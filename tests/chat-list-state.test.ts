import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  blockedReason,
  chatDot,
  chatRowSig,
  isSectionCollapsed,
  rowPreview,
  rowStatusText,
  toggleSectionCollapsed,
} from "../src/core/chat-list-state";
import type { ChatRow } from "../src/core/chat-rows";

describe("chatDot", () => {
  it("says nothing for a row at rest — the gutter stays empty", () => {
    expect(chatDot({ unseen: false })).toBeNull();
  });

  it("marks a running turn", () => {
    expect(chatDot({ lane: "running", unseen: false })).toBe("running");
  });

  it("marks a blocked turn as needing you", () => {
    expect(chatDot({ lane: "needs-input", unseen: false })).toBe("needs-you");
  });

  it("marks an unseen reply when nothing is live", () => {
    expect(chatDot({ unseen: true })).toBe("unseen");
  });

  it("ranks needs-you above running", () => {
    // deriveLane's own precedence: a conversation blocked on a permission
    // prompt is still streaming, so reading `running` first would label
    // "waiting for you" as "working" — the exact bug the lane ordering exists
    // to prevent, reproduced one layer up in the dot.
    expect(chatDot({ lane: "needs-input", unseen: true })).toBe("needs-you");
  });

  it("ranks both live states above unseen", () => {
    // An unseen reply is older news than a turn that is running right now.
    expect(chatDot({ lane: "running", unseen: true })).toBe("running");
  });
});

describe("section collapse", () => {
  it("treats absent state as expanded", () => {
    // The no-migration guarantee: an install that never toggled anything opens
    // exactly as it did before the feature landed.
    expect(isSectionCollapsed(undefined, "active")).toBe(false);
    expect(isSectionCollapsed([], "active")).toBe(false);
    expect(isSectionCollapsed([], "pinned")).toBe(false);
  });

  it("opens every section while searching, shelves included", () => {
    expect(isSectionCollapsed(undefined, "settled")).toBe(true);
    expect(isSectionCollapsed(undefined, "settled", true)).toBe(false);
    expect(isSectionCollapsed(["active"], "active", true)).toBe(false);
  });

  it("reads a collapsed key back", () => {
    expect(isSectionCollapsed(["active"], "active")).toBe(true);
    expect(isSectionCollapsed(["active"], "pinned")).toBe(false);
  });

  it("collapses by appending and expands by removing", () => {
    expect(toggleSectionCollapsed([], "active")).toEqual(["active"]);
    expect(toggleSectionCollapsed(["active"], "active")).toEqual([]);
    expect(toggleSectionCollapsed(undefined, "pinned")).toEqual(["pinned"]);
  });

  it("leaves the other sections alone", () => {
    expect(toggleSectionCollapsed(["pinned", "active"], "pinned")).toEqual(["active"]);
    expect(toggleSectionCollapsed(["pinned"], "active")).toEqual(["pinned", "active"]);
  });

  it("round-trips a day-mode key", () => {
    // `day:` keys are template-literal members of ChatSectionKey, not a
    // separate space — collapsing "This week" must persist the same way.
    const once = toggleSectionCollapsed([], "day:This week");
    expect(isSectionCollapsed(once, "day:This week")).toBe(true);
    expect(toggleSectionCollapsed(once, "day:This week")).toEqual([]);
  });

  it("never mutates the list it was given", () => {
    // The caller persists the RESULT; mutating in place would leave memory
    // ahead of disk the moment a save fails.
    const before: string[] = ["active"];
    toggleSectionCollapsed(before, "pinned");
    toggleSectionCollapsed(before, "active");
    expect(before).toEqual(["active"]);
  });

  /**
   * The two shelves are folded until opened, as in T3: put-away chats are a
   * click away, never in the way. What is stored is the user's choice to OPEN
   * one, under `expanded:<key>`, so absent state still means "as shipped".
   */
  describe("the Snoozed and Settled shelves", () => {
    it("start collapsed when nothing is stored", () => {
      expect(isSectionCollapsed(undefined, "snoozed")).toBe(true);
      expect(isSectionCollapsed([], "settled")).toBe(true);
    });

    it("open by storing an expanded token and fold again by removing it", () => {
      expect(toggleSectionCollapsed([], "settled")).toEqual(["expanded:settled"]);
      expect(isSectionCollapsed(["expanded:settled"], "settled")).toBe(false);
      expect(toggleSectionCollapsed(["expanded:settled"], "settled")).toEqual([]);
    });

    it("keep their state independent of each other and of the other sections", () => {
      const opened = toggleSectionCollapsed(["active"], "snoozed");
      expect(opened).toEqual(["active", "expanded:snoozed"]);
      expect(isSectionCollapsed(opened, "snoozed")).toBe(false);
      expect(isSectionCollapsed(opened, "settled")).toBe(true);
      expect(isSectionCollapsed(opened, "active")).toBe(true);
    });

    it("are not folded by a bare key: only the expanded token counts", () => {
      expect(isSectionCollapsed(["settled"], "settled")).toBe(true);
      expect(isSectionCollapsed(["snoozed", "settled"], "snoozed")).toBe(true);
    });

    it("never mutate the list they were given", () => {
      const before: string[] = ["expanded:settled"];
      toggleSectionCollapsed(before, "settled");
      toggleSectionCollapsed(before, "snoozed");
      expect(before).toEqual(["expanded:settled"]);
    });
  });
});

/* ---------------------------------------------------------------------------
 * Phase 4/5 — what a row says, and when saying it costs a rebuild.
 * ------------------------------------------------------------------------ */

/** A settled row; every test overrides only the fields it is about. */
const row = (over: Partial<ChatRow> = {}): ChatRow => ({
  id: "c1",
  title: "Untitled",
  preview: "the last exchange",
  provider: "claude",
  model: "opus",
  updatedAt: 1,
  open: false,
  pinned: false,
  unseen: false,
  messageCount: 3,
  shelf: "settled",
  ...over,
});

describe("rowStatusText", () => {
  it("says which kind of answer a blocked row is waiting on", () => {
    expect(rowStatusText(row({ lane: "needs-input", reason: "perm" }))).toBe("Needs permission");
    expect(rowStatusText(row({ lane: "needs-input", reason: "ask" }))).toBe("Needs an answer");
  });

  it("falls back to Working for a running row with no phrase yet", () => {
    expect(rowStatusText(row({ lane: "running" }))).toBe("Working");
  });

  it("carries the checklist progress on a running row", () => {
    expect(rowStatusText(row({ lane: "running", progress: { done: 3, total: 7 } }))).toBe("Working · 3/7");
  });

  it("says nothing when the live phrase is already on screen", () => {
    // The phrase IS the status once there is one: a "Working" chip above
    // "Searching the vault" says the same thing twice in a 216px column.
    expect(rowStatusText(row({ lane: "running", activity: "Searching the vault" }))).toBeNull();
  });

  it("says nothing for a row at rest", () => {
    expect(rowStatusText(row())).toBeNull();
  });
});

describe("rowPreview", () => {
  it("gives the running row its live phrase in place of the last exchange", () => {
    expect(rowPreview(row({ lane: "running", activity: "Searching the vault" }))).toEqual({
      text: "Searching the vault",
      live: true,
    });
  });

  it("appends the checklist progress to the live phrase", () => {
    expect(
      rowPreview(row({ lane: "running", activity: "Searching the vault", progress: { done: 1, total: 4 } })),
    ).toEqual({ text: "Searching the vault · 1/4", live: true });
  });

  it("keeps the last exchange when nothing is running", () => {
    expect(rowPreview(row())).toEqual({ text: "the last exchange", live: false });
  });

  it("keeps the last exchange on a running row with no phrase yet", () => {
    expect(rowPreview(row({ lane: "running" }))).toEqual({
      text: "the last exchange",
      live: false,
    });
  });
});

describe("chatRowSig", () => {
  const sig = (r: ChatRow) => chatRowSig(r, { rich: true, age: "now" });

  it("is identical across a tick that changed nothing — no DOM is touched", () => {
    // reconcileList rebuilds a node only when its signature moved, so an equal
    // signature IS the "touches no DOM" guarantee.
    const r = row({ lane: "running", activity: "Searching the vault" });
    expect(sig(r)).toBe(sig(row({ lane: "running", activity: "Searching the vault" })));
  });

  it("moves when the phrase moves, so the row repaints on the next tool call", () => {
    expect(sig(row({ lane: "running", activity: "Searching the vault" }))).not.toBe(
      sig(row({ lane: "running", activity: "Reading Alpha" })),
    );
  });

  it("moves when the rule an approval would grant moves", () => {
    expect(sig(row({ lane: "needs-input", reason: "perm", permRule: "Bash(git)" }))).not.toBe(
      sig(row({ lane: "needs-input", reason: "perm", permRule: "Bash(rm)" })),
    );
  });

  it("moves when the checklist progress moves, so the row repaints as items complete", () => {
    expect(sig(row({ lane: "running", progress: { done: 1, total: 4 } }))).not.toBe(
      sig(row({ lane: "running", progress: { done: 2, total: 4 } })),
    );
    expect(sig(row({ lane: "running" }))).not.toBe(sig(row({ lane: "running", progress: { done: 0, total: 4 } })));
  });

  it("still moves on the axes it already owned", () => {
    expect(sig(row())).not.toBe(sig(row({ title: "Renamed" })));
    expect(sig(row())).not.toBe(chatRowSig(row(), { rich: false, age: "now" }));
    expect(sig(row())).not.toBe(chatRowSig(row(), { rich: true, age: "2h" }));
  });
});

describe("the chats pane's reader/owner boundary", () => {
  const source = readFileSync(join(__dirname, "..", "src/ui/chat-list-view.ts"), "utf8");
  /** The file's CODE. The header comment is allowed — required, even — to name
   *  `ChatView` while describing the boundary; the code is not. */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("never reaches into ChatView: every mutation goes through a plugin wrapper", () => {
    // Phase 5 gave the pane a decision to take (Allow / Deny), which is the
    // first time it mutates a conversation. The boundary that survives is the
    // one the file cannot cross by accident: no import of the view, and no
    // handle on it to call.
    expect(code).not.toMatch(/from "\.\.\/view"/);
    expect(code).not.toMatch(/\bChatView\b/);
    expect(code).not.toMatch(/chatView\s*\(/);
  });

  it("takes the permission decision through the plugin", () => {
    expect(code).toMatch(/this\.plugin\.decidePermission\(/);
  });

  it("isolates the decide buttons from the row that wraps them", () => {
    // The buttons live inside a `clickable` row, whose keydown listener answers
    // Enter/Space with preventDefault — which cancels a nested button's own
    // activation click. Without the isolation, Enter on Allow reveals the chat
    // instead of allowing anything (tests/dom.test.ts holds the behaviour).
    const decideInto = /private decideInto\([\s\S]*?\n {2}\}/.exec(code)?.[0] ?? "";
    expect(decideInto).toMatch(/isolateActivation\(btn\)/);
  });
});

describe("the live phrase moves per tool call, never per token", () => {
  const view = readFileSync(join(__dirname, "..", "src/view.ts"), "utf8");

  it("is written in exactly one place: the tool-call-start handler", () => {
    // The phrase sits in a row SIGNATURE, so its update rate is the sidebar's
    // repaint rate. One assignment, on a tool boundary, is what keeps that
    // affordable — a write from a render or streaming path would rebuild the
    // row dozens of times a second.
    expect([...view.matchAll(/\bc\.activity = /g)]).toHaveLength(1);
    const at = view.indexOf("c.activity = ");
    const openCase = view.lastIndexOf('case "tool-call-', at);
    expect(view.slice(openCase, at)).toContain('case "tool-call-start"');
  });

  it("is cleared when the tool resolves and again when the turn ends", () => {
    // Two clears, not one: a turn can end (stopped, errored, finished) without
    // its last tool ever resolving, and a phrase left behind would sit on a
    // settled row claiming live work.
    expect([...view.matchAll(/delete c\.activity;/g)]).toHaveLength(2);
  });
});

describe("blockedReason", () => {
  it("gives a noun phrase that reads in a sentence", () => {
    expect(blockedReason("perm")).toBe("permission");
    expect(blockedReason("ask")).toBe("an answer");
  });

  it("is what the status line spends, so the two cannot drift", () => {
    const line = rowStatusText({ lane: "needs-input", reason: "ask", activity: null });
    expect(line).toBe(`Needs ${blockedReason("ask")}`);
  });
});
