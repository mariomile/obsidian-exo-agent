/**
 * Inbox: the one model of "what waits for you" (Release 2). Pure, no
 * `obsidian` import: the sidebar and the Cockpit render the same `Inbox`, and
 * every count anywhere is `buildInbox().count`, so two surfaces can never
 * disagree about how many things need you.
 *
 * Counting rules, each enforced here and nowhere else:
 *  - only a chat the sidebar lists can count (`isListedChat`): archived chats
 *    and empty husks never do;
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
import { awaitsReview, runOwner, type AutomationRef, type AutomationRunRecord } from "./automations";
import { dailyPulseNeedsReview, type DailyPulseReviewState } from "./daily-pulse";
import { plural } from "./reentry";
import { deriveLane, type SessionSnapshot } from "./session-cards";
import { effectiveSnoozed, wokeAt } from "./thread-lifecycle";

export type InboxKind = "request" | "error" | "result";
export type InboxSource = "chat" | "runs" | "run" | "proposals" | "pulse" | "answer";
export type InboxVerb = "read" | "resolve" | "archive";

export interface InboxItem {
  /** Stable and versioned: a new event gets a new id, so an old read or dismiss cannot hide it.
   *  chat:<convoId>:<perm|ask|error|reply> · runs:<slug|legacy> · run:<runId>
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
  archived: boolean;
  hasMessages: boolean;
  permRule?: string;
  updatedAt?: number;
  lastActiveAt?: number;
  seenAt?: number;
  snoozedUntil?: number;
  snoozedAt?: number;
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
  /** The automations that own runs: pre-v2 runs are filed by name against them. */
  automations: readonly AutomationRef[];
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

/** The verbs every Inbox panel is mounted with (`obsidian/inbox-feed` implements them). */
export interface InboxHandlers {
  /** Row click: resolve a request or an error, read a result. */
  open(item: InboxItem): void;
  /** Inline Allow / Deny on a chat blocked on a permission. */
  decide(item: InboxItem, verdict: "allow" | "deny"): void;
  /** Dismiss errors, mark results read. */
  clear(items: readonly InboxItem[]): void;
  /** "Mark N reviewed" on a group of automation runs. */
  markReviewed(item: InboxItem): void;
  /** Run a failed automation or Daily Pulse again. */
  retry(item: InboxItem): void;
}

const DAY = 86_400_000;
/** Queue answers stay in the Inbox this long after they land. */
const ANSWER_WINDOW_MS = DAY;

/**
 * The one visibility rule: a chat the sidebar lists, and so a chat the Inbox
 * may count. Archived chats are put away, and a chat with no messages that is
 * not running or blocked is an empty husk with nothing to say.
 */
export function isListedChat(c: SessionSnapshot): boolean {
  return !c.archived && deriveLane(c).lane !== "idle";
}

export type UnseenFacts = Pick<
  InboxChat,
  "focused" | "updatedAt" | "lastActiveAt" | "seenAt" | "snoozedUntil" | "snoozedAt" | "pendingPerm" | "pendingAsk"
>;

/**
 * The one read rule, for the Inbox, the sidebar rows and the tab strip: a turn
 * landed, or the chat woke from a snooze, since the user last had it in view or
 * marked it read. Never the chat in front of you (you are reading it), and
 * never a chat still snoozed: "not now" holds until it wakes.
 */
export function isUnseen(c: UnseenFacts, now: number): boolean {
  if (c.focused || effectiveSnoozed(c, now)) return false;
  const news = Math.max(c.updatedAt ?? 0, wokeAt(c, now) ?? 0);
  return news > Math.max(c.lastActiveAt ?? 0, c.seenAt ?? 0);
}

/** Group key of the pre-v2 runs no automation claims: one "Older runs" group,
 *  as on the Automations tab. */
export const LEGACY_RUNS_KEY = "legacy";

/** Which automation a run belongs to, exactly as the Automations tab files it
 *  (core/automations `runOwner`), so the Inbox and the tab show the same groups
 *  and "Run again" finds the automation by its slug. */
export function runGroupKey(r: AutomationRunRecord, automations: readonly AutomationRef[]): string {
  return runOwner(r, automations) ?? LEGACY_RUNS_KEY;
}

/** Who ran it: the owning automation's name, else the run name without an
 *  agent run's trigger ("Inbox Triager (create _inbox x.md)"). */
function ownerName(key: string, r: AutomationRunRecord, automations: readonly AutomationRef[]): string {
  return automations.find((a) => a.slug === key)?.name ?? r.name.replace(/ \(.*\)$/, "");
}

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
export function groupUnreviewedRuns(
  runs: readonly AutomationRunRecord[],
  automations: readonly AutomationRef[],
): RunGroup[] {
  const groups = new Map<string, RunGroup>();
  const sorted = runs.filter(awaitsReview).sort((a, b) => b.startedAt - a.startedAt);
  for (const r of sorted) {
    const key = runGroupKey(r, automations);
    let g = groups.get(key);
    if (!g) {
      const name = key === LEGACY_RUNS_KEY ? "Older runs" : ownerName(key, r, automations);
      g = { key, name, runs: [], writes: 0 };
      groups.set(key, g);
    }
    g.runs.push(r);
  }
  for (const g of groups.values()) g.writes = new Set(g.runs.flatMap((r) => r.writes)).size;
  return [...groups.values()];
}

/** Failed runs that wrote nothing, are not dismissed, and were not followed
 *  by a successful run of the same automation. */
export function openFailedRuns(
  runs: readonly AutomationRunRecord[],
  automations: readonly AutomationRef[],
): AutomationRunRecord[] {
  const lastOk = new Map<string, number>();
  for (const r of runs) {
    if (!r.ok) continue;
    const key = runGroupKey(r, automations);
    lastOk.set(key, Math.max(lastOk.get(key) ?? 0, r.startedAt));
  }
  return runs
    .filter(
      (r) =>
        !r.ok &&
        !r.reviewedAt &&
        !r.restoredAt &&
        r.writes.length === 0 &&
        (lastOk.get(runGroupKey(r, automations)) ?? -1) < r.startedAt,
    )
    .sort((a, b) => b.startedAt - a.startedAt);
}

function chatItem(c: InboxChat, now: number): InboxItem | null {
  if (!isListedChat(c)) return null;
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
  if (c.streaming || c.stopped || !isUnseen(c, now)) return null;
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
    const it = chatItem(c, i.now);
    if (it) items.push(it);
  }
  for (const g of groupUnreviewedRuns(i.runs, i.automations)) {
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
  for (const r of openFailedRuns(i.runs, i.automations)) {
    const key = runGroupKey(r, i.automations);
    items.push({
      id: `run:${r.id}`,
      kind: "error",
      source: "run",
      title: ownerName(key, r, i.automations),
      detail: "Run failed",
      at: r.startedAt,
      target: key,
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
