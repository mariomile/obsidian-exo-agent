/**
 * Mutations the chats sidebar performs on conversations, as free functions over
 * a `ChatView`. They live here rather than on the class for the same reason
 * `gallery-cards.ts` does: `view.ts` is at its size ceiling, and a sidebar
 * action is not chat-transcript behaviour.
 *
 * Titles are the reason most of this exists. A conversation's title is set once
 * from a 40-character slice of the first user message, and refined by a
 * generated one — but only twice, and only while a turn is landing. A chat that
 * missed both windows has no path back to a good title, which is how a history
 * list ends up two thirds unreadable. These give it one.
 */
import { FileSystemAdapter, Notice } from "obsidian";
import type { ChatView } from "../view";
import type ExoPlugin from "../main";
import type { Convo } from "./convo-types";
import { looksAutoTitled } from "../core/title-ownership";
import { canSettle, type SettleSource } from "../core/settle-note";
import { canSettleThread, canSnooze, lifecycleWrites, type LifecycleFields } from "../core/thread-lifecycle";
import { adaptAppToSettleVault, settleConversationToNote } from "../obsidian/settle-note";
import { ADAPTERS } from "../providers/registry";

/** Same active fallback the other convo mutations use — the active conversation
 *  is not always in `convos` (several paths push it lazily). */
function find(view: ChatView, id: string): Convo | undefined {
  return view.allConvos().find((c) => c.id === id);
}

/**
 * Pin or unpin. Pinning is what the tab strip already means by `pinned`, so the
 * sidebar deliberately toggles the same flag rather than inventing a parallel
 * one: a chat pinned from either surface is pinned in both.
 */
export function setConvoPinned(view: ChatView, id: string, pinned: boolean): boolean {
  const c = find(view, id);
  if (!c) return false;
  if (c.pinned !== pinned) view.togglePin(c);
  return true;
}

/** The lifecycle verbs of the chats sidebar (core/thread-lifecycle). */
export type LifecycleVerb =
  | { verb: "snooze"; until: number }
  | { verb: "unsnooze" }
  | { verb: "settle" }
  | { verb: "unsettle" };

/**
 * Snooze, settle, or take a chat back out. Refused where T3 refuses: nothing
 * is snoozed or settled while it waits on the user, and nothing is settled
 * while a turn runs. The field writes come from `lifecycleWrites`, so the
 * rules live in one pure place.
 */
export function applyLifecycle(view: ChatView, id: string, v: LifecycleVerb): boolean {
  const c = find(view, id);
  if (!c) return false;
  const live = { streaming: c.streaming, pendingPerm: c.pendingPerm != null, pendingAsk: c.pendingAsk != null };
  const now = Date.now();
  let writes: LifecycleFields;
  if (v.verb === "snooze") {
    if (!canSnooze(live)) return false;
    writes = lifecycleWrites.snooze(v.until, now);
  } else if (v.verb === "settle") {
    if (!canSettleThread(live)) return false;
    writes = lifecycleWrites.settle(now);
  } else {
    writes = v.verb === "unsettle" ? lifecycleWrites.unsettle(now) : lifecycleWrites.unsnooze();
  }
  Object.assign(c, writes);
  view.persist();
  return true;
}

/**
 * Settle a conversation's open permission prompt without opening its
 * transcript — the chats sidebar's inline Allow / Deny. The handle it calls is
 * the card's own `settle`, so the card resolves, stamps its verdict and clears
 * the pending state exactly as if the user had clicked it there.
 *
 * False when there is nothing to settle: the prompt was already answered, or
 * the chat is blocked on a question or a plan, neither of which is a one-line
 * yes/no. The caller says so rather than leaving a dead button on screen.
 */
export function decidePermission(view: ChatView, id: string, verdict: "allow" | "deny"): boolean {
  const decision = find(view, id)?.pendingDecision;
  if (!decision) return false;
  if (verdict === "allow") decision.allow();
  else decision.deny();
  return true;
}

/**
 * Mirror a settled conversation into its vault note, and return the path (null
 * when there is nothing to write). MANUAL only: this has exactly two callers,
 * the sidebar's row menu and the palette command — nothing on the turn path
 * reaches it, so no chat is ever settled behind the user's back.
 *
 * The gate is re-checked here rather than trusted from the caller: a row menu
 * is painted from a snapshot that can be seconds old, and a chat that started
 * running in the meantime must not be frozen into a note that claims an
 * outcome it does not have yet.
 */
export async function settleToNote(
  view: ChatView,
  plugin: ExoPlugin,
  id: string,
): Promise<string | null> {
  const c = find(view, id);
  if (!c) return null;
  const gate = {
    streaming: c.streaming,
    pendingPerm: c.pendingPerm != null,
    pendingAsk: c.pendingAsk != null,
    hasMessages: c.messages.length > 0,
  };
  if (!canSettle(gate)) return null;
  // Built-in Write/Edit report absolute paths; the note's links have to be
  // vault-relative or they resolve to nothing. Same rule as `ChatView.relPath`.
  const adapter = plugin.app.vault.adapter;
  const base = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
  const rel = (p: string): string =>
    base && base !== "." && p.startsWith(`${base}/`) ? p.slice(base.length + 1) : p;
  const src: SettleSource = {
    id: c.id,
    title: c.title,
    provider: ADAPTERS[c.provider].displayName,
    model: c.model,
    ...(c.agent ? { agent: c.agent } : {}),
    stopped: c.stopped,
    poisoned: !!c.resumeRisky,
    messages: c.messages,
  };
  return settleConversationToNote(adaptAppToSettleVault(plugin.app), plugin.paths, src, rel);
}

/** The last complete exchange, in the shape `generateTitle` wants. Returns null
 *  when the conversation has no assistant reply yet — there is nothing to title
 *  from, and asking a model to name a monologue produces a paraphrase. */
function lastExchange(c: Convo): { userText: string; assistantText: string } | null {
  const msgs = c.messages;
  let assistantText = "";
  let i = msgs.length - 1;
  for (; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "assistant") continue;
    assistantText = (m.segments ?? [])
      .filter((s) => s.t === "text")
      .map((s) => s.md ?? "")
      .join(" ")
      .trim();
    if (assistantText) break;
  }
  if (!assistantText) return null;
  for (let j = i - 1; j >= 0; j--) {
    const m = msgs[j];
    if (m.role === "user" && (m.text ?? "").trim()) {
      return { userText: (m.text ?? "").trim(), assistantText };
    }
  }
  return null;
}

/**
 * Regenerate one conversation's title from its last exchange. Does NOT set
 * `titleLocked`: the user asked for a better generated title, not to take
 * ownership of it, so a later automatic refinement is still allowed. Sets
 * `aiTitleApplied` so the turn-driven path does not immediately spend an
 * attempt redoing what just happened.
 */
export async function retitleConversation(
  view: ChatView,
  plugin: ExoPlugin,
  id: string,
): Promise<boolean> {
  const c = find(view, id);
  if (!c) return false;
  const ex = lastExchange(c);
  if (!ex) return false;
  const ctrl = new AbortController();
  c.titleAbort?.abort();
  c.titleAbort = ctrl;
  const title = await plugin.generateTitle(ex.userText, ex.assistantText, ctrl.signal);
  if (!title || ctrl.signal.aborted) return false;
  // Re-find: the conversation can be deleted while a 90s cold spawn is in
  // flight, and writing to a detached object would silently lose the title.
  const still = find(view, id);
  if (!still) return false;
  still.title = title;
  still.aiTitleApplied = true;
  view.renderTabs();
  view.persist();
  return true;
}

/** Conversations a sweep should touch: still auto-titled, not user-owned, and
 *  with an exchange to title from. */
export function retitleCandidates(view: ChatView): Convo[] {
  return view
    .allConvos()
    .filter((c) => !c.titleLocked && looksAutoTitled(c.title) && lastExchange(c) !== null);
}

/**
 * Retitle every candidate, one at a time. Sequential on purpose: each call cold
 * spawns a CLI session, which is the dominant cost, and running twenty in
 * parallel would contend for the same machine rather than finish sooner.
 * Reports progress through a single Notice that is rewritten in place.
 */
export async function backfillTitles(view: ChatView, plugin: ExoPlugin): Promise<void> {
  const targets = retitleCandidates(view);
  if (targets.length === 0) {
    new Notice("Every chat already has a real title.");
    return;
  }
  const notice = new Notice(`Retitling 0/${targets.length}…`, 0);
  let done = 0;
  let failed = 0;
  for (const [i, c] of targets.entries()) {
    notice.setMessage(`Retitling ${i + 1}/${targets.length}…`);
    // One failure is a slow cold spawn, not a reason to abandon the rest.
    if (await retitleConversation(view, plugin, c.id)) done++;
    else failed++;
  }
  notice.hide();
  new Notice(
    failed === 0
      ? `Retitled ${done} chat${done === 1 ? "" : "s"}.`
      : `Retitled ${done}, ${failed} failed. Run it again to retry those.`,
  );
}
