import { describe, expect, it, vi } from "vitest";
import type { ProposalPayload, ProposalRecord } from "../src/core/proposals";
import {
  routeAcceptedProposal,
  type ProposalAcceptanceDeps,
} from "../src/obsidian/proposal-router";

type PayloadByKind = {
  [K in ProposalPayload["kind"]]: Extract<ProposalPayload, { kind: K }>;
};

const payloads = {
  task: { kind: "task", title: "Ship Phase 1", prompt: "Finish the proposal inbox", model: "sonnet" },
  loop: { kind: "loop", title: "Check adoption", note: "Review proposal acceptance", resurface: "2026-08-01", tags: ["exo"] },
  decision: { kind: "decision", title: "Use explicit accept", context: "Suggestions are inert", decision: "Require Accept" },
  playbook: { kind: "playbook", name: "Weekly Review", prompt: "Review this week" },
} satisfies PayloadByKind;

function record<K extends ProposalPayload["kind"]>(kind: K): ProposalRecord {
  return {
    id: `proposal-${kind}`,
    kind,
    status: "pending",
    title: kind === "playbook" ? payloads.playbook.name : payloads[kind].title,
    payload: payloads[kind],
    rationale: "Explicit user intent",
    fingerprint: `fingerprint-${kind}`,
    source: { convoId: "convo-1", turnId: "turn-1", createdAt: 1_720_000_000_000 },
  } as ProposalRecord;
}

function deps(): ProposalAcceptanceDeps {
  return {
    tasks: { create: vi.fn(async () => ({ id: "task-1" })) },
    loops: { create: vi.fn(async () => ({ id: "loop-1", path: "Memory/open-loops.md" })) },
    decisions: { captureRawPreserving: vi.fn(async () => ({ path: "_system/memory/decisions/decision.md" })) },
    playbooks: {
      save: vi.fn(async ({ name }) => ({ name })),
    },
  };
}

describe("routeAcceptedProposal", () => {
  it("routes tasks through the TaskStore.create-shaped dependency", async () => {
    const d = deps();
    await expect(routeAcceptedProposal(record("task"), d)).resolves.toEqual({ ok: true, target: "task-1" });
    expect(d.tasks.create).toHaveBeenCalledWith({
      proposalId: "proposal-task",
      title: "Ship Phase 1",
      prompt: "Finish the proposal inbox",
      model: "sonnet",
    });
  });

  it("routes loops through the shared queued Open Loops create dependency", async () => {
    const d = deps();
    await expect(routeAcceptedProposal(record("loop"), d)).resolves.toEqual({
      ok: true,
      target: "loop-1",
      path: "Memory/open-loops.md",
    });
    expect(d.loops.create).toHaveBeenCalledWith({
      proposalId: "proposal-loop",
      title: "Check adoption",
      note: "Review proposal acceptance",
      resurface: "2026-08-01",
      tags: ["exo"],
    });
  });

  it("routes decisions through the raw-preserving capture dependency", async () => {
    const d = deps();
    await expect(routeAcceptedProposal(record("decision"), d)).resolves.toEqual({
      ok: true,
      target: "_system/memory/decisions/decision.md",
    });
    expect(d.decisions.captureRawPreserving).toHaveBeenCalledWith({
      proposalId: "proposal-decision",
      title: "Use explicit accept",
      context: "Suggestions are inert",
      decision: "Require Accept",
      rationale: "Explicit user intent",
    });
  });

  it("routes the requested playbook name through the serialized settings target", async () => {
    const d = deps();
    await expect(routeAcceptedProposal(record("playbook"), d)).resolves.toEqual({ ok: true, target: "Weekly Review" });
    expect(d.playbooks.save).toHaveBeenCalledWith({
      proposalId: "proposal-playbook",
      name: "Weekly Review",
      prompt: "Review this week",
    });
  });

  it.each(["task", "loop", "decision", "playbook"] as const)(
    "converts a %s dependency failure to a route error",
    async (kind) => {
      const d = deps();
      if (kind === "task") vi.mocked(d.tasks.create).mockRejectedValue(new Error("task unavailable"));
      if (kind === "loop") vi.mocked(d.loops.create).mockRejectedValue(new Error("loop unavailable"));
      if (kind === "decision") vi.mocked(d.decisions.captureRawPreserving).mockRejectedValue(new Error("decision unavailable"));
      if (kind === "playbook") vi.mocked(d.playbooks.save).mockRejectedValue(new Error("playbook unavailable"));

      await expect(routeAcceptedProposal(record(kind), d)).resolves.toEqual({
        ok: false,
        error: `${kind} unavailable`,
      });
    }
  );

  it("rejects a runtime-corrupt kind/payload mismatch before invoking dependencies", async () => {
    const d = deps();
    const corrupt = { ...record("task"), payload: payloads.loop } as unknown as ProposalRecord;
    await expect(routeAcceptedProposal(corrupt, d)).resolves.toEqual({
      ok: false,
      error: 'Proposal kind "task" does not match payload kind "loop".',
    });
    expect(d.tasks.create).not.toHaveBeenCalled();
    expect(d.loops.create).not.toHaveBeenCalled();
  });

  it("returns an error instead of throwing for structurally corrupt runtime input", async () => {
    const corrupt = { ...record("task"), payload: null } as unknown as ProposalRecord;
    await expect(routeAcceptedProposal(corrupt, deps())).resolves.toEqual({
      ok: false,
      error: "Invalid proposal payload.",
    });
  });

  it("keeps the kind matrix compile-time exhaustive", () => {
    expect(Object.keys(payloads).sort()).toEqual(["decision", "loop", "playbook", "task"]);
  });
});
