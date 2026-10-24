import { describe, expect, it } from "vitest";
import {
  buildDailyPulse,
  dailyPulseMetaLabel,
  type DailyPulseInput,
  type DailyPulseReviewState,
  type DailyPulseSection,
} from "../src/core/daily-pulse";

const NOW = Date.parse("2026-07-20T08:00:00.000Z");

function input(overrides: Partial<DailyPulseInput> = {}): DailyPulseInput {
  return {
    now: NOW,
    dueLoops: [],
    pendingProposals: [],
    automationRuns: [],
    recentNotes: [],
    budget: { remaining: null },
    ...overrides,
  };
}

function section(
  sections: DailyPulseSection[],
  title: DailyPulseSection["title"]
): DailyPulseSection | undefined {
  return sections.find((candidate) => candidate.title === title);
}

describe("buildDailyPulse", () => {
  it("builds all five sections with review/open targets and action metadata", () => {
    const result = buildDailyPulse(input({
      dueLoops: [{ id: "loop-1", title: "Follow up", resurface: "2026-07-20" }],
      pendingProposals: [{ id: "proposal-1", kind: "decision", title: "Choose pricing" }],
      automationRuns: [{ id: "run-1", name: "Morning sync", startedAt: NOW - 1_000, writes: ["Journal/today.md"] }],
      recentNotes: [{ path: "Active/Projects/Exo.md", mtime: NOW - 2_000 }],
      budget: { remaining: 3 },
    }));

    expect(result.generatedAt).toBe(NOW);
    expect(result.sections.map((value) => value.title)).toEqual([
      "Attention",
      "Open loops",
      "Suggestions",
      "Recent work",
      "System",
    ]);
    expect(section(result.sections, "Attention")?.items).toEqual([
      {
        id: "automation:run-1",
        kind: "automation",
        title: "Morning sync",
        detail: "1 write to review",
        target: { kind: "automation", id: "run-1" },
        action: { kind: "review", target: "automation", id: "run-1" },
      },
    ]);
    expect(section(result.sections, "Open loops")?.items[0]).toMatchObject({
      id: "loop:loop-1",
      target: { kind: "loop", id: "loop-1" },
      action: { kind: "review", target: "loop", id: "loop-1" },
    });
    expect(section(result.sections, "Suggestions")?.items[0]).toMatchObject({
      id: "proposal:proposal-1",
      detail: "Decision",
      target: { kind: "proposal", id: "proposal-1" },
      action: { kind: "review", target: "proposal", id: "proposal-1" },
    });
    expect(section(result.sections, "Recent work")?.items[0]).toEqual({
      id: "note:Active/Projects/Exo.md",
      kind: "note",
      title: "Exo",
      detail: "Active/Projects/Exo.md",
      target: { kind: "note", path: "Active/Projects/Exo.md" },
      action: { kind: "open", path: "Active/Projects/Exo.md" },
    });
    expect(section(result.sections, "System")?.items).toEqual([{
      id: "system:budget",
      kind: "system",
      title: "Background budget",
      detail: "3 remaining",
      target: { kind: "system", id: "budget" },
    }]);
  });

  it("omits empty sections, including System when budget is unknown", () => {
    expect(buildDailyPulse(input())).toEqual({ generatedAt: NOW, sections: [] });

    const result = buildDailyPulse(input({
      dueLoops: [{ id: "loop-1", title: "Only item" }],
    }));
    expect(result.sections.map((value) => value.title)).toEqual(["Open loops"]);
  });

  it("caps every section at five items, including the combined Attention section", () => {
    const result = buildDailyPulse(input({
      dueLoops: Array.from({ length: 7 }, (_, index) => ({ id: `loop-${index}`, title: `Loop ${index}` })),
      pendingProposals: Array.from({ length: 8 }, (_, index) => ({
        id: `proposal-${index}`,
        kind: "playbook" as const,
        title: `Proposal ${index}`,
      })),
      automationRuns: Array.from({ length: 6 }, (_, index) => ({
        id: `run-${index}`,
        name: `Run ${index}`,
        startedAt: NOW - index,
        writes: ["x.md"],
      })),
      recentNotes: Array.from({ length: 9 }, (_, index) => ({ path: `Note ${index}.md`, mtime: NOW - index })),
      budget: { remaining: 1 },
    }));

    for (const value of result.sections) expect(value.items.length).toBeLessThanOrEqual(5);
    expect(section(result.sections, "Attention")?.items).toHaveLength(5);
    expect(section(result.sections, "Open loops")?.items).toHaveLength(5);
    expect(section(result.sections, "Suggestions")?.items).toHaveLength(5);
    expect(section(result.sections, "Recent work")?.items).toHaveLength(5);
  });

  it("orders deterministically regardless of input order", () => {
    const values = input({
      dueLoops: [
        { id: "loop-later", title: "Later", resurface: "2026-07-20" },
        { id: "loop-now", title: "Now" },
      ],
      pendingProposals: [
        { id: "proposal-loop", kind: "loop", title: "Loop" },
        { id: "proposal-playbook", kind: "playbook", title: "Playbook" },
      ],
      automationRuns: [
        { id: "run-old", name: "Old", startedAt: NOW - 2_000, writes: ["old.md"] },
        { id: "run-new", name: "New", startedAt: NOW - 1_000, writes: ["new.md"] },
      ],
      recentNotes: [
        { path: "Old.md", mtime: NOW - 2_000 },
        { path: "New.md", mtime: NOW - 1_000 },
      ],
    });
    const reversed = input({
      ...values,
      dueLoops: [...values.dueLoops].reverse(),
      pendingProposals: [...values.pendingProposals].reverse(),
      automationRuns: [...values.automationRuns].reverse(),
      recentNotes: [...values.recentNotes].reverse(),
    });

    expect(buildDailyPulse(reversed)).toEqual(buildDailyPulse(values));
    expect(section(buildDailyPulse(values).sections, "Attention")?.items.map((item) => item.id)).toEqual([
      "automation:run-new",
      "automation:run-old",
    ]);
    expect(section(buildDailyPulse(values).sections, "Open loops")?.items.map((item) => item.id)).toEqual([
      "loop:loop-now",
      "loop:loop-later",
    ]);
  });

  it("handles zero budget, no-write runs, root notes, ties and does not mutate input", () => {
    const values = input({
      automationRuns: [
        { id: "ignored", name: "Read only", startedAt: NOW, writes: [] },
        { id: "run", name: "Writer", startedAt: NOW, writes: ["a.md", "b.md"] },
      ],
      recentNotes: [{ path: "README.md", mtime: NOW }],
      budget: { remaining: 0 },
    });
    const snapshot = structuredClone(values);
    const result = buildDailyPulse(values);

    expect(values).toEqual(snapshot);
    expect(section(result.sections, "Attention")?.items.map((item) => item.id)).toEqual([
      "automation:run",
    ]);
    expect(section(result.sections, "Attention")?.items.at(-1)?.detail).toBe("2 writes to review");
    expect(section(result.sections, "Recent work")?.items[0].title).toBe("README");
    expect(section(result.sections, "System")?.items[0].detail).toBe("Budget exhausted");
  });

  it("distinguishes paused background AI from an exhausted budget", () => {
    const result = buildDailyPulse(input({
      budget: { remaining: null, enabled: false },
    }));

    expect(section(result.sections, "System")?.items[0]).toMatchObject({
      title: "Background AI",
      detail: "Background AI paused",
    });
  });
});

describe("dailyPulseMetaLabel", () => {
  const state = (overrides: Partial<DailyPulseReviewState> = {}): DailyPulseReviewState => ({
    status: "ready",
    itemCount: 0,
    lastSuccessAt: 0,
    lastReviewedAt: 0,
    warnings: [],
    retryable: false,
    ...overrides,
  });
  it("reports retry on error regardless of items", () => {
    expect(dailyPulseMetaLabel(state({ status: "error", itemCount: 3 }))).toBe("retry available");
  });
  it("says ready to review, without a count, when a newer success is unreviewed", () => {
    expect(dailyPulseMetaLabel(state({ itemCount: 1, lastSuccessAt: 10 }))).toBe("ready to review");
    expect(dailyPulseMetaLabel(state({ itemCount: 4, lastSuccessAt: 10 }))).toBe("ready to review");
  });
  it("reports reviewed / not generated for the quiet states", () => {
    expect(dailyPulseMetaLabel(state({ itemCount: 2, lastSuccessAt: 10, lastReviewedAt: 20 }))).toBe("reviewed");
    expect(dailyPulseMetaLabel(state())).toBe("not generated");
  });
});
