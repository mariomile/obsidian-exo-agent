/**
 * Capabilities Overview rows (Release 2), pure. The old "Session" block mixed
 * two different things under one heading: settings values that only say what
 * a NEW chat starts from, and live MCP status from whichever session last
 * connected. Split in two, each labelled for what it is: "This chat" (what the
 * open chat actually runs with) and "Defaults" (what the next one starts from).
 * No `obsidian` import.
 */

export interface SummaryRow {
  label: string;
  value: string;
  /** Drives the status dot; absent for a neutral, dotless value. */
  ok?: boolean;
}

/** The open chat as it runs: effort already resolved for its model. */
export interface ChatSession {
  provider: string;
  model: string;
  effort: string;
  /** Tools "Always allow"-ed in this chat only. */
  allowed: number;
  /** MCP servers as this chat's own session reported them; null until it has
   *  one (a chat restored from disk has not spawned yet). */
  mcp: readonly McpStatus[] | null;
}

export interface McpStatus {
  name: string;
  status: string;
}

export interface SessionDefaults {
  provider: string;
  model: string;
  effort: string;
  permissionMode: string;
  toolsEnabled: boolean;
  fastStartup: boolean;
  /** `settings.permAllowRules`: one rule per line, `#` comments. */
  permAllowRules: string;
}

/** Rule lines in a rules text, the way the permission matcher reads them. */
export function countRules(rules: string): number {
  return rules.split("\n").filter((raw) => {
    const line = raw.trim();
    return line !== "" && !line.startsWith("#");
  }).length;
}

/** "This chat". Before the chat's session reported its servers the MCP row is
 *  left out rather than shown as "0 connected". */
export function thisChatRows(chat: ChatSession): SummaryRow[] {
  const { mcp } = chat;
  const rows: SummaryRow[] = [
    { label: "Provider", value: chat.provider },
    { label: "Model", value: chat.model || "default" },
    { label: "Effort", value: chat.effort },
    { label: "Allowed in this chat", value: String(chat.allowed) },
  ];
  if (mcp) {
    const connected = mcp.filter((m) => m.status === "connected").length;
    const trouble = mcp.length - connected;
    rows.push({
      label: "MCP servers",
      value: trouble > 0 ? `${connected} connected · ${trouble} need attention` : `${connected} connected`,
      ok: trouble === 0 && mcp.length > 0,
    });
  }
  return rows;
}

/** "Defaults": what a new chat starts from. */
export function defaultRows(d: SessionDefaults): SummaryRow[] {
  return [
    { label: "Provider", value: d.provider },
    { label: "Default model", value: d.model || "default" },
    { label: "Effort", value: d.effort },
    { label: "Permissions", value: d.permissionMode },
    { label: "Agentic tools", value: d.toolsEnabled ? "on" : "off", ok: d.toolsEnabled },
    { label: "Fast startup", value: d.fastStartup ? "on" : "off", ok: d.fastStartup },
    { label: "Saved allow rules", value: String(countRules(d.permAllowRules)) },
  ];
}
