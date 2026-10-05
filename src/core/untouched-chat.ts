/**
 * A chat nobody has started: no messages, nothing running or queued, and an
 * empty composer (no text, images, or attached notes) with no agent, goal or
 * research mode bound. An external prompt (askExo) fills such a chat instead
 * of leaving it behind as an empty "New chat" tab.
 */
export function isUntouchedChat(
  c: { messages: unknown[]; streaming: boolean; queue: unknown[]; agent?: string; goal?: unknown; researchMode: { enabled: boolean } },
  draft: { text: string; images: unknown[]; attached: string[] }
): boolean {
  return (
    !c.messages.length &&
    !c.streaming &&
    !c.queue.length &&
    !c.agent &&
    !c.goal &&
    !c.researchMode.enabled &&
    !draft.text.trim() &&
    !draft.images.length &&
    !draft.attached.length
  );
}
