/**
 * Turn checkpoints — the git half (see core/turn-checkpoint.ts for the shape
 * and the rules). Plumbing commands only, argument arrays only, an explicit
 * cwd, and a TEMPORARY index (`GIT_INDEX_FILE`), so the vault's own index,
 * branch and working tree are never read into or written by a capture.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkpointRef,
  isCheckpointable,
  parseNumstat,
  planTurnRevert,
  type RevertAction,
  type TurnDiffFile,
} from "../core/turn-checkpoint";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 20_000;
const MAX_PATCH_BYTES = 2_000_000;

/** The same author T3 stamps on its checkpoint commits, renamed. Set through
 *  the environment so a vault without a git identity can still checkpoint. */
const IDENTITY = {
  GIT_AUTHOR_NAME: "Exo",
  GIT_AUTHOR_EMAIL: "exo@users.noreply.github.com",
  GIT_COMMITTER_NAME: "Exo",
  GIT_COMMITTER_EMAIL: "exo@users.noreply.github.com",
};

type Git = (args: string[], env?: Record<string, string>) => Promise<string>;

function gitIn(cwd: string): Git {
  return async (args, env) =>
    (
      await execFileAsync("git", args, {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_PATCH_BYTES * 2,
        env: { ...process.env, ...IDENTITY, ...env },
      })
    ).stdout;
}

/** Where the vault sits inside its repo (`""` when the vault IS the repo
 *  root), or null when the vault is not in a git repo / git is missing. */
async function repoPrefix(git: Git): Promise<string | null> {
  try {
    if ((await git(["rev-parse", "--is-inside-work-tree"])).trim() !== "true") return null;
    return (await git(["rev-parse", "--show-prefix"])).trim();
  } catch {
    return null;
  }
}

/** Vault I/O the git half needs, supplied by the view (vault-relative paths). */
export interface CheckpointVault {
  basePath: string;
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/** Build one commit holding `files` (vault path → content; null = absent) in
 *  a throwaway index, optionally on top of `parent`. */
async function commitFiles(
  git: Git,
  prefix: string,
  files: ReadonlyMap<string, string | null>,
  message: string,
  parent?: string,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "exo-ckpt-"));
  const env = { GIT_INDEX_FILE: join(dir, "index") };
  try {
    let n = 0;
    for (const [path, content] of files) {
      if (content === null) continue;
      const blobFile = join(dir, `blob-${n++}`);
      await writeFile(blobFile, content, "utf8");
      const sha = (await git(["hash-object", "-w", "--", blobFile])).trim();
      await git(["update-index", "--add", "--cacheinfo", "100644", sha, prefix + path], env);
    }
    const tree = (await git(["write-tree"], env)).trim();
    const args = ["commit-tree", tree, "-m", message];
    if (parent) args.push("-p", parent);
    return (await git(args)).trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Capture one turn: `before` is the turn's checkpoint (content before its first
 * write, null = did not exist); the "after" side is read from the vault now.
 * Returns the ref, or null when there is nothing to capture or no git repo.
 * Never throws: a checkpoint is a safety net, and a failed one must not touch
 * the turn that produced it.
 */
export async function captureTurnCheckpoint(
  vault: CheckpointVault,
  convoId: string,
  before: ReadonlyMap<string, string | null>,
  stamp = Date.now(),
): Promise<string | null> {
  const paths = [...before.keys()].filter(isCheckpointable);
  if (paths.length === 0) return null;
  const git = gitIn(vault.basePath);
  try {
    const prefix = await repoPrefix(git);
    if (prefix === null) return null;
    const ref = checkpointRef(convoId, stamp);
    const beforeFiles = new Map(paths.map((p) => [p, before.get(p) ?? null]));
    const afterFiles = new Map<string, string | null>();
    for (const p of paths) afterFiles.set(p, await vault.read(p));
    const base = await commitFiles(git, prefix, beforeFiles, `exo checkpoint before ${ref}`);
    const head = await commitFiles(git, prefix, afterFiles, `exo checkpoint ${ref}`, base);
    await git(["update-ref", ref, head]);
    return ref;
  } catch (err) {
    console.warn("[exo] turn checkpoint failed", err);
    return null;
  }
}

/** What a turn changed: per-file counts and the unified patch. */
export async function readTurnDiff(
  basePath: string,
  ref: string,
): Promise<{ files: TurnDiffFile[]; patch: string } | null> {
  const git = gitIn(basePath);
  try {
    const prefix = (await repoPrefix(git)) ?? "";
    const range = [`${ref}^`, ref];
    const flags = ["--no-color", "--no-ext-diff", "--no-textconv"];
    const files = parseNumstat(await git(["diff", ...flags, "--numstat", "-z", ...range])).map((f) => ({
      ...f,
      path: f.path.startsWith(prefix) ? f.path.slice(prefix.length) : f.path,
    }));
    const patch = await git(["diff", ...flags, "--patch", ...range]);
    return { files, patch: patch.length > MAX_PATCH_BYTES ? patch.slice(0, MAX_PATCH_BYTES) : patch };
  } catch {
    return null;
  }
}

async function blobAt(git: Git, rev: string, gitPath: string): Promise<string | null> {
  try {
    return await git(["cat-file", "blob", `${rev}:${gitPath}`]);
  } catch {
    return null; // absent on that side of the turn
  }
}

/**
 * Revert one turn: restore every file it changed to its "before" content, but
 * only where the file still holds what the turn left (core planTurnRevert).
 * Returns the plan that ran and the paths that failed to write.
 */
export async function revertTurn(
  vault: CheckpointVault,
  ref: string,
): Promise<{ actions: RevertAction[]; failed: string[] } | null> {
  const git = gitIn(vault.basePath);
  try {
    const prefix = (await repoPrefix(git)) ?? "";
    const names = (await git(["diff", "--name-only", "-z", `${ref}^`, ref])).split("\0").filter(Boolean);
    const entries = [];
    for (const gitPath of names) {
      const path = gitPath.startsWith(prefix) ? gitPath.slice(prefix.length) : gitPath;
      if (!isCheckpointable(path)) continue;
      entries.push({
        path,
        before: await blobAt(git, `${ref}^`, gitPath),
        after: await blobAt(git, ref, gitPath),
        current: await vault.read(path),
      });
    }
    const actions = planTurnRevert(entries);
    const failed: string[] = [];
    for (const a of actions) {
      try {
        if (a.kind === "write") await vault.write(a.path, a.content);
        else if (a.kind === "delete") await vault.remove(a.path);
      } catch {
        failed.push(a.path);
      }
    }
    return { actions, failed };
  } catch {
    return null;
  }
}
