/**
 * "Save to note", Obsidian side: write a block through `vault.process`, keep
 * its receipt, undo it exactly. The rules (where, what, when undo is safe)
 * live in core/save-target, core/block-patch and core/save-undo. Accepted
 * correction proposals write here too, so they share receipts and undo.
 */
import { Notice, TFile, type App } from "obsidian";
import type ExoPlugin from "../main";
import { planCorrection } from "../core/correction";
import { formatSaveBlock, newAnchor, planInsert, type PatchPlan, type Provenance, type SaveBlock } from "../core/block-patch";
import { sectionIsList, type SaveTarget } from "../core/save-target";
import { planUndo, receiptFor, type SaveReceipt, type UndoPlan } from "../core/save-undo";
import type { ProposalAcceptanceDeps } from "./proposal-router";
import { SaveLog } from "./save-log";
import { ensureParentFolder, today } from "./tool-kit";

export type SaveError = "section-missing" | "nothing-to-save";

/** Plan the block for `content`: fresh anchor, fact or passage by section shape. */
function planFor(content: string, target: SaveTarget, text: string, provenance: Provenance) {
  const block = formatSaveBlock(text, provenance, newAnchor(Math.random, content), sectionIsList(content, target.section));
  return { block, plan: planInsert(content, target.section, block) };
}

export async function saveToNote(
  app: App,
  log: SaveLog,
  input: { target: SaveTarget; text: string; provenance: Provenance },
): Promise<SaveReceipt | { error: SaveError }> {
  if (!input.text.trim()) return { error: "nothing-to-save" };
  const path = input.target.path.endsWith(".md") ? input.target.path : `${input.target.path}.md`;
  const target = { ...input.target, path };
  const file = app.vault.getAbstractFileByPath(path);
  let made = null as { block: SaveBlock; plan: PatchPlan } | null;
  if (file instanceof TFile) {
    await app.vault.process(file, (content) => {
      const r = planFor(content, target, input.text, input.provenance);
      if ("error" in r.plan) return content;
      made = { block: r.block, plan: r.plan };
      return r.plan.next;
    });
  } else if (!file) {
    const r = planFor("", target, input.text, input.provenance);
    if (!("error" in r.plan)) {
      await ensureParentFolder(app, path);
      await app.vault.create(path, r.plan.next);
      made = { block: r.block, plan: r.plan };
    }
  }
  if (!made) return { error: "section-missing" };
  const { block, plan } = made;
  const receipt = receiptFor({ path, section: target.section, block, plan, provenance: input.provenance, createdNote: !file, savedAt: Date.now() });
  await log.record(receipt);
  return receipt;
}

const CORRECTION_ERROR = {
  "line-missing": "The outdated line is no longer in",
  "line-ambiguous": "The outdated line appears more than once in",
} as const;

/** Where an accepted correction proposal is written: in place, through
 *  `vault.process`, with a receipt in the save log so "Undo last save" and
 *  the Inbox undo revert it like any save. Throws a readable reason. */
export function noteCorrections(
  app: App,
  log: () => SaveLog,
  noteWrite: (paths: readonly string[]) => void,
): ProposalAcceptanceDeps["corrections"] {
  return {
    apply: async ({ path, change, convoId, title }) => {
      const file = app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) throw new Error(`Note not found: ${path}`);
      const provenance: Provenance = { convoId, msgIndex: 0, chatTitle: title, date: today() };
      let made = null as ReturnType<typeof planCorrection> | null;
      await app.vault.process(file, (content) => {
        made = planCorrection(content, change, { id: newAnchor(Math.random, content), path, provenance, savedAt: Date.now() });
        return "error" in made ? content : made.next;
      });
      if (!made) throw new Error(`Note not found: ${path}`);
      if ("error" in made) throw new Error(`${CORRECTION_ERROR[made.error]} ${file.basename}. Open the note to fix it by hand.`);
      await log().record(made.receipt);
      noteWrite([path]);
      return { path };
    },
  };
}

async function undoIn(app: App, r: SaveReceipt, path: string): Promise<UndoPlan> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return { ok: false, reason: "block-missing" };
  let plan = { ok: false, reason: "block-missing" } as UndoPlan;
  await app.vault.process(file, (content) => {
    plan = planUndo(content, r);
    return plan.ok && plan.next !== null ? plan.next : content;
  });
  if (plan.ok && plan.next === null) await app.fileManager.trashFile(file);
  return plan;
}

/** Undo save `id`, or the last one not undone. A block that moved is found by
 *  its anchor in the metadata cache, once. Null when there is nothing to undo. */
export async function undoSave(app: App, log: SaveLog, id?: string): Promise<UndoPlan | null> {
  const r = id ? await log.find(id) : await log.last();
  if (!r) return null;
  let plan = await undoIn(app, r, r.path);
  if (!plan.ok && plan.reason === "block-missing") {
    const moved = app.vault.getMarkdownFiles().find((f) => f.path !== r.path && app.metadataCache.getFileCache(f)?.blocks?.[r.id]);
    if (moved) plan = await undoIn(app, r, moved.path);
  }
  if (plan.ok) await log.markUndone(r.id, Date.now());
  return plan;
}

const UNDO_NOTICE: Record<string, string> = {
  ok: "Save undone.",
  "block-edited": "This block was edited after saving. Open the note to change it by hand.",
  "line-changed": "This line was edited after saving. Open the note to change it by hand.",
  "block-missing": "The saved block is no longer in the vault.",
  "already-undone": "Already undone.",
  none: "Nothing to undo.",
};

/** Undo and say what happened. True when the save is undone. */
export async function undoSaveWithNotice(app: App, log: SaveLog, id?: string): Promise<boolean> {
  const plan = await undoSave(app, log, id);
  new Notice(UNDO_NOTICE[!plan ? "none" : plan.ok ? "ok" : plan.reason]);
  return plan?.ok === true;
}

/** The receipt log in the plugin folder and the "Undo last save to note" command. */
export function registerNoteSaves(plugin: ExoPlugin): SaveLog {
  const path = `${plugin.manifest.dir}/note-saves.json`;
  const adapter = plugin.app.vault.adapter;
  const log = new SaveLog({
    read: async () => ((await adapter.exists(path)) ? adapter.read(path) : null),
    write: (content) => adapter.write(path, content),
    preserveCorrupt: (content) => adapter.write(`${plugin.manifest.dir}/note-saves.corrupt-${Date.now()}.json`, content),
  });
  plugin.addCommand({
    id: "undo-last-save",
    name: "Undo last save to note",
    callback: () => void undoSaveWithNotice(plugin.app, log),
  });
  return log;
}
