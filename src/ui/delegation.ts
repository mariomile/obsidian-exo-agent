/**
 * The chat side of delegation (core/delegation.ts): send into another chat.
 * Functions of the view rather than view methods, because `view.ts` is at its
 * size ceiling.
 */
import type { ChatView } from "../view";
import type ExoPlugin from "../main";
import type { Convo } from "./convo-types";
import { MAX_AGENT_HOPS, nextHop, planSend, type SendMode, type SendOutcome } from "../core/delegation";
import { chatView } from "./convo-bridge";
import { trySteer } from "./queue-view";

const byId = (view: ChatView, id: string): Convo | undefined => view.allConvos().find((c) => c.id === id);

/** Agent-to-agent hop depth per chat (core/delegation.ts `nextHop`). Runtime
 *  only: a restart is a fresh start, like a message from the user. */
const agentHops = new Map<string, number>();

/** The user wrote in this chat: whatever agents sent before no longer chains. */
export function resetAgentChain(id: string): void {
  agentHops.delete(id);
}

/** Send `text` into chat `id` as a user turn. Null when the chat is gone. */
export function sendToConvo(view: ChatView, id: string, text: string, mode: SendMode): SendOutcome | "stopping" | null {
  const c = byId(view, id);
  if (!c) return null;
  // Stopped while its turn was still preparing: that turn ends without
  // draining the queue, so a queued message would sit there unrun.
  if (c.stopped && c.turnClaimed && !c.streaming) return "stopping";
  const canSteer = !c.researchMode.enabled && !!c.session?.steer;
  let outcome = planSend(mode, c.streaming, canSteer, !!c.turnClaimed);
  if (outcome === "steered") {
    if (trySteer(view, c, { text })) return outcome;
    outcome = "queued";
  }
  if (outcome === "queued") {
    c.queue.push({ text });
    view.renderQueue(c);
    return outcome;
  }
  void view.runTurn(c, text);
  return outcome;
}

/* ---------------- agent tools (obsidian/chat-tools.ts) ---------------- */

const viewOf = (plugin: ExoPlugin): ChatView | null => chatView(plugin.app);

export function sendToChat(plugin: ExoPlugin, fromId: string, id: string, text: string, mode: SendMode): string {
  const view = viewOf(plugin);
  if (!view) return "Exo's chat view isn't open.";
  const hop = nextHop(agentHops, fromId);
  if (hop === null) return `Refused: ${MAX_AGENT_HOPS} agent-to-agent messages in a row without the user. Ask the user before sending more.`;
  const outcome = sendToConvo(view, id, text, mode);
  if (!outcome) return `No open chat ${id}.`;
  if (outcome === "stopping") return `Not sent: ${id} was just stopped. Try again in a moment.`;
  agentHops.set(id, hop);
  return outcome === "sent" ? `Sent to ${id}; it is running now.` : outcome === "steered" ? `Folded into ${id}'s running turn.` : `Queued in ${id}; it runs after the current turn.`;
}
