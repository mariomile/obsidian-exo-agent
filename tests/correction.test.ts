import { describe, it, expect } from "vitest";
import { planCorrection, quotedLine } from "../src/core/correction";
import { planUndo, type SaveReceipt } from "../src/core/save-undo";
import type { Provenance } from "../src/core/block-patch";

const P: Provenance = { convoId: "c1", msgIndex: 0, chatTitle: "Correct vault-lean", date: "2026-10-24" };
const META = { id: "exo-cccccc", path: "D/old.md", provenance: P, savedAt: 7 };

function done(r: ReturnType<typeof planCorrection>): { next: string; receipt: SaveReceipt } {
  if ("error" in r) throw new Error(r.error);
  return r;
}
function undone(content: string, r: SaveReceipt): string | null {
  const u = planUndo(content, r);
  if (!u.ok) throw new Error(u.reason);
  return u.next;
}

describe("planCorrection: line", () => {
  const note = "---\nstatus: active\n---\n# Pricing\n\n  - Pro is 29 euro\n- Team is 99\n";
  const newLine = "  - Pro is 39 euro (dal 2026-10-24; prima Pro is 29 euro)";

  it("writes the new line in the vault's changed-fact format, in place, with a replace receipt", () => {
    const { next, receipt } = done(planCorrection(note, { type: "line", oldLine: "- Pro is 29 euro", newLine }, META));
    expect(next).toBe(note.replace("  - Pro is 29 euro", newLine));
    expect(receipt).toMatchObject({ id: "exo-cccccc", op: "replace", path: "D/old.md", lines: [newLine], replaced: "  - Pro is 29 euro", savedAt: 7 });
    expect(undone(next, receipt)).toBe(note);
  });

  it("refuses when the old line changed or is no longer unique", () => {
    expect(planCorrection(note, { type: "line", oldLine: "- Pro is 25 euro", newLine }, META)).toEqual({ error: "line-missing" });
    const twice = `${note}- Pro is 29 euro\n`;
    expect(planCorrection(twice, { type: "line", oldLine: "- Pro is 29 euro", newLine }, META)).toEqual({ error: "line-ambiguous" });
  });
});

describe("planCorrection: frontmatter", () => {
  const note = "---\ntype: decision\nstatus: active\nsupersedes: \"[[older]]\"\ntags:\n  - vault\n---\nBody stays.\n";
  const set = { status: "superseded", superseded_by: "[[2026-09-25-memoria]]" };

  it("sets the keys, keeps every other frontmatter byte and the body", () => {
    const { next, receipt } = done(planCorrection(note, { type: "frontmatter", set }, META));
    expect(next).toBe(
      "---\ntype: decision\nstatus: \"superseded\"\nsupersedes: \"[[older]]\"\ntags:\n  - vault\nsuperseded_by: \"[[2026-09-25-memoria]]\"\n---\nBody stays.\n",
    );
    expect(receipt).toMatchObject({
      op: "frontmatter",
      keys: [
        { key: "status", before: ["status: active"], after: "status: \"superseded\"" },
        { key: "superseded_by", before: [], after: "superseded_by: \"[[2026-09-25-memoria]]\"" },
      ],
    });
  });

  it("undo restores the exact keys, keeping later edits elsewhere", () => {
    const { next, receipt } = done(planCorrection(note, { type: "frontmatter", set }, META));
    expect(undone(next, receipt)).toBe(note);
    const later = next.replace("Body stays.", "Body stays, edited.");
    expect(undone(later, receipt)).toBe(note.replace("Body stays.", "Body stays, edited."));
  });

  it("undo refuses when Mario changed a corrected key since", () => {
    const { next, receipt } = done(planCorrection(note, { type: "frontmatter", set }, META));
    expect(planUndo(next.replace('status: "superseded"', "status: archived"), receipt)).toEqual({ ok: false, reason: "line-changed" });
  });

  it("a note without frontmatter gets one, and undo removes it again", () => {
    const bare = "Just a body.\n";
    const { next, receipt } = done(planCorrection(bare, { type: "frontmatter", set: { status: "superseded" } }, META));
    expect(next).toBe("---\nstatus: \"superseded\"\n---\nJust a body.\n");
    expect(undone(next, receipt)).toBe(bare);
  });

  it("keeps CRLF line endings", () => {
    const crlf = note.replace(/\n/g, "\r\n");
    const { next, receipt } = done(planCorrection(crlf, { type: "frontmatter", set }, META));
    expect(next).toContain("status: \"superseded\"\r\n");
    expect(undone(next, receipt)).toBe(crlf);
  });
});

describe("quotedLine", () => {
  const note = "---\ntitle: Pro is 29 euro\n---\n# Pricing\n  - Pro is 29 euro\n- [ ] ship at 39\n```\n- in code\n```\n";

  it("finds the line as written in the note, with or without its list marker", () => {
    expect(quotedLine(note, "- Pro is 29 euro")).toBe("  - Pro is 29 euro");
    expect(quotedLine(note, "Pro is 29 euro")).toBe("  - Pro is 29 euro");
    expect(quotedLine(note, "ship at 39")).toBe("- [ ] ship at 39");
  });

  it("never matches frontmatter or code, and refuses a line that is not unique", () => {
    expect(quotedLine("---\nk: a\n---\nk: a\n", "k: a")).toBe("k: a");
    expect(quotedLine(note, "in code")).toEqual({ error: "line-missing" });
    expect(quotedLine(note, "Team is 99")).toEqual({ error: "line-missing" });
    expect(quotedLine("- a\n* a\n", "a")).toEqual({ error: "line-ambiguous" });
    expect(quotedLine("- a\n- a\n", "- a")).toEqual({ error: "line-ambiguous" });
  });
});
