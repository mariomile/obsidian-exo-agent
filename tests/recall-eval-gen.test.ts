import { describe, it, expect } from "vitest";
import { generateCases, questionFromLine, type GenInput, type GenNote } from "../src/core/recall-eval-gen";
import { buildSupersedeIndex, type NoteMarkers } from "../src/core/supersede";

const D = "_system/memory/decisions";
const P = "CRM/People";
const NOW = "_system/agent/NOW.md";
const dec = (name: string): string => `${D}/${name}.md`;

const note = (path: string, extra: Partial<GenNote> = {}): GenNote => ({
  path,
  basename: path.replace(/^.*\//, "").replace(/\.md$/, ""),
  frontmatter: {},
  lines: [],
  links: [],
  ...extra,
});

/** A canonical note whose line `i` links the given targets. */
const canonical = (path: string, rows: { text: string; targets: string[] }[]): GenNote =>
  note(path, {
    lines: rows.map((r) => r.text),
    links: rows.flatMap((r, line) => r.targets.map((target) => ({ line, target }))),
  });

function input(notes: GenNote[], markers: NoteMarkers[] = [], canonicalPaths: string[] = [NOW]): GenInput {
  return {
    notes,
    canonicalPaths,
    supersede: buildSupersedeIndex(markers).index,
    decisionsFolder: D,
    peopleFolder: P,
    projectsFolder: "Active/Projects",
  };
}

const LONG = "Il formato della memoria automatica del vault passa dal file unico alle note canoniche";

describe("questionFromLine", () => {
  it("strips list markers, wikilinks, fonte and dal tails", () => {
    const q = questionFromLine('- [ ] Decidere il formato della memoria automatica [[2026-09-25-memoria]] [fonte: chat "X" (obsidian://exo-chat?id=1); dal: 2026-10-01] (dal 2026-10-02; prima altro)');
    expect(q).toBe("Decidere il formato della memoria automatica");
  });

  it("keeps the label of an aliased wikilink out of the question", () => {
    expect(questionFromLine("- Scelta del task manager [[2026-10-20-todoist|Todoist]] per tutto il lavoro quotidiano")).toBe("Scelta del task manager per tutto il lavoro quotidiano");
  });

  it("returns null below 4 keywords", () => {
    expect(questionFromLine("- decisione [[2026-09-25-memoria]]: vedi sopra")).toBeNull();
  });
});

describe("generateCases: link family", () => {
  const a = dec("2026-09-25-memoria-automatica");
  const b = dec("2026-10-06-memoria-senza-umano");
  const notes = (): GenNote[] => [note(a), note(b)];

  it("a multi-link line becomes ONE case with every target expected", () => {
    const now = canonical(NOW, [{ text: `- ${LONG} [[x]] [[y]]`, targets: [a, b] }]);
    const cases = generateCases(input([now, ...notes()])).filter((c) => c.family === "link");
    expect(cases).toHaveLength(1);
    expect(cases[0].expect).toEqual([{ note: a }, { note: b }]);
    expect(cases[0].source).toBe(`${NOW}:1`);
    expect(cases[0].question).toBe(questionFromLine(`- ${LONG} [[x]] [[y]]`));
  });

  it("a superseded target is expected as its head, with the old note in mustNotLead", () => {
    const now = canonical(NOW, [{ text: `- ${LONG}`, targets: [a] }]);
    const markers: NoteMarkers[] = [
      { path: a, supersedes: [], supersededBy: [b] },
      { path: b, supersedes: [a], supersededBy: [] },
    ];
    const [c] = generateCases(input([now, ...notes()], markers)).filter((x) => x.family === "link");
    expect(c.expect).toEqual([{ note: b }]);
    expect(c.mustNotLead).toEqual([a]);
  });

  it("a line under 4 keywords is dropped", () => {
    const now = canonical(NOW, [{ text: "- decisione: vedi sopra", targets: [a] }]);
    expect(generateCases(input([now, ...notes()])).filter((c) => c.family === "link")).toEqual([]);
  });

  it("a line that links no decision gives no link case", () => {
    const now = canonical(NOW, [{ text: `- ${LONG}`, targets: ["Knowledge/Other.md"] }]);
    expect(generateCases(input([now, note("Knowledge/Other.md"), ...notes()])).filter((c) => c.family === "link")).toEqual([]);
  });

  it("at most 2 cases per decision", () => {
    const rows = [1, 2, 3, 4].map((n) => ({ text: `- ${LONG} variante ${n} della riga`, targets: [a] }));
    const now = canonical(NOW, rows);
    const cases = generateCases(input([now, ...notes()])).filter((c) => c.family === "link");
    expect(cases).toHaveLength(2);
    expect(cases.map((c) => c.source)).toEqual([`${NOW}:1`, `${NOW}:2`]);
  });

  it("the cap counts the note a case expects: an old and its head share one budget", () => {
    const markers: NoteMarkers[] = [
      { path: a, supersedes: [], supersededBy: [b] },
      { path: b, supersedes: [a], supersededBy: [] },
    ];
    const now = canonical(NOW, [
      { text: `- ${LONG} prima riga`, targets: [a] },
      { text: `- ${LONG} seconda riga`, targets: [b] },
      { text: `- ${LONG} terza riga`, targets: [a] },
      { text: `- ${LONG} quarta riga`, targets: [b] },
    ]);
    const cases = generateCases(input([now, ...notes()], markers)).filter((c) => c.family === "link");
    expect(cases.map((c) => c.source)).toEqual([`${NOW}:1`, `${NOW}:2`]);
    expect(cases.every((c) => c.expect.length === 1 && "note" in c.expect[0] && c.expect[0].note === b)).toBe(true);
  });

  it("a line with some capped targets keeps the others; it is dropped only when none remain", () => {
    const now = canonical(NOW, [
      { text: `- ${LONG} prima riga`, targets: [a] },
      { text: `- ${LONG} seconda riga`, targets: [a] },
      { text: `- ${LONG} terza riga`, targets: [a, b] },
      { text: `- ${LONG} quarta riga`, targets: [a] },
    ]);
    const cases = generateCases(input([now, ...notes()])).filter((c) => c.family === "link");
    expect(cases.map((c) => c.source)).toEqual([`${NOW}:1`, `${NOW}:2`, `${NOW}:3`]);
    expect(cases[2].expect).toEqual([{ note: b }]);
  });

  it("only canonical notes feed the link family", () => {
    const other = canonical("Knowledge/Other.md", [{ text: `- ${LONG}`, targets: [a] }]);
    expect(generateCases(input([other, ...notes()])).filter((c) => c.family === "link")).toEqual([]);
  });
});

describe("generateCases: project family", () => {
  it("a folder note Active/Projects/<P>/<P>.md is a hub, a sibling is not", () => {
    const notes = [
      note("Active/Projects/Exo/Exo.md"),
      note("Active/Projects/Exo/Roadmap.md"),
      note("Active/Projects/Exo/Sub/Sub.md"),
      note("Knowledge/Exo/Exo.md"),
    ];
    const cases = generateCases(input(notes)).filter((c) => c.family === "project");
    expect(cases).toHaveLength(1);
    expect(cases[0].question).toBe("Qual è lo stato attuale del progetto Exo e qual è il prossimo passo?");
    expect(cases[0].expect).toEqual([{ note: "Active/Projects/Exo/Exo.md" }]);
    expect(cases[0].source).toBe("Active/Projects/Exo/Exo.md");
  });
});

describe("generateCases: project family, folder from the input", () => {
  it("hubs are found under the projects folder the input names", () => {
    const notes = [note("Work/Exo/Exo.md"), note("Active/Projects/Old/Old.md")];
    const cases = generateCases({ ...input(notes), projectsFolder: "Work" }).filter((c) => c.family === "project");
    expect(cases.map((c) => c.source)).toEqual(["Work/Exo/Exo.md"]);
  });
});

describe("generateCases: ids", () => {
  it("person and supersede ids come from the path, so same-named notes cannot collide", () => {
    const x = `${P}/A/Ada.md`;
    const y = `${P}/B/Ada.md`;
    const now = canonical(NOW, [{ text: "- Sentire Ada", targets: [x, y] }]);
    const persons = generateCases(input([now, note(x), note(y)])).filter((c) => c.family === "person");
    expect(new Set(persons.map((c) => c.id)).size).toBe(2);

    const o1 = `${D}/a/2026-01-01-same.md`;
    const o2 = `${D}/b/2026-01-01-same.md`;
    const h = dec("2026-02-01-head");
    const d = { description: "Quale strumento uso per i task di tutti i giorni" };
    const markers: NoteMarkers[] = [
      { path: o1, supersedes: [], supersededBy: [h] },
      { path: o2, supersedes: [], supersededBy: [h] },
      { path: h, supersedes: [o1, o2], supersededBy: [] },
    ];
    const sup = generateCases(input([note(o1, { frontmatter: d }), note(o2, { frontmatter: d }), note(h)], markers)).filter((c) => c.family === "supersede");
    expect(new Set(sup.map((c) => c.id)).size).toBe(2);
  });
});

describe("generateCases: person family", () => {
  const ada = `${P}/Ada Lovelace.md`;
  const bob = `${P}/Bob Stone.md`;

  it("a person is included only when linked from a canonical note", () => {
    const now = canonical(NOW, [{ text: "- Sentire Ada", targets: [ada] }]);
    const other = canonical("Knowledge/Other.md", [{ text: "- Sentire Bob", targets: [bob] }]);
    const cases = generateCases(input([now, other, note(ada), note(bob)])).filter((c) => c.family === "person");
    expect(cases).toHaveLength(1);
    expect(cases[0].question).toBe("Chi è Ada Lovelace e che rapporto ho con questa persona?");
    expect(cases[0].expect).toEqual([{ note: ada }]);
  });

  it("one case per person however many lines link them", () => {
    const now = canonical(NOW, [
      { text: "- Sentire Ada", targets: [ada] },
      { text: "- Richiamare Ada", targets: [ada] },
    ]);
    expect(generateCases(input([now, note(ada)])).filter((c) => c.family === "person")).toHaveLength(1);
  });
});

describe("generateCases: supersede family", () => {
  const old = dec("2026-08-27-notion-solo-progetti");
  const head = dec("2026-10-20-todoist-task-manager");
  const markers: NoteMarkers[] = [
    { path: old, supersedes: [], supersededBy: [head] },
    { path: head, supersedes: [old], supersededBy: [] },
  ];

  it("the description of a superseded decision is the question, its head the expectation", () => {
    const notes = [note(old, { frontmatter: { description: "Quale strumento uso per i task di tutti i giorni" } }), note(head)];
    const cases = generateCases(input(notes, markers)).filter((c) => c.family === "supersede");
    expect(cases).toHaveLength(1);
    expect(cases[0].question).toBe("Quale strumento uso per i task di tutti i giorni");
    expect(cases[0].expect).toEqual([{ note: head }]);
    expect(cases[0].mustNotLead).toEqual([old]);
    expect(cases[0].source).toBe(old);
  });

  it("a superseded decision without a description is skipped", () => {
    expect(generateCases(input([note(old), note(head)], markers)).filter((c) => c.family === "supersede")).toEqual([]);
  });

  it("a decision that is not superseded gives no supersede case", () => {
    const notes = [note(head, { frontmatter: { description: "Quale strumento uso per i task di tutti i giorni" } })];
    expect(generateCases(input(notes)).filter((c) => c.family === "supersede")).toEqual([]);
  });
});

describe("generateCases: determinism", () => {
  it("the same input gives the same cases, whatever the order of the notes", () => {
    const a = dec("2026-09-25-memoria-automatica");
    const ada = `${P}/Ada Lovelace.md`;
    const notes = [
      canonical(NOW, [{ text: `- ${LONG}`, targets: [a] }, { text: "- Sentire Ada", targets: [ada] }]),
      note(a),
      note(ada),
      note("Active/Projects/Exo/Exo.md"),
      note("Active/Projects/Alfa/Alfa.md"),
    ];
    const first = generateCases(input(notes));
    const second = generateCases(input([...notes].reverse()));
    expect(second).toEqual(first);
    expect(new Set(first.map((c) => c.id)).size).toBe(first.length);
    expect(first.map((c) => c.family)).toEqual(["link", "project", "project", "person"]);
  });
});
