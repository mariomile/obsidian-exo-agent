/**
 * Persistence trim planner — extracted verbatim from `view.ts`'s `serialize()`,
 * and since retired: see the `@deprecated` note on `planPersistedConvos`.
 *
 * The historical behaviour it pins: eviction is recency-based, not
 * array/creation order. A conversation with an OLD position but a recent
 * `updatedAt` must survive while a newer-but-empty husk is dropped. Pinned
 * conversations (active + open tabs) are always kept, even with 0 messages, so
 * their tabs don't vanish on reload. Output preserves ORIGINAL array order
 * because `restore()` falls back to the LAST element as active.
 */
/**
 * Decide which on-disk source a load should trust, given the raw text of the
 * main conversations file and its `.bak` rotation (either may be `null` when the
 * file is missing). Pure so the crash-recovery policy can be unit-tested without
 * an Obsidian `DataAdapter`.
 *
 * Rules:
 *  - Valid array in `main` → use it (`source: "main"`, not corrupt).
 *  - `main` missing → fall through to `.bak` (a missing main is NOT corruption).
 *  - `main` present but unparseable / not an array → `mainCorrupt: true`, fall
 *    through to `.bak`. The caller preserves the corrupt file aside and warns.
 *  - Neither yields an array → empty history (`source: "empty"`).
 */
export function parseConversationsSource(
  mainRaw: string | null,
  bakRaw: string | null
): { data: unknown[]; source: "main" | "bak" | "empty"; mainCorrupt: boolean } {
  const main = tryParseArray(mainRaw);
  if (main) return { data: main, source: "main", mainCorrupt: false };
  // A missing main is not corruption; a present-but-unusable main is.
  const mainCorrupt = mainRaw != null;
  const bak = tryParseArray(bakRaw);
  if (bak) return { data: bak, source: "bak", mainCorrupt };
  return { data: [], source: "empty", mainCorrupt };
}

/** Parse `raw` and return it only if it's a JSON array; otherwise `null`
 *  (covers missing input, truncated/invalid JSON, and valid-but-non-array). */
function tryParseArray(raw: string | null): unknown[] | null {
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @deprecated Superseded by `planRetention` (src/core/retention.ts), which never
 * deletes: it returns the full set plus advisory cleanup candidates. Kept only
 * so the historical eviction contract stays under test — no production caller.
 */
export function planPersistedConvos<
  T extends { id: string; messages: unknown[]; updatedAt?: number },
>(all: T[], activeId: string, openTabIds: string[], max: number): T[] {
  // A conversation must survive restore if it's active or an open (possibly empty)
  // placeholder tab — otherwise those tabs vanish on reload.
  const pinned = new Set<string>([activeId, ...openTabIds]);
  // Drop empty "New chat" husks that aren't pinned so they don't waste slots.
  const filtered = all.filter((c) => c.messages.length > 0 || pinned.has(c.id));
  // Evict by recency (not array/creation order): always keep pinned, then fill the
  // remaining slots by updatedAt desc. Emit in ORIGINAL array order (restore() falls
  // back to the LAST element as active, so stable order matters).
  if (filtered.length <= max) return filtered;
  const keptIds = new Set<string>(filtered.filter((c) => pinned.has(c.id)).map((c) => c.id));
  const rest = filtered
    .filter((c) => !pinned.has(c.id))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  for (const c of rest) {
    if (keptIds.size >= max) break;
    keptIds.add(c.id);
  }
  return filtered.filter((c) => keptIds.has(c.id));
}

/**
 * Split conversations into the live set (persisted to `conversations.json`, the
 * set the retention planner measures) and the archived set (persisted to the
 * separate, unmeasured archive store). "Measures" is the whole relationship:
 * the budget is advisory, so being on the live side never means being trimmed —
 * an over-budget live set produces cleanup candidates the user confirms, and
 * `planRetention` never shrinks `keep`. Keeping this pure lets the
 * partition — the round-trip contract's foundation — be unit-tested without the
 * Obsidian view. Original order is preserved within each side.
 */
export function partitionConvos<T extends { archived?: boolean }>(
  all: T[],
): { live: T[]; archived: T[] } {
  const live: T[] = [];
  const archived: T[] = [];
  for (const c of all) (c.archived ? archived : live).push(c);
  return { live, archived };
}

/**
 * Cheap identity of the archive payload, so a persist rewrites the archive
 * store only when it changed. Archived chats are frozen (a resumed turn
 * un-archives), so every top-level field plus the message COUNT catches every
 * change without serializing the transcripts on each turn.
 */
export function archiveSignature(convos: readonly object[]): string {
  return JSON.stringify(
    convos.map((c) => {
      const msgs = (c as { messages?: unknown }).messages;
      return { ...c, messages: Array.isArray(msgs) ? msgs.length : 0 };
    }),
  );
}
