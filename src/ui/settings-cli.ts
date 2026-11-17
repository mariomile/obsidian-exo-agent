/**
 * CLI diagnostics + one-click update row for the settings pane. Extracted from
 * settings.ts, which sits at its size ceiling: these two helpers only ever
 * touched `this.plugin`, so they lose nothing by becoming free functions.
 */
import { Notice, Setting } from "obsidian";
import type ExoPlugin from "../main";
import { cliDiagnostics, updateClaudeCli, resolveCli } from "../cli";
import { maybeCheckCliUpdate } from "../cli-maintenance";
import { compareSemver } from "../core/semver";
import { OPENCODE_MIN_VERSION } from "../providers/opencode-acp";

/** When the resolved Claude CLI is older than the latest known published
 *  version, offer a one-click `npm i -g …@latest` update (never auto-run). */
export function maybeRenderCliUpdate(
  plugin: ExoPlugin,
  containerEl: HTMLElement,
  currentVersion: string,
): void {
  const latest = plugin.settings.cliLatestKnown;
  if (!latest || compareSemver(currentVersion, latest) >= 0) return; // unknown or up to date
  const row = new Setting(containerEl)
    .setName(`Update available: ${latest}`)
    .setDesc("A newer Claude CLI has been published. Updating installs it via the CLI's own updater (native) or your global npm prefix (npm install).");
  row.addButton((b) =>
    b
      .setButtonText("Update")
      .setCta()
      .onClick(async () => {
        b.setButtonText("Updating…").setDisabled(true);
        new Notice("Updating Claude CLI…");
        const cli = await resolveCli("claude", plugin.settings.claudeBin);
        const { ok, output } = await updateClaudeCli(cli);
        if (ok) {
          new Notice(`Updated to ${latest} — restart sessions to pick it up.`);
          b.buttonEl.remove();
        } else {
          const tail = output.split("\n").filter(Boolean).slice(-4).join("\n");
          new Notice(`Claude CLI update failed:\n${tail || "unknown error"}`);
          b.setButtonText("Update").setDisabled(false);
        }
      })
  );
}

/** Resolve the configured CLI and print what it actually is, plus its version
 *  (async, never blocks render). Turns future binary-drift debugging into a
 *  5-second glance. */
export function renderCliDiagnostics(
  plugin: ExoPlugin,
  containerEl: HTMLElement,
  name: string,
  configured: string,
): void {
  const el = containerEl.createDiv({ cls: "setting-item-description mva-cli-diag" });
  el.setText("Resolving…");
  // Lazily run (or reuse) the daily update check for Claude, so the button
  // below can appear once both the resolved version and the latest are known.
  if (name === "claude") void maybeCheckCliUpdate(plugin);
  void cliDiagnostics(name, configured)
    .then((d) => {
      el.setText(
        d.found
          ? `Resolved: ${d.bin}${d.version ? ` — ${d.version}` : ""}`
          : "Not found — set the path explicitly"
      );
      if (name === "claude" && d.found && d.version) maybeRenderCliUpdate(plugin, containerEl, d.version);
      // opencode 1.x speaks a different protocol and config: say so up front.
      if (name === "opencode" && d.version && compareSemver(d.version.replace(/^v/, ""), OPENCODE_MIN_VERSION) < 0) {
        el.setText(`${el.getText()} — Exo needs opencode ${OPENCODE_MIN_VERSION} or newer: run \`opencode upgrade\`.`);
      }
    })
    .catch(() => el.setText("Not found — set the path explicitly"));

  // Auto-update toggle — CLI drift is the recurring cause of Exo "not working",
  // so keeping the binary current is on by default (native installs self-heal
  // daily via `claude update`, only while idle).
  if (name === "claude") {
    new Setting(containerEl)
      .setName("Keep Claude CLI up to date")
      .setDesc("Automatically update the CLI in the background (daily, never mid-turn). Prevents a stale binary from silently breaking sessions.")
      .addToggle((t) =>
        t.setValue(plugin.settings.autoUpdateCli).onChange(async (v) => {
          plugin.settings.autoUpdateCli = v;
          await plugin.saveSettings();
        })
      );
  }
}
