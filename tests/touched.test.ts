import { describe, it, expect } from "vitest";
import { WRITE_TOOLS, mergeTouched, type TouchedNote } from "../src/core/touched";

describe("mergeTouched", () => {
  it("dedupes repeated reads of the same note", () => {
    const list: TouchedNote[] = [];
    mergeTouched(list, "a.md", "read");
    mergeTouched(list, "a.md", "read");
    expect(list).toEqual([{ path: "a.md", kind: "read" }]);
  });

  it("upgrades a read entry to a write (read-then-written shows as written)", () => {
    const list: TouchedNote[] = [];
    mergeTouched(list, "a.md", "read");
    mergeTouched(list, "a.md", "write");
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({ path: "a.md", kind: "write", count: 1 });
  });

  it("seeds a first write with count 1", () => {
    const list: TouchedNote[] = [];
    mergeTouched(list, "a.md", "write");
    expect(list[0]).toEqual({ path: "a.md", kind: "write", count: 1 });
  });

  it("increments the write count by N across repeated writes", () => {
    const list: TouchedNote[] = [];
    mergeTouched(list, "a.md", "write");
    mergeTouched(list, "a.md", "write");
    mergeTouched(list, "a.md", "write");
    expect(list[0].count).toBe(3);
  });

  it("upgrade-then-write keeps incrementing from the upgrade", () => {
    const list: TouchedNote[] = [];
    mergeTouched(list, "a.md", "read"); // no count
    mergeTouched(list, "a.md", "write"); // count 1
    mergeTouched(list, "a.md", "write"); // count 2
    expect(list[0]).toEqual({ path: "a.md", kind: "write", count: 2 });
  });

  it("keeps distinct notes as separate entries in insertion order", () => {
    const list: TouchedNote[] = [];
    mergeTouched(list, "a.md", "read");
    mergeTouched(list, "b.md", "write");
    expect(list.map((t) => t.path)).toEqual(["a.md", "b.md"]);
  });
});

describe("WRITE_TOOLS", () => {
  it("save_to_note is a write, so the touched footer and headless runs count it", () => {
    expect(WRITE_TOOLS.test("mcp__obsidian__save_to_note")).toBe(true);
  });

  it("propose_correction is not a write: the note changes only when Mario accepts", () => {
    expect(WRITE_TOOLS.test("mcp__obsidian__propose_correction")).toBe(false);
  });
});
