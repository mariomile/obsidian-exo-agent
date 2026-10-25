import { describe, it, expect } from "vitest";
import { applySupersede, buildSupersedeIndex, formatSupersede, markerKeys, markersOf, type MarkerFix, type NoteMarkers } from "../src/core/supersede";
import { correctionCandidate, parseProposalCandidates, PROPOSAL_LIMITS } from "../src/core/proposals";

const D = "_system/memory/decisions";
const p = (name: string): string => `${D}/${name}.md`;
const note = (name: string, m: Partial<Omit<NoteMarkers, "path">> = {}): NoteMarkers => ({
  path: p(name),
  supersedes: [],
  supersededBy: [],
  ...m,
});

describe("buildSupersedeIndex: what counts as superseded", () => {
  it("status: superseded alone marks a note, with no known successor", () => {
    const { index } = buildSupersedeIndex([note("2026-01-01-a", { status: "superseded" })]);
    expect(index.isSuperseded(p("2026-01-01-a"))).toBe(true);
    expect(index.successorOf(p("2026-01-01-a"))).toBeNull();
    expect(index.headOf(p("2026-01-01-a"))).toBeNull();
  });

  it("superseded_by alone marks a note and names its successor", () => {
    const { index } = buildSupersedeIndex([note("2026-01-01-a", { supersededBy: [p("2026-02-01-b")] }), note("2026-02-01-b")]);
    expect(index.isSuperseded(p("2026-01-01-a"))).toBe(true);
    expect(index.successorOf(p("2026-01-01-a"))).toBe(p("2026-02-01-b"));
    expect(index.headOf(p("2026-01-01-a"))).toBe(p("2026-02-01-b"));
  });

  it("a reverse supersedes link alone marks a note", () => {
    const { index } = buildSupersedeIndex([note("2026-01-01-a"), note("2026-02-01-b", { supersedes: [p("2026-01-01-a")] })]);
    expect(index.isSuperseded(p("2026-01-01-a"))).toBe(true);
    expect(index.isSuperseded(p("2026-02-01-b"))).toBe(false);
    expect(index.headOf(p("2026-01-01-a"))).toBe(p("2026-02-01-b"));
  });

  it("a current note is not superseded and has no head", () => {
    const { index } = buildSupersedeIndex([note("2026-01-01-a", { status: "active" })]);
    expect(index.isSuperseded(p("2026-01-01-a"))).toBe(false);
    expect(index.headOf(p("2026-01-01-a"))).toBeNull();
    expect(index.isSuperseded("Unknown.md")).toBe(false);
  });

  it("with several reverse linkers the successor is the newest by filename date, then path", () => {
    const { index } = buildSupersedeIndex([
      note("2026-01-01-a"),
      note("2026-03-01-c", { supersedes: [p("2026-01-01-a")] }),
      note("2026-02-01-b", { supersedes: [p("2026-01-01-a")] }),
      note("2026-03-01-b", { supersedes: [p("2026-01-01-a")] }),
    ]);
    expect(index.successorOf(p("2026-01-01-a"))).toBe(p("2026-03-01-c"));
  });

  it("a resolving superseded_by wins over reverse linkers", () => {
    const { index } = buildSupersedeIndex([
      note("2026-01-01-a", { supersededBy: [p("2026-02-01-b")] }),
      note("2026-02-01-b"),
      note("2026-03-01-c", { supersedes: [p("2026-01-01-a")] }),
    ]);
    expect(index.successorOf(p("2026-01-01-a"))).toBe(p("2026-02-01-b"));
  });
});

describe("buildSupersedeIndex: the head", () => {
  it("follows a chain A to B to C and heads at C", () => {
    const { index } = buildSupersedeIndex([
      note("2026-01-01-a"),
      note("2026-02-01-b", { supersedes: [p("2026-01-01-a")] }),
      note("2026-03-01-c", { supersedes: [p("2026-02-01-b")] }),
    ]);
    expect(index.headOf(p("2026-01-01-a"))).toBe(p("2026-03-01-c"));
    expect(index.headOf(p("2026-02-01-b"))).toBe(p("2026-03-01-c"));
  });

  it("ignores a self-reference (live: oryn-e-il-nome-di-rig supersedes itself)", () => {
    const self = "2026-08-19-oryn-e-il-nome-di-rig";
    const { index, fixes } = buildSupersedeIndex([note(self, { supersedes: [p(self)], supersededBy: [p(self)] })]);
    expect(index.isSuperseded(p(self))).toBe(false);
    expect(index.headOf(p(self))).toBeNull();
    expect(fixes).toEqual([]);
  });

  it("stops on a cycle A to B to A", () => {
    const { index } = buildSupersedeIndex([
      note("2026-01-01-a", { supersededBy: [p("2026-02-01-b")] }),
      note("2026-02-01-b", { supersededBy: [p("2026-01-01-a")] }),
    ]);
    expect(index.headOf(p("2026-01-01-a"))).toBe(p("2026-02-01-b"));
    expect(index.headOf(p("2026-02-01-b"))).toBe(p("2026-01-01-a"));
  });
});

describe("buildSupersedeIndex: broken links and fixes", () => {
  it("reports a link to a note that does not exist, never fixes it", () => {
    const plan = "2026-06-01-deepagent-growth-master-plan";
    const { broken, fixes, index } = buildSupersedeIndex([
      note(plan, { supersedes: [".archive/old-growth-plan"], supersededBy: ["gone-note"] }),
    ]);
    expect(broken).toEqual([
      { path: p(plan), field: "supersedes", target: ".archive/old-growth-plan" },
      { path: p(plan), field: "superseded_by", target: "gone-note" },
    ]);
    expect(fixes).toEqual([]);
    expect(index.isSuperseded(p(plan))).toBe(true);
    expect(index.headOf(p(plan))).toBeNull();
  });

  it("live shape: an active note that a newer note supersedes gets status and superseded_by", () => {
    const { fixes } = buildSupersedeIndex([
      note("2026-09-24-vault-lean", { status: "active" }),
      note("2026-09-25-memoria-automatica-nel-vault", { status: "active", supersedes: [p("2026-09-24-vault-lean")] }),
    ]);
    expect(fixes).toEqual([
      {
        path: p("2026-09-24-vault-lean"),
        set: { status: "superseded", superseded_by: "[[2026-09-25-memoria-automatica-nel-vault]]" },
        because: "2026-09-25-memoria-automatica-nel-vault lists this note in supersedes, but it is not marked as superseded.",
      },
    ]);
  });

  it("live shape: a note with no status gets the same fix", () => {
    const { fixes } = buildSupersedeIndex([
      note("2026-05-04-vault-objectos-migration"),
      note("2026-05-10-vault-flatten-tier-a", { supersedes: [p("2026-05-04-vault-objectos-migration")] }),
    ]);
    expect(fixes.map((f) => [f.path, f.set])).toEqual([
      [p("2026-05-04-vault-objectos-migration"), { status: "superseded", superseded_by: "[[2026-05-10-vault-flatten-tier-a]]" }],
    ]);
  });

  it("live shape: status superseded without superseded_by gets only the link, when a reverse link exists", () => {
    const { fixes } = buildSupersedeIndex([
      note("2026-08-26-memory-routing-and-review", { status: "superseded" }),
      note("2026-09-25-memoria-automatica-nel-vault", { supersedes: [p("2026-08-26-memory-routing-and-review")] }),
      note("2026-05-13-dreaming-pattern", { status: "superseded" }),
    ]);
    expect(fixes).toEqual([
      {
        path: p("2026-08-26-memory-routing-and-review"),
        set: { superseded_by: "[[2026-09-25-memoria-automatica-nel-vault]]" },
        because: "2026-09-25-memoria-automatica-nel-vault lists this note in supersedes, but its superseded_by is missing.",
      },
    ]);
  });

  it("a consistent pair needs no fix, and a broken superseded_by is never overwritten", () => {
    const { fixes } = buildSupersedeIndex([
      note("2026-01-01-a", { status: "superseded", supersededBy: [p("2026-02-01-b")] }),
      note("2026-02-01-b", { supersedes: [p("2026-01-01-a")] }),
      note("2026-01-05-c", { supersededBy: ["missing-note"] }),
      note("2026-02-05-d", { supersedes: [p("2026-01-05-c")] }),
    ]);
    expect(fixes).toEqual([
      {
        path: p("2026-01-05-c"),
        set: { status: "superseded" },
        because: "2026-02-05-d lists this note in supersedes, but it is not marked as superseded. Broken link: superseded_by points at missing-note, which does not exist.",
      },
    ]);
  });
});

describe("markersOf", () => {
  it("reads status and both link fields, list entries included", () => {
    expect(
      markersOf("A.md", { status: "active", tags: ["x"] }, [
        { key: "supersedes.0", target: "B.md" },
        { key: "supersedes.1", target: "C.md" },
        { key: "superseded_by", target: "D.md" },
        { key: "related", target: "E.md" },
      ]),
    ).toEqual({ path: "A.md", status: "active", supersedes: ["B.md", "C.md"], supersededBy: ["D.md"] });
  });

  it("keeps a plain-text superseded_by that is not a link, so it is still superseded", () => {
    expect(markersOf("A.md", { superseded_by: "some old idea" }, [])).toEqual({
      path: "A.md",
      supersedes: [],
      supersededBy: ["some old idea"],
    });
    expect(markersOf("A.md", undefined, [])).toEqual({ path: "A.md", supersedes: [], supersededBy: [] });
  });
});

describe("applySupersede", () => {
  const { index } = buildSupersedeIndex([
    note("2026-01-01-old"),
    note("2026-02-01-new", { supersedes: [p("2026-01-01-old")] }),
    note("2026-01-01-orphan", { status: "superseded" }),
    note("Other"),
  ]);
  const hit = (name: string) => ({ path: p(name), excerpt: `about ${name}` });
  const fetchHead = (path: string) => ({ path, excerpt: "" });

  it("puts the head in the superseded note's slot and keeps the old note right below, labelled", () => {
    const out = applySupersede([hit("Other"), hit("2026-01-01-old")], index, fetchHead);
    expect(out).toEqual([
      hit("Other"),
      { path: p("2026-02-01-new"), excerpt: "" },
      { ...hit("2026-01-01-old"), supersededBy: p("2026-02-01-new") },
    ]);
  });

  it("only labels when the head is already among the hits", () => {
    const out = applySupersede([hit("2026-01-01-old"), hit("2026-02-01-new")], index, fetchHead);
    expect(out).toEqual([{ ...hit("2026-01-01-old"), supersededBy: p("2026-02-01-new") }, hit("2026-02-01-new")]);
  });

  it("leaves a superseded note with no known head as it is", () => {
    expect(applySupersede([hit("2026-01-01-orphan")], index, fetchHead)).toEqual([hit("2026-01-01-orphan")]);
  });

  it("labels without inserting when the head cannot be fetched", () => {
    expect(applySupersede([hit("2026-01-01-old")], index, () => null)).toEqual([
      { ...hit("2026-01-01-old"), supersededBy: p("2026-02-01-new") },
    ]);
  });
});

describe("formatSupersede", () => {
  it("writes the vault's changed-fact format", () => {
    expect(formatSupersede("Pro tier is 29 euro", "Pro tier is 39 euro", "2026-10-24")).toBe(
      "Pro tier is 39 euro (dal 2026-10-24; prima Pro tier is 29 euro)",
    );
  });

  it("keeps the old line's list marker and indent, once", () => {
    expect(formatSupersede("  - Pro tier is 29 euro", "- Pro tier is 39 euro", "2026-10-24")).toBe(
      "  - Pro tier is 39 euro (dal 2026-10-24; prima Pro tier is 29 euro)",
    );
    expect(formatSupersede("- [ ] ship at 29", "ship at 39", "2026-10-24")).toBe("- [ ] ship at 39 (dal 2026-10-24; prima ship at 29)");
  });
});

describe("markerKeys: never overwrite what the note already says", () => {
  const fix: MarkerFix = { path: p("a"), set: { status: "superseded", superseded_by: "[[C]]" }, because: "c lists a." };
  const note = (fm: string) => `---\n${fm}\n---\nBody\n`;

  it("without the note's text it is the whole fix", () => {
    expect(markerKeys(fix)).toEqual({ status: "superseded", superseded_by: "[[C]]" });
  });

  it("an empty or absent superseded_by is written", () => {
    for (const fm of ["status: active", "status: active\nsuperseded_by:", 'status: active\nsuperseded_by: ""', "status: active\nsuperseded_by: null", "status: active\nsuperseded_by: []"]) {
      expect(markerKeys(fix, note(fm))).toEqual({ status: "superseded", superseded_by: "[[C]]" });
    }
  });

  it("any non-empty superseded_by is left alone: quoted, unquoted wikilink, bare list, plain text, block list", () => {
    for (const value of ['"[[B]]"', "[[B]]", "[B]", "B", "'[[B]]'"]) {
      expect(markerKeys(fix, note(`status: active\nsuperseded_by: ${value}`))).toEqual({ status: "superseded" });
    }
    expect(markerKeys(fix, note("status: active\nsuperseded_by:\n  - \"[[B]]\""))).toEqual({ status: "superseded" });
  });

  it("a status that already says superseded is left alone, in any quoting", () => {
    for (const value of ["superseded", '"superseded"', "'superseded'", "superseded # why"]) {
      expect(markerKeys(fix, note(`status: ${value}`))).toEqual({ superseded_by: "[[C]]" });
    }
  });

  it("nothing is left when both are already there", () => {
    expect(markerKeys(fix, note("status: superseded\nsuperseded_by: [[B]]"))).toEqual({});
  });
});

describe("a fix's explanation always validates", () => {
  it("many broken links are cut, the structural reason stays first", () => {
    const names = Array.from({ length: 40 }, (_, i) => `2025-01-${String(i + 10)}-gone-note-with-a-long-name`);
    const { fixes } = buildSupersedeIndex([
      note("2026-01-01-a", { supersededBy: names.map(p) }),
      note("2026-02-01-b", { supersedes: [p("2026-01-01-a")] }),
    ]);
    expect(fixes).toHaveLength(1);
    const because = fixes[0].because;
    expect(because.length).toBeLessThanOrEqual(PROPOSAL_LIMITS.rationale);
    expect(because.startsWith("2026-02-01-b lists this note in supersedes")).toBe(true);
    expect(because.endsWith("…")).toBe(true);
    const c = correctionCandidate(fixes[0].path, { type: "frontmatter", set: markerKeys(fixes[0]), before: {} }, because);
    expect(parseProposalCandidates(JSON.stringify([{ ...c.payload, rationale: c.rationale }])).status).toBe("ok");
  });

  it("a short explanation is untouched", () => {
    const { fixes } = buildSupersedeIndex([note("2026-01-01-a"), note("2026-02-01-b", { supersedes: [p("2026-01-01-a")] })]);
    expect(fixes[0].because).toBe("2026-02-01-b lists this note in supersedes, but it is not marked as superseded.");
  });
});
