import { describe, it, expect } from "vitest";
import {
  AUTO_SETTLE_AFTER_MS,
  canSettleThread,
  canSnooze,
  effectiveSettled,
  effectiveSnoozed,
  lifecycleWrites,
  planProgress,
  raisedHand,
  shelfOf,
  snoozePresets,
  snoozeWakeLabel,
  wokeAt,
  type LifecycleShell,
} from "../src/core/thread-lifecycle";
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

  it("files a snoozed chat on its own shelf below the inbox, soonest wake first", () => {
    expect(
      keysOf([src({ id: "rest" }), snoozed("late", NOON + 5 * HOUR), snoozed("soon", NOON + HOUR)]),
    ).toEqual([
      ["inbox", ["rest"]],
      ["snoozed", ["soon", "late"]],
    ]);
  });

  it("hides open, running and stopped chats, but never a pinned one", () => {
    const until = NOON + HOUR;
    expect(
      keysOf([
        snoozed("open", until, { open: true }),
        snoozed("running", until, { streaming: true }),
        snoozed("stopped", until, { stopped: true }),
        snoozed("pinned", until, { pinned: true }),
      ]),
    ).toEqual([
      ["pinned", ["pinned"]],
      ["snoozed", ["open", "running", "stopped"]],
    ]);
  });

  it("never hides the chat in front of you", () => {
    expect(keysOf([snoozed("x", NOON + HOUR, { focused: true })])).toEqual([["inbox", ["x"]]]);
  });

  it("marks a chat that woke since you last looked, and clears on a visit", () => {
    const woke = snoozed("x", NOON - 1, { lastActiveAt: NOON - HOUR });
    expect(buildChatList([woke], { query: "", now: NOON }).sections[0].items[0].unseen).toBe(true);
    const seen = snoozed("x", NOON - 1, { lastActiveAt: NOON });
    expect(buildChatList([seen], { query: "", now: NOON }).sections[0].items[0].unseen).toBe(false);
  });

  it("wakes on a child report waiting for it", () => {
    expect(keysOf([snoozed("x", NOON + HOUR, { pendingReport: true })])[0][0]).toBe("inbox");
  });

  it("puts it back in the inbox once the wake time passes", () => {
    expect(keysOf([snoozed("x", NOON + HOUR)], NOON + 2 * HOUR)).toEqual([["inbox", ["x"]]]);
  });

  it("never hides a chat blocked on the user", () => {
    const vm = buildChatList(
      [snoozed("x", NOON + HOUR, { streaming: true, pendingPerm: true })],
      { query: "", now: NOON },
    );
    expect(vm.sections.map((s) => s.key)).toEqual(["inbox"]);
    expect(vm.blocked.map((r) => r.id)).toEqual(["x"]);
  });

  it("says when it wakes in the age slot, and only while snoozed", () => {
    const [row] = buildChatList([snoozed("x", NOON + 3 * HOUR)], { query: "", now: NOON }).sections[0].items;
    expect(rowAge(row, NOON)).toBe("wakes 3h");
    const [awake] = buildChatList([src({ id: "y" })], { query: "", now: NOON }).sections[0].items;
    expect(rowAge(awake, NOON)).toBe("1h");
  });
});

const DAY = 24 * HOUR;

const thread = (over: Partial<LifecycleShell> = {}): LifecycleShell => ({
  updatedAt: NOON - HOUR,
  pendingPerm: false,
  pendingAsk: false,
  streaming: false,
  pinned: false,
  open: false,
  focused: false,
  ...over,
});

describe("settle", () => {
  const quiet = NOON - AUTO_SETTLE_AFTER_MS - 1;

  it("auto-settles after three quiet days, T3's default", () => {
    expect(AUTO_SETTLE_AFTER_MS).toBe(3 * DAY);
    expect(effectiveSettled(thread({ updatedAt: quiet }), NOON)).toBe(true);
    expect(effectiveSettled(thread({ updatedAt: NOON - 2 * DAY }), NOON)).toBe(false);
  });

  it("never auto-settles an open tab, a chat with news, or one taken back out by hand", () => {
    expect(effectiveSettled(thread({ updatedAt: quiet, open: true }), NOON)).toBe(false);
    expect(effectiveSettled(thread({ updatedAt: quiet, pendingReport: true }), NOON)).toBe(false);
    expect(effectiveSettled(thread({ updatedAt: quiet, settledOverride: "active" }), NOON)).toBe(false);
  });

  it("never settles what is in front of you, pinned, running, or waiting on you", () => {
    const by = { settledOverride: "settled" as const, settledAt: NOON };
    expect(effectiveSettled(thread({ ...by, focused: true }), NOON)).toBe(false);
    expect(effectiveSettled(thread({ ...by, pinned: true }), NOON)).toBe(false);
    expect(effectiveSettled(thread({ ...by, streaming: true }), NOON)).toBe(false);
    expect(effectiveSettled(thread({ ...by, pendingAsk: true }), NOON)).toBe(false);
  });

  it("keeps a chat settled by hand, even an open fresh one, until a turn lands after it", () => {
    const settled = thread({ open: true, updatedAt: NOON - HOUR, settledOverride: "settled", settledAt: NOON - 1 });
    expect(effectiveSettled(settled, NOON)).toBe(true);
    expect(effectiveSettled({ ...settled, updatedAt: NOON }, NOON)).toBe(false);
  });

  it("measures quiet from the last return: an un-settle restarts the clock", () => {
    expect(effectiveSettled(thread({ updatedAt: quiet, unsettledAt: NOON - HOUR }), NOON)).toBe(false);
  });

  it("refuses a settle while a turn runs or waits on you", () => {
    expect(canSettleThread({ streaming: true, pendingPerm: false, pendingAsk: false })).toBe(false);
    expect(canSettleThread({ streaming: false, pendingPerm: true, pendingAsk: false })).toBe(false);
    expect(canSettleThread({ streaming: false, pendingPerm: false, pendingAsk: false })).toBe(true);
  });

  it("pins over everything, then snooze, then settle, then the inbox", () => {
    expect(shelfOf(thread({ pinned: true, updatedAt: quiet }), NOON)).toBe("pinned");
    expect(shelfOf(thread({ snoozedUntil: NOON + HOUR, snoozedAt: NOON, updatedAt: quiet }), NOON)).toBe("snoozed");
    expect(shelfOf(thread({ updatedAt: quiet }), NOON)).toBe("settled");
    expect(shelfOf(thread(), NOON)).toBe("inbox");
  });

  it("writes a snooze that replaces a settle, and a settle that clears a snooze", () => {
    expect(lifecycleWrites.snooze(NOON + HOUR, NOON)).toMatchObject({ settledOverride: undefined, snoozedUntil: NOON + HOUR });
    expect(lifecycleWrites.settle(NOON)).toMatchObject({ settledOverride: "settled", settledAt: NOON, snoozedUntil: undefined });
    expect(lifecycleWrites.unsettle(NOON)).toMatchObject({ settledOverride: "active", unsettledAt: NOON });
  });

  it("comes back to the inbox after a snooze wakes, instead of falling straight onto the shelf", () => {
    const woke = thread({ updatedAt: quiet, snoozedUntil: NOON - HOUR, snoozedAt: quiet });
    expect(shelfOf(woke, NOON)).toBe("inbox");
  });
});

describe("wokeAt", () => {
  it("reports the wake time, or the turn that raised the hand", () => {
    expect(wokeAt(thread({ snoozedUntil: NOON - 5, snoozedAt: NOON - HOUR, updatedAt: NOON - 2 * HOUR }), NOON)).toBe(NOON - 5);
    expect(wokeAt(thread({ snoozedUntil: NOON + HOUR, snoozedAt: NOON - HOUR, updatedAt: NOON - 7 }), NOON)).toBe(NOON - 7);
    expect(wokeAt(thread({ snoozedUntil: NOON + HOUR, snoozedAt: NOON - 1 }), NOON)).toBeNull();
  });
});

describe("planProgress", () => {
  const todo = (statuses: string[]) => ({
    role: "assistant",
    segments: [{ t: "tool", name: "TodoWrite", input: { todos: statuses.map((status) => ({ status })) } }],
  });

  it("reads the LAST checklist of the conversation", () => {
    expect(planProgress([todo(["completed", "pending"]), { role: "user" }, todo(["completed", "completed", "in_progress"])]))
      .toEqual({ done: 2, total: 3 });
  });

  it("is null without a checklist or with an empty one", () => {
    expect(planProgress([{ role: "user" }])).toBeNull();
    expect(planProgress([todo([])])).toBeNull();
  });

  it("shows on a running row only", () => {
    const rows = buildChatList(
      [src({ id: "r", streaming: true, planProgress: { done: 1, total: 4 } }), src({ id: "i", planProgress: { done: 1, total: 4 } })],
      { query: "", now: NOON },
    ).sections.flatMap((x) => x.items);
    expect(rows.find((r) => r.id === "r")?.progress).toEqual({ done: 1, total: 4 });
    expect(rows.find((r) => r.id === "i")?.progress).toBeUndefined();
  });
});

describe("chats sidebar: an errored child is never folded away", () => {
  it("keeps an errored child in the inbox when its parent is settled", () => {
    const parent = src({ id: "p", updatedAt: NOON - 4 * DAY });
    const child = src({ id: "c", parentConvoId: "p", poisoned: true });
    expect(keysOf([parent, child])).toEqual([
      ["inbox", ["c"]],
      ["settled", ["p"]],
    ]);
  });
});
