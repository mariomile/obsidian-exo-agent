import { describe, it, expect } from "vitest";
import { parseCustomModels, modelOptions, providerModels, composerModelChoices } from "../src/core/model-options";
import type { ModelOption } from "../src/providers/types";

const BUILTINS: ModelOption[] = [
  { id: "claude-fable-5-1", label: "Fable 5.1" },
  { id: "claude-fable-5", label: "Fable 5" },
  { id: "claude-opus-4-8", label: "Opus 4.8" },
];

describe("parseCustomModels", () => {
  it("splits on commas and newlines, trimming blanks", () => {
    expect(parseCustomModels("a, b\nc ,  \n d")).toEqual(["a", "b", "c", "d"]);
  });

  it("returns an empty array for an empty string", () => {
    expect(parseCustomModels("")).toEqual([]);
    expect(parseCustomModels("  \n , ")).toEqual([]);
  });
});

describe("modelOptions", () => {
  it("returns the built-ins when there are no custom models", () => {
    expect(modelOptions(BUILTINS, "")).toEqual(BUILTINS);
  });

  it("appends custom ids after the built-ins, using the id as the label", () => {
    expect(modelOptions(BUILTINS, "claude-sonnet-5\nmy-model")).toEqual([
      { id: "claude-fable-5-1", label: "Fable 5.1" },
      { id: "claude-fable-5", label: "Fable 5" },
      { id: "claude-opus-4-8", label: "Opus 4.8" },
      { id: "claude-sonnet-5", label: "claude-sonnet-5" },
      { id: "my-model", label: "my-model" },
    ]);
  });

  it("dedupes a custom id that repeats a built-in (built-in label wins)", () => {
    expect(modelOptions(BUILTINS, "claude-fable-5, brand-new")).toEqual([
      { id: "claude-fable-5-1", label: "Fable 5.1" },
      { id: "claude-fable-5", label: "Fable 5" },
      { id: "claude-opus-4-8", label: "Opus 4.8" },
      { id: "brand-new", label: "brand-new" },
    ]);
  });

  it("dedupes repeated custom ids", () => {
    expect(modelOptions([], "x, x, y")).toEqual([
      { id: "x", label: "x" },
      { id: "y", label: "y" },
    ]);
  });
});

describe("providerModels", () => {
  it("prefers the live runtime catalog over the pinned built-ins", () => {
    const runtime = [{ id: "gpt-live", label: "GPT Live" }];
    expect(providerModels(BUILTINS, runtime, "")).toEqual(runtime);
  });

  it("falls back to the built-ins when the runtime catalog is missing or empty", () => {
    expect(providerModels(BUILTINS, undefined, "")).toEqual(BUILTINS);
    expect(providerModels(BUILTINS, [], "")).toEqual(BUILTINS);
  });

  it("appends custom ids after either source", () => {
    expect(providerModels(BUILTINS, undefined, "mine").map((m) => m.id)).toEqual([
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-opus-4-8",
      "mine",
    ]);
  });
});

describe("composerModelChoices", () => {
  const CODEX = [
    { id: "gpt-6-astra", label: "GPT-6 Astra" },
    { id: "gpt-5.5", label: "GPT-5.5" },
  ];
  const lists = (claudeHidden: string[], codexHidden: string[]) => [
    { provider: "claude" as const, options: BUILTINS, hidden: claudeHidden },
    { provider: "codex" as const, options: CODEX, hidden: codexHidden },
  ];
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

  it("lists every model of both providers when nothing is hidden, tagged by provider", () => {
    const out = composerModelChoices(lists([], []), { provider: "claude", model: "claude-fable-5-1" });
    expect(ids(out)).toEqual(["claude-fable-5-1", "claude-fable-5", "claude-opus-4-8", "gpt-6-astra", "gpt-5.5"]);
    expect(out.find((m) => m.id === "gpt-5.5")?.provider).toBe("codex");
  });

  it("drops hidden models", () => {
    const out = composerModelChoices(lists(["claude-opus-4-8"], ["gpt-5.5"]), { provider: "claude", model: "claude-fable-5-1" });
    expect(ids(out)).toEqual(["claude-fable-5-1", "claude-fable-5", "gpt-6-astra"]);
  });

  it("keeps the active chat's model in place even when it is hidden", () => {
    const out = composerModelChoices(lists(["claude-fable-5"], []), { provider: "claude", model: "claude-fable-5" });
    expect(ids(out).slice(0, 3)).toEqual(["claude-fable-5-1", "claude-fable-5", "claude-opus-4-8"]);
  });

  it("only protects the hidden id for the active provider", () => {
    const out = composerModelChoices(lists(["claude-fable-5"], ["claude-fable-5"]), { provider: "codex", model: "gpt-6-astra" });
    expect(ids(out)).not.toContain("claude-fable-5");
  });

  it("appends the active model when no list has it", () => {
    const out = composerModelChoices(lists([], []), { provider: "codex", model: "gpt-retired" });
    expect(out.at(-1)).toEqual({ id: "gpt-retired", label: "gpt-retired", provider: "codex" });
  });

  it("can hide a whole provider, which then contributes nothing", () => {
    const out = composerModelChoices(lists([], ["gpt-6-astra", "gpt-5.5"]), { provider: "claude", model: "claude-fable-5-1" });
    expect(out.every((m) => m.provider === "claude")).toBe(true);
  });
});

describe("composerModelChoices with an id shared by both providers", () => {
  const lists = [
    { provider: "claude" as const, options: [{ id: "shared", label: "shared" }, { id: "c1", label: "C1" }], hidden: [] },
    { provider: "codex" as const, options: [{ id: "shared", label: "shared" }, { id: "x1", label: "X1" }], hidden: [] },
  ];

  it("lists the id once, under the first provider", () => {
    const out = composerModelChoices(lists, { provider: "claude", model: "c1" });
    expect(out.filter((m) => m.id === "shared")).toEqual([{ id: "shared", label: "shared", provider: "claude" }]);
  });

  it("lists it under the active provider when it is the current model", () => {
    const out = composerModelChoices(lists, { provider: "codex", model: "shared" });
    expect(out.filter((m) => m.id === "shared")).toEqual([{ id: "shared", label: "shared", provider: "codex" }]);
  });
});
