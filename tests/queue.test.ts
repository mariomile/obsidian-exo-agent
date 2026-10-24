import { describe, it, expect } from "vitest";
import { canSteer, hasPending, holdQueue, nextRunnable, takeAt, type QueuedMessage } from "../src/core/queue";

const img = { mediaType: "image/png", data: "x" } as unknown as NonNullable<QueuedMessage["images"]>[number];

describe("holdQueue (Stop / broken session)", () => {
  it("keeps every message, held, with text, images and frozen context", () => {
    const ctx = { paths: ["Notes/A.md"], selection: { text: "sel", path: "Notes/A.md" } };
    const q: QueuedMessage[] = [{ text: "one", images: [img], context: ctx }, { text: "two" }];
    holdQueue(q);
    expect(q).toEqual([
      { text: "one", images: [img], context: ctx, held: true },
      { text: "two", held: true },
    ]);
  });

  it("holds in place, so a pill open in the editor keeps its edit", () => {
    const mine: QueuedMessage = { text: "a", editing: true };
    const q = [mine];
    holdQueue(q);
    mine.text = "edited";
    delete mine.editing;
    expect(q[0]).toEqual({ text: "edited", held: true });
    expect(nextRunnable(q)).toBe(-1); // saving the edit does not un-hold it
  });
});

describe("drain", () => {
  it("skips held messages and runs the first runnable one", () => {
    const q: QueuedMessage[] = [{ text: "held", held: true }, { text: "next" }];
    expect(nextRunnable(q)).toBe(1);
    expect(hasPending(q)).toBe(true);
    expect(takeAt(q, nextRunnable(q))?.text).toBe("next");
    expect(q).toEqual([{ text: "held", held: true }]);
  });

  it("runs nothing when everything is held (no double send after Stop)", () => {
    const q: QueuedMessage[] = [{ text: "a" }, { text: "b" }];
    holdQueue(q);
    expect(nextRunnable(q)).toBe(-1);
    expect(hasPending(q)).toBe(false);
    expect(takeAt(q, -1)).toBeUndefined();
    expect(q).toHaveLength(2);
  });
});

describe("a pill being edited", () => {
  it("is never drained: the turn end must not send the old text", () => {
    const q: QueuedMessage[] = [{ text: "draft", editing: true }, { text: "next" }];
    expect(nextRunnable(q)).toBe(1);
  });

  it("still counts as the user's input, so it wins over an active goal", () => {
    expect(hasPending([{ text: "draft", editing: true }])).toBe(true);
    expect(hasPending([{ text: "paused", held: true }])).toBe(false);
  });
});

describe("canSteer", () => {
  const live = { streaming: true, researchOn: false, hasSteer: true };
  it("only while streaming, with a provider that steers, outside Research Mode", () => {
    expect(canSteer({ text: "a" }, live)).toBe(true);
    expect(canSteer({ text: "a" }, { ...live, streaming: false })).toBe(false);
    expect(canSteer({ text: "a" }, { ...live, hasSteer: false })).toBe(false);
    expect(canSteer({ text: "a" }, { ...live, researchOn: true })).toBe(false);
  });

  it("never for a held message or one being edited", () => {
    expect(canSteer({ text: "a", held: true }, live)).toBe(false);
    expect(canSteer({ text: "a", editing: true }, live)).toBe(false);
  });

  it("never with images: both providers refuse them mid-turn", () => {
    expect(canSteer({ text: "a", images: [img] }, live)).toBe(false);
  });

  it("never when the message carries more than its text: steer would drop it", () => {
    expect(canSteer({ text: "a", context: { paths: ["A.md"], selection: null } }, live)).toBe(false);
    expect(canSteer({ text: "a", context: { paths: [], selection: { text: "s", path: "A.md" } } }, live)).toBe(false);
    expect(canSteer({ text: "a", agent: "researcher" }, live)).toBe(false);
    expect(canSteer({ text: "a", sendPrefix: "handoff" }, live)).toBe(false);
    expect(canSteer({ text: "a", researchMode: { enabled: true, startedAt: 1 } }, live)).toBe(false);
    // An empty frozen context is nothing to lose.
    expect(canSteer({ text: "a", context: { paths: [], selection: null } }, live)).toBe(true);
  });

  it("steers when the running turn already carries the message's notes and selection", () => {
    const sel = { text: "s", path: "A.md" };
    const turn = { ...live, turnContext: { paths: ["A.md", "B.md"], selection: sel } };
    // The common case: the note open beside the chat rode the turn already.
    expect(canSteer({ text: "a", context: { paths: ["A.md"], selection: null } }, turn)).toBe(true);
    expect(canSteer({ text: "a", context: { paths: ["A.md"], selection: { ...sel } } }, turn)).toBe(true);
    // A note or selection the turn never saw would be lost.
    expect(canSteer({ text: "a", context: { paths: ["C.md"], selection: null } }, turn)).toBe(false);
    expect(canSteer({ text: "a", context: { paths: [], selection: { text: "other", path: "A.md" } } }, turn)).toBe(false);
  });
});
