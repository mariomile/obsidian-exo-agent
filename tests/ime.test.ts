import { describe, it, expect } from "vitest";
import { isComposingKey } from "../src/core/ime";

describe("isComposingKey", () => {
  it("is true while the IME is composing", () => {
    expect(isComposingKey({ isComposing: true, key: "Enter" })).toBe(true);
  });
  it("is true for the committing keydown Chromium reports as Process", () => {
    expect(isComposingKey({ isComposing: false, key: "Process" })).toBe(true);
  });
  it("is false for a plain Enter", () => {
    expect(isComposingKey({ isComposing: false, key: "Enter" })).toBe(false);
  });
});
