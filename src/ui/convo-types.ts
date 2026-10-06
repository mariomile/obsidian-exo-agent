/**
 * Conversation & turn types — the data model `ChatView` renders.
 *
 * Extracted from `view.ts` (which was 7485 lines and is under a size ratchet,
 * see `tests/size-contract.test.ts`). These are pure type declarations with no
 * behaviour, so moving them costs nothing at runtime and buys two things:
 *
 *  1. It breaks a real import cycle. `ui/composer.ts` needed `Convo` and so did
 *     `import type { Convo } from "../view"` — while `view.ts` imports
 *     `Composer` from it. Every future module that touches a conversation had
 *     the same choice between a cycle and a duplicate shape.
 *  2. It gives the next extraction somewhere to land: a module that owns a
 *     slice of the view can now name `Convo`/`AssistantCtx` without importing
 *     the 7k-line class that happens to declare them.
 *
 * `ToolCard`, `ConvoData` and `AssistantCtx` are exported (they were file-local
 * in view.ts) because the extractions this file exists to enable will need them.
 */

import type { Component } from "obsidian";
import type { AgentSession, ContextUsage, ImageAttachment, ProviderId } from "../providers/types";
import type { Message, PersistedMessage, Segment } from "../core/model";
import type { ResearchModeState } from "../core/research";
import type { SessionLane } from "../core/session-cards";
import type { GoalState } from "../core/goal-loop";
import type { LiveTask } from "../core/live-tasks";
import type { TouchedNote } from "./graph-view";
import type { ComposerDraft } from "./composer";
import type { StepsRun } from "./steps";
import type { ChildReport } from "../core/child-reports";

export interface ToolCard {
  card: HTMLElement;
  statusEl: HTMLElement;
  bodyEl: HTMLElement;
  elapsedEl: HTMLElement;
  startedAt: number;
  /** Live workflow status span — created on the first workflow-progress event
   *  for this card (Workflow launches only). */
  wfEl?: HTMLElement;
}

/* ----- persisted data model (types in ./core/model) ----- */
export interface ConvoData {
  id: string;
  title: string;
  provider: ProviderId;
  model: string;
  sessionId?: string;
  updatedAt?: number;
  usage?: ContextUsage;
  researchMode?: ResearchModeState;
  /** Slug of the agent this conversation is bound to via `/as` (persisted). */
  agent?: string;
  /** True for chats the user archived (persisted to the separate archive store,
   *  never evicted). Absent/false for live chats. */
  archived?: boolean;
  /** Explicit user protection: never a retention cleanup candidate, never
   *  auto-retired from the tab strip. Persisted. */
  pinned?: boolean;
  /** When this conversation left the tab strip (retired or archived). Feeds the
   *  history's "Recently retired" group. Absent = never been in the strip,
   *  or still in it. Persisted. */
  retiredAt?: number;
  /** When this conversation was last the focused tab. The strip's LRU key.
   *  Persisted so the retire order survives a reload: every site that assigns it
   *  (`switchTo`, `setActiveSilently`) schedules a conversation-store write, not
   *  just the settings write that saves the tab set. */
  lastActiveAt?: number;
  /** Manually-assigned Session-Cockpit column (persisted). Absent = default. */
  boardStatus?: SessionLane;
  /** Lifecycle on the chats sidebar (core/thread-lifecycle, from T3 Code):
   *  snooze until a wake time, settle by hand or take back out. Each absent
   *  by default, so every existing conversations.json stays valid. */
  snoozedUntil?: number;
  snoozedAt?: number;
  settledOverride?: "settled" | "active";
  settledAt?: number;
  unsettledAt?: number;
  /** Convo id of the conversation that spawned this one via `spawn_task`.
   *  Denormalized from the ledger's `parent` (which stays the source of truth)
   *  so the sidebar can group without reading tasks.md. Persisted: a child that
   *  loses its parentage on reload would jump out from under its parent and
   *  read as an unexplained chat nobody started. */
  parentConvoId?: string;
  /** Reports from finished children this conversation has not yet handed to its
   *  model. Persisted (capped, see `MAX_PENDING_CHILD_REPORTS`) because it is
   *  the ONLY path by which a delegated conversation's output reaches the
   *  conversation that delegated it: dropping it on reload left the parent
   *  showing unread news it could never deliver. Written only when non-empty. */
  pendingChildReports?: ChildReport[];
  /** The user named this conversation by hand. Both auto-title paths must
   *  respect it. Written only when true; absent reads as false, so every
   *  existing conversations.json stays valid unchanged. Deliberately NOT
   *  `aiTitleApplied`, which answers a different question — that one is retry
   *  policy ("did we already generate one"), this one is ownership. */
  titleLocked?: boolean;
  /** How many messages of this conversation the user has already read — the
   *  per-conversation READ POSITION (see `core/reentry.ts`). Persisted, and
   *  the only new persisted state in the re-entry phase: it is what makes
   *  "since you left" mean anything after a restart. Absent reads as 0
   *  (never read), so every existing conversations.json stays valid. */
  readIndex?: number;
  /** Memory harvest watermark: how many of `messages` the harvest has already
   *  read. Persisted, so a harvest never re-reads a message across reloads and
   *  catch-up after a closed Obsidian starts where it left off. Absent = none
   *  harvested yet (core/memory-harvest). */
  harvestedIndex?: number;
  messages: PersistedMessage[];
}

/**
 * An open permission prompt, as seen from outside the transcript. Two verdicts
 * only — the card's third, "Always allow", writes a standing rule, and granting
 * a standing rule is not something a one-click sidebar row should be able to do
 * — plus the one line that says what a yes covers (`Bash(git)`), so the choice
 * is legible where it is taken.
 */
export interface PermDecision {
  /** The rule line an approval would grant, from `core/permissions`'
   *  `permRuleLine` — never paraphrased by the surface that shows it. */
  rule: string;
  allow: () => void;
  deny: () => void;
}

/** A live task plus its scroll-to target card. The DOM-free `LiveTask` fields
 *  feed the pure core; `cardEl` is view-only. */
export type LiveTaskRecord = LiveTask & { cardEl: HTMLElement };

export interface Convo {
  id: string;
  listEl: HTMLElement;
  title: string;
  sessionId?: string;
  /** True when the user archived this chat: hidden from the board's active
   *  Session-Cockpit lanes and moved to a separate untrimmed store (never
   *  evicted). Persisted. */
  archived?: boolean;
  /** Explicit user protection: never a retention cleanup candidate, never
   *  auto-retired from the tab strip. Persisted. */
  pinned?: boolean;
  /** When this conversation left the tab strip (retired or archived). Feeds the
   *  history's "Recently retired" group. Absent = never been in the strip,
   *  or still in it. Persisted. */
  retiredAt?: number;
  /** When this conversation was last the focused tab. The strip's LRU key.
   *  Persisted so the retire order survives a reload: every site that assigns it
   *  (`switchTo`, `setActiveSilently`) schedules a conversation-store write, not
   *  just the settings write that saves the tab set. */
  lastActiveAt?: number;
  /** Manually-assigned Session-Cockpit column (persisted). When set and the chat
   *  is idle, its card sits here instead of the default review lane; running /
   *  needs-input still auto-override. */
  boardStatus?: SessionLane;
  /** Lifecycle fields, see `ConvoData`. Persisted. */
  snoozedUntil?: number;
  snoozedAt?: number;
  settledOverride?: "settled" | "active";
  settledAt?: number;
  unsettledAt?: number;
  /** Convo id of the conversation that spawned this one via `spawn_task`.
   *  Denormalized from the ledger's `parent` (the source of truth) so the chats
   *  sidebar can indent without reading tasks.md. Persisted. */
  parentConvoId?: string;
  /** Reports from finished child tasks, waiting to be handed to this
   *  conversation's model on its NEXT turn. Persisted (capped): the next turn
   *  can happen after a restart just as easily as before one, and this queue is
   *  the only route a child's output has back to the parent's model. */
  pendingChildReports?: ChildReport[];
  provider: ProviderId;
  model: string;
  allow: Set<string>;
  updatedAt?: number;
  /** Last known context-window usage of this conversation's session — kept
   *  per-convo (and persisted) so tab switches and restarts restore the ring
   *  instead of blanking it until the next turn completes. */
  usage?: ContextUsage;
  messages: Message[];
  // Per-conversation runtime (enables parallel conversations).
  session: AgentSession | null;
  sessionSig: string;
  streaming: boolean;
  /** Reservation flag ONLY, claimed synchronously the instant runTurn is
   *  called (before any await) so a second call on the same convo can't slip
   *  in during the window before `streaming` itself is actually set, several
   *  awaits later. Nothing else should read or branch on it. Runtime-only. */
  turnClaimed?: boolean;
  /** Generation counter pairing with `turnClaimed`. runTurn's own queue-drain
   *  recurses into itself from inside its own finally, releasing then
   *  re-claiming synchronously so the continuation doesn't deadlock on the
   *  reservation the OUTER call still holds. Each claim stamps its own
   *  generation so that outer call's cleanup can tell it no longer owns the
   *  flag and must not clear it out from under the continuation. Runtime-only. */
  turnClaimGen?: number;
  stopped: boolean; // set by stop() so the turn renders as "Stopped", not an error
  /** When the FIRST Stop/Esc of the current turn was requested. Runtime-only —
   *  feeds stopAction's grace window so a second impatient press within a
   *  normal interrupt round-trip doesn't force-dispose a healthy session.
   *  Cleared at the next turn's start (runTurn) alongside `stopped`. */
  stopRequestedAt?: number;
  /** Active `/goal`. In-memory: not persisted across reloads. */
  goal?: GoalState;
  pendingPerm: (() => void) | null; // cancels an open permission card on stop
  pendingAsk: (() => void) | null; // cancels an open ask card on stop
  /** The open permission prompt, reduced to what a surface outside the
   *  transcript needs to settle it — the chats sidebar's inline Allow / Deny.
   *  Has exactly the life of the card (see `setPendingCard`, the one mutation
   *  point that clears it), so no row can hold a live button over a prompt that
   *  is already answered. Runtime-only, never persisted: an unanswered prompt
   *  does not survive a reload — the turn holding it is gone. */
  pendingDecision?: PermDecision | null;
  /** What this conversation is doing RIGHT NOW, as a human phrase ("Searching
   *  the vault") — set on tool-call-start, cleared on result and at turn end,
   *  so it moves per tool call and never per token. Read by the Context rail
   *  for the active chat and by the chats sidebar for every running row.
   *  Runtime-only. */
  activity?: string;
  /** A turn completed on this conversation while it was not the focused tab.
   *  Runtime-only, never persisted (same discipline as `aiTitleAttempts`): after
   *  a reload there is nothing you "have not seen". */
  unread?: boolean;
  queue: {
    text: string;
    images?: ImageAttachment[];
    sendPrefix?: string;
    isRecoveryRetry?: boolean;
    researchMode?: ResearchModeState;
    /** Agent slug bound to this queued message (`@agent` picked before send). */
    agent?: string;
  }[];
  pendingEl: HTMLElement | null; // container for queued-message chips
  /** The in-flight assistant turn of THIS conversation (null when idle) — the
   *  target for its session's ask_user cards, so parallel conversations can't
   *  cross-render into each other's transcripts. */
  currentCtx: AssistantCtx | null;
  /** Live background work this conversation owns RIGHT NOW — subagents, background
   *  Bash, and Workflow agents. Lives on the Convo (NOT the per-turn AssistantCtx)
   *  so it OUTLIVES the turn: keep-alive Level 1. Keyed by tool-call id (subagent/
   *  bash) or Workflow tool_use id. Drives the expandable agents chip. Runtime-only. */
  liveTasks: Map<string, LiveTaskRecord>;
  /** The discreet "Related" section appended below the last turn when the
   *  transcript doesn't fill the viewport (null when not shown). */
  tailSurfaceEl: HTMLElement | null;
  /** True once the proactive ≥75% compaction nudge has been shown for this
   *  conversation — one-shot, so it never re-appears after dismiss or compaction. */
  compactNudged?: boolean;
  /** Unsent composer draft (text + attachments), stashed when the user switches
   *  away so every chat keeps its own composer — runtime-only, never persisted. */
  draft?: ComposerDraft;
  /** Provider-only prefix for the NEXT turn (Codex compact emulation: the
   *  recap that reseeds a fresh session). Consumed once, never UI/persisted. */
  pendingSendPrefix?: string;
  /** Persisted per-conversation Research Mode; never shared across tabs. */
  researchMode: ResearchModeState;
  /** Slug of the agent this whole conversation is bound to (`/as <agent>`).
   *  Persisted. Deliberately does NOT alter `SessionOpts`: the binding is a
   *  provider-only rider that routes the turn to the engine's own subagent, so
   *  it can never desync `sessionSigOf()` or force a session respawn. */
  agent?: string;
  /** Count of AI-title generation attempts fired for this conversation — counts
   *  fires, not successes (a call that times out still consumes one). Feeds
   *  `isAiTitleDue` (core/title.ts), which allows at most 2: one after the first
   *  assistant turn, and — if the title is still not `aiTitleApplied` — one more
   *  after a later turn. Runtime-only (never persisted). */
  aiTitleAttempts?: number;
  /** True once a real AI title has actually landed and been swapped into
   *  `c.title`. The authoritative "no more retries" signal — deliberately a
   *  separate explicit flag rather than inferred by comparing `c.title` against
   *  the shape of a derived placeholder, since a user's own text can
   *  coincidentally look like a finished title. Runtime-only (never persisted). */
  aiTitleApplied?: boolean;
  /** The user named this conversation by hand (`renameConversation`). Both
   *  auto-title paths (`canAutoTitle`, core/title-ownership) must respect it.
   *  Persisted only when true. Deliberately separate from `aiTitleApplied`:
   *  this is ownership, not retry policy — collapsing them would let a failed
   *  generation reopen a user's title. */
  titleLocked?: boolean;
  /** Messages the user has already read — the read position the "since you
   *  left" line is drawn at, and the one thing this phase persists. Moved by
   *  `ui/reentry.ts` `revealReentry` on every reveal, which is also what makes
   *  the line dissolve and never return for the same position. Absent = never
   *  read. Deliberately NOT `unread`, a runtime-only boolean about the tab
   *  strip: this one is a place in a transcript and has to survive a reload. */
  readIndex?: number;
  /** Memory harvest watermark: how many of `messages` the harvest has already
   *  read. Persisted, so a harvest never re-reads a message across reloads and
   *  catch-up after a closed Obsidian starts where it left off. Absent = none
   *  harvested yet (core/memory-harvest). */
  harvestedIndex?: number;
  /** Context inlining (2026-08-12 calibration): path → the file's mtime at the
   *  moment its body was last inlined into an outbound turn of THIS conversation.
   *  A path here whose file still carries the same mtime rides the next turn as a
   *  pointer, not as bytes: the body is already in the cached history. Stamped
   *  only after the send is committed, and runtime-only: a reload loses the
   *  cached history too, so re-inlining once is the correct restart. */
  inlinedNoteMtimes?: Map<string, number>;
  /** Controller for the in-flight AI-title call, so disposing the conversation
   *  (close/delete/reset) aborts it. Runtime-only. */
  titleAbort?: AbortController | null;
  /** Runtime-only (never persisted): set when a turn ended poisoned but its
   *  on-disk sessionId was KEPT for a resume-first recovery. If a turn started
   *  with this true also poisons, recovery escalates to a fresh session + recap
   *  (see runTurn's two-stage recovery). Cleared on any healthy turn. */
  resumeRisky?: boolean;
}

export interface AssistantCtx {
  el: HTMLElement;
  bodyEl: HTMLElement;
  cards: Map<string, ToolCard>;
  segById: Map<string, Segment>;
  segments: Segment[];
  /** Stable across recovery retry because it derives from the persisted user turn. */
  turnId: string;
  curTextEl: HTMLElement | null;
  /** Chars of curRaw already rendered into stable (final) blocks. */
  stableLen: number;
  /** Live tail element re-rendered each tick (holds the not-yet-stable suffix). */
  tailEl: HTMLElement | null;
  /** Owns the tail's current `MarkdownRenderer.render()` call. Scoped per tick
   *  (not the view itself) so the previous tick's render children — e.g. a
   *  post-processor's card mount with a pending async fetch — get a real
   *  `onunload()` before their DOM is wiped, instead of leaking as zombie
   *  subscribers for the life of the view. Unload-then-replace on every tick;
   *  never read outside `renderText`/`resetTextStream`. */
  tailChild: Component | null;
  /** The live streaming caret (at most one per turn), tracked so cleanup is O(1). */
  caretEl: HTMLElement | null;
  /** Turn finalized (flushRender ran). A render tick's caret placement resolves on
   *  a microtask, so a tick in flight when the turn ends could otherwise re-add a
   *  caret AFTER cleanup. This flag is the airtight invariant — no caret may be
   *  placed once true — closing the whole orphaned-caret race class. */
  finalized: boolean;
  /** Incremental block-boundary scan state over curRaw (O(delta) per tick):
   *  chars already scanned (complete lines only) … */
  scanPos: number;
  /** … whether scanPos sits inside a ``` fence … */
  fenceOpen: boolean;
  /** … and the last safe (non-fenced blank-line) boundary found so far. */
  lastBoundary: number;
  curTextSeg: { t: "text"; md: string } | null;
  curRaw: string;
  fullText: string;
  userText: string;
  thinkingEl: HTMLElement | null;
  /** Open steps-timeline run (contiguous thinking + generic tool work). Null
   *  when no run is open; closed (folded to "N steps") when reply text resumes,
   *  an excluded card appears, or the turn ends. */
  stepsRun: StepsRun | null;
  sources: Set<string>;
  touched: TouchedNote[];
  /** Tool-use id → file path, for write tools (to reveal the note on result). */
  writeById: Map<string, string>;
  /** Tool-call ids that touched a note (top-level, non-subagent-nested). Their
   *  live `.mva-tool` row is streaming-only feedback — removed once the turn
   *  settles, since the touched-notes footer then carries the same fact. */
  noteTouchIds: Set<string>;
  /** Tool-call id → owning steps run, so dissolving note rows at turn end can
   *  re-count (or remove) the folded run they live in. */
  runById: Map<string, StepsRun>;
  /** Notes already revealed this turn (dedupe). */
  revealed: Set<string>;
  /** Vault-relative paths that got a preview card this turn (dedupe, first write wins). */
  artifacts: Set<string>;
  /** Vault-relative paths that did NOT exist when first written this turn (newly created). */
  createdPaths: Set<string>;
  convo: Convo;
  /** Per-turn debounce timer, so parallel conversations don't fight over a shared one. */
  renderTimer: number | null;
  /** Live TodoWrite panel for this turn (re-rendered on each update). */
  todosEl: HTMLElement | null;
  /** Background Bash tasks this turn: tool-call id → card + badge + parsed shell id. */
  bgTasks: Map<string, { cardEl: HTMLElement; badgeEl: HTMLElement; shellId?: string }>;
  /** Task (subagent) tool-calls currently in flight (added on start, removed on
   *  result). Drives steps-run folding, which asks "is a subagent still going?" */
  runningTasks: Set<string>;
  /** EVERY live-task id this turn registered on its conversation — subagents,
   *  background Bash, and Workflow runs alike. Distinct from `runningTasks`,
   *  which holds subagents only and is emptied as each result lands: this one
   *  is append-only for the life of the turn, because it answers a different
   *  question — "what did I put on the convo that I now have to settle?".
   *  Without it, turn end could only reach subagents, so a Bash or Workflow
   *  killed by Stop span in the agent badge forever. */
  liveTaskIds: Set<string>;
  /** Task (subagent) cards this turn: Task tool-call id → nested activity section. */
  taskCards: Map<string, { container: HTMLElement; summaryEl: HTMLElement; rowsEl: HTMLElement; count: number }>;
  /** Subagent mini-rows this turn (live-only): tool-call id → status dot + parent. */
  nestedRows: Map<string, { dotEl: HTMLElement; parentId: string }>;
  /** Working-indicator row (Feature 1) — star + phase label + elapsed + esc hint.
   *  Always re-appended as the last child of bodyEl so it trails the transcript. */
  workingEl: HTMLElement | null;
  workingLabel: HTMLElement | null;
  workingElapsed: HTMLElement | null;
  /** Interactive cards (permission / ask_user / plan) currently awaiting the
   *  user. While > 0 the card IS the feedback, so the working row hides. */
  openCards: number;
  /** A text segment is actively streaming — the caret is the live feedback, so
   *  the working row hides. Reset when the segment ends (thinking, tool, turn). */
  textStreaming: boolean;
  /** System-notification dedupe keys fired this turn (Feature 3): "done" | "waiting" | "error". */
  notified: Set<string>;
}
