import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CodexSession, type CodexSessionRuntime } from "../src/providers/codex";
import type { AgentEvent, SessionCaps, SessionOpts } from "../src/providers/types";
import { normalizeUtilization } from "../src/core/rate-limit";

type RpcMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
};

class FakeCodexProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin: Writable;
  killed = false;
  messages: RpcMessage[] = [];
  private consumed = new Set<RpcMessage>();
  private waiters: (() => void)[] = [];

  constructor() {
    super();
    let input = "";
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        input += chunk.toString();
        let nl: number;
        while ((nl = input.indexOf("\n")) >= 0) {
          const line = input.slice(0, nl).trim();
          input = input.slice(nl + 1);
          if (line) this.messages.push(JSON.parse(line) as RpcMessage);
          for (const wake of this.waiters.splice(0)) wake();
        }
        callback();
      },
    });
  }

  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });

  async next(method: string, timeoutMs = 1_000): Promise<RpcMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find((m) => m.method === method && !this.consumed.has(m));
      if (found) {
        this.consumed.add(found);
        return found;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for ${method}`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  reply(request: RpcMessage, result: unknown): void {
    this.push({ id: request.id, result });
  }

  push(message: RpcMessage): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

const OPTS: SessionOpts = {
  cli: { bin: "codex", pathEnv: "/usr/bin" },
  model: "gpt-5.6-sol",
  effort: "medium",
  cwd: "/vault",
  permissionMode: "default",
  toolsEnabled: true,
  fastStartup: true,
  sandboxMode: "workspace-write",
  approvalPolicy: "on-request",
};

async function readySession(
  overrides: Partial<SessionOpts> = {},
  runtimeOverrides: Partial<CodexSessionRuntime> = {},
): Promise<{ session: CodexSession; child: FakeCodexProcess }> {
  const child = new FakeCodexProcess();
  const runtime: CodexSessionRuntime = {
    spawn: vi.fn(() => child as never),
    requestTimeoutMs: 500,
    turnStartTimeoutMs: 500,
    ...runtimeOverrides,
  };
  const session = new CodexSession({ ...OPTS, ...overrides }, runtime);
  const init = await child.next("initialize");
  child.reply(init, { userAgent: "codex-test" });
  await child.next("initialized");
  const thread = await child.next(overrides.resumeSessionId ? "thread/resume" : "thread/start");
  child.reply(thread, { thread: { id: overrides.resumeSessionId ?? "thread-1" } });
  return { session, child };
}

async function startTurn(
  session: CodexSession,
  child: FakeCodexProcess,
  events: AgentEvent[],
): Promise<{ turn: Promise<void> }> {
  const turn = session.send("hello", (event) => events.push(event));
  const start = await child.next("turn/start");
  child.reply(start, { turn: { id: "turn-1" } });
  child.push({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
  return { turn };
}

describe("CodexSession app-server lifecycle", () => {
  it("keeps one process and thread warm across turns while streaming real deltas", async () => {
    const { session, child } = await readySession();
    const firstEvents: AgentEvent[] = [];
    const { turn: first } = await startTurn(session, child, firstEvents);
    child.push({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "hello" },
    });
    child.push({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: {
          last: { totalTokens: 120, inputTokens: 100, cachedInputTokens: 80, outputTokens: 20, reasoningOutputTokens: 0 },
          total: { totalTokens: 120, inputTokens: 100, cachedInputTokens: 80, outputTokens: 20, reasoningOutputTokens: 0 },
          modelContextWindow: 258_400,
        },
      },
    });
    child.push({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
    });
    await first;

    expect(firstEvents).toContainEqual({ kind: "text-delta", text: "hello" });
    expect(firstEvents).toContainEqual({ kind: "usage", usage: { used: 120, total: 258_400 } });
    expect(session.lastTurnTokens()).toBe(120);

    const secondEvents: AgentEvent[] = [];
    const second = session.send("again", (event) => secondEvents.push(event));
    const secondStart = (await child.next("turn/start"));
    const turnStarts = child.messages.filter((message) => message.method === "turn/start");
    expect(turnStarts).toHaveLength(2);
    child.reply(secondStart, { turn: { id: "turn-2" } });
    child.push({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-2" } } });
    child.push({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-2", status: "completed", items: [] } },
    });
    await second;
    expect(secondEvents).toContainEqual({ kind: "turn-end", sessionId: "thread-1" });
    session.dispose();
  });

  it("interrupts only the active turn and can send again on the same session", async () => {
    const { session, child } = await readySession();
    const events: AgentEvent[] = [];
    const { turn } = await startTurn(session, child, events);
    session.interrupt();
    const interrupt = await child.next("turn/interrupt");
    expect(interrupt.params).toMatchObject({ threadId: "thread-1", turnId: "turn-1" });
    child.reply(interrupt, {});
    child.push({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted", items: [] } },
    });
    await turn;
    expect(events.some((event) => event.kind === "error")).toBe(false);

    const next = session.send("next", () => {});
    const request = await child.next("turn/start");
    child.reply(request, { turn: { id: "turn-2" } });
    child.push({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-2" } } });
    child.push({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-2", status: "completed", items: [] } },
    });
    await next;
    session.dispose();
  });

  it("routes command approvals through Exo permission decisions", async () => {
    const { session, child } = await readySession();
    const events: AgentEvent[] = [];
    const { turn } = await startTurn(session, child, events);
    child.push({
      id: 88,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        command: "git status",
        cwd: "/vault",
        startedAtMs: Date.now(),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const approval = events.find((event) => event.kind === "permission-request");
    expect(approval).toBeDefined();
    if (approval?.kind === "permission-request") approval.resolve({ behavior: "allow", remember: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(child.messages).toContainEqual({ id: 88, result: { decision: "acceptForSession" } });

    child.push({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
    });
    await turn;
    session.dispose();
  });

  it("supports steer and native compact on the live thread", async () => {
    const { session, child } = await readySession();
    const { turn } = await startTurn(session, child, []);
    expect(session.steer("change course")).toBe(true);
    const steer = await child.next("turn/steer");
    expect(steer.params).toMatchObject({ threadId: "thread-1", expectedTurnId: "turn-1" });
    child.reply(steer, {});

    child.push({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
    });
    await turn;
    session.compact("keep decisions");
    const compact = await child.next("thread/compact/start");
    expect(compact.params).toEqual({ threadId: "thread-1" });
    session.dispose();
  });

  it("applies Exo plan mode through Codex collaborationMode and can switch live", async () => {
    const { session, child } = await readySession();
    const first = session.send("plan this", () => {});
    const firstStart = await child.next("turn/start");
    expect(firstStart.params?.collaborationMode).toMatchObject({ mode: "default" });
    child.reply(firstStart, { turn: { id: "turn-1" } });
    child.push({ method: "turn/started", params: { turn: { id: "turn-1" } } });
    child.push({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
    await first;

    session.setPermissionMode?.("plan");
    const second = session.send("make a plan", () => {});
    const secondStart = await child.next("turn/start");
    expect(secondStart.params?.collaborationMode).toMatchObject({
      mode: "plan",
      settings: { model: "gpt-5.6-sol", reasoning_effort: "medium" },
    });
    child.reply(secondStart, { turn: { id: "turn-2" } });
    child.push({ method: "turn/started", params: { turn: { id: "turn-2" } } });
    child.push({ method: "turn/completed", params: { turn: { id: "turn-2", status: "completed" } } });
    await second;
    session.dispose();
  });

  it("preserves the selected reasoning effort inside Codex collaboration mode", async () => {
    const { session, child } = await readySession({ effort: "high" });
    const turn = session.send("think hard", () => {});
    const start = await child.next("turn/start");
    expect(start.params?.collaborationMode).toMatchObject({
      mode: "default",
      settings: { reasoning_effort: "high" },
    });
    child.reply(start, { turn: { id: "turn-1" } });
    child.push({ method: "turn/started", params: { turn: { id: "turn-1" } } });
    child.push({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
    await turn;
    session.dispose();
  });

  it("threads a per-turn systemPrompt override into developer_instructions without persisting it", async () => {
    const { session, child } = await readySession({ systemPrompt: "base prompt" });
    const first = session.send("hello", () => {}, undefined, "you are Ghostwriter for this turn");
    const firstStart = await child.next("turn/start");
    const firstInstructions = String(
      (firstStart.params?.collaborationMode as { settings?: { developer_instructions?: string } })?.settings
        ?.developer_instructions
    );
    expect(firstInstructions).toContain("you are Ghostwriter for this turn");
    expect(firstInstructions).not.toContain("base prompt");
    child.reply(firstStart, { turn: { id: "turn-1" } });
    child.push({ method: "turn/started", params: { turn: { id: "turn-1" } } });
    child.push({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
    await first;

    // The next turn, with no override, falls back to the session's own prompt:
    // the override from the previous turn must not have leaked into `opts`.
    const second = session.send("again", () => {});
    const secondStart = await child.next("turn/start");
    const secondInstructions = String(
      (secondStart.params?.collaborationMode as { settings?: { developer_instructions?: string } })?.settings
        ?.developer_instructions
    );
    expect(secondInstructions).toContain("base prompt");
    expect(secondInstructions).not.toContain("Ghostwriter");
    child.reply(secondStart, { turn: { id: "turn-2" } });
    child.push({ method: "turn/started", params: { turn: { id: "turn-2" } } });
    child.push({ method: "turn/completed", params: { turn: { id: "turn-2", status: "completed" } } });
    await second;
    session.dispose();
  });

  it("routes Codex request_user_input through the owning Exo conversation", async () => {
    const requestUserInput = vi.fn(async () => ({ audience: "Founders" }));
    const { session, child } = await readySession({ requestUserInput });
    const { turn } = await startTurn(session, child, []);
    child.push({
      id: 89,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "question-1",
        questions: [{
          id: "audience",
          header: "Audience",
          question: "Who is this for?",
          options: [{ label: "Founders", description: "Startup founders" }],
        }],
      },
    });
    await vi.waitFor(() => expect(requestUserInput).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(child.messages).toContainEqual({
      id: 89,
      result: { answers: { audience: { answers: ["Founders"] } } },
    }));
    child.push({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
    await turn;
    session.dispose();
  });

  it("routes additional permission requests through the Exo approval card", async () => {
    const { session, child } = await readySession();
    const events: AgentEvent[] = [];
    const { turn } = await startTurn(session, child, events);
    const permissions = { network: { enabled: true } };
    child.push({
      id: 90,
      method: "item/permissions/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "perm-1", cwd: "/vault", permissions },
    });
    await vi.waitFor(() => expect(events.some((event) => event.kind === "permission-request")).toBe(true));
    const approval = events.find((event) => event.kind === "permission-request");
    if (approval?.kind === "permission-request") approval.resolve({ behavior: "allow", remember: true });
    await vi.waitFor(() => expect(child.messages).toContainEqual({
      id: 90,
      result: { permissions, scope: "session" },
    }));
    child.push({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
    await turn;
    session.dispose();
  });

  it("renders MCP form elicitations and returns typed content", async () => {
    const requestUserInput = vi.fn(async () => ({ audience: "Founders", public: "Yes", count: "3" }));
    const { session, child } = await readySession({ requestUserInput });
    const { turn } = await startTurn(session, child, []);
    child.push({
      id: 91,
      method: "mcpServer/elicitation/request",
      params: {
        serverName: "example",
        threadId: "thread-1",
        turnId: "turn-1",
        mode: "form",
        message: "Configure the export",
        requestedSchema: {
          type: "object",
          properties: {
            audience: { type: "string", title: "Audience", enum: ["Founders", "PMs"] },
            public: { type: "boolean", title: "Public" },
            count: { type: "integer", title: "Count" },
          },
        },
      },
    });
    await vi.waitFor(() => expect(requestUserInput).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(child.messages).toContainEqual({
      id: 91,
      result: { action: "accept", content: { audience: "Founders", public: true, count: 3 } },
    }));
    child.push({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
    await turn;
    session.dispose();
  });

  it("answers an MCP tool-call approval through the permission path, not the form path", async () => {
    // Codex 0.147 gates every MCP tool call behind this message. It is NOT a
    // form: zero questions must never mean "decline".
    const requestUserInput = vi.fn(async () => ({}));
    const { session, child } = await readySession({
      requestUserInput,
      obsidianReadTools: new Set(["mcp__obsidian__list_notes"]),
    });
    const events: AgentEvent[] = [];
    const { turn } = await startTurn(session, child, events);
    child.push({ method: "item/started", params: { item: {
      id: "exec-1", type: "mcpToolCall", server: "obsidian", tool: "create_note", status: "inProgress",
      arguments: { path: "C.md", content: "hi" },
    } } });
    child.push({
      id: 93,
      method: "mcpServer/elicitation/request",
      params: {
        serverName: "obsidian",
        threadId: "thread-1",
        turnId: "turn-1",
        mode: "form",
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          tool_description: "Create a new note.",
          tool_params: { path: "C.md", content: "hi" },
        },
        message: 'Allow the obsidian MCP server to run tool "create_note"?',
        requestedSchema: { type: "object", properties: {} },
      },
    });
    await vi.waitFor(() => expect(events.some((event) => event.kind === "permission-request")).toBe(true));
    const approval = events.find((event) => event.kind === "permission-request");
    expect(approval).toMatchObject({
      tool: "mcp__obsidian__create_note",
      input: { path: "C.md", content: "hi" },
    });
    expect(requestUserInput).not.toHaveBeenCalled();
    if (approval?.kind === "permission-request") approval.resolve({ behavior: "allow" });
    await vi.waitFor(() => expect(child.messages).toContainEqual({ id: 93, result: { action: "accept", content: {} } }));
    child.push({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
    await turn;
    session.dispose();
  });

  it("declines the approval when the user denies the card", async () => {
    const { session, child } = await readySession();
    const events: AgentEvent[] = [];
    const { turn } = await startTurn(session, child, events);
    child.push({ method: "item/started", params: { item: {
      id: "exec-1", type: "mcpToolCall", server: "obsidian", tool: "create_note", status: "inProgress", arguments: {},
    } } });
    child.push({
      id: 94,
      method: "mcpServer/elicitation/request",
      params: {
        serverName: "obsidian",
        _meta: { codex_approval_kind: "mcp_tool_call", tool_params: {} },
        message: 'Allow the obsidian MCP server to run tool "create_note"?',
        requestedSchema: { type: "object", properties: {} },
      },
    });
    await vi.waitFor(() => expect(events.some((event) => event.kind === "permission-request")).toBe(true));
    const approval = events.find((event) => event.kind === "permission-request");
    if (approval?.kind === "permission-request") approval.resolve({ behavior: "deny", message: "no" });
    await vi.waitFor(() => expect(child.messages).toContainEqual({ id: 94, result: { action: "decline" } }));
    child.push({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
    await turn;
    session.dispose();
  });

  it("fails closed: an approval with no identifiable tool is declined, and says why", async () => {
    const { session, child } = await readySession();
    const events: AgentEvent[] = [];
    const { turn } = await startTurn(session, child, events);
    // The matching mcpToolCall already completed: nothing left to correlate.
    child.push({
      id: 95,
      method: "mcpServer/elicitation/request",
      params: {
        serverName: "obsidian",
        _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { path: "C.md" } },
        message: 'Allow the obsidian MCP server to run tool "create_note"?',
        requestedSchema: { type: "object", properties: {} },
      },
    });
    await vi.waitFor(() => expect(child.messages).toContainEqual({ id: 95, result: { action: "decline" } }));
    expect(events.some((event) => event.kind === "permission-request")).toBe(false);
    expect(events.some((event) => event.kind === "notice")).toBe(true);
    child.push({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
    await turn;
    session.dispose();
  });

  it("never asks about a mutating bridge tool under a read-only sandbox", async () => {
    const { session, child } = await readySession({
      sandboxMode: "read-only",
      obsidianReadTools: new Set(["mcp__obsidian__list_notes"]),
    });
    const events: AgentEvent[] = [];
    const { turn } = await startTurn(session, child, events);
    child.push({ method: "item/started", params: { item: {
      id: "exec-1", type: "mcpToolCall", server: "obsidian", tool: "create_note", status: "inProgress", arguments: {},
    } } });
    child.push({
      id: 96,
      method: "mcpServer/elicitation/request",
      params: {
        serverName: "obsidian",
        _meta: { codex_approval_kind: "mcp_tool_call", tool_params: {} },
        message: 'Allow the obsidian MCP server to run tool "create_note"?',
        requestedSchema: { type: "object", properties: {} },
      },
    });
    await vi.waitFor(() => expect(child.messages).toContainEqual({ id: 96, result: { action: "decline" } }));
    expect(events.some((event) => event.kind === "permission-request")).toBe(false);
    child.push({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
    await turn;
    session.dispose();
  });

  it("cancels a pending approval when the turn ends under it", async () => {
    const { session, child } = await readySession();
    const events: AgentEvent[] = [];
    const { turn } = await startTurn(session, child, events);
    child.push({ method: "item/started", params: { item: {
      id: "exec-1", type: "mcpToolCall", server: "obsidian", tool: "create_note", status: "inProgress", arguments: {},
    } } });
    child.push({
      id: 97,
      method: "mcpServer/elicitation/request",
      params: {
        serverName: "obsidian",
        _meta: { codex_approval_kind: "mcp_tool_call", tool_params: {} },
        message: 'Allow the obsidian MCP server to run tool "create_note"?',
        requestedSchema: { type: "object", properties: {} },
      },
    });
    await vi.waitFor(() => expect(events.some((event) => event.kind === "permission-request")).toBe(true));
    child.push({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
    await turn;
    await vi.waitFor(() => expect(child.messages).toContainEqual({ id: 97, result: { action: "cancel" } }));
    session.dispose();
  });

  it("never correlates an approval with a tool call left over from an earlier turn", async () => {
    const { session, child } = await readySession();
    const events: AgentEvent[] = [];
    const { turn } = await startTurn(session, child, events);
    // Turn dies with the call still open (interrupt, crash): no item/completed.
    child.push({ method: "item/started", params: { item: {
      id: "exec-1", type: "mcpToolCall", server: "obsidian", tool: "read_note", status: "inProgress", arguments: { path: "A.md" },
    } } });
    child.push({ method: "turn/completed", params: { turn: { id: "turn-1", status: "interrupted" } } });
    await turn;

    const nextEvents: AgentEvent[] = [];
    const next = session.send("again", (event) => nextEvents.push(event));
    const start = await child.next("turn/start");
    child.reply(start, { turn: { id: "turn-2" } });
    child.push({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-2" } } });
    child.push({
      id: 98,
      method: "mcpServer/elicitation/request",
      params: {
        serverName: "obsidian",
        _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { path: "B.md", content: "x" } },
        message: 'Allow the obsidian MCP server to run tool "create_note"?',
        requestedSchema: { type: "object", properties: {} },
      },
    });
    await vi.waitFor(() => expect(child.messages).toContainEqual({ id: 98, result: { action: "decline" } }));
    expect(nextEvents.some((event) => event.kind === "permission-request")).toBe(false);
    child.push({ method: "turn/completed", params: { turn: { id: "turn-2", status: "completed" } } });
    await next;
    session.dispose();
  });

  it("normalizes Codex plans, subagents, web search, dynamic tools, and rate limits", async () => {
    const { session, child } = await readySession();
    const events: AgentEvent[] = [];
    const { turn } = await startTurn(session, child, events);
    child.push({ method: "turn/plan/updated", params: {
      turnId: "turn-1",
      plan: [{ step: "Inspect", status: "completed" }, { step: "Implement", status: "inProgress" }],
    } });
    child.push({ method: "item/started", params: { item: {
      id: "agent-1", type: "collabAgentToolCall", tool: "spawnAgent", status: "inProgress", prompt: "Review it",
    } } });
    child.push({ method: "item/completed", params: { item: {
      id: "agent-1", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed", agentsStates: { child: "completed" },
    } } });
    child.push({ method: "item/started", params: { item: { id: "web-1", type: "webSearch", query: "official docs" } } });
    child.push({ method: "item/completed", params: { item: { id: "web-1", type: "webSearch", query: "official docs" } } });
    child.push({ method: "item/started", params: { item: {
      id: "dyn-1", type: "dynamicToolCall", namespace: "exo", tool: "inspect", status: "inProgress", arguments: { path: "a.md" },
    } } });
    child.push({ method: "item/completed", params: { item: {
      id: "dyn-1", type: "dynamicToolCall", namespace: "exo", tool: "inspect", status: "completed", success: true, output: "ok",
    } } });
    child.push({ method: "account/rateLimits/updated", params: {
      rateLimits: { limitName: "five-hour", primary: { usedPercent: 85, resetsAt: 1234 } },
    } });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      kind: "tool-call-start", name: "TodoWrite",
    })));
    expect(events).toContainEqual(expect.objectContaining({ kind: "tool-call-start", id: "agent-1", name: "Agent" }));
    expect(events).toContainEqual({ kind: "tool-call-result", id: "agent-1", ok: true, output: '{"child":"completed"}' });
    expect(events).toContainEqual(expect.objectContaining({ kind: "tool-call-start", id: "web-1", name: "WebSearch" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "tool-call-start", id: "dyn-1", name: "dynamic__exo__inspect" }));
    expect(events).toContainEqual({
      kind: "rate-limit",
      status: "allowed_warning",
      utilization: 0.85,
      resetsAt: 1234,
      windowType: "five-hour",
      windows: [{ id: "codex:primary", label: "5-hour limit", utilization: 0.85, resetsAt: 1234 }],
    });
    expect(session.rateLimit).toEqual({
      status: "allowed_warning",
      utilization: 0.85,
      resetsAt: 1234,
      windowType: "five-hour",
      windows: [{ id: "codex:primary", label: "5-hour limit", utilization: 0.85, resetsAt: 1234 }],
    });
    child.push({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
    await turn;
    session.dispose();
  });

  it("reads the native Codex quota snapshot without inventing missing windows", async () => {
    const { session, child } = await readySession();
    const refresh = session.refreshRateLimits();
    const request = await child.next("account/rateLimits/read");
    expect(request.params).toEqual({});
    child.reply(request, {
      rateLimits: {
        limitId: "codex",
        planType: "plus",
        primary: { usedPercent: 34, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: null,
      },
      rateLimitsByLimitId: {
        codex: {
          primary: { usedPercent: 34, windowDurationMins: 300, resetsAt: 1_800_000_000 },
          secondary: null,
        },
      },
    });
    await refresh;
    expect(session.rateLimit).toEqual({
      status: "allowed",
      utilization: 0.34,
      resetsAt: 1_800_000_000,
      windowType: "codex:primary",
      planType: "plus",
      windows: [{
        id: "codex:primary",
        label: "5-hour limit",
        utilization: 0.34,
        resetsAt: 1_800_000_000,
        windowMinutes: 300,
      }],
    });
    session.dispose();
  });

  it("reports idle Codex failures as notices, never as an error on the finished turn", async () => {
    const { session, child } = await readySession();
    const events: AgentEvent[] = [];
    const { turn } = await startTurn(session, child, events);
    child.push({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
    await turn;
    session.compact();
    const compact = await child.next("thread/compact/start");
    child.push({ id: compact.id, error: { message: "boom" } });
    child.push({ method: "error", params: { error: { message: "late server error" } } });
    await vi.waitFor(() => expect(events.filter((e) => e.kind === "notice")).toHaveLength(2));
    expect(events.some((e) => e.kind === "error")).toBe(false);
    session.dispose();
  });

  it("reports a failed steer as a notice and keeps the turn alive", async () => {
    const { session, child } = await readySession();
    const events: AgentEvent[] = [];
    const { turn } = await startTurn(session, child, events);
    expect(session.steer("also this")).toBe(true);
    const steer = await child.next("turn/steer");
    child.push({ id: steer.id, error: { message: "turn moved on" } });
    await vi.waitFor(() => expect(events.some((e) => e.kind === "notice")).toBe(true));
    expect(events.some((e) => e.kind === "error")).toBe(false);
    child.push({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
    await turn;
    session.dispose();
  });

  it("keeps a turn alive through retrying server errors and a late compact failure", async () => {
    const { session, child } = await readySession();
    session.compact();
    const compact = await child.next("thread/compact/start");
    const events: AgentEvent[] = [];
    const { turn } = await startTurn(session, child, events);
    child.push({ id: compact.id, error: { message: "compact boom" } });
    child.push({ method: "error", params: { error: { message: "reconnecting 1/5" }, willRetry: true, threadId: "thread-1", turnId: "turn-1" } });
    child.push({ method: "error", params: { error: { message: "old turn" }, willRetry: false, threadId: "thread-1", turnId: "turn-0" } });
    await vi.waitFor(() => expect(events.filter((e) => e.kind === "notice")).toHaveLength(3));
    expect(events.some((e) => e.kind === "error")).toBe(false);
    child.push({ method: "error", params: { error: { message: "fatal" }, willRetry: false, threadId: "thread-1", turnId: "turn-1" } });
    await vi.waitFor(() => expect(events.some((e) => e.kind === "error")).toBe(true));
    child.push({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
    await turn;
    session.dispose();
  });

  it("keeps a 1% Codex window at 1%, not 100% and rejected", async () => {
    const { session, child } = await readySession();
    const refresh = session.refreshRateLimits();
    const request = await child.next("account/rateLimits/read");
    child.reply(request, { rateLimits: { limitId: "codex", primary: { usedPercent: 1, windowDurationMins: 300 } } });
    await refresh;
    expect(session.rateLimit?.status).toBe("allowed");
    expect(session.rateLimit?.utilization).toBe(0.01);
    expect(normalizeUtilization(session.rateLimit?.windows?.[0].utilization)).toBe(1);
    session.dispose();
  });

  it("discovers the live Codex skill and model catalog", async () => {
    const { session, child } = await readySession();
    const snapshots: NonNullable<typeof session.caps>[] = [];
    session.onCaps = (caps) => snapshots.push(caps);
    const skills = await child.next("skills/list");
    child.reply(skills, { data: [{ cwd: "/vault", skills: [{ name: "audit", enabled: true }, { name: "off", enabled: false }] }] });
    const models = await child.next("model/list");
    child.reply(models, { data: [
      { id: "gpt-new", displayName: "GPT New", hidden: false, upgrade: null },
      { id: "gpt-old", displayName: "GPT Old", hidden: false, upgrade: "gpt-new" },
      { id: "hidden", displayName: "Hidden", hidden: true },
    ] });
    await vi.waitFor(() => expect(snapshots).toHaveLength(1));
    expect(snapshots[0].skills).toEqual(["audit"]);
    expect(snapshots[0].models).toEqual([
      { id: "gpt-new", label: "GPT New" },
      { id: "gpt-old", label: "GPT Old (deprecated)" },
    ]);
    session.dispose();
  });

  it("auto-compacts Codex after a completed turn crosses 90% context usage", async () => {
    const { session, child } = await readySession({ autoCompact: true });
    const { turn } = await startTurn(session, child, []);
    child.push({ method: "thread/tokenUsage/updated", params: {
      tokenUsage: { last: { totalTokens: 900 }, modelContextWindow: 1000 },
    } });
    child.push({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
    await turn;
    const compact = await child.next("thread/compact/start");
    expect(compact.params).toEqual({ threadId: "thread-1" });
    session.dispose();
  });

  it("fails a silent initialization instead of leaving the UI on Thinking forever", async () => {
    const child = new FakeCodexProcess();
    const session = new CodexSession(OPTS, {
      spawn: vi.fn(() => child as never),
      requestTimeoutMs: 20,
      turnStartTimeoutMs: 20,
    });
    await expect(session.send("hello", () => {})).rejects.toThrow(/initialize.*timed out/i);
    expect(child.kill).toHaveBeenCalled();
  });

  it("registers the obsidian bridge with a 1-hour tool timeout, so ask_user can wait for the human", () => {
    const child = new FakeCodexProcess();
    const spawn = vi.fn(() => child as never);
    const session = new CodexSession(
      { ...OPTS, codexBridge: { port: 4321, token: "tok", scriptPath: "/bridge.mjs" } },
      { spawn, requestTimeoutMs: 500, turnStartTimeoutMs: 500 }
    );
    try {
      const args = spawn.mock.calls[0]?.[1] as unknown as string[];
      const override = args.find((a) => typeof a === "string" && a.includes("mcp_servers.obsidian="));
      expect(override).toBeDefined();
      // Codex's per-server default is 60s, which would kill every answer Mario
      // takes more than a minute to give. 3600 is the deliberate ceiling.
      expect(override).toContain("tool_timeout_sec=3600");
      expect(override).toContain('EXO_BRIDGE_PORT="4321"');
      expect(override).toContain('EXO_BRIDGE_TOKEN="tok"');
    } finally {
      session.dispose();
    }
  });

  it("releases its per-session Obsidian bridge exactly once", async () => {
    const stop = vi.fn();
    const { session } = await readySession({
      codexBridge: { port: 1234, token: "secret", scriptPath: "/bridge.mjs", stop },
    });
    session.dispose();
    session.dispose();
    expect(stop).toHaveBeenCalledOnce();
  });

  // The enumeration in routeItem covers the item types Codex had when it was
  // written. These two tests pin the behaviour for everything else: unknown
  // WORK becomes visible, known non-work stays silent. Without the first, a
  // Codex release that adds or renames an item type turns real work into a
  // turn that looks like it did nothing.
  it("renders an unmapped item type as a generic tool card instead of dropping it", async () => {
    const { session, child } = await readySession();
    const events: AgentEvent[] = [];
    const { turn } = await startTurn(session, child, events);
    child.push({
      method: "item/started",
      params: {
        threadId: "thread-1",
        item: { id: "item-9", type: "fileRead", arguments: { path: "note.md" }, status: "inProgress" },
      },
    });
    child.push({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        item: { id: "item-9", type: "fileRead", status: "completed", output: "# Note" },
      },
    });
    child.push({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
    });
    await turn;

    expect(events).toContainEqual({
      kind: "tool-call-start",
      id: "item-9",
      name: "fileRead",
      input: { path: "note.md" },
    });
    expect(events).toContainEqual({ kind: "tool-call-result", id: "item-9", ok: true, output: "# Note" });
    session.dispose();
  });

  it("keeps conversation-carrying items out of the tool stream", async () => {
    const { session, child } = await readySession();
    const events: AgentEvent[] = [];
    const { turn } = await startTurn(session, child, events);
    for (const type of ["reasoning", "userMessage", "todoList", "error"]) {
      child.push({
        method: "item/started",
        params: { threadId: "thread-1", item: { id: `item-${type}`, type, status: "inProgress" } },
      });
    }
    child.push({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
    });
    await turn;

    expect(events.filter((e) => e.kind === "tool-call-start")).toHaveLength(0);
    session.dispose();
  });

  // Codex has no `system/init` snapshot, so these rosters were hardcoded to []
  // — which read downstream as "no commands exist" and silently disabled
  // slash-command hoisting on every Codex turn. They are now read from the same
  // vault files the expansion and the agent store resolve against.
  it("reports the vault's real command and agent rosters", async () => {
    const dir = await mkdtemp(join(tmpdir(), "exo-caps-"));
    await mkdir(join(dir, ".claude/commands"), { recursive: true });
    await mkdir(join(dir, ".claude/agents"), { recursive: true });
    await writeFile(join(dir, ".claude/commands/brief.md"), "body");
    await writeFile(join(dir, ".claude/commands/search.md"), "body");
    await writeFile(join(dir, ".claude/commands/notes.txt"), "not a command");
    await writeFile(join(dir, ".claude/agents/ghostwriter.md"), "body");

    const { session, child } = await readySession({ cwd: dir });
    const caps = await new Promise<SessionCaps>((resolve) => {
      session.onCaps = resolve;
      void (async () => {
        child.reply(await child.next("skills/list"), { data: [] });
        child.reply(await child.next("model/list"), { data: [] });
      })();
    });

    expect(caps.commands).toEqual(["brief", "search"]);
    expect(caps.agents).toEqual(["ghostwriter"]);
    expect(caps.tools).toContain("Bash");
    await rm(dir, { recursive: true, force: true });
    session.dispose();
  });
});
