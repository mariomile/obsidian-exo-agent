import { describe, it, expect } from "vitest";
import {
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
});

describe("shouldWakeParent", () => {
  it("wakes an idle or busy parent once", () => {
    expect(shouldWakeParent({ stopped: false, queue: [] })).toBe(true);
    expect(shouldWakeParent({ stopped: false, queue: [{ text: WAKE_TEXT }] })).toBe(false);
  });
  it("never restarts a parent the user stopped", () => {
    expect(shouldWakeParent({ stopped: true, queue: [] })).toBe(false);
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
