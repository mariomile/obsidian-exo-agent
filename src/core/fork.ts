/**
 * Fork a chat from one of its messages, as T3 Code forks a thread "up to" a
 * message (orchestration-v2 `forkUpToMessageId`): the new chat holds the
 * history up to and including that message, and the original is untouched.
 *
 * Copies, never shares: a fork that kept references to the original's
 * segments would change when the original re-renders or rewinds. The turn
 * checkpoints stay behind, because their undo belongs to the chat that made
 * the edits.
 */
import type { Message } from "./model";

/** History of a fork made at message `upTo` (inclusive). Out of range takes
 *  the whole chat. */
export function forkMessages(messages: readonly Message[], upTo?: number): Message[] {
  const end = upTo === undefined || upTo < 0 || upTo >= messages.length ? messages.length : upTo + 1;
  return messages
    .slice(0, end)
    .map((m) => (m.role === "assistant" ? { role: "assistant", segments: [...m.segments] } : { ...m }));
}
