import { describe, it, expect } from "vitest";
import {
  planWorkingSet,
  deriveTabState,
  stripCap,
  toTabCandidate,
  tabSignature,
  tabAriaLabel,
  retiredFromStrip,
  countSurvivingRetirees,
  pinnedFirst,
  nextFocusAfterRemoval,
  stripAfterChildSpawn,
} from "../src/core/working-set";
import type { TabFacts } from "../src/core/working-set";

type Cand = Parameters<typeof planWorkingSet>[0][number];

const tab = (id: string, lastActiveAt: number, over: Partial<Cand> = {}): Cand => ({
  id,
  lastActiveAt,
  pinned: false,
  streaming: false,
  needsInput: false,
  hasDraft: false,
  hasQueue: false,
  ...over,
});

describe("planWorkingSet", () => {
  it("keeps everything while at or under the cap", () => {
    const tabs = [tab("a", 1), tab("b", 2), tab("c", 3)];
    const plan = planWorkingSet(tabs, { activeId: "c", cap: 6 });
    expect(plan.retire).toEqual([]);
    expect(plan.visible).toEqual(["a", "b", "c"]);
  });

  it("retires the least-recently-active when the cap is exceeded", () => {
    // 7 non-pinned, cap 6 -> exactly one retires, the oldest lastActiveAt.
    const tabs = [tab("a", 50), tab("b", 10), tab("c", 30), tab("d", 40), tab("e", 20), tab("f", 60), tab("g", 70)];
    const plan = planWorkingSet(tabs, { activeId: "g", cap: 6 });
    expect(plan.retire).toEqual(["b"]);
    expect(plan.visible).toEqual(["a", "c", "d", "e", "f", "g"]);
  });

  it("retires oldest-first when several slots are over", () => {
    const tabs = [tab("a", 30), tab("b", 10), tab("c", 20), tab("d", 40)];
    const plan = planWorkingSet(tabs, { activeId: "d", cap: 2 });
    expect(plan.retire).toEqual(["b", "c"]);
  });

  it("never retires the active tab even when it is the oldest", () => {
    const tabs = [tab("old", 1), tab("x", 50), tab("y", 60)];
    const plan = planWorkingSet(tabs, { activeId: "old", cap: 1 });
    expect(plan.retire).not.toContain("old");
  });

  it("never retires an exempt tab, and lets the strip grow when all are exempt", () => {
    // cap 1, but every tab is exempt for a different reason -> nothing retires.
    const tabs = [
      tab("active", 1),
      tab("streaming", 2, { streaming: true }),
      tab("blocked", 3, { needsInput: true }),
      tab("draft", 4, { hasDraft: true }),
      tab("queued", 5, { hasQueue: true }),
    ];
    const plan = planWorkingSet(tabs, { activeId: "active", cap: 1 });
    expect(plan.retire).toEqual([]);
    expect(plan.visible).toHaveLength(5);
  });

  it("does not count pinned tabs against the cap and never retires them", () => {
    // 3 pinned + 3 non-pinned, cap 3 -> nothing retires: only non-pinned count.
    const tabs = [
      tab("p1", 1, { pinned: true }),
      tab("p2", 2, { pinned: true }),
      tab("p3", 3, { pinned: true }),
      tab("a", 10),
      tab("b", 20),
      tab("c", 30),
    ];
    const plan = planWorkingSet(tabs, { activeId: "c", cap: 3 });
    expect(plan.retire).toEqual([]);
    expect(plan.visible).toHaveLength(6);
  });

  it("keeps a pinned tab even when the cap is actually over", () => {
    // The test above resolves to overBy = 0 and returns before `isExempt` is
    // ever evaluated: it pins down the cap FORMULA, not the exemption. Here the
    // cap is genuinely exceeded (4 non-pinned, cap 3 -> overBy 1) and the pinned
    // tab is the least-recently-active of all, i.e. the one the LRU would take
    // first. Pinning is the user's only opt-out from an automatic, silent
    // behaviour, so it has to be exercised under real pressure.
    const tabs = [tab("p", 1, { pinned: true }), tab("a", 10), tab("b", 20), tab("c", 30), tab("d", 40)];
    const plan = planWorkingSet(tabs, { activeId: "d", cap: 3 });
    expect(plan.retire).toEqual(["a"]);
    expect(plan.visible).toContain("p");
  });

  it("preserves the input order in visible", () => {
    // The strip must not reshuffle under the user: retiring removes, never sorts.
    const tabs = [tab("z", 90), tab("a", 10), tab("m", 50), tab("q", 80)];
    const plan = planWorkingSet(tabs, { activeId: "z", cap: 3 });
    expect(plan.retire).toEqual(["a"]);
    expect(plan.visible).toEqual(["z", "m", "q"]);
  });
});

describe("retire bookkeeping", () => {
  it("a retired tab carries a retiredAt timestamp and leaves the visible set", () => {
    // Contract the view must honour: retiring writes a timestamp (never 0 —
    // toConvoData drops a falsy retiredAt) and removes the id from the strip.
    const tabs = [tab("keep", 90), tab("old", 10), tab("active", 99)];
    const plan = planWorkingSet(tabs, { activeId: "active", cap: 2 });
    expect(plan.retire).toEqual(["old"]);
    expect(plan.visible).not.toContain("old");
    expect(plan.visible).toEqual(["keep", "active"]);
  });
});

describe("toTabCandidate", () => {
  type Source = Parameters<typeof toTabCandidate>[0];
  const convo = (over: Partial<Source> = {}): Source => ({
    id: "c1",
    streaming: false,
    pendingPerm: null,
    pendingAsk: null,
    queue: [],
    ...over,
  });
  const draft = (over = {}) => ({ text: "", images: [], attached: [], dismissedActive: null, ...over });

  it("prefers lastActiveAt, falls back to updatedAt, then 0", () => {
    // The fallback is what keeps pre-field conversations from all tying at 0.
    expect(toTabCandidate(convo({ lastActiveAt: 7, updatedAt: 3 })).lastActiveAt).toBe(7);
    expect(toTabCandidate(convo({ updatedAt: 3 })).lastActiveAt).toBe(3);
    expect(toTabCandidate(convo()).lastActiveAt).toBe(0);
  });

  it("reads pinned strictly, like every other site", () => {
    expect(toTabCandidate(convo({ pinned: true })).pinned).toBe(true);
    expect(toTabCandidate(convo()).pinned).toBe(false);
  });

  it("treats an open permission or ask card as needsInput", () => {
    expect(toTabCandidate(convo()).needsInput).toBe(false);
    expect(toTabCandidate(convo({ pendingPerm: () => {} })).needsInput).toBe(true);
    expect(toTabCandidate(convo({ pendingAsk: () => {} })).needsInput).toBe(true);
  });

  it("does not call a pristine composer a draft", () => {
    // getDraft() always returns an object, so presence is not evidence: an empty
    // composer that counted as a draft would exempt every tab from the cap.
    expect(toTabCandidate(convo({ draft: draft() })).hasDraft).toBe(false);
    expect(toTabCandidate(convo({ draft: draft({ text: "   \n" }) })).hasDraft).toBe(false);
  });

  it("counts text and images as unsent content", () => {
    expect(toTabCandidate(convo({ draft: draft({ text: "wip" }) })).hasDraft).toBe(true);
    expect(toTabCandidate(convo({ draft: draft({ images: [{}] }) })).hasDraft).toBe(true);
  });

  it("does not count attached context, which a send never clears", () => {
    // manualAttached is a sticky selection: sending clears the text and the
    // images but leaves it, so counting it would exempt a chat from the cap
    // permanently after a single attach — the cap would be quietly inert.
    expect(toTabCandidate(convo({ draft: draft({ attached: ["Note.md"] }) })).hasDraft).toBe(false);
    // ... but it must not suppress a real draft sitting alongside it.
    expect(toTabCandidate(convo({ draft: draft({ attached: ["Note.md"], text: "wip" }) })).hasDraft).toBe(true);
  });

  it("reports a non-empty queue", () => {
    expect(toTabCandidate(convo()).hasQueue).toBe(false);
    expect(toTabCandidate(convo({ queue: [{ text: "next" }] })).hasQueue).toBe(true);
  });
});

describe("stripCap", () => {
  it("passes a usable cap through, floored", () => {
    expect(stripCap(6, 6)).toBe(6);
    expect(stripCap(3.7, 6)).toBe(3);
  });

  it("falls back on a hand-edited data.json rather than emptying the strip", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "8", null, undefined]) {
      expect(stripCap(bad, 6)).toBe(6);
    }
  });
});

describe("deriveTabState", () => {
  const sig = (over = {}) => ({
    streaming: false,
    pendingPerm: false,
    pendingAsk: false,
    unread: false,
    stopped: false,
    poisoned: false,
    ...over,
  });

  it("is idle with no signals", () => {
    expect(deriveTabState(sig())).toEqual({ state: "idle", needsInput: false });
  });

  it("reports streaming and needsInput on separate channels so they compose", () => {
    // A turn blocked on a permission prompt is STILL streaming (the turn's
    // finally has not run). One enum could not say both; two channels can.
    expect(deriveTabState(sig({ streaming: true, pendingPerm: true }))).toEqual({
      state: "streaming",
      needsInput: true,
      reason: "perm",
    });
  });

  it("distinguishes the two needs-input reasons", () => {
    expect(deriveTabState(sig({ pendingAsk: true })).reason).toBe("ask");
  });

  it("prefers streaming over unread", () => {
    expect(deriveTabState(sig({ streaming: true, unread: true })).state).toBe("streaming");
  });

  it("prefers unread over a terminal badge", () => {
    // "It finished while you were away" is the more actionable fact.
    expect(deriveTabState(sig({ unread: true, stopped: true })).state).toBe("unread");
  });

  it("prefers stopped over error, matching deriveLane", () => {
    expect(deriveTabState(sig({ stopped: true, poisoned: true })).state).toBe("stopped");
  });

  it("reports error when poisoned alone", () => {
    expect(deriveTabState(sig({ poisoned: true })).state).toBe("error");
  });
});

describe("tabAriaLabel", () => {
  const quiet = { agents: { count: 0, spinning: false }, pinned: false };

  it("says nothing extra when the tab is idle", () => {
    // The mark draws nothing; the label adds nothing. Absence on both channels.
    expect(tabAriaLabel("Vault refactor", { state: "idle", needsInput: false }, quiet)).toBe("Vault refactor");
  });

  it("reports both channels when a streaming turn is blocked on the user", () => {
    expect(
      tabAriaLabel("Vault refactor", { state: "streaming", needsInput: true, reason: "perm" }, quiet)
    ).toBe("Vault refactor, running, waiting for permission");
  });

  it("distinguishes the two needs-input reasons", () => {
    expect(tabAriaLabel("Vault refactor", { state: "idle", needsInput: true, reason: "ask" }, quiet)).toBe(
      "Vault refactor, waiting for your answer"
    );
  });

  it("gives every non-idle state words of its own", () => {
    const said = (["streaming", "unread", "stopped", "error"] as const).map((state) =>
      tabAriaLabel("T", { state, needsInput: false }, quiet)
    );
    expect(new Set(said).size).toBe(said.length);
    expect(said.every((s) => s.startsWith("T, "))).toBe(true);
  });

  it("carries the pin and the agent count, which the explicit label would otherwise hide", () => {
    // An explicit aria-label REPLACES name-from-content, so the pin icon's and
    // the badge's own labels stop being announced: whatever the tab shows and
    // this string omits becomes sighted-only.
    expect(
      tabAriaLabel(
        "Vault refactor",
        { state: "streaming", needsInput: false },
        { agents: { count: 2, spinning: true }, pinned: true }
      )
    ).toBe("Vault refactor, pinned, running, 2 agents");
  });

  it("keeps the agent count singular at one", () => {
    expect(
      tabAriaLabel("T", { state: "idle", needsInput: false }, { agents: { count: 1, spinning: true }, pinned: false })
    ).toBe("T, 1 agent");
  });

  it("says 'background', never 'agent', once nothing is actually running", () => {
    // A task that DETACHED at turn end is not running — Exo cannot poll it, so
    // the label must not claim knowledge it doesn't have. This is the aria
    // twin of the tab badge bug: a spinning "N agents" left over from before
    // the turn ended, on a tab that is no longer doing anything Exo can see.
    expect(
      tabAriaLabel("T", { state: "idle", needsInput: false }, { agents: { count: 1, spinning: false }, pinned: false })
    ).toBe("T, 1 background");
  });

  it("'background' does not inflect — unlike 'agent(s)' it reads the same at any count", () => {
    expect(
      tabAriaLabel("T", { state: "idle", needsInput: false }, { agents: { count: 3, spinning: false }, pinned: false })
    ).toBe("T, 3 background");
  });
});

describe("tabSignature", () => {
  const facts = (over: Partial<TabFacts> = {}): TabFacts => ({
    title: "Refactor the parser",
    placeholder: false,
    state: "idle",
    needsInput: false,
    agents: { count: 0, spinning: false },
    pinned: false,
    active: false,
    density: "wide",
    firstUnpinned: false,
    ...over,
  });

  it("is stable for identical facts", () => {
    expect(tabSignature(facts())).toBe(tabSignature(facts()));
  });

  // One case per field: an omitted field is a state change that silently fails
  // to repaint, so every rendered fact gets its own pin here. Kept exhaustive
  // by the coverage test right below.
  const variants: [keyof TabFacts, Partial<TabFacts>][] = [
    ["title", { title: "Something else" }],
    ["placeholder", { placeholder: true }],
    ["state", { state: "streaming" }],
    ["needsInput", { needsInput: true, reason: "perm" }],
    ["agents", { agents: { count: 1, spinning: false } }],
    ["pinned", { pinned: true }],
    ["active", { active: true }],
    // The one that would have failed silently: in `dense` a non-active tab has
    // no title, no pin and no ×, so a flip the signature does not carry leaves
    // every untouched node painted for the density that just ended.
    ["density", { density: "dense" }],
    ["firstUnpinned", { firstUnpinned: true }],
  ];
  for (const [name, over] of variants) {
    it(`changes when ${name} changes`, () => {
      expect(tabSignature(facts(over))).not.toBe(tabSignature(facts()));
    });
  }

  it("pins every field of TabFacts", () => {
    // A field added later with no variant above would be a fact that can change
    // without changing the string — the silently-stale tab this whole shape
    // exists to prevent. `reason` has its own two cases below.
    const covered = new Set<string>([...variants.map(([k]) => k), "reason"]);
    expect(Object.keys(facts()).filter((k) => !covered.has(k))).toEqual([]);
  });

  it("distinguishes the two needs-input reasons", () => {
    expect(tabSignature(facts({ needsInput: true, reason: "perm" }))).not.toBe(
      tabSignature(facts({ needsInput: true, reason: "ask" }))
    );
  });

  it("ignores a reason left behind on a tab that is no longer blocked", () => {
    // Otherwise a stale reason would keep the signature different from the
    // freshly-unblocked one and repaint forever.
    expect(tabSignature(facts({ needsInput: false, reason: "perm" }))).toBe(tabSignature(facts()));
  });

  it("changes when a task detaches even though the count stays the same", () => {
    // This is the actual bug: a task going from running to detached (Exo can no
    // longer poll it, so it must stop spinning and stop being called "running")
    // does not change `count`. If the signature only carried `count`, the
    // reconciler would treat the tab as unchanged and leave a stale spinning
    // "N agents running" badge on a tab that has nothing left to report.
    expect(tabSignature(facts({ agents: { count: 1, spinning: true } }))).not.toBe(
      tabSignature(facts({ agents: { count: 1, spinning: false } }))
    );
  });

  it("does not collide across field boundaries", () => {
    // Fields are joined, so a value bleeding into its neighbour would make two
    // different tabs share a signature.
    expect(tabSignature(facts({ title: "a|b" }))).not.toBe(tabSignature(facts({ title: "a", placeholder: true })));
  });
});

describe("retiredFromStrip", () => {
  type Conv = Parameters<typeof retiredFromStrip>[0][number];
  const conv = (id: string, over: Partial<Conv> = {}): Conv => ({
    id,
    retiredAt: 1000,
    messages: ["hi"],
    ...over,
  });
  // These tests exercise the four non-time conditions, not the window added
  // below — `now` is pinned right at the fixtures' own `retiredAt` so the
  // cutoff falls deep in the past and never excludes anything here.
  const NOW = 1000;

  it("counts a chat that left the strip and is still retrievable", () => {
    expect(retiredFromStrip([conv("a")], [], NOW).map((c) => c.id)).toEqual(["a"]);
  });

  it("ignores a chat that was never in the strip", () => {
    // No retiredAt: an old history entry that was never a tab must not inflate
    // the number — that would turn the counter into "everything you ever wrote".
    expect(retiredFromStrip([conv("a", { retiredAt: undefined })], [], NOW)).toEqual([]);
  });

  it("ignores a chat that is currently an open tab", () => {
    // Reopening un-retires, but the number must be right in the window before
    // that too: a tab on screen is not hidden.
    expect(retiredFromStrip([conv("a"), conv("b")], ["b"], NOW).map((c) => c.id)).toEqual(["a"]);
  });

  it("ignores archived chats — a different exit with a different destination", () => {
    expect(retiredFromStrip([conv("a", { archived: true })], [], NOW)).toEqual([]);
  });

  it("counts a chat whose archived flag is explicitly false", () => {
    expect(retiredFromStrip([conv("a", { archived: false })], [], NOW).map((c) => c.id)).toEqual(["a"]);
  });

  it("ignores empty husks — the history does not list them", () => {
    // A "New chat" with nothing in it can be retired by the cap, but it has no
    // card in the history, so counting it promises something clicking cannot
    // deliver. This is the case the counter's contract exists for.
    expect(retiredFromStrip([conv("a", { messages: [] })], [], NOW)).toEqual([]);
  });

  it("counts every exit path alike once each is stamped", () => {
    // The cap, both archive gestures and the manual x all stamp retiredAt; the
    // filter reads the stamp, not the gesture, so they cannot disagree.
    const all = [conv("cap"), conv("x", { retiredAt: 2000 }), conv("open"), conv("husk", { messages: [] })];
    expect(retiredFromStrip(all, ["open"], NOW).map((c) => c.id)).toEqual(["cap", "x"]);
  });

  it("accepts any iterable of open ids, including a Set", () => {
    expect(retiredFromStrip([conv("a"), conv("b")], new Set(["a"]), NOW).map((c) => c.id)).toEqual(["b"]);
  });
});

describe("countSurvivingRetirees", () => {
  const withMessages = (n: number) => ({ messages: n > 0 ? ["hi"] : [] });

  it("counts nothing when the whole batch is empty husks", () => {
    // Four blank tabs opened and never typed in, then the cap fires: none of
    // them get a card in the history, so a notice built on this count must
    // stay silent rather than announce "4 chat ritirate" for zero destinations.
    expect(countSurvivingRetirees([withMessages(0), withMessages(0), withMessages(0), withMessages(0)])).toBe(0);
  });

  it("counts only the retirees that actually have content", () => {
    // Mixed batch: two real chats and two blank husks retire together. Only
    // the two with messages will be retrievable from the history afterwards.
    expect(
      countSurvivingRetirees([withMessages(1), withMessages(0), withMessages(2), withMessages(0)]),
    ).toBe(2);
  });

  it("counts every retiree when none are empty", () => {
    expect(countSurvivingRetirees([withMessages(1), withMessages(3)])).toBe(2);
  });
});

describe("pinnedFirst", () => {
  const pinnedSet = (ids: readonly string[]) => (id: string) => ids.includes(id);

  it("moves pinned ids to the front, keeping unpinned after", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const isPinned = pinnedSet(["c", "e"]);
    expect(pinnedFirst(ids, isPinned)).toEqual(["c", "e", "a", "b", "d", "f"]);
  });

  it("preserves relative order within each group", () => {
    // Pinned "d" and "b" keep b-before-d; unpinned a/c/e keep their own order.
    const ids = ["a", "b", "c", "d", "e"];
    const isPinned = pinnedSet(["b", "d"]);
    const result = pinnedFirst(ids, isPinned);
    expect(result).toEqual(["b", "d", "a", "c", "e"]);
  });

  it("is the identity when every tab is pinned", () => {
    const ids = ["x", "y", "z"];
    expect(pinnedFirst(ids, () => true)).toEqual(["x", "y", "z"]);
  });

  it("is the identity when no tab is pinned", () => {
    const ids = ["x", "y", "z"];
    expect(pinnedFirst(ids, () => false)).toEqual(["x", "y", "z"]);
  });

  it("returns an empty list for an empty input", () => {
    expect(pinnedFirst([], () => true)).toEqual([]);
  });

  it("unpinning returns a tab to its original relative position among the unpinned", () => {
    // "c" was pinned (front); once unpinned it should reappear in its original
    // slot relative to the other unpinned ids, not stranded at either edge.
    const ids = ["a", "b", "c", "d", "e"];
    const pinnedBefore = pinnedSet(["c"]);
    expect(pinnedFirst(ids, pinnedBefore)).toEqual(["c", "a", "b", "d", "e"]);
    const pinnedAfter = pinnedSet([]); // c unpinned
    expect(pinnedFirst(ids, pinnedAfter)).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("nextFocusAfterRemoval", () => {
  it("picks the right-hand visual neighbour when removing a middle tab", () => {
    // The reviewer's trace: openTabs = [a, b, c(pinned), d] renders visually as
    // [c, a, b, d]. Closing active tab b must land on its visual right, d —
    // NOT on c, which only looked adjacent in the old storage-order arithmetic.
    expect(nextFocusAfterRemoval(["c", "a", "b", "d"], "b")).toBe("d");
  });

  it("falls back to the left-hand visual neighbour when removing the rightmost tab", () => {
    expect(nextFocusAfterRemoval(["c", "a", "b", "d"], "d")).toBe("b");
  });

  it("picks the right-hand neighbour when the removed tab was pinned (leftmost)", () => {
    expect(nextFocusAfterRemoval(["c", "a", "b", "d"], "c")).toBe("a");
  });

  it("returns undefined when removing the only tab", () => {
    expect(nextFocusAfterRemoval(["only"], "only")).toBeUndefined();
  });

  it("returns undefined when the removed id is not in the list", () => {
    // Defensive: an id that was never part of the visual order has no neighbour.
    expect(nextFocusAfterRemoval(["a", "b"], "z")).toBeUndefined();
  });
});

describe("retiredFromStrip time window", () => {
  const NOW = 1_700_000_000_000;
  const DAY = 86_400_000;

  it("excludes a retired conversation older than the default 14-day window", () => {
    const c = { id: "old", retiredAt: NOW - 20 * DAY, archived: false, messages: [{}] };
    expect(retiredFromStrip([c], [], NOW)).toEqual([]);
  });

  it("includes a retired conversation within the window", () => {
    const c = { id: "recent", retiredAt: NOW - 2 * DAY, archived: false, messages: [{}] };
    expect(retiredFromStrip([c], [], NOW)).toEqual([c]);
  });

  it("accepts a custom window, for callers that need a different cutoff", () => {
    const c = { id: "mid", retiredAt: NOW - 20 * DAY, archived: false, messages: [{}] };
    expect(retiredFromStrip([c], [], NOW, 30 * DAY)).toEqual([c]);
    expect(retiredFromStrip([c], [], NOW, 10 * DAY)).toEqual([]);
  });
});

describe("stripAfterChildSpawn", () => {
  it("takes the freshly spawned child out of the strip, leaving every other tab alone", () => {
    expect(stripAfterChildSpawn(["a", "child", "b"], "child", "a")).toEqual(["a", "b"]);
  });

  /** No prior conversation to switch back to: the child IS the active tab.
   *  Removing it would leave the view focused on a chat the strip does not
   *  contain — a visible child is the smaller problem. */
  it("never removes the active tab", () => {
    const tabs = ["child"];
    expect(stripAfterChildSpawn(tabs, "child", "child")).toBe(tabs);
  });

  it("is a no-op for an id that is not in the strip, so calling it twice is safe", () => {
    const tabs = ["a", "b"];
    expect(stripAfterChildSpawn(tabs, "child", "a")).toBe(tabs);
    const once = stripAfterChildSpawn(["a", "child"], "child", "a");
    expect(stripAfterChildSpawn(once, "child", "a")).toBe(once);
  });

  it("returns the same instance when nothing changed, so the caller can skip the persist", () => {
    const tabs = ["a", "b"];
    expect(stripAfterChildSpawn(tabs, "missing", "a")).toBe(tabs);
    expect(stripAfterChildSpawn(tabs, "a", "a")).toBe(tabs);
  });

  it("removes only the child, even when the strip repeats nothing else about it", () => {
    // Order of the survivors is preserved: the strip is a user-arranged list.
    expect(stripAfterChildSpawn(["p", "c1", "q", "c2"], "c1", "p")).toEqual(["p", "q", "c2"]);
  });
});
