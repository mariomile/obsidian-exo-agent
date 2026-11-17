import { describe, it, expect } from "vitest";
import { PROFILES, PROVIDER_IDS, isProviderId, providerHidden, providerStr } from "../src/providers/profiles";
import { ADAPTERS } from "../src/providers/registry";
import { DEFAULT_SETTINGS } from "../src/settings-schema";
import { catalogsFromCache } from "../src/session-caps-cache";

describe("provider profiles", () => {
  it("every provider has a profile and an adapter with the same id", () => {
    expect(PROVIDER_IDS.length).toBeGreaterThan(1);
    for (const id of PROVIDER_IDS) {
      expect(PROFILES[id].id).toBe(id);
      expect(ADAPTERS[id].id).toBe(id);
    }
    expect(Object.keys(ADAPTERS).sort()).toEqual([...PROVIDER_IDS].sort());
  });

  it("every settings key a profile names exists in DEFAULT_SETTINGS with the right type", () => {
    for (const id of PROVIDER_IDS) {
      const { bin, model, customModels, hiddenModels } = PROFILES[id].keys;
      for (const k of [bin, model, customModels]) expect(typeof DEFAULT_SETTINGS[k]).toBe("string");
      expect(Array.isArray(DEFAULT_SETTINGS[hiddenModels])).toBe(true);
    }
  });

  it("reads a provider's own settings", () => {
    const s = { ...DEFAULT_SETTINGS, claudeBin: "/c", codexBin: "/x", codexHiddenModels: ["gpt-5.5"] };
    expect(providerStr(s, "claude", "bin")).toBe("/c");
    expect(providerStr(s, "codex", "bin")).toBe("/x");
    expect(providerHidden(s, "codex")).toEqual(["gpt-5.5"]);
    expect(providerHidden(s, "claude")).toEqual([]);
  });

  it("recognises only known provider ids", () => {
    expect(isProviderId("claude")).toBe(true);
    expect(isProviderId("codex")).toBe(true);
    expect(isProviderId("gpt")).toBe(false);
    expect(isProviderId("toString")).toBe(false);
    expect(isProviderId(undefined)).toBe(false);
  });

  it("offers Claude's auto mode only where it exists", () => {
    expect(PROFILES.claude.permModes).toContain("auto");
    expect(PROFILES.opencode.permModes).not.toContain("auto");
    expect(PROFILES.opencode.permModes).toEqual(["default", "acceptEdits", "plan", "bypassPermissions"]);
  });

  it("keeps Codex's sandbox settings in its own respawn signature only", () => {
    const s = { ...DEFAULT_SETTINGS };
    expect(PROFILES.claude.signatureExtras(s)).toEqual([]);
    expect(PROFILES.codex.signatureExtras(s)).toEqual([s.codexSandbox, s.codexApproval]);
  });
});

describe("catalogsFromCache", () => {
  it("reads per-provider catalogs", () => {
    const models = [{ id: "m", label: "M" }];
    expect(catalogsFromCache({ catalogs: { codex: models } })).toEqual({ codex: models });
  });

  it("attributes a legacy snapshot's models to Codex, the only provider that filled them", () => {
    const models = [{ id: "gpt-6-astra", label: "GPT-6 Astra" }];
    expect(catalogsFromCache({ skills: [], models })).toEqual({ codex: models });
  });

  it("returns nothing for an empty or missing cache", () => {
    expect(catalogsFromCache(null)).toEqual({});
    expect(catalogsFromCache({ skills: [] })).toEqual({});
  });
});
