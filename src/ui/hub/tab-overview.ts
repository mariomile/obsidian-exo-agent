import { defaultModel } from "../../settings-schema";
import { autonomyStatuses, autonomyActions, systemStatuses } from "../../core/actions-hub";
import { buildGroupHeader, buildStatusRow, buildRowScaffold, openExoSettings, runCommand, type HubTabContext } from "./shared";

/**
 * Overview tab — the session and system at a glance. Read-only status rows
 * (values change in settings, never here) plus the queue's action rows, which
 * have no other home. Renders sensibly with no live session (settings-derived
 * values + a quiet "no session yet" note).
 */
export async function renderOverviewTab(host: HTMLElement, ctx: HubTabContext): Promise<void> {
  host.empty();
  const s = ctx.plugin.settings;
  const caps = ctx.plugin.lastSessionCaps;
  const now = Date.now();

  const [queuePending, lastCommit] = await Promise.all([
    ctx.plugin.countQueuePending().catch(() => null),
    ctx.plugin.lastAutoCommitEpoch().catch(() => null),
  ]);

  // Session
  host.appendChild(buildGroupHeader("Session"));
  if (!caps) {
    host.createDiv({ cls: "mva-conn-empty", text: "No session yet — values below come from settings; open a chat to connect." });
  }
  const model = defaultModel(s, s.provider);
  host.appendChild(buildStatusRow("Provider", s.provider));
  host.appendChild(buildStatusRow("Model", model || "default"));
  host.appendChild(buildStatusRow("Effort", s.effort));
  host.appendChild(buildStatusRow("Permissions", s.permissionMode));
  host.appendChild(buildStatusRow("Agentic tools", s.toolsEnabled ? "on" : "off", s.toolsEnabled));
  host.appendChild(buildStatusRow("Fast startup", s.fastStartup ? "on" : "off", s.fastStartup));
  if (caps) {
    const mcp = caps.mcpServers ?? [];
    const connected = mcp.filter((m) => m.status === "connected").length;
    const trouble = mcp.length - connected;
    host.appendChild(buildStatusRow(
      "MCP servers",
      trouble > 0 ? `${connected} connected · ${trouble} need attention` : `${connected} connected`,
      trouble === 0 && mcp.length > 0
    ));
  }

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
    const btn = row.querySelector(".mva-conn-actions")!.createEl("button", { cls: "mva-btn", text: "Settings" });
    btn.onclick = () => openExoSettings(ctx);
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
    const btn = right.createEl("button", { cls: "mva-btn", text: a.badge ? `Run · ${a.badge}` : "Run" });
    if (a.enabled) btn.onclick = handler[a.id];
    else btn.setAttr("disabled", "true");
    host.appendChild(row);
  }
}
