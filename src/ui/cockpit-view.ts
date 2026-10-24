/**
 * Exo Cockpit — the control-center home surface (spec 2026-07-13). A main-pane
 * ItemView: attention strip (what waits for YOU), command bar (type → chat),
 * and five action-first tiles (Loops, Autonomy, System, Resume, Health).
 * One-way contract: this module imports from main/view; `view.ts` never
 * imports it.
 *
 * All gathering is tolerant — a missing file yields that tile's empty state,
 * never a blocked render. Refresh: on-open, manual button, and a plain 60s
 * interval (deliberately NOT rAF-gated — idle-pane starvation).
 */
import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type ExoPlugin from "../main";
import { clickable } from "./dom";
import {
  buildAttention,
  loopRows,
  resumeRows,
  previewFromMessages,
  healthRows,
  quotaValue,
  parseAnsweredStamp,
  type AttentionItem,
  type CockpitRow,
  type StateNote,
} from "../core/cockpit";
import { blockPath } from "../obsidian/agent-folder";
import { parseLoopsFile } from "../core/open-loops";
import { unreviewedWriteRuns } from "../core/automations";
import { dailyPulseNeedsReview } from "../core/daily-pulse";
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
const ATTENTION_ICONS: Record<AttentionItem["kind"], string> = {
  blocked: "shield-alert",
  pulse: "sunrise",
  streaming: "loader",
  runs: "file-diff",
  answer: "mail-check",
};

export class CockpitView extends ItemView {
  private refreshedAt = 0;
  private rendering = false;
  private refreshRequested = false;
  private inputEl: HTMLInputElement | null = null;

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
  }

  /* ------------------------------ actions ------------------------------ */

  private act(a: CockpitRow["action"]): void {
    if (a.kind === "ask") void this.plugin.askExo(a.arg, false);
    else if (a.kind === "convo") void this.plugin.openConvo(a.arg);
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

  /** Queue notes answered recently (attention strip). Bounded scan. */
  private async recentAnswers(_now: number): Promise<{ path: string; name: string; answeredAt: number }[]> {
    const out: { path: string; name: string; answeredAt: number }[] = [];
    try {
      const res = await this.app.vault.adapter.list(this.plugin.settings.exoQueueFolder);
      for (const f of res.files.slice(0, 20)) {
        if (!f.endsWith(".md")) continue;
        const t = parseAnsweredStamp(await this.readOr(f, ""));
        if (t != null) out.push({ path: f, name: f.split("/").pop()!.replace(/\.md$/, ""), answeredAt: t });
      }
    } catch {
      /* no queue folder */
    }
    return out.sort((a, b) => b.answeredAt - a.answeredAt);
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
      const [loopsRaw, queuePending, answers, convos, inbox, stateNote, report, unreviewedRuns, proposalPending] =
        await Promise.all([
          this.readOr(this.plugin.paths.openLoops, ""),
          this.plugin.countQueuePending().catch(() => null),
          this.recentAnswers(now),
          this.plugin.loadConversations().catch(() => []),
          this.inboxCount(),
          this.stateNote(now),
          this.lastReport(),
          this.plugin
            .loadAutomationRuns()
            .then((rs) => unreviewedWriteRuns(rs).length)
            .catch(() => 0),
          this.plugin.settings.proposalKernelEnabled
            ? this.plugin.listPendingProposals().then(({ records }) => records.length).catch(() => 0)
            : Promise.resolve(0),
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

      // Attention strip (only when non-empty)
      const pulseState = this.plugin.settings.dailyPulseReviewState;
      const attention = buildAttention({
        convos: (this.plugin.listChatRows() ?? []).map((r) => ({
          id: r.id,
          title: r.title,
          blocked: r.pendingPerm || r.pendingAsk,
          streaming: r.streaming,
        })),
        answers,
        unreviewedRuns,
        dailyPulseItems: dailyPulseNeedsReview(pulseState) ? pulseState.itemCount : 0,
        now,
      });
      if (attention.length || proposalPending > 0) this.renderAttention(el, attention, proposalPending);

      // Command bar
      this.renderCommandBar(el);
      if (this.inputEl) {
        this.inputEl.value = draft;
        if (hadFocus) this.inputEl.focus();
      }

      // Tile grid
      const grid = el.createDiv({ cls: "mva-ck-grid" });

      const loops = loopRows(parseLoopsFile(loopsRaw), now);
      this.tile(grid, "Loops", "target", loops, "No open loops.", {
        label: "open-loops.md",
        onClick: () => void this.app.workspace.openLinkText(this.plugin.paths.openLoops, "", "tab"),
      });

      this.renderAutonomy(grid, queuePending, now);
      this.renderSystem(grid);

      const resume = resumeRows(
        (convos as { id: string; title: string; updatedAt?: number; messages?: unknown[] }[]).map((c) => ({
          id: c.id,
          title: c.title,
          updatedAt: c.updatedAt,
          preview: previewFromMessages((c.messages ?? []) as Parameters<typeof previewFromMessages>[0]),
        })),
        now
      );
      this.tile(grid, "Resume", "history", resume, "No recent conversations.");

      const health = healthRows({
        inboxCount: inbox,
        stateNote,
        lastReport: report,
        now,
      });
      this.tile(grid, "Health", "heart-pulse", health, "Vault is healthy.");
    } finally {
      this.rendering = false;
      if (this.refreshRequested) {
        this.refreshRequested = false;
        void this.refresh();
      }
    }
  }

  private renderAttention(parent: HTMLElement, items: AttentionItem[], proposalPending: number): void {
    const strip = parent.createDiv({ cls: "mva-ck-attention" });
    for (const it of items) {
      const row = strip.createDiv({ cls: `mva-ck-att is-${it.kind}` });
      setIcon(row.createSpan({ cls: "mva-ck-att-icon" }), ATTENTION_ICONS[it.kind]);
      row.createSpan({ text: it.label });
      clickable(row, () => {
        if (it.kind === "pulse") void this.plugin.openDailyPulse();
        else if (it.kind === "answer") void this.app.workspace.openLinkText(it.target, "", "tab");
        else if (it.kind === "runs") void this.plugin.activateHub("automations");
        else if (it.kind === "blocked" || it.kind === "streaming") {
          void this.plugin.openConvo(it.target);
        }
      });
    }
    if (proposalPending > 0) {
      const row = strip.createDiv({ cls: "mva-ck-att is-proposal" });
      setIcon(row.createSpan({ cls: "mva-ck-att-icon" }), "lightbulb");
      row.createSpan({ text: `${proposalPending} suggestion${proposalPending === 1 ? "" : "s"}` });
      clickable(row, () => void this.plugin.openProposalsModal());
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

  private tile(
    grid: HTMLElement,
    title: string,
    icon: string,
    rows: CockpitRow[],
    emptyText: string,
    footer?: { label: string; onClick: () => void }
  ): HTMLElement {
    const card = grid.createDiv({ cls: "mva-ck-card" });
    const head = card.createDiv({ cls: "mva-ck-card-head" });
    setIcon(head.createSpan({ cls: "mva-ck-card-icon" }), icon);
    head.createSpan({ cls: "mva-ck-card-title", text: title });
    if (!rows.length) {
      card.createDiv({ cls: "mva-ck-empty", text: emptyText });
    } else {
      for (const r of rows) {
        const row = card.createDiv({ cls: "mva-ck-row" });
        row.createSpan({ cls: "mva-ck-row-label", text: r.label });
        if (r.badge) row.createSpan({ cls: "mva-ck-badge", text: r.badge });
        if (r.sub) row.createDiv({ cls: "mva-ck-row-sub", text: r.sub });
        clickable(row, () => this.act(r.action));
      }
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
    const card = this.tile(grid, "Autonomy", "bot", rows, "Queue off — enable it in settings.");
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
