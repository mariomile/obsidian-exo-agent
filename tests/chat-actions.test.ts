import { describe, it, expect } from "vitest";
import { decidePermission, markSeen, sessionSnapshot } from "../src/ui/chat-actions";
import type { ChatView } from "../src/view";
import type { Convo, PermDecision } from "../src/ui/convo-types";

/**
 * The mutation half of the sidebar's inline Allow / Deny.
 *
 * The pane never touches a conversation itself (see the reader/owner boundary
 * scan in chat-list-state.test.ts) — it calls `plugin.decidePermission`, which
 * lands here. What matters is that the verdict reaches the CARD's own handle,
 * so the transcript settles exactly as if the button had been pressed there,
 * and that an already-answered prompt says so instead of pretending.
 */
const convo = (id: string, pendingDecision?: PermDecision | null): Convo =>
  ({ id, pendingDecision }) as unknown as Convo;

const viewOf = (convos: Convo[]): ChatView =>
  ({ allConvos: () => convos }) as unknown as ChatView;

/** A live permission card, reduced to the handle the sidebar can reach. */
function card(): { decision: PermDecision; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    decision: {
      rule: "Bash(git)",
      allow: () => calls.push("allow"),
      deny: () => calls.push("deny"),
    },
  };
}

describe("decidePermission", () => {
  it("allows through the card's own handle", () => {
    const c = card();
    const view = viewOf([convo("c1", c.decision)]);
    expect(decidePermission(view, "c1", "allow")).toBe(true);
    expect(c.calls).toEqual(["allow"]);
  });

  it("denies through the card's own handle", () => {
    const c = card();
    const view = viewOf([convo("c1", c.decision)]);
    expect(decidePermission(view, "c1", "deny")).toBe(true);
    expect(c.calls).toEqual(["deny"]);
  });

  it("never settles a sibling conversation's prompt", () => {
    const mine = card();
    const other = card();
    const view = viewOf([convo("c1", mine.decision), convo("c2", other.decision)]);
    decidePermission(view, "c2", "allow");
    expect(mine.calls).toEqual([]);
    expect(other.calls).toEqual(["allow"]);
  });

  it("returns false when the prompt was already answered", () => {
    // `setPendingCard` nulls the handle the moment the card settles anywhere
    // else. The false is what drives the pane's "already answered" notice —
    // without it the row would silently do nothing.
    const view = viewOf([convo("c1", null)]);
    expect(decidePermission(view, "c1", "allow")).toBe(false);
  });

  it("returns false when the chat is blocked on something that is not a permission", () => {
    // A question or a plan has no one-line yes/no: there is no handle at all.
    const view = viewOf([convo("c1")]);
    expect(decidePermission(view, "c1", "deny")).toBe(false);
  });

  it("returns false for a conversation the view does not have", () => {
    const view = viewOf([convo("c1", card().decision)]);
    expect(decidePermission(view, "gone", "allow")).toBe(false);
  });
});

describe("markSeen", () => {
  it("stamps the read watermark on the named chats only, then persists once", () => {
    const a = { id: "a" } as Convo;
    const b = { id: "b" } as Convo;
    const calls: string[] = [];
    const view = {
      allConvos: () => [a, b],
      persist: () => calls.push("persist"),
      renderTabs: () => calls.push("tabs"),
    } as unknown as ChatView;
    markSeen(view, ["a", "missing"]);
    expect(a.seenAt).toBeGreaterThan(0);
    expect(b.seenAt).toBeUndefined();
    expect(calls).toEqual(["persist", "tabs"]);
  });

  it("writes nothing when no id matches", () => {
    const calls: string[] = [];
    const view = { allConvos: () => [], persist: () => calls.push("persist") } as unknown as ChatView;
    markSeen(view, ["x"]);
    expect(calls).toEqual([]);
  });
});

describe("sessionSnapshot", () => {
  it("reports the effort the chat's model actually runs with, and its own allow count", () => {
    const active = { provider: "claude", model: "claude-haiku-4-5", allow: new Set(["Read", "Bash(git)"]) } as unknown as Convo;
    const view = { active, plugin: { settings: { effort: "high" } } } as unknown as ChatView;
    expect(sessionSnapshot(view)).toEqual({ provider: "claude", model: "claude-haiku-4-5", effort: "default", allowed: 2, mcp: null });
  });

  it("reports MCP status from the chat's own session, not another chat's", () => {
    const caps = { mcpServers: [{ name: "vault", status: "connected" }] };
    const active = { provider: "claude", model: "", allow: new Set(), caps } as unknown as Convo;
    const view = { active, plugin: { settings: { effort: "high" }, lastSessionCaps: { mcpServers: [] } } } as unknown as ChatView;
    expect(sessionSnapshot(view).mcp).toEqual([{ name: "vault", status: "connected" }]);
  });
});
