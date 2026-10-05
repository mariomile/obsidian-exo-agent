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

/** What the context row shows and the message carries, from one place. */
export interface ContextModel {
  active: ActiveNoteState;
  /** Hand-attached paths, minus the attached active note. */
  manual: string[];
  /** What rides along with the message: the attached active note, then the rest. */
  paths: string[];
}

/** A note attached by hand is never also offered as a suggestion, and an
 *  attached active note is never listed twice. */
export function contextModel(active: ActiveNoteState, manual: readonly string[]): ContextModel {
  const unique = [...new Set(manual)];
  const state: ActiveNoteState = active.kind === "suggested" && unique.includes(active.path) ? { kind: "none" } : active;
  const attached = state.kind === "attached" ? state.path : null;
  const rest = unique.filter((p) => p !== attached);
  return { active: state, manual: rest, paths: attached ? [attached, ...rest] : rest };
}
