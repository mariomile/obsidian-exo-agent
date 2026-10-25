/**
 * An accepted correction applied to a note's text, with the receipt that
 * undoes it: a line goes through `planReplaceLine` (op "replace"), frontmatter
 * keys through the raw-preserving patcher with a snapshot of each touched key
 * (op "frontmatter"). A correction is one line: it never writes a newline. A
 * frontmatter fix applies only while each key still reads as it did when it
 * was proposed. No Obsidian import.
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

export type CorrectionError = "line-missing" | "line-ambiguous" | "stale" | "multi-line";

/** A correction that was refused, with the reason as a code the proposal
 *  store can act on. The message is what Mario reads. */
export class CorrectionFailure extends Error {
  constructor(readonly code: CorrectionError, message: string) {
    super(message);
    this.name = "CorrectionFailure";
  }
}

/** Failures that mean the note moved on: the fix as proposed can never apply,
 *  and a new derivation from the note as it reads now may. */
export function isGoneCorrection(code: CorrectionError | undefined): boolean {
  return code === "stale" || code === "line-missing" || code === "line-ambiguous";
}

export function planCorrection(
  content: string,
  change: CorrectionChange,
  meta: { id: string; path: string; provenance: Provenance; savedAt: number },
): { next: string; receipt: SaveReceipt } | { error: CorrectionError } {
  const base = { id: meta.id, path: meta.path, section: { kind: "end" as const }, provenance: meta.provenance, savedAt: meta.savedAt };
  if (change.type === "line") {
    if (/[\r\n]/.test(change.oldLine) || /[\r\n]/.test(change.newLine)) return { error: "multi-line" };
    const plan = planReplaceLine(content, change.oldLine, change.newLine);
    if ("error" in plan) return plan;
    const replaced = bodyLines(content)[plan.inserted.start].replace(/\r$/, "");
    return { next: plan.next, receipt: { ...base, op: "replace", lines: [change.newLine], replaced } };
  }
  // The validator trims `before`; a key's raw lines can end in a blank or comment line, so compare trimmed.
  const stale = Object.keys(change.set).some((key) => frontmatterKeyLines(content, key).join("\n").trim() !== (change.before[key] ?? ""));
  if (stale) return { error: "stale" };
  const next = patchFrontmatter(content, change.set);
  const keys = Object.keys(change.set).map((key) => ({
    key,
    before: frontmatterKeyLines(content, key),
    after: frontmatterKeyLines(next, key).join("\n"),
  }));
  return { next, receipt: { ...base, op: "frontmatter", lines: keys.map((k) => k.after), keys } };
}
