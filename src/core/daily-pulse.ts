/**
 * Daily Pulse — deterministic, side-effect-free view model.
 *
 * Collection and rendering live in the Obsidian layer. This module only turns
 * already-collected facts into a bounded set of review/open actions.
 */

import type { ProposalKind } from "./proposals";
import { isDue, type AutomationConfig } from "./automations";

export const DAILY_PULSE_AUTOMATION_NAME = "Daily Pulse";

/** Default system automation. It is intentionally inert until explicitly enabled. */
export function createDailyPulseAutomation(): AutomationConfig {
  return {
    name: DAILY_PULSE_AUTOMATION_NAME,
    system: "daily-pulse",
    cadence: { kind: "daily", hour: 8 },
    enabled: false,
    write: true,
  };
}

export function isDailyPulseAutomation(
  automation: AutomationConfig
): automation is AutomationConfig & { system: "daily-pulse" } {
  return automation.system === "daily-pulse";
}

export interface DailyPulseSeedResult {
  automations: AutomationConfig[];
  seeded: boolean;
  changed: boolean;
}

/**
 * One-shot settings migration for the system Daily Pulse automation.
 * Once `seeded` is persisted, user edits and deletion are authoritative.
 */
export function seedDailyPulseAutomation(
  automations: readonly AutomationConfig[],
  seeded: boolean
): DailyPulseSeedResult {
  if (seeded) {
    return { automations: [...automations], seeded: true, changed: false };
  }

  let keptPulse = false;
  const migrated = automations.filter((automation) => {
    if (!isDailyPulseAutomation(automation)) return true;
    if (keptPulse) return false;
    keptPulse = true;
    return true;
  });
  if (!keptPulse) migrated.push(createDailyPulseAutomation());
  return {
    automations: migrated,
    seeded: true,
    changed: true,
  };
}

export type DailyPulseSlotResult =
  | { status: "disabled" }
  | { status: "current" }
  | { status: "succeeded"; completedAt: number; warningCount: number }
  | { status: "failed"; error: string; retryable: true };

export interface DailyPulseReviewState {
  status: "idle" | "ready" | "warning" | "error";
  lastAttemptAt: number;
  lastSuccessAt: number;
  lastReviewedAt: number;
  warnings: { source: string; message: string }[];
  itemCount: number;
  lastError: string;
  retryable: boolean;
}

export function initialDailyPulseReviewState(): DailyPulseReviewState {
  return {
    status: "idle",
    lastAttemptAt: 0,
    lastSuccessAt: 0,
    lastReviewedAt: 0,
    warnings: [],
    itemCount: 0,
    lastError: "",
    retryable: false,
  };
}

export function dailyPulseNeedsReview(state: DailyPulseReviewState): boolean {
  return state.itemCount > 0 && state.lastSuccessAt > state.lastReviewedAt;
}

/** Meta-line suffix for the Daily Pulse automation row. */
export function dailyPulseMetaLabel(state: DailyPulseReviewState): string {
  if (state.status === "error") return "retry available";
  if (dailyPulseNeedsReview(state)) {
    return `${state.itemCount} item${state.itemCount === 1 ? "" : "s"} to review`;
  }
  return state.lastSuccessAt > 0 ? "reviewed" : "not generated";
}

/** Persistable review/error state for the future quiet Retry UI. */
export function dailyPulseReviewAfterRun(
  previous: DailyPulseReviewState,
  result: Extract<DailyPulseSlotResult, { status: "succeeded" | "failed" }>,
  now: number,
  warnings: readonly { source: string; message: string }[] = [],
  itemCount = 0
): DailyPulseReviewState {
  if (result.status === "failed") {
    return {
      ...previous,
      status: "error",
      lastAttemptAt: now,
      warnings: [],
      lastError: result.error,
      retryable: result.retryable,
    };
  }
  return {
    status: warnings.length > 0 ? "warning" : "ready",
    lastAttemptAt: now,
    lastSuccessAt: result.completedAt,
    lastReviewedAt: previous.lastReviewedAt,
    warnings: warnings.map(({ source, message }) => ({ source, message })),
    itemCount,
    lastError: "",
    retryable: false,
  };
}

/** Execute one due slot. The caller persists `completedAt` only on success. */
export async function runDailyPulseSlot(options: {
  config: AutomationConfig;
  lastRun: number;
  now: number;
  execute: () => Promise<{ warningCount: number }>;
}): Promise<DailyPulseSlotResult> {
  if (!options.config.enabled) return { status: "disabled" };
  if (options.lastRun === 0 && options.config.cadence.kind === "daily") {
    const firstSlot = new Date(options.now);
    firstSlot.setHours(options.config.cadence.hour, 0, 0, 0);
    if (options.now < firstSlot.getTime()) return { status: "current" };
  }
  if (!isDue(options.config.cadence, options.lastRun, options.now)) {
    return { status: "current" };
  }
  try {
    const result = await options.execute();
    return {
      status: "succeeded",
      completedAt: options.now,
      warningCount: result.warningCount,
    };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      retryable: true,
    };
  }
}

/** One in-process flight for the system pulse; timer ownership stays in main.ts. */
export class DailyPulseSlotRunner {
  private inFlight: Promise<DailyPulseSlotResult> | null = null;

  run(options: Parameters<typeof runDailyPulseSlot>[0]): Promise<DailyPulseSlotResult> {
    if (this.inFlight) return this.inFlight;
    const flight = runDailyPulseSlot(options).finally(() => {
      if (this.inFlight === flight) this.inFlight = null;
    });
    this.inFlight = flight;
    return flight;
  }
}

export interface DailyPulseInput {
  now: number;
  dueLoops: { id: string; title: string; resurface?: string }[];
  pendingProposals: { id: string; kind: ProposalKind; title: string }[];
  automationRuns: { id: string; name: string; startedAt: number; writes: string[] }[];
  recentNotes: { path: string; mtime: number }[];
  budget: { remaining: number | null; enabled?: boolean };
}

export type DailyPulseSectionTitle =
  | "Attention"
  | "Open loops"
  | "Suggestions"
  | "Recent work"
  | "System";

export type DailyPulseTarget =
  | { kind: "loop"; id: string }
  | { kind: "proposal"; id: string }
  | { kind: "automation"; id: string }
  | { kind: "note"; path: string }
  | { kind: "system"; id: "budget" };

export type DailyPulseAction =
  | { kind: "review"; target: "loop" | "proposal" | "automation"; id: string }
  | { kind: "open"; path: string };

export interface DailyPulseItem {
  id: string;
  kind: "loop" | "proposal" | "automation" | "note" | "system";
  title: string;
  detail?: string;
  target: DailyPulseTarget;
  action?: DailyPulseAction;
}

export interface DailyPulseSection {
  title: DailyPulseSectionTitle;
  items: DailyPulseItem[];
}

export interface DailyPulse {
  generatedAt: number;
  sections: DailyPulseSection[];
}

export const DAILY_PULSE_SECTION_LIMIT = 5;

const PROPOSAL_KIND_ORDER: Record<ProposalKind, number> = {
  loop: 0,
  decision: 1,
  playbook: 2,
};

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareTitleAndId(
  a: { title: string; id: string },
  b: { title: string; id: string }
): number {
  return compareText(a.title, b.title) || compareText(a.id, b.id);
}

function descendingTime(a: number, b: number): number {
  const safeA = Number.isFinite(a) ? a : Number.NEGATIVE_INFINITY;
  const safeB = Number.isFinite(b) ? b : Number.NEGATIVE_INFINITY;
  return safeB - safeA;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function noteTitle(path: string): string {
  const fileName = path.split(/[\\/]/).pop() ?? path;
  return fileName.replace(/\.md$/i, "") || fileName;
}

function bounded(items: DailyPulseItem[]): DailyPulseItem[] {
  return items.slice(0, DAILY_PULSE_SECTION_LIMIT);
}

function attentionItems(input: DailyPulseInput): DailyPulseItem[] {
  const runs: DailyPulseItem[] = input.automationRuns
    .filter((run) => run.writes.length > 0)
    .slice()
    .sort(
      (a, b) =>
        descendingTime(a.startedAt, b.startedAt) ||
        compareText(a.name, b.name) ||
        compareText(a.id, b.id)
    )
    .map((run) => ({
      id: `automation:${run.id}`,
      kind: "automation",
      title: run.name,
      detail: run.writes.length === 1 ? "1 write to review" : `${run.writes.length} writes to review`,
      target: { kind: "automation", id: run.id },
      action: { kind: "review", target: "automation", id: run.id },
    }));

  return bounded(runs);
}

function loopItems(input: DailyPulseInput): DailyPulseItem[] {
  return bounded(
    [...input.dueLoops]
      .sort(
        (a, b) =>
          compareText(a.resurface ?? "", b.resurface ?? "") ||
          compareTitleAndId(a, b)
      )
      .map((loop) => ({
        id: `loop:${loop.id}`,
        kind: "loop",
        title: loop.title,
        ...(loop.resurface ? { detail: `Due ${loop.resurface}` } : {}),
        target: { kind: "loop", id: loop.id },
        action: { kind: "review", target: "loop", id: loop.id },
      }))
  );
}

function proposalItems(input: DailyPulseInput): DailyPulseItem[] {
  return bounded(
    [...input.pendingProposals]
      .sort(
        (a, b) =>
          PROPOSAL_KIND_ORDER[a.kind] - PROPOSAL_KIND_ORDER[b.kind] ||
          compareTitleAndId(a, b)
      )
      .map((proposal) => ({
        id: `proposal:${proposal.id}`,
        kind: "proposal",
        title: proposal.title,
        detail: titleCase(proposal.kind),
        target: { kind: "proposal", id: proposal.id },
        action: { kind: "review", target: "proposal", id: proposal.id },
      }))
  );
}

function recentWorkItems(input: DailyPulseInput): DailyPulseItem[] {
  return bounded(
    [...input.recentNotes]
      .sort(
        (a, b) =>
          descendingTime(a.mtime, b.mtime) ||
          compareText(a.path, b.path)
      )
      .map((note) => ({
        id: `note:${note.path}`,
        kind: "note",
        title: noteTitle(note.path),
        detail: note.path,
        target: { kind: "note", path: note.path },
        action: { kind: "open", path: note.path },
      }))
  );
}

function systemItems(input: DailyPulseInput): DailyPulseItem[] {
  const remaining = input.budget.remaining;
  if (input.budget.enabled === false) {
    return [{
      id: "system:budget",
      kind: "system",
      title: "Background AI",
      detail: "Background AI paused",
      target: { kind: "system", id: "budget" },
    }];
  }
  if (remaining === null || !Number.isFinite(remaining)) return [];
  return [{
    id: "system:budget",
    kind: "system",
    title: "Background budget",
    detail: remaining <= 0 ? "Budget exhausted" : `${remaining} remaining`,
    target: { kind: "system", id: "budget" },
  }];
}

/** Build the first-render Daily Pulse without IO, Obsidian APIs or an LLM. */
export function buildDailyPulse(input: DailyPulseInput): DailyPulse {
  const candidates: DailyPulseSection[] = [
    { title: "Attention", items: attentionItems(input) },
    { title: "Open loops", items: loopItems(input) },
    { title: "Suggestions", items: proposalItems(input) },
    { title: "Recent work", items: recentWorkItems(input) },
    { title: "System", items: systemItems(input) },
  ];

  return {
    generatedAt: input.now,
    sections: candidates.filter((section) => section.items.length > 0),
  };
}
