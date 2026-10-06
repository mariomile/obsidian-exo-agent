/**
 * Chat-rows — the pure model behind the `exo-chats` sidebar list. UI-free and
 * Obsidian-free so the sectioning, search and grouping rules are testable
 * without mounting a view, same discipline as `history.ts` and
 * `session-cards.ts`.
 *
 * The default view groups by STATE, not by date: what needs you, what is
 * running, what you have open, what you pinned, then everything else. A date
 * bucket answers "when did I touch this", which is a question you ask
 * occasionally; the sidebar's standing question is "what is my situation", and
 * only the state axis answers it. The date axis is still available whole, as
 * `days` mode — the two are peers, which is why this is a mode and not a
 * default that swallowed the other.
 *
 * Liveness is read off `deriveLane` rather than re-derived, because its
 * precedence (perm → ask → streaming) is the correctness core: a conversation
 * blocked on a permission prompt is STILL `streaming: true`, so any local
 * re-implementation that reads streaming first would label "waiting for you"
 * as "working".
 *
 * A row appears in exactly one section. `now` is a parameter, never read
 * internally — same rule, and same reason, as `history.ts`.
 */
import { deriveLane, type NeedsInputReason, type SessionBadge } from "./session-cards";
import { groupByTime, type TimeGroupLabel } from "./history";
import { groupAcrossHomes, groupByParent, type GroupedConvo } from "./child-tree";
import { effectiveSnoozed, snoozeWakeLabel } from "./snooze";

/** The per-conversation facts the list needs. Structural, not `Convo` — this
 *  module stays ignorant of the view's types, the enumerator adapts. */
export interface ChatRowSource {
  id: string;
  title: string;
  preview: string;
  provider: string;
  model: string;
  updatedAt?: number;
  archived: boolean;
  /** Currently a tab in the strip. This is what makes a row part of the working
   *  set, not merely a highlight: an open tab is a chat you have deliberately
   *  kept to hand, so it earns a rich row whether or not a turn is running. */
  open: boolean;
  /** Kept to hand across sessions. Independent of `open` — a pin survives
   *  closing the tab, which is the entire point of pinning. */
  pinned: boolean;
  /** Last turn finished while the user was elsewhere — see `unseen` on ChatRow. */
  unseen: boolean;
  /** User turns, not total messages: it answers "how much of this is mine",
   *  which is what makes a conversation feel long or throwaway. */
  messageCount: number;
  /** The conversation that spawned this one via `spawn_task`. Drives the
   *  indent; absent for everything the user started themselves. */
  parentConvoId?: string;
  // Live signals, consumed by deriveLane.
  streaming: boolean;
  pendingPerm: boolean;
  pendingAsk: boolean;
  poisoned: boolean;
  stopped: boolean;
  hasMessages: boolean;
  /** What the tool running RIGHT NOW is doing, as a human phrase ("Searching
   *  the vault"). Written by the view per TOOL CALL and never per token, which
   *  is the whole reason it can sit in a row signature: a phrase that moved on
   *  every token would rebuild the row dozens of times a second. Absent between
   *  calls and whenever nothing is running. */
  activity?: string;
  /** The one-line permission rule the open permission prompt is asking about
   *  (`Bash(git)`), so the decision can be taken from the row without opening
   *  the transcript. Absent unless a permission card is open on this
   *  conversation. */
  permRule?: string;
  /** Snooze overlay (core/snooze). Persisted on the conversation; whether it
   *  still hides the row is decided here, against `now`. */
  snoozedUntil?: number;
  snoozedAt?: number;
}

export interface ChatRow {
  id: string;
  title: string;
  preview: string;
  provider: string;
  model: string;
  updatedAt?: number;
  open: boolean;
  pinned: boolean;
  messageCount: number;
  /** A turn completed here since the user last had this conversation in view.
   *  The live tier answers "what is happening"; this answers the question that
   *  actually matters more often — "what happened while I was not looking". */
  unseen: boolean;
  /** Kept on the row so the cross-collection grouping pass can see it. */
  parentConvoId?: string;
  /** How far to indent, decided by `groupAcrossHomes` across every collection
   *  at once. 0 for anything the user started, and for a child whose parent
   *  is not visible anywhere in the current list — an orphan renders at top
   *  level rather than vanishing. A child that IS visible is 1 regardless of
   *  which collection it would otherwise have landed in: it is relocated to
   *  sit under its parent, in the parent's collection. */
  depth: 0 | 1;
  /** At least one row is nested UNDER this one in the list as painted — what
   *  earns the row its own collapse toggle. Decided by the same grouping pass
   *  that decided `depth` (see `GroupedConvo.hasChildren`), never re-derived by
   *  the renderer: the pass knows which children were anchored away and which
   *  parents the search filtered out, and a second derivation would answer with
   *  less. Always false at depth 1 — a grandchild renders beside its parent,
   *  not under it. */
  hasChildren: boolean;
  /** Present only while the conversation is running or blocked. */
  lane?: "running" | "needs-input";
  reason?: NeedsInputReason;
  badge?: SessionBadge;
  /** The running tool's human phrase — present only on a `running` row, and
   *  only once a tool call has actually started. Deliberately NOT carried on a
   *  blocked row: a conversation waiting on a permission prompt is still
   *  `streaming: true`, and its last tool phrase would read as progress on the
   *  one row that cannot progress. */
  activity?: string;
  /** The rule an approval would grant, on a row blocked on a PERMISSION only
   *  (`reason === "perm"`). An open question has no rule to grant, so the row
   *  offers no inline decision. */
  permRule?: string;
  /** Wake time, present only while the snooze is still in force: not elapsed
   *  and no raised hand. Its presence is what files the row under Snoozed. */
  snoozedUntil?: number;
}

/**
 * How the list is carved up.
 *
 *  - `activity` — by state: what needs you, what is running, what is open,
 *    what is pinned, then everything settled. Answers "what is my situation".
 *  - `days` — pure chronology by last message, with no promotion at all.
 *    Answers "what did I do on Tuesday", which the activity view cannot: there,
 *    a chat that needs you sits above chats you touched more recently, so a day
 *    column would lie about order.
 *
 * Both are legitimate readings of the same data and neither subsumes the other,
 * which is why this is a mode and not a default.
 */
export type ChatListMode = "activity" | "days";

/**
 * Stable identity for a section, independent of its label. The renderer keys
 * DOM reuse and per-section collapsed state off this, so it must survive a
 * label being reworded or localized — a section keyed by its display text
 * loses its collapsed state the day someone renames "Settled".
 *
 * `day:` sections only exist in `days` mode; the six state sections only in
 * `activity`. `related` can appear in either, and is always last.
 */
export type ChatSectionKey =
  | "needsYou"
  | "running"
  | "open"
  | "pinned"
  | "snoozed"
  | "settled"
  | "related"
  | `day:${TimeGroupLabel}`;

export interface ChatSection {
  key: ChatSectionKey;
  /** Display text. Never parsed — see `ChatSectionKey`. */
  label: string;
  items: ChatRow[];
}

export interface ChatListVM {
  /**
   * Every section to render, in order, none of them empty. One ordered list
   * rather than named fields: the renderer's job is to iterate and paint, and
   * a fixed set of fields would make each new section a change in three files.
   *
   * In `activity` mode: `needsYou`, `running`, `open`, `pinned`, `snoozed`, `settled`.
   * In `days` mode: one `day:` section per non-empty bucket, in time order.
   * Either way `related` comes last when a semantic pass supplied hits — rows
   * that do NOT contain what you typed, which is why they are a section of
   * their own rather than mixed into the results.
   */
  sections: ChatSection[];
  /**
   * Every conversation blocked on a human right now — a permission prompt or an
   * open question — newest first. The needs-you strip's whole source.
   *
   * Deliberately NOT a section: it is derived from the visible set BEFORE the
   * query filter and outside the section machinery entirely, because that is
   * the only thing "immune to collapse" can honestly mean. A chat that cannot
   * move without you must not be reachable only through a section the user put
   * away, or through a search they happen to be halfway through typing.
   *
   * Empty when nothing is blocked, and the strip then renders nothing at all —
   * no chrome, no placeholder, no standing alert surface.
   */
  blocked: ChatRow[];
  /** Rows before the query filter. Distinguishes "no chats yet" from "no chats
   *  match" — different empty states, and collapsing them makes a search look
   *  like it deleted the user's data. */
  total: number;
  /** Rows after the query filter, across every section. */
  matched: number;
}

/** The state sections of `activity` mode, in precedence order: the first one a
 *  row qualifies for is the one it lands in, and that is also the order they
 *  are painted in. */
const ACTIVITY_SECTIONS = [
  ["needsYou", "Needs you"],
  ["running", "Running"],
  ["open", "Open"],
  ["pinned", "Pinned"],
  ["snoozed", "Snoozed"],
  ["settled", "Settled"],
] as const satisfies readonly (readonly [ChatSectionKey, string])[];

type ActivityKey = (typeof ACTIVITY_SECTIONS)[number][0];

/**
 * Which state section a row earns. First match wins, and the order is the
 * argument:
 *
 *  1. `needsYou` — it wants a human: blocked on a permission prompt or a
 *     question, or its last turn errored or was stopped. A badge counts even
 *     when the chat is also open, because an error is an action item and being
 *     open is merely where you left it — filing it under "Open" would put the
 *     one row that needs doing in the section for rows that need nothing.
 *  2. `running` — a turn is actually executing.
 *  3. `open` — in the tab strip, so deliberately kept to hand, but idle.
 *  4. `pinned` — kept across sessions, and not already above.
 *  5. `snoozed` — hidden until a wake time (core/snooze). Checked right after
 *     a blocked lane, so a snooze outranks running, open, pinned and a badge.
 *  6. `settled` — everything else, by recency, with no day sub-buckets.
 *
 * `lane` and `badge` are mutually exclusive by construction (`deriveLane`
 * only attaches a badge on the idle branch), so 1 and 2 cannot both apply.
 */
/**
 * The one definition of "this row wants a human": blocked on a permission or a
 * question right now (`lane`), or ended badly and still unacknowledged
 * (`badge`). Exported because the list is not the only reader — the rows paint
 * an attention state from it too, and when the view restated the rule it
 * restated it twice and got one of them wrong: the rich row asked for both
 * arms, the compact row asked only for `badge`, guarded by a comment asserting
 * the other arm could not reach it.
 */
export const needsYou = (r: ChatRow): boolean => r.lane === "needs-input" || !!r.badge;

const activityKey = (r: ChatRow): ActivityKey => {
  // A blocked chat never stays snoozed (it raised its hand, see core/snooze),
  // but a badge does: snoozing a stopped chat is the user saying "seen, later".
  if (r.lane === "needs-input") return "needsYou";
  if (r.snoozedUntil !== undefined) return "snoozed";
  if (needsYou(r)) return "needsYou";
  if (r.lane === "running") return "running";
  if (r.open) return "open";
  if (r.pinned) return "pinned";
  return "settled";
};

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * Compact age label for a list row: `now` / `30m` / `19h` / `4d`. Clamped at
 * zero so a clock skew (or a timestamp written a tick into the future) reads as
 * `now` rather than a negative age.
 */
export function relativeTime(ts: number, now: number): string {
  const age = Math.max(0, now - ts);
  if (age < MINUTE) return "now";
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m`;
  if (age < DAY) return `${Math.floor(age / HOUR)}h`;
  return `${Math.floor(age / DAY)}d`;
}

/**
 * Fold a string for matching: lowercase, and strip diacritics so `però` is
 * reachable by typing `pero`. Italian titles are full of accents nobody types
 * into a filter box, and an accent-sensitive search silently hides them.
 */
const fold = (s: string): string =>
  s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

/**
 * Does this conversation match the query? EVERY whitespace-separated token has
 * to appear somewhere in the title or the preview, in any order.
 *
 * Deliberately not a contiguous substring: typing `gbrain garry` should find
 * "GBrain di Garry Tan", and it does not under `includes(query)` because the
 * words are separated by a `di` the user did not remember. Word-order
 * independence is what makes a filter usable from memory rather than from
 * recall of the exact phrasing.
 */
export function matchesQuery(s: { title: string; preview: string }, query: string): boolean {
  const tokens = fold(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const hay = `${fold(s.title)} ${fold(s.preview)}`;
  return tokens.every((t) => hay.includes(t));
}

/** Families rendered as acronyms rather than title-cased words. */
const ACRONYMS = new Set(["gpt", "o1", "o3"]);

/**
 * A model id as a person would say it: `claude-opus-4-8` → `Opus 4.8`,
 * `gpt-5.6-luna` → `GPT 5.6 Luna`.
 *
 * The provider name is stripped when the id repeats it, because the row already
 * has a provider and "Claude · claude-opus-5" spends a third of a 216px sidebar
 * saying Claude twice. Hyphens BETWEEN DIGITS become dots — `4-8` is a version,
 * not two tokens — while hyphens between words stay word breaks.
 */
export function modelLabel(provider: string, model: string): string {
  const raw = model.trim();
  if (!raw) return "";
  const prefix = `${provider.trim().toLowerCase()}-`;
  const body = raw.toLowerCase().startsWith(prefix) ? raw.slice(prefix.length) : raw;
  const parts = body.split("-").filter(Boolean);
  const merged: string[] = [];
  for (const part of parts) {
    const prev = merged[merged.length - 1];
    // A numeric token following a numeric token continues the same version.
    if (prev !== undefined && /^[\d.]+$/.test(prev) && /^\d+$/.test(part)) {
      merged[merged.length - 1] = `${prev}.${part}`;
      continue;
    }
    merged.push(part);
  }
  return merged
    .map((p) => (ACRONYMS.has(p) ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(" ");
}

/** The age slot of a row: when it wakes while snoozed, how old it is
 *  otherwise. One function so the signature and both row densities agree. */
export function rowAge(r: Pick<ChatRow, "updatedAt" | "snoozedUntil">, now: number): string {
  if (r.snoozedUntil !== undefined) return `wakes ${snoozeWakeLabel(r.snoozedUntil, now)}`;
  return r.updatedAt ? relativeTime(r.updatedAt, now) : "";
}

const byRecency = (a: ChatRow, b: ChatRow): number => (b.updatedAt ?? 0) - (a.updatedAt ?? 0);

/** Snoozed shelf order: soonest wake first, it is the next one coming back. */
const bySoonestWake = (a: ChatRow, b: ChatRow): number =>
  (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0);

/** Ordering inside `needsYou`: something blocked right now, waiting on an
 *  answer, outranks something that already finished badly. Then recency. */
const NEEDS_YOU_RANK = (r: ChatRow): number => (r.lane === "needs-input" ? 0 : 1);

/** Ordering inside `open`: an unseen reply is the one row in a band of idle
 *  tabs that is carrying news, so it reads first. Then recency. */
const OPEN_RANK = (r: ChatRow): number => (r.unseen ? 0 : 1);

const RANKED_SORT = (rank: (r: ChatRow) => number) => (a: ChatRow, b: ChatRow): number => {
  const d = rank(a) - rank(b);
  return d !== 0 ? d : byRecency(a, b);
};

/** Per-section ordering; anything unlisted is plain recency. */
const SECTION_SORT: Partial<Record<ActivityKey, (a: ChatRow, b: ChatRow) => number>> = {
  needsYou: RANKED_SORT(NEEDS_YOU_RANK),
  open: RANKED_SORT(OPEN_RANK),
  snoozed: bySoonestWake,
};

/**
 * Rows that must never be relocated under a parent: exactly the membership of
 * the top two sections, derived from `activityKey` rather than restated, so
 * the two cannot drift apart.
 *
 * Live verification found the failure this exists for: a fan-out child blocked
 * on a permission prompt, whose parent was an old closed chat, was nested into
 * a history bucket — a conversation waiting on the user, filed under the
 * archive. Nesting is a convenience; "this is blocked on you" is not. Anchoring
 * pins the row's OWN position only: its children still nest under it, in its
 * section, same as under any other root.
 */
const isAnchored = (r: ChatRow): boolean => {
  const key = activityKey(r);
  return key === "needsYou" || key === "running";
};

function toRow(s: ChatRowSource): ChatRow {
  const row: ChatRow = {
    id: s.id,
    title: s.title,
    preview: s.preview,
    provider: s.provider,
    model: s.model,
    open: s.open,
    pinned: s.pinned,
    unseen: s.unseen,
    messageCount: s.messageCount,
    depth: 0,
    hasChildren: false,
  };
  if (s.updatedAt !== undefined) row.updatedAt = s.updatedAt;
  if (s.parentConvoId) row.parentConvoId = s.parentConvoId;
  return row;
}

/**
 * Stamp the live facts on a row: which lane it is in, why, and the two live
 * strings the sidebar renders — the running tool's phrase and the rule an
 * approval would grant. One function because the section rows and the needs-you
 * strip are built by two different passes over the same conversations, and two
 * copies of this rule would drift the day one of them gained a third string.
 */
function stampLive(row: ChatRow, s: ChatRowSource, d: ReturnType<typeof deriveLane>): ChatRow {
  if (d.lane === "running" || d.lane === "needs-input") {
    row.lane = d.lane;
    if (d.reason) row.reason = d.reason;
  }
  // The badge is independent of the lane and survives into any section: a chat
  // whose last turn errored says so whether it is open, pinned or filed.
  if (d.badge) row.badge = d.badge;
  if (row.lane === "running" && s.activity) row.activity = s.activity;
  if (row.reason === "perm" && s.permRule) row.permRule = s.permRule;
  return row;
}

/**
 * The next conversation to attend to, cycling and wrapping — the idle-worker
 * key. `fromId` is where the user is standing now; a `fromId` that is not
 * itself blocked (the usual case: you are reading something unrelated) starts
 * the walk at the first blocked chat rather than nowhere.
 *
 * Wrapping is right here and not in the sidebar's arrow keys, which
 * deliberately stop at both ends: this list is short and is a QUEUE, so the
 * gesture is "give me the next one" and running off the end would mean the last
 * unanswered chat is the one you cannot reach twice.
 */
export function nextNeedsInput(
  blocked: readonly { id: string }[],
  fromId: string | null,
): string | null {
  if (blocked.length === 0) return null;
  const at = fromId ? blocked.findIndex((r) => r.id === fromId) : -1;
  return blocked[(at + 1) % blocked.length].id;
}

/** Stamp the nesting `groupAcrossHomes` decided — the indent AND whether
 *  anything sits under the row — onto each row of one output collection. A row
 *  that is neither indented nor a parent already says so (`toRow`), so it comes
 *  back unchanged; only a row the pass actually moved or marked needs a new
 *  object, same as the old per-tier `nest` did. */
function stampNesting(grouped: readonly GroupedConvo<ChatRow>[]): ChatRow[] {
  return grouped.map(({ item, depth, hasChildren }) =>
    depth === 0 && !hasChildren ? item : { ...item, depth, hasChildren },
  );
}

/**
 * Build the list. Order of operations matters: exclusions, then the query
 * filter, then sectioning. Filtering first is what lets a zero-match search
 * return no sections at all, so the view renders one "no matches" state
 * instead of a stack of empty headers.
 *
 * A row lands in exactly one section — EXCEPT a child, which is relocated to
 * sit under its parent regardless of the section it would otherwise have
 * earned (see `depth` on `ChatRow`), and except an anchored row, which is
 * never relocated at all (see `isAnchored`).
 */
export function buildChatList(
  sources: readonly ChatRowSource[],
  opts: { query: string; now: number; mode?: ChatListMode; semanticIds?: readonly string[] },
): ChatListVM {
  const mode = opts.mode ?? "activity";
  const visible = sources.filter((s) => !s.archived && deriveLane(s).lane !== "idle");
  const searching = opts.query.trim().length > 0;
  const matched = searching ? visible.filter((s) => matchesQuery(s, opts.query)) : visible;

  // Semantic hits only ever ADD to a search, never reorder or replace it. The
  // literal filter is the contract — if you typed a word, rows containing it
  // stay where they are — and the semantic pass answers the different question
  // "what else is about this", for the case where you cannot remember the word
  // at all. It is skipped entirely when nothing is being searched.
  const literal = new Set(matched.map((s) => s.id));
  const related: ChatRow[] = [];
  if (searching && opts.semanticIds?.length) {
    const byId = new Map(visible.map((s) => [s.id, s]));
    for (const id of opts.semanticIds) {
      if (literal.has(id)) continue;
      const s = byId.get(id);
      if (s) related.push(toRow(s));
    }
  }

  const rows: ChatRow[] = [];
  for (const s of matched) {
    const row = stampLive(toRow(s), s, deriveLane(s));
    if (s.snoozedUntil !== undefined && effectiveSnoozed(s, opts.now)) row.snoozedUntil = s.snoozedUntil;
    rows.push(row);
  }

  // The needs-you strip, over `visible` rather than `matched` — see `blocked`
  // on ChatListVM for why it is built here, off to the side, instead of being
  // read back out of a section.
  const blocked: ChatRow[] = [];
  for (const s of visible) {
    const d = deriveLane(s);
    if (d.lane === "needs-input") blocked.push(stampLive(toRow(s), s, d));
  }
  blocked.sort(byRecency);

  // Named homes for the nesting pass, in paint order. `related` is deliberately
  // NOT one of them — see below.
  const homes = new Map<string, ChatRow[]>();
  const labels = new Map<string, string>();

  if (mode === "days") {
    // Nothing is promoted here — that is the whole point of the mode. The rows
    // keep their lane, pin and unseen flags, so the renderer still marks them;
    // only the GROUPING changes, never the information.
    //
    // groupByTime deliberately does not sort (history.ts:33-36) — the caller
    // owns the order, so sort before bucketing, not after.
    const chronological = [...rows].sort(byRecency);
    for (const g of groupByTime(chronological, opts.now)) {
      homes.set(`day:${g.label}`, g.items);
      labels.set(`day:${g.label}`, g.label);
    }
  } else {
    for (const [key, label] of ACTIVITY_SECTIONS) {
      homes.set(key, []);
      labels.set(key, label);
    }
    for (const row of rows) homes.get(activityKey(row))!.push(row);
    for (const [key] of ACTIVITY_SECTIONS) homes.get(key)!.sort(SECTION_SORT[key] ?? byRecency);
  }

  // One cross-collection pass, not one per section: a child is relocated to sit
  // under its parent wherever the parent landed, even when that is a different
  // section entirely — see `depth` on `ChatRow` and `groupAcrossHomes`. Each
  // section's OWN sort decides root order within it; this only decides which
  // section a child ends up in and where among its siblings.
  //
  // Anchoring applies to `activity` only: it exists to protect the state
  // sections, and `days` has none — there the axis IS the date, and a child
  // sitting in its parent's day is that mode working as designed rather than a
  // row hiding from the section that promised it.
  const grouped = groupAcrossHomes(homes, mode === "days" ? undefined : { isAnchored });

  // `related` gets its own, single-home nesting pass instead of joining the
  // union above: it is the semantic tier, defined for the user as rows that
  // do NOT contain what was typed (chat-list-view.ts). Folding it into the
  // cross-collection pass would let a literal match get relocated INTO
  // "doesn't contain your word", and would let a related-only hit get
  // laundered into a literal section by nesting under a parent that actually
  // matched. A child can still nest under a parent that is ALSO in `related`
  // — this is `groupByParent`, the single-home case, not a no-op.
  const sections: ChatSection[] = [...homes.keys()].map((key) => ({
    key: key as ChatSectionKey,
    label: labels.get(key) ?? key,
    items: stampNesting(grouped.get(key) ?? []),
  }));
  sections.push({ key: "related", label: "Related", items: stampNesting(groupByParent(related)) });

  return {
    // A section that relocation emptied — its only row pulled out to sit under
    // a parent elsewhere — is dropped rather than rendered as a header over
    // nothing: a label with no rows under it promises content that isn't there.
    sections: sections.filter((s) => s.items.length > 0),
    blocked,
    total: visible.length,
    // Related rows count as matches: without them a search whose only hits are
    // semantic would report zero and render the "no matches" empty state over a
    // list that is about to show results.
    matched: matched.length + related.length,
  };
}
