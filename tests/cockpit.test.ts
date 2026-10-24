import { describe, it, expect } from "vitest";
import {
  buildAttention,
  loopRows,
  resumeRows,
  previewFromMessages,
  healthRows,
  quotaValue,
  parseAnsweredStamp,
} from "../src/core/cockpit";
import type { LoopEntry } from "../src/core/open-loops";

const DAY = 86_400_000;
const NOW = Date.parse("2026-07-13T12:00:00");

const loop = (over: Partial<LoopEntry>): LoopEntry => ({
  id: `loop-${over.openedAt ?? 1}`,
  title: "t",
  note: "",
  openedAt: 1,
  status: "open",
  ...over,
});

describe("buildAttention", () => {
  it("orders blocked > streaming > fresh answers, capped", () => {
    const items = buildAttention({
      convos: [
        { id: "c1", title: "A", blocked: false, streaming: true },
        { id: "c2", title: "B", blocked: true, streaming: true },
      ],
      answers: [
        { path: "q/x.md", name: "x", answeredAt: NOW - DAY / 2 },
        { path: "q/old.md", name: "old", answeredAt: NOW - 2 * DAY },
      ],
      now: NOW,
    });
    expect(items.map((i) => i.kind)).toEqual(["blocked", "streaming", "answer"]);
    expect(items[0].target).toBe("c2");
    expect(items[2].target).toBe("q/x.md");
  });

  it("empty input → empty list", () => {
    expect(buildAttention({ convos: [], answers: [], now: NOW })).toEqual([]);
  });
});

describe("loopRows", () => {
  it("due loops first, badge due, seeds an ask action", () => {
    const rows = loopRows(
      [
        loop({ id: "loop-1", title: "later", openedAt: 1, resurface: "2099-01-01" }),
        loop({ id: "loop-2", title: "now", openedAt: 2 }),
        loop({ id: "loop-3", title: "closed", openedAt: 3, status: "closed" }),
      ],
      NOW
    );
    expect(rows.map((r) => r.label)).toEqual(["now", "later"]);
    expect(rows[0].badge).toBe("due");
    expect(rows[1].badge).toBeUndefined();
    expect(rows[0].action).toEqual({ kind: "ask", arg: "Let's close this loop: now" });
  });

  it("caps the list", () => {
    const many = Array.from({ length: 9 }, (_, i) => loop({ id: `loop-${i}`, title: `l${i}`, openedAt: i }));
    expect(loopRows(many, NOW, 6)).toHaveLength(6);
  });
});

describe("resumeRows", () => {
  it("most recent first, carries preview + age badge, opens the convo", () => {
    const rows = resumeRows(
      [
        { id: "c1", title: "Old", updatedAt: NOW - 3 * DAY, preview: "old p" },
        { id: "c2", title: "New", updatedAt: NOW - 60_000, preview: "new p" },
      ],
      NOW
    );
    expect(rows[0].label).toBe("New");
    expect(rows[0].sub).toBe("new p");
    expect(rows[0].badge).toBe("1m ago");
    expect(rows[0].action).toEqual({ kind: "convo", arg: "c2" });
  });
});

describe("previewFromMessages", () => {
  it("takes the last non-empty text, collapsed and capped", () => {
    const p = previewFromMessages(
      [
        { role: "user", text: "first" },
        { role: "assistant", segments: [{ t: "tool" }, { t: "text", md: "  the   answer  " }] },
      ],
      10
    );
    expect(p).toBe("the answe…");
  });

  it("empty transcript → empty string", () => {
    expect(previewFromMessages([])).toBe("");
  });
});

describe("healthRows", () => {
  it("inbox count, stale context, last report", () => {
    const rows = healthRows({
      inboxCount: 4,
      stateNote: { path: "_system/vault-context.md", ageDays: 12 },
      lastReport: { path: "_system/reports/r.md", name: "r", mtime: NOW - DAY },
      now: NOW,
    });
    expect(rows.map((r) => r.action.kind)).toEqual(["ask", "ask", "open"]);
    expect(rows[0].badge).toBe("4");
    expect(rows[1].badge).toBe("12d");
  });

  it("stale row names the measured state note", () => {
    const rows = healthRows({
      inboxCount: 0,
      stateNote: { path: "_system/agent/NOW.md", ageDays: 9 },
      lastReport: null,
      now: NOW,
    });
    expect(rows[0].label).toBe("NOW.md stale");
    expect(rows[0].action.arg).toContain("_system/agent/NOW.md");
  });

  it("healthy vault → no rows", () => {
    expect(
      healthRows({ inboxCount: 0, stateNote: { path: "_system/vault-context.md", ageDays: 2 }, lastReport: null, now: NOW })
    ).toEqual([]);
    expect(healthRows({ inboxCount: 0, stateNote: null, lastReport: null, now: NOW })).toEqual([]);
  });
});

describe("quotaValue", () => {
  it("percentage, rejected, and absent states", () => {
    expect(quotaValue({ status: "ok", utilization: 43.4 })).toBe("43% used");
    expect(quotaValue({ status: "rejected" })).toBe("limit reached");
    expect(quotaValue(null)).toBeNull();
    expect(quotaValue({ status: "ok" })).toBeNull();
  });
});

describe("parseAnsweredStamp", () => {
  it("parses the queue stamp (local time) and rejects notes without one", () => {
    const t = parseAnsweredStamp("---\nexo-answered: 2026-07-13 10:30\n---\nbody");
    expect(t).toBe(new Date(2026, 6, 13, 10, 30).getTime());
    expect(parseAnsweredStamp("---\ntags: x\n---\nbody")).toBeNull();
  });
});

describe("buildAttention — unreviewed runs", () => {
  it("surfaces the runs item after blocked, with singular/plural label", () => {
    const one = buildAttention({ convos: [], answers: [], unreviewedRuns: 1, now: NOW });
    expect(one).toEqual([{ kind: "runs", label: "1 automation run to review" }]);
    const items = buildAttention({
      convos: [{ id: "c2", title: "B", blocked: true, streaming: false }],
      answers: [],
      unreviewedRuns: 3,
      now: NOW,
    });
    expect(items.map((i) => i.kind)).toEqual(["blocked", "runs"]);
    expect(items[1].label).toBe("3 automation runs to review");
  });

  it("zero/absent → no item", () => {
    expect(buildAttention({ convos: [], answers: [], unreviewedRuns: 0, now: NOW })).toEqual([]);
    expect(buildAttention({ convos: [], answers: [], now: NOW })).toEqual([]);
  });
});

describe("buildAttention — Daily Pulse", () => {
  it("shows one compact badge only when review items are pending", () => {
    expect(buildAttention({
      convos: [],
      answers: [],
      dailyPulseItems: 1,
      now: NOW,
    })).toEqual([{ kind: "pulse", label: "Daily Pulse · 1 item" }]);
    expect(buildAttention({
      convos: [],
      answers: [],
      dailyPulseItems: 3,
      now: NOW,
    })[0].label).toBe("Daily Pulse · 3 items");
    expect(buildAttention({
      convos: [],
      answers: [],
      dailyPulseItems: 0,
      now: NOW,
    })).toEqual([]);
  });
});
