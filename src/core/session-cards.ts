/**
 * Session-cards — the pure lane model behind the Chats sidebar. UI-free and
 * Obsidian-free so it's unit-testable in isolation (same discipline as
 * `persistence.ts` / `recap.ts`): `chat-rows.ts` feeds `SessionSnapshot`s in and
 * this decides the lane and badge.
 *
 * Lane model: running / needs-input are AUTO-derived from runtime state (you
 * always see what needs attention); otherwise the chat is idle, in `review`. A
 * stopped/error badge is independent of the lane.
 */

/** Lane of a live chat. `running`/`needs-input` are auto-derived from runtime;
 *  `review` is an idle chat that has a turn. */
export type SessionLane = "running" | "needs-input" | "review";

/** Why a chat is in `needs-input`. */
export type NeedsInputReason = "perm" | "ask";

/** A non-lane annotation shown on an idle chat: the last turn was user-stopped or
 *  it errored/poisoned. Independent of the lane. */
export type SessionBadge = "stopped" | "error";

/**
 * The raw per-convo signals read off a live `Convo`. The lane is NOT
 * pre-computed here — `deriveLane` owns the precedence so the streaming+pending
 * coexistence rule lives in ONE tested place.
 */
export interface SessionSnapshot {
  id: string;
  title: string;
  /** A turn is in flight. NOTE: stays true while a permission/ask prompt is
   *  pending mid-turn — which is exactly why pending is checked before it. */
  streaming: boolean;
  pendingPerm: boolean;
  pendingAsk: boolean;
  /** The convo's last turn errored (adapter/poisoned). */
  poisoned: boolean;
  /** The user stopped the last turn (Esc / Stop). */
  stopped: boolean;
  hasMessages: boolean;
  archived: boolean;
  updatedAt?: number;
}

/** `deriveLane`'s result — `lane` is `"idle"` when no row should be rendered. */
export interface DerivedLane {
  lane: SessionLane | "idle";
  reason?: NeedsInputReason;
  badge?: SessionBadge;
}

/**
 * Map a convo's raw signals to a lane. Precedence is the correctness core:
 *
 *   1. `pendingPerm` / `pendingAsk` → needs-input. This MUST precede `streaming`
 *      because a convo blocked on a permission prompt is still `streaming:true`
 *      (the turn's `finally` hasn't run) — checking streaming first would
 *      mislabel "waiting for you" as Running, defeating the whole cockpit.
 *   2. `streaming` → running. (1) and (2) are the AUTO lanes: they always win, so
 *      a chat that starts working jumps into view.
 *   3. Otherwise the chat is idle (`review`), with an independent stopped/error
 *      badge. `stopped` wins over `poisoned` (a user-stopped turn reads as a
 *      stop, not an error). Empty "New chat" husks (no messages) are `idle`
 *      and produce no row.
 */
export function deriveLane(s: SessionSnapshot): DerivedLane {
  if (s.pendingPerm) return { lane: "needs-input", reason: "perm" };
  if (s.pendingAsk) return { lane: "needs-input", reason: "ask" };
  if (s.streaming) return { lane: "running" };
  if (!s.hasMessages) return { lane: "idle" };
  const badge: SessionBadge | undefined = s.stopped ? "stopped" : s.poisoned ? "error" : undefined;
  return badge ? { lane: "review", badge } : { lane: "review" };
}
