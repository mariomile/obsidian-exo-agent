/**
 * Grounding: did an answer cite the notes recall put in front of it, and did it
 * present a superseded note as current? Pure and import-free, so
 * `scripts/eval-grounding.mjs` can load it as it is. The recall log
 * (`obsidian/recall-log`) is the input; the conversation's own reply is the
 * other half of the join.
 */

/** What one turn's recall injected, by path only: never an excerpt. `msgIndex`
 *  and `userAt` name the user message the recall rode on: its place in the
 *  conversation's `messages` and its timestamp, so a chat that kept its id but
 *  lost or rewrote its messages (new session in the tab, rewind) is not joined
 *  to a reply that was never an answer to it. */
export interface RecallLogEntry {
  convoId: string;
  msgIndex: number;
  userAt: number;
  at: number;
  notes: { path: string; supersededBy?: string }[];
}

export interface GroundingScore {
  /** Entries whose reply was found; every entry recalled at least one note. */
  turns: number;
  /** Of those, the turns whose reply cites a recalled note. */
  citingRecalled: number;
  /** Turns that cite a superseded recalled note without citing its successor. */
  supersededCitedAsCurrent: number;
}

/** A link text mapped to a vault path, or null when no note answers to it.
 *  `prefer` lists paths that win over the shortest when a name is ambiguous. */
export type LinkResolver = (link: string, prefer?: readonly string[]) => string | null;

const stripMd = (s: string): string => s.replace(/\.md$/i, "");

/**
 * Resolver over a vault file list: a full path (with or without `.md`), a
 * basename, or an alias, case-insensitively. Several notes under one name
 * resolve to the shortest path, as Obsidian does, unless `prefer` (the notes
 * the turn recalled) holds one of them: the link was written about those.
 */
export function makeResolver(files: readonly { path: string; aliases?: readonly string[] }[]): LinkResolver {
  const byName = new Map<string, string>();
  const all = new Map<string, Set<string>>();
  const put = (key: string, path: string): void => {
    const k = key.trim().toLowerCase();
    if (!k) return;
    all.set(k, (all.get(k) ?? new Set()).add(path));
    const have = byName.get(k);
    if (have !== undefined && have.length <= path.length) return;
    byName.set(k, path);
  };
  // Paths and basenames first, so an alias never shadows a real note name.
  for (const f of files) {
    put(stripMd(f.path), f.path);
    put(stripMd(f.path.replace(/^.*\//, "")), f.path);
  }
  const names = new Map(byName);
  for (const f of files) for (const a of f.aliases ?? []) if (!names.has(a.trim().toLowerCase())) put(a, f.path);
  return (link, prefer = []) => {
    const k = stripMd(link.trim()).toLowerCase();
    return prefer.find((p) => all.get(k)?.has(p)) ?? byName.get(k) ?? null;
  };
}

/** The notes an answer links to, as resolved paths, each once, in order. */
export function citedPaths(answer: string, resolve: LinkResolver, prefer?: readonly string[]): string[] {
  const out: string[] = [];
  for (const m of answer.matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
    const target = m[1].split("|")[0].replace(/\\$/, "").split("#")[0];
    if (!target.trim()) continue;
    const path = resolve(target, prefer);
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

/** The slice of a stored message the join reads. */
export interface StoredMessage {
  role: string;
  at?: number;
  segments?: readonly { t?: string; md?: string }[];
}

/**
 * The reply to the logged user message: the text segments of the assistant
 * messages that follow it, up to the next user message. Null when the message
 * at `entry.msgIndex` is not the user message sent at `entry.userAt` (the chat
 * was emptied or rewound since) or no text came back.
 */
export function answerAfter(messages: readonly StoredMessage[], entry: Pick<RecallLogEntry, "msgIndex" | "userAt">): string | null {
  const msgIndex = entry.msgIndex;
  const sent = messages[msgIndex];
  if (sent?.role !== "user" || sent.at !== entry.userAt) return null;
  const parts: string[] = [];
  for (let i = msgIndex + 1; i < messages.length && messages[i].role !== "user"; i++) {
    for (const s of messages[i].segments ?? []) if (s.t === "text" && s.md) parts.push(s.md);
  }
  return parts.length ? parts.join("\n") : null;
}

/**
 * The log entry for one turn, pointing at the conversation's last user message
 * (the one just pushed) and the time it was sent. Null when there is nothing to
 * ground.
 */
export function recallLogEntry(input: {
  convoId: string;
  messages: readonly StoredMessage[];
  at: number;
  notes: readonly { path: string; supersededBy?: string }[];
}): RecallLogEntry | null {
  const msgIndex = input.messages.map((m) => m.role).lastIndexOf("user");
  const userAt = input.messages[msgIndex]?.at;
  if (!input.notes.length || userAt === undefined) return null;
  return {
    convoId: input.convoId,
    msgIndex,
    userAt,
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
  const score: GroundingScore = { turns: 0, citingRecalled: 0, supersededCitedAsCurrent: 0 };
  for (const e of entries) {
    const answer = answerOf(e);
    if (answer === null) continue;
    score.turns++;
    const cited = new Set(
      citedPaths(
        answer,
        resolve,
        e.notes.map((n) => n.path),
      ),
    );
    if (e.notes.some((n) => cited.has(n.path))) score.citingRecalled++;
    if (e.notes.some((n) => n.supersededBy && cited.has(n.path) && !cited.has(n.supersededBy))) score.supersededCitedAsCurrent++;
  }
  return score;
}
