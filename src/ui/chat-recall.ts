/**
 * Semantic recall over conversations — the impure half. Spawns
 * `scripts/chat-recall.mjs`, which owns the index and the embedder; this file
 * owns only process lifecycle and the contract with the caller.
 *
 * The script is inlined into main.js and written to the plugin dir on first
 * use: Obsidian's installer only downloads main.js, manifest.json and
 * styles.css, so a sidecar file in the release would never reach users.
 *
 * Why a subprocess and not an in-plugin embedder: the model and its runtime are
 * ~100MB of WASM that the plugin has no business bundling, and running them on
 * the renderer thread would freeze the UI for the duration of a query. Out of
 * process, a slow query costs latency and nothing else.
 *
 * Availability is a normal state, not an error. When the local embedder is not
 * installed the script exits 3, `unavailable` latches, and the sidebar simply
 * never shows a Related section again this session.
 */
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveCli } from "../cli";
import CHAT_RECALL_SCRIPT from "../../scripts/chat-recall.mjs?raw";

/** Exit code the script uses for "no local embedder here" — see chat-recall.mjs. */
const NO_EMBEDDER = 3;
/** A query is ~0.8s; past this something is wrong and the user is still typing. */
const QUERY_TIMEOUT_MS = 8000;
/** Indexing is incremental and near-free when nothing changed, but a first
 *  build embeds every conversation and downloads the model. */
const INDEX_TIMEOUT_MS = 600_000;

export interface RecallHost {
  /** Absolute path of the plugin directory — where conversations.json and the
   *  index live. */
  pluginDir: string;
  /** Absolute path of the bundled script. */
  scriptPath: string;
}

let unavailable = false;

/** Has the embedder already told us it is not here? Latched for the session so
 *  a missing install costs one spawn, not one per keystroke. */
export const isRecallUnavailable = (): boolean => unavailable;

/**
 * A real `node`, resolved the same way the plugin resolves its CLIs.
 *
 * NOT `process.execPath` with ELECTRON_RUN_AS_NODE: Obsidian's renderer helper
 * is built with macOS hardened runtime, and re-invoking it as Node dies with
 * SIGTRAP before the script runs. Measured, not assumed. `resolveCli` already
 * solves the harder half of this — a GUI app inherits no login-shell PATH, so
 * nvm-managed installs are invisible without it.
 */
async function nodeBin(): Promise<{ bin: string; pathEnv: string } | null> {
  try {
    return await resolveCli("node", "");
  } catch {
    return null;
  }
}

let scriptReady: Promise<boolean> | null = null;

/** Materialize the inlined script at `scriptPath`, rewriting it only when the
 *  bundled copy changed (a plugin update). Once per session. */
function ensureScript(scriptPath: string): Promise<boolean> {
  scriptReady ??= (async () => {
    try {
      const current = await readFile(scriptPath, "utf8").catch(() => null);
      if (current !== CHAT_RECALL_SCRIPT) await writeFile(scriptPath, CHAT_RECALL_SCRIPT);
      return true;
    } catch {
      return false;
    }
  })();
  return scriptReady;
}

async function run(host: RecallHost, args: string[], timeoutMs: number): Promise<string | null> {
  if (unavailable) return null;
  const node = await nodeBin();
  if (!node || !(await ensureScript(host.scriptPath))) {
    unavailable = true;
    return null;
  }
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(node.bin, [host.scriptPath, ...args], {
        cwd: host.pluginDir,
        env: { ...process.env, PATH: node.pathEnv },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      unavailable = true;
      return resolve(null);
    }
    let out = "";
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(value);
    };
    const timer = window.setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      // Only a definitive "not installed" latches. A crash or a missing index is
      // transient — the next turn may well have built one.
      if (code === NO_EMBEDDER) unavailable = true;
      finish(code === 0 ? out : null);
    });
  });
}

/** Conversation ids most related to `query`, best first. `null` means the pass
 *  could not run — never an empty array, which would read as "nothing is
 *  related" and let the caller clear a perfectly good Related section. */
export async function recallChats(
  host: RecallHost,
  query: string,
  limit = 12,
): Promise<string[] | null> {
  const scored = await recallChatScores(host, query, limit);
  return scored && scored.map((s) => s.id);
}

/** {@link recallChats} with each chat's similarity score, for callers that
 *  must tell a match from the index's best guess. */
export async function recallChatScores(
  host: RecallHost,
  query: string,
  limit = 12,
): Promise<{ id: string; score: number }[] | null> {
  const q = query.trim();
  if (!q) return null;
  const out = await run(host, ["query", host.pluginDir, q, String(limit)], QUERY_TIMEOUT_MS);
  if (out === null) return null;
  return out
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([score, id]) => !!id?.trim() && !Number.isNaN(Number(score)))
    .map(([score, id]) => ({ id: id.trim(), score: Number(score) }));
}

/** Bring the index up to date. Cheap and pipeline-free when nothing changed, so
 *  it is safe to call on view open and after a turn lands. */
export async function reindexChats(host: RecallHost): Promise<void> {
  await run(host, ["index", host.pluginDir], INDEX_TIMEOUT_MS);
}

/** Where the script is materialized: next to the built plugin. */
export const recallHost = (pluginDir: string): RecallHost => ({
  pluginDir,
  scriptPath: join(pluginDir, "chat-recall.mjs"),
});
