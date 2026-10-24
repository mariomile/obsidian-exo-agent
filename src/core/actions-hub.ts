/**
 * Actions Hub — pure view-model builders for Exo's capabilities panel (W2-UX).
 *
 * The memory and autonomy machinery (memory harvest, open-loops, background
 * budget, review.md) is scattered across the command palette, settings toggles,
 * and agent-only tools. This module turns plain inputs (harvest summaries,
 * loop entries, the budget ledger, timestamps, and a few booleans/flags — into
 * render-ready view models the panel paints as quiet, theme-native chips. It
 * adds NO new capability: every action row maps to an existing command or file
 * open; every status row is a read-only status + deep-link.
 *
 * No `obsidian` import — deliberately, so it is unit-testable with plain values.
 * The impure shell (the panel module) gathers the inputs (reads the harvest log
 * and the loops file, shells out to git for the last auto-commit)
 * and wires the returned view models to click handlers.
 */

import { activeLoops, dueLoops, type LoopEntry } from "./open-loops";
import { resetIfNewDay, type BudgetLedger } from "./background-budget";
import { nextAutomation, type AutomationConfig } from "./automations";

/** A read-only stat, rendered as a non-clickable chip (`label: value`). */
export interface HubStat {
  label: string;
  value: string;
}

/** An action row → maps by `id` to an existing command / file open in the panel. */
export interface HubAction {
  id:
    | "undo-harvest"
    | "open-inbox"
    | "open-loops"
    | "open-review"
    | "queue-drain"
    | "queue-new"
    | "automations"
    | "run-playbook";
  label: string;
  /** When false the chip renders inert (e.g. undo with no snapshot). */
  enabled: boolean;
  /** Optional trailing badge, e.g. a due-loop count. */
  badge?: string;
  /** Optional caveat shown alongside an *enabled* action (e.g. a reduced pass
   *  the button still runs, just not the full pipeline) — distinct from
   *  `badge`, which signals urgency/count rather than a scope caveat. */
  hint?: string;
}

/** A read-only status row → deep-links to Exo settings; the dot reflects `enabled`. */
export interface HubStatus {
  id: "autocommit" | "memory" | "queue" | "schedules";
  label: string;
  value: string;
  enabled: boolean;
}

/* ------------------------------ formatters ------------------------------ */

/** One decimal, dropping a trailing `.0` (12 → "12", 12.3 → "12.3"). */
function trim1(x: number): string {
  const r = Math.round(x * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** Compact a token/entry count: 500 → "500", 12000 → "12k", 1_500_000 → "1.5M".
 *  Non-finite / non-positive → "0". */
export function compactCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const abs = Math.floor(n);
  if (abs < 1000) return String(abs);
  if (abs < 1_000_000) return `${trim1(abs / 1000)}k`;
  return `${trim1(abs / 1_000_000)}M`;
}

/** Today's used-vs-budget label, e.g. "12k/200k". A non-positive budget renders
 *  as unlimited ("12k/∞"). The ledger is rolled to `now`'s UTC day first so a
 *  stale day's counter never shows. */
export function formatBudget(ledger: BudgetLedger, dailyBudget: number, now: number): string {
  const rolled = resetIfNewDay(ledger, now);
  const used = compactCount(rolled.tokensUsed);
  return dailyBudget > 0 ? `${used}/${compactCount(dailyBudget)}` : `${used}/∞`;
}

/** Relative age of `then` (epoch ms) vs `now`: "just now", "5m ago", "3h ago",
 *  "2d ago", else an absolute `YYYY-MM-DD`. Null / non-positive / non-finite →
 *  `fallback` (e.g. "never" for the last harvest, a dash while the git fetch is
 *  pending). A future timestamp (clock skew) reads as "just now". */
export function formatAge(then: number | null | undefined, now: number, fallback: string): string {
  if (then == null || !Number.isFinite(then) || then <= 0) return fallback;
  const diff = now - then;
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  if (diff < MIN) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  const d = new Date(then);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ------------------------------ Memory card ------------------------------ */

/** One memory harvest as the Memory card counts it. */
export interface HarvestSummary {
  at: number;
  writes: number;
  undone: boolean;
}

export interface MemoryCardInput {
  /** `autoMemory` setting. */
  autoMemory: boolean;
  /** Recent harvests, newest first. */
  harvests: HarvestSummary[];
  /** All parsed open-loops ledger entries. */
  loops: LoopEntry[];
  ledger: BudgetLedger;
  /** `backgroundDailyTokenBudget` (≤ 0 = unlimited). */
  dailyBudget: number;
  now: number;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The Memory card's live stats line: automatic memory, last harvest, writes
 *  this week, loop counts, budget. */
export function memoryStats(input: MemoryCardInput): HubStat[] {
  const open = activeLoops(input.loops).length;
  const due = dueLoops(input.loops, input.now).length;
  const week = input.harvests
    .filter((h) => !h.undone && input.now - h.at <= WEEK_MS)
    .reduce((n, h) => n + h.writes, 0);
  return [
    { label: "Auto memory", value: input.autoMemory ? "on" : "off" },
    { label: "Last harvest", value: formatAge(input.harvests[0]?.at, input.now, "never") },
    { label: "Writes 7d", value: String(week) },
    { label: "Loops", value: `${open} open · ${due} due` },
    { label: "Budget", value: formatBudget(input.ledger, input.dailyBudget, input.now) },
  ];
}

export interface MemoryActionsInput {
  /** A harvest not yet undone exists → undo is available. */
  canUndo: boolean;
  /** Today's inbox note exists → the inbox row is enabled. */
  inboxExists: boolean;
  /** The review note (`paths.review`) exists → the review row is shown. */
  reviewExists: boolean;
  loops: LoopEntry[];
  now: number;
}

/** The Memory card's action rows. `undo-harvest` is disabled with nothing to
 *  undo; `open-loops` carries a due-count badge; `open-review` is omitted when
 *  the file is absent. */
export function memoryActions(input: MemoryActionsInput): HubAction[] {
  const due = dueLoops(input.loops, input.now).length;
  const actions: HubAction[] = [
    { id: "undo-harvest", label: "Undo last memory write", enabled: input.canUndo },
    { id: "open-inbox", label: "Open today's unfiled memory", enabled: input.inboxExists },
    { id: "open-loops", label: "Open open-loops", enabled: true, ...(due > 0 ? { badge: `${due} due` } : {}) },
  ];
  if (input.reviewExists) actions.push({ id: "open-review", label: "Open review.md", enabled: true });
  return actions;
}

/* ----------------------------- Autonomy card ----------------------------- */

/* Scheduling itself lives in core/automations (slot-based cadences); this card
 * only formats "what fires next" from the structured configs. */

/** "due now" / "in 3h" / "in 2d" — rough is fine, it's a glance. */
function formatDueIn(ms: number): string {
  if (ms <= 0) return "due now";
  const HOUR = 3_600_000;
  if (ms < HOUR) return `in ${Math.max(1, Math.floor(ms / 60_000))}m`;
  if (ms < 24 * HOUR) return `in ${Math.floor(ms / HOUR)}h`;
  return `in ${Math.floor(ms / (24 * HOUR))}d`;
}

export interface AutonomyInput {
  exoQueueEnabled: boolean;
  /** Pending request notes in the queue folder; null = unknown (still loading). */
  queuePending: number | null;
  automations: AutomationConfig[];
  scheduledLastRun: Record<string, number>;
  /** Any custom prompts exist → "Run playbook…" is meaningful. */
  hasPlaybooks: boolean;
  now: number;
}

/** The Autonomy card's status rows: queue (with pending count) + schedules
 *  (with the next playbook due). */
export function autonomyStatuses(input: AutonomyInput): HubStatus[] {
  const pending = input.queuePending;
  const queueValue = !input.exoQueueEnabled
    ? "off"
    : pending == null
      ? "on"
      : pending > 0
        ? `on · ${pending} pending`
        : "on · idle";
  const enabled = input.automations.filter((a) => a.enabled);
  const next = nextAutomation(enabled, input.scheduledLastRun, input.now);
  const schedValue = !enabled.length
    ? input.automations.length
      ? "all paused"
      : "none"
    : `${enabled.length} active · ${next!.name} ${formatDueIn(next!.dueAt - input.now)}`;
  return [
    { id: "queue", label: "Exo Queue", value: queueValue, enabled: input.exoQueueEnabled },
    { id: "schedules", label: "Automations", value: schedValue, enabled: enabled.length > 0 },
  ];
}

/** The Autonomy card's action rows. Drain carries the pending count as a badge;
 *  queue actions render inert when the queue is off. */
export function autonomyActions(input: AutonomyInput): HubAction[] {
  const pending = input.queuePending ?? 0;
  return [
    {
      id: "queue-drain",
      label: "Drain queue now",
      enabled: input.exoQueueEnabled,
      ...(pending > 0 ? { badge: `${pending} pending` } : {}),
    },
    { id: "queue-new", label: "New queue request", enabled: input.exoQueueEnabled },
    {
      id: "run-playbook",
      label: "Run playbook…",
      enabled: input.hasPlaybooks,
      ...(input.hasPlaybooks ? {} : { hint: "no playbooks yet" }),
    },
    { id: "automations", label: "Automations…", enabled: true },
  ];
}

/* ------------------------------ System card ------------------------------ */

export interface SystemCardInput {
  /** `vaultAutoCommit` setting. */
  vaultAutoCommit: boolean;
  /** Epoch ms of the last `exo: auto-commit` in git log, or null (unknown / pending / none). */
  lastAutoCommitEpoch: number | null;
  /** `memoryCaps(...).autoCapture`: memory harvest can run. */
  autoCapture: boolean;
  now: number;
}

/** The System card's read-only status rows (auto-commit, memory). Each is a
 *  status + deep-link to settings — never a toggle. */
export function systemStatuses(input: SystemCardInput): HubStatus[] {
  const commitAge = formatAge(input.lastAutoCommitEpoch, input.now, "—");
  return [
    {
      id: "autocommit",
      label: "Auto-commit",
      value: input.vaultAutoCommit ? `on · ${commitAge}` : "off",
      enabled: input.vaultAutoCommit,
    },
    {
      id: "memory",
      label: "Automatic memory",
      value: input.autoCapture ? "on" : "off",
      enabled: input.autoCapture,
    },
  ];
}
