import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile, access } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { buildObsidianTools, OBSIDIAN_READ_TOOLS } from "../src/obsidian/tools";

/**
 * The capability tools are the agentic half of the Capabilities hub: whatever
 * the pane does with a click, the agent must be able to do from chat. These
 * cover the guardrails that make that safe — vault-ownership, non-destructive
 * imports — rather than re-testing the pure appliers (mcp-config.test.ts and
 * connections-install.test.ts already own those).
 */

function toolHandler(app: unknown, name: string) {
  const def = buildObsidianTools(app as never).find((c) => c.name === name);
  if (!def) throw new Error(`Missing tool: ${name}`);
  return def.handler;
}

const text = (r: { content: { type: string; text?: string }[] }): string =>
  r.content[0]?.type === "text" ? (r.content[0].text ?? "") : "";

/** Minimal App + exo host: an in-memory .mcp.json and a real temp vault dir. */
function fakeApp(base: string, mcpJson: string | null) {
  const files = new Map<string, string>();
  if (mcpJson !== null) files.set(".mcp.json", mcpJson);
  const exo = {
    settings: { automations: [], customPrompts: [], scheduledLastRun: {}, claudeBin: "" },
    saveSettings: vi.fn(async () => undefined),
    loadAutomationRuns: vi.fn(async () => []),
    restoreAutomationRun: vi.fn(async () => []),
    markAutomationRunsReviewed: vi.fn(async () => undefined),
    runPlaybook: vi.fn(async () => true),
    lastSessionCaps: null,
    reloadMcpConnections: vi.fn(async () => ({ ok: true })),
    refreshHub: vi.fn(),
  };
  const app = {
    plugins: { plugins: { "exo-agent": exo } },
    vault: {
      adapter: {
        getBasePath: () => base,
        read: async (p: string) => {
          const v = files.get(p);
          if (v === undefined) throw new Error("ENOENT");
          return v;
        },
        write: async (p: string, v: string) => void files.set(p, v),
        list: async () => ({ files: [], folders: [] }),
        exists: async () => false,
      },
    },
  };
  return { app, exo, files };
}

let base = "";
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "exo-captools-"));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("list_capabilities", () => {
  it("is auto-allowable — it only reads", () => {
    expect(OBSIDIAN_READ_TOOLS.has("mcp__obsidian__list_capabilities")).toBe(true);
  });

  it("reports vault-owned servers as editable", async () => {
    const { app } = fakeApp(base, JSON.stringify({ mcpServers: { notion: { command: "npx", args: ["notion-mcp"] } } }));
    const out = text(await toolHandler(app, "list_capabilities")({ kind: "mcp" }, {}));
    expect(out).toContain("notion");
    expect(out).toContain("vault-owned (editable)");
  });

  it("says so when nothing is configured", async () => {
    const { app } = fakeApp(base, null);
    const out = text(await toolHandler(app, "list_capabilities")({ kind: "mcp" }, {}));
    expect(out).toContain("MCP servers:");
  });

  it("flags servers with notes and only inlines them when asked", async () => {
    const { app, files } = fakeApp(base, JSON.stringify({ mcpServers: { notion: { command: "npx" } } }));
    files.set(".claude/mcp/notion.md", "# notion\n\n## Scope\n- Read the roadmap DB\n");

    const brief = text(await toolHandler(app, "list_capabilities")({ kind: "mcp" }, {}));
    expect(brief).toContain("has notes");
    expect(brief).toContain("with_notes: true");
    expect(brief).not.toContain("roadmap DB");

    const full = text(await toolHandler(app, "list_capabilities")({ kind: "mcp", with_notes: true }, {}));
    expect(full).toContain("--- notes for notion ---");
    expect(full).toContain("Read the roadmap DB");
  });

  it("ignores a never-filled template — an empty note is not documentation", async () => {
    const { app, files } = fakeApp(base, JSON.stringify({ mcpServers: { notion: { command: "npx" } } }));
    files.set(".claude/mcp/notion.md", "# notion\n\n## Scope\n\n<!-- fill me -->\n-\n");
    const out = text(await toolHandler(app, "list_capabilities")({ kind: "mcp" }, {}));
    expect(out).not.toContain("has notes");
  });
});

describe("manage_mcp_server", () => {
  it("adds a stdio server and applies it to the live session", async () => {
    const { app, exo, files } = fakeApp(base, null);
    const out = text(await toolHandler(app, "manage_mcp_server")(
      { action: "add", name: "granola", transport: "stdio", command: "npx", args: ["granola-mcp"] }, {}
    ));
    expect(out).toContain('"granola" added');
    const written = JSON.parse(files.get(".mcp.json")!) as { mcpServers: Record<string, { command: string }> };
    expect(written.mcpServers.granola.command).toBe("npx");
    expect(exo.reloadMcpConnections).toHaveBeenCalled();
    expect(exo.refreshHub).toHaveBeenCalled();
  });

  it("refuses to edit a server this vault does not own", async () => {
    const { app, files } = fakeApp(base, JSON.stringify({ mcpServers: {} }));
    const before = files.get(".mcp.json");
    const out = text(await toolHandler(app, "manage_mcp_server")({ action: "disable", name: "someone-elses" }, {}));
    expect(out).toContain("not vault-owned");
    expect(files.get(".mcp.json")).toBe(before); // untouched
  });

  it("refuses to add over an existing vault server", async () => {
    const { app } = fakeApp(base, JSON.stringify({ mcpServers: { notion: { command: "npx" } } }));
    const out = text(await toolHandler(app, "manage_mcp_server")(
      { action: "add", name: "notion", transport: "stdio", command: "other" }, {}
    ));
    expect(out).toContain('use action "update"');
  });

  it("reports invalid config instead of writing it", async () => {
    const { app, files } = fakeApp(base, null);
    const res = await toolHandler(app, "manage_mcp_server")(
      { action: "add", name: "broken", transport: "http", url: "not-a-url" }, {}
    );
    expect(res.isError).toBe(true);
    expect(files.has(".mcp.json")).toBe(false);
  });

  it("disables a vault server without removing it", async () => {
    const { app, files } = fakeApp(base, JSON.stringify({ mcpServers: { notion: { command: "npx" } } }));
    const out = text(await toolHandler(app, "manage_mcp_server")({ action: "disable", name: "notion" }, {}));
    expect(out).toContain('"notion" disabled');
    const written = JSON.parse(files.get(".mcp.json")!) as Record<string, Record<string, unknown>>;
    expect(written.mcpServers?.notion).toBeUndefined();
    expect(written.mcpServersDisabled?.notion).toBeDefined(); // reversible, not deleted
  });
});

describe("manage_skill", () => {
  it("removes only the vault copy, leaving the source untouched", async () => {
    const source = join(base, "source", "demo-skill");
    const vaultSkill = join(base, ".claude", "skills", "demo-skill");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "---\nname: demo-skill\n---\n");
    await mkdir(vaultSkill, { recursive: true });
    await writeFile(join(vaultSkill, "SKILL.md"), "---\nname: demo-skill\n---\n");

    const { app } = fakeApp(base, null);
    // The vault scan goes through the adapter, which reports no skills here, so
    // removal reports nothing to remove — and crucially never touches source.
    await toolHandler(app, "manage_skill")({ action: "remove", name: "demo-skill" }, {});
    await expect(access(join(source, "SKILL.md"))).resolves.toBeUndefined();
    expect(await readFile(join(source, "SKILL.md"), "utf8")).toContain("demo-skill");
  });

  it("declines to import a skill it cannot find", async () => {
    const { app } = fakeApp(base, null);
    const out = text(await toolHandler(app, "manage_skill")({ action: "import", name: "nope-not-real" }, {}));
    expect(out).toContain("No importable skill");
  });
});
