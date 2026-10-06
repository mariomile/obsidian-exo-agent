import type { App } from "obsidian";
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { ok, err, getExo } from "./tool-kit";
import type { AnyTool } from "./sdk-tool";

/**
 * The agent's hold on the chat it is running in. T3 Code's `t3_thread_update`
 * with `regenerate_title`: the agent can name its own chat, or ask for the same
 * whole-chat regeneration the "Retitle with AI" menu runs (core/title.ts).
 * Registered only for a real chat session, which is the only place there is a
 * "this chat" to act on.
 */
export function buildChatTools(app: App, convoId: string): AnyTool[] {
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
  return [updateChat];
}
