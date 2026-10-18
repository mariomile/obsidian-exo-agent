import { describe, it, expect } from "vitest";
import { TFile, type App } from "obsidian";
import { wordTokens, type Token } from "../src/mentions/tokenizer";
import {
  buildAliasSet,
  buildMentionIndex,
  flattenOutgoing,
  outgoingMentions,
  stem,
  wikilinkSpans,
  type MentionOptions,
  type MentionRange,
  type MentionTarget,
  type OutgoingMatch,
} from "../src/mentions/mentions-core";
import { OutgoingIndexCache } from "../src/mentions/connections";

/* The pre-index algorithm, copied verbatim from mentions-core before the
 * index landed: one buildAliasSet + one full findSequence scan per target. The
 * indexed path must reproduce its output exactly. */
const oldNorm = (t: string, doStem: boolean): string => (doStem ? stem(t) : t);
function oldFindSequence(tokens: Token[], aliasSeq: string[], doStem: boolean): MentionRange[] {
  const hits: MentionRange[] = [];
  const n = aliasSeq.length;
  if (n === 0) return hits;
  const target = doStem ? aliasSeq.map((t) => stem(t)) : aliasSeq;
  for (let i = 0; i + n <= tokens.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (oldNorm(tokens[i + j].text, doStem) !== target[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push({ start: tokens[i].start, end: tokens[i + n - 1].end });
  }
  return hits;
}
function oldOverlaps(a: MentionRange, b: MentionRange): boolean {
  return a.start < b.end && a.end > b.start;
}
function oldOutgoingMentions(
  text: string,
  targets: MentionTarget[],
  opts: MentionOptions & { selfPath?: string } = {},
): OutgoingMatch[] {
  const tokens = wordTokens(text);
  const spans = wikilinkSpans(text);
  const doStem = opts.stem ?? false;
  const out: OutgoingMatch[] = [];
  for (const t of targets) {
    if (t.path === opts.selfPath) continue;
    const aliasSet = buildAliasSet(t, opts);
    if (aliasSet.length === 0) continue;
    const ranges: MentionRange[] = [];
    for (const seq of aliasSet) {
      for (const r of oldFindSequence(tokens, seq, doStem)) {
        if (!spans.some((s) => oldOverlaps(r, s))) ranges.push(r);
      }
    }
    if (ranges.length > 0) {
      ranges.sort((a, b) => a.start - b.start);
      out.push({ targetPath: t.path, targetBasename: t.basename, ranges });
    }
  }
  return out;
}

/* Deterministic synthetic corpus. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const WORDS = [
  "product", "products", "Product", "prodotto", "prodotti", "pricing", "price", "prices", "Prices",
  "market", "markets", "fit", "the", "a", "an", "di", "io", "si", "AI", "ai", "chatGPT", "ChatGpt",
  "Perché", "perche", "naïve", "naive", "HTTPServer", "server", "ES2021", "mp3", "growth", "loop",
  "loops", "agent", "agents", "agentic", "Exo", "exo", "notes", "note", "voice", "voices", "data",
  "dato", "dati", "user", "users", "running", "run", "box", "boxes", "ortodonzia", "Ortodonzie",
  "deep", "DeepAgent", "x", "mai", "ciao", "caso", "casi", "case", "cases", "fitting", "abc", "abcs",
];
const SEPS = [" ", " ", " ", ", ", ". ", "\n", "-", "/", "'s ", " # ", "_"];
const LINKS = ["[[Product Market Fit]]", "[[pricing|Pricing]]", "[[x]]", "[[DeepAgent]]", "[[", "]]", "[[growth loop"];

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)];
}
function makeText(r: () => number): string {
  const n = 1 + Math.floor(r() * 80);
  let s = "";
  for (let i = 0; i < n; i++) {
    s += r() < 0.08 ? pick(r, LINKS) : pick(r, WORDS);
    s += pick(r, SEPS);
  }
  return s;
}
function makeName(r: () => number): string {
  const k = 1 + Math.floor(r() * 3);
  const parts: string[] = [];
  for (let i = 0; i < k; i++) parts.push(pick(r, WORDS));
  const joiner = r() < 0.15 ? "" : r() < 0.3 ? "-" : " ";
  return r() < 0.04 ? "!!" : parts.join(joiner);
}
function makeTargets(r: () => number): MentionTarget[] {
  const n = 1 + Math.floor(r() * 14);
  const out: MentionTarget[] = [];
  for (let i = 0; i < n; i++) {
    const basename = makeName(r);
    const aliases: string[] = [];
    const na = Math.floor(r() * 4);
    for (let j = 0; j < na; j++) {
      const roll = r();
      // Same name in another case/accent, a stem twin, or a fresh name.
      aliases.push(roll < 0.2 ? basename.toUpperCase() : roll < 0.35 ? `${basename}s` : makeName(r));
    }
    // Duplicate paths happen in the corpus on purpose (selfPath hits both).
    const path = r() < 0.1 && out.length > 0 ? out[0].path : `N/${i}-${basename}.md`;
    out.push({ path, basename, aliases });
  }
  return out;
}

const OPTION_SETS: Array<MentionOptions> = [
  {},
  { stem: true },
  { minTitleLen: 2, stopwords: new Set(["the", "di"]) },
  { stem: true, minTitleLen: 1, stopwords: new Set() },
];

describe("outgoingMentions equals the pre-index algorithm", () => {
  it("matches on 2000 synthetic texts x 4 option sets x self/no-self (16000 comparisons)", () => {
    const r = rng(20261018);
    let compared = 0;
    let nonEmpty = 0;
    for (let c = 0; c < 2000; c++) {
      const text = makeText(r);
      const targets = makeTargets(r);
      const self = r() < 0.5 ? pick(r, targets).path : undefined;
      for (const o of OPTION_SETS) {
        for (const selfPath of [undefined, self]) {
          const opts = { ...o, selfPath };
          const want = oldOutgoingMentions(text, targets, opts);
          const got = outgoingMentions(text, buildMentionIndex(targets, o), selfPath);
          expect(got).toEqual(want);
          expect(flattenOutgoing(got)).toEqual(flattenOutgoing(want));
          compared++;
          if (want.length > 0) nonEmpty++;
        }
      }
    }
    expect(compared).toBe(16000);
    // The corpus must actually exercise matching, not just agree on empties.
    expect(nonEmpty).toBeGreaterThan(8000);
  });

  it("one index reused across many texts gives the same answers as a fresh build", () => {
    const r = rng(7);
    const targets = makeTargets(r).concat(makeTargets(r), makeTargets(r));
    for (const doStem of [false, true]) {
      const index = buildMentionIndex(targets, { stem: doStem });
      for (let c = 0; c < 300; c++) {
        const text = makeText(r);
        const self = pick(r, targets).path;
        expect(outgoingMentions(text, index, self)).toEqual(
          oldOutgoingMentions(text, targets, { stem: doStem, selfPath: self }),
        );
      }
    }
  });

  it("keeps stem-twin duplicates, multi-word overlaps and wikilink exclusions", () => {
    const targets: MentionTarget[] = [
      { path: "A/Price.md", basename: "Price", aliases: ["Prices", "PRICE"] },
      { path: "A/Product.md", basename: "Product", aliases: [] },
      { path: "A/Product Market Fit.md", basename: "Product Market Fit", aliases: ["PMF"] },
      { path: "A/Perché.md", basename: "Perché", aliases: [] },
    ];
    const text = "prices and price, Product market fit [[Product]] perche PMF products";
    for (const doStem of [false, true]) {
      const want = oldOutgoingMentions(text, targets, { stem: doStem });
      expect(outgoingMentions(text, buildMentionIndex(targets, { stem: doStem }))).toEqual(want);
    }
    // With stemming the two aliases of Price hit the same span twice; both survive.
    const stemmed = outgoingMentions(text, buildMentionIndex(targets, { stem: true }));
    const price = stemmed.find((m) => m.targetBasename === "Price");
    expect(price?.ranges.filter((x) => x.start === 0).length).toBe(2);
  });
});

/* ---------------- cache invalidation (fake app, no Obsidian) ---------------- */

function md(path: string): TFile {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return Object.assign(new TFile(), {
    path,
    basename: base.slice(0, dot),
    extension: base.slice(dot + 1),
  });
}

/** A fake app whose vault/metadataCache `on` record handlers, so a test can
 *  `emit` the events the cache registered on its owner. */
function fakeApp(files: TFile[], aliases: Map<string, unknown>) {
  let walks = 0;
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const on = (prefix: string) => (name: string, fn: (...args: unknown[]) => void) => {
    const key = `${prefix}:${name}`;
    handlers.set(key, [...(handlers.get(key) ?? []), fn]);
    return {};
  };
  const app = {
    vault: {
      on: on("vault"),
      getMarkdownFiles: () => {
        walks++;
        return files.filter((f) => f.extension === "md");
      },
    },
    metadataCache: {
      on: on("metadataCache"),
      getFileCache: (f: TFile) => (aliases.has(f.path) ? { frontmatter: { aliases: aliases.get(f.path) } } : null),
    },
  } as unknown as App;
  const emit = (key: string, ...args: unknown[]) => {
    for (const fn of handlers.get(key) ?? []) fn(...args);
  };
  const owner = { registerEvent: () => {} };
  return { app, owner, emit, walks: () => walks };
}

describe("OutgoingIndexCache", () => {
  const EXCL = ["Journal/Daily/"];

  it("reuses the index across passes and rebuilds only on a target-set change", () => {
    const files = [md("A/Pricing.md"), md("A/Growth Loop.md"), md("Journal/Daily/2026-10-18.md")];
    const aliases = new Map<string, unknown>([["A/Pricing.md", ["Prices"]]]);
    const { app, owner, emit, walks } = fakeApp(files, aliases);
    const cache = new OutgoingIndexCache(app, owner);

    const first = cache.get(false, EXCL);
    expect(cache.get(false, EXCL)).toBe(first);
    expect(walks()).toBe(1);

    // Body-only edit: aliases unchanged, index kept.
    emit("metadataCache:changed", files[0]);
    expect(cache.get(false, EXCL)).toBe(first);
    // Excluded note edited: ignored.
    emit("metadataCache:changed", files[2]);
    expect(cache.get(false, EXCL)).toBe(first);
    expect(walks()).toBe(1);

    // Alias edit: rebuilt, and the new alias matches.
    aliases.set("A/Pricing.md", ["Prices", "Tariffe"]);
    emit("metadataCache:changed", files[0]);
    const second = cache.get(false, EXCL);
    expect(second).not.toBe(first);
    expect(outgoingMentions("le tariffe", second).map((m) => m.targetBasename)).toEqual(["Pricing"]);

    // A scanned note the index has never seen: rebuilt.
    files.push(md("A/Agent.md"));
    emit("metadataCache:changed", files[3]);
    const third = cache.get(false, EXCL);
    expect(third).not.toBe(second);

    // Any create/delete/rename, file or folder: rebuilt.
    let last = third;
    for (const [event, file] of [
      ["vault:create", md("A/New.md")],
      ["vault:create", md("A/img.png")],
      ["vault:delete", md("A/New.md")],
      ["vault:rename", { path: "B" }],
    ] as const) {
      emit(event, file, "old/path.md");
      const next = cache.get(false, EXCL);
      expect(next, event).not.toBe(last);
      last = next;
    }

    // Stemming flip or different exclusions: rebuilt for that key.
    const plain = cache.get(false, EXCL);
    expect(cache.get(true, EXCL)).not.toBe(plain);
    expect(cache.get(true, [])).not.toBe(plain);
  });

  it("serves the same matches as the pre-index pass over the same notes", () => {
    const files = [md("A/Pricing.md"), md("A/Product Market Fit.md"), md("B/Perché.md"), md("Journal/Daily/x.md")];
    const aliases = new Map<string, unknown>([
      ["A/Pricing.md", "Prices"],
      ["A/Product Market Fit.md", ["PMF", 42]],
    ]);
    const { app, owner } = fakeApp(files, aliases);
    const cache = new OutgoingIndexCache(app, owner);
    const targets: MentionTarget[] = [
      { path: "A/Pricing.md", basename: "Pricing", aliases: ["Prices"] },
      { path: "A/Product Market Fit.md", basename: "Product Market Fit", aliases: ["PMF", "42"] },
      { path: "B/Perché.md", basename: "Perché", aliases: [] },
    ];
    const text = "prices, product market fit, pmf 42 perche x";
    for (const doStem of [false, true]) {
      expect(outgoingMentions(text, cache.get(doStem, EXCL), "B/Perché.md")).toEqual(
        oldOutgoingMentions(text, targets, { stem: doStem, selfPath: "B/Perché.md" }),
      );
    }
  });

  it("drops a note renamed away from markdown (.md -> .txt)", () => {
    const pricing = md("A/Pricing.md");
    const files = [pricing, md("A/Growth Loop.md")];
    const { app, owner, emit } = fakeApp(files, new Map());
    const cache = new OutgoingIndexCache(app, owner);
    expect(outgoingMentions("our pricing", cache.get(false, EXCL)).map((m) => m.targetBasename)).toEqual(["Pricing"]);

    // Obsidian passes the file as it is AFTER the rename, plus the old path.
    const renamed = md("A/Pricing.txt");
    files[0] = renamed;
    emit("vault:rename", renamed, pricing.path);
    expect(outgoingMentions("our pricing", cache.get(false, EXCL))).toEqual([]);
  });
});
