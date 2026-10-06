/**
 * Child reports — the pure half of "a spawned child tells its parent what
 * happened" (no Obsidian imports).
 *
 * The driver observes convo-state events for child convos and turns each
 * outcome into a `ChildReport`. This module decides what an outcome IS, how the
 * excerpt is capped, and how a batch reads to the parent model. Delivery (UI
 * card, and queueing onto the parent's next turn) lives in the impure caller.
 */
import type { ConvoState, ConvoStateReason } from "./convo-state";

/** Longest child excerpt handed to the parent. */
export const EXCERPT_CAP = 2000;
/** How long the driver batches reports before delivering them. */
export const REPORT_DEBOUNCE_MS = 2000;
/**
 * How many undelivered reports one parent may hold. The queue is PERSISTED
 * (see `reviveChildReports`), so an uncapped one is an uncapped write to
 * conversations.json; and a parent sitting on more than a handful of unread
 * children is holding a briefing nobody will read anyway. Enforced where the
 * queue is filled, not only where it is saved, so runtime and disk can never
 * disagree about what the parent is carrying.
 */
export const MAX_PENDING_CHILD_REPORTS = 10;

export type ChildOutcome = "done" | "blocked" | "stopped" | "error";

const OUTCOMES: ReadonlySet<string> = new Set<ChildOutcome>(["done", "blocked", "stopped", "error"]);

export interface ChildReport {
  taskId: string;
  /** The convo that ran the child. EMPTY when the spawn itself failed: there
   *  never was a conversation. That case is precisely why routing must not go
   *  through this field (see `parentConvoId`). */
  childConvoId: string;
  /** Who the report is FOR — the convo id recorded as the task's `parent` in
   *  the ledger. Carried on the report rather than resolved downstream by
   *  looking `childConvoId` up among the conversations: that lookup finds
   *  nothing for a spawn failure, which silently drops exactly the report the
   *  parent most needs (the one saying its child never started). */
  parentConvoId: string;
  title: string;
  outcome: ChildOutcome;
  excerpt: string;
  /** Wall-clock ms when the outcome landed. */
  at: number;
}

/** The shape this module needs of a conversation to route a report to it. The
 *  view's `Convo` satisfies it structurally, so nothing here imports the view. */
export interface ReportHolder {
  id: string;
  pendingChildReports?: ChildReport[];
}

/**
 * Queue a report onto the conversation it names as parent, and return that
 * conversation so the caller can surface it.
 *
 * Returns `undefined` when the parent is not in `convos` — archived, deleted,
 * or simply gone. Dropping the report there is CORRECT, not a bug: there is no
 * next turn to hand it to and no transcript to show it in. It is also the only
 * failure mode, which is why routing is by `parentConvoId` and never by walking
 * back from `childConvoId`.
 */
export function queueReportForParent<T extends ReportHolder>(
  convos: readonly T[],
  report: ChildReport,
): T | undefined {
  const parent = convos.find((c) => c.id === report.parentConvoId);
  if (!parent) return undefined;
  const queued = (parent.pendingChildReports ??= []);
  // One report per task: a newer outcome replaces the older one, so a child
  // that was "blocked" on an approval and then finished reaches its parent as
  // "done", not as both.
  const same = queued.findIndex((r) => r.taskId === report.taskId);
  if (same >= 0) queued.splice(same, 1);
  queued.push(report);
  // Drop the OLDEST past the cap: a stale report is the one whose news has
  // least chance of still mattering to the next turn.
  if (queued.length > MAX_PENDING_CHILD_REPORTS) {
    queued.splice(0, queued.length - MAX_PENDING_CHILD_REPORTS);
  }
  return parent;
}

/**
 * Rebuild a persisted report queue, or `undefined` when there is nothing usable
 * to rebuild — so a chat that delegated nothing stays absent on disk rather than
 * growing an empty array in every entry.
 *
 * Validating rather than trusting, because `conversations.json` is a plain file
 * a human (or a half-finished write) can leave malformed, and what comes out of
 * here is spliced verbatim into the parent's next outbound message. Two fields
 * are load-bearing and therefore mandatory: `parentConvoId` (the only routing
 * key — a report without it can never be delivered) and a known `outcome`
 * (`formatReportsForParent` indexes a table with it, and an unknown value would
 * render `undefined` into the message). `childConvoId` is deliberately NOT
 * required: it is empty for the spawn-failure report, which is the one the
 * parent most needs.
 */
export function reviveChildReports(raw: unknown): ChildReport[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ChildReport[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Partial<ChildReport>;
    if (typeof r.parentConvoId !== "string" || !r.parentConvoId) continue;
    if (typeof r.outcome !== "string" || !OUTCOMES.has(r.outcome)) continue;
    out.push({
      taskId: typeof r.taskId === "string" ? r.taskId : "",
      childConvoId: typeof r.childConvoId === "string" ? r.childConvoId : "",
      parentConvoId: r.parentConvoId,
      title: typeof r.title === "string" ? r.title : "",
      outcome: r.outcome,
      excerpt: typeof r.excerpt === "string" ? r.excerpt : "",
      at: typeof r.at === "number" ? r.at : 0,
    });
  }
  if (!out.length) return undefined;
  // Same rule as the live queue, applied to a file that could have been grown
  // by hand or by an older build that did not cap.
  return out.slice(-MAX_PENDING_CHILD_REPORTS);
}

/**
 * Take everything queued on a parent and render it for that parent's next turn,
 * emptying the queue in the same step.
 *
 * Drain and format are ONE function on purpose. Split apart, a caller can
 * format without draining — and since the prefix is rebuilt on every turn, the
 * same "your child finished" message would then ride every subsequent turn
 * forever. Returns "" when there is nothing queued, so the caller can drop it
 * from the outbound join with a falsy filter.
 */
export function drainReportsForParent(parent: ReportHolder): string {
  const queued = parent.pendingChildReports;
  if (!queued?.length) return "";
  parent.pendingChildReports = [];
  return formatReportsForParent(queued);
}

/**
 * Map a convo-state notification to a child outcome, or null when the event is
 * not an outcome at all (`turn-start`). `needs-input` is ambiguous by design on
 * that channel: reason `error` is a failure, everything else (`perm`, `ask`, or
 * no reason at all) is a live question waiting for Mario.
 */
export function outcomeFromState(state: ConvoState, reason?: ConvoStateReason): ChildOutcome | null {
  if (state === "turn-end") return "done";
  if (state === "stopped") return "stopped";
  if (state === "error") return "error";
  if (state === "needs-input") return reason === "error" ? "error" : "blocked";
  return null;
}

/** The structural slice of a conversation's messages this module reads. The
 *  view's `Message` union satisfies it; nothing here imports the view. */
export interface ReportMessage {
  role: string;
  segments?: readonly { t: string; md?: string }[];
}

/**
 * The child's last answer, as the text that goes into a report's excerpt.
 *
 * An assistant turn is SEGMENTS, not a string — the `Message` union gives
 * `text` to user turns only (core/model.ts). Reading `.text` off an assistant
 * message therefore yields "" for every child, and every report ships with an
 * empty excerpt: a failure that is invisible from the outside, because the
 * report still arrives on time and merely says nothing. Hence this lives here,
 * under test, rather than as three lines inside the untested view.
 *
 * Only `text` segments count, and a turn with none falls through to the last
 * turn that did say something: a child whose final act was a tool call has no
 * prose of its own, and reporting silence there is strictly worse than
 * reporting the last thing it actually said.
 */
export function lastAssistantText(messages: readonly ReportMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const text = (m.segments ?? [])
      .filter((s) => s.t === "text")
      .map((s) => s.md ?? "")
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

/** Trim and cap a child's last assistant text for inclusion in a report. */
export function buildExcerpt(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= EXCERPT_CAP) return trimmed;
  return `${trimmed.slice(0, EXCERPT_CAP)}… [truncated]`;
}

const OUTCOME_LINE: Record<ChildOutcome, string> = {
  done: "is done",
  blocked: "is blocked, waiting for input",
  stopped: "was stopped by Mario",
  error: "hit an error and failed",
};

/**
 * Render a batch of reports as one message for the parent agent. Deliberately
 * plain prose: it is prepended to the parent's next turn, so it must read as
 * context, not as a tool result or a command.
 */
export function formatReportsForParent(reports: ChildReport[]): string {
  if (!reports.length) return "";
  const blocks = reports.map((r) => {
    const head = `Child task "${r.title}" (${r.taskId}) ${OUTCOME_LINE[r.outcome]}.`;
    const body = r.excerpt ? `\n${r.excerpt}` : "";
    return `${head}${body}`;
  });
  // Count-agnostic on purpose. "One of these was stopped by hand" was false at
  // BOTH edges of a batch: wrong for a single report (there is no "these"), and
  // actively harmful for two or more stopped children — it names one, which
  // reads as licence to pick the second one back up. This is the guardrail that
  // stops an agent resuming work a human deliberately killed, so it has to hold
  // for any number of them.
  const guidance = reports.some((r) => r.outcome === "stopped")
    ? "\n\nAny task above shown as stopped was stopped by hand: do not resume its work unless Mario asks."
    : "";
  const plural = reports.length === 1 ? "a task you delegated" : "tasks you delegated";
  return `Update on ${plural}:\n\n${blocks.join("\n\n")}${guidance}`;
}
