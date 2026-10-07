import { describe, expect, it, vi } from "vitest";
import type { Automation } from "../src/core/automation-model";
import { buildObsidianTools } from "../src/obsidian/tools";

function toolHandler(app: unknown, name: string) {
  const definition = buildObsidianTools(app as never).find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`Missing tool: ${name}`);
  return definition.handler;
}

const automation = (over: Partial<Automation>): Automation => ({
  slug: "x",
  name: "X",
  description: "",
  icon: "zap",
  when: [{ on: "schedule", cadence: { kind: "daily", hour: 7 } }],
  mode: "report",
  scope: [],
  canCall: [],
  cooldownMs: 15 * 60_000,
  enabled: true,
  prompt: "Do it.",
  ...over,
});

function fakeApp(autos: Automation[]) {
  const items = new Map(autos.map((a) => [a.slug, a]));
  const exo = {
    settings: { customPrompts: [{ name: "Distill", prompt: "distill" }], scheduledLastRun: {} as Record<string, number> },
    saveSettings: vi.fn(async () => undefined),
    loadAutomationRuns: vi.fn(async () => []),
    restoreAutomationRun: vi.fn(async () => []),
    markAutomationRunReviewed: vi.fn(async () => undefined),
    runPlaybook: vi.fn(async () => true),
    runAutomationNow: vi.fn(async () => true),
    automationStore: {
      list: () => [...items.values()],
      get: (slug: string) => items.get(slug) ?? null,
      errors: () => [],
      save: vi.fn(async (a: Automation) => void items.set(a.slug, a)),
      archive: vi.fn(async (slug: string) => void items.delete(slug)),
      filePath: (slug: string) => `_system/automations/${slug}.md`,
    },
  };
  return { app: { plugins: { plugins: { "exo-agent": exo } } }, exo };
}

describe("automation tools (v2, file-backed)", () => {
  it("lists automations as sentences with slug, mode and state", async () => {
    const { app } = fakeApp([
      automation({ slug: "morning-digest", name: "Morning Digest" }),
      automation({
        slug: "inbox-triager",
        name: "Inbox Triager",
        agent: "inbox-triager",
        mode: "act",
        enabled: false,
        when: [{ on: "vault-event", event: "create", path: "_inbox/**" }],
      }),
    ]);
    const result = await toolHandler(app, "list_automations")({}, {});
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("[morning-digest] Morning Digest — Runs daily at 07:00 · read-only · on");
    expect(text).toContain("[inbox-triager] Inbox Triager — Runs when a note is created in _inbox/ · can edit notes · paused · via agent inbox-triager");
  });

  it("pauses through the store, never through settings", async () => {
    const { app, exo } = fakeApp([automation({ slug: "morning-digest", name: "Morning Digest" })]);
    await toolHandler(app, "manage_automation")({ action: "pause", name: "Morning Digest" }, {});
    expect(exo.automationStore.save).toHaveBeenCalledWith(expect.objectContaining({ slug: "morning-digest", enabled: false }));
    expect(exo.saveSettings).not.toHaveBeenCalled();
  });

  it("creates a file automation with parsed when-lines", async () => {
    const { app, exo } = fakeApp([]);
    const result = await toolHandler(app, "manage_automation")({
      action: "create",
      name: "Weekly Review Prep",
      prompt: "Prepare the weekly review.",
      when: ["weekly mon 07:00"],
      mode: "report",
    }, {});
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Automation created");
    expect(exo.automationStore.save).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "weekly-review-prep",
        when: [{ on: "schedule", cadence: { kind: "weekly", day: 1, hour: 7 } }],
      })
    );
  });

  it("refuses an unparseable when-line without saving", async () => {
    const { app, exo } = fakeApp([automation({ slug: "morning-digest", name: "Morning Digest" })]);
    const result = await toolHandler(app, "manage_automation")({
      action: "update",
      name: "Morning Digest",
      when: ["whenever i feel like it"],
    }, {});
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Unparseable");
    expect(exo.automationStore.save).not.toHaveBeenCalled();
  });

  // Prompt-only automations run through the agent executor too, so `propose`
  // needs no bound agent: the run gets the contract and its block is collected.
  it("creates a prompt-only automation in propose mode", async () => {
    const { app, exo } = fakeApp([]);
    const result = await toolHandler(app, "manage_automation")({
      action: "create",
      name: "Suggester",
      prompt: "Suggest things.",
      mode: "propose",
    }, {});
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Automation created");
    expect(exo.automationStore.save).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "propose", agent: undefined, prompt: "Suggest things." })
    );
  });

  it("switches a prompt-only automation to propose mode", async () => {
    const { app, exo } = fakeApp([automation({ slug: "morning-digest", name: "Morning Digest" })]);
    await toolHandler(app, "manage_automation")({ action: "update", name: "Morning Digest", mode: "propose" }, {});
    expect(exo.automationStore.save).toHaveBeenCalledWith(expect.objectContaining({ mode: "propose" }));
  });

  it("refuses act mode with no write scope, saving nothing", async () => {
    const { app, exo } = fakeApp([]);
    const result = await toolHandler(app, "manage_automation")({ action: "create", name: "Fixer", prompt: "Fix.", mode: "act" }, {});
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Act mode needs");
    expect(exo.automationStore.save).not.toHaveBeenCalled();
  });

  it("delete archives and drops the scheduler cursors", async () => {
    const { app, exo } = fakeApp([automation({ slug: "morning-digest", name: "Morning Digest" })]);
    exo.settings.scheduledLastRun = { "agent:morning-digest::schedule daily 07": 1, "agent:other": 2 };
    await toolHandler(app, "manage_automation")({ action: "delete", name: "Morning Digest" }, {});
    expect(exo.automationStore.archive).toHaveBeenCalledWith("morning-digest");
    expect(exo.settings.scheduledLastRun).toEqual({ "agent:other": 2 });
  });

  it("duplicate saves a paused copy", async () => {
    const { app, exo } = fakeApp([automation({ slug: "morning-digest", name: "Morning Digest" })]);
    await toolHandler(app, "manage_automation")({ action: "duplicate", name: "Morning Digest" }, {});
    expect(exo.automationStore.save).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Morning Digest (copy)", slug: "morning-digest-copy", enabled: false }),
    );
  });

  it("run_now routes through runAutomationNow", async () => {
    const { app, exo } = fakeApp([automation({ slug: "morning-digest", name: "Morning Digest" })]);
    await toolHandler(app, "manage_automation")({ action: "run_now", name: "Morning Digest" }, {});
    expect(exo.runAutomationNow).toHaveBeenCalledWith(expect.objectContaining({ slug: "morning-digest" }));
  });
});
