import { describe, it, expect } from "vitest";
import { planInputParts, planRecapLabel, planStateText, planHandoffPrompt, PLAN_HANDOFF_DENY } from "../src/core/plan";

describe("planInputParts", () => {
  it("extracts inline plan markdown + file path (verified ExitPlanMode shape)", () => {
    const input = {
      plan: "# Plan\n\nDo the thing.\n",
      planFilePath: "/Users/x/.claude/plans/plan-abc.md",
    };
    expect(planInputParts(input)).toEqual({
      md: "# Plan\n\nDo the thing.\n",
      filePath: "/Users/x/.claude/plans/plan-abc.md",
    });
  });
  it("returns md null when only a file path is present", () => {
    const parts = planInputParts({ planFilePath: "/tmp/p.md" });
    expect(parts.md).toBeNull();
    expect(parts.filePath).toBe("/tmp/p.md");
  });
  it("tolerates alternate field names", () => {
    expect(planInputParts({ markdown: "hi", planPath: "/x" })).toEqual({ md: "hi", filePath: "/x" });
  });
  it("treats blank / missing / non-object as empty", () => {
    expect(planInputParts({ plan: "   " })).toEqual({ md: null, filePath: null });
    expect(planInputParts(null)).toEqual({ md: null, filePath: null });
    expect(planInputParts("nope")).toEqual({ md: null, filePath: null });
  });
});

describe("planRecapLabel", () => {
  it("summarizes the three states", () => {
    expect(planRecapLabel(true)).toBe("[plan: approved]");
    expect(planRecapLabel(false)).toBe("[plan: revised]");
    expect(planRecapLabel(null)).toBe("[plan: pending]");
  });
});

describe("planStateText", () => {
  it("labels approved / revised / proposed", () => {
    expect(planStateText(true)).toBe("Plan approved");
    expect(planStateText(true, true)).toBe("Plan approved — building");
    expect(planStateText(false)).toBe("Revision requested");
    expect(planStateText(null)).toBe("Plan proposed");
  });
});

describe("Build in new chat (T3 'Implement in new thread')", () => {
  it("hands the new chat the plan and nothing else", () => {
    expect(planHandoffPrompt("  ## Steps\n1. Do it\n")).toBe("Implement this plan.\n\n## Steps\n1. Do it");
  });

  it("tells the planning chat to stop, and its card says where the plan went", () => {
    expect(PLAN_HANDOFF_DENY).toMatch(/do not implement it in this chat/);
    expect(planStateText(true, true, true)).toBe("Implemented in");
    expect(planStateText(true, false, true)).toBe("Implemented in");
    expect(planStateText(true, true)).not.toBe("Implemented in");
  });
});
