/**
 * The re-entry surfaces: the "since you left" line and the resume verbs.
 *
 * Both are painted here rather than in `view.ts` for the usual reason — that
 * file is at its size ceiling — but also because neither is transcript
 * behaviour: they are the frame around a transcript you are returning to.
 * Every decision about WHAT they say lives in `core/reentry.ts`; this file owns
 * the elements, where they are inserted, and what a click goes to.
 *
 * Two rules that are structural, not stylistic:
 *
 *  1. **No width gate.** The Recap Rail is main-area-and-wide only, because it
 *     is a second column and a 300px sidebar has no room for one. The re-entry
 *     line is a single row inside the column that already exists, and the user
 *     who most needs it is precisely the sidebar user — so nothing here reads
 *     a width.
 *  2. **The streaming invariant.** While a turn is streaming exactly one of
 *     {working row, open card, caret} is live. Neither surface paints then:
 *     the band returns early, and the verbs are empty by construction
 *     (`resumeVerbs`).
 */
import { setIcon } from "obsidian";
import { clickable } from "./dom";
import type { Convo } from "./convo-types";
import type { ComposerDraft } from "./composer";
import {
  clampReadIndex,
  planReveal,
  readIndexAfterTurn,
  reentrySlots,
  resumeVerbs,
  type ReentrySlotKey,
  type ResumeVerb,
} from "../core/reentry";

const BAND = "mva-reentry";
const VERBS = "mva-resume-verbs";

/** What re-entering needs from the view: where to paint, and the two services
 *  a painted surface calls back into. One object because the band and the
 *  verbs are one moment, and splitting the arguments is how they came to be
 *  wired to two different sets of events. */
export interface ReentryHost {
  containerEl: HTMLElement;
  listWrap: HTMLElement;
  composer: ResumeComposer;
  openNote(path: string): void;
  persist(): void;
}

/**
 * The read position after a turn ENDS, which is the other half of the
 * lifecycle and the one that is easy to forget: a reveal reads the chat you
 * switch to, and this reads the chat you are already looking at.
 *
 * Without it the position only moves on a tab switch, so the next switch back
 * reports as news the twelve steps and three files you sat and watched land —
 * and prints them above the prompt you typed yourself.
 *
 *  - `active`: this is the conversation the view is showing. Its complement is
 *    the existing unread dot, which is the same question asked of the strip.
 *  - `visible`: the pane itself is on screen. A turn that finished while the
 *    Exo pane was behind another Obsidian tab is exactly the work the band
 *    exists to report, so it must NOT count as read.
 *  - `turnFrom`: where the ended turn's own messages start. Watching a turn end
 *    reads that turn and nothing behind it. See `readIndexAfterTurn`, and note
 *    that this is the only writer that could ever move the position over
 *    messages no reveal has rendered.
 */
export function noteTurnEnd(
  c: Convo,
  seen: { active: boolean; visible: boolean; turnFrom: number },
): void {
  if (!seen.active) c.unread = true;
  else if (seen.visible) {
    c.readIndex = readIndexAfterTurn({
      messages: c.messages,
      readIndex: c.readIndex,
      turnFrom: seen.turnFrom,
    });
  }
}

/**
 * The transcript itself was cut down in front of the user: a rewind, or "New
 * session in this tab" clearing it outright.
 *
 * The read position counts messages, so it has to move with them. Leaving a
 * stored 10 over a transcript truncated to 3 is not harmless: every later
 * reveal clamps it to whatever the transcript has grown back to, which is
 * always "caught up", and the chat you created, prompted and walked away from
 * never says a word about what it did.
 *
 * `undefined` stays `undefined`: a conversation nobody ever opened is still one
 * nobody ever opened.
 */
export function noteTranscriptReset(c: Convo): void {
  c.readIndex = clampReadIndex(c.readIndex, c.messages.length);
}

/**
 * Reveal a conversation: paint the "since you left" line at the last-read
 * position, then move the read position to the end.
 *
 * Advancing on reveal is what makes the line dissolve and never come back for
 * the same position — the next reveal computes its work over an empty stretch.
 * A streaming conversation is left completely alone, position included: reading
 * a chat mid-turn must not silently swallow the news of what it did while you
 * were away.
 *
 * `onOpenNote` is the files slot's target. Everything else scrolls inside the
 * transcript, so no other host service is needed. `onRead` fires only when the
 * position actually moved: it is how the caller gets the new number onto disk,
 * and a band that was read in a session that then quit without touching
 * anything else would otherwise come back on the next launch.
 */
export function revealReentry(
  c: Convo,
  onOpenNote: (path: string) => void,
  onRead?: () => void,
): void {
  const decision = planReveal({
    messages: c.messages,
    readIndex: c.readIndex,
    streaming: c.streaming,
  });
  const markRead = (): void => {
    if (decision.readIndex === null || decision.readIndex === c.readIndex) return;
    c.readIndex = decision.readIndex;
    onRead?.();
  };
  if (!decision.band) {
    markRead();
    return;
  }
  const { work, anchor: anchorIndex } = decision.band;

  // Resolved BEFORE anything is painted or marked read. A line that says "since
  // you left" has to sit where you left; a miss used to fall back to appending,
  // which prints the line BELOW every message it describes: a confidently
  // wrong answer to the one question the band exists to answer. The position
  // stays put too: news that was never rendered is still owed.
  const anchor = anchorTurn(c.listEl, anchorIndex);
  if (!anchor) return;

  const band = createDiv({ cls: `${BAND} mva-type-eyebrow` });
  band.createSpan({ cls: "mva-reentry-lede", text: "since you left" });
  for (const slot of reentrySlots(work)) {
    const el = band.createSpan({ cls: "mva-reentry-slot", text: slot.label });
    el.dataset.slot = slot.key;
    if (!slot.populated) {
      // An empty slot renders nothing (`styles.css` hides it): what is fixed is
      // the ORDER, so the second number you read always means files.
      el.addClass("is-empty");
      el.setText("");
      continue;
    }
    el.addClass("is-populated");
    clickable(el, () => {
      // Navigate FIRST: the targets are found relative to the band's position
      // in the transcript, and a detached band is positioned nowhere.
      goToSlot(c, band, slot.key, work.paths, onOpenNote);
      band.remove(); // acted on — the line has done its job
    });
  }

  // The old line goes only now, with its replacement built and its anchor
  // resolved. Removing it up front cost the reader the line they were in the
  // middle of, twice over: a turn that produced only prose grows the transcript
  // without giving the band anything to say, and a missing anchor refuses to
  // paint on purpose. Both used to end with nothing on screen.
  c.listEl.querySelector(`.${BAND}`)?.remove();
  // At the last-read position: immediately before the first turn the user has
  // not seen.
  c.listEl.insertBefore(band, anchor);
  markRead();
}

/**
 * The turn element the band goes above: the one rendering MESSAGE `index`.
 *
 * Deliberately NOT `querySelectorAll(".mva-turn").item(index)`. "One element
 * per message, in message order" holds right up until a turn is stopped before
 * its first token: that turn's element is created when the turn STARTS and
 * keeps the "Stopped." confirmation, but with no segments nothing is pushed to
 * `messages` for it — so from that turn on the DOM carries one more `.mva-turn`
 * than the transcript, permanently. Positional lookup then lands one turn late
 * and prints "since you left · 12 steps" above the prompt the user typed
 * themselves, which is the exact failure `bandAnchor` exists to prevent.
 *
 * Every element that HAS a message carries its index (`data-msg`, stamped in
 * `view.ts` at the two places a message is added). The ones that do not are
 * invisible to this lookup, which is the point.
 */
export function anchorTurn(listEl: HTMLElement, index: number): HTMLElement | null {
  return listEl.querySelector(`.mva-turn[data-msg="${index}"]`);
}

/**
 * The same stamp read the other way: which message a turn element renders, or
 * `null` for one that renders none.
 *
 * The rewind actions hang off a turn element and slice `c.messages` with it, so
 * they need exactly this number. `turns.indexOf(turnEl)` is not it: for the
 * reason above, a phantom turn makes DOM position and message index two
 * different numbers, and slicing with the wrong one truncates the wrong end of
 * the transcript and deletes the element carrying a live `data-msg`.
 */
export function turnMessageIndex(turnEl: HTMLElement | null): number | null {
  const raw = turnEl?.dataset.msg;
  if (raw === undefined) return null;
  const i = Number(raw);
  return Number.isInteger(i) && i >= 0 ? i : null;
}

/**
 * Cut the transcript back at a turn: every LATER turn element goes, and the
 * read position moves onto the messages the caller has just sliced.
 *
 * Only `.mva-turn` elements are removed. `listEl` also hosts the compact
 * divider and the band, and sweeping siblings would detach a node the view
 * still points at.
 */
export function cutTranscriptAfter(c: Convo, turnEl: HTMLElement): void {
  const turns = Array.from(c.listEl.querySelectorAll(".mva-turn"));
  const at = turns.indexOf(turnEl);
  if (at >= 0) for (const el of turns.slice(at + 1)) el.remove();
  noteTranscriptReset(c);
}

/** The same cut, taking the clicked turn with it: the code+conversation rewind
 *  undoes THIS turn's edits too, so its element goes as well. */
export function cutTranscriptFrom(c: Convo, turnEl: HTMLElement): void {
  cutTranscriptAfter(c, turnEl);
  turnEl.remove();
}

/**
 * Re-entry through the PANE, rather than through a change of conversation.
 *
 * `revealReentry`'s other two callers are boot and `switchTo` — and `switchTo`
 * is a change of active chat. But Exo's home is a collapsed right sidebar: you
 * prompt, you collapse it, the agent works twelve steps, and when you come back
 * the active chat never changed. Nothing on that path revealed anything, and
 * `noteTurnEnd` deliberately leaves the position alone for a turn that ended
 * while the pane was hidden — so without this the phase's flagship scenario
 * ended in silence, and the band appeared only if you switched to another chat
 * and back.
 *
 * Two gates, both load-bearing:
 *  - `isShown()`: these are workspace-wide events, and a pane that is still
 *    collapsed has not been re-entered. Boot goes through here for the same
 *    reason: `convo-bridge` materialises the view with `loadIfDeferred()` for
 *    background work, so `restore()` can run against a sidebar nobody opened.
 *  - a band already on screen needs no test of its own. `revealReentry` is
 *    idempotent: with nothing new to say it paints nothing and touches nothing,
 *    and it destroys the old line only once its replacement is built. Asking a
 *    second, cheaper question here is how the two answers came to disagree —
 *    "messages landed" is not "there is news", and a turn of pure prose is both.
 */
export function reenterActive(c: Convo | null | undefined, host: ReentryHost): void {
  if (!c || !host.containerEl.isShown()) return;
  revealReentry(c, (path) => host.openNote(path), () => host.persist());
  // Both halves of the same moment, from one call. They used to be wired to
  // two different event sets: the band answered layout-change, the verbs did
  // not, so the flagship path — collapse the sidebar, come back the next
  // morning — painted the line and no way back in. The verbs are also
  // clock-dependent now, so a chat going cold with the pane open has no other
  // event to wait for.
  renderResumeVerbs(host.listWrap, c, host.composer);
}

/** Where a populated slot goes. Steps are a place in the transcript below the
 *  line; files are a note, which is not in the transcript at all. */
function goToSlot(
  c: Convo,
  band: HTMLElement,
  key: ReentrySlotKey,
  paths: readonly string[],
  onOpenNote: (path: string) => void,
): void {
  if (key === "files") {
    if (paths.length) onOpenNote(paths[0]);
    return;
  }
  const target = findAfter(c.listEl, band, ".mva-steps");
  if (!target) return;
  // A folded run that you were sent to should be open: the click asked to see
  // the steps, not to see where they are.
  target.removeClass("is-collapsed");
  target.scrollIntoView({ block: "center" });
}

/** The first element matching `selector` that sits after `after` in document
 *  order — the unread stretch is below the band, and the same selectors match
 *  plenty of already-read turns above it. */
function findAfter(root: HTMLElement, after: HTMLElement, selector: string): HTMLElement | null {
  const all = Array.from(root.querySelectorAll<HTMLElement>(selector));
  return (
    all.find((el) => (after.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) ??
    null
  );
}

/** What the verbs need from the composer: whether it is empty, and how to put
 *  text into it. Structural so this file never imports the composer class. */
export interface ResumeComposer {
  getDraft(): ComposerDraft;
  insertText(text: string): void;
  focusInput(): void;
}

/**
 * Repaint the resume verbs above the composer for the conversation on screen.
 * Idempotent and cheap: the bar is two or three chips, so it is rebuilt rather
 * than reconciled, and it is removed outright whenever the state offers none.
 *
 * `host` is the composer's own parent (`listWrap`); the bar is inserted before
 * the composer so it reads as a lead-in to the empty input rather than as a
 * footer under the transcript.
 */
/**
 * How long this conversation has been sitting, measured from the last thing the
 * USER said. That is the only message carrying a timestamp, and it is the right
 * clock anyway: the question is how long ago you last spoke to this chat, not
 * how long ago it finished answering itself.
 *
 * `undefined` when the chat is empty, or when it predates 0.14.0 and carries no
 * timestamps at all. Undatable reads as "offer nothing", which is the safe
 * direction: a bar that should not be there is worse than one that is missing.
 */
function idleSince(c: Convo): number | undefined {
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const m = c.messages[i];
    if (m.role === "user" && typeof m.at === "number") return Math.max(0, Date.now() - m.at);
  }
  return undefined;
}

export function renderResumeVerbs(host: HTMLElement, c: Convo, composer: ResumeComposer): void {
  host.querySelector(`.${VERBS}`)?.remove();
  const verbs = resumeVerbs({
    streaming: c.streaming,
    pendingPerm: c.pendingPerm != null,
    pendingAsk: c.pendingAsk != null,
    stopped: c.stopped,
    poisoned: !!c.resumeRisky,
    idleMs: idleSince(c),
  });
  if (!verbs.length) return;

  const bar = createDiv({ cls: `${VERBS} mva-type-eyebrow` });
  for (const verb of verbs) {
    const chip = bar.createSpan({ cls: "mva-resume-verb" });
    setIcon(chip.createSpan({ cls: "mva-resume-verb-ico" }), ICONS[verb.key]);
    chip.createSpan({ text: verb.label });
    clickable(chip, () => runVerb(host, c, composer, verb));
  }
  const composerEl = host.querySelector(".mva-composer");
  if (composerEl) host.insertBefore(bar, composerEl);
  else host.appendChild(bar);

  // The verbs are a fast path INTO an empty composer, so they stand down the
  // moment the user starts writing one of their own. That rule lives HERE and
  // nowhere else: it used to be a `draftEmpty` field in the state too, so a
  // repaint with a half-written draft returned no verbs and deleted the bar,
  // and the keystroke listener then had nothing left to unhide. Standing down
  // is a visibility question, and visibility is a class.
  const input = host.querySelector<HTMLTextAreaElement>(".mva-input");
  if (!input) return;
  syncVerbVisibility(host, input);
  // Bound ONCE per textarea, and it looks the bar up on every keystroke rather
  // than closing over the one that existed when it was bound. This function
  // runs on every state transition; a listener per call would accumulate one
  // per repaint, each holding a bar that was thrown away turns ago.
  if (input.dataset.exoResumeVerbs === "1") return;
  input.dataset.exoResumeVerbs = "1";
  input.addEventListener("input", () => syncVerbVisibility(host, input));
}

function syncVerbVisibility(host: HTMLElement, input: HTMLTextAreaElement): void {
  const bar = host.querySelector(`.${VERBS}`);
  bar?.toggleClass("is-hidden", input.value.trim().length > 0);
}

const ICONS: Record<ResumeVerb["key"], string> = {
  resume: "play",
  "course-correct": "corner-up-right",
  approve: "check",
};

/** Approve settles the open permission where it stands; the message verbs seed
 *  the composer and hand the user the cursor — the verb is a starting point,
 *  not a turn nobody asked for. */
function runVerb(host: HTMLElement, c: Convo, composer: ResumeComposer, verb: ResumeVerb): void {
  if (verb.key === "approve") {
    c.pendingDecision?.allow();
    host.querySelector(`.${VERBS}`)?.remove();
    return;
  }
  if (verb.prompt) composer.insertText(verb.prompt);
  composer.focusInput();
  host.querySelector(`.${VERBS}`)?.remove();
}
