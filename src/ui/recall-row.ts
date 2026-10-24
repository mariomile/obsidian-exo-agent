import { setIcon } from "obsidian";
import { clickable } from "./dom";
import type { TurnRecall } from "../obsidian/turn-recall";

/**
 * Quiet, expandable "Recalled N" row under a user turn: the trust surface for
 * per-turn recall, so an injection is never invisible. Collapsed by default;
 * a click lists what rode along; every item opens at its source (a note at its
 * path, a past chat at the matching message). No fill at rest (design laws 2 & 4).
 */
export function renderRecallRow(
  turnEl: HTMLElement,
  recall: TurnRecall,
  open: { openPath: (path: string) => void; openChat: (id: string, msgIndex: number | null) => void },
): void {
  const n = recall.notes.length + recall.chats.length;
  const wrap = turnEl.createDiv({ cls: "mva-recall" });
  const header = wrap.createDiv({ cls: "mva-recall-header", attr: { role: "button", tabindex: "0" } });
  setIcon(header.createSpan({ cls: "mva-recall-icon" }), "brain");
  header.createSpan({ cls: "mva-recall-label", text: `Recalled ${n} ${n === 1 ? "item" : "items"}` });
  setIcon(header.createSpan({ cls: "mva-recall-caret" }), "chevron-right");

  const list = wrap.createDiv({ cls: "mva-recall-list" });
  const noteLink = (item: HTMLElement, text: string, path: string): void => {
    const link = item.createEl("a", { cls: "mva-recall-text", text, href: "#" });
    clickable(link, (e) => {
      e.preventDefault();
      open.openPath(path);
    });
  };
  for (const note of recall.notes) {
    const item = list.createDiv({ cls: "mva-recall-item" });
    item.createSpan({ cls: "mva-recall-meta", text: note.supersededBy ? "superseded" : "note" });
    noteLink(item, note.path, note.path);
    // Demoted, never hidden: the old note stays, pointing at the current one.
    if (note.supersededBy) {
      item.createSpan({ cls: "mva-recall-meta", text: "by" });
      noteLink(item, note.supersededBy.replace(/^.*\//, "").replace(/\.md$/, ""), note.supersededBy);
    }
  }
  for (const chat of recall.chats) {
    const item = list.createDiv({ cls: "mva-recall-item" });
    item.createSpan({ cls: "mva-recall-meta", text: `chat · ${chat.date}` });
    const link = item.createEl("a", { cls: "mva-recall-text", text: chat.title, href: "#", attr: { "aria-label": "Open chat" } });
    clickable(link, (e) => {
      e.preventDefault();
      open.openChat(chat.id, chat.msgIndex);
    });
  }

  const toggle = (): void => {
    const open = wrap.hasClass("is-open");
    wrap.toggleClass("is-open", !open);
    header.setAttr("aria-expanded", String(!open));
  };
  header.setAttr("aria-expanded", "false");
  clickable(header, toggle);
}
