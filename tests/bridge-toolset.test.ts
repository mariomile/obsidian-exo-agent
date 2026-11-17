import { describe, it, expect } from "vitest";
import { bridgeSessionToolset, mapUserInputAnswers } from "../src/core/bridge-toolset";

const READ = new Set(["mcp__obsidian__search_vault", "mcp__obsidian__read_note"]);
const tools = [
  { name: "search_vault" },
  { name: "read_note" },
  { name: "create_note" },
  { name: "ask_user" },
];

describe("bridgeSessionToolset", () => {
  it("returns the input array ITSELF when the sandbox is not read-only", () => {
    // Reference equality on purpose: the tool list sent to sessions must stay
    // byte-identical when no gating applies: a defensive copy would already be
    // drift surface.
    expect(bridgeSessionToolset(tools, false, READ)).toBe(tools);
  });

  it("keeps only read tools in a read-only sandbox", () => {
    const names = bridgeSessionToolset(tools, true, READ).map((t) => t.name);
    expect(names).toContain("search_vault");
    expect(names).toContain("read_note");
    expect(names).not.toContain("create_note");
  });

  it("keeps ask_user in a read-only sandbox even though it is not a read tool", () => {
    const names = bridgeSessionToolset(tools, true, READ).map((t) => t.name);
    expect(names).toContain("ask_user");
  });

  it("matches read names by basename (the read set carries the mcp__obsidian__ prefix)", () => {
    // A broken prefix strip would filter EVERYTHING out in read-only mode.
    expect(bridgeSessionToolset(tools, true, READ).length).toBe(3);
  });
});

describe("mapUserInputAnswers", () => {
  const questions = [
    { id: "q1", header: "Audience" },
    { id: "q2", header: "Tone" },
  ];

  it("keys the result by question id, reading card answers by header", () => {
    expect(mapUserInputAnswers(questions, { Audience: "Founders", Tone: "Direct" })).toEqual({
      q1: "Founders",
      q2: "Direct",
    });
  });

  it("fills an unanswered question with an empty string, never undefined", () => {
    const out = mapUserInputAnswers(questions, { Audience: "Founders" });
    expect(out).toEqual({ q1: "Founders", q2: "" });
  });

  it("questions sharing a header share the answer (codex defaults header to id, so collisions are self-inflicted)", () => {
    const dup = [
      { id: "a", header: "Pick" },
      { id: "b", header: "Pick" },
    ];
    expect(mapUserInputAnswers(dup, { Pick: "yes" })).toEqual({ a: "yes", b: "yes" });
  });
});
