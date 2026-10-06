import { describe, it, expect } from "vitest";
import {
  buildChatList,
  needsYou,
  relativeTime,
  modelLabel,
  nextNeedsInput,
  type ChatListVM,
  type ChatRow,
  type ChatRowSource,
  type ChatSectionKey,
} from "../src/core/chat-rows";

describe("modelLabel", () => {
  it("drops a provider prefix the id repeats", () => {
    expect(modelLabel("Claude", "claude-opus-5")).toBe("Opus 5");
  });

  it("joins a split version with a dot, not a space", () => {
    // 4-8 is one version number, not two tokens.
    expect(modelLabel("Claude", "claude-opus-4-8")).toBe("Opus 4.8");
    expect(modelLabel("Claude", "claude-sonnet-4-6")).toBe("Sonnet 4.6");
  });

  it("handles the whole real Claude family", () => {
    expect(modelLabel("Claude", "claude-sonnet-5")).toBe("Sonnet 5");
    expect(modelLabel("Claude", "claude-fable-5")).toBe("Fable 5");
    expect(modelLabel("Claude", "claude-fable-5-1")).toBe("Fable 5.1");
  });

  it("uppercases known acronyms and keeps word tokens as words", () => {
    expect(modelLabel("Codex", "gpt-5.6-luna")).toBe("GPT 5.6 Luna");
    expect(modelLabel("Codex", "gpt-6-astra")).toBe("GPT 6 Astra");
  });

  it("leaves an id alone when it does not repeat the provider", () => {
    expect(modelLabel("Codex", "opus-5")).toBe("Opus 5");
  });

  it("matches the provider prefix case-insensitively", () => {
    expect(modelLabel("CLAUDE", "claude-opus-5")).toBe("Opus 5");
  });

  it("returns empty for an empty model rather than a stray separator", () => {
    expect(modelLabel("Claude", "")).toBe("");
    expect(modelLabel("Claude", "   ")).toBe("");
  });
});

const NOON = new Date(2026, 7, 7, 12, 0, 0).getTime();
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** A quiet, idle, non-archived, closed conversation with one message. Every
 *  test overrides only the fields it is actually about. */
const src = (over: Partial<ChatRowSource> = {}): ChatRowSource => ({
  id: "c1",
  title: "Untitled",
  preview: "",
  provider: "claude",
  model: "opus",
  updatedAt: NOON,
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

const build = (sources: ChatRowSource[], query = "") =>
  buildChatList(sources, { query, now: NOON });

const byDays = (sources: ChatRowSource[], query = "") =>
  buildChatList(sources, { query, now: NOON, mode: "days" });

/** The rows of one section, or `[]` when the model dropped it as empty — which
 *  is the same thing as far as the screen is concerned. */
const rows = (vm: ChatListVM, key: ChatSectionKey): ChatRow[] =>
  vm.sections.find((s) => s.key === key)?.items ?? [];

const ids = (vm: ChatListVM, key: ChatSectionKey): string[] => rows(vm, key).map((r) => r.id);

const shape = (vm: ChatListVM, key: ChatSectionKey): Array<[string, number]> =>
  rows(vm, key).map((r) => [r.id, r.depth]);

/** Every row on screen, in paint order, across every section including
 *  `related`. The only way to tell "moved" from "duplicated". */
const allIds = (vm: ChatListVM): string[] => vm.sections.flatMap((s) => s.items.map((r) => r.id));

const daySections = (vm: ChatListVM) => vm.sections.filter((s) => s.key.startsWith("day:"));
const dayIds = (vm: ChatListVM): string[] => daySections(vm).flatMap((s) => s.items.map((r) => r.id));
const dayLabels = (vm: ChatListVM): string[] => daySections(vm).map((s) => s.label);

describe("buildChatList — state sections", () => {
  it("puts a streaming conversation in the Inbox, marked running", () => {
    const vm = build([src({ id: "a", streaming: true })]);
    expect(ids(vm, "inbox")).toEqual(["a"]);
    expect(rows(vm, "inbox")[0].lane).toBe("running");
    expect(vm.sections.map((s) => s.key)).toEqual(["inbox"]);
  });

  it("puts an open tab in the Inbox even when nothing is running", () => {
    // An open tab is a chat you deliberately kept to hand, so it belongs with
    // the work, not the archive.
    const vm = build([src({ id: "a", open: true })]);
    expect(ids(vm, "inbox")).toEqual(["a"]);
    expect(ids(vm, "settled")).toEqual([]);
  });

  it("keeps an open tab in the Inbox however long it has been quiet", () => {
    // Open tabs never auto-settle; only settling by hand puts one away.
    const vm = build([src({ id: "a", open: true, updatedAt: NOON - 30 * DAY })]);
    expect(ids(vm, "inbox")).toEqual(["a"]);
  });

  it("puts a closed idle conversation that went quiet 4 days ago in Settled", () => {
    const vm = build([src({ id: "a", updatedAt: NOON - 4 * DAY })]);
    expect(ids(vm, "settled")).toEqual(["a"]);
    expect(vm.sections.map((s) => s.key)).toEqual(["settled"]);
  });

  it("keeps a closed idle conversation touched an hour ago in the Inbox", () => {
    const vm = build([src({ id: "a", updatedAt: NOON - HOUR })]);
    expect(ids(vm, "inbox")).toEqual(["a"]);
    expect(ids(vm, "settled")).toEqual([]);
  });

  it("never lists the same conversation in two sections", () => {
    const vm = build([
      src({ id: "live", streaming: true }),
      src({ id: "open", open: true }),
      src({ id: "pin", pinned: true }),
      src({ id: "old", updatedAt: NOON - 4 * DAY }),
    ]);
    expect([...allIds(vm)].sort()).toEqual(["live", "old", "open", "pin"]);
    expect(new Set(allIds(vm)).size).toBe(allIds(vm).length);
  });

  it("labels a permission-blocked conversation needs-input, NOT running, even though it is still streaming", () => {
    // A blocked turn has streaming:true because its finally has not run.
    // Reading streaming first would say "working" about something waiting on you.
    const vm = build([src({ id: "a", streaming: true, pendingPerm: true })]);
    expect(rows(vm, "inbox")[0].lane).toBe("needs-input");
    expect(rows(vm, "inbox")[0].reason).toBe("perm");
    expect(vm.blocked.map((r) => r.id)).toEqual(["a"]);
  });

  it("distinguishes an ask-blocked conversation from a permission-blocked one", () => {
    const vm = build([src({ id: "a", streaming: true, pendingAsk: true })]);
    expect(rows(vm, "inbox")[0].lane).toBe("needs-input");
    expect(rows(vm, "inbox")[0].reason).toBe("ask");
  });

  it("leaves lane undefined on a merely-open tab", () => {
    const vm = build([src({ id: "a", open: true })]);
    expect(rows(vm, "inbox")[0].lane).toBeUndefined();
  });

  /**
   * The precedence, stated once and whole. Every row here qualifies for
   * several shelves at once — pinned beats snoozed beats settled beats inbox,
   * and the first one it earns is the only one it gets.
   */
  it("lands every row on exactly one shelf, in precedence order", () => {
    const vm = build([
      src({ id: "pin", pinned: true, streaming: true, pendingPerm: true, open: true }),
      src({ id: "pinSnoozed", pinned: true, snoozedUntil: NOON + HOUR, snoozedAt: NOON }),
      src({ id: "snoozed", snoozedUntil: NOON + HOUR, snoozedAt: NOON, settledOverride: "settled", settledAt: NOON }),
      src({ id: "byHand", settledOverride: "settled", settledAt: NOON }),
      src({ id: "old", updatedAt: NOON - 4 * DAY }),
      src({ id: "busy", streaming: true, updatedAt: NOON - HOUR }),
      src({ id: "errored", poisoned: true, open: true, updatedAt: NOON - 2 * HOUR }),
    ]);
    expect(vm.sections.map((s) => [s.key, s.items.map((r) => r.id)])).toEqual([
      ["pinned", ["pin", "pinSnoozed"]],
      ["inbox", ["busy", "errored"]],
      ["snoozed", ["snoozed"]],
      ["settled", ["byHand", "old"]],
    ]);
  });

  it("carries a stable key and a separate display label on every section", () => {
    // The renderer keys collapsed state off `key`, never off `label` — a label
    // is display text and may be reworded or localized.
    const vm = build([
      src({ id: "pin", pinned: true }),
      src({ id: "inbox" }),
      src({ id: "snoozed", snoozedUntil: NOON + HOUR, snoozedAt: NOON }),
      src({ id: "rest", updatedAt: NOON - 4 * DAY }),
    ]);
    expect(vm.sections.map((s) => [s.key, s.label])).toEqual([
      ["pinned", "Pinned"],
      ["inbox", "Inbox"],
      ["snoozed", "Snoozed"],
      ["settled", "Settled"],
    ]);
  });

  /**
   * An errored row that is ALSO open stays in the Inbox with its badge. There
   * is no separate attention section any more: the Inbox is where everything
   * that has not been put away lives, and the badge says what it needs.
   */
  it("keeps an errored row that is also open in the Inbox, badge intact", () => {
    const vm = build([src({ id: "a", open: true, poisoned: true })]);
    expect(ids(vm, "inbox")).toEqual(["a"]);
    expect(rows(vm, "inbox")[0].badge).toBe("error");
  });

  it("keeps a stopped row in the Inbox as well — a halted turn is yours to resume", () => {
    const vm = build([src({ id: "a", stopped: true })]);
    expect(ids(vm, "inbox")).toEqual(["a"]);
    expect(ids(vm, "settled")).toEqual([]);
  });

  it("does not bucket Settled by day — that axis is the other mode", () => {
    const vm = build([
      src({ id: "today", updatedAt: NOON }),
      src({ id: "week", updatedAt: NOON - 4 * DAY }),
      src({ id: "ancient", updatedAt: NOON - 90 * DAY }),
    ]);
    expect(vm.sections.map((s) => s.key)).toEqual(["inbox", "settled"]);
    expect(ids(vm, "inbox")).toEqual(["today"]);
    expect(ids(vm, "settled")).toEqual(["week", "ancient"]);
  });

  it("stamps the shelf on the row itself", () => {
    const vm = build([
      src({ id: "pin", pinned: true }),
      src({ id: "inbox" }),
      src({ id: "snoozed", snoozedUntil: NOON + HOUR, snoozedAt: NOON }),
      src({ id: "rest", updatedAt: NOON - 4 * DAY }),
    ]);
    expect(vm.sections.map((s) => s.items[0].shelf)).toEqual(["pinned", "inbox", "snoozed", "settled"]);
  });
});

/**
 * The lifecycle rules as the list applies them. The rules themselves are pinned
 * in thread-lifecycle.test.ts; what is tested here is that `buildChatList` asks
 * them against `now` and files the row accordingly.
 */
describe("buildChatList — shelves", () => {
  it("lets Pinned override a snooze and a settle", () => {
    const vm = build([
      src({ id: "a", pinned: true, snoozedUntil: NOON + HOUR, snoozedAt: NOON }),
      src({ id: "b", pinned: true, updatedAt: NOON - 90 * DAY }),
      src({ id: "c", pinned: true, settledOverride: "settled", settledAt: NOON }),
    ]);
    expect(vm.sections.map((s) => s.key)).toEqual(["pinned"]);
  });

  it("hides a snoozed chat until its wake time, then returns it to the Inbox", () => {
    const hidden = build([src({ id: "a", snoozedUntil: NOON + HOUR, snoozedAt: NOON })]);
    expect(ids(hidden, "snoozed")).toEqual(["a"]);
    expect(rows(hidden, "snoozed")[0].snoozedUntil).toBe(NOON + HOUR);
    const woke = build([src({ id: "a", snoozedUntil: NOON - HOUR, snoozedAt: NOON - 3 * HOUR, updatedAt: NOON - 3 * HOUR })]);
    expect(ids(woke, "inbox")).toEqual(["a"]);
    expect(ids(woke, "snoozed")).toEqual([]);
  });

  it("brings a snoozed chat back when a turn lands after the snooze", () => {
    const vm = build([src({ id: "a", snoozedUntil: NOON + HOUR, snoozedAt: NOON - HOUR, updatedAt: NOON })]);
    expect(ids(vm, "inbox")).toEqual(["a"]);
  });

  it("never snoozes the chat in front of you", () => {
    const vm = build([src({ id: "a", focused: true, snoozedUntil: NOON + HOUR, snoozedAt: NOON })]);
    expect(ids(vm, "inbox")).toEqual(["a"]);
    expect(ids(vm, "snoozed")).toEqual([]);
  });

  it("never hides a chat blocked on the user behind a snooze or a settle", () => {
    const vm = build([
      src({ id: "snoozed", streaming: true, pendingPerm: true, snoozedUntil: NOON + HOUR, snoozedAt: NOON }),
      src({ id: "settled", streaming: true, pendingAsk: true, settledOverride: "settled", settledAt: NOON }),
      src({ id: "old", streaming: true, pendingPerm: true, updatedAt: NOON - 10 * DAY }),
    ]);
    expect(vm.sections.map((s) => s.key)).toEqual(["inbox"]);
    expect(vm.blocked).toHaveLength(3);
  });

  it("keeps a chat settled by hand on Settled until a turn lands after the settle", () => {
    const kept = build([src({ id: "a", settledOverride: "settled", settledAt: NOON, updatedAt: NOON })]);
    expect(ids(kept, "settled")).toEqual(["a"]);
    expect(rows(kept, "settled")[0].settledAt).toBe(NOON);
    const woke = build([src({ id: "a", settledOverride: "settled", settledAt: NOON - HOUR, updatedAt: NOON })]);
    expect(ids(woke, "inbox")).toEqual(["a"]);
  });

  it("never settles the chat in front of you, even one settled by hand", () => {
    const vm = build([
      src({ id: "a", focused: true, settledOverride: "settled", settledAt: NOON }),
      src({ id: "b", focused: true, updatedAt: NOON - 30 * DAY }),
    ]);
    expect([...ids(vm, "inbox")].sort()).toEqual(["a", "b"]);
  });

  it("settles automatically only after more than 3 quiet days", () => {
    const vm = build([
      src({ id: "edge", updatedAt: NOON - 3 * DAY }),
      src({ id: "past", updatedAt: NOON - 3 * DAY - 1 }),
    ]);
    expect(ids(vm, "inbox")).toEqual(["edge"]);
    expect(ids(vm, "settled")).toEqual(["past"]);
  });

  it("does not auto-settle a chat with a child report waiting, or one taken back out by hand", () => {
    const vm = build([
      src({ id: "report", pendingReport: true, updatedAt: NOON - 10 * DAY }),
      src({ id: "active", settledOverride: "active", updatedAt: NOON - 10 * DAY }),
    ]);
    expect([...ids(vm, "inbox")].sort()).toEqual(["active", "report"]);
    expect(ids(vm, "settled")).toEqual([]);
  });

  it("measures quiet time from the last return, so an un-settle or an elapsed snooze restarts the clock", () => {
    const vm = build([
      src({ id: "unsettled", updatedAt: NOON - 10 * DAY, unsettledAt: NOON - HOUR }),
      src({ id: "woke", updatedAt: NOON - 10 * DAY, snoozedAt: NOON - 9 * DAY, snoozedUntil: NOON - HOUR }),
    ]);
    expect([...ids(vm, "inbox")].sort()).toEqual(["unsettled", "woke"]);
  });
});

describe("buildChatList — ordering inside a section", () => {
  it("sorts the Inbox by when each chat last came back, not by its state", () => {
    // A chat blocked on you does not outrank a newer one: the strip above the
    // list is what surfaces it, the Inbox is plain return order.
    const vm = build([
      src({ id: "blocked", pendingPerm: true, streaming: true, updatedAt: NOON - 5 * HOUR }),
      src({ id: "plain", updatedAt: NOON - HOUR }),
      src({ id: "errored", poisoned: true, updatedAt: NOON - 3 * HOUR }),
    ]);
    expect(ids(vm, "inbox")).toEqual(["plain", "errored", "blocked"]);
  });

  it("does not let an unseen reply jump the Inbox order", () => {
    const vm = build([
      src({ id: "idle", open: true, updatedAt: NOON }),
      src({ id: "unseen", open: true, unseen: true, updatedAt: NOON - 5 * HOUR }),
    ]);
    expect(ids(vm, "inbox")).toEqual(["idle", "unseen"]);
  });

  it("counts an un-settle and an elapsed snooze as a return when ordering the Inbox", () => {
    const vm = build([
      src({ id: "turn", updatedAt: NOON - 4 * HOUR }),
      src({ id: "unsettled", updatedAt: NOON - 9 * DAY, unsettledAt: NOON - HOUR }),
      src({ id: "woke", updatedAt: NOON - 9 * HOUR, snoozedAt: NOON - 8 * HOUR, snoozedUntil: NOON - 2 * HOUR }),
    ]);
    expect(ids(vm, "inbox")).toEqual(["unsettled", "woke", "turn"]);
  });

  it("sorts Snoozed by soonest wake", () => {
    const snoozed = (id: string, until: number) => src({ id, snoozedUntil: until, snoozedAt: NOON });
    const vm = build([snoozed("late", NOON + 5 * HOUR), snoozed("soon", NOON + HOUR), snoozed("mid", NOON + 2 * HOUR)]);
    expect(ids(vm, "snoozed")).toEqual(["soon", "mid", "late"]);
  });

  it("sorts Settled by the settle for a chat put away by hand, by its last turn otherwise", () => {
    const vm = build([
      src({ id: "auto-old", updatedAt: NOON - 9 * DAY }),
      src({ id: "auto-new", updatedAt: NOON - 4 * DAY }),
      // A settle by hand stamps that moment: newer than any auto-settled chat
      // even though its last turn is the oldest of the three.
      src({ id: "hand", updatedAt: NOON - 30 * DAY, settledOverride: "settled", settledAt: NOON - HOUR }),
    ]);
    expect(ids(vm, "settled")).toEqual(["hand", "auto-new", "auto-old"]);
  });
});

describe("buildChatList — pinned", () => {
  it("gives a pinned closed conversation its own section, out of Settled however old", () => {
    const vm = build([src({ id: "a", pinned: true, updatedAt: NOON - 90 * DAY })]);
    expect(ids(vm, "pinned")).toEqual(["a"]);
    expect(ids(vm, "settled")).toEqual([]);
  });

  it("keeps a pinned OPEN conversation in Pinned, not in both", () => {
    const vm = build([src({ id: "a", pinned: true, open: true })]);
    expect(ids(vm, "pinned")).toEqual(["a"]);
    expect(ids(vm, "inbox")).toEqual([]);
  });

  it("keeps a pinned RUNNING conversation in Pinned, still marked running", () => {
    const vm = build([src({ id: "a", pinned: true, streaming: true })]);
    expect(ids(vm, "pinned")).toEqual(["a"]);
    expect(rows(vm, "pinned")[0].lane).toBe("running");
    expect(ids(vm, "inbox")).toEqual([]);
  });

  it("still lists a pinned blocked chat in the needs-you strip", () => {
    const vm = build([src({ id: "a", pinned: true, streaming: true, pendingPerm: true })]);
    expect(ids(vm, "pinned")).toEqual(["a"]);
    expect(vm.blocked.map((r) => r.id)).toEqual(["a"]);
  });

  it("carries the pinned flag onto the row", () => {
    const vm = build([src({ id: "a", pinned: true, open: true })]);
    expect(rows(vm, "pinned")[0].pinned).toBe(true);
  });

  it("sorts the pinned section by plain recency", () => {
    const vm = build([
      src({ id: "old", pinned: true, updatedAt: NOON - 2 * HOUR }),
      src({ id: "new", pinned: true, updatedAt: NOON }),
    ]);
    expect(ids(vm, "pinned")).toEqual(["new", "old"]);
  });
});

/**
 * `days` is the alternative reading, kept whole and unchanged: pure chronology
 * by last message, no promotion, no state sections. Everything in here is a
 * REGRESSION pin — it must keep answering "what did I do on Tuesday" exactly as
 * it did before the default view moved to a state axis.
 */
describe("buildChatList — days mode", () => {
  it("promotes nothing: running, open and pinned all land in the day sections", () => {
    const vm = byDays([
      src({ id: "live", streaming: true }),
      src({ id: "open", open: true }),
      src({ id: "pin", pinned: true }),
      src({ id: "plain" }),
    ]);
    expect(vm.sections.every((s) => s.key.startsWith("day:"))).toBe(true);
    expect([...dayIds(vm)].sort()).toEqual(["live", "open", "pin", "plain"]);
  });

  it("emits no state section at all, not even an empty one", () => {
    const vm = byDays([src({ id: "blocked", pendingPerm: true }), src({ id: "err", poisoned: true })]);
    expect(vm.sections.map((s) => s.key)).toEqual(["day:Today"]);
  });

  it("orders strictly by last message, so an open tab does not outrank a newer chat", () => {
    // This is what the activity view cannot say: there, state wins over recency
    // and the day column would be out of order.
    const vm = byDays([
      src({ id: "openOld", open: true, updatedAt: NOON - 5 * HOUR }),
      src({ id: "closedNew", updatedAt: NOON }),
    ]);
    expect(dayIds(vm)).toEqual(["closedNew", "openOld"]);
  });

  it("keeps every marker on the row — only the grouping changes", () => {
    const vm = byDays([src({ id: "a", streaming: true, pendingPerm: true, pinned: true, unseen: true })]);
    const row = daySections(vm)[0].items[0];
    expect(row.lane).toBe("needs-input");
    expect(row.reason).toBe("perm");
    expect(row.pinned).toBe(true);
    expect(row.unseen).toBe(true);
  });

  it("buckets by calendar day, not by rolling 24 hours", () => {
    // 23:00 yesterday is "Yesterday" read at noon today, even though it is only
    // 13 hours ago.
    const lastNight = new Date(2026, 7, 6, 23, 0, 0).getTime();
    const vm = byDays([src({ id: "a", updatedAt: lastNight })]);
    expect(dayLabels(vm)).toEqual(["Yesterday"]);
  });

  it("puts a conversation with no updatedAt in Older", () => {
    const vm = byDays([src({ id: "a", updatedAt: undefined })]);
    expect(dayLabels(vm)).toEqual(["Older"]);
  });

  it("orders the buckets Today, Yesterday, This week", () => {
    const vm = byDays([
      src({ id: "week", updatedAt: NOON - 3 * DAY }),
      src({ id: "today", updatedAt: NOON }),
      src({ id: "yday", updatedAt: NOON - DAY }),
    ]);
    expect(dayLabels(vm)).toEqual(["Today", "Yesterday", "This week"]);
    expect(vm.sections.map((s) => s.key)).toEqual(["day:Today", "day:Yesterday", "day:This week"]);
  });

  it("orders rows by recency inside a bucket", () => {
    const vm = byDays([
      src({ id: "older", updatedAt: NOON - 5 * HOUR }),
      src({ id: "newer", updatedAt: NOON - HOUR }),
    ]);
    expect(dayIds(vm)).toEqual(["newer", "older"]);
  });

  it("still filters by query", () => {
    const vm = byDays([src({ id: "a", title: "keep", open: true }), src({ id: "b", title: "drop" })], "keep");
    expect(dayIds(vm)).toEqual(["a"]);
  });

  it("defaults to activity mode when no mode is given", () => {
    const vm = buildChatList([src({ id: "a", open: true })], { query: "", now: NOON });
    expect(ids(vm, "inbox")).toEqual(["a"]);
  });

  it("ignores the shelves too: a snoozed or auto-settled chat sits in its day bucket", () => {
    // Days mode is chronology with no promotion and no putting away.
    const vm = byDays([
      src({ id: "snoozed", snoozedUntil: NOON + HOUR, snoozedAt: NOON }),
      src({ id: "quiet", updatedAt: NOON - 4 * DAY }),
    ]);
    expect(vm.sections.every((s) => s.key.startsWith("day:"))).toBe(true);
    expect([...dayIds(vm)].sort()).toEqual(["quiet", "snoozed"]);
  });

  /**
   * Anchoring is an ACTIVITY-mode rule: it protects the state sections, and
   * this mode has none. Here the axis IS the date, so a live child sitting in
   * its parent's day bucket is the mode working as designed.
   */
  it("still nests a blocked child under a parent in an older bucket", () => {
    const vm = byDays([
      src({ id: "p", updatedAt: NOON - 3 * DAY }),
      src({ id: "c", updatedAt: NOON, parentConvoId: "p", pendingPerm: true }),
    ]);
    expect(dayLabels(vm)).toEqual(["This week"]);
    expect(daySections(vm)[0].items.map((r) => [r.id, r.depth])).toEqual([
      ["p", 0],
      ["c", 1],
    ]);
  });
});

describe("buildChatList — exclusions", () => {
  it("drops archived conversations from every section", () => {
    const vm = build([src({ id: "a", archived: true, open: true, pinned: true })]);
    expect(vm.sections).toEqual([]);
    expect(vm.total).toBe(0);
  });

  it("drops an archived conversation even while it is streaming", () => {
    const vm = build([src({ id: "a", archived: true, streaming: true })]);
    expect(vm.sections).toEqual([]);
  });

  it("drops empty New chat husks", () => {
    const vm = build([src({ id: "a", hasMessages: false })]);
    expect(vm.sections).toEqual([]);
  });
});

describe("buildChatList — badges", () => {
  it("carries a stopped badge on an idle conversation", () => {
    const vm = build([src({ id: "a", stopped: true })]);
    expect(rows(vm, "inbox")[0].badge).toBe("stopped");
  });

  it("carries an error badge on a poisoned conversation", () => {
    const vm = build([src({ id: "a", poisoned: true })]);
    expect(rows(vm, "inbox")[0].badge).toBe("error");
  });

  it("prefers stopped over error when both are true", () => {
    const vm = build([src({ id: "a", stopped: true, poisoned: true })]);
    expect(rows(vm, "inbox")[0].badge).toBe("stopped");
  });

  it("keeps the badge on the row in days mode too", () => {
    // The badge is independent of the section: a chat whose last turn errored
    // must still say so wherever it is filed.
    const vm = byDays([src({ id: "a", open: true, poisoned: true })]);
    expect(daySections(vm)[0].items[0].badge).toBe("error");
  });
});

describe("buildChatList — unseen", () => {
  it("carries the unseen flag onto the row", () => {
    const vm = build([src({ id: "a", open: true, unseen: true })]);
    expect(rows(vm, "inbox")[0].unseen).toBe(true);
  });

  it("does not by itself promote a closed conversation out of Settled", () => {
    // Unseen is a marker, not a state: promoting on it would quietly rebuild
    // the working set out of chats the user already filed away.
    const vm = build([src({ id: "a", unseen: true, updatedAt: NOON - 4 * DAY })]);
    expect(ids(vm, "settled")).toEqual(["a"]);
    expect(rows(vm, "settled")[0].unseen).toBe(true);
  });

  /** A chat that woke from a snooze since you last looked is news, exactly
   *  like a reply you have not read: the marker rides on `unseen`. */
  it("marks a chat that woke from a snooze since the user last looked", () => {
    const woke = {
      snoozedAt: NOON - 3 * HOUR,
      snoozedUntil: NOON - HOUR,
      updatedAt: NOON - 3 * HOUR,
    };
    expect(rows(build([src({ id: "a", ...woke, lastActiveAt: NOON - 2 * HOUR })]), "inbox")[0].unseen).toBe(true);
  });

  it("clears the woke marker once the user has had the chat in view, or while it is focused", () => {
    const woke = {
      snoozedAt: NOON - 3 * HOUR,
      snoozedUntil: NOON - HOUR,
      updatedAt: NOON - 3 * HOUR,
    };
    expect(rows(build([src({ id: "a", ...woke, lastActiveAt: NOON })]), "inbox")[0].unseen).toBe(false);
    expect(rows(build([src({ id: "a", ...woke, focused: true })]), "inbox")[0].unseen).toBe(false);
  });
});

describe("buildChatList — search", () => {
  it("matches on title, case-insensitively", () => {
    const vm = build([src({ id: "a", title: "Drag and Drop" }), src({ id: "b", title: "Other" })], "DRAG");
    expect(ids(vm, "inbox")).toEqual(["a"]);
  });

  it("matches on preview as well as title", () => {
    const vm = build([src({ id: "a", title: "Untitled", preview: "fix the gutter" })], "gutter");
    expect(vm.matched).toBe(1);
  });

  it("treats a whitespace-only query as no query", () => {
    const vm = build([src({ id: "a" }), src({ id: "b" })], "   ");
    expect(vm.matched).toBe(2);
  });

  it("matches tokens in any order, across words the user did not remember", () => {
    // The failure this replaced: `includes(query)` needs the words contiguous,
    // so typing what you remember never found the chat.
    const vm = build([src({ id: "a", title: "GBrain di Garry Tan — cosa rubare" })], "gbrain garry");
    expect(vm.matched).toBe(1);
  });

  it("requires every token, not just one", () => {
    const vm = build([src({ id: "a", title: "GBrain di Garry Tan" })], "gbrain notion");
    expect(vm.matched).toBe(0);
  });

  it("spans title and preview together", () => {
    const vm = build([src({ id: "a", title: "Vault Blueprint", preview: "phase four rollout" })], "blueprint rollout");
    expect(vm.matched).toBe(1);
  });

  it("ignores diacritics, in both directions", () => {
    // Nobody types the accent into a filter box.
    expect(build([src({ id: "a", title: "Però funziona" })], "pero").matched).toBe(1);
    expect(build([src({ id: "a", title: "Pero funziona" })], "però").matched).toBe(1);
  });

  it("filters every section, not only the Inbox", () => {
    const vm = build(
      [
        src({ id: "keep", title: "keep", open: true }),
        src({ id: "drop", title: "drop", open: true }),
        src({ id: "pin-keep", title: "keep", pinned: true }),
        src({ id: "pin-drop", title: "drop", pinned: true }),
        src({ id: "snooze-keep", title: "keep", snoozedUntil: NOON + HOUR, snoozedAt: NOON }),
        src({ id: "snooze-drop", title: "drop", snoozedUntil: NOON + HOUR, snoozedAt: NOON }),
        src({ id: "rest-keep", title: "keep", updatedAt: NOON - 4 * DAY }),
        src({ id: "rest-drop", title: "drop", updatedAt: NOON - 4 * DAY }),
      ],
      "keep",
    );
    expect(ids(vm, "inbox")).toEqual(["keep"]);
    expect(ids(vm, "pinned")).toEqual(["pin-keep"]);
    expect(ids(vm, "snoozed")).toEqual(["snooze-keep"]);
    expect(ids(vm, "settled")).toEqual(["rest-keep"]);
    expect(vm.matched).toBe(4);
  });

  it("reports total and matched separately so the view can tell 'no chats' from 'no matches'", () => {
    const vm = build([src({ id: "a", title: "alpha" }), src({ id: "b", title: "beta" })], "zzz");
    expect(vm.total).toBe(2);
    expect(vm.matched).toBe(0);
    expect(vm.sections).toEqual([]);
  });
});

describe("buildChatList — semantic related section", () => {
  const sem = (sources: ChatRowSource[], query: string, semanticIds: string[]) =>
    buildChatList(sources, { query, now: NOON, semanticIds });

  it("adds a semantic hit the literal filter missed", () => {
    const vm = sem([src({ id: "a", title: "Vault Blueprint" }), src({ id: "b", title: "Tag namespace" })], "zzz", ["b"]);
    expect(ids(vm, "related")).toEqual(["b"]);
  });

  it("puts Related last, after every state section", () => {
    const vm = sem([src({ id: "a", title: "alpha match", open: true }), src({ id: "b", title: "beta" })], "match", ["b"]);
    expect(vm.sections.map((s) => s.key)).toEqual(["inbox", "related"]);
  });

  it("never duplicates a row that already matched literally", () => {
    const vm = sem([src({ id: "a", title: "Vault Blueprint" })], "vault", ["a"]);
    expect(ids(vm, "related")).toEqual([]);
    expect(ids(vm, "inbox")).toEqual(["a"]);
  });

  it("preserves the semantic ranking order", () => {
    const vm = sem([src({ id: "a" }), src({ id: "b" }), src({ id: "c" })], "zzz", ["c", "a", "b"]);
    expect(ids(vm, "related")).toEqual(["c", "a", "b"]);
  });

  it("ignores semantic ids for conversations that are archived or gone", () => {
    const vm = sem([src({ id: "a", archived: true })], "zzz", ["a", "ghost"]);
    expect(ids(vm, "related")).toEqual([]);
  });

  it("does nothing at all when no query is being typed", () => {
    // Otherwise an idle sidebar would sprout a Related section out of nowhere.
    const vm = buildChatList([src({ id: "a" })], { query: "", now: NOON, semanticIds: ["a"] });
    expect(ids(vm, "related")).toEqual([]);
  });

  it("counts related rows as matches, so a semantic-only hit is not an empty state", () => {
    const vm = sem([src({ id: "a", title: "alpha" })], "zzz", ["a"]);
    expect(vm.matched).toBe(1);
    expect(vm.total).toBe(1);
  });
});

describe("relativeTime", () => {
  it("renders sub-hour ages in minutes", () => {
    expect(relativeTime(NOON - 30 * 60_000, NOON)).toBe("30m");
  });

  it("renders sub-day ages in hours", () => {
    expect(relativeTime(NOON - 19 * HOUR, NOON)).toBe("19h");
  });

  it("renders older ages in days", () => {
    expect(relativeTime(NOON - 4 * DAY, NOON)).toBe("4d");
  });

  it("renders anything under a minute as now", () => {
    expect(relativeTime(NOON - 5_000, NOON)).toBe("now");
  });

  it("never renders a negative age from a clock skew", () => {
    expect(relativeTime(NOON + 60_000, NOON)).toBe("now");
  });
});

/**
 * Fan-out children in the sidebar. Everything here goes through the REAL
 * `buildChatList` pipeline — sectioning, sorting, day bucketing — because the
 * whole risk of this feature is that grouping and ordering disagree once they
 * are composed, which testing `groupByParent` in isolation cannot catch.
 */
describe("buildChatList — child indentation", () => {
  const HALF_HOUR = HOUR / 2;

  it("places a child directly under its parent, indented, inside its section", () => {
    // Recency alone would order c, p (the child is newer) with both at depth 0.
    const vm = build([
      src({ id: "p", title: "Parent", open: true, updatedAt: NOON - HOUR }),
      src({ id: "c", title: "Child", open: true, updatedAt: NOON, parentConvoId: "p" }),
    ]);
    expect(shape(vm, "inbox")).toEqual([
      ["p", 0],
      ["c", 1],
    ]);
  });

  it("keeps every child of one parent together, in the section's own order", () => {
    const vm = build([
      src({ id: "p", open: true, updatedAt: NOON - 3 * HOUR }),
      src({ id: "c1", open: true, updatedAt: NOON - HOUR, parentConvoId: "p" }),
      src({ id: "c2", open: true, updatedAt: NOON, parentConvoId: "p" }),
      src({ id: "other", open: true, updatedAt: NOON - 2 * HOUR }),
    ]);
    // `other` is more recent than the parent, so it sorts above it; the parent
    // still carries its children with it rather than being split across it.
    expect(ids(vm, "inbox")).toEqual(["other", "p", "c2", "c1"]);
    expect(rows(vm, "inbox").map((r) => r.depth)).toEqual([0, 0, 1, 1]);
  });

  /** The invariant the whole feature hangs on: a child is never dropped and
   *  never hidden, whatever happened to its parent. */
  it("renders an orphan at top level when the parent was archived", () => {
    const vm = build([
      src({ id: "p", open: true, archived: true }),
      src({ id: "c", title: "Child", open: true, parentConvoId: "p" }),
    ]);
    expect(shape(vm, "inbox")).toEqual([["c", 0]]);
  });

  it("renders an orphan at top level when the parent does not exist at all", () => {
    const vm = build([src({ id: "c", open: true, parentConvoId: "gone" })]);
    expect(shape(vm, "inbox")).toEqual([["c", 0]]);
  });

  /**
   * Parent and child can naturally land in different sections — a parent kept
   * open sits in the Inbox while its long-quiet child would otherwise fall into
   * Settled. The child is pulled OUT of Settled and rendered nested under
   * the parent instead, so a conversation you are working in shows its whole
   * fan-out in one place. The section it would have occupied must not even
   * appear, since relocation left it with nothing in it.
   */
  it("indents across sections: a child that would land in Settled follows its parent into the Inbox", () => {
    const vm = build([
      src({ id: "p", title: "Parent", open: true }),
      src({ id: "c", title: "Child", open: false, updatedAt: NOON - 4 * DAY, parentConvoId: "p" }),
    ]);
    expect(shape(vm, "inbox")).toEqual([
      ["p", 0],
      ["c", 1],
    ]);
    expect(vm.sections.map((s) => s.key)).toEqual(["inbox"]);
  });

  it("indents inside a day bucket when parent and child share one", () => {
    const vm = byDays([
      src({ id: "p", updatedAt: NOON - HOUR }),
      src({ id: "c", updatedAt: NOON, parentConvoId: "p" }),
    ]);
    expect(dayLabels(vm)).toEqual(["Today"]);
    expect(daySections(vm)[0].items.map((r) => [r.id, r.depth])).toEqual([
      ["p", 0],
      ["c", 1],
    ]);
  });

  /**
   * A parent in one day bucket and a child in another still nest together —
   * the child is relocated into the PARENT's bucket, and a "Today" section
   * that would otherwise contain only that child must not render at all: an
   * empty header over nothing is worse than no header.
   */
  it("indents across day buckets: the child follows its parent into the parent's day", () => {
    const vm = byDays([
      src({ id: "p", updatedAt: NOON - 2 * DAY }),
      src({ id: "c", updatedAt: NOON, parentConvoId: "p" }),
    ]);
    expect(dayLabels(vm)).not.toContain("Today");
    expect(dayIds(vm)).toEqual(["p", "c"]);
    expect(daySections(vm).flatMap((s) => s.items).map((r) => r.depth)).toEqual([0, 1]);
  });

  it("caps the indent at one level: a grandchild sits beside its parent, not further right", () => {
    const vm = build([
      src({ id: "p", open: true, updatedAt: NOON - 2 * HOUR }),
      src({ id: "c", open: true, updatedAt: NOON - HOUR, parentConvoId: "p" }),
      src({ id: "g", open: true, updatedAt: NOON, parentConvoId: "c" }),
    ]);
    expect(shape(vm, "inbox")).toEqual([
      ["p", 0],
      ["c", 1],
      ["g", 1],
    ]);
  });

  it("leaves depth 0 on everything when nothing has a parent", () => {
    const vm = build([src({ id: "a", open: true }), src({ id: "b", open: true })]);
    expect(rows(vm, "inbox").every((r) => r.depth === 0)).toBe(true);
  });

  it("keeps the row count intact: grouping reorders, it never adds or drops rows", () => {
    const vm = build([
      src({ id: "p", open: true, updatedAt: NOON - HALF_HOUR }),
      src({ id: "c1", open: true, parentConvoId: "p" }),
      src({ id: "c2", open: true, parentConvoId: "p" }),
      src({ id: "loop-a", open: true, parentConvoId: "loop-b" }),
      src({ id: "loop-b", open: true, parentConvoId: "loop-a" }),
    ]);
    expect(rows(vm, "inbox")).toHaveLength(5);
    expect(new Set(ids(vm, "inbox")).size).toBe(5);
    expect(vm.matched).toBe(5);
    // A hand-edited ledger can produce a cycle: both members still render.
    expect(rows(vm, "inbox").filter((r) => r.id.startsWith("loop")).map((r) => r.depth)).toEqual([0, 0]);
  });

  it("indents pinned rows too, so the section is not the odd one out", () => {
    const vm = build([
      src({ id: "p", pinned: true, updatedAt: NOON - HOUR }),
      src({ id: "c", pinned: true, updatedAt: NOON, parentConvoId: "p" }),
    ]);
    expect(shape(vm, "pinned")).toEqual([
      ["p", 0],
      ["c", 1],
    ]);
  });

  it("carries parentConvoId onto the row, so the renderer and the model agree", () => {
    const vm = build([src({ id: "c", open: true, parentConvoId: "gone" })]);
    expect(rows(vm, "inbox")[0].parentConvoId).toBe("gone");
  });

  /**
   * The cardinal rule restated for search: a parent that the QUERY filtered
   * out is exactly as absent as one that was archived — the child it left
   * behind must still render, standalone, not vanish with it.
   */
  it("still shows a child when the search matches only the child, not the parent", () => {
    const vm = build(
      [
        src({ id: "p", title: "Parent unrelated", open: true }),
        src({ id: "c", title: "Child match", open: true, parentConvoId: "p" }),
      ],
      "match",
    );
    expect(shape(vm, "inbox")).toEqual([["c", 0]]);
  });

  /**
   * A grandchild's immediate parent (the child) is itself relocated into the
   * grandparent's section; the grandchild must follow it there too, not sit
   * back in whatever section it originally belonged to.
   */
  it("relocates a grandchild across sections alongside its relocated parent", () => {
    const vm = build([
      src({ id: "gp", open: true, updatedAt: NOON - 2 * HOUR }),
      src({ id: "p", open: false, updatedAt: NOON - 5 * DAY, parentConvoId: "gp" }),
      src({ id: "g", open: false, updatedAt: NOON - 4 * DAY, parentConvoId: "p" }),
    ]);
    expect(shape(vm, "inbox")).toEqual([
      ["gp", 0],
      ["p", 1],
      ["g", 1],
    ]);
    expect(vm.sections.map((s) => s.key)).toEqual(["inbox"]);
  });

  /**
   * Mutation target: a naive implementation could push a relocated child into
   * its new home WITHOUT removing it from its natural one, or vice versa.
   * Checking every section AT ONCE is what would catch that — checking them
   * one at a time cannot tell "missing everywhere" from "present twice".
   */
  it("never duplicates a row across Inbox, Pinned and Settled at once", () => {
    const vm = build([
      src({ id: "p1", open: true, updatedAt: NOON - 3 * HOUR }),
      src({ id: "c1", open: false, updatedAt: NOON - 4 * DAY, parentConvoId: "p1" }),
      src({ id: "p2", pinned: true, updatedAt: NOON - HOUR }),
      src({ id: "c2", pinned: false, updatedAt: NOON, parentConvoId: "p2" }),
      src({ id: "solo", updatedAt: NOON - 5 * DAY }),
    ]);
    expect([...allIds(vm)].sort()).toEqual(["c1", "c2", "p1", "p2", "solo"]);
    expect(new Set(allIds(vm)).size).toBe(allIds(vm).length);
  });
});

/**
 * Liveness outranks nesting. Found in the live vault: a fan-out child blocked
 * on a permission prompt, whose parent was an old closed chat, was relocated
 * into a history bucket — a conversation waiting on the user, filed under the
 * archive. Nesting is a convenience; "this is blocked on you" is not.
 */
describe("buildChatList — liveness outranks nesting", () => {
  it("keeps a needs-input child at top level instead of filing it under a settled parent", () => {
    const vm = build([
      src({ id: "p", title: "Old parent", updatedAt: NOON - 4 * DAY }),
      src({ id: "c", title: "Blocked child", parentConvoId: "p", streaming: true, pendingPerm: true }),
    ]);
    expect(shape(vm, "inbox")).toEqual([["c", 0]]);
    expect(rows(vm, "inbox")[0].lane).toBe("needs-input");
    expect(ids(vm, "settled")).toEqual(["p"]);
  });

  it("keeps a running child at top level too", () => {
    const vm = build([
      src({ id: "p", title: "Old parent", updatedAt: NOON - 4 * DAY }),
      src({ id: "c", title: "Working child", parentConvoId: "p", streaming: true }),
    ]);
    expect(shape(vm, "inbox")).toEqual([["c", 0]]);
    expect(ids(vm, "settled")).toEqual(["p"]);
  });

  it("anchors a snoozed child too, so Snoozed never shows a row that is on screen elsewhere", () => {
    // A snoozed child nested under an Inbox parent would be visible while
    // claiming to be hidden.
    const vm = build([
      src({ id: "p", title: "Open parent", open: true }),
      src({ id: "c", title: "Snoozed child", parentConvoId: "p", snoozedUntil: NOON + HOUR, snoozedAt: NOON }),
    ]);
    expect(shape(vm, "snoozed")).toEqual([["c", 0]]);
    expect(shape(vm, "inbox")).toEqual([["p", 0]]);
  });

  it("does not disable normal nesting: an idle child still follows its parent", () => {
    // The mutation this catches: anchoring everything, or anchoring on
    // `parentConvoId` rather than on the section, would silently flatten the tree.
    const vm = build([
      src({ id: "p", title: "Open parent", open: true }),
      src({ id: "c", title: "Idle child", parentConvoId: "p" }),
    ]);
    expect(shape(vm, "inbox")).toEqual([
      ["p", 0],
      ["c", 1],
    ]);
  });

  it("anchors the row's own position only — an anchored parent still carries its children", () => {
    const vm = build([
      src({ id: "p", title: "Running parent", parentConvoId: "gp", streaming: true }),
      src({ id: "gp", title: "Grandparent", updatedAt: NOON - 4 * DAY }),
      src({ id: "c", title: "Idle child", parentConvoId: "p" }),
    ]);
    expect(shape(vm, "inbox")).toEqual([
      ["p", 0],
      ["c", 1],
    ]);
    expect(ids(vm, "settled")).toEqual(["gp"]);
  });
});

/**
 * `related` is the semantic tier, presented as rows that do NOT contain what
 * was typed. Cross-collection relocation must not cross that line in either
 * direction: a literal match dragged into "Related" is a lie about why it is
 * on screen, and a semantic-only hit laundered into a literal section is the
 * same lie backwards.
 */
describe("buildChatList — related is not a nesting home", () => {
  const sem = (sources: ChatRowSource[], query: string, semanticIds: string[]) =>
    buildChatList(sources, { query, now: NOON, semanticIds });

  it("never relocates a literal match into Related", () => {
    const vm = sem(
      [
        src({ id: "p", title: "Alpha parent" }),
        src({ id: "c", title: "Child match", parentConvoId: "p" }),
      ],
      "match",
      ["p"],
    );
    expect(ids(vm, "related")).toEqual(["p"]);
    expect(shape(vm, "inbox")).toEqual([["c", 0]]);
  });

  it("never pulls a Related row out into a literal section", () => {
    const vm = sem(
      [
        src({ id: "p", title: "Parent match" }),
        src({ id: "c", title: "Zeta", parentConvoId: "p" }),
      ],
      "match",
      ["c"],
    );
    expect(ids(vm, "inbox")).toEqual(["p"]);
    expect(shape(vm, "related")).toEqual([["c", 0]]);
  });

  it("still nests inside Related when parent and child are both semantic-only", () => {
    const vm = sem(
      [
        src({ id: "p", title: "Alpha", updatedAt: NOON - HOUR }),
        src({ id: "c", title: "Beta", parentConvoId: "p", updatedAt: NOON }),
      ],
      "zzz",
      ["p", "c"],
    );
    expect(shape(vm, "related")).toEqual([
      ["p", 0],
      ["c", 1],
    ]);
  });

  it("never duplicates a row across the literal sections and Related", () => {
    const vm = sem(
      [
        src({ id: "p", title: "Parent match", open: true }),
        src({ id: "c", title: "Zeta", parentConvoId: "p" }),
        src({ id: "s", title: "Eta" }),
      ],
      "match",
      ["c", "s"],
    );
    expect([...allIds(vm)].sort()).toEqual(["c", "p", "s"]);
    expect(new Set(allIds(vm)).size).toBe(allIds(vm).length);
  });
});

/**
 * `hasChildren` through the whole pipeline, not just the grouping pass — the
 * flag is what earns a row its collapse control, and every rule that can move a
 * child (anchoring, the query filter, the Related split) can also change the
 * answer. Testing `groupAcrossHomes` alone would miss all three.
 */
describe("buildChatList — hasChildren", () => {
  const sem = (sources: ChatRowSource[], query: string, semanticIds: string[]) =>
    buildChatList(sources, { query, now: NOON, semanticIds });
  const kids = (vm: ChatListVM, key: ChatSectionKey): Array<[string, boolean]> =>
    rows(vm, key).map((r) => [r.id, r.hasChildren]);

  it("marks the parent and nothing else", () => {
    const vm = build([
      src({ id: "p", open: true, updatedAt: NOON - HOUR }),
      src({ id: "c", open: true, updatedAt: NOON, parentConvoId: "p" }),
      src({ id: "solo", open: true, updatedAt: NOON - 2 * HOUR }),
    ]);
    expect(kids(vm, "inbox")).toEqual([
      ["p", true],
      ["c", false],
      ["solo", false],
    ]);
  });

  it("leaves every row unmarked when nothing has a parent", () => {
    const vm = build([src({ id: "a", open: true }), src({ id: "b", open: true })]);
    expect(rows(vm, "inbox").some((r) => r.hasChildren)).toBe(false);
  });

  it("marks a parent whose child was pulled in from another section", () => {
    // The child earned Settled on its own and was relocated into the Inbox under
    // its parent; the parent still has to say so.
    const vm = build([
      src({ id: "p", open: true }),
      src({ id: "c", parentConvoId: "p", updatedAt: NOON - 4 * DAY }),
    ]);
    expect(kids(vm, "inbox")).toEqual([
      ["p", true],
      ["c", false],
    ]);
    expect(rows(vm, "settled")).toEqual([]);
  });

  it("does NOT mark a parent whose only child was anchored away by liveness", () => {
    // A blocked child stays where it is rather than nesting; nothing renders
    // under the parent, so a chevron there would open onto an empty group.
    const vm = build([
      src({ id: "p", updatedAt: NOON - 4 * DAY }),
      src({ id: "c", parentConvoId: "p", streaming: true, pendingPerm: true }),
    ]);
    expect(ids(vm, "inbox")).toEqual(["c"]);
    expect(kids(vm, "settled")).toEqual([["p", false]]);
  });

  it("does NOT mark a parent whose child the query filtered out", () => {
    const vm = build(
      [
        src({ id: "p", title: "Alpha", open: true }),
        src({ id: "c", title: "Zeta", open: true, parentConvoId: "p" }),
      ],
      "alpha",
    );
    expect(kids(vm, "inbox")).toEqual([["p", false]]);
  });

  it("does not mark the middle row of a flattened grandchild chain", () => {
    const vm = build([
      src({ id: "p", open: true, updatedAt: NOON }),
      src({ id: "c", open: true, updatedAt: NOON - HOUR, parentConvoId: "p" }),
      src({ id: "g", open: true, updatedAt: NOON - 2 * HOUR, parentConvoId: "c" }),
    ]);
    expect(rows(vm, "inbox").map((r) => [r.id, r.depth, r.hasChildren])).toEqual([
      ["p", 0, true],
      ["c", 1, false],
      ["g", 1, false],
    ]);
  });

  it("marks a parent inside Related, which nests on its own", () => {
    const vm = sem(
      [
        src({ id: "p", title: "Alpha", updatedAt: NOON - HOUR }),
        src({ id: "c", title: "Beta", parentConvoId: "p", updatedAt: NOON }),
      ],
      "zzz",
      ["p", "c"],
    );
    expect(kids(vm, "related")).toEqual([
      ["p", true],
      ["c", false],
    ]);
  });

  it("agrees with the painted shape: marked exactly when a depth-1 row follows", () => {
    // The renderer draws the control off `hasChildren` and counts the rows off
    // the painted order. If those two ever disagree, a chevron appears over
    // nothing or a hidden run has no way back.
    const vm = build([
      src({ id: "p", open: true, updatedAt: NOON }),
      src({ id: "c1", open: true, updatedAt: NOON - HOUR, parentConvoId: "p" }),
      src({ id: "c2", open: true, updatedAt: NOON - 2 * HOUR, parentConvoId: "p" }),
      src({ id: "q", open: true, updatedAt: NOON - 3 * HOUR }),
      src({ id: "settledOne", updatedAt: NOON - 4 * DAY }),
    ]);
    for (const section of vm.sections) {
      section.items.forEach((row, i) => {
        const follows = section.items[i + 1]?.depth === 1;
        expect([row.id, row.hasChildren]).toEqual([row.id, row.depth === 0 && follows]);
      });
    }
  });
});

/* ---------------------------------------------------------------------------
 * Phase 4 — the running row says what it is doing.
 * ------------------------------------------------------------------------ */

describe("buildChatList — the live activity phrase", () => {
  it("carries the running tool's phrase onto the running row", () => {
    const vm = build([src({ id: "a", streaming: true, activity: "Searching the vault" })]);
    expect(rows(vm, "inbox")[0].activity).toBe("Searching the vault");
  });

  it("leaves a running row with no phrase yet without one", () => {
    // Between two tool calls there is genuinely nothing to say; the row falls
    // back to its status chip rather than showing the last tool's phrase.
    const vm = build([src({ id: "a", streaming: true })]);
    expect(rows(vm, "inbox")[0].activity).toBeUndefined();
  });

  it("never carries a phrase on a row that is not running", () => {
    // A stale phrase on a settled row would be a lie about live work. The
    // blocked case matters most: a conversation waiting on a permission prompt
    // is STILL streaming, and its last tool phrase must not read as progress.
    const settled = build([src({ id: "a", activity: "Searching the vault", updatedAt: NOON - 4 * DAY })]);
    expect(rows(settled, "settled")[0].activity).toBeUndefined();
    const blockedVm = build([
      src({ id: "b", streaming: true, pendingPerm: true, activity: "Running a command" }),
    ]);
    expect(rows(blockedVm, "inbox")[0].activity).toBeUndefined();
  });

  it("carries the checklist progress on a running row only", () => {
    const planProgress = { done: 3, total: 7 };
    const running = build([src({ id: "a", streaming: true, planProgress })]);
    expect(rows(running, "inbox")[0].progress).toEqual(planProgress);
    const blockedVm = build([src({ id: "b", streaming: true, pendingPerm: true, planProgress })]);
    expect(rows(blockedVm, "inbox")[0].progress).toBeUndefined();
    const idle = build([src({ id: "c", planProgress })]);
    expect(rows(idle, "inbox")[0].progress).toBeUndefined();
  });
});

/* ---------------------------------------------------------------------------
 * Phase 5 — the mission deck: the needs-you strip and the cycle key.
 * ------------------------------------------------------------------------ */

describe("buildChatList — the needs-you strip", () => {
  it("is empty when nothing is blocked, so the strip renders nothing at all", () => {
    const vm = build([src({ id: "a", streaming: true }), src({ id: "b" })]);
    expect(vm.blocked).toEqual([]);
  });

  it("holds one entry per blocked chat, newest first, with the reason", () => {
    const vm = build([
      src({ id: "old", pendingAsk: true, streaming: true, updatedAt: NOON - HOUR }),
      src({ id: "new", pendingPerm: true, streaming: true, updatedAt: NOON }),
      src({ id: "running", streaming: true }),
    ]);
    expect(vm.blocked.map((r) => [r.id, r.reason])).toEqual([
      ["new", "perm"],
      ["old", "ask"],
    ]);
  });

  it("survives every section being collapsed", () => {
    // Collapse is a per-SECTION setting; the strip reads `blocked`, which is
    // built before sectioning and is not addressable by a section key at all.
    const vm = build([src({ id: "a", pendingPerm: true, streaming: true })]);
    const everySection = vm.sections.map((s) => s.key);
    expect(everySection.length).toBeGreaterThan(0);
    expect(vm.blocked.map((r) => r.id)).toEqual(["a"]);
    // Nothing the collapse state can say changes the answer above: `buildChatList`
    // takes no collapse input, so a collapsed pane and an open one produce the
    // same strip.
    expect(build([src({ id: "a", pendingPerm: true, streaming: true })]).blocked.map((r) => r.id))
      .toEqual(["a"]);
  });

  it("survives a search that filters the blocked chat off screen", () => {
    // Stronger than collapse and the same principle: a chat that cannot move
    // without you must never be reachable only through a filter you happen to
    // be typing.
    const vm = build([src({ id: "a", title: "Alpha", pendingPerm: true, streaming: true })], "zzz");
    expect(allIds(vm)).toEqual([]);
    expect(vm.blocked.map((r) => r.id)).toEqual(["a"]);
  });

  it("carries the rule an approval would grant on a permission block only", () => {
    const vm = build([
      src({ id: "perm", pendingPerm: true, streaming: true, permRule: "Bash(git)" }),
      src({ id: "ask", pendingAsk: true, streaming: true, permRule: "Bash(git)" }),
    ]);
    const byId = new Map(vm.blocked.map((r) => [r.id, r]));
    expect(byId.get("perm")?.permRule).toBe("Bash(git)");
    // An open question is not a permission: there is no rule to grant, so the
    // row must not offer Allow / Deny.
    expect(byId.get("ask")?.permRule).toBeUndefined();
  });

  it("puts the rule on the section row too, so the row can decide in place", () => {
    const vm = build([src({ id: "perm", pendingPerm: true, streaming: true, permRule: "Bash(git)" })]);
    expect(rows(vm, "inbox")[0].permRule).toBe("Bash(git)");
  });
});

describe("nextNeedsInput", () => {
  const blocked = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("answers null when nothing needs you", () => {
    expect(nextNeedsInput([], "a")).toBeNull();
  });

  it("starts at the first blocked chat when you are nowhere near one", () => {
    expect(nextNeedsInput(blocked, null)).toBe("a");
    expect(nextNeedsInput(blocked, "not-blocked")).toBe("a");
  });

  it("moves to the next one and wraps around", () => {
    expect(nextNeedsInput(blocked, "a")).toBe("b");
    expect(nextNeedsInput(blocked, "b")).toBe("c");
    expect(nextNeedsInput(blocked, "c")).toBe("a");
  });

  it("stays put when the only blocked chat is the one you are in", () => {
    expect(nextNeedsInput([{ id: "a" }], "a")).toBe("a");
  });
});

describe("needsYou", () => {
  const row = (over: Partial<ChatRow> = {}): ChatRow =>
    ({ id: "a", lane: null, badge: null, ...over }) as ChatRow;

  it("is true on both arms: blocked right now, or ended badly and unacknowledged", () => {
    expect(needsYou(row({ lane: "needs-input" }))).toBe(true);
    expect(needsYou(row({ badge: "error" }))).toBe(true);
  });

  it("is false for a running or idle row", () => {
    expect(needsYou(row({ lane: "running" }))).toBe(false);
    expect(needsYou(row())).toBe(false);
  });

  it("returns a boolean, so a caller can hand it straight to a class toggle", () => {
    // `badge` is a string; the rich row read it as truthy and the compact row
    // read it too, but only one of them also read `lane`. One predicate, one
    // shape, no second copy to drift.
    expect(needsYou(row({ badge: "error" }))).toBe(true);
  });
});
