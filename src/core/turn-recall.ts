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
/** A message longer than {@link MAX_KEYWORDS} keywords is searched in chunks of
 *  this many (a long OR query lets the many common words outvote the few that
 *  name the note), at most {@link MAX_QUERY_KEYWORDS} keywords in all. */
const QUERY_CHUNK = 8;
const MAX_QUERY_KEYWORDS = 24;
/** The title lane reads this many keywords: a name costs nothing to look up. */
const MAX_TITLE_KEYWORDS = 48;

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
    "voglio vorrei grazie ciao solo però pero mentre " +
    // Three letters: only a vault name can bring them back (see recallKeywords), never these.
    "chi cui ora per con non che dei del sul sui nel gli una uno tra fra piu mio mia tuo tua suo sua " +
    "are was has had you can not but how why who our out its his her she him all any " +
    "now one two six did get let got say see too way use yes yet own off old ago hai mai nei dal via tre uso due ore far"
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

/** The 3-letter words that are a name in the vault: a token of some note's
 *  basename or alias ("exo", "crm"). Stopwords and numbers never qualify, so a
 *  note called "Per" cannot bring "per" back. */
export function nameVocab(notes: readonly { basename: string; aliases: readonly string[] }[]): Set<string> {
  const vocab = new Set<string>();
  for (const note of notes) {
    for (const name of [note.basename, ...note.aliases]) {
      for (const w of words(name)) if (w.length === 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w)) vocab.add(w);
    }
  }
  return vocab;
}

/** The distinct content words of a message, in order: the search query.
 *  Words of four letters or more qualify; a 3-letter word only when it is in
 *  `vocab` ({@link nameVocab}), which is how "Exo" becomes searchable without
 *  "the" and "per" coming back. Operators (`-x`, `path:`) never survive, so a
 *  message can't steer the search engine's syntax by accident. */
export function recallKeywords(message: string, vocab?: ReadonlySet<string>, cap = MAX_KEYWORDS): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words(message)) {
    if (STOPWORDS.has(w) || seen.has(w) || (w.length < 4 && !(w.length === 3 && vocab?.has(w)))) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= cap) break;
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

/** A lexical match: the chat plus how many of the rare keywords its best line holds. */
export interface LexicalChat extends ChatRecall {
  hits: number;
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
 * message has a single keyword): one shared word is noise. Each match reports
 * its `hits`, which {@link rankRecall}'s chat gate reads.
 */
export function matchPastChats(
  chats: readonly ChatRecord[],
  keywords: readonly string[],
  opts: { excludeId: string; now: number },
): LexicalChat[] {
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
  const scored: { recall: LexicalChat; score: number; at: number }[] = [];
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
        hits: best.score,
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
  lexicalChats: LexicalChat[];
  /** The semantic chat index ({@link chatsFromIds}), best first; null when it
   *  could not answer in time. */
  semanticChats: ChatRecall[] | null;
}

/** Name words that can match a keyword: the same normalisation as
 *  {@link recallKeywords}, minus dates and numbers. Every 3-letter word that is
 *  not a stopword counts, asked for or not, so "How to Win in the Ai Age" is
 *  covered by "win" and "age" together, never by "win" alone. */
const nameWords = (name: string): string[] => [
  ...new Set(words(name).filter((w) => (w.length >= 4 || (w.length === 3 && !STOPWORDS.has(w))) && !/^\d+$/.test(w))),
];

/** A folder note: `X/X.md`, the page a folder is about ("Active/Projects/Exo/Exo.md"). */
export function isHub(path: string): boolean {
  const parts = path.split("/");
  if (parts.length < 2) return false;
  const base = parts[parts.length - 1].replace(/\.md$/i, "");
  return base.toLowerCase() === parts[parts.length - 2].toLowerCase();
}

/** A note the message names: how many words of its name the message shares,
 *  and `whole` when it shares every one. */
export interface TitleHit {
  path: string;
  shared: number;
  whole: boolean;
  /** Set when every shared word has three letters: too weak to inject a note
   *  unless the vault search found it too ({@link rankRecall}). */
  short?: true;
  /** The message writes the note out: `<basename>.md` or `[[<basename>`. That
   *  is a reference, not a word that happens to be a name, so it needs no
   *  vault-search hit ({@link rankRecall}). */
  explicit: boolean;
}

/**
 * Notes the message names: a basename or alias that shares two keywords with
 * it, or whose every word is a keyword ("Turno", "Alberto Aspese"). More shared
 * words first, then names covered more fully, then a project hub ahead of a
 * same-named note (a company card, a transcript), then path. A name sharing a
 * single word with a longer title is noise, not a mention.
 */
export function titleLane(
  keywords: readonly string[],
  notes: readonly { path: string; basename: string; aliases: readonly string[] }[],
  message: string,
): TitleHit[] {
  const asked = new Set(keywords);
  const text = message.toLowerCase();
  const hits: { path: string; shared: number; cover: number; short: boolean; explicit: boolean }[] = [];
  for (const note of notes) {
    let best: { shared: number; cover: number; short: boolean } | null = null;
    for (const name of [note.basename, ...note.aliases]) {
      const ws = nameWords(name);
      const common = ws.filter((w) => asked.has(w));
      const shared = common.length;
      if (!shared || (shared < 2 && shared < ws.length)) continue;
      const cover = shared / ws.length;
      const short = common.every((w) => w.length === 3);
      if (!best || shared > best.shared || (shared === best.shared && cover > best.cover)) best = { shared, cover, short };
    }
    if (!best) continue;
    const base = note.basename.toLowerCase();
    hits.push({ path: note.path, ...best, explicit: text.includes(`${base}.md`) || text.includes(`[[${base}`) });
  }
  return hits
    .sort(
      (a, b) =>
        b.shared - a.shared ||
        b.cover - a.cover ||
        Number(isHub(b.path)) - Number(isHub(a.path)) ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    )
    .map((h) => ({ path: h.path, shared: h.shared, whole: h.cover === 1, ...(h.short ? { short: true as const } : {}), explicit: h.explicit }));
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

/** Minimum rare-keyword hits for a lexical chat when the semantic lane could
 *  not answer. */
export const RECALL_CHAT_MIN_RARE_HITS = 3;

/** The notes and chats one turn injects, best first.
 *  - A note named in full comes in on its name alone: two words or more, or a
 *    project hub ("Active/Projects/DeepAgent/DeepAgent.md").
 *  - A one-word name that is not a project hub is a word the message may use
 *    for something else ("Claude", "win"), and so is a title match resting on
 *    3-letter words ({@link TitleHit.short}): both need the vault search to
 *    have found the note too, unless the message writes the note out
 *    ({@link TitleHit.explicit}).
 *  - A note named only in part needs the same: three shared words lift it from
 *    anywhere in that search ("turno open core" for turno-saas-open-core), two
 *    only reorder the notes the search would inject anyway ("Orchestration
 *    Board" for "Orchestration Board Ideas" must not push out the decision
 *    about it).
 *  - With `supersede`, a superseded note gives its slot to the current one and
 *    stays right below it, labelled.
 *  - A lexical chat is injected only if the semantic lane stands behind it; with
 *    no semantic answer (`semanticChats` null) it needs
 *    {@link RECALL_CHAT_MIN_RARE_HITS} rare-keyword hits. A chat only the
 *    semantic lane found keeps its own rule (the lift floor, already applied to
 *    `semanticChats`). */
export function rankRecall(
  lanes: RecallLanes,
  opts: { maxNotes: number; maxChats: number; supersede?: SupersedeIndex },
): { notes: NoteRecall[]; chats: ChatRecall[] } {
  const found = new Set(lanes.sonar.map((n) => n.path));
  const injected = new Set(lanes.sonar.slice(0, opts.maxNotes).map((n) => n.path));
  const title = lanes.title
    .filter((t) => {
      if (!t.explicit && (t.short || (t.shared < 2 && !isHub(t.path))) && !found.has(t.path)) return false;
      return t.whole || (t.shared >= 3 ? found : injected).has(t.path);
    })
    .map((t) => ({ path: t.path, excerpt: "" }));
  const notes = fuse([lanes.sonar, title], (n) => n.path).slice(0, opts.maxNotes);
  const semantic = lanes.semanticChats;
  const behind = semantic && new Set(semantic.map((c) => c.id));
  const gated = lanes.lexicalChats.filter((c) => (behind ? behind.has(c.id) : c.hits >= RECALL_CHAT_MIN_RARE_HITS));
  return {
    notes: opts.supersede ? applySupersede(notes, opts.supersede, (path) => ({ path, excerpt: "" })).slice(0, opts.maxNotes) : notes,
    chats: fuse([gated, semantic ?? []], (c) => c.id)
      .slice(0, opts.maxChats)
      .map(({ id, title, date, snippet, msgIndex }) => ({ id, title, date, snippet, msgIndex })),
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

/** The keywords of a turn: {@link recallKeywords} with the 3-letter words the
 *  vault names ({@link nameVocab}). */
export function turnKeywords(message: string, names: readonly { basename: string; aliases: readonly string[] }[]): string[] {
  return recallKeywords(message, nameVocab(names));
}

/** The vault searches of a turn, shared by the adapter and the eval: one query
 *  of the {@link turnKeywords} when the message has ten keywords or fewer, else
 *  near-equal chunks of at most {@link QUERY_CHUNK} over its first
 *  {@link MAX_QUERY_KEYWORDS} (17 keywords are 6, 6 and 5, never 8, 8 and 1: a
 *  one-word query would rank its first hit level with a full chunk's). */
export function recallQueries(message: string, vocab: ReadonlySet<string>): string[] {
  const keywords = recallKeywords(message, vocab, MAX_QUERY_KEYWORDS);
  if (keywords.length <= MAX_KEYWORDS) return keywords.length ? [keywords.join(" ")] : [];
  const chunks = Math.ceil(keywords.length / QUERY_CHUNK);
  const size = Math.ceil(keywords.length / chunks);
  const out: string[] = [];
  for (let i = 0; i < keywords.length; i += size) out.push(keywords.slice(i, i + size).join(" "));
  return out;
}

/** What one turn recalled: the notes and chats to inject, and the lanes they
 *  were ranked from. */
export interface RecallResult {
  notes: NoteRecall[];
  chats: ChatRecall[];
  lanes: RecallLanes;
}

/**
 * One turn of recall, everything but the reads. The adapter and the live eval
 * both call it, each supplying only its own reads: `names` is the note index
 * with excluded paths already left out (it feeds the keyword vocabulary and the
 * title lane alike), `search` the vault search (a failure leaves the other
 * lanes), `semantic` the raw scores of the semantic chat index, or null when it
 * gave none in time. `semantic` is started before `search`, so the two run
 * together. Null when the message is too short, a slash command, or has no
 * keyword.
 */
export async function recallTurn(input: {
  message: string;
  convoId: string;
  chats: readonly ChatRecord[];
  now: number;
  names: readonly { path: string; basename: string; aliases: readonly string[] }[];
  supersede?: SupersedeIndex;
  search: (query: string) => Promise<NoteRecall[]>;
  semantic: () => Promise<readonly { id: string; score: number }[] | null>;
}): Promise<RecallResult | null> {
  if (!shouldRecall(input.message)) return null;
  const vocab = nameVocab(input.names);
  const keywords = recallKeywords(input.message, vocab);
  if (!keywords.length) return null;
  const scores = input.semantic();
  const wide = recallKeywords(input.message, vocab, MAX_TITLE_KEYWORDS);
  // A failed search leaves the other queries, the chats and the title lane.
  const searched = await Promise.all(recallQueries(input.message, vocab).map((q) => input.search(q).catch((): NoteRecall[] => [])));
  // Cut to the lane depth after fusing: `found` ({@link rankRecall}) must not widen with the chunks.
  const sonar = (searched.length === 1 ? searched[0] : fuse(searched, (n) => n.path)).slice(0, RECALL_LANE_DEPTH);
  // A long message shares words with many names by chance, so its title hits
  // count only where the search found the note too, or the message writes it out.
  const found = new Set(sonar.map((n) => n.path));
  const named = titleLane(wide, input.names, input.message);
  const title = (wide.length > MAX_KEYWORDS ? named.filter((t) => t.explicit || found.has(t.path)) : named).slice(0, RECALL_LANE_DEPTH);
  const lexicalChats = matchPastChats(input.chats, keywords, { excludeId: input.convoId, now: input.now });
  const scored = await scores;
  const hits = scored && semanticHits(scored);
  const lanes: RecallLanes = {
    sonar,
    title,
    lexicalChats,
    semanticChats: hits && chatsFromIds(hits, input.chats, { excludeId: input.convoId }),
  };
  return { ...rankRecall(lanes, { maxNotes: RECALL_MAX_NOTES, maxChats: RECALL_MAX_CHATS, supersede: input.supersede }), lanes };
}
