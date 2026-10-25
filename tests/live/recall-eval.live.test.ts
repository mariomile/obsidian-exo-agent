/**
 * Live recall eval (`pnpm eval:recall`): the 10 questions of
 * `tests/fixtures/recall-eval.json` against Mario's running vault. Skipped by
 * the default suite.
 *
 * Read-only by construction: Obsidian is only asked to evaluate expressions
 * that read (Sonar search, note names, vault config), the conversation store is
 * read from disk, and the semantic chat index is only queried (`query` mode;
 * the test fails if the index files change). Every set goes through the turn's
 * own `recallTurn`, the function the adapter calls: this file supplies only
 * its reads (the note index minus excluded paths, built by the turn's own
 * `indexNotes`; the Sonar hits; the semantic scores), so what is measured is
 * what ships.
 *
 * The adapter's own semantic call is not used here on purpose: it may refresh
 * the script it runs inside the plugin folder, and this run must not write.
 * For the same reason the correction proposals recall would make are only
 * listed, never appended.
 *
 * Two sets run: the 10 hand questions (regression gate, 10/10 and no trap) and
 * the generated set (`core/recall-eval-gen`, derived from the vault's own links
 * and paths at each run; prints per-family rates and the ids of the misses,
 * asserts only that no superseded note leads). `EXO_EVAL_GEN=0` skips the
 * generated set. The generated cases expect notes only, so they run with no
 * past chats and no semantic answer: chats cannot change which notes a turn
 * injects.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { searchVaultNotes, type NoteHit } from "../../src/obsidian/vault-search";
import { makeExclusion } from "../../src/core/vault-exclusions";
import type { ChatRecord } from "../../src/core/recent-chats";
import { recallQueries, recallTurn, RECALL_LANE_DEPTH, type RecallResult } from "../../src/core/turn-recall";
import { generateCases, type GenNote } from "../../src/core/recall-eval-gen";
import {
  formatSummary,
  recallItems,
  resolveChats,
  scoreCase,
  summarize,
  type CaseScore,
  type EvalCase,
} from "../../src/core/recall-eval";
import { indexNotes, SUPERSEDE_KEY } from "../../src/obsidian/turn-recall";
import { parseChatScores } from "../../src/obsidian/chat-recall";
import type { App } from "obsidian";

const VAULT = "marioverse.ai";
const PLUGIN_DIR = `/Users/mariomiletta/Vaults/${VAULT}/.obsidian/plugins/exo-agent`;
/** Sonar hits fetched per question: what a real turn asks Sonar for when it filters exclusions (`searchVaultNotes`). */
const PROBE_DEPTH = RECALL_LANE_DEPTH * 3;

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
  names: { path: string; basename: string; frontmatter: Record<string, unknown> | null; links: { key: string; target: string }[] }[];
}

/** The vault's note index and exclusion config in one Obsidian round trip. Only reads. */
function liveVault(): LiveVault {
  const code = `(() => JSON.stringify({
    ignore: app.vault.getConfig("userIgnoreFilters") ?? [],
    reports: app.plugins.plugins["exo-agent"].paths.reports,
    names: app.vault.getMarkdownFiles().map((f) => {
      const cache = app.metadataCache.getFileCache(f);
      const fm = cache?.frontmatter;
      const links = (cache?.frontmatterLinks ?? [])
        .filter((l) => new RegExp(${JSON.stringify(SUPERSEDE_KEY.source)}).test(l.key))
        .map((l) => ({ key: l.key, target: app.metadataCache.getFirstLinkpathDest(l.link, f.path)?.path ?? l.link }));
      const keep = fm ? { aliases: fm.aliases, alias: fm.alias, status: fm.status, superseded_by: fm.superseded_by, description: fm.description } : null;
      return { path: f.path, basename: f.basename, frontmatter: keep, links };
    }),
  }))()`;
  return obsidianEval<LiveVault>(code);
}

/** Sonar hits per query, `PROBE_DEPTH` deep, a few queries per round trip. A
 *  blank query gets no hits. `ms` is the first call's wall time per query, as a
 *  turn would pay it (only measured when asked: it doubles the calls). Only reads. */
function liveSonar(queries: string[], timed = false): { hits: NoteHit[][]; ms: number[] } {
  const hits: NoteHit[][] = [];
  const ms: number[] = [];
  for (let i = 0; i < queries.length; i += 25) {
    const code = `(async () => {
      const sonar = app.plugins.plugins["sonar"];
      const hits = [];
      const ms = [];
      for (const q of ${JSON.stringify(queries.slice(i, i + 25))}) {
        if (${timed}) {
          const t0 = performance.now();
          if (q.trim()) await sonar.search(q, { limit: ${PROBE_DEPTH} });
          ms.push(Math.round(performance.now() - t0));
        }
        const hs = q.trim() ? await sonar.search(q, { limit: ${PROBE_DEPTH} }) : [];
        hits.push(hs.map((h) => ({ path: h.path, title: h.title, score: h.score, excerpt: h.excerpt ?? "" })));
      }
      return JSON.stringify({ hits, ms });
    })()`;
    const out = obsidianEval<{ hits: NoteHit[][]; ms: number[] }>(code);
    hits.push(...out.hits);
    ms.push(...out.ms);
  }
  return { hits, ms };
}

/** Body lines (frontmatter stripped) and the wikilink targets on each, for the
 *  given notes. Only reads (`cachedRead`, the metadata cache). */
function liveBodies(paths: string[]): { path: string; lines: string[]; links: { line: number; target: string }[] }[] {
  const code = `(async () => {
    const out = [];
    for (const path of ${JSON.stringify(paths)}) {
      const file = app.vault.getAbstractFileByPath(path);
      if (!file) continue;
      const text = await app.vault.cachedRead(file);
      const cache = app.metadataCache.getFileCache(file);
      const start = cache?.frontmatterPosition ? cache.frontmatterPosition.end.line + 1 : 0;
      const links = (cache?.links ?? [])
        .filter((l) => l.position.start.line >= start)
        .map((l) => ({
          line: l.position.start.line - start,
          target: app.metadataCache.getFirstLinkpathDest(l.link.split("#")[0], path)?.path ?? l.link,
        }));
      out.push({ path, lines: text.split("\\n").slice(start), links });
    }
    return JSON.stringify(out);
  })()`;
  return obsidianEval(code);
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
    return { scored: parseChatScores(out), ms: Math.round(performance.now() - t0) };
  } catch {
    return { scored: null, ms: Math.round(performance.now() - t0) };
  }
}

/** An App whose only capability is Sonar answering from the live hits. */
const sonarApp = (hits: NoteHit[]): App =>
  ({ plugins: { plugins: { sonar: { search: (_q: string, o?: { limit?: number }) => Promise.resolve(hits.slice(0, o?.limit ?? 10)) } } } }) as unknown as App;

/** The notes the vault itself treats as the source of current facts. */
const isCanonical = (path: string): boolean =>
  path === "_system/agent/NOW.md" || path === "_system/memory/open-loops.md" || path.startsWith("Active/Projects/");

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

/** Prompts that name a short word of the vault ("win", "log", "ask") without
 *  meaning a note: the title lane alone must inject nothing for them. */
const SHORT_NAME_PROMPTS = ["ask Claude to rewrite this paragraph", "puoi controllare il log del bot oggi", "how do we win this deal"];
/** Prompts that name a project: its hub note must lead. */
const HUB_PROMPTS = [
  { prompt: "Qual è lo stato attuale del progetto Exo e qual è il prossimo passo?", hub: "Active/Projects/Exo/Exo.md" },
  { prompt: "Qual è lo stato attuale del progetto DeepAgent e qual è il prossimo passo?", hub: "Active/Projects/DeepAgent/DeepAgent.md" },
];

/** A prompt that writes a note out: it must inject that note, with no vault-search hit needed. */
const NAMED_PROMPT = { prompt: "cosa dice il file CLAUDE.md?", note: "CLAUDE.md" };

/** What a run reads once: the note index minus excluded paths (as the turn
 *  builds it), the exclusion itself, and the conversation store. */
function liveContext() {
  const vault = liveVault();
  const exclude = makeExclusion(vault.ignore, [`${vault.reports}/`]);
  const live = vault.names.filter((n) => !exclude(n.path));
  return { vault, exclude, live, ...indexNotes(live), store: liveChats(), now: Date.now() };
}

/** One turn through the shipped `recallTurn`. `sonar` holds the live hits for
 *  the turn's own query, fetched beforehand (one Obsidian round trip per set);
 *  a query nobody fetched is an error, never an empty lane. */
async function runTurn(
  ctx: ReturnType<typeof liveContext>,
  sonar: Map<string, NoteHit[]>,
  message: string,
  opts: { chats: boolean; semantic: () => Promise<{ id: string; score: number }[] | null> },
): Promise<RecallResult | null> {
  return recallTurn({
    message,
    convoId: "",
    chats: opts.chats ? ctx.store : [],
    now: ctx.now,
    names: ctx.names,
    supersede: ctx.supersede.index,
    search: async (query) => {
      const hits = sonar.get(query);
      if (!hits) throw new Error(`no live Sonar hits fetched for "${query}"`);
      const found = await searchVaultNotes(sonarApp(hits), query, RECALL_LANE_DEPTH, ctx.exclude);
      return found.hits.map((h) => ({ path: h.path, excerpt: h.excerpt }));
    },
    semantic: opts.semantic,
  });
}

/** Live Sonar hits for what each message's turn would search for. */
function fetchSonar(ctx: ReturnType<typeof liveContext>, messages: string[], timed = false) {
  const perMessage = messages.map((m) => recallQueries(m, ctx.names));
  const queries = perMessage.flat();
  const { hits, ms } = liveSonar(queries, timed);
  const at: number[] = [];
  let next = 0;
  for (const qs of perMessage) {
    at.push(next);
    next += qs.length;
  }
  return {
    map: new Map(queries.map((q, i) => [q, hits[i]])),
    /** The hits of each message's first query. */
    probe: perMessage.map((_, i) => hits[at[i]] ?? []),
    /** What a turn pays for its searches: the sum, they share one thread. */
    ms: timed ? perMessage.map((qs, i) => ms.slice(at[i], at[i] + qs.length).reduce((a, b) => a + b, 0)) : ms,
  };
}

/** Notes a turn injected on the title lane alone: named by the message, not found by the vault search. */
const titleOnly = (r: RecallResult | null): string[] =>
  r ? r.notes.map((n) => n.path).filter((p) => r.lanes.title.some((t) => t.path === p) && !r.lanes.sonar.some((s) => s.path === p)) : [];

describe.skipIf(!process.env.EXO_LIVE_EVAL)("recall eval against the live vault", () => {
  it("serves the expected sources for the 10 questions", async () => {
    const fixture = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "recall-eval.json"), "utf8")) as { cases: EvalCase[]; ordinary: string[] };
    const ctx = liveContext();
    const { supersede, exclude, store } = ctx;
    const cases = fixture.cases.map((c) => resolveChats(c, store));
    const questions = cases.map((c) => c.question);
    const ordinaryPrompts = [...fixture.ordinary, ...SHORT_NAME_PROMPTS, ...HUB_PROMPTS.map((h) => h.prompt), NAMED_PROMPT.prompt];
    const sonar = fetchSonar(ctx, [...questions, ...ordinaryPrompts], true);
    const proposed = new Set<string>();
    const stampBefore = indexStamp();

    const rows: string[] = [];
    const scores: CaseScore[] = [];
    const semanticMs: number[] = [];
    for (const [i, c] of cases.entries()) {
      const sem = { ms: 0 };
      const result = await runTurn(ctx, sonar.map, c.question, {
        chats: true,
        semantic: async () => {
          const r = semanticScores(c.question);
          sem.ms = r.ms;
          return r.scored;
        },
      });
      expect(result, `no recall for ${c.id}`).not.toBeNull();
      const ranked = result!;
      semanticMs.push(sem.ms);
      for (const n of ranked.notes) if (supersede.fixes.some((f) => f.path === n.path)) proposed.add(n.path);
      const score = scoreCase(recallItems(ranked), c);
      scores.push(score);

      // Where each expected source sits in each lane, past the cut too.
      const probe = sonar.probe[i].filter((h) => !exclude(h.path)).map((h) => h.path);
      const titlePaths = ranked.lanes.title.map((t) => t.path);
      const semIds = ranked.lanes.semanticChats && ranked.lanes.semanticChats.map((x) => x.id);
      const at = (list: readonly string[], x: string | undefined) => {
        const r = x === undefined ? -1 : list.indexOf(x);
        return r < 0 ? "-" : String(r + 1);
      };
      const lanes = c.expect.map((e) => {
        if ("note" in e) return `sonar ${at(probe, e.note)} title ${at(titlePaths, e.note)}`;
        const tag = e.chat.id ? "" : "unresolved ";
        return `${tag}lexical ${at(ranked.lanes.lexicalChats.map((x) => x.id), e.chat.id)} semantic ${semIds ? at(semIds, e.chat.id) : "n/a"}`;
      });
      rows.push(
        `${c.id}  ${pad(score.hit ? (score.full ? "full" : "hit") : "MISS", 5)} ${pad(score.firstRank === null ? "-" : String(score.firstRank), 3)} ${pad(score.trapLeads ? "TRAP" : "", 5)} ${lanes.join(", ")}`,
      );
    }

    // Ordinary prompts must not drag past chats or name-only notes into the turn.
    const ordinary: { prompt: string; chats: number; titleOnly: string[]; result: RecallResult | null }[] = [];
    for (const prompt of ordinaryPrompts) {
      const result = await runTurn(ctx, sonar.map, prompt, { chats: true, semantic: async () => semanticScores(prompt).scored });
      ordinary.push({ prompt, chats: result?.chats.length ?? 0, titleOnly: titleOnly(result), result });
    }
    const group = (prompts: string[]) => ordinary.filter((o) => prompts.includes(o.prompt));
    const fixtureOrdinary = group(fixture.ordinary);
    const shortOrdinary = group(SHORT_NAME_PROMPTS);
    const hubRanks = HUB_PROMPTS.map((h) => {
      const r = ordinary.find((o) => o.prompt === h.prompt)!.result;
      const rank = r ? r.notes.findIndex((n) => n.path === h.hub) + 1 : 0;
      return { ...h, rank, sonarFound: r ? r.lanes.sonar.findIndex((n) => n.path === h.hub) + 1 : 0 };
    });

    const named = ordinary.find((o) => o.prompt === NAMED_PROMPT.prompt)!.result;
    const namedRank = named ? named.notes.findIndex((n) => n.path === NAMED_PROMPT.note) + 1 : 0;

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
        `sonar lane: ${ms(sonar.ms.slice(0, cases.length))}`,
        `semantic lane (node spawn + embed): ${ms(semanticMs)}`,
        `supersede: ${supersede.fixes.length} notes with disagreeing markers, ${supersede.broken.length} broken links; ` +
          `the 10 questions would propose ${proposed.size} correction(s)`,
        ...supersede.fixes.map((f) => `  ${proposed.has(f.path) ? "*" : " "} ${f.path}: ${JSON.stringify(f.set)}`),
        `ordinary prompts (${fixtureOrdinary.length}): ${fixtureOrdinary.reduce((n, o) => n + o.chats, 0)} chats injected, ${fixtureOrdinary.reduce((n, o) => n + o.titleOnly.length, 0)} notes from the title lane alone (${fixtureOrdinary.map((o) => `${o.chats}/${o.titleOnly.length}`).join(" ")})`,
        ...fixtureOrdinary.filter((o) => o.chats || o.titleOnly.length).map((o) => `  "${o.prompt}": chats ${JSON.stringify(o.result?.chats.map((c) => c.title) ?? [])}, title-only ${JSON.stringify(o.titleOnly)}`),
        `short-name prompts (${shortOrdinary.length}): ${shortOrdinary.reduce((n, o) => n + o.chats, 0)} chats injected, ${shortOrdinary.reduce((n, o) => n + o.titleOnly.length, 0)} notes from the title lane alone`,
        ...shortOrdinary.map((o) => `  "${o.prompt}": chats ${JSON.stringify(o.result?.chats.map((c) => c.title) ?? [])}, title-only ${JSON.stringify(o.titleOnly)}`),
        `named note "${NAMED_PROMPT.prompt}": ${NAMED_PROMPT.note} rank ${namedRank || "-"} (Sonar ${named && named.lanes.sonar.findIndex((n) => n.path === NAMED_PROMPT.note) + 1 || "-"})`,
        ...hubRanks.map((h) => `hub ${h.hub}: rank ${h.rank || "-"} (Sonar ${h.sonarFound || "-"}) for "${h.prompt}"`),
      ].join("\n"),
    );

    // S6 exit check (plan 5): every question finds a source it needs, and no
    // superseded note leads unlabelled.
    expect(summary.hitAt5).toBe(10);
    expect(summary.traps).toBe(0);
    // S4: a short word alone never injects a note, and the project hubs lead.
    expect(shortOrdinary.flatMap((o) => o.titleOnly)).toEqual([]);
    expect(fixtureOrdinary.flatMap((o) => o.titleOnly)).toEqual([]);
    expect(namedRank, `${NAMED_PROMPT.note} should be injected for "${NAMED_PROMPT.prompt}"`).toBeGreaterThan(0);
    for (const h of hubRanks) expect(h.rank, `${h.hub} should lead for "${h.prompt}"`).toBe(1);
  }, 300_000);

  it.skipIf(process.env.EXO_EVAL_GEN === "0")("serves the generated question set without a superseded note leading", async () => {
    const ctx = liveContext();
    const { live, supersede } = ctx;
    const canonicalPaths = live.map((n) => n.path).filter(isCanonical);
    const bodies = new Map(liveBodies(canonicalPaths).map((b) => [b.path, b]));
    const notes: GenNote[] = live.map((n) => ({
      path: n.path,
      basename: n.basename,
      frontmatter: n.frontmatter ?? {},
      lines: bodies.get(n.path)?.lines ?? [],
      links: bodies.get(n.path)?.links ?? [],
    }));
    const cases = generateCases({ notes, canonicalPaths, supersede: supersede.index, decisionsFolder: "_system/memory/decisions", peopleFolder: "CRM/People", projectsFolder: "Active/Projects" });
    const sonar = fetchSonar(ctx, cases.map((c) => c.question));

    const scored: { id: string; question: string; score: CaseScore; where: string }[] = [];
    for (const [i, c] of cases.entries()) {
      const result = await runTurn(ctx, sonar.map, c.question, { chats: false, semantic: async () => null });
      const probe = sonar.probe[i].filter((h) => !ctx.exclude(h.path)).map((h) => h.path);
      const where = c.expect.map((e) => ("note" in e ? `sonar ${probe.indexOf(e.note) + 1 || "-"} title ${result?.lanes.title.findIndex((t) => t.path === e.note) ?? -1}` : "chat")).join(", ");
      scored.push({ id: c.id, question: c.question, score: { ...scoreCase(recallItems(result ?? { notes: [], chats: [] }), c), family: c.family }, where });
    }
    const summary = summarize(scored.map((s) => s.score));
    const misses = scored.filter((s) => !s.score.hit);
    const traps = scored.filter((s) => s.score.trapLeads);
    console.log(
      [
        `generated set: ${cases.length} cases derived from ${canonicalPaths.length} canonical notes`,
        formatSummary(summary),
        `misses (${misses.length}), id and best rank:`,
        ...misses.map((m) => `  ${m.id}  ${m.score.firstRank ?? "-"}  (${m.where})  ${m.question}`),
        `traps (${traps.length}):`,
        ...traps.map((t) => `  ${t.id}`),
        `supersede: ${supersede.fixes.length} notes with disagreeing markers, ${supersede.broken.length} broken links`,
        ...supersede.broken.map((b) => `  ${b.path}: ${b.field} -> ${b.target}`),
      ].join("\n"),
    );

    // The rates are read from the report, not asserted: a vault edit must not turn this red.
    expect(cases.length).toBeGreaterThan(0);
    expect(summary.traps).toBe(0);
  }, 300_000);
});
