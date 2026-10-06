/**
 * Persisted conversation data model — the pure, UI-free types shared between
 * `view.ts` and the extracted `core/` logic modules. Moved out of `view.ts`
 * verbatim so the pure logic (recovery recap, persistence planning) can be
 * unit-tested without importing `obsidian`.
 */

export interface AskQuestion {
  question: string;
  header: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
  secret?: boolean;
}

export type Segment =
  | { t: "text"; md: string }
  | { t: "error"; message: string }
  | { t: "notice"; message: string }
  | { t: "tool"; name: string; input: unknown; ok: boolean | null; output: string }
  | { t: "ask"; questions: AskQuestion[]; answers: Record<string, string> }
  | { t: "artifact"; path: string }
  | { t: "plan"; md: string; approved: boolean | null };

/** Per-turn file snapshot for code rewind: path → content before the turn (null = didn't exist). */
export type Checkpoint = Map<string, string | null>;

export type Message =
  | { role: "user"; text: string; at?: number }
  | {
      role: "assistant";
      segments: Segment[];
      checkpoint?: Checkpoint;
      /** Hidden git ref holding this turn's before/after files (core/turn-checkpoint). */
      checkpointRef?: string;
    };

/** On-disk form of a message: the checkpoint Map is stored as [path, content] entries.
 *  `at` (epoch ms) is optional — messages persisted before 0.14.0 don't carry it. */
export type PersistedMessage =
  | { role: "user"; text: string; at?: number }
  | {
      role: "assistant";
      segments: Segment[];
      checkpoint?: [string, string | null][];
      checkpointRef?: string;
    };

export interface MessagePersistenceLimits {
  maxToolOutput: number;
  maxCheckpointFile: number;
}

/** Canonical runtime → disk codec shared by the view and persistence tests. */
export function persistMessage(
  message: Message,
  limits: MessagePersistenceLimits
): PersistedMessage {
  if (message.role === "user") return message;
  return {
    role: "assistant",
    segments: message.segments.map((segment) =>
      segment.t === "tool"
        ? { ...segment, output: segment.output.slice(0, limits.maxToolOutput) }
        : segment
    ),
    ...(message.checkpoint && message.checkpoint.size
      ? {
          checkpoint: [...message.checkpoint.entries()].filter(
            ([, content]) => content === null || content.length <= limits.maxCheckpointFile
          ),
        }
      : {}),
    ...(message.checkpointRef ? { checkpointRef: message.checkpointRef } : {}),
  };
}

/** Canonical disk → runtime codec; old messages naturally omit new fields. */
export function revivePersistedMessage(message: PersistedMessage): Message {
  if (message.role === "user") return message;
  return {
    role: "assistant",
    segments: message.segments,
    ...(Array.isArray(message.checkpoint) ? { checkpoint: new Map(message.checkpoint) } : {}),
    ...(typeof message.checkpointRef === "string" ? { checkpointRef: message.checkpointRef } : {}),
  };
}
