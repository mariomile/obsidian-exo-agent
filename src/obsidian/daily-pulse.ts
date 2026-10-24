/**
 * Daily Pulse collection shell.
 *
 * This module gathers the bounded facts consumed by the pure Daily Pulse
 * model. All IO is injected through structural adapters so collection can be
 * tested without loading Obsidian and one unavailable source cannot blank the
 * data returned by the other sources.
 */

import type { AutomationRef, AutomationRunRecord } from "../core/automations";
import { groupUnreviewedRuns } from "../core/inbox";
import {
  resetIfNewDay,
  type BudgetLedger,
} from "../core/background-budget";
import {
  buildDailyPulse,
  type DailyPulse,
  type DailyPulseAction,
  type DailyPulseInput,
  type DailyPulseItem,
} from "../core/daily-pulse";
import { dueLoops, type LoopEntry } from "../core/open-loops";
import type { ProposalKind } from "../core/proposals";
import type { WriteQueue } from "../core/write-queue";
import { exoPaths, LEGACY_MEMORY_ROOT, type ExoPaths } from "../core/paths";

/** Legacy default review-note path. Live callers pass the
 *  configured `paths.review`; kept as the module-level default so the many
 *  existing call sites and tests stay byte-identical. */
export const DAILY_PULSE_TARGET_PATH = exoPaths(LEGACY_MEMORY_ROOT).review;
export const DAILY_PULSE_START_MARKER = "<!-- exo:daily-pulse:start -->";
export const DAILY_PULSE_END_MARKER = "<!-- exo:daily-pulse:end -->";
export const DAILY_PULSE_FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1_000;
export const DAILY_PULSE_RECENT_NOTE_LIMIT = 20;
/**
 * The metadata adapter must stop after this many candidates. The collector
 * may discard internal/noisy paths, then applies the smaller output limit.
 */
export const DAILY_PULSE_RECENT_NOTE_SCAN_LIMIT = 50;

export type DailyPulseCollectionSource =
  | "loops"
  | "proposals"
  | "automations"
  | "recent-notes"
  | "budget";

export interface DailyPulseCollectionWarning {
  source: DailyPulseCollectionSource;
  message: string;
}

export interface RecentNoteCandidate {
  path: string;
  mtime: number;
}

export interface RecentNoteQuery {
  /** Exclusive lower boundary for candidate mtimes. */
  modifiedAfter: number;
  /** Hard maximum the adapter may inspect/return. */
  limit: number;
}

export interface DailyPulseBudgetSnapshot {
  enabled: boolean;
  dailyBudget: number;
  ledger: BudgetLedger;
}

interface PendingProposalSource {
  records: readonly {
    id: string;
    kind: ProposalKind;
    title: string;
  }[];
  warnings: readonly string[];
}

/**
 * Structural slices implemented by ProposalStore and the eventual
 * Obsidian wiring. `listRecentNotes` receives both a boundary and a hard cap;
 * broad vault enumeration is deliberately outside this contract.
 */
export interface DailyPulseCollectionSources {
  loadLoops(): Promise<readonly LoopEntry[]>;
  proposalStore: { listPending(): Promise<PendingProposalSource> };
  loadAutomationRuns(): Promise<readonly AutomationRunRecord[]>;
  /** The automations that own runs, so pre-v2 runs group as in the Inbox. */
  listAutomations(): readonly AutomationRef[];
  listRecentNotes(query: RecentNoteQuery): Promise<readonly RecentNoteCandidate[]>;
  loadBackgroundBudget(): Promise<DailyPulseBudgetSnapshot>;
}

export interface DailyPulseCollectionOptions {
  now: number;
  /** Missing on the first run; a bounded 24-hour lookback is used instead. */
  lastPulseAt?: number | null;
  /** The review-note path to exclude from "recent notes" (Exo's own output must
   *  not surface as a recent note). Absent → the legacy review-note path. */
  reviewPath?: string;
  /** The vault's config folder (`Vault#configDir`); its files are never
   *  "recent notes". */
  configDir?: string;
}

export interface DailyPulseCollectionResult {
  input: DailyPulseInput;
  warnings: DailyPulseCollectionWarning[];
}

/** Minimal file surface used by the serialized Daily Pulse read-modify-write. */
export interface DailyPulseFileAdapter {
  /** Return null only when the target file does not exist. */
  read(path: string): Promise<string | null>;
  /** Create or replace the target. Parent-folder handling belongs to the adapter. */
  write(path: string, content: string): Promise<void>;
}

export type DailyPulseWriteErrorCode =
  | "partial-markers"
  | "reversed-markers"
  | "duplicate-markers";

/**
 * A marker-layout error is recoverable by repairing the review note manually
 * and retrying. The writer never changes the file in this state.
 */
export class DailyPulseWriteError extends Error {
  readonly recoverable = true;

  constructor(
    readonly code: DailyPulseWriteErrorCode,
    readonly warning: string
  ) {
    super(warning);
    this.name = "DailyPulseWriteError";
  }
}

export interface DailyPulseWriteResult {
  path: string;
  created: boolean;
  changed: boolean;
}

export interface GeneratedDailyPulse {
  pulse: DailyPulse;
  warnings: DailyPulseCollectionWarning[];
  write: DailyPulseWriteResult;
}

interface Captured<T> {
  value: T;
  warnings: DailyPulseCollectionWarning[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function capture<T>(
  source: DailyPulseCollectionSource,
  load: () => Promise<T>,
  fallback: T
): Promise<Captured<T>> {
  try {
    return { value: await load(), warnings: [] };
  } catch (error) {
    return {
      value: fallback,
      warnings: [{ source, message: errorMessage(error) }],
    };
  }
}

function embeddedWarnings(
  source: DailyPulseCollectionSource,
  warnings: readonly string[]
): DailyPulseCollectionWarning[] {
  return warnings.map((message) => ({ source, message }));
}

function recentBoundary(now: number, lastPulseAt?: number | null): number {
  if (typeof lastPulseAt === "number" && Number.isFinite(lastPulseAt)) {
    return Math.min(lastPulseAt, now);
  }
  return now - DAILY_PULSE_FIRST_RUN_LOOKBACK_MS;
}

function normalizeVaultPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isExcludedRecentPath(path: string, reviewPath: string, configDir: string | undefined): boolean {
  return (configDir !== undefined && (path === configDir || path.startsWith(`${configDir}/`)))
    || path === reviewPath
    || path === "Resources/_artifacts"
    || path.startsWith("Resources/_artifacts/");
}

function collectRecentNotes(
  candidates: readonly RecentNoteCandidate[],
  modifiedAfter: number,
  now: number,
  reviewPath: string,
  configDir: string | undefined
): DailyPulseInput["recentNotes"] {
  const newestByPath = new Map<string, number>();
  for (const candidate of candidates.slice(0, DAILY_PULSE_RECENT_NOTE_SCAN_LIMIT)) {
    const path = normalizeVaultPath(candidate.path);
    if (!path || !/\.md$/i.test(path) || isExcludedRecentPath(path, reviewPath, configDir)) continue;
    if (!Number.isFinite(candidate.mtime)
      || candidate.mtime <= modifiedAfter
      || candidate.mtime > now) continue;
    const prior = newestByPath.get(path);
    if (prior === undefined || candidate.mtime > prior) {
      newestByPath.set(path, candidate.mtime);
    }
  }

  return [...newestByPath]
    .map(([path, mtime]) => ({ path, mtime }))
    .sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))
    .slice(0, DAILY_PULSE_RECENT_NOTE_LIMIT);
}

function remainingBudget(snapshot: DailyPulseBudgetSnapshot, now: number): number | null {
  if (!snapshot.enabled) return null;
  if (!(snapshot.dailyBudget > 0) || !Number.isFinite(snapshot.dailyBudget)) return null;
  const ledger = resetIfNewDay(snapshot.ledger, now);
  const used = Number.isFinite(ledger.tokensUsed) && ledger.tokensUsed > 0
    ? ledger.tokensUsed
    : 0;
  return Math.max(0, snapshot.dailyBudget - used);
}

/** Collect a DailyPulseInput while preserving partial success and warnings. */
export async function collectDailyPulseInput(
  sources: DailyPulseCollectionSources,
  options: DailyPulseCollectionOptions
): Promise<DailyPulseCollectionResult> {
  const { now } = options;
  const reviewPath = options.reviewPath ?? DAILY_PULSE_TARGET_PATH;
  const modifiedAfter = recentBoundary(now, options.lastPulseAt);
  const [loops, proposals, automations, notes, budget] = await Promise.all([
    capture("loops", () => sources.loadLoops(), []),
    capture("proposals", () => sources.proposalStore.listPending(), { records: [], warnings: [] }),
    capture("automations", () => sources.loadAutomationRuns(), []),
    capture(
      "recent-notes",
      () => sources.listRecentNotes({
        modifiedAfter,
        limit: DAILY_PULSE_RECENT_NOTE_SCAN_LIMIT,
      }),
      []
    ),
    capture("budget", () => sources.loadBackgroundBudget(), null),
  ]);

  const warnings = [
    ...loops.warnings,
    ...proposals.warnings,
    ...embeddedWarnings("proposals", proposals.value.warnings),
    ...automations.warnings,
    ...notes.warnings,
    ...budget.warnings,
  ];

  return {
    input: {
      now,
      dueLoops: dueLoops([...loops.value], now).map(({ id, title, resurface }) => ({
        id,
        title,
        ...(resurface ? { resurface } : {}),
      })),
      pendingProposals: proposals.value.records.map(({ id, kind, title }) => ({
        id,
        kind,
        title,
      })),
      // One entry per automation, as in the Inbox: the newest run stands for its group.
      automationRuns: groupUnreviewedRuns(automations.value, sources.listAutomations()).map((g) => ({
        id: g.runs[0].id,
        name: g.name,
        startedAt: g.runs[0].startedAt,
        writes: [...new Set(g.runs.flatMap((r) => r.writes))],
      })),
      recentNotes: collectRecentNotes(notes.value, modifiedAfter, now, reviewPath, options.configDir),
      budget: {
        remaining: budget.value === null ? null : remainingBudget(budget.value, now),
        ...(budget.value === null ? {} : { enabled: budget.value.enabled }),
      },
    },
    warnings,
  };
}

function markerCount(content: string, marker: string): number {
  let count = 0;
  let from = 0;
  while (true) {
    const index = content.indexOf(marker, from);
    if (index === -1) return count;
    count += 1;
    from = index + marker.length;
  }
}

function validateMarkerLayout(content: string): "absent" | "valid" {
  const starts = markerCount(content, DAILY_PULSE_START_MARKER);
  const ends = markerCount(content, DAILY_PULSE_END_MARKER);
  if (starts > 1 || ends > 1) {
    throw new DailyPulseWriteError(
      "duplicate-markers",
      "Daily Pulse found duplicate review markers. Keep exactly one start/end pair, then retry."
    );
  }
  if (starts !== ends) {
    throw new DailyPulseWriteError(
      "partial-markers",
      "Daily Pulse found only one review marker. Restore the missing marker, then retry."
    );
  }
  if (starts === 0) return "absent";
  if (content.indexOf(DAILY_PULSE_START_MARKER) > content.indexOf(DAILY_PULSE_END_MARKER)) {
    throw new DailyPulseWriteError(
      "reversed-markers",
      "Daily Pulse review markers are reversed. Put the start marker first, then retry."
    );
  }
  return "valid";
}

function oneLine(value: string): string {
  return value
    .replaceAll(DAILY_PULSE_START_MARKER, "&lt;!-- exo:daily-pulse:start --&gt;")
    .replaceAll(DAILY_PULSE_END_MARKER, "&lt;!-- exo:daily-pulse:end --&gt;")
    .replace(/\s+/g, " ")
    .trim();
}

function wikiAlias(value: string): string {
  return oneLine(value).replace(/\|/g, "\\|").replace(/\]/g, "\\]");
}

function wikiPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\.md$/i, "").replace(/\]/g, "\\]");
}

/** Strip the `.md` suffix so a vault path becomes a wikilink target. */
function wikiTarget(path: string): string {
  return path.replace(/\.md$/i, "");
}

function itemLabel(item: DailyPulseItem, paths: ExoPaths): string {
  const alias = wikiAlias(item.title);
  switch (item.target.kind) {
    case "loop":
      return `[[${wikiTarget(paths.openLoops)}|${alias}]]`;
    case "note":
      return `[[${wikiPath(item.target.path)}|${alias}]]`;
    case "proposal":
    case "automation":
    case "system":
      return `**${alias}**`;
  }
}

export function dailyPulseActionHref(action: DailyPulseAction): string {
  const params = new URLSearchParams();
  if (action.kind === "open") {
    params.set("target", "note");
    params.set("path", action.path);
  } else {
    params.set("target", action.target);
  }
  return `obsidian://exo-daily-pulse?${params.toString()}`;
}

function actionLabel(action: DailyPulseAction): string {
  if (action.kind === "open") return "Open note";
  switch (action.target) {
    case "loop": return "Review loop";
    case "proposal": return "Review suggestion";
    case "automation": return "Review automation";
  }
}

function actionText(action: DailyPulseAction): string {
  return `[${actionLabel(action)}](${dailyPulseActionHref(action)})`;
}

function actionMetadata(action: DailyPulseAction): string {
  // Keep metadata parseable JSON while making a comment terminator impossible.
  return JSON.stringify(action)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/--/g, "\\u002d\\u002d");
}

function warningLabel(source: DailyPulseCollectionSource): string {
  switch (source) {
    case "loops": return "Loops";
    case "proposals": return "Suggestions";
    case "automations": return "Automations";
    case "recent-notes": return "Recent notes";
    case "budget": return "Budget";
  }
}

/** Render marker contents only; callers own marker placement and file IO. */
export function renderDailyPulseBlock(
  pulse: DailyPulse,
  warnings: readonly DailyPulseCollectionWarning[],
  paths: ExoPaths = exoPaths(LEGACY_MEMORY_ROOT)
): string {
  const lines = [
    "# Daily Pulse",
    "",
    `_Generated ${new Date(pulse.generatedAt).toISOString()}_`,
  ];

  if (warnings.length > 0) {
    lines.push(
      "",
      "> [!warning]- Partial review",
      "> Some sources could not be refreshed; available items are still shown.",
      ...warnings.map(({ source, message }) =>
        `> - ${warningLabel(source)}: ${oneLine(message) || "Unavailable"}`
      )
    );
  }

  for (const section of pulse.sections) {
    lines.push("", `## ${section.title}`, "");
    for (const item of section.items) {
      lines.push(`- ${itemLabel(item, paths)}${item.detail ? ` — ${oneLine(item.detail)}` : ""}`);
      if (item.action) {
        lines.push(
          `  - Action: ${actionText(item.action)}`,
          `  - <!-- exo:daily-pulse:cta ${actionMetadata(item.action)} -->`
        );
      }
    }
  }

  if (pulse.sections.length === 0) {
    lines.push("", "Nothing needs review right now.");
  }
  return lines.join("\n");
}

function markedBlock(rendered: string): string {
  return `${DAILY_PULSE_START_MARKER}\n${rendered}\n${DAILY_PULSE_END_MARKER}\n`;
}

function initialReviewFile(pulse: DailyPulse, rendered: string): string {
  const date = new Date(pulse.generatedAt).toISOString().slice(0, 10);
  return [
    "---",
    "type: reference",
    "tags:",
    "  - type/reference",
    "created_by: exo",
    `last_updated: ${date}`,
    "last_edited_by: exo",
    "---",
    "",
    markedBlock(rendered),
  ].join("\n");
}

function appendBlock(content: string, block: string): string {
  if (content.length === 0 || content.endsWith("\n\n")) return `${content}${block}`;
  return `${content}${content.endsWith("\n") ? "\n" : "\n\n"}${block}`;
}

function replaceMarkerContents(content: string, rendered: string): string {
  const start = content.indexOf(DAILY_PULSE_START_MARKER) + DAILY_PULSE_START_MARKER.length;
  const end = content.indexOf(DAILY_PULSE_END_MARKER);
  return `${content.slice(0, start)}\n${rendered}\n${content.slice(end)}`;
}

/**
 * Serialize the complete review-note read/validate/render/write transaction.
 * No write occurs for invalid markers or byte-identical output.
 */
export function writeDailyPulse(
  adapter: DailyPulseFileAdapter,
  queue: WriteQueue,
  pulse: DailyPulse,
  warnings: readonly DailyPulseCollectionWarning[],
  paths: ExoPaths = exoPaths(LEGACY_MEMORY_ROOT)
): Promise<DailyPulseWriteResult> {
  const reviewPath = paths.review;
  return queue.enqueue(async () => {
    const current = await adapter.read(reviewPath);
    const rendered = renderDailyPulseBlock(pulse, warnings, paths);
    const created = current === null;
    let next: string;

    if (created) {
      next = initialReviewFile(pulse, rendered);
    } else {
      const layout = validateMarkerLayout(current);
      next = layout === "valid"
        ? replaceMarkerContents(current, rendered)
        : appendBlock(current, markedBlock(rendered));
    }

    if (next === current) {
      return { path: reviewPath, created: false, changed: false };
    }
    await adapter.write(reviewPath, next);
    return { path: reviewPath, created, changed: true };
  });
}

/** Complete deterministic collection/build/write pipeline; it never invokes an LLM. */
export async function generateAndWriteDailyPulse(
  sources: DailyPulseCollectionSources,
  adapter: DailyPulseFileAdapter,
  queue: WriteQueue,
  options: DailyPulseCollectionOptions,
  paths: ExoPaths = exoPaths(LEGACY_MEMORY_ROOT)
): Promise<GeneratedDailyPulse> {
  const collected = await collectDailyPulseInput(sources, { ...options, reviewPath: options.reviewPath ?? paths.review });
  const pulse = buildDailyPulse(collected.input);
  const write = await writeDailyPulse(adapter, queue, pulse, collected.warnings, paths);
  return { pulse, warnings: collected.warnings, write };
}
