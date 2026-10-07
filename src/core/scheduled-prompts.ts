/**
 * Scheduled prompts: a prompt that runs in a chat at a set time, once or on a
 * simple recurrence. Ported in spirit from T3 Code's `schedule_task`
 * (apps/server/src/mcp/toolkits/orchestrator): a run lands in the chat that
 * scheduled it by default, or in a fresh chat each time.
 *
 * Exo already has Automations (`_system/automations/*.md`), which run a
 * playbook outside any chat. This is the other half: a message that arrives in
 * a conversation later, so the agent picks the thread back up where it was.
 *
 * Pure and Obsidian-free. The runner (ui/scheduled-runner.ts) owns the timer,
 * the store and the dispatch into a chat.
 */

export type ScheduleRepeat = "hourly" | "daily" | "weekly";

export const SCHEDULE_REPEATS: readonly ScheduleRepeat[] = ["hourly", "daily", "weekly"];

export interface ScheduledPrompt {
  id: string;
  prompt: string;
  /** Next run, epoch ms. */
  dueAt: number;
  repeat?: ScheduleRepeat;
  /** The chat to run in, or "new" for a fresh chat on every run. */
  target: string;
  createdAt: number;
  lastRunAt?: number;
}

const PERIOD_MS: Record<ScheduleRepeat, number> = {
  hourly: 3_600_000,
  daily: 86_400_000,
  weekly: 7 * 86_400_000,
};

/** A run this far past its time was missed (Obsidian closed or asleep), not
 *  merely picked up by the next tick. */
export const LATE_AFTER_MS = 2 * 60_000;

export const isLate = (dueAt: number, now: number): boolean => now - dueAt > LATE_AFTER_MS;

/**
 * The next time after a run. Missed occurrences are skipped, not replayed: a
 * daily prompt after three days closed runs once, late, then goes back to its
 * time of day. Daily and weekly step by calendar day so the wall-clock time
 * holds across a daylight-saving change.
 */
export function nextDueAt(dueAt: number, repeat: ScheduleRepeat, now: number): number {
  if (repeat === "hourly") {
    const steps = Math.max(1, Math.floor((now - dueAt) / PERIOD_MS.hourly) + 1);
    return dueAt + steps * PERIOD_MS.hourly;
  }
  const days = repeat === "daily" ? 1 : 7;
  const d = new Date(dueAt);
  do {
    d.setDate(d.getDate() + days);
  } while (d.getTime() <= now);
  return d.getTime();
}

/** Split a store into the prompts due now and the store after their runs:
 *  one-off prompts leave it, recurring ones move to their next time. */
export function takeDue(
  list: readonly ScheduledPrompt[],
  now: number,
): { due: ScheduledPrompt[]; rest: ScheduledPrompt[] } {
  const due: ScheduledPrompt[] = [];
  const rest: ScheduledPrompt[] = [];
  for (const p of list) {
    if (p.dueAt > now) {
      rest.push(p);
      continue;
    }
    due.push(p);
    if (p.repeat) rest.push({ ...p, dueAt: nextDueAt(p.dueAt, p.repeat, now), lastRunAt: now });
  }
  return { due, rest };
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** `2026-10-07 09:00`, local time. */
export function formatWhen(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The message a run sends: a header line saying it was scheduled, and late
 *  when it was, so both the user and the agent know why it arrived now. */
export function scheduledMessage(p: ScheduledPrompt, now: number): string {
  const head = isLate(p.dueAt, now)
    ? `Scheduled task, due ${formatWhen(p.dueAt)}, ran late at ${formatWhen(now)}: Obsidian was closed or asleep.`
    : `Scheduled task, due ${formatWhen(p.dueAt)}.`;
  return `${head}\n\n${p.prompt}`;
}

/**
 * When to run, from what the agent or the form passes: a local date-time
 * (`2026-10-07T09:00` or `2026-10-07 09:00`) or minutes from now. Null when
 * neither is usable or the time is already past.
 */
export function parseWhen(input: { at?: string; inMinutes?: number }, now: number): number | null {
  if (typeof input.inMinutes === "number" && Number.isFinite(input.inMinutes) && input.inMinutes > 0) {
    return now + Math.round(input.inMinutes * 60_000);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})$/.exec((input.at ?? "").trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // `new Date` rolls Feb 30 over into March: refuse any field that moved.
  if (d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3] || d.getHours() !== +m[4] || d.getMinutes() !== +m[5]) return null;
  return d.getTime() <= now ? null : d.getTime();
}

/** One line per prompt, for the agent tool and the list. */
export function describeScheduled(p: ScheduledPrompt, targetTitle: string): string {
  const repeat = p.repeat ? `, repeats ${p.repeat}` : "";
  const where = p.target === "new" ? "a new chat" : `"${targetTitle}"`;
  const text = p.prompt.replace(/\s+/g, " ").trim();
  return `${p.id}: ${formatWhen(p.dueAt)}${repeat}, in ${where}: ${text.length > 80 ? `${text.slice(0, 80)}…` : text}`;
}
