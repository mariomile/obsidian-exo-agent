import { describe, expect, it, vi } from "vitest";
import { parseLoopsFile } from "../src/core/open-loops";
import type { ProposalRecord } from "../src/core/proposals";
import { WriteQueue } from "../src/core/write-queue";
import { routeAcceptedProposal } from "../src/obsidian/proposal-router";
import {
  DECISIONS_DIR,
  OPEN_LOOPS_PATH,
  DecisionProposalTarget,
  OpenLoopProposalTarget,
  PlaybookProposalTarget,
  proposalMarker,
  createProposalAcceptanceDeps,
  type ProposalTargetVaultAdapter,
} from "../src/obsidian/proposal-targets";

function fakeVault(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const folders = new Set<string>();
  const adapter: ProposalTargetVaultAdapter = {
    getFile: (path) => (files.has(path) ? { path } : null),
    read: async (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`missing: ${path}`);
      return content;
    },
    create: async (path, content) => {
      if (files.has(path)) throw new Error(`already exists: ${path}`);
      files.set(path, content);
    },
    process: async (path, fn) => {
      const current = files.get(path);
      if (current === undefined) throw new Error(`missing: ${path}`);
      files.set(path, fn(current));
    },
    ensureFolder: async (path) => {
      const slash = path.lastIndexOf("/");
      if (slash > 0) folders.add(path.slice(0, slash));
    },
  };
  return { adapter, files, folders };
}

describe("OpenLoopProposalTarget", () => {
  it("serializes concurrent creates without losing entries and makes same-millisecond ids unique", async () => {
    const { adapter, files, folders } = fakeVault();
    const target = new OpenLoopProposalTarget(adapter, new WriteQueue(), vi.fn(), () => 1_720_000_000_000);

    const created = await Promise.all([
      target.create({ proposalId: "proposal-one", title: "One", note: "First" }),
      target.create({ proposalId: "proposal-two", title: "Two", note: "Second", tags: ["exo"] }),
      target.create({ proposalId: "proposal-three", title: "Three", note: "Third", resurface: "2026-08-01" }),
    ]);

    expect(new Set(created.map(({ id }) => id)).size).toBe(3);
    expect(created.map(({ id }) => id)).toEqual([
      "loop-1720000000000",
      "loop-1720000000001",
      "loop-1720000000002",
    ]);
    expect(parseLoopsFile(files.get(OPEN_LOOPS_PATH)!).map(({ title }) => title)).toEqual([
      "One",
      "Two",
      "Three",
    ]);
    expect(folders).toContain("_system/memory");
  });

  it("computes the append against the content seen inside process, not an earlier read", async () => {
    const { adapter, files } = fakeVault();
    const target = new OpenLoopProposalTarget(adapter, new WriteQueue(), vi.fn(), () => 1_720_000_000_000);
    await target.create({ proposalId: "proposal-one", title: "One", note: "First" });

    // An editor autosave lands between this target's read and its write.
    const stale = files.get(OPEN_LOOPS_PATH)!;
    const edited = `${stale}\n## loop-1720000000001\n- title: Typed by hand\n- opened: 2024-07-03T09:46:40.001Z\n- status: open\n\nMine\n`;
    const seenInProcess: string[] = [];
    const racing: ProposalTargetVaultAdapter = {
      ...adapter,
      read: async () => stale,
      process: async (path, fn) => {
        files.set(path, edited);
        seenInProcess.push(files.get(path)!);
        files.set(path, fn(files.get(path)!));
      },
    };
    const racer = new OpenLoopProposalTarget(racing, new WriteQueue(), vi.fn(), () => 1_720_000_000_000);

    const created = await racer.create({ proposalId: "proposal-two", title: "Two", note: "Second" });

    const entries = parseLoopsFile(files.get(OPEN_LOOPS_PATH)!);
    expect(seenInProcess).toEqual([edited]);
    expect(entries.map(({ title }) => title)).toEqual(["One", "Typed by hand", "Two"]);
    // The hand-written loop took 1720000000001, so the new id skips past it.
    expect(created.id).toBe("loop-1720000000002");
  });

  it("dedupes against the content seen inside process when the proposal landed meanwhile", async () => {
    const { adapter, files } = fakeVault();
    const noteWrite = vi.fn();
    const first = new OpenLoopProposalTarget(adapter, new WriteQueue(), vi.fn(), () => 1_720_000_000_000);
    const landed = await first.create({ proposalId: "proposal-dup", title: "One", note: "First" });
    const withLoop = files.get(OPEN_LOOPS_PATH)!;
    files.set(OPEN_LOOPS_PATH, "");

    const racing: ProposalTargetVaultAdapter = {
      ...adapter,
      process: async (path, fn) => {
        files.set(path, withLoop);
        files.set(path, fn(files.get(path)!));
      },
    };
    const retry = new OpenLoopProposalTarget(racing, new WriteQueue(), noteWrite);
    const again = await retry.create({ proposalId: "proposal-dup", title: "One", note: "First" });

    expect(again).toEqual(landed);
    expect(parseLoopsFile(files.get(OPEN_LOOPS_PATH)!)).toHaveLength(1);
    expect(noteWrite).not.toHaveBeenCalled();
  });

  it("returns the existing loop when the same proposal is retried", async () => {
    const { adapter, files } = fakeVault();
    const noteWrite = vi.fn();
    const target = new OpenLoopProposalTarget(adapter, new WriteQueue(), noteWrite, () => 1_720_000_000_000);
    const input = { proposalId: "proposal-loop", title: "One", note: "First" };

    const first = await target.create(input);
    const second = await target.create(input);

    expect(second).toEqual(first);
    expect(noteWrite).toHaveBeenCalledTimes(1);
    expect(noteWrite).toHaveBeenCalledWith([OPEN_LOOPS_PATH]);
    expect(first.path).toBe(OPEN_LOOPS_PATH);
    expect(parseLoopsFile(files.get(OPEN_LOOPS_PATH)!)).toHaveLength(1);
  });
});

describe("DecisionProposalTarget", () => {
  it("creates the dated slug path with raw-patched frontmatter and decision body", async () => {
    const { adapter, files, folders } = fakeVault();
    const target = new DecisionProposalTarget(adapter, vi.fn(), () => new Date(2026, 6, 20, 23, 30));

    const result = await target.captureRawPreserving({
      proposalId: "proposal-decision",
      title: "Require Explicit Accept!",
      context: "Suggestions remain inert.",
      decision: "Require a user click.",
      rationale: "Prevents surprise writes.",
    });

    const path = `${DECISIONS_DIR}/2026-07-20-require-explicit-accept.md`;
    expect(result).toEqual({ path });
    expect(files.get(path)).toBe(
      `---\ntype: "decision"\ncreated_by: "exo"\ncreated: "2026-07-20"\ntags: ["type/decision"]\n---\n` +
      `# Decision: Require Explicit Accept!\n\n` +
      `## Contesto\nSuggestions remain inert.\n\n` +
      `## Decisione\nRequire a user click.\n\n` +
      `## Razionale\nPrevents surprise writes.\n`
      + `\n${proposalMarker("proposal-decision")}\n`
    );
    expect(folders).toContain(DECISIONS_DIR);
  });

  it("fails on a collision instead of overwriting the existing decision", async () => {
    const path = `${DECISIONS_DIR}/2026-07-20-same.md`;
    const { adapter, files } = fakeVault({ [path]: "keep me" });
    const target = new DecisionProposalTarget(adapter, vi.fn(), () => new Date(2026, 6, 20));

    await expect(target.captureRawPreserving({
      proposalId: "another-proposal",
      title: "Same",
      context: "Context",
      decision: "Decision",
      rationale: "Rationale",
    })).rejects.toThrow(`Already exists: ${path}`);
    expect(files.get(path)).toBe("keep me");
  });

  it("returns the existing decision when the same proposal is retried", async () => {
    const { adapter, files } = fakeVault();
    const noteWrite = vi.fn();
    const target = new DecisionProposalTarget(adapter, noteWrite, () => new Date(2026, 6, 20));
    const input = {
      proposalId: "proposal-decision",
      title: "Same",
      context: "Context",
      decision: "Decision",
      rationale: "Rationale",
    };

    const first = await target.captureRawPreserving(input);
    const second = await target.captureRawPreserving(input);

    expect(second).toEqual(first);
    expect([...files.keys()].filter((path) => path.startsWith(DECISIONS_DIR))).toHaveLength(1);
    expect(noteWrite).toHaveBeenCalledTimes(1);
    expect(noteWrite).toHaveBeenCalledWith([first.path]);
  });
});

describe("PlaybookProposalTarget", () => {
  it("resolves names case-insensitively inside the serialized save boundary", async () => {
    const settings = {
      customPrompts: [{ name: "digest", prompt: "old" }],
      proposalPlaybookReceipts: {} as Record<string, string>,
    };
    const saveSettings = vi.fn(async () => undefined);
    const target = new PlaybookProposalTarget(
      new WriteQueue(),
      { settings: () => settings, saveSettings }
    );

    await expect(target.save({ proposalId: "proposal-digest", name: "Digest", prompt: "new" })).resolves.toEqual({ name: "Digest 2" });
    expect(settings.customPrompts.at(-1)).toEqual({ name: "Digest 2", prompt: "new" });
    expect(settings.proposalPlaybookReceipts).toEqual({ "proposal-digest": "Digest 2" });
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent additions and saves each collision-safe snapshot", async () => {
    const settings = { customPrompts: [] as { name: string; prompt: string }[] };
    const snapshots: string[][] = [];
    const target = new PlaybookProposalTarget(
      new WriteQueue(),
      {
        settings: () => settings,
        saveSettings: async () => {
          await Promise.resolve();
          snapshots.push(settings.customPrompts.map(({ name }) => name));
        },
      }
    );

    const saved = await Promise.all([
      target.save({ proposalId: "proposal-one", name: "Review", prompt: "one" }),
      target.save({ proposalId: "proposal-two", name: "review", prompt: "two" }),
      target.save({ proposalId: "proposal-three", name: "Review", prompt: "three" }),
    ]);

    expect(saved.map(({ name }) => name)).toEqual(["Review", "review 2", "Review 3"]);
    expect(snapshots).toEqual([
      ["Review"],
      ["Review", "review 2"],
      ["Review", "review 2", "Review 3"],
    ]);
  });

  it("returns the existing playbook when the same proposal is retried", async () => {
    const settings = { customPrompts: [] as { name: string; prompt: string }[], proposalPlaybookReceipts: {} as Record<string, string> };
    const saveSettings = vi.fn(async () => undefined);
    const target = new PlaybookProposalTarget(new WriteQueue(), { settings: () => settings, saveSettings });
    const input = { proposalId: "proposal-review", name: "Review", prompt: "one" };

    const first = await target.save(input);
    const second = await target.save(input);

    expect(second).toEqual(first);
    expect(settings.customPrompts).toHaveLength(1);
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });

  it("rolls back both the playbook and receipt when settings persistence fails", async () => {
    const settings = { customPrompts: [] as { name: string; prompt: string }[], proposalPlaybookReceipts: {} as Record<string, string> };
    const target = new PlaybookProposalTarget(new WriteQueue(), {
      settings: () => settings,
      saveSettings: async () => { throw new Error("save failed"); },
    });

    await expect(target.save({ proposalId: "proposal-review", name: "Review", prompt: "one" }))
      .rejects.toThrow("save failed");
    expect(settings.customPrompts).toEqual([]);
    expect(settings.proposalPlaybookReceipts).toEqual({});
  });
});

describe("createProposalAcceptanceDeps", () => {
  it("lets the router convert a production adapter failure to a retryable route error", async () => {
    const { adapter } = fakeVault();
    adapter.create = async () => {
      throw new Error("vault is read-only");
    };
    const deps = createProposalAcceptanceDeps({
      vault: adapter,
      loopsWriteQueue: new WriteQueue(),
      playbooksWriteQueue: new WriteQueue(),
      playbooks: {
        settings: () => ({ customPrompts: [] }),
        saveSettings: async () => undefined,
      },
      noteWrite: vi.fn(),
      corrections: { apply: vi.fn(async ({ path }) => ({ path })) },
    });
    const record = {
      id: "proposal-loop",
      kind: "loop",
      status: "pending",
      title: "Remember",
      payload: { kind: "loop", title: "Remember", note: "Later" },
      rationale: "Requested follow-up",
      fingerprint: "fp",
      source: { convoId: "c", turnId: "t", createdAt: 1 },
    } satisfies ProposalRecord;

    await expect(routeAcceptedProposal(record, deps)).resolves.toEqual({
      ok: false,
      error: "vault is read-only",
    });
  });

  it("notes the vault write for a created loop and decision so git autocommit covers them", async () => {
    const { adapter } = fakeVault();
    const noteWrite = vi.fn();
    const deps = createProposalAcceptanceDeps({
      vault: adapter,
      loopsWriteQueue: new WriteQueue(),
      playbooksWriteQueue: new WriteQueue(),
      playbooks: {
        settings: () => ({ customPrompts: [] }),
        saveSettings: async () => undefined,
      },
      openLoopsPath: "Memory/open-loops.md",
      decisionsDir: "Memory/decisions",
      noteWrite,
    });

    await deps.loops.create({ proposalId: "p-loop", title: "Call Anna", note: "Soon" });
    expect(noteWrite).toHaveBeenLastCalledWith(["Memory/open-loops.md"]);

    const { path } = await deps.decisions.captureRawPreserving({
      proposalId: "p-dec",
      title: "Use Postgres",
      context: "c",
      decision: "d",
      rationale: "r",
    });
    expect(noteWrite).toHaveBeenLastCalledWith([path]);
  });
});
