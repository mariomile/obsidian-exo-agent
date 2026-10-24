import { describe, it, expect } from "vitest";
import { TFile, TFolder, type App } from "obsidian";
import { noteCorrections, saveToNote, undoSave } from "../src/obsidian/note-save";
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

describe("noteCorrections (accepted correction proposals)", () => {
  const input = { proposalId: "p1", title: "Correct old", convoId: "c1" };

  it("writes frontmatter through the receipt log, tells git autocommit, and undoes like a save", async () => {
    const before = "---\nstatus: active\ntype: decision\n---\nBody.\n";
    const { app, notes } = vault({ "D/old.md": before });
    const log = memLog();
    const wrote: string[][] = [];
    const target = noteCorrections(app, () => log, (paths) => wrote.push([...paths]));
    await expect(target.apply({ ...input, path: "D/old.md", change: { type: "frontmatter", set: { status: "superseded", superseded_by: "[[new]]" } } }))
      .resolves.toEqual({ path: "D/old.md" });
    expect(notes.get("D/old.md")).toBe('---\nstatus: "superseded"\ntype: decision\nsuperseded_by: "[[new]]"\n---\nBody.\n');
    expect(wrote).toEqual([["D/old.md"]]);
    const [r] = await log.list();
    expect(r).toMatchObject({ op: "frontmatter", path: "D/old.md", provenance: { convoId: "c1", chatTitle: "Correct old" } });
    expect((await undoSave(app, log))?.ok).toBe(true);
    expect(notes.get("D/old.md")).toBe(before);
  });

  it("replaces the outdated line and refuses, writing nothing, when it changed or is ambiguous", async () => {
    const { app, notes } = vault({ "N.md": "- Pro is 29 euro\n", "Two.md": "- x\n- x\n" });
    const log = memLog();
    const target = noteCorrections(app, () => log, () => {});
    const newLine = "- Pro is 39 euro (dal 2026-10-24; prima Pro is 29 euro)";
    await target.apply({ ...input, path: "N.md", change: { type: "line", oldLine: "- Pro is 29 euro", newLine } });
    expect(notes.get("N.md")).toBe(`${newLine}\n`);
    await expect(target.apply({ ...input, path: "N.md", change: { type: "line", oldLine: "- Pro is 29 euro", newLine } }))
      .rejects.toThrow("The outdated line is no longer in N. Open the note to fix it by hand.");
    await expect(target.apply({ ...input, path: "Two.md", change: { type: "line", oldLine: "- x", newLine: "- y" } }))
      .rejects.toThrow("The outdated line appears more than once in Two. Open the note to fix it by hand.");
    await expect(target.apply({ ...input, path: "Gone.md", change: { type: "line", oldLine: "- x", newLine: "- y" } }))
      .rejects.toThrow("Note not found: Gone.md");
    expect(notes.get("Two.md")).toBe("- x\n- x\n");
    expect(await log.list()).toHaveLength(1);
  });
});

describe("propose_correction tool", () => {
  function withHost(files: Record<string, string>, enabled = true) {
    const v = vault(files);
    const appended: { candidate: { payload: unknown }; source: { convoId: string } }[] = [];
    let refreshed = 0;
    (v.app as unknown as { plugins: unknown }).plugins = {
      plugins: {
        "exo-agent": {
          loadAutomationRuns: async () => [],
          runPlaybook: async () => true,
          settings: { collaboUrl: "", proposalKernelEnabled: enabled },
          proposalStore: {
            append: async (candidate: { payload: unknown }, source: { convoId: string }) => {
              const dup = appended.some((a) => JSON.stringify(a.candidate.payload) === JSON.stringify(candidate.payload));
              if (!dup) appended.push({ candidate, source });
              return { status: dup ? "duplicate" : "appended" };
            },
          },
          inbox: { refresh: async () => void refreshed++ },
        },
      },
    };
    const run = async (args: Record<string, unknown>) => {
      const t = buildObsidianTools(v.app, { convoId: "c1" }).find((x) => x.name === "propose_correction")!;
      const res = await (t.handler as (a: unknown, e: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>)(args, {});
      return { text: res.content[0].text, isError: res.isError === true };
    };
    return { ...v, appended, run, refreshed: () => refreshed };
  }

  it("proposes the line in the vault's changed-fact format and never touches the note", async () => {
    const { notes, appended, run, refreshed } = withHost({ "Pricing.md": "# Pricing\n- Pro is 29 euro\n" });
    const res = await run({ path: "Pricing.md", old_line: "Pro is 29 euro", new_text: "Pro is 39 euro" });
    expect(res).toEqual({ text: "Correction proposed for Pricing. Mario accepts it in the Inbox.", isError: false });
    expect(notes.get("Pricing.md")).toBe("# Pricing\n- Pro is 29 euro\n");
    expect(appended).toHaveLength(1);
    expect(appended[0].source).toMatchObject({ convoId: "c1" });
    expect(appended[0].candidate.payload).toMatchObject({
      kind: "correction",
      path: "Pricing.md",
      change: { type: "line", oldLine: "- Pro is 29 euro", newLine: expect.stringMatching(/^- Pro is 39 euro \(dal \d{4}-\d{2}-\d{2}; prima Pro is 29 euro\)$/) },
    });
    expect(refreshed()).toBe(1);
    expect((await run({ path: "Pricing.md", old_line: "Pro is 29 euro", new_text: "Pro is 39 euro" })).isError).toBe(false);
    expect(appended).toHaveLength(1);
  });

  it("errors the model can act on: unknown note, missing or ambiguous line, suggestions off", async () => {
    const { run } = withHost({ "N.md": "- a\n- a\n" });
    expect((await run({ path: "Nope", old_line: "a", new_text: "b" })).text).toBe("Note not found: Nope");
    expect((await run({ path: "N.md", old_line: "zzz", new_text: "b" })).text).toBe("Line not found in N. Quote the outdated line exactly as it is in the note.");
    expect((await run({ path: "N.md", old_line: "- a", new_text: "b" })).text).toBe("That line appears more than once in N. Quote a longer, unique line.");
    const off = withHost({ "N.md": "- a\n" }, false);
    expect(await off.run({ path: "N.md", old_line: "- a", new_text: "b" })).toEqual({ text: "Suggestions are off, so no correction can be proposed.", isError: true });
  });

  it("is registered only with a conversation", () => {
    const { app } = vault({});
    expect(buildObsidianTools(app, { convoId: "c1" }).map((t) => t.name)).toContain("propose_correction");
    expect(buildObsidianTools(app).map((t) => t.name)).not.toContain("propose_correction");
  });
});
