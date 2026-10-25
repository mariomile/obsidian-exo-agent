import { beforeEach, describe, expect, it, vi } from "vitest";
import type ExoPlugin from "../src/main";
import type { MarkerFix } from "../src/core/supersede";

const proposeMarkerFixes = vi.fn(async (_app: unknown, _fixes: readonly MarkerFix[], _convoId: string) => {});
const scanNotes = vi.fn();
vi.mock("../src/obsidian/corrections", () => ({ proposeMarkerFixes: (...a: Parameters<typeof proposeMarkerFixes>) => proposeMarkerFixes(...a) }));
vi.mock("../src/obsidian/turn-recall", () => ({ scanNotes: (...a: unknown[]) => scanNotes(...a) }));
vi.mock("../src/obsidian/vault-search", () => ({ vaultExclusion: () => () => false }));

const { runUpkeep } = await import("../src/obsidian/upkeep");

const NOW = new Date(2026, 9, 25, 9, 0).getTime();
const fix: MarkerFix = { path: "D/a.md", set: { status: "superseded" }, because: "b lists a." };
const found = (fixes: MarkerFix[] = [fix]) => ({ names: [{}], supersede: { index: {}, fixes, broken: [{ path: "D/b.md", field: "supersedes", target: "D/x.md" }] } });

function plugin(over: { kernel?: boolean; last?: number; closed?: string[] } = {}) {
  const settings = { proposalKernelEnabled: over.kernel ?? true, lastUpkeepAt: over.last ?? 0 };
  const saved: number[] = [];
  const p = {
    app: { vault: { getFileByPath: () => ({}) }, metadataCache: { getFileCache: () => ({}) } },
    settings,
    saveSettings: async () => void saved.push(settings.lastUpkeepAt),
    proposalStore: { load: async () => ({ data: { closedCorrections: over.closed ?? [] } }) },
  };
  return { p: p as unknown as ExoPlugin, settings, saved };
}

beforeEach(() => {
  proposeMarkerFixes.mockClear();
  scanNotes.mockReset();
  scanNotes.mockReturnValue(found());
});

describe("runUpkeep", () => {
  it("sends the planned fixes through the correction route and stamps the day", async () => {
    const { p, settings, saved } = plugin();
    const result = await runUpkeep(p, NOW);
    expect(proposeMarkerFixes).toHaveBeenCalledTimes(1);
    expect(proposeMarkerFixes.mock.calls[0][1]).toEqual([fix]);
    expect(settings.lastUpkeepAt).toBe(NOW);
    expect(saved).toEqual([NOW]);
    expect(result).toEqual({ ran: true, fixes: 1 });
  });

  it("does nothing a second time on the same local day", async () => {
    const { p } = plugin({ last: new Date(2026, 9, 25, 0, 5).getTime() });
    expect((await runUpkeep(p, NOW)).ran).toBe(false);
    expect(scanNotes).not.toHaveBeenCalled();
    expect(proposeMarkerFixes).not.toHaveBeenCalled();
  });

  it("with suggestions off it writes nothing and does not use up the day", async () => {
    const { p, settings } = plugin({ kernel: false });
    expect((await runUpkeep(p, NOW)).ran).toBe(false);
    expect(proposeMarkerFixes).not.toHaveBeenCalled();
    expect(settings.lastUpkeepAt).toBe(0);
  });

  it("an empty index (cache not ready) does not use up the day", async () => {
    scanNotes.mockReturnValue({ names: [], supersede: { index: {}, fixes: [], broken: [] } });
    const { p, settings } = plugin();
    expect((await runUpkeep(p, NOW)).ran).toBe(false);
    expect(settings.lastUpkeepAt).toBe(0);
  });

  it("skips fixes whose fingerprint is closed and still stamps the day", async () => {
    const { fixFingerprint } = await import("../src/core/upkeep");
    const { p, settings } = plugin({ closed: [fixFingerprint(fix)] });
    const result = await runUpkeep(p, NOW);
    expect(proposeMarkerFixes).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ran: true, fixes: 0 });
    expect(settings.lastUpkeepAt).toBe(NOW);
  });

  it("never throws: a failing scan leaves the day open", async () => {
    scanNotes.mockImplementation(() => {
      throw new Error("index unreadable");
    });
    const { p, settings } = plugin();
    await expect(runUpkeep(p, NOW)).resolves.toMatchObject({ ran: false });
    expect(settings.lastUpkeepAt).toBe(0);
  });

  it("two overlapping heartbeats run one sweep", async () => {
    const { p } = plugin();
    await Promise.all([runUpkeep(p, NOW), runUpkeep(p, NOW)]);
    expect(proposeMarkerFixes).toHaveBeenCalledTimes(1);
  });
});
