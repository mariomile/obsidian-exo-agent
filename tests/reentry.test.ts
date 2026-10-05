import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REENTRY_SLOTS,
  RESUME_STALE_MS,
  advanceReadIndex,
  bandAnchor,
  clampReadIndex,
  hasReentryNews,
  planReveal,
  readIndexAfterTurn,
  reentryLine,
  reentrySlots,
  resumeVerbs,
  shouldRenderReentry,
  workSince,
  type ResumeState,
} from "../src/core/reentry";
import {
  anchorTurn,
  cutTranscriptAfter,
  cutTranscriptFrom,
  noteTranscriptReset,
  noteTurnEnd,
  reenterActive,
  type ReentryHost,
  type ResumeComposer,
  renderResumeVerbs,
  revealReentry,
  turnMessageIndex,
} from "../src/ui/reentry";
import type { Convo } from "../src/ui/convo-types";
import type { Message } from "../src/core/model";
import type { ComposerDraft } from "../src/ui/composer";

/**
 * Phase 6, the re-entry system. Four behaviours are under test here: the
 * read-position lifecycle (the one new persisted fact), what the fixed-slot
 * line says, where the band lands in a transcript, and the verbs offered above
 * an empty composer.
 */

const user = (text: string): Message => ({ role: "user", text });
const tool = (name: string, input: unknown): Message => ({
  role: "assistant",
  segments: [{ t: "tool", name, input, ok: true, output: "" }],
});
const answered = (): Message => ({
  role: "assistant",
  segments: [{ t: "ask", questions: [], answers: { q: "yes" } }],
});
const unanswered = (): Message => ({
  role: "assistant",
  segments: [{ t: "ask", questions: [], answers: {} }],
});

describe("the read position", () => {
  it("advances to the whole transcript once read", () => {
    expect(advanceReadIndex(0)).toBe(0);
    expect(advanceReadIndex(7)).toBe(7);
  });

  it("keeps 'never opened' distinct from 'opened at position 0'", () => {
    // Every conversation that existed before this phase has no stored value.
    // Absent is NOT 0: 0 is a chat you opened while it was empty, and that one
    // has a real "since you left" the moment it works without you.
    expect(clampReadIndex(undefined, 5)).toBeUndefined();
    expect(clampReadIndex(Number.NaN, 5)).toBeUndefined();
    expect(clampReadIndex(0, 5)).toBe(0);
  });

  it("clamps a stored position to a transcript that shrank (a rewind)", () => {
    expect(clampReadIndex(9, 4)).toBe(4);
    expect(clampReadIndex(-3, 4)).toBe(0);
    expect(clampReadIndex(2, 4)).toBe(2);
  });

  it("reports nothing once the position has caught up — the line cannot return", () => {
    const messages = [user("a"), tool("Write", { file_path: "/v/a.md" })];
    const first = workSince(messages, 1);
    expect(hasReentryNews(first)).toBe(true);
    // Reading advances the position; the same position asked again is empty.
    const after = workSince(messages, advanceReadIndex(messages.length));
    expect(hasReentryNews(after)).toBe(false);
    expect(after).toEqual({ steps: 0, files: 0, paths: [] });
  });
});

describe("what the unread stretch contains", () => {
  const messages: Message[] = [
    user("go"),
    tool("Read", { file_path: "/v/seen.md" }),
    user("carry on"),
    tool("Write", { file_path: "/v/a.md" }),
    tool("Edit", { file_path: "/v/a.md" }),
    tool("Bash", { command: "ls" }),
    tool("Write", { file_path: "/v/b.md" }),
  ];

  it("counts only what happened after the read position", () => {
    const work = workSince(messages, 2);
    expect(work.steps).toBe(4); // the four tool calls after the position, none before
    expect(work.files).toBe(2); // a.md written twice counts once, b.md once
    expect(work.paths).toEqual(["/v/a.md", "/v/b.md"]);
  });

  it("counts reads as steps but never as files changed", () => {
    const work = workSince([user("x"), tool("Read", { file_path: "/v/n.md" })], 1);
    expect(work.steps).toBe(1);
    expect(work.files).toBe(0);
  });

  it("never reports a card as a question waiting: a persisted card is a dead one", () => {
    // A `plan` or `ask` segment only reaches `messages` when its TURN ends, and
    // that teardown cancels whatever card was still open. So an unanswered ask
    // in a transcript is a cancelled ask and an `approved: null` plan is a
    // cancelled plan: neither can be answered any more. While one is genuinely
    // open the conversation is streaming, and the band refuses to paint at all.
    const plan: Message = {
      role: "assistant",
      segments: [{ t: "plan", md: "do this", approved: null }],
    };
    expect(hasReentryNews(workSince([user("x"), unanswered()], 1))).toBe(false);
    expect(hasReentryNews(workSince([user("x"), answered()], 1))).toBe(false);
    expect(hasReentryNews(workSince([user("x"), plan], 1))).toBe(false);
  });
});

describe("the fixed-slot line", () => {
  it("keeps the two slots in one order, populated or not", () => {
    expect([...REENTRY_SLOTS]).toEqual(["steps", "files"]);
    const slots = reentrySlots({ steps: 0, files: 3, paths: ["a", "b", "c"] });
    expect(slots.map((s) => s.key)).toEqual(["steps", "files"]);
    expect(slots.map((s) => s.populated)).toEqual([false, true]);
  });

  it("says what the plan says it says", () => {
    const line = reentryLine({ steps: 12, files: 3, paths: ["a", "b", "c"] });
    expect(line).toBe("since you left · 12 steps · 3 files changed");
  });

  it("singularizes each slot on its own", () => {
    const line = reentryLine({ steps: 1, files: 1, paths: ["a"] });
    expect(line).toBe("since you left · 1 step · 1 file changed");
  });

  it("omits an empty slot from the text and says nothing at all when empty", () => {
    expect(reentryLine({ steps: 4, files: 0, paths: [] })).toBe("since you left · 4 steps");
    expect(reentryLine({ steps: 0, files: 0, paths: [] })).toBe("");
  });
});

describe("when the band may appear", () => {
  const work = { steps: 4, files: 1, paths: ["a.md"] };

  it("appears when a chat worked without you", () => {
    expect(shouldRenderReentry({ streaming: false, readIndex: 2, total: 6, work })).toBe(true);
  });

  it("never appears during a stream — the invariant allows one live surface", () => {
    expect(shouldRenderReentry({ streaming: true, readIndex: 2, total: 6, work })).toBe(false);
  });

  it("never appears when the position has already caught up", () => {
    expect(shouldRenderReentry({ streaming: false, readIndex: 6, total: 6, work })).toBe(false);
  });

  it("never appears over an unread stretch that did no work", () => {
    const none = { steps: 0, files: 0, paths: [] };
    expect(shouldRenderReentry({ streaming: false, readIndex: 2, total: 6, work: none })).toBe(
      false,
    );
  });
});

describe("resume verbs", () => {
  // The default is the state almost every conversation is in almost all of the
  // time: settled, and touched a minute ago. It must offer nothing.
  const state = (over: Partial<ResumeState> = {}): ResumeState => ({
    streaming: false,
    pendingPerm: false,
    pendingAsk: false,
    stopped: false,
    poisoned: false,
    idleMs: 60_000,
    ...over,
  });

  it("offers nothing on a settled chat you were just using", () => {
    // The bug this pins: "has a history" is not a state, it is the norm. A bar
    // that shows there is chrome, not an affordance.
    expect(resumeVerbs(state())).toEqual([]);
  });

  it("offers Resume once a settled chat has gone cold", () => {
    const verbs = resumeVerbs(state({ idleMs: RESUME_STALE_MS }));
    expect(verbs.map((v) => v.label)).toEqual(["Resume"]);
  });

  it("does not offer Course-correct on a cold chat: there is no course in flight", () => {
    const keys = resumeVerbs(state({ idleMs: RESUME_STALE_MS * 10 })).map((v) => v.key);
    expect(keys).toEqual(["resume"]);
  });

  it("offers Resume and Course-correct after a stop, however recent", () => {
    // Stopping is the moment the verbs are FOR: you cut a run off mid-course,
    // so picking it back up and redirecting it are both live options.
    const verbs = resumeVerbs(state({ stopped: true, idleMs: 1000 }));
    expect(verbs.map((v) => v.label)).toEqual(["Resume", "Course-correct"]);
  });

  it("treats an errored run like a stopped one", () => {
    const verbs = resumeVerbs(state({ poisoned: true, idleMs: 1000 }));
    expect(verbs.map((v) => v.key)).toEqual(["resume", "course-correct"]);
  });

  it("offers Approve, and only Approve, when a permission is waiting", () => {
    const verbs = resumeVerbs(state({ pendingPerm: true, streaming: true }));
    expect(verbs.map((v) => v.key)).toEqual(["approve"]);
    // Approve is a verdict, not a message: it seeds no composer text.
    expect(verbs[0].prompt).toBeUndefined();
  });

  it("offers nothing while a turn is streaming", () => {
    expect(resumeVerbs(state({ streaming: true, idleMs: RESUME_STALE_MS }))).toEqual([]);
  });

  it("offers nothing while a question card is open — the card is the surface", () => {
    expect(resumeVerbs(state({ pendingAsk: true, streaming: true }))).toEqual([]);
  });

  it("offers nothing on an empty new chat", () => {
    // No last message means no idle span to measure, not an infinite one.
    expect(resumeVerbs(state({ idleMs: undefined }))).toEqual([]);
    expect(resumeVerbs(state({ idleMs: undefined, stopped: true }))).toEqual([]);
  });

  it("words Resume differently after a stop or an error", () => {
    const cold = resumeVerbs(state({ idleMs: RESUME_STALE_MS }))[0].prompt;
    const stopped = resumeVerbs(state({ stopped: true }))[0].prompt;
    const errored = resumeVerbs(state({ poisoned: true }))[0].prompt;
    expect(stopped).not.toBe(cold);
    expect(errored).toBe(stopped);
  });

  it("every message verb seeds the composer with something", () => {
    for (const v of resumeVerbs(state({ stopped: true }))) expect(v.prompt).toBeTruthy();
    for (const v of resumeVerbs(state({ idleMs: RESUME_STALE_MS }))) expect(v.prompt).toBeTruthy();
  });
});

/* ---------------------------------------------------------------------------
 * The lifecycle of the one persisted number, as a SEQUENCE. Every bug this
 * phase had was a moment the position failed to move, or moved too far, and no
 * test of `advanceReadIndex` on its own can see that. So these drive the
 * functions the view actually calls, in the order the view calls them.
 * ------------------------------------------------------------------------ */

const convo = (messages: Message[], readIndex?: number): Convo =>
  ({ messages, readIndex, unread: false }) as unknown as Convo;

/** One reveal, applied exactly as `revealReentry` applies it. */
const reveal = (c: Convo, streaming = false) => {
  const d = planReveal({ messages: c.messages, readIndex: c.readIndex, streaming });
  if (d.readIndex !== null) c.readIndex = d.readIndex;
  return d.band;
};

const work12 = (): Message[] => [
  tool("Write", { file_path: "/v/a.md" }),
  tool("Edit", { file_path: "/v/b.md" }),
];

describe("the read position, over a session", () => {
  it("says nothing on a chat it has never seen, and starts counting from there", () => {
    const c = convo([user("hi"), ...work12()]);
    expect(reveal(c)).toBeNull(); // no "left" to be since
    expect(c.readIndex).toBe(3);
  });

  it("reports work done while you were away on a chat opened when it was empty", () => {
    // The flagship path: you make a chat, it is empty, you send and walk away.
    const c = convo([]);
    expect(reveal(c)).toBeNull();
    expect(c.readIndex).toBe(0); // a position, not an absence
    c.messages.push(user("do X"), ...work12());
    const band = reveal(c);
    expect(band?.work.steps).toBe(2);
    expect(band?.work.files).toBe(2);
  });

  it("puts the line under your own prompt, never above it", () => {
    // You typed it, so you have read it: the news starts at the reply.
    const c = convo([user("a"), tool("Write", { file_path: "/v/a.md" })], 0);
    expect(reveal(c)?.anchor).toBe(1);
    expect(bandAnchor([user("a"), user("b")], 0)).toBe(2);
  });

  it("never reports a turn that finished in front of you", () => {
    // reveal → the turn completes while this chat is the visible one → come
    // back: the band has nothing to say, because you watched it happen.
    const c = convo([user("a"), tool("Read", { file_path: "/v/a.md" })]);
    reveal(c);
    const turnFrom = c.messages.length;
    c.messages.push(user("do X"), ...work12());
    noteTurnEnd(c, { active: true, visible: true, turnFrom });
    expect(c.readIndex).toBe(c.messages.length);
    expect(c.unread).toBe(false);
    expect(reveal(c)).toBeNull();
  });

  it("still reports a turn that finished while the pane was not on screen", () => {
    const c = convo([user("a")], 1);
    const turnFrom = c.messages.length;
    c.messages.push(...work12());
    noteTurnEnd(c, { active: true, visible: false, turnFrom });
    expect(c.readIndex).toBe(1); // the active chat, but nobody was looking
    expect(reveal(c)?.work.steps).toBe(2);
  });

  it("marks a turn that landed in another chat unread and leaves its position", () => {
    const c = convo([user("a")], 1);
    const turnFrom = c.messages.length;
    c.messages.push(...work12());
    noteTurnEnd(c, { active: false, visible: true, turnFrom });
    expect(c.unread).toBe(true);
    expect(c.readIndex).toBe(1);
    expect(reveal(c)?.work.files).toBe(2);
  });

  it("keeps a stretch no reveal ever reported, even when the next turn ends in front of you", () => {
    // The normal way this happens: a run finishes while the sidebar is
    // collapsed, a second turn starts, you open the pane MID-stream (so the
    // reveal deliberately leaves the position alone), and 30s later that second
    // turn ends with you watching. Only the second turn was watched.
    const c = convo([user("a")], 1);
    c.messages.push(...work12()); // turn 1, finished behind a collapsed sidebar
    noteTurnEnd(c, { active: true, visible: false, turnFrom: 1 });
    expect(reveal(c, true)).toBeNull(); // walked in mid-stream: position held
    const turnFrom = c.messages.length;
    c.messages.push(user("and now this"), tool("Bash", { command: "ls" }));
    noteTurnEnd(c, { active: true, visible: true, turnFrom });
    expect(c.readIndex).toBe(1); // turn 1 is still owed a line
    expect(reveal(c)?.work.steps).toBe(3);
  });

  it("reads the turn you watched land when nothing was owed behind it", () => {
    const c = convo([user("a"), ...work12()], 3);
    const turnFrom = c.messages.length;
    c.messages.push(user("more"), tool("Bash", { command: "ls" }));
    noteTurnEnd(c, { active: true, visible: true, turnFrom });
    expect(c.readIndex).toBe(5);
  });

  it("reads a watched turn over an unread stretch that did no work", () => {
    // Prose is news the transcript already carries; the band would never
    // mention it, so holding the position for it would strand the number.
    const prose: Message = { role: "assistant", segments: [{ t: "text", md: "here you go" }] };
    const c = convo([user("a"), prose], 1);
    const turnFrom = c.messages.length;
    c.messages.push(user("more"), tool("Bash", { command: "ls" }));
    noteTurnEnd(c, { active: true, visible: true, turnFrom });
    expect(c.readIndex).toBe(4);
  });

  it("computes the same answer from the transcript alone", () => {
    const messages = [user("a"), ...work12(), user("b"), tool("Bash", { command: "ls" })];
    expect(readIndexAfterTurn({ messages, readIndex: 1, turnFrom: 3 })).toBe(1);
    expect(readIndexAfterTurn({ messages, readIndex: 3, turnFrom: 3 })).toBe(5);
    // Never opened: nothing is owed, so it catches up.
    expect(readIndexAfterTurn({ messages, readIndex: undefined, turnFrom: 3 })).toBe(5);
  });

  it("dissolves once read and does not return for the same position", () => {
    const c = convo([user("a")], 1);
    c.messages.push(...work12());
    expect(reveal(c)).not.toBeNull();
    expect(c.readIndex).toBe(3); // moved by the reveal that painted it
    expect(reveal(c)).toBeNull(); // and the same position never speaks twice
  });

  it("leaves the position untouched on a chat revealed mid-stream", () => {
    // Coming back mid-turn must not swallow the news: the band waits.
    const c = convo([user("a"), ...work12()], 1);
    expect(reveal(c, true)).toBeNull();
    expect(c.readIndex).toBe(1);
    expect(reveal(c)?.work.steps).toBe(2);
  });

  it("moves the position with a transcript that was rewound", () => {
    // A stored 10 over a transcript truncated to 3 keeps clamping to whatever
    // the transcript grows back to, which reads as "caught up" forever.
    const c = convo([user("a"), ...work12(), user("b"), ...work12()], 10);
    c.messages = c.messages.slice(0, 3);
    noteTranscriptReset(c);
    expect(c.readIndex).toBe(3);
    c.messages.push(...work12()); // a turn runs while you are away
    expect(reveal(c)?.work.steps).toBe(2);
  });

  it("starts the position over when the tab is cleared to a new session", () => {
    const c = convo([user("a"), ...work12()], 3);
    c.messages = [];
    noteTranscriptReset(c);
    expect(c.readIndex).toBe(0); // opened, and empty: a position, not an absence
    c.messages.push(user("do X"), ...work12());
    expect(reveal(c)?.work.steps).toBe(2);
  });
});

/* ---------------------------------------------------------------------------
 * The band as an element. `revealReentry` and `reenterActive` are the two
 * functions the view calls, and neither was driven by a test, so the stub
 * below is a DOM stand-in rich enough to host the real thing: insertion,
 * removal, the read position moving with it, and what a click goes to.
 * ------------------------------------------------------------------------ */

/** Only the surface `ui/reentry.ts` actually touches. */
class El {
  children: El[] = [];
  parent: El | null = null;
  readonly classes = new Set<string>();
  readonly dataset: Record<string, string> = {};
  text = "";
  value = "";
  tabIndex = 0;
  scrolled = false;
  private readonly handlers = new Map<string, ((e: unknown) => void)[]>();

  constructor(cls = "", text = "") {
    for (const c of cls.split(/\s+/).filter(Boolean)) this.classes.add(c);
    this.text = text;
  }

  private child(o: { cls?: string; text?: string }): El {
    return this.appendChild(new El(o.cls ?? "", o.text ?? ""));
  }
  createDiv(o: { cls?: string; text?: string } = {}): El {
    return this.child(o);
  }
  createSpan(o: { cls?: string; text?: string } = {}): El {
    return this.child(o);
  }
  appendChild(el: El): El {
    el.parent = this;
    this.children.push(el);
    return el;
  }
  insertBefore(el: El, ref: El): El {
    el.parent = this;
    this.children.splice(this.children.indexOf(ref), 0, el);
    return el;
  }
  remove(): void {
    const at = this.parent?.children.indexOf(this) ?? -1;
    if (this.parent && at >= 0) this.parent.children.splice(at, 1);
    this.parent = null;
  }
  addClass(c: string): void {
    this.classes.add(c);
  }
  removeClass(c: string): void {
    this.classes.delete(c);
  }
  toggleClass(c: string, on: boolean): void {
    if (on) this.classes.add(c);
    else this.classes.delete(c);
  }
  setText(t: string): void {
    this.text = t;
  }
  setAttribute(): void {
    /* `clickable` sets role="button"; nothing here reads it back. */
  }
  addEventListener(type: string, h: (e: unknown) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), h]);
  }
  click(): void {
    this.dispatch("click");
  }
  dispatch(type: string): void {
    for (const h of this.handlers.get(type) ?? []) h({});
  }
  scrollIntoView(): void {
    this.scrolled = true;
  }
  matches(selector: string): boolean {
    return selector.split(",").some((raw) => {
      const m = /^\.([\w-]+)(?:\[data-msg="(\d+)"\])?$/.exec(raw.trim());
      if (!m || !this.classes.has(m[1])) return false;
      return m[2] === undefined || this.dataset.msg === m[2];
    });
  }
  descendants(): El[] {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }
  querySelector(selector: string): El | null {
    return this.descendants().find((el) => el.matches(selector)) ?? null;
  }
  querySelectorAll(selector: string): El[] {
    return this.descendants().filter((el) => el.matches(selector));
  }
  compareDocumentPosition(other: El): number {
    let root: El = this;
    while (root.parent) root = root.parent;
    const order = [root, ...root.descendants()];
    return order.indexOf(other) > order.indexOf(this) ? 4 : 2;
  }
}

// `createDiv` is Obsidian's global DOM helper, and `Node` carries the one
// bitmask `findAfter` compares against.
(globalThis as unknown as { createDiv: (o?: { cls?: string }) => El }).createDiv = (o) =>
  new El(o?.cls ?? "");
(globalThis as unknown as { Node: { DOCUMENT_POSITION_FOLLOWING: number } }).Node = {
  DOCUMENT_POSITION_FOLLOWING: 4,
};

const BAND = ".mva-reentry";
const noop = () => {};

/** A re-entry host whose composer never offers verbs: these tests are about
 *  the band, and the verbs have their own suite. */
const host = (isShown: boolean, onRead: () => void = noop): ReentryHost => ({
  containerEl: { isShown: () => isShown } as unknown as HTMLElement,
  listWrap: new El() as unknown as HTMLElement,
  composer: { getDraft: () => ({ text: "x" }) as ComposerDraft, insertText: noop, focusInput: noop },
  openNote: noop,
  persist: onRead,
});
const shown = host(true);
const collapsed = host(false);

/**
 * A conversation with a transcript on screen. `turns[i]` is the message index
 * that DOM turn renders, or `null` for an element with no message behind it:
 * the shape the DOM takes after a turn is stopped before its first token.
 */
const domConvo = (messages: Message[], readIndex: number | undefined, turns: (number | null)[]) => {
  const listEl = new El("mva-list");
  for (const msg of turns) {
    const turn = listEl.createDiv({ cls: "mva-turn" });
    if (msg === null) continue;
    turn.dataset.msg = String(msg);
    if (messages[msg]?.role === "assistant") turn.createDiv({ cls: "mva-steps is-collapsed" });
  }
  const c = { messages, readIndex, unread: false, streaming: false, listEl } as unknown as Convo;
  return { c, listEl };
};

/** Every message index in the transcript: a DOM with no phantom turns. */
const allTurns = (messages: Message[]): number[] => messages.map((_, i) => i);

describe("the band, as an element", () => {
  it("goes in immediately above the first turn you have not seen", () => {
    const messages = [user("a"), ...work12()];
    const { c, listEl } = domConvo(messages, 1, allTurns(messages));
    revealReentry(c, noop);
    const band = listEl.querySelector(BAND);
    expect(band).not.toBeNull();
    expect(listEl.children.indexOf(band as El)).toBe(1); // before the turn for message 1
    expect(band?.children.map((s) => s.text)).toEqual([
      "since you left",
      "2 steps",
      "2 files changed",
    ]);
    expect(c.readIndex).toBe(3);
  });

  it("refuses to paint when the anchor turn is missing, and keeps the news", () => {
    // A miss used to `appendChild`, which prints "since you left · 2 steps"
    // BELOW every message it describes. There is no honest position left, so
    // the read position does not move either: the news is still owed.
    const messages = [user("a"), ...work12()];
    const { c, listEl } = domConvo(messages, 1, [0]); // the replies never made it into the DOM
    let persisted = 0;
    revealReentry(c, noop, () => persisted++);
    expect(listEl.querySelector(BAND)).toBeNull();
    expect(c.readIndex).toBe(1);
    expect(persisted).toBe(0);
  });

  it("reports work that landed behind a band nobody clicked", () => {
    // Read the line, leave it on screen, collapse the sidebar, let the agent
    // work, come back: the stale band used to make re-entry a no-op forever.
    const messages = [user("a"), ...work12()];
    const { c, listEl } = domConvo(messages, 1, allTurns(messages));
    revealReentry(c, noop);
    const first = listEl.querySelector(BAND);
    c.messages.push(tool("Bash", { command: "ls" }));
    listEl.createDiv({ cls: "mva-turn" }).dataset.msg = "3";
    reenterActive(c, shown);
    const second = listEl.querySelector(BAND);
    expect(second).not.toBe(first);
    expect(second?.children.map((s) => s.text)).toEqual(["since you left", "1 step", ""]);
    expect(c.readIndex).toBe(4);
  });

  it("leaves a band alone while it is still the whole truth", () => {
    const messages = [user("a"), ...work12()];
    const { c, listEl } = domConvo(messages, 1, allTurns(messages));
    revealReentry(c, noop);
    const painted = listEl.querySelector(BAND);
    let persisted = 0;
    reenterActive(c, host(true, () => persisted++));
    expect(listEl.querySelector(BAND)).toBe(painted); // the same element, untouched
    expect(persisted).toBe(0);
  });

  it("keeps a band when the work that landed behind it has nothing to report", () => {
    // The line is deleted and the news marked read, both, for a turn that
    // produced only prose: the transcript grew, so the band read as stale, and
    // the removal happened BEFORE anything decided there was a line to paint.
    // Prose is news the transcript already carries, so there is nothing to
    // repaint with, and the right answer is to leave the reader alone.
    const messages = [user("a"), ...work12()];
    const { c, listEl } = domConvo(messages, 1, allTurns(messages));
    revealReentry(c, noop);
    const painted = listEl.querySelector(BAND);

    c.messages.push(user("more"), { role: "assistant", segments: [{ t: "text", md: "done" }] });
    listEl.createDiv({ cls: "mva-turn" }).dataset.msg = "3";
    listEl.createDiv({ cls: "mva-turn" }).dataset.msg = "4";
    reenterActive(c, shown);

    expect(listEl.querySelector(BAND)).toBe(painted); // the same element, still readable
    // The position DOES catch up, and that is the same rule prose follows
    // everywhere else: the band can never mention it, so holding the number
    // back for it would strand it. What must not happen is losing the line.
    expect(c.readIndex).toBe(c.messages.length);
  });

  it("keeps a band when the anchor for the new work is missing", () => {
    // Same removal-before-decision hazard, reached through the other early
    // return: refusing to paint must not cost the line already on screen.
    const messages = [user("a"), ...work12()];
    const { c, listEl } = domConvo(messages, 1, allTurns(messages));
    revealReentry(c, noop);
    const painted = listEl.querySelector(BAND);
    c.messages.push(tool("Bash", { command: "ls" })); // no element for it
    reenterActive(c, shown);
    expect(listEl.querySelector(BAND)).toBe(painted);
  });

  it("leaves a band alone while a turn is streaming", () => {
    const messages = [user("a"), ...work12()];
    const { c, listEl } = domConvo(messages, 1, allTurns(messages));
    revealReentry(c, noop);
    const painted = listEl.querySelector(BAND);
    c.messages.push(user("one more thing"));
    (c as { streaming: boolean }).streaming = true;
    reenterActive(c, shown);
    expect(listEl.querySelector(BAND)).toBe(painted);
  });

  it("never re-enters a pane that is still collapsed", () => {
    const messages = [user("a"), ...work12()];
    const { c, listEl } = domConvo(messages, 1, allTurns(messages));
    reenterActive(c, collapsed);
    expect(listEl.querySelector(BAND)).toBeNull();
    expect(c.readIndex).toBe(1);
  });

  it("opens the first written note from the files slot, then dissolves", () => {
    const messages = [user("a"), ...work12()];
    const { c, listEl } = domConvo(messages, 1, allTurns(messages));
    const opened: string[] = [];
    revealReentry(c, (p) => opened.push(p));
    const band = listEl.querySelector(BAND) as El;
    band.children.find((s) => s.dataset.slot === "files")?.click();
    expect(opened).toEqual(["/v/a.md"]);
    expect(listEl.querySelector(BAND)).toBeNull(); // acted on, the line is done
  });

  it("sends the steps slot to a run BELOW the line, never to one above it", () => {
    const messages = [user("a"), tool("Read", { file_path: "/v/seen.md" }), ...work12()];
    const { c, listEl } = domConvo(messages, 2, allTurns(messages));
    revealReentry(c, noop);
    const band = listEl.querySelector(BAND) as El;
    band.children.find((s) => s.dataset.slot === "steps")?.click();
    const runs = listEl.querySelectorAll(".mva-steps");
    expect(runs.map((r) => r.scrolled)).toEqual([false, true, false]);
    expect(runs[1].classes.has("is-collapsed")).toBe(false); // opened, not just located
  });
});

describe("the resume verbs, as elements", () => {
  /** A composer host: the textarea the verbs stand down for, and the composer
   *  they are inserted above. */
  const verbHost = (draft: string) => {
    const host = new El("");
    const input = host.createDiv({ cls: "mva-input" });
    input.value = draft;
    host.createDiv({ cls: "mva-composer" });
    const composer: ResumeComposer = {
      getDraft: () => ({ text: input.value }) as ComposerDraft,
      insertText: noop,
      focusInput: noop,
    };
    // A stopped chat, which is the state that always offers verbs.
    const c = {
      messages: [{ role: "user", text: "go", at: Date.now() }],
      streaming: false,
      stopped: true,
      pendingPerm: null,
      pendingAsk: null,
    } as unknown as Convo;
    return { host, input, composer, c };
  };
  const bar = (host: El): El | null => host.querySelector(".mva-resume-verbs");

  it("offers the verbs of the state on an empty composer", () => {
    const { host, composer, c } = verbHost("");
    renderResumeVerbs(host as unknown as HTMLElement, c, composer);
    expect(bar(host)?.classes.has("is-hidden")).toBe(false);
  });

  it("keeps the bar, hidden, while the user is writing, and brings it back when they stop", () => {
    // It used to be removed outright: `draftEmpty` was part of the state, so a
    // non-empty draft returned no verbs at all and the bar was deleted. The
    // keystroke listener then looked up a bar that no longer existed, so
    // clearing the textarea never brought it back — the fast path was gone
    // until some unrelated repaint happened to rebuild it.
    const { host, input, composer, c } = verbHost("half a thought");
    renderResumeVerbs(host as unknown as HTMLElement, c, composer);
    expect(bar(host)).not.toBeNull();
    expect(bar(host)?.classes.has("is-hidden")).toBe(true);

    input.value = "";
    input.dispatch("input");
    expect(bar(host)?.classes.has("is-hidden")).toBe(false);
  });

  it("paints no bar at all when the state offers no verbs", () => {
    const { host, composer, c } = verbHost("");
    (c as { stopped: boolean }).stopped = false;
    renderResumeVerbs(host as unknown as HTMLElement, c, composer);
    expect(bar(host)).toBeNull();
  });
});

describe("cutting a transcript back at a turn", () => {
  /** A rewind, as the view performs it: the turn the user clicked, by message. */
  const rewound = (drop: "after" | "from") => {
    const messages = [user("a"), ...work12(), user("b"), ...work12()];
    const { c, listEl } = domConvo(messages, 6, [0, 1, null, 2, 3, 4, 5]);
    const queue = listEl.createDiv({ cls: "mva-queue" }); // held by field, not by the DOM
    const turnEl = listEl.querySelector('.mva-turn[data-msg="3"]') as unknown as HTMLElement;
    const idx = turnMessageIndex(turnEl) as number;
    c.messages = c.messages.slice(0, drop === "after" ? idx + 1 : idx);
    if (drop === "after") cutTranscriptAfter(c, turnEl);
    else cutTranscriptFrom(c, turnEl);
    return { c, listEl, queue };
  };

  it("keeps the turns up to the clicked one, phantom turns included", () => {
    const { listEl } = rewound("after");
    expect(listEl.querySelectorAll(".mva-turn").map((t) => t.dataset.msg ?? null)).toEqual([
      "0",
      "1",
      null,
      "2",
      "3",
    ]);
  });

  it("takes the clicked turn too when the code rewind undoes it", () => {
    const { listEl } = rewound("from");
    expect(listEl.querySelectorAll(".mva-turn").map((t) => t.dataset.msg ?? null)).toEqual([
      "0",
      "1",
      null,
      "2",
    ]);
  });

  it("leaves the read position somewhere the transcript can still speak from", () => {
    // Stored 6 over a transcript now 4 long: left alone it clamps to every
    // later length and the chat never reports another thing it did.
    const { c } = rewound("after");
    expect(c.readIndex).toBe(4);
    c.messages.push(...work12());
    expect(reveal(c)?.work.steps).toBe(2);
  });

  it("removes only turns: the queue node is held by field, not by the DOM", () => {
    const { listEl, queue } = rewound("after");
    expect(listEl.children.includes(queue)).toBe(true);
  });
});

/* ---------------------------------------------------------------------------
 * Where the line lands. `data-msg` is the only bridge between a message and its
 * element, and it is the piece that was wrong: a `.mva-turn` element does NOT
 * always have a message behind it, so the index of a message and the position
 * of its element are two different numbers.
 * ------------------------------------------------------------------------ */

const fakeList = (turns: (number | null)[]): HTMLElement => {
  const listEl = new El("mva-list");
  for (const msg of turns) {
    const turn = listEl.createDiv({ cls: "mva-turn" });
    if (msg !== null) turn.dataset.msg = String(msg);
  }
  return listEl as unknown as HTMLElement;
};

const domPos = (listEl: HTMLElement, el: HTMLElement | null): number =>
  (listEl as unknown as El).children.indexOf(el as unknown as El);

describe("the band's anchor element", () => {
  it("is the turn RENDERING the message, not the nth turn in the DOM", () => {
    // Prompt, Esc before the first token (an assistant element with nothing
    // behind it), prompt again, walk away. Message 2 is the second prompt's
    // reply and lives at DOM position 3.
    const dom = fakeList([0, null, 1, 2]);
    expect(domPos(dom, anchorTurn(dom, 2))).toBe(3);
  });

  it("keeps the line under the user's own prompt in that same DOM", () => {
    // `bandAnchor` moves past the prompt you typed, so it returns 2 here. The
    // element AT DOM position 2 is that very prompt (message 1) — inserting
    // there is "since you left · 12 steps" printed above your own words.
    const dom = fakeList([0, null, 1, 2]);
    expect(bandAnchor([user("a"), user("b"), tool("Write", { file_path: "/v/a.md" })], 1)).toBe(2);
    expect(turnMessageIndex(anchorTurn(dom, 2))).toBe(2); // the reply, not the prompt
  });

  it("finds no element for a message the DOM does not carry", () => {
    expect(anchorTurn(fakeList([0, 1]), 5)).toBeNull();
  });
});

describe("a turn element's message index", () => {
  it("reads the stamp, never the DOM position: the two differ after a phantom turn", () => {
    // What `rewindTo` / `rewindCodeTo` slice `messages` with. At DOM position 3
    // sits message 2, and truncating at 3 would delete a message that is still
    // on screen, taking its `data-msg` (and the band's anchor) with it.
    const turns = (fakeList([0, null, 1, 2]) as unknown as El).children;
    expect(turnMessageIndex(turns[3] as unknown as HTMLElement)).toBe(2);
    expect(turnMessageIndex(turns[0] as unknown as HTMLElement)).toBe(0);
  });

  it("reports nothing for a turn with no message behind it", () => {
    const turns = (fakeList([0, null]) as unknown as El).children;
    expect(turnMessageIndex(turns[1] as unknown as HTMLElement)).toBeNull();
    expect(turnMessageIndex(null)).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * The wiring in `view.ts`, read off the source: that file needs a mounted
 * Obsidian to run, so the CALL SITES are pinned here and the behaviour they
 * reach is pinned by the suites above.
 * ------------------------------------------------------------------------ */

const read = (rel: string): string => readFileSync(join(__dirname, "..", rel), "utf8");

describe("the re-entry band's wiring", () => {
  const ui = read("src/ui/reentry.ts");
  const view = read("src/view.ts");

  it("is not gated on pane width, unlike the Recap Rail", () => {
    // The rail is main-area-and-wide only (`view.ts` isWide → clientWidth > 900).
    // The re-entry line is the sidebar's too: a sidebar user comes back to a
    // chat exactly as often, and the line is the thing that tells them what
    // happened.
    expect(ui).not.toMatch(/900/);
    expect(ui).not.toMatch(/isWide|clientWidth|matchMedia/);
  });

  it("stamps every element that has a message with its index", () => {
    expect(view).toMatch(/"data-msg": i/);
    expect(view).toMatch(/"data-msg": c\.messages\.length - 1/);
    expect(view).toMatch(/ctx\.el\.dataset\.msg = String\(c\.messages\.length - 1\)/);
  });

  it("paints when the pane comes back with the SAME chat still active", () => {
    // `switchTo` is a CHANGE of conversation, and Exo lives in a collapsed
    // right sidebar — so the ordinary way back in never changes the active
    // chat, and nothing on that path used to reveal anything.
    // layout-change runs the same debounced refresh as a leaf change, and that
    // refresh is where the re-entry lives.
    const refresh = view.slice(view.indexOf("const refreshForLeafChange = debounce("), view.indexOf("}, 120, true);"));
    expect(refresh).toMatch(/reenterActive\(this\.active/);
    expect(view).toMatch(/"layout-change", \(\) => \{[^}]*refreshForLeafChange\(\)/);
  });

  it("re-enters every path through the same visibility gate", () => {
    // `restore()` runs from `onOpen`, and `convo-bridge` materialises the view
    // with `loadIfDeferred()` while the sidebar is still collapsed, so a bare
    // reveal there consumes the band into a pane nobody ever opened.
    expect(view).not.toMatch(/revealReentry\(/);
    // Every re-entry goes through the one host, so the band and the verbs
    // cannot end up answering different events again.
    expect(view.match(/reenterActive\(\w+(?:\.\w+)*, this\.reentryHost\)/g)).toHaveLength(4);
    expect(view).not.toMatch(/reenterActive\([^)]*containerEl/);
  });

  it("persists the read position with the conversation", () => {
    // Both directions: written to disk in `toConvoData`, read back in `restore`.
    expect(view).toMatch(/readIndex/);
    // 0 is a position and has to survive a quit — `if (c.readIndex)` would drop it.
    expect(view).toMatch(/c\.readIndex !== undefined \? \{ readIndex/);
    expect(read("src/ui/convo-types.ts")).toMatch(/readIndex\?: number/);
  });

  it("tells the turn end where the turn it just watched began", () => {
    expect(view).toMatch(/const turnFrom = c\.messages\.length;/);
    expect(view).toMatch(/noteTurnEnd\(c, \{ active: c === this\.active,.{0,80}turnFrom \}\)/);
  });

  it("moves the read position with every transcript it cuts down", () => {
    // The three sites that replace or truncate `messages`: a stored position
    // that outlives the messages it counted reads as "caught up" over work
    // nobody saw. `newSessionInTab` resets it; the two rewinds go through the
    // cut helpers, which carry the position with the elements.
    expect(view).toMatch(/noteTranscriptReset\(c\);/);
    expect(view).toMatch(/cutTranscriptAfter\(c, turnEl\);/);
    expect(view).toMatch(/cutTranscriptFrom\(c, turnEl\);/);
  });

  it("slices the transcript by message index, never by DOM position", () => {
    expect(view.match(/const idx = turnMessageIndex\(turnEl\);/g)?.length).toBe(2);
    expect(view).toMatch(/c\.messages = c\.messages\.slice\(0, idx \+ 1\);/);
    expect(view).toMatch(/c\.messages = c\.messages\.slice\(0, idx\);/);
    expect(view).not.toMatch(/const idx = turns\.indexOf\(turnEl\)/);
  });
});
