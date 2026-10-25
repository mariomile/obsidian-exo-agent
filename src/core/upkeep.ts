/**
 * Knowledge upkeep: the once-a-day sweep that repairs supersede markers across
 * the vault. It plans only the structural `MarkerFix`es `buildSupersedeIndex`
 * derives (frontmatter keys, never meaning); broken links are listed, never
 * fixed, because their target is unknowable. No Obsidian import.
 */
import { correctionCandidate, fingerprintProposal } from "./proposals";
import type { BrokenLink, MarkerFix, buildSupersedeIndex } from "./supersede";

export interface UpkeepPlan {
  fixes: MarkerFix[];
  broken: BrokenLink[];
}

/** The fingerprint the proposal store gives this fix once it is a correction
 *  (`before` and the reason are not part of it). */
export function fixFingerprint(fix: MarkerFix): string {
  const set = Object.fromEntries(Object.entries(fix.set).filter((e): e is [string, string] => e[1] !== undefined));
  return fingerprintProposal(correctionCandidate(fix.path, { type: "frontmatter", set, before: {} }, fix.because).payload);
}

/** Every fix not already closed (accepted or turned down); broken links as found. */
export function planUpkeep(found: ReturnType<typeof buildSupersedeIndex>, closed: ReadonlySet<string>): UpkeepPlan {
  return { fixes: found.fixes.filter((f) => !closed.has(fixFingerprint(f))), broken: found.broken };
}

/** True when the last run was not on the same local calendar day as `now`. */
export function dueToday(lastRun: number | null, now: number): boolean {
  if (!lastRun) return true;
  const a = new Date(lastRun);
  const b = new Date(now);
  return a.getFullYear() !== b.getFullYear() || a.getMonth() !== b.getMonth() || a.getDate() !== b.getDate();
}
