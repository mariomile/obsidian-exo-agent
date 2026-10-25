import { beforeEach, describe, expect, it, vi } from "vitest";
import { TFile, type App } from "obsidian";
import type { MarkerFix } from "../src/core/supersede";
import type { ProposalCandidate } from "../src/core/proposals";

vi.mock("../src/providers/sdk-loader", () => ({ claudeSdk: () => ({ tool: () => ({}) }) }));

const { proposeMarkerFixes } = await import("../src/obsidian/corrections");

const PATH = "D/2026-01-01-a.md";
const fix: MarkerFix = { path: PATH, set: { status: "superseded", superseded_by: "[[C]]" }, because: "c lists a." };

const appended: ProposalCandidate[] = [];
let result: { status: string; errors?: { path: string; message: string }[] } = { status: "applied" };

/** `disk` is the file as it is now; the metadata cache is never consulted. */
function app(disk: string): App {
  const file = Object.assign(new TFile(), { path: PATH, basename: "2026-01-01-a" });
  const exo = {
    loadAutomationRuns: () => {},
    runPlaybook: () => {},
    settings: { proposalKernelEnabled: true },
    proposalStore: { append: async (c: ProposalCandidate) => (appended.push(c), result) },
    inbox: { refresh: async () => {} },
  };
  return {
    vault: {
      getAbstractFileByPath: () => file,
      read: async () => disk,
      cachedRead: async () => "---\nstatus: active\n---\nstale cache copy\n",
    },
    plugins: { plugins: { "exo-agent": exo } },
  } as unknown as App;
}

const keysOf = (c: ProposalCandidate) => (c.payload.kind === "correction" && c.payload.change.type === "frontmatter" ? c.payload.change : null);

beforeEach(() => {
  appended.length = 0;
  result = { status: "applied" };
});

describe("proposeMarkerFixes reads the note as it is on disk", () => {
  it("a note with neither marker gets both, with each key as it reads now", async () => {
    await proposeMarkerFixes(app("---\nstatus: active\n---\nBody\n"), [fix], "upkeep");
    expect(keysOf(appended[0])).toEqual({ type: "frontmatter", set: { status: "superseded", superseded_by: "[[C]]" }, before: { status: "status: active" } });
  });

  it("an unquoted [[B]] superseded_by (no link in the metadata cache) is never replaced", async () => {
    await proposeMarkerFixes(app("---\nstatus: active\nsuperseded_by: [[B]]\n---\nBody\n"), [fix], "upkeep");
    expect(keysOf(appended[0])?.set).toEqual({ status: "superseded" });
  });

  it("a [B] superseded_by is never replaced", async () => {
    await proposeMarkerFixes(app("---\nstatus: active\nsuperseded_by: [B]\n---\nBody\n"), [fix], "upkeep");
    expect(keysOf(appended[0])?.set).toEqual({ status: "superseded" });
  });

  it("a superseded_by written to disk after the cache last looked is never replaced", async () => {
    await proposeMarkerFixes(app('---\nstatus: active\nsuperseded_by: "[[B]]"\n---\nBody\n'), [fix], "upkeep");
    expect(keysOf(appended[0])?.set).toEqual({ status: "superseded" });
  });

  it("a note already superseded with a successor is skipped", async () => {
    await proposeMarkerFixes(app("---\nstatus: superseded\nsuperseded_by: [[B]]\n---\nBody\n"), [fix], "upkeep");
    expect(appended).toEqual([]);
  });

  it("a validation rejection is logged, not swallowed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    result = { status: "invalid", errors: [{ path: "$.change.set.superseded_by", message: "too long" }] };
    await proposeMarkerFixes(app("---\nstatus: active\n---\nBody\n"), [fix], "upkeep");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("$.change.set.superseded_by: too long"));
    warn.mockRestore();
  });
});
