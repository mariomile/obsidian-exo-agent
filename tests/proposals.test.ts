import { describe, expect, it } from "vitest";
import {
  CLOSED_CORRECTIONS_MAX,
  closeCorrection,
  correctionCandidate,
  evaluateProposal,
  isMemoryProposalKind,
  fingerprintProposal,
  formatProposalPreview,
  parseProposalCandidates,
  pruneProposalRecords,
  type ProposalCandidate,
  type ProposalRecord,
} from "../src/core/proposals";

const NOW = Date.UTC(2026, 6, 20, 12);
const DAY = 24 * 60 * 60 * 1000;

function candidate(overrides: Partial<ProposalCandidate> = {}): ProposalCandidate {
  return {
    kind: "playbook",
    title: "Write release notes",
    payload: { kind: "playbook", name: "Write release notes", prompt: "Summarize the shipped changes." },
    rationale: "Mario committed to publishing them.",
    ...overrides,
  };
}

function record(
  status: ProposalRecord["status"],
  createdAt: number,
  overrides: Partial<ProposalRecord> = {}
): ProposalRecord {
  const value = candidate();
  return {
    id: `proposal-${status}-${createdAt}`,
    kind: value.kind,
    status,
    title: value.title,
    payload: value.payload,
    rationale: value.rationale,
    fingerprint: fingerprintProposal(value.payload),
    source: { convoId: "convo-1", turnId: "turn-1", createdAt },
    ...(status === "pending" ? {} : { resolvedAt: createdAt }),
    ...overrides,
  };
}

describe("parseProposalCandidates", () => {
  it("parses every kind and discards unknown LLM fields", () => {
    const result = parseProposalCandidates(JSON.stringify([
      { kind: "loop", title: "Follow up", note: "Ask again", rationale: "Deferred" },
      { kind: "decision", title: "Choose A", context: "Options", decision: "A", rationale: "Decided" },
      { kind: "playbook", name: "Weekly review", prompt: "Review the week", rationale: "Reusable" },
      { kind: "playbook", name: "Monthly review", prompt: "Review the month", rationale: "Reusable" },
    ]));

    // The limit is intentionally exercised separately: this batch is invalid.
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") expect(result.errors[0]).toMatchObject({ code: "too_many", path: "$" });

    const valid = parseProposalCandidates(JSON.stringify([
      { kind: "loop", title: "Follow up", note: "Ask again", resurface: "2028-02-29", tags: ["work"], rationale: "Deferred", ignored: true },
      { kind: "decision", title: "Choose A", context: "Options", decision: "A", rationale: "Decided", extra: "drop" },
    ]));
    expect(valid.status).toBe("ok");
    if (valid.status !== "ok") return;
    expect(valid.value).toHaveLength(2);
    expect(valid.value[0].payload).toEqual({ kind: "loop", title: "Follow up", note: "Ask again", resurface: "2028-02-29", tags: ["work"] });
    expect(valid.value[1].payload).toEqual({ kind: "decision", title: "Choose A", context: "Options", decision: "A", rationale: "Decided" });

    const playbook = parseProposalCandidates(JSON.stringify([
      { kind: "playbook", name: "Weekly review", prompt: "Review the week", rationale: "Reusable", extra: 1 },
    ]));
    expect(playbook).toEqual({
      status: "ok",
      value: [{
        kind: "playbook",
        title: "Weekly review",
        payload: { kind: "playbook", name: "Weekly review", prompt: "Review the week" },
        rationale: "Reusable",
      }],
    });
  });

  it("preserves optional Foundry metadata on a playbook and drops unknown fields", () => {
    const result = parseProposalCandidates(JSON.stringify([{
      kind: "playbook",
      name: "GTM brief",
      prompt: "Draft a GTM brief for {{topic}}",
      outcome: "A shareable one-pager",
      inputs: ["topic", "audience"],
      capabilities: ["vault.search", "web.search"],
      why: "Detected three equivalent runs in 30 days",
      workflowSignature: "research|vault.search>web.search|markdown",
      rationale: "Reusable workflow",
      ignored: true,
    }]));
    expect(result).toEqual({
      status: "ok",
      value: [{
        kind: "playbook",
        title: "GTM brief",
        payload: {
          kind: "playbook",
          name: "GTM brief",
          prompt: "Draft a GTM brief for {{topic}}",
          outcome: "A shareable one-pager",
          inputs: ["topic", "audience"],
          capabilities: ["vault.search", "web.search"],
          why: "Detected three equivalent runs in 30 days",
          workflowSignature: "research|vault.search>web.search|markdown",
        },
        rationale: "Reusable workflow",
      }],
    });
  });

  it("validates Foundry metadata types and limits without breaking the base playbook", () => {
    const cases = [
      { raw: [{ kind: "playbook", name: "N", prompt: "P", outcome: "x".repeat(501), rationale: "R" }], code: "too_long", path: "$[0].outcome" },
      { raw: [{ kind: "playbook", name: "N", prompt: "P", why: "x".repeat(501), rationale: "R" }], code: "too_long", path: "$[0].why" },
      { raw: [{ kind: "playbook", name: "N", prompt: "P", inputs: "topic", rationale: "R" }], code: "invalid_type", path: "$[0].inputs" },
      { raw: [{ kind: "playbook", name: "N", prompt: "P", inputs: [4], rationale: "R" }], code: "invalid_type", path: "$[0].inputs[0]" },
      { raw: [{ kind: "playbook", name: "N", prompt: "P", capabilities: ["x".repeat(121)], rationale: "R" }], code: "too_long", path: "$[0].capabilities[0]" },
    ];
    for (const testCase of cases) {
      const result = parseProposalCandidates(JSON.stringify(testCase.raw));
      expect(result.status).toBe("invalid");
      if (result.status === "invalid") expect(result.errors[0]).toMatchObject({ code: testCase.code, path: testCase.path });
    }
  });

  it("fingerprints a playbook on name and prompt only, ignoring Foundry metadata", () => {
    const bare = { kind: "playbook" as const, name: "GTM brief", prompt: "Draft it" };
    const enriched = {
      ...bare,
      outcome: "A one-pager",
      inputs: ["topic"],
      capabilities: ["web.search"],
      why: "Recurred three times",
      workflowSignature: "research|web.search|markdown",
    };
    expect(fingerprintProposal(enriched)).toBe(fingerprintProposal(bare));
    expect(fingerprintProposal({ ...bare, prompt: "Draft something else" })).not.toBe(fingerprintProposal(bare));
  });

  it("accepts one optional markdown fence, but rejects prose or trailing text", () => {
    const json = JSON.stringify([{ kind: "playbook", name: "T", prompt: "P", rationale: "R" }]);
    expect(parseProposalCandidates(`\n\`\`\`json\n${json}\n\`\`\`\n`).status).toBe("ok");
    expect(parseProposalCandidates(`Here you go:\n${json}`).status).toBe("invalid");
    expect(parseProposalCandidates(`${json}\nthanks`).status).toBe("invalid");
  });

  it("accepts an empty array and rejects malformed JSON or more than 3 candidates without throwing", () => {
    expect(parseProposalCandidates("[]")).toEqual({ status: "ok", value: [] });
    expect(() => parseProposalCandidates("[oops")).not.toThrow();
    expect(parseProposalCandidates("[oops")).toMatchObject({ status: "invalid" });
    const four = Array.from({ length: 4 }, (_, index) => ({ kind: "playbook", name: `T${index}`, prompt: "P", rationale: "R" }));
    expect(parseProposalCandidates(JSON.stringify(four))).toMatchObject({ status: "invalid", errors: [{ code: "too_many" }] });
  });

  it("returns typed validation errors for every kind and exact string limits", () => {
    const cases = [
      { raw: [{ kind: "loop", title: "x".repeat(121), note: "N", rationale: "R" }], code: "too_long", path: "$[0].title" },
      { raw: [{ kind: "playbook", name: "T", prompt: "x".repeat(4001), rationale: "R" }], code: "too_long", path: "$[0].prompt" },
      { raw: [{ kind: "loop", title: "T", note: "", rationale: "R" }], code: "required", path: "$[0].note" },
      { raw: [{ kind: "decision", title: "T", context: 4, decision: "D", rationale: "R" }], code: "invalid_type", path: "$[0].context" },
      { raw: [{ kind: "playbook", name: "x".repeat(121), prompt: "P", rationale: "R" }], code: "too_long", path: "$[0].name" },
      { raw: [{ kind: "playbook", name: "T", prompt: "P", rationale: "x".repeat(501) }], code: "too_long", path: "$[0].rationale" },
    ];
    for (const testCase of cases) {
      const result = parseProposalCandidates(JSON.stringify(testCase.raw));
      expect(result.status).toBe("invalid");
      if (result.status === "invalid") expect(result.errors[0]).toMatchObject({ code: testCase.code, path: testCase.path });
    }

    const exact = parseProposalCandidates(JSON.stringify([{ kind: "decision", title: "x".repeat(120), context: "x".repeat(4000), decision: "x".repeat(4000), rationale: "x".repeat(500) }]));
    expect(exact.status).toBe("ok");
  });

  it("validates local YYYY-MM-DD calendar dates", () => {
    const loop = (resurface: string) => JSON.stringify([{ kind: "loop", title: "T", note: "N", resurface, rationale: "R" }]);
    expect(parseProposalCandidates(loop("2028-02-29")).status).toBe("ok");
    for (const date of ["2027-02-29", "2026-04-31", "2026-13-01", "20-01-01", "2026-1-01"]) {
      expect(parseProposalCandidates(loop(date))).toMatchObject({ status: "invalid", errors: [{ code: "invalid_date" }] });
    }
  });
});

describe("fingerprint and dedup", () => {
  it("is deterministic and case/whitespace insensitive across kind, target and content", () => {
    const a = { kind: "playbook" as const, name: " Release   Notes ", prompt: "Summarize\n the CHANGES" };
    const b = { kind: "playbook" as const, name: "release notes", prompt: " summarize the changes " };
    expect(fingerprintProposal(a)).toBe(fingerprintProposal(a));
    expect(fingerprintProposal(a)).toBe(fingerprintProposal(b));
    expect(fingerprintProposal({ ...b, prompt: "Different" })).not.toBe(fingerprintProposal(b));
  });

  it("deduplicates pending and recently accepted records, but not dismissed or expired accepted ones", () => {
    const value = candidate();
    expect(evaluateProposal(value, [record("pending", NOW - 100 * DAY)], NOW).status).toBe("duplicate");
    expect(evaluateProposal(value, [record("accepted", NOW - 30 * DAY)], NOW).status).toBe("duplicate");
    expect(evaluateProposal(value, [record("accepted", NOW - 30 * DAY - 1)], NOW).status).toBe("ok");
    expect(evaluateProposal(value, [record("dismissed", NOW - DAY)], NOW).status).toBe("ok");
  });
});

describe("pruneProposalRecords", () => {
  it("preserves every pending record, prunes resolved records older than 30 days, and keeps at most 200 resolved", () => {
    const pending = Array.from({ length: 205 }, (_, index) => record("pending", NOW - (100 + index) * DAY, { id: `pending-${index}` }));
    const recent = Array.from({ length: 205 }, (_, index) => record(index % 2 ? "accepted" : "dismissed", NOW - index * 1000, { id: `resolved-${index}`, resolvedAt: NOW - index * 1000 }));
    const old = record("accepted", NOW - 31 * DAY, { id: "old", resolvedAt: NOW - 31 * DAY });
    const result = pruneProposalRecords([...pending, ...recent, old], NOW);
    expect(result.filter((item) => item.status === "pending")).toHaveLength(205);
    expect(result.filter((item) => item.status !== "pending")).toHaveLength(200);
    expect(result.some((item) => item.id === "old")).toBe(false);
    expect(result.some((item) => item.id === "resolved-204")).toBe(false);
  });
});

describe("formatProposalPreview", () => {
  it("formats a compact, single-line, quiet preview", () => {
    expect(formatProposalPreview(candidate({ rationale: "Explicit\ncommitment   from Mario." }))).toBe(
      "Playbook · Write release notes: Explicit commitment from Mario."
    );
    const long = formatProposalPreview(candidate({ rationale: "x".repeat(500) }));
    expect(long).toHaveLength(180);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("correction proposals", () => {
  const path = "_system/memory/decisions/2026-09-24-vault-lean.md";
  const frontmatter = { type: "frontmatter" as const, set: { status: "superseded", superseded_by: "[[2026-09-25-memoria]]" }, before: { status: "status: active" } };
  const line = { type: "line" as const, oldLine: "- Pro is 29 euro", newLine: "- Pro is 39 euro (dal 2026-10-24; prima Pro is 29 euro)" };

  it("builds a titled candidate whose rationale is the reason", () => {
    expect(correctionCandidate(path, frontmatter, "A newer note supersedes it.")).toEqual({
      kind: "correction",
      title: "Correct 2026-09-24-vault-lean",
      payload: { kind: "correction", path, change: frontmatter, because: "A newer note supersedes it." },
      rationale: "A newer note supersedes it.",
    });
  });

  it("round-trips both change shapes through the validator", () => {
    for (const change of [frontmatter, line]) {
      const value = correctionCandidate(path, change, "Outdated.");
      const parsed = parseProposalCandidates(JSON.stringify([{ ...value.payload, rationale: value.rationale }]));
      expect(parsed).toEqual({ status: "ok", value: [value] });
    }
  });

  it("rejects a correction without a path, with an unknown change, or with an empty or non-string set", () => {
    const base = { kind: "correction", path, because: "x", rationale: "x" };
    const bad = [
      { ...base, path: " ", change: frontmatter },
      { ...base, change: { type: "rewrite" } },
      { ...base, change: { type: "frontmatter", set: {} } },
      { ...base, change: { type: "frontmatter", set: { status: 3 }, before: {} } },
      { ...base, change: { type: "frontmatter", set: { status: "superseded" } } },
      { ...base, change: { type: "frontmatter", set: { status: "superseded" }, before: { other: "other: x" } } },
      { ...base, change: { type: "line", oldLine: "- a", newLine: " " } },
      { ...base, change: frontmatter, because: "" },
    ];
    for (const value of bad) expect(parseProposalCandidates(JSON.stringify([value])).status).toBe("invalid");
  });

  it("is not a memory kind: it waits for Mario's accept", () => {
    expect(isMemoryProposalKind("correction")).toBe(false);
  });

  it("fingerprints on path and change, not on the reason or the expected before, and set key order does not matter", () => {
    const a = correctionCandidate(path, frontmatter, "one reason").payload;
    const b = correctionCandidate(path, { type: "frontmatter", set: { superseded_by: "[[2026-09-25-memoria]]", status: "superseded" }, before: {} }, "another").payload;
    expect(fingerprintProposal(a)).toBe(fingerprintProposal(b));
    expect(fingerprintProposal(correctionCandidate("Other.md", frontmatter, "x").payload)).not.toBe(fingerprintProposal(a));
    expect(fingerprintProposal(correctionCandidate(path, line, "x").payload)).not.toBe(fingerprintProposal(a));
  });

  it("deduplicates pending, accepted and also dismissed corrections, so recall never re-proposes one Mario turned down", () => {
    const value = correctionCandidate(path, frontmatter, "x");
    const existing = (status: ProposalRecord["status"]) =>
      record(status, NOW - DAY, { kind: "correction", title: value.title, payload: value.payload, rationale: value.rationale, fingerprint: fingerprintProposal(value.payload) });
    expect(evaluateProposal(value, [existing("pending")], NOW).status).toBe("duplicate");
    expect(evaluateProposal(value, [existing("accepted")], NOW).status).toBe("duplicate");
    expect(evaluateProposal(value, [existing("dismissed")], NOW).status).toBe("duplicate");
  });

  it("a closed correction never comes back, even after pruning dropped its record", () => {
    const value = correctionCandidate(path, frontmatter, "x");
    const fp = fingerprintProposal(value.payload);
    expect(evaluateProposal(value, [], NOW, [fp]).status).toBe("duplicate");
    expect(evaluateProposal(value, [], NOW, []).status).toBe("ok");
    const old = record("accepted", NOW - 90 * DAY, { kind: "correction", title: value.title, payload: value.payload, rationale: value.rationale, fingerprint: fp });
    expect(evaluateProposal(value, [old], NOW).status).toBe("duplicate");
  });

  it("closedCorrections remembers closed correction fingerprints, newest first, capped", () => {
    expect(closeCorrection(["a", "b"], "c")).toEqual(["c", "a", "b"]);
    expect(closeCorrection(["a", "b"], "b")).toEqual(["b", "a"]);
    const full = Array.from({ length: CLOSED_CORRECTIONS_MAX }, (_, i) => `f${i}`);
    const next = closeCorrection(full, "new");
    expect(next).toHaveLength(CLOSED_CORRECTIONS_MAX);
    expect(next[0]).toBe("new");
  });
});
