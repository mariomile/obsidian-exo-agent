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

/**
 * `parseConversationsSource` with lazy reads: the `.bak` is read only when the
 * main file is missing or unusable, because a valid main wins regardless of
 * what the backup holds. Same result as reading both up front, minus a full
 * read and decode of the backup on every healthy load.
 */
export async function readConversationsSource(
  readMain: () => Promise<string | null>,
  readBak: () => Promise<string | null>
): Promise<ReturnType<typeof parseConversationsSource>> {
  const mainRaw = await readMain();
  const main = tryParseArray(mainRaw);
  if (main) return { data: main, source: "main", mainCorrupt: false };
  return parseConversationsSource(mainRaw, await readBak());
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

/**
 * `archiveSignature` of a load, or `""` when the load must not be trusted as the
 * file's content: a `.bak` recovery or an empty load must still be written out
 * as before, and a non-object entry would throw inside `archiveSignature`. `""`
 * never matches a real signature.
 */
export function restoredArchiveSignature(load: {
  data: readonly unknown[];
  source: "main" | "bak" | "empty";
}): string {
  if (load.source !== "main") return "";
  if (!load.data.every((c) => c !== null && typeof c === "object")) return "";
  return archiveSignature(load.data);
}

/** The `DataAdapter.stat` fields that change when a file is rewritten. */
export interface FileStamp {
  ctime: number;
  mtime: number;
  size: number;
}

/**
 * Lets the first archive save of a session skip rewriting (and rotating the
 * `.bak` of) an archive that already holds that payload. A load records the
 * archive signature plus the file stamp taken BEFORE the read. The next save
 * skips only if its payload has the same signature AND, checked inside the write
 * queue right before writing, the file still has that stamp. A write that lands
 * after the read (a closing view's last flush, another plugin instance) changes
 * the stamp, so that save writes exactly as before. One-shot: every later save
 * writes as it always did.
 */
export class ArchiveRewriteGuard {
  private loaded: { sig: string; stamp: string } | null = null;

  /** Record a load; `stampBeforeRead` must be taken before the read. Returns `load.data`. */
  noteLoad(
    stampBeforeRead: FileStamp | null,
    load: { data: unknown[]; source: "main" | "bak" | "empty" },
  ): unknown[] {
    const sig = restoredArchiveSignature(load);
    this.loaded = stampBeforeRead && sig ? { sig, stamp: stampKey(stampBeforeRead) } : null;
    return load.data;
  }

  /**
   * Consume the record for a save of `data`. Returns the check to run inside the
   * write queue right before writing, given a stat of the file about to be
   * written (resolves true when the file still holds this payload, so the write
   * is skipped), or `undefined` when the save writes.
   */
  takeSkipCheck(data: unknown[]): ((statNow: () => Promise<FileStamp | null>) => Promise<boolean>) | undefined {
    const loaded = this.loaded;
    this.loaded = null;
    if (!loaded || restoredArchiveSignature({ data, source: "main" }) !== loaded.sig) return undefined;
    return async (statNow) => {
      try {
        const now = await statNow();
        return now !== null && stampKey(now) === loaded.stamp;
      } catch {
        return false; // can't tell: write, as before
      }
    };
  }
}

function stampKey(s: FileStamp): string {
  return `${s.ctime}:${s.mtime}:${s.size}`;
}
