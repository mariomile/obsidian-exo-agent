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
});
