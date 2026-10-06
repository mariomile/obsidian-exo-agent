import type { App } from "obsidian";
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { MemoryCaps } from "../core/memory-caps";
import { formatRecentChats } from "../core/recent-chats";
import { formatChatHits, MIN_SEARCH_CHARS, searchChats } from "../core/chat-search";
import { ok, err, getExo } from "./tool-kit";
import type { AnyTool } from "./sdk-tool";

/**
 * The memory tools that read Exo's own state rather than a vault note:
 * `recent_chats` (the conversation store) and `undo_memory_write` (revert a
 * memory harvest). Both reach the plugin through `getExo`, like the automation
 * tools, so they work the same from chat, the Codex bridge and headless runs.
 */

/** Read-only memory tool names, auto-allowed without a permission card. */
export const MEMORY_READ_TOOLS = ["mcp__obsidian__recent_chats", "mcp__obsidian__search_chats"];

export function buildMemoryTools(app: App, caps: MemoryCaps): AnyTool[] {
  const recentChats = tool(
    "recent_chats",
    "Read your own recent conversations with the user (current and archived chats): per chat the title, date, what the user wrote, your final answer and the notes you produced. Use it when the user asks what you discussed, decided or produced recently.",
    {
      days: z.number().optional().describe("Window in days, default 7."),
      max_chars: z.number().optional().describe("Output cap, default 30000."),
    },
    async (args) => {
      const exo = getExo(app);
      if (!exo) return err("Exo isn't loaded.");
      const days = Math.min(Math.max(args.days ?? 7, 1), 365);
      const maxChars = Math.min(Math.max(args.max_chars ?? 30_000, 1000), 100_000);
      const chats = await exo.readConversationStore();
      return ok(formatRecentChats(chats, { days, maxChars, now: Date.now() }));
    }
  );

  // T3 Code's `t3_thread_search`: what was said, not a time window.
  const searchChatsTool = tool(
    "search_chats",
    "Search your own past conversations with the user (current and archived) for words in what the user wrote or in your final answers. Returns one line per matching chat: title, date, id, and the matching sentence. Use it when the user refers to something discussed before and you need to find which chat.",
    {
      query: z.string().describe(`Words to find, at least ${MIN_SEARCH_CHARS} characters; every word must appear.`),
      limit: z.number().optional().describe("Max chats, default 20."),
    },
    async (args) => {
      const exo = getExo(app);
      if (!exo) return err("Exo isn't loaded.");
      if (args.query.trim().length < MIN_SEARCH_CHARS) return err(`Query needs at least ${MIN_SEARCH_CHARS} characters.`);
      const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
      const hits = searchChats(await exo.readConversationStore(), args.query, limit);
      return ok(formatChatHits(hits, args.query));
    }
  );

  const undoMemoryWrite = tool(
    "undo_memory_write",
    "Undo a memory harvest: the lines Exo wrote into notes by itself after a chat. Reverts the latest harvest by default, or the one whose commit sha you pass. Refuses when a touched note changed since.",
    { sha: z.string().optional().describe("Commit sha (or prefix) of the harvest to revert; omit for the latest.") },
    async (args) => {
      const exo = getExo(app);
      if (!exo) return err("Exo isn't loaded.");
      const res = await exo.undoMemoryWrite(args.sha);
      return res.ok ? ok(res.message) : err(res.message);
    }
  );

  return [
    ...(caps.chatSearch ? [recentChats, searchChatsTool] : []),
    ...(caps.undo ? [undoMemoryWrite] : []),
  ];
}
