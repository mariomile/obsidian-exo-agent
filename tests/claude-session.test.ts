import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentEvent, SessionOpts } from "../src/providers/types";

/** Controllable fake for the SDK's `query()` stream: tests push CLI messages and
 *  the session's pump drains them, exactly like the real streaming-input mode. */
function makeFakeQuery() {
  const pending: unknown[] = [];
  let wake: (() => void) | null = null;
  return {
    interrupt: vi.fn(() => Promise.resolve()),
    getContextUsage: vi.fn(async (): Promise<unknown> => undefined),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(async (): Promise<unknown> => undefined),
    push(msg: unknown) {
      pending.push(msg);
      const w = wake;
      wake = null;
      w?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (pending.length === 0) await new Promise<void>((r) => (wake = r));
        yield pending.shift();
      }
    },
  };
}

let fake: ReturnType<typeof makeFakeQuery>;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => fake),
}));

import { claudeAdapter } from "../src/providers/claude";

const OPTS: SessionOpts = {
  cli: { bin: "claude", pathEnv: "" },
  model: "default",
  effort: "default",
  cwd: "/tmp",
  permissionMode: "default",
  toolsEnabled: false,
  fastStartup: true,
};

/** The CLI reports a locally-initiated interrupt as an error_during_execution
 *  result even though the process and session survive (verified against CLI
 *  2.1.195–2.1.201). The session must classify it by whether WE interrupted. */
describe("ClaudeSession interrupt vs error_during_execution", () => {
  beforeEach(() => {
    fake = makeFakeQuery();
  });

  const edeResult = {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "",
  };

  test("suppresses the error event when the turn was interrupted locally", async () => {
    const session = claudeAdapter.createSession(OPTS);
    const events: AgentEvent[] = [];
    const turn = session.send("hi", (e) => events.push(e));
    session.interrupt();
    fake.push(edeResult);
    await expect(turn).resolves.toBeUndefined();
    expect(events.filter((e) => e.kind === "error")).toEqual([]);
    expect(events.some((e) => e.kind === "turn-end")).toBe(true);
    session.dispose();
  });

  test("still reports error_during_execution when nothing interrupted the turn", async () => {
    const session = claudeAdapter.createSession(OPTS);
    const events: AgentEvent[] = [];
    const turn = session.send("hi", (e) => events.push(e));
    fake.push(edeResult);
    await turn;
    expect(events.some((e) => e.kind === "error")).toBe(true);
    session.dispose();
  });

  test("an interrupted turn does not mask a genuine error on the next turn", async () => {
    const session = claudeAdapter.createSession(OPTS);
    const first = session.send("hi", () => {});
    session.interrupt();
    fake.push(edeResult);
    await first;

    const events: AgentEvent[] = [];
    const second = session.send("again", (e) => events.push(e));
    fake.push(edeResult);
    await second;
    expect(events.some((e) => e.kind === "error")).toBe(true);
    session.dispose();
  });

  test("reports root is_error even when the CLI labels the result success", async () => {
    const session = claudeAdapter.createSession(OPTS);
    const events: AgentEvent[] = [];
    const turn = session.send("hi", (e) => events.push(e));
    fake.push({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Not logged in · Please run /login",
    });
    await turn;
    expect(events).toContainEqual({ kind: "error", message: "Not logged in · Please run /login" });
    expect(events.some((e) => e.kind === "turn-end")).toBe(true);
    session.dispose();
  });
});

/** W0 cost governance: the observer/utility-pass path needs a real per-turn
 *  token count (not a strlen guess) to record spend against the shared
 *  background budget. The Agent SDK's `result` message already carries
 *  `usage.input_tokens` / `usage.output_tokens` — this reads that synchronously
 *  at the moment `send()` resolves, unlike the async `contextUsage()` control
 *  round-trip which can race a short-lived session's `dispose()`. */
describe("ClaudeSession.lastTurnTokens", () => {
  beforeEach(() => {
    fake = makeFakeQuery();
  });

  test("returns input+output tokens from the most recent result message", async () => {
    const session = claudeAdapter.createSession(OPTS);
    const turn = session.send("hi", () => {});
    fake.push({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
      usage: { input_tokens: 120, output_tokens: 340 },
    });
    await turn;
    expect(session.lastTurnTokens?.()).toBe(460);
    session.dispose();
  });

  test("returns null when the result message carries no usage", async () => {
    const session = claudeAdapter.createSession(OPTS);
    const turn = session.send("hi", () => {});
    fake.push({ type: "result", subtype: "success", is_error: false, result: "ok" });
    await turn;
    expect(session.lastTurnTokens?.()).toBeNull();
    session.dispose();
  });

  test("updates across turns — a second turn's usage replaces the first's", async () => {
    const session = claudeAdapter.createSession(OPTS);
    const first = session.send("hi", () => {});
    fake.push({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    await first;
    expect(session.lastTurnTokens?.()).toBe(30);

    const second = session.send("again", () => {});
    fake.push({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
      usage: { input_tokens: 5, output_tokens: 7 },
    });
    await second;
    expect(session.lastTurnTokens?.()).toBe(12);
    session.dispose();
  });
});

describe("ClaudeSession native quota windows", () => {
  beforeEach(() => {
    fake = makeFakeQuery();
  });

  test("publishes five-hour, weekly, and model-scoped native windows", async () => {
    fake.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET.mockResolvedValue({
      rate_limits_available: true,
      subscription_type: "max",
      rate_limits: {
        five_hour: { utilization: 34, resets_at: "2030-01-01T10:00:00.000Z" },
        seven_day: { utilization: 48, resets_at: "2030-01-05T20:00:00.000Z" },
        model_scoped: [{
          display_name: "Fable",
          utilization: 11,
          resets_at: "2030-01-05T20:00:00.000Z",
        }],
      },
    });
    const session = claudeAdapter.createSession(OPTS);
    await session.refreshRateLimits?.();
    expect(session.rateLimit).toMatchObject({
      status: "allowed",
      utilization: 0.34,
      windowType: "five_hour",
      planType: "max",
      windows: [
        { id: "five_hour", label: "5-hour limit", utilization: 0.34 },
        { id: "seven_day", label: "Weekly · all models", utilization: 0.48 },
        { id: "model_scoped:Fable", label: "Weekly · Fable", utilization: 0.11 },
      ],
    });
    session.dispose();
  });
});

describe("ClaudeSession parent text boundaries", () => {
  beforeEach(() => { fake = makeFakeQuery(); });

  test("ends parent text before the turn finishes and ignores nested agent boundaries", async () => {
    const session = claudeAdapter.createSession(OPTS);
    const events: AgentEvent[] = [];
    const turn = session.send("hi", (e) => events.push(e));
    const stream = (event: unknown, parent_tool_use_id: string | null = null) =>
      fake.push({ type: "stream_event", parent_tool_use_id, event });
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Parent" } });
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Child" } }, "agent-1");
    stream({ type: "content_block_stop", index: 0 }, "agent-1");
    stream({ type: "message_stop" }, "agent-1");
    stream({ type: "content_block_stop", index: 1 }); // another block cannot end parent text
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events).toEqual([{ kind: "text-delta", text: "Parent" }]);
    stream({ type: "content_block_stop", index: 0 });
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[1]).toEqual({ kind: "text-end" });
    expect(events.some((e) => e.kind === "turn-end")).toBe(false);
    stream({ type: "message_stop" }); // no duplicate ending
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Resumed" } });
    stream({ type: "message_stop" }); // message boundary fallback
    fake.push({ type: "result", subtype: "success", result: "done" });
    await turn;
    expect(events.filter((e) => e.kind === "text-delta" || e.kind === "text-end")).toEqual([
      { kind: "text-delta", text: "Parent" }, { kind: "text-end" },
      { kind: "text-delta", text: "Resumed" }, { kind: "text-end" },
    ]);
    session.dispose();
  });
});
