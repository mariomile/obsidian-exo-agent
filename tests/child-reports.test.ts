import { describe, it, expect } from "vitest";
import {
  outcomeFromState,
  buildExcerpt,
  formatReportsForParent,
  queueReportForParent,
  drainReportsForParent,
  lastAssistantText,
  reviveChildReports,
  EXCERPT_CAP,
  MAX_PENDING_CHILD_REPORTS,
  type ChildReport,
} from "../src/core/child-reports";

describe("outcomeFromState", () => {
  it("maps a clean turn-end to done", () => {
    expect(outcomeFromState("turn-end")).toBe("done");
  });

  it("maps needs-input with an error reason to error, and otherwise to blocked", () => {
    expect(outcomeFromState("needs-input", "error")).toBe("error");
    expect(outcomeFromState("needs-input", "perm")).toBe("blocked");
    expect(outcomeFromState("needs-input", "ask")).toBe("blocked");
  });

  it("maps needs-input with no reason at all to blocked, not error", () => {
    expect(outcomeFromState("needs-input")).toBe("blocked");
  });

  it("maps stopped to stopped", () => {
    expect(outcomeFromState("stopped", "stopped")).toBe("stopped");
  });

  it("maps a direct error state to error", () => {
    expect(outcomeFromState("error")).toBe("error");
  });

  it("returns null for turn-start, which is not an outcome", () => {
    expect(outcomeFromState("turn-start")).toBeNull();
  });
});

describe("buildExcerpt", () => {
  it("returns short text unchanged", () => {
    expect(buildExcerpt("all done")).toBe("all done");
  });

  it("caps long text and marks the truncation", () => {
    const out = buildExcerpt("x".repeat(EXCERPT_CAP + 500));
    expect(out.length).toBeLessThanOrEqual(EXCERPT_CAP + 20);
    expect(out).toContain("truncated");
  });

  it("does not truncate or mark text exactly at the cap", () => {
    const exact = "y".repeat(EXCERPT_CAP);
    const out = buildExcerpt(exact);
    expect(out).toBe(exact);
    expect(out).not.toContain("truncated");
  });

  it("truncates text one character past the cap", () => {
    const overByOne = "z".repeat(EXCERPT_CAP + 1);
    const out = buildExcerpt(overByOne);
    expect(out).toContain("truncated");
    expect(out.startsWith("z".repeat(EXCERPT_CAP))).toBe(true);
  });

  it("trims surrounding whitespace", () => {
    expect(buildExcerpt("  hi\n\n")).toBe("hi");
  });

  it("trims before capping, so cap boundary is measured on trimmed text", () => {
    const padded = `  ${"a".repeat(EXCERPT_CAP)}  `;
    const out = buildExcerpt(padded);
    expect(out).toBe("a".repeat(EXCERPT_CAP));
    expect(out).not.toContain("truncated");
  });

  it("returns empty string unchanged", () => {
    expect(buildExcerpt("")).toBe("");
  });
});

describe("formatReportsForParent", () => {
  const base: ChildReport = {
    taskId: "task-1",
    childConvoId: "convo-b",
    parentConvoId: "convo-a",
    title: "Research pricing",
    outcome: "done",
    excerpt: "Found three competitors.",
    at: 1720000000000,
  };

  it("names the child, its outcome and its excerpt", () => {
    const out = formatReportsForParent([base]);
    expect(out).toContain("Research pricing");
    expect(out).toContain("done");
    expect(out).toContain("Found three competitors.");
  });

  it("batches several reports into one message", () => {
    const out = formatReportsForParent([base, { ...base, taskId: "task-2", title: "Draft post" }]);
    expect(out).toContain("Research pricing");
    expect(out).toContain("Draft post");
  });

  it("carries anti-hallucination guidance for stopped children", () => {
    const out = formatReportsForParent([{ ...base, outcome: "stopped" }]);
    expect(out.toLowerCase()).toContain("do not resume");
  });

  it("does not carry the stopped guidance when nothing was stopped", () => {
    const out = formatReportsForParent([base]);
    expect(out.toLowerCase()).not.toContain("do not resume");
  });

  /**
   * The guidance has to hold at BOTH edges of a batch. "One of these was
   * stopped by hand" was false for a single report (there is no "these") and
   * worse for two — it names ONE, which an agent can read as licence to resume
   * the other. It is the guardrail against resuming work a human deliberately
   * killed, so it must never be phrased as a count.
   */
  it("phrases the stopped guidance without a count, for a batch of exactly one", () => {
    const out = formatReportsForParent([{ ...base, outcome: "stopped" }]);
    expect(out).not.toMatch(/one of these/i);
    expect(out.toLowerCase()).toContain("do not resume");
  });

  it("covers EVERY stopped child when two or more were stopped", () => {
    const out = formatReportsForParent([
      { ...base, taskId: "task-1", title: "Research pricing", outcome: "stopped" },
      { ...base, taskId: "task-2", title: "Draft post", outcome: "stopped" },
    ]);
    expect(out).not.toMatch(/one of these/i);
    // One guidance line, not one per report, and it must not single any of them out.
    expect(out.match(/do not resume/gi)).toHaveLength(1);
    expect(out).toContain("Research pricing");
    expect(out).toContain("Draft post");
  });

  it("still carries the guidance when only SOME of a mixed batch was stopped", () => {
    const out = formatReportsForParent([base, { ...base, taskId: "task-2", outcome: "stopped" }]);
    expect(out.toLowerCase()).toContain("do not resume");
    expect(out).not.toMatch(/one of these/i);
  });

  it("distinguishes blocked from error children in the rendered text", () => {
    const blocked = formatReportsForParent([{ ...base, outcome: "blocked" }]);
    const error = formatReportsForParent([{ ...base, outcome: "error" }]);
    expect(blocked).not.toBe(error);
    // A reviewer skimming this must be able to tell "waiting" from "failed"
    // without cross-referencing anything else.
    expect(blocked.toLowerCase()).not.toContain("fail");
    expect(error.toLowerCase()).toMatch(/fail|error/);
  });

  it("reads as prose, not as a tool result: no JSON braces or key:value dumps", () => {
    const out = formatReportsForParent([base]);
    expect(out).not.toContain("{");
    expect(out).not.toContain("}");
    expect(out).not.toMatch(/"taskId"/);
  });

  it("returns an empty string for no reports", () => {
    expect(formatReportsForParent([])).toBe("");
  });
});

/** The structural slice `queueReportForParent` needs — the view's `Convo`
 *  satisfies it, so these tests exercise the real production shape. */
type Holder = { id: string; pendingChildReports?: ChildReport[] };

describe("queueReportForParent — routing", () => {
  const holder = (id: string): Holder => ({ id });
  const report = (over: Partial<ChildReport> = {}): ChildReport => ({
    taskId: "task-1",
    childConvoId: "convo-child",
    parentConvoId: "convo-parent",
    title: "Research pricing",
    outcome: "done",
    excerpt: "Found three competitors.",
    at: 1720000000000,
    ...over,
  });

  it("one report per task: a newer outcome replaces the older (blocked, then done)", () => {
    const parent = holder("convo-parent");
    queueReportForParent([parent], report({ outcome: "blocked", at: 1 }));
    queueReportForParent([parent], report({ taskId: "task-2", at: 2 }));
    queueReportForParent([parent], report({ outcome: "done", at: 3 }));
    expect(parent.pendingChildReports!.map((r) => `${r.taskId}:${r.outcome}`)).toEqual(["task-2:done", "task-1:done"]);
  });

  it("queues onto the conversation named by parentConvoId", () => {
    const parent = holder("convo-parent");
    const other = holder("convo-other");
    const hit = queueReportForParent([other, parent], report());
    expect(hit).toBe(parent);
    expect(parent.pendingChildReports).toHaveLength(1);
    expect(other.pendingChildReports).toBeUndefined();
  });

  /**
   * The whole reason `parentConvoId` is on the report. A child that never
   * started has no convo, so `childConvoId` is "" — resolving the parent by
   * looking THAT up among the conversations finds nothing and silently drops
   * the one report the parent most needs (its child never ran).
   */
  it("delivers a spawn-failure report, whose childConvoId is empty", () => {
    const parent = holder("convo-parent");
    const hit = queueReportForParent([parent], report({ childConvoId: "", outcome: "error" }));
    expect(hit).toBe(parent);
    expect(parent.pendingChildReports?.[0].outcome).toBe("error");
  });

  it("never routes by childConvoId: a convo that merely IS the child gets nothing", () => {
    // The child's own conversation is present and the parent's is not. A
    // childConvoId-based lookup would deliver the report to the child itself.
    const child = holder("convo-child");
    expect(queueReportForParent([child], report())).toBeUndefined();
    expect(child.pendingChildReports).toBeUndefined();
  });

  it("drops a report for a vanished parent without throwing", () => {
    expect(() => queueReportForParent([holder("convo-somebody-else")], report())).not.toThrow();
    expect(queueReportForParent([] as Holder[], report())).toBeUndefined();
  });

  it("accumulates several children's reports on the same parent, in arrival order", () => {
    const parent = holder("convo-parent");
    queueReportForParent([parent], report({ taskId: "task-1" }));
    queueReportForParent([parent], report({ taskId: "task-2" }));
    expect(parent.pendingChildReports?.map((r) => r.taskId)).toEqual(["task-1", "task-2"]);
  });

  /**
   * The queue is now persisted, so an unbounded one is an unbounded write to
   * conversations.json. Capped where it is FILLED (not only where it is saved),
   * so runtime and disk can never disagree about what the parent is holding.
   */
  it("caps the queue at MAX_PENDING_CHILD_REPORTS, dropping the OLDEST", () => {
    const parent = holder("convo-parent");
    const n = MAX_PENDING_CHILD_REPORTS + 4;
    for (let i = 0; i < n; i++) queueReportForParent([parent], report({ taskId: `task-${i}` }));
    const ids = parent.pendingChildReports!.map((r) => r.taskId);
    expect(ids).toHaveLength(MAX_PENDING_CHILD_REPORTS);
    // The newest survive: an old report is the one whose news is stalest.
    expect(ids[ids.length - 1]).toBe(`task-${n - 1}`);
    expect(ids).not.toContain("task-0");
  });
});

/**
 * Reload durability. A child finishing at 14:00 sets the parent's unread
 * affordance, which survives a restart; before this the report CONTENT did not,
 * so the parent advertised news it could never deliver and the model never
 * received its child's output — the entire point of the feature.
 *
 * `conversations.json` is a plain file: a half-written or hand-edited entry
 * must not put junk onto a live Convo, where the next turn would splice it
 * verbatim into the outbound message.
 */
describe("reviveChildReports — what comes back off disk", () => {
  const onDisk = (over: Partial<ChildReport> = {}): ChildReport => ({
    taskId: "task-1",
    childConvoId: "convo-child",
    parentConvoId: "convo-parent",
    title: "Research pricing",
    outcome: "done",
    excerpt: "Found three competitors.",
    at: 1720000000000,
    ...over,
  });

  it("round-trips a queued report unchanged", () => {
    const saved = [onDisk(), onDisk({ taskId: "task-2", outcome: "stopped" })];
    const back = reviveChildReports(JSON.parse(JSON.stringify(saved)));
    expect(back).toEqual(saved);
    // Formatting the revived queue must produce the same message the live one
    // would have — the report is only worth persisting if it still reads right.
    expect(formatReportsForParent(back!)).toBe(formatReportsForParent(saved));
  });

  it("returns undefined for absent or empty, so a normal chat stays clean", () => {
    expect(reviveChildReports(undefined)).toBeUndefined();
    expect(reviveChildReports([])).toBeUndefined();
    expect(reviveChildReports(null)).toBeUndefined();
    expect(reviveChildReports("not an array")).toBeUndefined();
    expect(reviveChildReports({ 0: onDisk() })).toBeUndefined();
  });

  it("drops entries that could not be delivered or rendered", () => {
    const back = reviveChildReports([
      onDisk(),
      { ...onDisk({ taskId: "task-x" }), parentConvoId: "" }, // unroutable
      { ...onDisk({ taskId: "task-y" }), outcome: "elsewhere" }, // unknown outcome
      { taskId: "task-z" }, // half-written
      null,
      "garbage",
    ]);
    expect(back?.map((r) => r.taskId)).toEqual(["task-1"]);
  });

  it("caps a hand-grown file at MAX_PENDING_CHILD_REPORTS, keeping the newest", () => {
    const many = Array.from({ length: MAX_PENDING_CHILD_REPORTS + 5 }, (_, i) =>
      onDisk({ taskId: `task-${i}` })
    );
    const back = reviveChildReports(many)!;
    expect(back).toHaveLength(MAX_PENDING_CHILD_REPORTS);
    expect(back[back.length - 1].taskId).toBe(`task-${MAX_PENDING_CHILD_REPORTS + 4}`);
  });

  it("never hands back the caller's own array, so disk data can't alias live state", () => {
    const saved = [onDisk()];
    const back = reviveChildReports(saved)!;
    back[0].excerpt = "mutated";
    expect(saved[0].excerpt).toBe("Found three competitors.");
  });
});

describe("drainReportsForParent — consumed exactly once", () => {
  const queued = (n: number): Holder => ({
    id: "convo-parent",
    pendingChildReports: Array.from({ length: n }, (_, i) => ({
      taskId: `task-${i}`,
      childConvoId: `convo-${i}`,
      parentConvoId: "convo-parent",
      title: `Child ${i}`,
      outcome: "done" as const,
      excerpt: `Result ${i}`,
      at: 1720000000000 + i,
    })),
  });

  it("renders every queued report and empties the queue in the same step", () => {
    const parent = queued(2);
    const text = drainReportsForParent(parent);
    expect(text).toContain("Child 0");
    expect(text).toContain("Child 1");
    expect(parent.pendingChildReports).toEqual([]);
  });

  /** The prefix is rebuilt on every turn: a drain that only formats would ride
   *  the same "your child finished" message on turn after turn forever. */
  it("returns nothing on the NEXT turn — the report never rides twice", () => {
    const parent = queued(1);
    expect(drainReportsForParent(parent)).not.toBe("");
    expect(drainReportsForParent(parent)).toBe("");
    expect(drainReportsForParent(parent)).toBe("");
  });

  it("returns '' for an empty or absent queue, so the caller can filter it out", () => {
    expect(drainReportsForParent({ id: "p" })).toBe("");
    expect(drainReportsForParent({ id: "p", pendingChildReports: [] })).toBe("");
  });

  it("agrees with formatReportsForParent on the same batch", () => {
    const parent = queued(2);
    const expected = formatReportsForParent(parent.pendingChildReports!);
    expect(drainReportsForParent(parent)).toBe(expected);
  });
});

describe("lastAssistantText — the excerpt source", () => {
  const assistant = (...mds: string[]) => ({
    role: "assistant",
    segments: mds.map((md) => ({ t: "text", md })),
  });

  /**
   * The regression this function exists for. An assistant `Message` has NO
   * `text` field — only `segments` (core/model.ts) — so the obvious
   * `m.text` reads `undefined` and every child report ships an empty excerpt.
   * Nothing downstream notices: the report still arrives, it just says nothing.
   */
  it("reads an assistant turn's text out of its segments, not a text field", () => {
    expect(lastAssistantText([assistant("Found three competitors.")])).toBe(
      "Found three competitors.",
    );
  });

  it("takes the LAST assistant turn, not the first", () => {
    expect(lastAssistantText([assistant("Old answer."), assistant("Fresh answer.")])).toBe(
      "Fresh answer.",
    );
  });

  it("ignores user turns, whose text really does live on `text`", () => {
    const msgs = [assistant("The answer."), { role: "user", text: "thanks" }];
    expect(lastAssistantText(msgs)).toBe("The answer.");
  });

  it("joins several text segments of the same turn", () => {
    expect(lastAssistantText([assistant("First.", "Second.")])).toBe("First.\nSecond.");
  });

  it("skips non-text segments — a tool call is not something the child said", () => {
    const msgs = [
      {
        role: "assistant",
        segments: [
          { t: "tool", md: undefined },
          { t: "text", md: "Done." },
        ],
      },
    ];
    expect(lastAssistantText(msgs)).toBe("Done.");
  });

  /** A child whose final act was a tool call has no prose of its own.
   *  Reporting the last thing it DID say beats reporting silence. */
  it("falls back to the last turn that actually said something", () => {
    const msgs = [
      assistant("Here is the plan."),
      { role: "assistant", segments: [{ t: "tool", md: undefined }] },
    ];
    expect(lastAssistantText(msgs)).toBe("Here is the plan.");
  });

  it("returns '' for a conversation with nothing to quote", () => {
    expect(lastAssistantText([])).toBe("");
    expect(lastAssistantText([{ role: "user", text: "hi" }])).toBe("");
    expect(lastAssistantText([{ role: "assistant" }])).toBe("");
    expect(lastAssistantText([assistant("   ")])).toBe("");
  });
});
