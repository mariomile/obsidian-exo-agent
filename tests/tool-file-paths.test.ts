import { describe, expect, it } from "vitest";
import { toolFilePath, toolFilePaths } from "../src/ui/tools";

describe("toolFilePaths", () => {
  it("returns both rename endpoints so rewind can restore both", () => {
    const input = { target: "Notes/Old.md", new_path: "Archive/New" };
    expect(toolFilePaths("mcp__obsidian__rename_note", input)).toEqual([
      "Notes/Old.md",
      "Archive/New.md",
    ]);
    expect(toolFilePath("mcp__obsidian__rename_note", input)).toBe("Notes/Old.md");
  });

  it("save_to_note targets its path, so rewind and click-to-open see it", () => {
    expect(toolFilePaths("mcp__obsidian__save_to_note", { path: "Projects/Pricing.md", text: "x" })).toEqual(["Projects/Pricing.md"]);
  });

  it("keeps one-path tools compatible", () => {
    expect(toolFilePaths("Write", { file_path: "/vault/note.md" })).toEqual(["/vault/note.md"]);
  });
});
