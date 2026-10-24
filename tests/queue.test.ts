import { describe, it, expect } from "vitest";
import { canSteer, hasRunnable, holdQueue, nextRunnable, takeAt, turnOptsFor, type QueuedMessage } from "../src/core/queue";

const img = { mediaType: "image/png", data: "x" } as unknown as NonNullable<QueuedMessage["images"]>[number];

describe("holdQueue (Stop / broken session)", () => {
  it("keeps the user's messages, held, with text, images and frozen context", () => {
    const ctx = { paths: ["Notes/A.md"], selection: { text: "sel", path: "Notes/A.md" } };
    const q: QueuedMessage[] = [{ text: "one", images: [img], context: ctx }, { text: "two" }];
    const held = holdQueue(q);
    expect(held).toEqual([
      { text: "one", images: [img], context: ctx, held: true },
      { text: "two", held: true },
    ]);
  });

  it("drops Exo's own items: they belonged to the stopped turn", () => {
    expect(holdQueue([{ text: "wake", auto: true }, { text: "mine" }])).toEqual([{ text: "mine", held: true }]);
  });

  it("does not mutate the input", () => {
    const q: QueuedMessage[] = [{ text: "a" }];
    holdQueue(q);
    expect(q[0].held).toBeUndefined();
  });
});

describe("drain", () => {
  it("skips held messages and runs the first runnable one", () => {
    const q: QueuedMessage[] = [{ text: "held", held: true }, { text: "next" }];
    expect(nextRunnable(q)).toBe(1);
    expect(hasRunnable(q)).toBe(true);
    expect(takeAt(q, nextRunnable(q))?.text).toBe("next");
    expect(q).toEqual([{ text: "held", held: true }]);
  });

  it("runs nothing when everything is held (no double send after Stop)", () => {
    const q: QueuedMessage[] = holdQueue([{ text: "a" }, { text: "b" }]);
    expect(nextRunnable(q)).toBe(-1);
    expect(hasRunnable(q)).toBe(false);
    expect(takeAt(q, -1)).toBeUndefined();
    expect(q).toHaveLength(2);
  });
});

describe("turnOptsFor", () => {
  it("is undefined for a plain follow-up", () => {
    expect(turnOptsFor({ text: "hi" })).toBeUndefined();
  });

  it("carries the frozen context into the turn", () => {
    const context = { paths: ["A.md"], selection: null };
    expect(turnOptsFor({ text: "hi", context })).toEqual({
      sendPrefix: undefined,
      isRecoveryRetry: undefined,
      researchMode: undefined,
      agent: undefined,
      auto: undefined,
      context,
    });
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

  it("never with images: both providers refuse them mid-turn", () => {
    expect(canSteer({ text: "a", images: [img] }, live)).toBe(false);
  });
});
