import { describe, it, expect } from "vitest";
import {
  archivedAutomationPath,
  automationRunKeysIn,
  contractFromAutomation,
  duplicateAutomation,
  parseAutomationFile,
  serializeAutomation,
  validateAutomation,
  type Automation,
} from "../src/core/automation-model";
import { dueScheduledAgentRuns, seedUnseenSlots } from "../src/core/agent-runs";
import type { AgentDef } from "../src/core/agents";

const base = (over: Partial<Automation> = {}): Automation => ({
  slug: "digest",
  name: "Digest",
  description: "",
  icon: "sun",
  when: [{ on: "schedule", cadence: { kind: "daily", hour: 7 } }],
  mode: "report",
  scope: [],
  canCall: [],
  cooldownMs: 15 * 60_000,
  enabled: true,
  prompt: "Write the digest.",
  ...over,
});

describe("frontmatter round-trip", () => {
  it("keeps keys the model does not own, with their list lines", () => {
    const raw = [
      "---",
      "name: Digest",
      "tags:",
      "  - type/automation",
      "owner: mario",
      "when:",
      '  - "daily 07:00"',
      "mode: report",
      "enabled: true",
      "---",
      "",
      "Body stays.",
    ].join("\n");
    const { automation } = parseAutomationFile("digest", raw);
    expect(automation.extra).toEqual(["tags:", "  - type/automation", "owner: mario"]);
    const out = serializeAutomation({ ...automation, mode: "act", scope: ["Journal/**"] });
    expect(out).toContain("tags:\n  - type/automation\nowner: mario\n---");
    expect(out).toContain("Body stays.");
    const again = parseAutomationFile("digest", out).automation;
    expect(again.extra).toEqual(automation.extra);
    expect(again.mode).toBe("act");
  });

  it("quotes names and descriptions YAML would misread, and reads them back", () => {
    const a = base({ name: "Review: weekly", description: 'Says "hi" # not a comment' });
    const out = serializeAutomation(a);
    expect(out).toContain('name: "Review: weekly"');
    const back = parseAutomationFile("digest", out).automation;
    expect(back.name).toBe("Review: weekly");
    expect(back.description).toBe('Says "hi" # not a comment');
  });

  it("leaves plain text unquoted", () => {
    expect(serializeAutomation(base({ description: "Ogni lunedì rifà gli indici" }))).toContain(
      "description: Ogni lunedì rifà gli indici\n",
    );
  });
});

describe("validateAutomation", () => {
  it("accepts a complete automation", () => {
    expect(validateAutomation(base())).toEqual([]);
  });

  it("refuses act with nowhere to write", () => {
    expect(validateAutomation(base({ mode: "act" })).join(" ")).toContain("Act mode needs");
    expect(validateAutomation(base({ mode: "act", scope: ["Journal/**"] }))).toEqual([]);
  });

  it("refuses a missing name, an empty brief, a whole-vault event and a bad cooldown", () => {
    const problems = validateAutomation(
      base({ name: " ", prompt: "", when: [{ on: "vault-event", event: "create", path: "**" }], cooldownMs: NaN }),
    );
    expect(problems).toHaveLength(4);
  });

  it("lets an agent carry the brief", () => {
    expect(validateAutomation(base({ prompt: "", agent: "inbox-triager" }))).toEqual([]);
  });
});

describe("duplicateAutomation", () => {
  it("picks a free name and starts paused", () => {
    const copy = duplicateAutomation(base(), new Set(["digest", "digest-copy"]));
    expect(copy.name).toBe("Digest (copy 2)");
    expect(copy.slug).not.toBe("digest-copy");
    expect(copy.enabled).toBe(false);
    copy.when.push({ on: "tag", tag: "#x" });
    expect(base().when).toHaveLength(1);
  });
});

describe("archive helpers", () => {
  it("mirrors the automations folder under .archive", () => {
    expect(archivedAutomationPath("_system/automations", "digest")).toBe(".archive/_system/automations/digest.md");
  });

  it("finds only this automation's scheduler cursors", () => {
    const lastRun = { "agent:digest": 1, "agent:digest::schedule daily 07": 2, "agent:digest-2": 3, "Morning Digest": 4 };
    expect(automationRunKeysIn(lastRun, "digest")).toEqual(["agent:digest", "agent:digest::schedule daily 07"]);
  });
});

describe("seedUnseenSlots", () => {
  const def = (a: Automation) => ({ brain: { slug: a.slug, name: a.name }, contract: contractFromAutomation(a) }) as unknown as AgentDef;
  const at = (h: number) => new Date(2026, 9, 7, h).getTime();

  it("a new schedule waits for its next slot instead of firing at once", () => {
    const agents = [def(base())];
    const lastRun: Record<string, number> = {};
    expect(dueScheduledAgentRuns(agents, { ...lastRun }, at(22))).toHaveLength(1);
    expect(seedUnseenSlots(agents, lastRun, at(22))).toBe(1);
    expect(dueScheduledAgentRuns(agents, lastRun, at(23))).toHaveLength(0);
    expect(dueScheduledAgentRuns(agents, lastRun, new Date(2026, 9, 8, 7, 1).getTime())).toHaveLength(1);
  });

  it("leaves existing cursors and paused automations alone", () => {
    const lastRun = { "agent:digest::schedule daily 07": 5 };
    expect(seedUnseenSlots([def(base()), def(base({ slug: "off", enabled: false }))], lastRun, at(22))).toBe(0);
    expect(lastRun).toEqual({ "agent:digest::schedule daily 07": 5 });
  });
});
