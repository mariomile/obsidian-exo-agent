/**
 * Agent runs — pure decision core for unattended agent execution.
 *
 * Every trigger (schedule today; vault events and note-mentions later) funnels
 * through here, so there is exactly one place that answers "may this agent run
 * right now?". The executor owns timers, vault IO and the CLI; this module owns
 * the gates.
 *
 * The gates deliberately live OUTSIDE the agent's own reasoning loop — an agent
 * cannot talk its way past a cooldown, a concurrency cap or a budget stop, the
 * way it could if these were instructions in a prompt.
 */

import {
  isDue,
  currentSlotStart,
  type Cadence,
} from "./automations";
import {
  triggerLabel,
  triggerKey,
  type AgentAutonomy,
  type AgentBrain,
  type AgentContract,
  type AgentDef,
  type AgentTrigger,
} from "./agents";
import { journalContract } from "./agent-journal";
import { parseProposalCandidates, type ProposalCandidate, type ProposalRecord } from "./proposals";

/** Persistence key for "when did this agent last run at all" (cooldown). */
export function agentLastRunKey(slug: string): string {
  return `agent:${slug}`;
}

/** Persistence key for "when did this agent last run FOR THIS TRIGGER" (slot
 *  semantics). Separate from the cooldown key so an agent with two schedules
 *  keeps one slot cursor per schedule. */
export function agentTriggerRunKey(slug: string, trigger: AgentTrigger): string {
  return `agent:${slug}::${triggerKey(trigger)}`;
}

/** Every schedule slot cursor an agent owns, one per schedule trigger. */
export function scheduleSlotKeys(agent: AgentDef): string[] {
  return agent.contract.triggers.filter((t) => t.on === "schedule").map((t) => agentTriggerRunKey(agent.brain.slug, t));
}

export interface DueAgentRun {
  agent: AgentDef;
  trigger: AgentTrigger;
  /** Persistence key to stamp once the run completes. */
  runKey: string;
  /** Human-readable trigger label, for notices and the run report. */
  reason: string;
}

/**
 * Scheduled agents whose slot has come round.
 *
 * Slot semantics (shared with automations) are what make catch-up safe: an
 * agent that was due while Obsidian was closed runs ONCE when it reopens, not
 * once per missed slot.
 */
export function dueScheduledAgentRuns(
  agents: AgentDef[],
  lastRun: Record<string, number>,
  now: number
): DueAgentRun[] {
  const out: DueAgentRun[] = [];
  for (const agent of agents) {
    if (!agent.contract.enabled) continue;
    for (const trigger of agent.contract.triggers) {
      if (trigger.on !== "schedule") continue;
      const runKey = agentTriggerRunKey(agent.brain.slug, trigger);
      if (!isDue(trigger.cadence, lastRun[runKey] ?? 0, now)) continue;
      out.push({ agent, trigger, runKey, reason: triggerLabel(trigger) });
    }
  }
  return out;
}

/**
 * Stamp "now" on every schedule slot that has no cursor yet, and return how
 * many were stamped. A missing cursor reads as "never ran", which is due at
 * once: without this a new automation saved at 22:00 with `daily 07:00` (or a
 * when-line edited, or a paused one switched on) fires on the next tick
 * instead of at its next 07:00. Runs before `dueScheduledAgentRuns`.
 */
export function seedUnseenSlots(agents: AgentDef[], lastRun: Record<string, number>, now: number): number {
  let seeded = 0;
  for (const agent of agents) {
    if (!agent.contract.enabled) continue;
    for (const key of scheduleSlotKeys(agent)) {
      if (lastRun[key] !== undefined) continue;
      lastRun[key] = now;
      seeded++;
    }
  }
  return seeded;
}

/** When a scheduled agent will next fire (Cockpit/pane display). */
export function nextScheduledSlot(cadence: Cadence, lastRun: number, now: number): number {
  return isDue(cadence, lastRun, now) ? now : currentSlotStart(cadence, now);
}

export type RunRefusal = "disabled" | "cooldown" | "concurrency" | "duplicate" | "budget" | "unavailable";

export type RunGate = { ok: true } | { ok: false; reason: RunRefusal; detail: string };

export interface GateInput {
  agent: AgentDef;
  /** Last run of this agent by ANY trigger. 0 = never. */
  lastRunAt: number;
  now: number;
  /** Runs already in flight (any agent). */
  running: number;
  maxConcurrent: number;
  /** Keys of runs already queued or in flight — dedupe target. */
  inFlightKeys: ReadonlySet<string>;
  runKey: string;
  /** False when the token/cost budget for background work is exhausted. */
  budgetAvailable: boolean;
  /** Manual runs bypass cooldown and schedule slots — a human asked. */
  manual?: boolean;
  /**
   * A run delegated by another agent. Exempt from the concurrency cap: the
   * caller is blocked awaiting the tool result, so a nested run adds depth, not
   * parallelism. Depth is bounded separately by `gateAgentInvoke`.
   */
  nested?: boolean;
  /**
   * Whether this device can actually spawn the CLI — false on mobile, where
   * there is no process to spawn.
   *
   * Triggers are the only thing in Exo that starts work nobody asked for, so on
   * a phone they must decline rather than fail: otherwise every note captured
   * on the go produces an error notice for a run that was never possible.
   * Defaults to true so existing callers and tests are unaffected.
   */
  canSpawn?: boolean;
}

/**
 * Decide whether a single run may start. Order matters: the cheapest and most
 * absolute refusals come first, so a disabled agent is never reported as
 * merely rate-limited.
 */
export function gateAgentRun(input: GateInput): RunGate {
  const { agent, runKey, now, manual } = input;
  if (input.canSpawn === false) {
    return { ok: false, reason: "unavailable", detail: "agent runs need the CLI, which this device cannot spawn" };
  }
  if (!agent.contract.enabled && !manual) {
    return { ok: false, reason: "disabled", detail: `${agent.brain.name} is disabled` };
  }
  if (input.inFlightKeys.has(runKey)) {
    return { ok: false, reason: "duplicate", detail: `${agent.brain.name} already has this run queued` };
  }
  if (!input.nested && input.running >= input.maxConcurrent) {
    return {
      ok: false,
      reason: "concurrency",
      detail: `${input.running}/${input.maxConcurrent} agent runs already in flight`,
    };
  }
  if (!input.budgetAvailable) {
    return { ok: false, reason: "budget", detail: "background budget exhausted" };
  }
  if (!manual) {
    const elapsed = now - input.lastRunAt;
    if (input.lastRunAt > 0 && elapsed < agent.contract.cooldownMs) {
      const left = Math.ceil((agent.contract.cooldownMs - elapsed) / 60_000);
      return { ok: false, reason: "cooldown", detail: `${agent.brain.name} is cooling down (${left}m left)` };
    }
  }
  return { ok: true };
}

/* --------------------------- agent → agent --------------------------- */

/**
 * Max delegation depth. 2 means an agent may call an agent, and that one may
 * not call further — matching the existing spawn-depth directive for subagents,
 * and keeping a runaway chain arithmetically impossible rather than merely
 * unlikely.
 */
export const MAX_AGENT_DEPTH = 2;

export type InvokeRefusal = "unknown" | "self" | "not-allowed" | "depth" | "disabled";

export type InvokeGate = { ok: true } | { ok: false; reason: InvokeRefusal; detail: string };

/**
 * May `caller` hand work to `callee`?
 *
 * `caller` is `"exo"` when a human is driving — a person may invoke any agent,
 * which is why the allowlist only binds agent-to-agent calls. Between agents
 * the allowlist is deny-by-default: an empty `can_call` means this agent
 * delegates to nobody.
 */
/** Who is calling `invoke_agent`, and how deep the delegation chain already
 *  is. Bound into each session's tool server, so concurrent runs never read
 *  each other's identity. A chat session is `EXO_CALLER`. */
export interface AgentCaller {
  slug: string;
  depth: number;
}
export const EXO_CALLER: AgentCaller = { slug: "exo", depth: 0 };

export function gateAgentInvoke(
  caller: string,
  callee: AgentDef | null,
  callerAgent: AgentDef | null,
  depth: number,
  maxDepth = MAX_AGENT_DEPTH
): InvokeGate {
  if (!callee) return { ok: false, reason: "unknown", detail: "no such agent" };
  if (caller === callee.brain.slug) {
    return { ok: false, reason: "self", detail: `${callee.brain.name} cannot invoke itself` };
  }
  if (depth >= maxDepth) {
    return { ok: false, reason: "depth", detail: `delegation depth ${maxDepth} reached` };
  }
  if (caller !== "exo") {
    if (!callerAgent) return { ok: false, reason: "unknown", detail: `unknown caller "${caller}"` };
    if (!callerAgent.contract.canCall.includes(callee.brain.slug)) {
      return {
        ok: false,
        reason: "not-allowed",
        detail: `${callerAgent.brain.name} may not invoke ${callee.brain.name} — add it to can_call`,
      };
    }
  }
  if (!callee.contract.enabled && caller !== "exo") {
    return { ok: false, reason: "disabled", detail: `${callee.brain.name} is disabled` };
  }
  return { ok: true };
}

/**
 * Whether an unattended run of this agent may write to the vault.
 *
 * Only `act` writes. `propose` runs read-only in this milestone and reports the
 * changes it would make — the inert Proposal Kernel channel is a later phase,
 * and a tier that silently wrote in the meantime would break its own promise.
 */
export function writeModeFor(autonomy: AgentAutonomy): boolean {
  return autonomy === "act";
}

/* ---------------------------- empty runs ---------------------------- */

/**
 * Sentinel a run uses to say "nothing needed doing".
 *
 * A scheduled or event-triggered agent runs far more often than it finds
 * anything, and writing a report note per run turns a quiet vault into a pile
 * of files saying "no action needed". The ledger already records that the run
 * happened; a note is only earned when there is something to read.
 *
 * Deterministic on purpose — deciding "was this report worth keeping?" from the
 * prose would be a guess, and guessing wrong either loses findings or keeps the
 * clutter.
 */
export const NOTHING_TO_REPORT = "NOTHING-TO-REPORT";

/**
 * True when a run explicitly declared it found nothing.
 *
 * Requires the sentinel to be essentially the whole reply, so an agent that
 * merely mentions the phrase while reporting real findings still gets its note.
 * If the model forgets the sentinel the run is treated as substantive — the
 * failure mode is an extra file, never a lost finding.
 */
export function isEmptyRun(output: string): boolean {
  const stripped = (output ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[^\w-]+/g, " ")
    .trim();
  return stripped === NOTHING_TO_REPORT;
}

/* ----------------------------- proposals ----------------------------- */

/** Fenced block an unattended run uses to hand structured proposals back. */
export const AGENT_PROPOSAL_FENCE = "exo-proposals";

/**
 * Pull the proposal payload out of a run's prose report.
 *
 * The kernel's own parser requires the whole string to be JSON, so a run that
 * also explains itself in English cannot be fed to it directly. The LAST fence
 * wins: if a run mentions the format earlier (quoting the instruction, showing
 * an example), the real answer is the one it finished with. Returns null when
 * there is no block, which is the normal case for a run that found nothing.
 */
export function extractProposalBlock(output: string): string | null {
  const fence = new RegExp("```" + AGENT_PROPOSAL_FENCE + "\\s*\\n([\\s\\S]*?)\\n```", "g");
  let last: string | null = null;
  for (const m of output.matchAll(fence)) last = m[1].trim();
  return last || null;
}

/**
 * The contract that turns a `propose` run's findings into kernel proposals.
 *
 * Only `propose` gets this. `notify` has nothing to propose by definition, and
 * `act` already writes — asking it for proposals too would mean the same change
 * could arrive twice, once applied and once pending.
 *
 * The vocabulary is the kernel's existing four kinds on purpose: a new "apply
 * this edit" kind would let an accepted proposal write anywhere, which is
 * exactly the power the kernel exists to withhold.
 */
export function proposalContract(memoryRootHint: string): string {
  return [
    "",
    "If anything you found should become an action, end your reply with a fenced block:",
    "",
    "```" + AGENT_PROPOSAL_FENCE,
    '[{"kind":"task","title":"…","prompt":"…","rationale":"why this is worth doing"}]',
    "```",
    "",
    "Rules for that block:",
    "- A flat JSON array. Every entry needs `kind` and `rationale`, plus the fields for its kind:",
    "  - `task` (work to run later) → `title`, `prompt`",
    "  - `loop` (an open thread to resurface) → `title`, `note` (optional `resurface` as YYYY-MM-DD, `tags`)",
    "  - `decision` (a choice worth recording) → `title`, `context`, `decision`",
    "  - `playbook` (a repeatable prompt worth saving) → `name`, `prompt`",
    "- At most 3 entries, and only things worth keeping or that a human would plausibly accept. An empty run needs no block at all.",
    "- Titles stay under 120 characters and rationales under 500. One bad entry rejects the whole block, so keep it minimal and valid.",
    "- `loop` and `decision` entries are recorded in the vault as soon as your run ends and are reviewed afterwards, so write them as final. `task` and `playbook` entries stay inert until a human accepts them. Do not propose the same thing twice.",
    `- Do not use a proposal to ask for a file edit you could describe in prose; edits stay in your report (${memoryRootHint}).`,
    "",
  ].join("\n");
}

/**
 * Whether a run takes part in the proposal channel: a `propose` tier AND the
 * proposal kernel switched on. The one rule for the whole channel, computed
 * once per run: the prompt builder appends the contract only when it holds,
 * and the executor collects the fenced block only when it holds, so a run is
 * never asked for proposals nobody will read (or read for ones never asked).
 */
export function proposeEligible(contract: Pick<AgentContract, "autonomy">, kernelEnabled: boolean): boolean {
  return contract.autonomy === "propose" && kernelEnabled;
}

/**
 * Salvage the valid entries from a block the kernel rejected wholesale.
 *
 * `parseProposalCandidates` is all-or-nothing, which is right for its own
 * producers but wrong here: observed on the first real run, an agent emitted two
 * proposals and the second was missing `rationale`, so BOTH were discarded — and
 * a discarded block is indistinguishable from a run that found nothing.
 *
 * Each entry is re-validated through the same kernel validator, one at a time,
 * so nothing bypasses validation; only the batching changes.
 */
export function salvageProposalCandidates(block: string): ProposalCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ProposalCandidate[] = [];
  for (const entry of parsed) {
    const one = parseProposalCandidates(JSON.stringify([entry]));
    if (one.status === "ok") out.push(...one.value);
  }
  return out;
}

/** What the collector below needs: somewhere to append, and somewhere to say
 *  what went wrong. Structural so core stays free of the Obsidian-side store. */
export interface RunProposalDeps {
  store: { append(candidate: ProposalCandidate, source: ProposalRecord["source"]): Promise<{ status: string }> };
  diagnostic?: (message: string, error?: unknown) => void;
}

/**
 * Turn an unattended run's fenced `exo-proposals` block into pending kernel
 * proposals. The caller decides eligibility (`proposeEligible`) and only calls
 * this for a run that was given the contract.
 *
 * Never throws: a malformed block or a failed append costs the proposals, not
 * the run that already did the work. Returns how many landed pending review.
 */
export async function collectRunProposals(
  output: string,
  source: ProposalRecord["source"],
  deps: RunProposalDeps
): Promise<number> {
  const block = extractProposalBlock(output ?? "");
  if (!block) return 0;
  const diagnose = (message: string, error?: unknown) => {
    try {
      if (deps.diagnostic) deps.diagnostic(message, error);
      else console.warn(message, error ?? "");
    } catch {
      /* diagnostics must never change the run's outcome */
    }
  };

  // Whole-block first; on rejection, salvage the valid entries. Observed on
  // the first real run: two proposals, the second missing `rationale`, and
  // all-or-nothing threw away both.
  const parsed = parseProposalCandidates(block);
  const candidates = parsed.status === "ok" ? parsed.value : salvageProposalCandidates(block);
  if (parsed.status !== "ok") {
    diagnose(
      `"${source.convoId}" proposal block partly invalid, salvaged ${candidates.length}: ${JSON.stringify(parsed.errors ?? parsed.status)}`
    );
  }

  let landed = 0;
  for (const candidate of candidates) {
    try {
      const res = await deps.store.append(candidate, source);
      if (res.status === "appended") landed++;
    } catch (err) {
      diagnose(`proposal append failed for "${source.convoId}"`, err);
    }
  }
  return landed;
}

/** Report name for a run — also the automation-run record's name, so agent
 *  runs appear in the existing review/restore queue alongside playbooks. */
export function agentRunName(agent: AgentDef, reason: string): string {
  // Event reasons carry a full vault path, which the report writer flattens into
  // an unreadable filename ("create _inboxAgenti che si chiamano tra loro.md").
  // The path is already in the ledger; the report name only needs the shape.
  const short = reason.length > 40 ? `${reason.slice(0, 37).trimEnd()}…` : reason;
  return `${agent.brain.name} (${short.replace(/\//g, " ")})`;
}

/**
 * The middle section shared by every run prompt: the task, the empty-run
 * sentinel, scope, autonomy tier, memory, and the propose/journal contracts.
 * Identical whether the model is delegating to an isolated subagent (Claude)
 * or acting as the agent directly in the current session (Codex — see
 * `buildDirectAgentRunPrompt`) — only the opening framing differs between the
 * two, so only that part is duplicated.
 *
 * A prompt-only automation runs as an inline brain with no agent file
 * (`invocable` empty): its own prompt IS the standing task, so it is stated
 * here instead of pointing at a file that does not exist.
 */
function agentRunBody(
  agent: AgentDef,
  task: { from: string; text: string } | undefined,
  memory: { path: string; excerpt: string } | undefined,
  reportsHint: string,
  propose: boolean
): (string | null)[] {
  const { brain, contract } = agent;
  return [
    task
      ? `Task from ${task.from}: ${task.text.trim()}\n\nDo that specific task, not this agent's standing job. If it turns out to be unnecessary or impossible, say so in one line and stop.`
      : brain.invocable
        ? "Standing task: do this agent's regular job as defined in its own agent file."
        : `Standing task:\n${(brain.prompt ?? "").trim()}`,
    "",
    `If nothing needs doing right now, reply with exactly \`${NOTHING_TO_REPORT}\` and nothing else — no preamble, no explanation. An empty run is a good outcome, not a failure to be filled with busywork, and that exact reply is what stops a pointless note being written to the vault.`,
    "",
    contract.scope.read.length ? `Read scope: ${contract.scope.read.join(", ")}.` : null,
    writeModeFor(contract.autonomy)
      ? contract.scope.write.length
        ? `Write scope: ${contract.scope.write.join(", ")}. Never write outside it. Every write is snapshotted and restorable.`
        : "This agent has no declared write scope, so do not write anything — report instead."
      : contract.autonomy === "propose"
        ? "Autonomy tier `propose`: this run is READ-ONLY. Describe precisely what you would change (file, and what edit) and stop. Do not write."
        : "Autonomy tier `notify`: this run is READ-ONLY. Report findings only.",
    "",
    // Memory is what makes runs compound instead of merely repeat: the agent
    // starts from what it already worked out rather than from zero every time.
    memory?.excerpt ? `What you learned in earlier runs:\n${memory.excerpt}` : null,
    memory
      ? `If this run taught you something durable — a preference, a recurring shape, a mistake worth not repeating — append ONE line to \`${memory.path}\` under "## Learnings". Nothing else goes in that file, and routine run detail does not belong there.`
      : null,
    memory ? "" : null,
    "Close with a short summary a human can scan in ten seconds.",
    propose ? proposalContract(reportsHint) : null,
    contract.output === "journal" ? journalContract() : null,
  ];
}

/**
 * The prompt an unattended run receives when the engine can delegate to an
 * isolated subagent (Claude's `Agent`/`Task` tool, which loads
 * `.claude/agents/<slug>.md` and enforces its own `tools:` scope).
 *
 * It states the trigger, the tier, and the scope, then hands off to the agent's
 * own definition — Exo never restates the agent's job, because the job lives in
 * the brain file the CLI already loads.
 */
export function buildAgentRunPrompt(
  agent: AgentDef,
  reason: string,
  memory?: { path: string; excerpt: string },
  /** A specific task, when this run was delegated rather than scheduled. */
  task?: { from: string; text: string },
  /** Where the run report lands — named so a `propose` run knows prose has a home. */
  reportsHint = "your run report",
  /** `proposeEligible` for this run: whether the proposal contract rides along. */
  propose = false
): string {
  const { brain } = agent;
  // `null` marks a line that dropped out conditionally; "" is a deliberate blank.
  const lines: (string | null)[] = [
    `<agent-run trigger="${reason}">`,
    task
      ? `This is a run of the "${brain.name}" agent, delegated by ${task.from}. No human is watching; there is nobody to ask.`
      : `This is an unattended, scheduled run of the "${brain.name}" agent. No human is watching; there is nobody to ask.`,
    // `run_in_background: false` is load-bearing: the Agent tool backgrounds by
    // default, so without it this session spawns the subagent, sees no result,
    // and cheerfully reports that the work "has started" — a run that takes 25s
    // and changes nothing.
    `Delegate the work to that subagent, and WAIT for it: Agent({ subagent_type: "${brain.invocable}", prompt: <the task below>, run_in_background: false }).`,
    "Do not report that you started it. Report what it actually did, in its words — your reply IS the record of this run, and there is no later turn in which to come back with the result.",
    "",
    ...agentRunBody(agent, task, memory, reportsHint, propose),
    "</agent-run>",
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}

/**
 * The prompt for a DIRECT run — no subagent delegation, for engines with no
 * mechanism to spawn one tied to `.claude/agents/*.md` (Codex today: its own
 * `collabAgentToolCall` is a different primitive with no notion of a named
 * persona file). The agent's own instructions ride separately as this
 * session's system prompt (`buildAgentSystemPrompt`), so this message is only
 * the task, addressed to the model as if it already IS the agent — there is no
 * "delegate to X" step because there is nothing to delegate to.
 *
 * Also the prompt of a prompt-only automation on either engine: its inline
 * brain has no agent file, so its prompt is stated as the standing task.
 */
export function buildDirectAgentRunPrompt(
  agent: AgentDef,
  reason: string,
  memory?: { path: string; excerpt: string },
  task?: { from: string; text: string },
  reportsHint = "your run report",
  /** `proposeEligible` for this run: whether the proposal contract rides along. */
  propose = false
): string {
  const { brain } = agent;
  const lines: (string | null)[] = [
    `<agent-run trigger="${reason}">`,
    task
      ? `You are the "${brain.name}" agent, running because ${task.from} asked for something specific. No human is watching; there is nobody to ask.`
      : `You are the "${brain.name}" agent, running unattended on its own schedule. No human is watching; there is nobody to ask.`,
    "",
    ...agentRunBody(agent, task, memory, reportsHint, propose),
    "</agent-run>",
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}

/**
 * The identity override for a DIRECT run or a direct interactive binding
 * (Codex): since there is no isolated subagent, "binding" means the current
 * session adopts the agent's own instructions in place of Exo's usual system
 * prompt. `body` is the agent file's markdown with its frontmatter already
 * stripped — the exact text a Claude subagent would load too, so the persona
 * itself is identical between engines even though the delivery mechanism and
 * the isolation it gets are not.
 */
export function buildAgentSystemPrompt(brain: AgentBrain, body: string): string {
  const lines: (string | null)[] = [
    `You are "${brain.name}", a named agent defined in this vault's \`.claude/agents/\` folder.`,
    brain.description ? `Remit: ${brain.description}` : null,
    "",
    "Your instructions:",
    "",
    body.trim(),
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}
