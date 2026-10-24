/**
 * Correction proposals: recall's marker fixes and the agent's
 * `propose_correction`. Both only append to the proposal inbox; nothing is
 * written to a note until Mario accepts (obsidian/note-save `noteCorrections`).
 */
import * as z from "zod";
import { TFile, type App } from "obsidian";
import { claudeSdk } from "../providers/sdk-loader";
import { quotedLine } from "../core/correction";
import { correctionCandidate, type ProposalCandidate } from "../core/proposals";
import { formatSupersede, type MarkerFix } from "../core/supersede";
import { resolveLink } from "./graph";
import { err, getExo, ok, today } from "./tool-kit";

/** Append each candidate; refresh the Inbox when one is new. Null when
 *  suggestions are off or the plugin is absent. Never throws. */
async function propose(app: App, candidates: readonly ProposalCandidate[], convoId: string, turnId: string): Promise<string[] | null> {
  const exo = getExo(app);
  if (!exo?.settings.proposalKernelEnabled) return null;
  const statuses: string[] = [];
  for (const c of candidates) {
    statuses.push(await exo.proposalStore.append(c, { convoId, turnId, createdAt: Date.now() }).then((r) => r.status, () => "failed"));
  }
  if (statuses.includes("appended")) await exo.inbox.refresh().catch(() => {});
  return statuses;
}

/** Recall found notes whose supersede markers disagree: propose the fix. */
export async function proposeMarkerFixes(app: App, fixes: readonly MarkerFix[], convoId: string): Promise<void> {
  if (!fixes.length) return;
  const set = (f: MarkerFix): Record<string, string> => Object.fromEntries(Object.entries(f.set).filter(([, v]) => v !== undefined));
  const candidates = fixes.map((f) => correctionCandidate(f.path, { type: "frontmatter", set: set(f) }, f.because));
  await propose(app, candidates, convoId, `recall-${Date.now()}`);
}

const basename = (path: string): string => path.replace(/^.*\//, "").replace(/\.md$/, "");

/** The agent flags an outdated line: a proposal, never a write. */
export function buildCorrectionTool(app: App, convoId: string) {
  const { tool } = claudeSdk();
  return tool(
    "propose_correction",
    "Propose replacing an outdated line in a note with the current fact. Nothing is written: Mario accepts or dismisses it in the Inbox. " +
      "Quote `old_line` exactly as it is in the note (the list marker may be left out); `new_text` is the current fact only. " +
      "The accepted line keeps the old one in the vault's format: `<new> (dal YYYY-MM-DD; prima <old>)`.",
    { path: z.string().describe("Vault path or note name"), old_line: z.string(), new_text: z.string() },
    async (args) => {
      const file = resolveLink(app, args.path);
      if (!(file instanceof TFile)) return err(`Note not found: ${args.path}`);
      if (!getExo(app)?.settings.proposalKernelEnabled) return err("Suggestions are off, so no correction can be proposed.");
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
      if (status === "appended") return ok(`Correction proposed for ${name}. Mario accepts it in the Inbox.`);
      if (status === "duplicate") return ok(`The same correction for ${name} is already in the Inbox.`);
      return err(`Could not propose the correction (${status ?? "suggestions off"}).`);
    },
  );
}
