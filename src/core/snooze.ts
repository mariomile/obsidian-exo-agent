/**
 * Snooze — "not now, but bring it back". Pure and Obsidian-free, same
 * discipline as `chat-rows.ts`.
 *
 * Borrowed from T3 Code's thread inbox (client-runtime/state/threadSettled.ts),
 * where it is the one lifecycle verb the chats sidebar did not have: pinning
 * keeps a chat to hand, archiving puts it away for good, and closing the tab
 * files it under Settled. None of them says "hide this until tomorrow morning,
 * unless it needs me first".
 *
 * Snooze is an OVERLAY on a conversation, never a state of its own: a snoozed
 * chat is still whatever it was, and only stops being shown in its section.
 * Nothing fires when the wake time passes. The fields stay where they are and
 * simply stop classifying as snoozed, which is why there is no timer to leak
 * and no wake event to miss while Obsidian was closed.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

/** The persisted pair. `snoozedAt` is what makes "something happened since"
 *  answerable: without it a completed turn cannot be told apart from the one
 *  that was already there when the user said "not now". */
export interface SnoozeFields {
  snoozedUntil?: number;
  snoozedAt?: number;
}

/** The live facts that can outrank a snooze. */
export interface SnoozeShell extends SnoozeFields {
  /** Last turn landed (view.ts stamps it at turn end). */
  updatedAt?: number;
  pendingPerm: boolean;
  pendingAsk: boolean;
}

/**
 * The chat "raises its hand": something happened that is worth more than the
 * user's "not now". Blocked on a permission or a question, or a turn finished
 * after the snooze was set. A chat snoozed while already stopped or errored
 * stays snoozed: that snooze was the user saying "I saw it, later".
 */
export function raisedHand(s: SnoozeShell): boolean {
  if (s.pendingPerm || s.pendingAsk) return true;
  return s.snoozedAt !== undefined && (s.updatedAt ?? 0) > s.snoozedAt;
}

/** Hidden right now? Malformed or elapsed wake times never hide a chat. */
export function effectiveSnoozed(s: SnoozeShell, now: number): boolean {
  if (s.snoozedUntil === undefined || !Number.isFinite(s.snoozedUntil)) return false;
  if (s.snoozedUntil <= now) return false;
  return !raisedHand(s);
}

/**
 * May this chat be snoozed? Not while it is waiting on the user: hiding an
 * open permission prompt or question defeats the prompt. A running chat IS
 * snoozable, since snooze changes what the sidebar shows, never what the agent
 * does.
 */
export function canSnooze(s: Pick<SnoozeShell, "pendingPerm" | "pendingAsk">): boolean {
  return !s.pendingPerm && !s.pendingAsk;
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
