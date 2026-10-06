/**
 * Delegation rules from T3 Code's orchestration v2 (`delegate_task`,
 * `task_status`, `task_cancel`, `thread_send`), on top of Exo's own child tasks
 * (core/child-tasks.ts) and child reports (core/child-reports.ts). Pure: the
 * Obsidian side lives in ui/delegation.ts.
 */
import { chatLines, type ChatMessage } from "./recent-chats";
import type { TaskEntry } from "./tasks";

/** How a message reaches another chat. `auto`: send now if the chat is idle,
 *  else run it right after the current turn. `queue`: always after the current
 *  turn. `steer`: fold it into the running turn when the provider can, else
 *  queue. */
export type SendMode = "auto" | "queue" | "steer";
export type SendOutcome = "sent" | "queued" | "steered";

/** Pure choice of what a send does, given the target chat's state. */
export function planSend(mode: SendMode, streaming: boolean, canSteer: boolean, claimed = false): SendOutcome {
  // A claimed turn still in its preamble (recall, vault reads) is not
  // streaming yet, but a second runTurn would be declined and the message lost.
  // It cannot be steered either: there is no live turn to fold into.
  if (claimed && !streaming) return "queued";
  if (!streaming) return "sent";
  return mode === "steer" && canSteer ? "steered" : "queued";
}

/** The message that wakes a parent when a delegated task reports back. The
 *  reports themselves ride the same turn (drainReportsForParent). */
export const WAKE_TEXT = "A delegated task reported back. Continue with its result.";

/** Should a report start (or queue) a parent turn?
 *  - Not for a "stopped" child: a stop usually came from the user (often via
 *    the parent's own Stop), and restarting the parent over it would undo the
 *    stop. That report rides the parent's next turn instead.
 *  - Not when the user stopped the parent and has not spoken since.
 *  - Not for a parent that was closed or archived: a turn nobody can see.
 *  - Not twice: one wake carries every report waiting at that point. */
export function shouldWakeParent(
  p: { stopped: boolean; archived?: boolean; queue: readonly { text: string }[] },
  outcome: string,
  open: boolean,
): boolean {
  if (outcome === "stopped" || p.stopped || p.archived || !open) return false;
  return !p.queue.some((q) => q.text === WAKE_TEXT);
}

/** A child task the asking chat owns, or a refusal it can read. */
export function ownedTask(tasks: readonly TaskEntry[], taskId: string, parentConvoId: string): TaskEntry | string {
  const t = tasks.find((x) => x.id === taskId);
  if (!t) return `No task ${taskId}.`;
  if (t.parent !== parentConvoId) return `Task ${taskId} was not delegated by this chat.`;
  return t;
}

/** Tasks a stopped parent takes down with it: not yet finished, its own. */
export function openChildTasks(tasks: readonly TaskEntry[], parentConvoId: string): TaskEntry[] {
  return tasks.filter(
    (t) => t.parent === parentConvoId && (t.status === "backlog" || t.status === "queued" || t.status === "running" || t.status === "needs-input"),
  );
}

/** `task_status` text. */
export function formatTaskStatus(
  t: TaskEntry,
  live: { exists: boolean; streaming: boolean; hasPending: boolean },
  lastAnswer: string,
): string {
  const state = live.streaming ? (live.hasPending ? "waiting for the user's approval" : "working") : t.status;
  const lines = [`${t.id} · ${t.title}`, `status: ${state}`];
  if (t.convo) lines.push(`chat: ${t.convo}${live.exists ? "" : " (closed)"}`);
  if (lastAnswer.trim()) lines.push(`last answer:\n${lastAnswer.trim()}`);
  return lines.join("\n");
}

/** `read_chat` text: the chat's conversation, newest kept when it is long. */
export function formatChatTranscript(chat: { id: string; title: string; messages: readonly ChatMessage[] }, maxChars: number): string {
  const lines = chatLines(chat.messages)
    .filter((l) => l.text.trim())
    .map((l) => `${l.role === "user" ? "USER" : "ASSISTANT"}: ${l.text.trim()}`);
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (used + lines[i].length > maxChars) break;
    kept.unshift(lines[i]);
    used += lines[i].length;
  }
  const head = `${chat.title || "Untitled chat"} (id ${chat.id})`;
  const cut = kept.length < lines.length ? ["[Earlier messages omitted]"] : [];
  return [head, ...cut, ...kept].join("\n\n");
}
