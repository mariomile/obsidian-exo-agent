/**
 * Where a save lands: a note and a section in it. Also home of the one
 * heading/fence scanner shared with memory harvest, so "is this a heading" and
 * "is this inside code or frontmatter" have a single answer. No Obsidian import.
 */

export interface SaveTarget {
  /** Vault path, existing or to be created. */
  path: string;
  section: SectionRef;
}

export type SectionRef =
  | { kind: "end" }
  /** The nth (0-based) heading with this text and level. */
  | { kind: "heading"; heading: string; level: number; occurrence: number }
  /** A heading created at the end of the note. */
  | { kind: "new"; heading: string; level: number };

/** Content lines `[start, end)` of a section, indices into `content.split("\n")`. */
export interface SectionSpan {
  headingLine: number | null;
  start: number;
  end: number;
}

/**
 * Lines memory must never touch, per line index: the YAML frontmatter block,
 * fenced code, headings, table rows, horizontal rules and blank lines.
 * `fenced` marks fence lines and everything between them. `open` is true when
 * the frontmatter never closes (then nothing may be appended).
 */
export function protectedLines(lines: readonly string[]): {
  locked: boolean[];
  fenced: boolean[];
  frontmatterEnd: number;
  open: boolean;
} {
  const locked = lines.map(() => false);
  const fenced = lines.map(() => false);
  let frontmatterEnd = -1;
  let open = false;
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    frontmatterEnd = close < 0 ? lines.length - 1 : close;
    open = close < 0;
    for (let i = 0; i <= frontmatterEnd; i++) locked[i] = true;
    start = frontmatterEnd + 1;
  }
  let fence: string | null = null;
  for (let i = start; i < lines.length; i++) {
    const t = lines[i].trim();
    const f = /^(```|~~~)/.exec(t);
    if (fence) {
      locked[i] = fenced[i] = true;
      if (f && t.startsWith(fence)) fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      locked[i] = fenced[i] = true;
      continue;
    }
    if (!t || /^#{1,6}\s/.test(t) || t.startsWith("|") || /^(-{3,}|\*{3,}|_{3,})$/.test(t)) locked[i] = true;
  }
  return { locked, fenced, frontmatterEnd, open };
}

/** True when index `i` sits between an opening and a closing fence. */
export function inFence(lines: readonly string[], locked: readonly boolean[], i: number, frontmatterEnd: number): boolean {
  let fence = false;
  for (let k = frontmatterEnd + 1; k < i && k < lines.length; k++) {
    if (/^(```|~~~)/.test(lines[k].trim()) && locked[k]) fence = !fence;
  }
  return fence;
}

export interface Heading {
  line: number;
  level: number;
  text: string;
}

/** Real headings of a note: never in frontmatter, never inside a fence. */
export function headingsOf(lines: readonly string[]): Heading[] {
  const { fenced, frontmatterEnd } = protectedLines(lines);
  const out: Heading[] = [];
  lines.forEach((l, i) => {
    const m = /^(#{1,6})\s+(.*)$/.exec(l.replace(/\r$/, ""));
    if (m && i > frontmatterEnd && !fenced[i]) out.push({ line: i, level: m[1].length, text: m[2].trim() });
  });
  return out;
}

/** Lines of a note without the empty tail a final newline leaves. */
export function bodyLines(content: string): string[] {
  if (!content) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

export function listSections(content: string): SectionRef[] {
  const seen = new Map<string, number>();
  return headingsOf(bodyLines(content)).map((h) => {
    const key = `${h.level}:${h.text}`;
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    return { kind: "heading", heading: h.text, level: h.level, occurrence };
  });
}

/** A heading section ends at the next heading of any level: its own content,
 *  before any subsection. Null when the heading is gone or the frontmatter
 *  never closes. */
export function resolveSection(content: string, ref: SectionRef): SectionSpan | null {
  const lines = bodyLines(content);
  const { frontmatterEnd, open } = protectedLines(lines);
  if (open) return null;
  if (ref.kind !== "heading") return { headingLine: null, start: ref.kind === "end" ? frontmatterEnd + 1 : lines.length, end: lines.length };
  const heads = headingsOf(lines);
  const hit = heads.filter((h) => h.text === ref.heading && h.level === ref.level)[ref.occurrence];
  if (!hit) return null;
  const next = heads.find((h) => h.line > hit.line);
  return { headingLine: hit.line, start: hit.line + 1, end: next ? next.line : lines.length };
}

export const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;

/** True when the section's content is a list: a one-line save there becomes a fact line. */
export function sectionIsList(content: string, ref: SectionRef): boolean {
  if (ref.kind === "new") return false;
  const span = resolveSection(content, ref);
  if (!span) return false;
  const filled = bodyLines(content)
    .slice(span.start, span.end)
    .filter((l) => l.trim());
  return filled.length > 0 && filled.every((l) => LIST_ITEM.test(l));
}

export function sectionLabel(ref: SectionRef): string {
  if (ref.kind === "end") return "End of note";
  if (ref.kind === "new") return `New section: ${ref.heading}`;
  return `${"#".repeat(ref.level)} ${ref.heading}`;
}

/** Notes worth offering as targets: the active note, then this turn's recalled
 *  notes, then the notes this chat read or wrote. Markdown only, max 6. */
export function suggestTargets(input: { activePath: string | null; recalled: string[]; touched: string[] }): string[] {
  const all = [input.activePath, ...input.recalled, ...input.touched];
  return [...new Set(all.filter((p): p is string => !!p && p.endsWith(".md")))].slice(0, 6);
}
