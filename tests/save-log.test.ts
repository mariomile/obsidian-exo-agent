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
    expect((await log.last())?.id).toBe("exo-2");
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

  it("last() skips undone receipts; markUndone stamps the time", async () => {
    const { file } = memFile();
    const log = new SaveLog(file);
    await log.record(receipt("exo-1"));
    await log.record(receipt("exo-2"));
    await log.markUndone("exo-2", 99);
    expect((await log.find("exo-2"))?.undoneAt).toBe(99);
    expect((await log.last())?.id).toBe("exo-1");
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
