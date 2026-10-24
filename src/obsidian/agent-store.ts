/**
 * Agent store — the single read/write path for the agent registry.
 *
 * Joins the two halves of an agent: the CLI-native **brain**
 * (`.claude/agents/<slug>.md`, discovered across scopes, never written) and the
 * Exo **contract** (`<memoryRoot>/agents/<slug>.md`, owned here). Every write
 * goes through one shared `WriteQueue`, matching the contract already used by
 * the open-loops ledger.
 *
 * Both IO surfaces are injected as structural slices — `AgentVaultAdapter` for
 * the vault and a `brains()` thunk for the multi-scope filesystem walk — so the
 * join, scaffold and conflict logic is unit-testable against in-memory fakes
 * without a real Obsidian `App`.
 */
import { TFile, type App } from "obsidian";
import { readFile } from "fs/promises";
import {
  formatDuration,
  isAgentSidecar,
  mergeAgents,
  orphanContracts,
  parseAgentBrain,
  parseCodexAgentToml,
  codexTomlValue,
  parseAgentSidecar,
  reconcileInvocable,
  resolveAgent,
  serializeAgentSidecar,
  serializeTrigger,
  stripFrontmatter,
  type AgentBrain,
  type AgentContract,
  type AgentDef,
  type AgentSource,
} from "../core/agents";
import { patchFrontmatter } from "../core/frontmatter-patch";
import {
  agentMemoryExcerpt,
  agentMemoryPath,
  initialAgentMemory,
  ledgerFileName,
  parseAgentLedger,
  serializeAgentRun,
  sortRuns,
  type AgentRunRecord,
} from "../core/agent-ledger";
import { seededContract } from "../core/agent-seeds";
import { appendUnderHeading, journalAlreadyHas, JOURNAL_HEADING } from "../core/agent-journal";
import { listAgentBrains } from "../core/capability-desc";
import type { ExoPaths } from "../core/paths";
import { WriteQueue } from "../core/write-queue";

/** A brain file as found on disk, before parsing. */
export interface RawBrain {
  slug: string;
  path: string;
  raw: string;
  source: AgentSource;
}

/** Structural slice of the vault API this module needs. */
export interface AgentVaultAdapter {
  /** Vault-relative paths of the files directly inside `dir` (missing → []). */
  listFiles(dir: string): Promise<string[]>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  ensureFolder(dir: string): Promise<void>;
}

export function adaptAppToAgentVault(app: App): AgentVaultAdapter {
  return {
    listFiles: async (dir) => {
      try {
        return (await app.vault.adapter.list(dir)).files;
      } catch {
        return []; // missing folder is the normal case before first use
      }
    },
    read: (path) => app.vault.adapter.read(path),
    write: async (path, content) => {
      const file = app.vault.getAbstractFileByPath(path);
      // Prefer the Vault API over the adapter so Obsidian's cache, Sync and
      // the plugin's own file watchers all see the change.
      if (file instanceof TFile) await app.vault.modify(file, content);
      else await app.vault.create(path, content);
    },
    exists: (path) => app.vault.adapter.exists(path),
    ensureFolder: async (dir) => {
      if (!dir || app.vault.getAbstractFileByPath(dir)) return;
      try {
        await app.vault.createFolder(dir);
      } catch {
        /* raced with another writer, or already exists */
      }
    },
  };
}

export interface AgentStoreDeps {
  vault: AgentVaultAdapter;
  paths: ExoPaths;
  queue: WriteQueue;
  /** Multi-scope brain discovery. Injected so tests avoid the filesystem. */
  brains: () => Promise<RawBrain[]>;
  /** The engine's own agent list from the last `system/init`, when one exists —
   *  ground truth for invocable ids. Absent/empty simply skips reconciliation. */
  caps?: () => readonly string[];
}

/** A sidecar file that exists but is not an Exo contract — a pre-existing note
 *  that happens to live in the agents folder. Never parsed, never overwritten. */
export interface AgentConflict {
  slug: string;
  path: string;
}

export class AgentStore {
  private agents: AgentDef[] = [];
  private warningsBySlug = new Map<string, string[]>();
  private orphanSlugs: string[] = [];
  private conflictFiles: AgentConflict[] = [];
  /** Slugs whose contract file exists on disk (set during refresh). */
  private sidecarSlugs = new Set<string>();
  private listeners = new Set<() => void>();
  private loaded = false;

  constructor(private deps: AgentStoreDeps) {}

  /* ------------------------------ reads ------------------------------ */

  list(): AgentDef[] {
    return this.agents;
  }

  get(slug: string): AgentDef | null {
    return this.agents.find((a) => a.brain.slug === slug) ?? null;
  }

  /** Resolve a loose user-typed reference (`@handle`, slug, or display name). */
  resolve(query: string): AgentDef | null {
    return resolveAgent(this.agents, query);
  }

  /** Enabled agents only — the set any trigger is allowed to consider. */
  enabled(): AgentDef[] {
    return this.agents.filter((a) => a.contract.enabled);
  }

  warningsFor(slug: string): string[] {
    return this.warningsBySlug.get(slug) ?? [];
  }

  /** Contracts whose brain disappeared (renamed or deleted agent). */
  orphans(): string[] {
    return this.orphanSlugs;
  }

  /** Files in the agents folder that are not contracts. Surfaced, not touched. */
  conflicts(): AgentConflict[] {
    return this.conflictFiles;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /* ----------------------------- refresh ----------------------------- */

  /** Rescan both halves and rebuild the registry. Never throws. */
  async refresh(): Promise<void> {
    const { vault, paths } = this.deps;

    const rawBrains = await this.deps.brains().catch((): RawBrain[] => []);
    const brains: AgentBrain[] = rawBrains.map((b) =>
      b.path.endsWith(".toml")
        ? parseCodexAgentToml(b.raw, b.slug, b.source, b.path)
        : parseAgentBrain(b.raw, b.slug, b.source, b.path)
    );

    const contracts: AgentContract[] = [];
    const warnings = new Map<string, string[]>();
    const conflicts: AgentConflict[] = [];
    const sidecars = new Set<string>();

    // A canonical bundle's AGENT.md carries the human contract and the prompt
    // in one file. Register its frontmatter before scanning any legacy flat
    // entries so the bundle is the single source of truth.
    for (const brain of rawBrains) {
      if (brain.source !== "vault" || !brain.path.endsWith("/AGENT.md")) continue;
      if (!isAgentSidecar(brain.raw)) continue;
      sidecars.add(brain.slug);
      const { contract, warnings: w } = parseAgentSidecar(brain.raw, brain.slug);
      contracts.push(contract);
      if (w.length) warnings.set(brain.slug, w);
    }

    for (const file of await vault.listFiles(paths.agents)) {
      if (!file.endsWith(".md")) continue;
      const slug = file.split("/").pop()!.replace(/\.md$/, "");
      if (sidecars.has(slug)) continue; // canonical bundle wins over a stale flat sidecar
      let raw: string;
      try {
        raw = await vault.read(file);
      } catch {
        continue;
      }
      if (!isAgentSidecar(raw)) {
        conflicts.push({ slug, path: file });
        continue;
      }
      sidecars.add(slug);
      const { contract, warnings: w } = parseAgentSidecar(raw, slug);
      contracts.push(contract);
      if (w.length) warnings.set(slug, w);
    }

    this.agents = reconcileInvocable(mergeAgents(brains, contracts), this.deps.caps?.() ?? []);
    this.warningsBySlug = warnings;
    this.orphanSlugs = orphanContracts(brains, contracts);
    this.conflictFiles = conflicts;
    this.sidecarSlugs = sidecars;
    this.loaded = true;
    this.emit();
  }

  /* ------------------------------ writes ----------------------------- */

  /**
   * Create an inert sidecar for every brain that has none. Returns the paths
   * written.
   *
   * Scaffolding never grants autonomy: the generated contract is disabled with
   * no triggers and no write scope, so discovering an agent can never make it
   * start doing things. A conflicting non-contract file is left untouched.
   *
   * Only the user's own agents (vault and `~/.claude`) get a sidecar. Installed
   * plugins ship agents by the hundred, their ids contain a `:` that has no
   * business in a filename, and nobody wants a trigger contract for a
   * marketplace code reviewer — they stay discoverable and bindable, just not
   * schedulable.
   */
  async scaffoldMissing(today = ""): Promise<string[]> {
    const { vault, paths, queue } = this.deps;
    const conflicting = new Set(this.conflictFiles.map((c) => c.slug));
    const missing = this.agents.filter(
      (a) =>
        (a.brain.source === "vault" || a.brain.source === "user")
        && !conflicting.has(a.brain.slug)
        && !this.hasSidecarFor(a.brain.slug)
    );
    if (!missing.length) return [];

    return queue.enqueue(async () => {
      await vault.ensureFolder(paths.agents);
      const written: string[] = [];
      for (const agent of missing) {
        const path = this.sidecarPath(agent.brain.slug);
        if (await vault.exists(path)) continue; // raced, or a conflict we skipped
        // A recognised agent gets a plausible starting contract instead of a
        // blank one — still disabled, so this suggests rather than activates.
        await vault.write(path, serializeAgentSidecar(seededContract(agent.brain.slug), agent.brain, today));
        written.push(path);
      }
      return written;
    });
  }

  /** Persist a contract. Canonical bundles keep their Markdown body intact;
   *  only the AGENT.md frontmatter is replaced. */
  async saveContract(contract: AgentContract, today = ""): Promise<void> {
    const { vault, paths, queue } = this.deps;
    const brain = this.get(contract.slug)?.brain;
    await queue.enqueue(async () => {
      await vault.ensureFolder(paths.agents);
      const path = this.sidecarPath(contract.slug);
      const serialized = serializeAgentSidecar(contract, brain, today);
      if (path.endsWith("/AGENT.md") && await vault.exists(path)) {
        const existing = await vault.read(path);
        await vault.write(path, patchFrontmatter(existing, {
          enabled: contract.enabled,
          icon: contract.icon,
          autonomy: contract.autonomy,
          output: contract.output,
          cooldown: formatDuration(contract.cooldownMs),
          read: contract.scope.read,
          write: contract.scope.write,
          can_call: contract.canCall,
          triggers: contract.triggers.map(serializeTrigger),
          ...(today ? { last_updated: today } : {}),
        }));
      } else {
        await vault.write(path, serialized);
      }
    });
    await this.refresh();
  }

  /** Flip a single agent on or off without touching the rest of its contract. */
  async setEnabled(slug: string, enabled: boolean, today = ""): Promise<void> {
    const agent = this.get(slug);
    if (!agent) return;
    await this.saveContract({ ...agent.contract, enabled }, today);
  }

  sidecarPath(slug: string): string {
    const brain = this.get(slug)?.brain;
    if (brain?.source === "vault" && brain.path?.endsWith(`/${slug}/AGENT.md`)) return brain.path;
    return `${this.deps.paths.agents}/${slug}.md`;
  }

  /* ------------------------ run ledger + memory ----------------------- */

  ledgerPath(at: number): string {
    return `${this.deps.paths.agentRuns}/${ledgerFileName(at)}`;
  }

  memoryPath(slug: string): string {
    return agentMemoryPath(this.deps.paths.agentMemory, slug);
  }

  /**
   * Append one run to the month's ledger.
   *
   * Append-only and serialized on the shared queue: the ledger is evidence, so
   * a concurrent run must never rewrite another's block. A failure here is
   * swallowed — losing a ledger line is bad, but failing the run that already
   * did its work would be worse.
   */
  async appendRun(record: AgentRunRecord): Promise<void> {
    const { vault, paths, queue } = this.deps;
    const path = this.ledgerPath(record.startedAt);
    await queue
      .enqueue(async () => {
        await vault.ensureFolder(paths.agentRuns);
        const existing = (await vault.exists(path)) ? await vault.read(path) : "";
        await vault.write(path, existing + (existing && !existing.endsWith("\n") ? "\n" : "") + serializeAgentRun(record));
      })
      .catch((err) => {
        console.warn("[Exo] agent ledger append failed:", err);
      });
  }

  /** Runs recorded in the ledger file covering `at` (default: now), newest first. */
  async readRuns(at = Date.now()): Promise<AgentRunRecord[]> {
    const path = this.ledgerPath(at);
    try {
      if (!(await this.deps.vault.exists(path))) return [];
      return sortRuns(parseAgentLedger(await this.deps.vault.read(path)));
    } catch {
      return [];
    }
  }

  /**
   * Append one line to today's daily note, under the agents heading.
   *
   * Serialized on the shared queue and read-modify-write, because the daily
   * note is a file the user may have open and other plugins may also append to.
   * Never creates the note: if there is no daily note for today, the run's line
   * is dropped rather than conjuring a file the user did not ask for — the
   * ledger still has the run. Returns whether the line landed.
   */
  async appendJournal(dailyPath: string, line: string): Promise<boolean> {
    const { vault, queue } = this.deps;
    if (!dailyPath) return false;
    return queue
      .enqueue(async () => {
        if (!(await vault.exists(dailyPath))) return false;
        const content = await vault.read(dailyPath);
        if (journalAlreadyHas(content, line)) return false;
        await vault.write(dailyPath, appendUnderHeading(content, JOURNAL_HEADING, line));
        return true;
      })
      .catch((err) => {
        console.warn("[Exo] journal append failed:", err);
        return false;
      });
  }

  /** An agent's memory, creating the file on first use. Returns the excerpt that
   *  rides into a run prompt, plus the path the agent may append to. */
  async loadMemory(agent: AgentDef, today = ""): Promise<{ path: string; excerpt: string }> {
    const { vault, paths, queue } = this.deps;
    const path = this.memoryPath(agent.brain.slug);
    try {
      if (!(await vault.exists(path))) {
        await queue.enqueue(async () => {
          await vault.ensureFolder(paths.agentMemory);
          if (!(await vault.exists(path))) {
            await vault.write(path, initialAgentMemory(agent.brain.name, agent.brain.slug, today));
          }
        });
        return { path, excerpt: "" };
      }
      return { path, excerpt: agentMemoryExcerpt(await vault.read(path)) };
    } catch {
      // No memory is a degraded run, not a failed one.
      return { path, excerpt: "" };
    }
  }

  /* --------------------------- subscription -------------------------- */

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* a broken listener must not break the store */
      }
    }
  }

  /** Whether a contract file was actually seen on the last refresh. Recorded
   *  during the scan rather than inferred from the parsed contract: a freshly
   *  scaffolded sidecar is byte-identical in meaning to a missing one, so any
   *  content-based heuristic would re-scaffold it forever. */
  private hasSidecarFor(slug: string): boolean {
    return this.sidecarSlugs.has(slug);
  }
}

/**
 * An agent's own instructions — its markdown body, frontmatter stripped — for
 * engines with no native subagent mechanism tied to the file itself (Codex):
 * this is what rides as the session's system prompt when there is no isolated
 * subagent available to load it the way Claude's `Agent`/`Task` tool does.
 *
 * Vault-scope brains are read through the Vault API (respects Sync and the
 * in-memory cache); every other scope (`~/.claude`, `~/.codex`, installed
 * plugins) is an absolute filesystem path, per `capability-desc.ts`'s own
 * scope split, so it falls back to a direct read. Returns "" rather than
 * throwing — a missing body degrades a run to Exo's own persona, it does not
 * fail it.
 */
export async function readAgentBrainBody(app: App, brain: AgentBrain): Promise<string> {
  if (!brain.path) return "";
  try {
    const raw =
      brain.source === "vault" ? await app.vault.adapter.read(brain.path) : await readFile(brain.path, "utf8");
    // A Codex agent is TOML: its instructions are one key, not "everything
    // after the frontmatter". Stripping frontmatter here would hand the model
    // the raw TOML — the file's own syntax as its persona.
    if (brain.path.endsWith(".toml")) return codexTomlValue(raw, "developer_instructions") ?? "";
    const contract = stripFrontmatter(raw).trim();
    if (!brain.path.endsWith("/AGENT.md")) return contract;
    const soulPath = brain.path.replace(/\/AGENT\.md$/, "/SOUL.md");
    let soul = "";
    try { soul = stripFrontmatter(await app.vault.adapter.read(soulPath)).trim(); } catch { /* optional */ }
    return [soul ? `<agent-soul>\n${soul}\n</agent-soul>` : "", contract].filter(Boolean).join("\n\n");
  } catch (err) {
    console.warn(`[Exo] could not read agent brain body for "${brain.slug}":`, err);
    return "";
  }
}

/** Wire a store against a real Obsidian app. `caps` is read lazily so a refresh
 *  after the first session's init picks up the engine's real agent list. */
export function createAgentStore(
  app: App,
  paths: ExoPaths,
  queue: WriteQueue,
  caps?: () => readonly string[]
): AgentStore {
  return new AgentStore({
    vault: adaptAppToAgentVault(app),
    paths,
    queue,
    brains: () => listAgentBrains(app, paths.agents),
    caps,
  });
}
