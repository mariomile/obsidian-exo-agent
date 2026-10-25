/**
 * Corrections: recall's marker fixes and the agent's `propose_correction`.
 * Both go through the proposal store, which writes them straight into the note
 * with an undo receipt (obsidian/note-save `noteCorrections`). Only a fix that
 * no longer applies stays in the Inbox, with its reason.
 */
import * as z from "zod";
import { TFile, type App } from "obsidian";
import { claudeSdk } from "../providers/sdk-loader";
import { quotedLine } from "../core/correction";
import { frontmatterKeyLines } from "../core/frontmatter-patch";
import { correctionCandidate, type ProposalCandidate } from "../core/proposals";
import { formatSupersede, markerKeys, type MarkerFix } from "../core/supersede";
import { resolveLink } from "./graph";
import { err, getExo, ok, today } from "./tool-kit";

/** Append each candidate (a correction is written on append); refresh the
 *  Inbox when one could not be written and waits there. Null when suggestions
 *  are off or the plugin is absent. Never throws. */
async function propose(app: App, candidates: readonly ProposalCandidate[], convoId: string, turnId: string): Promise<string[] | null> {
  const exo = getExo(app);
  if (!exo?.settings.proposalKernelEnabled) return null;
  const statuses: string[] = [];
  for (const c of candidates) {
    const result = await exo.proposalStore.append(c, { convoId, turnId, createdAt: Date.now() }).catch((error: unknown) => {
      console.warn("[Exo] could not save a correction.", error);
      return null;
    });
    if (result?.errors) {
      console.warn(`[Exo] correction rejected: ${result.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
    }
    statuses.push(result?.status ?? "failed");
  }
  if (statuses.includes("appended")) await exo.inbox.refresh().catch(() => {});
  return statuses;
}

/** Recall found notes whose supersede markers disagree: write the fix, with
 *  each key as it reads now so a write that races an edit can tell it went stale.
 *  The note is read from disk, not the metadata cache, which can lag it or miss
 *  an unquoted `[[link]]`; a key Mario already filled is never overwritten. */
export async function proposeMarkerFixes(app: App, fixes: readonly MarkerFix[], convoId: string): Promise<void> {
  const candidates: ProposalCandidate[] = [];
  for (const f of fixes) {
    const file = app.vault.getAbstractFileByPath(f.path);
    if (!(file instanceof TFile)) continue;
    const content = await app.vault.read(file);
    const set = markerKeys(f, content);
    if (!Object.keys(set).length) continue;
    const before = Object.fromEntries(
      Object.keys(set).flatMap((key) => {
        const lines = frontmatterKeyLines(content, key);
        return lines.length ? [[key, lines.join("\n")]] : [];
      }),
    );
    candidates.push(correctionCandidate(f.path, { type: "frontmatter", set, before }, f.because));
  }
  if (candidates.length) await propose(app, candidates, convoId, `recall-${Date.now()}`);
}

const basename = (path: string): string => path.replace(/^.*\//, "").replace(/\.md$/, "");

/** The agent flags an outdated line: corrected in place, with an undo receipt. */
export function buildCorrectionTool(app: App, convoId: string) {
  const { tool } = claudeSdk();
  return tool(
    "propose_correction",
    "Replace an outdated line in a note with the current fact. It is written at once, with a receipt Mario can undo. " +
      "Quote `old_line` exactly as it is in the note (the list marker may be left out); `new_text` is the current fact only. " +
      "The written line keeps the old one in the vault's format: `<new> (dal YYYY-MM-DD; prima <old>)`.",
    { path: z.string().describe("Vault path or note name"), old_line: z.string(), new_text: z.string() },
    async (args) => {
      const file = resolveLink(app, args.path);
      if (!(file instanceof TFile)) return err(`Note not found: ${args.path}`);
      if (/[\r\n]/.test(args.old_line.trim())) return err("old_line must be a single line. Quote one line of the note.");
      if (/[\r\n]/.test(args.new_text.trim())) return err("new_text must be a single line. Propose one correction per line.");
      if (!getExo(app)?.settings.proposalKernelEnabled) return err("Suggestions are off, so no correction can be made.");
      const name = basename(file.path);
      const line = quotedLine(await app.vault.cachedRead(file), args.old_line);
      if (typeof line !== "string") {
        return err(line.error === "line-missing"
          ? `Line not found in ${name}. Quote the outdated line exactly as it is in the note.`
          : `That line appears more than once in ${name}. Quote a longer, unique line.`);
      }
      if (!args.new_text.trim()) return err("new_text is empty.");
      const change = { type: "line" as const, oldLine: line, newLine: formatSupersede(line, args.new_text, today()) };
      const [status] = (await propose(app, [correctionCandidate(file.path, change, "Flagged as outdated in chat.")], convoId, `tool-${Date.now()}`)) ?? [];
      if (status === "applied") return ok(`Corrected ${name}. Mario can undo it with "Undo a save to note".`);
      if (status === "duplicate") return ok(`The same correction for ${name} was already made or turned down.`);
      if (status === "dropped") return err(`${name} changed while the correction was being made, so nothing was written. Quote the line as it is now.`);
      if (status === "appended") return err(`Could not write the correction to ${name}; it waits in the Inbox with the reason.`);
      return err(`Could not make the correction (${status ?? "suggestions off"}).`);
    },
  );
}
