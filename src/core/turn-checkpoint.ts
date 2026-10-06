/**
 * Turn checkpoints — the pure half of "what did this turn change, and undo just
 * that", ported from T3 Code's per-run checkpoints (apps/server/src/
 * checkpointing, orchestration-v2/CheckpointCaptureService.ts and
 * CheckpointRestoreSafety.ts).
 *
 * T3 snapshots the whole worktree into a hidden git ref after every run. A
 * vault is not a worktree a chat owns: it is always dirty, shared with Mario
 * and with other chats, and some folders must never be swept up. So Exo keeps
 * T3's shape (one hidden ref per turn, a diff between two commits, a restore
 * with a safety check) and narrows the content to the files the turn TOUCHED:
 *
 *   refs/exo/checkpoints/<convo>/<stamp>   = "after" commit (files at turn end)
 *     └─ parent                            = "before" commit (files before the turn)
 *
 * Both commits hold only the touched paths, built in a temporary index, so the
 * user's own index and branch are never touched and nothing is `git add -A`'d.
 *
 * Revert is T3's isolation check made per file: a file is restored only if it
 * still holds exactly what the turn left there. Anything edited since (by you,
 * another chat, a sync) is skipped and reported, never overwritten.
 */

/** Paths a checkpoint never captures or restores (vault rules: synced sources
 *  are append-only, runtime and attachments are not chat output). */
export const CHECKPOINT_EXCLUDED_PREFIXES = ["Input/Readwise/", ".claude/", "_attachments/"] as const;

export function isCheckpointable(path: string): boolean {
  return !CHECKPOINT_EXCLUDED_PREFIXES.some((p) => path.startsWith(p));
}

/** Git ref name for one turn. `stamp` makes it unique without depending on a
 *  message index, which a rewind can shift. Conversation ids are already
 *  ref-safe in practice; anything else is replaced so `update-ref` never
 *  rejects the name. */
export function checkpointRef(convoId: string, stamp: number): string {
  const safe = convoId.replace(/[^A-Za-z0-9_-]/g, "_") || "convo";
  return `refs/exo/checkpoints/${safe}/${stamp}`;
}

/** One file's three states at revert time. `null` = the file does not exist. */
export interface RevertEntry {
  path: string;
  before: string | null;
  after: string | null;
  current: string | null;
}

export type RevertAction =
  | { path: string; kind: "write"; content: string }
  | { path: string; kind: "delete" }
  | { path: string; kind: "skip-changed" }
  | { path: string; kind: "skip-noop" };

/**
 * What reverting a turn does to each file it touched:
 *  - unchanged since the turn → put the "before" content back (delete it if the
 *    turn created it);
 *  - changed since the turn → skip, never overwrite someone else's edit;
 *  - already back to "before" → nothing to do.
 */
export function planTurnRevert(entries: readonly RevertEntry[]): RevertAction[] {
  return entries.map((e) => {
    if (e.current === e.before) return { path: e.path, kind: "skip-noop" };
    if (e.current !== e.after) return { path: e.path, kind: "skip-changed" };
    return e.before === null
      ? { path: e.path, kind: "delete" }
      : { path: e.path, kind: "write", content: e.before };
  });
}

/** One line per file of `git diff --numstat -z` output. */
export interface TurnDiffFile {
  path: string;
  additions: number;
  deletions: number;
}

/**
 * Parse `git diff --numstat -z`. Each record is `<add>\t<del>\t<path>\0`; a
 * binary file reports `-` for both counts, read here as 0.
 */
export function parseNumstat(out: string): TurnDiffFile[] {
  const files: TurnDiffFile[] = [];
  for (const rec of out.split("\0")) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(rec.replace(/^\n/, ""));
    if (!m) continue;
    files.push({
      path: m[3],
      additions: m[1] === "-" ? 0 : Number(m[1]),
      deletions: m[2] === "-" ? 0 : Number(m[2]),
    });
  }
  return files;
}

/** The Notice after a revert: what was undone and what was left alone. */
export function revertSummary(actions: readonly RevertAction[], failed: readonly string[]): string {
  const done = actions.filter((a) => a.kind === "write" || a.kind === "delete").length - failed.length;
  const skipped = actions.filter((a) => a.kind === "skip-changed").map((a) => a.path);
  const parts = [done > 0 ? `Reverted ${done} file${done === 1 ? "" : "s"} from this turn.` : "Nothing to revert."];
  if (skipped.length) parts.push(`Left alone, changed since: ${skipped.join(", ")}.`);
  if (failed.length) parts.push(`Failed: ${failed.join(", ")}.`);
  return parts.join(" ");
}
