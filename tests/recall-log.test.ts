import { describe, it, expect } from "vitest";
import { MAX_RECALL_ENTRIES, RecallLog } from "../src/obsidian/recall-log";
import type { LogFile } from "../src/obsidian/harvest-log";
import type { RecallLogEntry } from "../src/core/grounding";

function memFile(initial: string | null = null) {
  const state = { content: initial, corrupt: [] as string[] };
  const file: LogFile = {
    read: async () => state.content,
    write: async (c) => {
      state.content = c;
    },
    preserveCorrupt: async (c) => {
      state.corrupt.push(c);
    },
  };
  return { state, file };
}
const entry = (i: number): RecallLogEntry => ({ convoId: "c", msgIndex: i, userAt: i, at: i, notes: [{ path: `N/${i}.md` }] });
/** What is on disk: the file the eval reads. */
const stored = (state: { content: string | null }): RecallLogEntry[] => JSON.parse(state.content ?? "[]");

describe("RecallLog", () => {
  it("appends oldest first and reads back", async () => {
    const { file, state } = memFile();
    const log = new RecallLog(file);
    await log.append(entry(0));
    await log.append(entry(1));
    expect(stored(state).map((e) => e.msgIndex)).toEqual([0, 1]);
  });
  it("keeps the newest 500", async () => {
    const { file, state } = memFile();
    const log = new RecallLog(file);
    for (let i = 0; i < MAX_RECALL_ENTRIES + 3; i++) await log.append(entry(i));
    const all = stored(state);
    expect(all).toHaveLength(MAX_RECALL_ENTRIES);
    expect(all[0].msgIndex).toBe(3);
    expect(all[all.length - 1].msgIndex).toBe(MAX_RECALL_ENTRIES + 2);
    expect(MAX_RECALL_ENTRIES).toBe(500);
  });
  it("concurrent appends lose nothing", async () => {
    const { file, state } = memFile();
    const log = new RecallLog(file);
    await Promise.all([0, 1, 2, 3].map((i) => log.append(entry(i))));
    expect(stored(state)).toHaveLength(4);
  });
  it("stores what it is given and nothing else: paths, no bodies", async () => {
    const { file, state } = memFile();
    await new RecallLog(file).append(entry(0));
    expect(JSON.parse(state.content!)).toEqual([entry(0)]);
  });
  it("moves a corrupt file aside instead of wiping it", async () => {
    const { file, state } = memFile("{not json");
    await new RecallLog(file).append(entry(0));
    expect(state.corrupt).toEqual(["{not json"]);
    expect(JSON.parse(state.content!)).toEqual([entry(0)]);
  });
});
