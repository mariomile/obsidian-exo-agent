import { describe, it, expect } from "vitest";
import {
  currentSlotStart,
  formatDueIn,
  playbookScheduleLabel,
  isDue,
  nextDueAt,
  nextAutomation,
  cadenceLabel,
  migrateScheduledRuns,
  pruneRuns,
  awaitsReview,
  runOwner,
  parseCadenceInput,
  type AutomationConfig,
  type AutomationRunRecord,
} from "../src/core/automations";

/** Local-time epoch for readable fixtures. Wed 2026-07-15 is a Wednesday (day 3). */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

describe("currentSlotStart", () => {
  it("hourly → top of the current hour", () => {
    expect(currentSlotStart({ kind: "hourly" }, at(2026, 7, 15, 14, 37))).toBe(at(2026, 7, 15, 14));
  });
  it("daily before the hour → yesterday's slot", () => {
    expect(currentSlotStart({ kind: "daily", hour: 9 }, at(2026, 7, 15, 8, 59))).toBe(at(2026, 7, 14, 9));
  });
  it("daily after the hour → today's slot", () => {
    expect(currentSlotStart({ kind: "daily", hour: 9 }, at(2026, 7, 15, 9, 0))).toBe(at(2026, 7, 15, 9));
  });
  it("weekly → most recent day+hour occurrence, same-day boundary both sides", () => {
    const wedNine = { kind: "weekly", day: 3, hour: 9 } as const;
    expect(currentSlotStart(wedNine, at(2026, 7, 15, 10))).toBe(at(2026, 7, 15, 9)); // Wed after 9
    expect(currentSlotStart(wedNine, at(2026, 7, 15, 8))).toBe(at(2026, 7, 8, 9)); // Wed before 9 → last Wed
    expect(currentSlotStart(wedNine, at(2026, 7, 17, 12))).toBe(at(2026, 7, 15, 9)); // Fri → this Wed
  });
});

describe("isDue / nextDueAt", () => {
  const daily9 = { kind: "daily", hour: 9 } as const;
  it("never ran → due", () => {
    expect(isDue(daily9, 0, at(2026, 7, 15, 10))).toBe(true);
    expect(nextDueAt(daily9, 0, at(2026, 7, 15, 10))).toBe(at(2026, 7, 15, 10)); // now
  });
  it("ran in the current slot → not due, next = tomorrow's slot", () => {
    const now = at(2026, 7, 15, 10);
    expect(isDue(daily9, at(2026, 7, 15, 9, 5), now)).toBe(false);
    expect(nextDueAt(daily9, at(2026, 7, 15, 9, 5), now)).toBe(at(2026, 7, 16, 9));
  });
  it("ran yesterday → due again once today's slot opens, not before", () => {
    expect(isDue(daily9, at(2026, 7, 14, 9, 10), at(2026, 7, 15, 8, 30))).toBe(false);
    expect(isDue(daily9, at(2026, 7, 14, 9, 10), at(2026, 7, 15, 9, 1))).toBe(true);
  });
  it("hourly fires once per clock hour", () => {
    const h = { kind: "hourly" } as const;
    expect(isDue(h, at(2026, 7, 15, 14, 2), at(2026, 7, 15, 14, 40))).toBe(false);
    expect(isDue(h, at(2026, 7, 15, 14, 2), at(2026, 7, 15, 15, 0))).toBe(true);
    expect(nextDueAt(h, at(2026, 7, 15, 14, 2), at(2026, 7, 15, 14, 40))).toBe(at(2026, 7, 15, 15));
  });
});

describe("nextAutomation", () => {
  const autos: AutomationConfig[] = [
    { name: "A", cadence: { kind: "daily", hour: 9 }, enabled: true, write: false },
    { name: "B", cadence: { kind: "hourly" }, enabled: true, write: true },
    { name: "C", cadence: { kind: "daily", hour: 6 }, enabled: false, write: false },
  ];
  it("returns the soonest enabled automation, skipping disabled", () => {
    const now = at(2026, 7, 15, 10, 30);
    const last = { A: at(2026, 7, 15, 9, 5), B: at(2026, 7, 15, 10, 2), C: 0 };
    expect(nextAutomation(autos, last, now)).toEqual({ name: "B", dueAt: at(2026, 7, 15, 11) });
  });
  it("due-now wins immediately", () => {
    const now = at(2026, 7, 15, 10, 30);
    expect(nextAutomation(autos, {}, now)?.dueAt).toBe(now);
  });
  it("empty/all-disabled → null", () => {
    expect(nextAutomation([], {}, 0)).toBeNull();
    expect(nextAutomation([autos[2]], {}, at(2026, 7, 15))).toBeNull();
  });
});

describe("cadenceLabel", () => {
  it("formats the three kinds", () => {
    expect(cadenceLabel({ kind: "hourly" })).toBe("hourly");
    expect(cadenceLabel({ kind: "daily", hour: 7 })).toBe("daily 07:00");
    expect(cadenceLabel({ kind: "weekly", day: 1, hour: 18 })).toBe("weekly Mon 18:00");
  });
});

describe("migrateScheduledRuns", () => {
  it("converts legacy lines, defaults 07:00 / Monday, write off", () => {
    expect(migrateScheduledRuns("Morning brief | daily\nWeekly review | weekly\n\nbad line\nX | monthly")).toEqual([
      { name: "Morning brief", cadence: { kind: "daily", hour: 7 }, enabled: true, write: false },
      { name: "Weekly review", cadence: { kind: "weekly", day: 1, hour: 7 }, enabled: true, write: false },
    ]);
  });
  it("empty input → empty list", () => {
    expect(migrateScheduledRuns("")).toEqual([]);
  });
});

describe("pruneRuns", () => {
  const rec = (id: string, startedAt: number): AutomationRunRecord => ({
    id,
    name: "A",
    startedAt,
    ok: true,
    reportPath: "",
    writes: [],
    checkpoint: [],
  });
  it("keeps the newest N, newest first", () => {
    const pruned = pruneRuns([rec("a", 1), rec("b", 3), rec("c", 2)], 2);
    expect(pruned.map((r) => r.id)).toEqual(["b", "c"]);
  });
});

describe("awaitsReview", () => {
  const rec = (id: string, over: Partial<AutomationRunRecord>): AutomationRunRecord => ({
    id,
    name: "A",
    startedAt: 1,
    ok: true,
    reportPath: "",
    writes: ["x.md"],
    checkpoint: [],
    ...over,
  });
  it("excludes read-only, reviewed, and restored runs", () => {
    const pool = [
      rec("live", {}),
      rec("readonly", { writes: [] }),
      rec("reviewed", { reviewedAt: 5 }),
      rec("restored", { restoredAt: 5 }),
    ].filter(awaitsReview);
    expect(pool.map((r) => r.id)).toEqual(["live"]);
  });
});

describe("runOwner", () => {
  const rec = (name: string, slug?: string): AutomationRunRecord => ({
    id: name, name, startedAt: 1, ok: true, reportPath: "", writes: [], checkpoint: [], ...(slug ? { slug } : {}),
  });
  const autos = [{ slug: "triager", name: "Inbox Triager" }, { slug: "digest", name: "Digest" }];
  it("files a run by its slug, a pre-v2 run by the automation claiming its name, else nowhere", () => {
    expect(runOwner(rec("Anything", "digest"), autos)).toBe("digest");
    expect(runOwner(rec("Inbox Triager", "deleted"), autos), "a deleted automation's runs").toBeNull();
    expect(runOwner(rec("Inbox Triager"), autos)).toBe("triager");
    expect(runOwner(rec("Inbox Triager (create _inbox x.md)"), autos)).toBe("triager");
    expect(runOwner(rec("Gone"), autos)).toBeNull();
  });
});

describe("parseCadenceInput", () => {
  it("parses the three kinds with defaults", () => {
    expect(parseCadenceInput("hourly")).toEqual({ kind: "hourly" });
    expect(parseCadenceInput("daily")).toEqual({ kind: "daily", hour: 7 });
    expect(parseCadenceInput("weekly")).toEqual({ kind: "weekly", day: 1, hour: 7 });
  });
  it("accepts day names in English and Italian, case-insensitive", () => {
    expect(parseCadenceInput("weekly", 18, "Friday")).toEqual({ kind: "weekly", day: 5, hour: 18 });
    expect(parseCadenceInput("weekly", 9, "lunedì")).toEqual({ kind: "weekly", day: 1, hour: 9 });
    expect(parseCadenceInput("weekly", 9, "mer")).toEqual({ kind: "weekly", day: 3, hour: 9 });
  });
  it("rejects invalid kind, hour, day", () => {
    expect(parseCadenceInput("monthly")).toBeNull();
    expect(parseCadenceInput("daily", 24)).toBeNull();
    expect(parseCadenceInput("weekly", 9, 7)).toBeNull();
    expect(parseCadenceInput("weekly", 9, "boh")).toBeNull();
  });
});

describe("formatDueIn", () => {
  const M = 60_000, H = 3_600_000, D = 24 * H;
  it("collapses anything within a minute to 'due now'", () => {
    expect(formatDueIn(0)).toBe("due now");
    expect(formatDueIn(59_000)).toBe("due now");
    expect(formatDueIn(-5_000)).toBe("due now");
  });
  it("formats minutes, hours, days with floor", () => {
    expect(formatDueIn(5 * M)).toBe("in 5m");
    expect(formatDueIn(H - 1)).toBe("in 59m");
    expect(formatDueIn(3 * H + 30 * M)).toBe("in 3h");
    expect(formatDueIn(2 * D + 5 * H)).toBe("in 2d");
  });
});

describe("playbookScheduleLabel", () => {
  const autos: AutomationConfig[] = [
    { name: "Morning Brief", cadence: { kind: "daily", hour: 8 }, enabled: true, write: false },
    { name: "paused one", cadence: { kind: "hourly" }, enabled: false, write: false },
  ];
  it("matches enabled automations case-insensitively", () => {
    expect(playbookScheduleLabel("morning brief", autos)).toBe("daily 08:00");
  });
  it("ignores disabled automations and unknown names", () => {
    expect(playbookScheduleLabel("paused one", autos)).toBeNull();
    expect(playbookScheduleLabel("nope", autos)).toBeNull();
  });
});
