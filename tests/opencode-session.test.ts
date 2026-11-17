import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { OpencodeSession, type OpencodeSessionRuntime } from "../src/providers/opencode";
import type { AgentEvent, PermissionDecision, SessionCaps, SessionOpts } from "../src/providers/types";

type RpcMessage = {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
};

/** A fake `opencode acp`: records what Exo writes, lets the test answer. */
class FakeAcpProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin: Writable;
  messages: RpcMessage[] = [];
  private consumed = new Set<RpcMessage>();
  private waiters: (() => void)[] = [];

  constructor() {
    super();
    let input = "";
    this.stdin = new Writable({
      write: (chunk, _enc, cb) => {
        input += chunk.toString();
        let nl: number;
        while ((nl = input.indexOf("\n")) >= 0) {
          const line = input.slice(0, nl).trim();
          input = input.slice(nl + 1);
          if (line) this.messages.push(JSON.parse(line) as RpcMessage);
          for (const wake of this.waiters.splice(0)) wake();
        }
        cb();
      },
    });
  }

  kill = vi.fn(() => true);

  /** The next unconsumed message matching `pred`. */
  async take(pred: (m: RpcMessage) => boolean, what: string, timeoutMs = 1_000): Promise<RpcMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find((m) => pred(m) && !this.consumed.has(m));
      if (found) {
        this.consumed.add(found);
        return found;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for ${what}`);
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), remaining);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  next(method: string): Promise<RpcMessage> {
    return this.take((m) => m.method === method, method);
  }

  /** Exo's answer to a request the agent sent with `id`. */
  answerTo(id: number): Promise<RpcMessage> {
    return this.take((m) => m.id === id && !m.method, `answer to ${id}`);
  }

  reply(req: RpcMessage, result: unknown): void {
    this.push({ jsonrpc: "2.0", id: req.id, result });
  }

  update(update: Record<string, unknown>): void {
    this.push({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "ses_1", update } });
  }

  push(message: RpcMessage): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

const MODEL_OPTION = {
  id: "model",
  currentValue: "omlx/qwen",
  options: [
    { value: "omlx/qwen", name: "omlx/qwen" },
    { value: "ollama/llama", name: "ollama/llama" },
  ],
};
const EFFORT_OPTION = { id: "effort", currentValue: "default", options: [{ value: "low" }, { value: "high" }, { value: "default" }] };
const MODE_OPTION = { id: "mode", currentValue: "build", options: [{ value: "build" }, { value: "plan" }] };

const OPTS: SessionOpts = {
  cli: { bin: "opencode", pathEnv: "/usr/bin" },
  model: "",
  effort: "default",
  cwd: "/vault-that-does-not-exist",
  permissionMode: "default",
  toolsEnabled: true,
  fastStartup: true,
  systemPrompt: "Be brief.",
};

async function readySession(
  overrides: Partial<SessionOpts> = {},
  init: Record<string, unknown> = {}
): Promise<{ session: OpencodeSession; child: FakeAcpProcess; spawn: ReturnType<typeof vi.fn> }> {
  const child = new FakeAcpProcess();
  const spawn = vi.fn(() => child as never);
  const runtime: OpencodeSessionRuntime = { spawn: spawn as never, requestTimeoutMs: 500 };
  const session = new OpencodeSession({ ...OPTS, ...overrides }, runtime);
  const i = await child.next("initialize");
  child.reply(i, {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
    agentInfo: { name: "OpenCode", version: "2.2.6" },
    ...init,
  });
  if (!overrides.resumeSessionId) {
    const n = await child.next("session/new");
    child.reply(n, { sessionId: "ses_1", configOptions: [MODEL_OPTION, EFFORT_OPTION, MODE_OPTION] });
  }
  return { session, child, spawn };
}

/** Let queued microtasks and stream callbacks run. */
const tick = () => new Promise((r) => setTimeout(r, 5));

function spawnEnv(spawn: ReturnType<typeof vi.fn>): Record<string, string> {
  return ((spawn.mock.calls[0] as unknown[])[2] as { env: Record<string, string> }).env;
}

describe("OpencodeSession startup", () => {
  it("spawns `opencode acp` in the vault with Exo's config injected", async () => {
    const { session, spawn } = await readySession();
    const [cmd, args, opts] = spawn.mock.calls[0] as [string, string[], { cwd: string; env: Record<string, string> }];
    expect(cmd).toBe("opencode");
    expect(args).toEqual(["acp"]);
    expect(opts.cwd).toBe("/vault-that-does-not-exist");
    expect(opts.env.PATH).toBe("/usr/bin");
    const config = JSON.parse(opts.env.OPENCODE_CONFIG_CONTENT);
    expect(config.snapshots).toBe(false);
    expect(config.permissions[0]).toEqual({ action: "*", resource: "*", effect: "ask" });
    // The instructions file carries the house rules and the session's own prompt.
    const file = config.instructions[0] as string;
    expect(readFileSync(file, "utf8")).toContain("Be brief.");
    session.dispose("test");
  });

  it("advertises no fs/terminal and a form elicitation capability", async () => {
    const child = new FakeAcpProcess();
    const session = new OpencodeSession(OPTS, { spawn: vi.fn(() => child as never) as never, requestTimeoutMs: 500 });
    const init = await child.next("initialize");
    expect(init.jsonrpc).toBe("2.0");
    expect(init.params?.clientCapabilities).toEqual({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      elicitation: { form: {} },
    });
    session.dispose("test");
  });

  it("refuses opencode 1.x with an upgrade hint", async () => {
    const child = new FakeAcpProcess();
    const session = new OpencodeSession(OPTS, { spawn: vi.fn(() => child as never) as never, requestTimeoutMs: 500 });
    child.reply(await child.next("initialize"), { agentInfo: { version: "1.19.5" } });
    await expect(session.send("hi", () => {})).rejects.toThrow(/opencode 2\.0\.0 or newer.*opencode upgrade/);
  });

  it("publishes the model catalog from the session's config options", async () => {
    const caps: SessionCaps[] = [];
    const child = new FakeAcpProcess();
    const session = new OpencodeSession(OPTS, { spawn: vi.fn(() => child as never) as never, requestTimeoutMs: 500 });
    session.onCaps = (c) => caps.push(c);
    child.reply(await child.next("initialize"), { agentInfo: { version: "2.2.6" } });
    child.reply(await child.next("session/new"), { sessionId: "ses_1", configOptions: [MODEL_OPTION] });
    await tick();
    expect(caps.at(-1)?.models).toEqual([
      { id: "omlx/qwen", label: "omlx/qwen" },
      { id: "ollama/llama", label: "ollama/llama" },
    ]);
    session.dispose("test");
  });

  it("selects the chat's model and effort only when they differ / exist", async () => {
    const child = new FakeAcpProcess();
    const session = new OpencodeSession(
      { ...OPTS, model: "ollama/llama", effort: "high" },
      { spawn: vi.fn(() => child as never) as never, requestTimeoutMs: 500 }
    );
    child.reply(await child.next("initialize"), { agentInfo: { version: "2.2.6" } });
    child.reply(await child.next("session/new"), { sessionId: "ses_1", configOptions: [MODEL_OPTION, EFFORT_OPTION, MODE_OPTION] });
    const model = await child.next("session/set_config_option");
    expect(model.params).toEqual({ sessionId: "ses_1", configId: "model", value: "ollama/llama" });
    child.reply(model, { configOptions: [{ ...MODEL_OPTION, currentValue: "ollama/llama" }, EFFORT_OPTION, MODE_OPTION] });
    const effort = await child.next("session/set_config_option");
    expect(effort.params).toMatchObject({ configId: "effort", value: "high" });
    child.reply(effort, {});
    session.dispose("test");
  });

  it("skips an effort tier the model does not list", async () => {
    const { session, child } = await readySession({ effort: "xhigh" });
    await tick();
    expect(child.messages.some((m) => m.method === "session/set_config_option")).toBe(false);
    session.dispose("test");
  });

  it("resumes a stored session, and falls back to a new one when opencode lost it", async () => {
    const child = new FakeAcpProcess();
    const session = new OpencodeSession(
      { ...OPTS, resumeSessionId: "ses_old" },
      { spawn: vi.fn(() => child as never) as never, requestTimeoutMs: 500 }
    );
    child.reply(await child.next("initialize"), { agentInfo: { version: "2.2.6" }, agentCapabilities: { sessionCapabilities: { resume: {} } } });
    const resume = await child.next("session/resume");
    expect(resume.params).toMatchObject({ sessionId: "ses_old", cwd: "/vault-that-does-not-exist" });
    child.push({ jsonrpc: "2.0", id: resume.id, error: { code: -32002, message: "Session not found" } });
    child.reply(await child.next("session/new"), { sessionId: "ses_new", configOptions: [] });
    const events: AgentEvent[] = [];
    const turn = session.send("hi", (e) => events.push(e));
    const prompt = await child.next("session/prompt");
    expect(prompt.params?.sessionId).toBe("ses_new");
    child.reply(prompt, { stopReason: "end_turn" });
    await turn;
    expect(events.at(-1)).toEqual({ kind: "turn-end", sessionId: "ses_new" });
    session.dispose("test");
  });
});

describe("OpencodeSession turns", () => {
  it("streams text and reasoning, then ends the turn with its token count", async () => {
    const { session, child } = await readySession();
    const events: AgentEvent[] = [];
    const turn = session.send("hello", (e) => events.push(e));
    const prompt = await child.next("session/prompt");
    expect(prompt.params?.prompt).toEqual([{ type: "text", text: "hello" }]);
    child.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
    child.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n\nhel" } });
    child.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } });
    await tick();
    child.reply(prompt, { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2 } });
    await turn;
    expect(events).toEqual([
      { kind: "thinking-delta", text: "thinking" },
      { kind: "text-delta", text: "hel" },
      { kind: "text-delta", text: "lo" },
      { kind: "text-end" },
      { kind: "turn-end", sessionId: "ses_1" },
    ]);
    expect(session.lastTurnTokens()).toBe(12);
    session.dispose("test");
  });

  it("sends images as ACP image blocks before the text", async () => {
    const { session, child } = await readySession();
    const turn = session.send("look", () => {}, [{ mediaType: "image/png", dataB64: "AAA" }]);
    const prompt = await child.next("session/prompt");
    expect(prompt.params?.prompt).toEqual([
      { type: "image", data: "AAA", mimeType: "image/png" },
      { type: "text", text: "look" },
    ]);
    child.reply(prompt, { stopReason: "end_turn" });
    await turn;
    session.dispose("test");
  });

  it("puts a bound agent's instructions ahead of this turn's text only", async () => {
    const { session, child } = await readySession();
    const turn = session.send("task", () => {}, undefined, "You are the editor.");
    const prompt = await child.next("session/prompt");
    const text = (prompt.params?.prompt as { text: string }[])[0].text;
    expect(text).toMatch(/^<agent-instructions>\nYou are the editor\.\n<\/agent-instructions>\n\ntask$/);
    child.reply(prompt, { stopReason: "end_turn" });
    await turn;
    session.dispose("test");
  });

  it("holds a tool card until opencode fills in the input, with Exo's names", async () => {
    const { session, child } = await readySession();
    const events: AgentEvent[] = [];
    const turn = session.send("edit it", (e) => events.push(e));
    const prompt = await child.next("session/prompt");
    child.update({ sessionUpdate: "tool_call", toolCallId: "c1", name: "write", kind: "edit", status: "pending", rawInput: {} });
    await tick();
    expect(events.filter((e) => e.kind === "tool-call-start")).toEqual([]);
    child.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "in_progress",
      locations: [{ path: "/vault/Note.md" }],
      rawInput: { path: "./Note.md", content: "x" },
    });
    child.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "Created file" } }],
    });
    await tick();
    child.reply(prompt, { stopReason: "end_turn" });
    await turn;
    expect(events).toContainEqual({
      kind: "tool-call-start",
      id: "c1",
      name: "Write",
      input: { path: "./Note.md", content: "x", file_path: "/vault/Note.md" },
    });
    expect(events).toContainEqual({ kind: "tool-call-result", id: "c1", ok: true, output: "Created file" });
    session.dispose("test");
  });

  it("asks Exo before a tool runs and answers with the matching option", async () => {
    const { session, child } = await readySession();
    const asks: Extract<AgentEvent, { kind: "permission-request" }>[] = [];
    const turn = session.send("go", (e) => e.kind === "permission-request" && asks.push(e));
    const prompt = await child.next("session/prompt");
    const options = [
      { optionId: "once", kind: "allow_once" },
      { optionId: "always", kind: "allow_always" },
      { optionId: "reject", kind: "reject_once" },
    ];
    const ask = (id: number, toolCall: Record<string, unknown>) =>
      child.push({ jsonrpc: "2.0", id, method: "session/request_permission", params: { sessionId: "ses_1", toolCall, options } });

    ask(0, { toolCallId: "s1", name: "shell", kind: "execute", rawInput: { command: "ls -la" } });
    await tick();
    expect(asks[0]).toMatchObject({ tool: "Bash", input: { command: "ls -la" } });
    asks[0].resolve({ behavior: "allow" });
    expect((await child.answerTo(0)).result).toEqual({ outcome: { outcome: "selected", optionId: "once" } });

    ask(1, { toolCallId: "m1", name: "obsidian_edit_note", rawInput: { target: "Plan" } });
    await tick();
    expect(asks[1]).toMatchObject({ tool: "mcp__obsidian__edit_note", input: { target: "Plan" } });
    asks[1].resolve({ behavior: "allow", remember: true });
    expect((await child.answerTo(1)).result).toEqual({ outcome: { outcome: "selected", optionId: "always" } });

    ask(2, { toolCallId: "r1", name: "read", rawInput: { path: "/x" } });
    await tick();
    asks[2].resolve({ behavior: "deny" } as PermissionDecision);
    expect((await child.answerTo(2)).result).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });

    child.reply(prompt, { stopReason: "end_turn" });
    await turn;
    session.dispose("test");
  });

  it("lets edits through without a card in acceptEdits mode", async () => {
    const { session, child } = await readySession({ permissionMode: "acceptEdits" });
    const asks: AgentEvent[] = [];
    const turn = session.send("go", (e) => e.kind === "permission-request" && asks.push(e));
    const prompt = await child.next("session/prompt");
    child.push({
      jsonrpc: "2.0",
      id: 7,
      method: "session/request_permission",
      params: {
        toolCall: { toolCallId: "e1", name: "edit", kind: "edit", rawInput: { path: "a.md" } },
        options: [{ optionId: "once", kind: "allow_once" }, { optionId: "reject", kind: "reject_once" }],
      },
    });
    expect((await child.answerTo(7)).result).toEqual({ outcome: { outcome: "selected", optionId: "once" } });
    expect(asks).toEqual([]);
    child.reply(prompt, { stopReason: "end_turn" });
    await turn;
    session.dispose("test");
  });

  it("interrupt cancels the turn and any open card, without an error", async () => {
    const { session, child } = await readySession();
    const events: AgentEvent[] = [];
    const turn = session.send("long", (e) => events.push(e));
    const prompt = await child.next("session/prompt");
    child.push({
      jsonrpc: "2.0",
      id: 3,
      method: "session/request_permission",
      params: { toolCall: { toolCallId: "x", name: "shell", rawInput: { command: "rm" } }, options: [{ optionId: "once", kind: "allow_once" }] },
    });
    await tick();
    session.interrupt();
    expect((await child.next("session/cancel")).params).toEqual({ sessionId: "ses_1" });
    expect((await child.answerTo(3)).result).toEqual({ outcome: { outcome: "cancelled" } });
    child.reply(prompt, { stopReason: "cancelled" });
    await turn;
    expect(events.some((e) => e.kind === "error")).toBe(false);
    expect(events.at(-1)).toEqual({ kind: "turn-end", sessionId: "ses_1" });
    session.dispose("test");
  });

  it("reports a cancel Exo did not ask for as an error", async () => {
    const { session, child } = await readySession();
    const events: AgentEvent[] = [];
    const turn = session.send("x", (e) => events.push(e));
    child.reply(await child.next("session/prompt"), { stopReason: "cancelled" });
    await turn;
    expect(events).toContainEqual({ kind: "error", message: "opencode cancelled the turn." });
    session.dispose("test");
  });

  it("fails only the turn when opencode answers the prompt with an error", async () => {
    const { session, child } = await readySession();
    const events: AgentEvent[] = [];
    const turn = session.send("x", (e) => events.push(e));
    const prompt = await child.next("session/prompt");
    child.push({ jsonrpc: "2.0", id: prompt.id, error: { code: -32603, message: "ProviderModelNotFound" } });
    await turn;
    expect(events).toEqual([
      { kind: "error", message: "session/prompt: ProviderModelNotFound" },
      { kind: "turn-end", sessionId: "ses_1" },
    ]);
    // The session is still usable.
    const again = session.send("y", () => {});
    child.reply(await child.next("session/prompt"), { stopReason: "end_turn" });
    await again;
    session.dispose("test");
  });

  it("rejects the turn when the process dies mid-turn, with its stderr", async () => {
    const { session, child } = await readySession();
    const events: AgentEvent[] = [];
    const turn = session.send("x", (e) => events.push(e));
    await child.next("session/prompt");
    child.stderr.write("panic: model server gone\n");
    await tick();
    child.emit("close", 1, null);
    await expect(turn).rejects.toThrow(/model server gone/);
    expect(events.some((e) => e.kind === "error")).toBe(true);
    await expect(session.send("again", () => {})).rejects.toThrow(/opencode session ended/);
  });

  it("reports context usage, with no cost for a free local model", async () => {
    const { session, child } = await readySession();
    const events: AgentEvent[] = [];
    const turn = session.send("x", (e) => events.push(e));
    const prompt = await child.next("session/prompt");
    child.update({ sessionUpdate: "usage_update", used: 9000, size: 262144, cost: { amount: 0, currency: "USD" } });
    child.update({ sessionUpdate: "usage_update", used: 9100, size: 262144, cost: { amount: 0.02, currency: "USD" } });
    await tick();
    child.reply(prompt, { stopReason: "end_turn" });
    await turn;
    expect(events).toContainEqual({ kind: "usage", usage: { used: 9000, total: 262144 } });
    expect(events).toContainEqual({ kind: "usage", usage: { used: 9100, total: 262144, costUsd: 0.02 } });
    expect(await session.contextUsage()).toEqual({ used: 9100, total: 262144, costUsd: 0.02 });
    session.dispose("test");
  });

  it("compacts with /compact and reports when opencode finishes", async () => {
    const { session, child } = await readySession();
    const events: AgentEvent[] = [];
    const first = session.send("x", (e) => events.push(e));
    child.reply(await child.next("session/prompt"), { stopReason: "end_turn" });
    await first;
    session.compact("keep the plan");
    const compact = await child.next("session/prompt");
    expect(compact.params?.prompt).toEqual([{ type: "text", text: "/compact keep the plan" }]);
    child.update({ sessionUpdate: "session_info_update", _meta: { "opencode/compaction": { status: "completed" } } });
    child.reply(compact, { stopReason: "end_turn" });
    await tick();
    expect(events).toContainEqual({ kind: "compact" });
    session.dispose("test");
  });

  it("switches opencode's mode when plan mode toggles", async () => {
    const { session, child } = await readySession();
    session.setPermissionMode("plan");
    const set = await child.next("session/set_config_option");
    expect(set.params).toMatchObject({ configId: "mode", value: "plan" });
    child.reply(set, {});
    session.setPermissionMode("acceptEdits");
    const back = await child.next("session/set_config_option");
    expect(back.params, JSON.stringify(child.messages.map((m) => m.params))).toMatchObject({ configId: "mode", value: "build" });
    session.dispose("test");
  });

  it("dispose stops the process, the bridge and removes the instructions file", async () => {
    const stop = vi.fn();
    const { session, child, spawn } = await readySession({ mcpBridge: { port: 1, token: "t", scriptPath: "", stop } });
    const file = JSON.parse(spawnEnv(spawn).OPENCODE_CONFIG_CONTENT).instructions[0] as string;
    expect(existsSync(file)).toBe(true);
    session.dispose("test");
    await tick();
    expect(child.kill).toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(existsSync(file)).toBe(false);
    await expect(session.send("x", () => {})).rejects.toThrow(/Session disposed \(test\)/);
  });
});
