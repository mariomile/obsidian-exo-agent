import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  planPersistedConvos,
  readConversationsSource,
  partitionConvos,
  archiveSignature,
} from "../src/core/persistence";
import { DEFAULT_SETTINGS, persistViewState, type MVASettings } from "../src/settings-schema";

type C = { id: string; messages: unknown[]; updatedAt?: number };

const convo = (id: string, msgCount: number, updatedAt?: number): C => ({
  id,
  messages: Array.from({ length: msgCount }, () => ({})),
  updatedAt,
});

/**
 * NOT a production contract. `planPersistedConvos` is deprecated and has no
 * caller: production retention is `planRetention` (src/core/retention.ts), which
 * never shrinks what it keeps. These cases pin the HISTORICAL planner — the one
 * that returned a reduced set whose difference was then deleted from disk — so
 * that the behaviour this branch removed stays legible, and so "recreates the
 * incident" below reads as the bug it was, not as a rule still in force.
 */
describe("planPersistedConvos (deprecated planner — historical behaviour only)", () => {
  it("recreates the incident: an OLD convo with recent updatedAt survives while a NEWER empty husk is dropped", () => {
    // 35 real convos + 10 empty husks = 45 entries, max 30 → real eviction runs
    // (35 > 30). c0 sits at the FRONT of the array but was touched most recently;
    // it must beat later, staler convos on updatedAt. Empty husks (0 messages,
    // unpinned) are dropped even though several carry a newer timestamp than c0.
    const all: C[] = [];
    all.push(convo("c0", 3, 10_000)); // old position, freshest timestamp
    for (let i = 1; i < 35; i++) all.push(convo(`c${i}`, 2, 1000 + i)); // 34 staler real convos
    for (let i = 0; i < 10; i++) all.push(convo(`husk${i}`, 0, 20_000 + i)); // 10 NEWER empty husks

    const kept = planPersistedConvos(all, "c1", [], 30);

    expect(kept.length).toBe(30);
    // The old-positioned but recently-updated convo survives eviction.
    expect(kept.some((c) => c.id === "c0")).toBe(true);
    // Every empty husk is dropped despite a newer updatedAt than c0.
    expect(kept.some((c) => c.id.startsWith("husk"))).toBe(false);
    // The pinned active convo is always kept.
    expect(kept.some((c) => c.id === "c1")).toBe(true);
  });

  it("always keeps active + open-tab convos even with 0 messages", () => {
    const all: C[] = [
      convo("active", 0), // empty but active
      convo("tab", 0), // empty but an open tab
      convo("orphan", 0), // empty, unpinned → dropped
      convo("real", 5, 100),
    ];
    const kept = planPersistedConvos(all, "active", ["tab"], 30);
    expect(kept.map((c) => c.id).sort()).toEqual(["active", "real", "tab"]);
  });

  it("preserves ORIGINAL array order in the output", () => {
    const all: C[] = [
      convo("a", 1, 5),
      convo("b", 1, 100),
      convo("c", 1, 50),
    ];
    // Active "z" isn't in the list, so nothing is pinned — pure recency eviction.
    const kept = planPersistedConvos(all, "z", [], 2);
    // b and c have the newest updatedAt; kept must still be in array order (b before c).
    expect(kept.map((c) => c.id)).toEqual(["b", "c"]);
  });

  it("never returns more than max", () => {
    const all = Array.from({ length: 50 }, (_, i) => convo(`c${i}`, 1, i));
    const kept = planPersistedConvos(all, "c0", [], 30);
    expect(kept.length).toBe(30);
  });

  it("evicts unpinned convos by updatedAt desc, keeping the most recent", () => {
    const all: C[] = [
      convo("keep-active", 1, 1),
      convo("old", 1, 1),
      convo("new", 1, 100),
      convo("mid", 1, 50),
    ];
    // max 2: active pinned + the single most-recent unpinned ("new").
    const kept = planPersistedConvos(all, "keep-active", [], 2);
    expect(kept.map((c) => c.id).sort()).toEqual(["keep-active", "new"]);
  });

  it("returns the filtered list untouched when under the cap", () => {
    const all: C[] = [convo("a", 1), convo("b", 0), convo("c", 2)];
    // b (empty, unpinned) is filtered out; a and c stay, in order, no eviction.
    const kept = planPersistedConvos(all, "z", [], 30);
    expect(kept.map((c) => c.id)).toEqual(["a", "c"]);
  });
});

describe("readConversationsSource", () => {
  const arr = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: `c${i}` })));
  const read = (mainRaw: string | null, bakRaw: string | null) =>
    readConversationsSource(
      () => Promise.resolve(mainRaw),
      () => Promise.resolve(bakRaw),
    );

  it("uses a valid main file and reports it not corrupt", async () => {
    const r = await read(arr(3), null);
    expect(r.source).toBe("main");
    expect(r.mainCorrupt).toBe(false);
    expect(r.data).toHaveLength(3);
  });

  it("falls back to a valid .bak when main is corrupt, flagging mainCorrupt", async () => {
    const r = await read("{ not json", arr(2));
    expect(r.source).toBe("bak");
    expect(r.mainCorrupt).toBe(true);
    expect(r.data).toHaveLength(2);
  });

  it("returns empty + mainCorrupt when BOTH main and bak are corrupt", async () => {
    const r = await read("{ broken", "also [broken");
    expect(r.source).toBe("empty");
    expect(r.mainCorrupt).toBe(true);
    expect(r.data).toEqual([]);
  });

  it("returns empty and NOT corrupt when both files are missing (fresh install)", async () => {
    const r = await read(null, null);
    expect(r.source).toBe("empty");
    expect(r.mainCorrupt).toBe(false);
    expect(r.data).toEqual([]);
  });

  it("recovers from bak for a truncated-JSON main (the classic crash-mid-write)", async () => {
    // A write interrupted partway leaves valid-prefix-but-unterminated JSON.
    const truncated = arr(5).slice(0, arr(5).length - 10);
    const r = await read(truncated, arr(4));
    expect(r.source).toBe("bak");
    expect(r.mainCorrupt).toBe(true);
    expect(r.data).toHaveLength(4);
  });

  it("treats valid JSON that isn't an array as corrupt and tries bak", async () => {
    const r = await read('{"conversations":[]}', arr(1));
    expect(r.source).toBe("bak");
    expect(r.mainCorrupt).toBe(true);
    expect(r.data).toHaveLength(1);
  });

  it("uses main even when a stale bak is also present (main wins)", async () => {
    const r = await read(arr(2), arr(9));
    expect(r.source).toBe("main");
    expect(r.data).toHaveLength(2);
  });

  const reader = (raw: string | null) => {
    const r = {
      calls: 0,
      read: async () => {
        r.calls++;
        return raw;
      },
    };
    return r;
  };

  it("never reads the backup when main is a valid array", async () => {
    const main = reader(arr(3));
    const bak = reader(arr(9));
    const r = await readConversationsSource(main.read, bak.read);
    expect(bak.calls).toBe(0);
    expect(main.calls).toBe(1);
    expect(r).toEqual({ data: JSON.parse(arr(3)), source: "main", mainCorrupt: false });
  });

  /* The eager policy as it shipped in 0.44.3 (both files read up front), copied
   * verbatim. The lazy reader must return exactly what it returned. */
  function eagerTryParseArray(raw: string | null): unknown[] | null {
    if (raw == null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  function eagerParseConversationsSource(
    mainRaw: string | null,
    bakRaw: string | null
  ): { data: unknown[]; source: "main" | "bak" | "empty"; mainCorrupt: boolean } {
    const main = eagerTryParseArray(mainRaw);
    if (main) return { data: main, source: "main", mainCorrupt: false };
    const mainCorrupt = mainRaw != null;
    const bak = eagerTryParseArray(bakRaw);
    if (bak) return { data: bak, source: "bak", mainCorrupt };
    return { data: [], source: "empty", mainCorrupt };
  }

  it("returns exactly what the eager 0.44.3 policy returned, for every main/bak pair", async () => {
    const truncated = arr(5).slice(0, arr(5).length - 10);
    const variants: Array<string | null> = [null, "{ broken", '{"conversations":[]}', truncated, arr(0), arr(2), arr(4)];
    let pairs = 0;
    for (const m of variants) {
      for (const b of variants) {
        const main = reader(m);
        const bak = reader(b);
        const expected = eagerParseConversationsSource(m, b);
        expect(await readConversationsSource(main.read, bak.read)).toEqual(expected);
        // The backup is read only when main could not be used.
        expect(bak.calls).toBe(expected.source === "main" ? 0 : 1);
        expect(main.calls).toBe(1);
        pairs++;
      }
    }
    expect(pairs).toBe(49);
  });
});

describe("partitionConvos", () => {
  const c = (id: string, archived?: boolean) => ({ id, archived });

  it("splits archived from live, preserving order within each side", () => {
    const { live, archived } = partitionConvos([
      c("a"),
      c("b", true),
      c("c"),
      c("d", true),
    ]);
    expect(live.map((x) => x.id)).toEqual(["a", "c"]);
    expect(archived.map((x) => x.id)).toEqual(["b", "d"]);
  });

  it("treats a missing archived flag as live", () => {
    const { live, archived } = partitionConvos([{ id: "a" }]);
    expect(live.map((x) => x.id)).toEqual(["a"]);
    expect(archived).toEqual([]);
  });

  it("handles all-archived and all-live inputs", () => {
    expect(partitionConvos([c("a", true), c("b", true)]).live).toEqual([]);
    expect(partitionConvos([c("a"), c("b")]).archived).toEqual([]);
  });

  it("returns empty sides for empty input", () => {
    expect(partitionConvos([])).toEqual({ live: [], archived: [] });
  });
});

/**
 * Convo ⇄ ConvoData round-trip contract.
 *
 * The mapping is NOT in this module: it is two hand-written object literals in
 * `view.ts` — the `const c: Convo = {…}` in `restore()` (disk → memory) and the
 * literal in `toConvoData()` (memory → disk). `view.ts` imports `obsidian` and
 * has zero unit tests, so nothing else in the tree can observe that the two
 * halves still agree.
 *
 * The failure they are exposed to is asymmetric and silent: add a field to one
 * literal and not the other and the build is green, the typecheck is green
 * (both sides are optional), and the field simply evaporates on the next
 * reload. That is exactly how a pinned or archived chat would come back from a
 * restart unpinned or unarchived.
 *
 * ⚠️ Red here means "add the field to the other literal too", never "delete the
 * field from the list".
 */
const view = readFileSync(join(__dirname, "..", "src", "view.ts"), "utf8");

/** Everything that must survive a save/load cycle. Deliberately includes the
 *  fields that predate this contract — one rule for all of them, so the next
 *  field added is added under a rule that is already being enforced. */
const ROUND_TRIP_FIELDS = [
  "archived",
  "pinned",
  "retiredAt",
  "lastActiveAt",
  "titleLocked",
  "agent",
  "sessionId",
  "updatedAt",
  "usage",
] as const;

/** The literal in `restore()` that builds a live `Convo` from a `ConvoData`. */
const restoreLiteral = (): string => {
  const start = view.indexOf("const c: Convo = {");
  expect(start, "restore()'s `const c: Convo = {` literal moved or was renamed").toBeGreaterThan(-1);
  const end = view.indexOf("\n      };", start);
  expect(end, "could not find the end of restore()'s Convo literal").toBeGreaterThan(start);
  return view.slice(start, end);
};

/** The literal in `toConvoData()` that writes a `ConvoData` back to disk. */
const toDataLiteral = (): string => {
  const start = view.indexOf("private toConvoData(c: Convo): ConvoData {");
  expect(start, "toConvoData moved or was renamed").toBeGreaterThan(-1);
  const end = view.indexOf("\n  }", start);
  expect(end, "could not find the end of toConvoData").toBeGreaterThan(start);
  return view.slice(start, end);
};

describe("Convo persistence round-trip (view.ts, which has no unit tests)", () => {
  const restore = restoreLiteral();
  const toData = toDataLiteral();

  for (const field of ROUND_TRIP_FIELDS) {
    it(`${field} is read back on restore`, () => {
      expect(
        restore,
        `${field} is written to disk but never read back: it silently disappears on reload.`,
      ).toContain(field);
    });

    it(`${field} is written on save`, () => {
      expect(
        toData,
        `${field} is restored from disk but never written: it survives exactly one session.`,
      ).toContain(field);
    });
  }
});

describe("the conversation id high-water mark", () => {
  const settings = (over: Partial<MVASettings> = {}): MVASettings =>
    ({ ...DEFAULT_SETTINGS, ...over }) as MVASettings;

  it("climbs with the counter", () => {
    const s = settings({ convoSeed: 7 });
    persistViewState(s, { openTabIds: ["c8"], activeTabId: "c8", convoSeed: 8 });
    expect(s.convoSeed).toBe(8);
  });

  it("never goes back down, however stale the caller's number is", () => {
    // The bug this closes: the counter used to be re-derived on every load from
    // the ids that SURVIVED, so deleting the highest-numbered chat handed its
    // number back out, and the next new chat wore a dead chat's id. Four
    // durable stores resolve against those ids.
    const s = settings({ convoSeed: 12 });
    persistViewState(s, { openTabIds: [], activeTabId: "", convoSeed: 3 });
    expect(s.convoSeed).toBe(12);
  });

  it("treats a settings file written before this key as zero, not as a reset", () => {
    const s = settings();
    delete (s as Partial<MVASettings>).convoSeed;
    persistViewState(s, { openTabIds: [], activeTabId: "", convoSeed: 5 });
    expect(s.convoSeed).toBe(5);
  });

  it("still writes the tab state it always wrote", () => {
    const s = settings();
    persistViewState(s, { openTabIds: ["c1", "c2"], activeTabId: "c2", convoSeed: 2 });
    expect(s.openTabIds).toEqual(["c1", "c2"]);
    expect(s.activeTabId).toBe("c2");
  });

  it("is seeded from the persisted mark as well as the surviving ids", () => {
    // The read side of the same rule, in view.ts's restore().
    const view = readFileSync(join(__dirname, "../src/view.ts"), "utf8");
    expect(view).toMatch(/convoSeed = Math\.max\(convoSeed, this\.plugin\.settings\.convoSeed \?\? 0, maxIdSuffix\(/);
  });
});

describe("archiveSignature", () => {
  const chat = (over: Record<string, unknown> = {}) => ({
    id: "a",
    title: "Old chat",
    updatedAt: 1,
    harvestedIndex: 3,
    messages: [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }],
    ...over,
  });

  it("is stable for an unchanged archive", () => {
    expect(archiveSignature([chat()])).toBe(archiveSignature([chat()]));
  });

  it("changes when a chat is archived or un-archived", () => {
    expect(archiveSignature([chat(), chat({ id: "b" })])).not.toBe(archiveSignature([chat()]));
  });

  it("changes when any top-level field or the message count changes", () => {
    const base = archiveSignature([chat()]);
    expect(archiveSignature([chat({ title: "Renamed" })])).not.toBe(base);
    expect(archiveSignature([chat({ harvestedIndex: 4 })])).not.toBe(base);
    expect(archiveSignature([chat({ messages: [] })])).not.toBe(base);
  });

  it("does not serialize the transcripts", () => {
    expect(archiveSignature([chat()])).not.toContain("hello");
  });
});
