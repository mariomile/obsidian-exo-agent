/**
 * Provider profiles: the per-provider BEHAVIOUR and SETTINGS choices the rest
 * of Exo branches on, in one table. `registry.ts` stays the runtime table
 * (display + session creation, and it pulls in the Agent SDK); this module is
 * pure — no Obsidian, no SDK — so core modules and tests can read it.
 *
 * Before this table every caller wrote `provider === "claude" ? … : …`, which
 * compiles fine for a third provider and silently routes it down the wrong
 * branch. A `Record<ProviderId, ProviderProfile>` makes a new provider a
 * compile error until every choice below is made for it.
 */
import type { PermissionMode, ProviderId } from "./types";
import type { MVASettings } from "../settings-schema";

/** Settings keys holding a plain string (not a literal union, so a write of
 *  any string type-checks), and those holding a string list. */
type StrKey = {
  [K in keyof MVASettings]-?: MVASettings[K] extends string ? (string extends MVASettings[K] ? K : never) : never;
}[keyof MVASettings];
type ListKey = { [K in keyof MVASettings]-?: MVASettings[K] extends string[] ? K : never }[keyof MVASettings];

export interface ProviderProfile {
  id: ProviderId;
  /** Short human name for labels ("Claude CLI not found", picker groups). */
  label: string;
  /** Binary name handed to `resolveCli` / `cliDiagnostics`. */
  cliName: string;
  /** Where this provider's per-provider settings live. */
  keys: { bin: StrKey; model: StrKey; customModels: StrKey; hiddenModels: ListKey };
  /** How the Obsidian tools reach the agent: the SDK's in-process MCP server,
   *  or the loopback MCP bridge — through the stdio relay script the CLI
   *  spawns (needs `node`), or straight over HTTP. */
  toolWiring: "in-process" | "bridge-stdio" | "bridge-http";
  /** How a bound named agent runs: a real isolated subagent (Claude's Agent
   *  tool), or this turn's system prompt replaced by the agent's instructions. */
  agentBinding: "subagent" | "system-prompt";
  /** Exo expands `.claude/commands` itself (the CLI doesn't read them). */
  expandVaultCommands: boolean;
  /** The composer permission chip: Claude-style modes, or Codex's sandbox. */
  permissionChip: "modes" | "codex-sandbox";
  /** The modes the chip offers when it shows modes. `auto` is Claude Code's
   *  classifier mode; a provider without it doesn't offer it. */
  permModes: readonly PermissionMode[];
  /** A live plan-mode switch only applies from the next turn. */
  planFromNextTurn: boolean;
  /** The native compact operation accepts free-text instructions. */
  compactTakesInstructions: boolean;
  /** How Exo checks a stored session id is still resumable: stat Claude's
   *  on-disk transcript, or trust the id (the CLI reports a bad one itself). */
  resumeProbe: "claude-jsonl" | "trust";
  /** The sign-in step on the "isn't ready" card. */
  signIn: string;
  /** Error wording: the CLI's login command, and whether it runs local
   *  models (unreachable-server / no-model failures get their own message). */
  failureWho: { name: string; login: string; localModels?: boolean };
  /** Placeholder for the custom-models textarea. */
  customModelsExample: string;
  /** Provider-only settings that need a respawn when they change. */
  signatureExtras(s: MVASettings): unknown[];
  /** Models for the background one-shots (AI titles, memory harvest,
   *  suggestions, distillation, agent seeding) when this is the default
   *  provider. `requested` is a caller's explicit pick for its own provider. */
  utility: {
    title(s: MVASettings): { model: string; effort: string };
    pass(s: MVASettings, requested?: string): string;
  };
}

export const PROFILES: Record<ProviderId, ProviderProfile> = {
  claude: {
    id: "claude",
    label: "Claude",
    cliName: "claude",
    keys: { bin: "claudeBin", model: "claudeModel", customModels: "claudeCustomModels", hiddenModels: "claudeHiddenModels" },
    toolWiring: "in-process",
    agentBinding: "subagent",
    expandVaultCommands: false,
    permissionChip: "modes",
    permModes: ["default", "acceptEdits", "plan", "auto", "bypassPermissions"],
    planFromNextTurn: false,
    compactTakesInstructions: true,
    resumeProbe: "claude-jsonl",
    signIn: "Open a terminal and run `claude` once to sign in.",
    failureWho: { name: "Claude", login: "claude auth login" },
    customModelsExample: "claude-opus-4-7\nclaude-opus-4-6",
    signatureExtras: () => [],
    utility: {
      // Haiku for a cheap, latency-sensitive one-liner; Haiku 5.5 thinks by
      // default and a title doesn't need it.
      title: () => ({ model: "claude-haiku-5-5", effort: "low" }),
      // Product floor for background passes is Sonnet — never Haiku.
      pass: (s, requested) => requested || s.backgroundModel || "claude-sonnet-5-5",
    },
  },
  codex: {
    id: "codex",
    label: "Codex",
    cliName: "codex",
    keys: { bin: "codexBin", model: "codexModel", customModels: "codexCustomModels", hiddenModels: "codexHiddenModels" },
    toolWiring: "bridge-stdio",
    agentBinding: "system-prompt",
    expandVaultCommands: true,
    permissionChip: "codex-sandbox",
    permModes: [], // the chip shows the sandbox instead
    planFromNextTurn: true,
    compactTakesInstructions: false,
    resumeProbe: "trust",
    signIn: "Open a terminal and run `codex` once to sign in.",
    failureWho: { name: "Codex", login: "codex login" },
    customModelsExample: "gpt-5.5\ngpt-5.6-terra",
    signatureExtras: (s) => [s.codexSandbox, s.codexApproval],
    utility: {
      title: (s) => ({ model: s.codexModel, effort: "low" }),
      pass: (s) => s.codexModel,
    },
  },
  opencode: {
    id: "opencode",
    label: "opencode",
    cliName: "opencode",
    keys: { bin: "opencodeBin", model: "opencodeModel", customModels: "opencodeCustomModels", hiddenModels: "opencodeHiddenModels" },
    // MCP over HTTP: opencode connects to the bridge itself, no `node` needed.
    toolWiring: "bridge-http",
    agentBinding: "system-prompt",
    expandVaultCommands: true,
    permissionChip: "modes",
    // No `auto`: opencode has no classifier mode, so it would only mean "ask".
    permModes: ["default", "acceptEdits", "plan", "bypassPermissions"],
    planFromNextTurn: false,
    compactTakesInstructions: true,
    resumeProbe: "trust",
    signIn: "Start your local model server (Ollama, LM Studio…) or run `opencode auth login` for a cloud provider.",
    failureWho: { name: "opencode", login: "opencode auth login", localModels: true },
    customModelsExample: "ollama/qwen3-coder\nlmstudio/gpt-oss-20b",
    signatureExtras: () => [],
    // The chat model ("" = opencode's own default): a local setup usually has
    // one model loaded, and loading a second just for titles would cost more.
    utility: {
      title: (s) => ({ model: s.opencodeModel, effort: "default" }),
      pass: (s) => s.opencodeModel,
    },
  },
};

/** Every provider, in picker/settings order. */
export const PROVIDER_IDS = Object.keys(PROFILES) as ProviderId[];

export function isProviderId(x: unknown): x is ProviderId {
  return typeof x === "string" && Object.prototype.hasOwnProperty.call(PROFILES, x);
}

/** One of a provider's string settings. */
export function providerStr(
  s: MVASettings,
  id: ProviderId,
  key: "bin" | "model" | "customModels"
): string {
  return s[PROFILES[id].keys[key]] ?? "";
}

/** A provider's hidden-model list. */
export function providerHidden(s: MVASettings, id: ProviderId): string[] {
  return s[PROFILES[id].keys.hiddenModels] ?? [];
}
