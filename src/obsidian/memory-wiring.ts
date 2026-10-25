import { Notice, TFile } from "obsidian";
import type ExoPlugin from "../main";
import { memoryCaps, type MemoryCaps } from "../core/memory-caps";
import { latestHarvestSha, reverseWrites, revertHarvestCommit, type UndoResult } from "../core/memory-undo";
import { MemoryHarvester } from "./memory-harvest";
import { HarvestLog } from "./harvest-log";
import { checkGitRepo, gitRunner, type GitRun } from "./git";
import { vaultBasePath } from "./tool-kit";
import { harvestSource } from "../ui/convo-bridge";
import { runUpkeep } from "./upkeep";

/**
 * Plugin-side wiring for automatic memory: the harvester (heartbeat, catch-up,
 * leave-triggered harvests), its log, and undo. Kept out of main.ts, which
 * sits under the size ratchet.
 */

/** How often due conversations are checked. The idle threshold (10 min) is
 *  what actually paces harvests; this only bounds the lag after it. */
export const HARVEST_HEARTBEAT_MS = 2 * 60 * 1000;
/** First catch-up after layout-ready: late enough to stay off the startup path. */
export const HARVEST_FIRST_TICK_MS = 60 * 1000;

/** Memory caps for the plugin's own surfaces (commands, capture, hub). */
export function pluginMemoryCaps(plugin: ExoPlugin): MemoryCaps {
  return memoryCaps(plugin.settings, { surface: "chat" });
}

function vaultGit(plugin: ExoPlugin): GitRun | null {
  const base = vaultBasePath(plugin.app);
  return base ? gitRunner(base) : null;
}

export function createHarvestLog(plugin: ExoPlugin): HarvestLog {
  const path = `${plugin.manifest.dir}/memory-harvests.json`;
  const adapter = plugin.app.vault.adapter;
  return new HarvestLog({
    read: async () => ((await adapter.exists(path)) ? adapter.read(path) : null),
    write: (content) => adapter.write(path, content),
    preserveCorrupt: (content) => adapter.write(`${plugin.manifest.dir}/memory-harvests.corrupt-${Date.now()}.json`, content),
  });
}

export function createMemoryHarvester(plugin: ExoPlugin, log: HarvestLog): MemoryHarvester {
  return new MemoryHarvester({
    app: plugin.app,
    caps: () => pluginMemoryCaps(plugin),
    paths: () => plugin.paths,
    source: () => harvestSource(plugin.app),
    utility: async (prompt, signal) => {
      let tokens: number | null = null;
      const text = await plugin.runUtilityPass(prompt, {
        signal,
        onUsage: (t) => {
          tokens = t;
        },
      });
      return { text, tokens };
    },
    budget: {
      check: (estimate) => plugin.checkBackgroundBudget(estimate),
      record: (tokens) => plugin.recordBackgroundSpend(tokens),
    },
    writeQueue: plugin.memoryWriteQueue,
    loopsWriteQueue: plugin.loopsWriteQueue,
    git: () => vaultGit(plugin),
    log,
    notify: (message) => new Notice(message, 8000),
    diag: (message) => plugin.diag.push("memory", message),
  });
}

/**
 * Undo a memory harvest: the latest one not yet undone, or `target` (a harvest
 * record id, or a commit sha or its prefix). With git: `git revert` (refused if a touched note changed
 * since). Without git: restore the harvest's snapshots (same refusal).
 */
export async function undoMemoryWrite(plugin: ExoPlugin, log: HarvestLog, target?: string): Promise<UndoResult> {
  const records = await log.list();
  const want = target?.trim();
  const record = want
    ? records.find((r) => r.id === want || (r.sha && (r.sha.startsWith(want) || want.startsWith(r.sha))))
    : records.find((r) => !r.undoneAt);
  if (record?.undoneAt) return { ok: false, message: "That harvest was already undone." };

  const git = vaultGit(plugin);
  const repo = git ? await checkGitRepo(git) : { isGitRepo: false, gitAvailable: false };
  const vault = undoVault(plugin);
  let result: UndoResult;
  if (record && !record.sha) {
    // Never committed (no git, or every note held uncommitted edits).
    result = await reverseWrites(vault, record.writes);
  } else if (git && repo.isGitRepo) {
    const sha = record?.sha ?? want ?? (await latestHarvestSha(git)) ?? undefined;
    if (!sha) result = { ok: false, message: "No memory harvest to undo." };
    else {
      const loose = record ? record.writes.filter((w) => record.uncommitted?.includes(w.path)) : [];
      const check = loose.length ? await reverseWrites(vault, loose, { dryRun: true }) : null;
      result = check && !check.ok ? check : await revertHarvestCommit(git, sha);
      // Notes written but not committed (they held the user's own edits) are
      // reversed line by line after the commit is reverted.
      if (result.ok && loose.length && check?.ok) {
        const rest = await reverseWrites(vault, loose);
        result = rest.ok ? result : { ok: false, partial: true, message: `${result.message} ${rest.message}` };
      }
    }
  } else if (record) {
    result = await reverseWrites(vault, record.writes);
  } else {
    result = { ok: false, message: want ? `No memory harvest ${want} on record.` : "No memory harvest to undo." };
  }
  // A partial undo cannot be retried (the restored notes no longer hold the
  // harvest's lines), so it closes the record like a full one.
  if ((result.ok || result.partial) && record) await log.markUndone(record.id, Date.now());
  plugin.refreshHub();
  return result;
}

function undoVault(plugin: ExoPlugin) {
  const vault = plugin.app.vault;
  return {
    read: async (path: string) => {
      const f = vault.getAbstractFileByPath(path);
      return f instanceof TFile ? vault.read(f) : null;
    },
    process: async (path: string, fn: (current: string) => string) => {
      const f = vault.getAbstractFileByPath(path);
      if (!(f instanceof TFile)) throw new Error(`File not found: ${path}`);
      await vault.process(f, fn);
    },
    remove: async (path: string) => {
      const f = vault.getAbstractFileByPath(path);
      if (f instanceof TFile) await plugin.app.fileManager.trashFile(f);
    },
  };
}

/** Build the harvester and its log onto the plugin, and register the undo
 *  command, the heartbeat and the first catch-up tick. Called in onload
 *  before the chat view registers: the view reports tab switches to it. */
export function registerMemory(plugin: ExoPlugin): void {
  plugin.harvestLog = createHarvestLog(plugin);
  plugin.memoryHarvest = createMemoryHarvester(plugin, plugin.harvestLog);
  plugin.register(() => plugin.memoryHarvest.dispose());

  plugin.addCommand({
    id: "undo-memory-write",
    name: "Undo last memory write",
    checkCallback: (checking) => {
      if (!pluginMemoryCaps(plugin).undo) return false;
      if (!checking) {
        void undoMemoryWrite(plugin, plugin.harvestLog).then((r) => new Notice(r.message, 8000));
      }
      return true;
    },
  });

  // The heartbeat also carries the daily knowledge upkeep (a no-op after its first run of the day).
  const beat = () => {
    void plugin.memoryHarvest.tick();
    void runUpkeep(plugin);
  };
  plugin.registerInterval(window.setInterval(beat, HARVEST_HEARTBEAT_MS));
  plugin.app.workspace.onLayoutReady(() => {
    const t = window.setTimeout(beat, HARVEST_FIRST_TICK_MS);
    plugin.register(() => window.clearTimeout(t));
  });
}
