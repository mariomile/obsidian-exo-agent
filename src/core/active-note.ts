/**
 * Whether the active note rides along with the next message. The composer used
 * to attach `getActiveFile()` unconditionally, so a full-page chat kept sending
 * (and showing) a note the user could no longer see. The rule now follows what
 * is on screen:
 * - visible next to the chat (sidebar chat, or a split) → attached;
 * - active but hidden (e.g. a background tab behind a full-page chat) →
 *   suggested: a one-click card, not part of the message;
 * - dismissed with × → off for that note only; another note attaches again.
 */
export type ActiveNoteState =
  | { kind: "attached"; path: string }
  | { kind: "suggested"; path: string }
  | { kind: "none" };

export function activeNoteState(
  path: string | null,
  visible: boolean,
  dismissed: string | null
): ActiveNoteState {
  if (!path || path === dismissed) return { kind: "none" };
  return visible ? { kind: "attached", path } : { kind: "suggested", path };
}
