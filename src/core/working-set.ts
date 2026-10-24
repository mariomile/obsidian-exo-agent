/**
 * Working-set core — decides which conversations stay in the tab strip, and how
 * each one looks. Pure (no `obsidian`, no DOM) so both policies are testable in
 * isolation, same discipline as `retention.ts` and `session-cards.ts`.
 *
 * Why a strip cap at all: opening a tab has an immediate motive, closing one has
 * none, so the strip converges on the maximum. The cap is the counter-pressure.
 * It is deliberately count-based and not time-based: retiring only ever happens
 * as a consequence of the user opening something, never while they are away.
 *
 * Retiring is NOT deleting. Since the retention split (see `retention.ts`),
 * leaving the strip has no bearing on whether a conversation survives on disk.
 */
import type { NeedsInputReason } from "./session-cards";
import type { StripDensity } from "./strip-density";

// ---------------------------------------------------------------------------
// Working set
// ---------------------------------------------------------------------------

/** One tab's inputs to the retire decision. */
export interface TabCandidate {
  id: string;
  /** Last time this tab was the focused one. The LRU key — deliberately NOT
   *  `updatedAt`, which only moves on a turn: looking at a tab without typing
   *  must protect it from being retired a moment later. */
  lastActiveAt: number;
  /** Explicit user protection: never retired, and does not count against the cap. */
  pinned: boolean;
  streaming: boolean;
  /** Blocked on a permission or ask prompt. */
  needsInput: boolean;
  /** Unsent composer text or attachments. */
  hasDraft: boolean;
  /** Messages queued behind the current turn. */
  hasQueue: boolean;
}

export interface WorkingSetPlan {
  /** Ids that stay in the strip, in the input's original order. */
  visible: string[];
  /** Ids to retire now, least-recently-active first. */
  retire: string[];
}

/**
 * Decide the strip's contents. `cap` counts only NON-pinned tabs: pinning is how
 * the user opts a tab out of the budget entirely.
 *
 * SIX exemptions, and the list is the whole contract of the one function that
 * can take a tab away — a partial list here is worse than none, because the next
 * reader will trust it:
 * - `pinned` — the user said so explicitly. Also excluded from the cap's count.
 * - `id === activeId` — the tab being looked at right now.
 * - `streaming` — a turn is in flight.
 * - `needsInput` — the turn is blocked on a permission or ask prompt.
 * - `hasDraft` — unsent composer text or images.
 * - `hasQueue` — messages waiting behind the current turn.
 *
 * Each one is work the user has not finished. When every over-cap tab is exempt
 * the strip simply grows; that is correct, and preferable to tearing away live
 * work to satisfy a number.
 *
 * KNOWN COST: `unread` is deliberately NOT an exemption. `lastActiveAt` moves
 * only on focus, never on turn activity, so a background chat that just finished
 * carries an old LRU key and is a prime retire candidate: it can leave the strip
 * before the user ever sees its mark. The mark itself is not lost: it is derived
 * from persisted fields (`updatedAt` against `lastActiveAt`/`seenAt`, core/inbox
 * `isUnseen`), so the chat stays in the Inbox and the sidebar until it is read.
 * The alternative is worse: twenty background chats finishing would exempt all
 * twenty and make the cap inert, which is the failure this file exists to
 * prevent. Recorded here so the trade-off is a decision on the record, not a bug
 * rediscovered later.
 */
export function planWorkingSet(
  tabs: TabCandidate[],
  opts: { activeId: string; cap: number },
): WorkingSetPlan {
  const isExempt = (t: TabCandidate): boolean =>
    t.pinned || t.streaming || t.needsInput || t.hasDraft || t.hasQueue || t.id === opts.activeId;

  const overBy = tabs.filter((t) => !t.pinned).length - opts.cap;
  if (overBy <= 0) return { visible: tabs.map((t) => t.id), retire: [] };

  const retire = new Set<string>();
  const byAge = tabs.filter((t) => !isExempt(t)).sort((a, b) => a.lastActiveAt - b.lastActiveAt);
  for (const t of byAge) {
    if (retire.size >= overBy) break;
    retire.add(t.id);
  }

  return {
    // Order is preserved: retiring removes entries, it never reshuffles the
    // strip under the user's cursor.
    visible: tabs.filter((t) => !retire.has(t.id)).map((t) => t.id),
    retire: byAge.filter((t) => retire.has(t.id)).map((t) => t.id),
  };
}

/**
 * Pinned tab ids first, everything else after, each group keeping its relative
 * order. Pinning is how the user says "keep this reachable", so a pinned tab
 * belongs at a stable, predictable edge rather than wherever it happened to sit.
 *
 * Stable within each group on purpose: pinning one tab must not reshuffle the
 * others among themselves, and unpinning returns a tab to its place in the rest
 * rather than stranding it at the front.
 */
export function pinnedFirst(ids: readonly string[], isPinned: (id: string) => boolean): string[] {
  const pinned: string[] = [];
  const rest: string[] = [];
  for (const id of ids) (isPinned(id) ? pinned : rest).push(id);
  return [...pinned, ...rest];
}

/**
 * Which tab should get focus after `removedId` leaves the strip, in VISUAL
 * (`pinnedFirst`) order. `orderedIds` is the order from BEFORE the removal —
 * the removed id is still in it — so "was it rightmost" is answered by its
 * position there, not by re-deriving order after the fact.
 *
 * Prefers the neighbour that was to the removed tab's right: closing a tab
 * slides the strip left under the cursor, so the tab that slides into the
 * closed one's old slot is the one the eye already expects to land on.
 * Falls back to the left neighbour when the removed tab was rightmost, and
 * to `undefined` when it was the only tab — callers own that last fallback
 * (typically: open a fresh conversation).
 *
 * Three call sites share this exact decision (`closeTab`, `setConvoArchived`,
 * `deleteConvo` in view.ts) and, before this function existed, each picked by
 * storage-order adjacency instead — correct only as long as storage order and
 * visual order were the same list. Pinned-first sorting broke that equivalence:
 * closing an unpinned tab next to a pinned block could jump focus onto the
 * pinned tab, several slots from where the eye was. This function is the one
 * place that decision is made, so the three sites cannot drift apart again.
 */
export function nextFocusAfterRemoval(orderedIds: readonly string[], removedId: string): string | undefined {
  const idx = orderedIds.indexOf(removedId);
  if (idx === -1) return undefined;
  return orderedIds[idx + 1] ?? orderedIds[idx - 1];
}

/** Clamp the configured cap. Mirrors `retentionBudgetBytes` in retention.ts:
 *  settings come from a hand-editable data.json, and a 0 / negative / NaN cap
 *  would retire every non-exempt tab in the strip in one go. */
export function stripCap(cap: unknown, fallback: number): number {
  const usable = typeof cap === "number" && Number.isFinite(cap) && cap > 0;
  return Math.floor(usable ? cap : fallback);
}

/** The slice of a live conversation the strip's decision reads. Structural on
 *  purpose: the real `Convo` carries DOM and sessions, and this file stays free
 *  of both — it only needs to satisfy this shape. */
export interface TabCandidateSource {
  id: string;
  lastActiveAt?: number;
  updatedAt?: number;
  pinned?: boolean;
  streaming: boolean;
  /** Cancel handles for an open permission / ask card — non-null means blocked. */
  pendingPerm: unknown;
  pendingAsk: unknown;
  /** The stashed composer draft, if any. Only the two fields the SEND path
   *  clears are read — see `toTabCandidate` on why `attached` is not one. */
  draft?: { text: string; images: readonly unknown[] };
  queue: readonly unknown[];
}

/**
 * Project a conversation onto the retire decision's inputs. Lives here, next to
 * the policy, because this mapping is where a wrong field silently disables an
 * exemption — and an exemption that fails open costs the user their place in a
 * tab that still had work in it.
 *
 * `lastActiveAt` falls back to `updatedAt` (then 0) so conversations restored
 * from a store written before the field existed sort by their last turn instead
 * of all tying at 0 and retiring in arbitrary order.
 *
 * `hasDraft` reads ONLY text and images, deliberately not `draft.attached`. An
 * exemption has to be able to end, and that one cannot: sending clears the input
 * text and the pending images, but never `manualAttached` — the attached-context
 * selection is sticky by design, and the user only drops it by clicking the x on
 * a context card. Counting it would mean that attaching a note to a chat once
 * exempts that chat from the cap for the rest of its life, with nothing on
 * screen explaining why the strip is over budget. That is the "cap is inert"
 * failure this whole file exists to prevent.
 */
export function toTabCandidate(c: TabCandidateSource): TabCandidate {
  return {
    id: c.id,
    lastActiveAt: c.lastActiveAt ?? c.updatedAt ?? 0,
    // Strict `=== true`, matching every other site that reads `pinned`.
    pinned: c.pinned === true,
    streaming: c.streaming,
    needsInput: c.pendingPerm != null || c.pendingAsk != null,
    // "Unsent content" is text or images: exactly what a send consumes.
    hasDraft: !!c.draft && (c.draft.text.trim().length > 0 || c.draft.images.length > 0),
    hasQueue: c.queue.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Overflow counter
// ---------------------------------------------------------------------------

/** The slice of a conversation the overflow counter reads. Structural, same
 *  discipline as `TabCandidateSource`: the real `Convo` satisfies it as-is, and
 *  this file never learns what a message or a DOM node is. */
export interface RetiredCandidateSource {
  id: string;
  /** When it last left the strip. Absent = never was a tab, or still is one. */
  retiredAt?: number;
  archived?: boolean;
  /** Only `.length` is read: a conversation with no messages is a husk the
   *  history does not list and the next persist drops (see `serializeSplit`),
   *  so counting one would promise a card that does not exist. */
  messages: readonly unknown[];
}

/**
 * The conversations that left the strip and are retrievable from the history.
 *
 * This IS the counter's contract, and the reason it returns the list rather than
 * a number: the count the strip shows has to be the size of the set clicking it
 * opens — a number that does not match what it shows is worse than no number —
 * so the count and the future "Ritirate di recente" group are one filter, not
 * two implementations that agree today.
 *
 * Four conditions, each load-bearing:
 * - `retiredAt` set — it was a tab and left. Every exit stamps it: the cap, both
 *   archive gestures, and the manual x (see `closeTab`). "Left the strip" has to
 *   mean one thing however you left, or the number is a subset of itself.
 * - not archived — archiving is a different exit with a different destination
 *   (the separate archive store, surfaced by "Show archived").
 * - has messages — see `messages` above.
 * - not an open tab — reopening un-retires (`switchTo` clears `retiredAt`), but
 *   this also covers the window before that: a tab on screen is not "hidden".
 *
 * THE WINDOW IS CLOSED. This used to run without one — a known cost, not an
 * oversight, because the count had to equal what its destination showed, and
 * that destination was the whole history. The debt was explicit: `retiredAt`
 * never expires, so an unwindowed filter only grows, and after a few weeks it
 * reports the size of the history rather than what the strip is hiding. It is
 * closed here, together with the "Ritirate di recente" group that reads this
 * same function — the docstring that used to sit here demanded exactly that:
 * whoever added the group had to add the window in the same commit, so the
 * count and the set it opens could never point at different definitions of
 * "recently retired". The default window is short (see `DEFAULT_RETIRED_WINDOW_MS`
 * below) precisely so "recently retired" still reads as recent; a chat that
 * ages out is still on disk and still in the full history, one search away —
 * the window only stops it from being counted, and shown, as if it just
 * happened.
 */
/** Default: a retired chat stops counting as "recently retired" after two
 *  weeks. Not exposed as a setting yet — YAGNI until someone asks; a constant
 *  beats a config surface nobody requested. */
export const DEFAULT_RETIRED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export function retiredFromStrip<T extends RetiredCandidateSource>(
  convos: readonly T[],
  openIds: Iterable<string>,
  now: number,
  windowMs: number = DEFAULT_RETIRED_WINDOW_MS,
): T[] {
  const open = new Set(openIds);
  const cutoff = now - windowMs;
  return convos.filter(
    (c) =>
      !!c.retiredAt &&
      c.retiredAt >= cutoff &&
      c.archived !== true &&
      c.messages.length > 0 &&
      !open.has(c.id),
  );
}

/** Subset a batch-retire notice needs: whether the conversation has content. */
export interface RetireNoticeCandidate {
  messages: readonly unknown[];
}

/**
 * How many of a just-retired batch will actually be sitting in the history
 * afterwards, so a "N ritirate" notice can say a number the user can go find.
 *
 * An empty "New chat" husk gets `retiredAt` stamped like everything else in
 * the batch, but `planRetention` drops it on the very next persist (nothing to
 * protect) and `retiredFromStrip` above excludes it from the overflow counter
 * for the same reason: it never gets a card in the history. Counting it in a
 * notice would claim a destination that does not exist for it — the same
 * mismatch `retiredFromStrip`'s own contract exists to prevent. Same predicate
 * as `retiredFromStrip`'s `messages.length > 0`, on purpose: both answer "will
 * this show up in the history", so they must not drift apart.
 */
export function countSurvivingRetirees<T extends RetireNoticeCandidate>(
  retired: readonly T[],
): number {
  return retired.filter((c) => c.messages.length > 0).length;
}

// ---------------------------------------------------------------------------
// Tab state
// ---------------------------------------------------------------------------

/** The mark's state. `needsInput` is deliberately NOT a member here: it rides a
 *  different visual channel (the whole tab lifts) precisely so it can coexist
 *  with any of these instead of competing for the same slot. */
export type TabState = "idle" | "streaming" | "unread" | "stopped" | "error";

/** The runtime signals a tab renders from. Same shape as the fields
 *  `SessionSnapshot` carries, so the sidebar and the strip read one vocabulary of
 *  signals even though they render different vocabularies of output. */
export interface TabSignals {
  streaming: boolean;
  pendingPerm: boolean;
  pendingAsk: boolean;
  /** A turn completed on this conversation while it was not the active one. */
  unread: boolean;
  stopped: boolean;
  poisoned: boolean;
}

export interface TabVM {
  state: TabState;
  /** The turn is blocked on the user. Composes with `state` rather than
   *  replacing it: "running, but waiting on you" is one tab, two facts. */
  needsInput: boolean;
  reason?: NeedsInputReason;
}

/**
 * Translate runtime signals into the tab's view-model.
 *
 * `needsInput` is computed independently of `state` on purpose. A conversation
 * blocked on a permission prompt is still `streaming: true` — the turn's
 * `finally` has not run (see the same note on `deriveLane`, session-cards.ts).
 * A single enum would have to pick a winner and lose the other fact; two
 * channels report both.
 *
 * State precedence: streaming (it is happening now) > unread (it finished and
 * you have not seen it) > stopped > error. `stopped` beating `error` mirrors
 * `deriveLane`: a user-stopped turn reads as a stop, not a failure.
 */
export function deriveTabState(s: TabSignals): TabVM {
  const reason: NeedsInputReason | undefined = s.pendingPerm ? "perm" : s.pendingAsk ? "ask" : undefined;
  const needsInput = reason !== undefined;

  const state: TabState = s.streaming
    ? "streaming"
    : s.unread
      ? "unread"
      : s.stopped
        ? "stopped"
        : s.poisoned
          ? "error"
          : "idle";

  return reason ? { state, needsInput, reason } : { state, needsInput };
}

/** What each state says, in words. `idle` is empty on purpose: the mark draws
 *  nothing, so the label adds nothing — absence is the signal on both channels. */
const STATE_WORDS: Record<TabState, string> = {
  idle: "",
  streaming: "running",
  unread: "finished while you were away",
  stopped: "stopped",
  error: "ended with an error",
};

/**
 * The tab's accessible name: the title plus, in words, what the mark says in
 * colour and what the lift says in weight. Without this the whole message is
 * carried by 6px of colour, which is exactly the part a screen reader cannot
 * reach.
 *
 * Both channels are reported when both are on — "running, waiting for
 * permission" — for the same reason `state` and `needsInput` are separate
 * fields: one tab, two facts, and picking a winner would drop one of them.
 *
 * It also has to carry `pinned` and `agents`. An explicit label REPLACES
 * name-from-content, so the pin icon's own label and the agent badge's own
 * label stop being announced the moment this attribute exists: anything the tab
 * shows and this string omits is a fact only sighted users get.
 */
/** Per-tab agent affordance: how many, and whether Exo actually knows any of
 *  them are still going. A task that DETACHED at turn end (background Bash,
 *  a Workflow whose stream closed) is not running — Exo cannot poll it — so
 *  `spinning` must be false for a tab whose only live tasks are detached. */
export interface TabAgents {
  count: number;
  spinning: boolean;
}

export function tabAriaLabel(
  title: string,
  vm: TabVM,
  extra: { agents: TabAgents; pinned: boolean },
): string {
  const parts = [title];
  if (extra.pinned) parts.push("pinned");
  const word = STATE_WORDS[vm.state];
  if (word) parts.push(word);
  if (vm.needsInput) {
    parts.push(vm.reason === "ask" ? "waiting for your answer" : "waiting for permission");
  }
  // Last: it is context, not the thing you have to act on. "Agent(s)" only
  // while Exo actually knows one is running; otherwise "background" — which,
  // unlike "agent(s)", does not inflect with the count.
  const { count, spinning } = extra.agents;
  if (count > 0) parts.push(spinning ? `${count} agent${count > 1 ? "s" : ""}` : `${count} background`);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Tab signature
// ---------------------------------------------------------------------------

/**
 * Every fact one tab renders. The strip reconciles keyed on `id` and skips any
 * node whose signature is unchanged, so this interface IS the contract: a fact
 * the tab paints but this shape omits becomes a state change that silently
 * fails to repaint — the exact defect keyed reconciliation was introduced to
 * fix. Adding a field costs a repaint that would have happened anyway; leaving
 * one out costs a stale tab, so this errs deliberately towards including more
 * than the current paint reads.
 */
export interface TabFacts {
  title: string;
  /** Untitled AND empty: painted as the italic placeholder, which is a
   *  different element from a plain title even when the two texts match — so
   *  the title string alone cannot stand in for it. */
  placeholder: boolean;
  state: TabState;
  needsInput: boolean;
  reason?: NeedsInputReason;
  /** Live background tasks this conversation owns right now. */
  agents: TabAgents;
  pinned: boolean;
  active: boolean;
  /** How the strip is rendering right now. A non-active tab paints a title, a
   *  pin and a close × in `wide` and none of the three in `dense`, so a density
   *  flip that is not in here repaints nothing — the reconciler would leave
   *  every unchanged node exactly as the previous density built it. */
  density: StripDensity;
  /** This tab opens the unpinned group, and a pinned block precedes it — so it
   *  draws the separator between the two. With nothing pinned there is no
   *  boundary and this is false on every tab. A rendered fact like any other. */
  firstUnpinned: boolean;
  // No `provider` here. The mark is a pure state channel: reusing its one slot
  // for provider identity is the same collision this vocabulary exists to
  // avoid — a filled brand dot and a filled `unread` dot differ only in hue,
  // and `--interactive-accent` is user-configurable. Nothing on the tab paints
  // the provider, so nothing here tracks it.
}

/** Serialize a tab's rendered facts. Pure and total: no field is conditional,
 *  so a value that changes always changes the string. */
export function tabSignature(f: TabFacts): string {
  return [
    f.title,
    f.placeholder ? "ph" : "",
    f.state,
    // Only meaningful while blocked; normalized so a stale reason left on a
    // no-longer-blocked tab cannot keep the signature alive.
    f.needsInput ? (f.reason ?? "?") : "",
    `${f.agents.count}:${f.agents.spinning ? "s" : ""}`,
    f.pinned ? "pin" : "",
    f.active ? "act" : "",
    f.density,
    f.firstUnpinned ? "fu" : "",
  ].join("|");
}
