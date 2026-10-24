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
  loop: { kind: "loop", title: "Check adoption", note: "Review proposal acceptance", resurface: "2026-08-01", tags: ["exo"] },
  decision: { kind: "decision", title: "Use explicit accept", context: "Suggestions are inert", decision: "Require Accept" },
  playbook: { kind: "playbook", name: "Weekly Review", prompt: "Review this week" },
  correction: {
    kind: "correction",
    path: "D/2026-09-24-vault-lean.md",
    change: { type: "frontmatter", set: { status: "superseded" } },
    because: "A newer note supersedes it.",
  },
} satisfies PayloadByKind;

function record<K extends ProposalPayload["kind"]>(kind: K): ProposalRecord {
  return {
    id: `proposal-${kind}`,
    kind,
    status: "pending",
    title: kind === "playbook" ? payloads.playbook.name : kind === "correction" ? "Correct 2026-09-24-vault-lean" : payloads[kind as "loop"].title,
    payload: payloads[kind],
    rationale: "Explicit user intent",
    fingerprint: `fingerprint-${kind}`,
    source: { convoId: "convo-1", turnId: "turn-1", createdAt: 1_720_000_000_000 },
  } as ProposalRecord;
}

function deps(): ProposalAcceptanceDeps {
  return {
    loops: { create: vi.fn(async () => ({ id: "loop-1", path: "Memory/open-loops.md" })) },
    decisions: { captureRawPreserving: vi.fn(async () => ({ path: "_system/memory/decisions/decision.md" })) },
    playbooks: {
      save: vi.fn(async ({ name }) => ({ name })),
    },
    corrections: { apply: vi.fn(async ({ path }) => ({ path })) },
  };
}

describe("routeAcceptedProposal", () => {
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

  it("routes an accepted correction to the note-correction target", async () => {
    const d = deps();
    await expect(routeAcceptedProposal(record("correction"), d)).resolves.toEqual({ ok: true, target: "D/2026-09-24-vault-lean.md" });
    expect(d.corrections.apply).toHaveBeenCalledWith({
      proposalId: "proposal-correction",
      title: "Correct 2026-09-24-vault-lean",
      convoId: "convo-1",
      path: "D/2026-09-24-vault-lean.md",
      change: { type: "frontmatter", set: { status: "superseded" } },
    });
  });

  it.each(["loop", "decision", "playbook", "correction"] as const)(
    "converts a %s dependency failure to a route error",
    async (kind) => {
      const d = deps();
      if (kind === "loop") vi.mocked(d.loops.create).mockRejectedValue(new Error("loop unavailable"));
      if (kind === "decision") vi.mocked(d.decisions.captureRawPreserving).mockRejectedValue(new Error("decision unavailable"));
      if (kind === "playbook") vi.mocked(d.playbooks.save).mockRejectedValue(new Error("playbook unavailable"));
      if (kind === "correction") vi.mocked(d.corrections.apply).mockRejectedValue(new Error("correction unavailable"));

      await expect(routeAcceptedProposal(record(kind), d)).resolves.toEqual({
        ok: false,
        error: `${kind} unavailable`,
      });
    }
  );

  it("rejects a runtime-corrupt kind/payload mismatch before invoking dependencies", async () => {
    const d = deps();
    const corrupt = { ...record("playbook"), payload: payloads.loop } as unknown as ProposalRecord;
    await expect(routeAcceptedProposal(corrupt, d)).resolves.toEqual({
      ok: false,
      error: 'Proposal kind "playbook" does not match payload kind "loop".',
    });
    expect(d.playbooks.save).not.toHaveBeenCalled();
    expect(d.loops.create).not.toHaveBeenCalled();
  });

  it("returns an error instead of throwing for structurally corrupt runtime input", async () => {
    const corrupt = { ...record("playbook"), payload: null } as unknown as ProposalRecord;
    await expect(routeAcceptedProposal(corrupt, deps())).resolves.toEqual({
      ok: false,
      error: "Invalid proposal payload.",
    });
  });

  it("keeps the kind matrix compile-time exhaustive", () => {
    expect(Object.keys(payloads).sort()).toEqual(["correction", "decision", "loop", "playbook"]);
  });
});
