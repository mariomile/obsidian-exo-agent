/**
 * describeActivity — maps an in-flight tool call to a short, human phrase for the
 * Context panel's live activity row ("what Exo is doing right now"). Pure and
 * UI-free so it's unit-testable; `view.ts` supplies the result to
 * `RecapPanel.render` as the current-activity descriptor.
 *
 * Distinct from `ui/tools.ts`'s `toolWorkingLabel` (the generic "Reading note…"
 * verb on the streaming working row): this carries the concrete target — a note
 * basename, a search query, a fetched host — so the panel reads as live activity,
 * not a generic spinner label. Unknown tools fall back to "Working…".
 */

function asRec(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}
function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Last path segment, wikilink brackets and a trailing `.md` stripped — mirrors
 *  the recap's note basename so the live row and the folded row read the same. */
function base(path: string): string {
  const clean = path.replace(/^\[\[|\]\]$/g, "").trim();
  const last = clean.split("/").pop() ?? clean;
  return last.replace(/\.md$/, "");
}

/** Bare hostname of a URL (no `www.`), or the raw string when it doesn't parse. */
function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A one-line, present-tense description of what `name`(`input`) is doing. */
export function describeActivity(name: string, input: unknown): string {
  const i = asRec(input);
  switch (name) {
    case "Read":
    case "NotebookRead":
    case "mcp__obsidian__read_note": {
      const p = base(asStr(i.file_path || i.notebook_path || i.target || i.path));
      return p ? `Reading ${p}` : "Reading a note";
    }
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
    case "mcp__obsidian__create_note":
    case "mcp__obsidian__edit_note":
    case "mcp__obsidian__save_to_note": {
      const p = base(asStr(i.file_path || i.notebook_path || i.target || i.path));
      return p ? `Writing ${p}` : "Writing a note";
    }
    case "WebSearch": {
      const q = asStr(i.query).trim();
      return q ? `Searching the web — ${q}` : "Searching the web";
    }
    case "WebFetch": {
      const u = asStr(i.url).trim();
      return u ? `Fetching ${host(u)}` : "Fetching a page";
    }
    case "mcp__obsidian__open_loop": {
      const t = asStr(i.title).trim();
      return t ? `Opening a loop — ${t}` : "Opening a loop";
    }
    case "mcp__obsidian__close_loop": {
      const id = asStr(i.id).trim();
      return id ? `Closing loop ${id}` : "Closing a loop";
    }
    case "mcp__obsidian__list_loops":
      return "Checking open loops";
    case "Bash":
      return "Running a command";
    case "Skill": {
      const s = asStr(i.skill || i.command).trim();
      return s ? `Running ${s}` : "Running a skill";
    }
    case "Task":
    case "Agent":
      return "Delegating to a subagent";
    case "Grep":
    case "Glob":
    case "LS":
    case "mcp__obsidian__search_vault":
      return "Searching the vault";
    default:
      return "Working…";
  }
}
