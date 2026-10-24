import { describe, it, expect } from "vitest";
import { countRules, defaultRows, thisChatRows, type ChatSession } from "../src/core/session-summary";

const chat: ChatSession = { provider: "claude", model: "claude-opus-4-1", effort: "high", allowed: 2, mcp: null };

describe("thisChatRows", () => {
  it("shows what the chat runs with, including its own allow count", () => {
    const rows = thisChatRows(chat);
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ["Provider", "claude"],
      ["Model", "claude-opus-4-1"],
      ["Effort", "high"],
      ["Allowed in this chat", "2"],
    ]);
  });

  it("adds MCP status only once a session reported it", () => {
    const rows = thisChatRows({
      ...chat,
      mcp: [
        { name: "a", status: "connected" },
        { name: "b", status: "failed" },
      ],
    });
    expect(rows.at(-1)).toEqual({ label: "MCP servers", value: "1 connected · 1 need attention", ok: false });
    expect(thisChatRows({ ...chat, mcp: [{ name: "a", status: "connected" }] }).at(-1)?.ok).toBe(true);
  });

  it("says default for an unset model", () => {
    expect(thisChatRows({ ...chat, model: "" })[1].value).toBe("default");
  });
});

describe("defaultRows", () => {
  it("lists the defaults a new chat starts from and counts saved allow rules", () => {
    const rows = defaultRows({
      provider: "codex",
      model: "",
      effort: "medium",
      permissionMode: "default",
      toolsEnabled: true,
      fastStartup: false,
      permAllowRules: "Bash(git)\n# note\n\nRead\n",
    });
    expect(rows.map((r) => r.label)).toEqual([
      "Provider",
      "Default model",
      "Effort",
      "Permissions",
      "Agentic tools",
      "Fast startup",
      "Saved allow rules",
    ]);
    expect(rows[1].value).toBe("default");
    expect(rows.at(-1)?.value).toBe("2");
  });
});

describe("countRules", () => {
  it("skips blank lines and comments", () => {
    expect(countRules("")).toBe(0);
    expect(countRules("  # x\nWrite(notes/)\n")).toBe(1);
  });
});
