import { describe, it, expect } from "vitest";
import { activeNoteState, contextModel } from "../src/core/active-note";

describe("activeNoteState", () => {
  it("attaches the active note when it is visible next to the chat", () => {
    expect(activeNoteState("A.md", true, null)).toEqual({ kind: "attached", path: "A.md" });
  });

  it("only suggests it when the note is hidden behind a full-page chat", () => {
    expect(activeNoteState("A.md", false, null)).toEqual({ kind: "suggested", path: "A.md" });
  });

  it("drops a dismissed note, visible or not", () => {
    expect(activeNoteState("A.md", true, "A.md")).toEqual({ kind: "none" });
    expect(activeNoteState("A.md", false, "A.md")).toEqual({ kind: "none" });
  });

  it("dismissing one note does not silence the next", () => {
    expect(activeNoteState("B.md", true, "A.md")).toEqual({ kind: "attached", path: "B.md" });
  });

  it("has nothing to offer without an active note", () => {
    expect(activeNoteState(null, true, null)).toEqual({ kind: "none" });
  });
});

describe("contextModel", () => {
  it("sends the attached note first, then the hand-attached ones, without duplicates", () => {
    const m = contextModel({ kind: "attached", path: "A.md" }, ["B.md", "A.md", "B.md"]);
    expect(m.paths).toEqual(["A.md", "B.md"]);
    expect(m.manual).toEqual(["B.md"]);
  });

  it("a suggested note attached by hand shows once, as a manual card", () => {
    const m = contextModel({ kind: "suggested", path: "A.md" }, ["A.md"]);
    expect(m.active).toEqual({ kind: "none" });
    expect(m.manual).toEqual(["A.md"]);
    expect(m.paths).toEqual(["A.md"]);
  });

  it("a suggestion alone sends nothing", () => {
    const m = contextModel({ kind: "suggested", path: "A.md" }, []);
    expect(m.active.kind).toBe("suggested");
    expect(m.paths).toEqual([]);
  });
});
