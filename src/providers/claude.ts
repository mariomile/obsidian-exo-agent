import {
  query,
  type Query,
  type SDKControlGetUsageResponse,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentEvent,
  AgentSession,
  ContextUsage,
  ModelOption,
  ProviderAdapter,
  RateLimitInfo,
  RateLimitWindow,
  SessionOpts,
} from "./types";
import { normalizeUtilization } from "../core/rate-limit";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { claudeCliEnv, configuredMcpServers, obsidianMcpDenyList, type DeniedMcpServer } from "../core/mcp-guard";

/** Read a JSON file, or undefined when absent / unreadable / not JSON. */
function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** `deniedMcpServers` entries for the external Obsidian-vault MCP servers this
 *  session would otherwise load from the user's Claude config (see
 *  core/mcp-guard.ts). Sync on purpose: the SDK query options are built in a
 *  constructor, and the two reads are small local files, once per session. */
function obsidianMcpDenials(cwd: string): DeniedMcpServer[] {
  const servers = configuredMcpServers(readJson(join(homedir(), ".claude.json")), readJson(join(cwd, ".mcp.json")), cwd);
  const deny = obsidianMcpDenyList(servers);
  if (deny.length) console.debug(`[Exo] skipping ${deny.length} external Obsidian MCP server(s): Exo already reads the vault directly.`);
  return deny;
}

/** Built-in file tools disabled in "native-first" mode (use Obsidian tools). */
const NATIVE_FIRST_DISALLOW = ["Read", "Grep", "Glob", "LS", "Edit", "MultiEdit", "Write", "NotebookEdit"];

/** Fixed house rule prepended to the system-prompt append: Exo already renders
 *  every touched file as chips under each turn, so the agent restating them in
 *  prose duplicates the native UI. Kept to one short paragraph (cache-friendly). */
const EXO_HOUSE_RULES =
  'Exo renders every file you read, create, or edit as chips below your message. ' +
  'Do NOT restate them as a prose list, a "Files touched"/"File toccati" section, ' +
  'or a details/accordion — it duplicates the native UI.';

function parseClaudeReset(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function claudeWindowLabel(id: string): string {
  if (id === "five_hour") return "5-hour limit";
  if (id === "seven_day") return "Weekly · all models";
  if (id === "seven_day_opus") return "Weekly · Opus";
  if (id === "seven_day_sonnet") return "Weekly · Sonnet";
  if (id === "seven_day_overage_included") return "Weekly · overage included";
  if (id === "overage") return "Overage";
  return id;
}

function claudeRateLimitWindows(usage: SDKControlGetUsageResponse): RateLimitWindow[] {
  const limits = usage.rate_limits;
  if (!limits) return [];
  const windows: RateLimitWindow[] = [];
  const add = (
    id: string,
    label: string,
    value: { utilization: number | null; resets_at: string | null } | null | undefined,
  ) => {
    if (!value) return;
    const resetsAt = parseClaudeReset(value.resets_at);
    windows.push({
      id,
      label,
      // The SDK /usage contract reports percentages (0-100). Keep the
      // normalized provider value as a fraction so rate_limit_event and usage
      // snapshots share one RateLimitInfo convention in Exo.
      ...(typeof value.utilization === "number" ? { utilization: value.utilization / 100 } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    });
  };

  add("five_hour", claudeWindowLabel("five_hour"), limits.five_hour);
  add("seven_day", claudeWindowLabel("seven_day"), limits.seven_day);
  add("seven_day_oauth_apps", "Weekly · OAuth apps", limits.seven_day_oauth_apps);
  add("seven_day_opus", claudeWindowLabel("seven_day_opus"), limits.seven_day_opus);
  add("seven_day_sonnet", claudeWindowLabel("seven_day_sonnet"), limits.seven_day_sonnet);
  for (const [index, value] of (limits.model_scoped ?? []).entries()) {
    const id = `model_scoped:${value.display_name || index}`;
    add(id, `Weekly · ${value.display_name || "model"}`, value);
  }
  return windows;
}

function quotaStatus(windows: RateLimitWindow[], fallback: RateLimitInfo["status"] = "allowed"): RateLimitInfo["status"] {
  if (fallback === "rejected") return "rejected";
  const max = Math.max(...windows.map((window) => normalizeUtilization(window.utilization) ?? 0), 0);
  return max >= 100 ? "rejected" : max >= 80 ? "allowed_warning" : "allowed";
}

/**
 * A persistent Claude conversation: one long-lived SDK `query()` driven in
 * streaming-input mode. Follow-up turns push into the same input stream, so the
 * CLI process and context stay warm — no per-message cold start.
 */
type UserContent = string | Array<Record<string, unknown>>;

class ClaudeSession implements AgentSession {
  private q: Query;
  // Pending user messages fed into the live streaming-input generator. `priority:
  // "now"` marks a mid-turn steer (injected into the running turn) vs a normal
  // message that opens a fresh turn.
  private queue: { role: "user"; content: UserContent; priority?: "now" }[] = [];
  private wake: (() => void) | null = null;
  private disposed = false;
  /** Set once, by dispose(). Reused by send()'s post-dispose guard so a call
   *  that arrives just after teardown reports the same "why" as the turn that
   *  was actually interrupted, instead of a bare unlabeled "disposed". */
  private disposedReason: string | null = null;
  /** True once the SDK message stream has ended (CLI process gone). A dead session
   *  can never emit a `result`, so sends against it must fail fast instead of
   *  parking forever (the view drops the session and the next message starts fresh). */
  private ended = false;
  private onEvent: ((e: AgentEvent) => void) | null = null;
  /** Latest system/init capability snapshot (skills/commands/agents/MCP). */
  caps: import("./types").SessionCaps | null = null;
  onCaps: ((caps: import("./types").SessionCaps) => void) | null = null;
  /** Latest native Claude plan quota snapshot from `rate_limit_event`. Stored so
   *  a late reader (tab switch) can render the badge without a fresh event. */
  rateLimit: import("./types").RateLimitInfo | null = null;
  private resolveTurn: (() => void) | null = null;
  private rejectTurn: ((e: unknown) => void) | null = null;
  private sessionId?: string;
  /** task_id → launching Workflow tool_use_id. task_updated events carry no
   *  tool_use_id, so the binding from task_started resolves them; doubles as
   *  the "this task IS a workflow" gate for task_progress. */
  private workflowTasks = new Map<string, string>();
  /** task_id → launching Agent tool_use_id, for BACKGROUNDED subagents. The
   *  Agent tool returns its result at launch (~1s) while the agent keeps
   *  running; these `system/task_*` echoes are the only window into its real
   *  lifecycle — same shape as `workflowTasks`, same reason. */
  private subagentTasks = new Map<string, string>();
  private permSeed = 0;
  /** Force-deny callback for an in-flight permission request, so interrupt/dispose
   *  unblock the SDK (otherwise parked waiting for canUseTool to resolve → turn hangs). */
  private denyPending: (() => void) | null = null;
  /** Per-turn tail of CLI stderr lines, surfaced when a turn ends in an error whose
   *  `result` is empty (e.g. error_during_execution). Cleared at the start of send(). */
  private stderrTail: string[] = [];
  /** True once WE interrupted the in-flight turn (Stop button, watchdog, dispose).
   *  The CLI reports any SDK interrupt as an `error_during_execution` result even
   *  though the process and session survive (verified on CLI 2.1.195–2.1.218:
   *  its clean-abort classification only covers aborted_streaming/aborted_tools,
   *  and an SDK interrupt lands outside both windows). This flag lets route()
   *  tell a requested abort from a genuine mid-turn failure. Cleared per send(). */
  private interruptRequested = false;
  /** input_tokens + output_tokens from the most recently completed turn's
   *  `result` message (W0 cost governance — real per-turn spend, not a strlen
   *  guess). Synchronous the instant `send()` resolves, unlike `contextUsage()`
   *  which is an async control round-trip that can race a short-lived
   *  utility session's `dispose()`. `null` until a `result` with `usage` arrives. */
  private lastResultUsage: { inputTokens: number; outputTokens: number } | null = null;

  /** The streaming-input side of the query: yields queued user messages,
   *  parking on `wake` while the queue is empty, until disposed. */
  private async *input(): AsyncGenerator<{
    type: "user";
    message: { role: "user"; content: UserContent };
    parent_tool_use_id: null;
    priority?: "now" | "next" | "later";
  }> {
    while (!this.disposed) {
      if (this.queue.length === 0) {
        await new Promise<void>((r) => (this.wake = r));
        if (this.disposed) return;
      }
      // Split the SDK-visible message from Exo's private `priority` marker so
      // the marker never leaks into MessageParam.
      const { priority, ...message } = this.queue.shift()!;
      yield { type: "user", message, parent_tool_use_id: null, ...(priority ? { priority } : {}) };
    }
  }

  constructor(opts: SessionOpts) {
    this.sessionId = opts.resumeSessionId;
    this.q = query({
      // The generator yields structurally-valid SDKUserMessages, but our internal
      // UserContent (`Array<Record<string, unknown>>`, built in send() where image
      // blocks carry `media_type: string`) is intentionally looser than the SDK's
      // strict `MessageParam.content` (`ContentBlockParam[]` with a media-type
      // union) — so it's a downcast to the streaming-input type the SDK expects,
      // not `any`.
      prompt: this.input() as AsyncIterable<SDKUserMessage>,
      options: {
        cwd: opts.cwd,
        // Load filesystem settings (CLAUDE.md + .claude/settings.json) explicitly —
        // parity with the bare Claude Code CLI. Pinned rather than relying on the
        // SDK's implicit "omitted = load all" default, which has flipped between SDK
        // majors: this keeps CLAUDE.md honored on ANY vault, even one with no
        // memory scaffold at all. Must include "project" for CLAUDE.md (SDK docs).
        settingSources: ["user", "project", "local"],
        ...(opts.model && opts.model !== "default" ? { model: opts.model } : {}),
        ...(opts.effort && opts.effort !== "default"
          ? { effort: opts.effort as "low" | "medium" | "high" | "xhigh" | "max" }
          : {}),
        ...(opts.autoCompact ? { autoCompactEnabled: true } : {}),
        // Adaptive thinking is already the default for supporting models (Opus
        // 4.6+/Fable 5.x), but those models default the *display* to `omitted`, so
        // thinking-delta events arrive with EMPTY text and the Reasoning block
        // renders blank. Setting `display: "summarized"` only unhides the summary
        // — it does not change whether the model thinks. Harmless on older models.
        thinking: { type: "adaptive", display: "summarized" },
        ...(() => {
          // Use Claude Code's OWN default system prompt (tool discipline,
          // conciseness — which keeps token use down — plan/todo behavior, and a
          // cache-friendly prefix) and APPEND Exo's memory + optional user prompt.
          // Passing a bare string here would REPLACE CC's system prompt, turning the
          // agent into a raw, more verbose Claude that behaves nothing like CC.
          const append = [EXO_HOUSE_RULES, opts.systemPrompt, opts.memoryPreamble].filter(Boolean).join("\n\n");
          return {
            systemPrompt: {
              type: "preset" as const,
              preset: "claude_code" as const,
              ...(append ? { append } : {}),
            },
          };
        })(),
        ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
        pathToClaudeCodeExecutable: opts.cli.bin,
        // Obsidian (a GUI app) doesn't inherit the login-shell PATH, so external
        // MCP stdio servers the CLI spawns (e.g. `npx @playwright/mcp`, plugin
        // `.cjs` runners needing `node`) fail to launch and surface as "isn't
        // connected". Pass the enriched PATH that cli.ts already resolves — the
        // same fix the Codex provider carries (codex.ts). HTTP servers (e.g. a
        // local Thymer port) are unaffected: those fail only when their app is down.
        // Also defaults an idle timeout for external MCP tool calls, so a hung
        // server fails the call instead of freezing the turn (core/mcp-guard.ts).
        env: claudeCliEnv(process.env, opts.cli.pathEnv),
        includePartialMessages: true,
        // Keep a short tail of CLI stderr so an opaque execution error (empty
        // `result`) can still surface actionable detail. Bounded ring buffer.
        stderr: (data: string) => {
          for (const line of data.split("\n")) {
            const t = line.trim();
            if (!t) continue;
            this.stderrTail.push(t.length > 400 ? t.slice(0, 400) + "…" : t);
            if (this.stderrTail.length > 12) this.stderrTail.shift();
          }
        },
        // In-process Obsidian tools (if enabled). strictMcpConfig keeps only
        // this server (no external MCP) for a fast, predictable cold start.
        ...(opts.obsidianServer
          ? {
              mcpServers: {
                obsidian: opts.obsidianServer as import("@anthropic-ai/claude-agent-sdk").McpServerConfig,
              },
            }
          : {}),
        // Hooks are controlled solely by runHooks (CC parity — CC runs hooks by
        // default). Fast startup now only skips external MCP servers.
        ...(opts.runHooks ? {} : { disableAllHooks: true }),
        ...(opts.fastStartup
          ? { strictMcpConfig: true, ...(opts.obsidianServer ? {} : { mcpServers: {} }) }
          : (() => {
              // External MCP is on: still skip external Obsidian-vault servers,
              // redundant here and a known source of hung turns. Denied via
              // flag-scope settings, so the user's own config stays untouched.
              const deny = obsidianMcpDenials(opts.cwd);
              return deny.length ? { settings: { deniedMcpServers: deny } } : {};
            })()),
        ...(opts.toolsEnabled
          ? {
              permissionMode: opts.permissionMode,
              canUseTool: (toolName, toolInput, ctx) =>
                new Promise((resolve) => {
                  const suggestions = ctx?.suggestions;
                  let settled = false;
                  const finish = (d: import("./types").PermissionDecision) => {
                    if (settled) return;
                    settled = true;
                    this.denyPending = null;
                    if (d.behavior === "allow") {
                      resolve({
                        behavior: "allow",
                        updatedInput: toolInput,
                        ...(d.remember && suggestions ? { updatedPermissions: suggestions } : {}),
                      });
                    } else {
                      resolve({ behavior: "deny", message: d.message || "Denied by user." });
                    }
                  };
                  // If the turn is interrupted/disposed while this is pending, deny so the
                  // SDK can unwind and emit a result (instead of parking forever).
                  this.denyPending = () => finish({ behavior: "deny", message: "Interrupted." });
                  this.onEvent?.({
                    kind: "permission-request",
                    id: `perm-${++this.permSeed}`,
                    tool: toolName,
                    input: toolInput,
                    resolve: finish,
                  });
                }),
              // When the Obsidian server is active, ALIAS the built-in
              // AskUserQuestion to our ask_user card UI instead of disallowing it:
              // a disallowedTools entry is treated as a user deny rule, and the
              // permission classifier extends that deny to mcp__obsidian__ask_user
              // (same intent, different tool) — blocking BOTH question paths.
              ...(opts.obsidianServer
                ? {
                    toolAliases: { AskUserQuestion: "mcp__obsidian__ask_user" },
                    ...(opts.nativeFirst ? { disallowedTools: NATIVE_FIRST_DISALLOW } : {}),
                  }
                : {}),
            }
          : // Pure-chat (tools off): use the SDK's `tools: []` switch ("disable all
            // built-in tools") rather than a hand-maintained disallowedTools denylist.
            // A denylist can drift as the SDK adds tools and — worse — a deny is read
            // as a user rule the permission classifier extends to same-intent tools
            // (the exact cascade that silently killed ask_user). `tools: []` can't drift
            // or cascade.
            { tools: [] }),
      },
    });

    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for await (const msg of this.q as AsyncIterable<ClaudeMsg>) {
        if (this.disposed) break;
        this.route(msg);
      }
      // The stream can complete WITHOUT a `result` for an in-flight turn (CLI
      // process exited mid-turn). Nothing else will ever settle that send() —
      // the view would wait forever with the composer stuck on "streaming".
      // No-op when the turn already settled or on dispose (handles are null).
      this.denyPending?.();
      this.settleTurn(new Error("Claude session ended unexpectedly."));
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.denyPending?.();
      // Only surface this as a TURN error while a turn is actually in flight.
      // `onEvent` is assigned per-send (below) and never cleared, so without
      // this guard a pump failure that happens while IDLE — CLI crash, machine
      // sleep, `claude` upgraded underneath us — routes into the handler of the
      // LAST COMPLETED turn: it appends an error card + Retry under a finished,
      // correct answer, fires an OS notification with nothing running, and
      // pushes an error segment into that turn's `ctx.segments` — the same array
      // already stored in `c.messages`, so the corruption is persisted and
      // survives a reload. Checked before `settleTurn`, which clears the handle.
      // Codex guards the identical emit in `failTransport`.
      if (this.resolveTurn) this.onEvent?.({ kind: "error", message: m });
      this.settleTurn(err instanceof Error ? err : new Error(m));
    } finally {
      this.ended = true;
    }
  }

  /** Background-run progress (`system/task_*`). task_started binds task_id →
   *  the launching tool_use; task_progress carries the incremental agent
   *  roster (workflows) or a liveness echo (subagents); task_updated carries
   *  the terminal status. Progress events carry their own tool_use_id, so the
   *  binding is also registered lazily — a missed task_started (e.g. no
   *  listener attached at that moment) doesn't mute the rest of the run.
   *  Two task families, two maps:
   *   - `task_type === "local_workflow"` → workflow roster events.
   *   - `subagent_type` present → a BACKGROUNDED Agent tool call (foreground
   *     subagents never become tasks: they stream nested tool_use with
   *     parent_tool_use_id instead). `skip_transcript` marks ambient
   *     housekeeping tasks the SDK asks consumers to hide — dropped here.
   *  Non-workflow, non-subagent background tasks (shells) pass through
   *  untouched: they never enter either binding map. */
  private routeTaskEvent(msg: ClaudeMsg, taskId: string, emit: (e: AgentEvent) => void): void {
    if (msg.subtype === "task_started") {
      if (msg.task_type === "local_workflow" && msg.tool_use_id) {
        this.workflowTasks.set(taskId, msg.tool_use_id);
        emit({ kind: "workflow-progress", toolUseId: msg.tool_use_id, taskId, name: msg.workflow_name, entries: [] });
      } else if (msg.tool_use_id && msg.subagent_type && !msg.skip_transcript) {
        this.subagentTasks.set(taskId, msg.tool_use_id);
        emit({ kind: "agent-task", toolUseId: msg.tool_use_id, taskId, description: msg.description });
      }
    } else if (msg.subtype === "task_progress") {
      const toolUseId = msg.tool_use_id ?? this.workflowTasks.get(taskId);
      if (toolUseId && msg.workflow_progress?.length) {
        this.workflowTasks.set(taskId, toolUseId); // lazy binding for task_updated
        emit({ kind: "workflow-progress", toolUseId, taskId, entries: msg.workflow_progress });
      } else if (msg.tool_use_id && msg.subagent_type && !msg.skip_transcript) {
        this.subagentTasks.set(taskId, msg.tool_use_id); // lazy binding for task_updated
        emit({ kind: "agent-task", toolUseId: msg.tool_use_id, taskId, description: msg.description });
      }
    } else if (msg.subtype === "task_updated") {
      const terminal = msg.patch?.status === "completed" || msg.patch?.status === "failed" || msg.patch?.status === "killed";
      const wfToolUse = this.workflowTasks.get(taskId);
      if (wfToolUse && msg.patch?.status) {
        emit({ kind: "workflow-progress", toolUseId: wfToolUse, taskId, entries: [], status: msg.patch.status });
        if (terminal) this.workflowTasks.delete(taskId);
        return;
      }
      const agToolUse = this.subagentTasks.get(taskId);
      if (agToolUse && msg.patch?.status) {
        emit({ kind: "agent-task", toolUseId: agToolUse, taskId, status: msg.patch.status });
        if (terminal) this.subagentTasks.delete(taskId);
      }
    }
  }

  private route(msg: ClaudeMsg): void {
    if (msg.session_id) this.sessionId = msg.session_id;

    // Capability snapshot — arrives at process start, typically BEFORE the first
    // send (prewarm), so it must be captured ahead of the onEvent guard below.
    if (msg.type === "system" && msg.subtype === "init") {
      this.caps = {
        skills: msg.skills ?? [],
        commands: msg.slash_commands ?? [],
        agents: msg.agents ?? [],
        tools: msg.tools ?? [],
        mcpServers: (msg.mcp_servers ?? []).flatMap((s) =>
          s?.name ? [{ name: s.name, status: s.status ?? "unknown" }] : []
        ),
      };
      this.onCaps?.(this.caps);
      return;
    }

    // Rate-limit snapshot (claude.ai subscription only). Can arrive during
    // prewarm before the first send (onEvent null), so — like the init snapshot —
    // store it unconditionally and emit only when a listener is attached.
    if (msg.type === "rate_limit_event") {
      const info = msg.rate_limit_info;
      if (info && typeof info.status === "string") {
        const nextWindow = info.rateLimitType
          ? {
              id: info.rateLimitType,
              label: claudeWindowLabel(info.rateLimitType),
              ...(typeof info.utilization === "number" ? { utilization: info.utilization } : {}),
              ...(typeof info.resetsAt === "number" ? { resetsAt: info.resetsAt } : {}),
            }
          : null;
        const windows = nextWindow
          ? [...(this.rateLimit?.windows ?? []).filter((window) => window.id !== nextWindow.id), nextWindow]
          : this.rateLimit?.windows;
        this.rateLimit = {
          status: info.status,
          utilization: info.utilization,
          resetsAt: info.resetsAt,
          windowType: info.rateLimitType,
          ...(windows?.length ? { windows } : {}),
          ...(this.rateLimit?.planType ? { planType: this.rateLimit.planType } : {}),
        };
        this.onEvent?.({
          kind: "rate-limit",
          status: info.status,
          utilization: info.utilization,
          resetsAt: info.resetsAt,
          windowType: info.rateLimitType,
          ...(windows?.length ? { windows } : {}),
          ...(this.rateLimit.planType ? { planType: this.rateLimit.planType } : {}),
        });
      }
      return;
    }

    const emit = this.onEvent;
    if (!emit) return;

    if (msg.type === "system" && msg.subtype === "compact_boundary") {
      emit({ kind: "compact", summary: msg.compact_summary });
      return;
    }
    if (msg.type === "system" && msg.task_id && msg.subtype?.startsWith("task_")) {
      this.routeTaskEvent(msg, msg.task_id, emit);
      return;
    }
    if (msg.type === "stream_event") {
      const ev = msg.event;
      if (ev?.type === "content_block_delta") {
        if (ev.delta?.type === "text_delta" && ev.delta.text) {
          emit({ kind: "text-delta", text: ev.delta.text });
        } else if (ev.delta?.type === "thinking_delta" && ev.delta.thinking) {
          emit({ kind: "thinking-delta", text: ev.delta.thinking });
        }
      }
    } else if (msg.type === "assistant") {
      // Subagent (Task) tool activity carries the parent Task's tool_use id so the
      // view can nest it under that card instead of rendering flat top-level cards.
      const pid = msg.parent_tool_use_id ?? undefined;
      for (const b of msg.message?.content ?? []) {
        if (b.type === "tool_use") {
          emit({ kind: "tool-call-start", id: b.id ?? "", name: b.name ?? "", input: b.input, parentId: pid });
        }
      }
    } else if (msg.type === "user") {
      const pid = msg.parent_tool_use_id ?? undefined;
      const c = msg.message?.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === "tool_result") {
            emit({
              kind: "tool-call-result",
              id: b.tool_use_id ?? "",
              ok: !b.is_error,
              output: stringifyToolResult(b.content),
              parentId: pid,
            });
          }
        }
      }
    } else if (msg.type === "result") {
      const interrupted = this.interruptRequested;
      this.interruptRequested = false;
      // W0: capture the real per-turn token count synchronously, BEFORE the
      // async contextUsage() round-trip below (which a short-lived utility
      // session may dispose() before it ever resolves).
      this.lastResultUsage = msg.usage
        ? { inputTokens: msg.usage.input_tokens ?? 0, outputTokens: msg.usage.output_tokens ?? 0 }
        : null;
      // A locally-requested interrupt comes back as error_during_execution (see
      // interruptRequested): the session is healthy, so skip the fake "CLI
      // crashed" error and settle the turn quietly like a clean abort.
      const failed = msg.is_error === true || (!!msg.subtype && msg.subtype !== "success");
      if (failed && !(interrupted && msg.subtype === "error_during_execution")) {
        let message = msg.result || `Claude ended: ${msg.subtype}`;
        if (this.stderrTail.length) {
          message += "\n\nCLI stderr (tail):\n" + this.stderrTail.slice(-6).join("\n");
        }
        emit({ kind: "error", message });
      }
      emit({ kind: "turn-end", sessionId: this.sessionId });
      this.settleTurn();
      // Context usage is a control round-trip — fetch after the turn resolves
      // so it never delays the UI; emit when (and if) it returns.
      void this.contextUsage().then((u) => {
        if (u) emit({ kind: "usage", usage: u });
      });
    }
  }

  /** Resolve (or reject) the in-flight turn exactly once and clear its handles. */
  private settleTurn(err?: unknown): void {
    const resolve = this.resolveTurn;
    const reject = this.rejectTurn;
    this.resolveTurn = this.rejectTurn = null;
    if (err !== undefined) reject?.(err);
    else resolve?.();
  }

  send(
    message: string,
    onEvent: (e: AgentEvent) => void,
    images?: import("./types").ImageAttachment[],
    // Codex-only per-turn override (see AgentSession.send doc) — Claude's own
    // Agent tool gives real subagent isolation instead, so there's nothing to
    // thread this into here.
    _systemPromptOverride?: string
  ): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error(`Session disposed (${this.disposedReason ?? "unknown"}).`));
    }
    // A dead stream can never answer: fail fast so the view drops this session
    // and the next message starts a fresh one (instead of parking forever — the
    // idle-session variant of this is a pre-warmed CLI that died while idle).
    if (this.ended) return Promise.reject(new Error("Claude session ended — sending again starts a fresh session."));
    // Guard against overlapping turns: a second send() while one is in flight would
    // orphan the first promise (its resolve/reject would be overwritten).
    if (this.resolveTurn) return Promise.reject(new Error("A turn is already in flight."));
    this.stderrTail = []; // per-turn tail — drop any lines from a prior turn
    this.interruptRequested = false; // an old interrupt must not excuse this turn's errors
    this.onEvent = onEvent;
    const content: UserContent =
      images && images.length
        ? [
            ...images.map((img) => ({
              type: "image",
              source: { type: "base64", media_type: img.mediaType, data: img.dataB64 },
            })),
            { type: "text", text: message },
          ]
        : message;
    return new Promise<void>((resolve, reject) => {
      this.resolveTurn = resolve;
      this.rejectTurn = reject;
      this.queue.push({ role: "user", content });
      const w = this.wake;
      this.wake = null;
      w?.();
    });
  }

  /** Mid-turn steering (Claude Code parity): inject a user message into the turn
   *  that's currently in flight instead of opening a new one. Pushes onto the same
   *  streaming-input generator the SDK is actively draining, tagged `priority:
   *  "now"` so the CLI folds it into the running turn. Returns false (caller falls
   *  back to queuing) when there's no in-flight turn or the session can't accept
   *  input — a dead/disposed stream, or no turn to steer.
   *
   *  Safe because this is exactly how `compact()` already pushes a mid-turn user
   *  message, and the SDK's streaming-input contract accepts multiple user
   *  messages during a turn (SDKUserMessage carries a `priority: 'now'|'next'|
   *  'later'` field for precisely this). The in-flight turn's single `result`
   *  still settles the original send()'s promise. */
  steer(text: string, images?: import("./types").ImageAttachment[]): boolean {
    if (this.disposed || this.ended) return false;
    // Steering is text-only — decline when images are attached so the caller falls
    // back to queuing (which sends them as a normal multimodal turn). Keeping this
    // here makes the shared send() path provider-agnostic.
    if (images?.length) return false;
    // Only steer when a turn is actually running; otherwise the caller should
    // send() normally (which opens a fresh turn and tracks its resolve/reject).
    if (!this.resolveTurn) return false;
    this.queue.push({ role: "user", content: [{ type: "text", text }], priority: "now" });
    const w = this.wake;
    this.wake = null;
    w?.();
    return true;
  }

  /** Change the permission mode live (e.g. toggling plan mode). */
  setPermissionMode(mode: import("./types").PermissionMode): void {
    if (this.disposed) return;
    try {
      void Promise.resolve(this.q.setPermissionMode?.(mode)).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  /** Trigger conversation compaction via the CLI's /compact command, optionally
   *  steered by free-text instructions.
   *
   *  The Agent SDK exposes NO dedicated compaction method: the `Query` interface
   *  (sdk.d.ts) offers interrupt / setModel / setPermissionMode / setMcpPermission…
   *  / getContextUsage etc., but nothing for compaction. `/compact` is a *local
   *  slash command* the CLI intercepts, so the supported form is to push it as a
   *  user message on the streaming-input queue — with any instructions appended
   *  as `/compact <instructions>` (the same shape the interactive CLI accepts). */
  compact(instructions?: string): void {
    if (this.disposed) return;
    const trimmed = instructions?.trim();
    const content = trimmed ? `/compact ${trimmed}` : "/compact";
    this.queue.push({ role: "user", content });
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  /** Call q.interrupt() and swallow both sync throws and promise rejections
   *  (it rejects when the query has already ended — harmless). */
  private safeInterrupt(): void {
    this.interruptRequested = true;
    try {
      void Promise.resolve(this.q.interrupt?.()).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  interrupt(): void {
    if (this.disposed) return;
    // Unblock a pending permission first so the SDK can unwind and emit a result.
    this.denyPending?.();
    // Only interrupt when a turn is actually running — calling q.interrupt() on an
    // idle/closed transport throws "ProcessTransport is not ready for writing".
    if (this.resolveTurn) this.safeInterrupt();
  }

  dispose(reason: string): void {
    if (this.disposed) return; // idempotent — dispose may be called more than once
    this.disposed = true;
    this.disposedReason = reason;
    this.denyPending?.();
    try {
      this.wake?.();
    } catch {
      /* ignore */
    }
    // Interrupt only if a turn is in flight (avoids the transport error on idle teardown).
    if (this.resolveTurn) this.safeInterrupt();
    // The pump loop breaks on `disposed` without emitting a result, so settle here
    // to ensure any awaiting send() promise is released. `reason` rides into the
    // rejected error so a session killed mid-turn is diagnosable from the
    // persisted transcript alone (see AgentSession.dispose doc).
    this.settleTurn(new Error(`Session disposed (${reason}).`));
  }

  /** W0 cost governance: input_tokens + output_tokens from the most recently
   *  completed turn's `result` message, or `null` before any turn has completed
   *  or when that turn's `result` carried no `usage`. Prefer this over
   *  `contextUsage()` for recording a single utility pass's spend — it's
   *  synchronous (no control round-trip) and reflects exactly this turn, not
   *  the whole session's running context-window occupancy. */
  lastTurnTokens(): number | null {
    if (!this.lastResultUsage) return null;
    return this.lastResultUsage.inputTokens + this.lastResultUsage.outputTokens;
  }

  private publishPlanUsage(usage: SDKControlGetUsageResponse): void {
    if (!usage.rate_limits_available || !usage.rate_limits) return;
    const windows = claudeRateLimitWindows(usage);
    if (!windows.length) return;
    const primary = windows.find((window) => window.id === "five_hour") ?? windows[0];
    const info: RateLimitInfo = {
      status: quotaStatus(windows),
      utilization: primary?.utilization,
      resetsAt: primary?.resetsAt,
      windowType: primary?.id,
      windows,
      ...(usage.subscription_type ? { planType: usage.subscription_type } : {}),
    };
    this.rateLimit = info;
    this.onEvent?.({ kind: "rate-limit", ...info });
  }

  async refreshRateLimits(): Promise<void> {
    try {
      const usage = await this.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?.();
      if (usage) this.publishPlanUsage(usage);
    } catch {
      /* Native plan quotas are best-effort and unavailable for non-subscription sessions. */
    }
  }

  async contextUsage(): Promise<ContextUsage | null> {
    let result: ContextUsage | null = null;
    try {
      const u = await this.q.getContextUsage?.();
      if (u && typeof u.totalTokens === "number" && typeof u.maxTokens === "number" && u.maxTokens > 0) {
        result = { used: u.totalTokens, total: u.maxTokens };
      }
    } catch {
      /* context usage unavailable */
    }

    // The same native control response powers Claude's /usage panel: cost plus
    // all plan windows (5-hour, weekly, and model-scoped) when available.
    try {
      const usage = await this.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?.();
      if (usage) {
        this.publishPlanUsage(usage);
        if (result && typeof usage.session?.total_cost_usd === "number") {
          result.costUsd = usage.session.total_cost_usd;
        }
      }
    } catch {
      /* cost and native plan quotas unavailable — omit silently */
    }
    return result;
  }
}

export const claudeAdapter: ProviderAdapter = {
  id: "claude",
  displayName: "Claude",
  brandColor: "#d97757",

  models(): ModelOption[] {
    // Pinned, verified model IDs (checked 2026-09-29 against the Claude Code
    // model-config reference). Add newer ones here as they ship. Users can also type any
    // custom model id in settings.
    return [
      { id: "claude-fable-5-1", label: "Fable 5.1" },
      { id: "claude-fable-5", label: "Fable 5" },
      { id: "claude-opus-5-5", label: "Opus 5.5" },
      { id: "claude-opus-5", label: "Opus 5" },
      { id: "claude-opus-4-8", label: "Opus 4.8" },
      { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
      { id: "claude-sonnet-5", label: "Sonnet 5" },
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
      { id: "claude-haiku-4-5", label: "Haiku 4.5" },
    ];
  },

  createSession(opts: SessionOpts): AgentSession {
    return new ClaudeSession(opts);
  },
};

function stringifyToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : ""))
      .join("");
  }
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

interface ClaudeMsg {
  type?: string;
  subtype?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  result?: string;
  /** Root-level result failure flag. The CLI can emit `subtype: "success"`
   *  together with `is_error: true` (for example when authentication is
   *  missing), so subtype alone is not a reliable success signal. */
  is_error?: boolean;
  compact_summary?: string;
  // Per-turn token usage on the `result` message (SDKResultMessage.usage in the
  // Agent SDK's types — verified against node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts).
  usage?: { input_tokens?: number; output_tokens?: number };
  // rate_limit_event payload (claude.ai subscription sessions only).
  rate_limit_info?: {
    status: import("./types").RateStatus;
    utilization?: number;
    resetsAt?: number;
    rateLimitType?: string;
  };
  // system/task_* background-run progress (workflow runs surface ONLY here —
  // per-agent activity never appears as tool_use events; probe 2026-07-21)
  task_id?: string;
  tool_use_id?: string;
  task_type?: string;
  workflow_name?: string;
  workflow_progress?: import("../core/workflow-progress").WorkflowProgressEntry[];
  patch?: { status?: string };
  // system/task_* fields for BACKGROUNDED subagents (SDKTaskStartedMessage /
  // SDKTaskProgressMessage in the Agent SDK's types): `subagent_type` is set
  // only for Agent-tool tasks; `skip_transcript` marks ambient housekeeping
  // tasks consumers should hide.
  subagent_type?: string;
  description?: string;
  skip_transcript?: boolean;
  // system/init capability snapshot (CLI ≥2.1.199 emits it in streaming-input too)
  skills?: string[];
  slash_commands?: string[];
  agents?: string[];
  tools?: string[];
  mcp_servers?: Array<{ name?: string; status?: string }>;
  event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
  message?: {
    content?: Array<{
      type?: string;
      id?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      is_error?: boolean;
      content?: unknown;
    }>;
  };
}
