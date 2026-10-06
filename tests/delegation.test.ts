import { describe, it, expect } from "vitest";
import {
  MAX_AGENT_HOPS,
  nextHop,
  formatChatTranscript,
  formatTaskStatus,
  openChildTasks,
  ownedTask,
  planSend,
  shouldWakeParent,
  WAKE_TEXT,
} from "../src/core/delegation";
import type { TaskEntry } from "../src/core/tasks";

const task = (over: Partial<TaskEntry>): TaskEntry =>
  ({ id: "task-1", title: "Research", status: "running", order: 0, prompt: "p", parent: "P", ...over }) as TaskEntry;

describe("planSend", () => {
  it("an idle chat runs the message now, whatever the mode", () => {
    for (const m of ["auto", "queue", "steer"] as const) expect(planSend(m, false, true)).toBe("sent");
  });
  it("a busy chat queues, unless steer is asked and possible", () => {
    expect(planSend("auto", true, true)).toBe("queued");
    expect(planSend("queue", true, true)).toBe("queued");
    expect(planSend("steer", true, true)).toBe("steered");
    expect(planSend("steer", true, false)).toBe("queued");
  });
  it("a turn still in its preamble counts as busy, so the message is queued, not lost", () => {
    for (const m of ["auto", "queue", "steer"] as const) expect(planSend(m, false, true, true)).toBe("queued");
  });
});

describe("shouldWakeParent", () => {
  const idle = { stopped: false, queue: [] };
  it("wakes an open parent once", () => {
    expect(shouldWakeParent(idle, "done", true)).toBe(true);
    expect(shouldWakeParent({ stopped: false, queue: [{ text: WAKE_TEXT }] }, "done", true)).toBe(false);
  });
  it("never restarts a parent the user stopped", () => {
    expect(shouldWakeParent({ stopped: true, queue: [] }, "done", true)).toBe(false);
  });
  it("a stopped child's report waits for the parent's next turn, even after the user typed again", () => {
    expect(shouldWakeParent(idle, "stopped", true)).toBe(false);
  });
  it("a blocked child does not wake the parent: its card is already there", () => {
    expect(shouldWakeParent(idle, "blocked", true)).toBe(false);
  });
  it("never runs a turn in a parent that was closed or archived", () => {
    expect(shouldWakeParent(idle, "done", false)).toBe(false);
    expect(shouldWakeParent({ ...idle, archived: true }, "done", true)).toBe(false);
  });
});

describe("ownedTask / openChildTasks", () => {
  const tasks = [
    task({ id: "a" }),
    task({ id: "b", parent: "Q" }),
    task({ id: "c", status: "queued" }),
    task({ id: "d", status: "done" }),
    task({ id: "e", status: "review" }),
  ];
  it("refuses a task this chat did not delegate", () => {
    expect(ownedTask(tasks, "b", "P")).toBe("Task b was not delegated by this chat.");
    expect(ownedTask(tasks, "zz", "P")).toBe("No task zz.");
    expect((ownedTask(tasks, "a", "P") as TaskEntry).id).toBe("a");
  });
  it("a stop takes down only this parent's unfinished tasks", () => {
    expect(openChildTasks(tasks, "P").map((t) => t.id)).toEqual(["a", "c"]);
  });
});

describe("formatTaskStatus", () => {
  it("says waiting for approval when the child is blocked on a card", () => {
    const s = formatTaskStatus(task({ convo: "k1" }), { exists: true, streaming: true, hasPending: true }, "half done");
    expect(s).toContain("status: waiting for the user's approval");
    expect(s).toContain("chat: k1");
    expect(s).toContain("last answer:\nhalf done");
  });
  it("falls back to the ledger status when the chat is idle or closed", () => {
    expect(formatTaskStatus(task({ status: "review", convo: "k1" }), { exists: false, streaming: false, hasPending: false }, ""))
      .toBe("task-1 · Research\nstatus: review\nchat: k1 (closed)");
  });
});

describe("formatChatTranscript", () => {
  it("keeps the newest messages under the cap and says what it cut", () => {
    const messages = [
      { role: "user" as const, text: "x".repeat(3000) },
      { role: "assistant" as const, segments: [{ t: "text" as const, md: "answer" }] },
      { role: "user" as const, text: "latest ask" },
    ];
    const out = formatChatTranscript({ id: "c1", title: "Pricing", messages }, 1000);
    expect(out).toBe("Pricing (id c1)\n\n[Earlier messages omitted]\n\nASSISTANT: answer\n\nUSER: latest ask");
  });
});

describe("nextHop (send_to_chat loop guard)", () => {
  it("allows a chain up to the cap, then refuses, even if every send is approved", () => {
    const depths = new Map<string, number>();
    let from = "A";
    const hops: (number | null)[] = [];
    for (let i = 0; i < MAX_AGENT_HOPS + 1; i++) {
      const to = from === "A" ? "B" : "A";
      const h = nextHop(depths, from);
      hops.push(h);
      if (h !== null) depths.set(to, h);
      from = to;
    }
    expect(hops).toEqual([1, 2, 3, null]);
  });
  it("a chat the user just wrote in starts again from zero", () => {
    const depths = new Map([["A", 3]]);
    expect(nextHop(depths, "A")).toBeNull();
    depths.delete("A");
    expect(nextHop(depths, "A")).toBe(1);
  });
});
