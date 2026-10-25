import { describe, it, expect } from "vitest";
import { TFile } from "obsidian";
import { MemoryHarvester, type HarvestChat, type HarvesterDeps, type HarvestSource } from "../src/obsidian/memory-harvest";
import { HarvestLog } from "../src/obsidian/harvest-log";
import { memoryCaps } from "../src/core/memory-caps";
import { exoPaths } from "../src/core/paths";
import { WriteQueue } from "../src/core/write-queue";
import { HARVEST_IDLE_MS } from "../src/core/memory-harvest";

const NOW = Date.now();
const today = (() => {
  const d = new Date(NOW);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();

function fakeApp(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const tfile = (path: string) => Object.assign(new TFile(), { path, basename: path.split("/").pop()!.replace(/\.md$/, "") });
  const app = {
    vault: {
      getAbstractFileByPath: (p: string) => (files.has(p) ? tfile(p) : null),
      cachedRead: async (f: TFile) => files.get(f.path)!,
      read: async (f: TFile) => files.get(f.path)!,
      modify: async (f: TFile, c: string) => void files.set(f.path, c),
      process: async (f: TFile, fn: (c: string) => string) => {
        const next = fn(files.get(f.path)!);
        files.set(f.path, next);
        return next;
      },
      create: async (p: string, c: string) => void files.set(p, c),
      createFolder: async () => undefined,
      getMarkdownFiles: () => [],
      getConfig: () => [],
    },
    plugins: {
      plugins: {
        sonar: {
          search: async (q: string) =>
            q.includes("anna") ? [{ path: "CRM/People/Anna.md", title: "Anna", score: 2, excerpt: "Anna" }] : [],
        },
      },
    },
  };
  return { app, files };
}

const AGENTS = "# Contract\n## Memoria\n| persona | nota in `CRM/People/` |\n| inbox | `_exo/memory/inbox/AAAA-MM-GG.md` |\n## Mappa\n";

function setup(opts: {
  chats: HarvestChat[];
  replies: string[];
  budget?: boolean;
  git?: (args: string[]) => Promise<string>;
  source?: HarvestSource | null;
}) {
  const { app, files } = fakeApp({
    "AGENTS.md": AGENTS,
    "CRM/People/Anna.md": "# Anna\n## Work\n- Designer at Acme\n",
  });
  const marks: [string, number][] = [];
  const prompts: string[] = [];
  const notices: string[] = [];
  const logFile = { content: null as string | null };
  const source: HarvestSource = {
    chats: () => opts.chats,
    markHarvested: (id, index) => {
      marks.push([id, index]);
      const c = opts.chats.find((x) => x.id === id);
      if (c) c.harvestedIndex = index;
    },
  };
  const replies = [...opts.replies];
  const deps: HarvesterDeps = {
    app: app as never,
    caps: () =>
      memoryCaps(
        { memoryReadEnabled: true, memoryWriteEnabled: true, agentFolderEnabled: false, autoMemory: true, backgroundPassesEnabled: true },
        { surface: "chat" },
      ),
    paths: () => exoPaths("_exo"),
    source: () => (opts.source === undefined ? source : opts.source),
    utility: async (prompt) => {
      prompts.push(prompt);
      return { text: replies.shift() ?? "", tokens: 100 };
    },
    budget: { check: () => opts.budget !== false, record: () => undefined },
    writeQueue: new WriteQueue(),
    loopsWriteQueue: new WriteQueue(),
    git: () => opts.git ?? null,
    log: new HarvestLog({
      read: async () => logFile.content,
      write: async (c) => void (logFile.content = c),
    }),
    notify: (m) => void notices.push(m),
    diag: () => undefined,
  };
  return { harvester: new MemoryHarvester(deps), files, marks, prompts, notices, logFile, deps };
}

const chatWith = (over: Partial<HarvestChat> = {}): HarvestChat => ({
  id: "c1",
  title: "Team update",
  messages: [
    { role: "user", text: "Anna is now head of design at Acme, not a designer anymore", at: NOW - HARVEST_IDLE_MS - 5000 },
    { role: "assistant", segments: [{ t: "text", md: "Noted." }] },
  ],
  streaming: false,
  lastActivityAt: NOW - HARVEST_IDLE_MS - 5000,
  ...over,
});

const EXTRACT = JSON.stringify({
  facts: [{ kind: "person", statement: "Anna is head of design at Acme", entity: "Anna", evidence: "Anna is now head of design" }],
});
const DECIDE = JSON.stringify({
  decisions: [
    {
      op: "update",
      candidate: 0,
      path: "CRM/People/Anna.md",
      oldLine: "- Designer at Acme",
      newText: `Head of design at Acme (dal ${today}; prima Designer at Acme)`,
    },
  ],
});

describe("MemoryHarvester", () => {
  it("harvests an idle conversation end to end: extract, decide with context, apply, log, watermark", async () => {
    const chat = chatWith();
    const { harvester, files, marks, prompts, notices, logFile } = setup({ chats: [chat], replies: [EXTRACT, DECIDE] });
    await harvester.tick();
    expect(files.get("CRM/People/Anna.md")).toBe(`# Anna\n## Work\n- Head of design at Acme (dal ${today}; prima Designer at Acme) [fonte: chat "Team update" (obsidian://exo-chat?id=c1&msg=0)]\n`);
    expect(marks).toEqual([["c1", 2]]);
    // The decider saw the vault's own rules and the exact line to update.
    expect(prompts[1]).toContain("## Memoria");
    expect(prompts[1]).toContain("NOTE CRM/People/Anna.md");
    expect(prompts[1]).toContain("line: - Designer at Acme");
    expect(notices[0]).toMatch(/remembered 1 thing from "Team update"/);
    const log = JSON.parse(logFile.content!);
    expect(log[0].writes).toMatchObject([{ path: "CRM/People/Anna.md", op: "update", text: expect.stringContaining("Head of design") }]);
    expect(log[0].writes[0].replaced).toBe("- Designer at Acme");
    expect(JSON.stringify(log)).not.toContain("# Anna"); // no note bodies in the log
  });

  it("commits ONLY the touched notes with the harvest message and records the sha", async () => {
    const calls: string[][] = [];
    const git = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return "true\n";
      if (args[0] === "rev-parse") return "abc123\n";
      if (args[0] === "log") return "exo: memory harvest: 1 scritture (Team update)\n";
      return "";
    };
    const { harvester, logFile } = setup({ chats: [chatWith()], replies: [EXTRACT, DECIDE], git });
    await harvester.tick();
    expect(calls).toContainEqual(["add", "-A", "--", "CRM/People/Anna.md"]);
    expect(calls).toContainEqual(["commit", "-m", "exo: memory harvest: 1 scritture (Team update)", "--", "CRM/People/Anna.md"]);
    expect(JSON.parse(logFile.content!)[0].sha).toBe("abc123");
  });

  it("skips gracefully when git is not available", async () => {
    const git = async () => {
      throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    };
    const { harvester, logFile, files } = setup({ chats: [chatWith()], replies: [EXTRACT, DECIDE], git });
    await harvester.tick();
    expect(files.get("CRM/People/Anna.md")).toContain("Head of design");
    expect(JSON.parse(logFile.content!)[0].sha).toBeUndefined();
  });

  it("does nothing for a conversation that is not idle yet, until the user leaves it", async () => {
    const chat = chatWith({ lastActivityAt: NOW });
    const { harvester, marks } = setup({ chats: [chat], replies: [EXTRACT, DECIDE] });
    await harvester.tick();
    expect(marks).toEqual([]);
    harvester.leaving("c1");
    await harvester.tick();
    await new Promise((r) => setTimeout(r, 0));
    await harvester.tick();
    expect(marks).toEqual([["c1", 2]]);
  });

  it("catch-up: only messages after the watermark are read, and a harvested chat is not re-read", async () => {
    const chat = chatWith({
      messages: [
        { role: "user", text: "Old fact already harvested about pricing tiers", at: NOW - HARVEST_IDLE_MS - 9000 },
        { role: "assistant", segments: [{ t: "text", md: "ok" }] },
        { role: "user", text: "Anna is now head of design at Acme, not a designer", at: NOW - HARVEST_IDLE_MS - 5000 },
        { role: "assistant", segments: [{ t: "text", md: "Noted." }] },
      ],
      harvestedIndex: 2,
    });
    const { harvester, prompts, marks } = setup({ chats: [chat], replies: [EXTRACT, DECIDE] });
    await harvester.tick();
    expect(prompts[0]).toContain("Anna is now head of design");
    expect(prompts[0]).not.toContain("Old fact already harvested");
    expect(marks).toEqual([["c1", 4]]);
    await harvester.tick(); // watermark at the end: nothing due, no more model calls
    expect(prompts).toHaveLength(2);
  });

  it("no facts: advances the watermark without a second call or any write", async () => {
    const { harvester, prompts, marks, files } = setup({ chats: [chatWith()], replies: ['{"facts":[]}'] });
    await harvester.tick();
    expect(prompts).toHaveLength(1);
    expect(marks).toEqual([["c1", 2]]);
    expect(files.get("CRM/People/Anna.md")).toBe("# Anna\n## Work\n- Designer at Acme\n");
  });

  it("budget denied: no model call and the watermark stays, so the next tick retries", async () => {
    const { harvester, prompts, marks } = setup({ chats: [chatWith()], replies: [EXTRACT, DECIDE], budget: false });
    await harvester.tick();
    expect(prompts).toEqual([]);
    expect(marks).toEqual([]);
  });

  it("a guardrail-rejected decision writes nothing but still settles the chat", async () => {
    const decide = JSON.stringify({ decisions: [{ op: "add", candidate: 0, path: "AGENTS.md", text: "Anna leads design" }] });
    const { harvester, files, marks, notices } = setup({ chats: [chatWith()], replies: [EXTRACT, decide] });
    await harvester.tick();
    expect(files.get("AGENTS.md")).toBe(AGENTS);
    expect(marks).toEqual([["c1", 2]]);
    expect(notices).toEqual([]);
  });

  it("B1: a note with the user's uncommitted edits is written but never committed", async () => {
    const calls: string[][] = [];
    const git = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return "true\n";
      if (args[0] === "status") return args.includes("CRM/People/Anna.md") ? " M CRM/People/Anna.md\n" : "";
      return "";
    };
    const { harvester, logFile, files } = setup({ chats: [chatWith()], replies: [EXTRACT, DECIDE], git });
    await harvester.tick();
    expect(files.get("CRM/People/Anna.md")).toContain("Head of design"); // written…
    expect(calls.some((c) => c[0] === "add" || c[0] === "commit")).toBe(false); // …but never staged or committed
    const rec = JSON.parse(logFile.content!)[0];
    expect(rec.sha).toBeUndefined(); // undo reverses the exact lines instead of git revert
    expect(rec.writes[0].replaced).toBe("- Designer at Acme");
  });

  it("B1: with one dirty and one clean note, only the clean one is committed", async () => {
    const calls: string[][] = [];
    const git = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return "true\n";
      if (args[0] === "rev-parse") return "abc123\n";
      if (args[0] === "log") return "exo: memory harvest: 1 scritture (Team update)\n";
      if (args[0] === "status") return args.includes("CRM/People/Anna.md") ? " M CRM/People/Anna.md\n" : "";
      return "";
    };
    const extract = JSON.stringify({
      facts: [
        { kind: "person", statement: "Anna is head of design at Acme", entity: "Anna", evidence: "x" },
        { kind: "other", statement: "rclone has a gdrive remote for backups", evidence: "y" },
      ],
    });
    const decide = JSON.stringify({
      decisions: [
        { op: "update", candidate: 0, path: "CRM/People/Anna.md", oldLine: "- Designer at Acme", newText: "Head of design at Acme" },
        { op: "add", candidate: 1, path: `_exo/memory/inbox/${today}.md`, text: "rclone has a gdrive remote" },
      ],
    });
    const { harvester, logFile } = setup({ chats: [chatWith()], replies: [extract, decide], git });
    await harvester.tick();
    const commit = calls.find((c) => c[0] === "commit")!;
    expect(commit).toEqual(["commit", "-m", "exo: memory harvest: 1 scritture (Team update)", "--", `_exo/memory/inbox/${today}.md`]);
    const rec = JSON.parse(logFile.content!)[0];
    expect(rec.sha).toBe("abc123");
    expect(rec.uncommitted).toEqual(["CRM/People/Anna.md"]);
  });

  it("M4: a title carrying a credential never reaches the commit, the Notice or the log", async () => {
    const calls: string[][] = [];
    const git = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return "true\n";
      if (args[0] === "rev-parse") return "abc\n";
      if (args[0] === "log") return "exo: memory harvest: 1 scritture (chat)\n";
      return "";
    };
    const chat = chatWith({ title: "deploy with GITHUB_TOKEN=ghp_abcdefghijklmnopqrstu" });
    const { harvester, logFile, notices } = setup({ chats: [chat], replies: [EXTRACT, DECIDE], git });
    await harvester.tick();
    expect(calls.find((c) => c[0] === "commit")![2]).toBe("exo: memory harvest: 1 scritture (chat)");
    expect(notices[0]).toContain('from "chat"');
    expect(logFile.content).not.toContain("ghp_");
  });

  it("H1: leaving with no view mounted settles, no re-tick loop", async () => {
    const { harvester, deps } = setup({ chats: [chatWith()], replies: [], source: null });
    let calls = 0;
    const orig = deps.source;
    deps.source = () => {
      calls++;
      return orig();
    };
    harvester.leaving("c1");
    await harvester.tick();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBeLessThanOrEqual(2);
  });

  it("M2: the watermark settles before writing, and an unload before apply writes nothing", async () => {
    const chat = chatWith();
    const { harvester, files, marks, deps } = setup({ chats: [chat], replies: [EXTRACT] });
    const util = deps.utility;
    deps.utility = async (p, sig) => {
      if (p.includes("FACTS:")) harvester.dispose(); // unload while the decider runs
      return p.includes("FACTS:") ? { text: DECIDE, tokens: 1 } : util(p, sig);
    };
    await harvester.tick();
    expect(files.get("CRM/People/Anna.md")).toBe("# Anna\n## Work\n- Designer at Acme\n");
    expect(marks).toEqual([]);
  });
});
