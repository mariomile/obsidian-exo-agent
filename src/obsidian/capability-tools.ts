/**
 * Capability self-management tools — the agentic half of the Capabilities hub.
 *
 * Everything the hub pane does with a click, the agent can do from chat: see
 * what's connected, add or fix an MCP server, install or remove a skill. The
 * pane and these tools share the same core (`mcp-config`, `connections-*`,
 * `capability-scan`), so neither can drift from the other.
 *
 * Reversibility, in descending order: disable is a toggle, remove takes a
 * config the tool prints back before deleting, and skill removal only ever
 * touches the vault copy — the source folder it was imported from is never
 * modified. Every mutating tool here gets a permission card (none of them are
 * in OBSIDIAN_READ_TOOLS).
 */
import { App } from "obsidian";
import * as z from "zod";
import { claudeSdk } from "../providers/sdk-loader";
import { homedir } from "os";
import { readFile } from "fs/promises";
import {
  scanCodexMcp,
  scanClaudeGlobalMcp,
  assignMcpState,
  scanSkillDirs,
  assignSkillState,
  scanLiveCaps,
  type ClaudeJson,
  type DiscoveryItem,
} from "../core/connections-scan";
import { connectMcp, disconnectMcp, setMcpEnabled, importSkill, removeSkill } from "../core/connections-install";
import { parseMcpJson, summarizeServer, buildServerConfig } from "../core/mcp-config";
import { mcpSections, skillSections } from "../core/hub-sections";
import { localScopeServers, markSkippedObsidianMcp } from "../core/mcp-guard";
import {
  gatherFromScopes,
  gatherFromVault,
  gatherOtherProjectSkills,
  gatherCodexSkills,
} from "../core/capability-scan";
import { automationLastRunKey, cadenceLabel, formatDueIn, nextDueAt } from "../core/automations";
import { mcpDocPath, isSafeDocName, summarizeMcpDoc, hasMcpDocContent } from "../core/mcp-docs";
import { ok, err, getExo, vaultBasePath, type ExoToolHost } from "./tool-kit";

const MCP_PATH = ".mcp.json";
const EMPTY_MCP = '{\n  "mcpServers": {}\n}';

/* ------------------------------ discovery ------------------------------ */

async function readMcpJson(app: App): Promise<string> {
  try {
    return await app.vault.adapter.read(MCP_PATH);
  } catch {
    return EMPTY_MCP; // no .mcp.json yet — the appliers create one
  }
}

/** Same gather the MCP tab runs, minus the DOM. */
async function gatherMcp(app: App, exo: ExoToolHost | null): Promise<{ items: DiscoveryItem[]; ourNames: Set<string> }> {
  const home = homedir();
  const caps = exo?.lastSessionCaps ?? null;

  let claudeJson: ClaudeJson = {};
  try { claudeJson = JSON.parse(await readFile(`${home}/.claude.json`, "utf8")) as ClaudeJson; } catch { /* absent */ }
  let codexToml = "";
  try { codexToml = await readFile(`${home}/.codex/config.toml`, "utf8"); } catch { /* absent */ }

  const liveStatus = new Map<string, string>((caps?.mcpServers ?? []).map((m) => [m.name, m.status]));
  const parsed = parseMcpJson(await readMcpJson(app));
  const vaultServers = parsed.error ? [] : parsed.servers;
  const ourNames = new Set(vaultServers.map((s) => s.name));
  const vaultItems: DiscoveryItem[] = vaultServers.map((s) => ({
    kind: "mcp",
    name: s.name,
    source: "vault",
    origin: "vault",
    state: "active",
    config: s.config,
    desc: summarizeServer(s.config),
    status: s.enabled ? liveStatus.get(s.name) ?? "unknown" : "disabled",
  }));

  const external = [...scanCodexMcp(codexToml), ...scanClaudeGlobalMcp(claudeJson)].filter((it) => !ourNames.has(it.name));
  const activeNames = new Set<string>([
    ...(caps?.mcpServers ?? []).map((m) => m.name),
    ...vaultServers.filter((s) => s.enabled).map((s) => s.name),
  ]);
  const inheritedNames = new Set<string>(Object.keys(claudeJson.mcpServers ?? {}));
  const fromConfig = assignMcpState(external, { activeNames, inheritedNames }).map((it) => ({
    ...it,
    status: liveStatus.get(it.name),
  }));
  const covered = new Set([...ourNames, ...fromConfig.map((i) => i.name)]);
  const live = scanLiveCaps(caps?.mcpServers ?? [], covered);
  const vaultBase = (app.vault.adapter as { getBasePath?(): string }).getBasePath?.() ?? "";
  const localNames = new Set(Object.keys(localScopeServers(claudeJson, vaultBase)));
  return { items: markSkippedObsidianMcp([...vaultItems, ...fromConfig, ...live], localNames), ourNames };
}

/** Same gather the Skills tab runs, minus the DOM. */
async function gatherSkills(app: App, exo: ExoToolHost | null): Promise<DiscoveryItem[]> {
  const home = homedir();
  const caps = exo?.lastSessionCaps ?? null;
  const dirs = [
    ...(await gatherOtherProjectSkills([`${home}/Dev Projects`, `${home}/Projects`])),
    await gatherCodexSkills(),
  ];
  const haveNames = new Set<string>([
    ...(caps?.skills ?? []),
    ...(await gatherFromScopes("skills")).map((s) => s.name),
  ]);
  const vaultNames = new Set<string>((await gatherFromVault(app, "skills")).map((s) => s.name));
  return assignSkillState(scanSkillDirs(dirs), haveNames, vaultNames);
}

/* ------------------------------ formatting ------------------------------ */

/** Read each server's notes — what it's for, scope, what to avoid. Absent or
 *  never-filled notes are simply omitted. */
async function readMcpDocs(app: App, names: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    names.map(async (name) => {
      if (!isSafeDocName(name)) return;
      try {
        const raw = await app.vault.adapter.read(mcpDocPath(name));
        if (hasMcpDocContent(raw)) out.set(name, summarizeMcpDoc(raw));
      } catch {
        /* no notes for this server */
      }
    })
  );
  return out;
}

function mcpReport(items: DiscoveryItem[], ourNames: Set<string>, docs: Map<string, string>): string[] {
  const s = mcpSections(items);
  const lines: string[] = ["MCP servers:"];
  if (!items.length) return [...lines, "  (none — add one with manage_mcp_server)"];
  const section = (label: string, list: DiscoveryItem[], note: string) => {
    if (!list.length) return;
    lines.push(`  ${label}:`);
    for (const it of list) {
      const status = !it.status || it.status === "connected" ? "active" : it.status;
      const owned = ourNames.has(it.name) ? " · vault-owned (editable)" : "";
      const noted = docs.has(it.name) ? " · has notes" : "";
      lines.push(`    - ${it.name} [${status}] ${it.desc ?? ""}${owned}${noted}`.trimEnd());
    }
    if (note) lines.push(`      ${note}`);
  };
  section("connected", s.connected, "");
  section("disabled", s.disabled, "");
  section("importable", s.importable, 'add with manage_mcp_server action:"add"');
  section("inherited", s.inherited, "already reaching Exo from their own config — nothing to do");
  section("skipped in Exo", s.skipped, "external Obsidian servers: Exo already reads the vault directly, use its own tools");
  return lines;
}

function skillReport(items: DiscoveryItem[]): string[] {
  const s = skillSections(items);
  const lines: string[] = ["Skills:"];
  if (s.vault.length) {
    lines.push("  in this vault:");
    for (const it of s.vault) lines.push(`    - ${it.name}${it.desc ? ` — ${it.desc}` : ""}`);
  }
  for (const g of s.groups) {
    lines.push(`  importable from ${g.origin}:`);
    for (const it of g.items) lines.push(`    - ${it.name}${it.desc ? ` — ${it.desc}` : ""}`);
  }
  if (s.haveCount) lines.push(`  ${s.haveCount} more already available to Exo globally (nothing to import).`);
  if (!s.vault.length && !s.groups.length && !s.haveCount) lines.push("  (none found)");
  return lines;
}

function automationReport(exo: ExoToolHost, now: number): string[] {
  const s = exo.settings;
  const lines: string[] = ["Automations:"];
  if (!s.automations.length) lines.push("  (none configured)");
  for (const a of s.automations) {
    const last = s.scheduledLastRun[automationLastRunKey(a)] ?? 0;
    const next = a.enabled ? ` · next ${formatDueIn(nextDueAt(a.cadence, last, now) - now)}` : "";
    lines.push(`  - ${a.name} — ${cadenceLabel(a.cadence)} · ${a.enabled ? "on" : "paused"} · ${a.write ? "writes" : "read-only"}${next}`);
  }
  lines.push(`Playbooks: ${s.customPrompts.map((p) => p.name).join(", ") || "(none)"}`);
  return lines;
}

/* -------------------------------- tools -------------------------------- */

export function buildCapabilityTools(app: App) {
  const { tool } = claudeSdk();
  const listCapabilities = tool(
    "list_capabilities",
    "Show what Exo currently has wired up: MCP servers (with live connection status and the notes describing what each is for), skills (in-vault, importable from other projects/Codex, or already global), automations and playbooks. Use it before changing anything with manage_mcp_server or manage_skill, before using an MCP server you haven't used in this conversation (its notes say what it's for and what to avoid), and whenever Mario asks what Exo can do or why a tool isn't available.",
    {
      kind: z.enum(["all", "mcp", "skills", "automations"]).optional(),
      /** Notes can be long; pull them only when they matter. */
      with_notes: z.boolean().optional(),
    },
    async (args) => {
      const exo = getExo(app);
      const kind = args.kind ?? "all";
      const out: string[] = [];
      if (kind === "all" || kind === "mcp") {
        const { items, ourNames } = await gatherMcp(app, exo);
        const docs = await readMcpDocs(app, items.map((i) => i.name));
        out.push(...mcpReport(items, ourNames, docs));
        if (args.with_notes) {
          for (const [name, body] of docs) {
            out.push("", `--- notes for ${name} ---`, body);
          }
        } else if (docs.size) {
          out.push("", `Notes available for: ${[...docs.keys()].join(", ")} — call again with with_notes: true to read them.`);
        }
      }
      if (kind === "all" || kind === "skills") {
        if (out.length) out.push("");
        out.push(...skillReport(await gatherSkills(app, exo)));
      }
      if (kind === "all" || kind === "automations") {
        if (out.length) out.push("");
        out.push(...(exo ? automationReport(exo, Date.now()) : ["Automations: Exo plugin not reachable."]));
      }
      if (!exo) out.push("", "(No live session snapshot — statuses come from config files on disk.)");
      return ok(out.join("\n"));
    }
  );

  const manageMcpServer = tool(
    "manage_mcp_server",
    'Add, edit, enable, disable, remove or reconnect an MCP server in this vault\'s .mcp.json. Run list_capabilities first and show Mario the exact server and config BEFORE calling this. For add/update pass transport ("stdio" needs command, "http"/"sse" need url). Enable/disable/remove/update only work on vault-owned servers — servers inherited from Claude global config or claude.ai connectors are managed at their own source. Applying a change respawns the session so tools appear or vanish immediately; the conversation survives.',
    {
      action: z.enum(["add", "update", "enable", "disable", "remove", "reconnect"]),
      name: z.string(),
      transport: z.enum(["stdio", "http", "sse"]).optional(),
      command: z.string().optional(),
      url: z.string().optional(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
    },
    async (a) => {
      const exo = getExo(app);
      if (!exo) return ok("Exo plugin not reachable.");
      const { items, ourNames } = await gatherMcp(app, exo);
      const known = items.find((i) => i.name === a.name);

      if (a.action === "reconnect") {
        const res = await exo.reloadMcpConnections();
        exo.refreshHub();
        return ok(res.ok ? "Reconnected — MCP servers re-attempted." : `Reconnect failed: ${res.error ?? "no active session."}`);
      }

      // Only servers WE wrote into .mcp.json can be edited/toggled/removed.
      if (a.action !== "add" && !ourNames.has(a.name)) {
        const where = known ? `it comes from ${known.origin}` : "it isn't configured in this vault";
        return ok(`"${a.name}" is not vault-owned — ${where}. Vault-owned servers: ${[...ourNames].join(", ") || "(none)"}.`);
      }
      if (a.action === "add" && ourNames.has(a.name)) {
        return ok(`"${a.name}" already exists in this vault — use action "update" to change it.`);
      }

      const raw = await readMcpJson(app);
      let next: string;
      try {
        if (a.action === "add" || a.action === "update") {
          const type = a.transport ?? (a.url ? "http" : "stdio");
          const built = buildServerConfig({
            name: a.name,
            type,
            target: (type === "stdio" ? a.command : a.url) ?? "",
            args: (a.args ?? []).join(" "),
            extraJson: a.env ? JSON.stringify(a.env) : "",
          });
          if ("error" in built) return err(`Invalid config: ${built.error}`);
          next = connectMcp(raw, built.name, built.config);
        } else if (a.action === "remove") {
          next = disconnectMcp(raw, a.name);
        } else {
          next = setMcpEnabled(raw, a.name, a.action === "enable");
        }
      } catch (e) {
        // The appliers refuse to overwrite an unparseable file rather than
        // clobbering hand-written config.
        return err(`Could not apply the change: ${e instanceof Error ? e.message : String(e)}`);
      }

      await app.vault.adapter.write(MCP_PATH, next);
      const res = await exo.reloadMcpConnections();
      exo.refreshHub();
      const verb = { add: "added", update: "updated", remove: "removed", enable: "enabled", disable: "disabled" }[a.action];
      return ok(`MCP server "${a.name}" ${verb}. ${res.ok ? "Session reconnected." : res.error ?? "Applies on the next session."}`);
    }
  );

  const manageSkill = tool(
    "manage_skill",
    'Install a skill into this vault (.claude/skills/) or remove the vault copy. Run list_capabilities first — import only works for skills listed as importable, and skills already available to Exo globally never need importing. Import copies the source folder; it never modifies or moves the original. Remove deletes only the vault copy. Confirm the skill name with Mario before calling this.',
    {
      action: z.enum(["import", "remove"]),
      name: z.string(),
      overwrite: z.boolean().optional(),
    },
    async (a) => {
      const exo = getExo(app);
      const base = vaultBasePath(app);
      if (!base) return err("No filesystem access to the vault (mobile adapter) — skills can't be managed here.");
      const dest = `${base}/.claude/skills/${a.name}`;
      const skills = await gatherSkills(app, exo);

      if (a.action === "remove") {
        const inVault = skills.find((s) => s.name === a.name && s.state === "active");
        if (!inVault) return ok(`"${a.name}" isn't installed in this vault — nothing to remove.`);
        await removeSkill(dest);
        exo?.refreshHub();
        return ok(`Removed the vault copy of "${a.name}". The source it was imported from is untouched.`);
      }

      const candidate = skills.find((s) => s.name === a.name && s.state === "importable");
      if (!candidate?.path) {
        const have = skills.find((s) => s.name === a.name);
        if (have?.state === "have") return ok(`"${a.name}" is already available to Exo globally — no import needed.`);
        if (have?.state === "active") return ok(`"${a.name}" is already installed in this vault.`);
        return ok(`No importable skill named "${a.name}". Run list_capabilities to see what's available.`);
      }
      const res = await importSkill(candidate.path, dest);
      if (res === "exists" && !a.overwrite) {
        return ok(`A skill folder named "${a.name}" already exists in the vault — pass overwrite: true to replace it.`);
      }
      if (res === "exists") await importSkill(candidate.path, dest, { overwrite: true });
      exo?.refreshHub();
      return ok(`Imported "${a.name}" from ${candidate.origin} into the vault. It loads on the next session.`);
    }
  );

  return [listCapabilities, manageMcpServer, manageSkill];
}

/** Read-only member of the family — safe to auto-allow. */
export const CAPABILITY_READ_TOOLS = new Set(["mcp__obsidian__list_capabilities"]);
