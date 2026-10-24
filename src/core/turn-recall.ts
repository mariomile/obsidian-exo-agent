/**
 * Per-turn recall, pure half: when to recall, what to search for, which past
 * chats match, and the budgeted block that rides the outbound message. The
 * impure half (vault search, reading the conversation store) is
 * `obsidian/turn-recall.ts`. No Obsidian import.
 */
import { chatLines, localDate, type ChatRecord } from "./recent-chats";

export const RECALL_OPEN = "[vault-recall]";
export const RECALL_CLOSE = "[/vault-recall]";

/** Whole block ceiling, delimiters included. */
export const RECALL_MAX_CHARS = 2000;
export const RECALL_MAX_NOTES = 5;
export const RECALL_MAX_CHATS = 2;
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
  /** Notes whose name matches the message. */
  title: NoteRecall[];
  /** {@link matchPastChats}. */
  lexicalChats: ChatRecall[];
  /** The semantic chat index, best first; null when it could not run. */
  semanticChats: ChatRecall[] | null;
}

/** The notes and chats one turn injects, best first. */
export function rankRecall(lanes: RecallLanes, opts: { maxNotes: number; maxChats: number }): { notes: NoteRecall[]; chats: ChatRecall[] } {
  return { notes: lanes.sonar.slice(0, opts.maxNotes), chats: lanes.lexicalChats.slice(0, opts.maxChats) };
}

/**
 * The block that rides the outbound message, or "" when there is nothing.
 * Entries are dropped from the end (chats first, then the weakest notes) until
 * the whole block fits {@link RECALL_MAX_CHARS}.
 */
export function formatRecallBlock(notes: readonly NoteRecall[], chats: readonly ChatRecall[]): string {
  const noteLines = notes.slice(0, RECALL_MAX_NOTES).map((n) => {
    const excerpt = flat(n.excerpt, RECALL_EXCERPT_CHARS);
    return excerpt ? `- ${n.path}: ${excerpt}` : `- ${n.path}`;
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
