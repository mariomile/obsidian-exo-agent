import { describe, it, expect, vi } from "vitest";
import type { App } from "obsidian";
import { buildObsidianTools } from "../src/obsidian/tools";
import { memoryCaps, type MemorySettings } from "../src/core/memory-caps";

const memory = (over: Partial<MemorySettings> = {}, readOnlySandbox = false) =>
  memoryCaps(
    {
      memoryReadEnabled: true,
      memoryWriteEnabled: true,
      agentFolderEnabled: false,
      autoMemory: true,
      backgroundPassesEnabled: true,
      ...over,
    },
    { surface: "chat", readOnlySandbox },
  );

const app = {} as App;
const names = (opts?: Parameters<typeof buildObsidianTools>[1]) =>
  buildObsidianTools(app, opts).map((t) => t.name);

const fakeStatus = {
  url: "u",
  title: "t",
  loading: false,
  scrollY: 0,
  scrollHeight: 0,
  viewportHeight: 0,
  ownerConvoId: null,
};
const fakeBrowserBridge = {
  open: async () => fakeStatus,
  navigate: async () => fakeStatus,
  snapshot: async () => ({ status: fakeStatus, elements: [] }),
  readPage: async () => ({ status: fakeStatus, text: "", total: 0 }),
  screenshot: async () => ({ status: fakeStatus, pngB64: "" }),
  click: async () => fakeStatus,
  type: async () => fakeStatus,
  scroll: async () => fakeStatus,
};

const BROWSER_TOOLS = [
  "browser_open",
  "browser_navigate",
  "browser_snapshot",
  "browser_read_page",
  "browser_screenshot",
  "browser_click",
  "browser_type",
  "browser_scroll",
];

describe("buildObsidianTools", () => {
  it("default build carries the full read+write set, including the memory tools", () => {
    const n = names({ memory: memory() });
    for (const t of ["search_vault", "read_note", "ask_user", "edit_note", "create_note", "recent_chats", "undo_memory_write", "open_loop"]) {
      expect(n, t).toContain(t);
    }
  });

  it("the old union-store tools are gone", () => {
    const n = names({ memory: memory() });
    for (const t of ["remember", "recall", "log_session", "capture_learning"]) expect(n, t).not.toContain(t);
  });

  it("memory write off drops the memory-write tools but keeps recent_chats", () => {
    const n = names({ memory: memory({ memoryWriteEnabled: false }) });
    for (const t of ["capture_decision", "open_loop", "close_loop", "undo_memory_write"]) {
      expect(n, t).not.toContain(t);
    }
    expect(n).toContain("recent_chats");
  });

  it("a read-only sandbox gets the read memory tools only", () => {
    const n = names({ memory: memory({}, true) });
    expect(n).toContain("recent_chats");
    expect(n).not.toContain("undo_memory_write");
    expect(n).not.toContain("capture_decision");
  });

  it("memory read off drops recent_chats", () => {
    expect(names({ memory: memory({ memoryReadEnabled: false }) })).not.toContain("recent_chats");
  });

  it("orchestrationEnabled gates add_task", () => {
    expect(names({ orchestrationEnabled: false })).not.toContain("add_task");
    expect(names({ orchestrationEnabled: true })).toContain("add_task");
  });

  it("rethink_memory needs memory write AND the agent folder AND a bridge", () => {
    const withFolder = memory({ agentFolderEnabled: true });
    expect(names({ memory: withFolder })).not.toContain("rethink_memory");
    expect(names({ memory: withFolder, rethinkBridge: async () => "" })).toContain("rethink_memory");
    expect(names({ memory: memory(), rethinkBridge: async () => "" })).not.toContain("rethink_memory");
  });

  it("browser tools register only when a bridge is present, byte-identical otherwise", () => {
    const off = names({});
    for (const t of BROWSER_TOOLS) expect(off, t).not.toContain(t);
    // Pre-feature call shape vs post-feature with no bridge: identical lists.
    expect(names({})).toEqual(names({ browserBridge: undefined }));
    const on = names({ browserBridge: fakeBrowserBridge });
    for (const t of BROWSER_TOOLS) expect(on, t).toContain(t);
    // The bridge adds the browser set and NOTHING else.
    expect(on.filter((n) => !n.startsWith("browser_"))).toEqual(off);
  });

  it("every tool exposes name, description, inputSchema, handler", () => {
    for (const t of buildObsidianTools(app)) {
      expect(typeof t.name).toBe("string");
      expect(typeof t.description).toBe("string");
      expect(t.inputSchema).toBeTruthy();
      expect(typeof t.handler).toBe("function");
    }
  });
});

describe("ask_user handler contract", () => {
  const QUESTIONS = {
    questions: [
      { question: "Which approach?", header: "Approach", options: [{ label: "A" }, { label: "B" }] },
    ],
  };
  type ToolResult = { isError?: boolean; content: Array<{ text?: string }> };
  const askUserOf = (opts?: Parameters<typeof buildObsidianTools>[1]) => {
    const t = buildObsidianTools(app, opts).find((x) => x.name === "ask_user");
    if (!t) throw new Error("ask_user not registered");
    return t as unknown as { handler: (args: unknown, extra: unknown) => Promise<ToolResult> };
  };

  it("returns the bridge's answers as JSON", async () => {
    const t = askUserOf({ askBridge: async () => ({ Approach: "A" }) });
    const res = await t.handler(QUESTIONS, {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toBe(JSON.stringify({ Approach: "A" }));
  });

  it("degrades to best-judgment guidance when no bridge is wired (headless)", async () => {
    const res = await askUserOf().handler(QUESTIONS, {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toMatch(/best judgment/i);
  });

  it("reports a dismissal (Stop / teardown) as a NORMAL result, never isError", async () => {
    // isError here would poison the Codex turn: the dismissal is guidance to
    // the model ("proceed"), not a failure.
    const t = askUserOf({
      askBridge: async () => {
        throw new Error("cancelled");
      },
    });
    const res = await t.handler(QUESTIONS, {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toMatch(/dismissed/i);
  });
});

describe("rethink_memory rationale rule", () => {
  type ToolResult = { isError?: boolean; content: Array<{ text?: string }> };
  function rethink(bridge: (req: unknown) => Promise<string>) {
    const tools = buildObsidianTools(app, {
      memory: memory({ agentFolderEnabled: true }),
      rethinkBridge: bridge,
    });
    const t = tools.find((x) => x.name === "rethink_memory");
    if (!t) throw new Error("rethink_memory not registered");
    return t as unknown as { handler: (args: unknown, extra: unknown) => Promise<ToolResult> };
  }

  it.each(["SOUL", "USER"])("refuses %s without a rationale and never calls the bridge", async (block) => {
    const bridge = vi.fn(async () => "Rewrote");
    const res = await rethink(bridge).handler({ block, new_content: "new" }, {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain(`${block}.md needs a rationale`);
    expect(bridge).not.toHaveBeenCalled();
  });

  it("treats a blank rationale as missing", async () => {
    const bridge = vi.fn(async () => "Rewrote");
    const res = await rethink(bridge).handler({ block: "USER", new_content: "new", rationale: "   " }, {});
    expect(res.isError).toBe(true);
    expect(bridge).not.toHaveBeenCalled();
  });

  it("writes SOUL and USER when a rationale is given", async () => {
    const bridge = vi.fn(async () => "Rewrote");
    const res = await rethink(bridge).handler({ block: "SOUL", new_content: "new", rationale: "shifted" }, {});
    expect(res.isError).toBeFalsy();
    expect(bridge).toHaveBeenCalledWith({ block: "SOUL", content: "new", rationale: "shifted" });
  });

  it("writes NOW without a rationale", async () => {
    const bridge = vi.fn(async () => "Rewrote NOW.md");
    const res = await rethink(bridge).handler({ block: "NOW", new_content: "new" }, {});
    expect(res.isError).toBeFalsy();
    expect(bridge).toHaveBeenCalledWith({ block: "NOW", content: "new" });
  });
});
