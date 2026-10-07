/**
 * Presentation state for the `exo-chats` sidebar — the decisions that are NOT
 * derivable from the conversations themselves:
 *
 *  1. which sections the user has collapsed,
 *  2. which status dot a row earns in the reserved gutter, and
 *  3. what a row SAYS: its status chip, its preview line, and the signature
 *     that decides whether saying it costs a rebuild.
 *
 * Pure and Obsidian-free, same discipline as `chat-rows.ts`: that module decides
 * what the list contains, this one decides how much of it is on screen, and the
 * view owns only the DOM. Both are unit-testable without mounting a pane.
 */
import type { ChatRow, ChatSectionKey } from "./chat-rows";

/**
 * The three states the gutter dot can say, and nothing else. Deliberately NOT
 * "has a badge": a stopped or errored turn already renders its own icon on the
 * row, and saying the same thing twice in two visual channels is exactly the
 * conflation the rails were removed for.
 *
 * The names are the user-facing meanings, not the CSS shapes — filled / ring /
 * small is the rendering choice, and it lives in the stylesheet where a redesign
 * can change it without touching this rule.
 */
export type ChatDot = "running" | "needs-you" | "unseen";

/**
 * Which dot, if any. One channel, so the states are ranked rather than stacked:
 *
 *  - `needs-you` first, matching `deriveLane`'s own precedence — a conversation
 *    blocked on a permission prompt is STILL streaming, and showing it as
 *    "working" would hide the one row that cannot progress without the user.
 *  - `running` next: something is happening, nothing is asked of you.
 *  - `unseen` last: nothing is happening, but news arrived while you were
 *    elsewhere. It loses to both live states because they are strictly newer
 *    information about the same conversation.
 *
 * `null` means at rest — the gutter stays reserved and stays empty.
 */
export function chatDot(row: { lane?: "running" | "needs-input"; unseen: boolean }): ChatDot | null {
  if (row.lane === "needs-input") return "needs-you";
  if (row.lane === "running") return "running";
  return row.unseen ? "unseen" : null;
}

/**
 * What a blocked row is waiting for, in the two lengths the UI needs: a bare
 * noun for a chip that already sits under the chat's name, and the full noun
 * phrase for anything that has to read as a sentence (a status line, a screen
 * reader label).
 *
 * One function because the mapping was written three times - here, and twice
 * more in the needs-you strip, where the chip said "answer" and the aria-label
 * said "an answer". Same two-branch decision, three copies, in the module pair
 * whose whole contract is that what a row SAYS is decided in core.
 */
export function blockedReason(reason: ChatRow["reason"]): { short: string; long: string } {
  return reason === "perm"
    ? { short: "permission", long: "permission" }
    : { short: "answer", long: "an answer" };
}


/**
 * The status chip of a running or blocked row, or `null` when the row says it
 * some other way.
 *
 * Three answers, and the third is the point of Phase 4:
 *
 *  - blocked → WHICH kind of answer is being waited on. The age already sits on
 *    the title line, so the chip only has to say permission vs question.
 *  - running with no phrase yet → `Working`. Between two tool calls there is
 *    genuinely nothing to report, and a row that went blank mid-turn would read
 *    as a chat that stopped.
 *  - running WITH a phrase → nothing. The phrase is the status once there is
 *    one, and a "Working" chip stacked above "Searching the vault" spends a
 *    line of a 216px column saying the same thing twice.
 */
export function rowStatusText(r: Pick<ChatRow, "lane" | "reason" | "activity" | "progress">): string | null {
  if (r.lane === "needs-input") return `Needs ${blockedReason(r.reason).long}`;
  if (r.lane !== "running") return null;
  return r.activity ? null : `Working${progressSuffix(r)}`;
}

/** T3's `planProgress` on a running row: ` · 3/7` of the agent's checklist. */
const progressSuffix = (r: Pick<ChatRow, "progress">): string =>
  r.progress ? ` · ${r.progress.done}/${r.progress.total}` : "";

/**
 * What the preview line carries: the live phrase while a tool is actually
 * running, the last exchange otherwise. `live` is the renderer's cue to treat
 * it as one truncated line rather than two wrapped ones — a phrase is a
 * sentence about right now, and letting it wrap would reflow the row on every
 * tool call.
 */
export function rowPreview(
  r: Pick<ChatRow, "preview" | "lane" | "activity" | "progress">,
): { text: string; live: boolean } {
  if (r.lane === "running" && r.activity) return { text: `${r.activity}${progressSuffix(r)}`, live: true };
  return { text: r.preview, live: false };
}

/**
 * Everything a painted row depends on, as one string. `reconcileList` rebuilds
 * a node only when this moves, so this function IS the "a tick that changed
 * nothing touches no DOM" guarantee — and, read the other way, anything the row
 * renders and this omits is a stale pixel nothing will ever repaint.
 *
 * Two axes come from the renderer rather than the row: `rich` (the same
 * conversation is a different element in the working set than in history, so
 * crossing that line rebuilds rather than patches) and `age` — the rendered
 * LABEL, not the raw `updatedAt`, because the label moves as `now` advances
 * while the timestamp sits still, and a raw-ms signature would leave "now" on
 * screen for an hour while also churning on milliseconds nobody can see.
 *
 * Deliberately ABSENT: whether the row's children or its section are currently
 * collapsed. Both are applied as classes after reconciliation, so toggling one
 * never rebuilds the row the user just pressed Enter on.
 */
export function chatRowSig(r: ChatRow, o: { rich: boolean; age: string }): string {
  return [
    o.rich, r.title, r.preview, r.lane ?? "", r.reason ?? "", r.badge ?? "",
    // The two live strings. `activity` moves per tool call and never per token,
    // which is what makes it affordable here at all.
    r.activity ?? "", r.permRule ?? "", r.progress ? `${r.progress.done}/${r.progress.total}` : "",
    r.provider, r.model, r.messageCount, r.open, r.pinned, r.unseen, o.age,
    // A row that gains or loses its parent changes shape, so it has to rebuild
    // rather than be patched in place at the wrong indent. Gaining or losing
    // CHILDREN is the same kind of change — it adds or removes the collapse
    // control.
    r.depth, r.hasChildren,
  ].join("|");
}

/**
 * The same discipline for the needs-you strip, which is rebuilt whole rather
 * than reconciled: a chip is two words, so patching one is not worth a keyed
 * list — but a rebuild on every 5s tick would drop the focus ring off a chip
 * the user is tabbing through, so the strip only rebuilds when this moves.
 *
 * It carries exactly what a chip renders: who is waiting and what for. The
 * title is in there because a blocked chat can be retitled while its prompt is
 * open (the generated-title path does it unprompted), and a chip left on the
 * old name is a chip pointing at a chat the user can no longer find by name.
 */
export function needsStripSig(blocked: readonly Pick<ChatRow, "id" | "title" | "reason">[]): string {
  return blocked.map((r) => `${r.id}:${r.title}:${r.reason ?? ""}`).join("|");
}

/**
 * The one collapse rule, shared by the two things that collapse. Absent means
 * EXPANDED, which is what lets either feature ship without a migration: an
 * install that never toggled anything has an empty list and opens exactly as it
 * did before.
 */
const isCollapsed = (collapsed: readonly string[] | undefined, key: string): boolean =>
  collapsed?.includes(key) === true;

/**
 * Flip one key, returning a NEW list — the caller persists the result, so a
 * mutation in place would make "did anything change" unanswerable and would let
 * a failed save leave the in-memory state ahead of disk.
 *
 * Collapsing appends and expanding FILTERS (rather than removing one match), so
 * a list that somehow accumulated a duplicate is deduped by the next expand
 * instead of needing two clicks. The stored order is the order the user
 * collapsed things in; nothing reads that order, but keeping it stable means a
 * settings file doesn't churn on every unrelated save.
 */
const flipCollapsed = (collapsed: readonly string[] | undefined, key: string): string[] => {
  const current = collapsed ?? [];
  return isCollapsed(current, key) ? current.filter((k) => k !== key) : [...current, key];
};

/**
 * Is this section collapsed?
 *
 * Keyed by `ChatSectionKey` and never by label — a section keyed by its display
 * text loses the user's choice the day "Settled" gets reworded.
 *
 * The list itself lives in `settings.chatsCollapsed`, next to `chatsMode`,
 * because it is the same kind of thing: a small, durable view preference the
 * pane reads on every paint and Obsidian persists in the plugin's own data.json.
 */
export function isSectionCollapsed(
  collapsed: readonly string[] | undefined,
  key: ChatSectionKey,
  searching = false,
): boolean {
  // A search opens every section: Settled starts folded, so its hits would
  // otherwise show only as a count while Related hits sit open above them.
  if (searching) return false;
  // The two shelves start folded, as in T3: put-away chats are a click away,
  // never in the way. The user's choice to OPEN one is what gets stored.
  if (SHELVES.has(key)) return !isCollapsed(collapsed, `expanded:${key}`);
  return isCollapsed(collapsed, key);
}

/** Flip one section. See `flipCollapsed`. */
export function toggleSectionCollapsed(
  collapsed: readonly string[] | undefined,
  key: ChatSectionKey,
): string[] {
  return flipCollapsed(collapsed, SHELVES.has(key) ? `expanded:${key}` : key);
}

/** Sections that are folded until opened (see `isSectionCollapsed`). */
const SHELVES: ReadonlySet<string> = new Set(["snoozed", "settled"]);

/**
 * Has the user folded away the fan-out children of THIS conversation? Same
 * contract as the section pair above, and deliberately a SEPARATE list
 * (`settings.chatsCollapsedParents`): the two are keyed in different
 * namespaces — a section key vs a conversation id — and merging them would let
 * a conversation whose id happened to read `settings` collapse the Settled
 * section, and would make "expand everything" ambiguous.
 *
 * A stale id — a conversation since deleted or archived — is simply never asked
 * about again, so the list needs no pruning pass and no migration.
 */
export function isParentCollapsed(
  collapsed: readonly string[] | undefined,
  convoId: string,
): boolean {
  return isCollapsed(collapsed, convoId);
}

/** Flip one parent's children. See `flipCollapsed`. */
export function toggleParentCollapsed(
  collapsed: readonly string[] | undefined,
  convoId: string,
): string[] {
  return flipCollapsed(collapsed, convoId);
}

/** What per-parent collapse means for one painted list. */
export interface ChildCollapse {
  /** Row ids that must not render: their parent is collapsed. */
  hidden: ReadonlySet<string>;
  /** Per parent id, how many rows are nested under it — the number a collapsed
   *  parent shows, so putting children away can never be the same thing as
   *  forgetting they exist. Present for every parent, collapsed or not. */
  counts: ReadonlyMap<string, number>;
}

/**
 * Resolve per-parent collapse over the painted order.
 *
 * Read POSITIONALLY, not by walking `parentConvoId`, and that is the point: the
 * tree is already flattened to one indent level, so a grandchild's own parent
 * is a depth-1 row while the row it must disappear with is the depth-0 one
 * above them both. The rendered run — a depth-0 row followed by every depth-1
 * row until the next depth-0 row — IS the subtree, by construction in
 * `groupAcrossHomes`, so collapsing that run hides exactly the descendants and
 * nothing of the next parent's.
 *
 * Sections can be concatenated and passed in one call: a child is always
 * emitted into its parent's home, so every section begins at depth 0 and a new
 * section's first row closes the previous section's last run.
 */
export function collapseChildren(
  items: readonly { id: string; depth: 0 | 1 }[],
  collapsed: readonly string[] | undefined,
): ChildCollapse {
  const hidden = new Set<string>();
  const counts = new Map<string, number>();
  let parent: string | null = null;
  for (const row of items) {
    if (row.depth === 0) {
      parent = row.id;
      continue;
    }
    // Unreachable given the invariant above; treated as a root rather than
    // attributed to whatever parent happened to precede it in another section.
    if (parent === null) continue;
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
    if (isCollapsed(collapsed, parent)) hidden.add(row.id);
  }
  return { hidden, counts };
}
