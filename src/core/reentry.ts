/**
 * Re-entry — the pure model behind "coming back to a chat is a designed
 * moment". Two things live here and nothing else: what a conversation did
 * WHILE YOU WERE NOT READING IT, and which verb should be on offer above an
 * empty composer given the state you are coming back to.
 *
 * The read position is the one new persisted fact in this phase, and it is
 * deliberately an INDEX, not a timestamp: the band has to be rendered AT a
 * position in the transcript, and a transcript is a list of messages, not a
 * clock. `readIndex` counts messages the user has already seen, so it is also
 * the DOM index of the first unread turn — one number that answers both "what
 * is new" and "where does the line go".
 *
 * "Seen" is the whole contract, and it has two halves: a reveal reads
 * everything on screen (`planReveal`), and a turn that FINISHES in front of
 * you is read as it lands (`ui/reentry`'s `noteTurnEnd`). Without the second
 * half the number only ever moves when you switch tabs, and the line ends up
 * reporting twelve steps you sat and watched.
 *
 * Everything here is Obsidian-free and DOM-free, same discipline as
 * `chat-rows.ts`: this decides what the line SAYS and whether it may appear,
 * `ui/reentry.ts` owns the elements and the click targets.
 */
import type { Message } from "./model";
import { fileEditKey } from "./steps";

/**
 * The slots of the "since you left" line, in the ONE order they are ever
 * painted in. Fixed by position is the whole design: the line is read at a
 * glance on re-entry, and a line whose second number means "files" on Monday
 * and something else on Tuesday has to be read word by word instead.
 *
 * There is no "questions waiting" slot, and there deliberately cannot be one.
 * An `ask` or `plan` card reaches `messages` only when its TURN ends, and that
 * teardown cancels whatever card was still open. So every unanswered card in a
 * transcript is a cancelled one, and the slot could only ever point at a dead
 * surface. While a card is genuinely open the conversation is streaming and the
 * band refuses to paint at all (the streaming invariant); a pending permission
 * is not a segment in the first place. A slot that can only count what the user
 * cannot answer is a slot that lies.
 */
export const REENTRY_SLOTS = ["steps", "files"] as const;

export type ReentrySlotKey = (typeof REENTRY_SLOTS)[number];

/** What the unread stretch of a conversation contains. */
export interface ReentryWork {
  /** Tool calls in the unread assistant turns — the "12 steps" number. */
  steps: number;
  /** Distinct files the unread stretch WROTE (via `fileEditKey`, the same
   *  write-classification the steps header counts with). */
  files: number;
  /** The written paths, first-seen order. The files slot's click target: a
   *  number you cannot open is a number you have to go looking for. */
  paths: string[];
}

/** One painted slot. `count === 0` slots are still returned — they hold their
 *  position — but they are not populated, so they are not clickable. */
export interface ReentrySlot {
  key: ReentrySlotKey;
  count: number;
  /** "12 steps" / "3 files changed". */
  label: string;
  populated: boolean;
}

const EMPTY_WORK: ReentryWork = { steps: 0, files: 0, paths: [] };

/**
 * What happened in `messages` after the first `readIndex` of them. A
 * `readIndex` past the end (a conversation that was rewound since it was last
 * read) reports nothing rather than counting backwards.
 */
export function workSince(messages: readonly Message[], readIndex: number): ReentryWork {
  const from = Math.max(0, Math.min(readIndex, messages.length));
  if (from >= messages.length) return { ...EMPTY_WORK };
  let steps = 0;
  const paths: string[] = [];
  for (const m of messages.slice(from)) {
    if (m.role !== "assistant") continue;
    for (const seg of m.segments) {
      if (seg.t !== "tool") continue;
      steps++;
      const key = fileEditKey(seg.name, seg.input);
      if (key && !paths.includes(key)) paths.push(key);
    }
  }
  return { steps, files: paths.length, paths };
}

/** Is there anything to report at all? An unread stretch of pure prose — the
 *  agent answered and did no work — is news the transcript already carries. */
export function hasReentryNews(work: ReentryWork): boolean {
  return work.steps > 0 || work.files > 0;
}

/** "1 file", "2 files": English count plus noun. */
export const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Every slot, always all of them, always in `REENTRY_SLOTS` order. */
export function reentrySlots(work: ReentryWork): ReentrySlot[] {
  const counts: Record<ReentrySlotKey, number> = {
    steps: work.steps,
    files: work.files,
  };
  const labels: Record<ReentrySlotKey, string> = {
    steps: plural(work.steps, "step"),
    files: `${plural(work.files, "file")} changed`,
  };
  return REENTRY_SLOTS.map((key) => ({
    key,
    count: counts[key],
    label: labels[key],
    populated: counts[key] > 0,
  }));
}

/** The whole line as one string: "since you left · 12 steps · 3 files
 *  changed". Empty slots are omitted from the TEXT (they still
 *  hold their position in the rendered row — see `reentrySlots`). */
export function reentryLine(work: ReentryWork): string {
  const parts = reentrySlots(work)
    .filter((s) => s.populated)
    .map((s) => s.label);
  return parts.length ? ["since you left", ...parts].join(" · ") : "";
}

/**
 * May the band be rendered right now?
 *
 *  - Never while a turn is streaming. THE STREAMING INVARIANT: exactly one of
 *    {working row, open card, caret} is the live surface, and a band that
 *    appeared mid-stream would be a second one.
 *  - Never past the end of the transcript: the position has caught up and
 *    there is nothing between it and the last turn.
 *  - Never when there is nothing to report.
 *
 * Position 0 is a POSITION, not an absence: a chat you opened while it was
 * empty and left to work has read nothing and everything is news. "Never
 * opened" is the ABSENT position, and it is `planReveal` that turns it away —
 * this predicate is only ever asked about a position that exists.
 */
export function shouldRenderReentry(o: {
  streaming: boolean;
  readIndex: number;
  total: number;
  work: ReentryWork;
}): boolean {
  if (o.streaming) return false;
  if (o.readIndex < 0 || o.readIndex >= o.total) return false;
  return hasReentryNews(o.work);
}

/** The read position after a read: everything currently in the transcript.
 *  Advancing is what makes the band dissolve and never come back for the same
 *  position — the next reveal computes its work over an empty stretch. */
export function advanceReadIndex(total: number): number {
  return Math.max(0, total);
}

/**
 * The read position after a turn ENDED in front of you. Watching a turn land
 * reads THAT turn, and only that turn.
 *
 * `turnFrom` is where the ended turn's own messages start. Anything before it
 * is a stretch this moment says nothing about: the ordinary way back into Exo
 * is opening the sidebar mid-run, and a reveal mid-stream deliberately leaves
 * the position alone so the news survives. Jumping to the end 30 seconds later,
 * because the turn happened to finish while you were looking, would mark as
 * read a stretch no reveal ever rendered: the one way this number can move
 * over messages nobody ever saw.
 *
 * An unread stretch of pure prose is not held onto: the band would never
 * mention it, so waiting for a line that cannot come only strands the number.
 */
export function readIndexAfterTurn(o: {
  messages: readonly Message[];
  readIndex: number | undefined;
  turnFrom: number;
}): number {
  const total = o.messages.length;
  const stored = clampReadIndex(o.readIndex, total);
  if (stored === undefined || stored >= o.turnFrom) return advanceReadIndex(total);
  const owed = workSince(o.messages.slice(0, Math.max(0, o.turnFrom)), stored);
  return hasReentryNews(owed) ? stored : advanceReadIndex(total);
}


/**
 * Where the line goes: the last-read position, moved past any messages the
 * user wrote there. A prompt you typed is one you have seen, so the band
 * belongs UNDER it — otherwise a chat you kicked off and walked away from
 * prints "since you left · 12 steps" above your own words.
 */
export function bandAnchor(messages: readonly Message[], readIndex: number): number {
  let i = Math.max(0, Math.min(readIndex, messages.length));
  while (i < messages.length && messages[i].role === "user") i++;
  return i;
}

/** What one reveal does: where the read position lands, and whether a band is
 *  painted on the way. `readIndex: null` means leave the position alone — a
 *  conversation revealed mid-stream is not a conversation you have read. */
export interface RevealDecision {
  readIndex: number | null;
  band: { work: ReentryWork; anchor: number } | null;
}

/**
 * The whole reveal, decided in one place and with no DOM in sight: what the
 * band says, where it goes, and where the read position ends up. `ui/reentry`
 * only applies this, so the lifecycle of the one persisted number in this
 * phase is testable as a SEQUENCE — reveal, work, reveal again — rather than
 * as three functions that happen to be called in the right order.
 */
export function planReveal(o: {
  messages: readonly Message[];
  readIndex: number | undefined;
  streaming: boolean;
}): RevealDecision {
  const total = o.messages.length;
  // Reading a chat mid-turn must not silently swallow the news of what it did
  // while you were away, so the position is left exactly where it was.
  if (o.streaming) return { readIndex: null, band: null };
  const stored = clampReadIndex(o.readIndex, total);
  const next = advanceReadIndex(total);
  // Never opened: there is no "left" to be since.
  if (stored === undefined) return { readIndex: next, band: null };
  const work = workSince(o.messages, stored);
  if (!shouldRenderReentry({ streaming: false, readIndex: stored, total, work })) {
    return { readIndex: next, band: null };
  }
  return { readIndex: next, band: { work, anchor: bandAnchor(o.messages, stored) } };
}

/** A stored read position, clamped to a transcript that may have shrunk (a
 *  rewind) or grown since it was written. `undefined` — no stored value at
 *  all — stays `undefined`: a conversation that has never been opened is a
 *  different fact from one opened at position 0, and only the second one can
 *  ever have a "since you left". */
export function clampReadIndex(stored: number | undefined, total: number): number | undefined {
  if (typeof stored !== "number" || !Number.isFinite(stored)) return undefined;
  return Math.max(0, Math.min(Math.floor(stored), total));
}

/* -------------------------- resume verbs ---------------------------- */

export type ResumeVerbKey = "resume" | "course-correct" | "approve";

export interface ResumeVerb {
  key: ResumeVerbKey;
  label: string;
  /** Text to seed the composer with. Absent on `approve`, which is not a
   *  message: it settles the open permission prompt directly. */
  prompt?: string;
}

/** The state a conversation is being re-entered in. */
export interface ResumeState {
  streaming: boolean;
  pendingPerm: boolean;
  pendingAsk: boolean;
  stopped: boolean;
  poisoned: boolean;
  /** Milliseconds since the last message landed. `undefined` when there is no
   *  last message, or it carries no timestamp: an empty chat has nothing to
   *  resume, which is a different fact from having been idle forever. */
  idleMs: number | undefined;
}

/** How long a settled chat has to sit untouched before a way back in beats no
 *  chrome at all. Twelve hours, so it takes a night or a full working day to
 *  cross: a chat you left after lunch is still in your head at 4pm and does
 *  not need a button telling you to continue it. */
export const RESUME_STALE_MS = 12 * 60 * 60 * 1000;

const RESUME: ResumeVerb = {
  key: "resume",
  label: "Resume",
  prompt: "Continue from where we left off.",
};
const RESUME_AFTER_STOP: ResumeVerb = {
  key: "resume",
  label: "Resume",
  prompt: "Pick this back up and continue.",
};
const COURSE_CORRECT: ResumeVerb = {
  key: "course-correct",
  label: "Course-correct",
  prompt: "Change of direction: ",
};
const APPROVE: ResumeVerb = { key: "approve", label: "Approve" };

/**
 * Which verbs to offer, contextual to the state:
 *
 *  - blocked on a permission → Approve, and nothing else. The chat cannot
 *    move on a message; it moves on a verdict.
 *  - streaming, or blocked on a question → nothing. The live surface is the
 *    card or the caret, and a verb bar under it would be a second one.
 *  - stopped or errored → Resume (worded as picking it back up) +
 *    Course-correct. This is the state the verbs are for: a run was cut off
 *    mid-course, so both picking it up and redirecting it are live.
 *  - settled and cold → Resume alone. Nothing is in flight to correct, and by
 *    then the useful offer is a way in that is not re-reading the transcript.
 *  - settled and recent, or empty → nothing. "Has a history" is not a state,
 *    it is the condition of every chat you have ever opened; a bar that shows
 *    there is chrome under the composer, not an affordance. If the chat is
 *    still in your head, the composer is already the fast path.
 */
export function resumeVerbs(s: ResumeState): ResumeVerb[] {
  if (s.pendingPerm) return [APPROVE];
  if (s.streaming || s.pendingAsk) return [];
  if (s.idleMs === undefined) return [];
  if (s.stopped || s.poisoned) return [RESUME_AFTER_STOP, COURSE_CORRECT];
  return s.idleMs >= RESUME_STALE_MS ? [RESUME] : [];
}
