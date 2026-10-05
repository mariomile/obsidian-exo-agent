import { App, TFile, getAllTags } from "obsidian";
import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { resolveLink, neighborhood, basename } from "./graph";
import { exoPaths, LEGACY_MEMORY_ROOT, type ExoPaths } from "../core/paths";
import { gatherConnections, linkMentionsIn, defaultExcludePrefixes } from "../mentions/connections";
import { loadIgnoreStore, ignoreMention } from "../mentions/ignore-store";
import { fold } from "../mentions/tokenizer";
import {
  formatLoop,
  parseLoopsFile,
  activeLoops,
  dueLoops,
  closeLoop,
  type LoopEntry,
} from "../core/open-loops";
import { WriteQueue } from "../core/write-queue";
import { EXO_CALLER, type AgentCaller } from "../core/agent-runs";
import { patchFrontmatter } from "../core/frontmatter-patch";
import { createBacklogTask, createChildTask, ChildTaskRefused, adaptAppToTaskVault } from "./task-store";
import { canSpawnChild, childrenOf } from "../core/child-tasks";
import { parseTasksFile } from "../core/tasks";
import { unreviewedWriteRuns } from "../core/automations";
import { parseDuration, formatDuration } from "../core/agents";
import {
  formatWhen,
  modeSentence,
  parseWhen,
  whenSentence,
  type Automation,
  type AutomationMode,
  DEFAULT_AUTOMATION_COOLDOWN_MS,
} from "../core/automation-model";
import { automationSlug } from "./automation-store";
import { ok, err, getExo, pluginInstance, type Result } from "./tool-kit";
import { buildCapabilityTools, CAPABILITY_READ_TOOLS } from "./capability-tools";
import { buildBrowserTools, BROWSER_READ_TOOLS, type BrowserBridge } from "./browser-tools";
import { buildCollaboTools, COLLABO_READ_TOOLS, collaboBridgeFrom } from "./collabo-tools";
import { toSdkTools, type AnyTool } from "./sdk-tool";
import { memoryCaps, type MemoryCaps } from "../core/memory-caps";
import { DEFAULT_SETTINGS } from "../settings-schema";
import { buildMemoryTools, MEMORY_READ_TOOLS } from "./memory-tools";
import { searchVaultNotes } from "./vault-search";

/** Tool-registry memory caps when the caller passes none: a chat with the
 *  default settings (tests and standalone callers). */
const DEFAULT_TOOL_MEMORY = memoryCaps(DEFAULT_SETTINGS, { surface: "chat" });


/** Structured question shape for `ask_user`. Duplicated from view.ts to avoid a
 *  view→tools import cycle (tools.ts must not import from view.ts). */
interface AskQuestion {
  question: string;
  header: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

/** A `rethink_memory` request handed to the view-side bridge. The tool has NOT
 *  yet decided the tier — the bridge resolves `planRethink`, enacts the write
 *  (now/human) or records a pending proposal card (persona), and returns a short
 *  status line for the model. Kept minimal to avoid a tools→view import cycle. */
export interface RethinkRequest {
  block: "SOUL" | "USER" | "NOW";
  content: string;
  rationale?: string;
}

const MAX_CONTENT = 8000;

/** AIditor's cross-plugin read/action API (when the aiditor plugin is enabled). */
interface AIditorAnnotation {
  id: string;
  notePath: string;
  quote: string;
  body: string;
  status: "active" | "resolved" | "orphaned";
}
interface AIditorApi {
  getAnnotations(filter?: { notePath?: string; status?: string | string[] }): AIditorAnnotation[];
  resolveAnnotation(id: string): boolean;
}
/** Resolve AIditor's public API off its plugin instance, or null when absent/disabled. */
function getAIditor(app: App): AIditorApi | null {
  const p = pluginInstance(app, "aiditor") as Partial<AIditorApi> | undefined;
  return p && typeof p.getAnnotations === "function" && typeof p.resolveAnnotation === "function"
    ? (p as AIditorApi)
    : null;
}

/** One-line rendering of an annotation for tool output — whitespace-collapsed, length-capped. */
function fmtAnnotation(a: AIditorAnnotation): string {
  const quote = a.quote.replace(/\s+/g, " ").trim().slice(0, 80);
  const body = a.body.replace(/\s+/g, " ").trim();
  return `- ${a.id} · ${a.status} · [[${a.notePath}]] · "${quote}" → ${body}`;
}

/** Sonar's cross-plugin action API (when the sonar plugin is enabled). Mirrors
 *  Obsidian's command palette: id, human title, owning plugin, and a
 *  destructive flag Sonar computes so callers can gate risky commands. */
interface SonarActionInfo {
  id: string;
  title: string;
  source: string;
  destructive: boolean;
}
interface SonarApi {
  getActions(): SonarActionInfo[];
  runAction(id: string): Promise<{ ok: boolean; destructive: boolean }>;
}
/** Resolve Sonar's public API off its plugin instance, or null when absent/disabled. */
function getSonar(app: App): SonarApi | null {
  const p = pluginInstance(app, "sonar") as Partial<SonarApi> | undefined;
  return p && typeof p.getActions === "function" && typeof p.runAction === "function"
    ? (p as SonarApi)
    : null;
}

/** One-line rendering of a Sonar action for tool output. */
function fmtSonarAction(a: SonarActionInfo): string {
  return `- ${a.id} · ${a.title} (${a.source})${a.destructive ? " ⚠ destructive" : ""}`;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled";
}
function today(): string {
  // Local date (not UTC) — toISOString() would roll to tomorrow late at night in +TZ.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Create any missing parent folders for a vault path (vault.create won't). */
async function ensureParentFolder(app: App, path: string): Promise<void> {
  const slash = path.lastIndexOf("/");
  if (slash <= 0) return;
  const dir = path.slice(0, slash);
  if (app.vault.getAbstractFileByPath(dir)) return;
  try {
    await app.vault.createFolder(dir);
  } catch {
    /* already exists (race) — fine */
  }
}

/** Options bag for {@link buildObsidianTools} and {@link createObsidianToolServer}:
 *  one field per gating/bridge input. */
export interface ObsidianToolOpts {
  /** Claude server only: load the tools up front instead of deferring them. */
  alwaysLoad?: boolean;
  /** What memory may do for this session (`memoryCaps(settings, env)`): the one
   *  gate for every memory tool below. Absent → chat defaults with the agent
   *  folder off (tests and standalone callers). */
  memory?: MemoryCaps;
  askBridge?: (questions: AskQuestion[]) => Promise<Record<string, string>>;
  loopsWriteQueue?: WriteQueue;
  orchestrationEnabled?: boolean;
  tasksWriteQueue?: WriteQueue;
  /** Convo id of the conversation this tool server belongs to. Present only
   *  for real chat sessions (never headless runs) — `spawn_task` is not
   *  registered without it, since a child with no parent has nobody to
   *  report to. */
  parentConvoId?: string;
  /** Per-convo bridge to the shared agent-browser tab. Absent → the browser_*
   *  tools are not registered at all (feature off, mobile, or headless run):
   *  the tool list must stay byte-identical to before the feature existed. */
  browserBridge?: BrowserBridge;
  rethinkBridge?: (req: RethinkRequest) => Promise<string>;
  /** Resolved memory-layer paths. Absent → the legacy root (test/fallback). */
  paths?: ExoPaths;
  /** Identity `invoke_agent` delegates as. Absent → Exo itself (chat). */
  agentCaller?: AgentCaller;
}

/**
 * Build the gated array of Obsidian-native tool definitions: graph
 * navigation, metadata-aware read/search, convention-aware writes, and
 * memory capture. Handlers run in-process and use the Obsidian API
 * (metadataCache/vault/fileManager) — no shell, graph- and frontmatter-aware.
 * Consumed directly by the Codex↔Obsidian bridge, and wrapped by
 * {@link createObsidianToolServer} for the Claude Agent SDK.
 */
export function buildObsidianTools(app: App, opts?: ObsidianToolOpts): AnyTool[] {
  const {
    memory = DEFAULT_TOOL_MEMORY,
    askBridge,
    loopsWriteQueue = new WriteQueue(),
    /** Orchestration Board master flag (default OFF). Gates `add_task` only —
     *  every other tool above is unaffected, and the tool list sent to sessions
     *  must be byte-identical to before this parameter existed when this is false. */
    orchestrationEnabled = false,
    /** Shared write-queue for the tasks ledger (`paths.tasks`),
     *  injected by the plugin the same way `loopsWriteQueue` is, so `add_task`
     *  and any future board-side writer serialize on the SAME queue. */
    tasksWriteQueue = new WriteQueue(),
    /** Convo id of the conversation this tool server belongs to. Absent for
     *  headless runs — `spawn_task` is gated on this being present, in
     *  addition to `orchestrationEnabled`. */
    parentConvoId,
    /** Bridge to the shared agent-browser tab, curried for THIS conversation by
     *  the plugin controller. Absent is the normal case: feature off, mobile, or
     *  a headless run, which must not drive a surface whose whole point is that
     *  Mario watches it. */
    browserBridge,
    /** View-side bridge that enacts a `rethink_memory` request: resolves the tier,
     *  writes the block directly (rationale surfaced for SOUL/USER), and renders
     *  the feed diff+undo. Absent → the tool is not registered. */
    rethinkBridge,
    paths = exoPaths(LEGACY_MEMORY_ROOT),
    agentCaller = EXO_CALLER,
  } = opts ?? {};
  const need = (target: string): TFile => {
    const f = resolveLink(app, target);
    if (!f) throw new Error(`Note not found: ${target}`);
    return f;
  };

  /** Serialized write path for the single-file Open-Loops Ledger. The plugin
   *  injects one shared instance across every conversation/session; the local
   *  default exists only for standalone tool registries in tests. */

  /* ----------------------------- read ----------------------------- */

  const searchVault = tool(
    "search_vault",
    "Full-text search across your vault — notes, and with Sonar also indexed attachments (PDF/HTML) and canvases. Returns ranked paths with snippets, using Sonar (BM25 + fuzzy) when installed and its index is ready, else a built-in scorer. Prefer this over Grep for vault content.",
    { query: z.string(), limit: z.number().optional() },
    async (args) => {
      const limit = Math.min(args.limit ?? 10, 30);
      const { hits, capped } = await searchVaultNotes(app, args.query, limit);
      if (hits.length === 0) return ok(`No matches for "${args.query}".`);
      const body = hits
        .map((h) => `- [[${h.path}]]: ${h.excerpt.replace(/\s+/g, " ").trim().slice(0, 160)}`)
        .join("\n");
      const note = capped
        ? `\n\n(Searched the ${capped.scanned} most recently edited notes of ${capped.total}. Install Sonar for full-vault search.)`
        : "";
      return ok(body + note);
    }
  );

  const readNote = tool(
    "read_note",
    "Read a note's content plus its metadata (frontmatter, tags, outgoing links). Accepts a wikilink or vault path.",
    { target: z.string() },
    async (args) => {
      const file = need(args.target);
      const cache = app.metadataCache.getFileCache(file);
      const tags = (cache && getAllTags(cache)) || [];
      const fm = cache?.frontmatter ?? {};
      let content = await app.vault.cachedRead(file);
      if (content.length > MAX_CONTENT) content = content.slice(0, MAX_CONTENT) + "\n… (truncated)";
      const meta = [
        `path: ${file.path}`,
        tags.length ? `tags: ${tags.join(", ")}` : "",
        Object.keys(fm).length ? `frontmatter: ${JSON.stringify(fm)}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return ok(`${meta}\n\n---\n${content}`);
    }
  );

  const getBacklinks = tool(
    "get_backlinks",
    "List the notes that link TO the given note.",
    { target: z.string() },
    async (args) => {
      const file = need(args.target);
      const bl = neighborhood(app, file).backlinks;
      return ok(bl.length ? bl.map((p) => `- [[${p}]]`).join("\n") : "No backlinks.");
    }
  );

  const getNeighborhood = tool(
    "get_neighborhood",
    "Get the graph neighborhood of a note: outgoing links, backlinks, and up/related frontmatter links.",
    { target: z.string() },
    async (args) => {
      const file = need(args.target);
      const n = neighborhood(app, file);
      const fmt = (xs: string[]) => (xs.length ? xs.map((p) => `  - [[${p}]]`).join("\n") : "  (none)");
      return ok(
        `Neighborhood of [[${file.path}]]:\n` +
          `outgoing:\n${fmt(n.outgoing)}\n` +
          `backlinks:\n${fmt(n.backlinks)}\n` +
          `related (up/related):\n${fmt(n.related)}`
      );
    }
  );

  const getConnections = tool(
    "get_connections",
    "Get a note's full connection picture: backlinks (Linked), up/related frontmatter (Related), and PLAIN-TEXT unlinked mentions elsewhere in the vault that aren't wikilinked yet (Unlinked, with a context snippet each). Use it to review a note's place in the graph and to judge which unlinked mentions are real references worth linking — then act with link_mentions or dismiss with ignore_mention. Accepts a wikilink/path; omit target for the active note.",
    { target: z.string().optional() },
    async (args) => {
      const file = args.target ? need(args.target) : app.workspace.getActiveFile();
      if (!file) return ok("No active note.");
      const ignore = await loadIgnoreStore(app, paths.mentions);
      const c = await gatherConnections(app, file, ignore, { excludePrefixes: defaultExcludePrefixes(paths.root) });
      const fmt = (xs: string[]) => (xs.length ? xs.map((p) => `  - [[${p}]]`).join("\n") : "  (none)");
      const unlinked = c.unlinked.length
        ? c.unlinked
            .map((u) => `  - [[${u.sourcePath}]] · ${u.ranges.length}× — "${u.snippet}"`)
            .join("\n")
        : "  (none)";
      return ok(
        `Connections for [[${file.path}]]:\n` +
          `Linked (backlinks):\n${fmt(c.linked)}\n` +
          `Related (up/related):\n${fmt(c.related)}\n` +
          `Unlinked mentions:\n${unlinked}`
      );
    }
  );

  const listNotes = tool(
    "list_notes",
    "List notes filtered by tag (e.g. '#domain/product') and/or folder prefix. Returns paths.",
    { tag: z.string().optional(), folder: z.string().optional(), limit: z.number().optional() },
    async (args) => {
      const limit = Math.min(args.limit ?? 50, 200);
      const wantTag = args.tag?.replace(/^#/, "");
      const out: string[] = [];
      for (const file of app.vault.getMarkdownFiles()) {
        if (args.folder && !file.path.startsWith(args.folder)) continue;
        if (wantTag) {
          const cache = app.metadataCache.getFileCache(file);
          const tags = (cache && getAllTags(cache)) || [];
          if (!tags.some((t) => t.replace(/^#/, "") === wantTag)) continue;
        }
        out.push(file.path);
        if (out.length >= limit) break;
      }
      return ok(out.length ? out.map((p) => `- [[${p}]]`).join("\n") : "No notes matched.");
    }
  );

  const listTags = tool(
    "list_tags",
    "List all tags in the vault with their note counts (most used first).",
    { limit: z.number().optional() },
    async (args) => {
      const counts = new Map<string, number>();
      for (const file of app.vault.getMarkdownFiles()) {
        const cache = app.metadataCache.getFileCache(file);
        for (const t of (cache && getAllTags(cache)) || []) counts.set(t, (counts.get(t) ?? 0) + 1);
      }
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, Math.min(args.limit ?? 60, 200));
      return ok(sorted.map(([t, c]) => `${t} (${c})`).join("\n") || "No tags.");
    }
  );

  const getActiveContext = tool(
    "get_active_context",
    "Get the note the user is currently viewing, the selected text (if any), its graph neighborhood, and any open AIditor comments Mario left on it. Treat those comments as Mario's margin notes — read them as context, and act on any that read as requests.",
    {},
    async () => {
      const file = app.workspace.getActiveFile();
      if (!file) return ok("No active note.");
      const n = neighborhood(app, file);
      const sel =
        app.workspace.activeEditor?.editor?.getSelection?.() ?? "";
      // Fold in the note's open annotations so the agent passively notices
      // comments whenever it orients on a note — no explicit call needed.
      const anns = getAIditor(app)?.getAnnotations({ notePath: file.path }) ?? [];
      const annText = anns.length
        ? `annotations (${anns.length} open — use list_annotations for the full set, resolve_annotation to close one):\n` +
          anns.slice(0, 8).map(fmtAnnotation).join("\n") + "\n"
        : "";
      return ok(
        `active: [[${file.path}]]\n` +
          (sel ? `selection:\n${sel}\n` : "") +
          annText +
          `related: ${[...n.related, ...n.backlinks].slice(0, 8).map(basename).join(", ") || "(none)"}`
      );
    }
  );

  const listAnnotations = tool(
    "list_annotations",
    "List AIditor margin comments Mario left on notes. Defaults to the active note and the open set (active + orphaned) — the comments awaiting attention. Pass scope:'vault' for every note, or notePath to target one; status 'resolved'/'all' to widen. Use it to read Mario's comments as context or enumerate open ones to act on, then close each with resolve_annotation.",
    {
      scope: z.enum(["note", "vault"]).optional(),
      notePath: z.string().optional(),
      status: z.enum(["open", "active", "orphaned", "resolved", "all"]).optional(),
    },
    async (args) => {
      const aiditor = getAIditor(app);
      if (!aiditor) return ok("AIditor plugin isn't enabled — no annotations available.");

      let notePath: string | undefined;
      if (args.notePath) {
        notePath = args.notePath;
      } else if ((args.scope ?? "note") === "note") {
        const f = app.workspace.getActiveFile();
        if (!f) return ok("No active note to read annotations from — pass scope:'vault' or a notePath.");
        notePath = f.path;
      }

      // 'open' (default) → omit status so aiditor applies its active+orphaned default.
      // 'all' → every status. Otherwise pass the single status through.
      const status = args.status ?? "open";
      const statusArg =
        status === "open" ? undefined : status === "all" ? ["active", "orphaned", "resolved"] : status;

      const anns = aiditor.getAnnotations({
        ...(notePath ? { notePath } : {}),
        ...(statusArg ? { status: statusArg } : {}),
      });
      if (!anns.length) {
        return ok(notePath ? `No matching annotations on [[${notePath}]].` : "No matching annotations.");
      }
      return ok(anns.map(fmtAnnotation).join("\n"));
    }
  );

  const listSonarActions = tool(
    "list_sonar_actions",
    "List runnable app commands via the Sonar plugin (Obsidian's command palette: every command from core and installed plugins). Use it when Mario asks to perform an app-level action — e.g. an intent handed off from Sonar's '?' mode like 'toggle the sidebar' or 'export this note' — to find the command id, then execute it with run_sonar_action. Pass query to filter (case-insensitive match on title/id/source).",
    { query: z.string().optional() },
    async (args) => {
      const sonar = getSonar(app);
      if (!sonar) return ok("Sonar plugin isn't enabled — no app actions available.");
      let actions = sonar.getActions();
      const q = args.query?.trim().toLowerCase();
      if (q) {
        actions = actions.filter((a) => `${a.title} ${a.id} ${a.source}`.toLowerCase().includes(q));
      }
      if (!actions.length) return ok(q ? `No actions match "${args.query}".` : "No actions available.");
      const CAP = 80;
      const lines = actions.slice(0, CAP).map(fmtSonarAction);
      if (actions.length > CAP) lines.push(`(+${actions.length - CAP} more — pass query to narrow)`);
      return ok(lines.join("\n"));
    }
  );

  const askUser = tool(
    "ask_user",
    "Ask the user structured questions with selectable options. Use this to resolve a genuine choice you can't infer — approach, scope, ambiguity between concrete options. Prefer it over asking in free text. Up to 4 questions; 2–6 options each; set multiSelect for multi-choice.",
    {
      questions: z
        .array(
          z.object({
            question: z.string(),
            header: z.string(),
            options: z
              // `preview` matches the built-in AskUserQuestion shape (aliased to
              // this tool) — accepted so aliased calls validate, ignored by the UI.
              .array(z.object({ label: z.string(), description: z.string().optional(), preview: z.string().optional() }))
              .min(2)
              .max(6),
            multiSelect: z.boolean().optional(),
          })
        )
        .min(1)
        .max(4),
    },
    async (args) => {
      if (!askBridge) return ok("No user is present (headless run) — proceed with your best judgment.");
      try {
        const answers = await askBridge(args.questions);
        return ok(JSON.stringify(answers));
      } catch (e) {
        return ok(`User dismissed the question — proceed with your best judgment. (${e instanceof Error ? e.message : ""})`);
      }
    }
  );

  /* ----------------------------- write ---------------------------- */

  const createNote = tool(
    "create_note",
    "Create a new note. Provide tags in frontmatter following the vault's tag system (#type/*, #domain/*). Fails if the note exists.",
    {
      path: z.string().describe("Vault path ending in .md"),
      content: z.string(),
      frontmatter: z.record(z.string(), z.any()).optional(),
    },
    async (args) => {
      const path = args.path.endsWith(".md") ? args.path : `${args.path}.md`;
      if (app.vault.getAbstractFileByPath(path)) return err(`Already exists: ${path}`);
      await ensureParentFolder(app, path);
      const fm = args.frontmatter ?? {};
      const hasTags = Object.prototype.hasOwnProperty.call(fm, "tags");
      await app.vault.create(path, patchFrontmatter(args.content, {
        ...fm,
        ...(hasTags ? {} : { tags: ["type/note"] }),
      }));
      return ok(`Created [[${path}]]`);
    }
  );

  const appendToNote = tool(
    "append_to_note",
    "Append text to the end of an existing note.",
    { target: z.string(), text: z.string() },
    async (args) => {
      const file = need(args.target);
      await app.vault.append(file, `\n${args.text}\n`);
      return ok(`Appended to [[${file.path}]]`);
    }
  );

  const updateFrontmatter = tool(
    "update_frontmatter",
    "Merge keys into a note's YAML frontmatter (safe, structure-preserving).",
    { target: z.string(), changes: z.record(z.string(), z.any()) },
    async (args) => {
      const file = need(args.target);
      await app.vault.process(file, (content) => patchFrontmatter(content, args.changes));
      return ok(`Updated frontmatter of [[${file.path}]]`);
    }
  );

  const addLinks = tool(
    "add_links",
    "Add wikilinks to a note's `related` frontmatter (deduped). Use to connect notes in the graph.",
    { target: z.string(), targets: z.array(z.string()) },
    async (args) => {
      const file = need(args.target);
      const cached: unknown = app.metadataCache.getFileCache(file)?.frontmatter?.related;
      const cur = new Set<string>(Array.isArray(cached) ? cached.map(String) : cached ? [String(cached)] : []);
      for (const t of args.targets) cur.add(`[[${t.replace(/^\[\[|\]\]$/g, "")}]]`);
      await app.vault.process(file, (content) => patchFrontmatter(content, { related: [...cur] }));
      return ok(`Linked ${args.targets.length} note(s) from [[${file.path}]]`);
    }
  );

  const linkMentions = tool(
    "link_mentions",
    "Turn plain-text mentions of `target` inside `source` into wikilinks — one link/undo-safe edit, every occurrence in that note. Use after get_connections when you've judged an unlinked mention a real reference. Surfaces that differ from the target name are piped (`[[Target|surface]]`) so the reading view is unchanged.",
    { source: z.string(), target: z.string() },
    async (args) => {
      const source = need(args.source);
      const target = need(args.target);
      const n = await linkMentionsIn(app, source, target);
      return n > 0
        ? ok(`Linked ${n} mention(s) of [[${target.basename}]] in [[${source.path}]].`)
        : ok(`No unlinked mentions of [[${target.basename}]] found in [[${source.path}]].`);
    }
  );

  const ignoreMentionTool = tool(
    "ignore_mention",
    "Dismiss an unlinked mention: stop offering to link `target` inside `source`, permanently (persisted). Use when a plain-text match is a coincidence or a reference you deliberately won't wikilink. Scoped to that one note — the mention still surfaces elsewhere.",
    { source: z.string(), target: z.string() },
    async (args) => {
      const source = need(args.source);
      const target = need(args.target);
      await ignoreMention(app, fold(target.basename), source.path, Date.now(), paths.mentions);
      return ok(`Ignoring mentions of [[${target.basename}]] in [[${source.path}]].`);
    }
  );

  const openNote = tool(
    "open_note",
    "Open a note in the Obsidian UI, replacing what's in the user's main workspace view. This is disruptive — call it ONLY when the user explicitly asked to open/see/jump to that note. Never call it as a courtesy after writing, creating, or finding a note: those results are already visible in the chat, and switching the user's view uninvited interrupts whatever they're doing in the main pane.",
    { target: z.string() },
    async (args) => {
      await app.workspace.openLinkText(args.target.replace(/^\[\[|\]\]$/g, ""), "", false);
      return ok(`Opened ${args.target}`);
    }
  );

  const editNote = tool(
    "edit_note",
    "Replace text in an existing note (Obsidian-native, link/frontmatter-safe). Fails if old_string is absent, or ambiguous unless replace_all is set. Prefer this over the built-in Edit for vault notes.",
    { target: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() },
    async (args) => {
      const file = need(args.target);
      // One atomic read-modify-write: an edit typed into the note meanwhile is
      // the content we patch, never content we overwrite.
      let refusal: Result | null = null;
      await app.vault.process(file, (content) => {
        const count = args.old_string ? content.split(args.old_string).length - 1 : 0;
        if (count === 0) refusal = err(`Text not found in ${file.path}.`);
        else if (count > 1 && !args.replace_all) refusal = err(`old_string appears ${count}× — pass replace_all or make it unique.`);
        if (refusal) return content;
        if (args.replace_all) return content.split(args.old_string).join(args.new_string);
        const i = content.indexOf(args.old_string);
        return content.slice(0, i) + args.new_string + content.slice(i + args.old_string.length);
      });
      return refusal ?? ok(`Edited [[${file.path}]]`);
    }
  );

  const insertAtCursor = tool(
    "insert_at_cursor",
    "Insert text at the user's cursor in the active note (replaces the current selection if any). Use to write directly where the user is working.",
    { text: z.string() },
    async (args) => {
      const editor = app.workspace.activeEditor?.editor;
      if (!editor) return err("No active editor to insert into.");
      editor.replaceSelection(args.text);
      return ok("Inserted at cursor.");
    }
  );

  const renameNote = tool(
    "rename_note",
    "Rename or move a note, updating all backlinks across the vault (Obsidian-native). Fails if the destination already exists.",
    { target: z.string(), new_path: z.string() },
    async (args) => {
      const file = need(args.target);
      const dest = args.new_path.endsWith(".md") ? args.new_path : `${args.new_path}.md`;
      if (app.vault.getAbstractFileByPath(dest)) return err(`Already exists: ${dest}`);
      await ensureParentFolder(app, dest);
      await app.fileManager.renameFile(file, dest);
      return ok(`Renamed to [[${dest}]]`);
    }
  );

  const resolveAnnotation = tool(
    "resolve_annotation",
    "Mark an AIditor comment resolved by id (from list_annotations or get_active_context) — use once you've acted on what the comment asked for. The comment is archived, not deleted, and disappears from the open set.",
    { id: z.string() },
    async (args) => {
      const aiditor = getAIditor(app);
      if (!aiditor) return err("AIditor plugin isn't enabled — nothing to resolve.");
      const done = aiditor.resolveAnnotation(args.id);
      return done ? ok(`Resolved annotation ${args.id}.`) : err(`No annotation with id ${args.id}.`);
    }
  );

  const runSonarAction = tool(
    "run_sonar_action",
    "Execute an app command by id via the Sonar plugin (ids come from list_sonar_actions). This closes the loop on Sonar's '?' intent mode: find the matching command, then run it. Actions flagged '⚠ destructive' delete or overwrite data — confirm with Mario before running one unless he explicitly asked for exactly that action.",
    { id: z.string() },
    async (args) => {
      const sonar = getSonar(app);
      if (!sonar) return err("Sonar plugin isn't enabled — can't run app actions.");
      const res = await sonar.runAction(args.id);
      if (!res.ok) return err(`No action with id ${args.id} — check list_sonar_actions for the exact id.`);
      return ok(`Ran ${args.id}.${res.destructive ? " (was flagged destructive)" : ""}`);
    }
  );

  /* --------------------------- memory ----------------------------- */

  const captureDecision = tool(
    "capture_decision",
    `Record a decision into ${paths.decisions}/ following the vault's decision-record convention.`,
    {
      title: z.string(),
      context: z.string(),
      decision: z.string(),
      rationale: z.string(),
      options: z.string().optional(),
      revisit: z.string().optional(),
      domain: z.string().optional(),
    },
    async (args) => {
      const path = `${paths.decisions}/${today()}-${slugify(args.title)}.md`;
      if (app.vault.getAbstractFileByPath(path)) return err(`Already exists: ${path}`);
      await ensureParentFolder(app, path);
      const body =
        `# Decision: ${args.title}\n\n` +
        `## Contesto\n${args.context}\n\n` +
        (args.options ? `## Opzioni considerate\n${args.options}\n\n` : "") +
        `## Decisione\n${args.decision}\n\n` +
        `## Razionale\n${args.rationale}\n\n` +
        (args.revisit ? `## Revisitare se\n${args.revisit}\n` : "");
      const file = await app.vault.create(path, body);
      await app.fileManager.processFrontMatter(file, (f: Record<string, unknown>) => {
        f.type = "decision";
        f.created_by = "exo";
        f.created = today();
        f.tags = ["type/decision", ...(args.domain ? [`domain/${args.domain.replace(/^#?domain\//, "")}`] : [])];
      });
      return ok(`Captured decision → [[${path}]]`);
    }
  );

  /* ------------------- agent identity (rethink) ------------------- */

  const rethinkMemory = tool(
    "rethink_memory",
    "Rewrite one shared-kernel block when your MODEL OF THE WORLD changes, not for single facts (those land in the vault automatically after the chat). `NOW.md` = what matters right now (hot projects, focus); `USER.md` = your distilled working model of the user; `SOUL.md` = shared operating principles. Pass a `rationale` for USER.md and SOUL.md: it's surfaced with the change in the feed, where the user reviews and can undo. Pass the WHOLE new block content, not a patch.",
    {
      block: z.enum(["SOUL", "USER", "NOW"]),
      new_content: z.string().describe("The complete new content for the block (replaces it whole; never truncated)."),
      rationale: z.string().optional().describe("Why the change — required for USER.md and SOUL.md, surfaced prominently in the change."),
    },
    async (args) => {
      if (!rethinkBridge) return err("The agent identity layer is off.");
      try {
        const status = await rethinkBridge({
          block: args.block,
          content: args.new_content,
          ...(args.rationale ? { rationale: args.rationale } : {}),
        });
        return ok(status);
      } catch (e) {
        return err(`Couldn't rethink ${args.block}.md: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  /* --------------------------- open loops -------------------------- */

  /** `YYYY-MM-DD`, matching the ledger's on-disk tickler-date format. */
  const RESURFACE_RE = /^\d{4}-\d{2}-\d{2}$/;

  async function readLoops(): Promise<LoopEntry[]> {
    const f = app.vault.getAbstractFileByPath(paths.openLoops);
    if (!(f instanceof TFile)) return [];
    try {
      return parseLoopsFile(await app.vault.cachedRead(f));
    } catch {
      return [];
    }
  }

  const openLoop = tool(
    "open_loop",
    "Record an open loop — a follow-up, promise, or thing to circle back on — in the Open-Loops Ledger. Optionally set a `resurface` tickler date (YYYY-MM-DD) for when it should come back up; omit it to make the loop due immediately.",
    {
      title: z.string(),
      context: z.string().describe("The verbatim context — what this loop is about, stored as-is."),
      resurface: z
        .string()
        .regex(RESURFACE_RE, "resurface must be YYYY-MM-DD")
        .optional(),
      tags: z.array(z.string()).optional(),
    },
    async (args) => {
      const openedAt = Date.now();
      const entry: LoopEntry = {
        id: `loop-${openedAt}`,
        title: args.title,
        note: args.context,
        openedAt,
        status: "open",
        ...(args.resurface ? { resurface: args.resurface } : {}),
        ...(args.tags && args.tags.length ? { tags: args.tags } : {}),
      };
      const block = formatLoop(entry);
      await loopsWriteQueue.enqueue(async () => {
        const existing = app.vault.getAbstractFileByPath(paths.openLoops);
        if (existing instanceof TFile) {
          await app.vault.process(existing, (cur) => `${cur.replace(/\s+$/, "")}\n\n${block}\n`);
        } else {
          await ensureParentFolder(app, paths.openLoops);
          await app.vault.create(paths.openLoops, `${block}\n`);
        }
      });
      return ok(`Opened ${entry.id}: ${entry.title}${entry.resurface ? ` (resurfaces ${entry.resurface})` : ""}.`);
    }
  );

  const closeLoopTool = tool(
    "close_loop",
    "Close an open loop by id (from `open_loop` or `list_loops`). The entry is never deleted — it's kept in the ledger with status=closed and, if given, an appended outcome note.",
    { id: z.string(), outcome: z.string().optional() },
    async (args) => {
      let result: Result | undefined;
      await loopsWriteQueue.enqueue(async () => {
        const f = app.vault.getAbstractFileByPath(paths.openLoops);
        if (!(f instanceof TFile)) {
          result = err(`No open-loops ledger yet — nothing to close.`);
          return;
        }
        await app.vault.process(f, (cur) => {
          let closed: LoopEntry[];
          try {
            closed = closeLoop(parseLoopsFile(cur), args.id, args.outcome);
          } catch {
            result = err(`No loop found with id ${args.id}.`);
            return cur;
          }
          result = ok(`Closed ${args.id}.`);
          return `${closed.map(formatLoop).join("\n\n")}\n`;
        });
      });
      return result ?? err("Failed to close loop.");
    }
  );

  const listLoops = tool(
    "list_loops",
    "List open loops from the Open-Loops Ledger — due ones first, then other active ones. Read-only.",
    {},
    async () => {
      const entries = await readLoops();
      const due = dueLoops(entries);
      const dueIds = new Set(due.map((e) => e.id));
      const others = activeLoops(entries).filter((e) => !dueIds.has(e.id));
      if (due.length === 0 && others.length === 0) return ok("No open loops.");
      const line = (e: LoopEntry, label: string) =>
        `- [${label}] ${e.id} — ${e.title}${e.resurface ? ` (resurface: ${e.resurface})` : ""}`;
      const body = [
        ...due.map((e) => line(e, "due")),
        ...others.map((e) => line(e, "open")),
      ].join("\n");
      return ok(body);
    }
  );

  /* --------------------------- orchestration ------------------------ */

  const addTask = tool(
    "add_task",
    "Put something on the Orchestration Board as a backlog task — use this when the user asks to put this on the board, turn this into a task, or queue this up for later instead of doing it in this conversation right now. Creates a `backlog` entry; it does not run anything.",
    {
      title: z.string().describe("Short task title shown on the board card."),
      prompt: z.string().describe("The task prompt — what the spawned conversation should do, verbatim."),
      model: z.string().optional().describe("Provider model id to run the task with; omit to use the default from settings."),
    },
    async (args) => {
      const vault = adaptAppToTaskVault(app);
      const entry = await createBacklogTask(vault, tasksWriteQueue, {
        title: args.title,
        prompt: args.prompt,
        ...(args.model ? { model: args.model } : {}),
      });
      return ok(`Added ${entry.id} to the Backlog: ${entry.title}`);
    }
  );

  const spawnTask = tool(
    "spawn_task",
    "Delegate a piece of work to a separate child conversation that runs in parallel with this one. Use it when the work is self-contained and would otherwise crowd this thread — research a source, draft a section, check a dataset. The child runs as a normal chat (so it can ask Mario for permission) and reports its outcome back here when it finishes. IMPORTANT: the Orchestration Board owns the scheduler, so it must be OPEN for a delegated task to run at all — with the board closed the task is written to the ledger and simply waits there, and nothing will report back. Say so if Mario seems to be expecting results. Prefer doing small work yourself: each child is a whole conversation Mario has to supervise.",
    {
      title: z.string().describe("Short title shown on the board card and in the sidebar."),
      prompt: z.string().describe("The full instruction for the child conversation — it does not see this chat's history."),
      model: z.string().optional().describe("Provider model id for the child; omit for the default."),
    },
    async (args) => {
      if (!parentConvoId) return ok("Delegation is unavailable in this session.");
      const vault = adaptAppToTaskVault(app);
      try {
        const entry = await createChildTask(
          vault,
          tasksWriteQueue,
          {
            title: args.title,
            prompt: args.prompt,
            parent: parentConvoId,
            ...(args.model ? { model: args.model } : {}),
          },
          paths.tasks,
          // Evaluated INSIDE createChildTask's own queued turn, against a
          // read taken that same turn — never a snapshot from before this
          // call was enqueued. That's what keeps N concurrent spawn_task
          // calls (one assistant turn, several parallel tool blocks) from
          // all passing the same stale "N < cap" check simultaneously.
          (tasks) => canSpawnChild(tasks, parentConvoId)
        );
        return ok(
          `Queued child task ${entry.id}: ${entry.title}. It starts when the Orchestration Board is open and has a free slot, and reports back here when it is done. If the board is closed nothing runs — the task waits in the ledger.`
        );
      } catch (e) {
        // A cap/depth refusal is expected traffic, not a failure — surface the
        // gate's own reason verbatim as a normal result so the agent reads it
        // as an answer instead of retrying the tool call.
        if (e instanceof ChildTaskRefused) return ok(e.reason);
        throw e;
      }
    }
  );

  const listTasks = tool(
    "list_tasks",
    "List tasks on the Orchestration Board. By default it shows only the child tasks this conversation delegated, with their current status — use it to check on work you handed off before reporting to Mario.",
    {
      all: z.boolean().optional().describe("List every task on the board instead of only this conversation's children."),
    },
    async (args) => {
      const vault = adaptAppToTaskVault(app);
      const existing = vault.getFile(paths.tasks);
      const tasks = parseTasksFile(existing ? await vault.read(paths.tasks) : "");
      const shown = args.all ? tasks : parentConvoId ? childrenOf(tasks, parentConvoId) : [];
      if (!shown.length) return ok(args.all ? "The board is empty." : "This conversation has not delegated any tasks.");
      return ok(
        shown
          .map((t) => `- ${t.id} · ${t.status} · ${t.title}${t.convo ? "" : " (not started yet)"}`)
          .join("\n")
      );
    }
  );

  /* ------------------------- automations (exo) ------------------------- */
  // Chat-side management of scheduled playbook runs — the same operations as
  // the Automations panel, so "metti in pausa il digest" works as a sentence.
  // All four resolve the live exo plugin instance at call time (never cached).

  // Named agents. Read-only by design in this milestone: the model can see who
  // exists and what each one is allowed to do, but binding a turn to an agent
  // stays a human action in the composer (`@agent` / `/as`).
  const listAgents = tool(
    "list_agents",
    "List Exo's named agents: what each one does, whether it is enabled, its autonomy tier (notify/propose/act), its read/write scope and its triggers. Use it when Mario asks which agents exist, before suggesting he delegate something, or to check what an agent is allowed to touch.",
    {},
    async () => {
      const exo = getExo(app);
      if (!exo) return ok("Exo plugin not reachable.");
      if (!(await exo.agentsReady())) return ok("Named agents are disabled in Exo settings.");
      const agents = exo.agentStore.list();
      if (!agents.length) return ok("No agents found. Canonical vault agents live in `_system/agents/<slug>/` bundles.");
      const autos = exo.automationStore.list();
      const lines = agents.map(({ brain }) => {
        const auto = autos.find((a) => a.agent === brain.slug);
        const say = auto
          ? `${auto.enabled ? "automated" : "automation paused"} · ${auto.when.map(whenSentence).join(" · ") || "no when-lines"} · ${modeSentence(auto.mode)}`
          : "mention/manual only";
        return [
          `- ${brain.name} (@${brain.slug}) — ${say}`,
          brain.description ? `    ${brain.description}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      });
      const orphans = exo.agentStore.orphans();
      if (orphans.length) lines.push("", `Contracts with no prompt file: ${orphans.join(", ")}`);
      return ok(lines.join("\n"));
    }
  );

  const invokeAgent = tool(
    "invoke_agent",
    "Hand a specific task to another named agent and wait for its result. Use when the work belongs to a different agent's domain (research, CRM, content) rather than doing it yourself. The call is refused unless the calling agent lists the target in its `can_call`, and delegation depth is capped — so a refusal is a configuration answer, not something to retry or work around.",
    {
      agent: z.string().describe("Slug or name of the agent to invoke."),
      task: z.string().describe("The specific task, written as an instruction. Not the agent's standing job."),
    },
    async ({ agent, task }) => {
      const exo = getExo(app);
      if (!exo) return ok("Exo plugin not reachable.");
      return ok(await exo.invokeAgentFromAgent(agent, task, agentCaller));
    }
  );

  const manageAgent = tool(
    "manage_agent",
    "Change how a named agent runs unattended by editing its automation file: on/off, mode (report | propose | act), cooldown, write scope, delegation allowlist, or its when-lines. When the agent has no automation yet, one is created. `when` replaces the whole list and uses the readable form: `daily 08:00`, `weekly mon 07:00`, `hourly`, `on create in _inbox/**`, `on tag #x`. Setting mode `act` or widening `write` lets the agent edit notes unattended — confirm with Mario before doing either.",
    {
      agent: z.string().describe("Slug or name of the agent."),
      enabled: z.boolean().optional(),
      mode: z.enum(["report", "propose", "act"]).optional(),
      cooldown: z.string().optional().describe("e.g. 30m, 2h, 1d"),
      write: z.array(z.string()).optional().describe("Replaces the write scope. [] means no autonomous writes."),
      can_call: z.array(z.string()).optional().describe("Replaces the delegation allowlist."),
      when: z.array(z.string()).optional().describe("Replaces every when-line. [] leaves the agent mention/manual-only."),
    },
    async (args) => {
      const exo = getExo(app);
      if (!exo) return ok("Exo plugin not reachable.");
      if (!(await exo.agentsReady())) return ok("Named agents are disabled in Exo settings.");
      const found = exo.agentStore.resolve(args.agent);
      if (!found) return err(`No agent named "${args.agent}".`);

      const store = exo.automationStore;
      const slug = found.brain.slug;
      const existing = store.list().find((a) => a.agent === slug) ?? null;
      const a: Automation = existing
        ? { ...existing, when: [...existing.when], scope: [...existing.scope], canCall: [...existing.canCall] }
        : {
            slug,
            name: found.brain.name,
            description: found.brain.description ?? "",
            icon: "bot",
            when: [],
            mode: "report",
            scope: [],
            canCall: [],
            cooldownMs: DEFAULT_AUTOMATION_COOLDOWN_MS,
            enabled: false,
            agent: slug,
            prompt: "",
          };
      const changed: string[] = [];

      if (args.enabled !== undefined && args.enabled !== a.enabled) {
        a.enabled = args.enabled;
        changed.push(args.enabled ? "enabled" : "disabled");
      }
      if (args.mode && args.mode !== a.mode) {
        a.mode = args.mode;
        changed.push(`mode → ${args.mode}`);
      }
      if (args.cooldown) {
        const ms = parseDuration(args.cooldown);
        if (ms === null) return err(`Unparseable cooldown "${args.cooldown}" — use forms like 30m, 2h, 1d.`);
        a.cooldownMs = ms;
        changed.push(`cooldown → ${formatDuration(ms)}`);
      }
      if (args.write) {
        a.scope = args.write;
        changed.push(`write → ${args.write.join(", ") || "(none)"}`);
      }
      if (args.can_call) {
        a.canCall = args.can_call.filter((x) => x !== slug);
        changed.push(`can_call → ${a.canCall.join(", ") || "(none)"}`);
      }
      if (args.when) {
        const parsed = [];
        for (const line of args.when) {
          const w = parseWhen(line);
          // Refuse the whole edit rather than silently dropping a line the
          // user believes they just set.
          if (!w) return err(`Unparseable when "${line}". Use forms like: daily 08:00 · weekly mon 07:00 · hourly · on create in _inbox/** · on tag #x`);
          parsed.push(w);
        }
        a.when = parsed;
        changed.push(`when → ${parsed.map(formatWhen).join(" · ") || "(manual only)"}`);
      }

      if (!changed.length) return ok(`${found.brain.name} already matches that — nothing changed.`);
      await store.save(a);
      await exo.refreshAgentsUI();
      const warn =
        a.mode === "act" && a.scope.length === 0
          ? " Note: mode is `act` but the write scope is empty, so every write will still be refused."
          : "";
      return ok(`${found.brain.name}: ${changed.join(", ")}. Saved to ${store.filePath(a.slug)}.${warn}`);
    }
  );

  const listAutomations = tool(
    "list_automations",
    "List Exo's automations (the files under the automations folder): what each one is, when it runs, its mode (report/propose/act), on/paused, last/next run — plus recent write runs with their review state and run ids. Use it before managing automations or when Mario asks what runs automatically.",
    {},
    async () => {
      const exo = getExo(app);
      if (!exo) return ok("Exo plugin not reachable.");
      const store = exo.automationStore;
      const lines: string[] = [];
      const autos = store.list();
      if (!autos.length) lines.push("No automations yet.");
      for (const a of autos) {
        const say = a.when.map(whenSentence).join(" · ") || "never (no when-lines)";
        const via = a.agent ? ` · via agent ${a.agent}` : "";
        lines.push(`- [${a.slug}] ${a.name} — ${say} · ${modeSentence(a.mode)} · ${a.enabled ? "on" : "paused"}${via}`);
      }
      for (const e of store.errors()) {
        lines.push(`- [${e.slug}] UNREADABLE: ${e.problem}`);
      }
      lines.push("", `Playbooks (reusable prompts): ${exo.settings.customPrompts.map((p) => p.name).join(", ") || "(none)"}`);
      const runs = await exo.loadAutomationRuns();
      if (runs.length) {
        lines.push("", "Recent write runs:");
        for (const r of runs.slice(0, 6)) {
          const state = r.restoredAt ? "restored" : r.reviewedAt ? "reviewed" : "TO REVIEW";
          lines.push(`- [${r.id}] ${r.name} · ${new Date(r.startedAt).toLocaleString()} · ${r.writes.length} notes · ${state}`);
        }
      }
      return ok(lines.join("\n"));
    }
  );

  const savePlaybook = tool(
    "save_playbook",
    "Create or update a reusable playbook (a named prompt in Exo's settings — what automations and the / menu run). Show Mario the exact name and prompt you're saving BEFORE calling this. Set overwrite to update an existing playbook.",
    { name: z.string(), prompt: z.string(), overwrite: z.boolean().optional() },
    async (args) => {
      const exo = getExo(app);
      if (!exo) return ok("Exo plugin not reachable.");
      const s = exo.settings;
      const existing = s.customPrompts.find((p) => p.name.toLowerCase() === args.name.toLowerCase());
      if (existing && !args.overwrite) {
        return ok(`Playbook "${existing.name}" already exists — pass overwrite: true to replace it.`);
      }
      if (existing) existing.prompt = args.prompt;
      else s.customPrompts.push({ name: args.name, prompt: args.prompt });
      await exo.saveSettings();
      return ok(`${existing ? "Updated" : "Saved"} playbook "${args.name}".`);
    }
  );

  const manageAutomation = tool(
    "manage_automation",
    `Create, update, pause, resume, delete (archive), or run an Exo automation — a readable file the scheduler executes. \`when\` lines use the readable grammar: \`daily 08:00\`, \`weekly mon 07:00\`, \`hourly\`, \`on create in _inbox/**\`, \`on tag #x\`. Mode \`act\` lets runs edit vault notes (checkpointed + restorable) — confirm with Mario before setting it. run_now executes immediately (may take minutes) and reports to ${paths.reports}/.`,
    {
      action: z.enum(["create", "update", "pause", "resume", "delete", "run_now"]),
      name: z.string().describe("Automation name (or slug for existing ones)."),
      description: z.string().optional(),
      prompt: z.string().optional().describe("The playbook body. Required for create unless agent is set."),
      agent: z.string().optional().describe("Bind to a named agent instead of a prompt."),
      when: z.array(z.string()).optional().describe("Replaces every when-line."),
      mode: z.enum(["report", "propose", "act"]).optional(),
      write_scope: z.array(z.string()).optional().describe("Folders/globs act|propose runs may write in."),
    },
    async (args) => {
      const exo = getExo(app);
      if (!exo) return ok("Exo plugin not reachable.");
      const store = exo.automationStore;
      const slug = automationSlug(args.name);
      const auto =
        store.get(slug)
        ?? store.list().find((x) => x.name.toLowerCase() === args.name.toLowerCase())
        ?? null;

      if (args.action === "run_now") {
        if (!auto) return ok(`No automation named "${args.name}" — see list_automations.`);
        const run = await exo.runAutomationNow(auto);
        if (run.refused) return ok(`Not run: ${run.refused}.`);
        return ok(run.ok ? `Run completed — report in ${paths.reports}/.` : `Run failed — see the report in ${paths.reports}/.`);
      }

      const parseWhens = (linesIn: string[]) => {
        const parsed = [];
        for (const line of linesIn) {
          const w = parseWhen(line);
          if (!w) return null;
          parsed.push(w);
        }
        return parsed;
      };

      if (args.action === "create") {
        if (auto) return ok(`Automation "${auto.name}" already exists — use update.`);
        if (!args.prompt && !args.agent) return ok("Give the automation a prompt, or bind it to an agent.");
        const when = args.when ? parseWhens(args.when) : [];
        if (when === null) return err("Unparseable when-line — use forms like: daily 08:00 · on create in _inbox/**");
        const a: Automation = {
          slug,
          name: args.name,
          description: args.description ?? "",
          icon: "zap",
          when,
          mode: (args.mode as AutomationMode) ?? "report",
          scope: args.write_scope ?? [],
          canCall: [],
          cooldownMs: DEFAULT_AUTOMATION_COOLDOWN_MS,
          enabled: true,
          agent: args.agent,
          prompt: args.prompt ?? "",
        };
        await store.save(a);
        return ok(`Automation created: ${a.name} (${store.filePath(slug)}) — ${a.when.map(formatWhen).join(" · ") || "no when-lines yet"}, ${modeSentence(a.mode)}.`);
      }

      if (!auto) return ok(`No automation named "${args.name}" — see list_automations.`);
      if (args.action === "delete") {
        await store.archive(auto.slug);
        return ok(`Automation "${auto.name}" archived to .archive/automations/.`);
      }
      if (args.action === "pause" || args.action === "resume") {
        await store.save({ ...auto, enabled: args.action === "resume" });
        return ok(`Automation "${auto.name}" ${args.action === "resume" ? "resumed" : "paused"}.`);
      }
      // update
      const a = { ...auto, when: [...auto.when], scope: [...auto.scope], canCall: [...auto.canCall] };
      if (args.when) {
        const when = parseWhens(args.when);
        if (when === null) return err("Unparseable when-line — use forms like: daily 08:00 · on create in _inbox/**");
        a.when = when;
      }
      if (args.description !== undefined) a.description = args.description;
      if (args.prompt !== undefined) a.prompt = args.prompt;
      if (args.agent !== undefined) a.agent = args.agent || undefined;
      if (args.mode) a.mode = args.mode;
      if (args.write_scope) a.scope = args.write_scope;
      await store.save(a);
      return ok(`Automation updated: ${a.name} — ${a.when.map(formatWhen).join(" · ") || "no when-lines"}, ${a.enabled ? "on" : "paused"}, ${modeSentence(a.mode)}.`);
    }
  );

  const reviewAutomationRun = tool(
    "review_automation_run",
    "Close out an automation write run: action 'reviewed' marks it OK; action 'restore' reverts EVERY note the run touched to its pre-run snapshot — destructive to the run's edits, confirm with Mario first. `id` comes from list_automations; omit it to target the most recent unreviewed run.",
    { action: z.enum(["reviewed", "restore"]), id: z.string().optional() },
    async (args) => {
      const exo = getExo(app);
      if (!exo) return ok("Exo plugin not reachable.");
      const runs = await exo.loadAutomationRuns();
      const target = args.id ? runs.find((r) => r.id === args.id) : unreviewedWriteRuns(runs)[0];
      if (!target) return ok(args.id ? `No run with id "${args.id}".` : "No unreviewed write runs.");
      if (args.action === "reviewed") {
        await exo.markAutomationRunReviewed(target.id);
        return ok(`Run "${target.name}" (${target.id}) marked as reviewed.`);
      }
      const restored = await exo.restoreAutomationRun(target.id);
      return ok(
        restored.length
          ? `Restored ${restored.length} note(s) from "${target.name}": ${restored.join(", ")}`
          : `Nothing restorable in "${target.name}" (missing snapshots).`
      );
    }
  );

  // Stateless service: resolved from the app here rather than curried per
  // conversation in view.ts, same as buildCapabilityTools(app) above.
  const collaboBridge = collaboBridgeFrom(app);

  return [
    searchVault, readNote, getBacklinks, getNeighborhood, getConnections, listNotes, listTags, getActiveContext,
    listAnnotations, listSonarActions, askUser, listLoops,
    createNote, appendToNote, updateFrontmatter, addLinks, linkMentions, ignoreMentionTool, openNote,
    editNote, insertAtCursor, renameNote, resolveAnnotation, runSonarAction,
    listAgents, invokeAgent, manageAgent,
    listAutomations, savePlaybook, manageAutomation, reviewAutomationRun,
    ...buildCapabilityTools(app),
    ...(memory.ledgerWrite ? [captureDecision, openLoop, closeLoopTool] : []),
    // `rethink_memory` also needs a live view bridge to render its diff.
    ...(memory.rethink && rethinkBridge ? [rethinkMemory] : []),
    ...buildMemoryTools(app, memory),
    ...(orchestrationEnabled ? [addTask, listTasks] : []),
    ...(orchestrationEnabled && parentConvoId ? [spawnTask] : []),
    ...(browserBridge ? buildBrowserTools(browserBridge) : []),
    ...(collaboBridge ? buildCollaboTools(collaboBridge) : []),
  ];
}

/**
 * In-process MCP server exposing Obsidian-native tools to the agent via the
 * Claude Agent SDK. Thin wrapper around {@link buildObsidianTools}: the tool
 * array itself is built there so the Codex/Obsidian bridge can consume it
 * directly without going through `createSdkMcpServer`. Same options bag.
 */
export function createObsidianToolServer(app: App, opts: ObsidianToolOpts) {
  const alwaysLoad = opts.alwaysLoad ?? true;
  return createSdkMcpServer({
    name: "obsidian",
    version: "1.0.0",
    alwaysLoad,
    instructions:
      "Obsidian-native tools. Prefer these over generic file/Bash tools for vault work — they respect links, tags, and frontmatter.",
    tools: toSdkTools(buildObsidianTools(app, opts)),
  });
}

/** Read-only obsidian tools that can be auto-allowed without a permission card. */
export const OBSIDIAN_READ_TOOLS = new Set([
  "mcp__obsidian__search_vault",
  "mcp__obsidian__read_note",
  "mcp__obsidian__get_backlinks",
  "mcp__obsidian__get_neighborhood",
  "mcp__obsidian__get_connections",
  "mcp__obsidian__list_notes",
  "mcp__obsidian__list_tags",
  "mcp__obsidian__get_active_context",
  "mcp__obsidian__list_annotations",
  "mcp__obsidian__list_sonar_actions",
  ...MEMORY_READ_TOOLS,
  "mcp__obsidian__list_loops",
  "mcp__obsidian__list_automations",
  "mcp__obsidian__list_agents",
  // Reads the ledger and writes nothing. Its own description tells the agent to
  // "check on work you handed off" — raising a write-permission card for that
  // turns a status glance into an interruption.
  "mcp__obsidian__list_tasks",
  // Browser observers: they change nothing on the page or in the vault. The
  // interacting tools (open/navigate/click/type/scroll) are deliberately NOT
  // here: their permission card, showing the URL/selector, is the evidence
  // trail for what the agent did in a shared, visible surface.
  ...BROWSER_READ_TOOLS,
  ...CAPABILITY_READ_TOOLS,
  // Collabo observers: they read a shared document or its event trail and
  // write nothing a collaborator can see. collabo_comment and collabo_suggest
  // stay off this list on purpose — see collabo-tools.ts.
  ...COLLABO_READ_TOOLS,
]);

/** Memory-write tool names (gated separately by the memoryWrite setting). */
export const OBSIDIAN_MEMORY_TOOLS = new Set([
  "mcp__obsidian__capture_decision",
  "mcp__obsidian__open_loop",
  "mcp__obsidian__close_loop",
  "mcp__obsidian__rethink_memory",
  "mcp__obsidian__undo_memory_write",
]);

// `OBSIDIAN_ORCHESTRATION_TOOLS` used to live here, listing `add_task` alone.
// Removed rather than extended with `spawn_task`/`list_tasks`: it had ZERO
// production consumers, and it never could have one — the `orchestrationEnabled`
// gate is applied at REGISTRATION (see `createObsidianToolServer`), so a tool
// that is off is not on the server at all and there is nothing left to classify.
// A Set nobody reads cannot go red when it drifts, which is exactly how
// `list_tasks` came to be missing from the read-tools Set above unnoticed.
