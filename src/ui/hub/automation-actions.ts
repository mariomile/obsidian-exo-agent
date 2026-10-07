/**
 * Automation management that needs more than the store: archiving also drops
 * the scheduler cursors the automation leaves in settings, duplicating picks a
 * free slug, and the two entry points (a blank form, a chat that writes it)
 * open the hub or the chat. Shared by the hub tab, the editor, the palette
 * commands and `manage_automation`, so every path does the same thing.
 */
import type ExoPlugin from "../../main";
import { automationRunKeysIn, duplicateAutomation, type Automation } from "../../core/automation-model";
import { editingState } from "./automation-editor";

/** Archive the file and forget its scheduler cursors. */
export async function archiveAutomation(plugin: ExoPlugin, slug: string): Promise<void> {
  await plugin.automationStore.archive(slug);
  const lastRun = plugin.settings.scheduledLastRun;
  const keys = automationRunKeysIn(lastRun, slug);
  for (const k of keys) delete lastRun[k];
  if (keys.length) await plugin.saveSettings();
}

/** Save a paused copy and return it. */
export async function duplicate(plugin: ExoPlugin, a: Automation): Promise<Automation> {
  const store = plugin.automationStore;
  const copy = duplicateAutomation(a, new Set(store.list().map((x) => x.slug)));
  await store.save(copy);
  return copy;
}

/** Open the hub on the editor: a blank form, or one automation. */
export async function openAutomationForm(plugin: ExoPlugin, slug: string | null = null): Promise<void> {
  editingState.active = true;
  editingState.slug = slug;
  await plugin.activateHub("automations");
  plugin.refreshHub();
}

/** The words-first path: a fresh chat with the request half-written, not
 *  sent, so Mario finishes the sentence and Exo builds it with
 *  `manage_automation`. */
export async function describeAutomationInChat(plugin: ExoPlugin): Promise<void> {
  await plugin.askExo(
    "Create an automation with manage_automation. Show me name, when, mode, scope and prompt before saving. What I want: ",
    false,
  );
}

export function registerAutomationCommands(plugin: ExoPlugin): void {
  plugin.addCommand({
    id: "new-automation",
    name: "New automation",
    callback: () => void openAutomationForm(plugin),
  });
  plugin.addCommand({
    id: "describe-automation",
    name: "New automation from a description",
    callback: () => void describeAutomationInChat(plugin),
  });
}
