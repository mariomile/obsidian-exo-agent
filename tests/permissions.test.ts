import { describe, expect, it } from "vitest";
import { matchPermRule, matchToolName, findToolRule, toolPermissionStatus, decidePermission, allowKey, permArgText, permRuleLine } from "../src/core/permissions";
import { buildChatList, type ChatRowSource } from "../src/core/chat-rows";

describe("matchPermRule", () => {
  it("matches Bash rules on command-token boundaries", () => {
    expect(matchPermRule("Bash(rm)", "Bash", "rm -rf x")).toBe(true);
    expect(matchPermRule("Bash(rm)", "Bash", "rmdir x")).toBe(false);
  });

  it("keeps generated file rules exact", () => {
    expect(matchPermRule("Write(Active/Foo.md)", "Write", "Active/Foo.md")).toBe(true);
    expect(matchPermRule("Write(Active/Foo.md)", "Write", "Active/Foo.md.bak")).toBe(false);
  });

  it("requires an explicit wildcard for path-prefix rules", () => {
    expect(matchPermRule("Write(Active/Project/*)", "Write", "Active/Project/note.md")).toBe(true);
    expect(matchPermRule("Write(Active/Project/*)", "Write", "Active/Other/note.md")).toBe(false);
  });

  it("governs a whole MCP source with one wildcard rule", () => {
    expect(matchPermRule("mcp__notion__*", "mcp__notion__search", "")).toBe(true);
    expect(matchPermRule("mcp__notion__*", "mcp__notion__create_pages", "")).toBe(true);
    expect(matchPermRule("mcp__notion__*", "mcp__linear__search", "")).toBe(false);
  });

  it("stops the source wildcard at a segment boundary", () => {
    // The neighbouring server whose name merely starts the same way.
    expect(matchPermRule("mcp__notion__*", "mcp__notion_admin__delete", "")).toBe(false);
    expect(matchPermRule("mcp__notion__*", "mcp__notionx__search", "")).toBe(false);
  });

  it("refuses a bare * — it would silently disable the permission card", () => {
    expect(matchPermRule("*", "Bash", "rm -rf /")).toBe(false);
    expect(matchPermRule("*", "mcp__notion__search", "")).toBe(false);
  });

  it("keeps non-wildcard tool names exact", () => {
    expect(matchPermRule("mcp__notion__search", "mcp__notion__search_all", "")).toBe(false);
  });

  it("still applies the argument filter under a tool wildcard", () => {
    expect(matchPermRule("mcp__obsidian__*(Active/Foo.md)", "mcp__obsidian__edit_note", "Active/Foo.md")).toBe(true);
    expect(matchPermRule("mcp__obsidian__*(Active/Foo.md)", "mcp__obsidian__edit_note", "Other.md")).toBe(false);
  });
});

describe("matchToolName", () => {
  it("is exact without a wildcard", () => {
    expect(matchToolName("Bash", "Bash")).toBe(true);
    expect(matchToolName("Bash", "BashOutput")).toBe(false);
  });

  it("covers the source's own bare name", () => {
    expect(matchToolName("mcp__notion__*", "mcp__notion")).toBe(true);
  });

  it("tolerates a wildcard written without the trailing separator", () => {
    expect(matchToolName("mcp__notion*", "mcp__notion__search")).toBe(true);
    expect(matchToolName("mcp__notion*", "mcp__notionx__search")).toBe(false);
  });
});

describe("decidePermission", () => {
  const base = {
    tool: "Bash",
    argText: "rm -rf x",
    isRead: false,
    isMemoryTool: false,
    alreadyAllowed: false,
    autoAllowRead: false,
    memoryWriteEnabled: true,
    permDenyRules: "",
    permAllowRules: "",
  };

  it("deny-rule wins over everything else, even when also auto-allow-eligible or a memory tool", () => {
    const outcome = decidePermission({
      ...base,
      tool: "mcp__obsidian__capture_learning",
      argText: "",
      isRead: true,
      isMemoryTool: true,
      alreadyAllowed: true,
      autoAllowRead: true,
      memoryWriteEnabled: false,
      permDenyRules: "mcp__obsidian__capture_learning",
      permAllowRules: "mcp__obsidian__capture_learning",
    });
    expect(outcome).toBe("deny-rule");
  });

  it("auto-allows via autoAllowRead && isRead", () => {
    const outcome = decidePermission({ ...base, tool: "Read", argText: "", isRead: true, autoAllowRead: true });
    expect(outcome).toBe("auto-allow");
  });

  it("auto-allows via alreadyAllowed", () => {
    const outcome = decidePermission({ ...base, alreadyAllowed: true });
    expect(outcome).toBe("auto-allow");
  });

  it("auto-allows via a matching permAllowRules entry", () => {
    const outcome = decidePermission({ ...base, permAllowRules: "Bash(rm)" });
    expect(outcome).toBe("auto-allow");
  });

  it("memory-denies only when isMemoryTool && !memoryWriteEnabled and nothing earlier matched", () => {
    const outcome = decidePermission({
      ...base,
      tool: "mcp__obsidian__capture_learning",
      argText: "",
      isMemoryTool: true,
      memoryWriteEnabled: false,
    });
    expect(outcome).toBe("memory-deny");
  });

  it("does not memory-deny when already allowed (auto-allow takes precedence)", () => {
    const outcome = decidePermission({
      ...base,
      tool: "mcp__obsidian__capture_learning",
      argText: "",
      isMemoryTool: true,
      memoryWriteEnabled: false,
      alreadyAllowed: true,
    });
    expect(outcome).toBe("auto-allow");
  });

  it("falls back to card when nothing else matches", () => {
    const outcome = decidePermission({ ...base, tool: "Edit", argText: "Active/Foo.md" });
    expect(outcome).toBe("card");
  });

  it("orders deny before allow: a deny rule beats a matching allow rule for the same tool/argText", () => {
    const outcome = decidePermission({
      ...base,
      permDenyRules: "Bash(rm)",
      permAllowRules: "Bash(rm)",
    });
    expect(outcome).toBe("deny-rule");
  });
});

describe("allowKey", () => {
  it("keys Bash by the leading command token", () => {
    expect(allowKey("Bash", { command: "rm -rf x" })).toBe("Bash:rm");
  });

  it("keys Bash as bare 'Bash' when the command is empty", () => {
    expect(allowKey("Bash", { command: "" })).toBe("Bash");
  });

  it("keys write tools by target file path", () => {
    expect(allowKey("Write", { file_path: "Active/Foo.md" })).toBe("Write:Active/Foo.md");
  });

  it("keys other tools by the bare tool name", () => {
    expect(allowKey("Read", { file_path: "Active/Foo.md" })).toBe("Read");
    expect(allowKey("mcp__obsidian__search_vault", { query: "x" })).toBe("mcp__obsidian__search_vault");
  });
});

describe("permArgText", () => {
  it("returns the full trimmed command for Bash", () => {
    expect(permArgText("Bash", { command: "  rm -rf x  " })).toBe("rm -rf x");
  });

  it("returns the target file path for write tools", () => {
    expect(permArgText("Write", { file_path: "Active/Foo.md" })).toBe("Active/Foo.md");
  });

  it("returns empty string for other tools", () => {
    expect(permArgText("Read", { file_path: "Active/Foo.md" })).toBe("");
  });
});

describe("permRuleLine", () => {
  it("produces Bash(token) for Bash commands", () => {
    expect(permRuleLine("Bash", { command: "rm -rf x" })).toBe("Bash(rm)");
  });

  it("produces bare Bash when the command is empty", () => {
    expect(permRuleLine("Bash", { command: "" })).toBe("Bash");
  });

  it("produces Tool(path) for write tools", () => {
    expect(permRuleLine("Write", { file_path: "Active/Foo.md" })).toBe("Write(Active/Foo.md)");
  });

  it("produces the bare tool name for other tools", () => {
    expect(permRuleLine("Read", { file_path: "Active/Foo.md" })).toBe("Read");
  });
});

describe("findToolRule", () => {
  it("returns the source-level rule that covers a server", () => {
    expect(findToolRule("Bash(rm)\nmcp__notion__*", "mcp__notion__")).toBe("mcp__notion__*");
  });

  it("ignores a rule naming one specific tool — it does not govern the source", () => {
    expect(findToolRule("mcp__notion__search", "mcp__notion__")).toBeNull();
  });

  it("skips comments and blank lines", () => {
    expect(findToolRule("# mcp__notion__*\n\n", "mcp__notion__")).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(findToolRule("mcp__linear__*", "mcp__notion__")).toBeNull();
  });
});

describe("toolPermissionStatus", () => {
  it("deny wins over allow", () => {
    expect(toolPermissionStatus("mcp__notion__search", "mcp__notion__*", "mcp__notion__search")).toBe("denied");
  });

  it("reports auto-allowed when only an allow rule matches", () => {
    expect(toolPermissionStatus("mcp__notion__search", "mcp__notion__*", "")).toBe("auto-allowed");
  });

  it("falls back to asks when nothing matches", () => {
    expect(toolPermissionStatus("mcp__notion__create_pages", "mcp__notion__search", "")).toBe("asks");
  });
});

describe("the inline decision path (chats sidebar)", () => {
  /** A conversation blocked on a permission prompt, as `listChatRows` reports
   *  it: still streaming (deriveLane's precedence), with the rule line the view
   *  computed from the open card. */
  const blockedOn = (tool: string, input: unknown): ChatRowSource => ({
    id: "c1",
    title: "Untitled",
    preview: "",
    provider: "claude",
    model: "opus",
    updatedAt: 1,
    archived: false,
    open: false,
    pinned: false,
    messageCount: 1,
    streaming: true,
    pendingPerm: true,
    pendingAsk: false,
    poisoned: false,
    stopped: false,
    hasMessages: true,
    permRule: permRuleLine(tool, input),
  });

  it("shows the row exactly the rule line the approval would grant", () => {
    // One source of truth: the sidebar must not paraphrase the rule — what the
    // row shows is what `permRuleLine` writes for the same call.
    const vm = buildChatList([blockedOn("Bash", { command: "git status" })], { query: "", now: 2 });
    expect(vm.blocked[0].permRule).toBe("Bash(git)");
    expect(vm.blocked[0].reason).toBe("perm");
  });

  it("scopes a write rule to the file, not the tool", () => {
    const vm = buildChatList([blockedOn("Write", { file_path: "Active/Foo.md" })], {
      query: "",
      now: 2,
    });
    expect(vm.blocked[0].permRule).toBe("Write(Active/Foo.md)");
  });
});
