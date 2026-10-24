/**
 * Per-turn recall, pure half: when to recall, what to search for, which past
 * chats match, and the budgeted block that rides the outbound message. The
 * impure half (vault search, reading the conversation store) is
 * `obsidian/turn-recall.ts`. No Obsidian import.
 */
import { chatLines, localDate, type ChatRecord } from "./recent-chats";
import { applySupersede, type SupersedeIndex } from "./supersede";

export const RECALL_OPEN = "[vault-recall]";
export const RECALL_CLOSE = "[/vault-recall]";

/** Whole block ceiling, delimiters included. */
export const RECALL_MAX_CHARS = 2000;
export const RECALL_MAX_NOTES = 5;
export const RECALL_MAX_CHATS = 2;
/** How deep each note lane is read before fusion: a note Sonar ranks 13th can
 *  still lead when the title lane names it too. */
export const RECALL_LANE_DEPTH = 20;
/** How far a semantic chat's score must stand above the median of the index's
 *  answer to count. Its raw cosine scores sit in a narrow 0.77 to 0.87 band
 *  for every prompt, so a fixed floor cannot tell a match from noise.
 *  Live 2026-10-24: expected chats lift 0.071 / 0.061 / 0.032, best noise 0.026 (eval questions) and 0.020 (ordinary prompts). */
export const RECALL_CHAT_MIN_LIFT = 0.029;
/** Reciprocal rank fusion constant, the same as Sonar's own `fuse`. */
const RRF_K = 60;
export const RECALL_EXCERPT_CHARS = 300;
/** How far back past chats are matched. */
export const RECALL_CHAT_WINDOW_DAYS = 60;
/** How many of the message's rarest keywords decide a chat match. */
export const RECALL_CHAT_KEYWORDS = 4;
const MIN_WORDS = 4;
const MAX_KEYWORDS = 10;

/** Short messages ("ok", "go on") and slash commands carry nothing to recall on. */
export function shouldRecall(message: string): boolean {
  const text = message.trim();
  if (!text || text.startsWith("/")) return false;
  return text.split(/\s+/).filter(Boolean).length >= MIN_WORDS;
}

/** Function words that match everything. Italian + English: the two
 *  languages Exo is used in. */
const STOPWORDS = new Set(
  (
    "the and for with that this from have what when where which your about into there their them then than also just like " +
    "would could should been were will does didn make want need please thanks " +
    "della delle dello degli nella nelle negli sono come cosa questo questa quello quella perché perche quando dove anche " +
    "ancora molto tutto tutti fare fatto essere stato avere hanno sulla sulle dalla dalle alla alle allo agli puoi fammi " +
    "voglio vorrei grazie ciao solo però pero mentre"
  ).split(" "),
);

/** Lowercase, accent-free word stream. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The distinct content words of a message, in order: the search query.
 *  Operators (`-x`, `path:`) never survive, so a message can't steer the
 *  search engine's syntax by accident. */
export function recallKeywords(message: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words(message)) {
    if (w.length < 4 || STOPWORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

export interface NoteRecall {
  path: string;
  excerpt: string;
  /** The current note that replaces this one (core/supersede). */
  supersededBy?: string;
}

export interface ChatRecall {
  id: string;
  title: string;
  date: string;
  snippet: string;
  /** The message the recall points at (`data-msg` in the transcript), or null
   *  when only the chat as a whole is known. */
  msgIndex: number | null;
}

const flat = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * Lexical match over past conversations: every chat except `excludeId` with
 * messages in the window, scored by how many distinct keywords its best line
 * contains. Only the message's {@link RECALL_CHAT_KEYWORDS} rarest keywords
 * (fewest chats containing them) count: words like "prima" or "product" sit in
 * most chats and match anything. A chat needs two of those hits (one when the
 * message has a single keyword): one shared word is noise.
 */
export function matchPastChats(
  chats: readonly ChatRecord[],
  keywords: readonly string[],
  opts: { excludeId: string; now: number },
): ChatRecall[] {
  if (!keywords.length) return [];
  const since = opts.now - RECALL_CHAT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const candidates = chats
    .filter((chat) => chat.id !== opts.excludeId)
    .map((chat) => ({
      chat,
      lines: chatLines(chat.messages)
        .filter((l) => l.at !== undefined && l.at >= since && l.text)
        .map((l) => ({ text: l.text, at: l.at ?? 0, index: l.index, present: new Set(words(l.text)) })),
    }));
  const df = new Map(keywords.map((k) => [k, candidates.filter((c) => c.lines.some((l) => l.present.has(k))).length]));
  const rare = [...keywords].sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0)).slice(0, RECALL_CHAT_KEYWORDS);
  const need = Math.min(2, rare.length);
  const scored: { recall: ChatRecall; score: number; at: number }[] = [];
  for (const { chat, lines } of candidates) {
    let best: { text: string; score: number; at: number; index: number } | null = null;
    for (const line of lines) {
      const score = rare.filter((k) => line.present.has(k)).length;
      if (score >= need && (!best || score > best.score)) best = { text: line.text, score, at: line.at, index: line.index };
    }
    if (!best) continue;
    scored.push({
      recall: {
        id: chat.id,
        title: chat.title || "Untitled chat",
        date: localDate(best.at),
        snippet: flat(best.text, RECALL_EXCERPT_CHARS),
        msgIndex: best.index,
      },
      score: best.score,
      at: best.at,
    });
  }
  return scored
    .sort((a, b) => b.score - a.score || b.at - a.at)
    .slice(0, RECALL_MAX_CHATS)
    .map((s) => s.recall);
}

/** Every source of one recall, before ranking. The adapter fetches them; the
 *  eval feeds the live ones into the same {@link rankRecall}, so what is
 *  measured is what ships. */
export interface RecallLanes {
  /** Sonar (or the built-in scorer), best first, exclusions already applied. */
  sonar: NoteRecall[];
  /** Notes whose name the message mentions ({@link titleLane}). */
  title: TitleHit[];
  /** {@link matchPastChats}. */
  lexicalChats: ChatRecall[];
  /** The semantic chat index ({@link chatsFromIds}), best first; null when it
   *  could not answer in time. */
  semanticChats: ChatRecall[] | null;
}

/** Name words that can match a keyword: the same normalisation as
 *  {@link recallKeywords}, minus dates and numbers. */
const nameWords = (name: string): string[] => [...new Set(words(name).filter((w) => w.length >= 4 && !/^\d+$/.test(w)))];

/** A note the message names: how many words of its name the message shares,
 *  and `whole` when it shares every one. */
export interface TitleHit {
  path: string;
  shared: number;
  whole: boolean;
}

/**
 * Notes the message names: a basename or alias that shares two keywords with
 * it, or whose every word is a keyword ("Turno", "Alberto Aspese"). More shared
 * words first, then names covered more fully, then path. A name sharing a
 * single word with a longer title is noise, not a mention.
 */
export function titleLane(keywords: readonly string[], notes: readonly { path: string; basename: string; aliases: readonly string[] }[]): TitleHit[] {
  const asked = new Set(keywords);
  const hits: { path: string; shared: number; cover: number }[] = [];
  for (const note of notes) {
    let best: { shared: number; cover: number } | null = null;
    for (const name of [note.basename, ...note.aliases]) {
      const ws = nameWords(name);
      const shared = ws.filter((w) => asked.has(w)).length;
      if (!shared || (shared < 2 && shared < ws.length)) continue;
      const cover = shared / ws.length;
      if (!best || shared > best.shared || (shared === best.shared && cover > best.cover)) best = { shared, cover };
    }
    if (best) hits.push({ path: note.path, ...best });
  }
  return hits
    .sort((a, b) => b.shared - a.shared || b.cover - a.cover || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((h) => ({ path: h.path, shared: h.shared, whole: h.cover === 1 }));
}

/** The chats of a semantic answer (best first) that stand out from it by
 *  {@link RECALL_CHAT_MIN_LIFT} over its median score. */
export function semanticHits(scored: readonly { id: string; score: number }[]): string[] {
  if (!scored.length) return [];
  const sorted = scored.map((s) => s.score).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return scored.filter((s) => s.score - median >= RECALL_CHAT_MIN_LIFT).map((s) => s.id);
}

/** Recalls for the chats the semantic index returned, in its order: the chat's
 *  first user message stands in for the match (the index embeds whole chats,
 *  so it cannot point at a line). No time window: that is the lane's point. */
export function chatsFromIds(ids: readonly string[], chats: readonly ChatRecord[], opts: { excludeId: string }): ChatRecall[] {
  const byId = new Map(chats.map((c) => [c.id, c]));
  const out: ChatRecall[] = [];
  for (const id of ids) {
    const chat = byId.get(id);
    if (!chat || id === opts.excludeId) continue;
    const first = chatLines(chat.messages).find((l) => l.role === "user" && l.text);
    const at = first?.at ?? chat.updatedAt;
    out.push({
      id,
      title: chat.title || "Untitled chat",
      date: at === undefined ? "" : localDate(at),
      snippet: flat(first?.text ?? "", RECALL_EXCERPT_CHARS),
      msgIndex: first?.index ?? null,
    });
  }
  return out;
}

/** Reciprocal rank fusion: an item found by several lanes adds up; the first
 *  lane that holds an item supplies it (Sonar's excerpt, the lexical snippet).
 *  Equal scores break by key, so the order never depends on lane timing. */
function fuse<T>(lanes: readonly (readonly T[])[], key: (t: T) => string): T[] {
  const acc = new Map<string, { item: T; score: number }>();
  for (const lane of lanes) {
    lane.forEach((item, i) => {
      const k = key(item);
      const hit = acc.get(k);
      if (hit) hit.score += 1 / (RRF_K + i + 1);
      else acc.set(k, { item, score: 1 / (RRF_K + i + 1) });
    });
  }
  return [...acc.entries()]
    .sort(([ka, a], [kb, b]) => b.score - a.score || (ka < kb ? -1 : ka > kb ? 1 : 0))
    .map(([, v]) => v.item);
}

/** The notes and chats one turn injects, best first. A note named in full
 *  comes in on its name alone. A note named only in part needs the vault
 *  search to have found it too: three shared words lift it from anywhere in
 *  that search ("turno open core" for turno-saas-open-core), two only reorder
 *  the notes the search would inject anyway ("Orchestration Board" for
 *  "Orchestration Board Ideas" must not push out the decision about it).
 *  With `supersede`, a superseded note gives its slot to the current one and
 *  stays right below it, labelled. */
export function rankRecall(
  lanes: RecallLanes,
  opts: { maxNotes: number; maxChats: number; supersede?: SupersedeIndex },
): { notes: NoteRecall[]; chats: ChatRecall[] } {
  const found = new Set(lanes.sonar.map((n) => n.path));
  const injected = new Set(lanes.sonar.slice(0, opts.maxNotes).map((n) => n.path));
  const title = lanes.title
    .filter((t) => t.whole || (t.shared >= 3 ? found : injected).has(t.path))
    .map((t) => ({ path: t.path, excerpt: "" }));
  const notes = fuse([lanes.sonar, title], (n) => n.path).slice(0, opts.maxNotes);
  return {
    notes: opts.supersede ? applySupersede(notes, opts.supersede, (path) => ({ path, excerpt: "" })).slice(0, opts.maxNotes) : notes,
    chats: fuse([lanes.lexicalChats, lanes.semanticChats ?? []], (c) => c.id).slice(0, opts.maxChats),
  };
}

/**
 * The block that rides the outbound message, or "" when there is nothing.
 * Entries are dropped from the end (chats first, then the weakest notes) until
 * the whole block fits {@link RECALL_MAX_CHARS}.
 */
export function formatRecallBlock(notes: readonly NoteRecall[], chats: readonly ChatRecall[]): string {
  const noteLines = notes.slice(0, RECALL_MAX_NOTES).map((n) => {
    const excerpt = flat(n.excerpt, RECALL_EXCERPT_CHARS);
    const label = n.supersededBy ? ` (superseded by ${n.supersededBy.replace(/^.*\//, "").replace(/\.md$/, "")}, use that)` : "";
    return `${excerpt ? `- ${n.path}: ${excerpt}` : `- ${n.path}`}${label}`;
  });
  const chatLinesOut = chats.slice(0, RECALL_MAX_CHATS).map((c) => `- "${flat(c.title, 80)}" (${c.date}): ${c.snippet}`);
  const render = (): string => {
    if (!noteLines.length && !chatLinesOut.length) return "";
    const parts = [RECALL_OPEN, "Background context recalled from the vault and past chats, NOT the current conversation. Use it only if relevant."];
    if (noteLines.length) parts.push("Notes:", ...noteLines);
    if (chatLinesOut.length) parts.push("Past chats:", ...chatLinesOut);
    parts.push(RECALL_CLOSE);
    return parts.join("\n");
  };
  let block = render();
  while (block.length > RECALL_MAX_CHARS) {
    if (chatLinesOut.length) chatLinesOut.pop();
    else noteLines.pop();
    block = render();
  }
  return block;
}
