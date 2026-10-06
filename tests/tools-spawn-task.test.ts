import { describe, it, expect } from "vitest";
import { TFile } from "obsidian";
import { createObsidianToolServer } from "../src/obsidian/tools";
import { parseTasksFile, serializeTasks, TASKS_PATH, type TaskEntry } from "../src/core/tasks";
import { WriteQueue } from "../src/core/write-queue";
import { canSpawnChild, MAX_OPEN_CHILDREN } from "../src/core/child-tasks";
import { exoPaths } from "../src/core/paths";

/** Registered tool names on an SDK MCP server instance — same shape read by
 *  `tests/tools-add-task.test.ts`, duplicated here rather than imported since
 *  that file keeps its helpers module-local. */
function toolNames(server: ReturnType<typeof createObsidianToolServer>): string[] {
  return Object.keys((server.instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
}

function registeredTools(server: ReturnType<typeof createObsidianToolServer>) {
  return (server.instance as unknown as {
    _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<any> }>;
  })._registeredTools;
}

/** Minimal fake Obsidian `App` — identical shape to `tests/tools-add-task.test.ts`'s
 *  `fakeApp()`, duplicated per that file's instruction not to invent a third
 *  fake app: this is the same one, just local to this file. */
function fakeApp() {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const app = {
    vault: {
      getMarkdownFiles: () => [],
      getAbstractFileByPath: (path: string) => (files.has(path) ? Object.assign(new TFile(), { path }) : null),
      read: async (f: { path: string }) => {
        const v = files.get(f.path);
        if (v === undefined) throw new Error(`no such file: ${f.path}`);
        return v;
      },
      cachedRead: async (f: { path: string }) => files.get(f.path) ?? "",
      create: async (path: string, content: string) => {
        if (files.has(path)) throw new Error(`already exists: ${path}`);
        files.set(path, content);
        return { path };
      },
      modify: async (f: { path: string }, content: string) => {
        files.set(f.path, content);
      },
      createFolder: async (dir: string) => {
        folders.add(dir);
      },
    },
    workspace: {},
    metadataCache: {},
  } as any;
  return { app, files };
}

const ISO = new Date(1_720_000_000_000).toISOString();

function childEntry(id: string, parent: string, status: TaskEntry["status"] = "queued"): TaskEntry {
  return { id, title: `Child ${id}`, status, created: ISO, updated: ISO, parent, prompt: "work" };
}

describe("fan-out tools registration gating", () => {
  it("registers neither spawn_task nor list_tasks when orchestrationEnabled is false", () => {
    const { app } = fakeApp();
    const server = createObsidianToolServer(app, {
      alwaysLoad: true,
      memoryWrite: false,
      memoryRead: true,
      memoryWriteQueue: new WriteQueue(),
      orchestrationEnabled: false,
      tasksWriteQueue: new WriteQueue(),
      agentFolderEnabled: false,
      loopsWriteQueue: new WriteQueue(),
      parentConvoId: "convo-a",
    });
    const names = toolNames(server);
    expect(names).not.toContain("spawn_task");
    expect(names).not.toContain("list_tasks");
  });

  it("registers list_tasks but withholds spawn_task when there is no parentConvoId", () => {
    const { app } = fakeApp();
    const server = createObsidianToolServer(app, {
      alwaysLoad: true,
      memoryWrite: false,
      memoryRead: true,
      memoryWriteQueue: new WriteQueue(),
      orchestrationEnabled: true,
      tasksWriteQueue: new WriteQueue(),
      agentFolderEnabled: false,
      loopsWriteQueue: new WriteQueue(),
    });
    const names = toolNames(server);
    expect(names).toContain("list_tasks");
    expect(names).not.toContain("spawn_task");
  });

  it("registers both spawn_task and list_tasks when orchestration is on and a parentConvoId is present", () => {
    const { app } = fakeApp();
    const server = createObsidianToolServer(app, {
      alwaysLoad: true,
      memoryWrite: false,
      memoryRead: true,
      memoryWriteQueue: new WriteQueue(),
      orchestrationEnabled: true,
      tasksWriteQueue: new WriteQueue(),
      agentFolderEnabled: false,
      loopsWriteQueue: new WriteQueue(),
      parentConvoId: "convo-a",
    });
    const names = toolNames(server);
    expect(names).toContain("spawn_task");
    expect(names).toContain("list_tasks");
  });
});

/**
 * The scheduler lives in the Orchestration Board's view. With the board CLOSED
 * there is no driver at all: `spawn_task` writes a `queued` block that nothing
 * ever promotes. The tool must not promise otherwise — an agent that tells Mario
 * "I've delegated that, it'll report back" when nothing can run is worse than
 * one that says the board has to be open.
 */
// The runtime is plugin-owned (obsidian/orchestration.ts): a closed board stops
// nothing, so neither text may tell the model it has to be open.
describe("spawn_task tells the truth: no board needed, the report wakes the parent", () => {
  const spawnTool = () => {
    const { app } = fakeApp();
    const server = createObsidianToolServer(app, {
      alwaysLoad: true,
      memoryWrite: false,
      memoryRead: true,
      memoryWriteQueue: new WriteQueue(),
      orchestrationEnabled: true,
      tasksWriteQueue: new WriteQueue(),
      agentFolderEnabled: false,
      loopsWriteQueue: new WriteQueue(),
      parentConvoId: "convo-a",
    });
    return (server.instance as unknown as {
      _registeredTools: Record<string, { description: string }>;
    })._registeredTools["spawn_task"];
  };

  it("says so in the tool description the model reads before calling", () => {
    const d = spawnTool().description;
    expect(d).not.toMatch(/board.{0,40}open|open.{0,40}board/i);
    expect(d).toMatch(/never poll/i);
  });

  it("says so again in the result, which is what the model actually acts on", async () => {
    const { app } = fakeApp();
    const queue = new WriteQueue();
    const server = createObsidianToolServer(app, {
      alwaysLoad: true,
      memoryWrite: false,
      memoryRead: true,
      memoryWriteQueue: queue,
      orchestrationEnabled: true,
      tasksWriteQueue: queue,
      agentFolderEnabled: false,
      loopsWriteQueue: queue,
      parentConvoId: "convo-a",
    });
    const result: any = await registeredTools(server)["spawn_task"].handler(
      { title: "Research the pricing page", prompt: "Go read it" },
      {}
    );
    const text = result.content[0].text;
    expect(text).not.toMatch(/board.{0,40}open|open.{0,40}board/i);
    expect(text).toMatch(/reports back to this chat/);
  });
});

describe("spawn_task behavior", () => {
  it("writes a queued child task carrying the parent convo id", async () => {
    const { app, files } = fakeApp();
    const queue = new WriteQueue();
    const server = createObsidianToolServer(app, {
      alwaysLoad: true,
      memoryWrite: false,
      memoryRead: true,
      memoryWriteQueue: queue,
      orchestrationEnabled: true,
      tasksWriteQueue: queue,
      agentFolderEnabled: false,
      loopsWriteQueue: queue,
      parentConvoId: "convo-a",
    });
    const spawnTask = registeredTools(server)["spawn_task"];
    expect(spawnTask).toBeTruthy();

    expect(files.has(TASKS_PATH)).toBe(false);
    const result: any = await spawnTask.handler({ title: "Research the pricing page", prompt: "Go read it" }, {});
    expect(result.isError).toBeFalsy();

    const parsed = parseTasksFile(files.get(TASKS_PATH)!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].status).toBe("queued");
    expect(parsed[0].parent).toBe("convo-a");
    expect(parsed[0].title).toBe("Research the pricing page");
    expect(parsed[0].prompt).toBe("Go read it");
  });

  it("refuses past the open-children cap and writes NOTHING to the ledger", async () => {
    const { app, files } = fakeApp();
    const existing = Array.from({ length: MAX_OPEN_CHILDREN }, (_, i) => childEntry(`task-${1_720_000_000_000 + i}`, "convo-a"));
    files.set(TASKS_PATH, serializeTasks(existing));
    const before = files.get(TASKS_PATH);

    const queue = new WriteQueue();
    const server = createObsidianToolServer(app, {
      alwaysLoad: true,
      memoryWrite: false,
      memoryRead: true,
      memoryWriteQueue: queue,
      orchestrationEnabled: true,
      tasksWriteQueue: queue,
      agentFolderEnabled: false,
      loopsWriteQueue: queue,
      parentConvoId: "convo-a",
    });
    const spawnTask = registeredTools(server)["spawn_task"];
    const gate = canSpawnChild(existing, "convo-a");
    expect(gate.ok).toBe(false);

    const result: any = await spawnTask.handler({ title: "One too many", prompt: "nope" }, {});
    // The refusal is reported back to the agent as a normal (non-error) result
    // carrying the cap's own reason text verbatim, so the agent doesn't blindly retry.
    expect(result.isError).toBeFalsy();
    if (!gate.ok) expect(result.content[0].text).toBe(gate.reason);

    expect(files.get(TASKS_PATH)).toBe(before);
    expect(parseTasksFile(files.get(TASKS_PATH)!)).toHaveLength(MAX_OPEN_CHILDREN);
  });

  it("concurrent spawn_task calls in one turn do NOT collectively exceed the open-children cap", async () => {
    // The canonical fan-out gesture: one assistant turn issues several
    // spawn_task calls in parallel tool blocks. Starting 2 below the cap (3
    // open, cap 5) with 4 concurrent calls: a check-then-act gate evaluated
    // OUTSIDE the write queue would let all 4 see "3 < 5" and all pass,
    // landing 7 open children. The gate must be evaluated fresh INSIDE each
    // call's own turn in the queue, so only 2 of the 4 may succeed.
    const { app, files } = fakeApp();
    const existing = Array.from({ length: 3 }, (_, i) => childEntry(`task-${1_720_000_000_000 + i}`, "convo-a"));
    files.set(TASKS_PATH, serializeTasks(existing));

    const queue = new WriteQueue();
    const server = createObsidianToolServer(app, {
      alwaysLoad: true,
      memoryWrite: false,
      memoryRead: true,
      memoryWriteQueue: queue,
      orchestrationEnabled: true,
      tasksWriteQueue: queue,
      agentFolderEnabled: false,
      loopsWriteQueue: queue,
      parentConvoId: "convo-a",
    });
    const spawnTask = registeredTools(server)["spawn_task"];

    const results: any[] = await Promise.all(
      [0, 1, 2, 3].map((i) => spawnTask.handler({ title: `Concurrent ${i}`, prompt: "work" }, {}))
    );

    const parsed = parseTasksFile(files.get(TASKS_PATH)!).filter((t) => t.parent === "convo-a");
    expect(parsed).toHaveLength(MAX_OPEN_CHILDREN); // exactly 5, never 7

    const succeeded = results.filter((r) => /^Queued child task/.test(r.content[0].text));
    const refused = results.filter((r) => !/^Queued child task/.test(r.content[0].text));
    expect(succeeded).toHaveLength(2); // only the 2 free slots (3 -> 5)
    expect(refused).toHaveLength(2);
    for (const r of refused) {
      expect(r.isError).toBeFalsy(); // refusal is a normal result, not an error
      expect(r.content[0].text).toContain(`cap ${MAX_OPEN_CHILDREN}`);
    }
  });
});

describe("fan-out tools honor a non-legacy configured ExoPaths (not a hardcoded TASKS_PATH)", () => {
  it("spawn_task writes to the configured paths.tasks, and list_tasks reads it back from there", async () => {
    const { app, files } = fakeApp();
    const customPaths = exoPaths("_exo"); // non-legacy root — differs from TASKS_PATH (legacy "_system/...")
    expect(customPaths.tasks).not.toBe(TASKS_PATH);

    const queue = new WriteQueue();
    const server = createObsidianToolServer(app, {
      alwaysLoad: true,
      memoryWrite: false,
      memoryRead: true,
      memoryWriteQueue: queue,
      orchestrationEnabled: true,
      tasksWriteQueue: queue,
      agentFolderEnabled: false,
      loopsWriteQueue: queue,
      paths: customPaths,
      parentConvoId: "convo-a",
    });
    const spawnTask = registeredTools(server)["spawn_task"];
    const listTasks = registeredTools(server)["list_tasks"];

    const spawnResult: any = await spawnTask.handler({ title: "Custom-root child", prompt: "go" }, {});
    expect(spawnResult.isError).toBeFalsy();

    // Written under the CONFIGURED path, never the legacy default.
    expect(files.has(customPaths.tasks)).toBe(true);
    expect(files.has(TASKS_PATH)).toBe(false);
    expect(parseTasksFile(files.get(customPaths.tasks)!)).toHaveLength(1);

    const listResult: any = await listTasks.handler({}, {});
    expect(listResult.content[0].text).toContain("Custom-root child");
  });
});

describe("list_tasks behavior", () => {
  it("defaults to only this conversation's children", async () => {
    const { app, files } = fakeApp();
    const entries: TaskEntry[] = [
      childEntry("task-1", "convo-a"),
      childEntry("task-2", "convo-b"),
      { id: "task-3", title: "Not delegated", status: "backlog", created: ISO, updated: ISO, prompt: "p" },
    ];
    files.set(TASKS_PATH, serializeTasks(entries));

    const queue = new WriteQueue();
    const server = createObsidianToolServer(app, {
      alwaysLoad: true,
      memoryWrite: false,
      memoryRead: true,
      memoryWriteQueue: queue,
      orchestrationEnabled: true,
      tasksWriteQueue: queue,
      agentFolderEnabled: false,
      loopsWriteQueue: queue,
      parentConvoId: "convo-a",
    });
    const listTasks = registeredTools(server)["list_tasks"];
    expect(listTasks).toBeTruthy();

    const result: any = await listTasks.handler({}, {});
    const text = result.content[0].text as string;
    expect(text).toContain("task-1");
    expect(text).not.toContain("task-2");
    expect(text).not.toContain("task-3");
  });

  it("with all: true, lists every task on the board regardless of parentage", async () => {
    const { app, files } = fakeApp();
    const entries: TaskEntry[] = [
      childEntry("task-1", "convo-a"),
      childEntry("task-2", "convo-b"),
      { id: "task-3", title: "Not delegated", status: "backlog", created: ISO, updated: ISO, prompt: "p" },
    ];
    files.set(TASKS_PATH, serializeTasks(entries));

    const queue = new WriteQueue();
    const server = createObsidianToolServer(app, {
      alwaysLoad: true,
      memoryWrite: false,
      memoryRead: true,
      memoryWriteQueue: queue,
      orchestrationEnabled: true,
      tasksWriteQueue: queue,
      agentFolderEnabled: false,
      loopsWriteQueue: queue,
      parentConvoId: "convo-a",
    });
    const listTasks = registeredTools(server)["list_tasks"];
    const result: any = await listTasks.handler({ all: true }, {});
    const text = result.content[0].text as string;
    expect(text).toContain("task-1");
    expect(text).toContain("task-2");
    expect(text).toContain("task-3");
  });

  it("is present (and reports no delegated tasks) even with no parentConvoId", async () => {
    const { app } = fakeApp();
    const server = createObsidianToolServer(app, {
      alwaysLoad: true,
      memoryWrite: false,
      memoryRead: true,
      memoryWriteQueue: new WriteQueue(),
      orchestrationEnabled: true,
      tasksWriteQueue: new WriteQueue(),
      agentFolderEnabled: false,
      loopsWriteQueue: new WriteQueue(),
    });
    const listTasks = registeredTools(server)["list_tasks"];
    expect(listTasks).toBeTruthy();
    const result: any = await listTasks.handler({}, {});
    expect(result.isError).toBeFalsy();
  });
});
