/**
 * Automations — pure scheduling core (no Obsidian imports).
 *
 * An automation runs a named playbook (custom prompt) unattended on a cadence.
 * Slot-based due logic: each cadence defines discrete local-time slots (top of
 * hour / daily at HH / weekly at day+HH); an automation is due when its last
 * run predates the current slot's start. The 30-min scheduler poll then fires
 * it once per slot — no drift, no double-fires, deterministic in tests.
 *
 * The executor (main.ts) owns timers and vault IO; this module owns decisions.
 */

export type Cadence =
  | { kind: "hourly" }
  | { kind: "daily"; hour: number } // 0–23 local
  | { kind: "weekly"; day: number; hour: number }; // day: 0=Sun … 6=Sat

export interface AutomationConfig {
  /** Custom prompt (playbook) name this automation runs — matched case-insensitively. */
  name: string;
  /** Optional built-in executor. Absent configs continue to run custom playbooks. */
  system?: "daily-pulse";
  cadence: Cadence;
  enabled: boolean;
  /** true → the run may write inside the vault (checkpointed, restorable);
   *  false → legacy read-only report run. */
  write: boolean;
}

/** Stable persistence key; system automations must not collide with playbook names. */
export function automationLastRunKey(automation: AutomationConfig): string {
  return automation.system ? `system:${automation.system}` : automation.name;
}

/** One executed automation run — persisted (pruned) so a bad write run can be
 *  rolled back from the UI. Checkpoint entries mirror the chat model: vault
 *  path → pre-run content, null when the file did not exist before the run. */
export interface AutomationRunRecord {
  id: string;
  name: string;
  startedAt: number;
  ok: boolean;
  reportPath: string;
  writes: string[];
  checkpoint: [string, string | null][];
  restoredAt?: number;
  /** Set when Mario marked the run as reviewed (review-queue flow) — reviewed
   *  and restored runs both leave the "to review" pool. */
  reviewedAt?: number;
  /** Automation file slug this run belongs to — absent on pre-v2 records,
   *  which the hub lists under a collapsed "Older runs" bucket. */
  slug?: string;
}

/**
 * Runs of one automation, newest first.
 *
 * Pre-v2 records carry no slug, only the display name the run was started
 * under — so an upgraded vault would show "never ran" for automations that
 * demonstrably ran this morning. They are claimed by exact name match: a
 * read-time join, so nothing is rewritten and nothing is guessed.
 */
export function runsForSlug(records: AutomationRunRecord[], slug: string, name?: string): AutomationRunRecord[] {
  return records
    .filter((r) => (r.slug ? r.slug === slug : name !== undefined && claimsRunName(name, r.name)))
    .sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Whether a pre-v2 record belongs to an automation, by the two names the old
 * writers produced: a playbook run stored the bare name ("Morning Digest"),
 * an agent run stored `agentRunName` ("Inbox Triager (create _inbox x.md)").
 * Both are exact shapes, not a fuzzy match — anything else stays unclaimed.
 */
function claimsRunName(automationName: string, recordName: string): boolean {
  return recordName === automationName || recordName.startsWith(`${automationName} (`);
}

/** What run ownership needs to know about an automation. */
export interface AutomationRef {
  slug: string;
  name: string;
}

/**
 * The automation a run belongs to, the way the Automations tab files it: its
 * slug while that automation exists, else (pre-v2) the automation that claims
 * its name, else null (the collapsed "Older runs" bucket, which also holds the
 * runs of a deleted or archived automation).
 */
export function runOwner(r: AutomationRunRecord, automations: readonly AutomationRef[]): string | null {
  if (r.slug) return automations.some((a) => a.slug === r.slug) ? r.slug : null;
  return automations.find((a) => claimsRunName(a.name, r.name))?.slug ?? null;
}

/** Runs no current automation owns (`runOwner`): shown once, collapsed. */
export function legacyRuns(records: AutomationRunRecord[], automations: readonly AutomationRef[] = []): AutomationRunRecord[] {
  return records
    .filter((r) => runOwner(r, automations) === null)
    .sort((a, b) => b.startedAt - a.startedAt);
}

/** The one "unreviewed write run" rule: it wrote, and nobody reviewed or
 *  restored it yet. The Inbox groups these (core/inbox `groupUnreviewedRuns`). */
export function awaitsReview(r: AutomationRunRecord): boolean {
  return r.writes.length > 0 && !r.reviewedAt && !r.restoredAt;
}

/** Validate loose cadence input (agent tools) into a Cadence. Day accepts 0–6
 *  or an English/Italian day name; hour defaults to 07. Null = invalid. */
export function parseCadenceInput(kind: string, hour?: number, day?: number | string): Cadence | null {
  const h = hour === undefined ? 7 : Math.trunc(hour);
  if (h < 0 || h > 23) return null;
  if (kind === "hourly") return { kind: "hourly" };
  if (kind === "daily") return { kind: "daily", hour: h };
  if (kind !== "weekly") return null;
  let d: number;
  if (typeof day === "string") {
    const names: Record<string, number> = {
      sun: 0, sunday: 0, dom: 0, domenica: 0,
      mon: 1, monday: 1, lun: 1, lunedi: 1, lunedì: 1,
      tue: 2, tuesday: 2, mar: 2, martedi: 2, martedì: 2,
      wed: 3, wednesday: 3, mer: 3, mercoledi: 3, mercoledì: 3,
      thu: 4, thursday: 4, gio: 4, giovedi: 4, giovedì: 4,
      fri: 5, friday: 5, ven: 5, venerdi: 5, venerdì: 5,
      sat: 6, saturday: 6, sab: 6, sabato: 6,
    };
    const hit = names[day.trim().toLowerCase()];
    if (hit === undefined) return null;
    d = hit;
  } else {
    d = day === undefined ? 1 : Math.trunc(day);
  }
  if (d < 0 || d > 6) return null;
  return { kind: "weekly", day: d, hour: h };
}

/* ------------------------------ due logic ------------------------------ */

/** Start (epoch ms, local time) of the cadence slot containing `now`. */
export function currentSlotStart(cadence: Cadence, now: number): number {
  const d = new Date(now);
  if (cadence.kind === "hourly") {
    d.setMinutes(0, 0, 0);
    return d.getTime();
  }
  if (cadence.kind === "daily") {
    d.setHours(cadence.hour, 0, 0, 0);
    if (d.getTime() > now) d.setDate(d.getDate() - 1);
    return d.getTime();
  }
  d.setHours(cadence.hour, 0, 0, 0);
  const back = (d.getDay() - cadence.day + 7) % 7;
  d.setDate(d.getDate() - back);
  if (d.getTime() > now) d.setDate(d.getDate() - 7);
  return d.getTime();
}

/** Due when the last run predates the current slot (0 = never ran → always due). */
export function isDue(cadence: Cadence, lastRun: number, now: number): boolean {
  return lastRun < currentSlotStart(cadence, now);
}

/** Epoch ms when this automation will next fire: now when already due, else
 *  the next slot boundary after the current one. */
export function nextDueAt(cadence: Cadence, lastRun: number, now: number): number {
  if (isDue(cadence, lastRun, now)) return now;
  const cur = currentSlotStart(cadence, now);
  const d = new Date(cur);
  if (cadence.kind === "hourly") d.setHours(d.getHours() + 1);
  else if (cadence.kind === "daily") d.setDate(d.getDate() + 1);
  else d.setDate(d.getDate() + 7);
  return d.getTime();
}

/** The next enabled automation to fire (for the Cockpit's Autonomy tile). */
export function nextAutomation(
  automations: AutomationConfig[],
  lastRun: Record<string, number>,
  now: number
): { name: string; dueAt: number } | null {
  let best: { name: string; dueAt: number } | null = null;
  for (const a of automations) {
    if (!a.enabled) continue;
    const dueAt = nextDueAt(a.cadence, lastRun[automationLastRunKey(a)] ?? 0, now);
    if (!best || dueAt < best.dueAt) best = { name: a.name, dueAt };
  }
  return best;
}

/* ------------------------------ labels ------------------------------ */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function cadenceLabel(c: Cadence): string {
  if (c.kind === "hourly") return "hourly";
  const hh = `${String(c.hour).padStart(2, "0")}:00`;
  return c.kind === "daily" ? `daily ${hh}` : `weekly ${DAYS[c.day] ?? "?"} ${hh}`;
}

/** Cadence label for the automation scheduling a given playbook (first enabled
 *  match by case-insensitive name), or null when the playbook is unscheduled.
 *  This — not the legacy `scheduledRuns` text — is the source of truth for the
 *  Playbooks tab's schedule badge. */
export function playbookScheduleLabel(name: string, automations: AutomationConfig[]): string | null {
  const a = automations.find((x) => x.enabled && x.name.toLowerCase() === name.toLowerCase());
  return a ? cadenceLabel(a.cadence) : null;
}

/** "due now" / "in 5m" / "in 3h" / "in 2d" — the meta-line countdown. */
export function formatDueIn(ms: number): string {
  if (ms <= 60_000) return "due now";
  const HOUR = 3_600_000;
  if (ms < HOUR) return `in ${Math.floor(ms / 60_000)}m`;
  if (ms < 24 * HOUR) return `in ${Math.floor(ms / HOUR)}h`;
  return `in ${Math.floor(ms / (24 * HOUR))}d`;
}

/* ----------------------------- migration ----------------------------- */

/** Convert the legacy `scheduledRuns` textarea ("Name | daily" / "Name | weekly",
 *  one per line) into structured configs. Legacy runs were read-only and had no
 *  time-of-day — they land on 07:00 (Monday for weekly), write off. */
export function migrateScheduledRuns(raw: string): AutomationConfig[] {
  const out: AutomationConfig[] = [];
  for (const line of raw.split("\n")) {
    const i = line.lastIndexOf("|");
    if (i < 0) continue;
    const name = line.slice(0, i).trim();
    const cadence = line.slice(i + 1).trim().toLowerCase();
    if (!name) continue;
    if (cadence === "daily") out.push({ name, cadence: { kind: "daily", hour: 7 }, enabled: true, write: false });
    else if (cadence === "weekly")
      out.push({ name, cadence: { kind: "weekly", day: 1, hour: 7 }, enabled: true, write: false });
  }
  return out;
}

/* ---------------------------- run records ---------------------------- */

/**
 * Keep the newest `max` run records (by startedAt), newest first — except
 * write runs still awaiting review, which are kept whatever their age.
 *
 * Those records ARE the restore points: pruning one throws away the only
 * snapshot of notes an automation edited while nobody was watching. Since
 * read-only runs are recorded too, a busy day of quiet runs could otherwise
 * push a pending rollback off the end of the list.
 */
export function pruneRuns(records: AutomationRunRecord[], max: number): AutomationRunRecord[] {
  const newestFirst = [...records].sort((a, b) => b.startedAt - a.startedAt);
  const pending = newestFirst.filter(awaitsReview);
  const rest = newestFirst.filter((r) => !pending.includes(r));
  return [...pending, ...rest.slice(0, Math.max(0, max - pending.length))].sort(
    (a, b) => b.startedAt - a.startedAt
  );
}
