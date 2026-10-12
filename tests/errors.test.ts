import { describe, it, expect } from "vitest";
import { describeCliFailure, isCliAuthFailure } from "../src/core/errors";

describe("describeCliFailure", () => {
  it("maps error_during_execution / EDE diagnostics to a transient-crash message + hint", () => {
    for (const raw of [
      "error_during_execution",
      "Claude ended: error_during_execution",
      "Some noise [EDE_DIAGNOSTIC] more noise",
    ]) {
      const r = describeCliFailure(raw);
      expect(r?.message).toMatch(/crashed mid-turn/i);
      expect(r?.hint).toMatch(/update the CLI/i);
    }
  });

  it("maps a process exit to a transient-crash message + hint", () => {
    const r = describeCliFailure("process exited with code 1");
    expect(r?.message).toMatch(/exited unexpectedly/i);
    expect(r?.hint).toMatch(/update the CLI/i);
  });

  it("maps a vanished Claude stream to a recoverable interruption", () => {
    for (const raw of [
      "Claude session ended unexpectedly.",
      "Claude session ended — sending again starts a fresh session.",
      "Session stream ended unexpectedly.",
    ]) {
      const r = describeCliFailure(raw);
      expect(r?.message).toMatch(/session ended unexpectedly/i);
      expect(r?.message).toMatch(/retry/i);
      expect(r?.hint).toMatch(/conversation is safe/i);
    }
  });

  it("maps a view-unload session disposal to a reload-recoverable message", () => {
    const r = describeCliFailure("Session disposed (view-unload).");
    expect(r?.message).toMatch(/reloaded mid-response/i);
    expect(r?.message).toMatch(/retry/i);
    expect(r?.hint).toMatch(/conversation is safe/i);
  });

  it("maps ENOENT / not-found to a binary-path message", () => {
    for (const raw of ["spawn claude ENOENT", "claude: command not found", "claude not found"]) {
      const r = describeCliFailure(raw);
      expect(r?.message).toMatch(/not found — set the binary path/i);
      expect(r?.hint).toBeUndefined();
    }
  });

  it("maps auth failures to a login message", () => {
    for (const raw of [
      "You are not logged in",
      "Invalid API key",
      "Please run /login to continue",
      "Error: unauthorized",
    ]) {
      const r = describeCliFailure(raw);
      expect(r?.message).toMatch(/isn't logged in/i);
    }
  });

  it("prefers the auth message when a crash string also mentions auth", () => {
    // "not logged in" must win over "process exited".
    const r = describeCliFailure("process exited with code 1: not logged in");
    expect(r?.message).toMatch(/isn't logged in/i);
  });

  it("is case-insensitive", () => {
    expect(describeCliFailure("ERROR_DURING_EXECUTION")?.message).toMatch(/crashed mid-turn/i);
  });

  it("maps a Claude-plan usage limit to a plan-limit message", () => {
    for (const raw of [
      "Claude AI usage limit reached",
      "You've hit your session limit for the 5-hour window",
      "reached your weekly limit",
    ]) {
      const r = describeCliFailure(raw);
      expect(r?.message).toMatch(/hit your Claude plan's usage limit/i);
    }
  });

  it("threads a reset clock into the usage-limit hint when present", () => {
    const withClock = describeCliFailure("You've hit your usage limit — resets at 14:30");
    expect(withClock?.hint).toMatch(/14:30/);
    const withoutClock = describeCliFailure("usage limit reached");
    expect(withoutClock?.hint).toMatch(/rolling window/i);
  });

  it("does NOT treat a bare API rate-limit 429 as a plan limit", () => {
    // API-key throughput 429 stays benign (surfaces raw) — only plan-usage
    // phrasings map to the plan-limit message.
    expect(describeCliFailure("rate limit exceeded")).toBeNull();
  });

  it("returns null for unknown / benign strings", () => {
    for (const raw of [
      "",
      "API error 400: bad request",
      "rate limit exceeded",
      "the model produced an odd answer",
    ]) {
      expect(describeCliFailure(raw)).toBeNull();
    }
  });
});

describe("isCliAuthFailure", () => {
  it("recognizes an expired OAuth login and points at claude auth login", () => {
    const raw = "Failed to authenticate: OAuth session expired and could not be refreshed";
    expect(isCliAuthFailure(raw)).toBe(true);
    expect(describeCliFailure(raw)?.message).toMatch(/claude auth login/);
  });

  it("does not flag a plain session death", () => {
    expect(isCliAuthFailure("Session expired, please start a new one")).toBe(false);
    expect(isCliAuthFailure("process exited with code 1")).toBe(false);
  });
});
