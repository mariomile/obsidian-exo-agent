import { App, FileSystemAdapter, TFile } from "obsidian";
import { resolveCli, describeError } from "./cli";
import { ADAPTERS } from "./providers/registry";
import type { AgentEvent } from "./providers/types";
import { buildObsidianTools, createObsidianToolServer, OBSIDIAN_READ_TOOLS, type ObsidianToolOpts } from "./obsidian/tools";
import type { CodexBridge } from "./obsidian/codex-bridge";
import { READ_ONLY_TOOLS, toolFilePath, toolFilePaths } from "./ui/tools";
import { isReadOnlyExternalTool } from "./core/headless-tools";
import { WRITE_TOOLS } from "./core/touched";
import { exoPaths, LEGACY_MEMORY_ROOT } from "./core/paths";
import { memoryCaps } from "./core/memory-caps";
import { effortFor } from "./core/model-tuning";
import { toVaultRelative } from "./core/vault-path";
import type { MVASettings } from "./settings";
import { defaultModel } from "./settings-schema";
import type { AgentCaller } from "./core/agent-runs";

/** Per-step idle timeout — no event for this long aborts the run (bounded autonomy). */
const STEP_IDLE_TIMEOUT = 180_000;

export interface HeadlessResult {
  ok: boolean;
  output: string;      // concatenated assistant text (per-step headers when multi-step)
  reads: string[];     // vault paths the agent read (for the report footer)
  /** Vault paths the agent wrote (write mode only — empty in read-only runs). */
  writes: string[];
  /** Pre-write snapshots of written files (path → content, null = didn't exist).
   *  Backs "Restore run"; a write whose snapshot failed is NOT here and is
   *  flagged in the report instead. */
  checkpoint: Map<string, string | null>;
  error?: string;
}

export interface HeadlessOpts {
  write?: boolean;
  /** Isolated Codex bridge owned by this run; released with the session. */
  codexBridge?: { bridge: CodexBridge; scriptPath: string; release: () => void };
  /** Session-level system prompt override — a named agent's own instructions
   *  for a Codex run, which has no subagent primitive to delegate to instead
   *  (see `buildAgentSystemPrompt`). Ignored by Claude, which keeps its
   *  delegation instruction inline in the prompt text via `buildAgentRunPrompt`. */
  systemPrompt?: string;
  /** The agent this run executes as: what its `invoke_agent` calls delegate from. */
  agentCaller?: AgentCaller;
}

function vaultPath(app: App): string {
  const a = app.vault.adapter;
  return a instanceof FileSystemAdapter ? a.getBasePath() : "";
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Vault-relative form of a tool path (tools may hand back absolute paths). */
function relPath(app: App, raw: string): string {
  const rel = toVaultRelative(raw, vaultPath(app)).replace(/\\/g, "/");
  return rel.replace(/^\.?\//, "");
}

/** Resolve a tool path like the chat turn loop does: exact vault file first,
 *  then linkpath resolution; unresolved (e.g. about-to-be-created) paths pass
 *  through so the snapshot records them as "didn't exist". */
function concretePath(app: App, raw: string): string {
  const rel = relPath(app, raw);
  if (app.vault.getAbstractFileByPath(rel) instanceof TFile) return rel;
  const linkpath = rel.endsWith(".md") ? rel.slice(0, -3) : rel;
  return app.metadataCache.getFirstLinkpathDest(linkpath, "")?.path ?? rel;
}

/** Snapshot a file's pre-write content into the checkpoint (idempotent per path). */
async function snapshot(app: App, cp: Map<string, string | null>, raw: string): Promise<void> {
  const path = concretePath(app, raw);
  if (cp.has(path)) return;
  const f = app.vault.getAbstractFileByPath(path);
  if (f instanceof TFile) cp.set(path, await app.vault.read(f));
  else if (!f) cp.set(path, null);
  else throw new Error(`not a file: ${path}`);
}

/**
 * Run a playbook headlessly. Read-only by default: read tools auto-allowed,
 * every mutating tool auto-denied. With `opts.write` the agent may ALSO edit
 * vault notes — each written file is snapshotted first (same checkpoint model
 * as chat turns) so the whole run can be restored; anything beyond vault-note
 * writes (shell, external mutations) stays denied. Multi-step (" >>> ")
 * playbooks run sequentially in one session.
 */
export async function runHeadlessPlaybook(
  app: App,
  settings: MVASettings,
  prompt: string,
  opts: HeadlessOpts = {}
): Promise<HeadlessResult> {
  const provider = settings.provider;
  const write = opts.write === true;
  const bin = provider === "claude" ? settings.claudeBin : settings.codexBin;
  const steps = prompt.split(/\s+>>>\s+/).map((s) => s.trim()).filter(Boolean);
  const reads = new Set<string>();
  const writes = new Set<string>();
  const checkpoint = new Map<string, string | null>();
  const pendingSnapshots: Promise<void>[] = [];
  let output = "";

  // One tool configuration for both engines. The headless surface never writes
  // memory, even in write mode: automations edit notes, they don't get to
  // rewrite Exo's memory (memoryCaps owns that rule).
  const toolOpts: ObsidianToolOpts = {
    memory: memoryCaps(settings, { surface: "headless" }),
    paths: exoPaths(settings.memoryRoot || LEGACY_MEMORY_ROOT),
    agentCaller: opts.agentCaller,
  };

  let session: import("./providers/types").AgentSession | null = null;
  try {
    const cli = await resolveCli(provider, bin);
    let codexBridge: import("./providers/types").SessionOpts["codexBridge"];
    if (provider === "codex" && settings.obsidianToolsEnabled && opts.codexBridge) {
      const readNames = new Set([...OBSIDIAN_READ_TOOLS].map((name) => name.replace("mcp__obsidian__", "")));
      const tools = buildObsidianTools(app, toolOpts).filter(
        (tool) => readNames.has(tool.name) || (write && WRITE_TOOLS.test(tool.name))
      );
      opts.codexBridge.bridge.setTools(tools);
      codexBridge = {
        port: opts.codexBridge.bridge.port,
        token: opts.codexBridge.bridge.token,
        scriptPath: opts.codexBridge.scriptPath,
        stop: opts.codexBridge.release,
      };
    }
    const model = defaultModel(settings, provider);
    session = ADAPTERS[provider].createSession({
      cli,
      model,
      effort: effortFor(provider, model, settings.effort),
      cwd: vaultPath(app),
      permissionMode: "default",
      toolsEnabled: true, // reads allowed; writes gated by the resolver / sandbox below
      systemPrompt: opts.systemPrompt,
      // External tools (Dia-style digest sources: Gmail/Slack/Calendar via MCP)
      // opt in per settings: fastStartup=false lets the CLI load external MCP
      // servers; the resolver below still auto-denies anything that mutates.
      fastStartup: !settings.playbookExternalTools,
      // Claude: in-process vault tools, same options as the Codex bridge above.
      obsidianServer:
        provider === "claude" && settings.obsidianToolsEnabled
          ? createObsidianToolServer(app, toolOpts)
          : undefined,
      // Codex: the sandbox is the gate — workspace-write only in write mode,
      // never ask (nothing can answer).
      sandboxMode: write ? "workspace-write" : "read-only",
      approvalPolicy: "never",
      codexBridge,
    });

    for (let i = 0; i < steps.length; i++) {
      let stepText = "";
      let watchdog: number | null = null;
      const bump = () => {
        if (watchdog !== null) window.clearTimeout(watchdog);
        watchdog = window.setTimeout(() => session?.interrupt(), STEP_IDLE_TIMEOUT);
      };
      const onEvent = (e: AgentEvent) => {
        bump();
        if (e.kind === "text-delta") stepText += e.text;
        else if (e.kind === "tool-call-start") {
          // Codex writes surface here (sandbox, no permission events): snapshot
          // races the write like the chat loop — best effort, flagged if lost.
          if (write && WRITE_TOOLS.test(e.name)) {
            for (const p of toolFilePaths(e.name, e.input)) {
              writes.add(concretePath(app, p));
              pendingSnapshots.push(snapshot(app, checkpoint, p).catch(() => {}));
            }
          } else {
            const fp = toolFilePath(e.name, e.input);
            if (fp) reads.add(fp);
          }
        } else if (e.kind === "permission-request") {
          const externalRead = settings.playbookExternalTools && isReadOnlyExternalTool(e.tool);
          if (READ_ONLY_TOOLS.has(e.tool) || OBSIDIAN_READ_TOOLS.has(e.tool) || externalRead) {
            e.resolve({ behavior: "allow" });
            return;
          }
          const fp = toolFilePath(e.tool, e.input);
          if (write && fp && WRITE_TOOLS.test(e.tool)) {
            // Vault-note write: snapshot BEFORE the write may run; a failed
            // snapshot denies the write (never mutate what we can't restore).
            const target = concretePath(app, fp);
            snapshot(app, checkpoint, fp).then(
              () => {
                writes.add(target);
                e.resolve({ behavior: "allow" });
              },
              () => e.resolve({ behavior: "deny", message: "Exo couldn't snapshot the target; write denied." })
            );
            return;
          }
          e.resolve({
            behavior: "deny",
            message: write
              ? "Automation runs may only edit vault notes."
              : "Headless playbook runs are read-only.",
          });
        }
      };
      bump();
      try {
        await session.send(steps[i], onEvent);
      } finally {
        if (watchdog !== null) window.clearTimeout(watchdog);
      }
      output += steps.length > 1 ? `\n\n## Step ${i + 1}\n\n${stepText.trim()}` : stepText.trim();
    }
    await Promise.all(pendingSnapshots);
    return { ok: true, output: output.trim(), reads: [...reads], writes: [...writes], checkpoint };
  } catch (err) {
    await Promise.all(pendingSnapshots).catch(() => {});
    return {
      ok: false,
      output: output.trim(),
      reads: [...reads],
      writes: [...writes],
      checkpoint,
      error: describeError(err, ADAPTERS[provider].displayName),
    };
  } finally {
    session?.dispose("headless-run-end");
    // Idempotent: a no-op when the session already released it, and the only
    // release when the bridge never reached a session (no session, or tools off).
    opts.codexBridge?.release();
  }
}

/** Write the run report to the configured reports dir and return its vault path.
 *  `reportsDir` defaults to the legacy reports dir for tests/fallback. */
export async function writeReport(
  app: App,
  name: string,
  result: HeadlessResult,
  reportsDir: string = exoPaths(LEGACY_MEMORY_ROOT).reports
): Promise<string> {
  const dir = reportsDir;
  if (!app.vault.getAbstractFileByPath(dir)) {
    try {
      await app.vault.createFolder(dir);
    } catch {
      /* exists (race) */
    }
  }
  const safe = name.replace(/[\\/:#^[\]|?]/g, "").trim() || "Playbook";
  let path = `${dir}/${today()} ${safe}.md`;
  if (app.vault.getAbstractFileByPath(path)) {
    const d = new Date();
    path = `${dir}/${today()} ${safe} ${String(d.getHours()).padStart(2, "0")}.${String(d.getMinutes()).padStart(2, "0")}.md`;
  }
  const unsnapshotted = result.writes.filter((p) => !result.checkpoint.has(p));
  const body =
    `# ${name}\n\n` +
    (result.ok ? "" : `> [!warning] Run ended with an error: ${result.error ?? "unknown"}\n\n`) +
    `${result.output || "_(no output)_"}\n` +
    (result.writes.length
      ? `\n---\n**Modified:** ${result.writes.map((p) => `[[${p}]]`).join(" · ")}\n` +
        `> [!info] Restorable run — revert every modified note from the Automations panel (Cockpit → Autonomy → Automations).\n` +
        (unsnapshotted.length
          ? `> [!warning] No pre-write snapshot for: ${unsnapshotted.map((p) => `[[${p}]]`).join(" · ")} — these cannot be auto-restored.\n`
          : "")
      : "") +
    (result.reads.length
      ? `\n---\n**Read:** ${result.reads.map((p) => `[[${p}]]`).join(" · ")}\n`
      : "");
  const file = await app.vault.create(path, body);
  await app.fileManager.processFrontMatter(file, (f: Record<string, unknown>) => {
    f.type = "report";
    f.created_by = "exo";
    f.date = today();
    f.tags = ["type/note"];
  });
  return path;
}

/** Revert a run: every checkpointed file back to its pre-run content (delete
 *  files that didn't exist). Returns the paths actually restored. */
export async function restoreRun(
  app: App,
  checkpoint: Iterable<[string, string | null]>
): Promise<string[]> {
  const restored: string[] = [];
  for (const [path, before] of checkpoint) {
    try {
      const f = app.vault.getAbstractFileByPath(path);
      if (before === null) {
        if (f instanceof TFile) await app.fileManager.trashFile(f);
      } else if (f instanceof TFile) {
        await app.vault.modify(f, before);
      } else {
        const dir = path.split("/").slice(0, -1).join("/");
        if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir).catch(() => {});
        await app.vault.create(path, before);
      }
      restored.push(path);
    } catch {
      /* keep going — report the rest */
    }
  }
  return restored;
}
