import { describe, it, expect } from "vitest";
import { SaveLog, MAX_SAVES } from "../src/obsidian/save-log";
import type { SaveReceipt } from "../src/core/save-undo";

function memFile() {
  const box = { content: null as string | null, corrupt: [] as string[] };
  return {
    box,
    file: {
      read: async () => box.content,
      write: async (c: string) => {
        box.content = c;
      },
      preserveCorrupt: async (c: string) => {
        box.corrupt.push(c);
      },
    },
  };
}

const receipt = (id: string, savedAt = 1): SaveReceipt => ({
  id,
  op: "insert",
  path: "N.md",
  section: { kind: "end" },
  lines: [`text ^${id}`],
  provenance: { convoId: "c", msgIndex: 0, chatTitle: "t", date: "2026-10-24" },
  savedAt,
});

describe("SaveLog", () => {
  it("records newest first and round-trips through JSON", async () => {
    const { file, box } = memFile();
    const log = new SaveLog(file);
    await log.record(receipt("exo-1"));
    await log.record(receipt("exo-2"));
    expect((await log.undoable()).map((r) => r.id)).toEqual(["exo-2", "exo-1"]);
    expect(await log.find("exo-1")).toEqual(receipt("exo-1"));
    expect(JSON.parse(box.content ?? "[]")).toHaveLength(2);
  });

  it(`keeps at most ${MAX_SAVES} receipts`, async () => {
    const { file } = memFile();
    const log = new SaveLog(file);
    for (let i = 0; i < MAX_SAVES + 5; i++) await log.record(receipt(`exo-${i}`));
    const all = await log.list();
    expect(all).toHaveLength(MAX_SAVES);
    expect(all[0].id).toBe(`exo-${MAX_SAVES + 4}`);
  });

  it("undoable() lists the receipts not undone, newest first; markUndone stamps the time", async () => {
    const { file } = memFile();
    const log = new SaveLog(file);
    await log.record(receipt("exo-1"));
    await log.record(receipt("exo-2"));
    await log.markUndone("exo-2", 99);
    expect((await log.find("exo-2"))?.undoneAt).toBe(99);
    expect((await log.undoable()).map((r) => r.id)).toEqual(["exo-1"]);
  });

  it("stores the exact lines only, never a note body", async () => {
    const { file, box } = memFile();
    await new SaveLog(file).record(receipt("exo-1"));
    const keys = Object.keys(JSON.parse(box.content ?? "[]")[0]);
    expect(keys).not.toContain("content");
    expect(keys).not.toContain("next");
    expect(keys).toContain("lines");
  });

  it("a corrupt log is kept aside, not overwritten silently", async () => {
    const { file, box } = memFile();
    box.content = "{not json";
    await new SaveLog(file).record(receipt("exo-1"));
    expect(box.corrupt).toEqual(["{not json"]);
  });
});

describe("SaveLog: the cap is per kind", () => {
  const correction = (id: string): SaveReceipt => ({ ...receipt(id), op: "frontmatter", lines: ['status: "superseded"'] });
  const replaced = (id: string): SaveReceipt => ({ ...receipt(id), op: "replace", replaced: "old" });

  it("60 corrections do not push out the newest 50 saves", async () => {
    const { file } = memFile();
    const log = new SaveLog(file);
    for (let i = 0; i < MAX_SAVES; i++) await log.record(receipt(`save-${i}`));
    for (let i = 0; i < 60; i++) await log.record(i % 2 ? correction(`fix-${i}`) : replaced(`fix-${i}`));
    const all = await log.list();
    expect(all.filter((r) => r.op === "insert")).toHaveLength(MAX_SAVES);
    expect(all.filter((r) => r.op !== "insert")).toHaveLength(MAX_SAVES);
    expect(all.some((r) => r.id === "save-0")).toBe(true);
    expect(all.some((r) => r.id === "fix-59")).toBe(true);
    expect(all.some((r) => r.id === "fix-9")).toBe(false);
  });

  it("60 saves do not push out the newest 50 corrections", async () => {
    const { file } = memFile();
    const log = new SaveLog(file);
    for (let i = 0; i < MAX_SAVES; i++) await log.record(correction(`fix-${i}`));
    for (let i = 0; i < 60; i++) await log.record(receipt(`save-${i}`));
    const all = await log.list();
    expect(all.filter((r) => r.op === "frontmatter")).toHaveLength(MAX_SAVES);
    expect(all.filter((r) => r.op === "insert")).toHaveLength(MAX_SAVES);
    expect(all.some((r) => r.id === "fix-0")).toBe(true);
    expect(all.some((r) => r.id === "save-9")).toBe(false);
  });

  it("keeps newest first across both kinds", async () => {
    const { file } = memFile();
    const log = new SaveLog(file);
    await log.record(receipt("a"));
    await log.record(correction("b"));
    await log.record(receipt("c"));
    expect((await log.undoable()).map((r) => r.id)).toEqual(["c", "b", "a"]);
  });
});
