/**
 * "Models in the composer" settings section: one toggle per model, per
 * provider, deciding which models the composer's model picker lists. Lives
 * outside settings.ts, which sits at its size ceiling.
 */
import { Setting } from "obsidian";
import type ExoPlugin from "../main";
import type { ProviderId } from "../providers/types";
import { ADAPTERS } from "../providers/registry";
import { providerModels } from "../core/model-options";

/** Renders the section into its own container and returns a re-render hook,
 *  called when the custom-model textareas change the lists. */
export function renderComposerModels(plugin: ExoPlugin, el: HTMLElement): () => void {
  const box = el.createDiv();
  const render = () => {
    box.empty();
    const s = plugin.settings;
    new Setting(box)
      .setName("Models in the composer")
      .setDesc("Choose which models the composer's model picker lists. The model a chat is already using always stays selectable.")
      .setHeading();
    for (const provider of ["claude", "codex"] as ProviderId[]) {
      const key = provider === "claude" ? "claudeHiddenModels" : "codexHiddenModels";
      const options = providerModels(
        ADAPTERS[provider].models(),
        provider === "codex" ? plugin.lastSessionCaps?.models : undefined,
        provider === "claude" ? s.claudeCustomModels : s.codexCustomModels
      );
      for (const m of options) {
        new Setting(box)
          .setName(m.label)
          .setDesc(`${ADAPTERS[provider].displayName} · ${m.id}`)
          .addToggle((t) =>
            t.setValue(!s[key].includes(m.id)).onChange(async (show) => {
              s[key] = show ? s[key].filter((id) => id !== m.id) : [...s[key], m.id];
              await plugin.saveSettings();
            })
          );
      }
    }
  };
  render();
  return render;
}
