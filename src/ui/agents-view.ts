/**
 * Agents pane — one row per named agent: who it is, whether it is on, what may
 * wake it, what it may touch, and when it last ran.
 *
 * The pane exists to answer one question at a glance: *what will happen without
 * me asking?* Everything on a row is chosen for that — the autonomy tier and
 * the trigger list are as prominent as the name, and an agent that can write
 * says so before you have to open anything.
 *
 * Same one-way contract as the cockpit: this module imports from main/view;
 * `view.ts` never imports it.
 */
import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type ExoPlugin from "../main";
import { clickable } from "./dom";
import { triggerLabel, formatDuration, type AgentDef } from "../core/agents";
import { contractFromAutomation } from "../core/automation-model";
import { agentLastRunKey, nextScheduledSlot, writeModeFor } from "../core/agent-runs";
import { runsForAgent, type AgentRunRecord } from "../core/agent-ledger";

export const AGENTS_VIEW_TYPE = "exo-agents";
export const AGENTS_ICON = "bot";

/** "in 3h" / "due now" / "—" — the pane's twin of the Cockpit's formatter. */
function fmtIn(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 60_000) return "due now";
  const HOUR = 3_600_000;
  if (ms < HOUR) return `in ${Math.floor(ms / 60_000)}m`;
  if (ms < 24 * HOUR) return `in ${Math.floor(ms / HOUR)}h`;
  return `in ${Math.floor(ms / (24 * HOUR))}d`;
}

function fmtAgo(at: number, now: number): string {
  if (!at) return "never";
  const ms = now - at;
  if (ms < 60_000) return "just now";
  const HOUR = 3_600_000;
  if (ms < HOUR) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 24 * HOUR) return `${Math.floor(ms / HOUR)}h ago`;
  return `${Math.floor(ms / (24 * HOUR))}d ago`;
}

export class AgentsView extends ItemView {
  private rendering = false;
  private expanded = new Set<string>();
  private runs: AgentRunRecord[] = [];

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: ExoPlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return AGENTS_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Exo Agents";
  }
  getIcon(): string {
    return AGENTS_ICON;
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("mva-ag");
    await this.refresh();
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf === this.leaf) void this.refresh();
      })
    );
  }

  /** Rebuild from the registry and the current month's ledger. Re-entrant-safe. */
  async refresh(): Promise<void> {
    if (this.rendering) return;
    this.rendering = true;
    try {
      const enabled = await this.plugin.agentsReady();
      this.runs = enabled ? await this.plugin.agentStore.readRuns() : [];
      this.render(enabled);
    } finally {
      this.rendering = false;
    }
  }

  /* ------------------------------- render ------------------------------ */

  private render(enabled: boolean): void {
    const el = this.contentEl;
    el.empty();

    const head = el.createDiv({ cls: "mva-ag-head" });
    head.createDiv({ cls: "mva-ag-title", text: "Agents" });
    const refreshBtn = head.createDiv({ cls: "mva-ag-action", attr: { "aria-label": "Refresh" } });
    setIcon(refreshBtn, "refresh-cw");
    clickable(refreshBtn, () => void this.refresh());

    if (!enabled) {
      this.renderEmpty(el, "Named agents are off.", "Turn them on in Exo settings to see and schedule your agents.");
      return;
    }

    const agents = this.plugin.agentStore.list();
    const own = agents.filter((a) => a.brain.source === "vault" || a.brain.source === "user");
    if (!own.length) {
      this.renderEmpty(el, "No agents yet.", "A canonical vault agent is a bundle in `_system/agents/<slug>/`. Add one and refresh.");
      return;
    }

    // Own agents first and in full; installed-plugin agents are callable but not
    // configurable, so they are a count, not a list of a hundred rows.
    const list = el.createDiv({ cls: "mva-ag-list" });
    for (const agent of own) this.renderRow(list, agent);

    const plugins = agents.length - own.length;
    if (plugins > 0) {
      el.createDiv({
        cls: "mva-ag-foot",
        text: `+ ${plugins} agents from installed plugins — callable with @, not schedulable.`,
      });
    }

    const conflicts = this.plugin.agentStore.conflicts();
    for (const c of conflicts) {
      const warn = el.createDiv({ cls: "mva-ag-warn" });
      warn.createSpan({ text: `${c.path} is not an agent contract — left untouched.` });
    }
  }

  private renderEmpty(el: HTMLElement, title: string, body: string): void {
    const empty = el.createDiv({ cls: "mva-ag-empty" });
    empty.createDiv({ cls: "mva-ag-empty-title", text: title });
    empty.createDiv({ cls: "mva-ag-empty-body", text: body });
  }

  private renderRow(list: HTMLElement, agent: AgentDef): void {
    const { brain } = agent;
    // Since v2 the contract sidecars are gone: what this row shows is the
    // agent's automation file, when one binds it — else the inert default.
    const auto = this.plugin.automationStore.list().find((x) => x.agent === brain.slug);
    const contract = auto ? contractFromAutomation(auto) : agent.contract;
    const now = Date.now();
    const row = list.createDiv({ cls: "mva-ag-row" });
    row.toggleClass("is-off", !contract.enabled);

    const top = row.createDiv({ cls: "mva-ag-top" });
    const icon = top.createSpan({ cls: "mva-ag-icon" });
    setIcon(icon, contract.icon || AGENTS_ICON);

    const main = top.createDiv({ cls: "mva-ag-main" });
    const nameRow = main.createDiv({ cls: "mva-ag-name-row" });
    nameRow.createSpan({ cls: "mva-ag-name", text: brain.name });
    // The tier is the row's most consequential fact, so it sits next to the name.
    const tier = nameRow.createSpan({ cls: "mva-ag-tier", text: contract.autonomy });
    tier.toggleClass("is-write", writeModeFor(contract.autonomy));
    if (brain.description) main.createDiv({ cls: "mva-ag-desc", text: brain.description });

    const meta = main.createDiv({ cls: "mva-ag-meta" });
    const triggers = contract.triggers.length
      ? contract.triggers.map(triggerLabel).join(" · ")
      : "no triggers — manual only";
    meta.createSpan({ cls: "mva-ag-triggers", text: triggers });

    const lastRunAt = this.plugin.settings.scheduledLastRun[agentLastRunKey(brain.slug)] ?? 0;
    meta.createSpan({ cls: "mva-ag-sep", text: "·" });
    meta.createSpan({ text: `last ${fmtAgo(lastRunAt, now)}` });

    const schedule = contract.triggers.find((t) => t.on === "schedule");
    if (schedule?.on === "schedule" && contract.enabled) {
      meta.createSpan({ cls: "mva-ag-sep", text: "·" });
      meta.createSpan({ text: `next ${fmtIn(nextScheduledSlot(schedule.cadence, lastRunAt, now) - now)}` });
    }
    if (contract.cooldownMs) {
      meta.createSpan({ cls: "mva-ag-sep", text: "·" });
      meta.createSpan({ text: `cooldown ${formatDuration(contract.cooldownMs)}` });
    }

    const actions = top.createDiv({ cls: "mva-ag-actions" });
    const toggle = actions.createDiv({
      cls: "mva-ag-toggle",
      attr: { role: "button", tabindex: "0", "aria-pressed": String(contract.enabled) },
    });
    toggle.toggleClass("is-on", contract.enabled);
    toggle.setAttribute("aria-label", contract.enabled ? "Disable agent" : "Enable agent");
    clickable(toggle, () => void this.toggle(agent));

    const runBtn = actions.createDiv({ cls: "mva-ag-action", attr: { "aria-label": "Run now" } });
    setIcon(runBtn, "play");
    clickable(runBtn, () => void this.runNow(agent));

    if (brain.path) {
      const openBtn = actions.createDiv({ cls: "mva-ag-action", attr: { "aria-label": "Open definition" } });
      setIcon(openBtn, "file-text");
      clickable(openBtn, () => void this.openDefinition(agent));
    }

    const warnings = this.plugin.agentStore.warningsFor(brain.slug);
    for (const w of warnings) row.createDiv({ cls: "mva-ag-warn", text: w });

    const history = runsForAgent(this.runs, brain.slug);
    if (!history.length) return;

    const toggleHistory = row.createDiv({ cls: "mva-ag-history-toggle" });
    const open = this.expanded.has(brain.slug);
    toggleHistory.setText(open ? `Hide ${history.length} runs` : `${history.length} runs this month`);
    clickable(toggleHistory, () => {
      if (this.expanded.has(brain.slug)) this.expanded.delete(brain.slug);
      else this.expanded.add(brain.slug);
      void this.refresh();
    });
    if (!open) return;

    const hist = row.createDiv({ cls: "mva-ag-history" });
    for (const run of history.slice(0, 20)) {
      const line = hist.createDiv({ cls: "mva-ag-run" });
      line.toggleClass("is-failed", run.outcome !== "ok");
      line.createSpan({ cls: "mva-ag-run-when", text: new Date(run.startedAt).toLocaleString() });
      line.createSpan({ cls: "mva-ag-run-trigger", text: run.trigger });
      if (run.by !== "exo") line.createSpan({ cls: "mva-ag-run-by", text: `via ${run.by}` });
      if (run.writes.length) line.createSpan({ cls: "mva-ag-run-writes", text: `${run.writes.length} writes` });
      if (run.report) {
        const openReport = line.createSpan({ cls: "mva-ag-run-open", text: "report" });
        clickable(openReport, () => void this.app.workspace.openLinkText(run.report!, "", "tab"));
      }
      // Restore lives here, next to the run that did the writing — it existed
      // before, but only inside the Automations modal, which is not where anyone
      // looks after reading "3 writes" on an agent's run.
      if (run.restoreId && run.writes.length) {
        const restore = line.createSpan({ cls: "mva-ag-run-restore", text: "restore" });
        // Two-step, matching the touched-notes revert: an agent write is
        // reversible, but reversing it overwrites whatever is there NOW, which
        // may include edits made since. One click should not do that.
        let armed = false;
        clickable(restore, () => {
          if (!armed) {
            armed = true;
            restore.setText("confirm?");
            restore.addClass("is-armed");
            window.setTimeout(() => {
              if (!armed) return;
              armed = false;
              restore.setText("restore");
              restore.removeClass("is-armed");
            }, 4000);
            return;
          }
          armed = false;
          void this.restore(run);
        });
      }
    }
  }

  /* ------------------------------ actions ------------------------------ */

  private async toggle(agent: AgentDef): Promise<void> {
    // Autonomy lives in the automation file since v2 — the toggle pauses or
    // resumes the agent's automation. An unbound agent has nothing to toggle.
    const auto = this.plugin.automationStore.list().find((a) => a.agent === agent.brain.slug);
    if (!auto) {
      new Notice(`${agent.brain.name} has no automation — it only runs when you ask. Create one in the Capabilities hub.`);
      return;
    }
    await this.plugin.automationStore.save({ ...auto, enabled: !auto.enabled });
    await this.refresh();
  }

  /** Roll a write run back to its pre-run snapshot. `restoreAutomationRun`
   *  reports the outcome itself, so this only has to refresh afterwards. */
  private async restore(run: AgentRunRecord): Promise<void> {
    if (!run.restoreId) return;
    await this.plugin.restoreAutomationRun(run.restoreId);
    await this.refresh();
  }

  private async runNow(agent: AgentDef): Promise<void> {
    const result = await this.plugin.invokeAgentFromAgent(agent.brain.slug, "Do your standing job.");
    new Notice(result);
    await this.refresh();
  }

  private async openDefinition(agent: AgentDef): Promise<void> {
    const path = agent.brain.path;
    if (!path) return;
    // Vault-relative for a vault agent; anything else lives outside the vault.
    if (path.startsWith(".claude/")) await this.app.workspace.openLinkText(path, "", "tab");
    else new Notice(`Defined outside the vault: ${path}`);
  }
}
