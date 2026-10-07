import type { ResolvedCli } from "../cli";

export type ProviderId = "claude" | "codex";

export interface ModelOption {
  id: string; // value passed to the CLI ("" / "default" = CLI default)
  label: string;
}

/** Permission decision returned to the CLI for a tool-use request (Phase 2). */
export type PermissionDecision =
  | { behavior: "allow"; remember?: boolean }
  | { behavior: "deny"; message?: string };

export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions";

/**
 * Normalized event stream produced by every provider adapter, so the chat UI is
 * provider-agnostic. Phase 1 emits text-delta / turn-end / error; the tool and
 * permission events are wired in Phase 2.
 */
export type AgentEvent =
  | { kind: "text-delta"; text: string }
  | { kind: "thinking-delta"; text: string }
  | { kind: "tool-call-start"; id: string; name: string; input: unknown; parentId?: string }
  | { kind: "tool-call-result"; id: string; ok: boolean; output: string; parentId?: string }
  | {
      kind: "permission-request";
      id: string;
      tool: string;
      input: unknown;
      resolve: (d: PermissionDecision) => void;
    }
  | { kind: "usage"; usage: ContextUsage }
  | { kind: "compact"; summary?: string }
  | {
      kind: "workflow-progress";
      toolUseId: string;
      taskId: string;
      name?: string;
      entries: import("../core/workflow-progress").WorkflowProgressEntry[];
      status?: string;
    }
  | {
      kind: "agent-task";
      /** The launching Agent tool_use id — the view's card/live-task key. */
      toolUseId: string;
      taskId: string;
      /** Launch description from task_started/task_progress, if any. */
      description?: string;
      /** Terminal status patch from task_updated ("completed" | "failed" | "killed" | …);
       *  absent means the agent is (still) running. */
      status?: string;
    }
  | {
      kind: "rate-limit";
      status: RateStatus;
      utilization?: number;
      resetsAt?: number;
      windowType?: string;
      windows?: RateLimitWindow[];
      planType?: string;
    }
  | { kind: "turn-end"; sessionId?: string }
  // Non-fatal, in-band notice from the provider (e.g. Codex's "Exceeded skills
  // context budget" item). Unlike `error` it MUST NOT poison the turn or discard
  // the streamed answer — the turn can still complete normally after it.
  | { kind: "notice"; message: string }
  | { kind: "error"; message: string };

export type RateStatus = "allowed" | "allowed_warning" | "rejected";

/** One native plan/account quota window. `utilization` accepts the provider's
 *  native convention (0-1 or 0-100); the UI normalizes it before rendering. */
export interface RateLimitWindow {
  id: string;
  label: string;
  utilization?: number;
  /** Provider timestamp: epoch seconds/milliseconds, or epoch milliseconds
   *  after parsing an ISO timestamp. */
  resetsAt?: number;
  windowMinutes?: number;
}

/** Latest native plan/account quota snapshot. Claude exposes this through its
 *  `/usage` control response; Codex exposes it through account/rateLimits/read
 *  and account/rateLimits/updated. API-key/third-party sessions may omit it. */
export interface RateLimitInfo {
  status: RateStatus;
  utilization?: number;
  resetsAt?: number;
  windowType?: string;
  windows?: RateLimitWindow[];
  planType?: string;
}

export interface ContextUsage {
  used: number;
  total: number;
  /** Estimated session cost in USD, when the provider/SDK exposes it. Claude
   *  only, via an experimental SDK control request; omitted (not zero) when
   *  unavailable — the UI must degrade gracefully, never show a fake $0.00. */
  costUsd?: number;
}

/** An image attached to a user turn (base64), for multimodal input. */
export interface ImageAttachment {
  mediaType: string; // e.g. "image/png"
  dataB64: string; // base64, no data: prefix
  name?: string;
}

/** Provider-native structured question normalized to Exo's ask card. */
export interface UserQuestion {
  question: string;
  header: string;
  id: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
  secret?: boolean;
}

/** Everything fixed for the lifetime of a conversation session. */
export interface SessionOpts {
  cli: ResolvedCli;
  /** Model id, or "" / "default" for the CLI's configured default. */
  model: string;
  /** Reasoning effort: "default" | low | medium | high | xhigh | max. */
  effort: string;
  /** Optional system prompt override. */
  systemPrompt?: string;
  /** Working directory for the agent — the vault root. */
  cwd: string;
  permissionMode: PermissionMode;
  /** Whether tools (Read/Write/Edit/Bash/…) are enabled at all. */
  toolsEnabled: boolean;
  /** Skip external MCP servers for faster cold start. */
  fastStartup: boolean;
  /** Load only these external MCP servers (core/mcp-scope.ts): every other
   *  server in `known` or the config files is denied. Ignored when
   *  `fastStartup` already skips them all. */
  mcpOnly?: { allow: string[]; known: string[] };
  /** Run Claude Code hooks (.claude/settings.json). CC parity — on by default. */
  runHooks?: boolean;
  /** Resume a prior on-disk session id when (re)creating the session. */
  resumeSessionId?: string;
  /** In-process Obsidian MCP server (createSdkMcpServer return). */
  obsidianServer?: unknown;
  /** Disable built-in file tools so the agent uses Obsidian-native ones. */
  nativeFirst?: boolean;
  /** Vault memory-layer preamble appended to the system prompt. */
  memoryPreamble?: string;
  /** Auto-compact the conversation when the context window fills (token saver). */
  autoCompact?: boolean;
  /** Codex sandbox: read-only | workspace-write | danger-full-access. */
  sandboxMode?: string;
  /** Codex approval policy: untrusted | on-request | granular | never. */
  approvalPolicy?: string;
  /** Codex ↔ Obsidian tools bridge (Tranche B1): loopback executor coordinates
   *  + the generated stdio script path. Present only for Codex sessions with
   *  obsidian tools enabled. */
  codexBridge?: { port: number; token: string; scriptPath: string; stop?: () => void };
  /** OBSIDIAN_READ_TOOLS: the read-classified bridge tools. Codex asks the
   *  client to approve every MCP tool call, and the read-only sandbox must
   *  never let a mutating bridge tool through (bridge writes run in the
   *  Obsidian process, outside codex's sandbox). */
  obsidianReadTools?: ReadonlySet<string>;
  /** Render a provider-native request for user input in the owning conversation. */
  requestUserInput?: (questions: UserQuestion[]) => Promise<Record<string, string>>;
}

/** Capability snapshot from the CLI's `system/init` message — the real skills /
 *  commands / agents / MCP servers this session sees (global + plugin + vault),
 *  far beyond what a vault-folder scan can discover. Emitted by CLI ≥2.1.199 in
 *  streaming-input mode too; older CLIs never deliver it (treat as enrichment,
 *  never a gate). */
export interface SessionCaps {
  skills: string[];
  commands: string[];
  agents: string[];
  /** Every tool the session registered — built-ins AND MCP tools (Workflow,
   *  Task, ScheduleWakeup, Cron*, Monitor, ToolSearch, Skill, mcp__*…). The
   *  Capabilities panel renders this instead of a hardcoded list, which silently
   *  drifted every time the CLI added an orchestration tool. */
  tools: string[];
  mcpServers: { name: string; status: string }[];
  /** Runtime model catalog when the provider exposes one (Codex app-server). */
  models?: ModelOption[];
}

/**
 * A live conversation. For Claude this wraps a single long-lived SDK `query()`
 * in streaming-input mode — follow-up turns reuse the same process/context
 * (no per-message cold start). Codex likewise keeps one app-server process and
 * thread alive for the conversation.
 */
export interface AgentSession {
  /** Latest capability snapshot (see SessionCaps); null until init arrives. */
  caps?: SessionCaps | null;
  /** Latest provider quota snapshot (see RateLimitInfo), stored so a view can
   *  read it after switching tabs. */
  rateLimit?: RateLimitInfo | null;
  /** Invoked once when the init snapshot lands (may be before the first send). */
  onCaps?: ((caps: SessionCaps) => void) | null;
  /** Send one user turn; resolves when that turn completes.
   *  `systemPromptOverride`, when given, replaces `SessionOpts.systemPrompt` for
   *  this ONE turn only — the session's own prompt is unaffected on the next
   *  send(). This is how a named-agent binding takes over a Codex turn without
   *  spawning a new session or true subagent isolation (Claude ignores it: its
   *  Agent tool gives a real isolated subagent instead). */
  send(
    message: string,
    onEvent: (e: AgentEvent) => void,
    images?: ImageAttachment[],
    systemPromptOverride?: string
  ): Promise<void>;
  /** Inject a user message into the in-flight turn. Returns true when it was
   *  accepted into a running turn, false
   *  when there's nothing to steer or the provider can't steer this input (caller
   *  should queue instead). Both providers decline when `images` are attached
   *  because steer is text-only. */
  steer?(text: string, images?: ImageAttachment[]): boolean;
  /** Interrupt the in-flight turn. */
  interrupt(): void;
  /** Compact the conversation context using the provider's native operation.
   *  Optional free-text `instructions` steer what the compaction summary keeps
   *  (appended to the /compact slash command). */
  compact?(instructions?: string): void;
  /** Change the permission mode live; used by the plan-mode toggle. */
  setPermissionMode?(mode: PermissionMode): void;
  /** Tear down the session (kills any live process). `reason` is a short,
   *  stable tag for WHY (e.g. "working-set-retire", "user-delete",
   *  "stop-escalation") — it rides into the rejected error message of any
   *  turn this interrupts, so a session killed mid-turn is diagnosable from
   *  the persisted transcript alone instead of a call-site archaeology dig. */
  dispose(reason: string): void;
  /** Current context-window usage, if the provider exposes it. */
  contextUsage(): Promise<ContextUsage | null>;
  /** Refresh native plan/account quota windows, if the provider exposes them. */
  refreshRateLimits?(): Promise<void>;
  /** W0 cost governance: input_tokens + output_tokens from the most recently
   *  completed turn, if the provider exposes it (synchronous, no control
   *  round-trip, unlike `contextUsage()`). */
  lastTurnTokens?(): number | null;
}

export interface ProviderAdapter {
  id: ProviderId;
  displayName: string;
  /** Fixed brand accent, theme-independent. */
  brandColor: string;
  /** Registered icon id of the provider's own mark (see ui/icons.ts). */
  icon: string;
  /** Whether the mark wears `brandColor`; a monochrome mark follows the text color. */
  iconTinted: boolean;
  models(): ModelOption[];
  createSession(opts: SessionOpts): AgentSession;
}
