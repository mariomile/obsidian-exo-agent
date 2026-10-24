import { describe, it, expect } from "vitest";
import {
  inFence,
  listSections,
  protectedLines,
  resolveSection,
  sectionLabel,
  sectionIsList,
  suggestTargets,
} from "../src/core/save-target";

const NOTE = [
  "---",
  "title: X",
  "# not a heading, frontmatter",
  "---",
  "Intro line",
  "",
  "## Decisions",
  "- one",
  "- two",
  "",
  "```",
  "# fenced, not a heading",
  "```",
  "",
  "## Notes",
  "Some text",
  "",
  "## Decisions",
  "- three",
  "",
].join("\n");

describe("listSections", () => {
  it("lists headings in order, skipping frontmatter and fenced #", () => {
    expect(listSections(NOTE)).toEqual([
      { kind: "heading", heading: "Decisions", level: 2, occurrence: 0 },
      { kind: "heading", heading: "Notes", level: 2, occurrence: 0 },
      { kind: "heading", heading: "Decisions", level: 2, occurrence: 1 },
    ]);
  });

  it("a frontmatter-only note has no sections", () => {
    expect(listSections("---\na: 1\n---\n")).toEqual([]);
  });

  it("reads CRLF headings without the carriage return", () => {
    expect(listSections("# Top\r\ntext\r\n")).toEqual([{ kind: "heading", heading: "Top", level: 1, occurrence: 0 }]);
  });
});

describe("resolveSection", () => {
  it("duplicate headings resolve by occurrence", () => {
    expect(resolveSection(NOTE, { kind: "heading", heading: "Decisions", level: 2, occurrence: 0 })).toEqual({
      headingLine: 6,
      start: 7,
      end: 14,
    });
    expect(resolveSection(NOTE, { kind: "heading", heading: "Decisions", level: 2, occurrence: 1 })).toEqual({
      headingLine: 17,
      start: 18,
      end: 19,
    });
  });

  it("a missing heading resolves to null", () => {
    expect(resolveSection(NOTE, { kind: "heading", heading: "Nope", level: 2, occurrence: 0 })).toBeNull();
    expect(resolveSection(NOTE, { kind: "heading", heading: "Decisions", level: 2, occurrence: 2 })).toBeNull();
  });

  it("end of note starts after the frontmatter", () => {
    expect(resolveSection("---\na: 1\n---\nbody\n", { kind: "end" })).toEqual({ headingLine: null, start: 3, end: 4 });
  });

  it("a new section resolves to the end of the note", () => {
    expect(resolveSection("a\nb\n", { kind: "new", heading: "Fresh", level: 2 })).toEqual({ headingLine: null, start: 2, end: 2 });
  });

  it("unclosed frontmatter resolves to null", () => {
    expect(resolveSection("---\na: 1\nbody\n", { kind: "end" })).toBeNull();
  });
});

describe("sectionIsList", () => {
  it("true when the section's content lines are list items", () => {
    expect(sectionIsList(NOTE, { kind: "heading", heading: "Decisions", level: 2, occurrence: 1 })).toBe(true);
    expect(sectionIsList(NOTE, { kind: "heading", heading: "Notes", level: 2, occurrence: 0 })).toBe(false);
    expect(sectionIsList("", { kind: "end" })).toBe(false);
    expect(sectionIsList("a\n", { kind: "new", heading: "X", level: 2 })).toBe(false);
  });
});

describe("sectionLabel", () => {
  it("labels each kind", () => {
    expect(sectionLabel({ kind: "end" })).toBe("End of note");
    expect(sectionLabel({ kind: "heading", heading: "Decisions", level: 2, occurrence: 0 })).toBe("## Decisions");
    expect(sectionLabel({ kind: "new", heading: "Notes", level: 2 })).toBe("New section: Notes");
  });
});

describe("suggestTargets", () => {
  it("active first, then recalled, then touched; deduped, markdown only, max 6", () => {
    expect(
      suggestTargets({
        activePath: "A.md",
        recalled: ["B.md", "A.md", "C.md"],
        touched: ["img.png", "D.md", "E.md", "F.md", "G.md"],
      }),
    ).toEqual(["A.md", "B.md", "C.md", "D.md", "E.md", "F.md"]);
  });

  it("works without an active note", () => {
    expect(suggestTargets({ activePath: null, recalled: [], touched: ["X.md"] })).toEqual(["X.md"]);
  });
});

describe("inFence (one fence scanner)", () => {
  const lines = ["# T", "```", "~~~", "code", "```", "after", "~~~", "open"];
  const p = protectedLines(lines);
  it("a ~~~ line inside a ``` block is content, not a fence", () => {
    expect(inFence(p, 3)).toBe(true);
    expect(inFence(p, 5)).toBe(false);
    expect(inFence(p, 6)).toBe(false);
  });
  it("an insertion point after an opening fence that never closes is inside", () => {
    expect(inFence(p, 7)).toBe(true);
    expect(inFence(p, 8)).toBe(true);
  });
  it("the closing fence marks the end of the block", () => {
    expect(p.closing).toEqual([false, false, false, false, true, false, false, false]);
  });
});
