/**
 * The generated recall eval: questions derived from the vault's own structure,
 * so the expected answer is a link or a path Mario already wrote, never a label
 * a person or a model typed. Four families (plan Release 4, 3.1): decisions
 * linked from canonical notes, project hubs, CRM people linked from canonical
 * notes, and supersede chains. Pure: the live harness
 * (`tests/live/recall-eval.live.test.ts`) reads the vault and hands the notes
 * in; scoring is `recall-eval.ts`. No Obsidian import.
 */
import type { EvalCase } from "./recall-eval";
import { recallKeywords, shouldRecall } from "./turn-recall";
import { withoutListMarker, type SupersedeIndex } from "./supersede";

export type CaseFamily = "link" | "project" | "person" | "supersede";

export interface GenNote {
  path: string;
  basename: string;
  /** status, description, aliases, supersedes, superseded_by. */
  frontmatter: Record<string, unknown>;
  /** Body lines, frontmatter stripped. */
  lines: string[];
  /** Resolved wikilink targets (vault paths); `line` indexes `lines`, from 0. */
  links: { line: number; target: string }[];
}

export interface GenInput {
  notes: readonly GenNote[];
  /** NOW.md, open-loops.md, Active/Projects/**\/*.md. */
  canonicalPaths: readonly string[];
  supersede: SupersedeIndex;
  decisionsFolder: string;
  peopleFolder: string;
  /** Holds one folder per project, each with a hub note of the same name (Active/Projects). */
  projectsFolder: string;
}

export interface GenCase extends EvalCase {
  family: CaseFamily;
  /** `path:line` (1-based) the case was derived from, or the path alone. */
  source: string;
}

/** Decisions get at most this many cases each: a note linked from twenty lines must not dominate the rate. */
const MAX_CASES_PER_DECISION = 2;
/** A line needs this many keywords to be a question: below it the line says nothing a search could use. */
const MIN_LINE_KEYWORDS = 4;

/**
 * A canonical line as a question: list marker, wikilinks (the answer's own
 * name), `[fonte ...]` and `(dal ...; prima ...)` tails removed. Null when
 * fewer than {@link MIN_LINE_KEYWORDS} keywords remain.
 */
export function questionFromLine(line: string): string | null {
  const text = withoutListMarker(line)
    .replace(/^(?:>\s*|#{1,6}\s+)+/, "")
    .replace(/!?\[\[[^\]]*\]\]/g, " ")
    .replace(/\[fonte[^\]]*\]/gi, " ")
    .replace(/\((?:dal|prima)\b[^)]*\)/gi, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s\^[\w-]+$/, "")
    .replace(/[*`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return recallKeywords(text).length >= MIN_LINE_KEYWORDS ? text : null;
}

const byPath = <T extends { path: string }>(a: T, b: T): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const inFolder = (path: string, folder: string): boolean => path.startsWith(`${folder.replace(/\/$/, "")}/`);

/** `<projectsFolder>/<P>/<P>.md`: the project's hub note. */
function hubProject(note: GenNote, projectsFolder: string): string | null {
  const root = projectsFolder.replace(/\/$/, "");
  if (!inFolder(note.path, root)) return null;
  const parts = note.path.slice(root.length + 1).split("/");
  return parts.length === 2 && parts[1] === `${parts[0]}.md` ? parts[0] : null;
}

function linkCases(input: GenInput, notes: readonly GenNote[], exists: ReadonlySet<string>): GenCase[] {
  const canonical = new Set(input.canonicalPaths);
  /** Cases per expected note: the head of a chain, not the note a line links. */
  const used = new Map<string, number>();
  const expectedOf = (target: string): string => input.supersede.headOf(target) ?? target;
  const out: GenCase[] = [];
  for (const note of notes) {
    if (!canonical.has(note.path)) continue;
    for (let line = 0; line < note.lines.length; line++) {
      const linked = [
        ...new Set(note.links.filter((l) => l.line === line && exists.has(l.target) && inFolder(l.target, input.decisionsFolder)).map((l) => l.target)),
      ];
      if (!linked.length) continue;
      const question = questionFromLine(note.lines[line]);
      if (!question) continue;
      const targets = linked.filter((t) => (used.get(expectedOf(t)) ?? 0) < MAX_CASES_PER_DECISION);
      if (!targets.length) continue;
      const expected = [...new Set(targets.map(expectedOf))];
      for (const e of expected) used.set(e, (used.get(e) ?? 0) + 1);
      const stale = targets.filter((t) => input.supersede.headOf(t) !== null && !expected.includes(t));
      out.push({
        id: `link:${note.path}:${line + 1}`,
        family: "link",
        source: `${note.path}:${line + 1}`,
        question,
        expect: expected.map((n) => ({ note: n })),
        ...(stale.length ? { mustNotLead: stale } : {}),
      });
    }
  }
  return out;
}

function projectCases(notes: readonly GenNote[], projectsFolder: string): GenCase[] {
  return notes
    .flatMap((n) => {
      const project = hubProject(n, projectsFolder);
      return project ? [{ note: n, project }] : [];
    })
    .map(({ note, project }): GenCase => ({
      id: `project:${project}`,
      family: "project",
      source: note.path,
      question: `Qual è lo stato attuale del progetto ${project} e qual è il prossimo passo?`,
      expect: [{ note: note.path }],
    }));
}

function personCases(input: GenInput, notes: readonly GenNote[], exists: ReadonlySet<string>): GenCase[] {
  const canonical = new Set(input.canonicalPaths);
  const basename = new Map(notes.map((n) => [n.path, n.basename]));
  const first = new Map<string, string>();
  for (const note of notes) {
    if (!canonical.has(note.path)) continue;
    for (const l of note.links) {
      if (exists.has(l.target) && inFolder(l.target, input.peopleFolder) && !first.has(l.target)) first.set(l.target, `${note.path}:${l.line + 1}`);
    }
  }
  return [...first.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, source]): GenCase => ({
      id: `person:${path}`,
      family: "person",
      source,
      question: `Chi è ${basename.get(path)} e che rapporto ho con questa persona?`,
      expect: [{ note: path }],
    }));
}

function supersedeCases(input: GenInput, notes: readonly GenNote[]): GenCase[] {
  const out: GenCase[] = [];
  for (const note of notes) {
    if (!inFolder(note.path, input.decisionsFolder) || !input.supersede.isSuperseded(note.path)) continue;
    const description = typeof note.frontmatter.description === "string" ? note.frontmatter.description.trim() : "";
    const head = input.supersede.headOf(note.path);
    if (!description || !head || !shouldRecall(description)) continue;
    out.push({
      id: `supersede:${note.path}`,
      family: "supersede",
      source: note.path,
      question: description,
      expect: [{ note: head }],
      mustNotLead: [note.path],
    });
  }
  return out;
}

/** Every case the vault supports, in a fixed order (link, project, person,
 *  supersede; by path within a family) so two runs can be diffed by id. */
export function generateCases(input: GenInput): GenCase[] {
  const notes = [...input.notes].sort(byPath);
  const exists = new Set(notes.map((n) => n.path));
  return [
    ...linkCases(input, notes, exists),
    ...projectCases(notes, input.projectsFolder),
    ...personCases(input, notes, exists),
    ...supersedeCases(input, notes),
  ];
}
