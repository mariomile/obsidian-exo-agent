/**
 * Exo Cockpit — the control-center home surface (spec 2026-07-13). A main-pane
 * ItemView: the Inbox (the same panel and data as the Chats sidebar), command
 * bar (type → chat), and action-first tiles (Loops, Autonomy, System, Health).
 * One-way contract: this module imports from main/view; `view.ts` never
 * imports it.
 *
 * All gathering is tolerant: a missing file yields no rows, and a tile with no
 * rows is not drawn, never a blocked render. Refresh: on-open, manual button,
 * and a plain 60s interval (deliberately NOT rAF-gated: idle-pane starvation).
 */
import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type ExoPlugin from "../main";
import { clickable } from "./dom";
import { mountInbox } from "./inbox-panel";
import { loopRows, healthRows, quotaValue, type CockpitRow, type StateNote } from "../core/cockpit";
import { blockPath } from "../obsidian/agent-folder";
import { parseLoopsFile } from "../core/open-loops";
import {
  autonomyStatuses,
  autonomyActions,
  formatBudget,
  formatAge,
} from "../core/actions-hub";

export const COCKPIT_VIEW_TYPE = "exo-cockpit";
/** Registered via addIcon() in main.ts (Huge Icons dashboard-speed). */
export const COCKPIT_ICON = "hi-dashboard-speed";

const INBOX_DIR = "_inbox";
/** Chat state lives in memory and moves without a feed event: the Inbox panel
 *  repaints on this tick (a no-op unless what it shows changed). */
const INBOX_TICK_MS = 5000;

export class CockpitView extends ItemView {
  private refreshedAt = 0;
  private rendering = false;
  private refreshRequested = false;
  private inputEl: HTMLInputElement | null = null;
  private inboxHost: HTMLElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: ExoPlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return COCKPIT_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Exo Cockpit";
  }
  getIcon(): string {
    return COCKPIT_ICON;
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("mva-ck");
    await this.refresh();
    this.registerInterval(
      window.setInterval(() => {
        // Don't yank the surface out from under the user: skip the automatic
        // tick while the tab is hidden or the command bar holds focus/draft.
        if (!this.containerEl.isShown()) return;
        const i = this.inputEl;
        if (i && (document.activeElement === i || i.value.trim())) return;
        void this.refresh();
      }, 60_000)
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf === this.leaf) void this.refresh();
      })
    );
    this.registerInterval(
      window.setInterval(() => {
        if (this.containerEl.isShown()) this.paintInbox();
      }, INBOX_TICK_MS)
    );
    this.register(this.plugin.inbox.onChange(() => this.paintInbox()));
  }

  private paintInbox(): void {
    if (this.inboxHost) mountInbox(this.inboxHost, this.plugin.inbox.current(), this.plugin.inbox.handlers);
  }

  /* ------------------------------ actions ------------------------------ */

  private act(a: CockpitRow["action"]): void {
    if (a.kind === "ask") void this.plugin.askExo(a.arg, false);
    else if (a.kind === "open") void this.app.workspace.openLinkText(a.arg, "", "tab");
    else if (a.kind === "command") this.runCommand(a.arg);
  }

  private runCommand(id: string): void {
    const ok = (this.app as unknown as { commands: { executeCommandById(id: string): boolean } }).commands.executeCommandById(id);
    if (!ok) new Notice(`Command not available: ${id}`);
  }

  private openSettings(): void {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open();
    setting?.openTabById(this.plugin.manifest.id);
  }

  /* ------------------------------ gathering ---------------------------- */

  private async readOr(path: string, fallback: string): Promise<string> {
    try {
      return await this.app.vault.adapter.read(path);
    } catch {
      return fallback;
    }
  }

  private async inboxCount(): Promise<number> {
    try {
      const res = await this.app.vault.adapter.list(INBOX_DIR);
      return res.files.filter((f) => f.endsWith(".md")).length;
    } catch {
      return 0;
    }
  }

  /** The note that carries current state, and how old it is: the identity
   *  `NOW.md` when the agent folder is on and the file exists, else
   *  vault-context. Null when that note is missing or unreadable. */
  private async stateNote(now: number): Promise<StateNote | null> {
    const adapter = this.app.vault.adapter;
    try {
      const identity = blockPath("NOW", this.plugin.paths.agentDir);
      const path =
        this.plugin.memoryCaps().identity && (await adapter.exists(identity))
          ? identity
          : this.plugin.paths.vaultContext;
      const st = await adapter.stat(path);
      return st?.mtime ? { path, ageDays: (now - st.mtime) / 86_400_000 } : null;
    } catch {
      return null;
    }
  }

  private async lastReport(): Promise<{ path: string; name: string; mtime: number } | null> {
    try {
      const res = await this.app.vault.adapter.list(this.plugin.paths.reports);
      let best: { path: string; name: string; mtime: number } | null = null;
      for (const f of res.files.slice(-30)) {
        if (!f.endsWith(".md")) continue;
        const st = await this.app.vault.adapter.stat(f);
        if (st?.mtime && (!best || st.mtime > best.mtime)) {
          best = { path: f, name: f.split("/").pop()!.replace(/\.md$/, ""), mtime: st.mtime };
        }
      }
      return best;
    } catch {
      return null;
    }
  }

  /* ------------------------------ rendering ---------------------------- */

  async refresh(): Promise<void> {
    if (this.rendering) {
      this.refreshRequested = true;
      return;
    }
    this.rendering = true;
    try {
      const now = Date.now();
      const [loopsRaw, queuePending, inbox, stateNote, report] = await Promise.all([
        this.readOr(this.plugin.paths.openLoops, ""),
        this.plugin.countQueuePending().catch(() => null),
        this.inboxCount(),
        this.stateNote(now),
        this.lastReport(),
      ]);

      const el = this.contentEl;
      // Preserve the command-bar draft/focus across ANY rebuild (manual
      // refresh / active-leaf-change / the gated interval tick).
      const draft = this.inputEl?.value ?? "";
      const hadFocus = document.activeElement === this.inputEl;
      el.empty();

      this.refreshedAt = now;

      // Header
      const head = el.createDiv({ cls: "mva-ck-head" });
      setIcon(head.createSpan({ cls: "mva-ck-mark" }), COCKPIT_ICON);
      head.createSpan({ cls: "mva-ck-title", text: "Exo Cockpit" });
      head.createSpan({ cls: "mva-ck-spacer" });
      head.createSpan({ cls: "mva-ck-stamp", text: `refreshed ${formatAge(this.refreshedAt || now, now, "now")}` });
      const rbtn = head.createSpan({ cls: "mva-ck-refresh", attr: { "aria-label": "Refresh" } });
      setIcon(rbtn, "refresh-cw");
      clickable(rbtn, () => void this.refresh());

      // The Inbox: absent when empty (CSS `:empty`).
      this.inboxHost = el.createDiv({ cls: "mva-inbox mva-ck-inbox" });
      this.paintInbox();

      // Command bar
      this.renderCommandBar(el);
      if (this.inputEl) {
        this.inputEl.value = draft;
        if (hadFocus) this.inputEl.focus();
      }

      // Tile grid
      const grid = el.createDiv({ cls: "mva-ck-grid" });

      const loops = loopRows(parseLoopsFile(loopsRaw), now);
      this.tile(grid, "Loops", "target", loops, {
        label: "open-loops.md",
        onClick: () => void this.app.workspace.openLinkText(this.plugin.paths.openLoops, "", "tab"),
      });

      this.renderAutonomy(grid, queuePending, now);
      this.renderSystem(grid);

      const health = healthRows({
        inboxCount: inbox,
        stateNote,
        lastReport: report,
        now,
      });
      this.tile(grid, "Health", "heart-pulse", health);
    } finally {
      this.rendering = false;
      if (this.refreshRequested) {
        this.refreshRequested = false;
        void this.refresh();
      }
    }
  }

  private renderCommandBar(parent: HTMLElement): void {
    const bar = parent.createDiv({ cls: "mva-ck-bar" });
    const input = bar.createEl("input", { cls: "mva-ck-input", attr: { placeholder: "Ask Exo…", type: "text" } });
    this.inputEl = input;
    const send = bar.createSpan({ cls: "mva-ck-send", attr: { "aria-label": "Send" } });
    setIcon(send, "arrow-up");
    const go = () => {
      const q = input.value.trim();
      if (!q) return;
      input.value = "";
      void this.plugin.askExo(q, true);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") go();
    });
    clickable(send, go);
  }

  /** A tile of action rows, or nothing at all when there are no rows: an
   *  empty tile is a column that says nothing. */
  private tile(
    grid: HTMLElement,
    title: string,
    icon: string,
    rows: CockpitRow[],
    footer?: { label: string; onClick: () => void }
  ): HTMLElement | null {
    if (!rows.length) return null;
    const card = grid.createDiv({ cls: "mva-ck-card" });
    const head = card.createDiv({ cls: "mva-ck-card-head" });
    setIcon(head.createSpan({ cls: "mva-ck-card-icon" }), icon);
    head.createSpan({ cls: "mva-ck-card-title", text: title });
    for (const r of rows) {
      const row = card.createDiv({ cls: "mva-ck-row" });
      row.createSpan({ cls: "mva-ck-row-label", text: r.label });
      if (r.badge) row.createSpan({ cls: "mva-ck-badge", text: r.badge });
      if (r.sub) row.createDiv({ cls: "mva-ck-row-sub", text: r.sub });
      clickable(row, () => this.act(r.action));
    }
    if (footer) {
      const f = card.createDiv({ cls: "mva-ck-foot", text: footer.label });
      clickable(f, footer.onClick);
    }
    return card;
  }

  private renderAutonomy(grid: HTMLElement, queuePending: number | null, now: number): void {
    const s = this.plugin.settings;
    const input = {
      exoQueueEnabled: s.exoQueueEnabled,
      queuePending,
      automations: s.automations ?? [],
      scheduledLastRun: s.scheduledLastRun ?? {},
      hasPlaybooks: (s.customPrompts ?? []).length > 0,
      now,
    };
    const rows: CockpitRow[] = [];
    for (const a of autonomyActions(input)) {
      if (!a.enabled) continue;
      const arg =
        a.id === "queue-drain"
          ? "exo-agent:queue-drain"
          : a.id === "queue-new"
            ? "exo-agent:queue-new-request"
            : a.id === "automations"
              ? "exo-agent:automations"
              : "exo-agent:run-playbook";
      rows.push({ label: a.label, ...(a.badge ? { badge: a.badge } : {}), action: { kind: "command", arg } });
    }
    const card = this.tile(grid, "Autonomy", "bot", rows);
    if (!card) return;
    // Status lines above the actions: queue · schedules · budget.
    const statusHost = card.createDiv({ cls: "mva-ck-status" });
    for (const st of autonomyStatuses(input)) {
      statusHost.createDiv({ cls: "mva-ck-row-sub", text: `${st.label}: ${st.value}` });
    }
    statusHost.createDiv({
      cls: "mva-ck-row-sub",
      text: `Budget: ${formatBudget(s.backgroundBudgetLedger, s.backgroundDailyTokenBudget, now)}`,
    });
    card.querySelector(".mva-ck-card-head")?.after(statusHost);
  }

  /** System tile: MCP servers (live status), plan quota, automatic memory, auto-commit.
   *  Every row deep-links to Exo settings, so rows are built without actions
   *  and wired directly — not through `act()`. */
  private renderSystem(grid: HTMLElement): void {
    const s = this.plugin.settings;
    const card = grid.createDiv({ cls: "mva-ck-card" });
    const head = card.createDiv({ cls: "mva-ck-card-head" });
    setIcon(head.createSpan({ cls: "mva-ck-card-icon" }), "settings-2");
    head.createSpan({ cls: "mva-ck-card-title", text: "System" });
    const row = (label: string, sub: string, warn = false) => {
      const r = card.createDiv({ cls: "mva-ck-row" });
      r.createSpan({ cls: "mva-ck-row-label", text: label });
      if (warn) r.createSpan({ cls: "mva-ck-badge", text: "!" });
      r.createDiv({ cls: "mva-ck-row-sub", text: sub });
      clickable(r, () => this.openSettings());
    };
    const servers = this.plugin.lastSessionCaps?.mcpServers ?? [];
    if (!servers.length) card.createDiv({ cls: "mva-ck-empty", text: "MCP status appears after the first session." });
    for (const m of servers) row(m.name, m.status, m.status !== "connected");
    const quota = quotaValue(this.plugin.lastRateLimit);
    if (quota) row("Plan quota", quota);
    row("Automatic memory", this.plugin.memoryCaps().autoCapture ? "on" : "off");
    row("Auto-commit", s.vaultAutoCommit ? "on" : "off");
  }
}
