import { execFile } from "child_process";
import { OpencodeSession } from "./opencode-acp";
import type { AgentSession, ModelOption, ProviderAdapter, SessionOpts } from "./types";
import type { ResolvedCli } from "../cli";
import { spawnSpec } from "../core/win-cli";

/** Model ids in `opencode models` output: one `<provider>/<model>` per line. */
export function parseOpencodeModels(stdout: string): ModelOption[] {
  const seen = new Set<string>();
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[\w.-]+\/\S+$/.test(l) && !seen.has(l) && !!seen.add(l))
    .map((id) => ({ id, label: id }));
}

/** The models opencode can run right now — its configured providers plus
 *  discovered local servers — for the settings dropdown before any chat has
 *  spawned a session. `--standalone` keeps it off the user's shared service.
 *  Resolves [] on any failure. */
export function listOpencodeModels(cli: ResolvedCli, cwd: string): Promise<ModelOption[]> {
  const s = spawnSpec(cli.bin, ["models", "--standalone"]);
  return new Promise((resolve) => {
    execFile(
      s.command,
      s.args,
      { cwd, env: { ...process.env, PATH: cli.pathEnv }, timeout: 60_000, windowsHide: true },
      (err, stdout) => resolve(err ? [] : parseOpencodeModels(String(stdout)))
    );
  });
}

export { OpencodeSession, type OpencodeSessionRuntime } from "./opencode-acp";

/** Icon id of the opencode mark, registered in ui/icons.ts. */
export const OPENCODE_MARK = "exo-opencode-mark";

export const opencodeAdapter: ProviderAdapter = {
  id: "opencode",
  displayName: "opencode",
  brandColor: "#4b4646",
  icon: OPENCODE_MARK,
  iconTinted: false,

  models(): ModelOption[] {
    // No pinned list: the models are whatever the user's opencode config and
    // its local-server discovery provide. The live catalog comes from the
    // session's config options (and `opencode models` in settings).
    return [];
  },

  createSession(opts: SessionOpts): AgentSession {
    return new OpencodeSession(opts);
  },
};
