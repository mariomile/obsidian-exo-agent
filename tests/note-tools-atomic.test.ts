import { describe, expect, test } from "vitest";
import { TFile, type App } from "obsidian";
import { buildObsidianTools } from "../src/obsidian/tools";

/** A one-note vault whose `process` applies the change to whatever the note
 *  holds at that moment, as Obsidian's does, and that refuses the old
 *  read-then-modify pair so a regression to it fails loudly. */
function vaultWith(content: string) {
  const file = Object.assign(new TFile(), { path: "N.md", basename: "N" });
  const state = { content };
  const app = {
    vault: {
      getAbstractFileByPath: (p: string) => (p === "N.md" ? file : null),
      process: async (_f: TFile, fn: (d: string) => string) => (state.content = fn(state.content)),
      read: async () => { throw new Error("non-atomic read"); },
      modify: async () => { throw new Error("non-atomic modify"); },
    },
    metadataCache: { getFirstLinkpathDest: () => null, getFileCache: () => null },
  } as unknown as App;
  const run = async (name: string, args: Record<string, unknown>) => {
    const t = buildObsidianTools(app).find((x) => x.name === name)!;
    const res = await (t.handler as (a: unknown, e: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>)(args, {});
    return { text: res.content[0].text, isError: res.isError === true };
  };
  return { state, run };
}

describe("note-writing tools are one atomic read-modify-write", () => {
  test("edit_note patches the note in place", async () => {
    const { state, run } = vaultWith("alpha beta");
    expect((await run("edit_note", { target: "N.md", old_string: "beta", new_string: "gamma" })).isError).toBe(false);
    expect(state.content).toBe("alpha gamma");
  });

  test("edit_note refusals leave the note untouched", async () => {
    const { state, run } = vaultWith("a a");
    expect((await run("edit_note", { target: "N.md", old_string: "a", new_string: "b" })).isError).toBe(true);
    expect((await run("edit_note", { target: "N.md", old_string: "zzz", new_string: "b" })).isError).toBe(true);
    expect(state.content).toBe("a a");
  });

  test("update_frontmatter merges into the current content", async () => {
    const { state, run } = vaultWith("---\na: 1\n---\nbody");
    await run("update_frontmatter", { target: "N.md", changes: { b: 2 } });
    expect(state.content).toContain("b: 2");
    expect(state.content).toContain("body");
  });
});
