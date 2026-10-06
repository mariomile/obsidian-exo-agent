/**
 * The chat side of delegation (core/delegation.ts): send into another chat,
 * stop a chat and the children it delegated to, wake a parent when a child
 * reports back, and put a child's approval in front of the parent. Functions of
 * the view rather than view methods, because `view.ts` is at its size ceiling.
 */
import { setIcon } from "obsidian";
import type { ChatView } from "../view";
import type ExoPlugin from "../main";
import type { Convo } from "./convo-types";
import type { ConvoStateEvent } from "../core/convo-state";
import {
  formatTaskStatus,
  openChildTasks,
  ownedTask,
  planSend,
  shouldWakeParent,
  WAKE_TEXT,
  type SendMode,
  type SendOutcome,
} from "../core/delegation";
import { buildExcerpt } from "../core/child-reports";
import { chatView } from "./convo-bridge";

const byId = (view: ChatView, id: string): Convo | undefined => view.allConvos().find((c) => c.id === id);

/** Send `text` into chat `id` as a user turn. Null when the chat is gone. */
export function sendToConvo(view: ChatView, id: string, text: string, mode: SendMode): SendOutcome | null {
  const c = byId(view, id);
  if (!c) return null;
  const canSteer = !c.researchMode.enabled && !!c.session?.steer;
  let outcome = planSend(mode, c.streaming, canSteer, !!c.turnClaimed);
  if (outcome === "steered") {
    let steered = false;
    try {
      steered = c.session?.steer?.(view.hoistOutbound(text)) ?? false;
    } catch {
      steered = false;
    }
    if (steered) {
      view.addUserTurn(c, text);
      view.persist();
      return outcome;
    }
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

/** A stop reaches the whole tree: every child this chat delegated to that is
 *  still working, and every child task still waiting to start. Called from
 *  `stop()`, which recurses through it for grandchildren. */
export function stopChildren(view: ChatView, parent: Convo): void {
  for (const k of view.allConvos()) {
    if (k.parentConvoId === parent.id && (k.streaming || k.turnClaimed || k.queue.length) && !k.stopped) view.stop("button", k);
  }
  const orch = view.plugin.orchestration;
  for (const t of openChildTasks(orch.snapshot(), parent.id)) {
    if (t.status === "backlog" || t.status === "queued") void orch.archive(t.id);
  }
}

/** A child reported back: run the parent now, or right after its current turn.
 *  The report itself rides that turn (drainReportsForParent). */
export function wakeParent(view: ChatView, parent: Convo, outcome: string): void {
  if (!shouldWakeParent(parent, outcome, view.openTabs.includes(parent.id))) return;
  if (parent.streaming) {
    parent.queue.push({ text: WAKE_TEXT });
    view.renderQueue(parent);
  } else void view.runTurn(parent, WAKE_TEXT);
}

const blockCards = new Map<string, HTMLElement>();

/** The child's approval card in its parent goes when the child's prompt
 *  closes, wherever it was answered (setPendingCard calls this). */
export function clearChildBlock(childId: string): void {
  blockCards.get(childId)?.remove();
  blockCards.delete(childId);
}

/**
 * Convo-state listener: when a child stops on a permission or a question, the
 * parent's transcript gets a card naming the child, with Allow/Deny for a
 * permission and Open for either. The card goes away as soon as the child moves
 * on, whoever answered.
 */
export function surfaceChildBlock(view: ChatView, e: ConvoStateEvent): void {
  clearChildBlock(e.convoId);
  if (e.state !== "needs-input" || (e.reason !== "perm" && e.reason !== "ask")) return;
  const child = byId(view, e.convoId);
  const parent = child?.parentConvoId ? byId(view, child.parentConvoId) : undefined;
  if (!child || !parent) return;
  const card = parent.listEl.createDiv({ cls: "mva-perm" });
  const head = card.createDiv({ cls: "mva-perm-head" });
  setIcon(head.createDiv({ cls: "mva-perm-icon" }), e.reason === "perm" ? "shield-alert" : "message-circle-question");
  head.createSpan({
    cls: "mva-perm-title",
    text: `${child.title || "A delegated task"} ${e.reason === "perm" ? "asks for approval" : "has a question"}`,
  });
  const decision = e.reason === "perm" ? child.pendingDecision : null;
  if (decision?.rule) card.createDiv({ cls: "mva-perm-detail", text: decision.rule });
  const actions = card.createDiv({ cls: "mva-perm-actions" });
  if (decision) {
    actions.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Allow once" }).onclick = () => decision.allow();
    actions.createEl("button", { cls: "mva-btn", text: "Deny" }).onclick = () => decision.deny();
  }
  actions.createEl("button", { cls: "mva-btn", text: "Open" }).onclick = () => view.openConvoById(child.id);
  blockCards.set(child.id, card);
  parent.unread = parent !== view.active || parent.unread;
  view.persist();
}

/* ---------------- agent tools (obsidian/chat-tools.ts) ---------------- */

const viewOf = (plugin: ExoPlugin): ChatView | null => chatView(plugin.app);

export function taskStatus(plugin: ExoPlugin, parentId: string, taskId: string): string {
  const t = ownedTask(plugin.orchestration.snapshot(), taskId, parentId);
  if (typeof t === "string") return t;
  const view = viewOf(plugin);
  const live = t.convo && view ? view.readConvoState(t.convo) : { exists: false, streaming: false, hasPending: false };
  const last = t.convo && view ? buildExcerpt(view.lastAssistantTextOf(t.convo)) : "";
  return formatTaskStatus(t, live, last);
}

export async function cancelTask(plugin: ExoPlugin, parentId: string, taskId: string): Promise<string> {
  const t = ownedTask(plugin.orchestration.snapshot(), taskId, parentId);
  if (typeof t === "string") return t;
  const view = viewOf(plugin);
  const c = t.convo && view ? byId(view, t.convo) : undefined;
  if (view && c && (c.streaming || c.queue.length)) view.stop("button", c);
  await plugin.orchestration.archive(t.id);
  return `Cancelled ${t.id}: ${t.title}.`;
}

export function sendToChat(plugin: ExoPlugin, fromId: string, id: string, text: string, mode: SendMode): string {
  const view = viewOf(plugin);
  if (!view) return "Exo's chat view isn't open.";
  // A child talks to its parent through its report, never by sending: two
  // chats sending to each other would run turns with no human in the loop.
  if (byId(view, fromId)?.parentConvoId === id) return "That is the chat that delegated to you: your result reaches it when you finish.";
  const outcome = sendToConvo(view, id, text, mode);
  if (!outcome) return `No open chat ${id}.`;
  return outcome === "sent" ? `Sent to ${id}; it is running now.` : outcome === "steered" ? `Folded into ${id}'s running turn.` : `Queued in ${id}; it runs after the current turn.`;
}
