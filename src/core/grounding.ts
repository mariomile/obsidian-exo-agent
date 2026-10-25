/**
 * Grounding: did an answer cite the notes recall put in front of it, and did it
 * present a superseded note as current? Pure and import-free, so
 * `scripts/eval-grounding.mjs` can load it as it is. The recall log
 * (`obsidian/recall-log`) is the input; the conversation's own reply is the
 * other half of the join.
 */

/** What one turn's recall injected, by path only: never an excerpt. `msgIndex`
 *  is the user message the recall rode on, in the conversation's `messages`. */
export interface RecallLogEntry {
  convoId: string;
  msgIndex: number;
  at: number;
  notes: { path: string; supersededBy?: string }[];
}

export interface GroundingScore {
  /** Entries whose reply was found. */
  turns: number;
  /** Of those, the turns that recalled at least one note. */
  withRecall: number;
  /** Of those, the turns whose reply cites a recalled note. */
  citingRecalled: number;
  /** Turns that cite a superseded recalled note without citing its successor. */
  supersededCitedAsCurrent: number;
}

/** A link text mapped to a vault path, or null when no note answers to it. */
export type LinkResolver = (link: string) => string | null;

const stripMd = (s: string): string => s.replace(/\.md$/i, "");

/**
 * Resolver over a vault file list: a full path (with or without `.md`), a
 * basename, or an alias, case-insensitively. Several notes under one name
 * resolve to the shortest path, as Obsidian does.
 */
export function makeResolver(files: readonly { path: string; aliases?: readonly string[] }[]): LinkResolver {
  const byName = new Map<string, string>();
  const put = (key: string, path: string): void => {
    const k = key.trim().toLowerCase();
    const have = byName.get(k);
    if (!k || (have !== undefined && have.length <= path.length)) return;
    byName.set(k, path);
  };
  // Paths and basenames first, so an alias never shadows a real note name.
  for (const f of files) {
    put(stripMd(f.path), f.path);
    put(stripMd(f.path.replace(/^.*\//, "")), f.path);
  }
  const names = new Map(byName);
  for (const f of files) for (const a of f.aliases ?? []) if (!names.has(a.trim().toLowerCase())) put(a, f.path);
  return (link) => byName.get(stripMd(link.trim()).toLowerCase()) ?? null;
}

/** The notes an answer links to, as resolved paths, each once, in order. */
export function citedPaths(answer: string, resolve: LinkResolver): string[] {
  const out: string[] = [];
  for (const m of answer.matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
    const target = m[1].split("|")[0].replace(/\\$/, "").split("#")[0];
    if (!target.trim()) continue;
    const path = resolve(target);
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

/** The slice of a stored message the join reads. */
export interface StoredMessage {
  role: string;
  segments?: readonly { t?: string; md?: string }[];
}

/**
 * The reply to the user message at `msgIndex`: the text segments of the
 * assistant messages that follow it, up to the next user message. Null when
 * `msgIndex` is not a user message or no text came back.
 */
export function answerAfter(messages: readonly StoredMessage[], msgIndex: number): string | null {
  if (messages[msgIndex]?.role !== "user") return null;
  const parts: string[] = [];
  for (let i = msgIndex + 1; i < messages.length && messages[i].role !== "user"; i++) {
    for (const s of messages[i].segments ?? []) if (s.t === "text" && s.md) parts.push(s.md);
  }
  return parts.length ? parts.join("\n") : null;
}

/**
 * The log entry for one turn. `messageCount` is the conversation's length once
 * the user message is pushed, so that message sits at `messageCount - 1`. Null
 * when there is nothing to ground.
 */
export function recallLogEntry(input: {
  convoId: string;
  messageCount: number;
  at: number;
  notes: readonly { path: string; supersededBy?: string }[];
}): RecallLogEntry | null {
  if (!input.notes.length || input.messageCount < 1) return null;
  return {
    convoId: input.convoId,
    msgIndex: input.messageCount - 1,
    at: input.at,
    notes: input.notes.map((n) => (n.supersededBy ? { path: n.path, supersededBy: n.supersededBy } : { path: n.path })),
  };
}

/** Score the logged turns against their replies. `answerOf` is null for a turn
 *  whose reply is not available; such a turn is not counted. */
export function scoreGrounding(
  entries: readonly RecallLogEntry[],
  answerOf: (entry: RecallLogEntry) => string | null,
  resolve: LinkResolver,
): GroundingScore {
  const score: GroundingScore = { turns: 0, withRecall: 0, citingRecalled: 0, supersededCitedAsCurrent: 0 };
  for (const e of entries) {
    const answer = answerOf(e);
    if (answer === null) continue;
    score.turns++;
    if (!e.notes.length) continue;
    score.withRecall++;
    const cited = new Set(citedPaths(answer, resolve));
    if (e.notes.some((n) => cited.has(n.path))) score.citingRecalled++;
    if (e.notes.some((n) => n.supersededBy && cited.has(n.path) && !cited.has(n.supersededBy))) score.supersededCitedAsCurrent++;
  }
  return score;
}
