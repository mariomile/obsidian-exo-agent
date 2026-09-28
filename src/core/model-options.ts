/**
 * Pure helpers for the per-provider model pickers. UI-free so the option-list
 * logic (built-ins + user custom ids, deduped) can be unit-tested without
 * importing `obsidian`. Shared by the settings default-model dropdowns and the
 * in-chat model picker.
 */
import type { ModelOption } from "../providers/types";

/** Options for the "Background AI model" dropdown — Sonnet-class only. Product
 *  constraint: the floor for background passes is Sonnet — never offer (or
 *  default to) a Haiku model here, even though Haiku is available as the
 *  observer's own hardcoded fast-path model elsewhere. Keep in sync with the
 *  pinned ids in `providers/claude.ts`. */
export const BACKGROUND_MODEL_OPTIONS: ReadonlyArray<ModelOption> = [
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
];

/** Split the comma/newline-separated custom-models textarea into trimmed ids. */
export function parseCustomModels(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * The full option list for one provider's default-model dropdown: the built-in
 * models first, then any custom ids from settings, deduped by id in insertion
 * order (built-ins win a label collision). Custom ids use the id as their label.
 */
export function modelOptions(builtins: ModelOption[], customRaw: string): ModelOption[] {
  const out: ModelOption[] = [];
  const seen = new Set<string>();
  for (const m of builtins) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({ id: m.id, label: m.label });
  }
  for (const id of parseCustomModels(customRaw)) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: id });
  }
  return out;
}
