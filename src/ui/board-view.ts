/**
 * Orchestration Board view (workstream B5) — the visible surface for the task
 * ledger. A full-pane `ItemView` (opens in the MAIN workspace area, not the
 * sidebar) that renders tasks as cards across six columns and drives them via
 * the `OrchestratorDriver`.
 *
 * One-way dependency (hard contract): this module MAY import `./view` (ChatView)
 * but `./view` MUST NOT import this module. The board observes chat; chat never
 * depends on the board. Verified by grep in the brief's acceptance criteria.
 *
 * The board is a RENDERER and a control surface, not an owner. The
 * `OrchestratorDriver` and its ledger watch belong to the plugin
 * (`obsidian/orchestration.ts`): this view attaches to the running runtime,
 * paints its snapshot and routes gestures to it. Closing the board stops
 * nothing — which is the point, since the driver used to live and die with this
 * tab and `spawn_task` was silently inert whenever it was closed.
 */
import { defaultModel } from "../settings-schema";
import { ItemView, Menu, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type ExoPlugin from "../main";
import { ADAPTERS } from "../providers/registry";
import type { ProviderId } from "../providers/types";
import { providerModels } from "../core/model-options";
import type { TaskEntry, TaskStatus } from "../core/tasks";
import {
  projectSessionCards,
  type SessionCardVM,
  type SessionLane,
  type SessionSnapshot,
} from "../core/session-cards";
import type { InputReason } from "../core/orchestrator";
import type { Unsubscribe } from "../core/convo-state";
import { clickable } from "./dom";
import { TaskModal } from "./task-modal";
import { reconcileList, type CardModel } from "./keyed-reconcile";

/** The board view type — registered in main.ts, opens in the main pane. */
export const BOARD_VIEW_TYPE = "exo-board";
/** Ribbon/tab icon for the board — registered via addIcon() in main.ts. */
export const BOARD_ICON = "hi-workflow";

/** The six visible columns, in order. `archived` is intentionally excluded —
 *  archived tasks keep their block in tasks.md but are hidden from the board. */
const COLUMNS: ReadonlyArray<{ status: TaskStatus; label: string }> = [
  { status: "backlog", label: "Backlog" },
  { status: "queued", label: "Queued" },
  { status: "running", label: "Running" },
  { status: "needs-input", label: "Needs Input" },
  { status: "review", label: "Review" },
  { status: "done", label: "Done" },
];

/** Human label for a needs-input reason badge. */
function reasonLabel(r: InputReason | undefined): string {
  switch (r) {
    case "error":
      return "Error";
    case "stopped":
      return "Stopped";
    case "needs-input":
      return "Waiting";
    default:
      return "Needs input";
  }
}

/** Compact "time since" label (e.g. "3m", "2h", "just now"). */
function timeSince(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** First lines of the prompt for the card preview (collapse blank lines). */
function promptPreview(prompt: string, lines = 3): string {
  return prompt
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, lines)
    .join(" ");
}

export class BoardView extends ItemView {
  /** Detach handle for the plugin runtime's task feed. Dropped on close — which
   *  detaches this renderer and nothing else. */
  private tasksUnsub: Unsubscribe | null = null;
  private boardEl!: HTMLElement;
  /** The active drag payload — a task or session card being dragged. */
  private dragItem: { kind: "task" | "session"; id: string } | null = null;
  /** Whether the last store load surfaced malformed-file warnings. */
  private loadWarnings: string[] = [];
  /** Last task list from the driver — kept so a session-card-only rerender
   *  (triggered by convo-state, not a task change) can repaint without a driver
   *  round-trip. */
  private lastTasks: TaskEntry[] = [];
  /** Unsubscribe from the convo-state channel (session-card freshness). */
  private convoUnsub: (() => void) | null = null;
  /** Timer backstop: catches convo lifecycle changes the channel doesn't emit
   *  (e.g. a deleted convo → ghost card), so the board self-heals. */
  private backstop: number | null = null;
  /** Coalesce flag so a burst of convo-state events causes ONE repaint. */
  private rerenderQueued = false;
  /** True while a card context menu is open — suppresses repaints that would
   *  detach the menu's anchor mid-interaction. */
  private menuOpen = false;
  /** Per-column DOM refs. The column shell is built once; cards are reconciled
   *  into these lists so the scroller and untouched cards survive every repaint. */
  private colLists = new Map<TaskStatus, HTMLElement>();
  private colCounts = new Map<TaskStatus, HTMLElement>();
  private colHeads = new Map<TaskStatus, HTMLElement>();
  private bannerEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: ExoPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return BOARD_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Orchestration Board";
  }
  getIcon(): string {
    return BOARD_ICON;
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("mva-root");
    root.addClass("mva-board-root");

    // Flag off but the view is somehow open (stale leaf restored from workspace
    // layout while orchestration is disabled): render a placeholder and stop —
    // never start the driver.
    if (!this.plugin.settings.orchestrationEnabled) {
      this.renderDisabledPlaceholder(root);
      return;
    }

    this.boardEl = root.createDiv({ cls: "mva-board" });

    // Attach to the PLUGIN's runtime. `start()` is idempotent: normally the
    // runtime is already up (it starts at layout-ready), and this only covers
    // opening the board in the same tick the flag was turned on.
    const orchestration = this.plugin.orchestration;
    this.tasksUnsub = orchestration.onTasks((tasks) => this.render(tasks));
    await orchestration.start();
    this.loadWarnings = orchestration.warnings();
    this.render(orchestration.snapshot());

    // Session Cockpit (U3): project the open ChatView's live chats as cards.
    // Subscribe directly to convo-state so session-card freshness doesn't depend
    // on the driver's task-emit cadence (the driver DOES emit on un-owned convos
    // today, but the board shouldn't rely on that internal). Both paths repaint,
    // so scheduleRerender coalesces. A low-frequency timer backstop catches
    // lifecycle changes the channel never emits (e.g. a deleted convo → ghost).
    this.convoUnsub = this.plugin.onConvoState(() => this.scheduleRerender());
    this.backstop = window.setInterval(() => this.scheduleRerender(), 5000);
    // Cold-open catch-up: the ChatView may still be restoring its convos when the
    // board first paints (session cards would momentarily be empty). One delayed
    // repaint picks them up without waiting for the 5s backstop.
    window.setTimeout(() => this.scheduleRerender(), 800);
  }

  /** Detach this renderer. Orchestration keeps running: the driver, its ledger
   *  watch and every in-flight child belong to the plugin, not to this tab. */
  async onClose(): Promise<void> {
    this.tasksUnsub?.();
    this.tasksUnsub = null;
    this.convoUnsub?.();
    this.convoUnsub = null;
    if (this.backstop != null) {
      window.clearInterval(this.backstop);
      this.backstop = null;
    }
  }

  // --- Rendering ----------------------------------------------------------

  private renderDisabledPlaceholder(root: HTMLElement): void {
    const wrap = root.createDiv({ cls: "mva-board-placeholder" });
    setIcon(wrap.createDiv({ cls: "mva-board-placeholder-icon" }), BOARD_ICON);
    wrap.createEl("h3", { text: "Orchestration is off" });
    wrap.createEl("p", {
      text: "Turn on the Orchestration Board in Exo settings to queue and run tasks as separate conversations.",
    });
  }

  /** Task-driven render entry point (driver onChange / onOpen / reloadTasks):
   *  store the fresh task list, then paint. Session-card-only refreshes call
   *  `paint()` directly through `scheduleRerender`. */
  private render(tasks: TaskEntry[]): void {
    this.lastTasks = tasks;
    this.paint();
  }

  /** Coalesced, gesture-safe repaint for session-card freshness. A burst of
   *  convo-state events collapses to one paint; the paint is dropped while a
   *  drag or a card menu is in flight (it would detach the drop target / menu
   *  anchor) — the timer backstop and the dragend/menu-close handlers catch up. */
  private scheduleRerender(): void {
    if (this.rerenderQueued) return;
    this.rerenderQueued = true;
    queueMicrotask(() => {
      this.rerenderQueued = false;
      if (this.dragItem != null || this.menuOpen) return;
      this.paint();
    });
  }

  /** Build the static column shell ONCE. Cards are reconciled into the per-column
   *  lists on every paint, so the horizontal scroll and every untouched card
   *  survive — no full `empty()`+rebuild (which reset scroll and reflashed cards). */
  private buildShell(): void {
    this.boardEl.empty();
    this.colLists.clear();
    this.colCounts.clear();
    this.colHeads.clear();
    this.bannerEl = null;
    const cols = this.boardEl.createDiv({ cls: "mva-board-cols" });
    for (const col of COLUMNS) {
      const colEl = cols.createDiv({ cls: "mva-board-col" });
      colEl.dataset.status = col.status;
      const head = colEl.createDiv({ cls: "mva-board-col-head" });
      head.createSpan({ cls: "mva-board-col-title", text: col.label });
      const count = head.createSpan({ cls: "mva-board-col-count", text: "0" });
      // "+" opens the TaskModal (Backlog only).
      if (col.status === "backlog") {
        const addBtn = head.createEl("button", {
          cls: "mva-board-col-add",
          attr: { "aria-label": "New task" },
        });
        setIcon(addBtn, "plus");
        addBtn.addEventListener("click", () => this.openTaskModal());
      }
      const list = colEl.createDiv({ cls: "mva-board-col-list" });
      this.wireColumnDrop(list, col.status);
      this.colLists.set(col.status, list);
      this.colCounts.set(col.status, count);
      this.colHeads.set(col.status, head);
    }
  }

  private paint(): void {
    if (!this.boardEl) return;
    if (this.colLists.size === 0) this.buildShell();
    this.reconcileBanner();

    const now = Date.now();
    const snaps = this.plugin.listSessionSnapshots();
    // Session-cards: the open ChatView's live chats, deduped against task-owned
    // convos. Empty when no ChatView leaf is open (the "leaf open" scope).
    const sessions = projectSessionCards(snaps, this.lastTasks);

    for (const col of COLUMNS) {
      const models: CardModel[] = [];
      const inCol = this.lastTasks
        .filter((t) => t.status === col.status)
        .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
      for (const t of inCol) models.push(this.taskCardModel(t, now));
      // Session-cards follow task-cards in the same lane (running/needs-input/review).
      for (const s of sessions.filter((s) => s.lane === (col.status as SessionLane))) {
        models.push(this.sessionCardModel(s, now));
      }
      reconcileList(this.colLists.get(col.status)!, models);
      this.colCounts.get(col.status)!.setText(String(models.length));
    }

    this.reconcileArchivedAffordance(snaps);
  }

  /** Toggle the malformed-ledger banner in place, without touching the columns. */
  private reconcileBanner(): void {
    if (this.loadWarnings.length && !this.bannerEl) {
      this.bannerEl = createDiv({ cls: "mva-board-error" });
      setIcon(this.bannerEl.createSpan({ cls: "mva-board-error-icon" }), "alert-triangle");
      this.bannerEl.createSpan({
        text: `Some tasks in the ledger look malformed. They're shown as best-effort; check ${this.plugin.paths.tasks}.`,
      });
      this.boardEl.prepend(this.bannerEl);
    } else if (!this.loadWarnings.length && this.bannerEl) {
      this.bannerEl.remove();
      this.bannerEl = null;
    }
  }

  /** Rebuild the Review-header "Show archived" button (cheap; keeps its captured
   *  list fresh). Present only when there are archived chats. */
  private reconcileArchivedAffordance(snaps: SessionSnapshot[]): void {
    const head = this.colHeads.get("review");
    if (!head) return;
    head.querySelector(".mva-board-col-archived")?.remove();
    const archived = snaps.filter((s) => s.archived);
    if (!archived.length) return;
    const btn = head.createEl("button", {
      cls: "mva-board-col-add mva-board-col-archived",
      attr: { "aria-label": `Show ${archived.length} archived chat(s)` },
    });
    setIcon(btn, "archive");
    btn.addEventListener("click", (e) => this.showArchivedMenu(e, archived));
  }

  private taskCardModel(task: TaskEntry, now: number): CardModel {
    const sig = [
      task.status,
      task.order ?? "",
      task.title,
      task.model ?? "",
      task.inputReason ?? "",
      task.chatMissing ? 1 : 0,
      timeSince(task.updated, now),
      promptPreview(task.prompt),
    ].join("");
    return { key: `t:${task.id}`, sig, build: () => this.buildTaskCard(task, now) };
  }

  private sessionCardModel(vm: SessionCardVM, now: number): CardModel {
    const sig = [
      vm.lane,
      vm.reason ?? "",
      vm.badge ?? "",
      vm.title,
      vm.updatedAt ? timeSince(new Date(vm.updatedAt).toISOString(), now) : "",
    ].join("");
    return { key: `s:${vm.id}`, sig, build: () => this.buildSessionCard(vm, now) };
  }

  private buildTaskCard(task: TaskEntry, now: number): HTMLElement {
    const card = createDiv({ cls: "mva-board-card" });
    card.dataset.taskId = task.id;
    card.draggable = true;
    if (task.status === "running") card.addClass("is-running");
    if (task.chatMissing) card.addClass("is-chat-missing");

    // Drag source.
    card.addEventListener("dragstart", (e) => {
      this.dragItem = { kind: "task", id: task.id };
      card.addClass("is-dragging");
      e.dataTransfer?.setData("text/plain", task.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => {
      this.dragItem = null;
      card.removeClass("is-dragging");
      // Catch up any session-card repaint that was suppressed during the drag.
      this.scheduleRerender();
    });
    // Drop onto another card = reorder before it (or move into this column).
    this.wireCardDrop(card, task);

    // Header row: title + model chip.
    const header = card.createDiv({ cls: "mva-board-card-head" });
    header.createSpan({ cls: "mva-board-card-title", text: task.title || "(untitled)" });

    const chips = card.createDiv({ cls: "mva-board-card-chips" });
    const model = task.model ?? this.defaultModel();
    chips.createSpan({ cls: "mva-board-chip mva-board-chip-model", text: model });

    // Live status dot (pulses via CSS while running).
    if (task.status === "running") {
      const dot = chips.createSpan({ cls: "mva-board-dot" });
      dot.setAttribute("aria-label", "streaming");
    }
    // Needs-input reason badge.
    if (task.status === "needs-input") {
      chips.createSpan({ cls: "mva-board-chip mva-board-chip-reason", text: reasonLabel(task.inputReason) });
    }
    // Chat-missing badge (reconciliation found the recorded convo gone).
    if (task.chatMissing) {
      chips.createSpan({ cls: "mva-board-chip mva-board-chip-missing", text: "chat missing" });
    }
    // Time since last update.
    const since = timeSince(task.updated, now);
    if (since) chips.createSpan({ cls: "mva-board-card-time", text: since });

    // Prompt preview.
    const preview = promptPreview(task.prompt);
    if (preview) card.createDiv({ cls: "mva-board-card-preview", text: preview });

    // Click reveals/focuses this task's chat (if it has spawned a convo).
    clickable(card, (e) => {
      // Ignore clicks that originate on the quick-add or drag handle interactions.
      if ((e.target as HTMLElement).closest("input, textarea, select, button")) return;
      void this.onCardClick(task);
    });

    // Context menu.
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.showCardMenu(e, task);
    });
    return card;
  }

  /** Render a session-card: the live projection of an open ad-hoc chat. Unlike a
   *  task-card it is not draggable (it has no ledger order) and carries no model
   *  chip; its lane already encodes the runtime state, plus an optional
   *  stopped/error badge. Click reveals the chat (U4). Context menu (archive) is
   *  added in U6. */
  private buildSessionCard(vm: SessionCardVM, now: number): HTMLElement {
    const card = createDiv({ cls: "mva-board-card is-session" });
    card.dataset.convoId = vm.id;
    card.draggable = true;
    // Drag a session-card between columns to set its manual boardStatus (idle
    // chats only — running/needs-input auto-override at render time).
    card.addEventListener("dragstart", (e) => {
      this.dragItem = { kind: "session", id: vm.id };
      card.addClass("is-dragging");
      e.dataTransfer?.setData("text/plain", vm.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => {
      this.dragItem = null;
      card.removeClass("is-dragging");
      this.scheduleRerender();
    });

    const header = card.createDiv({ cls: "mva-board-card-head" });
    header.createSpan({ cls: "mva-board-card-title", text: vm.title || "(untitled chat)" });
    // × closes the chat: archive it (kept in the archive store, retrievable via
    // "Show archived") AND close its sidebar tab.
    const x = header.createEl("button", {
      cls: "mva-board-card-x",
      attr: { "aria-label": "Close chat" },
    });
    setIcon(x, "x");
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.plugin.archiveAndCloseTab(vm.id)) this.scheduleRerender();
    });

    const chips = card.createDiv({ cls: "mva-board-card-chips" });
    if (vm.lane === "running") {
      chips.createSpan({ cls: "mva-board-dot" }).setAttribute("aria-label", "streaming");
    }
    if (vm.lane === "needs-input") {
      chips.createSpan({
        cls: "mva-board-chip mva-board-chip-reason",
        text: vm.reason === "perm" ? "Permission" : "Question",
      });
    }
    if (vm.badge) {
      chips.createSpan({
        cls: `mva-board-chip ${vm.badge === "error" ? "mva-board-chip-missing" : "mva-board-chip-reason"}`,
        text: vm.badge === "error" ? "Error" : "Stopped",
      });
    }
    if (vm.updatedAt) {
      const since = timeSince(new Date(vm.updatedAt).toISOString(), now);
      if (since) chips.createSpan({ cls: "mva-board-card-time", text: since });
    }

    clickable(card, (e) => {
      if ((e.target as HTMLElement).closest("input, textarea, select, button")) return;
      void this.onSessionCardClick(vm);
    });

    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.showSessionCardMenu(e, vm);
    });
    return card;
  }

  /** Reveal a session-card's chat. `plugin.revealConversation` already re-opens
   *  the ChatView leaf if it was closed, so no extra "ensure" step is needed. */
  private async onSessionCardClick(vm: SessionCardVM): Promise<void> {
    const ok = await this.plugin.revealConversation(vm.id);
    if (!ok) new Notice("That chat is no longer open.");
  }

  /** Context menu for a session-card. Closing is the card's × button (archive +
   *  close tab); the menu just opens the chat. */
  private showSessionCardMenu(e: MouseEvent, vm: SessionCardVM): void {
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle("Open chat")
        .setIcon("message-square")
        .onClick(() => void this.onSessionCardClick(vm))
    );
    this.openMenu(menu, e);
  }

  /** "Show archived" affordance (Review column header): list archived chats.
   *  Clicking one reveals it (resuming a turn there auto-un-archives it); a bulk
   *  "Un-archive" restores them to the board's active lanes. */
  private showArchivedMenu(e: MouseEvent, archived: SessionSnapshot[]): void {
    const menu = new Menu();
    for (const s of archived) {
      menu.addItem((i) =>
        i
          .setTitle(s.title || "(untitled chat)")
          .setIcon("message-square")
          .onClick(() => {
            this.plugin.setConvoArchived(s.id, false); // bring it back to the board
            void this.plugin.revealConversation(s.id);
            this.scheduleRerender();
          })
      );
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle(archived.length === 1 ? "Un-archive" : "Un-archive all")
        .setIcon("archive-restore")
        .onClick(() => {
          let any = false;
          for (const s of archived) any = this.plugin.setConvoArchived(s.id, false) || any;
          if (any) this.scheduleRerender();
        })
    );
    this.openMenu(menu, e);
  }

  /** Show a context menu with the repaint guard: suppress session-card repaints
   *  while it's open (a repaint would detach its anchor) and catch up on close. */
  private openMenu(menu: Menu, e: MouseEvent): void {
    this.menuOpen = true;
    menu.onHide(() => {
      this.menuOpen = false;
      this.scheduleRerender();
    });
    menu.showAtMouseEvent(e);
  }

  /** Open the TaskModal to create a new task; optionally enqueue it right away
   *  ("Run immediately"). The run must happen AFTER `reloadTasks()` so the
   *  rebuilt driver's in-memory list contains the new entry. */
  private openTaskModal(): void {
    new TaskModal(this.app, {
      mode: "create",
      modelChoices: this.modelChoices(),
      defaultModel: this.defaultModel(),
      onSubmit: async (r) => {
        const pinned = r.model ? { model: r.model } : {};
        const entry = await this.plugin.taskStore.create({ title: r.title, prompt: r.prompt, ...pinned });
        await this.reloadTasks();
        if (r.runImmediately) await this.plugin.orchestration.run(entry.id);
      },
    }).open();
  }

  // --- Interactions -------------------------------------------------------

  private async onCardClick(task: TaskEntry): Promise<void> {
    if (task.convo) {
      const ok = await this.plugin.revealConversation(task.convo);
      if (!ok) new Notice("That task's chat is no longer open.");
    } else {
      new Notice("This task hasn't started a chat yet. Run it to begin.");
    }
  }

  private showCardMenu(e: MouseEvent, task: TaskEntry): void {
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle("Run")
        .setIcon("play")
        .onClick(() => void this.plugin.orchestration.run(task.id))
    );
    menu.addItem((i) =>
      i
        .setTitle("Open chat")
        .setIcon("message-square")
        .onClick(() => void this.onCardClick(task))
    );
    menu.addItem((i) =>
      i
        .setTitle("Edit task…")
        .setIcon("pencil")
        .onClick(() => this.editTask(task))
    );
    if (task.status === "review") {
      menu.addItem((i) =>
        i
          .setTitle("Mark done")
          .setIcon("check")
          .onClick(() =>
            void this.plugin.orchestration.markDone(task.id).then(() => {
              // Marking done closes+archives the linked chat too (same path as the
              // session-card "×"), so it lands in the Conversations gallery tagged
              // "Done" instead of lingering as an open tab.
              if (task.convo) this.plugin.archiveAndCloseTab(task.convo);
            })
          )
      );
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("Archive")
        .setIcon("archive")
        .onClick(() => void this.plugin.orchestration.archive(task.id))
    );
    // Suppress session-card repaints while the menu is open (a repaint would
    // detach its anchor); catch up on close.
    this.openMenu(menu, e);
  }

  /** Edit an existing task through the same TaskModal, prefilled. Selecting the
   *  default model clears a previous pin (`model: undefined` drops the line
   *  from the ledger block via `applyTaskPatch`'s spread). */
  private editTask(task: TaskEntry): void {
    new TaskModal(this.app, {
      mode: "edit",
      initial: { title: task.title, prompt: task.prompt, model: task.model },
      modelChoices: this.modelChoices(),
      defaultModel: this.defaultModel(),
      onSubmit: async (r) => {
        await this.plugin.taskStore.update(task.id, { title: r.title, prompt: r.prompt, model: r.model });
        await this.reloadTasks();
      },
    }).open();
  }

  // --- Drag & drop --------------------------------------------------------

  /** Wire a column list as a drop target (append to end of the column). The list
   *  is built once in the shell, so the target task set is read live from
   *  `lastTasks` at drop time rather than captured. */
  private wireColumnDrop(list: HTMLElement, status: TaskStatus): void {
    list.addEventListener("dragover", (e) => {
      if (!this.dragItem) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      list.addClass("is-drop-target");
    });
    list.addEventListener("dragleave", () => list.removeClass("is-drop-target"));
    list.addEventListener("drop", (e) => {
      list.removeClass("is-drop-target");
      const item = this.dragItem;
      const id = item?.id ?? e.dataTransfer?.getData("text/plain") ?? null;
      if (!id) return;
      e.preventDefault();
      // Session-card: dropping into a column sets its manual boardStatus.
      if (item?.kind === "session") {
        if (this.plugin.setConvoBoardStatus(id, status as SessionLane)) this.scheduleRerender();
        return;
      }
      // Task-card: append to the end of the column (cards stop propagation for reorder).
      const maxOrder = this.lastTasks
        .filter((t) => t.status === status)
        .reduce((m, t) => Math.max(m, t.order ?? 0), 0);
      void this.plugin.orchestration.move(id, status, maxOrder + 1);
    });
  }

  /** Wire a card as a reorder drop target: dropping onto it inserts the dragged
   *  card just before it, in the same column. */
  private wireCardDrop(card: HTMLElement, target: TaskEntry): void {
    card.addEventListener("dragover", (e) => {
      // Only task-cards reorder onto each other; session drops bubble to the column.
      if (this.dragItem?.kind !== "task" || this.dragItem.id === target.id) return;
      e.preventDefault();
      e.stopPropagation();
      card.addClass("is-drop-before");
    });
    card.addEventListener("dragleave", () => card.removeClass("is-drop-before"));
    card.addEventListener("drop", (e) => {
      card.removeClass("is-drop-before");
      if (this.dragItem?.kind !== "task") return; // session drops bubble to the column
      const id = this.dragItem.id;
      if (id === target.id) return;
      e.preventDefault();
      e.stopPropagation(); // don't also fire the column's append drop
      // Insert just before the target card: use an order slightly less than the
      // target's. The driver persists status+order; a full render re-sorts.
      const targetOrder = target.order ?? 0;
      void this.plugin.orchestration.move(id, target.status, targetOrder - 0.5);
    });
  }

  // --- Helpers ------------------------------------------------------------

  /** Rebuild the plugin runtime's task list from the store, after a quick-add or
   *  an edit that bypassed the reducer. The reload emits back through `onTasks`,
   *  so the repaint below is only for the warning banner. */
  private async reloadTasks(): Promise<void> {
    await this.plugin.orchestration.reload();
    this.loadWarnings = this.plugin.orchestration.warnings();
    this.render(this.plugin.orchestration.snapshot());
  }

  private currentProvider(): ProviderId {
    return this.plugin.settings.provider;
  }

  private defaultModel(): string {
    const s = this.plugin.settings;
    return defaultModel(s, this.currentProvider());
  }

  /** Same list as settings and the composer: the live Codex catalog (or the
   *  built-ins) + custom ids for the current provider, deduped. Hidden models
   *  are a composer preference and stay available here. */
  private modelChoices(): { id: string; label: string }[] {
    const provider = this.currentProvider();
    const s = this.plugin.settings;
    return providerModels(
      ADAPTERS[provider].models(),
      provider === "codex" ? this.plugin.lastSessionCaps?.models : undefined,
      provider === "claude" ? s.claudeCustomModels : s.codexCustomModels
    );
  }
}
