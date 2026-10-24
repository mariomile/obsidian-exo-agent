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
import type { ResearchModeState } from "./research";

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

/** A queued message can be injected into the live turn only as plain text:
 *  steer carries no images (both providers refuse them), no hidden prefix, no
 *  agent and no frozen context, so a message with any of those waits for its own
 *  turn. Never outside a turn, in Research Mode, held, or open in the editor. */
export function canSteer(q: QueuedMessage, opts: { streaming: boolean; researchOn: boolean; hasSteer: boolean }): boolean {
  const plain = !q.images?.length && !q.sendPrefix && !q.isRecoveryRetry && !q.agent && !q.context?.paths.length && !q.context?.selection;
  return opts.streaming && opts.hasSteer && !opts.researchOn && plain && !q.held && !q.editing;
}
