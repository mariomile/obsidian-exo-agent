/**
 * Unlinked-mention detection + connection ranking — pure logic, no Obsidian
 * imports, no clock (the caller injects `now`). This is the engine behind the
 * in-document Connections block: it beats Obsidian's native "unlinked mentions"
 * on three axes — accent/case-folding (so `Perché`/`perche` match), multi-word
 * phrase matching with exact source offsets (so an inline underline lands on the
 * right span), and an anti-flood guard (short/common titles don't carpet-bomb
 * the vault). Light IT/EN stemming is available but opt-in (off by default) to
 * keep precision high on first ship.
 */

import { wordTokens, type Token } from "./tokenizer";

/** A note we might link TO — the thing whose name we hunt for in other notes. */
export interface MentionTarget {
  path: string;
  basename: string;
  /** `aliases` frontmatter values (already string[], may be empty). */
  aliases: string[];
}

/** A note we scan the body of, looking for plain-text mentions of the target. */
export interface CandidateDoc {
  path: string;
  /** Body text (frontmatter should be stripped by the caller). */
  text: string;
  /** mtime (ms) — feeds recency decay in scoring. */
  mtime: number;
  /** True when this doc already `[[links]]` to the target (skip it entirely). */
  alreadyLinks: boolean;
}

export interface MentionRange {
  start: number;
  end: number;
}

export interface UnlinkedMatch {
  sourcePath: string;
  /** Char offsets of each occurrence in the source text (for inline decoration). */
  ranges: MentionRange[];
  /** A short context snippet around the first occurrence. */
  snippet: string;
  score: number;
}

export interface MentionOptions {
  /** Minimum folded length for a single-word title to be searchable. Default 3. */
  minTitleLen?: number;
  /** Folded stopwords a single-word title may not be. Default {@link STOPWORDS}. */
  stopwords?: Set<string>;
  /** Path prefixes to never scan (daily notes, read-only libraries, templates). */
  excludePrefixes?: string[];
  /** Enable light IT/EN suffix stemming on both sides of the match. Default false. */
  stem?: boolean;
  now?: number;
  halfLifeDays?: number;
}

/**
 * Compact IT+EN stopword set (folded). Not exhaustive — just the high-frequency
 * function words that, when they happen to be a note title, would otherwise
 * match on every page. Mirrors the intent of Sonar's stopword guard.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  // English
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "for", "is", "it",
  "as", "by", "be", "we", "he", "so", "no", "do", "if", "up", "my", "me",
  // Italian
  "il", "lo", "la", "le", "gli", "un", "uno", "una", "di", "da", "in", "con",
  "su", "per", "tra", "fra", "che", "chi", "non", "si", "se", "ma", "ed", "al",
  "del", "col", "mi", "ti", "ci", "vi", "ne", "io", "tu", "lui", "noi", "voi",
]);

const DAY = 24 * 60 * 60 * 1000;

/** Exponential recency decay: 1 at age 0, 0.5 after one half-life. */
export function recencyFactor(mtime: number, now: number, halfLifeDays: number): number {
  const ageDays = Math.max(0, (now - mtime) / DAY);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * Light IT/EN suffix stemmer — crude on purpose, and only reached when
 * `opts.stem` is on. Strips common plural/inflection endings so `prodotti`
 * matches `prodotto` and `prices` matches `price`. Never shortens below 3 chars
 * (avoids collapsing distinct short words).
 */
export function stem(folded: string): string {
  if (folded.length <= 3) return folded;
  for (const suf of ["ing", "es", "hi", "he", "s", "i", "e", "o", "a"]) {
    if (folded.length - suf.length >= 3 && folded.endsWith(suf)) {
      return folded.slice(0, folded.length - suf.length);
    }
  }
  return folded;
}

const norm = (t: string, doStem: boolean): string => (doStem ? stem(t) : t);

/** Split a title/alias into its folded token sequence (same rules as the body). */
export function aliasTokens(name: string): string[] {
  return wordTokens(name).map((t) => t.text);
}

/**
 * The set of distinct, searchable alias token-sequences for a target: its
 * basename plus every frontmatter alias, each folded and de-duplicated. A
 * single-word alias that is too short or a stopword is dropped (anti-flood);
 * multi-word aliases are always kept (inherently specific).
 */
export function buildAliasSet(target: MentionTarget, opts: MentionOptions = {}): string[][] {
  const minLen = opts.minTitleLen ?? 3;
  const stops = opts.stopwords ?? STOPWORDS;
  const out: string[][] = [];
  const seen = new Set<string>();
  for (const name of [target.basename, ...target.aliases]) {
    const seq = aliasTokens(name);
    if (seq.length === 0) continue;
    if (seq.length === 1) {
      const w = seq[0];
      if (w.length < minLen || stops.has(w)) continue;
    }
    const key = seq.join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(seq);
  }
  return out;
}

/** Find every contiguous occurrence of `aliasSeq` in the token stream. */
function findSequence(tokens: Token[], aliasSeq: string[], doStem: boolean): MentionRange[] {
  const hits: MentionRange[] = [];
  const n = aliasSeq.length;
  if (n === 0) return hits;
  const target = doStem ? aliasSeq.map((t) => stem(t)) : aliasSeq;
  for (let i = 0; i + n <= tokens.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (norm(tokens[i + j].text, doStem) !== target[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push({ start: tokens[i].start, end: tokens[i + n - 1].end });
  }
  return hits;
}

function snippetAround(text: string, range: MentionRange, pad = 48): string {
  const from = Math.max(0, range.start - pad);
  const to = Math.min(text.length, range.end + pad);
  return (
    (from > 0 ? "…" : "") +
    text.slice(from, to).replace(/\s+/g, " ").trim() +
    (to < text.length ? "…" : "")
  );
}

function isExcluded(path: string, prefixes: string[]): boolean {
  return prefixes.some((p) => path.startsWith(p));
}

/**
 * Detect unlinked mentions of `target` across `candidates`. Returns one match
 * per source note (all occurrence ranges folded in), scored by occurrence count
 * and recency, highest first. Skips: the target itself, notes that already link
 * to it, and excluded path prefixes.
 */
export function unlinkedMentions(
  target: MentionTarget,
  candidates: CandidateDoc[],
  opts: MentionOptions = {},
): UnlinkedMatch[] {
  const aliasSet = buildAliasSet(target, opts);
  if (aliasSet.length === 0) return [];
  const doStem = opts.stem ?? false;
  const now = opts.now ?? 0;
  const halfLife = opts.halfLifeDays ?? 45;
  const excludes = opts.excludePrefixes ?? [];

  const out: UnlinkedMatch[] = [];
  for (const doc of candidates) {
    if (doc.path === target.path || doc.alreadyLinks) continue;
    if (isExcluded(doc.path, excludes)) continue;
    const tokens = wordTokens(doc.text);
    const ranges: MentionRange[] = [];
    for (const seq of aliasSet) ranges.push(...findSequence(tokens, seq, doStem));
    if (ranges.length === 0) continue;
    ranges.sort((a, b) => a.start - b.start);
    const recency = now > 0 ? recencyFactor(doc.mtime, now, halfLife) : 1;
    const score = (0.6 + 0.1 * Math.min(ranges.length, 4)) * recency;
    out.push({ sourcePath: doc.path, ranges, snippet: snippetAround(doc.text, ranges[0]), score });
  }
  out.sort((a, b) => b.score - a.score || a.sourcePath.localeCompare(b.sourcePath));
  return out;
}

/**
 * Convert one plain-text occurrence into a wikilink, purely. If the surface text
 * differs from the target basename (an alias or inflection), emits a piped link
 * `[[Target|surface]]` so the reading view is unchanged; otherwise `[[Target]]`.
 * The caller supplies exact char offsets (from {@link unlinkedMentions}); this
 * function never searches, so it can't mis-target a second occurrence.
 */
export function applyLink(text: string, range: MentionRange, targetBasename: string): string {
  const surface = text.slice(range.start, range.end);
  const link = surface === targetBasename ? `[[${targetBasename}]]` : `[[${targetBasename}|${surface}]]`;
  return text.slice(0, range.start) + link + text.slice(range.end);
}

/**
 * Apply {@link applyLink} to every range in one pass, right-to-left so earlier
 * offsets stay valid as later text grows. Ranges may arrive in any order.
 */
export function applyLinks(text: string, ranges: MentionRange[], targetBasename: string): string {
  const ordered = [...ranges].sort((a, b) => b.start - a.start);
  let out = text;
  for (const r of ordered) out = applyLink(out, r, targetBasename);
  return out;
}

/** The wikilink text for a surface occurrence: piped only when the surface
 *  differs from the target basename (alias/case/inflection). */
export function linkText(surface: string, targetBasename: string): string {
  return surface === targetBasename ? `[[${targetBasename}]]` : `[[${targetBasename}|${surface}]]`;
}

/* -------------------- outgoing (inline) mentions -------------------- */
// The inverse query behind the in-document inline underline: given ONE note's
// body, find every plain-text occurrence of ANOTHER note's title that isn't
// already wikilinked — so the reader can link OUT with one click. Native
// Obsidian only surfaces the incoming direction (mentions of THIS note
// elsewhere); this is what the current note cites.

export interface OutgoingMatch {
  targetPath: string;
  targetBasename: string;
  ranges: MentionRange[];
}

/** Char spans of existing `[[wikilinks]]` (brackets included) — matches inside
 *  these are already links and must not be underlined or re-linked. */
export function wikilinkSpans(text: string): MentionRange[] {
  const spans: MentionRange[] = [];
  const re = /\[\[[^\]]*\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) spans.push({ start: m.index, end: m.index + m[0].length });
  return spans;
}

function overlaps(a: MentionRange, b: MentionRange): boolean {
  return a.start < b.end && a.end > b.start;
}

/** Every target's alias sequences, normalized once (stemmed when `stem` is on)
 *  and bucketed by their first token, so a body pass looks each token up once
 *  instead of re-scanning the body per target. Build it once, reuse it across
 *  passes until the target set changes. */
export interface MentionIndex {
  stem: boolean;
  targets: MentionTarget[];
  /** First normalized token -> entries in (target, alias) order. */
  byFirst: Map<string, Array<{ target: number; seq: string[] }>>;
}

export function buildMentionIndex(targets: MentionTarget[], opts: MentionOptions = {}): MentionIndex {
  const doStem = opts.stem ?? false;
  const byFirst = new Map<string, Array<{ target: number; seq: string[] }>>();
  targets.forEach((t, target) => {
    for (const raw of buildAliasSet(t, opts)) {
      const seq = doStem ? raw.map((w) => stem(w)) : raw;
      const bucket = byFirst.get(seq[0]);
      if (bucket) bucket.push({ target, seq });
      else byFirst.set(seq[0], [{ target, seq }]);
    }
  });
  return { stem: doStem, targets, byFirst };
}

/**
 * Find every outgoing unlinked mention of any indexed target in `text`. Skips
 * ranges that fall inside an existing wikilink and the note at `selfPath`. One
 * tokenize pass over the body; each token looks up only the alias sequences
 * that start with it. Output: targets in index order, each with its ranges
 * ordered by start and, at equal start, by alias order (token starts strictly
 * increase, and a bucket holds its entries in alias order).
 */
export function outgoingMentions(text: string, index: MentionIndex, selfPath?: string): OutgoingMatch[] {
  const tokens = wordTokens(text);
  const spans = wikilinkSpans(text);
  const normed = tokens.map((t) => norm(t.text, index.stem));
  const byTarget = new Map<number, MentionRange[]>();
  for (let i = 0; i < normed.length; i++) {
    const bucket = index.byFirst.get(normed[i]);
    if (!bucket) continue;
    for (const { target, seq } of bucket) {
      const n = seq.length;
      if (i + n > normed.length || index.targets[target].path === selfPath) continue;
      let ok = true;
      for (let j = 1; j < n; j++) {
        if (normed[i + j] !== seq[j]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const r = { start: tokens[i].start, end: tokens[i + n - 1].end };
      if (spans.some((s) => overlaps(r, s))) continue;
      const ranges = byTarget.get(target);
      if (ranges) ranges.push(r);
      else byTarget.set(target, [r]);
    }
  }
  return [...byTarget.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([target, ranges]) => ({
      targetPath: index.targets[target].path,
      targetBasename: index.targets[target].basename,
      ranges,
    }));
}

export interface FlatOutgoing {
  targetPath: string;
  targetBasename: string;
  range: MentionRange;
}

/**
 * Flatten per-target matches into a single non-overlapping list for rendering.
 * When two targets claim overlapping spans (e.g. `Product` vs `Product Market
 * Fit` over "product market fit"), the LONGER span wins — the more specific
 * link is almost always the intended one.
 */
export function flattenOutgoing(matches: OutgoingMatch[]): FlatOutgoing[] {
  const all: FlatOutgoing[] = [];
  for (const m of matches) for (const range of m.ranges) {
    all.push({ targetPath: m.targetPath, targetBasename: m.targetBasename, range });
  }
  all.sort((a, b) => b.range.end - b.range.start - (a.range.end - a.range.start) || a.range.start - b.range.start);
  const kept: FlatOutgoing[] = [];
  for (const cand of all) {
    if (!kept.some((k) => overlaps(k.range, cand.range))) kept.push(cand);
  }
  kept.sort((a, b) => a.range.start - b.range.start);
  return kept;
}

/** Apply every flattened outgoing link in one pass, right-to-left so offsets
 *  stay valid. Each range links to its own target. Pure. */
export function applyFlatLinks(text: string, flats: FlatOutgoing[]): string {
  const ordered = [...flats].sort((a, b) => b.range.start - a.range.start);
  let out = text;
  for (const f of ordered) out = applyLink(out, f.range, f.targetBasename);
  return out;
}

/* ----------------------- connection ranking ----------------------- */

export type ConnectionKind = "linked" | "related" | "unlinked" | "suggested";

/** Relative weight per bucket — related frontmatter is the strongest signal,
 *  an unlinked plain-text mention the weakest (it isn't a link yet). */
export const KIND_WEIGHT: Record<ConnectionKind, number> = {
  related: 1.0,
  linked: 0.8,
  suggested: 0.6,
  unlinked: 0.4,
};

export interface ConnectionItem {
  path: string;
  kind: ConnectionKind;
  score: number;
  ranges?: MentionRange[];
  snippet?: string;
}

export interface RankInput {
  path: string;
  kind: ConnectionKind;
  mtime: number;
  ranges?: MentionRange[];
  snippet?: string;
}

/**
 * Rank a flat list of connection candidates by `kindWeight × recency`, keeping
 * the strongest kind when a path appears in more than one bucket (a note that is
 * both a backlink and an unlinked mention shows once, as the backlink).
 */
export function rankConnections(items: RankInput[], now: number, halfLifeDays = 45): ConnectionItem[] {
  const best = new Map<string, RankInput>();
  for (const it of items) {
    const cur = best.get(it.path);
    if (!cur || KIND_WEIGHT[it.kind] > KIND_WEIGHT[cur.kind]) best.set(it.path, it);
  }
  const scored: ConnectionItem[] = [...best.values()].map((it) => ({
    path: it.path,
    kind: it.kind,
    score: KIND_WEIGHT[it.kind] * (now > 0 ? recencyFactor(it.mtime, now, halfLifeDays) : 1),
    ...(it.ranges ? { ranges: it.ranges } : {}),
    ...(it.snippet ? { snippet: it.snippet } : {}),
  }));
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored;
}
