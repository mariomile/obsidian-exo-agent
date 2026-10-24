import { describe, it, expect } from "vitest";
import { formatSaveBlock, planInsert, planReplaceLine, type PatchPlan, type Provenance } from "../src/core/block-patch";
import type { SectionRef } from "../src/core/save-target";
import { planUndo, receiptFor, type SaveReceipt } from "../src/core/save-undo";

const P: Provenance = { convoId: "c1", msgIndex: 2, chatTitle: "Chat", date: "2026-10-24" };
const DEC: SectionRef = { kind: "heading", heading: "Decisions", level: 2, occurrence: 0 };

function plan(r: PatchPlan | { error: string }): PatchPlan {
  if ("error" in r) throw new Error(r.error);
  return r;
}

/** Save `text` into `content` and return the new content plus its receipt. */
function save(content: string, section: SectionRef, text: string, isList: boolean, createdNote = false) {
  const block = formatSaveBlock(text, P, "exo-aaaaaa", isList);
  const p = plan(planInsert(content, section, block));
  const r = receiptFor({ path: "N.md", section, block, plan: p, provenance: P, createdNote, savedAt: 1 });
  return { next: p.next, r };
}

function ok(u: ReturnType<typeof planUndo>): string | null {
  if (!u.ok) throw new Error(u.reason);
  return u.next;
}

const BASE = "# T\n\n## Decisions\n- one\n\n## Notes\ntext\n";

describe("planUndo: insert", () => {
  it("a clean undo restores the note byte for byte", () => {
    const { next, r } = save(BASE, DEC, "a fact", true);
    expect(ok(planUndo(next, r))).toBe(BASE);
    const passage = save("para\n", { kind: "end" }, "Line one\nLine two", false);
    expect(ok(planUndo(passage.next, passage.r))).toBe("para\n");
  });

  it("an edit elsewhere in the same section survives the undo", () => {
    const { next, r } = save(BASE, DEC, "a fact", true);
    const edited = next.replace("- one", "- one, edited");
    expect(ok(planUndo(edited, r))).toBe(BASE.replace("- one", "- one, edited"));
  });

  it("never merges Mario's line into the paragraph above: one blank separator stays", () => {
    const { next, r } = save("para\n", { kind: "end" }, "Line one\nLine two", false);
    expect(ok(planUndo(`${next}Mario wrote this\n`, r))).toBe("para\n\nMario wrote this\n");
    const list = save(BASE, DEC, "a fact", true);
    expect(ok(planUndo(list.next.replace("\n\n## Notes", "\n- Mario's fact\n\n## Notes"), list.r))).toBe(BASE.replace("- one\n", "- one\n- Mario's fact\n"));
  });

  it("an edit inside the block refuses with block-edited", () => {
    const { next, r } = save("para\n", { kind: "end" }, "Line one\nLine two", false);
    expect(planUndo(next.replace("Line one", "Line uno"), r)).toEqual({ ok: false, reason: "block-edited" });
  });

  it("a deleted anchor gives block-missing", () => {
    const { next, r } = save(BASE, DEC, "a fact", true);
    expect(planUndo(next.replace(" ^exo-aaaaaa", ""), r)).toEqual({ ok: false, reason: "block-missing" });
  });

  it("CRLF notes undo cleanly", () => {
    const crlf = BASE.replace(/\n/g, "\r\n");
    const { next, r } = save(crlf, DEC, "a fact", true);
    expect(ok(planUndo(next, r))).toBe(crlf);
  });

  it("CRLF with no final newline undoes byte for byte", () => {
    const doc = "## Decisions\r\n- one";
    const { next, r } = save(doc, DEC, "a fact", true);
    expect(ok(planUndo(next, r))).toBe(doc);
  });

  it("a created heading goes only when its section is empty", () => {
    const s = save("body\n", { kind: "new", heading: "Saved", level: 2 }, "A passage", false);
    expect(s.r.createdHeading).toBe("## Saved");
    expect(ok(planUndo(s.next, s.r))).toBe("body\n");
    const kept = `${s.next}more under it\n`;
    expect(ok(planUndo(kept, s.r))).toBe("body\n\n## Saved\nmore under it\n");
  });

  it("a created note is deleted only when nothing else is left", () => {
    const s = save("", { kind: "end" }, "A passage", false, true);
    expect(planUndo(s.next, s.r)).toEqual({ ok: true, next: null });
    // Properties added after the save are the user's: the note stays.
    expect(ok(planUndo(`---\na: 1\n---\n${s.next}`, s.r))).toBe("---\na: 1\n---\n");
    expect(ok(planUndo(`${s.next}\nMario wrote this\n`, s.r))).toBe("\nMario wrote this\n");
  });

  it("a second undo gives already-undone", () => {
    const { next, r } = save(BASE, DEC, "a fact", true);
    expect(planUndo(next, { ...r, undoneAt: 5 })).toEqual({ ok: false, reason: "already-undone" });
  });
});

describe("planUndo: replace", () => {
  const before = "a\n- old fact\nb\n";
  const p = plan(planReplaceLine(before, "- old fact", "- new fact ^exo-bbbbbb"));
  const r: SaveReceipt = {
    id: "exo-bbbbbb",
    op: "replace",
    path: "N.md",
    section: { kind: "end" },
    lines: ["- new fact ^exo-bbbbbb"],
    replaced: "- old fact",
    provenance: P,
    savedAt: 1,
  };

  it("restores the old line while the new one is intact", () => {
    expect(ok(planUndo(p.next, r))).toBe(before);
    expect(ok(planUndo(`${p.next}later edit\n`, r))).toBe(`${before}later edit\n`);
  });

  it("refuses with line-changed when the new line was edited", () => {
    expect(planUndo(p.next.replace("new fact", "newer fact"), r)).toEqual({ ok: false, reason: "line-changed" });
  });
});
