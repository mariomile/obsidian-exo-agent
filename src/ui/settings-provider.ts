/**
 * One provider's rows in the General settings tab: default model, binary path
 * (with diagnostics) and custom model ids. Rendered once per provider from the
 * profile table, so a new provider gets its rows without touching settings.ts.
 */
import { FileSystemAdapter, Notice, Setting, type DropdownComponent } from "obsidian";
import type ExoPlugin from "../main";
import type { ProviderId } from "../providers/types";
import { ADAPTERS } from "../providers/registry";
import { PROFILES, providerStr } from "../providers/profiles";
import { providerModelList } from "../providers/model-lists";
import { listOpencodeModels } from "../providers/opencode";
import { resolveCli } from "../cli";
import { renderCliDiagnostics } from "./settings-cli";

export function renderProviderSettings(
  plugin: ExoPlugin,
  el: HTMLElement,
  provider: ProviderId,
  onModelsChanged: () => void
): void {
  const s = plugin.settings;
  const p = PROFILES[provider];
  const { label, cliName, keys } = p;

  // Options = the live catalog or built-ins + the custom ids below; editing the
  // textarea repopulates the dropdown live.
  // A provider with no pinned models (opencode) lists what its CLI can run now,
  // and "" means the CLI's own configured default.
  const live = ADAPTERS[provider].models().length === 0;
  let dd: DropdownComponent | undefined;
  const fill = (d: DropdownComponent) => {
    d.selectEl.empty();
    if (live) d.addOption("", `${label} default`);
    const cur = providerStr(s, provider, "model");
    const opts = providerModelList(s, provider, plugin.modelCatalogs);
    for (const o of opts) d.addOption(o.id, o.label);
    // Keep the current selection valid even if it isn't in the option list.
    if (cur && !opts.some((o) => o.id === cur)) d.addOption(cur, cur);
    d.setValue(cur);
  };

  const refresh = async () => {
    const vault = plugin.app.vault.adapter;
    const cwd = vault instanceof FileSystemAdapter ? vault.getBasePath() : "";
    const cli = await resolveCli(cliName, providerStr(s, provider, "bin"));
    const models = await listOpencodeModels(cli, cwd);
    if (models.length) plugin.modelCatalogs[provider] = models;
    if (dd) fill(dd);
    onModelsChanged();
    return models.length;
  };

  const row = new Setting(el)
    .setName(`Default ${label} model`)
    .setDesc(
      live
        ? `Which ${label} model new conversations start with. The list comes from your ${label} config (opencode.json) and the local model servers it finds (Ollama, LM Studio, vLLM). Empty = ${label}'s own default.`
        : `Which ${label} model new conversations start with — includes any custom ${label} models set below.`
    )
    .addDropdown((d) => {
      dd = d;
      fill(d);
      d.onChange(async (v) => {
        s[keys.model] = v;
        await plugin.saveSettings();
      });
    });
  if (live) {
    row.addExtraButton((b) =>
      b.setIcon("refresh-cw").setTooltip("Refresh models").onClick(async () => {
        const n = await refresh();
        new Notice(n ? `${label}: ${n} models available.` : `${label} listed no models — check that it is installed and configured.`);
      })
    );
    if (!plugin.modelCatalogs[provider]?.length) void refresh();
  }

  new Setting(el)
    .setName(`${label} binary path`)
    .setDesc(`Path to the \`${cliName}\` CLI. Leave empty to auto-detect; run \`which ${cliName}\` (\`where ${cliName}\` on Windows) if detection fails.`)
    .addText((t) =>
      t
        .setPlaceholder("auto-detect")
        .setValue(providerStr(s, provider, "bin"))
        .onChange(async (v) => {
          s[keys.bin] = v.trim();
          await plugin.saveSettings();
        })
    );
  renderCliDiagnostics(plugin, el, cliName, providerStr(s, provider, "bin"));

  new Setting(el)
    .setName(`Custom ${label} models`)
    .setDesc(`Extra ${label} model ids (comma- or newline-separated) added to the model picker and the default-model dropdown above.`)
    .addTextArea((t) =>
      t
        .setPlaceholder(p.customModelsExample)
        .setValue(providerStr(s, provider, "customModels"))
        .onChange(async (v) => {
          s[keys.customModels] = v;
          await plugin.saveSettings();
          if (dd) fill(dd);
          onModelsChanged();
        })
    );
}
