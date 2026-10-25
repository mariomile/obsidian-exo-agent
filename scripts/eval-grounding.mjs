#!/usr/bin/env node
// Grounding eval. Read-only: reads recall-log.json and the conversations from
// the plugin folder, and the vault's file list (plus the frontmatter of the
// recalled notes, for aliases); writes nothing anywhere.
//
//   pnpm eval:grounding
//
// Vault: EXO_VAULT, default Mario's vault. For every logged turn it finds the
// assistant reply that followed the logged user message, resolves the
// [[wikilinks]] in it against the vault, and prints:
//   turns scored, citation rate (reply links a
//   recalled note), and superseded notes cited as current (reply links a
//   superseded note without linking its successor; target 0).
// Needs Node 22.18+ (it loads src/core/grounding.ts as it is).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { answerAfter, makeResolver, scoreGrounding } from "../src/core/grounding.ts";

const vault = process.env.EXO_VAULT ?? "/Users/mariomiletta/Vaults/marioverse.ai";
const dir = join(vault, ".obsidian/plugins/exo-agent");
const logPath = join(dir, "recall-log.json");

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []);
const entries = readJson(logPath);

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");
const ratio = (n, d) => `${n}/${d} (${pct(n, d)})`;

console.log(`recall log: ${logPath}${existsSync(logPath) ? "" : " (not written yet)"}`);
if (!entries.length) {
  console.log("");
  console.log("turns scored:             0   no recall turns logged yet; the log is written from the release that adds it");
  process.exit(0);
}

const convos = new Map();
for (const file of ["conversations.json", "conversations-archive.json"]) {
  for (const c of readJson(join(dir, file))) if (!convos.has(c.id)) convos.set(c.id, c);
}

// Vault markdown files, minus dot-folders (.obsidian, .archive, .git).
const files = [];
const walk = (rel) => {
  for (const d of readdirSync(join(vault, rel), { withFileTypes: true })) {
    if (d.name.startsWith(".") || d.name === "node_modules") continue;
    const path = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) walk(path);
    else if (d.name.endsWith(".md")) files.push({ path });
  }
};
walk("");

// Aliases matter only for notes the log mentions: a link can only count as a
// citation of a recalled note (or of its successor).
const aliasesOf = (path) => {
  const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(vault, path), "utf8"))?.[1] ?? "";
  const inline = /^aliases?:\s*\[(.*)\]\s*$/m.exec(fm)?.[1];
  const block = /^aliases?:\s*\n((?:\s+-\s.*\n?)+)/m.exec(`${fm}\n`)?.[1];
  const raw = inline ? inline.split(",") : block ? block.split("\n").map((l) => l.replace(/^\s*-\s*/, "")) : [];
  return raw.map((a) => a.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
};
const mentioned = new Set(entries.flatMap((e) => e.notes.flatMap((n) => [n.path, n.supersededBy].filter(Boolean))));
for (const f of files) if (mentioned.has(f.path)) f.aliases = aliasesOf(f.path);
const resolve = makeResolver(files);

const answerOf = (e) => answerAfter(convos.get(e.convoId)?.messages ?? [], e);
const score = scoreGrounding(entries, answerOf, resolve);
const lost = entries.filter((e) => answerOf(e) === null);

console.log(`conversations read:       ${convos.size}`);
console.log(`logged turns:             ${entries.length} (${lost.length} without a reply to join: deleted, rewound or still running)`);
console.log("");
console.log(`turns scored:             ${score.turns}`);
console.log(`citation rate:            ${ratio(score.citingRecalled, score.turns)}   replies linking a recalled note`);
console.log(`superseded as current:    ${score.supersededCitedAsCurrent}   replies linking a superseded note without its successor (target 0)`);
