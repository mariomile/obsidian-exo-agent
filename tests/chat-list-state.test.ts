import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  blockedReason,
  chatDot,
  chatRowSig,
  collapseChildren,
  isParentCollapsed,
  isSectionCollapsed,
  needsStripSig,
  rowPreview,
  rowStatusText,
  toggleParentCollapsed,
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
    expect(isSectionCollapsed(undefined, "inbox")).toBe(false);
    expect(isSectionCollapsed([], "inbox")).toBe(false);
    expect(isSectionCollapsed([], "pinned")).toBe(false);
  });

  it("opens every section while searching, shelves included", () => {
    expect(isSectionCollapsed(undefined, "settled")).toBe(true);
    expect(isSectionCollapsed(undefined, "settled", true)).toBe(false);
    expect(isSectionCollapsed(["inbox"], "inbox", true)).toBe(false);
  });

  it("reads a collapsed key back", () => {
    expect(isSectionCollapsed(["inbox"], "inbox")).toBe(true);
    expect(isSectionCollapsed(["inbox"], "pinned")).toBe(false);
  });

  it("collapses by appending and expands by removing", () => {
    expect(toggleSectionCollapsed([], "inbox")).toEqual(["inbox"]);
    expect(toggleSectionCollapsed(["inbox"], "inbox")).toEqual([]);
    expect(toggleSectionCollapsed(undefined, "pinned")).toEqual(["pinned"]);
  });

  it("leaves the other sections alone", () => {
    expect(toggleSectionCollapsed(["pinned", "inbox"], "pinned")).toEqual(["inbox"]);
    expect(toggleSectionCollapsed(["pinned"], "inbox")).toEqual(["pinned", "inbox"]);
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
    const before: string[] = ["inbox"];
    toggleSectionCollapsed(before, "pinned");
    toggleSectionCollapsed(before, "inbox");
    expect(before).toEqual(["inbox"]);
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
      const opened = toggleSectionCollapsed(["inbox"], "snoozed");
      expect(opened).toEqual(["inbox", "expanded:snoozed"]);
      expect(isSectionCollapsed(opened, "snoozed")).toBe(false);
      expect(isSectionCollapsed(opened, "settled")).toBe(true);
      expect(isSectionCollapsed(opened, "inbox")).toBe(true);
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

/**
 * Per-parent collapse. A second, independent axis on the same list: a section
 * hides a whole tier, a parent hides only its own fan-out. The tests that
 * matter are the ones that pin the two apart — the failure this feature can
 * actually produce is one collapse leaking into the other, or a parent hiding
 * a row that is not its child.
 */
describe("parent collapse", () => {
  it("treats absent state as expanded", () => {
    // The no-migration guarantee, same as sections: an install that never
    // touched a chevron opens exactly as it did before the feature landed.
    expect(isParentCollapsed(undefined, "convo-1")).toBe(false);
    expect(isParentCollapsed([], "convo-1")).toBe(false);
  });

  it("reads a collapsed conversation back", () => {
    expect(isParentCollapsed(["convo-1"], "convo-1")).toBe(true);
    expect(isParentCollapsed(["convo-1"], "convo-2")).toBe(false);
  });

  it("collapses by appending and expands by removing", () => {
    expect(toggleParentCollapsed([], "convo-1")).toEqual(["convo-1"]);
    expect(toggleParentCollapsed(["convo-1"], "convo-1")).toEqual([]);
    expect(toggleParentCollapsed(undefined, "convo-1")).toEqual(["convo-1"]);
  });

  it("leaves the other parents alone", () => {
    expect(toggleParentCollapsed(["a", "b"], "a")).toEqual(["b"]);
    expect(toggleParentCollapsed(["a"], "b")).toEqual(["a", "b"]);
  });

  it("dedupes on expand rather than leaving a second copy behind", () => {
    // A duplicate should never be written, but if one ever is, one click has to
    // fully expand — a filter that removed a single match would need two.
    expect(toggleParentCollapsed(["a", "a"], "a")).toEqual([]);
  });

  it("never mutates the list it was given", () => {
    const before: string[] = ["a"];
    toggleParentCollapsed(before, "b");
    toggleParentCollapsed(before, "a");
    expect(before).toEqual(["a"]);
  });

  it("is a SEPARATE store from the section collapse", () => {
    // The two lists are keyed in different namespaces. A conversation whose id
    // happens to read like a section key must not fold that section, and
    // collapsing a section must not fold a conversation of the same name.
    const parents = toggleParentCollapsed([], "inbox");
    expect(isSectionCollapsed([], "inbox")).toBe(false);
    expect(isParentCollapsed(parents, "inbox")).toBe(true);

    const sections = toggleSectionCollapsed([], "inbox");
    expect(isParentCollapsed([], "inbox")).toBe(false);
    expect(isSectionCollapsed(sections, "inbox")).toBe(true);
  });
});

describe("collapseChildren", () => {
  /** The shape the renderer actually paints: depth-0 rows each followed by
   *  their own depth-1 run. */
  const list = [
    { id: "p", depth: 0 as const },
    { id: "p1", depth: 1 as const },
    { id: "p2", depth: 1 as const },
    { id: "q", depth: 0 as const },
    { id: "q1", depth: 1 as const },
    { id: "lonely", depth: 0 as const },
  ];

  it("hides nothing when no parent is collapsed", () => {
    const out = collapseChildren(list, undefined);
    expect([...out.hidden]).toEqual([]);
  });

  it("hides exactly the collapsed parent's own children", () => {
    const out = collapseChildren(list, ["p"]);
    expect([...out.hidden].sort()).toEqual(["p1", "p2"]);
    // The sibling parent's child is untouched, and so is the parent row itself.
    expect(out.hidden.has("q1")).toBe(false);
    expect(out.hidden.has("p")).toBe(false);
  });

  it("hides two parents' children independently", () => {
    const out = collapseChildren(list, ["p", "q"]);
    expect([...out.hidden].sort()).toEqual(["p1", "p2", "q1"]);
  });

  it("counts children per parent, collapsed or not", () => {
    const out = collapseChildren(list, ["p"]);
    expect(out.counts.get("p")).toBe(2);
    expect(out.counts.get("q")).toBe(1);
    // A parent with no children is absent, never a zero: the renderer asks this
    // map for a number to SHOW, and "0 hidden" is a thing that cannot happen.
    expect(out.counts.has("lonely")).toBe(false);
  });

  it("folds a grandchild away with the depth-0 row, not with its own parent", () => {
    // The tree is flattened: `g` names `c` as its parent but renders at depth 1
    // beside it. Collapsing `p` must take both; there is no control on `c` to
    // take `g` on its own.
    const flattened = [
      { id: "p", depth: 0 as const },
      { id: "c", depth: 1 as const },
      { id: "g", depth: 1 as const },
    ];
    const out = collapseChildren(flattened, ["p"]);
    expect([...out.hidden].sort()).toEqual(["c", "g"]);
    expect(out.counts.get("p")).toBe(2);
    // And collapsing the middle row does nothing — it owns no run.
    expect([...collapseChildren(flattened, ["c"]).hidden]).toEqual([]);
  });

  it("does not carry a run across a section boundary", () => {
    // Sections are concatenated into one call; the next section's first row is
    // depth 0 and closes the previous run. A collapsed parent at the end of one
    // section must not swallow the start of the next.
    const twoSections = [
      { id: "p", depth: 0 as const },
      { id: "p1", depth: 1 as const },
      { id: "other", depth: 0 as const },
      { id: "other1", depth: 1 as const },
    ];
    const out = collapseChildren(twoSections, ["p"]);
    expect([...out.hidden]).toEqual(["p1"]);
  });

  it("ignores a collapsed id that is not on screen", () => {
    // A stale entry — the conversation was deleted or archived since — is
    // simply never consulted, which is why the list needs no pruning pass.
    const out = collapseChildren(list, ["deleted-long-ago"]);
    expect([...out.hidden]).toEqual([]);
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
  depth: 0,
  hasChildren: false,
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

describe("needsStripSig", () => {
  const chip = (over: Partial<ChatRow> = {}): ChatRow =>
    ({ id: "c1", title: "Alpha", reason: "perm", ...over }) as ChatRow;

  it("is identical across a tick where nothing about the blocked set moved", () => {
    // The strip is rebuilt whole, so an equal signature is what keeps the focus
    // ring on a chip the user is tabbing through across a 5s tick.
    expect(needsStripSig([chip()])).toBe(needsStripSig([chip()]));
  });

  it("moves when a blocked chat is retitled while its prompt is open", () => {
    // The generated-title path renames chats unprompted, including blocked
    // ones: a chip left on the old name points at a chat the user cannot find.
    expect(needsStripSig([chip()])).not.toBe(needsStripSig([chip({ title: "Renamed" })]));
  });

  it("moves when what a chat is waiting on changes", () => {
    expect(needsStripSig([chip()])).not.toBe(needsStripSig([chip({ reason: "ask" })]));
  });

  it("moves when the set itself changes", () => {
    expect(needsStripSig([chip()])).not.toBe(needsStripSig([chip(), chip({ id: "c2" })]));
    expect(needsStripSig([chip()])).not.toBe(needsStripSig([]));
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
  it("gives a bare noun for a chip and a noun phrase for a sentence", () => {
    expect(blockedReason("perm")).toEqual({ short: "permission", long: "permission" });
    expect(blockedReason("ask")).toEqual({ short: "answer", long: "an answer" });
  });

  it("is what the status line spends, so the two cannot drift", () => {
    const line = rowStatusText({ lane: "needs-input", reason: "ask", activity: null });
    expect(line).toBe(`Needs ${blockedReason("ask").long}`);
  });
});
