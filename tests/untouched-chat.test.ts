import { describe, it, expect } from "vitest";
import { isUntouchedChat } from "../src/core/untouched-chat";

const chat = (over = {}) => ({ messages: [], streaming: false, queue: [], researchMode: { enabled: false }, ...over });
const draft = (over = {}) => ({ text: "", images: [], attached: [], ...over });

describe("isUntouchedChat", () => {
  it("is true for a brand-new chat with an empty composer", () => {
    expect(isUntouchedChat(chat(), draft())).toBe(true);
  });

  it.each([
    ["has messages", chat({ messages: [{}] }), draft()],
    ["is streaming", chat({ streaming: true }), draft()],
    ["has a queued message", chat({ queue: [{}] }), draft()],
    ["has an agent bound", chat({ agent: "writer" }), draft()],
    ["has a goal", chat({ goal: {} }), draft()],
    ["is in research mode", chat({ researchMode: { enabled: true } }), draft()],
    ["has draft text", chat(), draft({ text: "half a thought" })],
    ["has a pasted image", chat(), draft({ images: [{}] })],
    ["has an attached note", chat(), draft({ attached: ["A.md"] })],
  ])("is false when the chat %s", (_label, c, d) => {
    expect(isUntouchedChat(c, d)).toBe(false);
  });

  it("ignores whitespace-only draft text", () => {
    expect(isUntouchedChat(chat(), draft({ text: "  \n" }))).toBe(true);
  });
});
