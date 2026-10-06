/**
 * Thread lifecycle — where a conversation sits in the chats sidebar, ported
 * from T3 Code's thread inbox (client-runtime/state/threadSettled.ts,
 * threadInbox.ts, threadSort.ts and the server's ThreadSettlementService).
 * Pure and Obsidian-free, same discipline as `chat-rows.ts`.
 *
 * The shape T3 settled on, and this copies:
 *
 *  - PINNED overrides everything: a pinned chat sits in the pinned block
 *    whatever else is true of it.
 *  - The INBOX is every chat that is not put away, newest RETURN first: the
 *    last time it came back to you (a turn landed, or you un-settled it).
 *  - SNOOZED is "not now, bring it back": hidden until a wake time, or earlier
 *    when the chat raises its hand.
 *  - SETTLED is "done": put there by hand, or automatically after a few quiet
 *    days. Activity after the settle brings it back on its own.
 *
 * Every way in has a way out (unsettle, unsnooze, unpin, unarchive), and none
 * of these states can hide a chat that is waiting on the user.
 *
 * Nothing here runs on a timer. Wake times and auto-settle are DERIVED from
 * persisted timestamps against `now` on every paint, so there is no wake event
 * to miss while Obsidian was closed, and no background sweep to keep alive.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

/** T3's default for `sidebarAutoSettleAfterDays`. */
export const AUTO_SETTLE_AFTER_MS = 3 * DAY;

/** The auto-settle choices offered in the chats sidebar menu, in days. 0 = off. */
export const AUTO_SETTLE_DAY_CHOICES = [0, 1, 3, 7, 14, 30] as const;

/** The setting (days, 0 = off) as the quiet time `effectiveSettled` takes.
 *  Anything that is not a positive finite number reads as off. */
export function autoSettleMs(days: number | undefined): number | null {
  return typeof days === "number" && Number.isFinite(days) && days > 0 ? days * DAY : null;
}

/** The persisted lifecycle fields of one conversation. */
export interface LifecycleFields {
  snoozedUntil?: number;
  /** When the snooze was set: what makes "something happened since" answerable. */
  snoozedAt?: number;
  /** `settled` = put away by hand; `active` = taken back out by hand, which
   *  also opts the chat out of auto-settle (T3: any override blocks it). */
  settledOverride?: "settled" | "active";
  settledAt?: number;
  /** When the chat last re-entered the inbox by hand. An inbox anchor. */
  unsettledAt?: number;
}

/** The live and persisted facts the lifecycle reads. */
export interface LifecycleShell extends LifecycleFields {
  /** Last turn landed (view.ts stamps it at turn end). */
  updatedAt?: number;
  pendingPerm: boolean;
  pendingAsk: boolean;
  /** A turn is executing right now. */
  streaming: boolean;
  pinned: boolean;
  /** In the tab strip. Exo has tabs and T3 does not: a tab you kept open is a
   *  chat kept to hand, so it never AUTO-settles (settling it by hand works). */
  open: boolean;
  /** The chat in front of you. Never put away: the open thread does not
   *  disappear behind a collapsed shelf. */
  focused: boolean;
  /** A finished child task has a report waiting for this chat: a delegated
   *  result, which in T3 wakes a thread like a completed run. */
  pendingReport?: boolean;
}

export type Shelf = "pinned" | "inbox" | "snoozed" | "settled";

const blockedOnUser = (s: Pick<LifecycleShell, "pendingPerm" | "pendingAsk">): boolean =>
  s.pendingPerm || s.pendingAsk;

/* -------------------------------- snooze -------------------------------- */

/**
 * The chat "raises its hand": something happened that is worth more than the
 * user's "not now". Blocked on a permission or a question, a child report
 * waiting, or a turn landed after the snooze was set. A chat snoozed while
 * already stopped or errored stays snoozed: that snooze was "I saw it, later".
 */
export function raisedHand(s: Pick<LifecycleShell, "pendingPerm" | "pendingAsk" | "pendingReport" | "updatedAt" | "snoozedAt">): boolean {
  if (blockedOnUser(s) || s.pendingReport) return true;
  return s.snoozedAt !== undefined && (s.updatedAt ?? 0) > s.snoozedAt;
}

/** Hidden right now? Malformed or elapsed wake times never hide a chat. */
export function effectiveSnoozed(
  s: Pick<LifecycleShell, "snoozedUntil" | "snoozedAt" | "pendingPerm" | "pendingAsk" | "pendingReport" | "updatedAt">,
  now: number,
): boolean {
  if (s.snoozedUntil === undefined || !Number.isFinite(s.snoozedUntil)) return false;
  if (s.snoozedUntil <= now) return false;
  return !raisedHand(s);
}

/**
 * When a snoozed chat woke, or null if it never snoozed or is still snoozed.
 * Feeds the "woke" marker: compared with the last time the user looked, so a
 * visit clears it like it clears unread. A timer wake reports the wake time; a
 * raised hand reports the turn that raised it.
 */
export function wokeAt(
  s: Pick<LifecycleShell, "snoozedUntil" | "snoozedAt" | "pendingPerm" | "pendingAsk" | "pendingReport" | "updatedAt">,
  now: number,
): number | null {
  if (s.snoozedUntil === undefined || !Number.isFinite(s.snoozedUntil)) return null;
  if (raisedHand(s)) return s.updatedAt !== undefined && s.snoozedAt !== undefined && s.updatedAt > s.snoozedAt
    ? s.updatedAt
    : now;
  return s.snoozedUntil <= now ? s.snoozedUntil : null;
}

/**
 * May this chat be snoozed? Not while it is waiting on the user: hiding an
 * open permission prompt or question defeats the prompt. A running chat IS
 * snoozable, since snooze changes what the sidebar shows, never what the agent
 * does.
 */
export function canSnooze(s: Pick<LifecycleShell, "pendingPerm" | "pendingAsk">): boolean {
  return !blockedOnUser(s);
}

export interface SnoozePreset {
  label: string;
  until: number;
}

const atHour = (base: Date, days: number, hour: number): Date => {
  // Calendar-day advance, not +24h: across a DST change a fixed offset lands on
  // the wrong local day.
  const d = new Date(base.getTime());
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
};

/**
 * The menu's choices. "This evening" only while evening is more than an hour
 * away; "Next week" (Monday 9:00) only when it is not the same instant as
 * "Tomorrow", which it is on Sundays.
 */
export function snoozePresets(now: Date): SnoozePreset[] {
  const t = now.getTime();
  const out: SnoozePreset[] = [
    { label: "In 1 hour", until: t + HOUR },
    { label: "In 3 hours", until: t + 3 * HOUR },
  ];
  const evening = atHour(now, 0, EVENING_HOUR).getTime();
  if (evening - t > HOUR) out.push({ label: "This evening", until: evening });
  const tomorrow = atHour(now, 1, MORNING_HOUR).getTime();
  out.push({ label: "Tomorrow morning", until: tomorrow });
  const toMonday = (1 - now.getDay() + 7) % 7 || 7;
  const nextWeek = atHour(now, toMonday, MORNING_HOUR).getTime();
  if (nextWeek !== tomorrow) out.push({ label: "Next week", until: nextWeek });
  return out;
}

/** Compact "wakes in" label: `45m`, `3h`, `2d`. Rounded UP, so a chat that is
 *  still hidden never reads `0m`. */
export function snoozeWakeLabel(until: number, now: number): string {
  const left = until - now;
  if (left <= 0) return "now";
  if (left < HOUR) return `${Math.max(1, Math.ceil(left / MINUTE))}m`;
  if (left < DAY) return `${Math.ceil(left / HOUR)}h`;
  return `${Math.ceil(left / DAY)}d`;
}

/* -------------------------------- settle -------------------------------- */

/**
 * When the chat last came back to the user: the inbox sort key, and the clock
 * auto-settle measures quiet time from. A turn landing, an un-settle, or a
 * snooze timer running out all count; T3's inbox sorts on the same idea
 * ("newest first by when each last came back to the user").
 */
export function returnedAt(s: Pick<LifecycleShell, "updatedAt" | "unsettledAt" | "snoozedUntil">, now: number): number {
  const woke = s.snoozedUntil !== undefined && s.snoozedUntil <= now ? s.snoozedUntil : 0;
  return Math.max(s.updatedAt ?? 0, s.unsettledAt ?? 0, woke);
}

/**
 * Is this chat on the Settled shelf right now? Never while it is in front of
 * you, pinned, running, or waiting on you. By hand: settled until a turn lands
 * after the settle. Automatically: after `quietMs` of quiet (null = never),
 * unless it is an open tab, has news waiting, or the user took it back out by
 * hand.
 */
export function effectiveSettled(
  s: LifecycleShell,
  now: number,
  quietMs: number | null = AUTO_SETTLE_AFTER_MS,
): boolean {
  if (s.focused || s.pinned || s.streaming || blockedOnUser(s)) return false;
  if (s.settledOverride === "active") return false;
  if (s.settledOverride === "settled") {
    const woke = s.settledAt !== undefined && (s.updatedAt ?? 0) > s.settledAt;
    if (!woke) return true;
    // Activity after the settle brought it back; from here it ages like any
    // other chat, which is what T3 does once the run clears the override.
  }
  if (quietMs === null || s.open || s.pendingReport) return false;
  return returnedAt(s, now) < now - quietMs;
}

/**
 * May this chat be settled by hand? T3's activity blockers: not while a turn is
 * running and not while it waits on the user. A chat that stopped or errored
 * has still finished.
 */
export function canSettleThread(s: Pick<LifecycleShell, "streaming" | "pendingPerm" | "pendingAsk">): boolean {
  return !s.streaming && !blockedOnUser(s);
}

/** Which shelf. Pinned first (it overrides everything), then the two ways a
 *  chat is put away, then the inbox. */
export function shelfOf(s: LifecycleShell, now: number, quietMs: number | null = AUTO_SETTLE_AFTER_MS): Shelf {
  if (s.pinned) return "pinned";
  if (!s.focused && effectiveSnoozed(s, now)) return "snoozed";
  if (effectiveSettled(s, now, quietMs)) return "settled";
  return "inbox";
}

/** The field writes for each verb, so the view never restates the rules. */
export const lifecycleWrites = {
  settle: (now: number): LifecycleFields => ({
    settledOverride: "settled", settledAt: now, unsettledAt: undefined,
    snoozedUntil: undefined, snoozedAt: undefined,
  }),
  unsettle: (now: number): LifecycleFields => ({
    settledOverride: "active", settledAt: undefined, unsettledAt: now,
  }),
  // A snooze replaces any settle: when it wakes, the chat comes back to the
  // inbox, not to the shelf it was snoozed from.
  snooze: (until: number, now: number): LifecycleFields => ({
    snoozedUntil: until, snoozedAt: now, settledOverride: undefined, settledAt: undefined,
  }),
  unsnooze: (): LifecycleFields => ({ snoozedUntil: undefined, snoozedAt: undefined }),
};

/* ----------------------------- plan progress ----------------------------- */

export interface PlanProgress {
  done: number;
  total: number;
}

/**
 * Progress of the agent's checklist (the last TodoWrite of the conversation),
 * shown on a running row like T3's `planProgress`. Null when there is no
 * checklist, or an empty one.
 */
export function planProgress(
  messages: readonly { role: string; segments?: readonly { t: string; name?: string; input?: unknown }[] }[],
): PlanProgress | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const segs = messages[i].segments;
    if (!segs) continue;
    for (let j = segs.length - 1; j >= 0; j--) {
      const seg = segs[j];
      if (seg.t !== "tool" || seg.name !== "TodoWrite") continue;
      const todos = (seg.input as { todos?: { status?: string }[] } | undefined)?.todos;
      if (!Array.isArray(todos) || todos.length === 0) return null;
      return { done: todos.filter((t) => t.status === "completed").length, total: todos.length };
    }
  }
  return null;
}
