/**
 * The quiet row a save leaves under the turn: "Saved to <Note> > <Section> ·
 * Open · Undo". Same look as the governed-write undo row (`.mva-mem-veto`).
 */
import type { App } from "obsidian";
import { sectionLabel } from "../core/save-target";
import type { SaveReceipt } from "../core/save-undo";
import type { SaveLog } from "../obsidian/save-log";
import { undoSaveWithNotice } from "../obsidian/note-save";
import { clickable } from "./dom";

const noteName = (path: string): string => path.replace(/^.*\//, "").replace(/\.md$/, "");

export function renderSaveReceipt(
  el: HTMLElement,
  r: SaveReceipt,
  on: { open: () => void; undo: () => void },
): HTMLElement {
  const row = el.createDiv({ cls: "mva-faint mva-mem-veto" });
  row.createSpan({ text: `Saved to ${noteName(r.path)} > ${sectionLabel(r.section)}` });
  for (const [label, fn] of [
    ["Open", on.open],
    ["Undo", on.undo],
  ] as const) {
    row.createSpan({ text: " · " });
    clickable(row.createSpan({ cls: "mva-link", text: label }), fn);
  }
  return row;
}

/** The receipt row wired to the vault: Open jumps to the block, Undo reverses it. */
export function mountSaveReceipt(app: App, log: SaveLog, el: HTMLElement, r: SaveReceipt): HTMLElement {
  const row: HTMLElement = renderSaveReceipt(el, r, {
    open: () => void app.workspace.openLinkText(`${r.path}#^${r.id}`, "", "tab"),
    undo: () =>
      void undoSaveWithNotice(app, log, r.id).then((done) => {
        if (!done) return;
        row.empty();
        row.createSpan({ text: "Save undone." });
      }),
  });
  return row;
}
