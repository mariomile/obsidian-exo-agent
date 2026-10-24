/**
 * Queued-message pills, pinned above the composer. Each pill shows what will be sent
 * (text, images, the context frozen with it) and the actions on it: edit in
 * place, steer into the running turn, run a held message, remove. State lives
 * on the Convo (core/queue.ts); functions of the view rather than view methods,
 * because `view.ts` is at its size ceiling.
 */

import { Notice, setIcon, setTooltip } from "obsidian";
import type { ChatView } from "../view";
import type { Convo } from "./convo-types";
import { canSteer, nextRunnable, takeAt, type QueuedMessage } from "../core/queue";
import { clickable } from "./dom";

export interface QueueHandlers {
  /** The item changed (edited, un-held): repaint, and start it if the chat is idle. */
  changed(): void;
  steer(q: QueuedMessage): void;
  remove(q: QueuedMessage): void;
  /** Whether `q` can be injected into the running turn right now. */
  canSteer(q: QueuedMessage): boolean;
}

/** Run the next runnable message if the chat is idle (a held item was released
 *  after the turn ended), then repaint. */
export function kickQueue(view: ChatView, c: Convo): void {
  if (!c.streaming && !c.turnClaimed) {
    const q = takeAt(c.queue, nextRunnable(c.queue));
    if (q) {
      view.renderQueue(c);
      void view.runTurn(c, q.text, q.images, q);
      return;
    }
  }
  view.renderQueue(c);
}

export function queueHandlers(view: ChatView, c: Convo): QueueHandlers {
  return {
    changed: () => kickQueue(view, c),
    steer: (q) => {
      let ok = false;
      try {
        ok = c.session?.steer?.(view.hoistOutbound(q.text)) ?? false;
      } catch {
        ok = false;
      }
      if (!ok) {
        new Notice("Exo: the running turn can't take it now, it stays queued");
        return;
      }
      takeAt(c.queue, c.queue.indexOf(q));
      view.addUserTurn(c, q.text);
      view.persist();
      view.renderQueue(c);
    },
    remove: (q) => {
      takeAt(c.queue, c.queue.indexOf(q));
      view.renderQueue(c);
    },
    canSteer: (q) =>
      canSteer(q, { streaming: c.streaming, researchOn: c.researchMode.enabled, hasSteer: !!c.session?.steer }),
  };
}

const basename = (p: string): string => (p.split("/").pop() ?? p).replace(/\.md$/, "");

function meta(row: HTMLElement, icon: string, count: number | null, tip: string): void {
  const m = row.createSpan({ cls: "mva-queued-meta" });
  setIcon(m.createSpan({ cls: "mva-queued-meta-icon" }), icon);
  if (count !== null) m.createSpan({ text: String(count) });
  setTooltip(m, tip);
}

function action(row: HTMLElement, icon: string, label: string, fn: () => void): void {
  const a = row.createSpan({ cls: "mva-queued-act", attr: { "aria-label": label } });
  setIcon(a, icon);
  clickable(a, fn);
}

/** Text typed in an open editor, so a repaint (Stop, a turn ending) reopens the
 *  editor with the edit instead of dropping it. */
const drafts = new WeakMap<QueuedMessage, string>();

/** Swap the pill's text for a textarea. While open the item is `editing`: never
 *  drained or steered, so a turn ending meanwhile can't send the old text.
 *  Enter or blur saves, Esc cancels, an emptied message is removed. The
 *  handlers look the item up by identity, never by index. */
function editInPlace(row: HTMLElement, textEl: HTMLElement, q: QueuedMessage, h: QueueHandlers): void {
  q.editing = true;
  const input = createEl("textarea", { cls: "mva-queued-input" });
  input.value = drafts.get(q) ?? q.text;
  input.rows = Math.min(6, input.value.split("\n").length);
  textEl.replaceWith(input);
  row.addClass("is-editing");
  let done = false;
  const finish = (save: boolean): void => {
    if (done) return;
    done = true;
    const text = input.value.trim();
    delete q.editing;
    drafts.delete(q);
    if (save && !text) return h.remove(q);
    if (save) q.text = text;
    h.changed();
  };
  input.addEventListener("input", () => drafts.set(q, input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  });
  // Deferred, and ignored once a repaint has replaced this textarea: the new
  // editor carries the draft on.
  input.addEventListener("blur", () =>
    window.setTimeout(() => {
      if (input.isConnected) finish(true);
    }, 0)
  );
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

/** Rebuild the pills inside `el` (the view's `.mva-queue` host above the composer). */
export function renderQueueRows(el: HTMLElement, queue: readonly QueuedMessage[], h: QueueHandlers): void {
  el.empty();
  for (const q of queue) {
    const row = el.createDiv({ cls: "mva-queued" + (q.held ? " is-held" : "") });
    const icon = row.createSpan({ cls: "mva-queued-icon" });
    setIcon(icon, q.held ? "circle-pause" : "clock");
    setTooltip(icon, q.held ? "Paused: runs when you press Run" : "Runs after the current turn");
    const textEl = row.createSpan({ cls: "mva-queued-text", text: q.text });
    if (q.images?.length) meta(row, "image", q.images.length, `${q.images.length} image${q.images.length === 1 ? "" : "s"}`);
    const paths = q.context?.paths ?? [];
    if (paths.length) meta(row, "file-text", paths.length, paths.map(basename).join(", "));
    if (q.context?.selection) meta(row, "text-select", null, `Selection from ${basename(q.context.selection.path)}`);
    action(row, "pencil", "Edit", () => editInPlace(row, textEl, q, h));
    if (h.canSteer(q)) action(row, "corner-down-right", "Send into the current turn", () => h.steer(q));
    if (q.held) {
      action(row, "play", "Run", () => {
        delete q.held;
        h.changed();
      });
    }
    action(row, "x", "Remove", () => h.remove(q));
    if (q.editing) editInPlace(row, textEl, q, h);
  }
}
