import { describe, expect, it, vi } from "vitest";
import { WriteQueue } from "../src/core/write-queue";
import {
  WorkflowSignalStore,
  parseWorkflowSignalLedger,
  type WorkflowSignalStoreAdapter,
} from "../src/obsidian/workflow-signal-store";
import type { WorkflowSignal } from "../src/core/workflow-signals";

const signal = (turnId: string, createdAt = 100): WorkflowSignal => ({
  id: `wf-${turnId}`,
  signature: "research|vault.read>web.search|markdown",
  intent: "research",
  tools: ["vault.read", "web.search"],
  createdAt,
  convoId: "c1",
  turnId,
  succeeded: true,
});

function memoryAdapter(initial: string | null = null): WorkflowSignalStoreAdapter & { value: string | null } {
  const adapter = {
    value: initial,
    read: vi.fn(async () => adapter.value),
    write: vi.fn(async (value: string) => {
      adapter.value = value;
    }),
  };
  return adapter;
}

describe("WorkflowSignalStore", () => {
  it("loads missing or corrupt data as an empty versioned ledger", async () => {
    expect(await new WorkflowSignalStore(memoryAdapter(), new WriteQueue()).load()).toEqual({
      version: 1,
      signals: [],
    });
    expect(await new WorkflowSignalStore(memoryAdapter("{broken"), new WriteQueue()).load()).toEqual({
      version: 1,
      signals: [],
    });
  });

  it("refuses to record over a corrupt ledger instead of replacing it", async () => {
    const adapter = memoryAdapter("{broken");
    await expect(new WorkflowSignalStore(adapter, new WriteQueue()).record(signal("t1"), 100)).rejects.toThrow(/unreadable/);
    expect(adapter.value).toBe("{broken");
    expect(adapter.write).not.toHaveBeenCalled();
  });

  it("rejects unsafe or malformed stored records rather than preserving free text", () => {
    const raw = JSON.stringify({
      version: 1,
      signals: [
        signal("safe"),
        { ...signal("unsafe"), tools: ["Read private@email.example"] },
        { ...signal("bad-intent"), intent: "Acme acquisition" },
      ],
    });

    expect(parseWorkflowSignalLedger(raw).signals).toEqual([signal("safe")]);
  });

  it("serializes concurrent records without losing either turn", async () => {
    const adapter = memoryAdapter();
    const store = new WorkflowSignalStore(adapter, new WriteQueue());

    await Promise.all([
      store.record(signal("t1", 100), 100),
      store.record(signal("t2", 101), 101),
    ]);

    expect((await store.load()).signals.map((item) => item.turnId)).toEqual(["t1", "t2"]);
    expect(adapter.write).toHaveBeenCalledTimes(2);
  });

  it("does not rewrite the ledger for a duplicate retry", async () => {
    const adapter = memoryAdapter();
    const store = new WorkflowSignalStore(adapter, new WriteQueue());
    await store.record(signal("t1"), 100);
    const duplicate = await store.record(signal("t1"), 100);

    expect(duplicate.candidate).toBeNull();
    expect(adapter.write).toHaveBeenCalledTimes(1);
  });
});
