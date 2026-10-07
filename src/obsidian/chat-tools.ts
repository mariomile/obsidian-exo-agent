import type { App } from "obsidian";
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { ok, err, getExo } from "./tool-kit";
import type { AnyTool } from "./sdk-tool";
import type ExoPlugin from "../main";
import { formatChatTranscript } from "../core/delegation";
import { describeScheduled, formatWhen, parseWhen, SCHEDULE_REPEATS, type ScheduleRepeat } from "../core/scheduled-prompts";

/** Read-only chat tools, auto-allowed without a permission card. */
export const CHAT_READ_TOOLS = ["mcp__obsidian__read_chat", "mcp__obsidian__task_status", "mcp__obsidian__list_scheduled_tasks"];

/** The view-side delegation module, loaded on call: a static import would pull
 *  view.ts into the tool registry's module graph. */
const delegation = () => import("../ui/delegation");
const scheduler = () => import("../ui/scheduled-runner");
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
      return ok((await delegation()).sendToChat(p, convoId, args.chat_id, args.message, args.mode ?? "auto"));
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

  // T3 Code's `schedule_task`: by default the run comes back to this chat.
  const scheduleTask = tool(
    "schedule_task",
    "Schedule a prompt to run later, once or on a repeat. By default it arrives in this chat as a message, so you pick the thread back up; set new_chat for a fresh chat on every run. Give `at` as local time YYYY-MM-DDTHH:MM, or `in_minutes`. If Obsidian is closed at that time, it runs on the next open and says it was late. Report the time back to the user.",
    {
      prompt: z.string().describe("What to do when it runs, written as an instruction to yourself."),
      at: z.string().optional().describe("Local date and time, YYYY-MM-DDTHH:MM."),
      in_minutes: z.number().optional().describe("Minutes from now, instead of `at`."),
      repeat: z.enum(SCHEDULE_REPEATS as [ScheduleRepeat, ...ScheduleRepeat[]]).optional().describe("Omit for once."),
      new_chat: z.boolean().optional().describe("Run in a new chat each time instead of this one."),
    },
    async (args) => {
      const p = plugin(app);
      if (!p) return err("Exo isn't loaded.");
      if (!args.prompt.trim()) return err("The prompt is empty.");
      const dueAt = parseWhen({ at: args.at, inMinutes: args.in_minutes }, Date.now());
      if (dueAt === null) return err("Give a future `at` (YYYY-MM-DDTHH:MM, local time) or a positive `in_minutes`.");
      const s = await (await scheduler()).addScheduled(p, { prompt: args.prompt.trim(), dueAt, target: args.new_chat ? "new" : convoId, repeat: args.repeat });
      return ok(`Scheduled ${s.id} for ${formatWhen(dueAt)}${s.repeat ? `, repeating ${s.repeat}` : ""}.`);
    },
  );

  const listScheduledTasks = tool(
    "list_scheduled_tasks",
    "List every scheduled prompt, soonest first: id, next run, repeat, the chat it runs in, and the prompt.",
    {},
    async () => {
      const p = plugin(app);
      if (!p) return err("Exo isn't loaded.");
      const s = await scheduler();
      const list = s.listScheduled(p);
      return ok(list.length ? list.map((x) => describeScheduled(x, s.targetTitle(p, x.target))).join("\n") : "Nothing is scheduled.");
    },
  );

  const cancelScheduledTask = tool(
    "cancel_scheduled_task",
    "Cancel a scheduled prompt by id (from schedule_task or list_scheduled_tasks). A repeating one stops for good.",
    { id: z.string().describe("The scheduled prompt id.") },
    async (args) => {
      const p = plugin(app);
      if (!p) return err("Exo isn't loaded.");
      return (await (await scheduler()).cancelScheduled(p, args.id)) ? ok(`Cancelled ${args.id}.`) : err(`No scheduled prompt ${args.id}.`);
    },
  );

  return [
    updateChat, readChat, sendToChat, scheduleTask, listScheduledTasks, cancelScheduledTask,
    ...(orchestration ? [taskStatus, taskCancel] : []),
  ];
}
