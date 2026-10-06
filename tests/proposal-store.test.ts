import { describe, expect, it, vi } from "vitest";
import { WriteQueue } from "../src/core/write-queue";
import type { ProposalCandidate, ProposalRecord } from "../src/core/proposals";
import {
  PROPOSALS_FILE,
  ProposalStore,
  type ProposalFileAdapter,
  type ProposalMetrics,
  type ProposalRouteResult,
} from "../src/obsidian/proposal-store";

function task(title: string, prompt = "Do it"): ProposalCandidate {
  return {
    kind: "task",
    title,
    payload: { kind: "task", title, prompt },
    rationale: "Explicit commitment",
  };
}

function playbook(
  name: string,
  overrides: Partial<Extract<ProposalCandidate["payload"], { kind: "playbook" }>> = {}
): ProposalCandidate {
  return {
    kind: "playbook",
    title: name,
    payload: { kind: "playbook", name, prompt: "Reusable prompt", ...overrides },
    rationale: "Recurring workflow",
  };
}

function loop(title: string, note = "Circle back"): ProposalCandidate {
  return {
    kind: "loop",
    title,
    payload: { kind: "loop", title, note },
    rationale: "Explicit follow-up",
  };
}

function decision(title: string): ProposalCandidate {
  return {
    kind: "decision",
    title,
    payload: { kind: "decision", title, context: "Context", decision: "Do X", rationale: "Because" },
    rationale: "Decision already made",
  };
}

function source(createdAt = 1_720_000_000_000) {
  return { convoId: "convo-1", turnId: "turn-1", createdAt };
}

function fakeFiles(initial?: string) {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set(PROPOSALS_FILE, initial);
  const adapter: ProposalFileAdapter = {
    read: async (path) => files.get(path) ?? null,
    write: async (path, content) => {
      files.set(path, content);
    },
  };
  return { adapter, files };
}

/** Route for tests that never accept anything. */
const idleRoute = async () => ({ ok: true as const, target: "idle" });

const zeroMetrics: ProposalMetrics = {
  generated: 0,
  accepted: 0,
  dismissed: 0,
  duplicates: 0,
  parseErrors: 0,
  routeErrors: 0,
};

describe("ProposalStore", () => {
  it("loads a safe empty versioned store when proposals.json is absent", async () => {
    const { adapter } = fakeFiles();
    const snapshot = await new ProposalStore(adapter, new WriteQueue(), idleRoute).load();
    expect(snapshot.data).toEqual({ version: 1, records: [], metrics: zeroMetrics });
    expect(snapshot.warnings).toEqual([]);
  });

  it("falls back without deleting or rewriting a wholly corrupt file", async () => {
    const raw = "{ definitely-not-json";
    const { adapter, files } = fakeFiles(raw);
    const store = new ProposalStore(adapter, new WriteQueue(), idleRoute);

    const snapshot = await store.load();
    expect(snapshot.data.records).toEqual([]);
    expect(snapshot.warnings[0]).toMatch(/could not parse/i);
    expect(files.get(PROPOSALS_FILE)).toBe(raw);
    await expect(store.append(task("No overwrite"), source())).rejects.toThrow(/corrupt/i);
    expect(files.get(PROPOSALS_FILE)).toBe(raw);
  });

  it("logically quarantines invalid records, preserves them on write, and keeps valid records", async () => {
    const { adapter, files } = fakeFiles();
    const seed = new ProposalStore(adapter, new WriteQueue(), idleRoute);
    const appended = await seed.append(task("Valid"), source());
    expect(appended.status).toBe("appended");
    const parsed = JSON.parse(files.get(PROPOSALS_FILE)!) as { records: unknown[]; metrics: ProposalMetrics };
    parsed.records.push({ id: "broken", kind: "task" });
    files.set(PROPOSALS_FILE, JSON.stringify(parsed));

    const store = new ProposalStore(adapter, new WriteQueue(), idleRoute);
    const before = await store.load();
    expect(before.data.records).toHaveLength(1);
    expect(before.warnings).toEqual([expect.stringMatching(/record 1/i)]);

    await store.recordMetric("parseErrors");
    const rawAfter = JSON.parse(files.get(PROPOSALS_FILE)!) as { records: unknown[] };
    expect(rawAfter.records).toHaveLength(2);
    expect(rawAfter.records).toContainEqual({ id: "broken", kind: "task" });
    expect((await store.load()).data.metrics.parseErrors).toBe(1);
  });

  it("validates candidates, assigns stable collision-safe ids/source, and deduplicates", async () => {
    const { adapter } = fakeFiles();
    const store = new ProposalStore(adapter, new WriteQueue(), idleRoute);
    const first = await store.append(task("Ship it"), source());
    expect(first.status).toBe("appended");
    if (first.status !== "appended") throw new Error("expected append");
    expect(first.record.id).toMatch(/^proposal-/);
    expect(first.record.source).toEqual(source());

    const duplicate = await store.append(task("  SHIP IT  ", " do   it "), source());
    expect(duplicate.status).toBe("duplicate");
    const invalid = await store.append({ kind: "task", title: "", payload: { kind: "task", title: "", prompt: "" }, rationale: "" }, source());
    expect(invalid.status).toBe("invalid");

    const snapshot = await store.load();
    expect(snapshot.data.records).toHaveLength(1);
    expect(snapshot.data.metrics).toMatchObject({ generated: 2, duplicates: 1 });
  });

  it("retains every pending record while pruning resolved records through the core policy", async () => {
    const { adapter } = fakeFiles();
    const store = new ProposalStore(adapter, new WriteQueue(), idleRoute);
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const current = await store.append(task("Current"), source(Date.now()));
    const stale = await store.append(task("Stale"), { ...source(old), turnId: "old" });
    if (current.status !== "appended" || stale.status !== "appended") throw new Error("expected append");
    await store.dismiss(stale.record.id, old);

    const pending = await store.listPending();
    expect(pending.records.map((record) => record.title)).toEqual(["Current"]);
    expect((await store.load()).data.records.map((record) => record.title)).toEqual(["Current"]);
  });

  it("marks accepted only after a successful route and records route failures as pending", async () => {
    const { adapter } = fakeFiles();
    let outcome: ProposalRouteResult = { ok: false, error: "target unavailable" };
    const store = new ProposalStore(adapter, new WriteQueue(), async () => outcome);
    const appended = await store.append(task("Route me"), source());
    if (appended.status !== "appended") throw new Error("expected append");

    const failed = await store.accept(appended.record.id);
    expect(failed).toMatchObject({ ok: false, error: "target unavailable" });
    expect((await store.listPending()).records).toHaveLength(1);
    expect((await store.listPending()).records[0].lastError).toBe("target unavailable");
    expect((await store.load()).data.metrics.routeErrors).toBe(1);

    outcome = { ok: true, target: "task-42" };
    const succeeded = await store.accept(appended.record.id);
    expect(succeeded).toMatchObject({ ok: true, target: "task-42" });
    expect(succeeded.record.lastError).toBeUndefined();
    expect((await store.listPending()).records).toEqual([]);
    expect((await store.load()).data.metrics.accepted).toBe(1);
  });

  it("treats a thrown route as a failure without resolving the proposal", async () => {
    const { adapter } = fakeFiles();
    const store = new ProposalStore(adapter, new WriteQueue(), async () => {
      throw new Error("boom");
    });
    const appended = await store.append(task("Retry me"), source());
    if (appended.status !== "appended") throw new Error("expected append");
    const result = await store.accept(appended.record.id);
    expect(result).toMatchObject({ ok: false, error: "boom" });
    expect((await store.listPending()).records[0].status).toBe("pending");
  });

  it("makes concurrent double accept single-flight and idempotent", async () => {
    const { adapter } = fakeFiles();
    const route = vi.fn(async () => ({ ok: true as const, target: "task-once" }));
    const store = new ProposalStore(adapter, new WriteQueue(), route);
    const appended = await store.append(task("Once"), source());
    if (appended.status !== "appended") throw new Error("expected append");
    const [first, second] = await Promise.all([
      store.accept(appended.record.id),
      store.accept(appended.record.id),
    ]);
    expect(route).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect((await store.load()).data.metrics.accepted).toBe(1);
  });

  it("recovers after the accepted-state write fails without duplicating an idempotent target", async () => {
    const { adapter } = fakeFiles();
    const targets = new Map<string, string>();
    const route = vi.fn(async (record: ProposalRecord) => {
      const target = targets.get(record.id) ?? `task-${targets.size + 1}`;
      targets.set(record.id, target);
      return { ok: true as const, target };
    });
    const store = new ProposalStore(adapter, new WriteQueue(), route);
    const appended = await store.append(task("Durable retry"), source());
    if (appended.status !== "appended") throw new Error("expected append");

    const write = adapter.write.bind(adapter);
    let failNextWrite = true;
    adapter.write = async (path, content) => {
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error("disk full");
      }
      await write(path, content);
    };

    await expect(store.accept(appended.record.id)).rejects.toThrow("disk full");
    const reloaded = new ProposalStore(adapter, new WriteQueue(), route);
    await expect(reloaded.accept(appended.record.id)).resolves.toMatchObject({
      ok: true,
      target: "task-1",
    });
    expect(targets.size).toBe(1);
    expect(route).toHaveBeenCalledTimes(2);
    expect((await reloaded.listPending()).records).toEqual([]);
  });

  it("serializes concurrent append and accept without losing either update", async () => {
    const { adapter } = fakeFiles();
    const queue = new WriteQueue();
    const enqueue = vi.spyOn(queue, "enqueue");
    const store = new ProposalStore(adapter, queue, async () => ({ ok: true, target: "task-first" }));
    const first = await store.append(task("First"), source());
    if (first.status !== "appended") throw new Error("expected append");
    await Promise.all([
      store.append(task("Second"), { ...source(), turnId: "turn-2" }),
      store.accept(first.record.id),
    ]);
    const snapshot = await store.load();
    expect(snapshot.data.records).toHaveLength(2);
    expect(snapshot.data.records.find((record) => record.id === first.record.id)?.status).toBe("accepted");
    expect(snapshot.data.records.find((record) => record.title === "Second")?.status).toBe("pending");
    expect(enqueue).toHaveBeenCalledTimes(3);
  });

  it("edits a pending playbook, recomputes title and fingerprint, and keeps Foundry metadata", async () => {
    const { adapter } = fakeFiles();
    const routed = vi.fn(async (record: ProposalRecord) => ({ ok: true as const, target: record.title }));
    const store = new ProposalStore(adapter, new WriteQueue(), routed);
    const appended = await store.append(
      playbook("Draft brief", { outcome: "A one-pager", inputs: ["topic"], workflowSignature: "research|web.search|markdown" }),
      source()
    );
    if (appended.status !== "appended") throw new Error("expected append");
    const before = appended.record.fingerprint;

    const updated = await store.updatePendingPlaybook(appended.record.id, { name: "GTM brief", prompt: "Draft a GTM brief for {{topic}}" });
    expect(updated.status).toBe("pending");
    expect(updated.title).toBe("GTM brief");
    expect(updated.payload).toMatchObject({
      kind: "playbook",
      name: "GTM brief",
      prompt: "Draft a GTM brief for {{topic}}",
      outcome: "A one-pager",
      inputs: ["topic"],
      workflowSignature: "research|web.search|markdown",
    });
    expect(updated.fingerprint).not.toBe(before);

    // Accept must route the persisted, edited values — never a stale copy.
    const accepted = await store.accept(appended.record.id);
    expect(accepted).toMatchObject({ ok: true, target: "GTM brief" });
    expect(routed.mock.calls[0][0].payload).toMatchObject({ name: "GTM brief", prompt: "Draft a GTM brief for {{topic}}" });
  });

  it("refuses to edit a missing, non-pending, or non-playbook proposal and re-validates fields", async () => {
    const { adapter } = fakeFiles();
    const store = new ProposalStore(adapter, new WriteQueue(), idleRoute);
    const pbook = await store.append(playbook("Editable"), source());
    const chore = await store.append(task("Not a playbook"), { ...source(), turnId: "turn-2" });
    if (pbook.status !== "appended" || chore.status !== "appended") throw new Error("expected append");

    await expect(store.updatePendingPlaybook("missing", { name: "X", prompt: "Y" })).rejects.toThrow(/not found/i);
    await expect(store.updatePendingPlaybook(chore.record.id, { name: "X", prompt: "Y" })).rejects.toThrow(/playbook/i);
    await expect(store.updatePendingPlaybook(pbook.record.id, { name: "", prompt: "Y" })).rejects.toThrow();
    await expect(store.updatePendingPlaybook(pbook.record.id, { name: "X", prompt: "y".repeat(4001) })).rejects.toThrow();

    await store.dismiss(pbook.record.id);
    await expect(store.updatePendingPlaybook(pbook.record.id, { name: "X", prompt: "Y" })).rejects.toThrow(/pending/i);
  });

  it("collects blocked workflow signatures from pending and accepted playbooks only", async () => {
    const { adapter } = fakeFiles();
    const store = new ProposalStore(adapter, new WriteQueue(), async () => ({ ok: true, target: "Accepted" }));
    const pending = await store.append(playbook("Pending", { workflowSignature: "research|web.search|markdown" }), source());
    const toAccept = await store.append(playbook("Accepted", { workflowSignature: "write|vault.write|vault-write" }), { ...source(), turnId: "turn-2" });
    const toDismiss = await store.append(playbook("Dismissed", { workflowSignature: "plan|no-tools|message" }), { ...source(), turnId: "turn-3" });
    await store.append(playbook("No signature"), { ...source(), turnId: "turn-4" });
    await store.append(task("Chore"), { ...source(), turnId: "turn-5" });
    if (pending.status !== "appended" || toAccept.status !== "appended" || toDismiss.status !== "appended") throw new Error("expected append");

    await store.accept(toAccept.record.id);
    await store.dismiss(toDismiss.record.id);

    const blocked = await store.blockedWorkflowSignatures();
    expect([...blocked].sort()).toEqual(["research|web.search|markdown", "write|vault.write|vault-write"]);
  });

  it("loads and accepts a legacy playbook record persisted without Foundry metadata", async () => {
    const { adapter } = fakeFiles();
    const seed = new ProposalStore(adapter, new WriteQueue(), idleRoute);
    // A record shaped exactly like one saved before P4-T03 (no metadata fields).
    const appended = await seed.append(playbook("Legacy playbook"), source());
    if (appended.status !== "appended") throw new Error("expected append");
    expect(appended.record.payload).toEqual({ kind: "playbook", name: "Legacy playbook", prompt: "Reusable prompt" });

    const store = new ProposalStore(adapter, new WriteQueue(), async () => ({ ok: true, target: "Legacy playbook" }));
    expect((await store.listPending()).records).toHaveLength(1);
    const accepted = await store.accept(appended.record.id);
    expect(accepted).toMatchObject({ ok: true, target: "Legacy playbook" });
    expect(await store.blockedWorkflowSignatures()).toEqual(new Set());
  });

  it("dismisses idempotently and reload reconstructs pending records plus metrics", async () => {
    const { adapter } = fakeFiles();
    const firstStore = new ProposalStore(adapter, new WriteQueue(), idleRoute);
    const kept = await firstStore.append(task("Keep"), source());
    const removed = await firstStore.append(task("Dismiss"), { ...source(), turnId: "turn-2" });
    if (kept.status !== "appended" || removed.status !== "appended") throw new Error("expected append");
    await firstStore.dismiss(removed.record.id);
    await firstStore.dismiss(removed.record.id);
    await firstStore.recordMetric("parseErrors", 2);

    const reloaded = new ProposalStore(adapter, new WriteQueue(), idleRoute);
    expect((await reloaded.listPending()).records.map((record: ProposalRecord) => record.id)).toEqual([kept.record.id]);
    expect((await reloaded.load()).data.metrics).toMatchObject({ generated: 2, dismissed: 1, parseErrors: 2 });
  });

  describe("memory kinds route with no human gate", () => {
    it("routes a loop immediately as accepted, with no pending step", async () => {
      const { adapter } = fakeFiles();
      const route = vi.fn(async () => ({ ok: true as const, target: "loop-1", path: "Memory/open-loops.md" }));
      const store = new ProposalStore(adapter, new WriteQueue(), route);

      const result = await store.append(loop("Call Anna"), source());
      if (result.status !== "applied") throw new Error("expected applied");
      expect(result.path).toBe("Memory/open-loops.md");

      expect(route).toHaveBeenCalledTimes(1);
      expect(result.target).toBe("loop-1");
      expect(result.record.status).toBe("accepted");
      expect(result.record.resolvedAt).toEqual(expect.any(Number));
      expect((await store.listPending()).records).toEqual([]);
      expect((await store.load()).data.metrics).toMatchObject({ generated: 1, accepted: 1 });
    });

    it("routes a decision immediately as accepted", async () => {
      const { adapter } = fakeFiles();
      const route = vi.fn(async () => ({ ok: true as const, target: "Decisions/x.md" }));
      const store = new ProposalStore(adapter, new WriteQueue(), route);

      const result = await store.append(decision("Use Postgres"), source());
      if (result.status !== "applied") throw new Error("expected applied");

      expect(result.record.status).toBe("accepted");
      expect(result.target).toBe("Decisions/x.md");
      expect(result.path).toBe("Decisions/x.md");
      expect(route).toHaveBeenCalledTimes(1);
    });

    it("appends and routes a memory record in one queue turn and one write", async () => {
      const { adapter } = fakeFiles();
      const queue = new WriteQueue();
      const enqueue = vi.spyOn(queue, "enqueue");
      const write = vi.spyOn(adapter, "write");
      const store = new ProposalStore(adapter, queue, async () => ({ ok: true, target: "loop-1" }));

      await store.append(loop("Call Anna"), source());

      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledTimes(1);
    });

    it("leaves tasks and playbooks pending and never routes them", async () => {
      const { adapter } = fakeFiles();
      const route = vi.fn(async () => ({ ok: true as const, target: "x" }));
      const store = new ProposalStore(adapter, new WriteQueue(), route);

      await store.append(task("Ship it"), source());
      await store.append(playbook("Weekly review"), source());

      expect(route).not.toHaveBeenCalled();
      expect((await store.listPending()).records.map((r) => r.kind).sort()).toEqual(["playbook", "task"]);
    });

    it("keeps a loop pending with its error and retryable when the route fails", async () => {
      const { adapter } = fakeFiles();
      let outcome: ProposalRouteResult = { ok: false, error: "vault is read-only" };
      const store = new ProposalStore(adapter, new WriteQueue(), async () => outcome);

      const result = await store.append(loop("Call Anna"), source());
      if (result.status !== "appended") throw new Error("expected appended");

      expect(result.record.status).toBe("pending");
      expect((await store.listPending()).records[0].lastError).toBe("vault is read-only");
      expect((await store.load()).data.metrics.routeErrors).toBe(1);

      outcome = { ok: true, target: "loop-1" };
      const retried = await store.accept(result.record.id);
      expect(retried).toMatchObject({ ok: true, target: "loop-1" });
      expect((await store.listPending()).records).toEqual([]);
      expect((await store.load()).data.records[0].lastError).toBeUndefined();
    });

    it("still dedups against an auto-accepted loop", async () => {
      const { adapter } = fakeFiles();
      const route = vi.fn(async () => ({ ok: true as const, target: "loop-1" }));
      const store = new ProposalStore(adapter, new WriteQueue(), route);

      await store.append(loop("Call Anna"), source());
      const again = await store.append(loop("Call Anna"), source(1_720_000_001_000));

      expect(again.status).toBe("duplicate");
      expect(route).toHaveBeenCalledTimes(1);
    });
  });
});
