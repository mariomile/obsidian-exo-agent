import { describe, it, expect } from "vitest";
import {
  AGENT_BLOCK_NAMES,
  blockSpec,
  isAgentBlock,
  parseManifest,
  compileIdentity,
  buildSeedPrompt,
  parseSeedBlocks,
  manifestContent,
  IDENTITY_ARBITRATION_LINE,
  agentBlockTemplate,
  isUnfilledAgentBlock,
  AGENT_TEMPLATE_MARKER,
  type BlockName,
  type IdentityBlock,
} from "../src/core/agent-self";

/* ------------------------------ registry -------------------------------- */

describe("AGENT_BLOCKS registry", () => {
  it("declares SOUL/USER/NOW in that order with the spec limits", () => {
    expect(AGENT_BLOCK_NAMES).toEqual<BlockName[]>(["SOUL", "USER", "NOW"]);
    expect(blockSpec("SOUL").limit).toBe(1500);
    expect(blockSpec("USER").limit).toBe(2000);
    expect(blockSpec("NOW").limit).toBe(1500);
  });

  it("requires a rationale for SOUL and USER only", () => {
    expect(blockSpec("NOW").requiresRationale).toBe(false);
    expect(blockSpec("USER").requiresRationale).toBe(true);
    expect(blockSpec("SOUL").requiresRationale).toBe(true);
  });

  it("recognizes only the three block names", () => {
    expect(isAgentBlock("SOUL")).toBe(true);
    expect(isAgentBlock("USER")).toBe(true);
    expect(isAgentBlock("NOW")).toBe(true);
    expect(isAgentBlock("nope")).toBe(false);
    expect(isAgentBlock("")).toBe(false);
  });
});

/* ---------------------------- parseManifest ----------------------------- */

describe("parseManifest", () => {
  it("returns hardcoded defaults on empty/garbage input", () => {
    const a = parseManifest("");
    const b = parseManifest("%%% not a manifest %%%");
    expect(a.version).toBe(b.version);
    expect(a.blocks.map((x) => x.name)).toEqual(["SOUL", "USER", "NOW"]);
    // Defaults carry the canonical limits.
    expect(a.blocks.find((x) => x.name === "USER")?.limit).toBe(2000);
  });

  it("parses a well-formed manifest table without throwing", () => {
    const md = [
      "# Agent manifest",
      "version: 2",
      "",
      "| block | limit | owner |",
      "| SOUL | 1500 | rewrite-with-rationale |",
      "| USER | 2000 | rewrite-with-rationale |",
      "| NOW | 1500 | rewrite |",
    ].join("\n");
    const m = parseManifest(md);
    expect(m.blocks.map((b) => b.name)).toEqual(["SOUL", "USER", "NOW"]);
  });

  it("falls back to the canonical block set when the table is corrupt", () => {
    const m = parseManifest("version: 9\n| block | limit |\n| garbage row without cols");
    expect(m.blocks.map((b) => b.name)).toEqual(["SOUL", "USER", "NOW"]);
  });

  it("never throws on any input", () => {
    expect(() => parseManifest(undefined as unknown as string)).not.toThrow();
    expect(() => parseManifest(null as unknown as string)).not.toThrow();
  });
});

/* --------------------------- compileIdentity ---------------------------- */

const NOW_MS = Date.UTC(2026, 6, 10, 12, 0, 0); // 2026-07-10

function block(name: BlockName, content: string, ageDays?: number): IdentityBlock {
  return {
    name,
    content,
    mtime: ageDays === undefined ? undefined : NOW_MS - ageDays * 86_400_000,
  };
}

describe("compileIdentity", () => {
  it("returns an empty string when every block is missing", () => {
    expect(compileIdentity([], { now: NOW_MS })).toBe("");
    expect(compileIdentity([block("SOUL", "   ")], { now: NOW_MS })).toBe("");
  });

  it("orders SOUL → USER → NOW regardless of input order", () => {
    const out = compileIdentity(
      [block("NOW", "now text"), block("SOUL", "soul text"), block("USER", "user text")],
      { now: NOW_MS }
    );
    const pi = out.indexOf("soul text");
    const hi = out.indexOf("user text");
    const ni = out.indexOf("now text");
    expect(pi).toBeGreaterThan(-1);
    expect(pi).toBeLessThan(hi);
    expect(hi).toBeLessThan(ni);
  });

  it("heads each block and appends the arbitration line", () => {
    const out = compileIdentity([block("SOUL", "be terse")], { now: NOW_MS });
    expect(out).toContain("Soul");
    expect(out).toContain("be terse");
    expect(out).toContain(IDENTITY_ARBITRATION_LINE);
  });

  it("adds a staleness marker from the mtime", () => {
    const out = compileIdentity([block("NOW", "hot project X", 5)], { now: NOW_MS });
    expect(out).toMatch(/updated 5 days ago/);
  });

  it("says 'today' for a same-day mtime", () => {
    const out = compileIdentity([block("NOW", "hot project X", 0)], { now: NOW_MS });
    expect(out).toMatch(/updated today/);
  });

  it("omits the staleness marker when the mtime is unknown", () => {
    const out = compileIdentity([block("NOW", "hot project X")], { now: NOW_MS });
    expect(out).not.toMatch(/updated .* days ago/);
    expect(out).not.toMatch(/updated today/);
  });

  it("includes an over-limit block WHOLE and marks it over budget (never truncates)", () => {
    const big = "x".repeat(1600); // persona limit is 1500
    const out = compileIdentity([block("SOUL", big)], { now: NOW_MS });
    expect(out).toContain(big); // the whole block survives verbatim
    expect(out).toMatch(/over budget/i);
  });

  it("does not mark an at-limit block as over budget", () => {
    const exact = "y".repeat(1500);
    const out = compileIdentity([block("SOUL", exact)], { now: NOW_MS });
    expect(out).not.toMatch(/over budget/i);
  });

  it("skips missing/blank blocks silently while keeping the present ones", () => {
    const out = compileIdentity(
      [block("SOUL", "p"), block("USER", "  "), block("NOW", "n")],
      { now: NOW_MS }
    );
    expect(out).toContain("p");
    expect(out).toContain("n");
    // no empty 'User' heading with nothing under it — USER was blank so it's skipped
    const hMatches = out.match(/User/g) ?? [];
    expect(hMatches.length).toBe(0);
  });
});

/* ------------------------------- seeder --------------------------------- */

describe("buildSeedPrompt", () => {
  const sources = {
    mentalModel: "Mario is a 0-to-1 PM.",
    preferences: "Direct, no filler.",
    vaultContext: "marioverse.ai vault.",
  };

  it("includes all three source sections and the per-block limits", () => {
    const p = buildSeedPrompt(sources);
    expect(p).toContain("Mario is a 0-to-1 PM.");
    expect(p).toContain("Direct, no filler.");
    expect(p).toContain("marioverse.ai vault.");
    expect(p).toContain("1500"); // persona/now limit
    expect(p).toContain("2000"); // human limit
  });

  it("instructs distillation, not copying", () => {
    expect(buildSeedPrompt(sources).toLowerCase()).toContain("distill");
  });
});

describe("parseSeedBlocks", () => {
  it("parses all three fenced blocks", () => {
    const raw = [
      "<<<SOUL>>>", "Be terse.", "<<<end-SOUL>>>",
      "<<<USER>>>", "Mario, PM.", "<<<end-USER>>>",
      "<<<NOW>>>", "Shipping identity.", "<<<end-NOW>>>",
    ].join("\n");
    expect(parseSeedBlocks(raw)).toEqual({
      SOUL: "Be terse.",
      USER: "Mario, PM.",
      NOW: "Shipping identity.",
    });
  });

  it("omits a missing block rather than inventing it", () => {
    const raw = "<<<SOUL>>>\nBe terse.\n<<<end-SOUL>>>";
    const out = parseSeedBlocks(raw);
    expect(out.SOUL).toBe("Be terse.");
    expect(out.USER).toBeUndefined();
    expect(out.NOW).toBeUndefined();
  });

  it("returns an empty map on garbage and never throws", () => {
    expect(parseSeedBlocks("no fences at all")).toEqual({});
    expect(parseSeedBlocks("")).toEqual({});
  });
});

describe("manifestContent", () => {
  it("documents the block registry and the read-don't-write contract", () => {
    const m = manifestContent();
    expect(m).toContain("SOUL.md");
    expect(m).toContain("USER.md");
    expect(m).toContain("NOW.md");
    expect(m).toMatch(/read.*don'?t write/i);
    expect(m).toContain("Exo owns maintenance");
  });
});

/* --------------------- onboarding block templates ----------------------- */

describe("agentBlockTemplate + isUnfilledAgentBlock", () => {
  it("produces a template carrying the marker and the block heading", () => {
    for (const name of AGENT_BLOCK_NAMES) {
      const t = agentBlockTemplate(name);
      expect(t).toContain(AGENT_TEMPLATE_MARKER);
      expect(t).toContain(blockSpec(name).heading);
    }
  });

  it("treats empty/whitespace and the untouched template as unfilled", () => {
    for (const name of AGENT_BLOCK_NAMES) {
      expect(isUnfilledAgentBlock(name, "")).toBe(true);
      expect(isUnfilledAgentBlock(name, "   \n  ")).toBe(true);
      expect(isUnfilledAgentBlock(name, agentBlockTemplate(name))).toBe(true);
      // trailing-newline tolerance (vault writes normalize whitespace)
      expect(isUnfilledAgentBlock(name, `${agentBlockTemplate(name)}\n`)).toBe(true);
    }
  });

  it("treats any hand-edit as filled (never clobbered by the seeder)", () => {
    for (const name of AGENT_BLOCK_NAMES) {
      expect(isUnfilledAgentBlock(name, `${agentBlockTemplate(name)}\nMy own words.`)).toBe(false);
      expect(isUnfilledAgentBlock(name, "# Persona\n\nI am terse and direct.")).toBe(false);
    }
  });
});
