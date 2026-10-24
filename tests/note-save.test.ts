import { describe, it, expect } from "vitest";
import { TFile, TFolder, type App } from "obsidian";
import { saveToNote, undoSave } from "../src/obsidian/note-save";
import { SaveLog } from "../src/obsidian/save-log";
import { buildObsidianTools } from "../src/obsidian/tools";
import { renderSaveReceipt } from "../src/ui/save-receipt";
import type { Provenance } from "../src/core/block-patch";
import type { SaveReceipt } from "../src/core/save-undo";
import { FakeEl, asEl } from "./fake-dom";

const P: Provenance = { convoId: "c1", msgIndex: 3, chatTitle: "Pricing", date: "2026-10-24" };

/** An in-memory vault: `process` is the only write to an existing note, as in Obsidian. */
function vault(files: Record<string, string>) {
  const notes = new Map(Object.entries(files));
  const trashed: string[] = [];
  const folders = new Set<string>();
  const fileFor = (path: string) =>
    Object.assign(new TFile(), { path, basename: path.replace(/^.*\//, "").replace(/\.md$/, ""), extension: "md" });
  const app = {
    vault: {
      getAbstractFileByPath: (p: string) =>
        notes.has(p) ? fileFor(p) : folders.has(p) ? Object.assign(new TFolder(), { path: p }) : null,
      process: async (f: TFile, fn: (d: string) => string) => {
        const next = fn(notes.get(f.path) ?? "");
        notes.set(f.path, next);
        return next;
      },
      create: async (p: string, c: string) => {
        notes.set(p, c);
        return fileFor(p);
      },
      createFolder: async (p: string) => void folders.add(p),
      getMarkdownFiles: () => [...notes.keys()].map(fileFor),
      cachedRead: async (f: TFile) => notes.get(f.path) ?? "",
      read: async () => {
        throw new Error("non-atomic read");
      },
    },
    metadataCache: {
      getFileCache: (f: TFile) => {
        const blocks: Record<string, unknown> = {};
        for (const m of (notes.get(f.path) ?? "").matchAll(/\^(exo-[a-z0-9]+)/g)) blocks[m[1]] = {};
        return { blocks };
      },
      getFirstLinkpathDest: () => null,
    },
    fileManager: {
      trashFile: async (f: TFile) => {
        trashed.push(f.path);
        notes.delete(f.path);
      },
    },
    workspace: { openLinkText: async () => {} },
  } as unknown as App;
  return { app, notes, trashed };
}

function memLog() {
  let content: string | null = null;
  return new SaveLog({
    read: async () => content,
    write: async (c) => {
      content = c;
    },
    preserveCorrupt: async () => {},
  });
}

const DEC = { kind: "heading" as const, heading: "Decisions", level: 2, occurrence: 0 };

function receipt(r: SaveReceipt | { error: string }): SaveReceipt {
  if ("error" in r) throw new Error(r.error);
  return r;
}

describe("saveToNote", () => {
  it("writes into the section with provenance and records the receipt", async () => {
    const { app, notes } = vault({ "N.md": "## Decisions\n- one\n\n## Notes\n" });
    const log = memLog();
    const r = receipt(await saveToNote(app, log, { target: { path: "N.md", section: DEC }, text: "two", provenance: P }));
    expect(notes.get("N.md")).toBe(`## Decisions\n- one\n${r.lines[0]}\n\n## Notes\n`);
    expect(r.lines[0]).toMatch(/^- two \[fonte: chat "Pricing" \(obsidian:\/\/exo-chat\?id=c1&msg=3\); dal: 2026-10-24\] \^exo-[0-9a-z]{6}$/);
    expect((await log.last())?.id).toBe(r.id);
  });

  it("creates a missing note, parent folder included", async () => {
    const { app, notes } = vault({});
    const r = receipt(
      await saveToNote(app, memLog(), { target: { path: "Inbox/New.md", section: { kind: "end" } }, text: "Body", provenance: P }),
    );
    expect(r.createdNote).toBe(true);
    expect(notes.get("Inbox/New.md")).toBe(`Body\n${r.lines[1]}\n`);
  });

  it("a section that is gone refuses and writes nothing", async () => {
    const { app, notes } = vault({ "N.md": "text\n" });
    const log = memLog();
    expect(await saveToNote(app, log, { target: { path: "N.md", section: DEC }, text: "x", provenance: P })).toEqual({
      error: "section-missing",
    });
    expect(notes.get("N.md")).toBe("text\n");
    expect(await log.last()).toBeUndefined();
  });

  it("empty text is nothing to save", async () => {
    const { app } = vault({ "N.md": "" });
    expect(await saveToNote(app, memLog(), { target: { path: "N.md", section: { kind: "end" } }, text: "  ", provenance: P })).toEqual({
      error: "nothing-to-save",
    });
  });
});

describe("undoSave", () => {
  it("undoes the last save, then reports already-undone", async () => {
    const { app, notes } = vault({ "N.md": "para\n" });
    const log = memLog();
    await saveToNote(app, log, { target: { path: "N.md", section: { kind: "end" } }, text: "Saved", provenance: P });
    const id = (await log.list())[0].id;
    expect(await undoSave(app, log)).toEqual({ ok: true, next: "para\n" });
    expect(notes.get("N.md")).toBe("para\n");
    expect(await undoSave(app, log, id)).toEqual({ ok: false, reason: "already-undone" });
  });

  it("finds a block moved to another note by its anchor", async () => {
    const { app, notes } = vault({ "N.md": "para\n", "Other.md": "x\n" });
    const log = memLog();
    const r = receipt(await saveToNote(app, log, { target: { path: "N.md", section: { kind: "end" } }, text: "Saved", provenance: P }));
    const moved = notes.get("N.md")!;
    notes.set("N.md", "para\n");
    notes.set("Other.md", `x\n\n${moved.slice("para\n\n".length)}`);
    expect((await undoSave(app, log, r.id)).ok).toBe(true);
    expect(notes.get("Other.md")).toBe("x\n");
  });

  it("a created note left empty goes to the trash", async () => {
    const { app, notes, trashed } = vault({});
    const log = memLog();
    await saveToNote(app, log, { target: { path: "New.md", section: { kind: "end" } }, text: "Saved", provenance: P });
    expect(await undoSave(app, log)).toEqual({ ok: true, next: null });
    expect(trashed).toEqual(["New.md"]);
    expect(notes.has("New.md")).toBe(false);
  });

  it("an edited block is refused and stays", async () => {
    const { app, notes } = vault({ "N.md": "para\n" });
    const log = memLog();
    await saveToNote(app, log, { target: { path: "N.md", section: { kind: "end" } }, text: "Saved", provenance: P });
    notes.set("N.md", notes.get("N.md")!.replace("Saved", "Saved, edited"));
    expect(await undoSave(app, log)).toEqual({ ok: false, reason: "block-edited" });
    expect(notes.get("N.md")).toContain("Saved, edited");
  });
});

describe("save_to_note tool", () => {
  function withHost(files: Record<string, string>) {
    const v = vault(files);
    const log = memLog();
    (v.app as unknown as { plugins: unknown }).plugins = {
      plugins: {
        "exo-agent": {
          loadAutomationRuns: async () => [],
          runPlaybook: async () => true,
          noteSaves: log,
          settings: { collaboUrl: "" },
          readConversationStore: async () => [{ id: "c1", title: "Pricing", messages: [{}, {}, {}] }],
        },
      },
    };
    const saved: SaveReceipt[] = [];
    const run = async (args: Record<string, unknown>) => {
      const t = buildObsidianTools(v.app, { convoId: "c1", onSaved: (r) => saved.push(r) }).find((x) => x.name === "save_to_note")!;
      const res = await (t.handler as (a: unknown, e: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>)(args, {});
      return { text: res.content[0].text, isError: res.isError === true };
    };
    return { ...v, log, run, saved };
  }

  it("saves into a section, provenance points at the message being produced", async () => {
    const { notes, run, saved } = withHost({ "N.md": "## Decisions\n- one\n" });
    const res = await run({ path: "N.md", section: "Decisions", text: "two" });
    expect(res.isError).toBe(false);
    expect(saved.map((r) => r.path)).toEqual(["N.md"]);
    expect(res.text).toMatch(/^Saved to N > ## Decisions \(\^exo-[0-9a-z]{6}\)\.$/);
    expect(notes.get("N.md")).toContain('[fonte: chat "Pricing" (obsidian://exo-chat?id=c1&msg=3); dal: ');
  });

  it("no section means end of note; new_section creates one", async () => {
    const { notes, run } = withHost({ "N.md": "body\n" });
    expect((await run({ path: "N", text: "tail" })).text).toMatch(/^Saved to N > End of note/);
    expect((await run({ path: "N.md", text: "more", new_section: "Saved" })).text).toMatch(/^Saved to N > New section: Saved/);
    expect(notes.get("N.md")).toContain("\n## Saved\nmore\n");
  });

  it("an unknown section is an error the model can act on", async () => {
    const { run, saved } = withHost({ "N.md": "body\n" });
    const res = await run({ path: "N.md", section: "Nope", text: "x" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Section not found");
    expect(saved).toEqual([]);
  });

  it("save_to_note replaces the old append tool", () => {
    const { app } = vault({});
    const names = buildObsidianTools(app).map((t) => t.name);
    expect(names).toContain("save_to_note");
    expect(names.some((n) => n.startsWith("append"))).toBe(false);
  });
});

describe("renderSaveReceipt", () => {
  it("shows note and section with Open and Undo as span controls", () => {
    const el = new FakeEl();
    const calls: string[] = [];
    const r: SaveReceipt = {
      id: "exo-abc123",
      op: "insert",
      path: "Projects/Pricing.md",
      section: DEC,
      lines: ["x ^exo-abc123"],
      provenance: P,
      savedAt: 1,
    };
    renderSaveReceipt(asEl(el), r, { open: () => calls.push("open"), undo: () => calls.push("undo") });
    expect(el.textContent).toContain("Saved to Pricing > ## Decisions");
    const open = el.byText("Open")!;
    const undo = el.byText("Undo")!;
    expect([open.tag, undo.tag]).toEqual(["span", "span"]);
    expect(open.attrs.role ?? open.getAttribute("role")).toBe("button");
    open.click();
    undo.click();
    expect(calls).toEqual(["open", "undo"]);
    expect(el.all().some((c) => c.tag === "button")).toBe(false);
  });
});
