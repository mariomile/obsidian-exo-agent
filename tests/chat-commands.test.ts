import { describe, it, expect, beforeEach, vi } from "vitest";
import { Notice } from "obsidian";
import { registerChatCommands } from "../src/ui/chat-commands";
import type ExoPlugin from "../src/main";
import type { ChatRowSource } from "../src/core/chat-rows";

/** The command reaches the writer through `convo-bridge`, imported lazily so
 *  the registrations never pull `view.ts`. Stubbed here for the same reason:
 *  what is under test is what the command does with the answer. */
const bridge = vi.hoisted(() => ({
  settle: (): Promise<string | null> => Promise.resolve(null),
  known: new Set<string>(),
  opened: [] as [string, number | null][],
}));
vi.mock("../src/ui/convo-bridge", () => ({
  settleToNote: () => bridge.settle(),
  openChatAt: (_app: unknown, id: string, msg: number | null) => {
    if (!bridge.known.has(id)) return false;
    bridge.opened.push([id, msg]);
    return true;
  },
}));

/** A conversation as `listChatRows` reports it; every test overrides only what
 *  it is about. */
const src = (over: Partial<ChatRowSource> = {}): ChatRowSource => ({
  id: "c1",
  title: "Untitled",
  preview: "",
  provider: "claude",
  model: "opus",
  updatedAt: 1,
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

/** A conversation blocked on a permission prompt: still streaming, which is
 *  deriveLane's whole precedence rule. */
const blocked = (id: string, updatedAt: number): ChatRowSource =>
  src({ id, updatedAt, streaming: true, pendingPerm: true });

interface Harness {
  run: (id: string) => void;
  ids: string[];
  revealed: string[];
  protocols: Map<string, (params: Record<string, string>) => void>;
}

/** Register the commands against a stub plugin and hand back a way to fire one. */
function harness(rows: ChatRowSource[] | null, activeId: string | null): Harness {
  const commands = new Map<string, () => void>();
  const protocols = new Map<string, (params: Record<string, string>) => void>();
  const revealed: string[] = [];
  const plugin = {
    addCommand: (c: { id: string; callback: () => void }) => commands.set(c.id, c.callback),
    registerObsidianProtocolHandler: (action: string, h: (params: Record<string, string>) => void) =>
      protocols.set(action, h),
    listChatRows: () => rows,
    activeConvoId: () => activeId,
    revealConversation: (id: string) => {
      revealed.push(id);
      return Promise.resolve(true);
    },
    activateView: () => Promise.resolve(),
    activateChats: () => Promise.resolve(),
    backfillTitles: () => Promise.resolve(),
  } as unknown as ExoPlugin;
  registerChatCommands(plugin);
  return {
    run: (id) => commands.get(id)?.(),
    ids: [...commands.keys()],
    revealed,
    protocols,
  };
}

describe("registerChatCommands", () => {
  beforeEach(() => {
    Notice.last = "";
  });

  it("keeps the ids the two moved commands already had", () => {
    // Obsidian stores hotkeys BY ID: a rename here silently drops whatever the
    // user had bound. Exact list, not a `toContain`: a rename has to fail here,
    // and adding a command (as Phase 7's `settle-chat-to-note` did) is a
    // one-line, deliberate change to this array.
    expect(harness([], null).ids).toEqual([
      "open-chat-list",
      "search-chats",
      "schedule-prompt",
      "scheduled-prompts",
      "retitle-chat",
      "retitle-chats",
      "next-needs-you",
      "settle-chat-to-note",
    ]);
  });
});

describe("settling the active chat from the palette", () => {
  beforeEach(() => {
    Notice.last = "";
    bridge.settle = () => Promise.resolve(null);
  });

  it("names the note it wrote", async () => {
    bridge.settle = () => Promise.resolve("_exo/chats/Ship it.md");
    harness([], "c7").run("settle-chat-to-note");
    await vi.waitFor(() => expect(Notice.last).toBe("Settled to _exo/chats/Ship it.md"));
  });

  it("says the write failed instead of dropping it on the floor", async () => {
    // `vault.create`/`vault.modify` are unwrapped: "File already exists",
    // ENAMETOOLONG, EACCES, a read-only vault. Nothing was written, and a
    // command that reports nothing is indistinguishable from a broken one.
    // The row menu already says this; the palette must say the same.
    bridge.settle = () => Promise.reject(new Error("EACCES"));
    harness([], "c7").run("settle-chat-to-note");
    await vi.waitFor(() => expect(Notice.last).toBe("Couldn't write the note."));
  });

  it("refuses a chat that is not settled, and says why", async () => {
    harness([], "c7").run("settle-chat-to-note");
    await vi.waitFor(() => expect(Notice.last).toContain("Only a settled chat"));
  });
});

describe("the next-chat-needing-you key", () => {
  const cycle = (rows: ChatRowSource[] | null, activeId: string | null): string[] => {
    const h = harness(rows, activeId);
    h.run("next-needs-you");
    return h.revealed;
  };

  beforeEach(() => {
    Notice.last = "";
  });

  it("goes to the blocked chat when you are somewhere else entirely", () => {
    expect(cycle([blocked("a", 2), src({ id: "quiet", updatedAt: 3 })], "quiet")).toEqual(["a"]);
  });

  it("moves to the next blocked chat and wraps around", () => {
    const rows = [blocked("new", 3), blocked("mid", 2), blocked("old", 1)];
    // Newest first, the blocked queue's order.
    expect(cycle(rows, "new")).toEqual(["mid"]);
    expect(cycle(rows, "mid")).toEqual(["old"]);
    expect(cycle(rows, "old")).toEqual(["new"]);
  });

  it("says so instead of doing nothing when nothing is waiting", () => {
    expect(cycle([src({ id: "quiet", streaming: true })], "quiet")).toEqual([]);
    expect(Notice.last).toContain("nothing is waiting");
  });

  it("skips a chat that is merely running", () => {
    // Running is not blocked: the key is for work that cannot continue.
    expect(cycle([src({ id: "busy", streaming: true, updatedAt: 5 }), blocked("a", 1)], null))
      .toEqual(["a"]);
  });

  it("opens Exo rather than reporting an empty queue when nothing is mounted", () => {
    // `null` means no ChatView, not "no chats" — reporting an empty queue there
    // would be a lie about data that exists.
    const h = harness(null, null);
    h.run("next-needs-you");
    expect(h.revealed).toEqual([]);
    expect(Notice.last).toBe("");
  });
});

describe("the exo-chat link", () => {
  beforeEach(() => {
    Notice.last = "";
    bridge.known = new Set(["c7"]);
    bridge.opened = [];
  });
  const open = (params: Record<string, string>): void => {
    const handler = harness([], null).protocols.get("exo-chat");
    expect(handler).toBeDefined();
    handler!({ action: "exo-chat", ...params });
  };

  it("opens the chat at the linked message", async () => {
    open({ id: "c7", msg: "4" });
    await vi.waitFor(() => expect(bridge.opened).toEqual([["c7", 4]]));
    expect(Notice.last).toBe("");
  });

  it("opens the chat without a message index when the link has none", async () => {
    open({ id: "c7" });
    await vi.waitFor(() => expect(bridge.opened).toEqual([["c7", null]]));
  });

  it("says so when the chat no longer exists", async () => {
    open({ id: "gone", msg: "1" });
    await vi.waitFor(() => expect(Notice.last).toBe("Chat not found. It may have been deleted."));
    expect(bridge.opened).toEqual([]);
  });

  it("says so for a link without an id", async () => {
    open({ msg: "1" });
    await vi.waitFor(() => expect(Notice.last).toBe("Chat not found. It may have been deleted."));
  });
});
