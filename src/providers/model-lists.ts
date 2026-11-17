/**
 * Each provider's model list as every picker sees it — the composer, the
 * settings dropdowns and the hidden-models list — so they can't drift apart.
 */
import type { ModelOption, ProviderId } from "./types";
import type { MVASettings } from "../settings-schema";
import type { ModelCatalogs } from "../session-caps-cache";
import { ADAPTERS } from "./registry";
import { providerModels } from "../core/model-options";
import { providerStr } from "./profiles";

/** Live catalog when the CLI reported one, else the pinned built-ins, then
 *  the user's custom ids. */
export function providerModelList(s: MVASettings, id: ProviderId, catalogs: ModelCatalogs): ModelOption[] {
  return providerModels(ADAPTERS[id].models(), catalogs[id], providerStr(s, id, "customModels"));
}

/** A model to repair an empty stored id with: the first built-in, else the
 *  first catalog entry, else "" (the CLI's own default). */
export function fallbackModel(id: ProviderId, catalogs: ModelCatalogs): string {
  return ADAPTERS[id].models()[0]?.id ?? catalogs[id]?.[0]?.id ?? "";
}
