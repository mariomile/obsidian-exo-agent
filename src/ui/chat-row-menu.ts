/**
 * The chat row's command surface: the context menu and the rename modal.
 *
 * Extracted from `chat-list-view.ts` on 2026-08-12, when that file crossed 1000
 * lines. This is the cut that follows state rather than line count: nothing
 * here reads the pane's own mutable state — not the query, the cursor, the
 * order, the collapse settings — so it is a function of one row plus three
 * services. It is also the part that keeps growing: this wave alone added
 * "Settle to note" to it.
 *
 * Every mutation goes through the plugin wrappers, never a reach into ChatView.
 */
import { App, Menu, Modal, Notice } from "obsidian";
import type ExoPlugin from "../main";
import type { ChatRow } from "../core/chat-rows";
import { canSettleRow } from "../core/settle-note";
import { activeConvoId, applyLifecycle, settleToNote } from "./convo-bridge";
import { snoozePresets } from "../core/thread-lifecycle";
import { retitleWithNotice } from "./chat-commands";

/** What the menu needs from whoever opened it: the two hosts it calls into,
 *  and a way to ask for a repaint once a mutation lands. */
export interface ChatRowMenuContext {
  app: App;
  plugin: ExoPlugin;
  repaint: () => void;
}

/**
 * Rename / Archive / Delete. Delete is two-step: the first click re-opens this
 * menu with the item relabelled "Confirm delete", the second one deletes.
 *
 * Obsidian closes a Menu on any item click, so the gallery's timer-based
 * arm/disarm (gallery-cards.ts:131-164) can't be transplanted as-is; the armed
 * state instead lives in the re-opened menu and dies with it. Dismissing the
 * menu — Escape, a click anywhere else — disarms, which is what the gallery's
 * 3s timer and outside-click listener were buying.
 */
export function openChatRowMenu(
e: MouseEvent,
r: ChatRow,
ctx: ChatRowMenuContext,
armed = false,
): void {
  e.preventDefault();
  const menu = new Menu();
  menu.addItem((i) =>
    i.setTitle("Rename").setIcon("pencil").onClick(() => promptRename(r, ctx)),
  );
  menu.addItem((i) =>
    i.setTitle("Retitle with AI").setIcon("sparkles").onClick(() => retitleWithNotice(ctx.plugin, r.id, ctx.repaint)),
  );
  menu.addItem((i) =>
    i
      .setTitle(r.pinned ? "Unpin" : "Pin")
      .setIcon(r.pinned ? "pin-off" : "pin")
      .onClick(() => {
        ctx.plugin.setConvoPinned(r.id, !r.pinned);
        ctx.repaint();
      }),
  );
  // The lifecycle verbs, from T3 Code (core/thread-lifecycle). Absent where
  // they would be refused: nothing is hidden while it waits on you, and nothing
  // is settled while a turn runs.
  if (r.shelf === "snoozed") {
    menu.addItem((i) =>
      i.setTitle("Unsnooze").setIcon("alarm-clock-off").onClick(() => {
        applyLifecycle(ctx.app, r.id, { verb: "unsnooze" });
        ctx.repaint();
      }),
    );
  } else if (r.lane !== "needs-input") {
    menu.addItem((i) =>
      i.setTitle("Snooze…").setIcon("alarm-clock").onClick(() => {
        // Same re-open trick as Delete: Menu has no typed submenu API.
        window.setTimeout(() => openSnoozeMenu(e, r, ctx), 0);
      }),
    );
  }
  if (r.shelf === "settled") {
    menu.addItem((i) =>
      i.setTitle("Unsettle").setIcon("inbox").onClick(() => {
        applyLifecycle(ctx.app, r.id, { verb: "unsettle" });
        ctx.repaint();
      }),
    );
  } else if (!r.lane) {
    menu.addItem((i) =>
      i.setTitle("Settle").setIcon("check-check").onClick(() => {
        if (!applyLifecycle(ctx.app, r.id, { verb: "settle" })) {
          new Notice("Couldn't settle this chat. Let the running turn finish first.");
          return;
        }
        if (activeConvoId(ctx.app) === r.id) new Notice("Settled. It moves to the shelf when you switch away.");
        ctx.repaint();
      }),
    );
  }
  // Settled chats only. Not greyed out but ABSENT on a running or blocked
  // row: a chat mid-turn has no outcome to write down yet, and an item that
  // is permanently there and permanently dead teaches the user to ignore it.
  if (canSettleRow(r)) {
    menu.addItem((i) =>
      i.setTitle("Settle to note").setIcon("file-plus-2").onClick(() => {
        const pending = new Notice("Settling…", 0);
        void settleToNote(ctx.plugin, r.id)
          .then((path) => {
            pending.hide();
            new Notice(
              path
                ? `Settled to ${path}`
                : "Couldn't settle this chat. Open Exo, and let any running turn finish.",
            );
          })
          .catch(() => {
            pending.hide();
            new Notice("Couldn't write the note.");
          });
      }),
    );
  }
  menu.addItem((i) =>
    i.setTitle("Archive").setIcon("archive").onClick(() => {
      // Three causes reach this false — a streaming turn, no mounted ChatView,
      // an id the store no longer holds — and the row cannot tell them apart,
      // so the message names the state rather than guessing the cause.
      if (!ctx.plugin.setConvoArchived(r.id, true)) {
        new Notice("Couldn't archive this chat. Open Exo and let any running turn finish.");
        return;
      }
      ctx.repaint();
    }),
  );
  menu.addItem((i) =>
    i
      .setTitle(armed ? "Confirm delete" : "Delete")
      .setIcon("trash-2")
      // The armed item re-opens under the cursor, so a double-click on Delete
      // would land on Confirm without the user ever reading it. The warning
      // styling is what makes the second menu look different from the first.
      .setWarning(armed)
      .onClick(() => {
        if (!armed) {
          window.setTimeout(() => openChatRowMenu(e, r, ctx, true), 0);
          return;
        }
        // The only destructive action here, and the only one that can no-op:
        // an unknown id returns false. Say so rather than repainting an
        // unchanged row and letting it read as a dead click.
        if (!ctx.plugin.deleteConversation(r.id)) {
          new Notice("Couldn't delete this chat — it is no longer in the store.");
          return;
        }
        ctx.repaint();
      }),
  );
  menu.showAtMouseEvent(e);
}

/** The snooze presets, as a second menu under the cursor. */
function openSnoozeMenu(e: MouseEvent, r: ChatRow, ctx: ChatRowMenuContext): void {
  const menu = new Menu();
  for (const p of snoozePresets(new Date())) {
    const when = new Date(p.until).toLocaleString(undefined, {
      weekday: "short", hour: "numeric", minute: "2-digit",
    });
    menu.addItem((i) =>
      i.setTitle(`${p.label} · ${when}`).onClick(() => {
        if (!applyLifecycle(ctx.app, r.id, { verb: "snooze", until: p.until })) {
          new Notice("Couldn't snooze this chat. It is waiting on you, or Exo is not open.");
          return;
        }
        // The chat in front of you stays on screen until you leave it, so say
        // where it went rather than leaving the click looking dead.
        new Notice(`Snoozed until ${when}.`);
        ctx.repaint();
      }),
    );
  }
  menu.showAtMouseEvent(e);
}

function promptRename(r: ChatRow, ctx: ChatRowMenuContext): void {
  new RenameChatModal(ctx.app, r.title, (title) => {
    // The mutation rejects a blank title and an unknown id (core/title-ownership
    // applyRename) — both surface here, because neither is visible from the row.
    if (!ctx.plugin.renameConversation(r.id, title)) {
      new Notice("Couldn't rename this chat. The title can't be empty, and Exo has to be open.");
      return;
    }
    ctx.repaint();
  }).open();
}

/** Prefilled single-field rename. Enter submits; Escape (Modal's own scope)
 *  cancels without touching the conversation. */
class RenameChatModal extends Modal {
  constructor(
    app: App,
    private readonly current: string,
    private readonly onSubmit: (title: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Rename chat");
    const input = this.contentEl.createEl("input", {
      cls: "mva-chats-rename-input",
      attr: { type: "text", placeholder: "Chat title" },
    });
    input.value = this.current;
    input.focus();
    input.select();
    const actions = this.contentEl.createDiv({ cls: "mva-chats-rename-actions" });
    const save = actions.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Rename" });
    const submit = () => {
      this.onSubmit(input.value);
      this.close();
    };
    save.onclick = submit;
    input.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      submit();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
