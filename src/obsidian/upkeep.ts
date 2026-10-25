/**
 * Knowledge upkeep, Obsidian side: once per local day, from the heartbeat,
 * every note whose supersede markers disagree is fixed through the correction
 * route (receipt, undo, "Exo corrected X" Notice). The plan is pure
 * (core/upkeep); the notes are scanned by the same pass recall uses.
 */
import type ExoPlugin from "../main";
import { dueToday, planUpkeep } from "../core/upkeep";
import { proposeMarkerFixes } from "./corrections";
import { scanNotes } from "./turn-recall";
import { vaultExclusion } from "./vault-search";

export interface UpkeepRun {
  ran: boolean;
  fixes: number;
}

const SKIPPED: UpkeepRun = { ran: false, fixes: 0 };
let running = false;

/** The daily sweep when it is due. Never throws; a run that could not look at
 *  the vault (suggestions off, index not ready, scan failed) leaves the day open. */
export async function runUpkeep(plugin: ExoPlugin, now = Date.now()): Promise<UpkeepRun> {
  if (running || !plugin.settings.proposalKernelEnabled || !dueToday(plugin.settings.lastUpkeepAt, now)) return SKIPPED;
  running = true;
  try {
    const { app } = plugin;
    const exclude = vaultExclusion(app);
    // A note the metadata cache has not read yet has no markers to judge.
    const found = scanNotes(app, (path) => {
      const file = app.vault.getFileByPath(path);
      return exclude(path) || !file || !app.metadataCache.getFileCache(file);
    });
    if (!found.names.length) return SKIPPED;
    const closed = new Set((await plugin.proposalStore.load()).data.closedCorrections);
    const { fixes } = planUpkeep(found.supersede, closed);
    if (fixes.length) await proposeMarkerFixes(app, fixes, "upkeep");
    plugin.settings.lastUpkeepAt = now;
    await plugin.saveSettings();
    return { ran: true, fixes: fixes.length };
  } catch {
    return SKIPPED;
  } finally {
    running = false;
  }
}
