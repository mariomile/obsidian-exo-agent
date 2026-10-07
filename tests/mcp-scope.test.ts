import { describe, it, expect } from "vitest";
import { mcpDenyList, rememberMcpServers, serverToolPrefix, toolInMcpScope, unknownMcpNames } from "../src/core/mcp-scope";
import { contractFromAutomation, parseAutomationFile, serializeAutomation } from "../src/core/automation-model";

const file = (mcpLine: string | null) =>
  ["---", "name: Digest", 'when:\n  - "daily 07:00"', ...(mcpLine === null ? [] : [mcpLine]), "enabled: true", "---", "", "Body."].join("\n");

describe("mcp: in the automation file", () => {
  it("absent, empty and listed are three different states", () => {
    expect(parseAutomationFile("d", file(null)).automation.mcp).toBeUndefined();
    expect(parseAutomationFile("d", file("mcp: []")).automation.mcp).toEqual([]);
    expect(parseAutomationFile("d", file('mcp: ["claude.ai Gmail", "plugin:pdf-viewer:pdf"]')).automation.mcp).toEqual([
      "claude.ai Gmail",
      "plugin:pdf-viewer:pdf",
    ]);
  });

  it("round-trips each state and reaches the run contract", () => {
    for (const line of [null, "mcp: []", 'mcp: ["claude.ai Gmail", "claude.ai Google Calendar"]']) {
      const a = parseAutomationFile("d", file(line)).automation;
      const again = parseAutomationFile("d", serializeAutomation(a)).automation;
      expect(again.mcp).toEqual(a.mcp);
      expect(again.extra).toBeUndefined();
      expect(contractFromAutomation(again).mcp).toEqual(a.mcp);
    }
  });

  it("block-list form is read too", () => {
    expect(parseAutomationFile("d", file("mcp:\n  - perplexity")).automation.mcp).toEqual(["perplexity"]);
  });
});

describe("server filter", () => {
  const known = ["claude.ai Gmail", "claude.ai Slack", "playwright", "plugin:data:hex", "obsidian"];

  it("denies every known server except the allowed ones and Exo's own", () => {
    expect(mcpDenyList(known, ["claude.ai gmail"])).toEqual(["claude.ai Slack", "playwright", "plugin:data:hex"]);
    expect(mcpDenyList(known, [])).toEqual(["claude.ai Gmail", "claude.ai Slack", "playwright", "plugin:data:hex"]);
  });

  it("names tools the way the CLI does", () => {
    expect(serverToolPrefix("claude.ai Google Calendar")).toBe("mcp__claude_ai_Google_Calendar__");
    expect(serverToolPrefix("plugin:pdf-viewer:pdf")).toBe("mcp__plugin_pdf_viewer_pdf__");
  });

  it("gates tool calls by server, leaving built-ins and Exo's tools alone", () => {
    const allowed = ["claude.ai Gmail"];
    expect(toolInMcpScope("mcp__claude_ai_Gmail__search_threads", allowed)).toBe(true);
    expect(toolInMcpScope("mcp__claude_ai_Slack__slack_read_channel", allowed)).toBe(false);
    expect(toolInMcpScope("mcp__obsidian__read_note", [])).toBe(true);
    expect(toolInMcpScope("mcp__playwright__browser_click", [])).toBe(false);
    expect(toolInMcpScope("Read", [])).toBe(true);
    expect(toolInMcpScope("mcp__anything__x", undefined)).toBe(true);
  });

  it("flags names no known server has, without refusing them", () => {
    expect(unknownMcpNames(["claude.ai gmail", "Granola"], known)).toEqual(["Granola"]);
  });

  it("remembers new servers only, and says so", () => {
    expect(rememberMcpServers(["b"], ["b", "obsidian"])).toBeNull();
    expect(rememberMcpServers(["b"], ["a", "c"])).toEqual(["a", "b", "c"]);
  });
});
