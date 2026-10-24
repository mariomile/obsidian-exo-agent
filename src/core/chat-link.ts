/**
 * The link back to a chat message: `obsidian://exo-chat?id=<convoId>&msg=<index>`.
 * Written into saved notes as provenance and opened by the `exo-chat` protocol
 * handler. `msg` is optional on the way in: a link without it opens the chat.
 */

export const CHAT_LINK_ACTION = "exo-chat";

export function chatLink(convoId: string, msgIndex: number): string {
  return `obsidian://${CHAT_LINK_ACTION}?id=${encodeURIComponent(convoId)}&msg=${msgIndex}`;
}

export function parseChatLink(params: Record<string, string | undefined>): { convoId: string; msgIndex: number | null } | null {
  const convoId = params.id?.trim();
  if (!convoId) return null;
  const msg = params.msg === undefined ? NaN : Number(params.msg);
  return { convoId, msgIndex: Number.isInteger(msg) && msg >= 0 ? msg : null };
}
