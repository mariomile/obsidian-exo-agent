import { describe, it, expect } from "vitest";
import { chatLines, formatRecentChats, type ChatRecord } from "../src/core/recent-chats";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);

const chat = (over: Partial<ChatRecord>): ChatRecord => ({ id: "c1", title: "Chat", messages: [], ...over });

describe("chatLines", () => {
  it("skips Exo's own wake-up line: it is not something the user wrote", () => {
    const lines = chatLines([
      { role: "user", text: "research pricing", at: 1 },
      { role: "user", text: "A delegated task reported back.", at: 2, auto: true },
    ]);
    expect(lines.map((l) => l.text)).toEqual(["research pricing"]);
  });

  it("assistant messages inherit the previous message's timestamp", () => {
    const lines = chatLines([
      { role: "user", text: "q1", at: 100 },
      { role: "assistant", segments: [{ t: "text", md: "a1" }] },
      { role: "user", text: "q2", at: 200 },
      { role: "assistant", segments: [{ t: "text", md: "a2" }] },
    ]);
    expect(lines.map((l) => l.at)).toEqual([100, 100, 200, 200]);
  });

  it("keeps the assistant's FINAL text segment and its artifact paths", () => {
    const [, a] = chatLines([
      { role: "user", text: "write it", at: 1 },
      {
        role: "assistant",
        segments: [
          { t: "text", md: "Let me look." },
          { t: "tool", name: "Read", input: {}, ok: true, output: "..." },
          { t: "artifact", path: "Notes/Plan.md" },
          { t: "text", md: "Done: the plan is in Notes/Plan.md." },
        ],
      },
    ]);
    expect(a.text).toBe("Done: the plan is in Notes/Plan.md.");
    expect(a.artifacts).toEqual(["Notes/Plan.md"]);
  });

  it("messages before the first timestamp stay undated", () => {
    expect(chatLines([{ role: "user", text: "old" }, { role: "assistant", segments: [] }]).map((l) => l.at)).toEqual([
      undefined,
      undefined,
    ]);
  });
});

describe("formatRecentChats", () => {
  const recent = chat({
    id: "c1",
    title: "Pricing",
    messages: [
      { role: "user", text: "What should Pro cost?", at: NOW - DAY },
      { role: "assistant", segments: [{ t: "text", md: "29 euro a month." }, { t: "artifact", path: "Pricing.md" }] },
    ],
  });
  const old = chat({
    id: "c2",
    title: "Ancient",
    messages: [{ role: "user", text: "long ago", at: NOW - 30 * DAY }],
  });

  it("includes only chats with messages in the window, with title, date, user text, final answer and artifacts", () => {
    const out = formatRecentChats([old, recent], { days: 7, maxChars: 30_000, now: NOW });
    expect(out).toContain("## Pricing (2026-09-24)");
    expect(out).toContain("- User: What should Pro cost?");
    expect(out).toContain("- Exo: 29 euro a month.");
    expect(out).toContain("- Artifacts: Pricing.md");
    expect(out).not.toContain("Ancient");
  });

  it("lists the most recent chat first and marks archived ones", () => {
    const newer = chat({ id: "c3", title: "Newer", archived: true, messages: [{ role: "user", text: "hi there", at: NOW - 1000 }] });
    const out = formatRecentChats([recent, newer], { days: 7, maxChars: 30_000, now: NOW });
    expect(out.indexOf("Newer")).toBeLessThan(out.indexOf("Pricing"));
    expect(out).toContain("archived)");
  });

  it("clips to max_chars", () => {
    const big = chat({
      title: "Big",
      messages: Array.from({ length: 50 }, (_, i) => ({ role: "user" as const, text: `message ${i} ${"x".repeat(500)}`, at: NOW - 1000 })),
    });
    const out = formatRecentChats([big], { days: 7, maxChars: 2000, now: NOW });
    expect(out.length).toBeLessThanOrEqual(2000 + "\n…(clipped)".length);
    expect(out).toContain("…(clipped)");
  });

  it("says so when nothing is in the window", () => {
    expect(formatRecentChats([old], { days: 7, maxChars: 1000, now: NOW })).toBe("No conversations in the last 7 day(s).");
  });
});

describe("recent_chats tool", () => {
  it("reads the plugin's conversation store in-process and honours days", async () => {
    const { buildMemoryTools } = await import("../src/obsidian/memory-tools");
    const { memoryCaps } = await import("../src/core/memory-caps");
    const exo = {
      loadAutomationRuns: async () => [],
      runPlaybook: async () => true,
      readConversationStore: async (): Promise<ChatRecord[]> => [
        chat({ id: "a", title: "Yesterday", messages: [{ role: "user", text: "hello there", at: Date.now() - DAY }] }),
        chat({ id: "b", title: "Last month", messages: [{ role: "user", text: "old", at: Date.now() - 30 * DAY }] }),
      ],
    };
    const app = { plugins: { plugins: { "exo-agent": exo } } } as never;
    const caps = memoryCaps(
      { memoryReadEnabled: true, memoryWriteEnabled: false, agentFolderEnabled: false, autoMemory: true, backgroundPassesEnabled: true },
      { surface: "headless" },
    );
    const tools = buildMemoryTools(app, caps);
    expect(tools.map((t) => t.name)).toEqual(["recent_chats", "search_chats"]); // headless: read tools only
    const handler = (tools[0] as unknown as { handler: (a: unknown, e: unknown) => Promise<{ content: { text: string }[] }> }).handler;
    const week = (await handler({}, {})).content[0].text;
    expect(week).toContain("Yesterday");
    expect(week).not.toContain("Last month");
    expect((await handler({ days: 60 }, {})).content[0].text).toContain("Last month");
  });
});
