/**
 * The config Exo injects into its own `opencode acp` process through
 * `OPENCODE_CONFIG_CONTENT`. It merges ABOVE the user's opencode.json (their
 * providers, models and MCP servers stay) and below managed settings, and it
 * only reaches this private process — never the user's files or their shared
 * background service. Pure, so every mode is snapshot-tested.
 *
 * Keys verified against opencode v2.2.6 (`opencode debug config`, 2026-11-08):
 * snapshots, formatter, lsp, update, share, instructions, compaction.auto,
 * permissions (ordered rules, last match wins), mcp.servers.<name> with
 * type "remote", url, headers and timeout.{startup,execution}.
 */
import type { PermissionMode } from "./types";

export interface OpencodeConfigInput {
  toolsEnabled: boolean;
  permissionMode: PermissionMode;
  /** Per-session instructions file (house rules, system prompt, memory). */
  instructions: string[];
  /** The loopback Obsidian tools bridge, reached over MCP-over-HTTP. */
  bridge?: { port: number; token: string };
  autoCompact: boolean;
}

/** Tools that change nothing and only keep the agent organised. */
const ALWAYS_ALLOWED = ["todowrite", "todoread", "question"];

export function buildOpencodeConfig(o: OpencodeConfigInput): Record<string, unknown> {
  return {
    // A vault is notes, not a repo: no git snapshot of it on every step, no
    // prettier pass over .md files, no language servers.
    snapshots: false,
    formatter: false,
    lsp: false,
    update: "disable",
    share: "disabled",
    ...(o.instructions.length ? { instructions: o.instructions } : {}),
    compaction: { auto: o.autoCompact },
    permissions: permissionRules(o),
    ...(o.bridge && o.toolsEnabled
      ? {
          mcp: {
            servers: {
              obsidian: {
                type: "remote",
                // Off: Code Mode hides MCP tools behind one `execute` tool running
                // JS, so Exo would see (and ask about) opaque code instead of
                // `read_note` / `edit_note` — and could no longer auto-allow reads.
                codemode: false,
                url: `http://127.0.0.1:${o.bridge.port}/mcp`,
                headers: { Authorization: `Bearer ${o.bridge.token}` },
                // ask_user waits on a human: never time the call out early.
                timeout: { startup: 10_000, execution: 3_600_000 },
              },
            },
          },
        }
      : {}),
  };
}

/** opencode's own default allows nearly everything without asking. Exo asks
 *  for every call instead, so ONE policy decides — the same read auto-allow,
 *  allow/deny rules and permission cards a Claude session goes through. */
function permissionRules(o: OpencodeConfigInput): { action: string; resource: string; effect: string }[] {
  if (!o.toolsEnabled) return [{ action: "*", resource: "*", effect: "deny" }];
  if (o.permissionMode === "bypassPermissions") return [{ action: "*", resource: "*", effect: "allow" }];
  return [
    { action: "*", resource: "*", effect: "ask" },
    ...ALWAYS_ALLOWED.map((action) => ({ action, resource: "*", effect: "allow" })),
  ];
}
