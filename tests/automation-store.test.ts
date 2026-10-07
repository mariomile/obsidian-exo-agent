import { describe, expect, it } from "vitest";
import {
  AutomationStore,
  migrateToAutomationFiles,
  type AutomationVaultAdapter,
} from "../src/obsidian/automation-store";
import { parseAutomationFile, scheduleRunKeys } from "../src/core/automation-model";
import { exoPaths } from "../src/core/paths";
import type { AgentDef } from "../src/core/agents";

/** In-memory vault: path → content. Folders are implicit. */
function fakeVault(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed));
  const adapter: AutomationVaultAdapter = {
    listFiles: async (dir) =>
      [...files.keys()].filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/")),
    read: async (path) => {
      const v = files.get(path);
      if (v === undefined) throw new Error(`missing ${path}`);
      return v;
    },
    write: async (path, content) => void files.set(path, content),
    exists: async (path) => files.has(path),
    ensureFolder: async () => undefined,
    rename: async (from, to) => {
      const v = files.get(from);
      if (v === undefined) return;
      files.delete(from);
      files.set(to, v);
    },
  };
  return { adapter, files };
}

const paths = exoPaths("_system");

const brain = (slug: string, name: string) => ({
  slug,
  name,
  invocable: name,
  source: "vault" as const,
});

const agentDef = (slug: string, name: string, over: Partial<AgentDef["contract"]> = {}): AgentDef => ({
  brain: brain(slug, name),
  contract: {
    slug,
    enabled: true,
    icon: "bot",
    autonomy: "act",
    output: "journal",
    cooldownMs: 15 * 60_000,
    scope: { read: [], write: ["_inbox/**"] },
    canCall: [],
    triggers: [{ on: "vault-event", event: "create", path: "_inbox/**" }],
    ...over,
  },
});

describe("AutomationStore", () => {
  it("round-trips a saved automation through the vault", async () => {
    const { adapter, files } = fakeVault();
    const store = new AutomationStore(adapter, paths);
    await store.refresh();
    expect(store.list()).toEqual([]);

    const a = parseAutomationFile("morning-digest", [
      "---", "name: Morning Digest", "when:", '  - "daily 07:00"', "mode: report", "enabled: true", "---", "", "Do it.",
    ].join("\n")).automation;
    await store.save(a);
    expect(files.has("_system/automations/morning-digest.md")).toBe(true);

    const reread = new AutomationStore(adapter, paths);
    await reread.refresh();
    expect(reread.get("morning-digest")).toEqual(a);
  });

  it("surfaces unparseable files instead of dropping them", async () => {
    const { adapter } = fakeVault({ "_system/automations/broken.md": "---\nname: Broken\nwhen:\n  - nonsense\n---\nBody" });
    const store = new AutomationStore(adapter, paths);
    await store.refresh();
    expect(store.get("broken")).not.toBeNull();
    expect(store.errors()[0].problem).toContain("nonsense");
  });

  it("archives instead of deleting", async () => {
    const { adapter, files } = fakeVault({ "_system/automations/x.md": "---\nname: X\n---\nBody" });
    const store = new AutomationStore(adapter, paths);
    await store.refresh();
    await store.archive("x");
    expect(files.has("_system/automations/x.md")).toBe(false);
    expect(files.has(".archive/_system/automations/x.md")).toBe(true);
    expect(store.get("x")).toBeNull();
  });

  it("never overwrites an earlier archived copy", async () => {
    const { adapter, files } = fakeVault({
      "_system/automations/x.md": "---\nname: X\n---\nNew",
      ".archive/_system/automations/x.md": "---\nname: X\n---\nOld",
    });
    const store = new AutomationStore(adapter, paths);
    await store.refresh();
    await store.archive("x");
    expect(files.get(".archive/_system/automations/x.md")).toContain("Old");
    expect([...files.keys()].some((k) => /^\.archive\/_system\/automations\/x-\d+\.md$/.test(k))).toBe(true);
  });
});

describe("migration", () => {
  it("carries the old last-run forward so the upgrade does not fire everything at once", async () => {
    const { adapter } = fakeVault();
    const store = new AutomationStore(adapter, paths);
    await store.refresh();
    const ranAt = 1_700_000_000_000;
    const legacy = {
      automations: [{ name: "Morning Digest", cadence: { kind: "daily" as const, hour: 7 }, enabled: true, write: false }],
      customPrompts: [{ name: "Morning Digest", prompt: "Summarize." }],
      scheduledLastRun: { "Morning Digest": ranAt } as Record<string, number>,
    };

    const result = await migrateToAutomationFiles(store, { list: () => [] }, legacy, adapter, paths);
    expect(result.ok).toBe(true);

    const migrated = store.get("morning-digest");
    expect(migrated).not.toBeNull();
    const keys = scheduleRunKeys(migrated!);
    expect(keys.length).toBe(1);
    expect(legacy.scheduledLastRun[keys[0]]).toBe(ranAt);
    // The legacy settings are cleared only on full success.
    expect(legacy.automations).toEqual([]);
    expect(legacy.customPrompts).toEqual([]);
  });

  it("stamps a schedule with no carried value rather than leaving it due", async () => {
    const { adapter } = fakeVault();
    const store = new AutomationStore(adapter, paths);
    await store.refresh();
    const legacy = {
      automations: [{ name: "Fresh", cadence: { kind: "daily" as const, hour: 7 }, enabled: true, write: false }],
      customPrompts: [{ name: "Fresh", prompt: "Go." }],
      scheduledLastRun: {} as Record<string, number>,
    };
    await migrateToAutomationFiles(store, { list: () => [] }, legacy, adapter, paths);
    const keys = scheduleRunKeys(store.get("fresh")!);
    expect(legacy.scheduledLastRun[keys[0]]).toBeGreaterThan(0);
  });

  it("moves agent contract sidecars to the archive and binds the automation to the brain", async () => {
    const { adapter, files } = fakeVault({ "_system/agents/inbox-triager.md": "---\nslug: inbox-triager\n---\n" });
    const store = new AutomationStore(adapter, paths);
    await store.refresh();
    const legacy = { automations: [], customPrompts: [], scheduledLastRun: {} as Record<string, number> };

    const result = await migrateToAutomationFiles(
      store,
      { list: () => [agentDef("inbox-triager", "Inbox Triager")] },
      legacy,
      adapter,
      paths,
    );

    expect(result.ok).toBe(true);
    expect(store.get("inbox-triager")?.agent).toBe("inbox-triager");
    expect(store.get("inbox-triager")?.mode).toBe("act");
    expect(files.has("_system/agents/inbox-triager.md")).toBe(false);
    expect(files.has(".archive/agents/inbox-triager.md")).toBe(true);
  });

  it("leaves mention-only agents alone — mention is invocation, not automation", async () => {
    const { adapter, files } = fakeVault({ "_system/agents/helper.md": "---\nslug: helper\n---\n" });
    const store = new AutomationStore(adapter, paths);
    await store.refresh();
    const legacy = { automations: [], customPrompts: [], scheduledLastRun: {} as Record<string, number> };

    await migrateToAutomationFiles(
      store,
      { list: () => [agentDef("helper", "Helper", { triggers: [{ on: "note-mention" }] })] },
      legacy,
      adapter,
      paths,
    );

    expect(store.get("helper")).toBeNull();
    expect(files.has("_system/agents/helper.md")).toBe(true);
  });

  it("is idempotent — a second pass neither duplicates nor re-stamps", async () => {
    const { adapter } = fakeVault();
    const store = new AutomationStore(adapter, paths);
    await store.refresh();
    const legacy = {
      automations: [{ name: "Digest", cadence: { kind: "daily" as const, hour: 7 }, enabled: true, write: false }],
      customPrompts: [{ name: "Digest", prompt: "Go." }],
      scheduledLastRun: {} as Record<string, number>,
    };
    await migrateToAutomationFiles(store, { list: () => [] }, legacy, adapter, paths);
    const stamped = { ...legacy.scheduledLastRun };

    // Re-running with the (now empty) legacy settings must be a no-op.
    await migrateToAutomationFiles(store, { list: () => [] }, legacy, adapter, paths);
    expect(store.list().length).toBe(1);
    expect(legacy.scheduledLastRun).toEqual(stamped);
  });
});
