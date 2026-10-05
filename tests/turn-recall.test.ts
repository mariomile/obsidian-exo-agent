import { describe, it, expect } from "vitest";
import {
  formatRecallBlock,
  matchPastChats,
  recallKeywords,
  shouldRecall,
  RECALL_CLOSE,
  RECALL_MAX_CHARS,
  RECALL_OPEN,
} from "../src/core/turn-recall";
import { recallForTurn } from "../src/obsidian/turn-recall";
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
    expect(out).toEqual([{ title: "Pricing call", date: "2026-09-23", snippet: "Let's settle Exo pricing tiers today" }]);
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
    const past = Array.from({ length: 4 }, (_, i) => ({ title: `T${i}`, date: "2026-09-20", snippet: "s".repeat(300) }));
    const block = formatRecallBlock(notes, past);
    expect(block.length).toBeLessThanOrEqual(RECALL_MAX_CHARS);
    expect((block.match(/^- N\//gm) ?? []).length).toBeLessThanOrEqual(5);
    expect((block.match(/^- "T/gm) ?? []).length).toBeLessThanOrEqual(2);
  });
});

describe("recallForTurn", () => {
  const app = (hits: { path: string; title: string; score: number; excerpt: string }[]) => {
    const calls: string[] = [];
    return {
      calls,
      app: {
        vault: { getMarkdownFiles: () => [] },
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
});
