import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatSummary,
  recallItems,
  resolveChats,
  scoreCase,
  summarize,
  type EvalCase,
  type RecallItem,
} from "../src/core/recall-eval";
import type { ChatRecord } from "../src/core/recent-chats";

const note = (path: string, supersededBy?: string): RecallItem => ({ kind: "note", path, ...(supersededBy ? { supersededBy } : {}) });
const chat = (id: string): RecallItem => ({ kind: "chat", id });
const notes = (n: number): RecallItem[] => Array.from({ length: n }, (_, i) => note(`N/${i + 1}.md`));

describe("scoreCase", () => {
  const one: EvalCase = { id: "a", question: "?", expect: [{ note: "N/5.md" }] };

  it("counts a hit at rank k and a miss at rank k + 1", () => {
    expect(scoreCase(notes(5), one, 5)).toMatchObject({ hit: true, firstRank: 5, rr: 0.2 });
    const late: EvalCase = { ...one, expect: [{ note: "N/6.md" }] };
    expect(scoreCase(notes(8), late, 5)).toMatchObject({ hit: false, full: false, firstRank: 6, rr: 0 });
  });

  it("any expected source is a hit; all of them is full", () => {
    const two: EvalCase = { id: "b", question: "?", expect: [{ note: "N/2.md" }, { note: "Missing.md" }] };
    expect(scoreCase(notes(5), two)).toMatchObject({ hit: true, full: false, firstRank: 2, rr: 0.5 });
    const both: EvalCase = { ...two, expect: [{ note: "N/2.md" }, { note: "N/4.md" }] };
    expect(scoreCase(notes(5), both)).toMatchObject({ hit: true, full: true, firstRank: 2 });
  });

  it("ranks chats among chats: the turn injects notes and chats as two lists", () => {
    const c: EvalCase = { id: "c", question: "?", expect: [{ chat: { title: "T", date: "2026-10-07", id: "c9" } }] };
    expect(scoreCase([...notes(5), chat("c1"), chat("c9")], c)).toMatchObject({ hit: true, firstRank: 2, rr: 0.5 });
  });

  it("a chat the fixture could not resolve is never found", () => {
    const c: EvalCase = { id: "c", question: "?", expect: [{ chat: { title: "Gone", date: "2026-10-07" } }] };
    expect(scoreCase([chat("c1")], c)).toMatchObject({ hit: false, firstRank: null, rr: 0 });
  });

  it("a trap fires when a must-not-lead note is served in the top k as current", () => {
    const t: EvalCase = { id: "t", question: "?", expect: [{ note: "N/1.md" }], mustNotLead: ["N/4.md"] };
    expect(scoreCase(notes(5), t).trapLeads).toBe(true);
    expect(scoreCase(notes(3), t).trapLeads).toBe(false);
    const labelled = [note("N/1.md"), note("N/4.md", "N/1.md")];
    expect(scoreCase(labelled, t).trapLeads).toBe(false);
  });
});

describe("summarize", () => {
  it("adds up hits, full hits, traps and the mean reciprocal rank", () => {
    const s = summarize([
      { hit: true, full: true, firstRank: 1, rr: 1, trapLeads: false },
      { hit: true, full: false, firstRank: 2, rr: 0.5, trapLeads: true },
      { hit: false, full: false, firstRank: null, rr: 0, trapLeads: false },
      { hit: true, full: true, firstRank: 4, rr: 0.25, trapLeads: false },
    ]);
    expect(s).toEqual({ cases: 4, hitAt5: 3, fullAt5: 2, mrr: 0.4375, traps: 1 });
    expect(formatSummary(s)).toBe("hit@5 3/4 · full@5 2/4 · MRR 0.44 · traps 1");
  });
});

describe("resolveChats", () => {
  const day = (iso: string): number => new Date(`${iso}T12:00:00`).getTime();
  const rec = (id: string, title: string, at: string): ChatRecord => ({
    id,
    title,
    messages: [{ role: "user", text: "x", at: day(at) }],
  });

  it("finds the chat id by title, using the date when titles collide", () => {
    const c: EvalCase = { id: "q", question: "?", expect: [{ note: "A.md" }, { chat: { title: "Plan", date: "2026-10-07" } }] };
    const out = resolveChats(c, [rec("c1", "Plan", "2026-09-01"), rec("c2", "Plan", "2026-10-07"), rec("c3", "Other", "2026-10-07")]);
    expect(out.expect).toEqual([{ note: "A.md" }, { chat: { title: "Plan", date: "2026-10-07", id: "c2" } }]);
  });

  it("a single title match wins even when the date drifted", () => {
    const c: EvalCase = { id: "q", question: "?", expect: [{ chat: { title: "Plan", date: "2026-10-07" } }] };
    expect(resolveChats(c, [rec("c1", "Plan", "2026-10-06")]).expect).toEqual([
      { chat: { title: "Plan", date: "2026-10-07", id: "c1" } },
    ]);
  });

  it("leaves an unknown title unresolved", () => {
    const c: EvalCase = { id: "q", question: "?", expect: [{ chat: { title: "Nope", date: "2026-10-07" } }] };
    expect(resolveChats(c, [rec("c1", "Plan", "2026-10-07")]).expect).toEqual([{ chat: { title: "Nope", date: "2026-10-07" } }]);
  });
});

describe("recallItems", () => {
  it("lists notes then chats, keeping supersede labels", () => {
    expect(
      recallItems({
        notes: [{ path: "A.md", excerpt: "" }, { path: "B.md", excerpt: "", supersededBy: "A.md" }],
        chats: [{ id: "c1", title: "T", date: "2026-10-01", snippet: "", msgIndex: 0 }],
      }),
    ).toEqual([note("A.md"), note("B.md", "A.md"), chat("c1")]);
  });
});

describe("the eval fixture", () => {
  const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures", "recall-eval.json"), "utf8")) as { cases: EvalCase[] };

  it("holds the ten cases of plan 4.2, each with a question and at least one expected source", () => {
    expect(fixture.cases.map((c) => c.id)).toEqual(["q01", "q02", "q03", "q04", "q05", "q06", "q07", "q08", "q09", "q10"]);
    for (const c of fixture.cases) {
      expect(c.question.length).toBeGreaterThan(10);
      expect(c.expect.length).toBeGreaterThan(0);
    }
  });
});
