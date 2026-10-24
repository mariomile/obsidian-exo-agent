import { describe, it, expect } from "vitest";
import {
  buildRecap,
  isRecoverableSessionError,
  recordTurnError,
  resolveRecovery,
  shouldColdReseed,
  stopAction,
  STOP_ESCALATION_GRACE_MS,
} from "../src/core/recovery";
import type { Message, Segment } from "../src/core/model";

const user = (text: string): Message => ({ role: "user", text });
const assistant = (segments: Segment[]): Message => ({ role: "assistant", segments });

describe("buildRecap", () => {
  it("wraps the recap in a <conversation-recap> envelope", () => {
    const recap = buildRecap([user("hello")]);
    expect(recap.startsWith("<conversation-recap>\n")).toBe(true);
    expect(recap.endsWith("\n</conversation-recap>")).toBe(true);
    expect(recap).toContain("[user] hello");
  });

  it("includes at most the last 8 messages", () => {
    const msgs: Message[] = Array.from({ length: 12 }, (_, i) => user(`msg${i}`));
    const recap = buildRecap(msgs);
    // msg0..msg3 dropped (only last 8 kept: msg4..msg11).
    expect(recap).not.toContain("[user] msg3");
    expect(recap).toContain("[user] msg4");
    expect(recap).toContain("[user] msg11");
    expect((recap.match(/\[user\]/g) ?? []).length).toBe(8);
  });

  it("truncates user messages to 400 chars", () => {
    const long = "u".repeat(1000);
    const recap = buildRecap([user(long)]);
    expect(recap).toContain(`[user] ${"u".repeat(400)}\n`);
    expect(recap).not.toContain("u".repeat(401));
  });

  it("truncates assistant text to 600 chars", () => {
    const long = "a".repeat(1000);
    const recap = buildRecap([assistant([{ t: "text", md: long }])]);
    expect(recap).toContain(`[assistant] ${"a".repeat(600)}`);
    expect(recap).not.toContain("a".repeat(601));
  });

  it("summarizes tool segments as [N tool calls] rather than inlining them", () => {
    const recap = buildRecap([
      assistant([
        { t: "text", md: "working on it" },
        { t: "tool", name: "Read", input: {}, ok: true, output: "SECRET FILE CONTENTS" },
        { t: "tool", name: "Edit", input: {}, ok: true, output: "more output" },
      ]),
    ]);
    expect(recap).toContain("[assistant] working on it [2 tool calls]");
    // Raw tool output must NOT leak into the recap.
    expect(recap).not.toContain("SECRET FILE CONTENTS");
  });

  it("appends the tool-count with no leading space when there is no text", () => {
    const recap = buildRecap([assistant([{ t: "tool", name: "Read", input: {}, ok: true, output: "x" }])]);
    expect(recap).toContain("[assistant] [1 tool calls]");
  });

  it("summarizes a plan segment by its approval state", () => {
    const approved = buildRecap([assistant([{ t: "plan", md: "# Plan", approved: true }])]);
    expect(approved).toContain("[assistant] [plan: approved]");
    const revised = buildRecap([assistant([{ t: "plan", md: "# Plan", approved: false }])]);
    expect(revised).toContain("[plan: revised]");
    const pending = buildRecap([assistant([{ t: "plan", md: "# Plan", approved: null }])]);
    expect(pending).toContain("[plan: pending]");
  });

  it("caps the body at ~5000 chars, dropping the OLDEST lines first", () => {
    // 8 assistant lines, each a full 600-char text + a tool-call suffix:
    // "[assistant] " (12) + 600 + " [1 tool calls]" (15) = 627 chars/line.
    // 8 lines joined = ~5023 > 5000 → the oldest line (L0) must be dropped.
    const msgs: Message[] = Array.from({ length: 8 }, (_, i) =>
      assistant([
        { t: "text", md: `L${i}-` + "x".repeat(597) }, // 3 + 597 = 600 chars exactly
        { t: "tool", name: "Read", input: {}, ok: true, output: "z" },
      ]),
    );
    const recap = buildRecap(msgs);
    const body = recap.split("transcript (oldest first):\n")[1].replace("\n</conversation-recap>", "");
    expect(body.length).toBeLessThanOrEqual(5000);
    // Oldest surviving lines kept, the earliest dropped: L0 gone, later ones present.
    expect(recap).not.toContain("L0-");
    expect(recap).toContain("L7-");
  });
});

describe("isRecoverableSessionError", () => {
  it.each([
    "Session expired, please start a new one",
    "SESSION NOT FOUND",
    "Error: invalid session id abc123",
    "the session invalid — reauthenticate",
    "process exited with code 1",
    "Process exited with code 143 (SIGTERM)",
    "Failed to resume session",
    "resume attempt returned an error",
    "Claude session ended unexpectedly.",
    "Claude session ended — sending again starts a fresh session.",
    "Session stream ended unexpectedly.",
    "Session disposed (view-unload).",
  ])("matches recoverable session death: %s", (msg) => {
    expect(isRecoverableSessionError(msg)).toBe(true);
  });

  it("does NOT treat other dispose reasons as recoverable — only view-unload races a live send()", () => {
    // user-delete/rewind/tab-close etc. never fire while a turn is in flight, so
    // their dispose message should keep surfacing as a plain (non-recoverable) error.
    expect(isRecoverableSessionError("Session disposed (user-delete).")).toBe(false);
    expect(isRecoverableSessionError("Session disposed (rewind).")).toBe(false);
  });

  it.each([
    "API error 400: bad request",
    "Invalid request: missing field 'model'",
    "rate limit exceeded",
    "ENOENT: no such file or directory",
    "you are not logged in",
    "resume", // "resume" alone (no failed/error) must not match
    "",
  ])("does NOT match a generic/non-session error: %s", (msg) => {
    expect(isRecoverableSessionError(msg)).toBe(false);
  });

  it("requires 'session' adjacency — a bare 'invalid' does not match", () => {
    expect(isRecoverableSessionError("invalid model name")).toBe(false);
    expect(isRecoverableSessionError("invalid session")).toBe(true);
  });
});

describe("recordTurnError", () => {
  it("records the first terminal error and suppresses duplicate provider errors", () => {
    const segments: Segment[] = [];

    expect(recordTurnError(segments, "first failure")).toEqual({
      showErrorCard: true,
      showRecoveryFooter: true,
    });
    expect(recordTurnError(segments, "duplicate close failure")).toEqual({
      showErrorCard: false,
      showRecoveryFooter: false,
    });
    expect(segments).toEqual([{ t: "error", message: "first failure" }]);
  });

  it("preserves existing non-error segments", () => {
    const segments: Segment[] = [{ t: "text", md: "partial answer" }];

    expect(recordTurnError(segments, "stream ended")).toEqual({
      showErrorCard: true,
      showRecoveryFooter: true,
    });
    expect(segments).toEqual([
      { t: "text", md: "partial answer" },
      { t: "error", message: "stream ended" },
    ]);
  });
});

describe("resolveRecovery", () => {
  const STAGE1 = "Session process crashed — your next message resumes it.";
  const STAGE2 = "Resume failed — restarting fresh with a recap of this conversation.";
  const NUCLEAR = "The next message starts a fresh session.";

  it("stage 1: first poison → keep the id, arm resumeRisky, resume-first footer", () => {
    expect(
      resolveRecovery({ poisoned: true, stopped: false, isRecoveryRetry: false, resumeRisky: false })
    ).toEqual({
      footer: STAGE1,
      session: "drop-keep-id",
      nextResumeRisky: true,
      enqueueRecapRetry: false,
      holdQueue: false,
    });
  });

  it("stage 2: poison while resume-risky → clear id, enqueue recap retry, drop the flag", () => {
    expect(
      resolveRecovery({ poisoned: true, stopped: false, isRecoveryRetry: false, resumeRisky: true })
    ).toEqual({
      footer: STAGE2,
      session: "drop-clear-id",
      nextResumeRisky: false,
      enqueueRecapRetry: true,
      holdQueue: false,
    });
  });

  it("nuclear: the recap retry itself poisoned → clear id, no retry, fresh-session footer", () => {
    // isRecoveryRetry wins even when resumeRisky is also set (loop guard).
    expect(
      resolveRecovery({ poisoned: true, stopped: false, isRecoveryRetry: true, resumeRisky: true })
    ).toEqual({
      footer: NUCLEAR,
      session: "drop-clear-id",
      nextResumeRisky: false,
      enqueueRecapRetry: false,
      holdQueue: false,
    });
  });

  it("nuclear also applies when the retry poisons without a prior resume-risky flag", () => {
    expect(
      resolveRecovery({ poisoned: true, stopped: false, isRecoveryRetry: true, resumeRisky: false })
    ).toEqual({
      footer: NUCLEAR,
      session: "drop-clear-id",
      nextResumeRisky: false,
      enqueueRecapRetry: false,
      holdQueue: false,
    });
  });

  it("healthy turn: no poison → clear resumeRisky, no footer, no session action", () => {
    expect(
      resolveRecovery({ poisoned: false, stopped: false, isRecoveryRetry: false, resumeRisky: true })
    ).toEqual({
      footer: null,
      session: "none",
      nextResumeRisky: false,
      enqueueRecapRetry: false,
      holdQueue: false,
    });
  });

  it("user-stopped-without-poison turn also clears resumeRisky", () => {
    expect(
      resolveRecovery({ poisoned: false, stopped: true, isRecoveryRetry: false, resumeRisky: true })
    ).toEqual({
      footer: null,
      session: "none",
      nextResumeRisky: false,
      enqueueRecapRetry: false,
      holdQueue: false,
    });
  });

  it("poisoned + stopped: the ladder is NOT entered — resumeRisky is left as-is", () => {
    // Gated `poisoned && !stopped` in the original — neither branch ran, so the
    // flag stays whatever it was. Assert both values pass through unchanged.
    expect(
      resolveRecovery({ poisoned: true, stopped: true, isRecoveryRetry: false, resumeRisky: true })
    ).toEqual({ footer: null, session: "none", nextResumeRisky: true, enqueueRecapRetry: false, holdQueue: false });
    expect(
      resolveRecovery({ poisoned: true, stopped: true, isRecoveryRetry: false, resumeRisky: false })
    ).toEqual({ footer: null, session: "none", nextResumeRisky: false, enqueueRecapRetry: false, holdQueue: false });
  });

  it("holds the queue after a failure that would fail the next message too, never after a Stop", () => {
    const base = { poisoned: false, stopped: false, isRecoveryRetry: false, resumeRisky: false };
    expect(resolveRecovery({ ...base, authFailed: true }).holdQueue).toBe(true);
    expect(resolveRecovery({ ...base, failed: true }).holdQueue).toBe(true);
    expect(resolveRecovery({ ...base, failed: true, stopped: true }).holdQueue).toBe(false);
    // A session death resumes on the next message: the queue keeps draining.
    expect(resolveRecovery({ ...base, poisoned: true }).holdQueue).toBe(false);
  });
});

describe("shouldColdReseed", () => {
  const base = { hasResumableSession: false, hasRecapPrefix: false, hasPriorHistory: true };

  it("reseeds a cold spawn that is continuing a conversation with history", () => {
    expect(shouldColdReseed(base)).toBe(true);
  });

  it("does NOT reseed when the session survives (warm resume carries context)", () => {
    expect(shouldColdReseed({ ...base, hasResumableSession: true })).toBe(false);
  });


  it("does NOT reseed when a stage-2 recap prefix is already threaded (never double)", () => {
    expect(shouldColdReseed({ ...base, hasRecapPrefix: true })).toBe(false);
  });

  it("reseeds after restart when only the interrupted user turn was persisted", () => {
    expect(shouldColdReseed({ ...base, hasPriorHistory: true })).toBe(true);
  });

  it("does NOT reseed on a convo's first turn (no prior message yet)", () => {
    expect(shouldColdReseed({ ...base, hasPriorHistory: false })).toBe(false);
  });
});

describe("stopAction", () => {
  it("first stop of a turn interrupts (session survives, CC parity)", () => {
    expect(stopAction(false, 0)).toBe("interrupt");
  });

  it("second stop AFTER the grace window escalates to dispose", () => {
    // The interrupt didn't settle the turn within a normal round-trip (stuck
    // transport / zombie CLI). Pressing Stop/Esc again must force-dispose the
    // session so the parked send() rejects and the composer unblocks — the
    // user-driven successor to the removed TurnWatchdog's rescue role.
    expect(stopAction(true, STOP_ESCALATION_GRACE_MS)).toBe("dispose");
    expect(stopAction(true, STOP_ESCALATION_GRACE_MS + 5000)).toBe("dispose");
  });

  it("second stop WITHIN the grace window re-interrupts instead of disposing", () => {
    // A healthy turn's interrupt round-trip is not instant — a second press
    // that lands before the CLI could plausibly have acknowledged the first
    // one is impatience, not evidence of a stuck session. Force-disposing here
    // would kill a turn that was about to end cleanly on its own (the exact
    // "accidental Esc silently kills work" class of incident this file has
    // already seen once).
    expect(stopAction(true, 0)).toBe("interrupt");
    expect(stopAction(true, STOP_ESCALATION_GRACE_MS - 1)).toBe("interrupt");
  });

  it("grace window boundary is inclusive of dispose (>=, not >)", () => {
    expect(stopAction(true, STOP_ESCALATION_GRACE_MS)).toBe("dispose");
  });
});

describe("expired CLI login", () => {
  const RAW = "Failed to authenticate: OAuth session expired and could not be refreshed";

  it("is not a recoverable session death, despite saying 'session expired'", () => {
    expect(isRecoverableSessionError(RAW)).toBe(false);
  });

  it("drops the live process, keeps the id, and never enters the ladder", () => {
    for (const resumeRisky of [false, true]) {
      for (const isRecoveryRetry of [false, true]) {
        expect(
          resolveRecovery({ poisoned: true, stopped: false, isRecoveryRetry, resumeRisky, authFailed: true })
        ).toEqual({ footer: null, session: "drop-keep-id", nextResumeRisky: false, enqueueRecapRetry: false, holdQueue: true });
      }
    }
  });
});
