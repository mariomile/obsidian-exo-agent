/**
 * Owner of the loopback MCP bridges (see mcp-bridge.ts): one isolated executor
 * per session, the shared stdio relay script a CLI spawns, and the stop-all on
 * unload. Extracted from main.ts so the plugin class keeps only the wiring.
 */
import { Notice, type App } from "obsidian";
import { execFile } from "child_process";
import { promisify } from "util";
import { startMcpBridge, type McpBridge } from "./mcp-bridge";
import { MCP_BRIDGE_SCRIPT } from "./mcp-bridge-script";

const execFileAsync = promisify(execFile);

/** A bridge reserved for one session. `release` is idempotent. */
export interface BridgeLease {
  bridge: McpBridge;
  scriptPath: string;
  release: () => void;
}

export class McpBridgeHost {
  private bridges = new Set<McpBridge>();
  private scriptPath: string | null = null;
  /** One-time guard for the node preflight Notice. */
  private nodeWarned = false;

  constructor(
    private app: App,
    private pluginDir: () => string,
    private vaultPath: () => string
  ) {}

  /** True when `node` resolves on the given PATH — a CLI that spawns the stdio
   *  relay script needs it. On failure, warn ONCE per app run. */
  async checkNode(pathEnv: string, providerLabel: string): Promise<boolean> {
    try {
      await execFileAsync("node", ["--version"], { env: { ...process.env, PATH: pathEnv } });
      return true;
    } catch {
      if (!this.nodeWarned) {
        this.nodeWarned = true;
        new Notice(`Obsidian tools bridge unavailable for ${providerLabel} — \`node\` not found on PATH. ${providerLabel} runs without vault tools.`);
      }
      return false;
    }
  }

  /** Start an isolated loopback executor and materialize the shared stdio script.
   *  Null when anything fails — the session then runs without Obsidian tools. */
  async lease(): Promise<BridgeLease | null> {
    try {
      if (!this.scriptPath) {
        const dir = this.pluginDir();
        const rel = `${dir}/exo-mcp-bridge.mjs`;
        await this.app.vault.adapter.write(rel, MCP_BRIDGE_SCRIPT);
        // Pre-rename copy of the same script; nothing spawns it any more.
        const legacy = `${dir}/codex-bridge.mjs`;
        if (await this.app.vault.adapter.exists(legacy)) await this.app.vault.adapter.remove(legacy).catch(() => {});
        this.scriptPath = `${this.vaultPath()}/${rel}`;
      }
      const bridge = await startMcpBridge();
      this.bridges.add(bridge);
      let released = false;
      return {
        bridge,
        scriptPath: this.scriptPath,
        release: () => {
          if (released) return;
          released = true;
          this.bridges.delete(bridge);
          bridge.stop();
        },
      };
    } catch (e) {
      console.warn("[Exo] MCP bridge unavailable:", e);
      return null;
    }
  }

  stopAll(): void {
    for (const bridge of this.bridges) bridge.stop();
    this.bridges.clear();
  }
}
