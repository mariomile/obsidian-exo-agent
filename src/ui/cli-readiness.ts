/**
 * CLI readiness row on top of the composer. When the chat view opens or the
 * active chat changes provider, probe that provider's CLI (the cached
 * `cliDiagnostics`, the same probe Settings shows). If it can't be found, say so
 * before the first message instead of after a failed turn. While the row is up,
 * focusing the composer probes again, so fixing the path in settings clears it.
 */

import { setIcon } from "obsidian";
import { cliDiagnostics } from "../cli";
import type { ProviderId } from "../providers/types";
import { PROFILES, providerStr } from "../providers/profiles";
import type { MVASettings } from "../settings-schema";
import { clickable } from "./dom";

const ROW = "mva-cli-missing";
const probeGen = new WeakMap<HTMLElement, number>(); // per view: the latest probe wins

export function showCliReadiness(
  composerEl: HTMLElement,
  provider: ProviderId,
  settings: MVASettings,
  openSettings: () => void
): void {
  const gen = (probeGen.get(composerEl) ?? 0) + 1;
  probeGen.set(composerEl, gen);
  const profile = PROFILES[provider];
  void cliDiagnostics(profile.cliName, providerStr(settings, provider, "bin"))
    .then((d) => d.found)
    .catch(() => false)
    .then((found) => {
      if (gen !== probeGen.get(composerEl)) return;
      composerEl.querySelector(`:scope > .${ROW}`)?.remove();
      if (found) return;
      const row = createDiv({ cls: ROW });
      setIcon(row.createSpan(), "triangle-alert");
      row.createSpan({ text: `${profile.label} CLI not found. Exo needs it to answer.` });
      const act = row.createSpan({ cls: "mva-cli-missing-act", text: "Open settings" });
      clickable(act, openSettings);
      composerEl.prepend(row);
      composerEl.addEventListener(
        "focusin",
        () => {
          if (gen === probeGen.get(composerEl)) showCliReadiness(composerEl, provider, settings, openSettings);
        },
        { once: true }
      );
    });
}
