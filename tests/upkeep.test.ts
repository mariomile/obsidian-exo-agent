import { describe, it, expect } from "vitest";
import { buildSupersedeIndex, type NoteMarkers } from "../src/core/supersede";
import { fixFingerprint, planUpkeep, dueToday } from "../src/core/upkeep";

const D = "_system/memory/decisions";
const p = (name: string): string => `${D}/${name}.md`;
const note = (name: string, m: Partial<Omit<NoteMarkers, "path">> = {}): NoteMarkers => ({
  path: p(name),
  supersedes: [],
  supersededBy: [],
  ...m,
});
const plan = (notes: NoteMarkers[], closed: string[] = []) => planUpkeep(buildSupersedeIndex(notes), new Set(closed));

describe("planUpkeep: one fix for each live marker shape", () => {
  it("a note listed in supersedes with neither marker gets both", () => {
    const { fixes } = plan([note("2026-01-01-a"), note("2026-02-01-b", { supersedes: [p("2026-01-01-a")] })]);
    expect(fixes).toHaveLength(1);
    expect(fixes[0].path).toBe(p("2026-01-01-a"));
    expect(fixes[0].set).toEqual({ status: "superseded", superseded_by: "[[2026-02-01-b]]" });
  });

  it("status already superseded: only superseded_by is added", () => {
    const { fixes } = plan([
      note("2026-01-01-a", { status: "superseded" }),
      note("2026-02-01-b", { supersedes: [p("2026-01-01-a")] }),
    ]);
    expect(fixes.map((f) => f.set)).toEqual([{ superseded_by: "[[2026-02-01-b]]" }]);
  });

  it("superseded_by already set: only status is added", () => {
    const { fixes } = plan([
      note("2026-01-01-a", { status: "active", supersededBy: [p("2026-02-01-b")] }),
      note("2026-02-01-b", { supersedes: [p("2026-01-01-a")] }),
    ]);
    expect(fixes.map((f) => f.set)).toEqual([{ status: "superseded" }]);
  });

  it("with several linkers the newest note is the successor", () => {
    const { fixes } = plan([
      note("2026-01-01-a"),
      note("2026-02-01-b", { supersedes: [p("2026-01-01-a")] }),
      note("2026-03-01-c", { supersedes: [p("2026-01-01-a")] }),
    ]);
    expect(fixes.map((f) => f.set.superseded_by)).toEqual(["[[2026-03-01-c]]"]);
  });

  it("markers that already agree produce no fix", () => {
    const { fixes, broken } = plan([
      note("2026-01-01-a", { status: "superseded", supersededBy: [p("2026-02-01-b")] }),
      note("2026-02-01-b", { supersedes: [p("2026-01-01-a")] }),
    ]);
    expect(fixes).toEqual([]);
    expect(broken).toEqual([]);
  });
});

describe("planUpkeep: closed fingerprints and broken links", () => {
  const notes = [note("2026-01-01-a"), note("2026-02-01-b", { supersedes: [p("2026-01-01-a")] })];

  it("skips a fix whose fingerprint is closed, keeps the others", () => {
    const [fix] = plan(notes).fixes;
    expect(plan(notes, [fixFingerprint(fix)]).fixes).toEqual([]);
    expect(plan(notes, ["proposal-v1-other"]).fixes).toHaveLength(1);
  });

  it("the fingerprint is the one the proposal store computes for the same fix", () => {
    const [fix] = plan(notes).fixes;
    expect(fixFingerprint(fix)).toMatch(/^proposal-v1-[0-9a-f]{16}$/);
    expect(fixFingerprint({ ...fix, because: "another reason" })).toBe(fixFingerprint(fix));
    expect(fixFingerprint({ ...fix, set: { status: "superseded" } })).not.toBe(fixFingerprint(fix));
  });

  it("lists a broken link and never fixes it", () => {
    const { fixes, broken } = plan([
      note("2026-01-01-a", { status: "superseded", supersededBy: [p("2026-09-09-gone")] }),
      note("2026-02-01-b", { supersedes: [p("2026-08-08-missing")] }),
    ]);
    expect(fixes).toEqual([]);
    expect(broken.map((b) => `${b.field} -> ${b.target}`).sort()).toEqual([
      `superseded_by -> ${p("2026-09-09-gone")}`,
      `supersedes -> ${p("2026-08-08-missing")}`,
    ]);
  });

  it("a fix on a note that also has a broken link still only sets markers", () => {
    const { fixes, broken } = plan([
      note("2026-01-01-a", { supersededBy: [p("2026-09-09-gone")] }),
      note("2026-02-01-b", { supersedes: [p("2026-01-01-a")] }),
    ]);
    expect(broken).toHaveLength(1);
    expect(fixes.map((f) => f.set)).toEqual([{ status: "superseded" }]);
  });
});

describe("dueToday", () => {
  const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).getTime();

  it("is due when it never ran", () => {
    expect(dueToday(null, at(2026, 10, 25, 9))).toBe(true);
    expect(dueToday(0, at(2026, 10, 25, 9))).toBe(true);
  });

  it("is not due again on the same local day", () => {
    expect(dueToday(at(2026, 10, 25, 0, 1), at(2026, 10, 25, 23, 59))).toBe(false);
  });

  it("is due again just across a local midnight", () => {
    expect(dueToday(at(2026, 10, 25, 23, 59), at(2026, 10, 26, 0, 1))).toBe(true);
  });

  it("is due when the clock moved back to an earlier day", () => {
    expect(dueToday(at(2026, 10, 26, 9), at(2026, 10, 25, 9))).toBe(true);
  });
});
