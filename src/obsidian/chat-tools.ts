import type { App } from "obsidian";
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { ok, err, getExo } from "./tool-kit";
import type { AnyTool } from "./sdk-tool";
import type ExoPlugin from "../main";
import { formatChatTranscript } from "../core/delegation";

/** Read-only chat tools, auto-allowed without a permission card. */
export const CHAT_READ_TOOLS = ["mcp__obsidian__read_chat", "mcp__obsidian__task_status"];

/** The view-side delegation module, loaded on call: a static import would pull
 *  view.ts into the tool registry's module graph. */
const delegation = () => import("../ui/delegation");
const plugin = (app: App): ExoPlugin | null => (getExo(app) as unknown as ExoPlugin | null);

/**
 * The agent's hold on the chat it is running in. T3 Code's `t3_thread_update`
 * with `regenerate_title`: the agent can name its own chat, or ask for the same
 * whole-chat regeneration the "Retitle with AI" menu runs (core/title.ts).
 * Registered only for a real chat session, which is the only place there is a
 * "this chat" to act on.
 */
export function buildChatTools(app: App, convoId: string, orchestration: boolean): AnyTool[] {
  const updateChat = tool(
    "update_chat",
    "Change the title of the chat you are running in. Use `regenerate_title` when the conversation has moved on and its title no longer says what it is about; use `rename` only when the user asks for a specific title. Do not retitle on your own initiative after every turn.",
    {
      action: z.enum(["rename", "regenerate_title"]).describe("rename: set `title`; regenerate_title: write a new one from the whole chat."),
      title: z.string().optional().describe("The new title, for `rename`."),
    },
    async (args) => {
      const exo = getExo(app);
      if (!exo) return err("Exo isn't loaded.");
      if (args.action === "rename") {
        const title = (args.title ?? "").trim();
        if (!title) return err("`rename` needs a non-empty `title`.");
        return exo.renameConversation(convoId, title) ? ok(`Renamed this chat to "${title}".`) : err("Couldn't rename this chat.");
      }
      if (!(await exo.retitleConversation(convoId))) return err("Couldn't regenerate the title: the chat has no complete exchange yet.");
      const now = (await exo.readConversationStore()).find((c) => c.id === convoId);
      return ok(`Retitled this chat${now ? ` to "${now.title}"` : ""}.`);
    },
  );
  // T3 Code's `thread_read`: one chat by id (ids come from search_chats,
  // recent_chats or list_tasks).
  const readChat = tool(
    "read_chat",
    "Read one of your other chats with the user by id: what the user wrote and your final answers, newest kept when it is long. Get ids from search_chats, recent_chats or list_tasks.",
    {
      chat_id: z.string().describe("The chat id."),
      max_chars: z.number().optional().describe("Output cap, default 20000."),
    },
    async (args) => {
      const exo = getExo(app);
      if (!exo) return err("Exo isn't loaded.");
      const chat = (await exo.readConversationStore()).find((c) => c.id === args.chat_id);
      if (!chat) return err(`No chat ${args.chat_id}.`);
      return ok(formatChatTranscript(chat, Math.min(Math.max(args.max_chars ?? 20_000, 1000), 100_000)));
    },
  );

  // T3 Code's `thread_send`, with its three modes.
  const sendToChat = tool(
    "send_to_chat",
    "Send a message into another of your chats, as if the user typed it there. mode auto: run now if that chat is idle, else right after its current turn; queue: always after its current turn; steer: fold into its running turn when possible, else queue. Use it to give a delegated task more instructions or to hand work to an existing chat.",
    {
      chat_id: z.string().describe("The target chat id."),
      message: z.string().describe("The message to send."),
      mode: z.enum(["auto", "queue", "steer"]).optional().describe("Default auto."),
    },
    async (args) => {
      const p = plugin(app);
      if (!p) return err("Exo isn't loaded.");
      if (args.chat_id === convoId) return err("That is this chat.");
      if (!args.message.trim()) return err("The message is empty.");
      return ok((await delegation()).sendToChat(p, args.chat_id, args.message, args.mode ?? "auto"));
    },
  );

  const taskStatus = tool(
    "task_status",
    "Check one task you delegated with spawn_task: its status (queued, working, waiting for approval, review, done), its chat id, and its last answer. You do not need to poll: a finished task reports back to this chat on its own.",
    { task_id: z.string().describe("The task id from spawn_task or list_tasks.") },
    async (args) => {
      const p = plugin(app);
      if (!p) return err("Exo isn't loaded.");
      return ok((await delegation()).taskStatus(p, convoId, args.task_id));
    },
  );

  const taskCancel = tool(
    "task_cancel",
    "Cancel a task you delegated with spawn_task: stops its chat if it is working and takes it off the board.",
    { task_id: z.string().describe("The task id from spawn_task or list_tasks.") },
    async (args) => {
      const p = plugin(app);
      if (!p) return err("Exo isn't loaded.");
      return ok(await (await delegation()).cancelTask(p, convoId, args.task_id));
    },
  );

  return [updateChat, readChat, sendToChat, ...(orchestration ? [taskStatus, taskCancel] : [])];
}
