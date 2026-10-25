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
  it("prefers a recalled path over the shortest for an ambiguous name", () => {
    const r = makeResolver([{ path: "SOUL.md" }, { path: "Agents/Exo/SOUL.md" }, { path: "Agents/Emily/SOUL.md" }]);
    expect(r("SOUL")).toBe("SOUL.md");
    expect(r("SOUL", ["Agents/Exo/SOUL.md"])).toBe("Agents/Exo/SOUL.md");
    expect(r("soul.md", ["Agents/Emily/SOUL.md", "Agents/Exo/SOUL.md"])).toBe("Agents/Emily/SOUL.md");
    expect(r("SOUL", ["Knowledge/Other.md"])).toBe("SOUL.md");
    expect(citedPaths("See [[SOUL]].", r, ["Agents/Exo/SOUL.md"])).toEqual(["Agents/Exo/SOUL.md"]);
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
  const entry = (notes: RecallLogEntry["notes"], msgIndex = 0): RecallLogEntry => ({ convoId: "c", msgIndex, userAt: 5, at: 6, notes });
  const score = (entries: RecallLogEntry[], answers: Record<number, string | null>) =>
    scoreGrounding(entries, (e) => answers[e.msgIndex] ?? null, resolve);

  it("counts an answer citing a recalled note", () => {
    const s = score([entry([{ path: "Knowledge/Pricing.md" }])], { 0: "Per [[Knowledge/Pricing]] it is 10." });
    expect(s).toEqual({ turns: 1, citingRecalled: 1, supersededCitedAsCurrent: 0 });
  });
  it("counts an uncited answer as a turn with recall but no citation", () => {
    const s = score([entry([{ path: "Knowledge/Pricing.md" }])], { 0: "It is 10." });
    expect(s).toEqual({ turns: 1, citingRecalled: 0, supersededCitedAsCurrent: 0 });
  });
  it("citing a note that was not recalled is not a citation of recall", () => {
    const s = score([entry([{ path: "Knowledge/Pricing.md" }])], { 0: "See [[Exo]]." });
    expect(s.citingRecalled).toBe(0);
  });
  it("skips entries with no answer", () => {
    const s = score([entry([{ path: "Knowledge/Pricing.md" }], 0), entry([{ path: "Knowledge/Pricing.md" }], 2)], { 2: "Hi." });
    expect(s).toEqual({ turns: 1, citingRecalled: 0, supersededCitedAsCurrent: 0 });
  });
  it("reads an ambiguous link as the recalled note", () => {
    const r = makeResolver([{ path: "SOUL.md" }, { path: "Agents/Exo/SOUL.md" }]);
    const e = entry([{ path: "Agents/Exo/SOUL.md" }]);
    expect(scoreGrounding([e], () => "Per [[SOUL]].", r).citingRecalled).toBe(1);
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
    { role: "user", text: "q1", at: 10 },
    { role: "assistant", segments: [{ t: "tool" }, { t: "text", md: "first" }, { t: "text", md: "second" }] },
    { role: "user", text: "q2", at: 20 },
    { role: "user", text: "q3", at: 30 },
    { role: "assistant", segments: [{ t: "error", message: "x" }] },
    { role: "user", text: "q4", at: 40 },
    { role: "assistant", segments: [{ t: "text", md: "four" }] },
  ];
  const at = (msgIndex: number, userAt: number) => ({ msgIndex, userAt });
  it("joins the text of the assistant messages that follow, up to the next user message", () => {
    expect(answerAfter(msgs, at(0, 10))).toBe("first\nsecond");
    expect(answerAfter(msgs, at(5, 40))).toBe("four");
  });
  it("is null with no reply text, when the index is not a user message, or out of range", () => {
    expect(answerAfter(msgs, at(2, 20))).toBeNull();
    expect(answerAfter(msgs, at(3, 30))).toBeNull();
    expect(answerAfter(msgs, at(1, 10))).toBeNull();
    expect(answerAfter(msgs, at(99, 10))).toBeNull();
  });
  it("does not join a chat that kept its id but not its messages", () => {
    // new session in the tab: same id, emptied, then a different first question
    const fresh = [{ role: "user", text: "other", at: 99 }, { role: "assistant", segments: [{ t: "text", md: "unrelated" }] }];
    expect(answerAfter(fresh, at(0, 10))).toBeNull();
    // rewind: the logged user message is gone and another sits at its index
    const rewound = [{ role: "user", text: "q1", at: 10 }, { role: "assistant", segments: [{ t: "text", md: "a1" }] }, { role: "user", text: "q2 again", at: 77 }, { role: "assistant", segments: [{ t: "text", md: "a2" }] }];
    expect(answerAfter(rewound, at(2, 20))).toBeNull();
    expect(answerAfter(rewound, at(0, 10))).toBe("a1");
    // an old message without a timestamp is never joined
    expect(answerAfter([{ role: "user", text: "q" }, { role: "assistant", segments: [{ t: "text", md: "a" }] }], at(0, 10))).toBeNull();
  });
  it("joins the retried answer after an error: the user bubble is reused", () => {
    const failed = [{ role: "user", text: "q", at: 10 }, { role: "assistant", segments: [{ t: "error", message: "boom" }] }];
    expect(answerAfter(failed, at(0, 10))).toBeNull();
    const retried = [...failed, { role: "assistant", segments: [{ t: "text", md: "retried answer" }] }];
    expect(answerAfter(retried, at(0, 10))).toBe("retried answer");
  });
});

describe("recallLogEntry", () => {
  const notes = [
    { path: "Knowledge/Pricing.md", excerpt: "SECRET BODY TEXT" },
    { path: "Knowledge/Old/Pricing 2025.md", excerpt: "more body", supersededBy: "Knowledge/Pricing.md" },
  ];
  const messages = [
    { role: "user", text: "a", at: 1 },
    { role: "assistant", segments: [] },
    { role: "user", text: "b", at: 7 },
  ];
  it("points at the last user message and its timestamp", () => {
    const e = recallLogEntry({ convoId: "c1", messages, at: 9, notes })!;
    expect([e.msgIndex, e.userAt, e.at]).toEqual([2, 7, 9]);
    expect(recallLogEntry({ convoId: "c1", messages: messages.slice(0, 1), at: 9, notes })).toMatchObject({ msgIndex: 0, userAt: 1 });
  });
  it("keeps paths and successors only, never an excerpt", () => {
    const e = recallLogEntry({ convoId: "c1", messages, at: 9, notes })!;
    expect(e.notes).toEqual([{ path: "Knowledge/Pricing.md" }, { path: "Knowledge/Old/Pricing 2025.md", supersededBy: "Knowledge/Pricing.md" }]);
    expect(JSON.stringify(e)).not.toMatch(/BODY|body/);
  });
  it("is null with no notes, no user message, or a user message without a timestamp", () => {
    expect(recallLogEntry({ convoId: "c1", messages, at: 9, notes: [] })).toBeNull();
    expect(recallLogEntry({ convoId: "c1", messages: [], at: 9, notes })).toBeNull();
    expect(recallLogEntry({ convoId: "c1", messages: [{ role: "user", text: "x" }], at: 9, notes })).toBeNull();
  });
});
