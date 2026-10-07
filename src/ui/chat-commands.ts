/**
 * The chats sidebar's palette commands, in one place — the same arrangement
 * `ui/view-registry.ts` gives the panes, and for the same reason: `main.ts` is
 * at its size ceiling and its next declared extraction is exactly this block,
 * so a new command lands here rather than growing the lifecycle file.
 *
 * The two ids that moved (`open-chat-list`, `retitle-chats`) are unchanged:
 * Obsidian stores hotkeys BY ID, so renaming one would silently drop whatever
 * the user had bound to it.
 */
import { Notice } from "obsidian";
import type ExoPlugin from "../main";
import { buildChatList, nextNeedsInput } from "../core/chat-rows";

export function registerChatCommands(plugin: ExoPlugin): void {
  plugin.addCommand({
    id: "open-chat-list",
    name: "Open chats",
    callback: () => void plugin.activateChats(),
  });
  // Search across chats (core/chat-search): opens the sidebar with the cursor
  // in its search field, which already looks inside what was said.
  plugin.addCommand({
    id: "search-chats",
    name: "Search chats",
    callback: () => void searchChatsCommand(plugin),
  });
  // Scheduled prompts (core/scheduled-prompts): in this chat by default. Loaded
  // on call, like `settleActive` below, to keep view.ts out of this module graph.
  plugin.addCommand({
    id: "schedule-prompt",
    name: "Schedule a prompt",
    callback: () => void import("./scheduled-ui").then((m) => new m.ScheduleModal(plugin.app, plugin, plugin.activeConvoId() ?? undefined).open()),
  });
  plugin.addCommand({
    id: "scheduled-prompts",
    name: "Show scheduled prompts",
    callback: () => void import("./scheduled-ui").then((m) => new m.ScheduledListModal(plugin.app, plugin).open()),
  });
  plugin.addCommand({
    id: "retitle-chat",
    name: "Retitle this chat",
    callback: () => {
      const id = plugin.activeConvoId();
      if (id) retitleWithNotice(plugin, id);
      else void plugin.activateView();
    },
  });
  plugin.addCommand({
    id: "retitle-chats",
    name: "Retitle auto-named chats",
    callback: () => void plugin.backfillTitles(),
  });
  // The idle-worker key: one press moves to the next conversation that cannot
  // continue without you. No default hotkey, like every other command this
  // plugin registers — it binds what the user chooses, never what we assumed.
  plugin.addCommand({
    id: "next-needs-you",
    name: "Go to the next chat that needs you",
    callback: () => goToNextNeedsYou(plugin),
  });
  // Settling is deliberately a command and a menu item, never a turn-end hook:
  // which conversations become vault notes is an editorial decision, and a
  // vault that grows a note per chat on its own is a vault nobody trusts.
  plugin.addCommand({
    id: "settle-chat-to-note",
    name: "Settle this chat to a note",
    callback: () => void settleActive(plugin),
  });
}

/** Mirror the conversation the user is standing in. The gate lives in
 *  `chat-actions.settleToNote`; a refusal comes back as null and is reported
 *  rather than swallowed.
 *
 *  A refusal and a FAILED WRITE are different answers and get different words.
 *  `vault.create`/`vault.modify` are unwrapped down there: "File already
 *  exists", ENAMETOOLONG, EACCES, a read-only vault. Left uncaught they became
 *  an unhandled rejection with no Notice at all — nothing written, nothing
 *  said, indistinguishable from a broken command. The row menu already reports
 *  this case; both entry points say the same thing.
 *
 *  The bridge is imported HERE, not at module scope: a static import would
 *  pull `view.ts` — and with it the whole Obsidian surface — into this file's
 *  module graph, which is exactly what keeps the command registrations
 *  loadable (and testable) on their own. */
async function settleActive(plugin: ExoPlugin): Promise<void> {
  const id = plugin.activeConvoId();
  if (!id) {
    void plugin.activateView();
    return;
  }
  try {
    const { settleToNote } = await import("./convo-bridge");
    const path = await settleToNote(plugin, id);
    new Notice(
      path ? `Settled to ${path}` : "Only a settled chat can become a note — let this turn finish.",
    );
  } catch {
    new Notice("Couldn't write the note.");
  }
}

/**
 * Cycle to the next blocked conversation, wrapping. The queue is the sidebar's
 * own needs-you strip — `buildChatList().blocked`, unfiltered and unsectioned —
 * so the key and the strip can never disagree about what is waiting.
 *
 * Says so out loud when nothing is waiting: a command that silently does
 * nothing is indistinguishable from one that is broken.
 */
function goToNextNeedsYou(plugin: ExoPlugin): void {
  const sources = plugin.listChatRows();
  // No ChatView mounted — there is no conversation to go to yet, so open Exo
  // rather than reporting an empty queue that only looks empty.
  if (!sources) {
    void plugin.activateView();
    return;
  }
  const { blocked } = buildChatList(sources, { query: "", now: Date.now() });
  const next = nextNeedsInput(blocked, plugin.activeConvoId());
  if (!next) {
    new Notice("Exo — nothing is waiting on you.");
    return;
  }
  void plugin.revealConversation(next);
}

async function searchChatsCommand(plugin: ExoPlugin): Promise<void> {
  await plugin.activateChats();
  for (const leaf of plugin.app.workspace.getLeavesOfType("exo-chats")) {
    const view = leaf.view as { focusSearch?: () => void };
    view.focusSearch?.();
  }
}

/** Regenerate one chat's title from the whole conversation, with the feedback
 *  every entry point owes the user: cold-spawning a CLI session takes seconds,
 *  and an action that appears to do nothing for ten seconds reads as broken.
 *  Shared by the command, the tab menu and the sidebar row menu. */
export function retitleWithNotice(plugin: ExoPlugin, id: string, after?: () => void): void {
  const pending = new Notice("Retitling…", 0);
  void plugin
    .retitleConversation(id)
    .then((ok) => {
      pending.hide();
      if (!ok) new Notice("Couldn't retitle: this chat has no complete exchange yet.");
      after?.();
    })
    .catch(() => {
      pending.hide();
      new Notice("Retitling failed.");
    });
}
