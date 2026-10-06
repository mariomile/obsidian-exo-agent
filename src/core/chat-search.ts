/**
 * Search across chats — what the user wrote and what Exo concluded, not only
 * the title. Ported from T3 Code's thread search (orchestration-v2/
 * ThreadSearch.ts, the `t3_thread_search` tool): it starts at two characters,
 * matches user messages and final agent answers (never tool output or
 * reasoning), keeps one best hit per chat (a user message before an answer,
 * then the newest), and returns a snippet around the match.
 *
 * Pure and Obsidian-free. The sidebar and the agent tool both call it; neither
 * builds a second index, because the messages are already in memory (sidebar)
 * or in the store the tool reads anyway.
 */
import { chatLines, type ChatMessage } from "./recent-chats";

/** Below this a query matches nearly everything; T3 starts at the same point. */
export const MIN_SEARCH_CHARS = 2;
const SNIPPET_CHARS = 240;
const SNIPPET_BEFORE = 72;

/**
 * Fold for matching: lowercase, diacritics stripped, so `però` is found by
 * typing `pero`. Shared with the sidebar's title filter.
 */
export const fold = (s: string): string => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

const tokensOf = (query: string): string[] => fold(query).split(/\s+/).filter(Boolean);

export type ChatHitSource = "title" | "user" | "assistant";

export interface ChatSearchHit {
  id: string;
  title: string;
  source: ChatHitSource;
  /** The matching line, whitespace-collapsed and cut around the match. */
  snippet: string;
  updatedAt?: number;
  archived?: boolean;
}

/** A line of text cut to `SNIPPET_CHARS` around the first token, with
 *  ellipses where it was cut. */
export function snippetAround(text: string, token: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= SNIPPET_CHARS) return flat;
  const at = Math.max(0, fold(flat).indexOf(token));
  const start = Math.max(0, Math.min(at - SNIPPET_BEFORE, flat.length - SNIPPET_CHARS));
  const end = Math.min(flat.length, start + SNIPPET_CHARS);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

/**
 * The best hit in one chat, or null. Every token must appear somewhere in the
 * title or the chat's lines (word order free, as in the sidebar); the snippet
 * comes from the best line that contains the first token: a user message
 * before an answer, the newest of each.
 */
export function findInChat(
  chat: { id: string; title: string; messages: readonly ChatMessage[]; updatedAt?: number; archived?: boolean },
  query: string,
): ChatSearchHit | null {
  const tokens = tokensOf(query);
  if (tokens.join(" ").length < MIN_SEARCH_CHARS) return null;
  const lines = chatLines(chat.messages).filter((l) => l.text.trim());
  const hay = [chat.title, ...lines.map((l) => l.text)].map(fold).join("\n");
  if (!tokens.every((t) => hay.includes(t))) return null;
  const base = { id: chat.id, title: chat.title, updatedAt: chat.updatedAt, archived: chat.archived };
  const first = tokens[0];
  for (const role of ["user", "assistant"] as const) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (l.role === role && fold(l.text).includes(first)) {
        return { ...base, source: role, snippet: snippetAround(l.text, first) };
      }
    }
  }
  return { ...base, source: "title", snippet: chat.title };
}

const SOURCE_RANK: Record<ChatHitSource, number> = { title: 0, user: 1, assistant: 2 };

/** Every chat that matches, one hit each: title and user hits first, then
 *  answers, newest chat first inside each. */
export function searchChats(
  chats: readonly Parameters<typeof findInChat>[0][],
  query: string,
  limit = 50,
): ChatSearchHit[] {
  const hits: ChatSearchHit[] = [];
  for (const c of chats) {
    const h = findInChat(c, query);
    if (h) hits.push(h);
  }
  hits.sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return hits.slice(0, limit);
}

/** The agent tool's rendering: one line per hit, with the id it can open. */
export function formatChatHits(hits: readonly ChatSearchHit[], query: string): string {
  if (hits.length === 0) return `No chats match "${query}".`;
  return hits
    .map((h) => {
      const date = h.updatedAt ? new Date(h.updatedAt).toISOString().slice(0, 10) : "undated";
      const who = h.source === "assistant" ? "Exo" : h.source === "user" ? "User" : "Title";
      return `- ${h.title || "Untitled chat"} (${date}${h.archived ? ", archived" : ""}; id ${h.id})\n  ${who}: ${h.snippet}`;
    })
    .join("\n");
}
