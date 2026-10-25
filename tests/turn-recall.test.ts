import { describe, it, expect, vi, afterEach } from "vitest";
import { TFile } from "obsidian";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  chatsFromIds,
  formatRecallBlock,
  isHub,
  matchPastChats,
  nameVocab,
  rankRecall,
  recallKeywords,
  recallQueries,
  recallTurn,
  semanticHits,
  shouldRecall,
  titleLane,
  RECALL_CHAT_MIN_LIFT,
  RECALL_CLOSE,
  RECALL_LANE_DEPTH,
  RECALL_MAX_CHARS,
  RECALL_MAX_CHATS,
  RECALL_MAX_NOTES,
  RECALL_OPEN,
  type ChatRecall,
  type LexicalChat,
  type NoteRecall,
} from "../src/core/turn-recall";
import { indexNotes, recallForTurn, SEMANTIC_BUDGET_MS } from "../src/obsidian/turn-recall";
import { recallChatScores } from "../src/obsidian/chat-recall";
import { buildSupersedeIndex } from "../src/core/supersede";

vi.mock("../src/obsidian/chat-recall", () => ({
  recallChatScores: vi.fn(() => Promise.resolve(null)),
  recallHost: (pluginDir: string) => ({ pluginDir, scriptPath: `${pluginDir}/chat-recall.mjs` }),
}));
import type { ChatRecord } from "../src/core/recent-chats";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);

describe("shouldRecall", () => {
  it("skips messages under four words and slash commands", () => {
    expect(shouldRecall("ok go on")).toBe(false);
    expect(shouldRecall("/compact keep the pricing decisions")).toBe(false);
    expect(shouldRecall("")).toBe(false);
    expect(shouldRecall("what did we decide on pricing")).toBe(true);
  });
});

describe("recallKeywords", () => {
  it("keeps distinct content words, folds accents, drops stopwords and operators", () => {
    expect(recallKeywords("Cosa abbiamo deciso sul pricing di Exo? -path:Pricing perché")).toEqual([
      "abbiamo",
      "deciso",
      "pricing",
      "path",
    ]);
  });
});

describe("recallKeywords with a name vocabulary", () => {
  it("keeps a 3-char token only when a note is named so", () => {
    const msg = "Qual è il progetto Exo adesso?";
    expect(recallKeywords(msg)).toEqual(["qual", "progetto", "adesso"]);
    expect(recallKeywords(msg, new Set(["exo"]))).toEqual(["qual", "progetto", "exo", "adesso"]);
    expect(recallKeywords(msg, new Set(["crm"]))).toEqual(["qual", "progetto", "adesso"]);
  });
  it("stopwords stay dropped even when a note carries the word", () => {
    const vocab = new Set(["per", "con", "the", "exo"]);
    expect(recallKeywords("the plan per Exo con calma", vocab)).toEqual(["plan", "exo", "calma"]);
  });
  it("2-char tokens never qualify", () => {
    expect(recallKeywords("cosa fa AI nel progetto", new Set(["ai"]))).toEqual(["progetto"]);
  });
});

describe("nameVocab", () => {
  it("collects the 3-char word tokens of basenames and aliases, minus stopwords and digits", () => {
    const vocab = nameVocab([
      { basename: "Exo", aliases: [] },
      { basename: "Note per CRM", aliases: ["Gestione API"] },
      { basename: "2026-10-25 123", aliases: [] },
      { basename: "Deployment", aliases: [] },
    ]);
    expect([...vocab].sort()).toEqual(["api", "crm", "exo"]);
  });
});

describe("isHub", () => {
  it("a folder note is X/X.md, anywhere in the path", () => {
    expect(isHub("Active/Projects/Exo/Exo.md")).toBe(true);
    expect(isHub("Exo/Exo.md")).toBe(true);
    expect(isHub("CRM/Companies/Exo.md")).toBe(false);
    expect(isHub("Exo.md")).toBe(false);
    expect(isHub("Active/Projects/Exo/Roadmap.md")).toBe(false);
  });
});

const chats: ChatRecord[] = [
  {
    id: "current",
    title: "Now",
    messages: [{ role: "user", text: "pricing tiers for Exo launch", at: NOW }],
  },
  {
    id: "c1",
    title: "Pricing call",
    messages: [
      { role: "user", text: "Let's settle Exo pricing tiers today", at: NOW - 2 * DAY },
      { role: "assistant", segments: [{ t: "text", md: "Pricing tiers: Free, Pro 29 euro, Team." }] },
    ],
  },
  {
    id: "c2",
    title: "Old pricing",
    messages: [{ role: "user", text: "pricing tiers draft", at: NOW - 90 * DAY }],
  },
  {
    id: "c3",
    title: "Unrelated",
    messages: [{ role: "user", text: "tiers of a wedding cake", at: NOW - DAY }],
  },
];

describe("matchPastChats", () => {
  it("matches past chats in the last 60 days, never the current one, with title, date and snippet", () => {
    const out = matchPastChats(chats, ["pricing", "tiers", "launch"], { excludeId: "current", now: NOW });
    expect(out).toEqual([
      { id: "c1", title: "Pricing call", date: "2026-09-23", snippet: "Let's settle Exo pricing tiers today", msgIndex: 0, hits: 2 },
    ]);
  });
  it("reports how many of the rare keywords the best line holds, for the chat gate", () => {
    const three: ChatRecord = { id: "t", title: "T", messages: [{ role: "user", text: "pricing tiers launch plan", at: NOW - DAY }] };
    expect(matchPastChats([three], ["pricing", "tiers", "launch"], { excludeId: "x", now: NOW }).map((c) => c.hits)).toEqual([3]);
  });
  it("carries the index of the best matching message, counting messages recall skips", () => {
    const chat: ChatRecord = {
      id: "deep",
      title: "Deep",
      messages: [
        { role: "user", text: "report from a child", at: NOW - DAY, auto: true },
        { role: "user", text: "pricing first", at: NOW - DAY },
        { role: "assistant", segments: [{ t: "text", md: "Pricing tiers: Free and Pro." }] },
      ],
    };
    const [hit] = matchPastChats([chat], ["pricing", "tiers"], { excludeId: "x", now: NOW });
    expect(hit).toMatchObject({ id: "deep", msgIndex: 2, snippet: "Pricing tiers: Free and Pro." });
  });
  it("needs two keyword hits: one shared word is noise", () => {
    expect(matchPastChats(chats, ["tiers", "wedding2"], { excludeId: "current", now: NOW }).map((c) => c.title)).toEqual([]);
  });
  it("only the message's rarest keywords count: common words never match a chat", () => {
    const line = (id: string, text: string): ChatRecord => ({
      id,
      title: id,
      messages: [{ role: "user", text, at: NOW - DAY }],
    });
    const corpus: ChatRecord[] = [
      ...Array.from({ length: 6 }, (_, i) => line(`common${i}`, "prima devo sistemare il product backlog")),
      line("interview", "preparare interview revolut con esempi STAR"),
    ];
    const keywords = ["devo", "preparare", "prima", "interview", "revolut", "conversazione", "product"];
    expect(matchPastChats(corpus, keywords, { excludeId: "x", now: NOW }).map((c) => c.title)).toEqual(["interview"]);
  });
  it("returns at most two chats", () => {
    const many: ChatRecord[] = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`,
      title: `M${i}`,
      messages: [{ role: "user" as const, text: "pricing tiers again", at: NOW - i * 1000 }],
    }));
    expect(matchPastChats(many, ["pricing", "tiers"], { excludeId: "x", now: NOW })).toHaveLength(2);
  });
});

describe("formatRecallBlock", () => {
  it("is empty with nothing to recall", () => {
    expect(formatRecallBlock([], [])).toEqual({ block: "", notes: [] });
  });
  it("marks the block as background and clips excerpts to 300 chars", () => {
    const { block } = formatRecallBlock([{ path: "Notes/Pricing.md", excerpt: "p".repeat(900) }], []);
    expect(block.startsWith(RECALL_OPEN)).toBe(true);
    expect(block.endsWith(RECALL_CLOSE)).toBe(true);
    expect(block).toMatch(/NOT the current conversation/);
    const line = block.split("\n").find((l) => l.startsWith("- Notes/Pricing.md"))!;
    expect(line.length).toBeLessThanOrEqual("- Notes/Pricing.md: ".length + 300);
  });
  it("tells the model to cite what it relies on and to prefer a successor, once", () => {
    const { block } = formatRecallBlock([{ path: "Notes/Pricing.md", excerpt: "x" }], []);
    const rule = "When you rely on a recalled note, cite it as [[Note]]. If you use a note marked superseded, cite its successor instead.";
    expect(block.split(rule)).toHaveLength(2);
    expect(block.indexOf(rule)).toBeLessThan(block.indexOf("Notes:"));
    // chat-only blocks carry it too: the header is shared
    expect(formatRecallBlock([], [{ id: "t", title: "T", date: "2026-09-20", snippet: "s", msgIndex: 0 }]).block).toContain(rule);
  });
  it("keeps at most 5 notes and 2 chats, and the whole block within 2000 chars", () => {
    const notes = Array.from({ length: 8 }, (_, i) => ({ path: `N/${i}.md`, excerpt: "e".repeat(300) }));
    const past = Array.from({ length: 4 }, (_, i) => ({
      id: `t${i}`,
      title: `T${i}`,
      date: "2026-09-20",
      snippet: "s".repeat(300),
      msgIndex: 0,
    }));
    const { block } = formatRecallBlock(notes, past);
    expect(block.length).toBeLessThanOrEqual(RECALL_MAX_CHARS);
    expect((block.match(/^- N\//gm) ?? []).length).toBeLessThanOrEqual(5);
    expect((block.match(/^- "T/gm) ?? []).length).toBeLessThanOrEqual(2);
  });
  it("returns the notes whose line is in the block: the ones the cap dropped are not", () => {
    const notes = Array.from({ length: 5 }, (_, i) => ({ path: `Knowledge/${"deep/".repeat(18)}N${i}.md`, excerpt: "e".repeat(300) }));
    const { block, notes: shown } = formatRecallBlock(notes, []);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(5);
    expect(shown).toEqual(notes.slice(0, shown.length));
    for (const n of notes) expect(block.includes(`- ${n.path}:`)).toBe(shown.includes(n));
    // chats go first, so a block that fits once they are dropped keeps every note
    const chat = { id: "t", title: "T", date: "2026-09-20", snippet: "s".repeat(900), msgIndex: 0 };
    expect(formatRecallBlock(notes.slice(0, 2), [chat, chat]).notes).toEqual(notes.slice(0, 2));
  });
});

describe("rankRecall on single lanes (parity with the pre-extraction pipeline)", () => {
  const n = (path: string): NoteRecall => ({ path, excerpt: `about ${path}` });
  const before = (sonar: NoteRecall[], lexical: LexicalChat[]) => ({
    notes: sonar.slice(0, RECALL_MAX_NOTES),
    chats: lexical.slice(0, RECALL_MAX_CHATS).map(({ hits: _hits, ...chat }) => chat),
  });
  const lanes = (sonar: NoteRecall[], lexicalChats: LexicalChat[]) => ({ sonar, title: [], lexicalChats, semanticChats: null });
  const opts = { maxNotes: RECALL_MAX_NOTES, maxChats: RECALL_MAX_CHATS };

  it("keeps Sonar's order and the lexical chats as they were", () => {
    const sonar = ["B.md", "A.md", "C.md"].map(n);
    const lexical = matchPastChats(chats, ["pricing", "tiers", "launch"], { excludeId: "current", now: NOW }).map((c) => ({ ...c, hits: 3 }));
    expect(rankRecall(lanes(sonar, lexical), opts)).toEqual(before(sonar, lexical));
  });
  it("cuts a long Sonar lane to five notes", () => {
    const sonar = Array.from({ length: 9 }, (_, i) => n(`N/${9 - i}.md`));
    expect(rankRecall(lanes(sonar, []), opts)).toEqual(before(sonar, []));
  });
  it("chats alone when the vault search found nothing", () => {
    const lexical: LexicalChat[] = [1, 2, 3].map((i) => ({ id: `c${i}`, title: `T${i}`, date: "2026-10-01", snippet: "s", msgIndex: 0, hits: 3 }));
    expect(rankRecall(lanes([], lexical), opts)).toEqual(before([], lexical));
  });
});

describe("titleLane", () => {
  const lane = (keywords: string[], notes: ReturnType<typeof note>[], message = "") => titleLane(keywords, notes, message);
  const note = (path: string, aliases: string[] = []) => ({ path, basename: path.replace(/^.*\//, "").replace(/\.md$/, ""), aliases });

  it("a note the message names in full beats one that shares a single word", () => {
    const keywords = recallKeywords("Chi è Alberto Aspese e quanti eventi in calendario abbiamo avuto?");
    const notes = [note("Templates/Calendario.md"), note("CRM/People/Alberto Aspese.md"), note("CRM/People/Alberto Rossi.md")];
    expect(lane(keywords, notes)).toEqual([
      { path: "CRM/People/Alberto Aspese.md", shared: 2, whole: true, explicit: false },
      { path: "Templates/Calendario.md", shared: 1, whole: true, explicit: false },
    ]);
  });
  it("normalises diacritics and hyphens: open-core matches open core, città matches citta", () => {
    const keywords = recallKeywords("Che cosa è diventato Turno con il modello open core?");
    expect(lane(keywords, [note("D/2026-10-03-turno-saas-open-core.md")])).toEqual([{ path: "D/2026-10-03-turno-saas-open-core.md", shared: 3, whole: false, explicit: false }]);
    expect(lane(recallKeywords("parlami della nuova universita di citta alta"), [note("N/Università Città Alta.md")])).toEqual([
      { path: "N/Università Città Alta.md", shared: 3, whole: true, explicit: false },
    ]);
  });
  it("aliases count as names", () => {
    const keywords = recallKeywords("cosa sappiamo della Orchestration Board ormai?");
    expect(lane(keywords, [note("P/Board ideas v2.md", ["Orchestration Board"])])).toEqual([{ path: "P/Board ideas v2.md", shared: 2, whole: true, explicit: false }]);
  });
  it("one shared word with a longer name is not a title match", () => {
    expect(lane(recallKeywords("quale task manager uso adesso"), [note("R/Notes on everything task related.md")])).toEqual([]);
  });
  it("a 3-char name word counts once the message names it, so Exo is findable; the hit is marked short", () => {
    expect(lane(["exo"], [note("Companies/Exo.md")])).toEqual([{ path: "Companies/Exo.md", shared: 1, whole: true, short: true, explicit: false }]);
    expect(lane(["stato"], [note("Companies/Exo.md")])).toEqual([]);
  });
  it("a title hit is explicit when the message writes <name>.md or [[<name>, whatever the case", () => {
    const claude = note("CLAUDE.md");
    expect(lane(["claude"], [claude], "cosa dice il file CLAUDE.md?")[0].explicit).toBe(true);
    expect(lane(["claude"], [claude], "apri [[claude]] adesso")[0].explicit).toBe(true);
    expect(lane(["claude"], [claude], "apri [[Claude|il file]] adesso")[0].explicit).toBe(true);
    expect(lane(["claude"], [claude], "ask Claude to rewrite")[0].explicit).toBe(false);
  });
  it("a link marks the note explicit only when it ends the name: [[Open Core]] does not write out a note named Open", () => {
    const open = note("T/Open.md");
    expect(lane(["open"], [open], "leggi [[Open Core]] adesso")[0].explicit).toBe(false);
    expect(lane(["open"], [open], "leggi [[Open]] adesso")[0].explicit).toBe(true);
    expect(lane(["open"], [open], "leggi [[Open#Piani]] adesso")[0].explicit).toBe(true);
    expect(lane(["open"], [open], "leggi [[Open|il file]] adesso")[0].explicit).toBe(true);
  });
  it("a file name marks the note explicit only when it is the whole name: subagents.md does not write out a note named agents", () => {
    const agents = note("T/agents.md");
    expect(lane(["agents"], [agents], "controlla subagents.md adesso")[0].explicit).toBe(false);
    expect(lane(["agents"], [agents], "controlla agents.md adesso")[0].explicit).toBe(true);
    expect(lane(["agents"], [agents], "controlla (agents.md) adesso")[0].explicit).toBe(true);
    expect(lane(["agents"], [agents], "agents.md dice")[0].explicit).toBe(true);
    expect(lane(["agents"], [agents], "apri knowledge/agents.md")[0].explicit).toBe(true);
  });
  it("a hyphen or underscore before the file name joins it to a longer one: open-agents.md does not write out a note named agents", () => {
    const agents = note("T/agents.md");
    expect(lane(["agents"], [agents], "apri turno-open-agents.md adesso")[0].explicit).toBe(false);
    expect(lane(["agents"], [agents], "apri sub_agents.md adesso")[0].explicit).toBe(false);
  });
  it("a basename with regex characters is matched literally", () => {
    const cpp = note("T/C++ (guida).md");
    expect(lane(["guida", "c"], [cpp], "apri [[C++ (guida)]] ora")[0].explicit).toBe(true);
    expect(lane(["guida", "c"], [cpp], "apri C++ guida ora")[0].explicit).toBe(false);
  });
  it("every non-stopword 3-char word of a name counts in its coverage: 'win this deal' is not How to Win in the Ai Age", () => {
    expect(lane(["win", "deal"], [note("R/How to Win in the Ai Age.md")])).toEqual([]);
    expect(lane(["win", "age"], [note("R/How to Win in the Ai Age.md")])).toEqual([{ path: "R/How to Win in the Ai Age.md", shared: 2, whole: true, short: true, explicit: false }]);
  });
  it("a name with a 3-char word needs the message to name it too", () => {
    expect(lane(["companies"], [note("T/CRM Companies.md")])).toEqual([]);
    expect(lane(["crm", "companies"], [note("T/CRM Companies.md")])).toEqual([{ path: "T/CRM Companies.md", shared: 2, whole: true, explicit: false }]);
  });
  it("3-char stopwords in a name do not count: Guida per Exo is covered by guida + exo", () => {
    expect(lane(["guida", "exo"], [note("G/Guida per Exo.md")])).toEqual([{ path: "G/Guida per Exo.md", shared: 2, whole: true, explicit: false }]);
  });
  it("a project hub beats a same-named note that sorts before it", () => {
    const notes = [note("Companies/DeepAgent.md"), note("Projects/DeepAgent/DeepAgent.md"), note("Archive/DeepAgent.md")];
    expect(lane(["deepagent"], notes).map((h) => h.path)).toEqual([
      "Projects/DeepAgent/DeepAgent.md",
      "Archive/DeepAgent.md",
      "Companies/DeepAgent.md",
    ]);
  });
  it("without a hub the lane is unchanged: path order", () => {
    expect(lane(["deepagent"], [note("Z/DeepAgent.md"), note("A/DeepAgent.md")]).map((h) => h.path)).toEqual(["A/DeepAgent.md", "Z/DeepAgent.md"]);
  });
  it("a hub does not outrank a note the message names more fully", () => {
    const hits = lane(["bending", "spoons"], [note("Bending/Bending.md"), note("CRM/Bending Spoons.md")]);
    expect(hits.map((h) => h.path)).toEqual(["CRM/Bending Spoons.md", "Bending/Bending.md"]);
  });
  it("ties break by path, so the lane is deterministic", () => {
    const keywords = recallKeywords("parliamo di Bending Spoons domani mattina");
    expect(lane(keywords, [note("Z/Bending Spoons.md"), note("A/Bending Spoons.md")]).map((h) => h.path)).toEqual(["A/Bending Spoons.md", "Z/Bending Spoons.md"]);
  });
});

describe("rankRecall fusion", () => {
  const n = (path: string): NoteRecall => ({ path, excerpt: `about ${path}` });
  const c = (id: string, snippet = "s"): ChatRecall => ({ id, title: id, date: "2026-10-01", snippet, msgIndex: 0 });
  const lex = (id: string, hits: number, snippet = "s"): LexicalChat => ({ ...c(id, snippet), hits });
  const opts = { maxNotes: RECALL_MAX_NOTES, maxChats: RECALL_MAX_CHATS };

  it("a note found by two lanes outranks the note one lane ranked first", () => {
    const sonar = ["Top.md", "B.md", "C.md", "D.md", "E.md", "F.md", "Both.md"].map(n);
    const r = rankRecall({ sonar, title: [{ path: "Both.md", shared: 3, whole: false, explicit: false }], lexicalChats: [], semanticChats: null }, opts);
    expect(r.notes.map((x) => x.path)).toEqual(["Both.md", "Top.md", "B.md", "C.md", "D.md"]);
    expect(r.notes[0].excerpt).toBe("about Both.md");
  });
  it("equal scores break by path", () => {
    const r = rankRecall({ sonar: [n("Z.md")], title: [{ path: "A.md", shared: 2, whole: true, explicit: false }], lexicalChats: [], semanticChats: null }, opts);
    expect(r.notes.map((x) => x.path)).toEqual(["A.md", "Z.md"]);
  });
  it("a partial name match only confirms a note the vault search found; it never brings one in alone", () => {
    const sonar = ["S1.md", "S2.md", "S3.md", "S4.md", "S5.md"].map(n);
    const title = [
      { path: "Partial only.md", shared: 3, whole: false, explicit: false },
      { path: "S5.md", shared: 2, whole: false, explicit: false },
      { path: "Named in full.md", shared: 2, whole: true, explicit: false },
    ];
    const r = rankRecall({ sonar, title, lexicalChats: [], semanticChats: null }, opts);
    expect(r.notes.map((x) => x.path)).toEqual(["S5.md", "S1.md", "Named in full.md", "S2.md", "S3.md"]);
    expect(r.notes[2].excerpt).toBe("");
  });
  it("two words shared with a longer name reorder the notes the vault search would inject, never push one out", () => {
    const sonar = ["S1.md", "S2.md", "S3.md", "S4.md", "S5.md", "S6.md", "Deep.md"].map(n);
    const title = [{ path: "Deep.md", shared: 2, whole: false, explicit: false }];
    const r = rankRecall({ sonar, title, lexicalChats: [], semanticChats: null }, opts);
    expect(r.notes.map((x) => x.path)).toEqual(["S1.md", "S2.md", "S3.md", "S4.md", "S5.md"]);
  });
  it("a title match resting on a 3-char word alone needs the vault search to have found the note", () => {
    const hub = { path: "Projects/Exo/Exo.md", shared: 1, whole: true, short: true as const, explicit: false };
    expect(rankRecall({ sonar: [], title: [hub], lexicalChats: [], semanticChats: null }, opts).notes).toEqual([]);
    const deep = ["A", "B", "C", "D", "E", "F", "G", "Projects/Exo/Exo"].map((x) => n(`${x}.md`));
    expect(rankRecall({ sonar: deep, title: [hub], lexicalChats: [], semanticChats: null }, opts).notes[0].path).toBe("Projects/Exo/Exo.md");
  });
  it("an explicit reference needs no search hit even for a one-word name", () => {
    const hit = { path: "CLAUDE.md", shared: 1, whole: true, explicit: true };
    expect(rankRecall({ sonar: [], title: [hit], lexicalChats: [], semanticChats: null }, opts).notes.map((x) => x.path)).toEqual(["CLAUDE.md"]);
    const short = { path: "Companies/Exo.md", shared: 1, whole: true, short: true as const, explicit: true };
    expect(rankRecall({ sonar: [], title: [short], lexicalChats: [], semanticChats: null }, opts).notes.map((x) => x.path)).toEqual(["Companies/Exo.md"]);
  });
  it("a name of two words or more, all in the message, still comes in on its name alone", () => {
    const hit = { path: "CRM/People/Alberto Aspese.md", shared: 2, whole: true, explicit: false };
    expect(rankRecall({ sonar: [], title: [hit], lexicalChats: [], semanticChats: null }, opts).notes.map((x) => x.path)).toEqual(["CRM/People/Alberto Aspese.md"]);
  });
  it("a one-word name needs the vault search too, however long the word: 'Claude' in a prompt is not the CLAUDE note", () => {
    const hit = { path: "CLAUDE.md", shared: 1, whole: true, explicit: false };
    expect(rankRecall({ sonar: [], title: [hit], lexicalChats: [], semanticChats: null }, opts).notes).toEqual([]);
    expect(rankRecall({ sonar: [n("Turno Open Core.md"), n("CLAUDE.md")], title: [hit], lexicalChats: [], semanticChats: null }, opts).notes[0].path).toBe("CLAUDE.md");
  });
  it("a note in two lanes still beats a title-only hub", () => {
    const sonar = ["Companies/Exo.md"].map(n);
    const title = [
      { path: "Projects/Exo/Exo.md", shared: 1, whole: true, explicit: false },
      { path: "Companies/Exo.md", shared: 1, whole: true, explicit: false },
    ];
    const r = rankRecall({ sonar, title, lexicalChats: [], semanticChats: null }, opts);
    expect(r.notes.map((x) => x.path)).toEqual(["Companies/Exo.md", "Projects/Exo/Exo.md"]);
  });
  it("chats from both lanes are deduped by id, keeping the lexical snippet", () => {
    const r = rankRecall({ sonar: [], title: [], lexicalChats: [lex("x", 2, "lexical")], semanticChats: [c("y"), c("x", "semantic")] }, opts);
    expect(r.chats.map((x) => [x.id, x.snippet])).toEqual([["x", "lexical"], ["y", "s"]]);
  });
  it("still two chats at most", () => {
    const r = rankRecall({ sonar: [], title: [], lexicalChats: [lex("a", 2)], semanticChats: [c("a"), c("b"), c("d"), c("e")] }, opts);
    expect(r.chats).toHaveLength(2);
  });
});

describe("rankRecall chat gate", () => {
  const lexical = (id: string, hits: number): LexicalChat => ({ id, title: id, date: "2026-10-01", snippet: "lexical", msgIndex: 0, hits });
  const sem = (id: string): ChatRecall => ({ id, title: id, date: "2026-10-01", snippet: "semantic", msgIndex: 0 });
  const opts = { maxNotes: RECALL_MAX_NOTES, maxChats: RECALL_MAX_CHATS };
  const rank = (lexicalChats: LexicalChat[], semanticChats: ChatRecall[] | null) => rankRecall({ sonar: [], title: [], lexicalChats, semanticChats }, opts).chats;

  it("a lexical chat with 2 hits the semantic lane does not stand behind is dropped", () => {
    expect(rank([lexical("a", 2)], [sem("other")]).map((c) => c.id)).toEqual(["other"]);
  });
  it("even 3 hits do not rescue it while the semantic lane answered", () => {
    expect(rank([lexical("a", 3)], [])).toEqual([]);
  });
  it("a lexical chat the semantic lane stands behind is kept with 2 hits", () => {
    expect(rank([lexical("a", 2)], [sem("a")]).map((c) => c.id)).toEqual(["a"]);
  });
  it("semantic lane unavailable: 3 hits keep the chat", () => {
    expect(rank([lexical("a", 3)], null).map((c) => c.id)).toEqual(["a"]);
  });
  it("semantic lane unavailable: 2 hits drop it", () => {
    expect(rank([lexical("a", 2)], null)).toEqual([]);
  });
  it("a semantic-only chat is kept untouched", () => {
    expect(rank([], [sem("s")]).map((c) => c.id)).toEqual(["s"]);
  });
  it("a corroborated chat keeps its lexical snippet and loses the hit count", () => {
    const [chat] = rank([lexical("a", 2)], [sem("a")]);
    expect(chat).toEqual({ id: "a", title: "a", date: "2026-10-01", snippet: "lexical", msgIndex: 0 });
  });
});

describe("recallTurn", () => {
  const names = [
    { path: "Projects/Exo/Exo.md", basename: "Exo", aliases: [] },
    { path: "Companies/Exo.md", basename: "Exo", aliases: [] },
    { path: "R/How to Win in the Ai Age.md", basename: "How to Win in the Ai Age", aliases: [] },
    { path: "T/Win.md", basename: "Win", aliases: [] },
    { path: "CLAUDE.md", basename: "CLAUDE", aliases: [] },
  ];
  const hit = (path: string): NoteRecall => ({ path, excerpt: `about ${path}` });
  const base = { names, chats: [] as ChatRecord[], convoId: "x", now: NOW, search: () => Promise.resolve([] as NoteRecall[]), semantic: () => Promise.resolve(null) };

  it("is null for short messages, and for messages with no keyword, without reading anything", async () => {
    const search = vi.fn(() => Promise.resolve([]));
    const semantic = vi.fn(() => Promise.resolve(null));
    expect(await recallTurn({ ...base, message: "ok thanks", search, semantic })).toBeNull();
    expect(await recallTurn({ ...base, message: "come sono stato questo", search, semantic })).toBeNull();
    expect(search).not.toHaveBeenCalled();
    expect(semantic).not.toHaveBeenCalled();
  });
  it("the vocabulary comes from the names it is given: no Exo note, no exo keyword", async () => {
    const search = vi.fn(() => Promise.resolve([]));
    await recallTurn({ ...base, names: names.slice(2), message: "what is the status of Exo today", search });
    expect(search).toHaveBeenCalledWith("status today");
    expect(recallKeywords("what is the status of Exo today", nameVocab(names))).toEqual(["status", "exo", "today"]);
  });
  it("the project hub keeps its lead over the same-named company card when Sonar found both", async () => {
    const search = () => Promise.resolve([hit("Projects/Exo/Exo.md"), hit("Companies/Exo.md")]);
    const r = await recallTurn({ ...base, message: "what is the status of Exo today", search });
    expect(r!.notes.map((x) => x.path)).toEqual(["Projects/Exo/Exo.md", "Companies/Exo.md"]);
  });
  it("a short name alone injects nothing: Sonar must have found the note too", async () => {
    for (const message of ["how do we win this deal", "ask Claude to rewrite this paragraph"]) {
      const r = await recallTurn({ ...base, message });
      expect(r!.notes).toEqual([]);
      expect(r!.lanes.title.map((t) => t.path)).not.toContain("R/How to Win in the Ai Age.md");
    }
  });
  it("a note referenced as a file in the message comes in without the vault search: 'cosa dice il file CLAUDE.md?' injects it, 'ask Claude to rewrite this paragraph' does not", async () => {
    const named = await recallTurn({ ...base, message: "cosa dice il file CLAUDE.md?" });
    expect(named!.notes.map((x) => x.path)).toEqual(["CLAUDE.md"]);
    const linked = await recallTurn({ ...base, message: "riassumi [[claude]] per favore adesso" });
    expect(linked!.notes.map((x) => x.path)).toEqual(["CLAUDE.md"]);
    const loose = await recallTurn({ ...base, message: "ask Claude to rewrite this paragraph" });
    expect(loose!.notes).toEqual([]);
  });
  it("a search that throws leaves the chats and the title lane", async () => {
    const r = await recallTurn({ ...base, message: "what is the status of Exo today", search: () => Promise.reject(new Error("sonar down")) });
    expect(r!.notes).toEqual([]);
    expect(r!.lanes.sonar).toEqual([]);
  });
  it("a long message is searched in chunks, and a note found by more than one chunk leads", async () => {
    const msg = Array.from({ length: 20 }, (_, i) => `termine${String.fromCharCode(97 + i)}`).join(" ");
    const lanes: Record<string, NoteRecall[]> = {
      [msg.split(" ").slice(0, 7).join(" ")]: [hit("A.md"), hit("Shared.md")],
      [msg.split(" ").slice(7, 14).join(" ")]: [hit("B.md"), hit("Shared.md")],
      [msg.split(" ").slice(14).join(" ")]: [hit("C.md")],
    };
    const search = vi.fn((q: string) => Promise.resolve(lanes[q] ?? []));
    const r = await recallTurn({ ...base, message: msg, search });
    expect(search).toHaveBeenCalledTimes(3);
    expect(r!.notes.map((n) => n.path)).toEqual(["Shared.md", "A.md", "B.md", "C.md"]);
  });
  it("the fused lane is cut to the lane depth: a short name found only far down a later chunk is not 'found'", async () => {
    const filler = Array.from({ length: 12 }, (_, i) => `termine${String.fromCharCode(97 + i)}`).join(" ");
    const lane = (tag: string, last?: NoteRecall) => [...Array.from({ length: RECALL_LANE_DEPTH - 1 }, (_, i) => hit(`${tag}${i}.md`)), last ?? hit(`${tag}z.md`)];
    const lanes = [lane("a"), lane("b"), lane("c", hit("R/How to Win in the Ai Age.md"))];
    let n = 0;
    const r = await recallTurn({ ...base, message: `${filler} how do we win in the ai age`, search: () => Promise.resolve(lanes[n++ % 3]) });
    expect(r!.lanes.sonar).toHaveLength(RECALL_LANE_DEPTH);
    expect(r!.notes.map((x) => x.path)).not.toContain("R/How to Win in the Ai Age.md");
  });
  it("one chunk failing leaves the others", async () => {
    const msg = Array.from({ length: 20 }, (_, i) => `termine${String.fromCharCode(97 + i)}`).join(" ");
    const search = vi.fn((q: string) => (q.startsWith("terminea") ? Promise.reject(new Error("sonar down")) : Promise.resolve([hit("B.md")])));
    const r = await recallTurn({ ...base, message: msg, search });
    expect(r!.notes.map((n) => n.path)).toEqual(["B.md"]);
  });
  it("the title lane reads the whole message: a name past the tenth keyword counts once the search found the note too", async () => {
    const filler = Array.from({ length: 14 }, (_, i) => `termine${String.fromCharCode(97 + i)}`).join(" ");
    const note = "D/Turno SaaS Open Core.md";
    const withNames = [...names, { path: note, basename: "Turno SaaS Open Core", aliases: [] }];
    const message = `${filler} turno saas open core`;
    const found = await recallTurn({ ...base, names: withNames, message, search: () => Promise.resolve([hit(note)]) });
    expect(found!.lanes.title.map((t) => t.path)).toContain(note);
    expect(found!.notes.map((n) => n.path)).toEqual([note]);
  });
  it("a long message names notes by chance: a name the search did not find is dropped, unless the message writes it out; a short one keeps it", async () => {
    const filler = Array.from({ length: 14 }, (_, i) => `termine${String.fromCharCode(97 + i)}`).join(" ");
    const withNames = [...names, { path: "D/Open Core.md", basename: "Open Core", aliases: [] }];
    const long = await recallTurn({ ...base, names: withNames, message: `${filler} open core` });
    expect(long!.lanes.title).toEqual([]);
    expect(long!.notes).toEqual([]);
    const written = await recallTurn({ ...base, names: withNames, message: `${filler} leggi [[open core]]` });
    expect(written!.notes.map((n) => n.path)).toEqual(["D/Open Core.md"]);
    const short = await recallTurn({ ...base, names: withNames, message: "cosa dice open core" });
    expect(short!.notes.map((n) => n.path)).toEqual(["D/Open Core.md"]);
  });
  it("a name inside the first ten keywords comes in on its name alone however long the message gets: no cliff at the eleventh keyword", async () => {
    const filler = Array.from({ length: 14 }, (_, i) => `termine${String.fromCharCode(97 + i)}`).join(" ");
    const withNames = [...names, { path: "D/Open Core.md", basename: "Open Core", aliases: [] }];
    const short = await recallTurn({ ...base, names: withNames, message: "cosa dice open core oggi" });
    const long = await recallTurn({ ...base, names: withNames, message: `cosa dice open core oggi ${filler}` });
    expect(short!.notes.map((n) => n.path)).toEqual(["D/Open Core.md"]);
    expect(long!.notes.map((n) => n.path)).toEqual(["D/Open Core.md"]);
  });
  it("chance names past the tenth keyword cannot push a name inside it out of the title lane", async () => {
    const filler = Array.from({ length: 14 }, (_, i) => `termine${String.fromCharCode(97 + i)}`);
    const chance = Array.from({ length: 21 }, (_, i) => ({ path: `F/${i}.md`, basename: `${filler[7 + (i % 7)]} ${filler[7 + ((i + 1) % 7)]}`, aliases: [] }));
    const withNames = [...names, ...chance, { path: "Z/Open Core.md", basename: "Open Core", aliases: [] }];
    const long = await recallTurn({ ...base, names: withNames, message: `cosa dice open core oggi ${filler.join(" ")}` });
    expect(long!.notes.map((n) => n.path)).toEqual(["Z/Open Core.md"]);
  });
  it("a name inside the first ten keywords keeps the hit those ten give: words past them neither weaken nor strengthen it", async () => {
    const filler = Array.from({ length: 14 }, (_, i) => `termine${String.fromCharCode(97 + i)}`).join(" ");
    const person = { path: "CRM/People/Alberto Aspese.md", basename: "Alberto Aspese", aliases: ["Alberto Aspese DeepAgent Sales"] };
    const kept = await recallTurn({ ...base, names: [...names, person], message: `cosa dice alberto aspese oggi ${filler} sales` });
    expect(kept!.notes.map((n) => n.path)).toEqual([person.path]);
    const ideas = { path: "D/Orchestration Board Ideas.md", basename: "Orchestration Board Ideas", aliases: [] };
    const partial = await recallTurn({ ...base, names: [...names, ideas], message: `orchestration board oggi ${filler} ideas` });
    expect(partial!.notes).toEqual([]);
  });
  it("past chats are still matched on the first ten keywords only", async () => {
    const chat: ChatRecord = { id: "c", title: "t", messages: [{ role: "user", text: "tardiva zeta tardiva zeta", at: NOW - DAY }] };
    const filler = Array.from({ length: 10 }, (_, i) => `termine${String.fromCharCode(97 + i)}`).join(" ");
    const r = await recallTurn({ ...base, chats: [chat], message: `${filler} tardiva zeta` });
    expect(r!.lanes.lexicalChats).toEqual([]);
  });
  it("computes the semantic hits once and gates the lexical chats on them", async () => {
    const old: ChatRecord = { id: "old", title: "Pricing history", messages: [{ role: "user", text: "how did pricing start", at: NOW - 300 * DAY }] };
    const flat = Array.from({ length: 10 }, (_, i) => ({ id: `noise${i}`, score: 0.8 }));
    const input = { ...base, chats: [...chats, old], convoId: "current", message: "what are the Exo pricing tiers" };
    const behind = await recallTurn({ ...input, semantic: () => Promise.resolve([{ id: "c1", score: 0.87 }, { id: "old", score: 0.88 }, ...flat]) });
    expect(behind!.chats.map((c) => c.id)).toEqual(["c1", "old"]);
    const elsewhere = await recallTurn({ ...input, semantic: () => Promise.resolve([{ id: "old", score: 0.88 }, ...flat]) });
    expect(elsewhere!.chats.map((c) => c.id)).toEqual(["old"]);
    const down = await recallTurn({ ...input, semantic: () => Promise.resolve(null) });
    expect(down!.chats.map((c) => c.id)).toEqual(["c1"]);
  });
});

describe("recallQueries", () => {
  const nums = (n: number, from = 0): string => Array.from({ length: n }, (_, i) => `parola${String.fromCharCode(97 + from + i)}`).join(" ");
  const none = new Set<string>();
  it("a message of ten keywords or fewer is one query, the same words recall always searched", () => {
    const msg = `cosa abbiamo deciso su ${nums(6)} ieri`;
    expect(recallQueries(msg, none)).toEqual([recallKeywords(msg, none).join(" ")]);
    expect(recallQueries(`mmm ${nums(10)}`, none)).toEqual([nums(10)]);
    expect(recallQueries("mmm", none)).toEqual([]);
  });
  it("a longer message is searched in near-equal chunks of at most eight keywords, three at most, so no word is drowned by the rest", () => {
    expect(recallQueries(`mmm ${nums(30)}`, none)).toEqual([nums(8), nums(8, 8), nums(8, 16)]);
    expect(recallQueries(`mmm ${nums(14)}`, none)).toEqual([nums(7), nums(7, 7)]);
  });
  it("never leaves a tail of one or two keywords: 17 keywords are 6, 6 and 5", () => {
    expect(recallQueries(`mmm ${nums(17)}`, none)).toEqual([nums(6), nums(6, 6), nums(5, 12)]);
    expect(recallQueries(`mmm ${nums(11)}`, none)).toEqual([nums(6), nums(5, 6)]);
  });
});

describe("rankRecall with superseded notes", () => {
  const n = (path: string): NoteRecall => ({ path, excerpt: `about ${path}` });
  const { index } = buildSupersedeIndex([
    { path: "D/2026-09-24-vault-lean.md", status: "active", supersedes: [], supersededBy: [] },
    { path: "D/2026-09-25-memoria.md", supersedes: ["D/2026-09-24-vault-lean.md"], supersededBy: [] },
  ]);
  const opts = { maxNotes: RECALL_MAX_NOTES, maxChats: RECALL_MAX_CHATS, supersede: index };
  const lanes = (sonar: NoteRecall[]) => ({ sonar, title: [], lexicalChats: [], semanticChats: null });

  it("the head takes the superseded note's slot; the old note stays right below, labelled", () => {
    const r = rankRecall(lanes(["D/2026-09-24-vault-lean.md", "A.md", "B.md", "C.md", "E.md"].map(n)), opts);
    expect(r.notes).toEqual([
      { path: "D/2026-09-25-memoria.md", excerpt: "" },
      { path: "D/2026-09-24-vault-lean.md", excerpt: "about D/2026-09-24-vault-lean.md", supersededBy: "D/2026-09-25-memoria.md" },
      n("A.md"),
      n("B.md"),
      n("C.md"),
    ]);
  });

  it("a head already recalled means label only", () => {
    const r = rankRecall(lanes(["D/2026-09-24-vault-lean.md", "A.md", "D/2026-09-25-memoria.md"].map(n)), opts);
    expect(r.notes.map((x) => [x.path, x.supersededBy])).toEqual([
      ["D/2026-09-24-vault-lean.md", "D/2026-09-25-memoria.md"],
      ["A.md", undefined],
      ["D/2026-09-25-memoria.md", undefined],
    ]);
  });

  it("the block tells the model which note to use instead", () => {
    const r = rankRecall(lanes([n("D/2026-09-24-vault-lean.md")]), opts);
    const { block } = formatRecallBlock(r.notes, []);
    expect(block).toContain("- D/2026-09-25-memoria.md\n");
    expect(block).toContain("- D/2026-09-24-vault-lean.md: about D/2026-09-24-vault-lean.md (superseded by 2026-09-25-memoria, use that)");
  });
});

describe("semanticHits", () => {
  const background = Array.from({ length: 10 }, (_, i) => ({ id: `bg${i}`, score: 0.82 - i * 0.001 }));

  it("keeps the chats that stand out from the rest of the index's answer", () => {
    const scored = [{ id: "a", score: 0.82 + RECALL_CHAT_MIN_LIFT + 0.01 }, { id: "b", score: 0.82 + RECALL_CHAT_MIN_LIFT + 0.005 }, ...background];
    expect(semanticHits(scored)).toEqual(["a", "b"]);
  });
  it("a flat answer (an ordinary prompt) keeps nothing, however high the raw scores", () => {
    const flat = Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, score: 0.87 - i * 0.001 }));
    expect(semanticHits(flat)).toEqual([]);
  });
  it("nothing in, nothing out", () => {
    expect(semanticHits([])).toEqual([]);
  });
});

describe("chatsFromIds", () => {
  const old: ChatRecord = {
    id: "old",
    title: "Equity talk",
    messages: [
      { role: "user", text: "report", at: NOW - 200 * DAY, auto: true },
      { role: "user", text: "Is equity the real   wealth multiplier?", at: NOW - 200 * DAY },
      { role: "assistant", segments: [{ t: "text", md: "Mostly." }] },
    ],
  };

  it("maps semantic ids to recalls at the first user message, with no time window", () => {
    expect(chatsFromIds(["old"], [old], { excludeId: "current" })).toEqual([
      { id: "old", title: "Equity talk", date: "2026-03-09", snippet: "Is equity the real wealth multiplier?", msgIndex: 1 },
    ]);
  });
  it("skips the current chat and ids the store no longer has", () => {
    expect(chatsFromIds(["current", "gone", "old"], [old, { ...old, id: "current" }], { excludeId: "current" }).map((x) => x.id)).toEqual(["old"]);
  });
});

describe("recallForTurn", () => {
  const app = (hits: { path: string; title: string; score: number; excerpt: string }[]) => {
    const calls: string[] = [];
    return {
      calls,
      app: {
        vault: { getMarkdownFiles: () => [] },
        metadataCache: { getFileCache: () => null },
        plugins: {
          plugins: {
            sonar: {
              search: async (q: string) => {
                calls.push(q);
                return hits;
              },
            },
          },
        },
      } as never,
    };
  };

  it("queries Sonar with the message keywords and injects notes + past chats", async () => {
    const { app: a, calls } = app([
      { path: "Notes/Pricing.md", title: "Pricing", score: 3, excerpt: "Pro is 29 euro" },
      { path: ".archive/Old.md", title: "Old", score: 2, excerpt: "hidden" },
    ]);
    const r = await recallForTurn(a, { message: "what are the Exo pricing tiers today", convoId: "current", chats, now: NOW });
    expect(calls[0]).toBe("pricing tiers today");
    expect(r!.notes).toEqual([{ path: "Notes/Pricing.md", excerpt: "Pro is 29 euro" }]);
    expect(r!.chats.map((c) => c.title)).toEqual(["Pricing call"]);
    expect(r!.block).toContain("- Notes/Pricing.md: Pro is 29 euro");
  });

  it("logs what it injected for the grounding eval: paths only, pointing at the user message just pushed", async () => {
    const written: Record<string, string> = {};
    const adapter = {
      getBasePath: () => "/v",
      exists: async (p: string) => p in written,
      read: async (p: string) => written[p],
      write: async (p: string, c: string) => {
        written[p] = c;
      },
    };
    const a = { ...(app([{ path: "Notes/Pricing.md", title: "Pricing", score: 3, excerpt: "Pro is 29 euro" }]).app as object), vault: { getMarkdownFiles: () => [], adapter } } as never;
    const r = await recallForTurn(a, { message: "what are the Exo pricing tiers today", convoId: "current", chats, now: NOW, pluginDir: "plug/exo" });
    expect(r).not.toBeNull();
    await vi.waitFor(() => expect(written["plug/exo/recall-log.json"]).toBeDefined());
    const log = JSON.parse(written["plug/exo/recall-log.json"]);
    // `current` holds one message, the user's: index 0
    expect(log).toEqual([{ convoId: "current", msgIndex: 0, userAt: NOW, at: NOW, notes: [{ path: "Notes/Pricing.md" }] }]);
    expect(written["plug/exo/recall-log.json"]).not.toContain("29 euro");
  });

  it("warns, and does not throw, when the log cannot be written", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapter = { getBasePath: () => "/v", exists: async () => false, read: async () => "", write: async () => Promise.reject(new Error("disk full")) };
    const a = { ...(app([{ path: "Notes/Pricing.md", title: "Pricing", score: 3, excerpt: "Pro" }]).app as object), vault: { getMarkdownFiles: () => [], adapter } } as never;
    const r = await recallForTurn(a, { message: "what are the Exo pricing tiers today", convoId: "current", chats, now: NOW, pluginDir: "plug/exo" });
    expect(r).not.toBeNull();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("[exo] recall log write failed", expect.any(Error)));
    warn.mockRestore();
  });

  it("logs nothing when only chats were recalled, or without a plugin folder", async () => {
    const written: Record<string, string> = {};
    const adapter = { getBasePath: () => "/v", exists: async () => false, read: async () => "", write: async (p: string, c: string) => void (written[p] = c) };
    const a = { ...(app([]).app as object), vault: { getMarkdownFiles: () => [], adapter } } as never;
    await recallForTurn(a, { message: "what are the Exo pricing tiers today", convoId: "current", chats, now: NOW, pluginDir: "plug/exo" });
    const b = { ...(app([{ path: "Notes/P.md", title: "P", score: 1, excerpt: "e" }]).app as object), vault: { getMarkdownFiles: () => [], adapter } } as never;
    await recallForTurn(b, { message: "what are the Exo pricing tiers today", convoId: "current", chats, now: NOW });
    await new Promise((r) => setTimeout(r, 20));
    expect(written).toEqual({});
  });

  it("skips short messages and slash commands without searching", async () => {
    const { app: a, calls } = app([]);
    expect(await recallForTurn(a, { message: "ok thanks", convoId: "x", chats, now: NOW })).toBeNull();
    expect(await recallForTurn(a, { message: "/compact the pricing tiers now", convoId: "x", chats, now: NOW })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("null when nothing matches anywhere", async () => {
    const { app: a } = app([]);
    expect(await recallForTurn(a, { message: "tell me about quantum gardening robots", convoId: "x", chats, now: NOW })).toBeNull();
  });

  const withVault = (a: object) => ({ ...(a as object), vault: { getMarkdownFiles: () => [], adapter: { getBasePath: () => "/v" } } }) as never;
  const semantic = vi.mocked(recallChatScores);
  afterEach(() => {
    semantic.mockReset();
    vi.useRealTimers();
  });

  it("adds the semantic chat lane: a chat outside the lexical window is recalled", async () => {
    const old: ChatRecord = { id: "old", title: "Pricing history", messages: [{ role: "user", text: "how did pricing start", at: NOW - 300 * DAY }] };
    const flat = Array.from({ length: 10 }, (_, i) => ({ id: `noise${i}`, score: 0.8 }));
    semantic.mockResolvedValue([{ id: "current", score: 0.9 }, { id: "old", score: 0.88 }, { id: "c1", score: 0.87 }, ...flat]);
    const r = await recallForTurn(withVault(app([]).app), { message: "what are the Exo pricing tiers", convoId: "current", chats: [...chats, old], now: NOW, pluginDir: ".obsidian/plugins/exo-agent" });
    expect(semantic).toHaveBeenCalledWith({ pluginDir: "/v/.obsidian/plugins/exo-agent", scriptPath: "/v/.obsidian/plugins/exo-agent/chat-recall.mjs" }, "what are the Exo pricing tiers", 12, expect.any(AbortSignal));
    expect(r!.chats.map((c) => c.id)).toEqual(["c1", "old"]);
  });

  it("a semantic lane past its budget leaves the lexical chats alone", async () => {
    vi.useFakeTimers();
    semantic.mockReturnValue(new Promise(() => {}));
    const pending = recallForTurn(withVault(app([]).app), { message: "what are the Exo pricing tiers", convoId: "current", chats, now: NOW, pluginDir: "p" });
    await vi.advanceTimersByTimeAsync(SEMANTIC_BUDGET_MS);
    // c1 shares two keywords only: without the semantic lane that is not enough.
    expect(await pending).toBeNull();
    // Giving up also stops the query: the subprocess is not left running.
    expect(semantic.mock.calls[0][3]!.aborted).toBe(true);
  });

  it("a semantic lane past its budget still lets a chat holding 3 rare keywords through", async () => {
    vi.useFakeTimers();
    semantic.mockReturnValue(new Promise(() => {}));
    const pending = recallForTurn(withVault(app([]).app), { message: "settle Exo pricing tiers today", convoId: "current", chats, now: NOW, pluginDir: "p" });
    await vi.advanceTimersByTimeAsync(SEMANTIC_BUDGET_MS);
    expect((await pending)!.chats.map((c) => c.id)).toEqual(["c1"]);
  });

  it("a semantic answer that does not stand behind the lexical chat drops it, even if it scored it", async () => {
    semantic.mockResolvedValue([...Array.from({ length: 11 }, (_, i) => ({ id: `n${i}`, score: 0.8 })), { id: "c1", score: 0.8 }]);
    const r = await recallForTurn(withVault(app([]).app), { message: "settle Exo pricing tiers today", convoId: "current", chats, now: NOW, pluginDir: "p" });
    expect(r).toBeNull();
  });

  it("a 3-char note name is a keyword: Exo is searched when a note is named Exo", async () => {
    const files = [{ path: "Projects/Exo/Exo.md", basename: "Exo" }];
    const base = app([{ path: "Projects/Exo/Exo.md", title: "Exo", score: 1, excerpt: "the Exo hub" }]);
    const a = { ...(base.app as object), vault: { getMarkdownFiles: () => files }, metadataCache: { getFileCache: () => null } } as never;
    const r = await recallForTurn(a, { message: "what is the status of Exo today", convoId: "x", chats: [], now: NOW });
    expect(base.calls[0]).toBe("status exo today");
    expect(r!.notes.map((x) => x.path)).toEqual(["Projects/Exo/Exo.md"]);
  });

  it("a semantic lane inside its budget is not aborted", async () => {
    semantic.mockResolvedValue([]);
    await recallForTurn(withVault(app([]).app), { message: "what are the Exo pricing tiers", convoId: "current", chats, now: NOW, pluginDir: "p" });
    expect(semantic.mock.calls[0][3]!.aborted).toBe(false);
  });

  it("no plugin dir, no semantic lane", async () => {
    await recallForTurn(app([]).app, { message: "what are the Exo pricing tiers", convoId: "current", chats, now: NOW });
    expect(semantic).not.toHaveBeenCalled();
  });

  it("the title lane comes from note names and aliases, minus excluded paths", async () => {
    const file = (path: string) => ({ path, basename: path.replace(/^.*\//, "").replace(/\.md$/, "") });
    const files = [file("Projects/Exo Pricing Tiers.md"), file(".archive/Exo Pricing Tiers.md"), file("Misc/Plan.md")];
    const a = {
      ...(app([]).app as object),
      vault: { getMarkdownFiles: () => files },
      metadataCache: { getFileCache: (f: { path: string }) => (f.path === "Misc/Plan.md" ? { frontmatter: { aliases: ["Pricing tiers"] } } : null) },
    } as never;
    const r = await recallForTurn(a, { message: "what are the Exo pricing tiers", convoId: "current", chats: [], now: NOW });
    // "exo" is a vault name here, so the note named Exo Pricing Tiers shares three words, the alias two.
    expect(r!.notes.map((x) => x.path)).toEqual(["Projects/Exo Pricing Tiers.md", "Misc/Plan.md"]);
  });

  it("reads supersede markers from frontmatter links and proposes the fix for a recalled note", async () => {
    const old = { path: "D/2026-09-24-vault-lean.md", basename: "2026-09-24-vault-lean" };
    const cur = { path: "D/2026-09-25-memoria.md", basename: "2026-09-25-memoria" };
    const appended: { candidate: unknown; source: { convoId: string; turnId: string } }[] = [];
    const refreshed: number[] = [];
    const exo = (enabled: boolean) => ({
      loadAutomationRuns: async () => [],
      runPlaybook: async () => true,
      settings: { proposalKernelEnabled: enabled },
      proposalStore: { append: async (candidate: unknown, source: { convoId: string; turnId: string }) => (appended.push({ candidate, source }), { status: "appended" }) },
      inbox: { refresh: async () => void refreshed.push(1) },
    });
    const a = (enabled: boolean) =>
      ({
        vault: {
          getMarkdownFiles: () => [old, cur],
          getAbstractFileByPath: (p: string) => (p === old.path ? Object.assign(new TFile(), old) : null),
          read: async () => "---\nstatus: active\n---\nLean vault.\n",
        },
        metadataCache: {
          getFileCache: (f: { path: string }) =>
            f.path === cur.path
              ? { frontmatter: { status: "active" }, frontmatterLinks: [{ key: "supersedes", link: "2026-09-24-vault-lean", original: "" }] }
              : { frontmatter: { status: "active" } },
          getFirstLinkpathDest: (link: string) => [old, cur].find((f) => f.basename === link) ?? null,
        },
        plugins: {
          plugins: {
            sonar: { search: async () => [{ path: old.path, title: "Vault lean", score: 3, excerpt: "lean vault" }] },
            "exo-agent": exo(enabled),
          },
        },
      }) as never;

    const r = await recallForTurn(a(true), { message: "what did we decide about the lean vault", convoId: "current", chats: [], now: NOW });
    expect(r!.notes.map((x) => [x.path, x.supersededBy])).toEqual([
      [cur.path, undefined],
      [old.path, cur.path],
    ]);
    await vi.waitFor(() => expect(refreshed).toHaveLength(1));
    expect(appended).toHaveLength(1);
    expect(appended[0].source).toMatchObject({ convoId: "current" });
    expect(appended[0].candidate).toMatchObject({
      kind: "correction",
      payload: { kind: "correction", path: old.path, change: { type: "frontmatter", set: { status: "superseded", superseded_by: "[[2026-09-25-memoria]]" }, before: { status: "status: active" } } },
    });

    appended.length = 0;
    await recallForTurn(a(false), { message: "what did we decide about the lean vault", convoId: "current", chats: [], now: NOW });
    await new Promise((res) => setTimeout(res, 0));
    expect(appended).toEqual([]);
  });

  it("a semantic answer with nothing standing out adds no chat and corroborates none", async () => {
    semantic.mockResolvedValue(Array.from({ length: 12 }, (_, i) => ({ id: i ? (i === 1 ? "c1" : `n${i}`) : "old", score: 0.86 })));
    const old: ChatRecord = { id: "old", title: "Old", messages: [{ role: "user", text: "anything", at: NOW - 300 * DAY }] };
    const r = await recallForTurn(withVault(app([]).app), { message: "what are the Exo pricing tiers", convoId: "current", chats: [...chats, old], now: NOW, pluginDir: "p" });
    expect(r).toBeNull();
  });
});

describe("indexNotes", () => {
  it("names with aliases for the title lane, supersede markers for the index", () => {
    const { names, supersede } = indexNotes([
      { path: "D/old.md", basename: "old", frontmatter: { status: "active", aliases: ["Lean vault"] }, links: [] },
      { path: "D/new.md", basename: "new", frontmatter: { status: "active" }, links: [{ key: "supersedes", target: "D/old.md" }] },
    ]);
    expect(names).toEqual([
      { path: "D/old.md", basename: "old", aliases: ["Lean vault"] },
      { path: "D/new.md", basename: "new", aliases: [] },
    ]);
    expect(supersede.index.successorOf("D/old.md")).toBe("D/new.md");
  });
});

describe("turn-recall layering", () => {
  it("the Obsidian adapter does not reach into the UI layer", () => {
    const src = readFileSync(join(__dirname, "..", "src", "obsidian", "turn-recall.ts"), "utf8");
    expect(src).not.toMatch(/from "\.\.\/ui\//);
  });
});
