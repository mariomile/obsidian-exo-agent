import { describe, it, expect } from "vitest";
import {
  deriveLane,
  type SessionSnapshot,
} from "../src/core/session-cards";

/** Minimal factory — an idle husk by default; each test flips only what it pins. */
const snap = (over: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  id: "c1",
  title: "Chat",
  streaming: false,
  pendingPerm: false,
  pendingAsk: false,
  poisoned: false,
  stopped: false,
  hasMessages: true,
  archived: false,
  ...over,
});

describe("deriveLane", () => {
  it("maps a plain streaming convo to running", () => {
    expect(deriveLane(snap({ streaming: true }))).toEqual({ lane: "running" });
  });

  it("maps a turn-ended convo with messages to review", () => {
    expect(deriveLane(snap({ streaming: false, hasMessages: true }))).toEqual({ lane: "review" });
  });

  it("maps an empty husk (no flags, no messages) to idle", () => {
    expect(deriveLane(snap({ hasMessages: false }))).toEqual({ lane: "idle" });
  });

  // The bug the review caught: a convo waiting on a permission prompt is STILL
  // streaming:true, so pending must win — else "waiting for you" reads as Running.
  it("classifies streaming+pendingPerm as needs-input, NOT running", () => {
    expect(deriveLane(snap({ streaming: true, pendingPerm: true }))).toEqual({
      lane: "needs-input",
      reason: "perm",
    });
  });

  it("classifies pendingAsk as needs-input with reason ask", () => {
    expect(deriveLane(snap({ streaming: true, pendingAsk: true }))).toEqual({
      lane: "needs-input",
      reason: "ask",
    });
  });

  it("routes a user-stopped turn to review with a stopped badge", () => {
    expect(deriveLane(snap({ stopped: true }))).toEqual({ lane: "review", badge: "stopped" });
  });

  it("routes a poisoned turn to review with an error badge", () => {
    expect(deriveLane(snap({ poisoned: true }))).toEqual({ lane: "review", badge: "error" });
  });

  // A user-stopped turn reads as a stop, not an error.
  it("prefers the stopped badge over error when both flags are set", () => {
    expect(deriveLane(snap({ stopped: true, poisoned: true }))).toEqual({
      lane: "review",
      badge: "stopped",
    });
  });
});
