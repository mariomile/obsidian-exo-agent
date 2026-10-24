/**
 * CLI readiness row on top of the composer. When the chat view opens or the
 * active chat changes provider, probe that provider's CLI (the cached
 * `cliDiagnostics`, the same probe Settings shows). If it can't be found, say so
 * before the first message instead of after a failed turn.
 */

import { setIcon } from "obsidian";
import { cliDiagnostics } from "../cli";
import type { ProviderId } from "../providers/types";
import { clickable } from "./dom";

const ROW = "mva-cli-missing";
const probeGen = new WeakMap<HTMLElement, number>(); // per view: the latest probe wins

export function showCliReadiness(
  composerEl: HTMLElement,
  provider: ProviderId,
  bins: { claudeBin: string; codexBin: string },
  openSettings: () => void
): void {
  const gen = (probeGen.get(composerEl) ?? 0) + 1;
  probeGen.set(composerEl, gen);
  void cliDiagnostics(provider, provider === "codex" ? bins.codexBin : bins.claudeBin)
    .then((d) => d.found)
    .catch(() => false)
    .then((found) => {
      if (gen !== probeGen.get(composerEl)) return;
      composerEl.querySelector(`:scope > .${ROW}`)?.remove();
      if (found) return;
      const row = createDiv({ cls: ROW });
      setIcon(row.createSpan(), "triangle-alert");
      row.createSpan({ text: `${provider === "codex" ? "Codex" : "Claude"} CLI not found. Exo needs it to answer.` });
      const act = row.createSpan({ cls: "mva-cli-missing-act", text: "Open settings" });
      clickable(act, openSettings);
      composerEl.prepend(row);
    });
}
