import { describe, expect, it, vi } from "vitest";
import type { ProposalCandidate, ProposalRecord } from "../src/core/proposals";
import type {
  AppendProposalResult,
  ProposalMetrics,
} from "../src/obsidian/proposal-store";
import {
  buildProposalProducerPrompt,
  produceTurnProposals,
  type ProposalProducerDeps,
  type ProposalTurnInput,
} from "../src/obsidian/proposal-producer";

const source: ProposalRecord["source"] = {
  convoId: "convo-1",
  turnId: "turn-1",
  createdAt: 1_720_000_000_000,
};

const taskJson = {
  kind: "task",
  title: "Prepare launch checklist",
  prompt: "Prepare the launch checklist agreed in this turn.",
  rationale: "Explicit next action: the launch checklist was committed to.",
};

function eligible(overrides: Partial<ProposalTurnInput> = {}): ProposalTurnInput {
  return {
    successful: true,
    responseIsSubstantial: true,
    responseHasError: false,
    hasPendingInteraction: false,
    stopped: false,
    poisoned: false,
    recoveryIncomplete: false,
    administrativeSlashCommand: false,
    userText: "Let's prepare the launch checklist tomorrow.",
    responseText: "Agreed. I will prepare a concrete launch checklist tomorrow and bring it back for review.",
    backgroundEnabled: true,
    suggestionsEnabled: true,
    budgetAllowed: true,
    source,
    ...overrides,
  };
}

function metrics(): ProposalMetrics {
  return {
    generated: 0,
    accepted: 0,
    dismissed: 0,
    duplicates: 0,
    parseErrors: 0,
    routeErrors: 0,
  };
}

function deps(raw = "[]", appendResults: AppendProposalResult[] = []): {
  value: ProposalProducerDeps;
  runUtilityPass: ReturnType<typeof vi.fn>;
  append: ReturnType<typeof vi.fn>;
  recordMetric: ReturnType<typeof vi.fn>;
  diagnostic: ReturnType<typeof vi.fn>;
} {
  const runUtilityPass = vi.fn(async () => raw);
  const append = vi.fn(async (_candidate: ProposalCandidate) =>
    appendResults.shift() ?? ({
      status: "appended" as const,
      record: {} as ProposalRecord,
    })
  );
  const recordMetric = vi.fn(async () => metrics());
  const diagnostic = vi.fn();
  return {
    value: {
      runUtilityPass,
      store: { append, recordMetric },
      signal: new AbortController().signal,
      diagnostic,
    },
    runUtilityPass,
    append,
    recordMetric,
    diagnostic,
  };
}

describe("proposal producer eligibility", () => {
  const gates: Array<[string, Partial<ProposalTurnInput>, string]> = [
    ["unsuccessful turn", { successful: false }, "unsuccessful_turn"],
    ["non-substantial response", { responseIsSubstantial: false }, "insubstantial_response"],
    ["empty response", { responseText: "   " }, "insubstantial_response"],
    ["error response", { responseHasError: true }, "error_response"],
    ["pending interaction", { hasPendingInteraction: true }, "pending_interaction"],
    ["stopped turn", { stopped: true }, "stopped"],
    ["poisoned turn", { poisoned: true }, "poisoned"],
    ["incomplete recovery", { recoveryIncomplete: true }, "incomplete_recovery"],
    ["administrative slash command", { administrativeSlashCommand: true }, "administrative_command"],
    ["btw aside", { userText: "/btw should we revisit this?" }, "aside_command"],
    ["background disabled", { backgroundEnabled: false }, "background_disabled"],
    ["suggestions disabled", { suggestionsEnabled: false }, "suggestions_disabled"],
    ["budget denied", { budgetAllowed: false }, "budget_denied"],
  ];

  it.each(gates)("skips %s without spending a utility call", async (_name, patch, reason) => {
    const mocked = deps();
    const result = await produceTurnProposals(eligible(patch), mocked.value);
    expect(result).toEqual({ status: "skipped", reason });
    expect(mocked.runUtilityPass).not.toHaveBeenCalled();
    expect(mocked.append).not.toHaveBeenCalled();
  });
});

describe("proposal producer extraction", () => {
  it("builds a strict, bounded extraction prompt without requesting tools", () => {
    const prompt = buildProposalProducerPrompt(eligible());
    expect(prompt).toContain("ONLY a JSON array");
    expect(prompt).toContain("maximum 3");
    expect(prompt).toMatch(/explicit commitments/i);
    expect(prompt).toMatch(/no personal inferences/i);
    expect(prompt).toMatch(/paraphrase/i);
    expect(prompt).toContain(eligible().responseText);
  });

  it("accepts a valid empty candidate array", async () => {
    const mocked = deps("[]");
    const result = await produceTurnProposals(eligible(), mocked.value);
    expect(result).toEqual({
      status: "generated",
      candidates: 0,
      appended: 0,
      saved: [],
      duplicates: 0,
      invalid: 0,
    });
    expect(mocked.runUtilityPass).toHaveBeenCalledTimes(1);
    expect(mocked.append).not.toHaveBeenCalled();
    expect(mocked.recordMetric).not.toHaveBeenCalled();
  });

  it("parses and appends at most three valid candidates with source", async () => {
    const raw = JSON.stringify([
      taskJson,
      { kind: "loop", title: "Revisit launch", note: "Review launch readiness next week.", rationale: "Explicit follow-up loop." },
      { kind: "playbook", name: "Launch review", prompt: "Review launch readiness and list blockers.", rationale: "Reusable workflow requested." },
    ]);
    const mocked = deps(raw);
    const result = await produceTurnProposals(eligible(), mocked.value);
    expect(result).toMatchObject({ status: "generated", candidates: 3, appended: 3 });
    expect(mocked.append).toHaveBeenCalledTimes(3);
    expect(mocked.append.mock.calls[0][1]).toEqual(source);
  });

  it("rejects malformed output quietly, records one parse error, and diagnoses", async () => {
    const mocked = deps("Here are the proposals: []");
    const result = await produceTurnProposals(eligible(), mocked.value);
    expect(result).toMatchObject({ status: "failed", reason: "invalid_output" });
    expect(mocked.recordMetric).toHaveBeenCalledWith("parseErrors");
    expect(mocked.diagnostic).toHaveBeenCalledTimes(1);
    expect(mocked.append).not.toHaveBeenCalled();
  });

  it("treats empty utility output as a quiet parse failure", async () => {
    const mocked = deps("  \n");
    const result = await produceTurnProposals(eligible(), mocked.value);
    expect(result).toEqual({ status: "failed", reason: "empty_output" });
    expect(mocked.recordMetric).toHaveBeenCalledWith("parseErrors");
    expect(mocked.diagnostic).toHaveBeenCalledTimes(1);
  });

  it("never throws when the utility dependency fails", async () => {
    const mocked = deps();
    mocked.runUtilityPass.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(produceTurnProposals(eligible(), mocked.value)).resolves.toEqual({
      status: "failed",
      reason: "utility_error",
    });
    expect(mocked.recordMetric).toHaveBeenCalledWith("parseErrors");
    expect(mocked.diagnostic).toHaveBeenCalledTimes(1);
  });

  it("aggregates append outcomes while leaving their metrics to ProposalStore", async () => {
    const duplicate: AppendProposalResult = {
      status: "duplicate",
      duplicateOf: {} as ProposalRecord,
    };
    const invalid: AppendProposalResult = {
      status: "invalid",
      errors: [{ code: "required", path: "$[0].title", message: "title is required" }],
    };
    const mocked = deps(JSON.stringify([taskJson, { ...taskJson, title: "Second" }, { ...taskJson, title: "Third" }]), [
      { status: "appended", record: {} as ProposalRecord },
      duplicate,
      invalid,
    ]);
    const result = await produceTurnProposals(eligible(), mocked.value);
    expect(result).toEqual({
      status: "generated",
      candidates: 3,
      appended: 1,
      saved: [],
      duplicates: 1,
      invalid: 1,
    });
    expect(mocked.recordMetric).not.toHaveBeenCalled();
  });

  it("reports memory records written directly apart from pending suggestions", async () => {
    const taskJson = { kind: "task", title: "First", prompt: "Do it", rationale: "Explicit" };
    const mocked = deps(JSON.stringify([taskJson, { ...taskJson, title: "Second" }]), [
      { status: "appended", record: { status: "pending" } as ProposalRecord },
      {
        status: "applied",
        record: { kind: "decision", title: "Use Postgres", status: "accepted" } as ProposalRecord,
        target: "Decisions/2026-10-06-use-postgres.md",
      },
    ]);
    const result = await produceTurnProposals(eligible(), mocked.value);
    expect(result).toMatchObject({
      status: "generated",
      appended: 1,
      saved: [{ kind: "decision", title: "Use Postgres", target: "Decisions/2026-10-06-use-postgres.md" }],
    });
  });
});
