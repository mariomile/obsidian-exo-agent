import type { MVASettings } from "./settings";
import type { ModelOption, ProviderId, SessionCaps } from "./providers/types";

/**
 * Last session capability snapshot (skills/commands/agents/tools/mcpServers),
 * own file — NOT settings. It used to be mixed into data.json's
 * `cachedSessionCaps` (69% of the file's bytes, ~46KB of 66KB measured
 * 2026-08-06) even though it is pure cache: rebuilt from a live SDK session
 * every init, never authored, and every default-value migration in
 * settings.ts had to reason about a blob unrelated to any actual setting (the
 * exact shape of the recurring "flip a default, data.json doesn't migrate,
 * check live data" gotcha).
 *
 * Persisted anyway (not held only in memory) because it has real UX value: it
 * seeds the $/@// menus and the Capabilities panel immediately after an
 * Obsidian restart, before the first session's init arrives. Slightly stale
 * is fine here (menu seeding, not authorization), so the contract is
 * minimal: simple write, no backup rotation, corrupt/missing collapses to null
 * instead of failing.
 *
 * Adapter is a narrow subset of Obsidian's `DataAdapter`, not the type
 * itself — same convention as `WorkflowSignalStoreAdapter` — so this stays
 * decoupled from the exact Obsidian version's surface.
 */
export interface SessionCapsCacheAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
}

// `pluginDir` mirrors `PluginManifest.dir`'s own type (`string | undefined`) —
// same as main.ts's sibling `convoFile()`, which interpolates it
// unchecked. In practice Obsidian always sets it for an installed plugin; kept
// honest here rather than asserted, since the compiler now actually checks it.
export function sessionCapsCacheFile(pluginDir: string | undefined): string {
  return `${pluginDir}/session-caps-cache.json`;
}

/** Runtime model catalogs, per provider. Kept apart from the last snapshot:
 *  that one belongs to whichever provider spawned last, and a Claude spawn
 *  must not wipe the Codex catalog. */
export type ModelCatalogs = Partial<Record<ProviderId, ModelOption[]>>;

/** The catalogs stored beside a cached snapshot. A cache written before they
 *  had their own field carries only `models`, which only Codex ever filled. */
export function catalogsFromCache(raw: unknown): ModelCatalogs {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as { catalogs?: unknown; models?: unknown };
  if (r.catalogs && typeof r.catalogs === "object") return r.catalogs;
  return Array.isArray(r.models) && r.models.length ? { codex: r.models } : {};
}

export async function writeSessionCapsCache(
  adapter: SessionCapsCacheAdapter,
  pluginDir: string | undefined,
  caps: SessionCaps,
  catalogs: ModelCatalogs = {},
): Promise<boolean> {
  try {
    await adapter.write(sessionCapsCacheFile(pluginDir), JSON.stringify({ ...caps, catalogs }));
    return true;
  } catch {
    return false;
  }
}

export async function readSessionCapsCache(
  adapter: SessionCapsCacheAdapter,
  pluginDir: string | undefined,
): Promise<SessionCaps | null> {
  try {
    const p = sessionCapsCacheFile(pluginDir);
    if (await adapter.exists(p)) return JSON.parse(await adapter.read(p)) as SessionCaps;
  } catch {
    /* corrupt/missing — same as a session that hasn't reported caps yet */
  }
  return null;
}

export async function removeSessionCapsCache(
  adapter: SessionCapsCacheAdapter,
  pluginDir: string | undefined,
): Promise<void> {
  try {
    const p = sessionCapsCacheFile(pluginDir);
    if (await adapter.exists(p)) await adapter.remove(p);
  } catch {
    /* ignore */
  }
}

/**
 * One-shot cleanup for installs that saved data.json before this migration:
 * `cachedSessionCaps` isn't in DEFAULT_SETTINGS anymore, so the
 * `Object.assign({}, DEFAULT_SETTINGS, await loadData())` in loadSettings()
 * can't strip it — every future saveSettings() would keep re-serializing the
 * orphaned ~46KB key forever otherwise. Returns whether it removed anything,
 * so the caller only pays for a save when there was something to clean.
 */
export function stripLegacyCachedSessionCaps(settings: MVASettings): boolean {
  // Not on MVASettings anymore — that's exactly the point. Cast is the honest
  // way to reach a key the type no longer declares but a loaded data.json
  // still might carry.
  const raw = settings as unknown as Record<string, unknown>;
  if (!("cachedSessionCaps" in raw)) return false;
  delete raw.cachedSessionCaps;
  return true;
}
