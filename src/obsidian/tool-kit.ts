import type { Automation } from "../core/automation-model";
import type { App } from "obsidian";
import type { AutomationConfig, AutomationRunRecord } from "../core/automations";
import type { AgentDef } from "../core/agents";
import type { AgentCaller } from "../core/agent-runs";
import type { ChatRecord } from "../core/recent-chats";

/** The shape every in-process tool returns. Free-form human-readable text —
 *  the agent reads it, not a parser. */
export type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

export const ok = (text: string): Result => ({ content: [{ type: "text", text }] });
export const err = (text: string): Result => ({ content: [{ type: "text", text }], isError: true });

/** The slice of the exo plugin the self-management tools use — resolved live
 *  from app.plugins (same cross-plugin convention as getSonar; here it's our
 *  own plugin, reached this way to avoid a tools→main import cycle). */
export interface ExoToolHost {
  settings: {
    automations: AutomationConfig[];
    customPrompts: { name: string; prompt: string }[];
    scheduledLastRun: Record<string, number>;
    claudeBin: string;
    /** Exo Collabo service coordinates and the note-to-document registry.
     *  Read here rather than threaded from view.ts: the Collabo bridge is
     *  stateless, so there is nothing to curry per conversation. */
    collaboUrl: string;
    collaboApiKey: string;
    collaboShares: Record<string, { slug: string; ownerSecret: string; accessToken: string; role: string }>;
  };
  saveSettings(): Promise<void>;
  loadAutomationRuns(): Promise<AutomationRunRecord[]>;
  restoreAutomationRun(id: string): Promise<string[]>;
  markAutomationRunReviewed(id: string): Promise<void>;
  runPlaybook(name: string, prompt: string, opts?: { write?: boolean; slug?: string }): Promise<boolean>;
  /** Unified automation files — the store behind the Automations tab. */
  automationStore: {
    list(): Automation[];
    get(slug: string): Automation | null;
    errors(): { slug: string; problem: string }[];
    save(a: Automation): Promise<void>;
    archive(slug: string): Promise<void>;
    filePath(slug: string): string;
  };
  /** Manual run of one automation through the shared executor. */
  runAutomationNow(a: Automation): Promise<{ ok: boolean; refused?: string }>;
  /** Resolves false when named agents are disabled in settings. */
  agentsReady(): Promise<boolean>;
  agentStore: {
    list(): AgentDef[];
    orphans(): string[];
    resolve(query: string): AgentDef | null;
  };
  /** Delegate to another agent; resolves to a human-readable result or refusal. */
  invokeAgentFromAgent(target: string, task: string, caller: AgentCaller): Promise<string>;
  /** Re-render any open Agents pane after a contract change. */
  refreshAgentsUI(): Promise<void>;
  /** Live capability snapshot from the session's system/init (null pre-spawn
   *  and on Codex — capability tools fall back to disk scans). */
  lastSessionCaps: {
    skills: string[];
    commands: string[];
    agents: string[];
    tools: string[];
    mcpServers: { name: string; status: string }[];
  } | null;
  /** Respawn the active session so .mcp.json edits take effect immediately. */
  reloadMcpConnections(): Promise<{ ok: boolean; error?: string }>;
  /** Re-render any open Capabilities hub leaf, so a chat-driven change shows
   *  up in the pane without a manual refresh. */
  refreshHub(): void;
  /** Every conversation (current + archive): the live view's when mounted,
   *  else the stores on disk. Read-only. */
  readConversationStore(): Promise<ChatRecord[]>;
  /** Revert a memory harvest (latest when `sha` is absent). */
  undoMemoryWrite(sha?: string): Promise<{ ok: boolean; message: string }>;
}

/** Another plugin's live instance by id, or undefined when it is absent or
 *  disabled. `app.plugins` is not in Obsidian's public typings; this is the one
 *  place that reaches into it. Callers duck-type the result. */
export function pluginInstance(app: App, id: string): unknown {
  return (app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins?.plugins?.[id];
}

export function getExo(app: App): ExoToolHost | null {
  const p = pluginInstance(app, "exo-agent") as Partial<ExoToolHost> | undefined;
  return p && typeof p.loadAutomationRuns === "function" && typeof p.runPlaybook === "function"
    ? (p as ExoToolHost)
    : null;
}

/** Vault base path on disk, or "" on adapters without one (mobile). */
export function vaultBasePath(app: App): string {
  return (app.vault.adapter as unknown as { getBasePath?(): string }).getBasePath?.() ?? "";
}
