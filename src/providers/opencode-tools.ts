/**
 * opencode tool calls, translated into the names and input fields the rest of
 * Exo already understands (Claude Code's): `READ_ONLY_TOOLS` auto-allow,
 * `WRITE_TOOLS` checkpoints, `toolFilePath` chips and permission labels all
 * key off `Read`/`Edit`/`Bash` and `file_path`/`command`. Without this an
 * opencode read is never auto-allowed and an opencode write is never
 * snapshotted. Pure: no Obsidian, no process.
 *
 * Shapes observed on opencode v2.2.6 over ACP (2026-11-08 probe):
 *   tool_call       {toolCallId, name: "read", kind: "read", status: "pending", rawInput: {}}
 *   tool_call_update {status: "in_progress", rawInput: {path: "./notes.md"}, locations: [{path: "/abs/notes.md"}]}
 *   write  rawInput {path, content}      shell rawInput {command, workdir|cwd}
 */

export interface AcpToolCall {
  toolCallId?: string;
  name?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: { path?: string }[];
  content?: unknown;
}

const BY_NAME: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  multiedit: "MultiEdit",
  patch: "Edit",
  apply_patch: "Edit",
  shell: "Bash",
  bash: "Bash",
  glob: "Glob",
  grep: "Grep",
  list: "LS",
  ls: "LS",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  task: "Agent",
  subagent: "Agent",
  todowrite: "TodoWrite",
  todoread: "TodoRead",
  skill: "Skill",
};

/** ACP `kind` → Exo name, for a call that carries no recognisable `name`. */
const BY_KIND: Record<string, string> = {
  read: "Read",
  edit: "Edit",
  delete: "Edit",
  move: "Edit",
  execute: "Bash",
  search: "Grep",
  fetch: "WebFetch",
};

/** The Obsidian bridge's server name (tool-wiring.ts registers it so). */
const OBSIDIAN_SERVER = "obsidian";

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Exo's name for an opencode tool. `mcpServers` are the MCP server names this
 *  session may expose (opencode prefixes their tools `<server>_<tool>`). */
export function exoToolName(call: AcpToolCall, mcpServers: readonly string[] = [OBSIDIAN_SERVER]): string {
  const raw = (call.name ?? "").trim();
  const known = BY_NAME[raw.toLowerCase()];
  if (known) return known;
  for (const server of [...mcpServers].sort((a, b) => b.length - a.length)) {
    for (const sep of ["__", "_"]) {
      const prefix = `${server}${sep}`;
      if (raw.startsWith(prefix) && raw.length > prefix.length) return `mcp__${server}__${raw.slice(prefix.length)}`;
    }
  }
  if (raw) return raw;
  return BY_KIND[call.kind ?? ""] ?? (call.title || "tool");
}

/** Exo-shaped input: the opencode fields kept, plus the Claude Code field names
 *  Exo reads (`file_path`, `command`). The absolute `locations` path wins over
 *  a relative `rawInput.path`, because Exo resolves paths against the vault. */
export function exoToolInput(name: string, call: AcpToolCall): Record<string, unknown> {
  const input = { ...rec(call.rawInput) };
  const located = call.locations?.find((l) => typeof l.path === "string")?.path;
  if (["Read", "Write", "Edit", "MultiEdit"].includes(name)) {
    const path = located ?? input.filePath ?? input.file_path ?? input.path;
    if (typeof path === "string" && path) input.file_path = path;
  }
  if (name === "Bash" && typeof input.command !== "string" && typeof call.title === "string") input.command = call.title;
  return input;
}

/** True once a call carries enough input to render and decide on. opencode
 *  announces calls `pending` with an empty `rawInput` and fills it in later. */
export function hasInput(call: AcpToolCall): boolean {
  return Object.keys(rec(call.rawInput)).length > 0;
}

/** The text a finished call produced, for the tool card's output. */
export function toolOutputText(call: AcpToolCall): string {
  const parts: string[] = [];
  for (const block of Array.isArray(call.content) ? call.content : []) {
    const b = rec(block);
    const inner = rec(b.content);
    if (typeof inner.text === "string") parts.push(inner.text);
    else if (b.type === "diff" && typeof b.path === "string") parts.push(`Edited ${b.path}`);
  }
  if (parts.length) return parts.join("\n");
  const out = rec(call.rawOutput);
  return typeof out.output === "string" ? out.output : "";
}
