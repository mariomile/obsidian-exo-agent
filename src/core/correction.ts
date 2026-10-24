/**
 * An accepted correction applied to a note's text, with the receipt that
 * undoes it: a line goes through `planReplaceLine` (op "replace"), frontmatter
 * keys through the raw-preserving patcher with a snapshot of each touched key
 * (op "frontmatter"). No Obsidian import.
 */
import { planReplaceLine, type Provenance } from "./block-patch";
import { frontmatterKeyLines, patchFrontmatter } from "./frontmatter-patch";
import type { CorrectionChange } from "./proposals";
import { bodyLines } from "./save-target";
import type { SaveReceipt } from "./save-undo";
import { withoutListMarker } from "./supersede";

/** The one note line the model quoted, as it is in the note: exact (trimmed)
 *  first, else the same text under any list marker. Frontmatter and fenced
 *  code never match (planReplaceLine decides). */
export function quotedLine(content: string, quoted: string): string | { error: "line-missing" | "line-ambiguous" } {
  const exact = planReplaceLine(content, quoted, quoted);
  if (!("error" in exact)) return bodyLines(content)[exact.inserted.start].replace(/\r$/, "");
  if (exact.error === "line-ambiguous") return exact;
  const want = withoutListMarker(quoted);
  if (!want) return { error: "line-missing" };
  const texts = [...new Set(bodyLines(content).map((l) => l.replace(/\r$/, "").trim()).filter((l) => withoutListMarker(l) === want))];
  const hits = texts.flatMap((t) => {
    const plan = planReplaceLine(content, t, t);
    return "error" in plan ? (plan.error === "line-ambiguous" ? [null, null] : []) : [bodyLines(content)[plan.inserted.start].replace(/\r$/, "")];
  });
  if (!hits.length) return { error: "line-missing" };
  if (hits.length > 1) return { error: "line-ambiguous" };
  return hits[0] as string;
}

export function planCorrection(
  content: string,
  change: CorrectionChange,
  meta: { id: string; path: string; provenance: Provenance; savedAt: number },
): { next: string; receipt: SaveReceipt } | { error: "line-missing" | "line-ambiguous" } {
  const base = { id: meta.id, path: meta.path, section: { kind: "end" as const }, provenance: meta.provenance, savedAt: meta.savedAt };
  if (change.type === "line") {
    const plan = planReplaceLine(content, change.oldLine, change.newLine);
    if ("error" in plan) return plan;
    const replaced = bodyLines(content)[plan.inserted.start].replace(/\r$/, "");
    return { next: plan.next, receipt: { ...base, op: "replace", lines: [change.newLine], replaced } };
  }
  const next = patchFrontmatter(content, change.set);
  const keys = Object.keys(change.set).map((key) => ({
    key,
    before: frontmatterKeyLines(content, key),
    after: frontmatterKeyLines(next, key).join("\n"),
  }));
  return { next, receipt: { ...base, op: "frontmatter", lines: keys.map((k) => k.after), keys } };
}
