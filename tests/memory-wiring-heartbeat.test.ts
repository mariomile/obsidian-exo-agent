import { describe, expect, it, vi } from "vitest";
import type ExoPlugin from "../src/main";

const runUpkeep = vi.fn(async () => ({ ran: false, fixes: 0 }));
const tick = vi.fn(async () => {});
vi.mock("../src/obsidian/upkeep", () => ({ runUpkeep: (...a: unknown[]) => (runUpkeep as (...x: unknown[]) => unknown)(...a) }));
vi.mock("../src/obsidian/memory-harvest", () => ({
  MemoryHarvester: class {
    tick = tick;
    dispose() {}
  },
}));

vi.mock("../src/ui/convo-bridge", () => ({ harvestSource: () => ({}) }));

const { registerMemory } = await import("../src/obsidian/memory-wiring");

describe("the heartbeat carries the daily upkeep", () => {
  it("each beat (interval and first catch-up) ticks the harvester and runs the upkeep", () => {
    const beats: (() => void)[] = [];
    vi.stubGlobal("window", { setInterval: (fn: () => void) => (beats.push(fn), 1), setTimeout: (fn: () => void) => (beats.push(fn), 2), clearTimeout: () => {} });
    const plugin = {
      manifest: { dir: "p" },
      app: { vault: { adapter: {} }, workspace: { onLayoutReady: (cb: () => void) => cb() } },
      settings: {},
      register: () => {},
      registerInterval: () => {},
      addCommand: () => {},
    } as unknown as ExoPlugin;
    registerMemory(plugin);
    expect(beats).toHaveLength(2);
    for (const beat of beats) beat();
    expect(tick).toHaveBeenCalledTimes(2);
    expect(runUpkeep).toHaveBeenCalledTimes(2);
    expect(runUpkeep).toHaveBeenCalledWith(plugin);
    vi.unstubAllGlobals();
  });
});
