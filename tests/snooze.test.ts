import { describe, it, expect } from "vitest";
import {
  canSnooze,
  effectiveSnoozed,
  raisedHand,
  snoozePresets,
  snoozeWakeLabel,
} from "../src/core/snooze";
import { buildChatList, rowAge, type ChatRowSource } from "../src/core/chat-rows";

const NOON = new Date(2026, 9, 6, 12, 0, 0).getTime(); // Tuesday
const HOUR = 3_600_000;

const shell = (over = {}) => ({ pendingPerm: false, pendingAsk: false, updatedAt: NOON - HOUR, ...over });

describe("effectiveSnoozed", () => {
  it("hides until the wake time, then stops hiding on its own", () => {
    const s = shell({ snoozedUntil: NOON + HOUR, snoozedAt: NOON - 1 });
    expect(effectiveSnoozed(s, NOON)).toBe(true);
    expect(effectiveSnoozed(s, NOON + HOUR)).toBe(false);
  });

  it("never hides a chat without a snooze or with a malformed one", () => {
    expect(effectiveSnoozed(shell(), NOON)).toBe(false);
    expect(effectiveSnoozed(shell({ snoozedUntil: NaN }), NOON)).toBe(false);
  });

  it("wakes early when the chat raises its hand", () => {
    const base = { snoozedUntil: NOON + 5 * HOUR, snoozedAt: NOON - HOUR / 2 };
    expect(effectiveSnoozed(shell({ ...base, pendingPerm: true }), NOON)).toBe(false);
    expect(effectiveSnoozed(shell({ ...base, pendingAsk: true }), NOON)).toBe(false);
    // A turn landed after the snooze was set.
    expect(effectiveSnoozed(shell({ ...base, updatedAt: NOON - 1 }), NOON)).toBe(false);
  });

  it("stays snoozed over news that was already there when snoozed", () => {
    expect(raisedHand(shell({ snoozedAt: NOON - 1, updatedAt: NOON - HOUR }))).toBe(false);
  });
});

describe("canSnooze", () => {
  it("refuses a chat that is waiting on the user, allows a running one", () => {
    expect(canSnooze({ pendingPerm: true, pendingAsk: false })).toBe(false);
    expect(canSnooze({ pendingPerm: false, pendingAsk: true })).toBe(false);
    expect(canSnooze({ pendingPerm: false, pendingAsk: false })).toBe(true);
  });
});

describe("snoozePresets", () => {
  it("offers this evening only while it is more than an hour away", () => {
    expect(snoozePresets(new Date(NOON)).map((p) => p.label)).toEqual([
      "In 1 hour", "In 3 hours", "This evening", "Tomorrow morning", "Next week",
    ]);
    const late = new Date(2026, 9, 6, 17, 30);
    expect(snoozePresets(late).map((p) => p.label)).not.toContain("This evening");
  });

  it("lands tomorrow at 9:00 local and next week on Monday 9:00", () => {
    const p = snoozePresets(new Date(NOON));
    const tomorrow = new Date(p.find((x) => x.label === "Tomorrow morning")!.until);
    expect([tomorrow.getDate(), tomorrow.getHours()]).toEqual([7, 9]);
    const week = new Date(p.find((x) => x.label === "Next week")!.until);
    expect([week.getDay(), week.getDate(), week.getHours()]).toEqual([1, 12, 9]);
  });

  it("drops next week on Sunday, where it is the same instant as tomorrow", () => {
    const sunday = new Date(2026, 9, 4, 12, 0);
    expect(snoozePresets(sunday).map((p) => p.label)).not.toContain("Next week");
  });
});

describe("snoozeWakeLabel", () => {
  it("rounds up so a hidden chat never reads 0m", () => {
    expect(snoozeWakeLabel(NOON + 10_000, NOON)).toBe("1m");
    expect(snoozeWakeLabel(NOON + 90 * 60_000, NOON)).toBe("2h");
    expect(snoozeWakeLabel(NOON + 30 * HOUR, NOON)).toBe("2d");
    expect(snoozeWakeLabel(NOON - 1, NOON)).toBe("now");
  });
});

const src = (over: Partial<ChatRowSource> = {}): ChatRowSource => ({
  id: "c1",
  title: "Untitled",
  preview: "",
  provider: "claude",
  model: "opus",
  updatedAt: NOON - HOUR,
  archived: false,
  open: false,
  pinned: false,
  unseen: false,
  messageCount: 3,
  streaming: false,
  pendingPerm: false,
  pendingAsk: false,
  poisoned: false,
  stopped: false,
  hasMessages: true,
  ...over,
});

const keysOf = (sources: ChatRowSource[], now = NOON) =>
  buildChatList(sources, { query: "", now }).sections.map((s) => [s.key, s.items.map((r) => r.id)]);

describe("chats sidebar: the Snoozed shelf", () => {
  const snoozed = (id: string, until: number, over: Partial<ChatRowSource> = {}) =>
    src({ id, snoozedUntil: until, snoozedAt: NOON - HOUR / 2, ...over });

  it("files a snoozed chat on its own shelf, above Settled, soonest wake first", () => {
    expect(
      keysOf([src({ id: "rest" }), snoozed("late", NOON + 5 * HOUR), snoozed("soon", NOON + HOUR)]),
    ).toEqual([
      ["snoozed", ["soon", "late"]],
      ["settled", ["rest"]],
    ]);
  });

  it("outranks open, pinned, running and a stopped badge", () => {
    const until = NOON + HOUR;
    expect(
      keysOf([
        snoozed("open", until, { open: true }),
        snoozed("pinned", until, { pinned: true }),
        snoozed("running", until, { streaming: true }),
        snoozed("stopped", until, { stopped: true }),
      ])[0][0],
    ).toBe("snoozed");
    expect(keysOf([snoozed("x", until, { open: true, pinned: true, streaming: true })])).toEqual([
      ["snoozed", ["x"]],
    ]);
  });

  it("puts it back where it belongs once the wake time passes", () => {
    expect(keysOf([snoozed("x", NOON + HOUR, { open: true })], NOON + 2 * HOUR)).toEqual([
      ["open", ["x"]],
    ]);
  });

  it("never hides a chat blocked on the user", () => {
    const vm = buildChatList(
      [snoozed("x", NOON + HOUR, { streaming: true, pendingPerm: true })],
      { query: "", now: NOON },
    );
    expect(vm.sections.map((s) => s.key)).toEqual(["needsYou"]);
    expect(vm.blocked.map((r) => r.id)).toEqual(["x"]);
  });

  it("says when it wakes in the age slot, and only while snoozed", () => {
    const [row] = buildChatList([snoozed("x", NOON + 3 * HOUR)], { query: "", now: NOON }).sections[0].items;
    expect(rowAge(row, NOON)).toBe("wakes 3h");
    const [awake] = buildChatList([src({ id: "y" })], { query: "", now: NOON }).sections[0].items;
    expect(rowAge(awake, NOON)).toBe("1h");
  });
});
