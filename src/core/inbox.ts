/**
 * Inbox: the one model of "what waits for you" (Release 2). Pure, no
 * `obsidian` import: the sidebar and the Cockpit render the same `Inbox`, and
 * every count anywhere is `buildInbox().count`, so two surfaces can never
 * disagree about how many things need you.
 *
 * Counting rules, each enforced here and nowhere else:
 *  - a chat counts once, by its strongest state: request > error > new result;
 *  - streaming and stopped chats are not in the Inbox;
 *  - unreviewed write runs count once per automation, whatever their number;
 *  - pending suggestions count once, and so does the Daily Pulse.
 *
 * Every verb mutates the SOURCE (a chat's `seenAt`, a run's `reviewedAt`, the
 * pulse's `lastReviewedAt`). Queue answers are the only items with no source
 * field to write, so they alone are tracked in `settings.inboxSeen`, keyed by
 * a versioned id: a new answer gets a new id, so an old "read" cannot hide it.
 */
import { unreviewedWriteRuns, type AutomationRunRecord } from "./automations";
import { dailyPulseNeedsReview, type DailyPulseReviewState } from "./daily-pulse";

export type InboxKind = "request" | "error" | "result";
export type InboxSource = "chat" | "runs" | "run" | "proposals" | "pulse" | "answer";
export type InboxVerb = "read" | "resolve" | "archive";

export interface InboxItem {
  /** Stable and versioned: a new event gets a new id, so an old read or dismiss cannot hide it.
   *  chat:<convoId>:<perm|ask|error|reply> · runs:<slug|name> · run:<runId>
   *  proposals · pulse:<lastSuccessAt> · pulse-error:<lastAttemptAt> · answer:<path>@<answeredAt> */
  id: string;
  kind: InboxKind;
  source: InboxSource;
  title: string;
  detail: string;
  at: number;
  /** What the item points at: a convo id, an automation group key, a note path. */
  target: string;
  runIds?: string[];
  permRule?: string;
  verbs: readonly InboxVerb[];
}

/** The chat facts the Inbox reads: a subset of `ChatRowSource` (core/chat-rows). */
export interface InboxChat {
  id: string;
  title: string;
  focused: boolean;
  streaming: boolean;
  stopped: boolean;
  pendingPerm: boolean;
  pendingAsk: boolean;
  poisoned: boolean;
  permRule?: string;
  updatedAt?: number;
  lastActiveAt?: number;
  seenAt?: number;
}

export interface InboxAnswer {
  path: string;
  name: string;
  answeredAt: number;
}

export interface InboxInput {
  /** Null when no chat view is open: chats then contribute nothing. */
  chats: readonly InboxChat[] | null;
  runs: readonly AutomationRunRecord[];
  /** Pending suggestions; 0 when the proposal kernel is off. */
  proposals: number;
  pulse: DailyPulseReviewState;
  answers: readonly InboxAnswer[];
  /** `settings.inboxSeen`: read marks for queue answers only. */
  seen: Readonly<Record<string, number>>;
  now: number;
}

export interface Inbox {
  items: InboxItem[];
  count: number;
  byKind: Record<InboxKind, number>;
}

const DAY = 86_400_000;
/** Queue answers stay in the Inbox this long after they land. */
const ANSWER_WINDOW_MS = DAY;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * A turn landed here since the user last had the chat in view or marked it
 * read. Never the chat in front of you: you are reading it.
 */
export function isUnseen(
  c: Pick<InboxChat, "focused" | "updatedAt" | "lastActiveAt" | "seenAt">,
): boolean {
  return !c.focused && (c.updatedAt ?? 0) > Math.max(c.lastActiveAt ?? 0, c.seenAt ?? 0);
}

/** Which automation a run belongs to: its file slug, else (pre-v2) its name. */
export function runGroupKey(r: AutomationRunRecord): string {
  return r.slug ?? r.name;
}

/** A run name as the automation's name: agent runs carry their trigger in
 *  parentheses ("Inbox Triager (create _inbox x.md)"). */
const automationName = (r: AutomationRunRecord): string => r.name.replace(/ \(.*\)$/, "");

export interface RunGroup {
  key: string;
  name: string;
  /** Newest first. */
  runs: AutomationRunRecord[];
  /** Distinct vault paths the group's runs wrote. */
  writes: number;
}

/** Unreviewed write runs, one group per automation, newest group first. A
 *  failed write run lives here too: it wrote, so it is reviewed, never twice. */
export function groupUnreviewedRuns(runs: readonly AutomationRunRecord[]): RunGroup[] {
  const groups = new Map<string, RunGroup>();
  const sorted = [...unreviewedWriteRuns([...runs])].sort((a, b) => b.startedAt - a.startedAt);
  for (const r of sorted) {
    const key = runGroupKey(r);
    let g = groups.get(key);
    if (!g) {
      g = { key, name: automationName(r), runs: [], writes: 0 };
      groups.set(key, g);
    }
    g.runs.push(r);
  }
  for (const g of groups.values()) g.writes = new Set(g.runs.flatMap((r) => r.writes)).size;
  return [...groups.values()];
}

/** Failed runs that wrote nothing, are not dismissed, and were not followed
 *  by a successful run of the same automation. */
export function openFailedRuns(runs: readonly AutomationRunRecord[]): AutomationRunRecord[] {
  const lastOk = new Map<string, number>();
  for (const r of runs) {
    if (!r.ok) continue;
    const key = runGroupKey(r);
    lastOk.set(key, Math.max(lastOk.get(key) ?? 0, r.startedAt));
  }
  return runs
    .filter(
      (r) =>
        !r.ok &&
        !r.reviewedAt &&
        !r.restoredAt &&
        r.writes.length === 0 &&
        (lastOk.get(runGroupKey(r)) ?? -1) < r.startedAt,
    )
    .sort((a, b) => b.startedAt - a.startedAt);
}

function chatItem(c: InboxChat): InboxItem | null {
  const base = { source: "chat" as const, title: c.title || "Untitled", at: c.updatedAt ?? 0, target: c.id };
  if (c.pendingPerm) {
    return {
      ...base,
      id: `chat:${c.id}:perm`,
      kind: "request",
      detail: c.permRule ? `Wants to run ${c.permRule}` : "Waiting for your OK",
      ...(c.permRule ? { permRule: c.permRule } : {}),
      verbs: ["resolve"],
    };
  }
  if (c.pendingAsk) {
    return { ...base, id: `chat:${c.id}:ask`, kind: "request", detail: "Asked you a question", verbs: ["resolve"] };
  }
  if (c.streaming || c.stopped || !isUnseen(c)) return null;
  if (c.poisoned) {
    return {
      ...base,
      id: `chat:${c.id}:error`,
      kind: "error",
      detail: "Ended with an error",
      verbs: ["resolve", "archive"],
    };
  }
  return { ...base, id: `chat:${c.id}:reply`, kind: "result", detail: "New reply", verbs: ["read"] };
}

function pulseItem(p: DailyPulseReviewState): InboxItem | null {
  if (p.status === "error" && p.lastAttemptAt > p.lastReviewedAt) {
    return {
      id: `pulse-error:${p.lastAttemptAt}`,
      kind: "error",
      source: "pulse",
      title: "Daily Pulse failed",
      detail: p.lastError || "The last run did not finish",
      at: p.lastAttemptAt,
      target: "",
      verbs: ["resolve", "archive"],
    };
  }
  if (dailyPulseNeedsReview(p)) {
    return {
      id: `pulse:${p.lastSuccessAt}`,
      kind: "result",
      source: "pulse",
      title: "Daily Pulse",
      detail: "Ready to review",
      at: p.lastSuccessAt,
      target: "",
      verbs: ["read"],
    };
  }
  return null;
}

const KIND_ORDER: Record<InboxKind, number> = { request: 0, error: 1, result: 2 };

/** The Inbox: requests, then errors, then new results, newest first inside
 *  each kind. No cap: `count === items.length`, always. */
export function buildInbox(i: InboxInput): Inbox {
  const items: InboxItem[] = [];
  for (const c of i.chats ?? []) {
    const it = chatItem(c);
    if (it) items.push(it);
  }
  for (const g of groupUnreviewedRuns(i.runs)) {
    items.push({
      id: `runs:${g.key}`,
      kind: "request",
      source: "runs",
      title: g.name,
      detail: `${plural(g.runs.length, "run")} to review, ${plural(g.writes, "file")} changed`,
      at: g.runs[0].startedAt,
      target: g.key,
      runIds: g.runs.map((r) => r.id),
      verbs: ["resolve"],
    });
  }
  if (i.proposals > 0) {
    items.push({
      id: "proposals",
      kind: "request",
      source: "proposals",
      title: plural(i.proposals, "suggestion"),
      detail: "Waiting for accept or dismiss",
      at: 0,
      target: "",
      verbs: ["resolve"],
    });
  }
  for (const r of openFailedRuns(i.runs)) {
    items.push({
      id: `run:${r.id}`,
      kind: "error",
      source: "run",
      title: automationName(r),
      detail: "Run failed",
      at: r.startedAt,
      target: runGroupKey(r),
      runIds: [r.id],
      verbs: ["resolve", "archive"],
    });
  }
  const pulse = pulseItem(i.pulse);
  if (pulse) items.push(pulse);
  for (const a of i.answers) {
    const id = `answer:${a.path}@${a.answeredAt}`;
    if (i.now - a.answeredAt >= ANSWER_WINDOW_MS || i.seen[id] !== undefined) continue;
    items.push({
      id,
      kind: "result",
      source: "answer",
      title: a.name,
      detail: "Exo Queue answered",
      at: a.answeredAt,
      target: a.path,
      verbs: ["read"],
    });
  }
  items.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.at - a.at);
  const byKind: Record<InboxKind, number> = { request: 0, error: 0, result: 0 };
  for (const it of items) byKind[it.kind]++;
  return { items, count: items.length, byKind };
}

/** Everything a rendered row shows: the panel rebuilds only when this moves. */
export function inboxSig(items: readonly InboxItem[]): string {
  return items.map((it) => `${it.id}:${it.title}:${it.detail}:${it.permRule ?? ""}`).join("|");
}

/** Drop read marks older than `maxAgeMs`: an answer leaves the Inbox after a
 *  day anyway, so a week-old mark protects nothing. */
export function pruneSeen(
  seen: Readonly<Record<string, number>>,
  now: number,
  maxAgeMs = 7 * DAY,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, at] of Object.entries(seen)) if (now - at <= maxAgeMs) out[id] = at;
  return out;
}
