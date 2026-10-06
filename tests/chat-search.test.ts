import { describe, it, expect } from "vitest";
import { findInChat, formatChatHits, searchChats, snippetAround } from "../src/core/chat-search";
import { buildChatList, type ChatRowSource } from "../src/core/chat-rows";

const text = (md: string) => ({ role: "assistant" as const, segments: [{ t: "text" as const, md }] });
const tool = () => ({
  role: "assistant" as const,
  segments: [{ t: "tool" as const, name: "Bash", input: { command: "grep pricing" }, ok: true, output: "pricing.md" }],
});
const chat = (id: string, messages: Parameters<typeof findInChat>[0]["messages"], over = {}) => ({
  id,
  title: `Chat ${id}`,
  messages,
  updatedAt: 1,
  ...over,
});

describe("findInChat", () => {
  it("finds what the user wrote and what Exo concluded, never tool output", () => {
    expect(findInChat(chat("a", [{ role: "user", text: "help me with pricing" }]), "pricing")?.source).toBe("user");
    expect(findInChat(chat("b", [{ role: "user", text: "hi" }, text("The value metric drives pricing.")]), "pricing")?.source)
      .toBe("assistant");
    expect(findInChat(chat("c", [{ role: "user", text: "hi" }, tool()]), "pricing")).toBeNull();
  });

  it("starts at two characters", () => {
    expect(findInChat(chat("a", [{ role: "user", text: "x marks" }]), "x")).toBeNull();
    expect(findInChat(chat("a", [{ role: "user", text: "xy marks" }]), "xy")).not.toBeNull();
  });

  it("prefers a user message over an answer, the newest of each", () => {
    const hit = findInChat(
      chat("a", [{ role: "user", text: "old ask about Sendcloud" }, text("Sendcloud answer"), { role: "user", text: "new Sendcloud ask" }]),
      "sendcloud",
    );
    expect(hit?.snippet).toBe("new Sendcloud ask");
  });

  it("matches every word in any order, without accents", () => {
    expect(findInChat(chat("a", [{ role: "user", text: "GBrain di Garry Tan, però" }]), "garry gbrain pero")).not.toBeNull();
    expect(findInChat(chat("a", [{ role: "user", text: "GBrain" }]), "gbrain garry")).toBeNull();
  });
});

describe("snippetAround", () => {
  it("cuts long lines around the match with ellipses", () => {
    const long = `${"a ".repeat(200)}needle ${"b ".repeat(200)}`;
    const s = snippetAround(long, "needle");
    expect(s).toContain("needle");
    expect(s.startsWith("…")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
    expect(s.length).toBeLessThanOrEqual(242);
  });
});

describe("searchChats", () => {
  it("ranks user hits before answers, newest chat first, one hit per chat", () => {
    const hits = searchChats(
      [
        chat("ans", [{ role: "user", text: "q" }, text("about kore")], { updatedAt: 9 }),
        chat("old", [{ role: "user", text: "kore naming" }], { updatedAt: 1 }),
        chat("new", [{ role: "user", text: "kore pricing" }, text("kore")], { updatedAt: 5 }),
      ],
      "kore",
    );
    expect(hits.map((h) => h.id)).toEqual(["new", "old", "ans"]);
    expect(formatChatHits(hits, "kore")).toContain("id new");
    expect(formatChatHits([], "zz")).toBe('No chats match "zz".');
  });
});

describe("chats sidebar search looks inside the chat", () => {
  const src = (over: Partial<ChatRowSource>): ChatRowSource => ({
    id: "c1",
    title: "Untitled",
    preview: "hello",
    provider: "claude",
    model: "opus",
    updatedAt: 1000,
    archived: false,
    open: false,
    pinned: false,
    unseen: false,
    messageCount: 1,
    streaming: false,
    pendingPerm: false,
    pendingAsk: false,
    poisoned: false,
    stopped: false,
    hasMessages: true,
    ...over,
  });

  it("matches a chat by an answer deep in it, and shows the matching line as the preview", () => {
    const s = src({ messages: [{ role: "user", text: "hello" }, text("We settled on usage-based pricing.")] });
    const vm = buildChatList([s], { query: "usage based", now: 1000 });
    const row = vm.sections.flatMap((x) => x.items)[0];
    expect(row?.id).toBe("c1");
    expect(row?.preview).toBe("We settled on usage-based pricing.");
  });

  it("leaves the preview alone when the title or preview already matched", () => {
    const s = src({ title: "Pricing", messages: [{ role: "user", text: "pricing again" }] });
    const row = buildChatList([s], { query: "pricing", now: 1000 }).sections.flatMap((x) => x.items)[0];
    expect(row?.preview).toBe("hello");
  });
});
