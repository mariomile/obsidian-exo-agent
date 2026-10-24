import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ Modal: class {}, setIcon: vi.fn() }));
import { playbookMetadataDetails, proposalPayloadDetails, proposalTargetLabel } from "../src/ui/proposals-modal";

describe("proposal inbox presentation", () => {
  it("describes every explicit acceptance target", () => {
    expect(proposalTargetLabel({ kind: "loop", title: "L", note: "N" })).toBe("Open Loops");
    expect(proposalTargetLabel({ kind: "decision", title: "D", context: "C", decision: "Yes" })).toBe("Decision record");
    expect(proposalTargetLabel({ kind: "playbook", name: "P", prompt: "Run" })).toBe("Custom prompts");
  });

  it("renders the complete typed loop payload", () => {
    expect(proposalPayloadDetails({
      kind: "loop",
      title: "Follow up",
      note: "Call next week",
      resurface: "2026-07-27",
      tags: ["work", "follow-up"],
    })).toEqual([
      { label: "Note", value: "Call next week" },
      { label: "Resurface", value: "2026-07-27" },
      { label: "Tags", value: "work, follow-up" },
    ]);
  });

  it("does not invent empty optional fields", () => {
    expect(proposalPayloadDetails({ kind: "playbook", name: "Ship", prompt: "Build it" }))
      .toEqual([{ label: "Prompt", value: "Build it" }]);
  });

  it("surfaces read-only Foundry metadata beneath a playbook prompt", () => {
    expect(proposalPayloadDetails({
      kind: "playbook",
      name: "GTM brief",
      prompt: "Draft it",
      outcome: "A one-pager",
      inputs: ["topic", "audience"],
      capabilities: ["web.search"],
      why: "Recurred three times",
    })).toEqual([
      { label: "Prompt", value: "Draft it" },
      { label: "Outcome", value: "A one-pager" },
      { label: "Inputs", value: "topic, audience" },
      { label: "Capabilities", value: "web.search" },
      { label: "Why", value: "Recurred three times" },
    ]);
    expect(playbookMetadataDetails({ kind: "playbook", name: "P", prompt: "Run" })).toEqual([]);
  });

  it("shows a correction's note and the exact change, before and after", () => {
    const fm = { kind: "correction" as const, path: "D/2026-09-24-vault-lean.md", because: "x", change: { type: "frontmatter" as const, set: { status: "superseded", superseded_by: "[[2026-09-25-memoria]]" }, before: { status: "status: active" } } };
    expect(proposalTargetLabel(fm)).toBe("D/2026-09-24-vault-lean.md");
    expect(proposalPayloadDetails(fm)).toEqual([
      { label: "Correction", value: "Mark as superseded by 2026-09-25-memoria" },
      { label: "Before", value: "status: active\nsuperseded_by: (missing)" },
      { label: "After", value: "status: superseded\nsuperseded_by: [[2026-09-25-memoria]]" },
    ]);
    expect(proposalPayloadDetails({ ...fm, change: { type: "frontmatter", set: { status: "superseded" }, before: {} } })[0])
      .toEqual({ label: "Correction", value: "Mark as superseded" });
    const line = { kind: "correction" as const, path: "Pricing.md", because: "x", change: { type: "line" as const, oldLine: "- Pro is 29", newLine: "- Pro is 39 (dal 2026-10-24; prima Pro is 29)" } };
    expect(proposalTargetLabel(line)).toBe("Pricing.md");
    expect(proposalPayloadDetails(line)).toEqual([
      { label: "Correction", value: "Replace outdated line" },
      { label: "Before", value: "- Pro is 29" },
      { label: "After", value: "- Pro is 39 (dal 2026-10-24; prima Pro is 29)" },
    ]);
  });
});
