import { describe, it, expect } from "vitest";
import { buildOpencodeConfig, type OpencodeConfigInput } from "../src/providers/opencode-config";
import { exoToolInput, exoToolName, hasInput, toolOutputText } from "../src/providers/opencode-tools";
import { parseOpencodeModels } from "../src/providers/opencode";
import { describeCliFailure } from "../src/core/errors";

const BASE: OpencodeConfigInput = {
  toolsEnabled: true,
  permissionMode: "default",
  instructions: ["/tmp/exo/instructions.md"],
  autoCompact: true,
};

describe("buildOpencodeConfig", () => {
  it("keeps the vault safe: no snapshots, formatters, LSP or auto-update", () => {
    const c = buildOpencodeConfig(BASE);
    expect(c).toMatchObject({ snapshots: false, formatter: false, lsp: false, update: "disable", share: "disabled" });
    expect(c.instructions).toEqual(["/tmp/exo/instructions.md"]);
    expect(c.compaction).toEqual({ auto: true });
  });

  it("asks Exo about every tool by default, apart from pure bookkeeping", () => {
    const rules = buildOpencodeConfig(BASE).permissions as { action: string; effect: string }[];
    expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "ask" });
    expect(rules.filter((r) => r.effect === "allow").map((r) => r.action)).toEqual(["todowrite", "todoread", "question"]);
  });

  it("denies everything with tools off, allows everything in bypass", () => {
    expect(buildOpencodeConfig({ ...BASE, toolsEnabled: false }).permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }]);
    expect(buildOpencodeConfig({ ...BASE, permissionMode: "bypassPermissions" }).permissions).toEqual([
      { action: "*", resource: "*", effect: "allow" },
    ]);
  });

  it("registers the Obsidian bridge over HTTP, with Code Mode off", () => {
    const c = buildOpencodeConfig({ ...BASE, bridge: { port: 4321, token: "tok" } });
    expect(c.mcp).toEqual({
      servers: {
        obsidian: {
          type: "remote",
          codemode: false,
          url: "http://127.0.0.1:4321/mcp",
          headers: { Authorization: "Bearer tok" },
          timeout: { startup: 10_000, execution: 3_600_000 },
        },
      },
    });
    expect(buildOpencodeConfig({ ...BASE, toolsEnabled: false, bridge: { port: 1, token: "t" } }).mcp).toBeUndefined();
  });

  it("omits instructions when there are none", () => {
    expect(buildOpencodeConfig({ ...BASE, instructions: [] })).not.toHaveProperty("instructions");
  });
});

describe("opencode tool translation", () => {
  it("maps opencode's built-in tools onto Exo's names", () => {
    expect(exoToolName({ name: "read" })).toBe("Read");
    expect(exoToolName({ name: "write" })).toBe("Write");
    expect(exoToolName({ name: "shell" })).toBe("Bash");
    expect(exoToolName({ name: "apply_patch" })).toBe("Edit");
    expect(exoToolName({ name: "task" })).toBe("Agent");
  });

  it("maps bridge tools to Exo's mcp__obsidian__ names", () => {
    expect(exoToolName({ name: "obsidian_read_note" })).toBe("mcp__obsidian__read_note");
    expect(exoToolName({ name: "obsidian__read_note" })).toBe("mcp__obsidian__read_note");
    expect(exoToolName({ name: "gmail_search" }, ["obsidian", "gmail"])).toBe("mcp__gmail__search");
  });

  it("keeps an unknown tool's own name, and falls back to its kind", () => {
    expect(exoToolName({ name: "execute" })).toBe("execute");
    expect(exoToolName({ kind: "execute" })).toBe("Bash");
    expect(exoToolName({ title: "mystery" })).toBe("mystery");
  });

  it("gives file tools an absolute file_path, preferring the location", () => {
    expect(exoToolInput("Read", { rawInput: { path: "./a.md" }, locations: [{ path: "/v/a.md" }] })).toEqual({
      path: "./a.md",
      file_path: "/v/a.md",
    });
    expect(exoToolInput("Edit", { rawInput: { filePath: "/v/b.md" } })).toMatchObject({ file_path: "/v/b.md" });
    expect(exoToolInput("Bash", { title: "ls", rawInput: { workdir: "/v" } })).toEqual({ workdir: "/v", command: "ls" });
  });

  it("knows when opencode has filled a call in", () => {
    expect(hasInput({ rawInput: {} })).toBe(false);
    expect(hasInput({ rawInput: { path: "x" } })).toBe(true);
  });

  it("reads a finished call's text output", () => {
    expect(toolOutputText({ content: [{ type: "content", content: { type: "text", text: "ok" } }] })).toBe("ok");
    expect(toolOutputText({ content: [{ type: "diff", path: "/v/a.md" }] })).toBe("Edited /v/a.md");
    expect(toolOutputText({ rawOutput: { output: "raw" } })).toBe("raw");
  });
});

describe("parseOpencodeModels", () => {
  it("reads one provider/model id per line and skips noise", () => {
    const out = "omlx/Qwen3.6-35B-A3B\nopencode/big-pickle\n\nWARN something\nomlx/Qwen3.6-35B-A3B\n";
    expect(parseOpencodeModels(out).map((m) => m.id)).toEqual(["omlx/Qwen3.6-35B-A3B", "opencode/big-pickle"]);
  });
});

describe("describeCliFailure for opencode", () => {
  const who = { name: "opencode", login: "opencode auth login", localModels: true };

  it("names the provider and its login command", () => {
    expect(describeCliFailure("Unauthorized", who)?.message).toContain("`opencode auth login`");
  });

  it("explains an unreachable local model server", () => {
    expect(describeCliFailure("connect ECONNREFUSED 127.0.0.1:11434", who)?.message).toBe("The model server isn't reachable.");
  });

  it("explains a missing model", () => {
    expect(describeCliFailure("session/prompt: ProviderModelNotFound", who)?.message).toBe("opencode has no usable model.");
  });

  it("leaves Claude's wording alone", () => {
    expect(describeCliFailure("connect ECONNREFUSED 127.0.0.1:443")).toBeNull();
    expect(describeCliFailure("not logged in")?.message).toContain("`claude auth login`");
  });
});
