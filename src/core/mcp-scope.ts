/**
 * Which MCP servers an automation run may load (pure, no Obsidian).
 *
 * An automation's `mcp:` line names the servers it needs, as the CLI names
 * them (`claude.ai Gmail`, `perplexity`, `plugin:pdf-viewer:pdf`). Absent =
 * the global setting decides; `[]` = no external server, only Exo's own
 * `obsidian` tools.
 *
 * Enforcement has two layers, because the CLI has no "load only these" switch
 * that covers claude.ai connectors (its `allowedMcpServers` policy drops every
 * connector whatever the name, measured on CLI 2.1.293):
 *  1. `deniedMcpServers` for every OTHER server Exo has seen, so they never
 *     load and their tools never reach the context;
 *  2. a tool-call gate, so a server Exo has not seen yet (new connector,
 *     another machine) still cannot be used even though it loaded.
 */

/** The tool-name prefix the CLI gives a server's tools. */
export function serverToolPrefix(server: string): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_]+/g, "_")}__`;
}

const OWN_SERVER = "obsidian";

/** Servers to deny so only `allowed` (plus Exo's own) load. Case-insensitive. */
export function mcpDenyList(known: readonly string[], allowed: readonly string[]): string[] {
  const keep = new Set([...allowed, OWN_SERVER].map((s) => s.toLowerCase()));
  return [...new Set(known)].filter((s) => !keep.has(s.toLowerCase()));
}

/** May a run scoped to `allowed` call this tool? Built-ins and Exo's own tools
 *  always pass; an MCP tool passes only when its server is in the list. */
export function toolInMcpScope(tool: string, allowed: readonly string[] | undefined): boolean {
  if (!allowed || !tool.startsWith("mcp__")) return true;
  const lower = tool.toLowerCase();
  return [OWN_SERVER, ...allowed].some((s) => lower.startsWith(serverToolPrefix(s).toLowerCase()));
}

/** Names in `wanted` no known server has: worth a warning, never a refusal
 *  (the server may exist on another machine). */
export function unknownMcpNames(wanted: readonly string[], known: readonly string[]): string[] {
  const have = new Set(known.map((s) => s.toLowerCase()));
  return wanted.filter((s) => !have.has(s.toLowerCase()));
}

/** Fold the servers a session reported into the remembered roster. Returns
 *  null when nothing new was seen, so the caller can skip a settings write. */
export function rememberMcpServers(known: readonly string[], seen: readonly string[]): string[] | null {
  const have = new Set(known);
  const fresh = seen.filter((s) => s && s !== OWN_SERVER && !have.has(s));
  return fresh.length ? [...known, ...fresh].sort((a, b) => a.localeCompare(b)) : null;
}
