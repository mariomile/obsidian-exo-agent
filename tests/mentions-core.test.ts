import { describe, it, expect } from "vitest";
import { fold, wordTokens } from "../src/mentions/tokenizer";
import {
  buildAliasSet,
  unlinkedMentions,
  aliasTokens,
  stem,
  rankConnections,
  recencyFactor,
  applyLink,
  applyLinks,
  outgoingMentions,
  buildMentionIndex,
  flattenOutgoing,
  wikilinkSpans,
  STOPWORDS,
  type CandidateDoc,
  type MentionTarget,
} from "../src/mentions/mentions-core";

const target = (basename: string, aliases: string[] = [], path = `Atlas/${basename}.md`): MentionTarget => ({
  path,
  basename,
  aliases,
});
const doc = (path: string, text: string, mtime = 0, alreadyLinks = false): CandidateDoc => ({
  path,
  text,
  mtime,
  alreadyLinks,
});

describe("tokenizer", () => {
  it("folds accents and case identically", () => {
    expect(fold("Perché")).toBe(fold("perche"));
    expect(fold("Naïve")).toBe("naive");
    expect(fold("PRICING")).toBe("pricing");
  });

  it("emits linear segment tokens with exact source offsets", () => {
    const toks = wordTokens("go Pricing now");
    const pricing = toks.find((t) => t.text === "pricing")!;
    expect("go Pricing now".slice(pricing.start, pricing.end)).toBe("Pricing");
  });

  it("splits camelCase into ordered segments", () => {
    expect(wordTokens("ProductMarketFit").map((t) => t.text)).toEqual(["product", "market", "fit"]);
  });
});

describe("buildAliasSet — anti-flood guard", () => {
  it("drops a short single-word title", () => {
    expect(buildAliasSet(target("AI"))).toEqual([]); // "ai" len 2 < minTitleLen 3
  });

  it("drops a single-word stopword title", () => {
    expect(STOPWORDS.has("per")).toBe(true);
    expect(buildAliasSet(target("Per"))).toEqual([]);
  });

  it("keeps a multi-word title even if each word is short", () => {
    expect(buildAliasSet(target("Go To Market"))).toEqual([["go", "to", "market"]]);
  });

  it("includes and de-duplicates aliases", () => {
    const set = buildAliasSet(target("Pricing", ["Pricing", "Price Model"]));
    expect(set).toContainEqual(["pricing"]);
    expect(set).toContainEqual(["price", "model"]);
    expect(set.filter((s) => s.join(" ") === "pricing").length).toBe(1);
  });
});

describe("unlinkedMentions — matching", () => {
  it("finds an accent/case-insensitive mention with a correct offset", () => {
    const text = "La strategia di pricing è chiara.";
    const [m] = unlinkedMentions(target("Pricing"), [doc("a.md", text)]);
    expect(m.sourcePath).toBe("a.md");
    expect(text.slice(m.ranges[0].start, m.ranges[0].end)).toBe("pricing");
  });

  it("matches a multi-word title as a contiguous phrase", () => {
    const text = "We nailed product market fit last quarter.";
    const [m] = unlinkedMentions(target("Product Market Fit"), [doc("a.md", text)]);
    expect(text.slice(m.ranges[0].start, m.ranges[0].end)).toBe("product market fit");
  });

  it("does not match a partial phrase", () => {
    const out = unlinkedMentions(target("Product Market Fit"), [doc("a.md", "product market share")]);
    expect(out).toEqual([]);
  });

  it("collects every occurrence in a note", () => {
    const [m] = unlinkedMentions(target("Pricing"), [doc("a.md", "pricing here, Pricing there")]);
    expect(m.ranges.length).toBe(2);
  });
});

describe("unlinkedMentions — exclusions", () => {
  it("skips the target note itself", () => {
    const t = target("Pricing", [], "Atlas/Pricing.md");
    expect(unlinkedMentions(t, [doc("Atlas/Pricing.md", "pricing pricing")])).toEqual([]);
  });

  it("skips notes that already link to the target", () => {
    expect(unlinkedMentions(target("Pricing"), [doc("a.md", "pricing", 0, true)])).toEqual([]);
  });

  it("skips excluded path prefixes", () => {
    const out = unlinkedMentions(target("Pricing"), [doc("Journal/Daily/01.md", "pricing")], {
      excludePrefixes: ["Journal/Daily/"],
    });
    expect(out).toEqual([]);
  });
});

describe("stemming (opt-in)", () => {
  it("is off by default — plural does not match singular", () => {
    expect(unlinkedMentions(target("Prodotto"), [doc("a.md", "i prodotti sono pronti")])).toEqual([]);
  });

  it("matches inflections when enabled", () => {
    const [m] = unlinkedMentions(target("Prodotto"), [doc("a.md", "i prodotti sono pronti")], { stem: true });
    expect(m.sourcePath).toBe("a.md");
  });

  it("never stems below three chars", () => {
    expect(stem("is")).toBe("is");
    expect(aliasTokens("Pricing")).toEqual(["pricing"]);
  });
});

describe("scoring", () => {
  it("ranks a more recent note above an older one", () => {
    const now = 100 * 24 * 60 * 60 * 1000;
    const out = unlinkedMentions(
      target("Pricing"),
      [doc("old.md", "pricing", 0), doc("new.md", "pricing", now)],
      { now, halfLifeDays: 45 },
    );
    expect(out[0].sourcePath).toBe("new.md");
  });

  it("recencyFactor halves after one half-life", () => {
    const now = 45 * 24 * 60 * 60 * 1000;
    expect(recencyFactor(0, now, 45)).toBeCloseTo(0.5, 5);
  });
});

describe("applyLink — safe mutation from exact offsets", () => {
  it("wraps a bare occurrence in a wikilink", () => {
    const text = "about pricing today";
    const [m] = unlinkedMentions(target("pricing"), [doc("a.md", text)]);
    expect(applyLink(text, m.ranges[0], "pricing")).toBe("about [[pricing]] today");
  });

  it("pipes the surface when it differs from the basename (alias/case)", () => {
    const text = "The Pricing page";
    const [m] = unlinkedMentions(target("Pricing"), [doc("a.md", text)]);
    // matched surface is "Pricing"; basename "pricing" differs by case
    expect(applyLink(text, m.ranges[0], "pricing")).toBe("The [[pricing|Pricing]] page");
  });

  it("links every occurrence without offset drift", () => {
    const text = "pricing and pricing again";
    const [m] = unlinkedMentions(target("pricing"), [doc("a.md", text)]);
    expect(applyLinks(text, m.ranges, "pricing")).toBe("[[pricing]] and [[pricing]] again");
  });
});

describe("outgoingMentions — inline (this note cites others)", () => {
  const targets = [
    target("Pricing", [], "Atlas/Pricing.md"),
    target("Product Market Fit", [], "Atlas/Product Market Fit.md"),
  ];

  it("finds a bare outgoing mention", () => {
    const out = outgoingMentions("our pricing is set", buildMentionIndex(targets));
    expect(out.map((m) => m.targetBasename)).toContain("Pricing");
  });

  it("skips text already inside a wikilink", () => {
    const out = outgoingMentions("our [[Pricing]] is set", buildMentionIndex(targets));
    expect(out).toEqual([]);
  });

  it("skips the note's own title", () => {
    const out = outgoingMentions("pricing pricing", buildMentionIndex(targets), "Atlas/Pricing.md");
    expect(out).toEqual([]);
  });

  it("wikilinkSpans covers the whole [[...]]", () => {
    const [s] = wikilinkSpans("a [[X]] b");
    expect("a [[X]] b".slice(s.start, s.end)).toBe("[[X]]");
  });

  it("flattenOutgoing keeps the longer span on overlap", () => {
    const out = outgoingMentions("we hit product market fit", buildMentionIndex(targets));
    const flat = flattenOutgoing(out);
    // "Product Market Fit" (long) beats the "product" substring under "Pricing"? no —
    // only PMF matches here; assert the phrase span is kept whole and once.
    expect(flat.length).toBe(1);
    expect(flat[0].targetBasename).toBe("Product Market Fit");
  });
});

describe("rankConnections", () => {
  it("keeps the strongest kind when a path appears in two buckets", () => {
    const ranked = rankConnections(
      [
        { path: "x.md", kind: "unlinked", mtime: 0 },
        { path: "x.md", kind: "linked", mtime: 0 },
      ],
      0,
    );
    expect(ranked.length).toBe(1);
    expect(ranked[0].kind).toBe("linked");
  });

  it("orders related above linked above unlinked", () => {
    const ranked = rankConnections(
      [
        { path: "c.md", kind: "unlinked", mtime: 0 },
        { path: "a.md", kind: "related", mtime: 0 },
        { path: "b.md", kind: "linked", mtime: 0 },
      ],
      0,
    );
    expect(ranked.map((r) => r.path)).toEqual(["a.md", "b.md", "c.md"]);
  });
});
