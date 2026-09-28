import { describe, expect, test } from "vitest";
import { clampEffort, effortOptionsFor } from "../src/core/model-tuning";

/** Effort tiers are a consequence of the chosen model (per the claude-api
 *  reference and Codex app-server `model/list`, checked 2026-09-23):
 *  xhigh exists on Opus 4.7+/Fable 5.x/Sonnet 5; max on Opus 4.6+/Sonnet 4.6+;
 *  Haiku 4.5 rejects effort entirely; Codex GPT-6 Astra/Sol and GPT-5.6 Sol/Terra
 *  go up to "ultra", GPT-6/5.6 Luna up to "max", older/unknown ids stop at "xhigh". */
describe("effortOptionsFor", () => {
  const values = (provider: string, model: string) =>
    effortOptionsFor(provider as "claude" | "codex", model)?.map(([v]) => v) ?? null;

  test("frontier Claude models get the full ladder", () => {
    for (const m of ["claude-fable-5-1", "claude-fable-5", "claude-opus-5-5", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5-5", "claude-sonnet-5"]) {
      expect(values("claude", m)).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);
    }
  });

  test("Opus 4.6 and Sonnet 4.6 lack xhigh but keep max", () => {
    expect(values("claude", "claude-opus-4-6")).toEqual(["default", "low", "medium", "high", "max"]);
    expect(values("claude", "claude-sonnet-4-6")).toEqual(["default", "low", "medium", "high", "max"]);
  });

  test("Haiku does not support effort — control hidden", () => {
    expect(values("claude", "claude-haiku-4-5")).toBeNull();
    expect(values("claude", "claude-haiku-4-5-20251001")).toBeNull();
  });

  test("unknown/custom Claude ids and the CLI default get the full ladder", () => {
    expect(values("claude", "claude-nova-6")).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);
    expect(values("claude", "")).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);
    expect(values("claude", "default")).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);
  });

  test("Codex GPT-6 Astra/Sol and GPT-5.6 Sol/Terra get max and ultra", () => {
    for (const m of ["gpt-6-astra", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra"]) {
      expect(values("codex", m)).toEqual(["default", "low", "medium", "high", "xhigh", "max", "ultra"]);
    }
  });

  test("Codex GPT-6/5.6 Luna stop at max", () => {
    for (const m of ["gpt-6-luna", "gpt-5.6-luna"]) {
      expect(values("codex", m)).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);
    }
  });

  test("older and unknown Codex ids stop at xhigh", () => {
    expect(values("codex", "gpt-5.5")).toEqual(["default", "low", "medium", "high", "xhigh"]);
    expect(values("codex", "gpt-5.4-mini")).toEqual(["default", "low", "medium", "high", "xhigh"]);
    expect(values("codex", "some-custom-model")).toEqual(["default", "low", "medium", "high", "xhigh"]);
  });
});

describe("clampEffort", () => {
  test("keeps a valid effort", () => {
    expect(clampEffort("high", effortOptionsFor("claude", "claude-opus-4-8"))).toBe("high");
  });

  test("falls back to default when the tier is not offered by the model", () => {
    expect(clampEffort("max", effortOptionsFor("codex", "gpt-5.5"))).toBe("default");
    expect(clampEffort("xhigh", effortOptionsFor("claude", "claude-sonnet-4-6"))).toBe("default");
  });

  test("falls back to default when the control is hidden", () => {
    expect(clampEffort("high", effortOptionsFor("claude", "claude-haiku-4-5"))).toBe("default");
  });
});
