/**
 * Scheduled prompts, the surfaces: the form that schedules one, the list that
 * shows and cancels them, and the clock button in the chats sidebar header
 * that opens the list and counts what is waiting. Form recipe as in
 * `mcp-server-modal.ts`: `.mva-pv-*` rows and `.mva-btn` buttons.
 */
import { App, Modal, Notice, setIcon } from "obsidian";
import type ExoPlugin from "../main";
import { clickable } from "./dom";
import { addScheduled, cancelScheduled, listScheduled, onScheduledChange, targetTitle } from "./scheduled-runner";
import { describeScheduled, formatWhen, parseWhen, SCHEDULE_REPEATS, type ScheduleRepeat } from "../core/scheduled-prompts";

/** `datetime-local` wants `YYYY-MM-DDTHH:MM`, local time. */
const localInput = (ms: number): string => formatWhen(ms).replace(" ", "T");

/** A row of buttons acting as one choice; the chosen one is primary. */
function choice<T extends string>(parent: HTMLElement, options: { value: T; label: string }[], value: T, set: (v: T) => void): void {
  const row = parent.createDiv({ cls: "mva-sched-choice" });
  const paint = (current: T) => {
    row.empty();
    for (const o of options) {
      const b = row.createEl("button", { cls: "mva-btn" + (o.value === current ? " mva-btn-primary" : ""), text: o.label });
      b.onclick = () => {
        set(o.value);
        paint(o.value);
      };
    }
  };
  paint(value);
}

/** Schedule a prompt. `chatId` is the chat it runs in by default; without
 *  one, every run opens a new chat. */
export class ScheduleModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: ExoPlugin,
    private readonly chatId?: string,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("mva-root", "mva-mcp-modal");
    contentEl.createEl("h3", { cls: "mva-mcp-modal-title", text: "Schedule a prompt" });

    const promptRow = contentEl.createDiv({ cls: "mva-pv-row" });
    promptRow.createSpan({ cls: "mva-pv-label", text: "Prompt" });
    const prompt = promptRow.createEl("textarea", { cls: "mva-pv-input", attr: { rows: "4", placeholder: "What should Exo do then?" } });

    const whenRow = contentEl.createDiv({ cls: "mva-pv-row" });
    whenRow.createSpan({ cls: "mva-pv-label", text: "When" });
    const when = whenRow.createEl("input", { cls: "mva-pv-input", attr: { type: "datetime-local" } });
    when.value = localInput(Date.now() + 10 * 60_000);

    let repeat: ScheduleRepeat | "once" = "once";
    const repeatRow = contentEl.createDiv({ cls: "mva-pv-row" });
    repeatRow.createSpan({ cls: "mva-pv-label", text: "Repeat" });
    choice(repeatRow, [{ value: "once", label: "Once" }, ...SCHEDULE_REPEATS.map((r) => ({ value: r, label: r[0].toUpperCase() + r.slice(1) }))], repeat, (v) => (repeat = v));

    let target = this.chatId ?? "new";
    const whereRow = contentEl.createDiv({ cls: "mva-pv-row" });
    whereRow.createSpan({ cls: "mva-pv-label", text: "Run in" });
    choice(whereRow, [...(this.chatId ? [{ value: this.chatId, label: "This chat" }] : []), { value: "new", label: "A new chat" }], target, (v) => (target = v));

    const err = contentEl.createDiv({ cls: "mva-mcp-modal-err" });
    const actions = contentEl.createDiv({ cls: "mva-mcp-modal-actions" });
    actions.createEl("button", { cls: "mva-btn", text: "Cancel" }).onclick = () => this.close();
    const save = actions.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Schedule" });
    save.onclick = async () => {
      if (save.disabled) return;
      const text = prompt.value.trim();
      const dueAt = parseWhen({ at: when.value }, Date.now());
      if (!text) return void err.setText("Write the prompt to run.");
      if (dueAt === null) return void err.setText("Pick a time in the future.");
      save.disabled = true;
      await addScheduled(this.plugin, { prompt: text, dueAt, target, repeat: repeat === "once" ? undefined : repeat });
      new Notice(`Scheduled for ${formatWhen(dueAt)}.`);
      this.close();
    };
    prompt.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Everything scheduled, soonest first, each with Cancel. */
export class ScheduledListModal extends Modal {
  private off: (() => void) | null = null;

  constructor(
    app: App,
    private readonly plugin: ExoPlugin,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.addClass("mva-root", "mva-mcp-modal");
    this.off = onScheduledChange(() => this.render());
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { cls: "mva-mcp-modal-title", text: "Scheduled prompts" });
    const list = listScheduled(this.plugin);
    if (!list.length) contentEl.createDiv({ cls: "mva-faint", text: "Nothing scheduled." });
    for (const p of list) {
      const row = contentEl.createDiv({ cls: "mva-sched-row" });
      row.createDiv({ cls: "mva-sched-text", text: describeScheduled(p, targetTitle(this.plugin, p.target)) });
      row.createEl("button", { cls: "mva-btn", text: "Cancel" }).onclick = () => void cancelScheduled(this.plugin, p.id);
    }
    const actions = contentEl.createDiv({ cls: "mva-mcp-modal-actions" });
    actions.createEl("button", { cls: "mva-btn", text: "Schedule a prompt" }).onclick = () => {
      this.close();
      new ScheduleModal(this.app, this.plugin, this.plugin.activeConvoId() ?? undefined).open();
    };
  }

  onClose(): void {
    this.off?.();
    this.contentEl.empty();
  }
}

/** The clock in the chats sidebar header: how many prompts wait, and the list
 *  on click. Hidden while nothing is scheduled. */
export function addScheduledButton(head: HTMLElement, plugin: ExoPlugin): void {
  const btn = head.createSpan({ cls: "mva-icon-btn mva-sched-btn", attr: { "aria-label": "Scheduled prompts" } });
  setIcon(btn, "alarm-clock");
  const count = btn.createSpan({ cls: "mva-sched-count" });
  const paint = () => {
    const n = listScheduled(plugin).length;
    count.setText(n ? String(n) : "");
    btn.toggle(n > 0);
  };
  const off = onScheduledChange(() => (btn.isConnected ? paint() : off()));
  paint();
  clickable(btn, () => new ScheduledListModal(plugin.app, plugin).open());
}
