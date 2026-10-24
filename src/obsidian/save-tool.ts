/**
 * The agent's `save_to_note`: the same save as the turn's "Save to note"
 * (section-aware, provenance back to this chat, receipt and undo), driven by
 * the model with distilled text.
 */
import * as z from "zod";
import { TFile, type App } from "obsidian";
import { claudeSdk } from "../providers/sdk-loader";
import { listSections, sectionLabel, type SectionRef } from "../core/save-target";
import type { Provenance } from "../core/block-patch";
import type { SaveReceipt } from "../core/save-undo";
import { resolveLink } from "./graph";
import { saveToNote } from "./note-save";
import { err, getExo, ok, today } from "./tool-kit";

/** Provenance for the assistant message being produced: it is pushed at turn
 *  end, so its index is the conversation's current length. */
async function provenanceFor(app: App, convoId: string | undefined): Promise<Provenance> {
  const rec = convoId ? (await getExo(app)?.readConversationStore())?.find((c) => c.id === convoId) : undefined;
  return { convoId: convoId ?? "", msgIndex: rec?.messages.length ?? 0, chatTitle: rec?.title ?? "Exo", date: today() };
}

export function buildSaveTool(app: App, convoId: string | undefined, onSaved?: (r: SaveReceipt) => void) {
  const { tool } = claudeSdk();
  return tool(
    "save_to_note",
    "Save a result into a note, in the right section, with a provenance line back to this chat and an undo receipt. " +
      "Save the distilled point, not the whole answer. A one-line text saved into a section that is a list becomes one vault fact line " +
      "(`- <text> [fonte: chat ...; dal: YYYY-MM-DD]`), so give the bare fact; longer text is saved verbatim with the provenance line under it. " +
      "`section` is an existing heading's text (no #); `new_section` adds a heading at the end; neither means end of note. Creates the note if missing.",
    {
      path: z.string().describe("Vault path or note name"),
      section: z.string().optional(),
      text: z.string(),
      new_section: z.string().optional(),
    },
    async (args) => {
      const log = getExo(app)?.noteSaves;
      if (!log) return err("Save to note needs the Exo plugin loaded.");
      const file = resolveLink(app, args.path);
      const path = file?.path ?? (args.path.endsWith(".md") ? args.path : `${args.path}.md`);
      let section: SectionRef = { kind: "end" };
      if (args.new_section?.trim()) section = { kind: "new", heading: args.new_section.trim(), level: 2 };
      else if (args.section?.trim()) {
        const want = args.section.replace(/^#+\s*/, "").trim().toLowerCase();
        const all = file instanceof TFile ? listSections(await app.vault.cachedRead(file)) : [];
        const hit = all.find((s) => s.kind === "heading" && s.heading.toLowerCase() === want);
        if (!hit) {
          const known = all.map(sectionLabel).join(", ") || "none";
          return err(`Section not found: ${args.section}. Sections in ${path}: ${known}. Use new_section to create one.`);
        }
        section = hit;
      }
      const r = await saveToNote(app, log, { target: { path, section }, text: args.text, provenance: await provenanceFor(app, convoId) });
      if ("error" in r) return err(r.error === "nothing-to-save" ? "Nothing to save." : "Section not found. Pick another.");
      onSaved?.(r);
      return ok(`Saved to ${r.path.replace(/^.*\//, "").replace(/\.md$/, "")} > ${sectionLabel(r.section)} (^${r.id}).`);
    },
  );
}
