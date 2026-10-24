import { App } from "obsidian";
import { readdir, readFile, stat } from "fs/promises";
import { homedir } from "os";
import { parseLoopsFile, type LoopEntry } from "./open-loops";
import type { SkillDir } from "./connections-scan";
import { codexSkillNames } from "./capability-desc";
import { parseAgentBrain } from "./agents";

export interface NamedItem {
  name: string;
  desc?: string;
}

/** Descriptions are clamped for single-line rows. */
const DESC_CLAMP = 110;

export const BUILTIN_TOOLS = [
  "Read", "Write", "Edit", "MultiEdit", "Bash", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "Agent", "TodoWrite",
];
export const FILE_BUILTINS = new Set(["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS", "NotebookEdit"]);
export const NATIVE_READ = ["search_vault", "read_note", "get_backlinks", "get_neighborhood", "list_notes", "list_tags", "get_active_context"];
export const NATIVE_WRITE = ["create_note", "save_to_note", "update_frontmatter", "add_links", "open_note", "edit_note", "insert_at_cursor", "rename_note"];
export const NATIVE_MEMORY = ["capture_decision", "open_loop", "close_loop", "undo_memory_write"];

async function scanNames(dir: string): Promise<{ folders: string[]; mds: string[] }> {
  const out = { folders: [] as string[], mds: [] as string[] };
  try {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue; // .DS_Store, .system, .impeccable — never a skill/agent/command
      let isDir = e.isDirectory();
      // ~/.claude/skills is mostly symlinks (→ ~/.agents/skills); a symlink
      // Dirent reports isDirectory()===false, so stat() through the link or the
      // whole global skill catalog goes missing from every scan.
      if (!isDir && e.isSymbolicLink()) {
        try { isDir = (await stat(`${dir}/${e.name}`)).isDirectory(); } catch { /* dangling link */ }
      }
      if (isDir) out.folders.push(e.name);
      else if (e.name.endsWith(".md")) out.mds.push(e.name.replace(/\.md$/, ""));
    }
  } catch {
    /* missing dir */
  }
  return out;
}

/** Read `name:` / `description:` from a markdown file's frontmatter.
 *  Parsing is delegated to `parseAgentBrain` — the one agent-frontmatter reader
 *  shared with the registry and the composer's `@` index. */
async function readAgentMeta(file: string): Promise<NamedItem | null> {
  try {
    const raw = (await readFile(file, "utf8")).slice(0, 1500);
    const base = file.split("/").pop()!.replace(/\.md$/, "");
    const brain = parseAgentBrain(raw, base, "user", file);
    return { name: brain.name, desc: brain.description?.slice(0, DESC_CLAMP) };
  } catch {
    return null;
  }
}

export async function gatherFromScopes(sub: "skills" | "agents" | "commands"): Promise<NamedItem[]> {
  const seen = new Set<string>();
  const items: NamedItem[] = [];
  const roots = [`${homedir()}/.claude/${sub}`]; // global
  const add = (name: string, desc?: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    items.push({ name, desc });
  };
  for (const root of roots) {
    const { folders, mds } = await scanNames(root);
    for (const f of folders) add(f);
    for (const md of mds) {
      if (sub === "agents") {
        const meta = await readAgentMeta(`${root}/${md}.md`);
        add(meta?.name ?? md, meta?.desc);
      } else add(md);
    }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

/** Skills found in OTHER projects' .claude/skills dirs (not this vault, not
 *  global) — a source the hub's Skills tab can import from. */
export async function gatherOtherProjectSkills(roots: string[]): Promise<SkillDir[]> {
  const out: SkillDir[] = [];
  for (const root of roots) {
    const projects: string[] = [];
    try {
      for (const e of await readdir(root, { withFileTypes: true })) if (e.isDirectory()) projects.push(e.name);
    } catch {
      continue; // missing root — skip
    }
    for (const proj of projects) {
      const dir = `${root}/${proj}/.claude/skills`;
      const { folders } = await scanNames(dir);
      if (!folders.length) continue;
      const skills = [];
      for (const name of folders) {
        const meta = await readAgentMeta(`${dir}/${name}/SKILL.md`);
        skills.push({ name, path: `${dir}/${name}`, desc: meta?.desc });
      }
      out.push({ origin: proj, source: "other-project", skills });
    }
  }
  return out;
}

/** Codex-native skills under ~/.codex/skills — reuses the composer's scanner for
 *  names, enriches with desc/path. Mostly mirror the Claude set (deduped later). */
export async function gatherCodexSkills(): Promise<SkillDir> {
  const names = (await codexSkillNames()).filter((n) => !n.startsWith(".")); // .system etc. aren't skills
  const dir = `${homedir()}/.codex/skills`;
  const skills = [];
  for (const name of names) {
    const meta = await readAgentMeta(`${dir}/${name}/SKILL.md`);
    skills.push({ name, path: `${dir}/${name}`, desc: meta?.desc });
  }
  return { origin: "Codex", source: "codex", skills };
}

export async function gatherFromVault(app: App, sub: string): Promise<NamedItem[]> {
  const items: NamedItem[] = [];
  try {
    const res = await app.vault.adapter.list(`.claude/${sub}`);
    for (const f of res.folders) items.push({ name: f.split("/").pop() ?? f });
    for (const f of res.files) {
      if (!f.endsWith(".md")) continue;
      const base = f.split("/").pop()!.replace(/\.md$/, "");
      if (sub === "agents") {
        let item: NamedItem = { name: base };
        try {
          const brain = parseAgentBrain((await app.vault.adapter.read(f)).slice(0, 1500), base, "vault", f);
          item = { name: brain.name, desc: brain.description?.slice(0, DESC_CLAMP) };
        } catch {
          /* unreadable — fall back to the filename */
        }
        items.push(item);
      } else items.push({ name: base });
    }
  } catch {
    /* missing */
  }
  return items;
}

export function mergeByName(a: NamedItem[], b: NamedItem[]): NamedItem[] {
  const map = new Map<string, NamedItem>();
  for (const it of [...a, ...b]) if (!map.has(it.name)) map.set(it.name, it);
  return [...map.values()].sort((x, y) => x.name.localeCompare(y.name));
}

export async function gatherMcpServers(app: App): Promise<string[]> {
  const names = new Set<string>();
  const tryFile = async (path: string) => {
    try {
      const json = JSON.parse(await readFile(path, "utf8")) as { mcpServers?: Record<string, unknown> };
      for (const k of Object.keys(json.mcpServers ?? {})) names.add(k);
    } catch {
      /* missing / unreadable / not JSON — ignore */
    }
  };
  await tryFile(`${homedir()}/.claude.json`);
  // project .mcp.json lives at the vault root
  const base = (app.vault.adapter as unknown as { getBasePath?(): string }).getBasePath?.();
  if (base) await tryFile(`${base}/.mcp.json`);
  return [...names].sort();
}

export interface HookSummary {
  event: string; // PreToolUse, PostToolUse, SessionStart, Notification, …
  count: number; // number of matcher entries under that event
}

/** Read the `hooks` object from a Claude settings.json, tolerating missing/invalid JSON. */
export async function gatherHooks(path: string): Promise<HookSummary[]> {
  try {
    const json = JSON.parse(await readFile(path, "utf8")) as { hooks?: Record<string, unknown> };
    const out: HookSummary[] = [];
    for (const [event, matchers] of Object.entries(json.hooks ?? {})) {
      out.push({ event, count: Array.isArray(matchers) ? matchers.length : 0 });
    }
    return out;
  } catch {
    /* missing / unreadable / not JSON — ignore */
    return [];
  }
}

/** Read + parse the open-loops ledger (empty when absent/unreadable). */
export async function gatherLoops(app: App, loopsPath: string): Promise<LoopEntry[]> {
  try {
    if (await app.vault.adapter.exists(loopsPath)) {
      return parseLoopsFile(await app.vault.adapter.read(loopsPath));
    }
  } catch {
    /* missing/unreadable */
  }
  return [];
}
