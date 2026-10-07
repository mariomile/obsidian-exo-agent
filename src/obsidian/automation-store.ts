/**
 * Automation store — the single read/write path for unified automations.
 *
 * Scans `<memoryRoot>/automations/*.md`, parses each file through the pure
 * model, and keeps an in-memory map keyed by slug. Files that fail to parse
 * are never dropped: they surface through `errors()` so the hub can render
 * them in an error state with the problem in plain words.
 *
 * IO goes through the same structural `AgentVaultAdapter` slice the agent
 * store uses (plus `rename` for archiving), so the store is unit-testable
 * against an in-memory fake. Archiving moves files under `.archive/` — the
 * vault rule is "never delete".
 */
import type { App } from "obsidian";
import {
  parseAutomationFile,
  serializeAutomation,
  type Automation,
} from "../core/automation-model";
import { archivedAutomationPath, automationFromAgent, automationFromPlaybook, scheduleRunKeys } from "../core/automation-model";
import { slugifyAgent } from "../core/agents";
import type { ExoPaths } from "../core/paths";
import { adaptAppToAgentVault, type AgentVaultAdapter } from "./agent-store";
import type { AgentStore } from "./agent-store";
import type { AutomationConfig } from "../core/automations";

export interface AutomationVaultAdapter extends AgentVaultAdapter {
  rename(from: string, to: string): Promise<void>;
}

export function adaptAppToAutomationVault(app: App): AutomationVaultAdapter {
  return {
    ...adaptAppToAgentVault(app),
    rename: async (from, to) => {
      const file = app.vault.getAbstractFileByPath(from);
      if (!file) return;
      await app.fileManager.renameFile(file, to);
    },
  };
}

export interface AutomationParseError {
  slug: string;
  problem: string;
}

export class AutomationStore {
  private items = new Map<string, Automation>();
  private problems: AutomationParseError[] = [];
  private loaded = false;
  private listeners: (() => void)[] = [];

  constructor(
    private vault: AutomationVaultAdapter,
    private paths: ExoPaths,
  ) {}

  isLoaded(): boolean {
    return this.loaded;
  }

  filePath(slug: string): string {
    return `${this.paths.automations}/${slug}.md`;
  }

  /** True when a vault path lives inside the automations folder. */
  owns(path: string): boolean {
    return path.startsWith(`${this.paths.automations}/`) && path.endsWith(".md");
  }

  async refresh(): Promise<void> {
    const items = new Map<string, Automation>();
    const problems: AutomationParseError[] = [];
    for (const path of await this.vault.listFiles(this.paths.automations)) {
      if (!path.endsWith(".md")) continue;
      const slug = path.slice(path.lastIndexOf("/") + 1, -3);
      try {
        const raw = await this.vault.read(path);
        const { automation, warnings } = parseAutomationFile(slug, raw);
        items.set(slug, automation);
        if (warnings.length) problems.push({ slug, problem: warnings.join("; ") });
      } catch (err) {
        problems.push({ slug, problem: String(err) });
      }
    }
    this.items = items;
    this.problems = problems;
    this.loaded = true;
    for (const cb of this.listeners) cb();
  }

  list(): Automation[] {
    return [...this.items.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  errors(): AutomationParseError[] {
    return [...this.problems];
  }

  get(slug: string): Automation | null {
    return this.items.get(slug) ?? null;
  }

  async save(a: Automation): Promise<void> {
    await this.vault.ensureFolder(this.paths.automations);
    await this.vault.write(this.filePath(a.slug), serializeAutomation(a));
    this.items.set(a.slug, a);
    for (const cb of this.listeners) cb();
  }

  /** Move the file to the same path under `.archive/` — never delete. */
  async archive(slug: string): Promise<void> {
    const from = this.filePath(slug);
    if (!(await this.vault.exists(from))) {
      this.items.delete(slug);
      return;
    }
    let to = archivedAutomationPath(this.paths.automations, slug);
    await this.vault.ensureFolder(to.slice(0, to.lastIndexOf("/")));
    if (await this.vault.exists(to)) to = to.replace(/\.md$/, `-${Date.now()}.md`);
    await this.vault.rename(from, to);
    this.items.delete(slug);
    for (const cb of this.listeners) cb();
  }

  onChange(cb: () => void): void {
    this.listeners.push(cb);
  }
}

/* ------------------------------ migration ------------------------------ */

export interface LegacyAutomationSettings {
  automations: AutomationConfig[];
  customPrompts: { name: string; prompt: string }[];
  /** Per-slot "last ran at". Re-keyed by the migration: playbook automations
   *  used to be keyed by prompt NAME, automations are keyed by run key. */
  scheduledLastRun: Record<string, number>;
}

/**
 * One-shot migration: settings playbooks and agent contract sidecars become
 * automation files. Returns human-readable notices; `ok` is false when any
 * item failed (caller must then NOT set the migrated flag).
 *
 * Mutates `legacy` in place on success (clears migrated entries) — the caller
 * persists settings.
 */
export async function migrateToAutomationFiles(
  store: AutomationStore,
  agentStore: Pick<AgentStore, "list">,
  legacy: LegacyAutomationSettings,
  vault: AutomationVaultAdapter,
  paths: ExoPaths,
): Promise<{ ok: boolean; notices: string[] }> {
  const notices: string[] = [];
  let ok = true;

  // 1. Settings playbooks → files.
  const migratedPromptNames = new Set<string>();
  for (const cfg of legacy.automations) {
    try {
      const prompt = cfg.system
        ? ""
        : (legacy.customPrompts.find((p) => p.name.toLowerCase() === cfg.name.toLowerCase())?.prompt ?? "");
      if (!cfg.system && !prompt) notices.push(`"${cfg.name}": no matching playbook prompt — migrated with empty prompt`);
      const a = automationFromPlaybook(cfg, prompt);
      if (store.get(a.slug)) continue; // already migrated (re-run after partial failure)
      await store.save(a);
      // Carry the old "last ran" forward under the new key. Without this every
      // migrated schedule reads as never-run and the whole set fires at once on
      // the first heartbeat after the upgrade.
      carryLastRun(legacy, a, legacy.scheduledLastRun[cfg.name]);
      if (prompt) migratedPromptNames.add(cfg.name.toLowerCase());
      notices.push(`migrated schedule "${cfg.name}"`);
    } catch (err) {
      ok = false;
      notices.push(`FAILED "${cfg.name}": ${String(err)}`);
    }
  }

  // 2. Agent contracts with unattended triggers → files; sidecar archived.
  for (const def of agentStore.list()) {
    try {
      const a = automationFromAgent(def);
      if (!a) continue;
      if (!store.get(a.slug)) {
        await store.save(a);
        // Agent schedules already used this key shape (slug + trigger), so the
        // existing value survives; only a missing one is stamped.
        carryLastRun(legacy, a, undefined);
        notices.push(`migrated agent "${def.brain.name}"`);
      }
      const sidecar = `${paths.agents}/${def.contract.slug}.md`;
      if (await vault.exists(sidecar)) {
        await vault.ensureFolder(".archive/agents");
        let to = `.archive/agents/${def.contract.slug}.md`;
        if (await vault.exists(to)) to = `.archive/agents/${def.contract.slug}-${Date.now()}.md`;
        await vault.rename(sidecar, to);
      }
    } catch (err) {
      ok = false;
      notices.push(`FAILED agent "${def.brain.name}": ${String(err)}`);
    }
  }

  if (ok) {
    legacy.automations = [];
    legacy.customPrompts = legacy.customPrompts.filter((p) => !migratedPromptNames.has(p.name.toLowerCase()));
  }
  return { ok, notices };
}

/** Stamp the automation's schedule keys, preferring a carried-over value and
 *  falling back to "now" — an unstamped key means "never ran", i.e. due. */
function carryLastRun(legacy: LegacyAutomationSettings, a: Automation, previous: number | undefined): void {
  for (const key of scheduleRunKeys(a)) {
    if (legacy.scheduledLastRun[key]) continue;
    legacy.scheduledLastRun[key] = previous && previous > 0 ? previous : Date.now();
  }
}

/** Convenience for tests and main: slug a new automation name safely. */
export function automationSlug(name: string): string {
  return slugifyAgent(name) || "automation";
}
