/**
 * The per-chat message queue (pure). Messages typed while a turn runs wait here
 * and start as the next turn. Two rules keep queued work from being lost:
 *
 * - Stop and a broken session HOLD the user's queued messages instead of
 *   clearing them. A held message stays on screen and runs only when the user
 *   asks for it; Exo-generated items (`auto`) are dropped, they belonged to the
 *   turn that was stopped.
 * - The context a message was written against (attached notes, selection) is
 *   frozen when it is queued, so it reaches the model even if the user switches
 *   chat or note before the turn starts.
 */

import type { ImageAttachment } from "../providers/types";
import type { ContextSelection } from "./context-assembly";
import type { ResearchModeState } from "./research";

/** Composer context captured at enqueue time. */
export interface QueuedContext {
  paths: string[];
  selection: ContextSelection | null;
}

export interface QueuedMessage {
  text: string;
  images?: ImageAttachment[];
  sendPrefix?: string;
  isRecoveryRetry?: boolean;
  researchMode?: ResearchModeState;
  /** Agent slug bound to this queued message (`@agent` picked before send). */
  agent?: string;
  /** Written by Exo, not the user (core/model.ts `Message.auto`). */
  auto?: true;
  /** Context frozen at enqueue; absent = read the composer when the turn runs. */
  context?: QueuedContext;
  /** Kept after a Stop or a failed turn: never drained, runs only on request. */
  held?: true;
  /** Open in the pill editor: never drained or steered until the edit is saved. */
  editing?: true;
}

/** Stop / non-recoverable error: drop Exo's own items, hold the user's. The
 *  kept items are the same objects, so a pill open in the editor keeps its edit. */
export function holdQueue(queue: readonly QueuedMessage[]): QueuedMessage[] {
  const kept = queue.filter((q) => !q.auto);
  for (const q of kept) q.held = true;
  return kept;
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

/** Turn options a queued message carries into `runTurn`, or undefined when it
 *  carries none (a plain follow-up). */
export function turnOptsFor(q: QueuedMessage):
  | Pick<QueuedMessage, "sendPrefix" | "isRecoveryRetry" | "researchMode" | "agent" | "auto" | "context">
  | undefined {
  if (!q.isRecoveryRetry && !q.sendPrefix && !q.researchMode && !q.agent && !q.auto && !q.context) return undefined;
  return {
    sendPrefix: q.sendPrefix,
    isRecoveryRetry: q.isRecoveryRetry,
    researchMode: q.researchMode,
    agent: q.agent,
    auto: q.auto,
    context: q.context,
  };
}

/** A queued message can be injected into the live turn only without images
 *  (both providers refuse steer with attachments), outside Research Mode, and
 *  never while held (it belongs to no turn) or open in the editor. */
export function canSteer(q: QueuedMessage, opts: { streaming: boolean; researchOn: boolean; hasSteer: boolean }): boolean {
  return opts.streaming && opts.hasSteer && !opts.researchOn && !q.images?.length && !q.isRecoveryRetry && !q.held && !q.editing;
}
