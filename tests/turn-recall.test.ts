import { describe, it, expect, vi, afterEach } from "vitest";
import {
  chatsFromIds,
  formatRecallBlock,
  matchPastChats,
  rankRecall,
  recallKeywords,
  semanticHits,
  shouldRecall,
  titleLane,
  RECALL_CHAT_MIN_LIFT,
  RECALL_CLOSE,
  RECALL_MAX_CHARS,
  RECALL_MAX_CHATS,
  RECALL_MAX_NOTES,
  RECALL_OPEN,
  type ChatRecall,
  type NoteRecall,
} from "../src/core/turn-recall";
import { recallForTurn, SEMANTIC_BUDGET_MS } from "../src/obsidian/turn-recall";
import { recallChatScores } from "../src/ui/chat-recall";

vi.mock("../src/ui/chat-recall", () => ({
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
      { id: "c1", title: "Pricing call", date: "2026-09-23", snippet: "Let's settle Exo pricing tiers today", msgIndex: 0 },
    ]);
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
    expect(formatRecallBlock([], [])).toBe("");
  });
  it("marks the block as background and clips excerpts to 300 chars", () => {
    const block = formatRecallBlock([{ path: "Notes/Pricing.md", excerpt: "p".repeat(900) }], []);
    expect(block.startsWith(RECALL_OPEN)).toBe(true);
    expect(block.endsWith(RECALL_CLOSE)).toBe(true);
    expect(block).toMatch(/NOT the current conversation/);
    const line = block.split("\n").find((l) => l.startsWith("- Notes/Pricing.md"))!;
    expect(line.length).toBeLessThanOrEqual("- Notes/Pricing.md: ".length + 300);
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
    const block = formatRecallBlock(notes, past);
    expect(block.length).toBeLessThanOrEqual(RECALL_MAX_CHARS);
    expect((block.match(/^- N\//gm) ?? []).length).toBeLessThanOrEqual(5);
    expect((block.match(/^- "T/gm) ?? []).length).toBeLessThanOrEqual(2);
  });
});

describe("rankRecall on single lanes (parity with the pre-extraction pipeline)", () => {
  const n = (path: string): NoteRecall => ({ path, excerpt: `about ${path}` });
  const before = (sonar: NoteRecall[], lexical: ChatRecall[]) => ({
    notes: sonar.slice(0, RECALL_MAX_NOTES),
    chats: lexical.slice(0, RECALL_MAX_CHATS),
  });
  const lanes = (sonar: NoteRecall[], lexicalChats: ChatRecall[]) => ({ sonar, title: [], lexicalChats, semanticChats: null });
  const opts = { maxNotes: RECALL_MAX_NOTES, maxChats: RECALL_MAX_CHATS };

  it("keeps Sonar's order and the lexical chats as they were", () => {
    const sonar = ["B.md", "A.md", "C.md"].map(n);
    const lexical = matchPastChats(chats, ["pricing", "tiers", "launch"], { excludeId: "current", now: NOW });
    expect(rankRecall(lanes(sonar, lexical), opts)).toEqual(before(sonar, lexical));
  });
  it("cuts a long Sonar lane to five notes", () => {
    const sonar = Array.from({ length: 9 }, (_, i) => n(`N/${9 - i}.md`));
    expect(rankRecall(lanes(sonar, []), opts)).toEqual(before(sonar, []));
  });
  it("chats alone when the vault search found nothing", () => {
    const lexical: ChatRecall[] = [1, 2, 3].map((i) => ({ id: `c${i}`, title: `T${i}`, date: "2026-10-01", snippet: "s", msgIndex: 0 }));
    expect(rankRecall(lanes([], lexical), opts)).toEqual(before([], lexical));
  });
});

describe("titleLane", () => {
  const note = (path: string, aliases: string[] = []) => ({ path, basename: path.replace(/^.*\//, "").replace(/\.md$/, ""), aliases });

  it("a note the message names in full beats one that shares a single word", () => {
    const keywords = recallKeywords("Chi è Alberto Aspese e quanti eventi in calendario abbiamo avuto?");
    const notes = [note("Templates/Calendario.md"), note("CRM/People/Alberto Aspese.md"), note("CRM/People/Alberto Rossi.md")];
    expect(titleLane(keywords, notes)).toEqual([
      { path: "CRM/People/Alberto Aspese.md", shared: 2, whole: true },
      { path: "Templates/Calendario.md", shared: 1, whole: true },
    ]);
  });
  it("normalises diacritics and hyphens: open-core matches open core, città matches citta", () => {
    const keywords = recallKeywords("Che cosa è diventato Turno con il modello open core?");
    expect(titleLane(keywords, [note("D/2026-10-03-turno-saas-open-core.md")])).toEqual([{ path: "D/2026-10-03-turno-saas-open-core.md", shared: 3, whole: false }]);
    expect(titleLane(recallKeywords("parlami della nuova universita di citta alta"), [note("N/Università Città Alta.md")])).toEqual([
      { path: "N/Università Città Alta.md", shared: 3, whole: true },
    ]);
  });
  it("aliases count as names", () => {
    const keywords = recallKeywords("cosa sappiamo della Orchestration Board ormai?");
    expect(titleLane(keywords, [note("P/Board ideas v2.md", ["Orchestration Board"])])).toEqual([{ path: "P/Board ideas v2.md", shared: 2, whole: true }]);
  });
  it("one shared word with a longer name is not a title match", () => {
    expect(titleLane(recallKeywords("quale task manager uso adesso"), [note("R/Notes on everything task related.md")])).toEqual([]);
  });
  it("ties break by path, so the lane is deterministic", () => {
    const keywords = recallKeywords("parliamo di Bending Spoons domani mattina");
    expect(titleLane(keywords, [note("Z/Bending Spoons.md"), note("A/Bending Spoons.md")]).map((h) => h.path)).toEqual(["A/Bending Spoons.md", "Z/Bending Spoons.md"]);
  });
});

describe("rankRecall fusion", () => {
  const n = (path: string): NoteRecall => ({ path, excerpt: `about ${path}` });
  const c = (id: string, snippet = "s"): ChatRecall => ({ id, title: id, date: "2026-10-01", snippet, msgIndex: 0 });
  const opts = { maxNotes: RECALL_MAX_NOTES, maxChats: RECALL_MAX_CHATS };

  it("a note found by two lanes outranks the note one lane ranked first", () => {
    const sonar = ["Top.md", "B.md", "C.md", "D.md", "E.md", "F.md", "Both.md"].map(n);
    const r = rankRecall({ sonar, title: [{ path: "Both.md", shared: 3, whole: false }], lexicalChats: [], semanticChats: null }, opts);
    expect(r.notes.map((x) => x.path)).toEqual(["Both.md", "Top.md", "B.md", "C.md", "D.md"]);
    expect(r.notes[0].excerpt).toBe("about Both.md");
  });
  it("equal scores break by path", () => {
    const r = rankRecall({ sonar: [n("Z.md")], title: [{ path: "A.md", shared: 1, whole: true }], lexicalChats: [], semanticChats: null }, opts);
    expect(r.notes.map((x) => x.path)).toEqual(["A.md", "Z.md"]);
  });
  it("a partial name match only confirms a note the vault search found; it never brings one in alone", () => {
    const sonar = ["S1.md", "S2.md", "S3.md", "S4.md", "S5.md"].map(n);
    const title = [
      { path: "Partial only.md", shared: 3, whole: false },
      { path: "S5.md", shared: 2, whole: false },
      { path: "Named in full.md", shared: 2, whole: true },
    ];
    const r = rankRecall({ sonar, title, lexicalChats: [], semanticChats: null }, opts);
    expect(r.notes.map((x) => x.path)).toEqual(["S5.md", "S1.md", "Named in full.md", "S2.md", "S3.md"]);
    expect(r.notes[2].excerpt).toBe("");
  });
  it("two words shared with a longer name reorder the notes the vault search would inject, never push one out", () => {
    const sonar = ["S1.md", "S2.md", "S3.md", "S4.md", "S5.md", "S6.md", "Deep.md"].map(n);
    const title = [{ path: "Deep.md", shared: 2, whole: false }];
    const r = rankRecall({ sonar, title, lexicalChats: [], semanticChats: null }, opts);
    expect(r.notes.map((x) => x.path)).toEqual(["S1.md", "S2.md", "S3.md", "S4.md", "S5.md"]);
  });
  it("chats from both lanes are deduped by id, keeping the lexical snippet", () => {
    const r = rankRecall({ sonar: [], title: [], lexicalChats: [c("x", "lexical")], semanticChats: [c("y"), c("x", "semantic")] }, opts);
    expect(r.chats.map((x) => [x.id, x.snippet])).toEqual([["x", "lexical"], ["y", "s"]]);
  });
  it("still two chats at most", () => {
    const r = rankRecall({ sonar: [], title: [], lexicalChats: [c("a")], semanticChats: [c("b"), c("d"), c("e")] }, opts);
    expect(r.chats).toHaveLength(2);
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
    const r = await recallForTurn(a, { message: "what are the Exo pricing tiers", convoId: "current", chats, now: NOW });
    expect(calls[0]).toBe("pricing tiers");
    expect(r!.notes).toEqual([{ path: "Notes/Pricing.md", excerpt: "Pro is 29 euro" }]);
    expect(r!.chats.map((c) => c.title)).toEqual(["Pricing call"]);
    expect(r!.block).toContain("- Notes/Pricing.md: Pro is 29 euro");
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

  const withVault = (a: object) => ({ ...(a as object), vault: { getMarkdownFiles: () => [], adapter: { basePath: "/v" } } }) as never;
  const semantic = vi.mocked(recallChatScores);
  afterEach(() => {
    semantic.mockReset();
    vi.useRealTimers();
  });

  it("adds the semantic chat lane: a chat outside the lexical window is recalled", async () => {
    const old: ChatRecord = { id: "old", title: "Pricing history", messages: [{ role: "user", text: "how did pricing start", at: NOW - 300 * DAY }] };
    const flat = Array.from({ length: 10 }, (_, i) => ({ id: `noise${i}`, score: 0.8 }));
    semantic.mockResolvedValue([{ id: "current", score: 0.9 }, { id: "old", score: 0.88 }, ...flat]);
    const r = await recallForTurn(withVault(app([]).app), { message: "what are the Exo pricing tiers", convoId: "current", chats: [...chats, old], now: NOW, pluginDir: ".obsidian/plugins/exo-agent" });
    expect(semantic).toHaveBeenCalledWith({ pluginDir: "/v/.obsidian/plugins/exo-agent", scriptPath: "/v/.obsidian/plugins/exo-agent/chat-recall.mjs" }, "what are the Exo pricing tiers", 12);
    expect(r!.chats.map((c) => c.id)).toEqual(["c1", "old"]);
  });

  it("a semantic lane past its budget leaves the lexical chats alone", async () => {
    vi.useFakeTimers();
    semantic.mockReturnValue(new Promise(() => {}));
    const pending = recallForTurn(withVault(app([]).app), { message: "what are the Exo pricing tiers", convoId: "current", chats, now: NOW, pluginDir: "p" });
    await vi.advanceTimersByTimeAsync(SEMANTIC_BUDGET_MS);
    const r = await pending;
    expect(r!.chats.map((c) => c.id)).toEqual(["c1"]);
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
    expect(r!.notes.map((x) => x.path)).toEqual(["Misc/Plan.md", "Projects/Exo Pricing Tiers.md"]);
  });

  it("a semantic answer with nothing standing out adds no chat", async () => {
    semantic.mockResolvedValue(Array.from({ length: 12 }, (_, i) => ({ id: i ? `n${i}` : "old", score: 0.86 })));
    const old: ChatRecord = { id: "old", title: "Old", messages: [{ role: "user", text: "anything", at: NOW - 300 * DAY }] };
    const r = await recallForTurn(withVault(app([]).app), { message: "what are the Exo pricing tiers", convoId: "current", chats: [...chats, old], now: NOW, pluginDir: "p" });
    expect(r!.chats.map((c) => c.id)).toEqual(["c1"]);
  });
});
