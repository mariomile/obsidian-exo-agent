/**
 * Exo settings schema: the MVASettings shape and its defaults, extracted from
 * settings.ts per its size-ratchet plan (the tab renders settings; the schema
 * IS settings). settings.ts re-exports both so external importers keep their
 * `from "./settings"` path.
 */
import type { PermissionMode, ProviderId } from "./providers/types";
import type { AutomationConfig } from "./core/automations";
import { initialDailyPulseReviewState, type DailyPulseReviewState } from "./core/daily-pulse";
import type { MemorySetup } from "./core/vault-setup";
import { exoPaths, LEGACY_MEMORY_ROOT } from "./core/paths";
import type { StoredShareRole } from "./core/collab-bridge";

/** Legacy default for the request-queue folder (kept for existing installs).
 *  Exported because the settings tab uses it as the field placeholder. */
export const LEGACY_QUEUE_FOLDER = exoPaths(LEGACY_MEMORY_ROOT).queue;

/** What Exo remembers about a note tied to an Exo Collabo document, shared
 *  from this vault or imported into it. `ownerSecret` is the promote/revoke
 *  credential and never leaves plugin data; it is empty for a document this
 *  vault only imported, since importing hands over a token, never the owner
 *  secret. `accessToken` is the scoped one used for ordinary reads and agent
 *  proposals. */
export interface CollaboShare {
  slug: string;
  ownerSecret: string;
  accessToken: string;
  role: StoredShareRole;
}

export interface MVASettings {
  provider: ProviderId;
  claudeBin: string;
  codexBin: string;
  claudeModel: string;
  codexModel: string;
  /** Extra model ids (comma/newline separated) added to the model pickers. */
  claudeCustomModels: string;
  codexCustomModels: string;
  /** Model ids left out of the composer's model picker. A hide list rather
   *  than a show list, so a model added to the catalog appears by default. */
  claudeHiddenModels: string[];
  codexHiddenModels: string[];
  effort: string;
  systemPrompt: string;
  /** User-defined prompt templates surfaced in the "/" menu. */
  customPrompts: { name: string; prompt: string }[];
  /** Internal idempotency receipts for accepted playbook proposals. */
  proposalPlaybookReceipts: Record<string, string>;
  /** What sending a message during a running turn does: "queue" waits and starts
   *  it as the next turn; "steer" injects it into the live turn. */
  steerMode: "queue" | "steer";
  /** On by default: without tools the agent can't read the vault, and a
   *  fresh install's first question about a note fails. Sensitive actions stay
   *  gated by the permission cards. */
  toolsEnabled: boolean;
  permissionMode: PermissionMode;
  autoAllowRead: boolean;
  fastStartup: boolean;
  /** Start the CLI session in the background when Exo opens, so the first
   *  message skips the cold start. */
  prewarmSession: boolean;
  /** Run Claude Code hooks (.claude/settings.json) — CC parity, on by default. */
  runHooks: boolean;
  /** `/goal` command enabled. */
  enableGoal: boolean;
  /** Per-window auto-iteration cap before `/goal` pauses to ask to continue. */
  goalMaxIterations: number;
  /** Persistent allow rules — one per line: `Tool` or `Tool(argPrefix)`. */
  permAllowRules: string;
  /** Persistent deny rules — one per line; deny wins over allow. */
  permDenyRules: string;
  /** Persist "Always allow" card choices into permAllowRules across sessions. */
  rememberAlwaysAllow: boolean;
  /** Codex sandbox + approval policy. */
  codexSandbox: string;
  codexApproval: string;
  /** Auto-compact the conversation when context fills (token saver). */
  autoCompactEnabled: boolean;
  /** Load native tool defs on-demand instead of always in context (saves tokens). */
  contextSavingMode: boolean;
  // Obsidian-native tools. All optional/toggleable.
  obsidianToolsEnabled: boolean;
  nativeFirst: boolean;
  memoryReadEnabled: boolean;
  memoryWriteEnabled: boolean;
  /** Automatic memory: after each chat goes idle Exo writes the durable facts
   *  it learned into the user's own notes (memory harvest), and before each
   *  message it recalls related notes and past chats. Default ON. Spend is
   *  bounded by `backgroundPassesEnabled` + the daily budget ledger. */
  autoMemory: boolean;
  /** The Agent Is the Folder: hydrate boot from the agent folder (SOUL/USER/NOW)
   *  and enable the governed `rethink_memory` tool.
   *  DEFAULT OFF — with it off, boot is byte-identical and the folder is never read.
   *  Natural rollout: seed the folder → review → flip this on. */
  agentFolderEnabled: boolean;
  featureSurfacing: boolean;
  featureWikilinkify: boolean;
  /** Open notes the agent edits in a tab beside the chat, live. */
  revealEditedNotes: boolean;
  /** OS notifications when a turn finishes / waits / errors while Obsidian is backgrounded. */
  systemNotifications: boolean;
  /** Set once after seeding example custom prompts, so we never re-seed. */
  seededPrompts: boolean;
  /** Refine the first-message tab title with a Haiku-generated 3-6 word title. */
  aiTitles: boolean;
  /** In-note AI: floating toolbar over a selection (format + Edit / Continue / Ask Exo). */
  inlineAi: boolean;
  /** Show the current editor selection as a click-to-attach chip in the composer. */
  showSelectionChip: boolean;
  /** Inline the body of attached notes into the outbound message instead of just
   *  their paths, so the model reads them directly instead of choosing to fetch. */
  injectContextContent: boolean;
  /** Log the assembled active-context block (chips vs what's actually serialized)
   *  to the devtools console before each turn — a diagnostic, off by default. */
  debugContext: boolean;
  /** In-document Connections: underline OUTGOING unlinked mentions (other notes'
   *  titles this note cites in plain text) so they can be linked with one click. */
  connectionsInlineUnderline: boolean;
  /** Broaden mention matching with light IT/EN stemming (plurals/inflections). */
  connectionsStemming: boolean;
  // Tab bar runtime state (not user-facing settings).
  openTabIds: string[];
  activeTabId: string;
  /** High-water mark of the conversation id counter. Persisted because the
   *  counter used to be re-derived from the ids that SURVIVED a reload, so
   *  deleting the highest-numbered chat handed its number back out. See
   *  `persistViewState`. */
  convoSeed: number;
  /** W0 background-AI master toggle: gates every background LLM pass. */
  backgroundPassesEnabled: boolean;
  /** W0 shared daily token budget for all background passes (0 = unlimited). */
  backgroundDailyTokenBudget: number;
  /** W0 model for background passes (floor Sonnet — never Haiku). */
  backgroundModel: string;
  /** W0 persisted daily budget ledger. */
  backgroundBudgetLedger: { dateUTC: string; tokensUsed: number };
  /** Typed inert proposal inbox and explicit acceptance router. */
  proposalKernelEnabled: boolean;
  /** Run the post-turn extractor after healthy turns. Off by default. */
  proposalTurnSuggestions: boolean;
  /** Exo Queue ("Exo in tasca"): il desktop evade note-richiesta scritte dal
   *  telefono in exoQueueFolder (via Obsidian Sync), headless e read-only. */
  exoQueueEnabled: boolean;
  /** Cartella della coda richieste (vault-relative). */
  exoQueueFolder: string;
  /** Root of Exo's memory layer (vault-relative). All memory paths derive from
   *  this (see core/paths.ts). Empty = unset → auto-detected at boot: an
   *  existing legacy-root vault keeps it, a fresh vault adopts the default. */
  memoryRoot: string;
  /** The onboarding memory-scaffold choice ("none" | "minimal" | "full").
   *  `undefined` = not chosen yet → the empty-state picker is offered. Recording
   *  any value (including "none") dismisses it permanently. Pre-picker installs
   *  are `undefined` but detected as already-set-up, so they never see it. */
  memorySetup?: MemorySetup;
  /** Open the Cockpit view automatically when Obsidian's layout is ready. */
  cockpitOnStartup: boolean;
  /** How the chats sidebar groups: working-set-first, or pure chronology. */
  chatsMode: import("./core/chat-rows").ChatListMode;
  /** Chats-sidebar sections collapsed, by `ChatSectionKey` — core/chat-list-state. */
  chatsCollapsed: string[];
  /** Chats-sidebar rows whose fan-out children are folded away, by CONVERSATION
   *  ID. A list of its own rather than a share of `chatsCollapsed`: the two are
   *  keyed in different namespaces — core/chat-list-state. */
  chatsCollapsedParents: string[];
  /** LEGACY scheduled playbook runs ("<Prompt name> | daily" per line) — migrated
   *  into `automations` on load, then cleared. Kept only for the migration path. */
  scheduledRuns: string;
  /** Structured automations (playbook + slot cadence + write flag) — the
   *  scheduler in main.ts and the Cockpit Automations panel read these. */
  automations: AutomationConfig[];
  /** One-shot guard for the unified automation-files migration (v2): settings
   *  playbooks + agent contract sidecars → `<memoryRoot>/automations/*.md`. */
  automationsMigrated: boolean;
  /** Load external MCP tools (Gmail/Slack/Calendar…) in headless playbook runs —
   *  Dia-style digest sources. Read-only enforced by the headless resolver
   *  (core/headless-tools.ts): read tools auto-allowed, mutations auto-denied. */
  playbookExternalTools: boolean;
  /** Set once after seeding the Morning Digest playbook, so it's never re-seeded. */
  seededDigest: boolean;
  /** One-shot migration guard for the editable/deletable Daily Pulse system config. */
  seededDailyPulse: boolean;
  /** Quiet persisted state consumed by the Phase 2 review UI and Retry action. */
  dailyPulseReviewState: DailyPulseReviewState;
  /** Learning loop: propose saving a flow as a reusable playbook when the same
   *  KIND of task (by topic) recurs (free proposal; LLM distillation only on
   *  accept). Recurrence is tracked in the memory folder's playbook-signals.json. */
  learningLoop: boolean;
  /** How many times a topic must recur before the playbook nudge fires. Default 3. */
  playbookThreshold: number;
  /** Per-playbook last-run timestamps (scheduler bookkeeping). */
  scheduledLastRun: Record<string, number>;
  /** Epoch ms of the last daily Claude-CLI update check (0 = never). */
  cliUpdateCheckAt: number;
  /** Latest published Claude CLI version seen by the update check ("" = unknown). */
  cliLatestKnown: string;
  /** Keep the Claude CLI current automatically. CLI drift is the recurring root
   *  cause of Exo "not working" (a stale binary throws error_during_execution and
   *  poisons sessions), so ON by default. Native installs self-heal via `claude
   *  update` on a daily throttle, only while no turn is streaming; npm installs
   *  fall back to a non-intrusive "update available" notice. */
  autoUpdateCli: boolean;
  /** Git auto-commit safety net: silently commit vault writes so every
   *  agent-driven mutation is recoverable via git. OFF by default — an opt-in
   *  net, not a surprise. No-op when the vault isn't a git repo. */
  vaultAutoCommit: boolean;
  /** Periodic fallback cadence (minutes) — a commit check runs at least this
   *  often even without a fresh tracked write, catching a dirty tree from
   *  drift. The debounce quiet period after a write (2 min, fixed) usually
   *  fires first. */
  vaultAutoCommitIntervalMinutes: number;
  /** Orchestration Board master flag, default OFF. Gates the `add_task` tool,
   *  the "Promote to task" command, and (future) the board view/ribbon icon —
   *  chat is unaffected either way. See docs/superpowers/specs/2026-07-08-orchestration-board-design.md.
   *  Turning this OFF never touches already-running conversations — they keep
   *  going as normal chats; it only stops new tasks from being queued/started. */
  orchestrationEnabled: boolean;
  /** Max number of Orchestration Board tasks the driver runs concurrently. */
  orchestrationMaxConcurrent: number;
  /** Soft ceiling for conversations.json, in megabytes. Exceeding it proposes a
   *  cleanup in the history — it never deletes anything on its own. */
  retentionBudgetMb: number;
  /** Soft cap on NON-pinned tabs in the chat strip. Opening one more retires the
   *  least-recently-active unpinned tab. Retiring never deletes. */
  stripMaxTabs: number;
  /** Named-agent master flag, default OFF. Gates the registry, the `@agent`
   *  binding in the composer, the `/as` command and scheduled agent runs.
   *  Discovering agents never grants them autonomy — each agent is additionally
   *  disabled in its own contract until turned on. */
  agentsEnabled: boolean;
  /** Agent browser master flag, default OFF, desktop only. Gates the eight
   *  `browser_*` tools and the exo-browser leaf's live mode. When false the
   *  session tool list is byte-identical to before the feature existed. */
  browserEnabled: boolean;
  /** Exo Collabo service base URL. Empty means the feature is off: the share
   *  and import commands hide themselves and the `collabo_*` tools are not
   *  registered, so the session tool list is byte-identical to before the
   *  feature existed. */
  collaboUrl: string;
  /** Key for document CREATION on that service (its
   *  PROOF_SHARE_MARKDOWN_API_KEY). Per-document calls use the document's own
   *  token instead, never this. */
  collaboApiKey: string;
  /** Vault-relative note path to the document it was shared as, so re-sharing
   *  the same note reconnects instead of creating a second document. */
  collaboShares: Record<string, CollaboShare>;
}

export const DEFAULT_SETTINGS: MVASettings = {
  provider: "claude",
  claudeBin: "",
  codexBin: "",
  claudeModel: "claude-fable-5-1",
  codexModel: "gpt-6-astra",
  claudeCustomModels: "",
  codexCustomModels: "",
  claudeHiddenModels: [],
  codexHiddenModels: [],
  effort: "default",
  systemPrompt: "",
  customPrompts: [],
  proposalPlaybookReceipts: {},
  steerMode: "queue",
  toolsEnabled: true,
  permissionMode: "default",
  autoAllowRead: true,
  fastStartup: true,
  prewarmSession: true,
  runHooks: true,
  enableGoal: true,
  goalMaxIterations: 10,
  permAllowRules: "",
  permDenyRules: "",
  rememberAlwaysAllow: false,
  codexSandbox: "workspace-write",
  codexApproval: "on-request",
  autoCompactEnabled: true,
  contextSavingMode: false,
  obsidianToolsEnabled: true,
  nativeFirst: false,
  memoryReadEnabled: true,
  memoryWriteEnabled: true,
  autoMemory: true,
  agentFolderEnabled: false,
  featureSurfacing: true,
  featureWikilinkify: true,
  revealEditedNotes: false,
  systemNotifications: true,
  seededPrompts: false,
  aiTitles: true,
  inlineAi: true,
  showSelectionChip: true,
  injectContextContent: false,
  debugContext: false,
  openTabIds: [],
  activeTabId: "",
  convoSeed: 0,
  backgroundPassesEnabled: true,
  backgroundDailyTokenBudget: 200000,
  backgroundModel: "claude-sonnet-5",
  backgroundBudgetLedger: { dateUTC: "", tokensUsed: 0 },
  proposalKernelEnabled: true,
  proposalTurnSuggestions: false,
  exoQueueEnabled: true,
  exoQueueFolder: LEGACY_QUEUE_FOLDER,
  memoryRoot: "",
  cockpitOnStartup: false,
  chatsMode: "activity",
  chatsCollapsed: [],
  chatsCollapsedParents: [],
  scheduledRuns: "",
  automations: [],
  automationsMigrated: false,
  playbookExternalTools: false,
  seededDigest: false,
  seededDailyPulse: false,
  dailyPulseReviewState: initialDailyPulseReviewState(),
  learningLoop: true,
  playbookThreshold: 3,
  scheduledLastRun: {},
  cliUpdateCheckAt: 0,
  cliLatestKnown: "",
  autoUpdateCli: true,
  vaultAutoCommit: false,
  vaultAutoCommitIntervalMinutes: 15,
  orchestrationEnabled: false,
  orchestrationMaxConcurrent: 2,
  retentionBudgetMb: 50,
  stripMaxTabs: 6,
  agentsEnabled: false,
  browserEnabled: false,
  connectionsInlineUnderline: true,
  connectionsStemming: true,
  collaboUrl: "",
  collaboApiKey: "",
  collaboShares: {},
};

/** Keys of settings that no longer exist (the pre-harvest memory subsystem:
 *  union store, observer, proactive recall, dream pass). `Object.assign` over
 *  DEFAULT_SETTINGS cannot drop them, so load strips them explicitly. */
const OBSOLETE_SETTING_KEYS = [
  "memoryStoreEnabled",
  "selfWritingMemory",
  "observerCadence",
  "observerStepInterval",
  "proactiveRecall",
  "proactiveRecallK",
  "dreamPassSchedule",
  "lastDreamPass",
  "dreamLlmEnabled",
  "memoryFileBudget",
  "claudememProjects",
  "appliedProposalKeys",
] as const;

/** Delete obsolete keys in place; true when anything was removed (caller saves). */
export function stripObsoleteSettings(s: object): boolean {
  const rec = s as Record<string, unknown>;
  let changed = false;
  for (const key of OBSOLETE_SETTING_KEYS) {
    if (key in rec) {
      delete rec[key];
      changed = true;
    }
  }
  return changed;
}

/**
 * Write the view's runtime state, with the one rule that cannot be left to the
 * caller: `convoSeed` is a HIGH-WATER MARK and only ever climbs.
 *
 * Conversation ids are minted `c<N>` from a counter that used to be re-seeded
 * on every load from the ids still on disk. Deleting the highest-numbered chat
 * therefore freed its number, and the next new chat was minted with a dead
 * chat's id — which four durable stores then resolved against: the settled
 * note's `exo_convo` stamp, the orchestration board's `- convo:` line,
 * `proposals.json`, and `workflow-signals.json`. The worst of them was silent:
 * a task driven by an unrelated conversation.
 *
 * Keeping the max here rather than at the call site means a caller that reads a
 * stale seed, or writes out of order, still cannot lower it.
 */
export function persistViewState(
  s: MVASettings,
  v: { openTabIds: string[]; activeTabId: string; convoSeed: number },
): void {
  s.openTabIds = v.openTabIds;
  s.activeTabId = v.activeTabId;
  s.convoSeed = Math.max(s.convoSeed ?? 0, v.convoSeed);
}
