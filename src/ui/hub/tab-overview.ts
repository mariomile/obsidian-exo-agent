import { defaultModel } from "../../settings-schema";
import { autonomyStatuses, autonomyActions, systemStatuses } from "../../core/actions-hub";
import { defaultRows, thisChatRows, type SummaryRow } from "../../core/session-summary";
import * as convoBridge from "../convo-bridge";
import { clickable } from "../dom";
import { buildGroupHeader, buildStatusRow, buildRowScaffold, openExoSettings, runCommand, type HubTabContext } from "./shared";

/**
 * Overview tab: the open chat and the system at a glance. Read-only status
 * rows (values change in settings, never here) plus the queue's action rows,
 * which have no other home. "This chat" is what the open chat runs with;
 * "Defaults" is what a new chat starts from (core/session-summary).
 */
export async function renderOverviewTab(host: HTMLElement, ctx: HubTabContext): Promise<void> {
  host.empty();
  const s = ctx.plugin.settings;
  const now = Date.now();

  const [queuePending, lastCommit] = await Promise.all([
    ctx.plugin.countQueuePending().catch(() => null),
    ctx.plugin.lastAutoCommitEpoch().catch(() => null),
  ]);

  const rows = (list: SummaryRow[]) => {
    for (const r of list) host.appendChild(buildStatusRow(r.label, r.value, r.ok));
  };

  // This chat: the open chat's own session, MCP status included (the caps its
  // session reported at init). The chat view repaints this tab on a switch.
  host.appendChild(buildGroupHeader("This chat"));
  const chat = convoBridge.sessionSnapshot(ctx.app);
  if (chat) rows(thisChatRows(chat));
  else host.createDiv({ cls: "mva-conn-empty", text: "Open a chat to see its session." });

  // Defaults: what a new chat starts from.
  host.appendChild(buildGroupHeader("Defaults"));
  rows(defaultRows({
    provider: s.provider,
    model: defaultModel(s, s.provider),
    effort: s.effort,
    permissionMode: s.permissionMode,
    toolsEnabled: s.toolsEnabled,
    fastStartup: s.fastStartup,
    permAllowRules: s.permAllowRules,
  }));

  // System — read-only status + deep-link to settings (never a toggle).
  host.appendChild(buildGroupHeader("System"));
  const sys = systemStatuses({
    vaultAutoCommit: s.vaultAutoCommit,
    lastAutoCommitEpoch: lastCommit,
    autoCapture: ctx.plugin.memoryCaps().autoCapture,
    now,
  });
  for (const st of sys) {
    const row = buildStatusRow(st.label, st.value, st.enabled);
    const btn = row.querySelector(".mva-conn-actions")!.createSpan({ cls: "mva-btn", text: "Settings" });
    clickable(btn, () => openExoSettings(ctx));
    host.appendChild(row);
  }

  // Autonomy — queue status + the verbs that drive it. The Automations status
  // row is omitted here: it has its own tab.
  const autonomyInput = {
    exoQueueEnabled: s.exoQueueEnabled,
    queuePending,
    automations: s.automations ?? [],
    scheduledLastRun: s.scheduledLastRun ?? {},
    hasPlaybooks: (s.customPrompts ?? []).length > 0,
    now,
  };
  host.appendChild(buildGroupHeader("Exo Queue", queuePending ?? undefined));
  const queueStatus = autonomyStatuses(autonomyInput).find((st) => st.id === "queue");
  if (queueStatus) host.appendChild(buildStatusRow(queueStatus.label, queueStatus.value, queueStatus.enabled));
  const handler: Record<string, () => void> = {
    "queue-drain": () => runCommand(ctx, "exo-agent:queue-drain"),
    "queue-new": () => runCommand(ctx, "exo-agent:queue-new-request"),
    "run-playbook": () => runCommand(ctx, "exo-agent:run-playbook"),
  };
  for (const a of autonomyActions(autonomyInput)) {
    if (a.id === "automations") continue; // its own tab
    const { row, right } = buildRowScaffold(a.label, undefined, a.hint);
    const btn = right.createSpan({ cls: "mva-btn", text: a.badge ? `Run · ${a.badge}` : "Run" });
    if (a.enabled) clickable(btn, handler[a.id]);
    else {
      btn.addClass("is-disabled");
      btn.setAttrs({ role: "button", "aria-disabled": "true" });
    }
    host.appendChild(row);
  }
}
