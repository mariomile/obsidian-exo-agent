import { describe, it, expect } from "vitest";
import { autoMemoryNote } from "../src/core/memory-prompts";

describe("autoMemoryNote", () => {
  const rule = "cite the ones you rely on as [[Note]]";
  it("asks for [[Note]] citations and successors when recall is on, in one sentence", () => {
    const note = autoMemoryNote({ recall: true, chats: false });
    expect(note).toContain(rule);
    expect(note).toContain("if you use a note marked superseded, cite its successor instead");
    expect(note.split(rule)).toHaveLength(2);
  });
  it("says nothing about recalled notes when recall is off", () => {
    expect(autoMemoryNote({ recall: false, chats: true })).not.toContain("[[Note]]");
  });
});
