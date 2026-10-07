import { describe, expect, it } from "vitest";
import {
  describeScheduled,
  isLate,
  nextDueAt,
  parseWhen,
  scheduledMessage,
  takeDue,
  type ScheduledPrompt,
} from "../src/core/scheduled-prompts";

const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const p = (over: Partial<ScheduledPrompt>): ScheduledPrompt => ({
  id: "s1",
  prompt: "Check the inbox",
  dueAt: at(2026, 10, 7, 9),
  target: "c1",
  createdAt: 0,
  ...over,
});

describe("takeDue", () => {
  it("runs a due one-off once and drops it, keeps a future one", () => {
    const now = at(2026, 10, 7, 9, 1);
    const later = p({ id: "s2", dueAt: at(2026, 10, 7, 10) });
    const { due, rest } = takeDue([p({}), later], now);
    expect(due.map((x) => x.id)).toEqual(["s1"]);
    expect(rest).toEqual([later]);
  });

  it("moves a recurring prompt to its next time and records the run", () => {
    const now = at(2026, 10, 7, 9, 1);
    const { due, rest } = takeDue([p({ repeat: "daily" })], now);
    expect(due).toHaveLength(1);
    expect(rest[0].dueAt).toBe(at(2026, 10, 8, 9));
    expect(rest[0].lastRunAt).toBe(now);
  });
});

describe("nextDueAt", () => {
  it("skips missed occurrences instead of replaying them", () => {
    const now = at(2026, 10, 10, 12);
    expect(nextDueAt(at(2026, 10, 7, 9), "daily", now)).toBe(at(2026, 10, 11, 9));
    expect(nextDueAt(at(2026, 10, 7, 9), "weekly", now)).toBe(at(2026, 10, 14, 9));
    expect(nextDueAt(at(2026, 10, 10, 9), "hourly", now)).toBe(at(2026, 10, 10, 13));
  });

  it("keeps the wall-clock time across a daylight-saving change", () => {
    const due = at(2026, 10, 24, 9);
    const next = new Date(nextDueAt(due, "daily", due + 1000));
    expect([next.getDate(), next.getHours(), next.getMinutes()]).toEqual([25, 9, 0]);
  });
});

describe("lateness", () => {
  it("is late only well past the due time", () => {
    const due = at(2026, 10, 7, 9);
    expect(isLate(due, due + 30_000)).toBe(false);
    expect(isLate(due, due + 3 * 60_000)).toBe(true);
  });

  it("says so in the message it sends", () => {
    const due = at(2026, 10, 7, 9);
    expect(scheduledMessage(p({}), due + 10_000)).toBe("Scheduled task, due 2026-10-07 09:00.\n\nCheck the inbox");
    expect(scheduledMessage(p({}), at(2026, 10, 7, 10, 5))).toContain("ran late at 2026-10-07 10:05: Obsidian was closed or asleep");
  });
});

describe("parseWhen", () => {
  const now = at(2026, 10, 7, 9);
  it("reads minutes from now and local date-times", () => {
    expect(parseWhen({ inMinutes: 5 }, now)).toBe(now + 300_000);
    expect(parseWhen({ at: "2026-10-07T10:30" }, now)).toBe(at(2026, 10, 7, 10, 30));
    expect(parseWhen({ at: "2026-10-07 10:30" }, now)).toBe(at(2026, 10, 7, 10, 30));
  });

  it("refuses the past and garbage", () => {
    expect(parseWhen({ at: "2026-10-07T08:00" }, now)).toBeNull();
    expect(parseWhen({ at: "tomorrow" }, now)).toBeNull();
    expect(parseWhen({ at: "2027-02-30T09:00" }, now)).toBeNull();
    expect(parseWhen({ at: "2026-10-07T27:00" }, now)).toBeNull();
    expect(parseWhen({ inMinutes: 0 }, now)).toBeNull();
  });
});

it("describes a prompt in one line", () => {
  expect(describeScheduled(p({ repeat: "weekly" }), "Inbox")).toBe(
    's1: 2026-10-07 09:00, repeats weekly, in "Inbox": Check the inbox',
  );
  expect(describeScheduled(p({ target: "new" }), "")).toContain("in a new chat");
});
