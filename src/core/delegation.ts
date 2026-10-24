/**
 * Delegation rules from T3 Code's `thread_send` and `thread_read`: how a message
 * reaches another chat and how a chat is read back. Pure: the Obsidian side
 * lives in ui/delegation.ts.
 */
import { chatLines, type ChatMessage } from "./recent-chats";

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

/**
 * Agent-to-agent sends without the user in between. A message that
 * send_to_chat delivers carries the sender's depth plus one; a message the user
 * types resets that chat to zero. Past the cap the send is refused, so two
 * chats cannot keep each other running, even under "Always allow".
 */
export const MAX_AGENT_HOPS = 3;

/** The depth the target would reach, or null when that exceeds the cap. */
export function nextHop(depths: ReadonlyMap<string, number>, from: string): number | null {
  const next = (depths.get(from) ?? 0) + 1;
  return next > MAX_AGENT_HOPS ? null : next;
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
