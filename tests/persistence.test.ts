import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  planPersistedConvos,
  parseConversationsSource,
  readConversationsSource,
  partitionConvos,
  archiveSignature,
  restoredArchiveSignature,
  ArchiveRewriteGuard,
  type FileStamp,
} from "../src/core/persistence";
import { WriteQueue } from "../src/core/write-queue";
import { DEFAULT_SETTINGS, persistViewState, type MVASettings } from "../src/settings-schema";

type C = { id: string; messages: unknown[]; updatedAt?: number };

const convo = (id: string, msgCount: number, updatedAt?: number): C => ({
  id,
  messages: Array.from({ length: msgCount }, () => ({})),
  updatedAt,
});

/**
 * NOT a production contract. `planPersistedConvos` is deprecated and has no
 * caller: production retention is `planRetention` (src/core/retention.ts), which
 * never shrinks what it keeps. These cases pin the HISTORICAL planner — the one
 * that returned a reduced set whose difference was then deleted from disk — so
 * that the behaviour this branch removed stays legible, and so "recreates the
 * incident" below reads as the bug it was, not as a rule still in force.
 */
describe("planPersistedConvos (deprecated planner — historical behaviour only)", () => {
  it("recreates the incident: an OLD convo with recent updatedAt survives while a NEWER empty husk is dropped", () => {
    // 35 real convos + 10 empty husks = 45 entries, max 30 → real eviction runs
    // (35 > 30). c0 sits at the FRONT of the array but was touched most recently;
    // it must beat later, staler convos on updatedAt. Empty husks (0 messages,
    // unpinned) are dropped even though several carry a newer timestamp than c0.
    const all: C[] = [];
    all.push(convo("c0", 3, 10_000)); // old position, freshest timestamp
    for (let i = 1; i < 35; i++) all.push(convo(`c${i}`, 2, 1000 + i)); // 34 staler real convos
    for (let i = 0; i < 10; i++) all.push(convo(`husk${i}`, 0, 20_000 + i)); // 10 NEWER empty husks

    const kept = planPersistedConvos(all, "c1", [], 30);

    expect(kept.length).toBe(30);
    // The old-positioned but recently-updated convo survives eviction.
    expect(kept.some((c) => c.id === "c0")).toBe(true);
    // Every empty husk is dropped despite a newer updatedAt than c0.
    expect(kept.some((c) => c.id.startsWith("husk"))).toBe(false);
    // The pinned active convo is always kept.
    expect(kept.some((c) => c.id === "c1")).toBe(true);
  });

  it("always keeps active + open-tab convos even with 0 messages", () => {
    const all: C[] = [
      convo("active", 0), // empty but active
      convo("tab", 0), // empty but an open tab
      convo("orphan", 0), // empty, unpinned → dropped
      convo("real", 5, 100),
    ];
    const kept = planPersistedConvos(all, "active", ["tab"], 30);
    expect(kept.map((c) => c.id).sort()).toEqual(["active", "real", "tab"]);
  });

  it("preserves ORIGINAL array order in the output", () => {
    const all: C[] = [
      convo("a", 1, 5),
      convo("b", 1, 100),
      convo("c", 1, 50),
    ];
    // Active "z" isn't in the list, so nothing is pinned — pure recency eviction.
    const kept = planPersistedConvos(all, "z", [], 2);
    // b and c have the newest updatedAt; kept must still be in array order (b before c).
    expect(kept.map((c) => c.id)).toEqual(["b", "c"]);
  });

  it("never returns more than max", () => {
    const all = Array.from({ length: 50 }, (_, i) => convo(`c${i}`, 1, i));
    const kept = planPersistedConvos(all, "c0", [], 30);
    expect(kept.length).toBe(30);
  });

  it("evicts unpinned convos by updatedAt desc, keeping the most recent", () => {
    const all: C[] = [
      convo("keep-active", 1, 1),
      convo("old", 1, 1),
      convo("new", 1, 100),
      convo("mid", 1, 50),
    ];
    // max 2: active pinned + the single most-recent unpinned ("new").
    const kept = planPersistedConvos(all, "keep-active", [], 2);
    expect(kept.map((c) => c.id).sort()).toEqual(["keep-active", "new"]);
  });

  it("returns the filtered list untouched when under the cap", () => {
    const all: C[] = [convo("a", 1), convo("b", 0), convo("c", 2)];
    // b (empty, unpinned) is filtered out; a and c stay, in order, no eviction.
    const kept = planPersistedConvos(all, "z", [], 30);
    expect(kept.map((c) => c.id)).toEqual(["a", "c"]);
  });
});

describe("parseConversationsSource", () => {
  const arr = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: `c${i}` })));

  it("uses a valid main file and reports it not corrupt", () => {
    const r = parseConversationsSource(arr(3), null);
    expect(r.source).toBe("main");
    expect(r.mainCorrupt).toBe(false);
    expect(r.data).toHaveLength(3);
  });

  it("falls back to a valid .bak when main is corrupt, flagging mainCorrupt", () => {
    const r = parseConversationsSource("{ not json", arr(2));
    expect(r.source).toBe("bak");
    expect(r.mainCorrupt).toBe(true);
    expect(r.data).toHaveLength(2);
  });

  it("returns empty + mainCorrupt when BOTH main and bak are corrupt", () => {
    const r = parseConversationsSource("{ broken", "also [broken");
    expect(r.source).toBe("empty");
    expect(r.mainCorrupt).toBe(true);
    expect(r.data).toEqual([]);
  });

  it("returns empty and NOT corrupt when both files are missing (fresh install)", () => {
    const r = parseConversationsSource(null, null);
    expect(r.source).toBe("empty");
    expect(r.mainCorrupt).toBe(false);
    expect(r.data).toEqual([]);
  });

  it("recovers from bak for a truncated-JSON main (the classic crash-mid-write)", () => {
    // A write interrupted partway leaves valid-prefix-but-unterminated JSON.
    const truncated = arr(5).slice(0, arr(5).length - 10);
    const r = parseConversationsSource(truncated, arr(4));
    expect(r.source).toBe("bak");
    expect(r.mainCorrupt).toBe(true);
    expect(r.data).toHaveLength(4);
  });

  it("treats valid JSON that isn't an array as corrupt and tries bak", () => {
    const r = parseConversationsSource('{"conversations":[]}', arr(1));
    expect(r.source).toBe("bak");
    expect(r.mainCorrupt).toBe(true);
    expect(r.data).toHaveLength(1);
  });

  it("uses main even when a stale bak is also present (main wins)", () => {
    const r = parseConversationsSource(arr(2), arr(9));
    expect(r.source).toBe("main");
    expect(r.data).toHaveLength(2);
  });
});

describe("readConversationsSource", () => {
  const arr = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: `c${i}` })));
  const reader = (raw: string | null) => {
    const r = {
      calls: 0,
      read: async () => {
        r.calls++;
        return raw;
      },
    };
    return r;
  };

  it("never reads the backup when main is a valid array", async () => {
    const main = reader(arr(3));
    const bak = reader(arr(9));
    const r = await readConversationsSource(main.read, bak.read);
    expect(bak.calls).toBe(0);
    expect(main.calls).toBe(1);
    expect(r).toEqual({ data: JSON.parse(arr(3)), source: "main", mainCorrupt: false });
  });

  it("returns exactly what parseConversationsSource returns, for every main/bak pair", async () => {
    const truncated = arr(5).slice(0, arr(5).length - 10);
    const variants: Array<string | null> = [null, "{ broken", '{"conversations":[]}', truncated, arr(0), arr(2), arr(4)];
    let pairs = 0;
    for (const m of variants) {
      for (const b of variants) {
        const main = reader(m);
        const bak = reader(b);
        const expected = parseConversationsSource(m, b);
        expect(await readConversationsSource(main.read, bak.read)).toEqual(expected);
        // The backup is read only when main could not be used.
        expect(bak.calls).toBe(expected.source === "main" ? 0 : 1);
        expect(main.calls).toBe(1);
        pairs++;
      }
    }
    expect(pairs).toBe(49);
  });
});

describe("partitionConvos", () => {
  const c = (id: string, archived?: boolean) => ({ id, archived });

  it("splits archived from live, preserving order within each side", () => {
    const { live, archived } = partitionConvos([
      c("a"),
      c("b", true),
      c("c"),
      c("d", true),
    ]);
    expect(live.map((x) => x.id)).toEqual(["a", "c"]);
    expect(archived.map((x) => x.id)).toEqual(["b", "d"]);
  });

  it("treats a missing archived flag as live", () => {
    const { live, archived } = partitionConvos([{ id: "a" }]);
    expect(live.map((x) => x.id)).toEqual(["a"]);
    expect(archived).toEqual([]);
  });

  it("handles all-archived and all-live inputs", () => {
    expect(partitionConvos([c("a", true), c("b", true)]).live).toEqual([]);
    expect(partitionConvos([c("a"), c("b")]).archived).toEqual([]);
  });

  it("returns empty sides for empty input", () => {
    expect(partitionConvos([])).toEqual({ live: [], archived: [] });
  });
});

/**
 * Convo ⇄ ConvoData round-trip contract.
 *
 * The mapping is NOT in this module: it is two hand-written object literals in
 * `view.ts` — the `const c: Convo = {…}` in `restore()` (disk → memory) and the
 * literal in `toConvoData()` (memory → disk). `view.ts` imports `obsidian` and
 * has zero unit tests, so nothing else in the tree can observe that the two
 * halves still agree.
 *
 * The failure they are exposed to is asymmetric and silent: add a field to one
 * literal and not the other and the build is green, the typecheck is green
 * (both sides are optional), and the field simply evaporates on the next
 * reload. That is exactly how a fan-out child would come back from a restart
 * with no parent, jump out from under it in the sidebar, and read as a chat
 * nobody started.
 *
 * ⚠️ Red here means "add the field to the other literal too", never "delete the
 * field from the list".
 */
const view = readFileSync(join(__dirname, "..", "src", "view.ts"), "utf8");

/** Everything that must survive a save/load cycle. Deliberately includes the
 *  fields that predate this contract — one rule for all of them, so the next
 *  field added is added under a rule that is already being enforced. */
const ROUND_TRIP_FIELDS = [
  "archived",
  "pinned",
  "retiredAt",
  "lastActiveAt",
  "boardStatus",
  "parentConvoId",
  "titleLocked",
  "agent",
  "sessionId",
  "updatedAt",
  "usage",
  "pendingChildReports",
] as const;

/** The literal in `restore()` that builds a live `Convo` from a `ConvoData`. */
const restoreLiteral = (): string => {
  const start = view.indexOf("const c: Convo = {");
  expect(start, "restore()'s `const c: Convo = {` literal moved or was renamed").toBeGreaterThan(-1);
  const end = view.indexOf("\n      };", start);
  expect(end, "could not find the end of restore()'s Convo literal").toBeGreaterThan(start);
  return view.slice(start, end);
};

/** The literal in `toConvoData()` that writes a `ConvoData` back to disk. */
const toDataLiteral = (): string => {
  const start = view.indexOf("private toConvoData(c: Convo): ConvoData {");
  expect(start, "toConvoData moved or was renamed").toBeGreaterThan(-1);
  const end = view.indexOf("\n  }", start);
  expect(end, "could not find the end of toConvoData").toBeGreaterThan(start);
  return view.slice(start, end);
};

describe("Convo persistence round-trip (view.ts, which has no unit tests)", () => {
  const restore = restoreLiteral();
  const toData = toDataLiteral();

  for (const field of ROUND_TRIP_FIELDS) {
    it(`${field} is read back on restore`, () => {
      expect(
        restore,
        `${field} is written to disk but never read back: it silently disappears on reload.`,
      ).toContain(field);
    });

    it(`${field} is written on save`, () => {
      expect(
        toData,
        `${field} is restored from disk but never written: it survives exactly one session.`,
      ).toContain(field);
    });
  }

  it("parentConvoId is written conditionally, so a normal chat stays clean on disk", () => {
    // Matches how `boardStatus` and `titleLocked` are already handled: absent
    // stays absent rather than becoming an explicit `undefined` in every entry.
    expect(toData).toMatch(/\.\.\.\(c\.parentConvoId \? \{ parentConvoId: c\.parentConvoId \} : \{\}\)/);
  });

  it("pendingChildReports is written conditionally, so a normal chat stays clean on disk", () => {
    // Same shape as parentConvoId above: a chat that delegated nothing must not
    // grow an empty array in every entry of conversations.json.
    expect(toData).toMatch(/c\.pendingChildReports\?\.length \?/);
  });

  it("pendingChildReports is revived through the validating reader, not trusted raw", () => {
    // conversations.json is a plain file on disk: a hand-edited or half-written
    // entry must not put a non-array (or a report missing its parentConvoId)
    // onto a live Convo, where the next turn would splice it into the outbound
    // message. The validation lives in the tested pure module.
    expect(restore).toContain("reviveChildReports(d.pendingChildReports)");
  });
});

/**
 * The durability contract in prose, so the round-trip assertions above read as
 * a rule rather than as a list.
 *
 * A child report IS the feature: it is the only path by which a delegated
 * conversation's output ever reaches the model that delegated it. The parent's
 * "unread" affordance survives a restart (it is derived from the persisted
 * updatedAt/lastActiveAt pair, and from the queue itself in `listChatRows`), so
 * dropping the queue on reload left the sidebar advertising news the parent
 * could never deliver — and the model never received its child's work at all.
 * The approved design says so explicitly: "pending child reports persist in
 * ConvoData (small capped array), so an unread report survives restart."
 */
describe("child reports survive a reload (view.ts persistence seam)", () => {
  it("the queue is capped where it is filled, so it cannot grow without bound on disk", () => {
    const core = readFileSync(join(__dirname, "..", "src", "core", "child-reports.ts"), "utf8");
    expect(core).toContain("MAX_PENDING_CHILD_REPORTS");
  });
});

describe("the conversation id high-water mark", () => {
  const settings = (over: Partial<MVASettings> = {}): MVASettings =>
    ({ ...DEFAULT_SETTINGS, ...over }) as MVASettings;

  it("climbs with the counter", () => {
    const s = settings({ convoSeed: 7 });
    persistViewState(s, { openTabIds: ["c8"], activeTabId: "c8", convoSeed: 8 });
    expect(s.convoSeed).toBe(8);
  });

  it("never goes back down, however stale the caller's number is", () => {
    // The bug this closes: the counter used to be re-derived on every load from
    // the ids that SURVIVED, so deleting the highest-numbered chat handed its
    // number back out, and the next new chat wore a dead chat's id. Four
    // durable stores resolve against those ids.
    const s = settings({ convoSeed: 12 });
    persistViewState(s, { openTabIds: [], activeTabId: "", convoSeed: 3 });
    expect(s.convoSeed).toBe(12);
  });

  it("treats a settings file written before this key as zero, not as a reset", () => {
    const s = settings();
    delete (s as Partial<MVASettings>).convoSeed;
    persistViewState(s, { openTabIds: [], activeTabId: "", convoSeed: 5 });
    expect(s.convoSeed).toBe(5);
  });

  it("still writes the tab state it always wrote", () => {
    const s = settings();
    persistViewState(s, { openTabIds: ["c1", "c2"], activeTabId: "c2", convoSeed: 2 });
    expect(s.openTabIds).toEqual(["c1", "c2"]);
    expect(s.activeTabId).toBe("c2");
  });

  it("is seeded from the persisted mark as well as the surviving ids", () => {
    // The read side of the same rule, in view.ts's restore().
    const view = readFileSync(join(__dirname, "../src/view.ts"), "utf8");
    expect(view).toMatch(/convoSeed = Math\.max\(convoSeed, this\.plugin\.settings\.convoSeed \?\? 0, maxIdSuffix\(/);
  });
});

describe("archiveSignature", () => {
  const chat = (over: Record<string, unknown> = {}) => ({
    id: "a",
    title: "Old chat",
    updatedAt: 1,
    harvestedIndex: 3,
    messages: [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }],
    ...over,
  });

  it("is stable for an unchanged archive", () => {
    expect(archiveSignature([chat()])).toBe(archiveSignature([chat()]));
  });

  it("changes when a chat is archived or un-archived", () => {
    expect(archiveSignature([chat(), chat({ id: "b" })])).not.toBe(archiveSignature([chat()]));
  });

  it("changes when any top-level field or the message count changes", () => {
    const base = archiveSignature([chat()]);
    expect(archiveSignature([chat({ title: "Renamed" })])).not.toBe(base);
    expect(archiveSignature([chat({ harvestedIndex: 4 })])).not.toBe(base);
    expect(archiveSignature([chat({ messages: [] })])).not.toBe(base);
  });

  it("does not serialize the transcripts", () => {
    expect(archiveSignature([chat()])).not.toContain("hello");
  });
});

describe("restoredArchiveSignature", () => {
  const archive = [
    { id: "a", title: "Old", archived: true, updatedAt: 1, messages: [{ role: "user", text: "hi" }] },
    { id: "b", title: "Older", archived: true, pinned: true, messages: [] },
  ];

  it("signs an archive loaded from the main file exactly as the first persist will", () => {
    // What the first persist serializes for an untouched archive is the same
    // top-level shape that was written, so the two signatures must agree.
    const loaded = JSON.parse(JSON.stringify(archive)) as object[];
    expect(restoredArchiveSignature({ data: loaded, source: "main" })).toBe(archiveSignature(archive));
  });

  it("still differs once the archive changes, so a real change is written", () => {
    const seed = restoredArchiveSignature({ data: archive, source: "main" });
    expect(archiveSignature([{ ...archive[0], title: "Renamed" }, archive[1]])).not.toBe(seed);
    expect(archiveSignature([archive[0]])).not.toBe(seed);
  });

  it("is empty (untrusted) after a backup recovery or an empty load", () => {
    expect(restoredArchiveSignature({ data: archive, source: "bak" })).toBe("");
    expect(restoredArchiveSignature({ data: [], source: "empty" })).toBe("");
  });

  it("is empty (and does not throw) when an entry is not an object", () => {
    expect(restoredArchiveSignature({ data: [archive[0], null], source: "main" })).toBe("");
    expect(restoredArchiveSignature({ data: [archive[0], "x"], source: "main" })).toBe("");
  });

  it("signs an empty main-file archive as the empty signature", () => {
    expect(restoredArchiveSignature({ data: [], source: "main" })).toBe(archiveSignature([]));
  });
});

describe("ArchiveRewriteGuard", () => {
  const archive = () => [
    { id: "a", title: "Old", archived: true, updatedAt: 1, messages: [{ role: "user", text: "hi" }] },
    { id: "b", title: "Older", archived: true, messages: [] },
  ];
  const stamp: FileStamp = { ctime: 100, mtime: 200, size: 3000 };
  const stat = (s: FileStamp | null) => () => Promise.resolve(s);
  const loadedGuard = (s: FileStamp | null = stamp, source: "main" | "bak" | "empty" = "main") => {
    const g = new ArchiveRewriteGuard();
    g.noteLoad(s, { data: archive(), source });
    return g;
  };

  it("skips the first save of an archive unchanged since the load", async () => {
    const check = loadedGuard().takeSkipCheck(archive());
    expect(check).toBeDefined();
    expect(await check!(stat({ ...stamp }))).toBe(true);
  });

  it("writes when the file was rewritten after the read (any stamp field differs)", async () => {
    for (const changed of [{ ...stamp, mtime: 201 }, { ...stamp, size: 3001 }, { ...stamp, ctime: 101 }]) {
      expect(await loadedGuard().takeSkipCheck(archive())!(stat(changed))).toBe(false);
    }
  });

  it("writes when the file is gone at save time or cannot be stat'ed", async () => {
    expect(await loadedGuard().takeSkipCheck(archive())!(stat(null))).toBe(false);
    expect(await loadedGuard().takeSkipCheck(archive())!(() => Promise.reject(new Error("EIO")))).toBe(false);
  });

  it("writes when the payload differs from what was loaded", () => {
    const changed = archive();
    changed[0].title = "Renamed";
    expect(loadedGuard().takeSkipCheck(changed)).toBeUndefined();
    expect(loadedGuard().takeSkipCheck([archive()[0]])).toBeUndefined();
    expect(loadedGuard().takeSkipCheck([...archive(), null])).toBeUndefined();
  });

  it("is one-shot: only the first save after a load can skip", () => {
    const g = loadedGuard();
    expect(g.takeSkipCheck(archive())).toBeDefined();
    expect(g.takeSkipCheck(archive())).toBeUndefined();
    // A payload mismatch consumes the record too.
    const h = loadedGuard();
    expect(h.takeSkipCheck([])).toBeUndefined();
    expect(h.takeSkipCheck(archive())).toBeUndefined();
  });

  it("never skips without a trusted load: none, backup, empty, or no stamp before the read", () => {
    expect(new ArchiveRewriteGuard().takeSkipCheck(archive())).toBeUndefined();
    expect(loadedGuard(stamp, "bak").takeSkipCheck(archive())).toBeUndefined();
    expect(loadedGuard(stamp, "empty").takeSkipCheck([])).toBeUndefined();
    expect(loadedGuard(null).takeSkipCheck(archive())).toBeUndefined();
  });

  it("returns the loaded data unchanged, and the latest load replaces the record", async () => {
    const g = new ArchiveRewriteGuard();
    const data = archive();
    expect(g.noteLoad(stamp, { data, source: "main" })).toBe(data);
    g.noteLoad(stamp, { data: [], source: "bak" });
    expect(g.takeSkipCheck(archive())).toBeUndefined();
  });

  // Mirrors main.ts: saves run in a WriteQueue, the check runs first inside the
  // queued task, and every write replaces the file (new stamp).
  function disk(initial: unknown[]) {
    let n = 0;
    const d = {
      content: JSON.stringify(initial),
      stamp: { ctime: 0, mtime: 0, size: 0 } as FileStamp,
      writes: 0,
      write(json: string) {
        n++;
        d.content = json;
        d.stamp = { ctime: n, mtime: n, size: json.length };
        d.writes++;
      },
    };
    return d;
  }
  const save = (q: WriteQueue, d: ReturnType<typeof disk>, data: unknown[], check?: ReturnType<ArchiveRewriteGuard["takeSkipCheck"]>) => {
    const json = JSON.stringify(data);
    return q.enqueue(async () => {
      if (check && (await check(() => Promise.resolve({ ...d.stamp })))) return true;
      d.write(json);
      return true;
    });
  };
  const load = (g: ArchiveRewriteGuard, d: ReturnType<typeof disk>) => {
    const before = { ...d.stamp };
    return g.noteLoad(before, { data: JSON.parse(d.content) as unknown[], source: "main" }) as typeof archiveA;
  };
  const archiveA = archive();
  const archiveB = [archive()[1]]; // chat "a" unarchived by the closing view

  it("same plugin: a closing view's queued write lands before the check, so the first save writes", async () => {
    const d = disk(archiveA);
    const q = new WriteQueue();
    const g = new ArchiveRewriteGuard();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    void q.enqueue(() => gate); // the live-file write still in flight
    const v1 = save(q, d, archiveB); // the closing view's archive write, queued
    const memory = load(g, d); // the new view reads the old archive meanwhile
    expect(memory).toEqual(archiveA);
    const v2 = save(q, d, memory, g.takeSkipCheck(memory));
    release();
    await Promise.all([v1, v2]);
    expect(d.writes).toBe(2);
    expect(JSON.parse(d.content)).toEqual(archiveA); // same final file as the old code
  });

  it("another plugin instance: a write landing after the read is detected, so the first save writes", async () => {
    const d = disk(archiveA);
    const g = new ArchiveRewriteGuard();
    const memory = load(g, d);
    d.write(JSON.stringify(archiveB)); // old instance's late write, outside our queue
    await save(new WriteQueue(), d, memory, g.takeSkipCheck(memory));
    expect(d.writes).toBe(2);
    expect(JSON.parse(d.content)).toEqual(archiveA);
  });

  it("no concurrent writer: the first save is skipped and the file is untouched", async () => {
    const d = disk(archiveA);
    const g = new ArchiveRewriteGuard();
    const memory = load(g, d);
    const before = { ...d.stamp };
    expect(await save(new WriteQueue(), d, memory, g.takeSkipCheck(memory))).toBe(true);
    expect(d.writes).toBe(0);
    expect(d.stamp).toEqual(before);
    // A later real change still writes.
    await save(new WriteQueue(), d, archiveB, g.takeSkipCheck(archiveB));
    expect(d.writes).toBe(1);
  });
});
