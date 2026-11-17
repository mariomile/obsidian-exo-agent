/** Codex 0.147.0 gates EVERY MCP tool call behind an approval, and it delivers
 *  that approval on the `mcpServer/elicitation/request` channel: same method as
 *  a real elicitation form, but tagged `_meta.codex_approval_kind ===
 *  "mcp_tool_call"` and carrying an EMPTY `requestedSchema.properties`. Read as
 *  a form it has zero questions, and the zero-question branch answers
 *  `decline`, which codex reports as "user rejected MCP tool call". That one
 *  reply broke every Obsidian bridge tool on Codex.
 *
 *  This module decides what such a request is and which tool it is about, so
 *  the provider can hand it to Exo's ONE permission decision (`decidePermission`)
 *  instead of growing a second, codex-shaped rule set. */

import { INTERACTION_TOOLS } from "./bridge-toolset";

/** Bridge server name registered in `mcpOverride` (`mcp_servers.obsidian=…`).
 *  Bridge tools run inside the Obsidian process, so they bypass codex's own
 *  sandbox, which is why the read-only gate below is scoped to this server. */
export const OBSIDIAN_MCP_SERVER = "obsidian";

/** A codex `mcpToolCall` item that has started and not yet completed. */
export interface InFlightMcpCall {
  server: string;
  tool: string;
  args: unknown;
}

export type CodexElicitationRoute =
  /** A genuine elicitation form: keep the existing question/answer path. */
  | { kind: "form" }
  /** Fail CLOSED. Answer `decline`, as Exo accidentally always did. */
  | { kind: "decline"; reason: string }
  /** Hand to `decidePermission` as a normal tool permission request. */
  | { kind: "permission"; tool: string; input: unknown };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Key-order-independent value identity, so `{a,b}` matches `{b,a}`. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The tool name codex quotes in its own approval prompt ("…run tool "x"?").
 *  Only ever used to break a tie between candidates already in flight, never as
 *  a source of truth: message wording is UI text and can change without notice. */
function quotedToolName(message: unknown): string | null {
  const match = typeof message === "string" ? /"([^"]+)"/.exec(message) : null;
  return match ? match[1] : null;
}

/** An MCP tool-call approval, not an elicitation form. */
export function isMcpToolApproval(params: Record<string, unknown>): boolean {
  return record(params._meta).codex_approval_kind === "mcp_tool_call";
}

/** Which tool is being approved. The payload has no tool-name field, so this
 *  correlates the approval with the `mcpToolCall` item codex emits immediately
 *  before it (verified on the wire: item/started → approval → item/completed,
 *  ~50ms apart, and the call cannot complete before it is approved).
 *
 *  Same server + same arguments identifies the call even when several are in
 *  flight; the quoted name breaks a tie between two calls that share arguments.
 *  Anything still ambiguous returns null, and the caller declines. */
export function recoverApprovalTool(
  params: Record<string, unknown>,
  inFlight: Iterable<InFlightMcpCall>,
): string | null {
  const server = typeof params.serverName === "string" ? params.serverName : "";
  if (!server) return null;
  const candidates = [...inFlight].filter((call) => call.server === server);
  if (!candidates.length) return null;
  const toolParams = record(params._meta).tool_params;
  const wanted = canonical(toolParams);
  const byArgs = candidates.filter((call) => canonical(call.args) === wanted);
  // Arguments that name something and match NOTHING in flight are a
  // contradiction, not a missing signal: the approval belongs to a call this
  // process cannot see, and answering it would unblock that call under the
  // classification of the one it can. Decline instead. Absent or empty
  // `tool_params` (a tool called with no arguments) contradicts nothing, so the
  // single-candidate fallback still stands.
  if (!byArgs.length && Object.keys(record(toolParams)).length > 0) return null;
  const pool = byArgs.length ? byArgs : candidates;
  const names = new Set(pool.map((call) => call.tool));
  if (names.size === 1) return [...names][0];
  const quoted = quotedToolName(params.message);
  return quoted && names.has(quoted) ? quoted : null;
}

/** The single decision for anything arriving on `mcpServer/elicitation/request`. */
export function routeCodexElicitation(p: {
  params: Record<string, unknown>;
  inFlight: Iterable<InFlightMcpCall>;
  readOnlySandbox: boolean;
  /** OBSIDIAN_READ_TOOLS: fully-qualified `mcp__obsidian__*` names. */
  readTools: ReadonlySet<string>;
}): CodexElicitationRoute {
  if (!isMcpToolApproval(p.params)) return { kind: "form" };
  const tool = recoverApprovalTool(p.params, p.inFlight);
  if (!tool) return { kind: "decline", reason: "Exo could not tell which tool codex asked to approve." };
  const name = `mcp__${String(p.params.serverName)}__${tool}`;
  // ask_user is permitted in every sandbox mode: it mutates nothing, and it IS
  // the human-in-the-loop, so it needs no gate of its own (view.ts answers it
  // without a card: a permission card in front of a question card would be two
  // prompts for one human). Same list the sandbox toolset filter keeps.
  const bridge = p.params.serverName === OBSIDIAN_MCP_SERVER;
  if (bridge && INTERACTION_TOOLS.has(tool)) {
    return { kind: "permission", tool: name, input: record(p.params._meta).tool_params ?? {} };
  }
  if (p.readOnlySandbox && bridge && !p.readTools.has(name)) {
    return { kind: "decline", reason: `${tool} mutates the vault; the Codex sandbox is read-only.` };
  }
  return { kind: "permission", tool: name, input: record(p.params._meta).tool_params ?? {} };
}
