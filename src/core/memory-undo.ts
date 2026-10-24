/**
 * Undo a memory harvest. With git: `git revert` the harvest commit, refusing
 * when any file it touched changed since. Without git, and for notes the
 * harvest wrote but did not commit (they had the user's uncommitted edits):
 * reverse the exact recorded edits (remove the inserted lines, put the
 * replaced line back), all or nothing, refusing when a line is no longer
 * there exactly once. I/O is injected; the git runner is the `GitRun` shape
 * from `obsidian/git.ts`.
 */
import {
  HARVEST_COMMIT_PREFIX,
  REVERT_COMMIT_PREFIX,
  revertCommitMessage,
} from "./memory-harvest";
import type { AppliedWrite } from "./memory-apply";

type GitRun = (args: string[]) => Promise<string>;

export interface UndoVault {
  /** Current content, or null when the file is gone. */
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface UndoResult {
  ok: boolean;
  message: string;
  /** The revert commit, when git made one. */
  revertSha?: string;
}

const lines = (out: string): string[] =>
  out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** Latest harvest commit not already reverted, from the vault's git log. */
export async function latestHarvestSha(git: GitRun): Promise<string | null> {
  const out = await git([
    "log",
    "-n",
    "200",
    "--format=%H%x09%s",
    "-E",
    `--grep=^exo: memory (harvest|revert):`,
  ]);
  const reverted = new Set<string>();
  for (const line of lines(out)) {
    const [sha, subject = ""] = line.split("\t");
    if (subject.startsWith(REVERT_COMMIT_PREFIX)) reverted.add(subject.slice(REVERT_COMMIT_PREFIX.length).trim());
    else if (subject.startsWith(HARVEST_COMMIT_PREFIX) && ![...reverted].some((r) => sha.startsWith(r) || r.startsWith(sha))) {
      return sha;
    }
  }
  return null;
}

export async function revertHarvestCommit(git: GitRun, sha: string): Promise<UndoResult> {
  let subject: string;
  try {
    subject = (await git(["log", "-1", "--format=%s", sha])).trim();
  } catch {
    return { ok: false, message: `No commit ${sha} in this vault.` };
  }
  if (!subject.startsWith(HARVEST_COMMIT_PREFIX)) {
    return { ok: false, message: `${sha.slice(0, 8)} is not a memory harvest commit ("${subject}").` };
  }
  const files = lines(await git(["show", "--name-only", "--format=", sha]));
  if (!files.length) return { ok: false, message: `${sha.slice(0, 8)} touched no files.` };
  const later = lines(await git(["log", "--format=%H", `${sha}..HEAD`, "--", ...files]));
  const dirty = lines(await git(["status", "--porcelain", "--", ...files]));
  if (later.length || dirty.length) {
    return {
      ok: false,
      message: `Not reverted: ${files.join(", ")} changed since the harvest. Edit the lines by hand instead.`,
    };
  }
  try {
    await git(["revert", "--no-commit", sha]);
    await git(["commit", "-m", revertCommitMessage(sha), "--", ...files]);
  } catch (err) {
    try {
      await git(["revert", "--abort"]);
    } catch {
      /* nothing to abort */
    }
    return { ok: false, message: `git revert failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const revertSha = (await git(["rev-parse", "HEAD"])).trim();
  return { ok: true, message: `Reverted memory harvest ${sha.slice(0, 8)} (${files.length} file(s)).`, revertSha };
}

/** Index of the one place `block` occurs as consecutive lines, or -1 when it
 *  is missing or ambiguous. */
export function uniqueRun(lines: readonly string[], block: readonly string[]): number {
  let found = -1;
  for (let i = 0; i + block.length <= lines.length; i++) {
    if (block.every((b, k) => lines[i + k] === b)) {
      if (found >= 0) return -1;
      found = i;
    }
  }
  return found;
}

/**
 * Reverse `writes` exactly: remove each inserted block, put each replaced line
 * back, newest first. Computed in memory for every note before anything is
 * written, so it is all or nothing (`dryRun` stops right before writing). A note the harvest created is removed when
 * nothing but its starter content is left.
 */
export async function reverseWrites(
  vault: UndoVault,
  writes: readonly AppliedWrite[],
  opts: { dryRun?: boolean } = {},
): Promise<UndoResult> {
  if (!writes.length) return { ok: false, message: "That harvest wrote nothing to undo." };
  const next = new Map<string, string>();
  const created = new Map<string, string>();
  for (const w of [...writes].reverse()) {
    const current = next.get(w.path) ?? (await vault.read(w.path));
    if (current === null) return { ok: false, message: `Not undone: ${w.path} no longer exists.` };
    const lines = current.split("\n");
    const at = uniqueRun(lines, w.lines);
    if (at < 0) {
      return { ok: false, message: `Not undone: the line in ${w.path} changed since the harvest. Edit it by hand instead.` };
    }
    if (w.op === "update") lines.splice(at, 1, w.replaced ?? "");
    else {
      lines.splice(at, w.lines.length);
      // A loop block was appended after a blank separator line: take it too.
      if (w.lines.length > 1 && at > 0 && lines[at - 1] === "" && (lines[at] ?? "") === "") lines.splice(at - 1, 1);
    }
    next.set(w.path, lines.join("\n"));
    if (w.created !== undefined) created.set(w.path, w.created);
  }
  if (opts.dryRun) return { ok: true, message: "reversible" };
  for (const [path, content] of next) {
    const starter = created.get(path);
    if (starter !== undefined && content.trim() === starter.trim()) await vault.remove(path);
    else await vault.write(path, content);
  }
  return { ok: true, message: `Undid ${writes.length} memory write(s) in ${next.size} note(s).` };
}
