import { Notice, type App } from "obsidian";
import { ChatView, VIEW_TYPE } from "../view";
import type ExoPlugin from "../main";
import type { ChatRowSource } from "../core/chat-rows";
import * as actions from "./chat-actions";
import type { HarvestSource } from "../obsidian/memory-harvest";
import type { ChatRecord } from "../core/recent-chats";

/** The mounted ChatView, or null when none is — including when the leaf exists
 *  but is still a deferred placeholder, on which `instanceof` is false. */
export function chatView(app: App): ChatView | null {
  const leaf = app.workspace.getLeavesOfType(VIEW_TYPE)[0];
  if (!leaf) return null;
  if (leaf.view instanceof ChatView) return leaf.view;
  // The leaf exists but Obsidian has not materialised it yet (a restored tab
  // that was never activated, or any tab right after a plugin reload). Ask for
  // it and report null for now: the caller's next tick finds it. Without this
  // the chats sidebar sits on "Open Exo to see your chats" while a fully
  // populated conversation store is one deferred view away.
  void (leaf as unknown as { loadIfDeferred?: () => Promise<void> }).loadIfDeferred?.();
  return null;
}

/**
 * Every conversation, for the chats sidebar. Returns `null` — not `[]` — when
 * no ChatView is mounted. An empty array would render "no conversations", which
 * is a lie about data that exists; `null` lets the sidebar say "open Exo".
 */
export function listChatRows(app: App): ChatRowSource[] | null {
  return chatView(app)?.listChatRows() ?? null;
}

export function renameConversation(app: App, convoId: string, title: string): boolean {
  return chatView(app)?.renameConversation(convoId, title) ?? false;
}

export function deleteConversation(app: App, convoId: string): boolean {
  return chatView(app)?.deleteConversation(convoId) ?? false;
}

export function setConvoPinned(app: App, convoId: string, pinned: boolean): boolean {
  const view = chatView(app);
  return view ? actions.setConvoPinned(view, convoId, pinned) : false;
}

/** Snooze until `until`, or wake now with `null`. False when the chat is
 *  blocked on the user, unknown, or Exo is not mounted. */
export function setConvoSnoozed(app: App, convoId: string, until: number | null): boolean {
  const view = chatView(app);
  return view ? actions.setConvoSnoozed(view, convoId, until) : false;
}

/** Answer a conversation's open permission prompt from the chats sidebar. This
 *  is the ONLY route the pane has to a verdict: it never holds a `ChatView`. */
export function decidePermission(app: App, convoId: string, verdict: "allow" | "deny"): boolean {
  const view = chatView(app);
  return view ? actions.decidePermission(view, convoId, verdict) : false;
}

/** Which conversation the user is standing in, or null when Exo is not mounted.
 *  The anchor the "next chat needing you" cycle counts from. */
export function activeConvoId(app: App): string | null {
  return chatView(app)?.active?.id ?? null;
}

/**
 * Mirror a settled conversation into a vault note; resolves to the note's path,
 * or null when nothing was written (no ChatView mounted, unknown id, or the
 * chat is running/blocked/empty — the settled-only gate). The caller reports
 * the outcome: the pane cannot tell those cases apart, and neither can this.
 */
export async function settleToNote(plugin: ExoPlugin, convoId: string): Promise<string | null> {
  const view = chatView(plugin.app);
  return view ? actions.settleToNote(view, plugin, convoId) : null;
}

export async function retitleConversation(plugin: ExoPlugin, convoId: string): Promise<boolean> {
  const view = chatView(plugin.app);
  return view ? actions.retitleConversation(view, plugin, convoId) : false;
}

/** Sweep every still-auto-titled conversation. Surfaces its own progress and
 *  outcome through Notices, so callers do not need a result. */
export async function backfillTitles(plugin: ExoPlugin): Promise<void> {
  const view = chatView(plugin.app);
  if (!view) {
    new Notice("Open Exo first — retitling reads the conversation store.");
    return;
  }
  await actions.backfillTitles(view, plugin);
}

/** The chat view as the memory harvest's conversation store: every
 *  conversation with its watermark, and a setter that persists a new one.
 *  Null while no view is mounted (the lookup also materialises a deferred one,
 *  so the next heartbeat finds it). */
export function harvestSource(app: App): HarvestSource | null {
  const view = chatView(app);
  if (!view) return null;
  return {
    chats: () =>
      view.allConvos().map((c) => {
        let lastAt = c.updatedAt ?? 0;
        for (const m of c.messages) if (m.role === "user" && typeof m.at === "number") lastAt = Math.max(lastAt, m.at);
        return {
          id: c.id,
          title: c.title,
          messages: c.messages,
          harvestedIndex: c.harvestedIndex,
          streaming: c.streaming,
          lastActivityAt: lastAt,
        };
      }),
    markHarvested: (id, index) => {
      const c = view.allConvos().find((x) => x.id === id);
      if (!c) return;
      c.harvestedIndex = index;
      view.persist();
    },
  };
}

/** Every conversation (current + archive) for read-only consumers
 *  (`recent_chats`): the mounted view's live state when there is one, else the
 *  two stores on disk. */
export async function readConversationStore(plugin: ExoPlugin): Promise<ChatRecord[]> {
  const view = chatView(plugin.app);
  if (view) {
    return view.allConvos().map((c) => ({
      id: c.id,
      title: c.title,
      updatedAt: c.updatedAt,
      archived: c.archived,
      messages: c.messages,
    }));
  }
  const [live, archived] = await Promise.all([plugin.loadConversations(), plugin.loadArchivedConversations()]);
  return [...live, ...archived].filter(
    (d): d is ChatRecord => !!d && typeof d === "object" && Array.isArray((d as ChatRecord).messages),
  );
}
