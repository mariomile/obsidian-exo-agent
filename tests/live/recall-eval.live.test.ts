/**
 * Live recall eval (`pnpm eval:recall`): the 10 questions of
 * `tests/fixtures/recall-eval.json` against Mario's running vault. Skipped by
 * the default suite.
 *
 * Read-only by construction: Obsidian is only asked to evaluate expressions
 * that read (Sonar search, vault config), and the conversation store is read
 * from disk. The lanes go through the same `searchVaultNotes` filtering and
 * `rankRecall` the turn uses, so what is measured is what ships.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { searchVaultNotes, type NoteHit } from "../../src/obsidian/vault-search";
import { makeExclusion } from "../../src/core/vault-exclusions";
import type { ChatRecord } from "../../src/core/recent-chats";
import {
  matchPastChats,
  rankRecall,
  recallKeywords,
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
import type { App } from "obsidian";

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
}

/** One Obsidian round trip for every question. Every call in it only reads. */
function liveVault(queries: string[]): LiveVault {
  const code = `(async () => {
    const sonar = app.plugins.plugins["sonar"];
    const queries = ${JSON.stringify(queries)};
    const hits = [];
    for (const q of queries) hits.push(await sonar.search(q, { limit: ${PROBE_DEPTH} }));
    return JSON.stringify({
      ignore: app.vault.getConfig("userIgnoreFilters") ?? [],
      reports: app.plugins.plugins["exo-agent"].paths.reports,
      sonar: hits.map((hs) => hs.map((h) => ({ path: h.path, title: h.title, score: h.score, excerpt: h.excerpt ?? "" }))),
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

/** An App whose only capability is Sonar answering from the live hits. */
const sonarApp = (hits: NoteHit[]): App =>
  ({ plugins: { plugins: { sonar: { search: (_q: string, o?: { limit?: number }) => Promise.resolve(hits.slice(0, o?.limit ?? 10)) } } } }) as unknown as App;

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

describe.skipIf(!process.env.EXO_LIVE_EVAL)("recall eval against the live vault", () => {
  it("serves the expected sources for the 10 questions", async () => {
    const fixture = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "recall-eval.json"), "utf8")) as { cases: EvalCase[] };
    const store = liveChats();
    const cases = fixture.cases.map((c) => resolveChats(c, store));
    const keywords = cases.map((c) => recallKeywords(c.question));
    const vault = liveVault(keywords.map((k) => k.join(" ")));
    const exclude = makeExclusion(vault.ignore, [`${vault.reports}/`]);
    const now = Date.now();

    const rows: string[] = [];
    const scores: CaseScore[] = [];
    for (const [i, c] of cases.entries()) {
      const { hits } = await searchVaultNotes(sonarApp(vault.sonar[i]), keywords[i].join(" "), RECALL_MAX_NOTES, exclude);
      const sonar = hits.map((h) => ({ path: h.path, excerpt: h.excerpt }));
      const lexicalChats = matchPastChats(store, keywords[i], { now });
      const ranked = rankRecall({ sonar, title: [], lexicalChats, semanticChats: null }, { maxNotes: RECALL_MAX_NOTES, maxChats: RECALL_MAX_CHATS });
      const score = scoreCase(recallItems(ranked), c);
      scores.push(score);

      // Where each expected source sits in each lane, past the cut too.
      const probe = vault.sonar[i].filter((h) => !exclude(h.path)).map((h) => h.path);
      const lanes = c.expect.map((e) => {
        if ("note" in e) {
          const r = probe.indexOf(e.note);
          return `sonar ${r < 0 ? "-" : r + 1}`;
        }
        const r = lexicalChats.findIndex((x) => x.id === e.chat.id);
        return `${e.chat.id ? "" : "unresolved "}lexical ${r < 0 ? "-" : r + 1}`;
      });
      rows.push(
        `${c.id}  ${pad(score.hit ? (score.full ? "full" : "hit") : "MISS", 5)} ${pad(score.firstRank === null ? "-" : String(score.firstRank), 3)} ${pad(score.trapLeads ? "TRAP" : "", 5)} ${lanes.join(", ")}`,
      );
    }
    const summary = summarize(scores);
    console.log(["id   result first trap  rank per lane (expected sources)", ...rows, "", formatSummary(summary)].join("\n"));

    // S2 baseline (plan 4.3): regressions show until the S3 lanes land.
    expect(summary.hitAt5).toBeGreaterThanOrEqual(7);
  }, 300_000);
});
