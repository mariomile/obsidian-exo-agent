/**
 * The per-chat message queue (pure). Messages typed while a turn runs wait here
 * and start as the next turn. Two rules keep queued work from being lost:
 *
 * - Stop and a broken session HOLD the queued messages instead of clearing
 *   them. A held message stays on screen and runs only when the user asks.
 * - The context a message was written against (attached notes, selection) is
 *   frozen when it is queued, so it reaches the model even if the user switches
 *   chat or note before the turn starts.
 */

import type { ImageAttachment } from "../providers/types";
import type { ContextSelection } from "./context-assembly";
import { normalizeResearchModeState, type ResearchModeState } from "./research";

/** Composer context captured at enqueue time. */
export interface QueuedContext {
  paths: string[];
  selection: ContextSelection | null;
}

/** What a message carries into its turn besides text and images. A queued
 *  message IS its own turn options: the drain hands it to `runTurn` as is. */
export interface TurnOpts {
  /** Hidden text sent ahead of the message (a handoff, a recovery recap). */
  sendPrefix?: string;
  isRecoveryRetry?: boolean;
  researchMode?: ResearchModeState;
  /** Agent slug bound to this message (`@agent` picked before send). */
  agent?: string;
  /** Context frozen at enqueue; absent = read the composer when the turn runs. */
  context?: QueuedContext;
}

export interface QueuedMessage extends TurnOpts {
  text: string;
  images?: ImageAttachment[];
  /** Kept after a Stop or a failed turn: never drained, runs only on request. */
  held?: true;
  /** Open in the pill editor: never drained or steered until the edit is saved. */
  editing?: true;
}

/** On-disk form of a queued message: no images (user messages in history do not
 *  persist them either), and never held or editing: those are restore-time state. */
export type PersistedQueuedMessage = Omit<QueuedMessage, "images" | "held" | "editing">;

/** The queue as written to disk. Copies, so a later edit never leaks into the
 *  saved snapshot. A message left with no text (it was only images) is dropped:
 *  there is nothing to send. */
export function serializeQueue(queue: readonly QueuedMessage[]): PersistedQueuedMessage[] {
  const out: PersistedQueuedMessage[] = [];
  for (const q of queue) {
    if (!q.text.trim()) continue;
    const p: PersistedQueuedMessage = { text: q.text };
    if (q.context) p.context = { paths: [...q.context.paths], selection: q.context.selection ? { ...q.context.selection } : null };
    if (q.agent) p.agent = q.agent;
    if (q.researchMode) p.researchMode = { ...q.researchMode };
    if (q.sendPrefix) p.sendPrefix = q.sendPrefix;
    if (q.isRecoveryRetry) p.isRecoveryRetry = true;
    out.push(p);
  }
  return out;
}

/** The queue read back from disk. Every message returns HELD: a reload must
 *  never send anything by itself, the user releases each with Run. Malformed
 *  entries are skipped. */
export function restoreQueue(raw: unknown): QueuedMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: QueuedMessage[] = [];
  for (const entry of raw as unknown[]) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    if (typeof r.text !== "string" || !r.text.trim()) continue;
    const q: QueuedMessage = { text: r.text, held: true };
    const ctx = r.context as { paths?: unknown; selection?: { text?: unknown; path?: unknown } | null } | null | undefined;
    if (ctx && Array.isArray(ctx.paths)) {
      const sel = ctx.selection;
      q.context = {
        paths: (ctx.paths as unknown[]).filter((p): p is string => typeof p === "string"),
        selection: sel && typeof sel.text === "string" && typeof sel.path === "string" ? { text: sel.text, path: sel.path } : null,
      };
    }
    if (typeof r.agent === "string" && r.agent) q.agent = r.agent;
    if (r.researchMode) q.researchMode = normalizeResearchModeState(r.researchMode);
    if (typeof r.sendPrefix === "string" && r.sendPrefix) q.sendPrefix = r.sendPrefix;
    if (r.isRecoveryRetry === true) q.isRecoveryRetry = true;
    out.push(q);
  }
  return out;
}

/** Stop / non-recoverable error: pause every queued message, in place, so a
 *  pill open in the editor keeps its edit. */
export function holdQueue(queue: readonly QueuedMessage[]): void {
  for (const q of queue) q.held = true;
}

/** Index of the next message the turn-end drain may run, or -1. */
export function nextRunnable(queue: readonly QueuedMessage[]): number {
  return queue.findIndex((q) => !q.held && !q.editing);
}

/** True when the user still has a message waiting to run, queued or being
 *  edited. Held messages do not count: they run only on Run. */
export function hasPending(queue: readonly QueuedMessage[]): boolean {
  return queue.some((q) => !q.held);
}

/** Remove and return the item at `i` (undefined when out of range). */
export function takeAt(queue: QueuedMessage[], i: number): QueuedMessage | undefined {
  if (i < 0 || i >= queue.length) return undefined;
  return queue.splice(i, 1)[0];
}

/** A message can be injected into the live turn only as plain text: steer
 *  carries no images (both providers refuse them), no hidden prefix, no agent,
 *  no research run, and no context beyond what the turn already carries, so a
 *  message with any of those waits for its own turn. Never outside a turn, in
 *  Research Mode, held, or open in the editor. */
export function canSteer(
  q: QueuedMessage,
  opts: { streaming: boolean; researchOn: boolean; hasSteer: boolean; turnContext?: QueuedContext }
): boolean {
  const plain = !q.images?.length && !q.sendPrefix && !q.isRecoveryRetry && !q.agent && !q.researchMode;
  return opts.streaming && opts.hasSteer && !opts.researchOn && plain && contextSent(q.context, opts.turnContext) && !q.held && !q.editing;
}

/** Whether the running turn already carries everything `ctx` would add: a steer
 *  sends only text, so a note or selection the turn never saw would be lost. */
function contextSent(ctx: QueuedContext | undefined, turn: QueuedContext | undefined): boolean {
  if (!ctx) return true;
  const sel = ctx.selection;
  if (sel && (sel.path !== turn?.selection?.path || sel.text !== turn.selection.text)) return false;
  return ctx.paths.every((p) => turn?.paths.includes(p));
}
