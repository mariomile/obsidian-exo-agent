/**
 * Pure helpers for the per-provider model pickers. UI-free so the option-list
 * logic (built-ins + user custom ids, deduped) can be unit-tested without
 * importing `obsidian`. Shared by the settings default-model dropdowns and the
 * in-chat model picker.
 */
import type { ModelOption, ProviderId } from "../providers/types";

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

/** One provider's full model list, as every picker sees it: the live catalog
 *  the CLI reported (Codex `model/list`) when there is one, else the pinned
 *  built-ins, then the user's custom ids. */
export function providerModels(
  builtins: ModelOption[],
  runtime: ModelOption[] | undefined,
  customRaw: string
): ModelOption[] {
  return modelOptions(runtime?.length ? runtime : builtins, customRaw);
}

export interface ComposerModelChoice extends ModelOption {
  provider: ProviderId;
}

/**
 * Options for the composer's unified model picker: each provider's list minus
 * the ids hidden in settings. The active chat's model is always kept (and
 * appended when it is in no list, e.g. a custom id since removed), so hiding
 * it never leaves the picker without its current value. The picker resolves a
 * pick by id alone, so an id listed under both providers appears once, under
 * the active provider when it is the current model, else under the first.
 */
export function composerModelChoices(
  lists: ReadonlyArray<{ provider: ProviderId; options: ModelOption[]; hidden: readonly string[] }>,
  current: { provider: ProviderId; model: string }
): ComposerModelChoice[] {
  const out: ComposerModelChoice[] = [];
  const seen = new Set<string>();
  const add = (m: ModelOption, provider: ProviderId) => {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    out.push({ id: m.id, label: m.label, provider });
  };
  // The current model claims its id first, so a twin under the other provider
  // can't shadow it.
  if (current.model) seen.add(current.model);
  for (const { provider, options, hidden } of lists) {
    const hide = new Set(hidden);
    for (const m of options) {
      if (provider === current.provider && m.id === current.model) {
        out.push({ id: m.id, label: m.label, provider });
      } else if (!hide.has(m.id)) add(m, provider);
    }
    if (provider === current.provider && current.model && !options.some((m) => m.id === current.model)) {
      out.push({ id: current.model, label: current.model, provider });
    }
  }
  return out;
}
