import { describe, expect, it } from "vitest";
import { runsForSlug, legacyRuns, pruneRuns } from "./automations";
import type { AgentDef } from "./agents";
import { matchVaultEvent } from "./agent-triggers";
import { parseWhen, formatWhen, parseAutomationFile, serializeAutomation, automationFromPlaybook, automationFromAgent, contractFromAutomation, legacyConfigFromAutomation, scheduleRunKeys } from "./automation-model";

describe("when grammar", () => {
  it("parses schedules", () => {
    expect(parseWhen("hourly")).toEqual({ on: "schedule", cadence: { kind: "hourly" } });
    expect(parseWhen("daily 07:00")).toEqual({ on: "schedule", cadence: { kind: "daily", hour: 7 } });
    expect(parseWhen("daily 7")).toEqual({ on: "schedule", cadence: { kind: "daily", hour: 7 } });
    expect(parseWhen("weekly mon 07:00")).toEqual({ on: "schedule", cadence: { kind: "weekly", day: 1, hour: 7 } });
    expect(parseWhen("weekly lunedì 8")).toEqual({ on: "schedule", cadence: { kind: "weekly", day: 1, hour: 8 } });
  });

  it("parses events and tags", () => {
    expect(parseWhen("on create in _inbox/")).toEqual({ on: "vault-event", event: "create", path: "_inbox/**" });
    expect(parseWhen("on modify in Journal/Daily")).toEqual({ on: "vault-event", event: "modify", path: "Journal/Daily/**" });
    expect(parseWhen("on tag #todo")).toEqual({ on: "tag", tag: "#todo" });
    expect(parseWhen("on tag todo")).toEqual({ on: "tag", tag: "#todo" }); // bare form also normalizes
  });

  it("rejects garbage", () => {
    expect(parseWhen("daily 25:00")).toBeNull();
    expect(parseWhen("whenever")).toBeNull();
  });

  it("round-trips through formatWhen", () => {
    for (const s of ["hourly", "daily 07:00", "weekly mon 07:00", "on create in _inbox/**", "on tag #todo"]) {
      const w = parseWhen(s);
      expect(w).not.toBeNull();
      expect(parseWhen(formatWhen(w!))).toEqual(w);
    }
  });
});

describe("tag trigger interop with the shared matching engine", () => {
  it("produces a tag AutomationWhen that matchVaultEvent actually fires on", () => {
    // Regression: parseWhen used to strip the "#", producing {tag: "todo"}
    // while note tags read from Obsidian's cache (and every other tag trigger
    // in the codebase, via core/agents.ts parseTrigger) are always "#"-prefixed
    // — so the comparison in matchVaultEvent's `current.has(trigger.tag)` never
    // matched and the trigger silently never fired. Caught live, not by a unit
    // test, because the old unit test asserted the bug's own (bare) output as
    // correct instead of checking against the engine it feeds.
    const when = parseWhen("on tag #e2e-fire");
    expect(when).not.toBeNull();
    const agent: AgentDef = {
      brain: { slug: "x", name: "X", invocable: "X", source: "vault" },
      contract: { ...contractFromAutomation({
        slug: "x", name: "X", description: "", icon: "zap", when: [when!], mode: "report",
        scope: [], canCall: [], cooldownMs: 900000, enabled: true, prompt: "",
      }) },
    };
    const fired = matchVaultEvent([agent], { path: "note.md", kind: "create", tags: ["#e2e-fire"] });
    expect(fired.length).toBe(1);
  });
});

describe("file round-trip", () => {
  it("parses and re-serializes stably", () => {
    const raw = [
      "---",
      "name: Inbox Triager",
      "description: Files _inbox notes",
      "icon: inbox",
      "when:",
      '  - "on create in _inbox/**"',
      "mode: act",
      "scope: [_inbox, Atlas]",
      "agent: inbox-triager",
      "cooldown: 15m",
      "enabled: true",
      "---",
      "",
      "Triage the inbox.",
      "",
    ].join("\n");
    const { automation, warnings } = parseAutomationFile("inbox-triager", raw);
    expect(warnings).toEqual([]);
    expect(automation.mode).toBe("act");
    expect(automation.when).toEqual([{ on: "vault-event", event: "create", path: "_inbox/**" }]);
    expect(automation.scope).toEqual(["_inbox", "Atlas"]);
    expect(automation.agent).toBe("inbox-triager");
    expect(automation.prompt).toBe("Triage the inbox.");
    const again = parseAutomationFile("inbox-triager", serializeAutomation(automation));
    expect(again.warnings).toEqual([]);
    expect(again.automation).toEqual(automation);
  });

  it("degrades unparseable when-lines to warnings, never drops the automation", () => {
    const raw = "---\nname: X\nwhen:\n  - nonsense\nenabled: true\n---\nBody";
    const { automation, warnings } = parseAutomationFile("x", raw);
    expect(automation.when).toEqual([]);
    expect(warnings.length).toBe(1);
  });

  it("defaults sanely on a minimal file", () => {
    const { automation } = parseAutomationFile("bare", "---\nname: Bare\n---\nDo it.");
    expect(automation.mode).toBe("report");
    expect(automation.icon).toBe("zap");
    expect(automation.enabled).toBe(false);
    expect(automation.when).toEqual([]);
    expect(automation.cooldownMs).toBe(15 * 60_000);
  });
});

describe("migration mapping", () => {
  it("maps a playbook automation to a file automation", () => {
    const a = automationFromPlaybook(
      { name: "Morning Digest", cadence: { kind: "daily", hour: 7 }, enabled: true, write: true },
      "Summarize the day.",
    );
    expect(a.slug).toBe("morning-digest");
    expect(a.mode).toBe("act");
    expect(a.when).toEqual([{ on: "schedule", cadence: { kind: "daily", hour: 7 } }]);
    expect(a.prompt).toBe("Summarize the day.");
    expect(a.enabled).toBe(true);
  });

  it("keeps the daily-pulse system key", () => {
    const a = automationFromPlaybook(
      { name: "Daily Pulse", system: "daily-pulse", cadence: { kind: "daily", hour: 8 }, enabled: false, write: false },
      "",
    );
    expect(a.system).toBe("daily-pulse");
    expect(a.mode).toBe("report");
  });

  it("maps an agent contract, dropping note-mention", () => {
    const def = {
      brain: { slug: "inbox-triager", name: "Inbox Triager", invocable: "Inbox Triager", description: "Files inbox notes", source: "vault" as const },
      contract: {
        slug: "inbox-triager", enabled: true, icon: "inbox", autonomy: "act" as const, output: "journal" as const,
        cooldownMs: 15 * 60_000, scope: { read: ["_inbox/**"], write: ["_inbox/**", "Atlas/**"] }, canCall: [],
        triggers: [
          { on: "vault-event" as const, event: "create" as const, path: "_inbox/**" },
          { on: "note-mention" as const },
        ],
      },
    };
    const a = automationFromAgent(def);
    expect(a).not.toBeNull();
    expect(a!.agent).toBe("inbox-triager");
    expect(a!.mode).toBe("act");
    expect(a!.when).toEqual([{ on: "vault-event", event: "create", path: "_inbox/**" }]);
    expect(a!.scope).toEqual(["_inbox/**", "Atlas/**"]);
    expect(a!.icon).toBe("inbox");
    expect(a!.description).toBe("Files inbox notes");
  });

  it("returns null for mention-only agents", () => {
    const def = {
      brain: { slug: "helper", name: "Helper", invocable: "Helper", source: "vault" as const },
      contract: {
        slug: "helper", enabled: true, icon: "bot", autonomy: "notify" as const, output: "report" as const,
        cooldownMs: 0, scope: { read: [], write: [] }, canCall: [], triggers: [{ on: "note-mention" as const }],
      },
    };
    expect(automationFromAgent(def)).toBeNull();
  });
});

describe("executor bridges", () => {
  const auto = (over: Partial<import("./automation-model").Automation>) => ({
    slug: "x", name: "X", description: "", icon: "zap",
    when: [], mode: "report" as const, scope: [], canCall: [], cooldownMs: 15 * 60_000,
    enabled: true, prompt: "Do it.", ...over,
  });

  it("synthesizes a contract from an automation", () => {
    const c = contractFromAutomation(auto({
      mode: "act", scope: ["_inbox/**"],
      when: [{ on: "vault-event", event: "create", path: "_inbox/**" }],
    }));
    expect(c.autonomy).toBe("act");
    expect(c.output).toBe("journal");
    expect(c.triggers).toEqual([{ on: "vault-event", event: "create", path: "_inbox/**" }]);
    expect(c.scope.write).toEqual(["_inbox/**"]);
    expect(c.enabled).toBe(true);
  });

  it("report mode maps to notify autonomy with report output", () => {
    const c = contractFromAutomation(auto({}));
    expect(c.autonomy).toBe("notify");
    expect(c.output).toBe("report");
  });

  it("builds a legacy config for slot runners", () => {
    const cfg = legacyConfigFromAutomation(auto({
      system: "daily-pulse",
      when: [{ on: "schedule", cadence: { kind: "daily", hour: 8 } }],
    }));
    expect(cfg).toEqual({ name: "X", system: "daily-pulse", cadence: { kind: "daily", hour: 8 }, enabled: true, write: false });
    expect(legacyConfigFromAutomation(auto({}))).toBeNull();
  });
});

describe("schedule keys", () => {
  it("names one key per schedule slot and ignores event triggers", () => {
    const a = parseAutomationFile("digest", [
      "---", "name: Digest", "when:", '  - "daily 07:00"', '  - "on create in _inbox/**"',
      '  - "weekly mon 08:00"', "---", "Body",
    ].join("\n")).automation;
    const keys = scheduleRunKeys(a);
    // One key per schedule; the event trigger contributes none.
    expect(keys.length).toBe(2);
    expect(keys[0]).toContain("agent:digest::schedule");
    expect(keys[0]).toContain("daily");
    expect(keys[1]).toContain("weekly");
    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe("run buckets", () => {
  const rec = (over: Partial<import("./automations").AutomationRunRecord>) => ({
    id: "r", name: "X", startedAt: 1, ok: true, reportPath: "", writes: [], checkpoint: [] as [string, string | null][], ...over,
  });
  it("splits per-slug and legacy runs", () => {
    const records = [rec({ id: "a", slug: "x", startedAt: 1 }), rec({ id: "b", slug: "x", startedAt: 5 }), rec({ id: "c" })];
    expect(runsForSlug(records, "x").map((r) => r.id)).toEqual(["b", "a"]);
    expect(legacyRuns(records, [{ slug: "x", name: "Ex" }]).map((r) => r.id)).toEqual(["c"]);
    expect(legacyRuns(records).map((r) => r.id), "runs of a deleted automation are older runs").toEqual(["b", "a", "c"]);
  });

  it("claims pre-v2 records by exact name so an upgrade keeps its history", () => {
    const records = [
      rec({ id: "old", name: "Morning Digest", startedAt: 2 }),
      rec({ id: "new", slug: "morning-digest", name: "Morning Digest", startedAt: 9 }),
      rec({ id: "stray", name: "Something Else" }),
    ];
    expect(runsForSlug(records, "morning-digest", "Morning Digest").map((r) => r.id)).toEqual(["new", "old"]);
    expect(legacyRuns(records, [{ slug: "morning-digest", name: "Morning Digest" }]).map((r) => r.id)).toEqual(["stray"]);
  });

  it("claims agent-run records by their \"Name (reason)\" shape", () => {
    const records = [
      rec({ id: "evt", name: "Inbox Triager (create _inbox Paseo.md)", startedAt: 3 }),
      rec({ id: "manual", name: "Inbox Triager", startedAt: 1 }),
      rec({ id: "other", name: "Inbox Triager Deluxe", startedAt: 2 }),
    ];
    expect(runsForSlug(records, "inbox-triager", "Inbox Triager").map((r) => r.id)).toEqual(["evt", "manual"]);
    expect(legacyRuns(records, [{ slug: "inbox-triager", name: "Inbox Triager" }]).map((r) => r.id)).toEqual(["other"]);
  });

  it("does not claim by name when the automation name is not given", () => {
    const records = [rec({ id: "old", name: "Morning Digest" })];
    expect(runsForSlug(records, "morning-digest")).toEqual([]);
  });
});

describe("pruneRuns", () => {
  const rec = (over: Partial<import("./automations").AutomationRunRecord>) => ({
    id: "r", name: "X", startedAt: 1, ok: true, reportPath: "", writes: [] as string[],
    checkpoint: [] as [string, string | null][], ...over,
  });

  it("keeps the newest records", () => {
    const records = [rec({ id: "a", startedAt: 1 }), rec({ id: "b", startedAt: 2 }), rec({ id: "c", startedAt: 3 })];
    expect(pruneRuns(records, 2).map((r) => r.id)).toEqual(["c", "b"]);
  });

  it("never drops a write run still awaiting review — it wins the budget", () => {
    const pending = rec({ id: "old-write", startedAt: 1, writes: ["a.md"] });
    const chatter = [2, 3, 4, 5].map((t) => rec({ id: `q${t}`, startedAt: t }));
    // Budget of 2: the pending restore point survives and the newest quiet run
    // takes the other slot; the older quiet runs age out.
    expect(pruneRuns([pending, ...chatter], 2).map((r) => r.id)).toEqual(["q5", "old-write"]);
  });

  it("keeps every pending restore point even past the budget", () => {
    const pendings = [1, 2, 3].map((t) => rec({ id: `w${t}`, startedAt: t, writes: ["a.md"] }));
    expect(pruneRuns(pendings, 1).map((r) => r.id)).toEqual(["w3", "w2", "w1"]);
  });

  it("lets a reviewed write run age out like anything else", () => {
    const reviewed = rec({ id: "old-write", startedAt: 1, writes: ["a.md"], reviewedAt: 9 });
    const chatter = [2, 3].map((t) => rec({ id: `q${t}`, startedAt: t }));
    expect(pruneRuns([reviewed, ...chatter], 2).map((r) => r.id)).toEqual(["q3", "q2"]);
  });
});
