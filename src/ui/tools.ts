import { isLargeContent } from "../core/steps";

/** Read-only tools that can be auto-allowed (no side effects). */
export const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);

export interface ToolMeta {
  icon: string; // lucide icon id
  label: string;
  target: string; // short context (file path, command, pattern…)
  /** Vault path to open when the target is clicked (file tools only). */
  openPath?: string;
}

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Obsidian native tools whose target is a note path/link (for click-to-open). */
const OBSIDIAN_NOTE_TOOLS = new Set([
  "mcp__obsidian__read_note",
  "mcp__obsidian__get_backlinks",
  "mcp__obsidian__get_neighborhood",
  "mcp__obsidian__save_to_note",
  "mcp__obsidian__update_frontmatter",
  "mcp__obsidian__add_links",
  "mcp__obsidian__open_note",
  "mcp__obsidian__create_note",
  "mcp__obsidian__edit_note",
  "mcp__obsidian__rename_note",
]);

/** Every raw file path a tool mutates/reads. Rename has two paths because a
 *  correct rewind must restore the source and remove/restore the destination. */
export function toolFilePaths(name: string, input: unknown): string[] {
  const i = rec(input);
  if (FILE_TOOLS.has(name)) {
    const path = asString(i.file_path || i.notebook_path);
    return path ? [path] : [];
  }
  if (OBSIDIAN_NOTE_TOOLS.has(name)) {
    const source = asString(i.target || i.path).replace(/^\[\[|\]\]$/g, "");
    if (name === "mcp__obsidian__rename_note") {
      const rawDest = asString(i.new_path).replace(/^\[\[|\]\]$/g, "");
      const dest = rawDest && !rawDest.endsWith(".md") ? `${rawDest}.md` : rawDest;
      return [source, dest].filter(Boolean);
    }
    return source ? [source] : [];
  }
  return [];
}

/** Primary path for click-to-open and permission labels. */
export function toolFilePath(name: string, input: unknown): string | undefined {
  return toolFilePaths(name, input)[0];
}

const OBSIDIAN_META: Record<string, { icon: string; label: string; targetKey?: string }> = {
  search_vault: { icon: "search", label: "Search vault", targetKey: "query" },
  read_note: { icon: "file-text", label: "Read note", targetKey: "target" },
  get_backlinks: { icon: "link", label: "Backlinks", targetKey: "target" },
  get_neighborhood: { icon: "network", label: "Neighborhood", targetKey: "target" },
  list_notes: { icon: "folder", label: "List notes", targetKey: "tag" },
  list_tags: { icon: "tag", label: "List tags" },
  get_active_context: { icon: "crosshair", label: "Active context" },
  create_note: { icon: "file-plus", label: "Create note", targetKey: "path" },
  save_to_note: { icon: "file-down", label: "Save to note", targetKey: "path" },
  propose_correction: { icon: "file-check", label: "Propose correction", targetKey: "path" },
  update_frontmatter: { icon: "settings-2", label: "Frontmatter", targetKey: "target" },
  add_links: { icon: "link", label: "Add links", targetKey: "target" },
  open_note: { icon: "external-link", label: "Open note", targetKey: "target" },
  edit_note: { icon: "file-pen-line", label: "Edit note", targetKey: "target" },
  insert_at_cursor: { icon: "text-cursor-input", label: "Insert at cursor" },
  rename_note: { icon: "file-symlink", label: "Rename note", targetKey: "target" },
  capture_decision: { icon: "gavel", label: "Capture decision", targetKey: "title" },
  recent_chats: { icon: "history", label: "Recent chats", targetKey: "days" },
  undo_memory_write: { icon: "undo-2", label: "Undo memory write", targetKey: "sha" },
  list_capabilities: { icon: "hi-puzzle", label: "Capabilities", targetKey: "kind" },
  manage_mcp_server: { icon: "plug", label: "MCP server", targetKey: "name" },
  manage_skill: { icon: "sparkles", label: "Skill", targetKey: "name" },
};

function asString(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function rec(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

/** Short, human label + target for a tool call. */
export function toolMeta(name: string, input: unknown): ToolMeta {
  return { ...baseMeta(name, input), openPath: toolFilePath(name, input) };
}

function baseMeta(name: string, input: unknown): Omit<ToolMeta, "openPath"> {
  const i = rec(input);
  // Obsidian native tools (mcp__obsidian__<tool>)
  if (name.startsWith("mcp__obsidian__")) {
    const tool = name.slice("mcp__obsidian__".length);
    const m = OBSIDIAN_META[tool];
    if (m) {
      const raw = m.targetKey ? asString(i[m.targetKey]).replace(/^\[\[|\]\]$/g, "") : "";
      const target = m.targetKey === "target" || m.targetKey === "path" ? basename(raw) : truncate(raw, 50);
      return { icon: m.icon, label: m.label, target };
    }
  }
  // Other MCP tools arrive as mcp__server__tool
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return { icon: "plug", label: parts.slice(2).join(" ") || name, target: parts[1] ?? "" };
  }
  switch (name) {
    case "Read":
      return { icon: "file-text", label: "Read", target: basename(asString(i.file_path)) };
    case "Write":
      return { icon: "file-plus", label: "Write", target: basename(asString(i.file_path)) };
    case "Edit":
    case "MultiEdit":
      return { icon: "file-pen-line", label: "Edit", target: basename(asString(i.file_path)) };
    case "NotebookEdit":
      return { icon: "file-pen-line", label: "Edit notebook", target: basename(asString(i.notebook_path)) };
    case "Bash":
      return { icon: "terminal", label: "Run command", target: truncate(asString(i.command), 60) };
    case "Glob":
      return { icon: "search", label: "Find files", target: asString(i.pattern) };
    case "Grep":
      return { icon: "search", label: "Search", target: asString(i.pattern) };
    case "LS":
      return { icon: "folder", label: "List", target: asString(i.path) };
    case "WebFetch":
      return { icon: "globe", label: "Fetch URL", target: truncate(asString(i.url), 50) };
    case "WebSearch":
      return { icon: "globe", label: "Web search", target: asString(i.query) };
    case "TodoWrite":
      return { icon: "list-checks", label: "Update todos", target: "" };
    // Subagent-spawning tool — `Task` (legacy) and `Agent` (current CLI name).
    case "Task":
    case "Agent":
      return { icon: "bot", label: "Subagent", target: asString(i.description) };
    default:
      return { icon: "wrench", label: name, target: "" };
  }
}

/** Present-tense phase label for the working indicator row (Feature 1 — the
 *  "sta lavorando" row). Reuses toolMeta's label for anything not special-cased,
 *  so it always tracks the tool metadata (fallback "Working…"). */
export function toolWorkingLabel(name: string, input: unknown): string {
  switch (name) {
    case "Read":
      return "Reading note…";
    case "Write":
      return "Writing note…";
    case "Edit":
    case "MultiEdit":
      return "Editing…";
    case "NotebookEdit":
      return "Editing notebook…";
    case "Bash":
      return "Running command…";
    case "Glob":
      return "Finding files…";
    case "Grep":
      return "Searching…";
    case "LS":
      return "Listing files…";
    case "WebFetch":
      return "Fetching URL…";
    case "WebSearch":
      return "Searching the web…";
    case "Task":
    case "Agent":
      return "Running subagent…";
  }
  const label = baseMeta(name, input).label;
  return label ? `${label}…` : "Working…";
}

/** Render the detail body for a tool (diff / command / params). */
export function renderToolDetail(el: HTMLElement, name: string, input: unknown, _result: unknown): void {
  const i = rec(input);
  if (name === "Edit") {
    renderDiff(el, asString(i.old_string), asString(i.new_string));
    return;
  }
  if (name === "MultiEdit" && Array.isArray(i.edits)) {
    for (const e of i.edits as Array<Record<string, unknown>>) {
      renderDiff(el, asString(e.old_string), asString(e.new_string));
    }
    return;
  }
  if (name === "Write") {
    const content = asString(i.content);
    if (isLargeContent(content)) {
      const n = content.split("\n").length;
      const details = el.createEl("details", { cls: "mva-diff-collapse" });
      details.createEl("summary", { text: `+${n} lines` });
      renderDiff(details, "", content);
    } else {
      renderDiff(el, "", content);
    }
    return;
  }
  if (name === "Bash") {
    // Order (what → command → result): the description caption first, then the
    // command once with a `$` prompt. The command is NOT repeated in the header
    // when expanded (see .mva-tool.is-command in styles.css) — it lives here only.
    // NOTE: the header/body de-dup is deliberately scoped to Bash. Generic MCP
    // tools (WebFetch/WebSearch/…) still repeat their target in the params body
    // below — not generalized here on purpose.
    if (i.description) el.createDiv({ cls: "mva-tool-note", text: asString(i.description) });
    const pre = el.createEl("pre", { cls: "mva-code" });
    pre.createEl("code", { text: "$ " + asString(i.command) });
    return;
  }
  // Generic: a couple of meaningful params.
  const keys = Object.keys(i).filter((k) => i[k] != null && typeof i[k] !== "object");
  if (keys.length) {
    const dl = el.createDiv({ cls: "mva-params" });
    for (const k of keys.slice(0, 4)) {
      const row = dl.createDiv({ cls: "mva-param" });
      row.createSpan({ cls: "mva-param-k", text: k });
      row.createSpan({ cls: "mva-param-v", text: truncate(asString(i[k]), 120) });
    }
  }
}

function renderDiff(el: HTMLElement, oldStr: string, newStr: string): void {
  const pre = el.createEl("pre", { cls: "mva-diff" });
  if (oldStr) {
    for (const line of oldStr.split("\n")) {
      pre.createDiv({ cls: "mva-diff-line mva-del", text: "- " + line });
    }
  }
  for (const line of newStr.split("\n")) {
    pre.createDiv({ cls: "mva-diff-line mva-add", text: "+ " + line });
  }
}

function basename(p: string): string {
  if (!p) return "";
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

function truncate(s: string, n: number): string {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}
