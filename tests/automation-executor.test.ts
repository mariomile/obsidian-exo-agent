import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contractFromAutomation, scheduleRunKeys, type Automation } from "../src/core/automation-model";
import type { AgentDef } from "../src/core/agents";
import { AGENT_PROPOSAL_FENCE, NOTHING_TO_REPORT } from "../src/core/agent-runs";

/**
 * One executor for automations: a prompt-only automation (no `agent:`) runs
 * through `ExoPlugin.runAgent` as an inline brain, exactly like an agent-backed
 * one. These drive the real plugin methods against a fake `this`, with the CLI
 * run and the report writer mocked out.
 */

// main.ts pulls in the whole plugin graph; every Obsidian class it extends at
// load time resolves to an empty stand-in, the rest to the shared stub.
vi.mock("obsidian", async () => {
  const actual = (await vi.importActual<Record<string, unknown>>("obsidian")) as Record<string | symbol, unknown>;
  return new Proxy(actual, {
    has: () => true,
    get: (t, k) => (k in t ? t[k] : k === "then" ? undefined : class {}),
  });
});
vi.mock("electron", () => ({ shell: {}, default: {} }));

const headless = vi.hoisted(() => ({
  prompts: [] as { prompt: string; opts: { write?: boolean; systemPrompt?: string; agentCaller?: { slug: string; depth: number } } }[],
  output: "",
  writes: [] as string[],
  reports: [] as string[],
}));
vi.mock("../src/headless", () => ({
  runHeadlessPlaybook: vi.fn(async (_app: unknown, _settings: unknown, prompt: string, opts: { write?: boolean }) => {
    headless.prompts.push({ prompt, opts });
    return { ok: true, output: headless.output, reads: [], writes: headless.writes, checkpoint: new Map() };
  }),
  writeReport: vi.fn(async (_app: unknown, name: string) => {
    headless.reports.push(name);
    return `_system/reports/${name}.md`;
  }),
  restoreRun: vi.fn(async () => []),
}));
vi.mock("../src/obsidian/agent-triggers", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../src/obsidian/agent-triggers")),
  todayDailyNotePath: () => "Daily/2026-09-25.md",
}));

const { default: ExoPlugin } = await import("../src/main");

const automation = (over: Partial<Automation> = {}): Automation => ({
  slug: "morning-digest",
  name: "Morning Digest",
  description: "",
  icon: "zap",
  when: [{ on: "schedule", cadence: { kind: "daily", hour: 8 } }],
  mode: "propose",
  scope: [],
  canCall: [],
  cooldownMs: 15 * 60_000,
  enabled: true,
  prompt: "Scan the inbox.",
  ...over,
});

const fenced = (entries: unknown) => ["Found one.", "", "```exo-proposals", JSON.stringify(entries), "```"].join("\n");
const TASK = { kind: "task", title: "Follow up", prompt: "Follow up on the call.", rationale: "It was promised." };

function fakePlugin(kernel: boolean) {
  const plugin = Object.create(ExoPlugin.prototype) as InstanceType<typeof ExoPlugin>;
  const deps = {
    agentStore: {
      get: vi.fn(() => null),
      loadMemory: vi.fn(async () => ({ path: "_system/memory/agents/morning-digest.md", excerpt: "" })),
      appendRun: vi.fn(async (_record: Record<string, unknown>) => undefined),
      appendJournal: vi.fn(async () => true),
    },
    proposalStore: { append: vi.fn(async (_candidate: unknown, _source: unknown) => ({ status: "appended" })) },
    recordAutomationRun: vi.fn(async () => "rec-1"),
    recordBackgroundSpend: vi.fn(),
    checkBackgroundBudget: vi.fn(() => true),
    saveSettings: vi.fn(async () => undefined),
    noteVaultWrite: vi.fn(),
  };
  Object.assign(plugin, {
    ...deps,
    app: {},
    agentRunsInFlight: new Set<string>(),
    settings: {
      provider: "claude",
      obsidianToolsEnabled: false,
      proposalKernelEnabled: kernel,
      systemNotifications: false,
      scheduledLastRun: {},
    },
    diag: { push: vi.fn() },
  });
  // `paths` is a getter on the class; shadow it on the instance.
  Object.defineProperty(plugin, "paths", { value: { reports: "_system/reports" } });
  return { plugin, ...deps };
}

beforeEach(() => {
  headless.prompts.length = 0;
  headless.reports.length = 0;
  headless.output = "";
  headless.writes = [];
});

describe("run gate and caller identity", () => {
  it("Run now respects the run gate: refused while another run holds the only slot", async () => {
    const { plugin } = fakePlugin(true);
    (plugin as unknown as { agentRunsInFlight: Set<string> }).agentRunsInFlight.add("agent:other::daily");
    expect(await plugin.runAutomationNow(automation())).toBe(false);
    expect(headless.prompts).toHaveLength(0);
  });

  it("Run now respects the background budget", async () => {
    const { plugin } = fakePlugin(true);
    (plugin as unknown as { checkBackgroundBudget: () => boolean }).checkBackgroundBudget = () => false;
    expect(await plugin.runAutomationNow(automation())).toBe(false);
    expect(headless.prompts).toHaveLength(0);
  });

  it("hands an unattended run's writes to the git safety net", async () => {
    const { plugin, noteVaultWrite } = fakePlugin(true);
    headless.writes = ["_inbox/A.md"];
    await plugin.runAutomationNow(automation({ mode: "act", scope: ["_inbox/**"] }));
    expect(noteVaultWrite).toHaveBeenCalledWith(["_inbox/A.md"]);
  });

  it("binds the run's own identity into its tools, one level below the caller", async () => {
    const { plugin } = fakePlugin(true);
    await plugin.runAutomationNow(automation());
    expect(headless.prompts[0].opts.agentCaller).toEqual({ slug: "morning-digest", depth: 1 });
  });
});

describe("prompt-only automation through the agent executor", () => {
  it("runs its own prompt as the direct run's standing task, with the proposal contract", async () => {
    const { plugin } = fakePlugin(true);
    headless.output = "Digest body.";
    expect(await plugin.runAutomationNow(automation())).toBe(true);

    expect(headless.prompts).toHaveLength(1);
    const { prompt, opts } = headless.prompts[0];
    expect(prompt.split("\n")[0]).toBe('<agent-run trigger="manual">');
    expect(prompt).toContain("Standing task:\nScan the inbox.");
    expect(prompt).toContain(AGENT_PROPOSAL_FENCE);
    expect(prompt).not.toContain("subagent_type");
    expect(opts.write).toBe(false);
    // No agent file: no persona override on any engine.
    expect(opts.systemPrompt).toBeUndefined();
  });

  it("collects the fenced block into the proposals inbox in propose mode", async () => {
    const { plugin, proposalStore } = fakePlugin(true);
    headless.output = fenced([TASK]);
    await plugin.runAutomationNow(automation());

    expect(proposalStore.append).toHaveBeenCalledTimes(1);
    expect(proposalStore.append.mock.calls[0][1]).toMatchObject({ convoId: "agent:morning-digest" });
  });

  it("writes a ledger entry and counts against the background budget", async () => {
    const { plugin, agentStore, recordBackgroundSpend, recordAutomationRun } = fakePlugin(true);
    headless.output = "Digest body.";
    await plugin.runAutomationNow(automation());

    expect(agentStore.appendRun).toHaveBeenCalledTimes(1);
    expect(agentStore.appendRun.mock.calls[0][0]).toMatchObject({
      slug: "morning-digest",
      outcome: "ok",
      trigger: "manual",
      tier: "propose",
    });
    expect(recordAutomationRun).toHaveBeenCalledTimes(1);
    expect(recordBackgroundSpend).toHaveBeenCalledTimes(1);
    expect(headless.reports).toHaveLength(1);
  });

  it("stays silent on NOTHING-TO-REPORT: no report, a ledger line that says so", async () => {
    const { plugin, agentStore } = fakePlugin(true);
    headless.output = NOTHING_TO_REPORT;
    await plugin.runAutomationNow(automation({ mode: "report" }));

    expect(headless.reports).toHaveLength(0);
    expect(agentStore.appendRun.mock.calls[0][0]).toMatchObject({ summary: "Nothing to report." });
  });

  it("journals an `act` run into today's daily note instead of a report", async () => {
    const { plugin, agentStore } = fakePlugin(true);
    headless.output = "Filed 3 notes.\n\nJOURNAL: filed 3 inbox notes";
    await plugin.runAutomationNow(automation({ mode: "act", scope: ["_inbox/**"] }));

    expect(headless.prompts[0].opts.write).toBe(true);
    expect(headless.prompts[0].prompt).not.toContain(AGENT_PROPOSAL_FENCE);
    expect(headless.reports).toHaveLength(0);
    expect(agentStore.appendJournal).toHaveBeenCalledWith("Daily/2026-09-25.md", expect.any(String));
  });

  it("with the kernel off: no contract in the prompt and nothing collected, even from a fenced block", async () => {
    const { plugin, proposalStore } = fakePlugin(false);
    headless.output = fenced([TASK]);
    await plugin.runAutomationNow(automation());

    expect(headless.prompts[0].prompt).not.toContain(AGENT_PROPOSAL_FENCE);
    expect(proposalStore.append).not.toHaveBeenCalled();
  });

  it("stamps the schedule slot after a manual run, so the next slot does not repeat it", async () => {
    const { plugin } = fakePlugin(true);
    headless.output = "Digest body.";
    await plugin.runAutomationNow(automation());
    const keys = scheduleRunKeys(automation());
    expect(keys).toHaveLength(1);
    expect(Object.keys(plugin.settings.scheduledLastRun)).toContain(keys[0]);
  });
});

describe("schedule slots: a standing run covers every slot", () => {
  const twoSlots = automation({
    mode: "report",
    when: [
      { on: "schedule", cadence: { kind: "daily", hour: 7 } },
      { on: "schedule", cadence: { kind: "weekly", day: 1, hour: 7 } },
      { on: "vault-event", event: "create", path: "_inbox/**" },
    ],
  });
  const [daily, weekly] = scheduleRunKeys(twoSlots);
  const def = (): AgentDef => ({
    brain: { slug: twoSlots.slug, name: twoSlots.name, invocable: "", source: "vault", prompt: twoSlots.prompt },
    contract: contractFromAutomation(twoSlots),
  });

  it("a scheduled run of one slot stamps both schedule slots", async () => {
    const { plugin } = fakePlugin(true);
    headless.output = "Digest body.";
    expect(await plugin.runAgent(def(), "daily 07:00", daily)).toBe(true);
    expect(plugin.settings.scheduledLastRun[daily]).toBeGreaterThan(0);
    expect(plugin.settings.scheduledLastRun[weekly]).toBe(plugin.settings.scheduledLastRun[daily]);
  });

  it("an event run stamps neither schedule slot", async () => {
    const { plugin } = fakePlugin(true);
    headless.output = "Filed it.";
    await plugin.runAgent(def(), "create _inbox/A.md", "agent:morning-digest::create:_inbox/**");
    expect(plugin.settings.scheduledLastRun[daily]).toBeUndefined();
    expect(plugin.settings.scheduledLastRun[weekly]).toBeUndefined();
  });
});

describe("OS notification for prompt-only runs, as playbook runs had", () => {
  const notified: string[] = [];
  beforeEach(() => {
    notified.length = 0;
    vi.stubGlobal("document", { hasFocus: () => false });
    vi.stubGlobal(
      "Notification",
      class {
        onclick: (() => void) | null = null;
        constructor(title: string) {
          notified.push(title);
        }
      }
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const withNotifications = () => {
    const f = fakePlugin(true);
    f.plugin.settings.systemNotifications = true;
    return f;
  };

  it("fires when a successful report-mode run writes its report", async () => {
    const { plugin } = withNotifications();
    headless.output = "Digest body.";
    await plugin.runAutomationNow(automation({ mode: "report" }));
    expect(headless.reports).toHaveLength(1);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain("ready");
  });

  it("stays quiet when the run is silent", async () => {
    const { plugin } = withNotifications();
    headless.output = NOTHING_TO_REPORT;
    await plugin.runAutomationNow(automation({ mode: "report" }));
    expect(notified).toHaveLength(0);
  });
});

describe("agent-backed automation: the same eligibility rule", () => {
  const librarian: AgentDef = {
    brain: { slug: "librarian", name: "Librarian", invocable: "Librarian", source: "vault" },
    contract: {
      slug: "librarian",
      enabled: true,
      icon: "bot",
      autonomy: "propose",
      output: "report",
      cooldownMs: 0,
      scope: { read: [], write: [] },
      canCall: [],
      triggers: [],
    },
  };

  it("delegates to the subagent and carries the contract with the kernel on", async () => {
    const { plugin } = fakePlugin(true);
    headless.output = "Done.";
    await plugin.runAgent(librarian, "daily 08:00");
    expect(headless.prompts[0].prompt).toContain('subagent_type: "Librarian"');
    expect(headless.prompts[0].prompt).toContain(AGENT_PROPOSAL_FENCE);
  });

  it("leaves the contract out and collects nothing with the kernel off", async () => {
    const { plugin, proposalStore } = fakePlugin(false);
    headless.output = fenced([TASK]);
    await plugin.runAgent(librarian, "daily 08:00");
    expect(headless.prompts[0].prompt).not.toContain(AGENT_PROPOSAL_FENCE);
    expect(proposalStore.append).not.toHaveBeenCalled();
  });
});
