import { describe, it, expect } from "vitest";
import { answerAfter, citedPaths, makeResolver, recallLogEntry, scoreGrounding, type RecallLogEntry } from "../src/core/grounding";

const files = [
  { path: "Active/Projects/Exo/Exo.md", aliases: ["Exo Agent"] },
  { path: "Knowledge/Pricing.md" },
  { path: "Knowledge/Old/Pricing 2025.md" },
  { path: "Archive/Pricing.md" },
];
const resolve = makeResolver(files);

describe("makeResolver", () => {
  it("resolves basename, full path, alias and case", () => {
    expect(resolve("Pricing 2025")).toBe("Knowledge/Old/Pricing 2025.md");
    expect(resolve("Knowledge/Pricing")).toBe("Knowledge/Pricing.md");
    expect(resolve("Knowledge/Pricing.md")).toBe("Knowledge/Pricing.md");
    expect(resolve("exo agent")).toBe("Active/Projects/Exo/Exo.md");
    expect(resolve("Exo")).toBe("Active/Projects/Exo/Exo.md");
  });
  it("picks the shortest path for an ambiguous basename, and null for nothing", () => {
    expect(resolve("Pricing")).toBe("Archive/Pricing.md");
    expect(resolve("Nope")).toBeNull();
  });
});

describe("citedPaths", () => {
  it("resolves aliases, #heading links and display text", () => {
    const answer = "See [[Exo Agent]], [[Pricing 2025#Tiers]] and [[Knowledge/Pricing|the pricing note]].";
    expect(citedPaths(answer, resolve)).toEqual([
      "Active/Projects/Exo/Exo.md",
      "Knowledge/Old/Pricing 2025.md",
      "Knowledge/Pricing.md",
    ]);
  });
  it("handles table-escaped pipes, embeds and duplicates; ignores unresolved and self-heading links", () => {
    const answer = "| [[Exo\\|x]] | ![[Exo]] | [[#Local]] | [[Ghost]] |";
    expect(citedPaths(answer, resolve)).toEqual(["Active/Projects/Exo/Exo.md"]);
  });
  it("is empty for an answer with no wikilinks", () => {
    expect(citedPaths("plain text, a [markdown](link) and [single]", resolve)).toEqual([]);
  });
});

describe("scoreGrounding", () => {
  const entry = (notes: RecallLogEntry["notes"], msgIndex = 0): RecallLogEntry => ({ convoId: "c", msgIndex, at: 1, notes });
  const score = (entries: RecallLogEntry[], answers: Record<number, string | null>) =>
    scoreGrounding(entries, (e) => answers[e.msgIndex] ?? null, resolve);

  it("counts an answer citing a recalled note", () => {
    const s = score([entry([{ path: "Knowledge/Pricing.md" }])], { 0: "Per [[Knowledge/Pricing]] it is 10." });
    expect(s).toEqual({ turns: 1, withRecall: 1, citingRecalled: 1, supersededCitedAsCurrent: 0 });
  });
  it("counts an uncited answer as a turn with recall but no citation", () => {
    const s = score([entry([{ path: "Knowledge/Pricing.md" }])], { 0: "It is 10." });
    expect(s).toEqual({ turns: 1, withRecall: 1, citingRecalled: 0, supersededCitedAsCurrent: 0 });
  });
  it("citing a note that was not recalled is not a citation of recall", () => {
    const s = score([entry([{ path: "Knowledge/Pricing.md" }])], { 0: "See [[Exo]]." });
    expect(s.citingRecalled).toBe(0);
  });
  it("skips entries with no answer and counts a turn without notes only as a turn", () => {
    const s = score([entry([{ path: "Knowledge/Pricing.md" }], 0), entry([], 2)], { 2: "Hi." });
    expect(s).toEqual({ turns: 1, withRecall: 0, citingRecalled: 0, supersededCitedAsCurrent: 0 });
  });
  it("counts a superseded note cited without its head", () => {
    const e = entry([{ path: "Knowledge/Old/Pricing 2025.md", supersededBy: "Knowledge/Pricing.md" }]);
    expect(score([e], { 0: "The price is in [[Pricing 2025]]." }).supersededCitedAsCurrent).toBe(1);
  });
  it("does not count a superseded note when the answer also cites its head", () => {
    const e = entry([{ path: "Knowledge/Old/Pricing 2025.md", supersededBy: "Knowledge/Pricing.md" }]);
    const s = score([e], { 0: "It was in [[Pricing 2025]], now in [[Knowledge/Pricing]]." });
    expect(s.supersededCitedAsCurrent).toBe(0);
    expect(s.citingRecalled).toBe(1);
  });
  it("does not count a superseded note that is not cited", () => {
    const e = entry([{ path: "Knowledge/Old/Pricing 2025.md", supersededBy: "Knowledge/Pricing.md" }]);
    expect(score([e], { 0: "Use [[Knowledge/Pricing]]." }).supersededCitedAsCurrent).toBe(0);
  });
});

describe("answerAfter", () => {
  const msgs = [
    { role: "user", text: "q1" },
    { role: "assistant", segments: [{ t: "tool" }, { t: "text", md: "first" }, { t: "text", md: "second" }] },
    { role: "user", text: "q2" },
    { role: "user", text: "q3" },
    { role: "assistant", segments: [{ t: "error", message: "x" }] },
    { role: "user", text: "q4" },
    { role: "assistant", segments: [{ t: "text", md: "four" }] },
  ];
  it("joins the text of the assistant messages that follow, up to the next user message", () => {
    expect(answerAfter(msgs, 0)).toBe("first\nsecond");
    expect(answerAfter(msgs, 5)).toBe("four");
  });
  it("is null with no reply text, when the index is not a user message, or out of range", () => {
    expect(answerAfter(msgs, 2)).toBeNull();
    expect(answerAfter(msgs, 3)).toBeNull();
    expect(answerAfter(msgs, 1)).toBeNull();
    expect(answerAfter(msgs, 99)).toBeNull();
  });
});

describe("recallLogEntry", () => {
  const notes = [
    { path: "Knowledge/Pricing.md", excerpt: "SECRET BODY TEXT" },
    { path: "Knowledge/Old/Pricing 2025.md", excerpt: "more body", supersededBy: "Knowledge/Pricing.md" },
  ];
  it("points at the user message just pushed: message count minus 1", () => {
    expect(recallLogEntry({ convoId: "c1", messageCount: 5, at: 9, notes })?.msgIndex).toBe(4);
    expect(recallLogEntry({ convoId: "c1", messageCount: 1, at: 9, notes })?.msgIndex).toBe(0);
  });
  it("keeps paths and successors only, never an excerpt", () => {
    const e = recallLogEntry({ convoId: "c1", messageCount: 2, at: 9, notes })!;
    expect(e.notes).toEqual([{ path: "Knowledge/Pricing.md" }, { path: "Knowledge/Old/Pricing 2025.md", supersededBy: "Knowledge/Pricing.md" }]);
    expect(JSON.stringify(e)).not.toMatch(/BODY|body/);
  });
  it("is null with no notes or no messages", () => {
    expect(recallLogEntry({ convoId: "c1", messageCount: 2, at: 9, notes: [] })).toBeNull();
    expect(recallLogEntry({ convoId: "c1", messageCount: 0, at: 9, notes })).toBeNull();
  });
});
