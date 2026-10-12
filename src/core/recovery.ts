/**
 * Session-recovery pure logic — extracted verbatim from `view.ts`.
 */
import type { Message, Segment } from "./model";
import { planRecapLabel } from "./plan";
import { isCliAuthFailure, isEndedSessionFailure } from "./errors";

/**
 * True when an error message signals a *recoverable* session death — the kind
 * the two-stage resume/fresh+recap machine can heal, as opposed to a generic
 * API/usage error that should just surface.
 *
 * Matches (case-insensitive): an expired / missing / invalid session, a crashed
 * CLI process ("process exited with code …"), a failed/errored resume attempt,
 * and a `view-unload` disposal (the plugin was reloaded mid-turn — see
 * `dropSession(c, "view-unload")` in view.ts's `onClose()`; it is the only
 * dispose reason that can race a live `send()`, since every other reason fires
 * from an explicit user action that only runs when nothing is streaming). A
 * plain API error (e.g. "API error 400: bad request") must NOT match.
 */
export function isRecoverableSessionError(msg: string): boolean {
  const m = (msg || "").toLowerCase();
  // "OAuth session expired" is a dead login, not a dead session.
  if (isCliAuthFailure(m)) return false;
  if (/session expired|session not found|invalid session|session invalid|process exited with code/.test(m)) {
    return true;
  }
  if (isEndedSessionFailure(m)) return true;
  if (/session disposed \(view-unload\)/.test(m)) return true;
  // A resume that itself failed/errored is recoverable (escalates to fresh+recap).
  if (m.includes("resume") && (m.includes("failed") || m.includes("error"))) return true;
  return false;
}

/**
 * Persist one terminal error per assistant turn. Providers can report the same
 * failure more than once (for example, an error JSONL item followed by a
 * non-zero process close). Keeping the first error makes both the persisted
 * transcript and the live warning idempotent. Explicit presentation flags keep
 * the error card (which owns Retry) and the recovery footer on the same
 * first-signal-only decision.
 */
export type TurnErrorDecision = {
  showErrorCard: boolean;
  showRecoveryFooter: boolean;
};

export function recordTurnError(segments: Segment[], message: string): TurnErrorDecision {
  if (segments.some((segment) => segment.t === "error")) {
    return { showErrorCard: false, showRecoveryFooter: false };
  }
  segments.push({ t: "error", message });
  return { showErrorCard: true, showRecoveryFooter: true };
}

/**
 * Inputs to the two-stage session-recovery reducer, read straight off the turn.
 * `poisoned` — an in-band error_during_execution or a thrown recoverable session
 * error marked the live session dead. `stopped` — the user pressed Stop.
 * `isRecoveryRetry` — this turn was itself the stage-2 recap retry. `resumeRisky`
 * — a prior crash already put the convo on the resume-first ladder.
 */
export type RecoveryInput = {
  poisoned: boolean;
  stopped: boolean;
  isRecoveryRetry: boolean;
  resumeRisky: boolean;
  /** The turn failed because the CLI has no usable login (see `isCliAuthFailure`). */
  authFailed?: boolean;
};

/**
 * The decision, single-sourced so the four call sites in view.ts (in-band error,
 * catch path, finally ladder, footer text) can never drift apart again.
 *
 * `footer` — exact text rendered under a poisoned turn (null ⇒ no recovery footer).
 * `session` — how to treat the live session at turn end: "none" (leave it),
 * "drop-keep-id" (drop the crashed live object but keep the sessionId so the next
 * message resumes the transcript), "drop-clear-id" (nuclear — drop everything,
 * next message is fresh). `nextResumeRisky` — the value to assign to the convo's
 * resumeRisky flag. `enqueueRecapRetry` — stage-2 only: auto-retry the same user
 * message once with a private recap threaded to the provider.
 */
export type RecoveryPlan = {
  footer: string | null;
  session: "none" | "drop-keep-id" | "drop-clear-id";
  nextResumeRisky: boolean;
  enqueueRecapRetry: boolean;
};

/**
 * Pure reducer for the two-stage (resume-first → fresh+recap → nuclear) session
 * recovery. Mirrors the original hand-synchronized logic in `view.ts` exactly:
 *
 * - `poisoned && !stopped` enters the ladder:
 *   - `isRecoveryRetry` → nuclear reset (drop + clear id, footer promises a fresh
 *     session next message).
 *   - else `resumeRisky` → stage 2: fresh + clear id + enqueue a recap retry.
 *   - else → stage 1: drop the live object but KEEP the id (next message resumes),
 *     arm resumeRisky so a second consecutive poison escalates.
 * - `!poisoned` → healthy/user-stopped-without-poison turn: clear resumeRisky so a
 *   future isolated crash starts from stage 1. No session action, no footer.
 * - `poisoned && stopped` → the ladder is NOT entered (gated `poisoned && !stopped`
 *   in the original); resumeRisky is left as-is. No session action, no footer.
 */
export function resolveRecovery(s: RecoveryInput): RecoveryPlan {
  const { poisoned, stopped, isRecoveryRetry, resumeRisky, authFailed } = s;
  if (authFailed && !stopped) {
    // A dead login is not a crashed session: resuming, recapping or wiping the
    // id cannot heal it, and every attempt fails the same way. Drop the live
    // process so the next message spawns one that reads the new login, keep the
    // id so it resumes this conversation, and leave the ladder disarmed.
    return { footer: null, session: "drop-keep-id", nextResumeRisky: false, enqueueRecapRetry: false };
  }
  if (poisoned && !stopped) {
    if (isRecoveryRetry) {
      // The stage-2 recap retry itself poisoned — nuclear reset (loop guard).
      return {
        footer: "The next message starts a fresh session.",
        session: "drop-clear-id",
        nextResumeRisky: false,
        enqueueRecapRetry: false,
      };
    }
    if (resumeRisky) {
      // Stage 2: a prior resume re-errored — go fully fresh AND auto-retry with a recap.
      return {
        footer: "Resume failed — restarting fresh with a recap of this conversation.",
        session: "drop-clear-id",
        nextResumeRisky: false,
        enqueueRecapRetry: true,
      };
    }
    // Stage 1 (resume-first): drop the live object, keep the id, arm the ladder.
    return {
      footer: "Session process crashed — your next message resumes it.",
      session: "drop-keep-id",
      nextResumeRisky: true,
      enqueueRecapRetry: false,
    };
  }
  if (!poisoned) {
    // Healthy (or user-stopped without a poison) — reset the recovery ladder.
    return { footer: null, session: "none", nextResumeRisky: false, enqueueRecapRetry: false };
  }
  // poisoned && stopped — ladder not entered; resumeRisky untouched.
  return { footer: null, session: "none", nextResumeRisky: resumeRisky, enqueueRecapRetry: false };
}

/** Build a compact plaintext recap of the recent transcript, used to re-seed a
 *  FRESH session after a resume also failed (Stage 2 recovery). Threaded to the
 *  provider only — never rendered, queued, or persisted. Takes the last ≤8
 *  entries: user messages truncated to 400 chars, assistant messages as their
 *  concatenated text (≤600 chars) with tool activity summarized as [N tool
 *  calls]. The whole recap is capped at ~5000 chars, dropping oldest first. */
export function buildRecap(messages: Message[]): string {
  const lines: string[] = [];
  for (const m of messages.slice(-8)) {
    if (m.role === "user") {
      lines.push(`[user] ${m.text.slice(0, 400)}`);
    } else {
      let toolCount = 0;
      const texts: string[] = [];
      const planTags: string[] = [];
      for (const seg of m.segments) {
        if (seg.t === "text") texts.push(seg.md);
        else if (seg.t === "tool") toolCount++;
        else if (seg.t === "plan") planTags.push(planRecapLabel(seg.approved));
      }
      let body = texts.join("").slice(0, 600);
      if (toolCount > 0) body += (body ? " " : "") + `[${toolCount} tool calls]`;
      if (planTags.length) body += (body ? " " : "") + planTags.join(" ");
      lines.push(`[assistant] ${body}`);
    }
  }
  // Cap the body at ~5000 chars, dropping the oldest lines first.
  let body = lines.join("\n");
  while (body.length > 5000 && lines.length > 1) {
    lines.shift();
    body = lines.join("\n");
  }
  return (
    "<conversation-recap>\n" +
    "The previous session is not available in this process (it may have crashed, " +
    "been stopped, or the app restarted); this fresh session continues an ongoing " +
    "conversation. Recent transcript (oldest first):\n" +
    body +
    "\n</conversation-recap>"
  );
}

/**
 * Whether a turn about to be sent must seed its session with a {@link buildRecap}
 * of the transcript. True only for a COLD spawn (no resumable session) that is
 * continuing a conversation with real history — the case where the CLI process
 * starts on an empty transcript and a "continua/riprendi" would otherwise forage
 * the vault instead of continuing the thread. Skipped when a stage-2 recap prefix
 * is already threaded (never double-seed) and on a convo's first turn (no
 * prior persisted message yet). Generalizes the stage-2-only recap to close every
 * cold-start hole (poisoned-and-stopped, nuclear reset, post-crash fresh process).
 *
 * `hasResumableSession` asks whether the session still EXISTS, not merely whether
 * the convo remembers an id. The CLI expires its session files, so an id can
 * outlive the session it names: the resume then lands on nothing and the model
 * starts blind while the whole transcript sits on screen. Holding an id is not
 * holding context — only a session that is actually there suppresses the recap.
 */
export function shouldColdReseed(s: {
  hasResumableSession: boolean;
  hasRecapPrefix: boolean;
  hasPriorHistory: boolean;
}): boolean {
  return !s.hasResumableSession && !s.hasRecapPrefix && s.hasPriorHistory;
}

/** How long a first interrupt gets to settle the turn on its own before a
 *  second Stop/Esc is trusted as evidence of a stuck session rather than plain
 *  impatience. Below this, `q.interrupt()`'s round-trip (CLI process, not a
 *  local call) has not had a fair chance to land yet. */
export const STOP_ESCALATION_GRACE_MS = 1500;

/**
 * What a Stop press should do, given whether this turn was already stopped
 * and how long ago that first stop was requested.
 *
 * First press → `interrupt` (graceful; the CLI session survives — Claude Code
 * parity). A second press within `STOP_ESCALATION_GRACE_MS` of the first is
 * still `interrupt` — the round-trip hasn't had a fair chance to land, so
 * force-disposing here would kill a turn that was about to end cleanly on its
 * own (the exact "accidental Esc silently kills work" class of incident this
 * file has already seen once — see `stop()` in view.ts). Only a press AFTER
 * the grace window escalates to `dispose`, which rejects the parked send() so
 * the turn closes and the composer unblocks. User-driven successor to the
 * removed TurnWatchdog's rescue role.
 */
export function stopAction(alreadyStopped: boolean, msSinceFirstStop: number): "interrupt" | "dispose" {
  if (!alreadyStopped) return "interrupt";
  return msSinceFirstStop >= STOP_ESCALATION_GRACE_MS ? "dispose" : "interrupt";
}
