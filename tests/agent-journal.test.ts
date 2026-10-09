import { describe, it, expect } from "vitest";
import {
  extractJournalLine,
  journalLine,
  appendUnderHeading,
  journalAlreadyHas,
  journalContract,
  JOURNAL_HEADING,
  JOURNAL_MARKER,
  JOURNAL_MAX,
} from "../src/core/agent-journal";

describe("extractJournalLine", () => {
  it("takes the marked line", () => {
    expect(extractJournalLine(`Some prose.\n${JOURNAL_MARKER} filed 2 notes into Atlas/`)).toBe(
      "filed 2 notes into Atlas/"
    );
  });

  it("takes the LAST marker, so a quoted instruction does not win", () => {
    const out = `${JOURNAL_MARKER} example from the brief\n\nreal work\n${JOURNAL_MARKER} filed 3 captures`;
    expect(extractJournalLine(out)).toBe("filed 3 captures");
  });

  it("tolerates a bulleted or bolded marker", () => {
    expect(extractJournalLine(`- ${JOURNAL_MARKER} did a thing`)).toBe("did a thing");
    expect(extractJournalLine(`**${JOURNAL_MARKER}** did a thing`)).toBe("did a thing");
  });

  it("falls back to the first real prose line when the marker is missing", () => {
    // The agent did the work; a missing marker must not hide it.
    expect(extractJournalLine("# Report\n\n> quote\n\nSpostate 2 note in Atlas/.")).toBe("Spostate 2 note in Atlas/.");
  });

  it("ignores fenced blocks when falling back", () => {
    expect(extractJournalLine("```\nnot prose\n```\n\nReal summary here.")).toBe("Real summary here.");
  });

  it("returns null when there is nothing to say", () => {
    expect(extractJournalLine("")).toBeNull();
    expect(extractJournalLine("## Only\n### Headings")).toBeNull();
  });

  it("clamps an over-long line instead of dumping a report into the daily note", () => {
    const long = `${JOURNAL_MARKER} ${"x".repeat(400)}`;
    const out = extractJournalLine(long)!;
    expect(out.length).toBeLessThanOrEqual(JOURNAL_MAX);
    expect(out.endsWith("…")).toBe(true);
  });

  it("flattens newlines and bold so the line stays one line", () => {
    expect(extractJournalLine(`${JOURNAL_MARKER} **filed**   2   notes`)).toBe("filed 2 notes");
  });
});

describe("journalLine", () => {
  it("renders time, agent and summary", () => {
    const at = new Date(2026, 7, 2, 14, 32).getTime();
    expect(journalLine("Inbox Triager", at, "filed 2 notes")).toBe("- 14:32 **Inbox Triager** — filed 2 notes");
  });

  it("zero-pads the clock", () => {
    const at = new Date(2026, 7, 2, 9, 5).getTime();
    expect(journalLine("A", at, "x")).toContain("- 09:05 ");
  });
});

describe("appendUnderHeading", () => {
  const line = "- 09:00 **A** — did a thing";

  it("creates the section at the end when absent", () => {
    const out = appendUnderHeading("# Daily\n\nSome notes.", JOURNAL_HEADING, line);
    expect(out).toContain(JOURNAL_HEADING);
    expect(out.indexOf(JOURNAL_HEADING)).toBeGreaterThan(out.indexOf("Some notes."));
    expect(out).toContain(line);
  });

  it("appends inside an existing section, in order", () => {
    const before = `# Daily\n\n${JOURNAL_HEADING}\n\n- 08:00 **A** — first\n`;
    const out = appendUnderHeading(before, JOURNAL_HEADING, line);
    expect(out.indexOf("first")).toBeLessThan(out.indexOf("did a thing"));
  });

  it("stays inside its section — a following heading is untouched", () => {
    const before = [`${JOURNAL_HEADING}`, "", "- 08:00 **A** — first", "", "## Altro", "", "roba mia"].join("\n");
    const out = appendUnderHeading(before, JOURNAL_HEADING, line);
    expect(out.indexOf("did a thing")).toBeLessThan(out.indexOf("## Altro"));
    expect(out).toContain("roba mia");
  });

  it("does not disturb a higher-level heading that follows", () => {
    const before = [`${JOURNAL_HEADING}`, "", "- 08:00 **A** — first", "# Top", "mio"].join("\n");
    const out = appendUnderHeading(before, JOURNAL_HEADING, line);
    expect(out.indexOf("did a thing")).toBeLessThan(out.indexOf("# Top"));
  });

  it("finds the section after the user changed its heading level", () => {
    const before = ["## 🤖 Agents", "", "- 08:00 **A** — first", "", "## Meetings", "- call"].join("\n");
    const out = appendUnderHeading(before, JOURNAL_HEADING, line);
    expect(out.match(/🤖 Agents/g)).toHaveLength(1);
    expect(out.indexOf("did a thing")).toBeLessThan(out.indexOf("## Meetings"));
  });

  it("handles an empty note", () => {
    expect(appendUnderHeading("", JOURNAL_HEADING, line)).toBe(`${JOURNAL_HEADING}\n\n${line}\n`);
  });

  it("is idempotent-checkable via journalAlreadyHas", () => {
    const out = appendUnderHeading("", JOURNAL_HEADING, line);
    expect(journalAlreadyHas(out, line)).toBe(true);
    expect(journalAlreadyHas(out, "- 10:00 **B** — other")).toBe(false);
  });
});

describe("journalContract", () => {
  it("asks for change, not activity", () => {
    const c = journalContract();
    expect(c).toContain(JOURNAL_MARKER);
    expect(c).toMatch(/what CHANGED/);
  });
});
