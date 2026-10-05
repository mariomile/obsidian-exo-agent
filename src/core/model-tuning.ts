/**
 * Model → tuning-capability map: which effort tiers each model supports.
 * The composer's Effort control derives from the chosen model (it hides for
 * models with no effort support, and offers only that model's tiers).
 *
 * Source of truth: the Claude Platform reference and live Codex app-server
 * `model/list` on codex-cli 0.156.1 (checked 2026-09-23):
 * - `xhigh` exists on Opus 4.7+, Opus 4.8, Fable 5.x, Sonnet 5.
 * - `max` exists on Opus 4.6 and later, Sonnet 4.6 and later.
 * - Haiku 4.5 (and earlier Sonnets) reject `effort` outright.
 * - Codex GPT-6 Astra/Sol and GPT-5.6 Sol/Terra accept low..ultra;
 *   GPT-6/5.6 Luna accept low..max;
 *   GPT-5.5/5.4 and unknown Codex ids stay low..xhigh (Codex rejects
 *   unsupported tiers outright, so unknowns get the conservative set).
 * Unknown/custom Claude ids get the full ladder: a wrong tier degrades to a
 * CLI warning, while hiding the control would block valid new models.
 */
export type EffortOption = [value: string, label: string];

const LADDER: EffortOption[] = [
  ["default", "Default"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra high"],
  ["max", "Max"],
  ["ultra", "Ultra"],
];

const pick = (...values: string[]): EffortOption[] =>
  LADDER.filter(([v]) => v === "default" || values.includes(v));

/** Effort tiers for a model, or `null` when the model has no effort support
 *  (the caller hides the control). */
export function effortOptionsFor(
  provider: "claude" | "codex",
  modelId: string
): EffortOption[] | null {
  const id = (modelId || "").toLowerCase();
  if (provider === "codex") {
    if (id.includes("gpt-6-luna") || id.includes("gpt-5.6-luna")) return pick("low", "medium", "high", "xhigh", "max");
    if (id.includes("gpt-6-astra") || id.includes("gpt-6-sol") || id.includes("gpt-5.6")) {
      return pick("low", "medium", "high", "xhigh", "max", "ultra");
    }
    return pick("low", "medium", "high", "xhigh");
  }
  if (id.includes("haiku")) return null;
  if (id.includes("opus-4-6") || id.includes("sonnet-4-6")) return pick("low", "medium", "high", "max");
  return pick("low", "medium", "high", "xhigh", "max");
}

/** Keep the current effort only when the model offers it; otherwise fall back
 *  to "default" (the CLI's own choice) so an invalid tier never reaches the
 *  provider (Codex rejects unsupported `model_reasoning_effort` tiers, Claude
 *  warns). */
export function clampEffort(effort: string, options: EffortOption[] | null): string {
  if (!options) return "default";
  return options.some(([v]) => v === effort) ? effort : "default";
}

/** The effort a session for this model actually runs with. The stored setting
 *  is never rewritten, so a tier the user chose survives a detour through a
 *  model that doesn't offer it (e.g. Haiku) and applies again on the way back. */
export function effortFor(provider: "claude" | "codex", modelId: string, effort: string): string {
  return clampEffort(effort || "default", effortOptionsFor(provider, modelId));
}
