/**
 * opencode as an Exo provider: one `opencode acp` process per conversation,
 * driven over the Agent Client Protocol (newline JSON-RPC 2.0 on stdio). The
 * process starts its own private opencode server, so the config Exo injects
 * (`OPENCODE_CONFIG_CONTENT`, see opencode-config.ts) reaches only this
 * session — the user's opencode.json supplies providers and models (local
 * Ollama / LM Studio / vLLM / OpenAI-compatible endpoints), Exo supplies the
 * vault policy.
 *
 * Wire facts this adapter relies on were recorded against opencode v2.2.6 on
 * 2026-11-08 (see docs/plans/2026-11-08-opencode-provider-plan.md):
 * - `session/new` and `session/resume` return `configOptions` (model, effort,
 *   mode); `session/resume` restores context without replaying history.
 * - tool calls arrive `pending` with an empty `rawInput`, then `in_progress`
 *   with it; permission requests reuse the same `toolCallId`.
 * - `session/prompt` resolves with `{stopReason, usage}` when the turn ends;
 *   `session/cancel` makes it resolve with `stopReason: "cancelled"`.
 * - `/compact` is an available command; compaction reports through
 *   `session_info_update` `_meta["opencode/compaction"]`.
 */
import { spawn } from "child_process";
import { existsSync } from "fs";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type {
  AgentEvent,
  AgentSession,
  ContextUsage,
  ImageAttachment,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  SessionCaps,
  SessionOpts,
} from "./types";
import { StdioRpc, type RpcId } from "./jsonrpc-stdio";
import { buildOpencodeConfig } from "./opencode-config";
import { exoToolInput, exoToolName, hasInput, toolOutputText, type AcpToolCall } from "./opencode-tools";
import { elicitationContent, elicitationQuestions } from "./elicitation";
import { EXO_HOUSE_RULES } from "./house-rules";
import { spawnSpec } from "../core/win-cli";
import { compareSemver } from "../core/semver";

export const OPENCODE_MIN_VERSION = "2.0.0";
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

export interface OpencodeSessionRuntime {
  spawn: typeof spawn;
  /** Timeout for control requests (initialize, session/new, config options). */
  requestTimeoutMs: number;
}

const DEFAULT_RUNTIME: OpencodeSessionRuntime = { spawn, requestTimeoutMs: 60_000 };

interface ConfigOption {
  id?: string;
  currentValue?: string;
  options?: { value?: string; name?: string }[];
}

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

interface TrackedCall extends AcpToolCall {
  started: boolean;
}

export class OpencodeSession implements AgentSession {
  caps: SessionCaps | null = null;
  rateLimit = null;
  onCaps: ((caps: SessionCaps) => void) | null = null;

  private rpc: StdioRpc;
  private runtime: OpencodeSessionRuntime;
  private ready: Promise<void>;
  private sessionId?: string;
  private onEvent: ((e: AgentEvent) => void) | null = null;
  private turnOpen = false;
  private textOpen = false;
  private interruptRequested = false;
  private calls = new Map<string, TrackedCall>();
  private approvals = new Map<RpcId, () => void>();
  private usage: ContextUsage | null = null;
  private turnTokens: number | null = null;
  private configOptions: ConfigOption[] = [];
  private commands: string[] = [];
  private compacting: Promise<unknown> | null = null;
  /** Serializes mode switches so rapid toggles land in order. */
  private modeSync: Promise<unknown> = Promise.resolve();
  private tmpDir: string | null = null;
  private disposed = false;
  private disposedReason: string | null = null;
  private failure: Error | null = null;
  private bridgeStopped = false;

  constructor(private opts: SessionOpts, runtime: Partial<OpencodeSessionRuntime> = {}) {
    this.runtime = { ...DEFAULT_RUNTIME, ...runtime };
    this.rpc = new StdioRpc({ label: "opencode acp", requestTimeoutMs: this.runtime.requestTimeoutMs, tagJsonrpc: true });
    this.ready = this.start();
    // Prewarm failures are delivered by send(); never an unhandled rejection.
    void this.ready.catch(() => {});
  }

  /* ------------------------------ startup ------------------------------ */

  private async start(): Promise<void> {
    try {
      const instructions = await this.writeInstructions();
      const config = buildOpencodeConfig({
        toolsEnabled: this.opts.toolsEnabled,
        permissionMode: this.opts.permissionMode,
        instructions,
        bridge: this.opts.mcpBridge,
        autoCompact: this.opts.autoCompact ?? true,
      });
      const cmd = spawnSpec(this.opts.cli.bin, ["acp"]);
      this.rpc.start(
        this.runtime.spawn,
        cmd.command,
        cmd.args,
        {
          cwd: this.opts.cwd,
          env: { ...process.env, PATH: this.opts.cli.pathEnv, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
        },
        {
          onRequest: (id, method, params) => this.onRequest(id, method, params),
          onNotification: (method, params) => this.onNotification(method, params),
          onExit: (error) => this.fail(error),
        }
      );

      const init = record(await this.rpc.request("initialize", {
        protocolVersion: 1,
        // Exo never serves files or terminals to the agent: opencode uses its
        // own tools, gated by the permission requests below.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
        clientInfo: { name: "exo_obsidian", title: "Exo for Obsidian", version: "1.0.0" },
      }));
      const version = String(record(init.agentInfo).version ?? "");
      if (version && compareSemver(version, OPENCODE_MIN_VERSION) < 0) {
        throw new Error(`Exo needs opencode ${OPENCODE_MIN_VERSION} or newer (found ${version}). Run \`opencode upgrade\`.`);
      }

      const session = record(await this.openSession(record(init.agentCapabilities)));
      this.configOptions = Array.isArray(session.configOptions) ? (session.configOptions as ConfigOption[]) : [];
      await this.applyConfig();
      this.publishCaps();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.fail(failure);
      throw failure;
    }
  }

  /** Resume the stored session when asked (context restored, no history
   *  replay); a session opencode no longer has falls back to a fresh one. */
  private async openSession(agentCaps: Record<string, unknown>): Promise<unknown> {
    const base = { cwd: this.opts.cwd, mcpServers: [] };
    const resumable = "resume" in record(agentCaps.sessionCapabilities);
    if (this.opts.resumeSessionId && resumable) {
      try {
        const resumed = await this.rpc.request("session/resume", { ...base, sessionId: this.opts.resumeSessionId });
        this.sessionId = this.opts.resumeSessionId;
        return resumed;
      } catch {
        /* gone from opencode's store — start fresh below */
      }
    }
    const created = record(await this.rpc.request("session/new", base));
    if (typeof created.sessionId !== "string" || !created.sessionId) throw new Error("opencode did not return a session id.");
    this.sessionId = created.sessionId;
    return created;
  }

  /** Model, effort and plan mode for this session — each only when it differs
   *  from what opencode already has, and effort only when the model offers it. */
  private async applyConfig(): Promise<void> {
    const model = this.opts.model && this.opts.model !== "default" ? this.opts.model : "";
    if (model && model !== this.option("model")?.currentValue) await this.setOption("model", model);
    const effort = this.opts.effort && this.opts.effort !== "default" ? this.opts.effort : "";
    if (effort && this.option("effort")?.options?.some((o) => o.value === effort)) await this.setOption("effort", effort);
    await this.syncMode();
  }

  private option(id: string): ConfigOption | undefined {
    return this.configOptions.find((o) => o.id === id);
  }

  private async setOption(configId: string, value: string): Promise<void> {
    if (!this.sessionId) return;
    const res = record(await this.rpc.request("session/set_config_option", { sessionId: this.sessionId, configId, value }));
    if (Array.isArray(res.configOptions)) this.configOptions = res.configOptions as ConfigOption[];
    else {
      const opt = this.option(configId);
      if (opt) opt.currentValue = value;
      else this.configOptions.push({ id: configId, currentValue: value });
    }
  }

  /** opencode's agent for the current permission mode, applied only when it
   *  differs from what the session runs (a toggle during startup must not
   *  send it twice). */
  private async syncMode(): Promise<void> {
    const want = this.opts.permissionMode === "plan" ? "plan" : "build";
    if ((this.option("mode")?.currentValue ?? "build") !== want) await this.setOption("mode", want);
  }

  private async writeInstructions(): Promise<string[]> {
    const body = [EXO_HOUSE_RULES, this.opts.systemPrompt, this.opts.memoryPreamble].filter(Boolean).join("\n\n");
    const files: string[] = [];
    try {
      this.tmpDir = await mkdtemp(join(tmpdir(), "exo-opencode-"));
      const path = join(this.tmpDir, "exo-instructions.md");
      await writeFile(path, body);
      files.push(path);
    } catch {
      /* unwritable temp — run without Exo's instructions rather than not at all */
    }
    // opencode v2 reads AGENTS.md only; a vault set up for Claude Code keeps
    // its standing instructions in CLAUDE.md.
    const claudeMd = join(this.opts.cwd, "CLAUDE.md");
    if (existsSync(claudeMd) && !existsSync(join(this.opts.cwd, "AGENTS.md"))) files.push(claudeMd);
    return files;
  }

  /* ------------------------------ capabilities ------------------------------ */

  private models(): ModelOption[] {
    return (this.option("model")?.options ?? []).flatMap((o) =>
      typeof o.value === "string" ? [{ id: o.value, label: o.name || o.value }] : []
    );
  }

  /** opencode's effort tiers for the current model ("default" first). */
  effortTiers(): string[] {
    return (this.option("effort")?.options ?? []).flatMap((o) => (typeof o.value === "string" ? [o.value] : []));
  }

  private publishCaps(): void {
    const tools = this.opts.toolsEnabled
      ? ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch", "Agent", "TodoWrite", ...(this.opts.mcpBridge ? ["mcp__obsidian__*"] : [])]
      : [];
    this.caps = {
      skills: [],
      commands: this.commands,
      agents: [],
      tools,
      mcpServers: this.opts.mcpBridge && this.opts.toolsEnabled ? [{ name: "obsidian", status: "connected" }] : [],
      models: this.models(),
    };
    this.onCaps?.(this.caps);
  }

  /* ------------------------------ incoming ------------------------------ */

  private emit(e: AgentEvent): void {
    this.onEvent?.(e);
  }

  private closeText(): void {
    if (!this.textOpen) return;
    this.textOpen = false;
    this.emit({ kind: "text-end" });
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (method !== "session/update") return;
    const update = record(params.update);
    const kind = String(update.sessionUpdate ?? "");
    const content = record(update.content);
    if (kind === "agent_message_chunk") {
      let text = typeof content.text === "string" ? content.text : "";
      // Models open a block with blank lines; the bubble shouldn't.
      if (!this.textOpen) text = text.replace(/^\s*\n/, "");
      if (!text) return;
      this.textOpen = true;
      this.emit({ kind: "text-delta", text });
    } else if (kind === "agent_thought_chunk") {
      const text = typeof content.text === "string" ? content.text : "";
      if (text.trim()) this.emit({ kind: "thinking-delta", text });
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      this.onToolCall(update);
    } else if (kind === "plan") {
      const entries = Array.isArray(update.entries) ? update.entries : [];
      this.emit({
        kind: "tool-call-start",
        id: `opencode-plan-${this.sessionId ?? "s"}`,
        name: "TodoWrite",
        input: { todos: entries.map((e) => ({ content: String(record(e).content ?? ""), status: String(record(e).status ?? "pending") })) },
      });
    } else if (kind === "available_commands_update") {
      const list = Array.isArray(update.availableCommands) ? update.availableCommands : [];
      this.commands = list.flatMap((c) => (typeof record(c).name === "string" ? [String(record(c).name)] : []));
      this.publishCaps();
    } else if (kind === "config_option_update") {
      if (Array.isArray(update.configOptions)) this.configOptions = update.configOptions as ConfigOption[];
      this.publishCaps();
    } else if (kind === "usage_update") {
      const used = Number(update.used ?? 0);
      const total = Number(update.size ?? 0);
      if (used > 0 && total > 0) {
        const cost = record(update.cost);
        const amount = Number(cost.amount ?? 0);
        // A local model reports a cost of 0: show none rather than "$0.00".
        this.usage = { used, total, ...(cost.currency === "USD" && amount > 0 ? { costUsd: amount } : {}) };
        this.emit({ kind: "usage", usage: this.usage });
      }
    } else if (kind === "session_info_update") {
      const compaction = record(record(update._meta)["opencode/compaction"]);
      if (compaction.status === "completed") this.emit({ kind: "compact" });
    }
  }

  /** opencode announces a call before its input exists, then fills it in: the
   *  card (and Exo's checkpoint, keyed off the input's path) waits for it. */
  private onToolCall(u: AcpToolCall): void {
    const id = u.toolCallId ?? "";
    if (!id) return;
    const prev = this.calls.get(id);
    const call: TrackedCall = {
      ...prev,
      ...Object.fromEntries(Object.entries(u).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0))),
      rawInput: hasInput(u) ? u.rawInput : prev?.rawInput ?? u.rawInput,
      started: prev?.started ?? false,
    };
    this.calls.set(id, call);
    const done = call.status === "completed" || call.status === "failed";
    if (!call.started && (hasInput(call) || call.status === "in_progress" || done)) {
      call.started = true;
      this.closeText();
      const name = exoToolName(call);
      this.emit({ kind: "tool-call-start", id, name, input: exoToolInput(name, call) });
    }
    if (done) {
      this.emit({ kind: "tool-call-result", id, ok: call.status === "completed", output: toolOutputText(u) });
      this.calls.delete(id);
    }
  }

  private onRequest(id: RpcId, method: string, params: Record<string, unknown>): void {
    if (method === "session/request_permission") return this.onPermission(id, params);
    if (method.includes("elicitation")) return this.onElicitation(id, params);
    this.rpc.respondError(id, -32601, `Exo does not serve ${method}.`);
  }

  private onPermission(id: RpcId, params: Record<string, unknown>): void {
    const req = record(params.toolCall) as AcpToolCall;
    const known = req.toolCallId ? this.calls.get(req.toolCallId) : undefined;
    const call: AcpToolCall = { ...known, ...req, rawInput: hasInput(req) ? req.rawInput : known?.rawInput };
    const options = Array.isArray(params.options) ? (params.options as { optionId?: string; kind?: string }[]) : [];
    const pick = (kind: string) => options.find((o) => o.kind === kind)?.optionId;
    let settled = false;
    const answer = (optionId: string | undefined) => {
      if (settled) return;
      settled = true;
      this.approvals.delete(id);
      this.rpc.respond(id, optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
    };
    const name = exoToolName(call);
    // acceptEdits: file edits go through without a card, as on Claude.
    if (this.opts.permissionMode === "acceptEdits" && EDIT_TOOLS.has(name)) return answer(pick("allow_once"));
    if (!this.onEvent || !this.turnOpen) return answer(pick("reject_once"));
    this.approvals.set(id, () => answer(undefined));
    this.emit({
      kind: "permission-request",
      id: `opencode-${String(id)}`,
      tool: name,
      input: exoToolInput(name, call),
      resolve: (d: PermissionDecision) =>
        answer(d.behavior === "allow" ? pick(d.remember ? "allow_always" : "allow_once") ?? pick("allow_once") : pick("reject_once")),
    });
  }

  private onElicitation(id: RpcId, params: Record<string, unknown>): void {
    const questions = elicitationQuestions(params);
    if (!this.opts.requestUserInput || questions.length === 0) {
      this.rpc.respond(id, { action: "decline" });
      return;
    }
    void this.opts.requestUserInput(questions).then(
      (answers) => this.rpc.respond(id, { action: "accept", content: elicitationContent(params, answers) }),
      () => this.rpc.respond(id, { action: "cancel" })
    );
  }

  /* ------------------------------ turns ------------------------------ */

  async send(
    message: string,
    onEvent: (e: AgentEvent) => void,
    images?: ImageAttachment[],
    systemPromptOverride?: string
  ): Promise<void> {
    if (this.disposed) throw new Error(`Session disposed (${this.disposedReason ?? "unknown"}).`);
    if (this.failure) throw new Error(`opencode session ended — sending again starts a fresh session. (${this.failure.message})`);
    if (this.turnOpen) throw new Error("A turn is already in flight.");
    this.turnOpen = true;
    this.onEvent = onEvent;
    this.textOpen = false;
    this.interruptRequested = false;
    this.turnTokens = null;
    try {
      await this.ready;
      await this.compacting?.catch(() => {});
      if (!this.sessionId) throw new Error("opencode session is not ready.");
      // A bound agent's instructions ride this turn only (opencode has no
      // per-turn system prompt): ahead of the message, never persisted.
      const text = systemPromptOverride
        ? `<agent-instructions>\n${systemPromptOverride}\n</agent-instructions>\n\n${message}`
        : message;
      const prompt = [
        ...(images ?? []).map((img) => ({ type: "image", data: img.dataB64, mimeType: img.mediaType })),
        { type: "text", text },
      ];
      let result: Record<string, unknown>;
      try {
        // No timeout: a local model may think for minutes, and the user can stop it.
        result = record(await this.rpc.request("session/prompt", { sessionId: this.sessionId, prompt }, null));
      } catch (error) {
        if (!this.rpc.alive) throw error; // process gone: handled below
        // The session survived (e.g. the model endpoint refused): fail this turn only.
        this.emit({ kind: "error", message: error instanceof Error ? error.message : String(error) });
        this.emit({ kind: "turn-end", sessionId: this.sessionId });
        return;
      }
      this.closeText();
      const usage = record(result.usage);
      const tokens = Number(usage.inputTokens ?? 0) + Number(usage.outputTokens ?? 0);
      if (tokens > 0) this.turnTokens = tokens;
      const stop = String(result.stopReason ?? "end_turn");
      if (stop === "cancelled" && !this.interruptRequested) this.emit({ kind: "error", message: "opencode cancelled the turn." });
      else if (stop === "refusal") this.emit({ kind: "error", message: "The model refused to continue." });
      else if (stop === "max_tokens") this.emit({ kind: "notice", message: "The reply hit the model's output limit." });
      else if (stop === "max_turn_requests") this.emit({ kind: "notice", message: "The turn hit opencode's step limit." });
      this.emit({ kind: "turn-end", sessionId: this.sessionId });
    } catch (error) {
      const failure = this.failure ?? (error instanceof Error ? error : new Error(String(error)));
      this.emit({ kind: "error", message: failure.message });
      throw failure;
    } finally {
      this.turnOpen = false;
      this.calls.clear();
      this.cancelApprovals();
    }
  }

  interrupt(): void {
    if (this.disposed || !this.turnOpen || !this.sessionId) return;
    this.interruptRequested = true;
    this.cancelApprovals();
    this.rpc.notify("session/cancel", { sessionId: this.sessionId });
  }

  compact(instructions?: string): void {
    if (this.disposed || this.failure || this.turnOpen || !this.sessionId || this.compacting) return;
    const text = instructions?.trim() ? `/compact ${instructions.trim()}` : "/compact";
    this.compacting = this.rpc
      .request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] }, null)
      .catch((error) => this.emit({ kind: "notice", message: `Compact failed: ${String(error)}` }))
      .finally(() => (this.compacting = null));
  }

  setPermissionMode(mode: PermissionMode): void {
    const wasPlan = this.opts.permissionMode === "plan";
    this.opts.permissionMode = mode;
    if (wasPlan === (mode === "plan") || this.disposed) return;
    this.modeSync = this.modeSync
      .then(() => this.ready)
      .then(() => this.syncMode())
      .catch((error) => this.emit({ kind: "notice", message: `Couldn't switch opencode mode: ${String(error)}` }));
  }

  dispose(reason: string): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposedReason = reason;
    this.cancelApprovals();
    if (this.turnOpen && this.sessionId) this.rpc.notify("session/cancel", { sessionId: this.sessionId });
    this.rpc.close(new Error(`Session disposed (${reason}).`));
    this.cleanup();
  }

  async contextUsage(): Promise<ContextUsage | null> {
    return this.usage;
  }

  lastTurnTokens(): number | null {
    return this.turnTokens;
  }

  /* ------------------------------ teardown ------------------------------ */

  private fail(error: Error): void {
    if (this.failure || this.disposed) return;
    this.failure = error;
    this.cancelApprovals();
    this.rpc.close(error);
    this.cleanup();
  }

  private cancelApprovals(): void {
    for (const cancel of [...this.approvals.values()]) cancel();
    this.approvals.clear();
  }

  private cleanup(): void {
    if (this.tmpDir) {
      void rm(this.tmpDir, { recursive: true, force: true }).catch(() => {});
      this.tmpDir = null;
    }
    if (!this.bridgeStopped) {
      this.bridgeStopped = true;
      this.opts.mcpBridge?.stop?.();
    }
  }
}
