import { spawn, type ChildProcess } from "child_process";
import { writeFile, unlink, readdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type {
  AgentEvent,
  AgentSession,
  ContextUsage,
  ImageAttachment,
  RateLimitInfo,
  RateLimitWindow,
  SessionCaps,
  SessionOpts,
} from "./types";
import { normalizeUtilization } from "../core/rate-limit";
import { routeCodexElicitation, type InFlightMcpCall } from "../core/codex-approval";
import { spawnSpec } from "../core/win-cli";

type RpcId = number | string;
type RpcMessage = {
  id?: RpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: number;
};

type ThreadItem = {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  cwd?: string;
  status?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  changes?: { path?: string; kind?: string }[];
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  prompt?: string | null;
  receiverThreadIds?: string[];
  agentsStates?: unknown;
  query?: string;
  namespace?: string | null;
  success?: boolean | null;
  output?: unknown;
};

function collaborationMode(opts: SessionOpts, systemPromptOverride?: string): Record<string, unknown> {
  const plan = opts.permissionMode === "plan";
  const reasoningEffort = opts.effort && opts.effort !== "default" ? opts.effort : plan ? "medium" : null;
  // A per-turn override (named-agent binding) replaces the session's own
  // systemPrompt for this turn only — it is never written back to `opts`.
  const developerInstructions = [EXO_HOUSE_RULES, systemPromptOverride ?? opts.systemPrompt, opts.memoryPreamble]
    .filter(Boolean)
    .join("\n\n");
  return {
    mode: plan ? "plan" : "default",
    settings: {
      model: opts.model && opts.model !== "default" ? opts.model : "gpt-6-astra",
      reasoning_effort: reasoningEffort,
      developer_instructions: developerInstructions || null,
    },
  };
}

/** Item types that carry conversation content or are already surfaced through
 *  another channel (reasoning deltas, `turn/plan/updated`, the `error`
 *  notification). Everything NOT listed here — including types that do not
 *  exist yet — falls through to a generic tool card in `routeItem`. Keeping the
 *  exclusions explicit is what lets the fallback be safe: the default renders
 *  work, and only known non-work is dropped. */
const NON_TOOL_ITEMS = new Set(["agentMessage", "userMessage", "reasoning", "todoList", "plan", "error"]);

const EXO_HOUSE_RULES =
  'Exo renders every file you read, create, or edit as chips below your message. ' +
  'Do NOT restate them as a prose list, a "Files touched"/"File toccati" section, ' +
  "or a details/accordion — it duplicates the native UI.";

const REQUEST_TIMEOUT_MS = 20_000;
const TURN_START_TIMEOUT_MS = 30_000;

export interface CodexSessionRuntime {
  spawn: typeof spawn;
  requestTimeoutMs: number;
  turnStartTimeoutMs: number;
}

const DEFAULT_RUNTIME: CodexSessionRuntime = {
  spawn,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  turnStartTimeoutMs: TURN_START_TIMEOUT_MS,
};

/** Basenames of the files in `dir` carrying `ext`. Codex has no `system/init`
 *  snapshot the way Claude does, so the vault's own `.claude/` rosters are read
 *  from disk — the same files Exo's command expansion and agent store resolve
 *  against, which is what makes the reported inventory true rather than empty.
 *  A missing directory is an empty roster, never an error. */
async function listNames(dir: string, ext: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((f) => f.endsWith(ext)).map((f) => f.slice(0, -ext.length)).sort();
  } catch {
    return [];
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function prettyLimitId(id: string): string {
  const value = id.replace(/^codex[_-]?/i, "").replace(/[_-]+/g, " ").trim();
  if (!value) return "model";
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}

function codexWindowLabel(limitId: string, window: Record<string, unknown>, root: Record<string, unknown>): string {
  const minutes = Number(window.windowDurationMins ?? 0);
  const name = String(root.limitName ?? "").toLowerCase();
  if (minutes === 300 || name.includes("five-hour") || name.includes("five_hour")) return "5-hour limit";
  if (minutes === 10080 || name.includes("weekly") || name.includes("seven-day")) {
    return limitId === "codex" ? "Weekly · all models" : `Weekly · ${prettyLimitId(limitId)}`;
  }
  if (minutes > 0) return `${minutes} min limit`;
  return limitId === "codex" ? "Plan limit" : prettyLimitId(limitId);
}

function codexRateLimitWindows(payload: unknown, fullSnapshot: boolean): RateLimitWindow[] {
  const response = record(payload);
  const root = record(response.rateLimits ?? response);
  const byLimitId = record(response.rateLimitsByLimitId);
  const entries = fullSnapshot && Object.keys(byLimitId).length
    ? Object.entries(byLimitId).map(([id, value]) => [id, record(value)] as const)
    : [[String(root.limitId ?? "codex"), root] as const];
  const windows: RateLimitWindow[] = [];
  for (const [limitId, limits] of entries) {
    for (const slot of ["primary", "secondary"] as const) {
      const window = record(limits[slot]);
      const usedPercent = Number(window.usedPercent);
      if (!Number.isFinite(usedPercent)) continue;
      const resetsAt = Number(window.resetsAt);
      const windowMinutes = Number(window.windowDurationMins);
      windows.push({
        id: `${limitId}:${slot}`,
        label: codexWindowLabel(limitId, window, limits),
        // app-server reports 0-100; Exo's RateLimitInfo convention is a fraction
        // (see claudeRateLimitWindows), else 1% would read as 100%.
        utilization: usedPercent / 100,
        ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
        ...(Number.isFinite(windowMinutes) && windowMinutes > 0 ? { windowMinutes } : {}),
      });
    }
  }
  return windows;
}

function codexRateLimitInfo(payload: unknown, previous: RateLimitInfo | null, fullSnapshot: boolean): RateLimitInfo | null {
  const response = record(payload);
  const root = record(response.rateLimits ?? response);
  const parsed = codexRateLimitWindows(payload, fullSnapshot);
  if (!parsed.length) return previous;

  const windows = fullSnapshot || !previous?.windows?.length
    ? parsed
    : [...new Map([...(previous.windows ?? []), ...parsed].map((window) => [window.id, window])).values()];
  const primary = windows.find((window) => window.windowMinutes === 300) ?? windows[0];
  const max = Math.max(...windows.map((window) => normalizeUtilization(window.utilization) ?? 0), 0);
  const reached = typeof root.rateLimitReachedType === "string" && root.rateLimitReachedType.length > 0;
  const nativeLimitName = typeof root.limitName === "string" && root.limitName.length > 0
    ? root.limitName
    : primary?.id;
  return {
    status: reached || max >= 100 ? "rejected" : max >= 80 ? "allowed_warning" : "allowed",
    utilization: primary?.utilization,
    resetsAt: primary?.resetsAt,
    windowType: nativeLimitName,
    windows,
    ...(typeof root.planType === "string" && root.planType ? { planType: root.planType } : previous?.planType ? { planType: previous.planType } : {}),
  };
}

function enumOptions(schema: Record<string, unknown>): { label: string }[] {
  if (Array.isArray(schema.enum)) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    return schema.enum.flatMap((value, index) => typeof value === "string"
      ? [{ label: typeof names[index] === "string" ? String(names[index]) : value }]
      : []);
  }
  const variants = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(record(schema.items).anyOf) ? record(schema.items).anyOf as unknown[] : [];
  return variants.flatMap((value) => {
    const option = record(value);
    return typeof option.const === "string"
      ? [{ label: typeof option.title === "string" ? option.title : option.const }]
      : [];
  });
}

function elicitationQuestions(params: Record<string, unknown>): import("./types").UserQuestion[] {
  const schema = record(params.requestedSchema);
  const properties = record(schema.properties);
  return Object.entries(properties).map(([id, raw]) => {
    const property = record(raw);
    const type = String(property.type ?? "string");
    const options = type === "boolean" ? [{ label: "Yes" }, { label: "No" }] : enumOptions(property);
    return {
      id,
      header: typeof property.title === "string" ? property.title : id,
      question: typeof property.description === "string"
        ? property.description
        : typeof params.message === "string" ? params.message : id,
      options,
      multiSelect: type === "array",
    };
  });
}

function elicitationContent(
  params: Record<string, unknown>,
  answers: Record<string, string>,
): Record<string, unknown> {
  const properties = record(record(params.requestedSchema).properties);
  return Object.fromEntries(Object.entries(answers).map(([id, answer]): [string, unknown] => {
    const schema = record(properties[id]);
    const type = String(schema.type ?? "string");
    if (type === "boolean") return [id, answer === "Yes"];
    if (type === "number" || type === "integer") {
      const value = Number(answer);
      return [id, Number.isFinite(value) ? value : answer];
    }
    if (type === "array") return [id, answer.split(",").map((value) => value.trim()).filter(Boolean)];
    return [id, answer];
  }));
}

function imageExt(mediaType: string): string {
  const match = /^image\/(png|jpe?g|gif|webp)$/i.exec(mediaType);
  const sub = match?.[1]?.toLowerCase() ?? "png";
  return sub === "jpeg" ? "jpg" : sub;
}

function approvalPolicy(value?: string): unknown {
  if (value === "granular") {
    return {
      granular: {
        sandbox_approval: true,
        rules: true,
        skill_approval: true,
        request_permissions: true,
        mcp_elicitations: true,
      },
    };
  }
  if (value === "untrusted" || value === "never") return value;
  // app-server removed the legacy on-failure variant. Keep its conservative
  // intent by upgrading it to the interactive policy.
  return "on-request";
}

function mcpOverride(bridge: { port: number; token: string; scriptPath: string }): string {
  const esc = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return (
    `mcp_servers.obsidian={command="node",args=["${esc(bridge.scriptPath)}"],` +
    `env={EXO_BRIDGE_PORT="${bridge.port}",EXO_BRIDGE_TOKEN="${esc(bridge.token)}"},` +
    "startup_timeout_sec=10,tool_timeout_sec=3600}"
  );
}

/** Persistent rich-client Codex transport. One app-server process owns one
 * conversation thread and stays warm across turns. */
export class CodexSession implements AgentSession {
  private child: ChildProcess | null = null;
  private threadId?: string;
  private activeTurnId?: string;
  private onEvent: ((event: AgentEvent) => void) | null = null;
  private onTurnComplete: (() => void) | null = null;
  private onTurnFailure: ((error: Error) => void) | null = null;
  private requestId = 0;
  private pending = new Map<RpcId, PendingRequest>();
  private approvalCancels = new Map<RpcId, () => void>();
  private stdoutBuffer = "";
  private stderrTail: string[] = [];
  private disposed = false;
  /** Set once, by dispose(). Reused by send()'s post-dispose guard — see the
   *  parity note on ClaudeSession.disposedReason. */
  private disposedReason: string | null = null;
  private ended = false;
  private turnInFlight = false;
  private interruptRequested = false;
  private streamedAgentItems = new Set<string>();
  /** Item types already reported to the console by the `routeItem` fallback —
   *  logged once each, so an unmapped type is diagnosable without spamming a
   *  line per item. */
  private unknownItemTypes = new Set<string>();
  private imagePaths: string[] = [];
  private usage: ContextUsage | null = null;
  private turnTokens: number | null = null;
  private autoCompactPending = false;
  private bridgeStopped = false;
  private rateLimitRefresh: Promise<void> | null = null;
  private ready: Promise<void>;
  private runtime: CodexSessionRuntime;
  private mcpStatuses = new Map<string, string>();
  /** MCP tool calls started and not yet completed: the only thing that says
   *  WHICH tool an approval request is about (the payload never names it). */
  private inFlightMcp = new Map<string, InFlightMcpCall>();

  caps: SessionCaps | null = null;
  rateLimit: RateLimitInfo | null = null;
  onCaps: ((caps: SessionCaps) => void) | null = null;

  constructor(private opts: SessionOpts, runtime: Partial<CodexSessionRuntime> = {}) {
    this.runtime = { ...DEFAULT_RUNTIME, ...runtime };
    this.threadId = opts.resumeSessionId;
    this.ready = this.start();
    // Prewarm failures are delivered by send(); keep an early catch attached so
    // an idle tab never creates an unhandled rejection.
    void this.ready.catch(() => {});
  }

  private async start(): Promise<void> {
    const args = ["app-server", "--listen", "stdio://"];
    if (this.opts.fastStartup || !this.opts.toolsEnabled) args.push("-c", "mcp_servers={}");
    if (!this.opts.runHooks) args.push("-c", "features.hooks=false");
    if (!this.opts.toolsEnabled) {
      args.push(
        "-c", "features.shell_tool=false",
        "-c", "features.unified_exec=false",
        "-c", "features.multi_agent=false",
        "-c", 'web_search="disabled"',
      );
    }
    // Later overrides win: the native Obsidian bridge survives Fast startup.
    if (this.opts.toolsEnabled && this.opts.codexBridge) {
      args.push("-c", mcpOverride(this.opts.codexBridge));
    }

    try {
      // On Windows an npm-installed codex resolves to its `.js` entry, which
      // must run through node; spawnSpec is the identity everywhere else.
      const cmd = spawnSpec(this.opts.cli.bin, args);
      const child = this.runtime.spawn(cmd.command, cmd.args, {
        cwd: this.opts.cwd,
        env: { ...process.env, PATH: this.opts.cli.pathEnv },
        windowsHide: true,
      });
      this.child = child;
      child.stdout?.on("data", (chunk: Buffer | string) => this.consume(chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer | string) => this.captureStderr(chunk.toString()));
      child.stdin?.on("error", () => { /* close/error owns reporting */ });
      child.on("error", (error) => this.failTransport(error));
      child.on("close", (code, signal) => {
        if (this.disposed || this.ended) return;
        const detail = this.stderrTail.join("\n").trim();
        this.failTransport(new Error(
          detail || `codex app-server exited (code ${code ?? "null"}, signal ${signal ?? "none"})`,
        ));
      });

      await this.request("initialize", {
        clientInfo: { name: "exo_obsidian", title: "Exo for Obsidian", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      });
      this.notify("initialized", {});

      const developerInstructions = [EXO_HOUSE_RULES, this.opts.systemPrompt, this.opts.memoryPreamble]
        .filter(Boolean)
        .join("\n\n");
      const params: Record<string, unknown> = {
        ...(this.threadId ? { threadId: this.threadId } : {}),
        cwd: this.opts.cwd,
        approvalPolicy: approvalPolicy(this.opts.approvalPolicy),
        approvalsReviewer: "user",
        sandbox: this.opts.toolsEnabled ? this.opts.sandboxMode || "workspace-write" : "read-only",
        ...(this.opts.model && this.opts.model !== "default" ? { model: this.opts.model } : {}),
        ...(developerInstructions ? { developerInstructions } : {}),
      };
      const response = record(await this.request(this.threadId ? "thread/resume" : "thread/start", params));
      const thread = record(response.thread);
      if (typeof thread.id !== "string" || !thread.id) {
        throw new Error("Codex app-server did not return a thread id.");
      }
      this.threadId = thread.id;
      void this.discoverCapabilities();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.failTransport(failure);
      throw failure;
    }
  }

  /** The tools this session actually turned on, derived from the same flags
   *  `start()` passes to the app-server — so the inventory can't drift from the
   *  config the way a hardcoded list does. MCP tools are not listed here: they
   *  arrive through `mcpServer/startupStatus/updated` and own the MCP tab. */
  private enabledTools(): string[] {
    if (!this.opts.toolsEnabled) return [];
    const tools = ["Bash", "Edit", "WebSearch", "Agent", "TodoWrite"];
    if (this.opts.codexBridge) tools.push("mcp__obsidian__*");
    return tools;
  }

  private async discoverCapabilities(): Promise<void> {
    try {
      const [skillsResponse, modelsResponse] = await Promise.all([
        this.request("skills/list", { cwds: [this.opts.cwd], forceReload: false }),
        this.request("model/list", {}),
      ]);
      const skillEntries = Array.isArray(record(skillsResponse).data) ? record(skillsResponse).data as unknown[] : [];
      const skills = skillEntries.flatMap((entry) => {
        const list = record(entry).skills;
        return Array.isArray(list) ? list.flatMap((skill) => {
          const value = record(skill);
          return value.enabled !== false && typeof value.name === "string" ? [value.name] : [];
        }) : [];
      });
      const modelEntries = Array.isArray(record(modelsResponse).data) ? record(modelsResponse).data as unknown[] : [];
      const models = modelEntries.flatMap((entry) => {
        const value = record(entry);
        if (value.hidden === true || typeof value.id !== "string") return [];
        const label = typeof value.displayName === "string" ? value.displayName : value.id;
        return [{ id: value.id, label: value.upgrade ? `${label} (deprecated)` : label }];
      });
      const [commands, agents] = await Promise.all([
        listNames(`${this.opts.cwd}/.claude/commands`, ".md"),
        listNames(`${this.opts.cwd}/.claude/agents`, ".md"),
      ]);
      this.caps = {
        skills: [...new Set(skills)],
        commands,
        agents,
        tools: this.enabledTools(),
        mcpServers: [...this.mcpStatuses].map(([name, status]) => ({ name, status })),
        models,
      };
      this.onCaps?.(this.caps);
    } catch (error) {
      this.onEvent?.({ kind: "notice", message: `Codex capability discovery failed: ${String(error)}` });
    }
  }

  private consume(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.route(JSON.parse(line) as RpcMessage);
      } catch {
        // A malformed diagnostic line must not poison the JSONL transport.
      }
    }
  }

  private captureStderr(chunk: string): void {
    for (const line of chunk.split("\n")) {
      const text = line.trim();
      if (!text) continue;
      this.stderrTail.push(text.length > 500 ? `${text.slice(0, 500)}…` : text);
      if (this.stderrTail.length > 16) this.stderrTail.shift();
    }
  }

  private route(message: RpcMessage): void {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      window.clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message || "request failed"}`));
      } else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.routeServerRequest(message);
      return;
    }
    if (message.method) this.routeNotification(message.method, message.params ?? {});
  }

  private routeServerRequest(message: RpcMessage): void {
    const method = message.method ?? "";
    const id = message.id;
    if (id === undefined) return;
    const params = message.params ?? {};
    if (method === "item/tool/requestUserInput") {
      const rawQuestions = Array.isArray(params.questions) ? params.questions : [];
      const questions = rawQuestions.flatMap((value) => {
        const question = record(value);
        if (typeof question.id !== "string" || typeof question.question !== "string") return [];
        const options = Array.isArray(question.options)
          ? question.options.flatMap((raw) => {
              const option = record(raw);
              return typeof option.label === "string"
                ? [{ label: option.label, ...(typeof option.description === "string" ? { description: option.description } : {}) }]
                : [];
            })
          : [];
        return [{
          id: question.id,
          header: typeof question.header === "string" ? question.header : question.id,
          question: question.question,
          options,
          multiSelect: question.multiSelect === true,
          secret: question.isSecret === true,
        }];
      });
      if (!this.opts.requestUserInput || questions.length === 0) {
        this.sendRpc({ id, result: { answers: {} } });
        return;
      }
      void this.opts.requestUserInput(questions).then(
        (answers) => this.sendRpc({
          id,
          result: {
            answers: Object.fromEntries(
              questions.map((question) => [question.id, { answers: [answers[question.id] ?? ""].filter(Boolean) }])
            ),
          },
        }),
        () => this.sendRpc({ id, result: { answers: {} } }),
      );
      return;
    }

    if (method === "mcpServer/elicitation/request") {
      // Codex overloads this channel: a real elicitation form, OR an approval
      // for an MCP tool call. Only the form has questions to ask.
      const route = routeCodexElicitation({
        params,
        inFlight: this.inFlightMcp.values(),
        readOnlySandbox: this.opts.sandboxMode === "read-only",
        readTools: this.opts.obsidianReadTools ?? new Set<string>(),
      });
      if (route.kind === "decline") {
        // Fail CLOSED: an unidentified (or sandbox-forbidden) tool is refused,
        // never accepted. Said out loud, because a silent decline is exactly
        // what made this bug invisible for a whole release.
        this.onEvent?.({ kind: "notice", message: `Codex tool call refused: ${route.reason}` });
        this.sendRpc({ id, result: { action: "decline" } });
        return;
      }
      if (route.kind === "permission") {
        // Exo's ONE permission decision (read auto-allow, rules, card) owns
        // this, exactly as it owns the same tool on a Claude session.
        let settled = false;
        const answer = (action: "accept" | "decline" | "cancel") => {
          if (settled) return;
          settled = true;
          this.approvalCancels.delete(id);
          this.sendRpc({ id, result: action === "accept" ? { action, content: {} } : { action } });
        };
        this.approvalCancels.set(id, () => answer("cancel"));
        this.onEvent?.({
          kind: "permission-request",
          id: `codex-${String(id)}`,
          tool: route.tool,
          input: route.input,
          resolve: (decision) => answer(decision.behavior === "allow" ? "accept" : "decline"),
        });
        return;
      }
      const questions = elicitationQuestions(params);
      if (!this.opts.requestUserInput || questions.length === 0) {
        this.sendRpc({ id, result: { action: "decline" } });
        return;
      }
      void this.opts.requestUserInput(questions).then(
        (answers) => this.sendRpc({ id, result: { action: "accept", content: elicitationContent(params, answers) } }),
        () => this.sendRpc({ id, result: { action: "cancel" } }),
      );
      return;
    }

    const commandApproval = method === "item/commandExecution/requestApproval";
    const fileApproval = method === "item/fileChange/requestApproval";
    const permissionsApproval = method === "item/permissions/requestApproval";
    if (!commandApproval && !fileApproval && !permissionsApproval) {
      this.sendRpc({ id, error: { code: -32601, message: `Unsupported app-server request: ${method}` } });
      return;
    }

    let settled = false;
    const finish = (decision: "accept" | "acceptForSession" | "decline" | "cancel") => {
      if (settled) return;
      settled = true;
      this.approvalCancels.delete(id);
      this.sendRpc({ id, result: { decision } });
    };
    this.approvalCancels.set(id, () => finish("cancel"));
    this.onEvent?.({
      kind: "permission-request",
      id: `codex-${String(id)}`,
      tool: commandApproval ? "Bash" : fileApproval ? "Edit" : "Permissions",
      input: commandApproval
        ? { command: params.command ?? "", cwd: params.cwd, reason: params.reason }
        : fileApproval
          ? { file_path: params.grantRoot ?? "", reason: params.reason }
          : { permissions: params.permissions ?? {}, cwd: params.cwd, reason: params.reason },
      resolve: (decision) => {
        if (permissionsApproval) {
          this.approvalCancels.delete(id);
          settled = true;
          this.sendRpc({
            id,
            result: {
              permissions: decision.behavior === "allow" ? params.permissions ?? {} : {},
              scope: decision.behavior === "allow" && decision.remember ? "session" : "turn",
            },
          });
          return;
        }
        if (decision.behavior === "allow") finish(decision.remember ? "acceptForSession" : "accept");
        else finish("decline");
      },
    });
  }

  private routeNotification(method: string, params: Record<string, unknown>): void {
    if (method === "turn/started") {
      const turn = record(params.turn);
      if (typeof turn.id === "string") this.activeTurnId = turn.id;
      return;
    }
    if (method === "item/agentMessage/delta") {
      const itemId = String(params.itemId ?? "");
      this.streamedAgentItems.add(itemId);
      if (typeof params.delta === "string" && params.delta) {
        this.onEvent?.({ kind: "text-delta", text: params.delta });
      }
      return;
    }
    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      if (typeof params.delta === "string" && params.delta) {
        this.onEvent?.({ kind: "thinking-delta", text: params.delta });
      }
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      this.routeItem(record(params.item), method === "item/completed");
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      const tokenUsage = record(params.tokenUsage);
      const last = record(tokenUsage.last);
      const used = Number(last.totalTokens ?? 0);
      const total = Number(tokenUsage.modelContextWindow ?? 0);
      if (used > 0) this.turnTokens = used;
      if (used > 0 && total > 0) {
        this.usage = { used, total };
        if (this.opts.autoCompact && used / total >= 0.9) this.autoCompactPending = true;
        this.onEvent?.({ kind: "usage", usage: this.usage });
      }
      return;
    }
    if (method === "turn/plan/updated") {
      const plan = Array.isArray(params.plan) ? params.plan : [];
      this.onEvent?.({
        kind: "tool-call-start",
        id: `codex-plan-${String(params.turnId ?? this.activeTurnId ?? "turn")}`,
        name: "TodoWrite",
        input: {
          todos: plan.map((raw) => {
            const step = record(raw);
            return {
              content: String(step.step ?? ""),
              status: step.status === "inProgress" ? "in_progress" : String(step.status ?? "pending"),
            };
          }),
        },
      });
      return;
    }
    if (method === "account/rateLimits/updated") {
      const next = codexRateLimitInfo(params, this.rateLimit, false);
      if (next) {
        this.rateLimit = next;
        this.onEvent?.({ kind: "rate-limit", ...next });
      }
      return;
    }
    if (method === "thread/compacted") {
      this.onEvent?.({ kind: "compact" });
      return;
    }
    if (method === "warning") {
      this.onEvent?.({ kind: "notice", message: String(params.message ?? "Codex warning.") });
      return;
    }
    if (method === "mcpServer/startupStatus/updated") {
      const name = typeof params.name === "string" ? params.name : "";
      const raw = typeof params.status === "string" ? params.status : "unknown";
      if (name) {
        this.mcpStatuses.set(name, raw === "ready" ? "connected" : raw);
        this.publishCaps();
      }
      return;
    }
    if (method === "error") {
      const error = record(params.error);
      const message = typeof error.message === "string"
        ? error.message
        : typeof params.message === "string" ? params.message : "Codex app-server error.";
      this.emitFailure(message);
      return;
    }
    if (method === "turn/completed") {
      const turn = record(params.turn);
      const status = String(turn.status ?? "");
      if (status === "failed") {
        const error = record(turn.error);
        this.onEvent?.({
          kind: "error",
          message: typeof error.message === "string" ? error.message : "Codex turn failed.",
        });
      } else if (status === "interrupted" && !this.interruptRequested) {
        this.onEvent?.({ kind: "error", message: "Codex turn was interrupted." });
      }
      const shouldCompact = this.autoCompactPending && status === "completed";
      this.autoCompactPending = false;
      this.onEvent?.({ kind: "turn-end", sessionId: this.threadId });
      this.finishTurn();
      void this.refreshRateLimits();
      if (shouldCompact && this.threadId) {
        void this.request("thread/compact/start", { threadId: this.threadId })
          .catch((error) => this.onEvent?.({ kind: "notice", message: `Auto-compact failed: ${String(error)}` }));
      }
    }
  }

  private routeItem(item: ThreadItem, done: boolean): void {
    const id = item.id || "codex-item";
    if (item.type === "agentMessage") {
      if (done && item.text && !this.streamedAgentItems.has(id)) {
        this.onEvent?.({ kind: "text-delta", text: item.text });
      }
      return;
    }
    if (item.type === "commandExecution") {
      if (done) {
        this.onEvent?.({
          kind: "tool-call-result",
          id,
          ok: item.status === "completed" && Number(item.exitCode ?? 0) === 0,
          output: item.aggregatedOutput ?? "",
        });
      } else {
        this.onEvent?.({ kind: "tool-call-start", id, name: "Bash", input: { command: item.command ?? "", cwd: item.cwd } });
      }
      return;
    }
    if (item.type === "fileChange") {
      for (const change of item.changes ?? []) {
        const path = change.path ?? "";
        this.onEvent?.(done
          ? { kind: "tool-call-result", id: `${id}:${path}`, ok: item.status !== "failed", output: "" }
          : { kind: "tool-call-start", id: `${id}:${path}`, name: "Edit", input: { file_path: path } });
      }
      return;
    }
    if (item.type === "mcpToolCall") {
      const name = `mcp__${item.server ?? "unknown"}__${item.tool ?? "tool"}`;
      // Codex emits this ~50ms BEFORE the approval it gates, and the call cannot
      // complete until the approval is answered, so the entry is always there
      // when the approval arrives.
      if (done) this.inFlightMcp.delete(id);
      else if (item.server && item.tool) {
        this.inFlightMcp.set(id, { server: item.server, tool: item.tool, args: item.arguments });
      }
      this.onEvent?.(done
        ? { kind: "tool-call-result", id, ok: item.status === "completed", output: outputText(item.result ?? item.error) }
        : { kind: "tool-call-start", id, name, input: item.arguments });
      return;
    }
    if (item.type === "collabAgentToolCall") {
      const input = {
        description: item.prompt ?? String(item.tool ?? "Subagent"),
        prompt: item.prompt ?? "",
        receiver_thread_ids: item.receiverThreadIds ?? [],
      };
      this.onEvent?.(done
        ? { kind: "tool-call-result", id, ok: item.status === "completed", output: outputText(item.agentsStates) }
        : { kind: "tool-call-start", id, name: "Agent", input });
      return;
    }
    if (item.type === "webSearch") {
      this.onEvent?.(done
        ? { kind: "tool-call-result", id, ok: true, output: item.query ?? "" }
        : { kind: "tool-call-start", id, name: "WebSearch", input: { query: item.query ?? "" } });
      return;
    }
    if (item.type === "dynamicToolCall") {
      const name = ["dynamic", item.namespace, item.tool].filter(Boolean).join("__");
      this.onEvent?.(done
        ? { kind: "tool-call-result", id, ok: item.success !== false && item.status !== "failed", output: outputText(item.output ?? item.result ?? item.error) }
        : { kind: "tool-call-start", id, name, input: item.arguments });
      return;
    }
    // Anything Codex adds after this switch was written. The cases above are
    // shape-specific renderings of well-known items, NOT an allowlist of what
    // the UI may show: without this fallback a new item type is silent work —
    // it happens, and the turn looks like it did nothing. Rendering it as a
    // plain tool card under its own type name is worse than a tailored card
    // and far better than invisibility.
    if (!item.type || NON_TOOL_ITEMS.has(item.type)) return;
    if (!this.unknownItemTypes.has(item.type)) {
      this.unknownItemTypes.add(item.type);
      console.debug(`[Exo] codex: unmapped item type "${item.type}" — rendered as a generic tool card.`);
    }
    this.onEvent?.(done
      ? {
          kind: "tool-call-result",
          id,
          ok: item.status !== "failed",
          output: outputText(item.output ?? item.result ?? item.error ?? item.text),
        }
      : { kind: "tool-call-start", id, name: item.type, input: item.arguments ?? {} });
  }

  private publishCaps(): void {
    this.caps = {
      skills: this.caps?.skills ?? [],
      commands: this.caps?.commands ?? [],
      agents: this.caps?.agents ?? [],
      tools: this.caps?.tools ?? [],
      mcpServers: [...this.mcpStatuses].map(([name, status]) => ({ name, status })),
      ...(this.caps?.models ? { models: this.caps.models } : {}),
    };
    this.onCaps?.(this.caps);
  }

  private sendRpc(message: RpcMessage): void {
    if (this.ended || !this.child?.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.sendRpc({ method, params });
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.ended || !this.child) return Promise.reject(new Error("Codex app-server is not running."));
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${this.runtime.requestTimeoutMs}ms.`));
      }, this.runtime.requestTimeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.sendRpc({ id, method, params });
    });
  }

  async send(
    message: string,
    onEvent: (event: AgentEvent) => void,
    images?: ImageAttachment[],
    systemPromptOverride?: string
  ): Promise<void> {
    if (this.disposed) throw new Error(`Session disposed (${this.disposedReason ?? "unknown"}).`);
    if (this.turnInFlight) throw new Error("A turn is already in flight.");
    this.turnInFlight = true;
    this.onEvent = onEvent;
    this.interruptRequested = false;
    this.turnTokens = null;
    this.streamedAgentItems.clear();
    try {
      await this.ready;
      if (!this.threadId) throw new Error("Codex thread is not ready.");

      const input: Record<string, unknown>[] = [];
      this.imagePaths = [];
      for (const [index, image] of (images ?? []).entries()) {
        try {
          const path = join(tmpdir(), `exo-codex-img-${Date.now()}-${index}.${imageExt(image.mediaType)}`);
          await writeFile(path, Buffer.from(image.dataB64, "base64"));
          this.imagePaths.push(path);
          input.push({ type: "localImage", path });
        } catch {
          /* unwritable temp — send without this attachment */
        }
      }
      input.push({ type: "text", text: message, text_elements: [] });

      const completion = new Promise<void>((resolve, reject) => {
        this.onTurnComplete = resolve;
        this.onTurnFailure = reject;
      });
      const response = record(await this.request("turn/start", {
        threadId: this.threadId,
        input,
        cwd: this.opts.cwd,
        approvalPolicy: approvalPolicy(this.opts.approvalPolicy),
        approvalsReviewer: "user",
        collaborationMode: collaborationMode(this.opts, systemPromptOverride),
        ...(this.opts.model && this.opts.model !== "default" ? { model: this.opts.model } : {}),
        ...(this.opts.effort && this.opts.effort !== "default" ? { effort: this.opts.effort } : {}),
      }));
      const turn = record(response.turn);
      if (typeof turn.id === "string") this.activeTurnId = turn.id;

      if (!this.activeTurnId) {
        await new Promise<void>((resolve, reject) => {
          const deadline = window.setTimeout(() => reject(new Error(
            `turn/started timed out after ${this.runtime.turnStartTimeoutMs}ms.`,
          )), this.runtime.turnStartTimeoutMs);
          const poll = () => {
            if (this.activeTurnId) {
              window.clearTimeout(deadline);
              resolve();
            } else if (!this.ended) window.setTimeout(poll, 10);
          };
          poll();
        });
      }
      await completion;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (!this.ended) this.failTransport(failure);
      throw failure;
    } finally {
      this.turnInFlight = false;
    }
  }

  steer(text: string, images?: ImageAttachment[]): boolean {
    if (this.disposed || this.ended || !this.threadId || !this.activeTurnId || images?.length) return false;
    void this.request("turn/steer", {
      threadId: this.threadId,
      expectedTurnId: this.activeTurnId,
      input: [{ type: "text", text, text_elements: [] }],
    // A failed steer is not a failed turn: the turn keeps running, only this
    // message missed it, so say so without poisoning the answer in progress.
    }).catch((error) => this.onEvent?.({ kind: "notice", message: `Message not delivered to the running turn: ${String(error)}` }));
    return true;
  }

  compact(_instructions?: string): void {
    if (this.disposed || this.ended || !this.threadId || this.activeTurnId) return;
    void this.request("thread/compact/start", { threadId: this.threadId })
      .catch((error) => this.emitFailure(`Compact failed: ${String(error)}`));
  }

  setPermissionMode(mode: import("./types").PermissionMode): void {
    this.opts.permissionMode = mode;
  }

  interrupt(): void {
    if (this.disposed || this.ended || !this.threadId || !this.activeTurnId) return;
    this.interruptRequested = true;
    this.cancelApprovals();
    void this.request("turn/interrupt", { threadId: this.threadId, turnId: this.activeTurnId }).catch(() => {});
  }

  dispose(reason: string): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposedReason = reason;
    this.cancelApprovals();
    if (this.threadId && this.activeTurnId) {
      this.sendRpc({
        id: ++this.requestId,
        method: "turn/interrupt",
        params: { threadId: this.threadId, turnId: this.activeTurnId },
      });
    }
    this.rejectPending(new Error(`Session disposed (${reason}).`));
    this.finishTurn(new Error(`Session disposed (${reason}).`));
    try {
      this.child?.stdin?.end();
      this.child?.kill("SIGTERM");
    } catch { /* ignore */ }
    this.child = null;
    this.ended = true;
    this.stopBridge();
    this.cleanupImages();
  }

  async contextUsage(): Promise<ContextUsage | null> {
    return this.usage;
  }

  async refreshRateLimits(): Promise<void> {
    if (this.rateLimitRefresh) return this.rateLimitRefresh;
    const refresh = (async () => {
      try {
        await this.ready;
        const response = await this.request("account/rateLimits/read", {});
        const next = codexRateLimitInfo(response, this.rateLimit, true);
        if (next) {
          this.rateLimit = next;
          this.onEvent?.({ kind: "rate-limit", ...next });
        }
      } catch {
        // Native account quotas are best-effort and unavailable for API-key/local sessions.
      }
    })();
    const tracked = refresh.finally(() => {
      if (this.rateLimitRefresh === tracked) this.rateLimitRefresh = null;
    });
    this.rateLimitRefresh = tracked;
    return tracked;
  }

  lastTurnTokens(): number | null {
    return this.turnTokens;
  }

  /** `onEvent` outlives its turn on purpose (late usage and quota snapshots
   *  still land on the last turn), so an error raised while idle would reach a
   *  finished turn and append a failure under a correct answer. Only an
   *  in-flight turn can fail; outside one the same message is a notice. */
  private emitFailure(message: string): void {
    this.onEvent?.(this.onTurnComplete ? { kind: "error", message } : { kind: "notice", message });
  }

  private finishTurn(error?: Error): void {
    const resolve = this.onTurnComplete;
    const reject = this.onTurnFailure;
    this.onTurnComplete = null;
    this.onTurnFailure = null;
    this.activeTurnId = undefined;
    this.inFlightMcp.clear();
    this.cancelApprovals();
    this.cleanupImages();
    if (error) reject?.(error);
    else resolve?.();
  }

  private cancelApprovals(): void {
    for (const cancel of this.approvalCancels.values()) cancel();
    this.approvalCancels.clear();
  }

  private cleanupImages(): void {
    for (const path of this.imagePaths) void unlink(path).catch(() => {});
    this.imagePaths = [];
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private failTransport(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.rejectPending(error);
    if (this.onTurnComplete || this.onTurnFailure) {
      this.onEvent?.({ kind: "error", message: error.message });
      this.finishTurn(error);
    }
    try {
      this.child?.stdin?.end();
      this.child?.kill("SIGTERM");
    } catch { /* ignore */ }
    this.child = null;
    this.stopBridge();
  }

  private stopBridge(): void {
    if (this.bridgeStopped) return;
    this.bridgeStopped = true;
    this.opts.codexBridge?.stop?.();
  }
}
