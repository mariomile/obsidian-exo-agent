/**
 * Remember an async result for `ttlMs` (pure). Callers inside the window, and
 * callers that arrive while the call is still running, share one result. A
 * rejection is never remembered: the next caller tries again.
 */
export function memoTtl<T>(fn: () => Promise<T>, ttlMs: number, now: () => number = Date.now): () => Promise<T> {
  let hit: { at: number; value: Promise<T> } | null = null;
  return () => {
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = fn();
    const mine = { at: now(), value };
    hit = mine;
    value.catch(() => {
      if (hit === mine) hit = null;
    });
    return value;
  };
}
