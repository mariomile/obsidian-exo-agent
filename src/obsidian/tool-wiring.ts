/**
 * How one session's Obsidian tools reach its provider, decided by the
 * provider profile (`toolWiring`) instead of a claude/codex branch at each
 * spawn site. Chat and headless runs share it; each supplies its own tool
 * list and its own bridge lease.
 *
 * SANDBOX HONESTY: bridge tool handlers run in the Obsidian process, outside
 * any CLI sandbox, so the caller's `bridgeTools` must already be narrowed to
 * what the session may do.
 */
import type { ProviderId, SessionOpts } from "../providers/types";
import { PROFILES } from "../providers/profiles";
import type { AnyTool } from "./sdk-tool";
import type { BridgeLease, McpBridgeHost } from "./mcp-bridge-host";

export interface WiredTools {
  /** In-process MCP server (in-process providers only). */
  obsidianServer?: unknown;
  /** Loopback bridge coordinates (bridge providers only). */
  mcpBridge?: SessionOpts["mcpBridge"];
}

export async function wireProviderTools(o: {
  provider: ProviderId;
  /** Obsidian tools on for this session at all. */
  enabled: boolean;
  /** Build the in-process server (fresh per session: it binds to one transport). */
  inProcess: () => unknown;
  /** The bridge's tool list, already narrowed for the session. */
  bridgeTools: () => AnyTool[];
  /** Reserve a bridge; null when unavailable. The session releases it. */
  lease: () => Promise<BridgeLease | null | undefined>;
  /** For the `node` preflight a stdio relay needs. */
  host?: McpBridgeHost;
  pathEnv?: string;
}): Promise<WiredTools> {
  if (!o.enabled) return {};
  const profile = PROFILES[o.provider];
  if (profile.toolWiring === "in-process") return { obsidianServer: o.inProcess() };
  if (profile.toolWiring === "bridge-stdio" && o.host && !(await o.host.checkNode(o.pathEnv ?? "", profile.label))) {
    return {};
  }
  const b = await o.lease();
  if (!b) return {};
  b.bridge.setTools(o.bridgeTools());
  return {
    mcpBridge: { port: b.bridge.port, token: b.bridge.token, scriptPath: b.scriptPath, stop: b.release },
  };
}
