/**
 * Agent run ledger — pure parser/serializer (no Obsidian imports).
 *
 * An append-only markdown record of every agent run, one file per month under
 * `paths.agentRuns`. Deliberately the same shape as the open-loops ledger
 * (`## id` + `- key: value` + free text): greppable, diffable, editable by a
 * human, and readable on a phone.
 *
 * This is the vault-native answer to Buzz's signed work. Exo writes the facts
 * (who ran, why, what changed, whether it worked); the agent writes judgment
 * into its own memory file. Neither writes the other's half.
 */

import { stripFrontmatter } from "./agents";

export type AgentRunOutcome = "ok" | "failed" | "refused";

export interface AgentRunRecord {
  /** Sortable, unique: ISO instant + slug. */
  id: string;
  slug: string;
  /** Display name at the time of the run — names drift, records should not. */
  name: string;
  startedAt: number;
  durationMs: number;
  outcome: AgentRunOutcome;
  /** Human-readable trigger ("daily 08:00", "create _inbox/x.md", "manual"). */
  trigger: string;
  /** Autonomy tier the run executed under. */
  tier: string;
  /** Vault path of the run report, when one was written. */
  report?: string;
  /** Vault paths the run wrote. */
  writes: string[];
  /**
   * Id of the checkpoint record backing "Restore" for this run, when it wrote.
   *
   * Stored rather than derived: the checkpoint id embeds `startedAt` but also a
   * random suffix, so correlating the two records by timestamp would be a guess.
   * Absent for read-only runs, which have nothing to restore.
   */
  restoreId?: string;
  /**
   * Who asked. `exo` for a trigger or a human; an agent slug when this run was
   * delegated by another agent — the attribution chain that makes agent↔agent
   * work auditable instead of anonymous.
   */
  by: string;
  /** One-line summary, when the run produced one. */
  summary?: string;
}

/** `2026-08.md` — the ledger file a given instant belongs to. */
export function ledgerFileName(at: number): string {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}.md`;
}

export function agentRunId(slug: string, startedAt: number): string {
  return `${new Date(startedAt).toISOString()}·${slug}`;
}

const esc = (s: string) => s.replace(/\r?\n/g, " ").trim();

/** One record as a markdown block. Always ends with a blank line so appends
 *  concatenate cleanly without a read-modify-write of the whole file. */
export function serializeAgentRun(r: AgentRunRecord): string {
  const lines = [
    `## ${r.id}`,
    `- agent: ${r.slug}`,
    `- name: ${esc(r.name)}`,
    `- trigger: ${esc(r.trigger)}`,
    `- tier: ${r.tier}`,
    `- outcome: ${r.outcome}`,
    `- started: ${new Date(r.startedAt).toISOString()}`,
    `- duration: ${Math.max(0, Math.round(r.durationMs / 1000))}s`,
    `- by: ${r.by}`,
    ...(r.report ? [`- report: ${r.report}`] : []),
    ...(r.restoreId ? [`- restore: ${r.restoreId}`] : []),
    `- writes: ${r.writes.length ? r.writes.join(", ") : "(none)"}`,
    "",
    ...(r.summary ? [esc(r.summary), ""] : []),
  ];
  return lines.join("\n");
}

function parseField(block: string, key: string): string | undefined {
  const m = block.match(new RegExp(`^- ${key}:[ \\t]*(.*)$`, "m"));
  const v = m?.[1]?.trim();
  return v || undefined;
}

/** Parse a ledger file. Unknown or malformed blocks are skipped, never thrown —
 *  a hand-edited ledger must degrade, not break the pane that reads it. */
export function parseAgentLedger(raw: string): AgentRunRecord[] {
  const out: AgentRunRecord[] = [];
  // Split on headings, keeping each heading with its body.
  const blocks = raw.split(/^## /m).slice(1);
  for (const chunk of blocks) {
    const nl = chunk.indexOf("\n");
    const id = (nl === -1 ? chunk : chunk.slice(0, nl)).trim();
    const body = nl === -1 ? "" : chunk.slice(nl + 1);
    const slug = parseField(body, "agent");
    const started = parseField(body, "started");
    if (!id || !slug || !started) continue;
    const startedAt = Date.parse(started);
    if (!Number.isFinite(startedAt)) continue;

    const outcomeRaw = parseField(body, "outcome");
    const outcome: AgentRunOutcome =
      outcomeRaw === "ok" || outcomeRaw === "failed" || outcomeRaw === "refused" ? outcomeRaw : "failed";

    const writesRaw = parseField(body, "writes");
    const writes =
      !writesRaw || writesRaw === "(none)"
        ? []
        : writesRaw.split(",").map((w) => w.trim()).filter(Boolean);

    const durationRaw = parseField(body, "duration") ?? "0s";
    const seconds = Number.parseInt(durationRaw, 10);

    // Free text after the field block is the summary.
    const summary = body
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.startsWith("- "))
      .join(" ")
      .trim();

    out.push({
      id,
      slug,
      name: parseField(body, "name") ?? slug,
      startedAt,
      durationMs: Number.isFinite(seconds) ? seconds * 1000 : 0,
      outcome,
      trigger: parseField(body, "trigger") ?? "unknown",
      tier: parseField(body, "tier") ?? "propose",
      report: parseField(body, "report"),
      ...(parseField(body, "restore") ? { restoreId: parseField(body, "restore") } : {}),
      writes,
      by: parseField(body, "by") ?? "exo",
      ...(summary ? { summary } : {}),
    });
  }
  return out;
}

/** Newest first — the order every consumer wants. */
export function sortRuns(runs: AgentRunRecord[]): AgentRunRecord[] {
  return [...runs].sort((a, b) => b.startedAt - a.startedAt);
}

export function runsForAgent(runs: AgentRunRecord[], slug: string): AgentRunRecord[] {
  return sortRuns(runs.filter((r) => r.slug === slug));
}

/** The delegation chain that produced a run, oldest caller first. Cycles are
 *  impossible by construction (depth cap) but the walk is bounded anyway. */
export function attributionChain(runs: AgentRunRecord[], id: string, max = 8): string[] {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const chain: string[] = [];
  let cursor = byId.get(id);
  const seen = new Set<string>();
  while (cursor && chain.length < max && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.unshift(cursor.slug);
    if (cursor.by === "exo") break;
    cursor = runs.find((r) => r.slug === cursor!.by && r.startedAt <= cursor!.startedAt);
  }
  return chain;
}

/* ------------------------------- memory ------------------------------- */

/** Vault path of an agent's compounding memory. A scope under vault memory —
 *  not a fifth store; the Memory Map's precedence rules are unchanged. */
export function agentMemoryPath(agentMemoryDir: string, slug: string): string {
  return `${agentMemoryDir}/${slug}.md`;
}

/** Seed content for an agent's memory file. */
export function initialAgentMemory(name: string, slug: string, today = ""): string {
  return [
    "---",
    "type: memory",
    "subtype: agent-memory",
    `agent: ${slug}`,
    "created_by: exo",
    ...(today ? [`last_updated: ${today}`] : []),
    "tags:",
    "  - type/memory",
    "---",
    "",
    `# ${name} — memory`,
    "",
    "> What this agent has learned across runs. It reads this file before every run",
    "> and appends to it when a run produces something durable. Edit it freely —",
    "> a line removed here is a lesson the agent forgets.",
    "",
    "## Learnings",
    "",
  ].join("\n");
}

/** Trim an agent's memory to the block that rides into a run prompt. Keeps the
 *  tail (most recent learnings) when the file has outgrown the budget. */
export function agentMemoryExcerpt(raw: string, maxChars = 4000): string {
  const body = stripFrontmatter(raw).trim();
  if (body.length <= maxChars) return body;
  const tail = body.slice(body.length - maxChars);
  const cut = tail.indexOf("\n");
  return `…\n${cut === -1 ? tail : tail.slice(cut + 1)}`;
}
