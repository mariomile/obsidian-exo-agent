import { describe, it, expect } from "vitest";
import {
  newAnchor,
  formatProvenance,
  formatSaveBlock,
  planInsert,
  planReplaceLine,
  type PatchPlan,
  type Provenance,
} from "../src/core/block-patch";
import { chatLink } from "../src/core/chat-link";

const P: Provenance = { convoId: "c1", msgIndex: 4, chatTitle: "Pricing chat", date: "2026-10-24" };
const PROV = `[fonte: chat "Pricing chat" (${chatLink("c1", 4)}); dal: 2026-10-24]`;

function plan(r: PatchPlan | { error: string }): PatchPlan {
  if ("error" in r) throw new Error(r.error);
  return r;
}

describe("newAnchor", () => {
  it("is exo- plus 6 base36 chars", () => {
    expect(newAnchor(() => 0)).toBe("exo-000000");
    expect(newAnchor(() => 0.999)).toBe("exo-zzzzzz");
  });

  it("redraws when the note already carries the anchor", () => {
    const seq = [0, 0, 0, 0, 0, 0, 0.999, 0.999, 0.999, 0.999, 0.999, 0.999];
    let i = 0;
    expect(newAnchor(() => seq[i++], "old line ^exo-000000\n")).toBe("exo-zzzzzz");
  });
});

describe("formatProvenance", () => {
  it("carries the chat link and the date in the vault's fonte/dal format", () => {
    expect(formatProvenance(P)).toBe(PROV);
  });

  it("with no chat (a headless run) it names the automation and carries no link", () => {
    expect(formatProvenance({ ...P, convoId: "", msgIndex: 0, chatTitle: "Weekly digest" })).toBe(
      '[fonte: automazione "Weekly digest"; dal: 2026-10-24]',
    );
  });

  it("never lets a quote or newline in the title break the line", () => {
    expect(formatProvenance({ ...P, chatTitle: 'A "b"\nc' })).toContain('chat "A \'b\' c"');
  });
});

describe("formatSaveBlock", () => {
  it("one line into a list section becomes a vault fact line", () => {
    expect(formatSaveBlock("Price is 49 EUR", P, "exo-abc123", true)).toEqual({
      anchor: "exo-abc123",
      shape: "fact",
      lines: [`- Price is 49 EUR ${PROV} ^exo-abc123`],
    });
  });

  it("anything else is the passage verbatim plus one provenance line with the anchor last", () => {
    const b = formatSaveBlock("First\n\n- second\n", P, "exo-abc123", true);
    expect(b.shape).toBe("passage");
    expect(b.lines).toEqual(["First", "", "- second", `${PROV} ^exo-abc123`]);
    expect(formatSaveBlock("One line", P, "exo-abc123", false).lines).toEqual(["One line", `${PROV} ^exo-abc123`]);
  });
});

const FACT = formatSaveBlock("New fact", P, "exo-aaaaaa", true);
const PASSAGE = formatSaveBlock("A passage", P, "exo-bbbbbb", false);
const DEC = { kind: "heading" as const, heading: "Decisions", level: 2, occurrence: 0 };

describe("planInsert", () => {
  it("a fact joins the section's list with no blank line, before the next heading", () => {
    const content = "# T\n\n## Decisions\n- one\n- two\n\n## Notes\ntext\n";
    const p = plan(planInsert(content, DEC, FACT));
    expect(p.next).toBe(`# T\n\n## Decisions\n- one\n- two\n${FACT.lines[0]}\n\n## Notes\ntext\n`);
    expect(p.inserted).toEqual({ start: 5, lines: FACT.lines });
    expect(p.createdHeading).toBe(false);
    expect(p.pad).toEqual({ before: false, after: false });
  });

  it("a passage gets one blank line from its neighbours", () => {
    const content = "## Decisions\nsome text\n## Notes\n";
    const p = plan(planInsert(content, DEC, PASSAGE));
    expect(p.next).toBe(`## Decisions\nsome text\n\nA passage\n${PASSAGE.lines[1]}\n\n## Notes\n`);
    expect(p.pad).toEqual({ before: true, after: true });
    expect(p.inserted.start).toBe(3);
  });

  it("end of note appends after the last content line", () => {
    const p = plan(planInsert("para\n\n\n", { kind: "end" }, PASSAGE));
    expect(p.next).toBe(`para\n\nA passage\n${PASSAGE.lines[1]}\n\n\n`);
  });

  it("an empty note becomes just the block", () => {
    expect(plan(planInsert("", { kind: "end" }, PASSAGE)).next).toBe(`A passage\n${PASSAGE.lines[1]}\n`);
  });

  it("a new section is created at the end with its heading", () => {
    const p = plan(planInsert("body\n", { kind: "new", heading: "Saved", level: 2 }, PASSAGE));
    expect(p.next).toBe(`body\n\n## Saved\nA passage\n${PASSAGE.lines[1]}\n`);
    expect(p.createdHeading).toBe(true);
    expect(p.inserted.lines[0]).toBe("## Saved");
  });

  it("frontmatter is untouched and the block goes after it", () => {
    const p = plan(planInsert("---\na: 1\n---\n", { kind: "end" }, PASSAGE));
    expect(p.next).toBe(`---\na: 1\n---\nA passage\n${PASSAGE.lines[1]}\n`);
  });

  it("CRLF is preserved on every line", () => {
    const p = plan(planInsert("## Decisions\r\n- one\r\n", DEC, FACT));
    expect(p.next).toBe(`## Decisions\r\n- one\r\n${FACT.lines[0]}\r\n`);
  });

  it("CRLF with no final newline: the old last line gets its CR, no stray CR at the end", () => {
    const p = plan(planInsert("## Decisions\r\n- one", DEC, FACT));
    expect(p.next).toBe(`## Decisions\r\n- one\r\n${FACT.lines[0]}`);
  });

  it("a fenced heading is not a section", () => {
    expect(planInsert("```\n## Decisions\n```\n", DEC, FACT)).toEqual({ error: "section-missing" });
  });

  it("a ~~~ line inside a ``` block does not hide the section after it", () => {
    const content = "```\n~~~\n```\n## Decisions\n- one\n";
    expect(plan(planInsert(content, DEC, FACT)).next).toBe(`${content}${FACT.lines[0]}\n`);
  });

  it("a missing section is an error, the content is not touched", () => {
    expect(planInsert("text\n", DEC, FACT)).toEqual({ error: "section-missing" });
  });

  it("the diff is section-scoped: heading and context around the added lines", () => {
    const content = "# T\nfar\n\n## Decisions\n- one\n- two\n\n## Notes\ntext\n";
    const d = plan(planInsert(content, DEC, FACT)).diff;
    expect(d).toEqual([
      { kind: "ctx", text: "## Decisions" },
      { kind: "ctx", text: "- one" },
      { kind: "ctx", text: "- two" },
      { kind: "add", text: FACT.lines[0] },
      { kind: "ctx", text: "" },
      { kind: "ctx", text: "## Notes" },
    ]);
  });
});

describe("planReplaceLine", () => {
  it("replaces the one matching line and keeps its line ending", () => {
    const p = plan(planReplaceLine("a\r\n- old fact\r\nb\r\n", "- old fact", "- new fact"));
    expect(p.next).toBe("a\r\n- new fact\r\nb\r\n");
    expect(p.inserted).toEqual({ start: 1, lines: ["- new fact"] });
    expect(p.diff).toEqual([
      { kind: "ctx", text: "a" },
      { kind: "del", text: "- old fact" },
      { kind: "add", text: "- new fact" },
      { kind: "ctx", text: "b" },
    ]);
  });

  it("missing or ambiguous lines are errors", () => {
    expect(planReplaceLine("a\n", "- x", "- y")).toEqual({ error: "line-missing" });
    expect(planReplaceLine("- x\n- x\n", "- x", "- y")).toEqual({ error: "line-ambiguous" });
  });

  it("never replaces inside frontmatter or a fence", () => {
    expect(planReplaceLine("---\nk: v\n---\n", "k: v", "k: w")).toEqual({ error: "line-missing" });
    expect(planReplaceLine("```\ncode\n```\n", "code", "x")).toEqual({ error: "line-missing" });
  });
});
