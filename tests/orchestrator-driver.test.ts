import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OrchestratorDriver, type DriverDeps } from "../src/obsidian/orchestrator-driver";
import type { ConvoStateEvent, ConvoStateListener, Unsubscribe } from "../src/core/convo-state";
import type { TaskEntry, TaskStatus, TaskPatch } from "../src/core/tasks";
import type { ConvoSnapshot } from "../src/core/orchestrator";
import { PARENT_STOPPED } from "../src/core/delegation";
import {
  REPORT_DEBOUNCE_MS,
  queueReportForParent,
  drainReportsForParent,
  type ChildReport,
} from "../src/core/child-reports";

/** Build a task entry with sensible defaults. */
function task(over: Partial<TaskEntry> & { id: string }): TaskEntry {
  return {
    title: "T",
    status: "backlog",
    created: "2026-07-08T00:00:00.000Z",
    updated: "2026-07-08T00:00:00.000Z",
    prompt: "do the thing",
    ...over,
  };
}

/**
 * In-memory fake of the B3 TaskStore's driver-facing surface: an authoritative
 * list of tasks that load() returns and update/move/archive mutate. Records
 * every mutation so tests can assert what was persisted.
 */
function fakeStore(initial: TaskEntry[] = []) {
  let tasks = initial.map((t) => ({ ...t }));
  const moves: Array<{ id: string; status: TaskStatus; order: number }> = [];
  const patches: Array<{ id: string; patch: TaskPatch }> = [];
  const store = {
    load: vi.fn(async () => ({ tasks: tasks.map((t) => ({ ...t })), warnings: [] as string[] })),
    update: vi.fn(async (id: string, patch: TaskPatch) => {
      tasks = tasks.map((t) => (t.id === id ? { ...t, ...patch } : t));
      patches.push({ id, patch });
      return tasks.find((t) => t.id === id)!;
    }),
    move: vi.fn(async (id: string, status: TaskStatus, order: number) => {
      tasks = tasks.map((t) => (t.id === id ? { ...t, status, order } : t));
      moves.push({ id, status, order });
      return tasks.find((t) => t.id === id)!;
    }),
    archive: vi.fn(async (id: string) => {
      tasks = tasks.map((t) => (t.id === id ? { ...t, status: "archived" as TaskStatus } : t));
      return tasks.find((t) => t.id === id)!;
    }),
  };
  return {
    store,
    moves,
    patches,
    get tasks() {
      return tasks;
    },
    set(next: TaskEntry[]) {
      tasks = next.map((t) => ({ ...t }));
    },
  };
}

/** A controllable fake of the plugin-level convo-state emitter. */
function fakeEmitter() {
  const listeners = new Set<ConvoStateListener>();
  return {
    subscribe(fn: ConvoStateListener): Unsubscribe {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(event: ConvoStateEvent) {
      for (const l of listeners) l(event);
    },
    get size() {
      return listeners.size;
    },
  };
}

/** A deps bundle wired to controllable fakes. `spawn` hands out sequential
 *  convo ids and records what it was asked to spawn. */
function makeDeps(initial: TaskEntry[] = []) {
  const emitter = fakeEmitter();
  const backing = fakeStore(initial);
  const spawned: Array<{ prompt: string; model?: string; parent?: string }> = [];
  let n = 0;
  const liveness = new Map<string, ConvoSnapshot>();
  const deps: DriverDeps = {
    store: backing.store,
    subscribe: (fn) => emitter.subscribe(fn),
    spawn: vi.fn(async (prompt: string, opts?: { model?: string; parent?: string }) => {
      spawned.push({
        prompt,
        ...(opts?.model ? { model: opts.model } : {}),
        ...(opts?.parent ? { parent: opts.parent } : {}),
      });
      return `convo-${++n}`;
    }),
    liveness: (convoId: string) => liveness.get(convoId) ?? { exists: false, streaming: false, pendingRequest: false },
    config: () => ({ maxConcurrent: 2 }),
    notify: vi.fn(),
    onChange: vi.fn(),
    // onChildReport / lastAssistantText are optional (Task 7); left undefined
    // here and set per-test so existing tests don't need to know about them.
  };
  return { deps, emitter, backing, spawned, liveness };
}

/** Let the driver's async chain (store awaits + spawn awaits) fully settle.
 *  A macrotask tick drains every pending microtask the dispatch chain queued. */
const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

describe("OrchestratorDriver — lifecycle", () => {
  it("subscribes to the emitter on start and unsubscribes on stop", async () => {
    const { deps, emitter } = makeDeps();
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    expect(emitter.size).toBe(1);
    driver.stop();
    expect(emitter.size).toBe(0);
  });

  it("loads tasks from the store on start", async () => {
    const { deps, backing } = makeDeps([task({ id: "task-1" })]);
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    expect(backing.store.load).toHaveBeenCalled();
    expect(driver.snapshot().map((t) => t.id)).toEqual(["task-1"]);
  });
});

describe("OrchestratorDriver — enqueue + spawn", () => {
  it("enqueuing a backlog task spawns a conversation and records its id", async () => {
    const { deps, backing, spawned } = makeDeps([task({ id: "task-1", prompt: "write the post" })]);
    const driver = new OrchestratorDriver(deps);
    await driver.start();

    await driver.enqueue("task-1");

    expect(spawned).toEqual([{ prompt: "write the post" }]);
    const t = driver.snapshot().find((x) => x.id === "task-1")!;
    expect(t.status).toBe("running");
    expect(t.convo).toBe("convo-1");
    // The recorded convo id must be persisted through the store.
    expect(backing.patches.some((p) => p.id === "task-1" && p.patch.convo === "convo-1")).toBe(true);
  });

  it("passes the task's pinned model to spawn", async () => {
    const { deps, spawned } = makeDeps([task({ id: "task-1", model: "claude-opus-4-8" })]);
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    await driver.enqueue("task-1");
    expect(spawned[0]).toEqual({ prompt: "do the thing", model: "claude-opus-4-8" });
  });
});

describe("OrchestratorDriver — concurrency cap", () => {
  it("with cap 2 and 3 queued tasks, only 2 conversations spawn", async () => {
    const { deps, spawned } = makeDeps([
      task({ id: "task-1", order: 0 }),
      task({ id: "task-2", order: 1 }),
      task({ id: "task-3", order: 2 }),
    ]);
    const driver = new OrchestratorDriver(deps);
    await driver.start();

    await driver.enqueue("task-1");
    await driver.enqueue("task-2");
    await driver.enqueue("task-3");

    expect(spawned).toHaveLength(2);
    const running = driver.snapshot().filter((t) => t.status === "running");
    expect(running).toHaveLength(2);
    const queued = driver.snapshot().filter((t) => t.status === "queued");
    expect(queued.map((t) => t.id)).toEqual(["task-3"]);
  });

  it("the third task starts when a running slot frees (turn-end on one running task)", async () => {
    const { deps, emitter, spawned } = makeDeps([
      task({ id: "task-1", order: 0 }),
      task({ id: "task-2", order: 1 }),
      task({ id: "task-3", order: 2 }),
    ]);
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    await driver.enqueue("task-1");
    await driver.enqueue("task-2");
    await driver.enqueue("task-3");
    expect(spawned).toHaveLength(2);

    // task-1 got convo-1; its turn ends → Review, freeing a slot.
    const t1 = driver.snapshot().find((t) => t.id === "task-1")!;
    emitter.emit({ convoId: t1.convo!, state: "turn-end" });
    await flush();

    // Third task should now have spawned.
    expect(spawned).toHaveLength(3);
    const t3 = driver.snapshot().find((t) => t.id === "task-3")!;
    expect(t3.status).toBe("running");
    expect(t3.convo).toBe("convo-3");
  });
});

describe("OrchestratorDriver — convo-state → column moves", () => {
  it("turn-start keeps the task running; turn-end moves it to review", async () => {
    const { deps, emitter } = makeDeps([task({ id: "task-1", order: 0 })]);
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    await driver.enqueue("task-1");
    const convo = driver.snapshot().find((t) => t.id === "task-1")!.convo!;

    emitter.emit({ convoId: convo, state: "turn-start" });
    await flush();
    expect(driver.snapshot().find((t) => t.id === "task-1")!.status).toBe("running");

    emitter.emit({ convoId: convo, state: "turn-end" });
    await flush();
    expect(driver.snapshot().find((t) => t.id === "task-1")!.status).toBe("review");
  });

  it("needs-input / error / stopped park the task in needs-input with a reason badge", async () => {
    const cases: Array<{ state: "needs-input" | "error" | "stopped"; reason: "ask" | "error" | "stopped" }> = [
      { state: "needs-input", reason: "ask" },
      { state: "error", reason: "error" },
      { state: "stopped", reason: "stopped" },
    ];
    for (const c of cases) {
      const { deps, emitter } = makeDeps([task({ id: "task-1", order: 0 })]);
      const driver = new OrchestratorDriver(deps);
      await driver.start();
      await driver.enqueue("task-1");
      const convo = driver.snapshot().find((t) => t.id === "task-1")!.convo!;
      emitter.emit({ convoId: convo, state: c.state, reason: c.reason });
      await flush();
      const t = driver.snapshot().find((x) => x.id === "task-1")!;
      expect(t.status).toBe("needs-input");
      expect(t.inputReason).toBeDefined();
    }
  });

  it("turn-end NEVER completes a task (Done is user-action-only)", async () => {
    const { deps, emitter } = makeDeps([task({ id: "task-1", order: 0 })]);
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    await driver.enqueue("task-1");
    const convo = driver.snapshot().find((t) => t.id === "task-1")!.convo!;
    emitter.emit({ convoId: convo, state: "turn-end" });
    await flush();
    expect(driver.snapshot().find((t) => t.id === "task-1")!.status).toBe("review");
    // No convo event may move it to done.
    expect(driver.snapshot().find((t) => t.id === "task-1")!.status).not.toBe("done");
  });

  it("markDone only completes a review task (explicit user action)", async () => {
    const { deps, emitter } = makeDeps([task({ id: "task-1", order: 0 })]);
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    await driver.enqueue("task-1");
    const convo = driver.snapshot().find((t) => t.id === "task-1")!.convo!;
    emitter.emit({ convoId: convo, state: "turn-end" });
    await flush();
    await driver.markDone("task-1");
    expect(driver.snapshot().find((t) => t.id === "task-1")!.status).toBe("done");
  });
});

describe("OrchestratorDriver — archive", () => {
  it("archives a card from any column (not just done), hiding it but keeping the block", async () => {
    const { deps, backing } = makeDeps([task({ id: "task-1", status: "review", order: 0 })]);
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    await driver.archive("task-1");
    // In-memory: archived (hidden by the board's column filter).
    expect(driver.snapshot().find((t) => t.id === "task-1")!.status).toBe("archived");
    // Persisted via store.archive (block kept, status archived).
    expect(backing.store.archive).toHaveBeenCalledWith("task-1");
    expect(backing.tasks.find((t) => t.id === "task-1")!.status).toBe("archived");
  });
});

describe("OrchestratorDriver — spawn failure", () => {
  it("spawn rejection parks the task in needs-input and notifies", async () => {
    const { deps } = makeDeps([task({ id: "task-1", order: 0 })]);
    deps.spawn = vi.fn(async () => {
      throw new Error("CLI down");
    });
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    await driver.enqueue("task-1");
    await flush();
    const t = driver.snapshot().find((x) => x.id === "task-1")!;
    expect(t.status).toBe("needs-input");
    expect(deps.notify).toHaveBeenCalled();
  });

  it("a child whose parent was stopped mid-spawn is archived quietly: no notice, no report", async () => {
    const { deps, backing } = makeDeps([task({ id: "task-1", order: 0, parent: "P" })]);
    deps.spawn = vi.fn(async () => {
      throw new Error(PARENT_STOPPED);
    });
    deps.onChildReport = vi.fn();
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    await driver.enqueue("task-1");
    await flush();
    await new Promise((r) => setTimeout(r, REPORT_DEBOUNCE_MS + 50));
    expect(driver.snapshot().find((x) => x.id === "task-1")!.status).toBe("archived");
    expect(backing.store.archive).toHaveBeenCalledWith("task-1");
    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.onChildReport).not.toHaveBeenCalled();
  });

  it("spawn resolving to an empty convo id is a failure: parks in needs-input(error) + notifies", async () => {
    const { deps } = makeDeps([task({ id: "task-1", order: 0 })]);
    // The real startTaskConversation / askInNewConversation returns "" (does NOT
    // reject) when the view can't be resolved or the prompt is empty. That empty
    // id must be treated as a spawn failure, not a success.
    deps.spawn = vi.fn(async () => "");
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    await driver.enqueue("task-1");
    await flush();
    const t = driver.snapshot().find((x) => x.id === "task-1")!;
    expect(t.status).toBe("needs-input");
    expect(t.inputReason).toBe("error");
    expect(t.convo ?? "").toBe(""); // never record the empty id as a live convo
    expect(deps.notify).toHaveBeenCalled();
  });

  it("a spawn failure in a batch promote refills the freed slot (no slot leak)", async () => {
    // cap 2; A, B, C all queued at boot; start()'s fillSlots pass promotes A+B
    // together in ONE fillSlots. A's spawn fails. The freed slot must be
    // refilled by C, so under cap 2 exactly two tasks run (B and C).
    const { deps } = makeDeps([
      task({ id: "A", status: "queued", order: 0 }),
      task({ id: "B", status: "queued", order: 1 }),
      task({ id: "C", status: "queued", order: 2 }),
    ]);
    let calls = 0;
    deps.spawn = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("CLI down"); // first promoted task (A) fails
      return `convo-${calls}`;
    });
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    await flush();

    const snap = driver.snapshot();
    const running = snap.filter((t) => t.status === "running").map((t) => t.id).sort();
    const needsInput = snap.filter((t) => t.status === "needs-input").map((t) => t.id);
    expect(needsInput).toContain("A");
    expect(running).toHaveLength(2);
    expect(snap.filter((t) => t.status === "queued")).toHaveLength(0);
  });

  it("two consecutive spawn failures in one batch each free only their own slot", async () => {
    // cap 2; A, B, C queued at boot. A and B both fail; C succeeds and runs.
    const { deps } = makeDeps([
      task({ id: "A", status: "queued", order: 0 }),
      task({ id: "B", status: "queued", order: 1 }),
      task({ id: "C", status: "queued", order: 2 }),
    ]);
    let calls = 0;
    deps.spawn = vi.fn(async () => {
      calls++;
      if (calls <= 2) throw new Error("CLI down");
      return `convo-${calls}`;
    });
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    await flush();
    const snap = driver.snapshot();
    // Two spawns fail, one succeeds. The invariant that matters: each failure
    // frees only its own slot and the next queued task fills it, so exactly two
    // tasks park in needs-input, exactly one runs, and nothing is left stranded
    // in queued (no slot leak). (Which two fail depends on the recursion order
    // through the effect loop; the counts are the contract.)
    expect(snap.filter((t) => t.status === "needs-input")).toHaveLength(2);
    expect(snap.filter((t) => t.status === "running")).toHaveLength(1);
    expect(snap.filter((t) => t.status === "queued")).toHaveLength(0);
  });
});

describe("OrchestratorDriver — boot promotes queued tasks", () => {
  it("boot with a queued task and a free slot auto-promotes and spawns it", async () => {
    const { deps, spawned } = makeDeps([task({ id: "task-1", status: "queued", order: 0 })]);
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    await flush();
    const t = driver.snapshot().find((x) => x.id === "task-1")!;
    expect(t.status).toBe("running");
    expect(t.convo).toBe("convo-1");
    expect(spawned).toHaveLength(1);
  });

  it("boot respects the concurrency cap when more tasks are queued than slots", async () => {
    const { deps, spawned } = makeDeps([
      task({ id: "task-1", status: "queued", order: 0 }),
      task({ id: "task-2", status: "queued", order: 1 }),
      task({ id: "task-3", status: "queued", order: 2 }),
    ]);
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    await flush();
    expect(spawned).toHaveLength(2);
    const snap = driver.snapshot();
    expect(snap.filter((t) => t.status === "running")).toHaveLength(2);
    expect(snap.filter((t) => t.status === "queued").map((t) => t.id)).toEqual(["task-3"]);
  });
});

describe("OrchestratorDriver — child spawn parentage", () => {
  it("passes the task's parent through to spawn", async () => {
    const { deps, spawned } = makeDeps([task({ id: "task-1", parent: "convo-parent", prompt: "research" })]);
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    await driver.enqueue("task-1");
    expect(spawned[0]).toEqual({ prompt: "research", parent: "convo-parent" });
  });

  it("omits parent from spawn opts when the task has none", async () => {
    const { deps, spawned } = makeDeps([task({ id: "task-1", prompt: "solo" })]);
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    await driver.enqueue("task-1");
    expect(spawned[0]).toEqual({ prompt: "solo" });
  });
});

describe("OrchestratorDriver — child reports", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Advance past the report debounce window, running any due timer. */
  const flushReports = async () => {
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS + 10);
  };

  it("reports a child's completion to its parent, with the excerpt", async () => {
    const reports: ChildReport[] = [];
    const { deps, emitter } = makeDeps([
      task({
        id: "task-1",
        title: "Research pricing",
        status: "running",
        parent: "convo-parent",
        convo: "convo-child",
      }),
    ]);
    deps.onChildReport = (r) => reports.push(r);
    deps.lastAssistantText = () => "Found three competitors.";
    const driver = new OrchestratorDriver(deps);
    await driver.start();

    emitter.emit({ convoId: "convo-child", state: "turn-end" });
    await flushReports();

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      taskId: "task-1",
      childConvoId: "convo-child",
      // Routing key: the consumer delivers by THIS, never by childConvoId.
      parentConvoId: "convo-parent",
      title: "Research pricing",
      outcome: "done",
      excerpt: "Found three competitors.",
    });
  });

  it("emits no report for a task that has no parent", async () => {
    const reports: ChildReport[] = [];
    const { deps, emitter } = makeDeps([
      task({ id: "task-2", title: "Solo task", status: "running", convo: "convo-solo" }),
    ]);
    deps.onChildReport = (r) => reports.push(r);
    const driver = new OrchestratorDriver(deps);
    await driver.start();

    emitter.emit({ convoId: "convo-solo", state: "turn-end" });
    await flushReports();

    expect(reports).toHaveLength(0);
  });

  it("emits no report for turn-start, which is not an outcome", async () => {
    const reports: ChildReport[] = [];
    const { deps, emitter } = makeDeps([
      task({ id: "task-3", title: "Child", status: "running", parent: "convo-parent", convo: "convo-child" }),
    ]);
    deps.onChildReport = (r) => reports.push(r);
    const driver = new OrchestratorDriver(deps);
    await driver.start();

    emitter.emit({ convoId: "convo-child", state: "turn-start" });
    await flushReports();

    expect(reports).toHaveLength(0);
  });

  /**
   * Deliberately THREE DIFFERENT children, not three events on one: a settled
   * child never settles again (see "reports a settled child ONCE" below), so
   * re-using one child here would only re-test the reducer's no-op. What the
   * debounce is FOR is a fan-out landing together — several children finishing
   * seconds apart must reach the parent as one message, not as a drip.
   */
  it("collapses a burst of children settling into a single, restarted-debounce batch", async () => {
    const reports: ChildReport[] = [];
    const { deps, emitter } = makeDeps([
      task({ id: "task-4a", title: "Child A", status: "running", parent: "convo-parent", convo: "convo-a" }),
      task({ id: "task-4b", title: "Child B", status: "running", parent: "convo-parent", convo: "convo-b" }),
      task({ id: "task-4c", title: "Child C", status: "running", parent: "convo-parent", convo: "convo-c" }),
    ]);
    deps.onChildReport = (r) => reports.push(r);
    const driver = new OrchestratorDriver(deps);
    await driver.start();

    // t=0: first outcome schedules a flush at t=2000.
    emitter.emit({ convoId: "convo-a", state: "turn-end" });
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS - 100); // t=1900, not yet fired

    // A second child settles just before the original deadline: it must restart
    // the debounce (new deadline t=3900), not let the original t=2000 timer fire.
    emitter.emit({ convoId: "convo-b", state: "turn-end" });
    await vi.advanceTimersByTimeAsync(200); // t=2100 — past the ORIGINAL deadline

    // If the timer wasn't restarted, a (premature) partial batch would be here.
    expect(reports).toHaveLength(0);

    // A third child, still inside the restarted window.
    emitter.emit({ convoId: "convo-c", state: "turn-end" });

    await flushReports();

    // All three delivered in one flush, one report each — never a drip.
    expect(reports.map((r) => r.taskId).sort()).toEqual(["task-4a", "task-4b", "task-4c"]);
  });

  /**
   * A settled child is still a NORMAL chat: Mario opens it and keeps working in
   * it. Every one of those turns emits `turn-end`, and the reducer correctly
   * no-ops (the task is already in `review`, and only a `running` task settles).
   * The report path must follow the same guard, or the parent is told "your
   * delegated task is done" again on every later turn of a conversation it
   * never re-delegated — with a fresh excerpt from unrelated work.
   */
  it("reports a settled child ONCE, however many later turns that chat runs", async () => {
    const reports: ChildReport[] = [];
    const { deps, emitter } = makeDeps([
      task({ id: "task-6", title: "Research pricing", status: "running", parent: "convo-parent", convo: "convo-child" }),
    ]);
    let last = "Found three competitors.";
    deps.lastAssistantText = () => last;
    deps.onChildReport = (r) => reports.push(r);
    const driver = new OrchestratorDriver(deps);
    await driver.start();

    // The real settling transition: running -> review. One report.
    emitter.emit({ convoId: "convo-child", state: "turn-end" });
    await flushReports();
    expect(reports).toHaveLength(1);

    // Mario now keeps chatting in that child. Two more turns, well past the
    // debounce window so they can't be collapsed into the first batch.
    last = "Sure, here is that unrelated thing.";
    emitter.emit({ convoId: "convo-child", state: "turn-end" });
    await flushReports();
    last = "And another one.";
    emitter.emit({ convoId: "convo-child", state: "turn-end" });
    await flushReports();

    // Still exactly one: the task never went back to `running`, so nothing settled.
    expect(reports).toHaveLength(1);
    expect(reports[0].excerpt).toBe("Found three competitors.");
    expect(driver.snapshot().find((t) => t.id === "task-6")!.status).toBe("review");
  });

  it("reports a child parked in needs-input ONCE, not on every later event", async () => {
    const reports: ChildReport[] = [];
    const { deps, emitter } = makeDeps([
      task({ id: "task-7", title: "Draft post", status: "running", parent: "convo-parent", convo: "convo-child" }),
    ]);
    deps.onChildReport = (r) => reports.push(r);
    const driver = new OrchestratorDriver(deps);
    await driver.start();

    emitter.emit({ convoId: "convo-child", state: "needs-input", reason: "perm" });
    await flushReports();
    expect(reports).toHaveLength(1);
    expect(reports[0].outcome).toBe("blocked");

    // The card is already parked; further needs-input/stopped noise is not news.
    emitter.emit({ convoId: "convo-child", state: "needs-input", reason: "perm" });
    await flushReports();
    emitter.emit({ convoId: "convo-child", state: "stopped", reason: "stopped" });
    await flushReports();

    expect(reports).toHaveLength(1);
  });

  it("an approved card resumes the child, so its finish reaches the parent", async () => {
    const reports: ChildReport[] = [];
    const { deps, emitter } = makeDeps([
      task({ id: "task-8", title: "Touch file", status: "running", parent: "convo-parent", convo: "convo-child" }),
    ]);
    deps.onChildReport = (r) => reports.push(r);
    const driver = new OrchestratorDriver(deps);
    await driver.start();

    emitter.emit({ convoId: "convo-child", state: "needs-input", reason: "perm" });
    await flushReports();
    // The view emits turn-start when the card is answered and the turn goes on.
    emitter.emit({ convoId: "convo-child", state: "turn-start" });
    emitter.emit({ convoId: "convo-child", state: "turn-end" });
    await flushReports();

    expect(reports.map((r) => r.outcome)).toEqual(["blocked", "done"]);
    expect(driver.snapshot().find((t) => t.id === "task-8")!.status).toBe("review");
  });

  it("re-running a settled child reports again — a real second settling transition", async () => {
    const reports: ChildReport[] = [];
    const { deps, emitter } = makeDeps([
      task({ id: "task-8", title: "Research pricing", status: "running", parent: "convo-parent", convo: "convo-child" }),
    ]);
    deps.onChildReport = (r) => reports.push(r);
    const driver = new OrchestratorDriver(deps);
    await driver.start();

    emitter.emit({ convoId: "convo-child", state: "turn-end" });
    await flushReports();
    expect(reports).toHaveLength(1);

    // The child picks work back up (turn-start -> running), then finishes again.
    emitter.emit({ convoId: "convo-child", state: "turn-start" });
    await vi.advanceTimersByTimeAsync(1);
    emitter.emit({ convoId: "convo-child", state: "turn-end" });
    await flushReports();

    expect(reports).toHaveLength(2);
  });

  it("a throwing onChildReport consumer does not break the driver", async () => {
    const { deps, emitter } = makeDeps([
      task({ id: "task-5", title: "Child", status: "running", parent: "convo-parent", convo: "convo-child" }),
    ]);
    deps.onChildReport = () => {
      throw new Error("boom");
    };
    const driver = new OrchestratorDriver(deps);
    await driver.start();

    emitter.emit({ convoId: "convo-child", state: "turn-end" });
    await expect(flushReports()).resolves.toBeUndefined();

    // The reducer's own transition (turn-end -> review) must still have applied.
    expect(driver.snapshot().find((t) => t.id === "task-5")!.status).toBe("review");
  });

  /**
   * `stop()` is not only "the board was closed": the board also stops and
   * rebuilds the driver whenever the ledger changes underneath it, which is now
   * a routine event (a `spawn_task` write). Either can land inside the 2s report
   * debounce, and a dropped report is the child's output gone for good — the
   * parent's queue is the only route it has back.
   */
  it("stop() DELIVERS a queued report instead of dropping it, and fires no timer after", async () => {
    const reports: ChildReport[] = [];
    const { deps, emitter } = makeDeps([
      task({ id: "task-9", title: "Child", status: "running", parent: "convo-parent", convo: "convo-child" }),
    ]);
    deps.onChildReport = (r) => reports.push(r);
    const driver = new OrchestratorDriver(deps);
    await driver.start();

    emitter.emit({ convoId: "convo-child", state: "turn-end" });
    await vi.advanceTimersByTimeAsync(1); // dispatch settles; well inside the debounce
    expect(reports).toHaveLength(0); // still batching

    driver.stop();
    expect(reports).toHaveLength(1); // handed over on the way out
    expect(reports[0].taskId).toBe("task-9");

    // And nothing arrives twice: the timer was cancelled, not merely beaten.
    await flushReports();
    expect(reports).toHaveLength(1);
  });

  // A child that fails to spawn never gets a convo, so it never emits a
  // convo-state event and `maybeQueueChildReport` can never fire for it. Without
  // wiring the catch block in `runEffect` to queue a report directly, a parent
  // that fans out 3 children where one fails to spawn gets 2 reports and waits
  // forever on the third. These pin the fix at `runEffect`'s catch block.

  it("reports a spawn failure to the parent as an error outcome carrying the failure message", async () => {
    const reports: ChildReport[] = [];
    const { deps } = makeDeps([
      task({ id: "task-7", title: "Research pricing", status: "queued", order: 0, parent: "convo-parent" }),
    ]);
    deps.onChildReport = (r) => reports.push(r);
    deps.spawn = vi.fn(async () => {
      throw new Error("CLI down");
    });
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    await flushReports();

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      taskId: "task-7",
      title: "Research pricing",
      outcome: "error",
      // The failure path is exactly where childConvoId cannot identify the
      // parent — no convo was ever created — so parentConvoId has to carry it.
      childConvoId: "",
      parentConvoId: "convo-parent",
    });
    expect(reports[0].excerpt).toContain("CLI down");

    // The rest of the catch block's behavior (needs-input + error badge +
    // Notice) must be unaffected by the new report path.
    const t = driver.snapshot().find((x) => x.id === "task-7")!;
    expect(t.status).toBe("needs-input");
    expect(t.inputReason).toBe("error");
    expect(deps.notify).toHaveBeenCalled();
  });

  it("reports a spawn failure to the parent when spawn resolves empty (the other failure path)", async () => {
    const reports: ChildReport[] = [];
    const { deps } = makeDeps([
      task({ id: "task-9", title: "Empty spawn", status: "queued", order: 0, parent: "convo-parent" }),
    ]);
    deps.onChildReport = (r) => reports.push(r);
    deps.spawn = vi.fn(async () => "");
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    await flushReports();

    expect(reports).toHaveLength(1);
    expect(reports[0].outcome).toBe("error");
    expect(reports[0].taskId).toBe("task-9");
    expect(reports[0].childConvoId).toBe("");
    expect(reports[0].parentConvoId).toBe("convo-parent");
  });

  it("emits no report for a spawn failure on a task without a parent", async () => {
    const reports: ChildReport[] = [];
    const { deps } = makeDeps([task({ id: "task-8", title: "Solo task", status: "queued", order: 0 })]);
    deps.onChildReport = (r) => reports.push(r);
    deps.spawn = vi.fn(async () => {
      throw new Error("CLI down");
    });
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    await flushReports();

    expect(reports).toHaveLength(0);
    const t = driver.snapshot().find((x) => x.id === "task-8")!;
    expect(t.status).toBe("needs-input");
  });

  /**
   * The two halves composed. Each side passed on its own while the feature was
   * broken end to end: the driver emitted a report, the view had a consumer,
   * and the report was dropped in between because the consumer resolved the
   * parent by looking `childConvoId` up among the conversations — which finds
   * nothing when the spawn failed and there never was a child convo. These wire
   * the REAL consumer (`queueReportForParent`, what `deliverChildReport` calls)
   * onto the REAL driver, so that gap cannot reopen silently.
   */
  it("a spawn-failure report reaches the parent conversation through the real consumer", async () => {
    const parent = { id: "convo-parent" } as { id: string; pendingChildReports?: ChildReport[] };
    // The child's own convo does NOT exist — nothing was ever spawned.
    const convos = [parent];
    const { deps } = makeDeps([
      task({ id: "task-10", title: "Research pricing", status: "queued", order: 0, parent: "convo-parent" }),
    ]);
    deps.onChildReport = (r) => void queueReportForParent(convos, r);
    deps.spawn = vi.fn(async () => {
      throw new Error("CLI down");
    });
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    await flushReports();

    expect(parent.pendingChildReports).toHaveLength(1);
    expect(drainReportsForParent(parent)).toContain("Research pricing");
  });

  it("a finished child's report reaches the parent through the real consumer", async () => {
    const parent = { id: "convo-parent" } as { id: string; pendingChildReports?: ChildReport[] };
    const child = { id: "convo-child" } as { id: string; pendingChildReports?: ChildReport[] };
    const convos = [parent, child];
    const { deps, emitter } = makeDeps([
      task({ id: "task-11", title: "Draft post", status: "running", parent: "convo-parent", convo: "convo-child" }),
    ]);
    deps.onChildReport = (r) => void queueReportForParent(convos, r);
    deps.lastAssistantText = () => "Drafted.";
    const driver = new OrchestratorDriver(deps);
    await driver.start();

    emitter.emit({ convoId: "convo-child", state: "turn-end" });
    await flushReports();

    // The report lands on the PARENT, never on the child that produced it.
    expect(child.pendingChildReports).toBeUndefined();
    const text = drainReportsForParent(parent);
    expect(text).toContain("Draft post");
    expect(text).toContain("Drafted.");
    // Consumed once: the parent's turn after this one gets nothing.
    expect(drainReportsForParent(parent)).toBe("");
  });
});

describe("OrchestratorDriver — reconciliation on boot", () => {
  it("flags chatMissing for a running task whose convo is gone", async () => {
    const { deps } = makeDeps([task({ id: "task-1", status: "running", convo: "convo-old", order: 0 })]);
    // liveness returns exists:false for convo-old (default).
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    const t = driver.snapshot().find((x) => x.id === "task-1")!;
    expect(t.chatMissing).toBe(true);
  });

  it("corrects a running task to review when its convo is idle", async () => {
    const { deps, liveness } = makeDeps([
      task({ id: "task-1", status: "running", convo: "convo-live", order: 0 }),
    ]);
    liveness.set("convo-live", { exists: true, streaming: false, pendingRequest: false });
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    expect(driver.snapshot().find((x) => x.id === "task-1")!.status).toBe("review");
  });

  it("re-running a chat-missing task spawns a fresh convo and records the new id", async () => {
    const { deps, spawned } = makeDeps([task({ id: "task-1", status: "running", convo: "convo-old", order: 0 })]);
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    expect(driver.snapshot().find((x) => x.id === "task-1")!.chatMissing).toBe(true);

    await driver.run("task-1");
    await flush();
    expect(spawned).toHaveLength(1);
    const t = driver.snapshot().find((x) => x.id === "task-1")!;
    expect(t.status).toBe("running");
    expect(t.convo).toBe("convo-1");
    expect(t.chatMissing).toBeFalsy();
  });
});

/**
 * "No host to put a conversation in" is NOT a spawn failure.
 *
 * Once the driver runs on plugin load (rather than only while the board tab is
 * open), the very first scheduler pass can happen before any ChatView exists.
 * Burning every queued task into `needs-input` with an error badge and a false
 * "it failed" report to its parent would be a regression, not a fix — so the
 * driver asks `canSpawn()` first and WITHHOLDS the promotion when the answer is
 * no: the task stays `queued`, no slot is consumed, nothing is reported.
 */
describe("OrchestratorDriver — no conversation host available", () => {
  it("withholds the promotion: the task stays queued, with no badge, no notice, no report", async () => {
    const { deps, spawned } = makeDeps([task({ id: "task-1", status: "queued", order: 0, parent: "convo-parent" })]);
    const reports: ChildReport[] = [];
    deps.onChildReport = (r) => reports.push(r);
    deps.canSpawn = () => false;
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    await flush();

    const t = driver.snapshot().find((x) => x.id === "task-1")!;
    expect(t.status).toBe("queued");
    expect(t.inputReason).toBeUndefined();
    expect(spawned).toHaveLength(0);
    expect(deps.notify).not.toHaveBeenCalled();
    expect(reports).toEqual([]);
  });

  it("consumes no concurrency slot while withheld (a later host start still gets the full cap)", async () => {
    const { deps, spawned } = makeDeps([
      task({ id: "task-1", status: "queued", order: 0 }),
      task({ id: "task-2", status: "queued", order: 1 }),
      task({ id: "task-3", status: "queued", order: 2 }),
    ]);
    let host = false;
    deps.canSpawn = () => host;
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    await flush();
    expect(driver.snapshot().filter((t) => t.status === "running")).toHaveLength(0);

    host = true;
    await driver.pump();
    await flush();
    // Cap 2: exactly two spawn, the third stays queued — the withheld pass must
    // not have leaked slots.
    expect(spawned).toHaveLength(2);
    expect(driver.snapshot().filter((t) => t.status === "running")).toHaveLength(2);
  });

  it("tells the shell a host is missing so it can arm a retry", async () => {
    const { deps } = makeDeps([task({ id: "task-1", status: "queued", order: 0 })]);
    deps.canSpawn = () => false;
    deps.onSpawnHostMissing = vi.fn();
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    await flush();
    expect(deps.onSpawnHostMissing).toHaveBeenCalled();
  });

  it("still treats a genuine spawn failure as a failure when a host IS available", async () => {
    const { deps } = makeDeps([task({ id: "task-1", status: "queued", order: 0, parent: "convo-parent" })]);
    const reports: ChildReport[] = [];
    deps.onChildReport = (r) => reports.push(r);
    deps.canSpawn = () => true;
    deps.spawn = vi.fn(async () => {
      throw new Error("CLI down");
    });
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    await flush();

    const t = driver.snapshot().find((x) => x.id === "task-1")!;
    expect(t.status).toBe("needs-input");
    expect(t.inputReason).toBe("error");
    expect(deps.notify).toHaveBeenCalled();
  });
});
