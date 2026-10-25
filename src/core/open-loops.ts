/**
 * Open-Loops Ledger, pure logic (no Obsidian imports).
 *
 * A "loop" is a durable open thread the user asked to be reminded about later:
 * a follow-up, a promise, a thing to circle back on. Unlike the Memory Union
 * Store (verbatim facts/preferences/decisions), a loop has a lifecycle: it
 * opens, optionally carries a tickler ("resurface") date, and closes with an
 * append-only outcome note. Closing NEVER deletes the entry, the ledger is
 * append-only in spirit.
 *
 * On-disk shape, a single markdown file (the `paths.openLoops` ledger),
 * one block per entry:
 *
 *   ## loop-<epochMs>
 *   - title: <title>
 *   - opened: <ISO-8601>
 *   - resurface: <YYYY-MM-DD>   (tickler date; line omitted when open-ended)
 *   - status: open|closed
 *   - closed: <ISO-8601>        (line omitted while open)
 *   - tags: tag1, tag2          (line omitted when no tags)
 *
 *   <verbatim note, may be multi-line markdown; outcome text is appended here
 *    on close, the opening context is never overwritten>
 *
 * `parseLoopsFile` tolerates arbitrary junk between blocks (a human may
 * hand-edit the file) and never throws, garbage lines are skipped, not
 * fatal. `formatLoop` ∘ `parseLoopsFile` round-trips for entries whose note
 * carries no leading/trailing blank lines (internal newlines are preserved).
 */

export type LoopStatus = "open" | "closed";

export interface LoopEntry {
  /** Stable id: `loop-<epochMs>` when generated, `loop-<slug>` when hand-written. */
  id: string;
  title: string;
  /** The opening context, stored verbatim. Outcome text is appended (never overwritten) on close. */
  note: string;
  /** Creation time, epoch milliseconds. */
  openedAt: number;
  /**
   * How the source wrote `opened:` when it is not the canonical ISO form of `openedAt`
   * (a hand-written `2026-09-08`, free text). `formatLoop` writes it back verbatim.
   * `null` = the source had no `opened:` line, so none is written. Absent = the loop
   * was created by code and gets an ISO line.
   */
  openedRaw?: string | null;
  /** Unknown `- key: value` metadata lines, kept verbatim so a rewrite never drops them. */
  extraMeta?: string[];
  /** Tickler date the loop should resurface on, `YYYY-MM-DD` (local date). Omitted = due immediately. */
  resurface?: string;
  status: LoopStatus;
  /** Close time, epoch milliseconds (omitted while open). */
  closedAt?: number;
  tags?: string[];
}

/** Block header, e.g. `## loop-1720000000000` or a hand-written slug `## loop-2026-10-03-turno-init`. No `g` flag: safe for `.test`. */
const HEADER = /^##\s+(loop-[\w-]+)\s*$/;
/** A metadata line inside a block, e.g. `- title: Follow up with Marco`. */
const META = /^-\s+([\w-]+):\s*(.*)$/;

/** Render one entry to its canonical on-disk block (no trailing newline). */
export function formatLoop(e: LoopEntry): string {
  const lines = [`## ${e.id}`, `- title: ${e.title}`];
  if (e.openedRaw !== null) {
    lines.push(`- opened: ${e.openedRaw ?? new Date(e.openedAt).toISOString()}`);
  }
  lines.push(`- status: ${e.status}`);
  if (e.resurface) lines.push(`- resurface: ${e.resurface}`);
  if (e.closedAt !== undefined) lines.push(`- closed: ${new Date(e.closedAt).toISOString()}`);
  if (e.tags && e.tags.length) lines.push(`- tags: ${e.tags.join(", ")}`);
  if (e.extraMeta) lines.push(...e.extraMeta);
  lines.push("", e.note);
  return lines.join("\n");
}

/** Parse a whole ledger file into entries. Junk between/around blocks is ignored, never thrown on. */
export function parseLoopsFile(content: string): LoopEntry[] {
  const lines = content.split(/\r?\n/);
  const entries: LoopEntry[] = [];
  let i = 0;
  while (i < lines.length) {
    const head = HEADER.exec(lines[i]);
    if (!head) {
      i++;
      continue;
    }
    const id = head[1];
    i++;

    let title = "";
    let openedAt = NaN;
    let openedRaw: string | undefined;
    const extraMeta: string[] = [];
    let resurface: string | undefined;
    let status: LoopStatus = "open";
    let closedAt: number | undefined;
    let tags: string[] = [];

    for (let m: RegExpExecArray | null; i < lines.length && (m = META.exec(lines[i])); i++) {
      const key = m[1];
      const val = m[2].trim();
      if (key === "title") title = val;
      else if (key === "opened") {
        openedAt = Date.parse(val);
        openedRaw = val;
      }
      else if (key === "resurface") resurface = val || undefined;
      // Any value other than the literal "closed" is tolerated as "open", hand-edited
      // junk in this field must never break the rest of the parse.
      else if (key === "status") status = val === "closed" ? "closed" : "open";
      else if (key === "closed") {
        const t = Date.parse(val);
        if (Number.isFinite(t)) closedAt = t;
      } else if (key === "tags") tags = val.split(",").map((t) => t.trim()).filter(Boolean);
      else extraMeta.push(lines[i]);
    }

    // Optional single blank line separating metadata from the verbatim note.
    if (i < lines.length && lines[i].trim() === "") i++;

    const textLines: string[] = [];
    while (i < lines.length && !HEADER.test(lines[i])) textLines.push(lines[i++]);
    const note = textLines.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");

    // Fall back to the date or epoch embedded in the id when `opened:` is missing/garbage.
    if (!Number.isFinite(openedAt)) {
      const idm = /^loop-(\d+)$/.exec(id);
      const dm = /^loop-(\d{4}-\d{2}-\d{2})(?:-|$)/.exec(id);
      openedAt = idm ? Number(idm[1]) : dm ? Date.parse(dm[1]) : 0;
      if (!Number.isFinite(openedAt)) openedAt = 0;
    }
    // Only keep the raw text when writing the ISO form would change it.
    const keepRaw =
      openedRaw === undefined
        ? null
        : new Date(openedAt).toISOString() === openedRaw
          ? undefined
          : openedRaw;

    entries.push({
      id,
      title,
      note,
      openedAt,
      ...(keepRaw !== undefined ? { openedRaw: keepRaw } : {}),
      status,
      ...(extraMeta.length ? { extraMeta } : {}),
      ...(resurface ? { resurface } : {}),
      ...(closedAt !== undefined ? { closedAt } : {}),
      ...(tags.length ? { tags } : {}),
    });
  }
  return entries;
}

/** Local calendar date (`YYYY-MM-DD`) for a timestamp, NOT UTC. Mirrors the `today()`
 *  convention used across the codebase (e.g. `src/obsidian/tools.ts`): toISOString()
 *  would roll to tomorrow late at night in a positive-offset timezone. */
function localDateString(at: number | Date): string {
  const d = at instanceof Date ? at : new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** All open (not-yet-closed) loops, in ledger order. */
export function activeLoops(entries: LoopEntry[]): LoopEntry[] {
  return entries.filter((e) => e.status === "open");
}

/**
 * Open loops that are due to resurface: no `resurface` date (due immediately),
 * or a `resurface` date on/before `now`'s local calendar day. Comparison is by
 * local date string (`YYYY-MM-DD`, lexicographic == chronological), so it is
 * timezone-safe and time-of-day-independent, only the calendar day matters.
 */
export function dueLoops(entries: LoopEntry[], now: number | Date = Date.now()): LoopEntry[] {
  const today = localDateString(now);
  return activeLoops(entries).filter((e) => !e.resurface || e.resurface <= today);
}

/**
 * Close a loop: flips status to `closed`, sets `closedAt`, and, if `outcome`
 * is given, appends it to the note. The opening note is NEVER overwritten or
 * removed, only appended to (append-only spirit, mirrors `memory-store.ts`).
 * Every other entry in `entries` is returned unchanged. Throws if `id` isn't
 * present, since a close that silently no-ops would look like success but
 * lose the caller's outcome text.
 */
export function closeLoop(
  entries: LoopEntry[],
  id: string,
  outcome?: string,
  now: number | Date = Date.now()
): LoopEntry[] {
  const at = now instanceof Date ? now.getTime() : now;
  let found = false;
  const next = entries.map((e) => {
    if (e.id !== id) return e;
    found = true;
    const closed: LoopEntry = {
      ...e,
      status: "closed",
      closedAt: at,
      note: outcome ? `${e.note}\n\n---\noutcome: ${outcome}` : e.note,
    };
    return closed;
  });
  if (!found) throw new Error(`Loop not found: ${id}`);
  return next;
}
