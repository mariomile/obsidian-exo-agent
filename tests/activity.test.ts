import { describe, it, expect } from "vitest";
import { describeActivity } from "../src/core/activity";

describe("describeActivity — reads", () => {
  it("Read → basename, .md and directory stripped", () => {
    expect(describeActivity("Read", { file_path: "Notes/Sub/Product Market Fit.md" })).toBe(
      "Reading Product Market Fit"
    );
  });
  it("mcp__obsidian__read_note → target basename, wikilink brackets stripped", () => {
    expect(describeActivity("mcp__obsidian__read_note", { target: "[[Pricing]]" })).toBe(
      "Reading Pricing"
    );
  });
  it("NotebookRead uses notebook_path", () => {
    expect(describeActivity("NotebookRead", { notebook_path: "a/b/Analysis.ipynb" })).toBe(
      "Reading Analysis.ipynb"
    );
  });
  it("Read with no path falls back", () => {
    expect(describeActivity("Read", {})).toBe("Reading a note");
  });
});

describe("describeActivity — writes", () => {
  it("Write → basename", () => {
    expect(describeActivity("Write", { file_path: "Atlas/GTM.md" })).toBe("Writing GTM");
  });
  it("Edit → basename", () => {
    expect(describeActivity("Edit", { file_path: "Atlas/GTM.md" })).toBe("Writing GTM");
  });
  it("mcp__obsidian__save_to_note reads as a write", () => {
    expect(describeActivity("mcp__obsidian__save_to_note", { path: "Projects/Pricing.md" })).toBe("Writing Pricing");
  });
  it("mcp__obsidian__propose_correction says it proposes, since nothing is written yet", () => {
    expect(describeActivity("mcp__obsidian__propose_correction", { path: "Projects/Pricing.md" })).toBe("Proposing a correction to Pricing");
    expect(describeActivity("mcp__obsidian__propose_correction", {})).toBe("Proposing a correction");
  });
  it("mcp__obsidian__create_note → path basename", () => {
    expect(describeActivity("mcp__obsidian__create_note", { path: "Inbox/New Idea.md" })).toBe(
      "Writing New Idea"
    );
  });
  it("Write with no path falls back", () => {
    expect(describeActivity("Write", {})).toBe("Writing a note");
  });
});

describe("describeActivity — web", () => {
  it("WebSearch appends the query", () => {
    expect(describeActivity("WebSearch", { query: "obsidian plugins" })).toBe(
      "Searching the web — obsidian plugins"
    );
  });
  it("WebSearch with no query falls back", () => {
    expect(describeActivity("WebSearch", {})).toBe("Searching the web");
  });
  it("WebFetch shows the bare host (www. stripped)", () => {
    expect(describeActivity("WebFetch", { url: "https://www.example.com/a/b?q=1" })).toBe(
      "Fetching example.com"
    );
  });
  it("WebFetch with an unparseable url shows the raw string", () => {
    expect(describeActivity("WebFetch", { url: "not-a-url" })).toBe("Fetching not-a-url");
  });
  it("WebFetch with no url falls back", () => {
    expect(describeActivity("WebFetch", {})).toBe("Fetching a page");
  });
});

describe("describeActivity — other tools", () => {
  it("Bash", () => {
    expect(describeActivity("Bash", { command: "ls" })).toBe("Running a command");
  });
  it("Skill names the skill", () => {
    expect(describeActivity("Skill", { skill: "autoresearch" })).toBe("Running autoresearch");
  });
  it("Skill with no skill falls back", () => {
    expect(describeActivity("Skill", {})).toBe("Running a skill");
  });
  it("Task", () => {
    expect(describeActivity("Task", { subagent_type: "Explore" })).toBe(
      "Delegating to a subagent"
    );
  });
  it("Grep → vault search", () => {
    expect(describeActivity("Grep", { pattern: "foo" })).toBe("Searching the vault");
  });
  it("Glob → vault search", () => {
    expect(describeActivity("Glob", { pattern: "**/*.md" })).toBe("Searching the vault");
  });
});

describe("describeActivity — unknown", () => {
  it("unknown tool falls back to Working…", () => {
    expect(describeActivity("SomeFutureTool", { x: 1 })).toBe("Working…");
  });
  it("null input is safe", () => {
    expect(describeActivity("Read", null)).toBe("Reading a note");
  });
});
