/**
 * Undo for a save, three-way safe. Base = the receipt, ours = the exact lines
 * Exo wrote, theirs = the note now. Only Exo's lines go; every other edit,
 * including later ones in the same section, stays. A block Mario edited is
 * never removed. No Obsidian import.
 */
import type { PatchPlan, Provenance, SaveBlock } from "./block-patch";
import { uniqueRun } from "./memory-undo";
import { bodyLines, type SectionRef } from "./save-target";

export interface SaveReceipt {
  /** = the block anchor. */
  id: string;
  op: "insert" | "replace";
  path: string;
  section: SectionRef;
  /** Exact inserted block lines (insert) or `[newLine]` (replace). */
  lines: string[];
  /** The old line (replace). */
  replaced?: string;
  /** The heading line Exo added, if any. */
  createdHeading?: string;
  /** Blank separators Exo added around the insert. */
  pad?: { before: boolean; after: boolean };
  createdNote?: boolean;
  provenance: Provenance;
  savedAt: number;
  undoneAt?: number;
}

export type UndoPlan =
  | { ok: true; next: string | null }
  | { ok: false; reason: "block-edited" | "block-missing" | "line-changed" | "already-undone" };

/** The receipt for an insert planned by `planInsert`. */
export function receiptFor(input: {
  path: string;
  section: SectionRef;
  block: SaveBlock;
  plan: PatchPlan;
  provenance: Provenance;
  createdNote: boolean;
  savedAt: number;
}): SaveReceipt {
  const { plan } = input;
  return {
    id: input.block.anchor,
    op: "insert",
    path: input.path,
    section: input.section,
    lines: input.block.lines,
    ...(plan.createdHeading ? { createdHeading: plan.inserted.lines[0] } : {}),
    pad: plan.pad,
    ...(input.createdNote ? { createdNote: true } : {}),
    provenance: input.provenance,
    savedAt: input.savedAt,
  };
}

const plain = (l: string | undefined): string => (l ?? "").replace(/\r$/, "");
const blank = (l: string | undefined): boolean => l !== undefined && !plain(l).trim();

/** An unterminated document keeps no CR on its last line (the insert gave it one). */
function rejoin(current: string, lines: readonly string[]): string {
  const out = lines.join("\n");
  return current.endsWith("\n") && lines.length ? `${out}\n` : out.replace(/\r$/, "");
}

/** Nothing left but whitespace. Frontmatter counts as content: Exo never writes it. */
const emptyNote = (content: string): boolean => !content.trim();

export function planUndo(current: string, r: SaveReceipt): UndoPlan {
  if (r.undoneAt) return { ok: false, reason: "already-undone" };
  const lines = bodyLines(current);
  const view = lines.map(plain);

  if (r.op === "replace") {
    const i = uniqueRun(view, r.lines.slice(0, 1));
    if (i < 0 || r.replaced === undefined) return { ok: false, reason: "line-changed" };
    const out = [...lines];
    out[i] = `${r.replaced}${lines[i].endsWith("\r") ? "\r" : ""}`;
    return { ok: true, next: rejoin(current, out) };
  }

  const tag = new RegExp(`(?:^|\\s)\\^${r.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
  const k = view.findIndex((l) => tag.test(l));
  if (k < 0) return { ok: false, reason: "block-missing" };
  const s = k - r.lines.length + 1;
  if (s < 0 || r.lines.some((l, j) => view[s + j] !== l)) return { ok: false, reason: "block-edited" };

  let a = s;
  let b = k + 1;
  if (r.pad?.after && blank(lines[b])) b++;
  let headingGone = !r.createdHeading;
  if (r.createdHeading && view[a - 1] === r.createdHeading) {
    let n = b;
    while (n < lines.length && blank(lines[n])) n++;
    if (n === lines.length || /^#{1,6}\s/.test(view[n])) {
      a--;
      headingGone = true;
    }
  }
  if (headingGone && r.pad?.before && blank(lines[a - 1])) a--;
  const next = rejoin(current, [...lines.slice(0, a), ...lines.slice(b)]);
  return { ok: true, next: r.createdNote && emptyNote(next) ? null : next };
}
