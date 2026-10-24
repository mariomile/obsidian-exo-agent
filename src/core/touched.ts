/**
 * Touched-notes merge — extracted verbatim from `view.ts`. The `TouchedNote`
 * type lives in `ui/graph-view`; re-exported here so `core/` stays a
 * self-contained import surface without duplicating the declaration.
 */
import type { TouchedNote } from "../ui/graph-view";

export type { TouchedNote };

/** Tool names that mutate a note — classifies a touched file as read vs write.
 *  Single source of truth shared by `view.ts` (per-turn footer) and
 *  `core/recap.ts` (conversation rollup). */
export const WRITE_TOOLS =
  /Write|Edit|MultiEdit|NotebookEdit|save_to_note|update_frontmatter|create_note|add_links|edit_note|insert_at_cursor|rename_note/;

/** Merge one tool-touched file into a touched list: reads dedupe; a write
 * upgrades a read entry and bumps the per-note edit count. */
export function mergeTouched(list: TouchedNote[], path: string, kind: "read" | "write"): void {
  const existing = list.find((t) => t.path === path);
  if (!existing) list.push({ path, kind, ...(kind === "write" ? { count: 1 } : {}) });
  else if (kind === "write") {
    existing.kind = "write"; // read-then-written → show as written
    existing.count = (existing.count ?? 0) + 1;
  }
}
