/**
 * CLI-currency maintenance for the Claude CLI: the daily update check, the
 * "update available" offer, the one-click update, and the background auto-heal
 * pass. Extracted from main.ts as free functions over the plugin — CLI drift (a
 * stale binary throws error_during_execution and poisons the session) is the
 * recurring root cause of Exo "not working", so keeping the CLI current earns
 * its own module.
 */
import { Notice, requestUrl } from "obsidian";
import type ExoPlugin from "./main";
import { resolveCli, cliDiagnostics, updateClaudeCli, claudeInstallChannel } from "./cli";
import { compareSemver } from "./core/semver";

const DAY = 24 * 60 * 60 * 1000;

/** One-click Claude-CLI update, shared by the palette command, the settings
 *  button, and the boot notice. Resolves the CLI and updates via the
 *  channel-correct updater (native `claude update` or npm i -g, 3-min cap), then
 *  reports the version delta. New sessions pick the new binary up automatically
 *  (the resolve caches are cleared on success, so the post-update probe
 *  re-resolves it). */
export async function runCliUpdate(plugin: ExoPlugin): Promise<void> {
  plugin.diag.push("cli", "one-click update started");
  new Notice("Exo — updating Claude CLI…");
  const cli = await resolveCli("claude", plugin.settings.claudeBin);
  const before = (await cliDiagnostics("claude", plugin.settings.claudeBin)).version;
  const { ok, output } = await updateClaudeCli(cli);
  if (ok) {
    const after = (await cliDiagnostics("claude", plugin.settings.claudeBin)).version; // caches cleared → fresh
    plugin.diag.push("cli", `one-click update ok ${before ?? "?"} → ${after ?? "?"}`);
    new Notice(
      before && after && before !== after
        ? `Exo — Claude CLI updated ${before} → ${after}. New sessions use it automatically.`
        : "Exo — Claude CLI is already up to date.",
      8000
    );
  } else {
    const tail = output.split("\n").filter(Boolean).slice(-4).join("\n");
    plugin.diag.push("cli", "one-click update FAILED");
    new Notice(`Exo — CLI update failed:\n${tail || "unknown error"}`, 10000);
  }
}

/** Keep the Claude CLI current without the user having to think about it — CLI
 *  drift is the recurring root cause of Exo "not working" (a stale binary throws
 *  error_during_execution and poisons the session). Runs at startup and on a
 *  daily interval; throttled to once/day via `cliUpdateCheckAt`. Skips while any
 *  turn is streaming (never swap the binary mid-turn). Native installs self-heal
 *  via `claude update` and notice only on an actual version change; npm installs
 *  (or auto-update disabled) fall back to the non-intrusive registry check +
 *  "update available" offer. Best-effort; never throws. */
export async function maybeAutoUpdateCli(plugin: ExoPlugin, force = false): Promise<void> {
  try {
    if (plugin.unloaded) return;
    const now = Date.now();
    if (!force && plugin.settings.cliUpdateCheckAt && now - plugin.settings.cliUpdateCheckAt < DAY) return;
    if (plugin.listChatRows()?.some((r) => r.streaming)) return; // never mid-turn

    const cli = await resolveCli("claude", plugin.settings.claudeBin);
    const channel = claudeInstallChannel(cli.bin);

    if (channel === "npm" || !plugin.settings.autoUpdateCli) {
      // npm channel, or auto-update off: keep the passive registry offer. That
      // path owns its own `cliUpdateCheckAt` write, so don't double-stamp here.
      await maybeCheckCliUpdate(plugin, force);
      await maybeOfferCliUpdate(plugin);
      return;
    }

    // Native channel + auto-update on: self-heal in place.
    const before = (await cliDiagnostics("claude", plugin.settings.claudeBin)).version;
    const { ok } = await updateClaudeCli(cli);
    plugin.settings.cliUpdateCheckAt = now;
    await plugin.saveSettings();
    if (!ok) {
      plugin.diag.push("cli", "auto-update failed (silent)");
      return; // a failed background update never nags
    }
    const after = (await cliDiagnostics("claude", plugin.settings.claudeBin)).version; // caches cleared → fresh
    if (before && after && before !== after) {
      plugin.diag.push("cli", `auto-updated ${before} → ${after}`);
      new Notice(`Exo — Claude CLI updated ${before} → ${after}. New sessions use it automatically.`, 8000);
    }
  } catch {
    /* best-effort — never block or noise the boot */
  }
}

/** If the daily check found a newer published CLI, surface a persistent notice
 *  with an Update button — once per published version (localStorage marker), so
 *  the user never has to dig into Settings to stay current. */
async function maybeOfferCliUpdate(plugin: ExoPlugin): Promise<void> {
  try {
    const latest = plugin.settings.cliLatestKnown;
    if (!latest) return;
    const d = await cliDiagnostics("claude", plugin.settings.claudeBin); // cached — shared with checkCliVerified
    if (!d.version || compareSemver(d.version, latest) >= 0) return; // unknown or already current
    const KEY = "exo-cli-update-offered";
    if (plugin.app.loadLocalStorage(KEY) === latest) return; // offered once already
    plugin.app.saveLocalStorage(KEY, latest);
    plugin.diag.push("cli", `update available ${d.version} → ${latest}`);
    const frag = createFragment();
    const span = createSpan();
    span.textContent = `Exo — Claude CLI ${latest} available (installed ${d.version}). `;
    const btn = createEl("button");
    btn.textContent = "Update now";
    frag.append(span, btn);
    const n = new Notice(frag, 0); // sticky until clicked/dismissed
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = "Updating…";
      await runCliUpdate(plugin);
      n.hide();
    };
  } catch {
    /* best-effort — never noise the boot */
  }
}

/** Check npm for a newer Claude CLI, at most once per day. Caches the result in
 *  settings (`cliLatestKnown` + `cliUpdateCheckAt`) so the settings tab can show
 *  an update button without a network round-trip on every render. Uses
 *  Obsidian's `requestUrl` (not node fetch — desktop CSP/proxy safe). Never
 *  throws; a failed check just records the attempt so we don't hammer the API. */
export async function maybeCheckCliUpdate(plugin: ExoPlugin, force = false): Promise<void> {
  const now = Date.now();
  if (!force && plugin.settings.cliUpdateCheckAt && now - plugin.settings.cliUpdateCheckAt < DAY) return;
  try {
    const res = await requestUrl({
      url: "https://registry.npmjs.org/@anthropic-ai/claude-code/latest",
    });
    const version = (res.json as { version?: unknown } | undefined)?.version;
    if (typeof version === "string" && version) plugin.settings.cliLatestKnown = version;
  } catch {
    /* offline / registry down — silent */
  } finally {
    plugin.settings.cliUpdateCheckAt = now;
    await plugin.saveSettings();
  }
}
