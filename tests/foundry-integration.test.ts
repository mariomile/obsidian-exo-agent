import { describe, expect, it } from "vitest";
import { WriteQueue } from "../src/core/write-queue";
import {
  createWorkflowSignal,
  type WorkflowSignalInput,
} from "../src/core/workflow-signals";
import {
  WorkflowSignalStore,
  type WorkflowSignalStoreAdapter,
} from "../src/obsidian/workflow-signal-store";
import {
  ProposalStore,
  PROPOSALS_FILE,
  type ProposalFileAdapter,
} from "../src/obsidian/proposal-store";
import { parseFoundryDistillation } from "../src/core/foundry-distill";

type ProposalRoute = ConstructorParameters<typeof ProposalStore>[2];

/**
 * End-to-end Workflow Foundry loop, wiring the real signal store, real proposal
 * store, and the pure distiller exactly as `view.ts` orchestrates them — but
 * with a canned distillation reply instead of a live utility pass. This proves
 * the P4-T04 property the isolated unit tests cannot: three equivalent runs
 * yield exactly one proposal, and later runs are suppressed by pending/accepted
 * signatures.
 */

function signalStore(): WorkflowSignalStore {
  let value: string | null = null;
  const adapter: WorkflowSignalStoreAdapter = {
    read: async () => value,
    write: async (next) => { value = next; },
  };
  return new WorkflowSignalStore(adapter, new WriteQueue());
}

function proposalStore(route: ProposalRoute = async (record) => ({ ok: true, target: record.title })): ProposalStore {
  const files = new Map<string, string>();
  const adapter: ProposalFileAdapter = {
    read: async (path) => files.get(path) ?? null,
    write: async (path, content) => { files.set(path, content); },
  };
  void PROPOSALS_FILE;
  return new ProposalStore(adapter, new WriteQueue(), route);
}

const distillReply = JSON.stringify({
  name: "Competitor scan",
  outcome: "A cited competitor summary",
  prompt: "Research {{topic}} in the vault, then the web, and produce a cited summary with gaps.",
  inputs: ["topic"],
  capabilities: ["vault.search", "web.search"],
  why: "This workflow recurred three times.",
});

const turnInput = (turnId: string, createdAt: number): WorkflowSignalInput => ({
  userText: "Research the competitor landscape and summarize",
  tools: [
    { name: "mcp__obsidian__search_vault" },
    { name: "WebSearch" },
  ],
  outputType: "markdown",
  createdAt,
  convoId: "c1",
  turnId,
  succeeded: true,
});

/** One orchestrated turn: record the signal, and on a threshold candidate,
 *  distill (from the canned reply) and append through the Proposal Kernel. */
async function runTurn(
  signals: WorkflowSignalStore,
  proposals: ProposalStore,
  turnId: string,
  createdAt: number,
  reply = distillReply
): Promise<"none" | "appended" | "duplicate"> {
  const blockedSignatures = await proposals.blockedWorkflowSignatures();
  const signal = createWorkflowSignal(turnInput(turnId, createdAt));
  const result = await signals.record(signal, createdAt, { threshold: 3, blockedSignatures });
  if (!result.candidate) return "none";
  const distilled = parseFoundryDistillation(reply, {
    workflowSignature: result.candidate.signature,
    occurrences: result.candidate.occurrences,
  });
  if (distilled.status !== "ok") return "none";
  const appended = await proposals.append(distilled.candidate, { convoId: "c1", turnId, createdAt });
  return appended.status === "appended" ? "appended" : "duplicate";
}

describe("Workflow Foundry — end to end", () => {
  const t0 = Date.parse("2026-07-20T10:00:00Z");
  const MIN = 60 * 1000;

  it("distills exactly one proposal on the third equivalent run", async () => {
    const signals = signalStore();
    const proposals = proposalStore();

    expect(await runTurn(signals, proposals, "t1", t0)).toBe("none");
    expect(await runTurn(signals, proposals, "t2", t0 + MIN)).toBe("none");
    expect(await runTurn(signals, proposals, "t3", t0 + 2 * MIN)).toBe("appended");

    const pending = await proposals.listPending();
    expect(pending.records).toHaveLength(1);
    expect(pending.records[0].payload).toMatchObject({
      kind: "playbook",
      name: "Competitor scan",
      workflowSignature: "research|vault.search>web.search|markdown",
    });
  });

  it("suppresses further distillation while a proposal is pending or accepted", async () => {
    const signals = signalStore();
    const proposals = proposalStore();
    await runTurn(signals, proposals, "t1", t0);
    await runTurn(signals, proposals, "t2", t0 + MIN);
    expect(await runTurn(signals, proposals, "t3", t0 + 2 * MIN)).toBe("appended");

    // A fourth equivalent run finds the pending signature blocked → no candidate.
    expect(await runTurn(signals, proposals, "t4", t0 + 3 * MIN)).toBe("none");

    // Accept it, then a fifth run stays suppressed by the accepted signature.
    const pendingId = (await proposals.listPending()).records[0].id;
    await proposals.accept(pendingId);
    expect(await runTurn(signals, proposals, "t5", t0 + 4 * MIN)).toBe("none");
    expect((await proposals.load()).data.records.filter((r) => r.status === "pending")).toHaveLength(0);
  });

  it("still distills a genuinely different workflow after one is pending", async () => {
    const signals = signalStore();
    const proposals = proposalStore();
    for (const [i, id] of ["t1", "t2", "t3"].entries()) {
      await runTurn(signals, proposals, id, t0 + i * MIN);
    }
    expect((await proposals.listPending()).records).toHaveLength(1);

    // A different signature (write intent, vault.write) recorded three times.
    // Its distillation is a distinct playbook, so it becomes a second proposal.
    const writeReply = JSON.stringify({
      name: "Weekly note",
      prompt: "Draft and save this week's note from {{highlights}}, then link it into the journal.",
      why: "This write workflow recurred three times.",
    });
    const writeInput = (turnId: string, createdAt: number): WorkflowSignalInput => ({
      userText: "Draft and save a weekly note",
      tools: [{ name: "Write" }, { name: "Edit" }],
      outputType: "vault-write",
      createdAt,
      convoId: "c2",
      turnId,
      succeeded: true,
    });
    let appended = 0;
    for (const [i, id] of ["w1", "w2", "w3"].entries()) {
      const blocked = await proposals.blockedWorkflowSignatures();
      const signal = createWorkflowSignal(writeInput(id, t0 + 10 * MIN + i * MIN));
      const result = await signals.record(signal, t0 + 10 * MIN + i * MIN, { threshold: 3, blockedSignatures: blocked });
      if (!result.candidate) continue;
      const distilled = parseFoundryDistillation(writeReply, {
        workflowSignature: result.candidate.signature,
        occurrences: result.candidate.occurrences,
      });
      if (distilled.status !== "ok") continue;
      const outcome = await proposals.append(distilled.candidate, { convoId: "c2", turnId: id, createdAt: t0 + 10 * MIN + i * MIN });
      if (outcome.status === "appended") appended++;
    }
    expect(appended).toBe(1);
    expect((await proposals.listPending()).records).toHaveLength(2);
  });

  it("edits a distilled playbook before accepting and routes the edited values", async () => {
    const signals = signalStore();
    const routed: { name: string; prompt: string }[] = [];
    const proposals = proposalStore(async (record) => {
      if (record.payload.kind === "playbook") routed.push({ name: record.payload.name, prompt: record.payload.prompt });
      return { ok: true, target: record.title };
    });
    await runTurn(signals, proposals, "t1", t0);
    await runTurn(signals, proposals, "t2", t0 + MIN);
    await runTurn(signals, proposals, "t3", t0 + 2 * MIN);
    const id = (await proposals.listPending()).records[0].id;

    await proposals.updatePendingPlaybook(id, { name: "Renamed scan", prompt: "A shorter reusable prompt for the scan." });
    const accepted = await proposals.accept(id);
    expect(accepted.ok).toBe(true);
    expect(routed).toEqual([{ name: "Renamed scan", prompt: "A shorter reusable prompt for the scan." }]);
  });
});
