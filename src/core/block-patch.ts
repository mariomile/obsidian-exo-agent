/**
 * The block a save writes and where it goes: the text in the vault's own fact
 * format with a provenance line back to the chat and an Obsidian block anchor,
 * planned as an exact insertion so the receipt can undo it. No Obsidian import.
 */
import { chatLink } from "./chat-link";
import { documentNewline } from "./frontmatter-patch";
import { oneLine, safeTitle } from "./memory-harvest";
import { LIST_ITEM, bodyLines, inFence, protectedLines, resolveSection, type SectionRef } from "./save-target";

export interface Provenance {
  convoId: string;
  msgIndex: number;
  chatTitle: string;
  /** YYYY-MM-DD */
  date: string;
}

export interface SaveBlock {
  anchor: string;
  lines: string[];
  shape: "fact" | "passage";
}

export interface DiffLine {
  kind: "ctx" | "add" | "del";
  text: string;
}

export interface PatchPlan {
  next: string;
  /** The exact lines added (heading included for a new section), blank
   *  separators excluded; `start` is the index of the first one in `next`. */
  inserted: { start: number; lines: string[] };
  createdHeading: boolean;
  /** Blank separators added before the first and after the last inserted line. */
  pad: { before: boolean; after: boolean };
  /** Section-scoped, for the preview. */
  diff: DiffLine[];
}

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

/** `exo-` plus 6 base36 chars, redrawn while `content` already carries it. */
export function newAnchor(rand: () => number, content = ""): string {
  for (;;) {
    let id = "exo-";
    for (let i = 0; i < 6; i++) id += BASE36[Math.min(35, Math.floor(rand() * 36))];
    if (!content.includes(`^${id}`)) return id;
  }
}

export function formatProvenance(p: Provenance): string {
  const title = safeTitle(p.chatTitle).replace(/"/g, "'");
  return `[fonte: chat "${title}" (${chatLink(p.convoId, p.msgIndex)}); dal: ${p.date}]`;
}

/** One line into a list section becomes one vault fact line; anything else
 *  is the passage verbatim followed by one provenance line. The anchor ends
 *  the last line either way. */
export function formatSaveBlock(text: string, p: Provenance, anchor: string, sectionIsList: boolean): SaveBlock {
  const tail = `${formatProvenance(p)} ^${anchor}`;
  const lines = text.replace(/\r\n?/g, "\n").replace(/^\s*\n/, "").replace(/\s+$/, "").split("\n");
  if (sectionIsList && lines.length === 1) return { anchor, shape: "fact", lines: [`- ${oneLine(lines[0])} ${tail}`] };
  return { anchor, shape: "passage", lines: [...lines, tail] };
}

const plain = (l: string | undefined): string => (l ?? "").replace(/\r$/, "");
const blank = (l: string | undefined): boolean => !plain(l).trim();
const isHeading = (l: string | undefined): boolean => /^#{1,6}\s/.test(plain(l));

/** Rebuild the document from body lines, keeping its final newline. */
function rejoin(content: string, lines: readonly string[]): string {
  const out = lines.join("\n");
  return content.endsWith("\n") || !content ? `${out}\n` : out;
}

/** `middle` framed by the original lines around `at` (skipping `skip` replaced
 *  lines), plus the section heading when the window starts below it. */
function contextDiff(lines: readonly string[], at: number, skip: number, headingLine: number | null, middle: DiffLine[]): DiffLine[] {
  const lo = Math.max(headingLine ?? 0, at - 3, 0);
  const before = lines.slice(lo, at).map((l) => ({ kind: "ctx" as const, text: plain(l) }));
  const head = headingLine !== null && headingLine < lo ? [{ kind: "ctx" as const, text: plain(lines[headingLine]) }] : [];
  const after = lines.slice(at + skip, at + skip + 2).map((l) => ({ kind: "ctx" as const, text: plain(l) }));
  return [...head, ...before, ...middle, ...after];
}

/**
 * Insert `block` at the end of the section's own content: before its trailing
 * blank lines and before the next heading. A passage gets one blank line from
 * its neighbours; a fact line joins an adjacent list. Frontmatter and fences
 * are never written into; line endings follow the document.
 */
export function planInsert(content: string, target: SectionRef, block: SaveBlock): PatchPlan | { error: "section-missing" } {
  const span = resolveSection(content, target);
  if (!span) return { error: "section-missing" };
  const lines = bodyLines(content);
  const { locked, frontmatterEnd } = protectedLines(lines);
  let at = span.end;
  while (at > span.start && blank(lines[at - 1])) at--;
  if (inFence(lines, locked, at, frontmatterEnd)) return { error: "section-missing" };

  const created = target.kind === "new" ? [`${"#".repeat(target.level)} ${target.heading.trim()}`] : [];
  const added = [...created, ...block.lines];
  const fact = block.shape === "fact" && !created.length;
  const prev = at - 1 > frontmatterEnd && at - 1 !== span.headingLine ? lines[at - 1] : undefined;
  const next = lines[at];
  const before = prev !== undefined && !blank(prev) && !isHeading(prev) && !(fact && LIST_ITEM.test(plain(prev)));
  const after = next !== undefined && !blank(next) && !(fact && LIST_ITEM.test(plain(next)));
  const cr = documentNewline(content) === "\r\n" ? "\r" : "";
  const write = [...(before ? [""] : []), ...added, ...(after ? [""] : [])].map((l) => `${l}${cr}`);
  const out = [...lines.slice(0, at), ...write, ...lines.slice(at)];
  // Appending past a CRLF document's unterminated last line: that line gets its
  // CR and the new last line stays unterminated, as the document was.
  if (cr && at === lines.length && content && !content.endsWith("\n")) {
    out[at - 1] = `${plain(out[at - 1])}\r`;
    out[out.length - 1] = plain(out[out.length - 1]);
  }
  return {
    next: rejoin(content, out),
    inserted: { start: at + (before ? 1 : 0), lines: added },
    createdHeading: created.length > 0,
    pad: { before, after },
    diff: contextDiff(lines, at, 0, span.headingLine, write.map((l) => ({ kind: "add", text: plain(l) }))),
  };
}

/** Replace the one content line equal (trimmed) to `oldLine`, keeping its
 *  line ending. Frontmatter and fenced code are never matched. */
export function planReplaceLine(
  content: string,
  oldLine: string,
  newLine: string,
): PatchPlan | { error: "line-missing" | "line-ambiguous" } {
  const lines = bodyLines(content);
  const { fenced, frontmatterEnd } = protectedLines(lines);
  const want = oldLine.trim();
  const hits = lines.flatMap((l, i) => (i > frontmatterEnd && !fenced[i] && plain(l).trim() === want ? [i] : []));
  if (!hits.length) return { error: "line-missing" };
  if (hits.length > 1) return { error: "line-ambiguous" };
  const i = hits[0];
  const cr = lines[i].endsWith("\r") ? "\r" : "";
  const out = [...lines];
  out[i] = `${newLine}${cr}`;
  return {
    next: rejoin(content, out),
    inserted: { start: i, lines: [newLine] },
    createdHeading: false,
    pad: { before: false, after: false },
    diff: contextDiff(lines, i, 1, null, [
      { kind: "del", text: plain(lines[i]) },
      { kind: "add", text: newLine },
    ]),
  };
}
