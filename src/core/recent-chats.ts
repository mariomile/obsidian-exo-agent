/**
 * Pure views over Exo's own conversation store, shared by the `recent_chats`
 * tool and per-turn recall. No Obsidian import.
 */
import type { Segment } from "./model";

/** The slice of a message these helpers read: both the live `Message` and the
 *  on-disk `PersistedMessage` satisfy it. */
export type ChatMessage = { role: "user"; text: string; at?: number; auto?: true } | { role: "assistant"; segments: Segment[] };

/** The slice of a conversation these helpers read. */
export interface ChatRecord {
  id: string;
  title: string;
  updatedAt?: number;
  archived?: boolean;
  messages: readonly ChatMessage[];
}

/** One message reduced to what a reader needs. */
export interface ChatLine {
  role: "user" | "assistant";
  at: number | undefined;
  /** User text, or the assistant's FINAL text segment (what it concluded). */
  text: string;
  /** Assistant artifact paths (notes it produced), empty for user lines. */
  artifacts: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Flatten a conversation into timestamped lines. Assistant messages carry no
 * `at` of their own, so each inherits the previous message's timestamp; a
 * conversation whose first messages predate `at` (pre-0.14) stays undefined
 * until the first stamped message.
 */
export function chatLines(messages: readonly ChatMessage[]): ChatLine[] {
  const out: ChatLine[] = [];
  let last: number | undefined;
  for (const m of messages) {
    if (m.role === "user") {
      if (typeof m.at === "number") last = m.at;
      if (m.auto) continue; // Exo's own line (a child's report waking its parent), not the user's words
      out.push({ role: "user", at: last, text: m.text, artifacts: [] });
      continue;
    }
    let final = "";
    const artifacts: string[] = [];
    for (const seg of m.segments) {
      if (seg.t === "text" && seg.md.trim()) final = seg.md;
      else if (seg.t === "artifact") artifacts.push(seg.path);
    }
    out.push({ role: "assistant", at: last, text: final, artifacts });
  }
  return out;
}

/** `YYYY-MM-DD` in local time. */
export function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const clip = (s: string, n: number): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};

/** A conversation's lines that fall inside the window, most recent chat first. */
export function chatsInWindow(
  chats: readonly ChatRecord[],
  sinceMs: number,
): { chat: ChatRecord; lines: ChatLine[]; lastAt: number }[] {
  const out: { chat: ChatRecord; lines: ChatLine[]; lastAt: number }[] = [];
  for (const chat of chats) {
    const lines = chatLines(chat.messages).filter((l) => l.at !== undefined && l.at >= sinceMs);
    if (!lines.length) continue;
    out.push({ chat, lines, lastAt: Math.max(...lines.map((l) => l.at ?? 0)) });
  }
  return out.sort((a, b) => b.lastAt - a.lastAt);
}

/** Per-message clip inside `recent_chats`: enough to carry a conclusion. */
const USER_CLIP = 600;
const ASSISTANT_CLIP = 1200;

/**
 * The `recent_chats` rendering: each conversation with messages in the last
 * `days`, title + date, user texts, assistant final text + artifact paths,
 * everything clipped to `maxChars` total.
 */
export function formatRecentChats(
  chats: readonly ChatRecord[],
  opts: { days: number; maxChars: number; now: number },
): string {
  const windowed = chatsInWindow(chats, opts.now - opts.days * DAY_MS);
  if (!windowed.length) return `No conversations in the last ${opts.days} day(s).`;
  const blocks: string[] = [];
  let used = 0;
  for (const { chat, lines, lastAt } of windowed) {
    const body = lines
      .map((l) => {
        if (l.role === "user") return `- User: ${clip(l.text, USER_CLIP)}`;
        const text = l.text ? `- Exo: ${clip(l.text, ASSISTANT_CLIP)}` : "";
        const arts = l.artifacts.length ? `- Artifacts: ${l.artifacts.join(", ")}` : "";
        return [text, arts].filter(Boolean).join("\n");
      })
      .filter(Boolean)
      .join("\n");
    const block = `## ${chat.title || "Untitled chat"} (${localDate(lastAt)}${chat.archived ? ", archived" : ""})\n${body}`;
    if (used + block.length > opts.maxChars) {
      const room = opts.maxChars - used;
      if (room > 200) blocks.push(`${block.slice(0, room)}\n…(clipped)`);
      else blocks.push("…(clipped)");
      break;
    }
    blocks.push(block);
    used += block.length + 2;
  }
  return blocks.join("\n\n");
}
