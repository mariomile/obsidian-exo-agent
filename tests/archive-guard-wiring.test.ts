import { describe, it, expect, vi } from "vitest";
import type ExoPlugin from "../src/main";
import { ArchiveRewriteGuard, type FileStamp } from "../src/core/persistence";
import { WriteQueue } from "../src/core/write-queue";

// main.ts pulls in the whole view; these stubs only let the module load. What
// runs below is the real load/save code of the plugin against a fake disk.
vi.mock("electron", () => ({ webUtils: { getPathForFile: () => "" }, shell: {}, clipboard: {}, default: {} }));
vi.mock("obsidian", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return new Proxy(real, {
    get: (t, k) => (typeof k === "string" && k in t ? t[k] : k === "then" ? undefined : class {}),
    has: () => true,
  });
});

const DIR = ".obsidian/plugins/exo-agent";
const P = `${DIR}/conversations-archive.json`;
const BAK = `${P}.bak`;

/** In-memory adapter: every write gets a fresh stamp, a rename carries it. */
class FakeDisk {
  private files = new Map<string, { text: string; stamp: FileStamp }>();
  private clock = 1000;
  archiveWrites = 0;
  afterRead: ((path: string) => void) | undefined;

  put(path: string, text: string): void {
    this.clock++;
    this.files.set(path, { text, stamp: { ctime: this.clock, mtime: this.clock, size: text.length } });
  }
  text(path: string): string | undefined {
    return this.files.get(path)?.text;
  }
  stamp(path: string): FileStamp | undefined {
    return this.files.get(path)?.stamp;
  }

  adapter = {
    exists: async (p: string) => this.files.has(p),
    read: async (p: string) => {
      const e = this.files.get(p);
      if (!e) throw new Error(`ENOENT ${p}`);
      this.afterRead?.(p);
      return e.text;
    },
    write: async (p: string, text: string) => {
      if (p === `${P}.tmp`) this.archiveWrites++;
      this.put(p, text);
    },
    remove: async (p: string) => {
      this.files.delete(p);
    },
    rename: async (from: string, to: string) => {
      const e = this.files.get(from);
      if (!e) throw new Error(`ENOENT ${from}`);
      this.files.delete(from);
      this.files.set(to, e);
    },
    stat: async (p: string) => {
      const e = this.files.get(p);
      return e ? { type: "file", ...e.stamp } : null;
    },
  };
}

async function makePlugin(disk: FakeDisk): Promise<ExoPlugin> {
  const { default: Plugin } = await import("../src/main");
  return Object.assign(Object.create(Plugin.prototype) as ExoPlugin, {
    app: { vault: { adapter: disk.adapter } },
    manifest: { dir: DIR },
    conversationWriteQueue: new WriteQueue(),
    archiveGuard: new ArchiveRewriteGuard(),
  });
}

const convo = (id: string, title: string) => ({
  id,
  title,
  archived: true,
  messages: [{ role: "user", text: `hello ${id}` }],
});
const A = [convo("a", "Alpha"), convo("b", "Beta")];
const B = [convo("b", "Beta")];

describe("archive rewrite guard wiring (ExoPlugin)", () => {
  it("skips the first save of an archive unchanged since the load, leaving file and .bak alone", async () => {
    const disk = new FakeDisk();
    disk.put(P, JSON.stringify(A));
    disk.put(BAK, "[]");
    const plugin = await makePlugin(disk);
    const before = disk.stamp(P);

    const loaded = await plugin.loadArchivedConversations();
    expect(await plugin.saveArchivedConversations(loaded)).toBe(true);

    expect(disk.archiveWrites).toBe(0);
    expect(disk.stamp(P)).toEqual(before);
    expect(disk.text(BAK)).toBe("[]");
    // One-shot: the next save of the same payload writes and rotates as before.
    expect(await plugin.saveArchivedConversations(loaded)).toBe(true);
    expect(disk.archiveWrites).toBe(1);
    expect(disk.text(BAK)).toBe(JSON.stringify(A));
  });

  it("takes the stamp before the read: a write landing right after the read is not skipped over", async () => {
    const disk = new FakeDisk();
    disk.put(P, JSON.stringify(A));
    disk.afterRead = (p) => {
      if (p !== P) return;
      disk.afterRead = undefined;
      disk.put(P, JSON.stringify(B)); // another writer lands between our read and our save
    };
    const plugin = await makePlugin(disk);

    const loaded = await plugin.loadArchivedConversations();
    expect(loaded).toEqual(A);
    expect(await plugin.saveArchivedConversations(loaded)).toBe(true);

    // Old code rewrote A over the late B; so must the new code.
    expect(disk.archiveWrites).toBe(1);
    expect(disk.text(P)).toBe(JSON.stringify(A));
  });

  it("checks inside the write queue: a closing view's queued write lands first, then the new view's save still writes", async () => {
    const disk = new FakeDisk();
    disk.put(P, JSON.stringify(A));
    const plugin = await makePlugin(disk);
    const queue = (plugin as unknown as { conversationWriteQueue: WriteQueue }).conversationWriteQueue;

    let release!: () => void;
    void queue.enqueue(() => new Promise<void>((r) => (release = r))); // a live-file write in flight
    const closing = plugin.saveArchivedConversations(B); // the closing view's last archive flush
    const loaded = await plugin.loadArchivedConversations(); // the new view reads A meanwhile
    expect(loaded).toEqual(A);
    const first = plugin.saveArchivedConversations(loaded);
    release();
    expect(await Promise.all([closing, first])).toEqual([true, true]);

    // Old code: write B, then write A. Same two writes, same final file.
    expect(disk.archiveWrites).toBe(2);
    expect(disk.text(P)).toBe(JSON.stringify(A));
  });

  it("keeps no record when the load recovered from .bak, so the first save writes", async () => {
    const disk = new FakeDisk();
    disk.put(P, "{not json");
    disk.put(BAK, JSON.stringify(A));
    const plugin = await makePlugin(disk);

    const loaded = await plugin.loadArchivedConversations();
    expect(loaded).toEqual(A);
    expect(await plugin.saveArchivedConversations(loaded)).toBe(true);

    expect(disk.archiveWrites).toBe(1);
    expect(disk.text(P)).toBe(JSON.stringify(A));
  });

  it("leaves the live conversations store unguarded", async () => {
    const disk = new FakeDisk();
    const live = `${DIR}/conversations.json`;
    disk.put(live, JSON.stringify(A));
    const plugin = await makePlugin(disk);

    const loaded = await plugin.loadConversations();
    const stamp = disk.stamp(live);
    expect(await plugin.saveConversations(loaded)).toBe(true);
    expect(disk.stamp(live)).not.toEqual(stamp);
    expect(disk.text(`${live}.bak`)).toBe(JSON.stringify(A));
  });
});
