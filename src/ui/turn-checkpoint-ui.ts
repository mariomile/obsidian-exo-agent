/**
 * The turn's own controls on its "N files" footer: see what the turn changed
 * as one diff, and revert just that turn (core/turn-checkpoint.ts). Its own
 * file because `view.ts` is at its size ceiling (tests/size-contract.test.ts).
 */
import { App, Modal, Notice, setIcon } from "obsidian";
import { clickable } from "./dom";
import { revertSummary, type TurnDiffFile } from "../core/turn-checkpoint";
import { readTurnDiff, revertTurn, type CheckpointVault } from "../obsidian/turn-checkpoint";

/** The message's checkpoint ref, filled in asynchronously after the turn. */
export interface TurnCheckpointHolder {
  checkpointRef?: string;
}

const NOT_READY = "No checkpoint for this turn: the vault is not a git repo, or the turn changed nothing Exo can checkpoint.";

export function addTurnCheckpointActions(
  app: App,
  head: HTMLElement,
  holder: TurnCheckpointHolder,
  vault: () => CheckpointVault,
): void {
  const acts = head.createSpan({ cls: "mva-src-acts" });
  const diff = acts.createSpan({ cls: "mva-src-act", attr: { "aria-label": "What this turn changed" } });
  setIcon(diff, "git-compare");
  clickable(diff, (e) => {
    e.stopPropagation();
    const ref = holder.checkpointRef;
    if (!ref) return void new Notice(NOT_READY);
    void readTurnDiff(vault().basePath, ref).then((d) => {
      if (!d) return void new Notice("Couldn't read this turn's checkpoint.");
      new TurnDiffModal(app, d.files, d.patch).open();
    });
  });

  // Two-step, same as the per-note revert: the first click arms, the second
  // reverts, and the arm lapses after 3s.
  const revert = acts.createSpan({ cls: "mva-src-act", attr: { "aria-label": "Revert this turn" } });
  setIcon(revert, "undo-2");
  let armedUntil = 0;
  clickable(revert, (e) => {
    e.stopPropagation();
    const ref = holder.checkpointRef;
    if (!ref) return void new Notice(NOT_READY);
    if (Date.now() > armedUntil) {
      armedUntil = Date.now() + 3000;
      revert.addClass("is-armed");
      revert.setAttr("aria-label", "Click again to revert this turn");
      window.setTimeout(() => revert.removeClass("is-armed"), 3000);
      return;
    }
    armedUntil = 0;
    revert.removeClass("is-armed");
    void revertTurn(vault(), ref).then((r) => {
      new Notice(r ? revertSummary(r.actions, r.failed) : "Couldn't revert this turn.", 8000);
    });
  });
}

/** Read-only view of one turn's checkpoint diff: file list, then the patch. */
class TurnDiffModal extends Modal {
  constructor(
    app: App,
    private files: TurnDiffFile[],
    private patch: string,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("mva-ie-modal");
    this.titleEl.setText("What this turn changed");
    if (this.files.length === 0) {
      this.contentEl.createDiv({ cls: "mva-ie-orig", text: "This turn left every file as it found it." });
      return;
    }
    const list = this.contentEl.createEl("ul");
    for (const f of this.files) list.createEl("li", { text: `${f.path}  +${f.additions} −${f.deletions}` });
    this.contentEl.createEl("pre").createEl("code", { text: this.patch });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** The vault I/O a checkpoint needs, over Obsidian's API so edits and deletes
 *  go through the same paths a user's would (and land in the trash). */
export function checkpointVaultFor(app: App, basePath: string): CheckpointVault {
  return {
    basePath,
    read: async (path) => ((await app.vault.adapter.exists(path)) ? app.vault.adapter.read(path) : null),
    write: async (path, content) => {
      const f = app.vault.getFileByPath(path);
      if (f) await app.vault.modify(f, content);
      else await app.vault.create(path, content);
    },
    remove: async (path) => {
      const f = app.vault.getFileByPath(path);
      if (f) await app.fileManager.trashFile(f);
    },
  };
}
