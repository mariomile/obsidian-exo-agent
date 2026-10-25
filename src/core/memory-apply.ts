/**
 * Memory harvest, write half: apply the decider's ADD/UPDATE decisions under
 * the guardrails in `memory-harvest.ts`. Each write is recorded as the exact
 * lines it inserted or replaced, which is what undo reverses (no note bodies
 * are stored anywhere). I/O is injected (`ApplyVault`), so this stays
 * Obsidian-free and the guardrails are testable end to end.
 */
import {
  applyAdd,
  applyUpdate,
  checkTarget,
  containsSecret,
  inboxNote,
  normalizeTarget,
  oneLine,
  stripProvenance,
  HARVEST_MAX_WRITES,
  type Decision,
  type HarvestProvenance,
  type TargetEnv,
} from "./memory-harvest";
import { formatLoop } from "./open-loops";

export interface ApplyVault {
  exists(path: string): boolean;
  /** Atomic read-modify-write of an existing note (Obsidian `vault.process`):
   *  `fn` returns the new content, or null to leave the note untouched. */
  edit(path: string, fn: (current: string) => string | null): Promise<boolean>;
  /** Create a note (and its parent folders). */
  create(path: string, content: string): Promise<void>;
}

/** One write, precise enough to reverse: the digest's row and undo's handle. */
export interface AppliedWrite {
  path: string;
  op: "add" | "update";
  /** Human-readable text for the digest. */
  text: string;
  /** add: the exact lines inserted; update: the one new line. */
  lines: string[];
  /** update: the exact line it replaced. */
  replaced?: string;
  /** add that created the note: its starter content, so undo can remove a
   *  note that holds nothing else. */
  created?: string;
}

export interface ApplyResult {
  writes: AppliedWrite[];
  rejected: { decision: Decision; reason: string }[];
}

export interface ApplyEnv extends TargetEnv {
  today: string;
  now: number;
  /** Every path shown to the decider as a NOTE: nothing else is writable
   *  (besides the inbox), whatever the model answers. */
  offered: ReadonlySet<string>;
  /** The open-loops ledger: an ADD there becomes a well-formed loop entry,
   *  and UPDATE is refused (its lines are the ledger's own metadata). */
  ledgerPath: string;
  /** The chat the facts came from: code appends it to every line it writes. */
  provenance: HarvestProvenance;
}

export async function applyDecisions(vault: ApplyVault, decisions: readonly Decision[], env: ApplyEnv): Promise<ApplyResult> {
  const writes: AppliedWrite[] = [];
  const rejected: { decision: Decision; reason: string }[] = [];
  const created = new Set<string>();

  for (const d of decisions) {
    if (d.op === "noop") continue;
    const reject = (reason: string): void => void rejected.push({ decision: d, reason });
    if (writes.length >= HARVEST_MAX_WRITES) {
      reject("write limit reached");
      continue;
    }
    const path = normalizeTarget(d.path);
    if (path !== env.inboxPath && !env.offered.has(path)) {
      reject("not a note shown to the decider");
      continue;
    }
    const why = checkTarget(path, { ...env, exists: (p) => created.has(p) || env.exists(p) });
    if (why) {
      reject(why);
      continue;
    }
    const text = d.op === "add" ? d.text : d.newText;
    if (containsSecret(text) || (d.op === "update" && containsSecret(d.oldLine))) {
      reject("looks like a credential");
      continue;
    }

    if (path === env.ledgerPath) {
      if (d.op === "update") {
        reject("the open-loops ledger only takes new loops");
        continue;
      }
      const title = oneLine(d.text).slice(0, 80);
      const block = formatLoop({ id: `loop-${env.now + writes.length}`, title, note: oneLine(d.text), openedAt: env.now, status: "open" });
      const ok = await vault.edit(path, (cur) => `${cur.replace(/\s+$/, "")}\n\n${block}\n`);
      if (!ok) reject("ledger could not be edited");
      else writes.push({ path, op: "add", text: oneLine(d.text), lines: block.split("\n") });
      continue;
    }

    if (d.op === "add" && !created.has(path) && !env.exists(path)) {
      // Only the inbox reaches here (checkTarget): create it with the fact.
      const starter = inboxNote(env.today);
      const res = applyAdd(starter, d.section, d.text, env.provenance);
      if (!res) {
        reject("text would be structure, not a line");
        continue;
      }
      await vault.create(path, res.content);
      created.add(path);
      writes.push({ path, op: "add", text: oneLine(stripProvenance(d.text)), lines: [res.line], created: starter });
      continue;
    }

    const out: { write?: AppliedWrite } = {};
    const ok = await vault.edit(path, (cur) => {
      if (d.op === "add") {
        const res = applyAdd(cur, d.section, d.text, env.provenance);
        if (!res) return null;
        out.write = { path, op: "add", text: oneLine(stripProvenance(d.text)), lines: [res.line] };
        return res.content;
      }
      const res = applyUpdate(cur, d.oldLine, d.newText, env.today);
      if (!res) return null;
      out.write = { path, op: "update", text: oneLine(stripProvenance(d.newText)), lines: [res.to], replaced: res.from };
      return res.content;
    });
    if (!ok || !out.write) {
      reject(d.op === "add" ? "text would be structure, or the note is malformed" : "oldLine is not one plain line found exactly once");
      continue;
    }
    writes.push(out.write);
  }
  return { writes, rejected };
}
