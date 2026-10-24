/**
 * Live recall eval (`pnpm eval:recall`): the 10 questions of
 * `tests/fixtures/recall-eval.json` against Mario's running vault. Skipped by
 * the default suite.
 *
 * Read-only by construction: Obsidian is only asked to evaluate expressions
 * that read (Sonar search, note names, vault config), the conversation store is
 * read from disk, and the semantic chat index is only queried (`query` mode;
 * the test fails if the index files change). The lanes are built with the same
 * functions the turn uses (`searchVaultNotes`, `titleLane`, `matchPastChats`,
 * `chatsFromIds`) and fused by the same `rankRecall`, so what is measured is
 * what ships.
 *
 * The adapter's own semantic call is not used here on purpose: it may refresh
 * the script it runs inside the plugin folder, and this run must not write.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { searchVaultNotes, type NoteHit } from "../../src/obsidian/vault-search";
import { makeExclusion } from "../../src/core/vault-exclusions";
import type { ChatRecord } from "../../src/core/recent-chats";
import {
  chatsFromIds,
  matchPastChats,
  rankRecall,
  recallKeywords,
  semanticHits,
  titleLane,
  RECALL_LANE_DEPTH,
  RECALL_MAX_CHATS,
  RECALL_MAX_NOTES,
} from "../../src/core/turn-recall";
import {
  formatSummary,
  recallItems,
  resolveChats,
  scoreCase,
  summarize,
  type CaseScore,
  type EvalCase,
} from "../../src/core/recall-eval";
import { parseFrontMatterAliases, type App } from "obsidian";

const VAULT = "marioverse.ai";
const PLUGIN_DIR = `/Users/mariomiletta/Vaults/${VAULT}/.obsidian/plugins/exo-agent`;
/** Sonar hits fetched per question: enough to report ranks past the cut. */
const PROBE_DEPTH = 50;

function obsidianEval<T>(code: string): T {
  let out = "";
  try {
    out = execFileSync("obsidian", [`vault=${VAULT}`, "eval", `code=${code}`], {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    throw new Error("Obsidian is not running or the CLI is unavailable");
  }
  const at = out.indexOf("=> ");
  if (at < 0) throw new Error("Obsidian is not running or the CLI is unavailable");
  return JSON.parse(out.slice(at + 3)) as T;
}

interface LiveVault {
  ignore: string[];
  reports: string;
  sonar: NoteHit[][];
  /** Milliseconds per Sonar call, as the turn would pay it. */
  sonarMs: number[];
  names: { path: string; basename: string; frontmatter: Record<string, unknown> | null }[];
}

/** One Obsidian round trip for every question. Every call in it only reads. */
function liveVault(queries: string[]): LiveVault {
  const code = `(async () => {
    const sonar = app.plugins.plugins["sonar"];
    const queries = ${JSON.stringify(queries)};
    const hits = [];
    const sonarMs = [];
    for (const q of queries) {
      const t0 = performance.now();
      await sonar.search(q, { limit: ${RECALL_LANE_DEPTH * 3} });
      sonarMs.push(Math.round(performance.now() - t0));
      hits.push(await sonar.search(q, { limit: ${PROBE_DEPTH} }));
    }
    return JSON.stringify({
      ignore: app.vault.getConfig("userIgnoreFilters") ?? [],
      reports: app.plugins.plugins["exo-agent"].paths.reports,
      sonar: hits.map((hs) => hs.map((h) => ({ path: h.path, title: h.title, score: h.score, excerpt: h.excerpt ?? "" }))),
      sonarMs,
      names: app.vault.getMarkdownFiles().map((f) => {
        const fm = app.metadataCache.getFileCache(f)?.frontmatter;
        return { path: f.path, basename: f.basename, frontmatter: fm ? { aliases: fm.aliases, alias: fm.alias } : null };
      }),
    });
  })()`;
  return obsidianEval<LiveVault>(code);
}

/** The conversation store as the view hands it to recall: live and archived. */
function liveChats(): ChatRecord[] {
  const read = (f: string) => JSON.parse(readFileSync(join(PLUGIN_DIR, f), "utf8")) as ChatRecord[];
  return [...read("conversations.json"), ...read("conversations-archive.json")].map((x) => ({
    id: x.id,
    title: x.title,
    updatedAt: x.updatedAt,
    archived: x.archived,
    messages: x.messages,
  }));
}

const INDEX_FILES = ["meta.json", "vectors.f32"].map((f) => join(PLUGIN_DIR, "chat-index", f));
const indexStamp = (): string => INDEX_FILES.map((f) => statSync(f).mtimeMs).join(",");

/** The semantic chat lane exactly as the plugin spawns it (`query` mode, from
 *  the plugin folder): every scored id, best first, and its wall time. Null
 *  when the script fails. */
function semanticScores(question: string): { scored: { id: string; score: number }[] | null; ms: number } {
  const script = join(__dirname, "..", "..", "scripts", "chat-recall.mjs");
  const t0 = performance.now();
  try {
    const out = execFileSync("node", [script, "query", PLUGIN_DIR, question, "12"], { cwd: PLUGIN_DIR, encoding: "utf8", timeout: 30_000 });
    const scored = out
      .split("\n")
      .map((l) => l.split("\t"))
      .filter(([score, id]) => !!id?.trim() && !Number.isNaN(Number(score)))
      .map(([score, id]) => ({ id: id.trim(), score: Number(score) }));
    return { scored, ms: Math.round(performance.now() - t0) };
  } catch {
    return { scored: null, ms: Math.round(performance.now() - t0) };
  }
}

/** An App whose only capability is Sonar answering from the live hits. */
const sonarApp = (hits: NoteHit[]): App =>
  ({ plugins: { plugins: { sonar: { search: (_q: string, o?: { limit?: number }) => Promise.resolve(hits.slice(0, o?.limit ?? 10)) } } } }) as unknown as App;

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

describe.skipIf(!process.env.EXO_LIVE_EVAL)("recall eval against the live vault", () => {
  it("serves the expected sources for the 10 questions", async () => {
    const fixture = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "recall-eval.json"), "utf8")) as { cases: EvalCase[]; ordinary: string[] };
    const store = liveChats();
    const cases = fixture.cases.map((c) => resolveChats(c, store));
    const keywords = cases.map((c) => recallKeywords(c.question));
    const vault = liveVault(keywords.map((k) => k.join(" ")));
    const exclude = makeExclusion(vault.ignore, [`${vault.reports}/`]);
    const now = Date.now();

    const names = vault.names
      .filter((n) => !exclude(n.path))
      .map((n) => ({ path: n.path, basename: n.basename, aliases: parseFrontMatterAliases(n.frontmatter) ?? [] }));
    const stampBefore = indexStamp();

    const rows: string[] = [];
    const scores: CaseScore[] = [];
    const semanticMs: number[] = [];
    const titleMs: number[] = [];
    for (const [i, c] of cases.entries()) {
      const { hits } = await searchVaultNotes(sonarApp(vault.sonar[i]), keywords[i].join(" "), RECALL_LANE_DEPTH, exclude);
      const sonar = hits.map((h) => ({ path: h.path, excerpt: h.excerpt }));
      const t0 = performance.now();
      const title = titleLane(keywords[i], names).slice(0, RECALL_LANE_DEPTH);
      titleMs.push(Math.round(performance.now() - t0));
      const titlePaths = title.map((t) => t.path);
      const lexicalChats = matchPastChats(store, keywords[i], { excludeId: "", now });
      const sem = semanticScores(c.question);
      semanticMs.push(sem.ms);
      const semIds = sem.scored && sem.scored.map((x) => x.id);
      const semanticChats = sem.scored && chatsFromIds(semanticHits(sem.scored), store, { excludeId: "" });
      const ranked = rankRecall({ sonar, title, lexicalChats, semanticChats }, { maxNotes: RECALL_MAX_NOTES, maxChats: RECALL_MAX_CHATS });
      const score = scoreCase(recallItems(ranked), c);
      scores.push(score);

      // Where each expected source sits in each lane, past the cut too.
      const probe = vault.sonar[i].filter((h) => !exclude(h.path)).map((h) => h.path);
      const at = (list: readonly string[], x: string | undefined) => {
        const r = x === undefined ? -1 : list.indexOf(x);
        return r < 0 ? "-" : String(r + 1);
      };
      const lanes = c.expect.map((e) => {
        if ("note" in e) return `sonar ${at(probe, e.note)} title ${at(titlePaths, e.note)}`;
        const tag = e.chat.id ? "" : "unresolved ";
        return `${tag}lexical ${at(lexicalChats.map((x) => x.id), e.chat.id)} semantic ${semIds ? at(semIds, e.chat.id) : "n/a"}`;
      });
      rows.push(
        `${c.id}  ${pad(score.hit ? (score.full ? "full" : "hit") : "MISS", 5)} ${pad(score.firstRank === null ? "-" : String(score.firstRank), 3)} ${pad(score.trapLeads ? "TRAP" : "", 5)} ${lanes.join(", ")}`,
      );
    }
    // Ordinary editing prompts must not drag past chats into the turn: chats
    // injected without the semantic floor, then with it.
    const ordinary = fixture.ordinary.map((prompt) => {
      const kw = recallKeywords(prompt);
      const lexicalChats = matchPastChats(store, kw, { excludeId: "", now });
      const { scored } = semanticScores(prompt);
      const chats = (ids: string[] | null) =>
        rankRecall({ sonar: [], title: [], lexicalChats, semanticChats: ids && chatsFromIds(ids, store, { excludeId: "" }) }, { maxNotes: RECALL_MAX_NOTES, maxChats: RECALL_MAX_CHATS }).chats.length;
      return { before: chats(scored && scored.map((x) => x.id)), after: chats(scored && semanticHits(scored)) };
    });
    const total = (k: "before" | "after") => ordinary.reduce((n, o) => n + o[k], 0);

    expect(indexStamp(), "the semantic chat index changed during a read-only run").toBe(stampBefore);
    const summary = summarize(scores);
    const ms = (xs: number[]) => {
      const sorted = [...xs].sort((a, b) => a - b);
      return `first ${xs[0]} ms, median ${sorted[Math.floor(sorted.length / 2)]} ms, max ${sorted[sorted.length - 1]} ms`;
    };
    console.log(
      [
        "id   result first trap  rank per lane (expected sources)",
        ...rows,
        "",
        formatSummary(summary),
        `sonar lane: ${ms(vault.sonarMs)}`,
        `title lane (${names.length} notes): ${ms(titleMs)}`,
        `semantic lane (node spawn + embed): ${ms(semanticMs)}`,
        `ordinary prompts (${ordinary.length}): ${total("before")} chats injected without the semantic floor, ${total("after")} with it (${ordinary.map((o) => `${o.before}>${o.after}`).join(" ")})`,
      ].join("\n"),
    );

    // S3 exit check (plan 5): every question finds a source it needs. Traps
    // may still lead until the supersede labels land.
    expect(summary.hitAt5).toBe(10);
  }, 300_000);
});
