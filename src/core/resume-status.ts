/**
 * Resume status — whether a conversation would pick up its full context or
 * start from nothing. Pure (no `obsidian`, no DOM, no filesystem) so the
 * classification and the path encoding are testable without touching a disk.
 *
 * Two stores back a conversation and they have independent lifecycles: Exo owns
 * the transcript you read, the Claude CLI owns the session that makes resuming
 * actually work. Deleting a chat here leaves the session behind; the session
 * expiring leaves the chat looking perfectly fine while resume has silently
 * died. This module makes the second case visible, which is the dangerous one:
 * nothing warns you today, you find out by writing.
 */
import { PROFILES, isProviderId } from "../providers/profiles";

/** What would happen if the user wrote in this conversation right now. */
export type ResumeStatus =
  /** The session is on disk: it picks up with full context. */
  | "resumable"
  /** No session to resume: writing starts a fresh one with no memory of the turn. */
  | "restarts"
  /** The session store could not be read. NOT the same as "restarts" — see below. */
  | "unknown";

/**
 * The Claude CLI's per-project directory name, derived from the working
 * directory it was launched in: every non-alphanumeric character becomes a
 * dash. Verified against real directories for a path containing a space and a
 * path containing a dot before this was written.
 *
 * Deliberately NOT collapsing runs of dashes: `/a//b` is `-a--b` on disk, and
 * collapsing would point at a directory that does not exist — which would make
 * every conversation read as `restarts`, the exact false alarm this feature
 * must never produce.
 */
export function projectDirName(vaultPath: string): string {
  return vaultPath.replace(/[^a-zA-Z0-9]/g, "-");
}

/** The only field this needs from a conversation. Structural, so the module
 *  stays ignorant of the view's `Convo` type. */
export interface ResumableConvo {
  sessionId?: string;
}

/**
 * Classify one conversation against the set of session ids present on disk.
 *
 * `onDisk === null` means the read failed or the directory is absent, and it
 * returns `unknown` for everything. This is the load-bearing case: reporting a
 * failed read as `restarts` would put a false warning on every conversation in
 * the history at once, which is worse than showing nothing. Absence of evidence
 * is not evidence of absence, and the UI treats the two differently.
 */
export function resumeStatus(c: ResumableConvo, onDisk: ReadonlySet<string> | null): ResumeStatus {
  if (onDisk === null) return "unknown";
  if (!c.sessionId) return "restarts";
  return onDisk.has(c.sessionId) ? "resumable" : "restarts";
}

/**
 * The outcome of looking up one session file. Three-way on purpose: "the file is
 * not there" and "the lookup failed" are different facts, and collapsing them
 * into a boolean is precisely the mistake this module exists to prevent.
 */
export type SessionFileProbe =
  /** The session file is on disk. */
  | "present"
  /** The lookup succeeded and the file is not there. The only evidence of absence. */
  | "absent"
  /** The lookup itself failed (EACCES, an unexpected filesystem state). Not evidence. */
  | "failed";

/**
 * Whether writing in this conversation would actually pick up its context — the
 * question `shouldColdReseed` needs before deciding to seed a recap.
 *
 * The default is the OPPOSITE of {@link resumeStatus}'s, deliberately. The badge
 * must never cry wolf, so an unreadable store says nothing at all. This answer
 * instead gates an outbound message, where the two errors are not symmetric: a
 * wrong "not resumable" costs one duplicated recap (wasteful, harmless), while a
 * wrong "resumable" is the silent failure itself — the model receives no history
 * and starts blind while the transcript sits visible on screen. So this side
 * leans toward acting, but only on evidence: `absent` is the single input that
 * returns false. Every unknown keeps the pre-existing behavior of trusting the id,
 * because a `failed` lookup treated as absence would prepend a recap to every turn
 * of every conversation, forever.
 *
 * `probe` is a thunk so the guards below can short-circuit before any I/O
 * happens: a Codex conversation or an empty base must not cost a stat, and the
 * ORDER of the guards lives here, tested, rather than being duplicated by the
 * caller deciding when to look.
 */
export function resumableFrom(s: {
  provider: string;
  sessionId?: string;
  vaultBase: string;
  probe: () => SessionFileProbe;
}): boolean {
  // No session was ever created: nothing to resume, and nothing to look up.
  if (!s.sessionId) return false;
  // A Codex (or opencode) session id names a thread in that CLI's own store,
  // not a Claude CLI session file. Searching the Claude project directory for it
  // would find nothing and declare every such chat dead — leave it alone.
  if (!isProviderId(s.provider) || PROFILES[s.provider].resumeProbe !== "claude-jsonl") return true;
  // "" (mobile, or any non-FileSystemAdapter) encodes to "" and would aim the
  // lookup at ~/.claude/projects itself: a path that reads perfectly fine and
  // holds no session file, i.e. a confident and wrong "gone".
  if (!s.vaultBase) return true;
  return s.probe() !== "absent";
}

/**
 * Which of `ids` have a session file this action could actually free.
 * Reuses the same on-disk check the resume badge trusts — never a second
 * definition of "eligible" that could drift from what the badge shows.
 *
 * `activeId` is excluded unconditionally, even when its own session is
 * genuinely resumable: freeing the conversation the user is actively writing
 * in would be freeing the session out from under the next message.
 */
export function eligibleForFreeing(
  ids: readonly string[],
  sessionIdOf: (id: string) => string | undefined,
  onDisk: ReadonlySet<string>,
  activeId?: string,
): string[] {
  return ids.filter((id) => {
    if (id === activeId) return false;
    const sid = sessionIdOf(id);
    return !!sid && onDisk.has(sid);
  });
}
