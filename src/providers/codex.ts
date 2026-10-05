import { CodexSession as AppServerCodexSession } from "./codex-app-server";
import type {
  AgentEvent,
  AgentSession,
  ModelOption,
  ProviderAdapter,
  SessionOpts,
} from "./types";

export {
  CodexSession,
  type CodexSessionRuntime,
} from "./codex-app-server";

/** GPT-5-family input context window — the ring's denominator for Codex.
 *  A constant, not per-model: close enough for a fill gauge, and the JSONL
 *  stream doesn't report the window size. */
const CODEX_CONTEXT_WINDOW = 272_000;

/** TOML inline-table override that registers the bridge as codex's `obsidian`
 *  MCP server. Values are TOML basic strings — escape backslashes and quotes. */
export function codexMcpOverride(b: { port: number; token: string; scriptPath: string }): string {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return (
    `mcp_servers.obsidian={command="node",args=["${esc(b.scriptPath)}"],` +
    `env={EXO_BRIDGE_PORT="${b.port}",EXO_BRIDGE_TOKEN="${esc(b.token)}"},` +
    `startup_timeout_sec=10,tool_timeout_sec=3600}`
  );
}

export interface CodexParseState {
  sessionId?: string;
  streamed: boolean;
  finalText: string;
}

/**
 * Parse one JSONL line from `codex exec --json` and emit AgentEvents.
 * Handles both the current schema (0.142+: thread.started / item.* / turn.*)
 * and the legacy one ({msg:{type:...}}) so older CLIs keep working.
 */
export function handleCodexLine(
  line: string,
  state: CodexParseState,
  onEvent: (e: AgentEvent) => void,
): void {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  const topType = String(obj.type ?? "");

  if (topType === "thread.started" && typeof obj.thread_id === "string") {
    state.sessionId = obj.thread_id;
    return;
  }

  if (topType === "turn.failed") {
    const err = (obj.error ?? {}) as Record<string, unknown>;
    if (typeof err.message === "string") onEvent({ kind: "error", message: err.message });
    return;
  }

  if (topType === "turn.completed") {
    // `usage.input_tokens` counts the FULL prompt of this turn (system +
    // transcript + tools), so input+output approximates current context
    // occupancy — good enough to drive the context ring for Codex too.
    const usage = (obj.usage ?? {}) as Record<string, unknown>;
    const input = Number(usage.input_tokens ?? 0);
    const output = Number(usage.output_tokens ?? 0);
    if (input > 0) {
      onEvent({ kind: "usage", usage: { used: input + output, total: CODEX_CONTEXT_WINDOW } });
    }
    return;
  }

  if (topType === "item.started" || topType === "item.completed") {
    const item = (obj.item ?? {}) as Record<string, unknown>;
    const itemType = String(item.type ?? "");
    const id = String(item.id ?? "cx");
    const done = topType === "item.completed";

    if (itemType === "agent_message" && done && typeof item.text === "string") {
      onEvent({ kind: "text-delta", text: state.streamed ? `\n\n${item.text}` : item.text });
      state.streamed = true;
    } else if (itemType === "reasoning" && done && typeof item.text === "string") {
      onEvent({ kind: "thinking-delta", text: item.text });
    } else if (itemType === "command_execution") {
      if (done) {
        onEvent({
          kind: "tool-call-result",
          id,
          ok: Number(item.exit_code ?? 0) === 0,
          output: String(item.aggregated_output ?? ""),
        });
      } else {
        onEvent({ kind: "tool-call-start", id, name: "Bash", input: { command: String(item.command ?? "") } });
      }
    } else if (itemType === "file_change") {
      const changes = Array.isArray(item.changes) ? (item.changes as Record<string, unknown>[]) : [];
      const ok = item.status !== "failed";
      for (const c of changes) {
        const path = String(c.path ?? "");
        if (done) onEvent({ kind: "tool-call-result", id: `${id}:${path}`, ok, output: "" });
        else onEvent({ kind: "tool-call-start", id: `${id}:${path}`, name: "Edit", input: { file_path: path } });
      }
    } else if (itemType === "error" && done && typeof item.message === "string") {
      // In-band transcript error item — NOT a turn verdict. Codex emits these
      // (e.g. the benign "Exceeded skills context budget" notice when many skills
      // are installed) and still completes the turn with a real agent_message
      // afterward. Surface it as a non-fatal notice so the answer isn't discarded;
      // only turn.failed (above) and a non-zero process exit are fatal.
      onEvent({ kind: "notice", message: item.message });
    }
    return;
  }

  // Legacy schema: {id, session_id, msg:{type:...}}
  const msg = (obj.msg ?? obj) as Record<string, unknown>;
  const type = String(msg.type ?? "");
  const sid = (obj.session_id ?? msg.session_id) as string | undefined;
  if (sid) state.sessionId = sid;

  if (type === "agent_message_delta" && typeof msg.delta === "string") {
    state.streamed = true;
    onEvent({ kind: "text-delta", text: msg.delta });
  } else if (type === "agent_reasoning_delta" && typeof msg.delta === "string") {
    onEvent({ kind: "thinking-delta", text: msg.delta });
  } else if (type === "agent_message" && typeof msg.message === "string") {
    state.finalText = msg.message;
  } else if (type === "exec_command_begin") {
    const id = String(msg.call_id ?? msg.id ?? "cx");
    const command = Array.isArray(msg.command)
      ? (msg.command as unknown[]).join(" ")
      : String(msg.command ?? "");
    onEvent({ kind: "tool-call-start", id, name: "Bash", input: { command } });
  } else if (type === "exec_command_end") {
    const id = String(msg.call_id ?? msg.id ?? "");
    const out = String(msg.aggregated_output ?? msg.stdout ?? msg.output ?? "");
    onEvent({ kind: "tool-call-result", id, ok: Number(msg.exit_code ?? 0) === 0, output: out });
  } else if (type === "patch_apply_begin") {
    const changes = (msg.changes ?? {}) as Record<string, unknown>;
    for (const path of Object.keys(changes)) {
      onEvent({
        kind: "tool-call-start",
        id: `${msg.call_id ?? "patch"}:${path}`,
        name: "Edit",
        input: { file_path: path },
      });
    }
  } else if (type === "patch_apply_end") {
    const changes = (msg.changes ?? {}) as Record<string, unknown>;
    const ok = msg.success !== false;
    for (const path of Object.keys(changes)) {
      onEvent({ kind: "tool-call-result", id: `${msg.call_id ?? "patch"}:${path}`, ok, output: "" });
    }
  } else if (type === "error" && typeof msg.message === "string") {
    onEvent({ kind: "error", message: msg.message });
  }
}

/** Icon id of the OpenAI mark, registered in ui/icons.ts. */
export const OPENAI_MARK = "exo-openai-mark";

export const codexAdapter: ProviderAdapter = {
  id: "codex",
  displayName: "Codex",
  brandColor: "#19c37d",
  icon: OPENAI_MARK,
  iconTinted: false,

  models(): ModelOption[] {
    // Verified live via app-server `model/list` on codex-cli 0.156.1
    // (checked 2026-09-23), in catalog priority order. Users can also type any
    // custom model id in settings.
    return [
      { id: "gpt-6-astra", label: "GPT-6 Astra" },
      { id: "gpt-6-sol", label: "GPT-6 Sol" },
      { id: "gpt-6-luna", label: "GPT-6 Luna" },
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
      { id: "gpt-5.5", label: "GPT-5.5" },
    ];
  },

  createSession(opts: SessionOpts): AgentSession {
    return new AppServerCodexSession(opts);
  },
};
