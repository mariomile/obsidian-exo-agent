#!/usr/bin/env node
// Memory-harvest eval. Read-only: reads memory-harvests.json from the plugin
// folder and the notes it points to from disk; writes nothing anywhere.
//
//   pnpm eval:harvest                    all records in the log
//   pnpm eval:harvest -- --since=2026-11-01   only harvests from that local date on
//
// Vault: EXO_VAULT, default Mario's vault. Prints, over the selected writes:
//   writes, verbatim survival (non-inbox writes whose exact lines are still in
//   the note), provenance rate, undo rate, inbox share.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const vault = process.env.EXO_VAULT ?? "/Users/mariomiletta/Vaults/marioverse.ai";
const logPath = join(vault, ".obsidian/plugins/exo-agent/memory-harvests.json");
const sinceArg = process.argv.find((a) => a.startsWith("--since="))?.slice("--since=".length);
const since = sinceArg ? new Date(`${sinceArg}T00:00:00`).getTime() : 0;
if (sinceArg && Number.isNaN(since)) {
  console.error(`eval:harvest: bad --since "${sinceArg}", expected YYYY-MM-DD`);
  process.exit(1);
}
if (!existsSync(logPath)) {
  console.error(`eval:harvest: no harvest log at ${logPath}`);
  process.exit(1);
}

const records = JSON.parse(readFileSync(logPath, "utf8")).filter((r) => r.at >= since);
const writes = records.flatMap((r) => r.writes.map((w) => ({ ...w, undone: Boolean(r.undoneAt) })));

const isInbox = (w) => /(^|\/)memory\/inbox\//.test(w.path);
// A fact line carries provenance when it has a source tail: `[fonte: ...; dal: ...]`
// on an added fact, `(dal ...; prima ...) [fonte: ...]` on an updated one. The
// bare `(dal ...; prima ...)` of releases before the source tail counts too.
const hasProvenance = (w) => w.lines.some((l) => /\[fonte:|\bdal:|\(dal \d{4}-\d{2}-\d{2}; prima /.test(l));

// The release-4 baseline counted only `[fonte:` and `dal:`; kept for comparison.
const hasBaselineProvenance = (w) => w.lines.some((l) => /\[fonte:|\bdal:/.test(l));

const notes = new Map();
const noteLines = (path) => {
  if (!notes.has(path)) {
    const file = join(vault, path);
    notes.set(path, existsSync(file) ? new Set(readFileSync(file, "utf8").split("\n").map((l) => l.trimEnd())) : null);
  }
  return notes.get(path);
};
const survives = (w) => {
  const set = noteLines(w.path);
  return set !== null && w.lines.every((l) => set.has(l.trimEnd()));
};

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");
const ratio = (n, d) => `${n}/${d} (${pct(n, d)})`;

const inbox = writes.filter(isInbox);
const routed = writes.filter((w) => !isInbox(w));
const added = writes.filter((w) => w.op === "add");
const updated = writes.filter((w) => w.op === "update");

console.log(`harvest log: ${logPath}`);
console.log(`scope: ${sinceArg ? `harvests since ${sinceArg}` : "all records in the log"}`);
console.log("");
console.log(`harvests:                 ${records.length}`);
console.log(`writes:                   ${writes.length} (${added.length} add, ${updated.length} update)`);
console.log(`inbox share:              ${ratio(inbox.length, writes.length)}`);
console.log(`undo rate (writes):       ${ratio(writes.filter((w) => w.undone).length, writes.length)}`);
console.log(`undo rate (harvests):     ${ratio(records.filter((r) => r.undoneAt).length, records.length)}`);
console.log(`verbatim survival:        ${ratio(routed.filter(survives).length, routed.length)}   non-inbox writes still in the note, exact lines`);
console.log(`provenance, non-inbox:    ${ratio(routed.filter(hasProvenance).length, routed.length)}`);
console.log(`provenance, all writes:   ${ratio(writes.filter(hasProvenance).length, writes.length)}`);
console.log(`provenance, add / update: ${ratio(added.filter(hasProvenance).length, added.length)} / ${ratio(updated.filter(hasProvenance).length, updated.length)}`);
console.log(`provenance, baseline def: ${ratio(routed.filter(hasBaselineProvenance).length, routed.length)} non-inbox, ${ratio(writes.filter(hasBaselineProvenance).length, writes.length)} all   ([fonte: or dal: only)`);
