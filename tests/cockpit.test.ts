import { describe, it, expect } from "vitest";
import {
  loopRows,
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
