import { Editor, FileSystemAdapter, MarkdownView, Notice, Platform, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ChatView, VIEW_TYPE, EXO_ICON } from "./view";
import { DiagLog } from "./core/diag";
import type { SessionSnapshot, SessionLane } from "./core/session-cards";
import { handoffPrefix } from "./core/handoff";
import type { ChildReport } from "./core/child-reports";
import { BOARD_VIEW_TYPE, BOARD_ICON } from "./ui/board-view";
import { createOrchestration } from "./obsidian/orchestration-wiring";
import { CockpitView, COCKPIT_VIEW_TYPE } from "./ui/cockpit-view";
import { AgentsView, AGENTS_VIEW_TYPE } from "./ui/agents-view";
import { HubView, HUB_VIEW_TYPE, type HubTab } from "./ui/hub/hub-view";
import {
  registerExoViews,
  activateView as activateChatView,
  activateBoard as activateBoardView,
  activateHub as activateHubView,
  activateConnections as activateConnectionsView,
  activateAgents as activateAgentsView,
  activateChats as activateChatsView,
} from "./ui/view-registry";
import { registerChatCommands } from "./ui/chat-commands";
import { registerFormatCommands } from "./editor/format-commands";
import { registerExoIcons } from "./ui/icons";
import { AgentPicker, PlaybookPicker } from "./ui/pickers";
import * as convoBridge from "./ui/convo-bridge";
import { DEFAULT_SETTINGS, MVASettingTab, type MVASettings } from "./settings";
import { stripObsoleteSettings } from "./settings-schema";
import { pluginMemoryCaps, registerMemory, undoMemoryWrite } from "./obsidian/memory-wiring";
import type { MemoryHarvester } from "./obsidian/memory-harvest";
import type { HarvestLog } from "./obsidian/harvest-log";
import type { MemoryCaps } from "./core/memory-caps";
import type { ChatRecord } from "./core/recent-chats";
import { ADAPTERS } from "./providers/registry";
import { resolveCli, cliDiagnostics } from "./cli";
import { runCliUpdate, maybeAutoUpdateCli } from "./cli-maintenance";
import { cliVerifyStatus, VERIFIED_CLAUDE_CLI } from "./core/semver";
import { InlineEditModal } from "./ui/inline-edit";
import type { AgentEvent } from "./providers/types";
import {
  AGENT_BLOCK_NAMES,
  buildSeedPrompt,
  parseSeedBlocks,
  manifestContent,
  isUnfilledAgentBlock,
} from "./core/agent-self";
import { scaffoldItems, parentFolder, type MemorySetup } from "./core/vault-setup";
import { detectMemoryRoot, exoPaths, LEGACY_MEMORY_ROOT, type ExoPaths } from "./core/paths";
import { resetIfNewDay, canSpend, recordSpend } from "./core/background-budget";
import { runHeadlessPlaybook, writeReport, restoreRun, type HeadlessOpts, type HeadlessResult } from "./headless";
import { automationLastRunKey, migrateScheduledRuns, pruneRuns, type AutomationConfig, type AutomationRunRecord } from "./core/automations";
import { AutomationStore, adaptAppToAutomationVault, migrateToAutomationFiles } from "./obsidian/automation-store";
import { contractFromAutomation, legacyConfigFromAutomation, type Automation } from "./core/automation-model";
import { drainExoQueue, countPendingQueue } from "./queue";
import { parseConversationsSource } from "./core/persistence";
import { sanitizeTitle, classifyTitleOutcome } from "./core/title";
import { buildEditPrompt, buildContinuePrompt } from "./core/inline-ai";
import { inlineAiExtension } from "./editor/inline-ai";
import { mentionsExtension } from "./mentions/editor";
import { selectionObserverExtension } from "./editor/selection-observer";
import { WriteQueue } from "./core/write-queue";
import { WorkflowSignalStore } from "./obsidian/workflow-signal-store";
import { registerCollaboCommands } from "./obsidian/collabo-commands";
import { startCodexBridge, type CodexBridge } from "./obsidian/codex-bridge";
import { CODEX_BRIDGE_SCRIPT } from "./obsidian/codex-bridge-script";
import { promoteToTaskCommandVisible } from "./core/tasks";
import {
  ConvoStateChannel,
  type ConvoState,
  type ConvoStateReason,
  type ConvoStateListener,
  type Unsubscribe,
} from "./core/convo-state";
import { TaskStore, adaptAppToTaskVault } from "./obsidian/task-store";
import { AgentStore, createAgentStore, readAgentBrainBody } from "./obsidian/agent-store";
import type { AgentDef } from "./core/agents";
import { AgentTriggerDriver, makeNoteReader, todayDailyNotePath } from "./obsidian/agent-triggers";
import type { ExoToolHost } from "./obsidian/tool-kit";
import { extractJournalLine, journalLine } from "./core/agent-journal";
import { agentRunId } from "./core/agent-ledger";
import {
  agentLastRunKey,
  agentRunName,
  type DueAgentRun,
  buildAgentRunPrompt,
  buildDirectAgentRunPrompt,
  buildAgentSystemPrompt,
  collectRunProposals,
  dueScheduledAgentRuns,
  isEmptyRun,
  gateAgentInvoke,
  gateAgentRun,
  EXO_CALLER,
  type AgentCaller,
  type RunGate,
  proposeEligible,
  scheduleSlotKeys,
  writeModeFor,
} from "./core/agent-runs";
import { makeTolerantSetMaxListeners, isTolerantShim } from "./core/node-interop";
import {
  ProposalStore,
  type PendingProposals,
  type ProposalAcceptResult,
} from "./obsidian/proposal-store";
import { routeAcceptedProposal, type ProposalAcceptanceDeps } from "./obsidian/proposal-router";
import {
  createProposalAcceptanceDeps,
  type ProposalTargetVaultAdapter,
} from "./obsidian/proposal-targets";
import { parseLoopsFile } from "./core/open-loops";
import {
  DailyPulseSlotRunner,
  dailyPulseReviewAfterRun,
  isDailyPulseAutomation,
  seedDailyPulseAutomation,
} from "./core/daily-pulse";
import {
  generateAndWriteDailyPulse,
  type DailyPulseCollectionWarning,
} from "./obsidian/daily-pulse";
import {
  produceTurnProposals,
  type ProposalProducerResult,
  type ProposalTurnInput,
} from "./obsidian/proposal-producer";
import {
  buildFoundryDistillPrompt,
  parseFoundryDistillation,
} from "./core/foundry-distill";
import { ProposalsModal } from "./ui/proposals-modal";
import {
  readSessionCapsCache,
  removeSessionCapsCache,
  stripLegacyCachedSessionCaps,
  writeSessionCapsCache,
} from "./session-caps-cache";
import { checkGitRepo, gitRunner, isWorktreeDirty, runGitCommit } from "./obsidian/git";
import {
  initialAutoCommitState,
  recordVaultWrite,
  isCommitDue,
  shouldCommitNow,
  afterCommitCheck,
  formatCommitMessage,
  type AutoCommitState,
} from "./core/git-autocommit";
import {
  SENTINEL_AGENT,
  SENTINEL_REL_PATH,
  normalizeSentinelPaths,
  sentinelRecordArgs,
} from "./core/write-sentinel";

const execFileAsync = promisify(execFile);

/** Snapshot-size cap per file in a persisted automation-run record (same bloat
 *  guard as the chat's MAX_CHECKPOINT_FILE — oversized edits aren't restorable). */
const MAX_AUTOMATION_SNAPSHOT = 64_000;

/** Seeded "Morning Digest" playbook — Dia-style: vault + connected external
 *  tools (MCP, read-only). Sources degrade gracefully; the wording keeps the
 *  report short and phone-readable. Editable like any custom prompt. */
const morningDigestPrompt = (paths: ExoPaths): string => `Sei il mio chief of staff. Prepara il MORNING DIGEST di oggi, in italiano, leggibile da telefono: righe corte, liste, niente tabelle. Massimo ~60 righe.

Raccogli dalle fonti in quest'ordine. Se una fonte non è disponibile (tool assente o permesso negato), scrivi "— non disponibile" nella sua sezione e prosegui senza fermarti.

IMPORTANTE: non scrivere NULLA prima del digest — niente premesse, niente narrazione del processo. La tua risposta deve iniziare esattamente con "# ☀️ Morning Digest". Eventuali caveat sulle fonti vanno solo nella riga "Stato fonti" in fondo.

1. VAULT — leggi: ${paths.openLoops} (loop attivi e scaduti), ${paths.tasks} (task running / needs-input / review), conteggio note in _inbox/, la daily note di ieri e di oggi in Journal/Daily/ se esistono.
2. CALENDAR — con i tool MCP di Google Calendar: gli eventi di oggi, con orari.
3. GMAIL — con i tool MCP di Gmail: cerca i thread NON letti o importanti delle ultime 24 ore; riporta al massimo 5: mittente — oggetto — perché conta in una riga.
4. SLACK — con i tool MCP di Slack: mention e messaggi rilevanti delle ultime 24 ore; al massimo 5 conversazioni: canale — sintesi in una riga.
5. LETTURE — con il tool MCP di Readwise (search): 2-3 highlight recenti se disponibili.

Poi scrivi il digest ESATTAMENTE in questo formato:

# ☀️ Morning Digest

## 🎯 Oggi
(agenda essenziale + le 3 priorità che proponi tu, ognuna con un perché di una riga)

## ✅ Da fare
(loop scaduti, task fermi in needs-input/review, "N note in inbox da processare" se >0)

## 📧 Mail da guardare

## 💬 Slack da considerare

## 📚 Letture

---
Stato fonti: (una riga: quali fonti hai letto e quali erano non disponibili)`;

/** Typed, quiet outcome of a Workflow Foundry playbook distillation attempt. */
export type WorkflowDistillOutcome =
  | { status: "skipped"; reason: "kernel_disabled" | "background_disabled" | "budget_denied" | "in_flight" }
  | { status: "appended"; proposalId: string }
  | { status: "duplicate" }
  | { status: "failed"; reason: "empty_output" | "invalid_output" | "utility_error" | "store_error" };

export default class ExoPlugin extends Plugin implements ExoToolHost {
  settings!: MVASettings;

  /** Turn-lifecycle diagnostics ring buffer (see core/diag.ts). The view logs
   *  the critical path into it; "Copy diagnostics" pastes it for bug reports. */
  readonly diag = new DiagLog();

  /** Latest capability snapshot from any session's system/init (pushed by the
   *  view) — lets settings show live per-server MCP status. Best-effort: null
   *  until a session has spawned this app run. */
  lastSessionCaps: import("./providers/types").SessionCaps | null = null;

  /** Codex ↔ Obsidian tool bridges, isolated per session and stopped on unload. */
  private codexBridges = new Set<CodexBridge>();
  private codexBridgeScriptPath: string | null = null;

  /** One-time guard for the codex-bridge node preflight Notice. */
  private nodeWarned = false;
  /** Deferred boot maintenance must never outlive a hot unload/reload. */
  /** Handles for idle-scheduled startup chores (requestIdleCallback ids or
   *  setTimeout ids); cancelled on unload. */
  private startupIdleHandles: number[] = [];
  /** Public so the extracted CLI-maintenance functions can bail after unload. */
  unloaded = false;

  /** Latest native plan/account quota snapshot (pushed by the chat view) — the
   *  Cockpit renders it in the System tile. Null until a provider reports. */
  lastRateLimit: import("./providers/types").RateLimitInfo | null = null;

  /**
   * THE ONE shared write path for Exo's own memory writes into vault notes: the
   * agent-folder blocks (`rethink_memory`) and memory harvest. Plugin-scoped so
   * every writer enqueues on the SAME FIFO and never interleaves a
   * read-modify-write cycle on the same note (w1-1 contract).
   */
  readonly memoryWriteQueue = new WriteQueue();
  /** Automatic memory: the harvester and its record of recent harvests
   *  (built in onload by `registerMemory`, obsidian/memory-wiring). */
  memoryHarvest!: MemoryHarvester;
  harvestLog!: HarvestLog;
  /** One shared write path for the open-loops ledger (`paths.openLoops`) across every
   *  Claude/Codex conversation. Each session gets a fresh tool registry, so a
   *  queue created inside that registry cannot prevent lost updates. */
  readonly loopsWriteQueue = new WriteQueue();
  /** Serialize temp/backup rotation for conversation history. Multiple views and
   *  rapid UI updates may call saveConversations concurrently; sharing the same
   *  .tmp path without a queue can regress or temporarily remove the main file. */
  private readonly conversationWriteQueue = new WriteQueue();
  /** Settings share one JSON file; serialize snapshots so background update
   *  checks and interactive settings changes cannot race saveData(). */
  private readonly settingsWriteQueue = new WriteQueue();
  private readonly sessionCapsWriteQueue = new WriteQueue();
  /**
   * THE ONE shared write path for every append to the Orchestration Board
   * tasks ledger (`paths.tasks`). Both the `add_task` SDK
   * tool (chat-driven) and the "Promote to task" command enqueue on this SAME
   * queue — same contract as `memoryWriteQueue` above — so board and
   * chat-driven task creation never interleave a read-modify-write cycle.
   * Injected into `createObsidianToolServer` (src/view.ts) and used directly
   * by `ChatView.cmdPromoteToTask`.
   */
  readonly tasksWriteQueue = new WriteQueue();
  /** Single mutation boundary for the plugin-dir proposal inbox. */
  private readonly proposalWriteQueue = new WriteQueue();
  /** Settings mutation + persistence boundary for accepted playbooks. */
  private readonly proposalPlaybookWriteQueue = new WriteQueue();
  /** One serialized read-modify-write boundary for the review note (`paths.review`). */
  private readonly dailyPulseWriteQueue = new WriteQueue();
  /** Serialized privacy-safe Workflow Foundry signal ledger. */
  private readonly workflowSignalWriteQueue = new WriteQueue();
  /** Serialize collection, review-note write and settings persistence as one operation. */
  private readonly dailyPulseOperationQueue = new WriteQueue();
  private readonly dailyPulseSlotRunner = new DailyPulseSlotRunner();
  /**
   * THE ONE shared `TaskStore` instance — the typed load/create/update/move/
   * archive API over the same ledger (`paths.tasks`),
   * built on `tasksWriteQueue` above so it can never race a caller still
   * using the lower-level `createBacklogTask` directly. Constructed in
   * `onload()` (needs `this.app`); the future board view/driver should read
   * and mutate tasks ONLY through this instance.
   */
  taskStore!: TaskStore;
  /** Serialized writes to the agent contract sidecars (`paths.agents`). */
  private readonly agentWriteQueue = new WriteQueue();
  private readonly automationRunsWriteQueue = new WriteQueue();
  /**
   * THE ONE agent registry — loads canonical vault bundles plus external runtime
   * agents. Constructed in `onload()`; refreshed lazily via
   * `agentsReady()` so a disabled feature costs nothing at boot.
   */
  agentStore!: AgentStore;
  /** Unified automations — one readable file per automation under
   *  `<memoryRoot>/automations/`. Loaded at layout-ready; watched thereafter. */
  automationStore!: AutomationStore;
  private agentRefresh: Promise<void> | null = null;
  /** Event-driven agent triggers. Disarmed until layout-ready. */
  private agentTriggers: AgentTriggerDriver | null = null;
  proposalStore!: ProposalStore;
  workflowSignalStore!: WorkflowSignalStore;
  private proposalAcceptanceDeps!: ProposalAcceptanceDeps;
  private readonly proposalRouteErrors = new Map<string, string>();
  private readonly proposalAbort = new AbortController();
  /** Signatures whose distillation is in flight; guards the record→append window. */
  private readonly distillingSignatures = new Set<string>();
  private static readonly PROPOSAL_TOKEN_ESTIMATE = 2500;

  /**
   * THE ONE plugin-level convo-state notification channel — how ChatView tells
   * the (optional) Orchestration Board how each conversation's turn lifecycle is
   * moving (turn-start / turn-end / needs-input / stopped / error). Synchronous,
   * in-memory, one-way (board observes; chat never depends on it). Guarded on
   * `orchestrationEnabled`: a strict no-op when the flag is off, so chat runtime
   * behavior is identical to a build without the board. See
   * src/core/convo-state.ts and the isolation contract in
   * docs/superpowers/specs/2026-07-08-orchestration-board-design.md.
   */
  readonly convoState = new ConvoStateChannel(() => this.settings.orchestrationEnabled);

  /** THE orchestration runtime — driver + ledger watch, owned by the PLUGIN so
   *  delegated tasks run with every tab closed. The board renders it; it used to
   *  own it, which made `spawn_task` a no-op whenever that tab wasn't open. */
  readonly orchestration = createOrchestration(this);

  /** Ribbon-icon handle for the Orchestration Board — created only while
   *  `orchestrationEnabled` is on, removed when it's toggled off, so the entry
   *  point disappears entirely (not just disabled) on hot-disable. */
  private boardRibbonEl: HTMLElement | null = null;
  /** Last-applied orchestration flag, so `saveSettings` can detect a toggle and
   *  re-sync entry points + tear down the board on disable. */
  private orchestrationApplied = false;

  /** Stable identity for this plugin instance in the cross-session write
   *  sentinel. Per-load, so a reload starts a fresh logical session and two
   *  Obsidian windows on one vault register as distinct writers. */
  private readonly writeSentinelSessionId = `${process.pid}-${Date.now().toString(36)}`;

  /** Git auto-commit safety net — debounce/cadence bookkeeping (in-memory
   *  only; resets on reload, which is fine, it's just scheduling state). */
  private gitAutoCommitState: AutoCommitState = initialAutoCommitState();
  /** Vault-relative paths written by Exo and eligible for the next commit.
   *  Versions prevent a commit finishing in the background from clearing a
   *  newer write to the same path. Never stage unrelated worktree changes. */
  private readonly gitAutoCommitPaths = new Map<string, number>();
  /** Fires at most once per session — repeated failures log to console but
   *  never spam the user with Notices. */
  private gitAutoCommitNoticeShown = false;
  /** Quiet period after a tracked write before a commit check runs (fixed —
   *  keeping this predictable rather than another setting to tune). */
  private static readonly AUTO_COMMIT_DEBOUNCE_MS = 2 * 60 * 1000;
  /** How often the periodic checker ticks. Actual git calls only run when
   *  `isCommitDue` says a debounce or cadence window has elapsed, so most
   *  ticks are a free no-op. Kept at 60s (not lower): the shortest real
   *  commit latency is the 2-min debounce quiet period, so a 60s sampling
   *  interval detects it with negligible lag while cutting idle wake-ups 3×. */
  private static readonly AUTO_COMMIT_CHECK_INTERVAL_MS = 60 * 1000;

  async onload(): Promise<void> {
    this.unloaded = false;
    // Electron-renderer interop, BEFORE anything can spawn a session: the Agent
    // SDK hands its (DOM-realm) AbortSignals to Node's events.setMaxListeners,
    // which throws ERR_INVALID_ARG_TYPE in Obsidian's renderer and kills every
    // Claude session at query() setup (first hit: a background utility pass, 2026-07-06, but it
    // breaks chat and headless identically). Mutating the module object is what
    // makes the bundled SDK see the shim (esbuild namespace getters are live).
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- must mutate the live CJS module object, which an ES import binding cannot
    const nodeEvents = require("node:events") as { setMaxListeners: (n?: number, ...t: unknown[]) => void };
    if (!isTolerantShim(nodeEvents.setMaxListeners)) {
      nodeEvents.setMaxListeners = makeTolerantSetMaxListeners(nodeEvents.setMaxListeners.bind(nodeEvents));
    }

    await this.loadSettings();
    // Seed the capability snapshot from the last app run, so menus and panels
    // are rich before the first session's init arrives (refreshed on every init).
    // Own file (session-caps-cache.json), not settings — see saveSessionCapsCache.
    this.lastSessionCaps = await this.loadSessionCapsCache();

    // ONE shared TaskStore for the whole plugin — built on `tasksWriteQueue` so
    // it can never race the lower-level `createBacklogTask` call in
    // `src/view.ts`/`src/obsidian/tools.ts`, which enqueues on the same queue.
    this.taskStore = new TaskStore(adaptAppToTaskVault(this.app), this.tasksWriteQueue, this.paths.tasks);
    this.agentStore = createAgentStore(
      this.app,
      this.paths,
      this.agentWriteQueue,
      () => this.lastSessionCaps?.agents ?? []
    );
    this.automationStore = new AutomationStore(adaptAppToAutomationVault(this.app), this.paths);

    const proposalRoot = this.manifest.dir;
    const adapter = this.app.vault.adapter;
    this.proposalStore = new ProposalStore({
      read: async (relativePath) => {
        const path = `${proposalRoot}/${relativePath}`;
        return await adapter.exists(path) ? adapter.read(path) : null;
      },
      write: (relativePath, content) => adapter.write(`${proposalRoot}/${relativePath}`, content),
    }, this.proposalWriteQueue);
    const workflowSignalsPath = this.paths.workflowSignals;
    const memoryDir = this.paths.memory;
    this.workflowSignalStore = new WorkflowSignalStore({
      read: async () => await adapter.exists(workflowSignalsPath)
        ? adapter.read(workflowSignalsPath)
        : null,
      write: async (content) => {
        if (!(await adapter.exists(memoryDir))) {
          try {
            await adapter.mkdir(memoryDir);
          } catch (error) {
            if (!(await adapter.exists(memoryDir))) throw error;
          }
        }
        await adapter.write(workflowSignalsPath, content);
      },
    }, this.workflowSignalWriteQueue);
    const targetVault: ProposalTargetVaultAdapter = {
      getFile: (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile ? file : null;
      },
      read: (path) => adapter.read(path),
      create: async (path, content) => {
        await this.app.vault.create(path, content);
      },
      modify: async (path, content) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error(`File not found: ${path}`);
        await this.app.vault.modify(file, content);
      },
      ensureFolder: (path) => this.ensureParentFolders(path),
    };
    this.proposalAcceptanceDeps = createProposalAcceptanceDeps({
      tasks: this.taskStore,
      vault: targetVault,
      loopsWriteQueue: this.loopsWriteQueue,
      playbooksWriteQueue: this.proposalPlaybookWriteQueue,
      playbooks: {
        settings: () => this.settings,
        saveSettings: () => this.saveSettings(),
      },
      openLoopsPath: this.paths.openLoops,
      decisionsDir: this.paths.decisions,
    });

    registerMemory(this);
    registerExoIcons();
    registerExoViews(this);

    // In-note AI: a floating toolbar over the selection (Edit / Continue / Ask
    // Exo). Registered once; gated live behind the `inlineAi` setting, so
    // toggling it off makes the extension inert without a reload.
    this.registerEditorExtension(inlineAiExtension(this));

    // Selection observer: reports the active editor's selection to the composer
    // so it shows an ambient "Selection" chip. Registered once; gated live
    // behind `showSelectionChip`, so toggling it off makes it inert.
    this.registerEditorExtension(selectionObserverExtension(this));

    // In-document Connections: underline outgoing unlinked mentions + a
    // bottom suggested-links block. Registered once; both surfaces are gated
    // live behind settings (default off) so the extension is inert until
    // enabled — no reload needed to toggle.
    this.registerEditorExtension(mentionsExtension(this));

    this.addRibbonIcon(EXO_ICON, "Open Exo", () => this.activateView());
    // Cockpit + Connections are reached from the Exo header's Apps menu, not a
    // global ribbon icon (Mario: "solo in Exo"). Commands stay for the palette.

    this.addCommand({
      id: "review-connections",
      name: "Review connections of the active note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) {
          void this.askExo(
            `Review the connections of [[${file.path}]]: call get_connections, judge which unlinked mentions are real references (vs coincidental strings), and propose which to link with link_mentions or dismiss with ignore_mention. Show me your reasoning before acting.`,
            true,
            { source: "review-connections" },
          );
        }
        return true;
      },
    });

    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "open-connections",
      name: "Open Connections",
      callback: () => void this.activateConnections(),
    });

    // Paste-ready turn-lifecycle diagnostics (names/kinds/counts only — never
    // vault content). The first thing to ask for when "Exo si è bloccato".
    this.addCommand({
      id: "copy-diagnostics",
      name: "Copy diagnostics",
      callback: () => {
        const report = this.diag.dump({
          version: this.manifest.version,
          platform: process.platform,
          generated: new Date().toISOString(),
        });
        void navigator.clipboard.writeText(report);
        new Notice("Exo — diagnostics copied to clipboard");
      },
    });

    // One-click CLI update, discoverable from the palette (the settings pane
    // has its own button, but nobody should have to dig for it).
    this.addCommand({
      id: "update-claude-cli",
      name: "Update Claude CLI",
      callback: () => void runCliUpdate(this),
    });

    const withView = (fn: (v: ChatView) => void) => () => {
      const view = convoBridge.chatView(this.app);
      if (view) fn(view); else void this.activateView();
    };
    this.addCommand({ id: "new-tab", name: "New tab", callback: withView((v) => v.cmdNewTab()) });
    this.addCommand({
      id: "new-session",
      name: "New session (clear current tab)",
      callback: withView((v) => v.cmdNewSession()),
    });
    // One entry, named for the guarantee: closing a tab retires it (it keeps
    // everything and comes back from the history), so "Close" was understating
    // and a second "Retire" entry would be a duplicate the user could bind to a
    // different hotkey. The id stays `close-tab` — Obsidian stores hotkeys by
    // id, so renaming it would silently drop any binding already in use.
    this.addCommand({
      id: "close-tab",
      name: "Retire current tab (keeps it in history)",
      callback: withView((v) => v.cmdCloseTab()),
    });
    this.addCommand({
      id: "fork-conversation",
      name: "Fork conversation into new tab",
      callback: withView((v) => v.cmdForkConversation()),
    });
    // Strip navigation. No `hotkeys:` on any of them: this plugin already
    // registers ~27 commands and Obsidian ships its own bindings, so assigning
    // defaults here is asking for a conflict the user did not choose. They bind
    // what they use.
    this.addCommand({ id: "next-tab", name: "Next tab", callback: withView((v) => v.cmdCycleTab(1)) });
    this.addCommand({ id: "prev-tab", name: "Previous tab", callback: withView((v) => v.cmdCycleTab(-1)) });
    this.addCommand({
      id: "toggle-pin-tab",
      name: "Pin or unpin current tab",
      callback: withView((v) => v.cmdTogglePin()),
    });
    this.addCommand({
      id: "compact",
      name: "Compact conversation (free up context)",
      callback: withView((v) => v.cmdCompact()),
    });
    this.addCommand({
      id: "toggle-plan",
      name: "Toggle plan mode",
      callback: withView((v) => v.cmdTogglePlan()),
    });

    // Orchestration Board — flag-gated the same way the setting says: OFF by
    // default, and invisible (not just disabled) in the command palette when
    // off, via checkCallback returning false. Never touches chat when off.
    this.addCommand({
      id: "promote-to-task",
      name: "Promote to task (add to Orchestration Board backlog)",
      checkCallback: (checking) => {
        if (!promoteToTaskCommandVisible(this.settings)) return false;
        if (!checking) withView((v) => void v.cmdPromoteToTask())();
        return true;
      },
    });

    // Orchestration Board open command — invisible in the palette when the flag
    // is off (checkCallback returns false), mirroring "Promote to task".
    this.addCommand({
      id: "open-orchestration-board",
      name: "Open orchestration board",
      checkCallback: (checking) => {
        if (!this.settings.orchestrationEnabled) return false;
        if (!checking) void this.activateBoard();
        return true;
      },
    });

    // Ribbon icon (added/removed on flag toggle). Establishes the baseline for
    // the current flag state so a later toggle in settings re-syncs correctly.
    this.orchestrationApplied = this.settings.orchestrationEnabled;
    this.syncBoardRibbon();

    this.addCommand({
      id: "open-cockpit",
      name: "Open Cockpit",
      callback: () => void this.openCockpit(),
    });
    registerChatCommands(this);
    registerFormatCommands(this);
    this.addCommand({
      id: "open-proposals",
      name: "Review suggestions",
      checkCallback: (checking) => {
        if (!this.settings.proposalKernelEnabled) return false;
        if (!checking) void this.openProposalsModal();
        return true;
      },
    });
    this.app.workspace.onLayoutReady(() => {
      if (this.unloaded) return;
      // Orchestration starts HERE, not earlier: before layout-ready a spawn
      // would race Obsidian's own workspace restore for the sidebar leaf.
      this.orchestration.sync();
      if (this.settings.cockpitOnStartup && this.app.workspace.getLeavesOfType(COCKPIT_VIEW_TYPE).length === 0) {
        void this.openCockpit();
      }
      this.scheduleStartupMaintenance();
    });

    this.addCommand({
      id: "inline-edit",
      name: "Inline edit selection",
      editorCallback: (editor: Editor, ctx) => {
        if (!(ctx instanceof MarkdownView)) return;
        this.inlineEdit(editor);
      },
    });

    this.addCommand({
      id: "seed-agent-folder",
      name: "Seed agent folder",
      // Visible whenever vault-memory writes are allowed. Seeding is safe with the
      // agent-folder flag OFF (boot ignores the folder until it's flipped on) — it
      // IS the natural rollout: seed → review USER.md → enable the flag.
      checkCallback: (checking: boolean) => {
        if (!this.memoryCaps().ledgerWrite) return false;
        if (!checking) void this.seedAgentFolder();
        return true;
      },
    });

    this.addCommand({
      id: "setup-vault-memory",
      name: "Set up vault memory",
      // Same gate as seed-agent-folder: pointless (and confusing) to offer
      // scaffolding when the user has turned vault-memory writes off.
      checkCallback: (checking: boolean) => {
        if (!this.memoryCaps().ledgerWrite) return false;
        // The explicit command scaffolds the complete layer; the empty-state
        // picker is where "minimal" vs "full" is chosen.
        if (!checking) void this.applyMemorySetup("full");
        return true;
      },
    });

    this.addCommand({
      id: "run-playbook",
      name: "Run playbook now (headless, read-only)",
      callback: () => {
        const prompts = this.settings.customPrompts;
        if (!prompts.length) {
          new Notice("No custom prompts yet — add some in Exo settings.");
          return;
        }
        new PlaybookPicker(this.app, prompts, (p) => void this.runPlaybook(p.name, p.prompt), this.paths.reports).open();
      },
    });
    this.addCommand({
      id: "automations",
      name: "Automations…",
      callback: () => void this.activateHub("automations"),
    });
    this.addCommand({
      id: "open-agents",
      name: "Open Agents",
      checkCallback: (checking) => {
        if (!this.settings.agentsEnabled) return false;
        if (!checking) void this.activateAgents();
        return true;
      },
    });
    this.addCommand({
      id: "run-agent",
      name: "Run agent…",
      checkCallback: (checking) => {
        if (!this.settings.agentsEnabled) return false;
        if (!checking) void this.promptRunAgent();
        return true;
      },
    });
    this.addCommand({
      id: "open-daily-pulse",
      name: "Open Daily Pulse",
      callback: () => void this.openDailyPulse(),
    });
    this.registerObsidianProtocolHandler("exo-daily-pulse", (params) => {
      void this.openDailyPulseTarget(params);
    });
    this.registerInterval(window.setInterval(() => void this.checkScheduledRuns(), 30 * 60 * 1000));
    void this.checkScheduledRuns();
    this.setupAgentTriggers();

    this.addCommand({
      id: "queue-drain",
      name: "Drain Queue now",
      callback: () => {
        if (!this.settings.exoQueueEnabled) {
          new Notice("Exo Queue is off — enable it in settings.");
          return;
        }
        new Notice("Draining Exo Queue…");
        void this.maybeDrainExoQueue();
      },
    });
    this.addCommand({
      id: "queue-new-request",
      name: "New Queue request",
      callback: () => void this.createQueueRequest(),
    });
    registerCollaboCommands(this);

    // Exo Queue ("Exo in tasca"): evade le note-richiesta arrivate via Sync.
    // Poll leggero ogni 5 min (list di una cartella); drain sequenziale con
    // flag busy — mai due giri concorrenti (una richiesta può durare minuti).
    // È un canale background: 5 min di latenza sono accettabili e il tick più
    // raro riduce le wake-up in idle (prima era 60s → 300s).
    this.registerInterval(window.setInterval(() => void this.maybeDrainExoQueue(), 5 * 60 * 1000));

    // Git auto-commit safety net: ticks frequently, but only ever runs git
    // commands once the pure debounce/cadence decision says a check is due —
    // no-op (and silent) whenever the setting is off, the vault isn't a git
    // repo, or the worktree is clean. See core/git-autocommit.ts.
    this.registerInterval(
      window.setInterval(() => void this.maybeAutoCommit(), ExoPlugin.AUTO_COMMIT_CHECK_INTERVAL_MS)
    );

    // Re-check CLI currency daily, not only at boot: a long-lived Obsidian
    // session (days/weeks without a restart) would otherwise never re-run the
    // startup check and silently drift onto a stale, session-poisoning binary.
    this.registerInterval(
      window.setInterval(() => void maybeAutoUpdateCli(this), 24 * 60 * 60 * 1000)
    );

    this.addSettingTab(new MVASettingTab(this.app, this));

  }

  /** Keep process spawning and the registry request off Obsidian's critical
   *  startup path. Both chores are latency-insensitive (the CLI verify is a
   *  child_process spawn; the update check is a daily-throttled network call),
   *  so run them when the main thread is actually idle instead of at a fixed
   *  +2s that collides with every other plugin's boot work. The update check
   *  is pushed out further still — nothing depends on its freshness. Callbacks
   *  are cancelled on hot unload and no-op via the `unloaded` guard. */
  private scheduleStartupMaintenance(): void {
    if (this.unloaded) return;
    this.runWhenIdle(() => void this.checkCliVerified(), 5_000);
    this.runWhenIdle(() => void maybeAutoUpdateCli(this), 30_000);
  }

  /** Run `cb` on the next idle slot (or after `timeout` ms, whichever first),
   *  tracking the handle so onunload can cancel it. Falls back to setTimeout
   *  where requestIdleCallback is unavailable. */
  private runWhenIdle(cb: () => void, timeout: number): void {
    const guarded = () => {
      if (!this.unloaded) cb();
    };
    const ric = (window as unknown as {
      requestIdleCallback?: (c: () => void, o?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (typeof ric === "function") {
      this.startupIdleHandles.push(ric(guarded, { timeout }));
    } else {
      this.startupIdleHandles.push(window.setTimeout(guarded, timeout));
    }
  }

  /** One-shot (per CLI version) drift notice: probe `claude --version` and warn
   *  when it falls outside {@link VERIFIED_CLAUDE_CLI}. The "already noticed"
   *  marker lives in Obsidian localStorage (not settings/data.json) so it never
   *  collides with settings writes and never syncs across devices. Best-effort:
   *  a failed probe is silent ("unknown" never nags). */
  private async checkCliVerified(): Promise<void> {
    try {
      const d = await cliDiagnostics("claude", this.settings.claudeBin);
      const status = cliVerifyStatus(d.version, VERIFIED_CLAUDE_CLI);
      if (status === "verified" || status === "unknown") return;
      const KEY = "exo-cli-verify-noticed";
      if (this.app.loadLocalStorage(KEY) === d.version) return; // told once already
      this.app.saveLocalStorage(KEY, d.version);
      this.diag.push("cli", `version ${d.version} ${status} (verified ${VERIFIED_CLAUDE_CLI.min}–${VERIFIED_CLAUDE_CLI.maxVerified})`);
      new Notice(
        status === "newer"
          ? `Exo — Claude CLI ${d.version} is newer than the verified range (≤ v${VERIFIED_CLAUDE_CLI.maxVerified}). If turns misbehave, run "Copy diagnostics" and check for an Exo update.`
          : `Exo — Claude CLI ${d.version} is older than the minimum verified v${VERIFIED_CLAUDE_CLI.min}. Please update the CLI.`,
        10000
      );
    } catch {
      /* best-effort — never block or noise the boot */
    }
  }

  async activateView(): Promise<void> {
    await activateChatView(this);
  }

  async activateBoard(): Promise<void> {
    await activateBoardView(this);
  }

  async activateHub(tab?: HubTab): Promise<void> {
    await activateHubView(this, tab);
  }

  async activateConnections(): Promise<void> {
    await activateConnectionsView(this);
  }

  async activateAgents(): Promise<void> {
    await activateAgentsView(this);
  }

  async activateChats(): Promise<void> {
    await activateChatsView(this);
  }

  async openCockpit(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(COCKPIT_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: COCKPIT_VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  /** Add or remove the board ribbon icon so it matches the flag exactly. */
  private syncBoardRibbon(): void {
    if (this.settings.orchestrationEnabled) {
      this.boardRibbonEl ??= this.addRibbonIcon(BOARD_ICON, "Open orchestration board", () => void this.activateBoard());
    } else if (this.boardRibbonEl) {
      this.boardRibbonEl.remove();
      this.boardRibbonEl = null;
    }
  }

  /**
   * React to an `orchestrationEnabled` toggle (called from `saveSettings`), with
   * no reload: `orchestration.sync()` starts or stops the runtime, the ribbon
   * and the palette command follow the flag, and a hot-disable also detaches any
   * open board leaf. Running conversations survive as normal chats; no markdown
   * is touched either way.
   */
  private applyOrchestrationToggle(): void {
    const now = this.settings.orchestrationEnabled;
    if (now === this.orchestrationApplied) return;
    this.orchestrationApplied = now;
    this.syncBoardRibbon();
    this.orchestration.sync();
    if (!now) for (const leaf of this.app.workspace.getLeavesOfType(BOARD_VIEW_TYPE)) leaf.detach();
  }

  /**
   * Public cross-plugin entry point: reveal Exo and start a new default-model
   * chat seeded with `query` (sent immediately unless `autoSend` is false).
   * Consumed by sibling plugins — e.g. Sonar's "Search with Exo" row — so they
   * don't have to reach into ChatView internals. Safe to call before the view
   * exists; it's created on demand. `opts.source` declares where the query came
   * from (e.g. "sonar-intent") and maps to a hidden steering directive.
   */
  async askExo(query: string, autoSend = true, opts?: { source?: string }): Promise<void> {
    await this.activateView();
    convoBridge.chatView(this.app)?.askInNewConversation(query, autoSend, { sendPrefix: handoffPrefix(opts?.source), reuseUntouched: true });
  }

  private vaultPath(): string {
    const a = this.app.vault.adapter;
    return a instanceof FileSystemAdapter ? a.getBasePath() : ".";
  }

  /**
   * Git auto-commit safety net — record that a turn wrote `fileCount` file(s).
   * Called from ChatView at turn end (any turn that touched the write-tool
   * set), regardless of whether the turn succeeded, errored, or was stopped.
   *
   * Purely bookkeeping: synchronous, in-memory, no I/O — so this can never
   * slow down or block a chat turn. The actual `git add`/`git commit` (if
   * ever due) happens later, off a periodic timer (`maybeAutoCommit`), fully
   * decoupled from any turn. No-ops entirely when the setting is off.
   */
  noteVaultWrite(paths: readonly string[]): void {
    const normalized = normalizeSentinelPaths(paths, this.vaultPath());
    if (!normalized.length) return;

    // Cross-session visibility is independent of auto-commit: even with the
    // safety net off, another session writing the same file is worth recording.
    this.recordToWriteSentinel(normalized);

    if (!this.settings.vaultAutoCommit) return;
    for (const path of normalized) this.gitAutoCommitPaths.set(path, (this.gitAutoCommitPaths.get(path) ?? 0) + 1);
    this.gitAutoCommitState = recordVaultWrite(this.gitAutoCommitState, Date.now(), normalized.length);
  }

  /**
   * Publish this turn's writes to the machine-local write sentinel so parallel
   * sessions (other Exo windows, Claude Code, Codex) can see the overlap.
   *
   * Fire-and-forget by design: never awaited, every failure swallowed, and a
   * no-op when the sentinel isn't installed. A registry that cannot delay or
   * fail a chat turn is the whole point — it informs, it never gates.
   */
  private recordToWriteSentinel(vaultRelativePaths: readonly string[]): void {
    try {
      const script = join(homedir(), SENTINEL_REL_PATH);
      if (!existsSync(script)) return;
      const args = sentinelRecordArgs(script, vaultRelativePaths);
      if (!args) return;
      execFile(
        process.execPath,
        args,
        {
          env: {
            ...process.env,
            MV_SESSION: SENTINEL_AGENT,
            MV_SESSION_ID: this.writeSentinelSessionId,
            VAULT_ROOT: this.vaultPath(),
          },
          timeout: 5000,
        },
        () => {
          /* Best-effort: a sentinel failure must stay invisible to the turn. */
        },
      );
    } catch {
      /* Never let bookkeeping surface into a chat turn. */
    }
  }

  /**
   * Convo-state notification — modeled on `noteVaultWrite()` above: synchronous,
   * in-memory, and unable to block, delay, or throw back into a chat turn (the
   * channel guards on `orchestrationEnabled` and try/catches every listener). The
   * ChatView hook sites call THIS at the exact points they already flip
   * `streaming` / open a pending card / stop, so a board crash is invisible to
   * chat and toggling the flag off makes it a strict no-op.
   */
  emitConvoState(convoId: string, state: ConvoState, detail?: { reason?: ConvoStateReason }): void {
    this.convoState.emit(convoId, state, detail);
  }

  /** Register a convo-state listener (the board driver). Returns an unsubscribe
   *  handle. Listeners never influence chat — throwing is swallowed. */
  onConvoState(listener: ConvoStateListener): Unsubscribe {
    return this.convoState.subscribe(listener);
  }

  /**
   * Read API for board reconciliation (workstream B5): given a convo id, report
   * whether it still exists in the live view and whether it's mid-turn / waiting
   * on input. Returns `{ exists: false }` when the view isn't open or the convo
   * is gone. Pure read — never mutates chat state.
   */
  readConvoState(convoId: string): { exists: boolean; streaming: boolean; hasPending: boolean } {
    return convoBridge.chatView(this.app)?.readConvoState(convoId) ?? { exists: false, streaming: false, hasPending: false };
  }

  /**
   * Plugin-level wrapper around `ChatView.listSessionSnapshots` for the
   * Orchestration Board's Session Cockpit: project the open ChatView's live
   * conversations into UI-free snapshots. Returns `[]` when no ChatView leaf is
   * open (the documented "leaf open" scope boundary). Pure read.
   */
  listSessionSnapshots(): SessionSnapshot[] {
    return convoBridge.chatView(this.app)?.listSessionSnapshots() ?? [];
  }

  /**
   * Set/clear a conversation's archived flag (Session Cockpit U6). Returns false
   * when no ChatView leaf is open or the convo id is unknown.
   */
  setConvoArchived(convoId: string, archived: boolean): boolean {
    return convoBridge.chatView(this.app)?.setConvoArchived(convoId, archived) ?? false;
  }

  /** Set a conversation's manually-assigned board column (Session Cockpit drag). */
  setConvoBoardStatus(convoId: string, status: SessionLane): boolean {
    return convoBridge.chatView(this.app)?.setConvoBoardStatus(convoId, status) ?? false;
  }

  /** The board × action: archive a conversation and close its sidebar tab. */
  archiveAndCloseTab(convoId: string): boolean {
    return convoBridge.chatView(this.app)?.archiveAndCloseTab(convoId) ?? false;
  }

  /** Reconnect MCP servers on the active Exo session (Connections pane). Respawns
   *  the active conversation's CLI session — which resumes, so context survives —
   *  re-attempting all MCP connections and picking up new OAuth creds / .mcp.json
   *  edits. Returns an error when no ChatView leaf is open (nothing to reconnect). */
  async reloadMcpConnections(): Promise<{
    ok: boolean;
    error?: string;
    servers?: import("./providers/types").SessionCaps["mcpServers"];
  }> {
    const view = convoBridge.chatView(this.app);
    return view ? view.reloadMcpConnections() : { ok: false, error: "Open an Exo chat first — reconnect runs on the active session." };
  }

  /**
   * Make sure a ChatView leaf EXISTS without revealing or focusing anything —
   * the background counterpart to `activateView`. Spawning is a system action
   * (the orchestrator consuming its queue), so it must never move the UI; only
   * an explicit user action (`revealConversation`) may reveal. The leaf is
   * created inactive in the right sidebar; the sidebar stays collapsed.
   */
  private async ensureChatView(): Promise<void> {
    const { workspace } = this.app;
    if (workspace.getLeavesOfType(VIEW_TYPE).length > 0) return;
    const leaf = workspace.getRightLeaf(false);
    await leaf?.setViewState({ type: VIEW_TYPE, active: false });
  }

  /**
   * Plugin-level wrapper around `ChatView.startTaskConversation` for callers that
   * don't hold the view (e.g. the Orchestration Board driver). Spawns a fresh
   * conversation seeded with `prompt` WITHOUT revealing Exo or stealing focus
   * (2026-07-08: was `activateView`, which yanked the sidebar open on every
   * queued-task start). The view is created hidden on demand; if it still can't
   * be resolved it returns "".
   */
  async startTaskConversation(prompt: string, opts?: { model?: string; parent?: string }): Promise<string> {
    await this.ensureChatView();
    return convoBridge.chatView(this.app)?.startTaskConversation(prompt, opts) ?? "";
  }

  /** Child-reporting bridges for the Orchestration Board driver: read a child's
   *  last answer for the excerpt, and hand a finished child's report to its
   *  parent conversation. Both no-op when no ChatView is mounted — there is
   *  then no conversation to read from or deliver to. */
  lastAssistantTextOf(convoId: string): string {
    return convoBridge.chatView(this.app)?.lastAssistantTextOf(convoId) ?? "";
  }
  deliverChildReport(report: ChildReport): void {
    convoBridge.chatView(this.app)?.deliverChildReport(report);
  }

  /**
   * Plugin-level wrapper around `ChatView.revealConversation` for the
   * Orchestration Board: reveal Exo (in the sidebar) and focus the tab holding
   * `convoId`, so clicking a board card jumps to that task's chat. Creates the
   * view on demand. Returns false if the convo can't be found. Pure reveal —
   * never spawns a conversation.
   */
  async revealConversation(convoId: string): Promise<boolean> {
    await this.activateView();
    return convoBridge.chatView(this.app)?.revealConversation(convoId) ?? false;
  }

  /** Plugin-level wrapper around `ChatView.insertIntoComposer` for the
   *  Capabilities hub's Skills tab: click a Command/Sub-agent chip → reveal
   *  Exo and drop it into whatever conversation is active there. Creates the
   *  view on demand, same as `revealConversation`. */
  async insertIntoComposer(text: string): Promise<void> {
    await this.activateView();
    convoBridge.chatView(this.app)?.insertIntoComposer(text);
  }

  /** Chats sidebar wrappers — bodies in `ui/convo-bridge.ts` (see it for the `null`-vs-`[]` contract). */
  listChatRows(): ReturnType<typeof convoBridge.listChatRows> { return convoBridge.listChatRows(this.app); }
  renameConversation(id: string, title: string): boolean { return convoBridge.renameConversation(this.app, id, title); }
  deleteConversation(id: string): boolean { return convoBridge.deleteConversation(this.app, id); }
  async newConversation(): Promise<void> { await this.activateView(); convoBridge.chatView(this.app)?.newConversation(); }
  setConvoPinned(id: string, pinned: boolean): boolean { return convoBridge.setConvoPinned(this.app, id, pinned); }
  decidePermission(id: string, verdict: "allow" | "deny"): boolean { return convoBridge.decidePermission(this.app, id, verdict); }
  activeConvoId(): string | null { return convoBridge.activeConvoId(this.app); }
  retitleConversation(id: string): Promise<boolean> { return convoBridge.retitleConversation(this, id); }
  backfillTitles(): Promise<void> { return convoBridge.backfillTitles(this); }

  /**
   * Periodic tick for the git auto-commit safety net (see core/git-autocommit
   * for the pure decision logic). Cheap on every tick that isn't due; only
   * once the debounce (after a write) or cadence (periodic fallback) window
   * has elapsed does this actually shell out to `git`. Fully async and
   * fire-and-forget from the caller — a failure here is caught, logged, and
   * (at most once per session) surfaced as a single Notice; it never throws
   * back into a chat turn because nothing calls this from inside one.
   */
  private async maybeAutoCommit(): Promise<void> {
    if (!this.settings.vaultAutoCommit) return;
    const cwd = this.vaultPath();
    if (cwd === ".") return; // no real filesystem adapter (e.g. mobile) — silent no-op

    const debounceMs = ExoPlugin.AUTO_COMMIT_DEBOUNCE_MS;
    const cadenceMs = Math.max(1, this.settings.vaultAutoCommitIntervalMinutes) * 60 * 1000;
    const now = Date.now();
    // Cheap pure check first — most ticks bail out here with zero git calls.
    if (!isCommitDue(this.gitAutoCommitState, now, debounceMs, cadenceMs)) return;

    const stateAtStart = this.gitAutoCommitState;
    const pathVersions = [...this.gitAutoCommitPaths.entries()];
    // Mark this check before async git I/O. Any write that lands while git is
    // running records a fresh debounce instead of being erased in `finally`.
    this.gitAutoCommitState = afterCommitCheck(stateAtStart, now);
    if (!pathVersions.length) return;
    const paths = pathVersions.map(([path]) => path);
    let completed = false;

    try {
      const git = gitRunner(cwd);
      const { isGitRepo, gitAvailable } = await checkGitRepo(git);
      const worktreeDirty = isGitRepo && gitAvailable ? await isWorktreeDirty(git, paths) : false;
      const pendingFileCount = paths.length;
      const commit = shouldCommitNow({
        enabled: this.settings.vaultAutoCommit,
        isGitRepo,
        gitAvailable,
        worktreeDirty,
        state: stateAtStart,
        now,
        debounceMs,
        cadenceMs,
      });
      if (commit) await runGitCommit(git, paths, formatCommitMessage(pendingFileCount));
      completed = true;
    } catch (err) {
      // Never let a failed commit break anything — log it and surface at most
      // one Notice ever (repeated failures would otherwise spam every tick).
      console.error("[Exo] git auto-commit failed:", err);
      if (!this.gitAutoCommitNoticeShown) {
        this.gitAutoCommitNoticeShown = true;
        new Notice("Exo: git auto-commit failed once — see the developer console for details.");
      }
    } finally {
      if (completed) {
        for (const [path, version] of pathVersions) {
          if (this.gitAutoCommitPaths.get(path) === version) this.gitAutoCommitPaths.delete(path);
        }
      }
    }
  }

  /**
   * Core of every one-shot text transform: a transient, tool-less session that
   * streams `text-delta` chunks to `onDelta` and resolves with the full text.
   * The session is disposed on abort and on completion. Shared by `oneShot`
   * (modal), `oneShotStream` (inline Edit) and `continueStream` (inline
   * Continue) so there's one place that owns the CLI session lifecycle.
   */
  private async runStream(
    prompt: string,
    signal: AbortSignal,
    onDelta: (text: string) => void
  ): Promise<string> {
    const provider = this.settings.provider;
    const bin = provider === "claude" ? this.settings.claudeBin : this.settings.codexBin;
    const cli = await resolveCli(provider, bin);
    const session = ADAPTERS[provider].createSession({
      cli,
      model: provider === "claude" ? this.settings.claudeModel : this.settings.codexModel,
      effort: "default",
      cwd: this.vaultPath(),
      permissionMode: "default",
      toolsEnabled: false, // pure text transform — no tools needed
      fastStartup: true,
    });
    signal.addEventListener("abort", () => {
      try {
        session.dispose("utility-aborted");
      } catch {
        /* already torn down */
      }
    });
    let out = "";
    try {
      await session.send(prompt, (e: AgentEvent) => {
        if (e.kind === "text-delta") {
          out += e.text;
          onDelta(e.text);
        }
      });
    } finally {
      session.dispose("utility-run-end");
    }
    return out;
  }

  /** One-shot text transform (no streaming): returns the trimmed result. Used by
   *  the legacy inline-edit modal. */
  private async oneShot(instruction: string, text: string, signal: AbortSignal): Promise<string> {
    return (await this.runStream(buildEditPrompt(instruction, text), signal, () => {})).trim();
  }

  /** Streaming Edit: rewrite `text` per `instruction`, emitting live chunks via
   *  `onDelta`. Resolves with the full (untrimmed — the diff needs raw text)
   *  result. Used by the in-note floating toolbar's Edit action. */
  async oneShotStream(
    instruction: string,
    text: string,
    signal: AbortSignal,
    onDelta: (text: string) => void
  ): Promise<string> {
    return this.runStream(buildEditPrompt(instruction, text), signal, onDelta);
  }

  /** Streaming Continue: keep writing from `precedingText`, emitting live chunks
   *  via `onDelta`. Resolves with the continuation only. Used by the in-note
   *  Continue action. */
  async continueStream(
    precedingText: string,
    signal: AbortSignal,
    onDelta: (text: string) => void
  ): Promise<string> {
    return this.runStream(buildContinuePrompt(precedingText), signal, onDelta);
  }

  /** Reveal the Exo chat and seed the given selection as a quoted context block
   *  in the composer, then focus it — the in-note "Ask Exo" action. */
  async attachSelectionToChat(text: string, sourcePath: string): Promise<void> {
    await this.activateView();
    convoBridge.chatView(this.app)?.attachSelection(text, sourcePath);
  }

  /** Forward the active editor's current selection to the open chat view so it
   *  renders an ambient "Selection" chip in the composer (`text=""` clears it).
   *  Unlike `attachSelectionToChat`, this never reveals/activates the view — it's
   *  passive ambient state: if no ChatView is open there's simply nothing to show. */
  reportSelection(text: string, sourcePath: string): void {
    convoBridge.chatView(this.app)?.setCurrentSelection(text, sourcePath);
  }

  /** Generate a concise 3-6 word chat title with Haiku. ALWAYS runs on the Claude
   *  CLI (its own model), regardless of the conversation's provider — a cheap,
   *  latency-sensitive one-liner. Transient, tool-less session (same shape as
   *  `oneShot`). Never throws: if the Claude CLI can't be resolved or the call
   *  errors/aborts/times out it resolves to "" and the caller keeps the truncated
   *  placeholder. An internal 90s timeout (plus the caller's `signal`) guarantees
   *  a hung call can't leak.
   *
   *  Instrumented (Task 6 Step 1, see
   *  .superpowers/sdd/2026-08-01-strip-plan/task-6-brief.md): AI titles landed
   *  only ~15% of the time on the real vault. The suspect was a 15s ceiling
   *  firing before a cold Claude-session spawn inside the Obsidian renderer
   *  completes (other timeouts in this plugin were already raised to 90s for the
   *  same reason) — CONFIRMED by direct measurement: two runs on the real
   *  vault, both hit the 15s ceiling and returned "" (15234ms and 15319ms wall
   *  time against a 15000ms timer — the abort fired right at the deadline, not
   *  because a reply was slow but because the session hadn't finished
   *  cold-spawning yet). Raised to 90s to match; see the timer comment below for
   *  why this must not be "optimized" back down. Every attempt logs one
   *  `this.diag.push("title", ...)` line with: spawn latency (time to the
   *  `system/init` handshake via `session.onCaps` — NOT the moment
   *  `createSession()` returns, which is synchronous and always ~0ms, so it
   *  would never show a cold-spawn stall), time to the first text-delta, total
   *  duration, and an outcome that distinguishes the internal timeout from the
   *  caller's own signal aborting, from any other thrown error, and from a
   *  reply that came back but sanitized to nothing (see `classifyTitleOutcome`
   *  in core/title.ts). Deliberately NOT gated behind a debug flag — this needs
   *  to produce data during normal use. */
  async generateTitle(userText: string, assistantText: string, signal: AbortSignal): Promise<string> {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onAbort);
    // Set only inside the timer callback below — the sole signal that OUR 90s
    // ceiling actually fired, as opposed to the caller's `signal` aborting for
    // an unrelated reason (e.g. the view tearing down mid-call).
    let timedOut = false;
    // 90s, matching the other cold-spawn-bound timeouts in this plugin (see the
    // 90_000 timeouts below in runObserver/produceProposalsAfterTurn/
    // distillWorkflowPlaybook). This call cold-spawns a FRESH Claude CLI session
    // inside the Obsidian renderer, which dominates the cost — NOT model
    // latency. A 15s ceiling was measured firing at 15234ms and 15319ms on the
    // real vault, both times returning "" before the spawn had even finished.
    // This value tracks cold-spawn cost, not response time — do not lower it
    // without a fresh measurement; that is exactly what regressed AI titles to
    // ~15% success before.
    const timer = window.setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, 90_000);
    let spawnMs = -1; // time to system/init (cold-spawn handshake), via onCaps
    let deltaMs = -1; // time to the first assistant text-delta
    let threw = false;
    let resultTitle = "";
    let errDetail = "";
    try {
      const cli = await resolveCli("claude", this.settings.claudeBin);
      const session = ADAPTERS.claude.createSession({
        cli,
        model: "claude-haiku-4-5", // product default — cheap/fast one-liner
        effort: "default",
        cwd: this.vaultPath(),
        permissionMode: "default",
        toolsEnabled: false, // title only — no tools
        fastStartup: true,
      });
      // The real "did the CLI process come up" signal — createSession() itself
      // is synchronous (it only builds the query() object), so timing right
      // after it returns would always read ~0ms and could never confirm or
      // rule out a cold-spawn stall.
      session.onCaps = () => {
        if (spawnMs < 0) spawnMs = Date.now() - t0;
      };
      ctrl.signal.addEventListener("abort", () => {
        try {
          session.dispose("title-aborted");
        } catch {
          /* already torn down */
        }
      });
      // Cap the input (~1500 chars total) so the call stays cheap and fast.
      const user = userText.replace(/\s+/g, " ").trim().slice(0, 800);
      const asst = assistantText.replace(/\s+/g, " ").trim().slice(0, 700);
      const prompt =
        "Write a short, specific title for this chat. Rules: 3-6 words, plain text only, " +
        "no surrounding quotes, no backticks, no trailing punctuation, and no preamble " +
        '(never "Chat about…", "Title:", etc). Return ONLY the title.\n\n' +
        `User: ${user}\n\nAssistant: ${asst}`;
      let out = "";
      try {
        await session.send(prompt, (e: AgentEvent) => {
          if (e.kind === "text-delta") {
            if (deltaMs < 0) deltaMs = Date.now() - t0;
            out += e.text;
          }
        });
      } finally {
        session.dispose("title-run-end");
      }
      resultTitle = sanitizeTitle(out);
      return resultTitle;
    } catch (err) {
      threw = true;
      errDetail = err instanceof Error ? err.message : String(err);
      return ""; // CLI missing / errored / aborted — keep the placeholder
    } finally {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      const outcome = classifyTitleOutcome({ threw, timedOut, callerAborted: signal.aborted, title: resultTitle });
      const totalMs = Date.now() - t0;
      this.diag.push(
        "title",
        `${outcome} spawn=${spawnMs >= 0 ? `${spawnMs}ms` : "?"} delta=${deltaMs >= 0 ? `${deltaMs}ms` : "?"} total=${totalMs}ms` +
          (outcome === "error" ? ` err=${errDetail}` : "")
      );
    }
  }

  /**
   * Run a prompt on a cheap, transient, tool-less Claude CLI session (same
   * lifecycle shape as {@link generateTitle}). The reusable chassis behind every
   * background utility pass: memory harvest, turn suggestions, playbook
   * distillation. Returns the raw model text, or "" on any failure: never throws,
   * aborts silently. A hard timeout plus the caller's `signal` guarantees a hung
   * call can't leak.
   *
   * @param opts.model    Model id (defaults to the `backgroundModel` setting).
   * @param opts.timeoutMs Hard ceiling (default 90s).
   * @param opts.onUsage  W0 cost governance: invoked once with the real
   *                      input+output token count for this call, read from the
   *                      session synchronously right after `send()` resolves
   *                      (before dispose) — see `ClaudeSession.lastTurnTokens()`.
   *                      Never invoked if the provider doesn't expose it.
   */
  async runUtilityPass(
    prompt: string,
    opts: { signal: AbortSignal; model?: string; timeoutMs?: number; onUsage?: (tokens: number) => void }
  ): Promise<string> {
    // Model floor is Sonnet (product policy: never Haiku for background
    // passes) — default to the W0 backgroundModel setting, not a hardcoded id.
    // 90s, not 15s: a cold session + trivial turn measured ~35s on 2026-08-05
    // (CLI 2.1.220) — the binary itself spawns in 40ms, the cost is session
    // init + the API round trip. A 15s default could never succeed, so every
    // call site already overrode it; the default was a trap for the next one.
    const { signal, timeoutMs = 90_000, onUsage } = opts;
    const model = opts.model || this.settings.backgroundModel || "claude-sonnet-5";
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onAbort);
    const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const cli = await resolveCli("claude", this.settings.claudeBin);
      const session = ADAPTERS.claude.createSession({
        cli,
        model,
        effort: "default",
        cwd: this.vaultPath(),
        permissionMode: "default",
        toolsEnabled: false, // read-only extraction — no tools
        fastStartup: true,
      });
      ctrl.signal.addEventListener("abort", () => {
        try {
          session.dispose("utility-pass-aborted");
        } catch {
          /* already torn down */
        }
      });
      let out = "";
      try {
        await session.send(prompt, (e: AgentEvent) => {
          if (e.kind === "text-delta") out += e.text;
        });
        // Read BEFORE dispose — contextUsage() is an async control round-trip
        // that a disposed session may never resolve; lastTurnTokens() is
        // populated synchronously by the `result` message that just settled
        // send() above.
        const tokens = session.lastTurnTokens?.();
        if (typeof tokens === "number") onUsage?.(tokens);
      } finally {
        session.dispose("utility-pass-run-end");
      }
      return out;
    } catch (err) {
      // Caller treats "" as no-op, but NEVER swallow the reason silently —
      // an instantly-empty utility pass is indistinguishable from a healthy
      // empty answer without this line (bit us on the first background LLM run).
      console.warn("[Exo] utility pass failed:", err);
      return "";
    } finally {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * The Agent Is the Folder — seeder (design §6). Read the vault's existing
   * scattered identity sources, distill the three blocks with the CHAT's default
   * (frontier) model — NOT the background floor: this is a one-shot, high-stakes
   * distillation — and write ONLY the block files that don't already exist (never
   * overwrite a hand-authored block). Also (re)writes the manifest and opens
   * `USER.md` for review. Runs regardless of the `agentFolderEnabled` flag: with
   * the flag off the folder is simply never read, which is the safe rollout path.
   */
  private async seedAgentFolder(): Promise<void> {
    const readSource = async (path: string): Promise<string> => {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) {
        try {
          return await this.app.vault.cachedRead(f);
        } catch {
          /* unreadable — treat as empty */
        }
      }
      return "";
    };

    const sources = {
      mentalModel: await readSource(this.paths.mentalModel),
      preferences: await readSource(this.paths.preferences),
      vaultContext: await readSource(this.paths.vaultContext),
    };
    if (!sources.mentalModel && !sources.preferences && !sources.vaultContext) {
      new Notice(`Nothing to seed from — the ${this.paths.root}/ source files are empty or missing.`);
      return;
    }

    new Notice("Seeding the agent folder — distilling identity blocks…");
    const ctrl = new AbortController();
    // The CHAT's default model (settings' provider default), not backgroundModel:
    // seeding is one-shot and high-stakes, so it uses the frontier model.
    const raw = await this.runUtilityPass(buildSeedPrompt(sources), {
      signal: ctrl.signal,
      model: this.settings.claudeModel,
      timeoutMs: 120_000,
    });
    const blocks = parseSeedBlocks(raw);
    if (Object.keys(blocks).length === 0) {
      new Notice("Seeding failed — the model returned no usable blocks. Try again.");
      return;
    }

    // Manifest first (contract doc), then only the MISSING block files.
    let written = 0;
    const writtenPaths: string[] = [];
    let skipped = 0;
    const agentDir = this.paths.agentDir;
    await this.ensureFolder(agentDir);
    const manifestPath = `${agentDir}/manifest.md`;
    await this.writeIfMissing(manifestPath, manifestContent(), () => {}, true);
    writtenPaths.push(manifestPath);
    for (const name of AGENT_BLOCK_NAMES) {
      const content = blocks[name];
      if (!content) continue;
      const path = `${agentDir}/${name}.md`;
      const existing = this.app.vault.getAbstractFileByPath(path);
      const body = `${content.replace(/\s+$/, "")}\n`;
      if (existing instanceof TFile) {
        // A file left by the "Full" scaffold is an untouched template — replace it
        // with the distilled block. Once the user has hand-edited it, it reads as
        // filled and we leave their work alone.
        const current = await this.app.vault.cachedRead(existing).catch(() => "");
        if (!isUnfilledAgentBlock(name, current)) {
          skipped++;
          continue;
        }
        await this.app.vault.modify(existing, body);
      } else {
        await this.app.vault.create(path, body);
      }
      written++;
      writtenPaths.push(path);
    }

    // Seeded blocks nudge the git-autocommit debounce like any other vault
    // write (integration audit 2026-07-10) — the fresh identity should reach
    // git on the fast path, not only the periodic cadence.
    if (writtenPaths.length > 0) this.noteVaultWrite(writtenPaths);

    new Notice(
      `Agent kernel seeded — wrote ${written} block(s)${skipped ? `, kept ${skipped} existing` : ""}. Review USER.md, then enable the shared kernel in settings.`
    );
    // Open USER.md for review (the block most worth a human check).
    const humanPath = `${agentDir}/USER.md`;
    if (this.app.vault.getAbstractFileByPath(humanPath) instanceof TFile) {
      await this.app.workspace.openLinkText(humanPath, "", true);
    }
  }

  /** Exo's memory-layer paths, derived from the configured `memoryRoot`. Single
   *  accessor so every consumer resolves the same paths without re-reading a
   *  literal — the vault's structure lives in one place (core/paths.ts). */
  get paths(): ExoPaths {
    return exoPaths(this.settings.memoryRoot);
  }

  /**
   * Ensure the agent registry is loaded, once. Returns false when the feature is
   * off, so callers can bail without touching the store.
   *
   * Loading is lazy and shared: the first caller (composer `@`, `/as`, or the
   * scheduler) pays the scan, everyone else awaits the same promise. Scaffolding
   * missing contract sidecars happens here too — writing an inert, disabled file
   * per discovered brain, which is what makes the agents visible in the vault
   * without granting any of them autonomy.
   */
  async agentsReady(): Promise<boolean> {
    if (!this.settings.agentsEnabled) return false;
    if (!this.agentRefresh) {
      this.agentRefresh = (async () => {
        // No contract scaffolding: v2 archived the sidecars — autonomy lives
        // in automation files now, and re-scaffolding would resurrect them.
        await this.agentStore.refresh();
      })().catch(() => undefined);
    }
    await this.agentRefresh;
    return true;
  }

  /** Load the unified automation files and run the one-shot v2 migration
   *  (settings playbooks + agent contract sidecars → automation files). */
  private async readyAutomations(): Promise<void> {
    try {
      await this.automationStore.refresh();
      if (!this.settings.automationsMigrated) {
        const { ok, notices } = await migrateToAutomationFiles(
          this.automationStore,
          this.agentStore,
          this.settings,
          adaptAppToAutomationVault(this.app),
          this.paths,
        );
        if (notices.length) {
          if (ok) this.diag.push("automations", `migration: ${notices.join(" · ")}`);
          else console.warn("[Exo] automations migration:", notices.join(" · "));
          new Notice(`Exo automations: ${notices.filter((n) => !n.startsWith("FAILED")).length} migrated${ok ? "" : " — some items failed, see console"}`);
        }
        if (ok) {
          this.settings.automationsMigrated = true;
          this.invalidateAgents();
        }
        await this.saveSettings();
        await this.automationStore.refresh();
      }
    } catch (err) {
      console.warn("[Exo] automations load failed:", err);
    }
  }

  /** Drop the cached registry so the next consumer rescans (settings changed,
   *  a contract was edited by hand, a new agent file appeared). */
  invalidateAgents(): void {
    this.agentRefresh = null;
  }

  /** Re-render any open Agents pane. No-op when none is open. */
  async refreshAgentsUI(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(AGENTS_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof AgentsView) await view.refresh();
    }
  }

  /**
   * Wire vault events to the agent trigger driver.
   *
   * Registration happens at load but the driver stays DISARMED until the
   * workspace is ready: Obsidian replays `create` for every file in the vault
   * while it builds its initial index, and an armed driver would read that as
   * the whole vault being created at once.
   */
  private setupAgentTriggers(): void {
    const driver = new AgentTriggerDriver({
      agents: () => {
        if (!this.settings.agentsEnabled) return [];
        // A cold store used to make every event vanish silently: the driver saw
        // an empty list, concluded nobody was listening, and dropped the event
        // before it even scheduled. Kick the load instead — this event is still
        // lost, but the next one lands, rather than the feature staying dead
        // until something else happened to warm the registry.
        if (!this.agentStore.isLoaded()) {
          void this.agentsReady();
          return [];
        }
        return this.automationDefs();
      },
      memoryRoot: () => this.paths.root,
      configDir: () => this.app.vault.configDir,
      readNote: makeNoteReader(this.app),
      dispatch: (run) => void this.dispatchTriggeredRun(run),
      schedule: (fn, ms) => window.setTimeout(fn, ms),
      cancel: (id) => window.clearTimeout(id),
    });
    this.agentTriggers = driver;
    this.register(() => driver.dispose());

    // Registered one by one: Obsidian's `vault.on` overloads are per-event, and
    // `rename` carries a second argument, so a loop over a union does not type.
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile) driver.notify(file.path, "create");
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) driver.notify(file.path, "modify");
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file) => {
        // Reported against the NEW path — that is the note that now exists.
        if (file instanceof TFile) driver.notify(file.path, "rename");
      })
    );

    // Contract files are meant to be edited by hand — that is the whole point of
    // keeping them in the vault. Without this, an edit would sit in a file the
    // cached registry never re-reads, and the agent would keep its old triggers
    // until the plugin reloaded.
    const watchContracts = (path: string) => {
      if (!path.endsWith(".md") || !path.startsWith(`${this.paths.agents}/`)) return;
      this.invalidateAgents();
      void this.refreshAgentsUI();
    };
    this.registerEvent(this.app.vault.on("modify", (file) => watchContracts(file.path)));
    this.registerEvent(this.app.vault.on("create", (file) => watchContracts(file.path)));
    this.registerEvent(this.app.vault.on("delete", (file) => watchContracts(file.path)));
    this.registerEvent(this.app.vault.on("rename", (file) => watchContracts(file.path)));

    this.app.workspace.onLayoutReady(() => {
      // Warm the registry so the first real event has agents to match against,
      // then arm. Failure here must not block the rest of the plugin.
      void this.agentsReady()
        .catch(() => false)
        .then(() => driver.arm())
        .then(() => this.readyAutomations());
    });

    // Automation files are meant to be hand-editable too — re-scan on any
    // change inside the automations folder so the hub and scheduler never act
    // on a stale parse.
    const watchAutomations = (path: string) => {
      if (!this.automationStore.owns(path)) return;
      void this.automationStore.refresh().then(() => this.refreshAgentsUI());
    };
    this.registerEvent(this.app.vault.on("modify", (file) => watchAutomations(file.path)));
    this.registerEvent(this.app.vault.on("create", (file) => watchAutomations(file.path)));
    this.registerEvent(this.app.vault.on("delete", (file) => watchAutomations(file.path)));
    this.registerEvent(this.app.vault.on("rename", (file) => watchAutomations(file.path)));
  }

  /** Apply the shared run gates to an event-triggered run, then execute it. */
  private async dispatchTriggeredRun(run: DueAgentRun): Promise<void> {
    await this.runDueAutomation(run);
  }

  /** Vault setup — create every memory-layer path Exo reads/writes that's
   *  currently missing (Global Constraints: never touches what already
   *  exists). Shared by the `setup-vault-memory` command and the empty-state
   *  banner (ChatView calls this directly, hence no `private`). */
  /** Apply the onboarding memory-scaffold choice: record it (so the picker
   *  never re-offers) and, for minimal/full, create the create-only-if-absent
   *  items for that preset. "none" persists the choice and creates nothing. */
  async applyMemorySetup(preset: MemorySetup): Promise<void> {
    this.settings.memorySetup = preset;
    await this.saveSettings();
    if (preset === "none") {
      new Notice("Exo memory: nothing created. You can set it up later in settings.");
      return;
    }
    let written = 0;
    let skipped = 0;
    let failed = 0;
    const writtenPaths: string[] = [];
    for (const item of scaffoldItems(this.paths, preset)) {
      const existed = !!this.app.vault.getAbstractFileByPath(item.path);
      if (existed) {
        skipped++;
        continue;
      }
      try {
        if (item.kind === "folder") {
          await this.ensureFolder(item.path);
        } else {
          const parent = parentFolder(item.path);
          if (parent) await this.ensureFolder(parent);
          await this.app.vault.create(item.path, item.content ?? "");
        }
        written++;
        writtenPaths.push(item.path);
      } catch (err) {
        failed++;
        console.error(`[Exo] vault setup failed to create ${item.path}:`, err);
      }
    }
    if (writtenPaths.length > 0) this.noteVaultWrite(writtenPaths);
    new Notice(
      `Exo vault memory set up — created ${written} item(s)${skipped ? `, kept ${skipped} existing` : ""}${failed ? `, ${failed} failed (see console)` : ""}.`
    );
  }

  /** Create a folder if it doesn't exist (idempotent, race-safe). */
  private async ensureFolder(path: string): Promise<void> {
    if (this.app.vault.getAbstractFileByPath(path)) return;
    try {
      await this.app.vault.createFolder(path);
    } catch {
      /* already exists (race) — fine */
    }
  }

  /** Create each missing parent component for a target file, shallow to deep. */
  private async ensureParentFolders(filePath: string): Promise<void> {
    const parts = filePath.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      await this.ensureFolder(current);
    }
  }

  /** Write a file only when it's absent; `manifest` forces an overwrite so the
   *  contract doc stays current on every re-seed (it's Exo-owned, not hand-edited). */
  private async writeIfMissing(
    path: string,
    content: string,
    onWrite: () => void,
    overwrite = false
  ): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      if (overwrite) await this.app.vault.modify(existing, content);
      return;
    }
    await this.app.vault.create(path, content);
    onWrite();
  }

  private inlineEdit(editor: Editor): void {
    const selection = editor.getSelection();
    const text = selection || editor.getLine(editor.getCursor().line);
    if (!text.trim()) {
      new Notice("Select some text (or place the cursor on a non-empty line) to edit.");
      return;
    }
    const hadSelection = selection.length > 0;
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    const line = editor.getCursor().line;
    new InlineEditModal(this.app, text, (instr, t, sig) => this.oneShot(instr, t, sig), (next) => {
      if (hadSelection) {
        editor.replaceRange(next, from, to);
      } else {
        editor.replaceRange(next, { line, ch: 0 }, { line, ch: editor.getLine(line).length });
      }
    }).open();
  }

  /* Seeded playbook: the Dia-style morning digest — vault + external sources
   * (Gmail/Slack/Calendar/Readwise via MCP, read-only). Each source degrades
   * gracefully when unavailable; the report is written by the runner, not the
   * agent (headless runs are read-only). */

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<MVASettings> | null);
    // See session-caps-cache.ts: strips the orphaned pre-migration key that
    // Object.assign above can't drop on its own.
    if (stripLegacyCachedSessionCaps(this.settings)) await this.saveSettings();
    if (stripObsoleteSettings(this.settings)) await this.saveSettings();
    // Codex app-server no longer accepts the legacy `on-failure` policy.
    if (this.settings.codexApproval === "on-failure") {
      this.settings.codexApproval = "on-request";
      await this.saveSettings();
    }
    // Memory-root auto-detect (one-shot): a vault that already has a legacy-root
    // layer keeps it — existing installs (marioverse included) never migrate —
    // while a fresh vault adopts the neutral, tool-owned `_exo/`. Persisted so
    // it's stable and user-overridable in Settings thereafter.
    if (!this.settings.memoryRoot) {
      const hasLegacy = await this.app.vault.adapter.exists(LEGACY_MEMORY_ROOT);
      this.settings.memoryRoot = detectMemoryRoot(hasLegacy);
      await this.saveSettings();
    }
    const savedPulseState = this.settings.dailyPulseReviewState;
    this.settings.dailyPulseReviewState = {
      ...DEFAULT_SETTINGS.dailyPulseReviewState,
      ...(savedPulseState && typeof savedPulseState === "object" ? savedPulseState : {}),
      warnings: Array.isArray(savedPulseState?.warnings) ? savedPulseState.warnings : [],
    };
    // One-shot migration: legacy "Name | daily" scheduled-run lines become
    // structured automations (07:00 slot, read-only) and the raw field clears.
    if (this.settings.scheduledRuns.trim() && this.settings.automations.length === 0) {
      this.settings.automations = migrateScheduledRuns(this.settings.scheduledRuns);
      this.settings.scheduledRuns = "";
      await this.saveSettings();
    }
    const pulseSeed = seedDailyPulseAutomation(
      this.settings.automations,
      this.settings.seededDailyPulse
    );
    if (pulseSeed.changed) {
      this.settings.automations = pulseSeed.automations;
      this.settings.seededDailyPulse = pulseSeed.seeded;
      await this.saveSettings();
    }
    // Migrate the old "Default" model option (empty id — silently let the CLI's
    // own default apply): the picker no longer offers an ambiguous unlabeled
    // state, so an empty saved id resolves to that provider's first real model.
    if (!this.settings.claudeModel) this.settings.claudeModel = ADAPTERS.claude.models()[0].id;
    if (!this.settings.codexModel) this.settings.codexModel = ADAPTERS.codex.models()[0].id;
    // Seed a few example reusable prompts on first run (once) so "Your prompts"
    // isn't empty. They're editable/deletable in Settings; never re-seeded.
    if (!this.settings.seededPrompts && this.settings.customPrompts.length === 0) {
      this.settings.customPrompts = [
        { name: "Distill", prompt: "Distill this note to its 3 core ideas, each as one crisp sentence." },
        { name: "Devil's advocate", prompt: "Argue the strongest case against the main claim in this note." },
        { name: "Next actions", prompt: "Turn this note into a short checklist of concrete next actions." },
      ];
      this.settings.seededPrompts = true;
      await this.saveSettings();
    }
    // Seed the Morning Digest playbook once (editable/deletable like any prompt;
    // never re-seeded). Schedule it with "Morning Digest | daily" in settings.
    if (!this.settings.seededDigest) {
      if (!this.settings.customPrompts.some((p) => p.name.toLowerCase() === "morning digest")) {
        this.settings.customPrompts.push({ name: "Morning Digest", prompt: morningDigestPrompt(this.paths) });
      }
      this.settings.seededDigest = true;
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(this.settings)) as MVASettings;
    await this.settingsWriteQueue.enqueue(() => this.saveData(snapshot));
    // React to an orchestration-flag toggle: add/remove the ribbon and tear the
    // board down on hot-disable (safe — no markdown touched, chats survive).
    this.applyOrchestrationToggle();
  }

  private convoFile(base = "conversations.json"): string {
    return `${this.manifest.dir}/${base}`;
  }

  /**
   * Persisted conversation history (separate from settings/data.json).
   *
   * Recovery-aware: reads the main file AND its `.bak` rotation, then defers the
   * trust decision to the pure `parseConversationsSource`. When the main file
   * exists but is corrupt it is NEVER deleted — it's renamed aside as
   * `<file>.corrupt-<epoch>` for forensics, and the user is told whether history
   * was recovered from backup or lost.
   */
  async loadConversations(base = "conversations.json"): Promise<unknown[]> {
    const adapter = this.app.vault.adapter;
    const p = this.convoFile(base);
    const bak = `${p}.bak`;
    const readOrNull = async (path: string): Promise<string | null> => {
      try {
        return (await adapter.exists(path)) ? await adapter.read(path) : null;
      } catch {
        return null;
      }
    };
    const mainRaw = await readOrNull(p);
    const bakRaw = await readOrNull(bak);
    const { data, source, mainCorrupt } = parseConversationsSource(mainRaw, bakRaw);
    if (mainCorrupt) {
      // Preserve the corrupt file — never start silently empty over a bad file.
      try {
        if (await adapter.exists(p)) await adapter.rename(p, `${p}.corrupt-${Date.now()}`);
      } catch {
        /* best effort — recovery still proceeds */
      }
      new Notice(
        source === "bak"
          ? "Exo recovered conversation history from a backup — the main file was corrupted (kept for recovery)."
          : "Exo couldn't read conversation history — the file was corrupted and no usable backup existed (kept for recovery)."
      );
    }
    return data;
  }

  /**
   * Atomic, backup-rotating write. Returns false (never throws) if it failed, so
   * callers can surface it. Sequence — at no intermediate step are BOTH the main
   * file and its `.bak` missing/incomplete:
   *   1. write the payload to `<file>.tmp` (main + bak stay intact)
   *   2. rotate the current main file to `<file>.bak` (one generation)
   *   3. rename `.tmp` over the main path
   */
  async saveConversations(data: unknown[], base = "conversations.json"): Promise<boolean> {
    // Snapshot the payload at call time; the caller's arrays keep mutating while
    // this request waits behind earlier saves.
    const json = JSON.stringify(data);
    return this.conversationWriteQueue.enqueue(async () => {
      const adapter = this.app.vault.adapter;
      const p = this.convoFile(base);
      const tmp = `${p}.tmp`;
      const bak = `${p}.bak`;
      try {
        // 1. Stage the new content. A crash here leaves main (and bak) untouched.
        await adapter.write(tmp, json);
        // 2. Rotate the live main file to .bak before replacing it. Rename can't
        //    overwrite an existing target on every platform, so clear the old bak
        //    first. Main is still present throughout this step.
        if (await adapter.exists(p)) {
          if (await adapter.exists(bak)) await adapter.remove(bak);
          await adapter.rename(p, bak);
        }
        // 3. Move the staged file over the (now absent) main path.
        await adapter.rename(tmp, p);
        return true;
      } catch {
        // Drop a stray tmp so a half-written file can't be mistaken for real data.
        try {
          if (await adapter.exists(tmp)) await adapter.remove(tmp);
        } catch {
          /* ignore */
        }
        return false;
      }
    });
  }

  /**
   * Archived conversations live in a SEPARATE, never-trimmed store so archive
   * growth (each keeps its full transcript) can't tax the write-hot
   * `conversations.json` that the active chat re-serializes every turn. Same
   * atomic/backup/recovery machinery, different file.
   */
  loadArchivedConversations(): Promise<unknown[]> {
    return this.loadConversations("conversations-archive.json");
  }
  saveArchivedConversations(data: unknown[]): Promise<boolean> {
    return this.saveConversations(data, "conversations-archive.json");
  }

  // Mechanics (file path, read/write/corrupt-handling) live in
  // session-caps-cache.ts — these three are thin wrappers that own only the
  // WriteQueue serialization, same division of labor as workflow-signal-store.
  async saveSessionCapsCache(caps: import("./providers/types").SessionCaps): Promise<boolean> {
    return this.sessionCapsWriteQueue.enqueue(() =>
      writeSessionCapsCache(this.app.vault.adapter, this.manifest.dir, caps)
    );
  }
  async loadSessionCapsCache(): Promise<import("./providers/types").SessionCaps | null> {
    return readSessionCapsCache(this.app.vault.adapter, this.manifest.dir);
  }
  async clearSessionCapsCache(): Promise<void> {
    return removeSessionCapsCache(this.app.vault.adapter, this.manifest.dir);
  }
  /** Roll the daily ledger and answer whether a background pass may spend `estimate`.
   *  Not `private`: memory harvest gates through this same W0 ledger. */
  checkBackgroundBudget(estimate: number): boolean {
    const s = this.settings;
    const now = Date.now();
    s.backgroundBudgetLedger = resetIfNewDay(s.backgroundBudgetLedger, now);
    return canSpend(s.backgroundBudgetLedger, estimate, {
      enabled: s.backgroundPassesEnabled,
      dailyBudget: s.backgroundDailyTokenBudget,
      now,
    });
  }

  /** Add `tokens` to the daily background ledger and persist. Not `private` —
   *  see {@link checkBackgroundBudget}. */
  recordBackgroundSpend(tokens: number): void {
    const s = this.settings;
    s.backgroundBudgetLedger = recordSpend(s.backgroundBudgetLedger, tokens, Date.now());
    void this.saveSettings();
  }

  /** Epoch ms of the most recent `exo: auto-commit` in the vault's git log, or
   *  null when it can't be determined (not a repo, git missing, no such commit).
   *  Read-only, never throws — same execFile discipline as the auto-commit path.
   *  Used by the Actions hub (W2-UX) to show the last auto-commit time; the panel
   *  calls it once per open and async-fills, so a slow git call never blocks render. */
  async lastAutoCommitEpoch(): Promise<number | null> {
    const cwd = this.vaultPath();
    if (cwd === ".") return null;
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["log", "-1", "--format=%ct", "--grep", "exo: auto-commit"],
        { cwd }
      );
      const secs = parseInt(stdout.trim(), 10);
      return Number.isFinite(secs) ? secs * 1000 : null;
    } catch {
      return null;
    }
  }

  /** Run one playbook headlessly and write its report. Write-enabled runs also
   *  persist a restorable run record (files touched + pre-write snapshots). */
  async runPlaybook(name: string, prompt: string, opts: { write?: boolean; slug?: string } = {}): Promise<boolean> {
    if (/\{\{\s*[\w-]+\s*\}\}/.test(prompt)) {
      new Notice(`"${name}" has {{variables}} — run it from the composer instead.`);
      return false;
    }
    const startedAt = Date.now();
    new Notice(`Running playbook "${name}"…`);
    const headlessOpts: HeadlessOpts = { write: opts.write, codexBridge: await this.headlessBridge() };
    const result = await runHeadlessPlaybook(this.app, this.settings, prompt, headlessOpts);
    if (result.writes.length) this.noteVaultWrite(result.writes);
    const path = await writeReport(this.app, name, result, this.paths.reports);
    // Every automation run is recorded, not just the ones that wrote. The
    // records started life as restore points, so read-only runs left no trace
    // — which made an automation's own timeline read "never ran" the morning
    // after it ran. A record with no checkpoint is history; only one WITH a
    // checkpoint is a restore point, and the UI keys off `writes`/`checkpoint`.
    if (opts.slug || opts.write) await this.recordAutomationRun(name, startedAt, result, path, opts.slug);
    new Notice(
      result.ok ? `Playbook "${name}" done → ${path}` : `Playbook "${name}" failed (report: ${path})`
    );
    this.notifyReportReady(name, result.ok, path);
    return result.ok;
  }

  /** OS notification when Obsidian isn't focused: scheduled runs usually finish
   *  in the background, and this is how the digest announces itself. Click
   *  opens the report. Same gate as the chat's turn notifications. */
  private notifyReportReady(name: string, ok: boolean, path: string): void {
    if (!this.settings.systemNotifications || document.hasFocus()) return;
    try {
      const n = new Notification(`Exo — ${ok ? `"${name}" ready` : `"${name}" failed`}`, {
        body: ok ? "The report is in the vault — click to open it." : "The run failed — the report has the error.",
        silent: false,
      });
      n.onclick = () => {
        void this.app.workspace.openLinkText(path, "", "tab");
      };
    } catch {
      /* notifications unavailable: the in-app Notice already covered it */
    }
  }

  /** Run any scheduled playbooks that are due (off by default — empty list). */
  /** Exo Queue: drain con guardia anti-concorrenza (le richieste headless
   *  possono durare minuti; il poll a 60s NON deve accavallarsi). */
  private exoQueueBusy = false;
  private async maybeDrainExoQueue(): Promise<void> {
    if (!this.settings.exoQueueEnabled || this.exoQueueBusy) return;
    this.exoQueueBusy = true;
    try {
      await drainExoQueue(this.app, this.settings, {
        codexBridge: () => this.headlessBridge(),
        noteWrite: (paths) => this.noteVaultWrite(paths),
      });
    } catch (err) {
      console.warn("[Exo] queue drain failed:", err);
    } finally {
      this.exoQueueBusy = false;
    }
  }

  /** "New Queue request": create an empty request note in the queue folder
   *  and open it — the same note a phone capture would write; the next drain
   *  (60s poll or "Drain now") answers it in place. */
  async createQueueRequest(): Promise<void> {
    const folder = this.settings.exoQueueFolder;
    try {
      if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
      const stamp = new Date();
      const p = (x: number) => String(x).padStart(2, "0");
      const name = `Richiesta ${stamp.getFullYear()}-${p(stamp.getMonth() + 1)}-${p(stamp.getDate())} ${p(stamp.getHours())}${p(stamp.getMinutes())}${p(stamp.getSeconds())}`;
      const file = await this.app.vault.create(`${folder}/${name}.md`, "");
      await this.app.workspace.getLeaf("tab").openFile(file);
      new Notice("Write the request in the note body — Exo answers on the next drain.");
    } catch (err) {
      new Notice(`Couldn't create the queue request: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** True when `node` resolves on the given PATH — the codex child must be able
   *  to spawn the bridge script. On failure, warn ONCE per app run. */
  async checkNodeForBridge(pathEnv: string): Promise<boolean> {
    try {
      await execFileAsync("node", ["--version"], { env: { ...process.env, PATH: pathEnv } });
      return true;
    } catch {
      if (!this.nodeWarned) {
        this.nodeWarned = true;
        new Notice("Obsidian tools bridge unavailable for Codex — `node` not found on PATH. Codex runs without vault tools.");
      }
      return false;
    }
  }

  /** The vault-tools bridge a headless run needs: one per run on Codex with the
   *  Obsidian tools on, none otherwise (Claude gets its tools in-process). */
  private async headlessBridge(): Promise<HeadlessOpts["codexBridge"]> {
    if (this.settings.provider !== "codex" || !this.settings.obsidianToolsEnabled) return undefined;
    return (await this.ensureCodexBridge()) ?? undefined;
  }

  /** Start an isolated loopback executor and materialize the shared stdio script
   *  the codex child spawns. Null when anything fails — Codex then runs without
   *  Obsidian tools. The owning session must call `release` on teardown. */
  async ensureCodexBridge(): Promise<{
    bridge: CodexBridge;
    scriptPath: string;
    release: () => void;
  } | null> {
    try {
      if (!this.codexBridgeScriptPath) {
        const rel = `${this.manifest.dir}/codex-bridge.mjs`;
        await this.app.vault.adapter.write(rel, CODEX_BRIDGE_SCRIPT);
        this.codexBridgeScriptPath = `${this.vaultPath()}/${rel}`;
      }
      const bridge = await startCodexBridge();
      this.codexBridges.add(bridge);
      let released = false;
      return {
        bridge,
        scriptPath: this.codexBridgeScriptPath,
        release: () => {
          if (released) return;
          released = true;
          this.codexBridges.delete(bridge);
          bridge.stop();
        },
      };
    } catch (e) {
      console.warn("[Exo] codex bridge unavailable:", e);
      return null;
    }
  }

  async listPendingProposals(): Promise<PendingProposals> {
    return this.proposalStore.listPending();
  }

  lastProposalRouteError(id: string): string | undefined {
    return this.proposalRouteErrors.get(id);
  }

  async acceptProposal(id: string): Promise<ProposalAcceptResult> {
    if (!this.settings.proposalKernelEnabled) throw new Error("Suggestion inbox is disabled.");
    const result = await this.proposalStore.accept(id, (record) =>
      routeAcceptedProposal(record, this.proposalAcceptanceDeps)
    );
    if (result.ok) this.proposalRouteErrors.delete(id);
    else this.proposalRouteErrors.set(id, result.error);
    void this.refreshCockpit();
    return result;
  }

  async dismissProposal(id: string) {
    if (!this.settings.proposalKernelEnabled) throw new Error("Suggestion inbox is disabled.");
    const record = await this.proposalStore.dismiss(id);
    this.proposalRouteErrors.delete(id);
    void this.refreshCockpit();
    return record;
  }

  async updateProposalPlaybook(id: string, patch: { name: string; prompt: string }) {
    if (!this.settings.proposalKernelEnabled) throw new Error("Suggestion inbox is disabled.");
    return this.proposalStore.updatePendingPlaybook(id, patch);
  }

  async openProposalsModal(): Promise<void> {
    if (!this.settings.proposalKernelEnabled) return;
    const conversations = await this.loadConversations().catch(() => []);
    const titles = new Map<string, string>();
    for (const value of conversations) {
      if (typeof value !== "object" || value === null) continue;
      const convo = value as { id?: unknown; title?: unknown };
      if (typeof convo.id === "string" && typeof convo.title === "string") titles.set(convo.id, convo.title);
    }
    new ProposalsModal(this.app, {
      loadPending: () => this.listPendingProposals(),
      accept: (id) => this.acceptProposal(id),
      dismiss: (id) => this.dismissProposal(id),
      sourceTitle: (convoId) => titles.get(convoId) ?? "Conversation",
      lastRouteError: (id) => this.lastProposalRouteError(id),
      updatePlaybook: (id, patch) => this.updateProposalPlaybook(id, patch),
    }).open();
  }

  async produceProposalsAfterTurn(
    input: Omit<ProposalTurnInput, "backgroundEnabled" | "suggestionsEnabled" | "budgetAllowed">
  ): Promise<ProposalProducerResult> {
    const estimate = ExoPlugin.PROPOSAL_TOKEN_ESTIMATE;
    const result = await produceTurnProposals({
      ...input,
      backgroundEnabled: this.settings.backgroundPassesEnabled,
      suggestionsEnabled: this.settings.proposalKernelEnabled && this.settings.proposalTurnSuggestions,
      budgetAllowed: this.checkBackgroundBudget(estimate),
    }, {
      signal: this.proposalAbort.signal,
      model: this.settings.backgroundModel,
      store: this.proposalStore,
      runUtilityPass: async (prompt, options) => {
        let actualTokens: number | null = null;
        const output = await this.runUtilityPass(prompt, {
          ...options,
          timeoutMs: 90_000,
          onUsage: (tokens) => {
            actualTokens = tokens;
          },
        });
        this.recordBackgroundSpend(actualTokens ?? estimate);
        return output;
      },
    });
    if (result.status === "generated" && result.appended > 0) void this.refreshCockpit();
    return result;
  }

  /**
   * Distill a recurring workflow into an editable playbook proposal. Called only
   * when the deterministic signal recorder returns a threshold candidate, so the
   * one utility pass runs at most once per detection. Every failure is typed and
   * quiet: it never throws, retries, or surfaces a large error in the chat.
   */
  async distillWorkflowPlaybook(input: {
    intent: string;
    tools: string[];
    outputType: string;
    occurrences: number;
    workflowSignature: string;
    userText: string;
    responseText: string;
    source: ProposalTurnInput["source"];
  }): Promise<WorkflowDistillOutcome> {
    if (!this.settings.proposalKernelEnabled) return { status: "skipped", reason: "kernel_disabled" };
    if (!this.settings.backgroundPassesEnabled) return { status: "skipped", reason: "background_disabled" };
    const estimate = ExoPlugin.PROPOSAL_TOKEN_ESTIMATE;
    if (!this.checkBackgroundBudget(estimate)) return { status: "skipped", reason: "budget_denied" };
    // Close the record→append window: two eligible turns of the same signature
    // in parallel conversations must not both spend a pass and append twins.
    if (this.distillingSignatures.has(input.workflowSignature)) return { status: "skipped", reason: "in_flight" };
    this.distillingSignatures.add(input.workflowSignature);
    try {
      let raw: string;
      try {
        let actualTokens: number | null = null;
        raw = await this.runUtilityPass(buildFoundryDistillPrompt(input), {
          signal: this.proposalAbort.signal,
          model: this.settings.backgroundModel,
          timeoutMs: 90_000,
          onUsage: (tokens) => {
            actualTokens = tokens;
          },
        });
        this.recordBackgroundSpend(actualTokens ?? estimate);
      } catch (error) {
        console.warn("[Exo] foundry distillation utility pass failed (no-op):", error);
        return { status: "failed", reason: "utility_error" };
      }
      if (!raw.trim()) return { status: "failed", reason: "empty_output" };

      const parsed = parseFoundryDistillation(raw, {
        workflowSignature: input.workflowSignature,
        occurrences: input.occurrences,
      });
      if (parsed.status !== "ok") {
        console.warn(`[Exo] foundry distillation rejected: ${parsed.error}`);
        void this.proposalStore.recordMetric("parseErrors").catch(() => {});
        return { status: "failed", reason: "invalid_output" };
      }

      try {
        const appended = await this.proposalStore.append(parsed.candidate, input.source);
        if (appended.status === "appended") {
          void this.refreshCockpit();
          return { status: "appended", proposalId: appended.record.id };
        }
        if (appended.status === "duplicate") return { status: "duplicate" };
        return { status: "failed", reason: "invalid_output" };
      } catch (error) {
        console.warn("[Exo] foundry distillation could not persist the proposal (no-op):", error);
        return { status: "failed", reason: "store_error" };
      }
    } finally {
      this.distillingSignatures.delete(input.workflowSignature);
    }
  }

  private async refreshCockpit(): Promise<void> {
    const view = this.app.workspace.getLeavesOfType(COCKPIT_VIEW_TYPE)[0]?.view;
    if (view instanceof CockpitView) await view.refresh();
  }

  /** Re-render an open Capabilities hub — called when a new SessionCaps
   *  snapshot arrives, so the pane's live statuses (MCP health, skill/tool
   *  inventories) match the session without a manual refresh. Cheap: the
   *  row-based tabs reconcile by key, so unchanged rows aren't rebuilt. */
  /** What memory may do on the plugin's own surfaces (see core/memory-caps). */
  memoryCaps(): MemoryCaps { return pluginMemoryCaps(this); }
  readConversationStore(): Promise<ChatRecord[]> { return convoBridge.readConversationStore(this); }
  undoMemoryWrite(sha?: string): Promise<{ ok: boolean; message: string }> { return undoMemoryWrite(this, this.harvestLog, sha); }

  refreshHub(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(HUB_VIEW_TYPE)) {
      if (leaf.view instanceof HubView) leaf.view.refresh();
    }
  }

  onunload(): void {
    this.unloaded = true;
    this.orchestration.stop();
    this.proposalAbort.abort();
    const cancelIdle = (window as unknown as {
      cancelIdleCallback?: (h: number) => void;
    }).cancelIdleCallback;
    for (const h of this.startupIdleHandles) {
      if (typeof cancelIdle === "function") cancelIdle(h);
      window.clearTimeout(h);
    }
    this.startupIdleHandles = [];
    for (const bridge of this.codexBridges) bridge.stop();
    this.codexBridges.clear();
  }

  /** Pending queue requests (for the Autonomy card). */
  countQueuePending(): Promise<number> {
    return countPendingQueue(this.app, this.settings);
  }

  /** Live attention data for the Cockpit (blocked / streaming conversations). */
  liveAttention(): { id: string; title: string; blocked: boolean; streaming: boolean }[] {
    return convoBridge.chatView(this.app)?.convoAttention() ?? [];
  }

  /** Open the chat view on a specific conversation (Cockpit "Resume" rows). */
  async openConvo(id: string): Promise<void> {
    await this.activateView();
    // Two-step, not `?? false`: with no view there is nothing to report missing.
    const view = convoBridge.chatView(this.app);
    if (view && !view.openConvoById(id)) new Notice("Conversation not found — it may have been deleted.");
  }

  /** Deterministic production pipeline. Background-AI settings never gate it. */
  async generateDailyPulse(now: number = Date.now()): Promise<{
    warnings: DailyPulseCollectionWarning[];
    itemCount: number;
  }> {
    const pulseState = this.settings.dailyPulseReviewState;
    const generated = await generateAndWriteDailyPulse({
      taskStore: this.taskStore,
      loadLoops: async () => {
        const file = this.app.vault.getAbstractFileByPath(this.paths.openLoops);
        if (!(file instanceof TFile)) return [];
        return parseLoopsFile(await this.app.vault.read(file));
      },
      proposalStore: this.proposalStore,
      loadAutomationRuns: () => this.loadAutomationRuns(),
      listRecentNotes: async ({ modifiedAfter, limit }) =>
        this.app.vault.getMarkdownFiles()
          .filter((file) => file.stat.mtime > modifiedAfter && file.stat.mtime <= now)
          .sort((a, b) => b.stat.mtime - a.stat.mtime || a.path.localeCompare(b.path))
          .slice(0, limit)
          .map((file) => ({ path: file.path, mtime: file.stat.mtime })),
      loadBackgroundBudget: async () => ({
        enabled: this.settings.backgroundPassesEnabled,
        dailyBudget: this.settings.backgroundDailyTokenBudget,
        ledger: { ...this.settings.backgroundBudgetLedger },
      }),
    }, {
      read: async (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile ? this.app.vault.read(file) : null;
      },
      write: async (path, content) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          await this.app.vault.modify(file, content);
          return;
        }
        await this.ensureParentFolders(path);
        await this.app.vault.create(path, content);
      },
    }, this.dailyPulseWriteQueue, {
      now,
      lastPulseAt: pulseState.lastSuccessAt || null,
      configDir: this.app.vault.configDir,
    }, this.paths);

    return {
      warnings: generated.warnings,
      itemCount: generated.pulse.sections.reduce(
        (total, section) => total + section.items.length,
        0
      ),
    };
  }

  private async persistDailyPulseSuccess(options: {
    completedAt: number;
    attemptedAt: number;
    warnings: DailyPulseCollectionWarning[];
    itemCount: number;
    config?: AutomationConfig;
    reviewed?: boolean;
  }): Promise<void> {
    const lastRunKey = options.config ? automationLastRunKey(options.config) : null;
    const priorLastRun = lastRunKey ? this.settings.scheduledLastRun[lastRunKey] : undefined;
    const priorReviewState = this.settings.dailyPulseReviewState;
    const nextReviewState = dailyPulseReviewAfterRun(
      priorReviewState,
      {
        status: "succeeded",
        completedAt: options.completedAt,
        warningCount: options.warnings.length,
      },
      options.attemptedAt,
      options.warnings,
      options.itemCount
    );
    if (options.reviewed) nextReviewState.lastReviewedAt = options.completedAt;
    if (lastRunKey) this.settings.scheduledLastRun[lastRunKey] = options.completedAt;
    this.settings.dailyPulseReviewState = nextReviewState;
    try {
      await this.saveSettings();
    } catch (error) {
      if (lastRunKey) {
        if (priorLastRun === undefined) delete this.settings.scheduledLastRun[lastRunKey];
        else this.settings.scheduledLastRun[lastRunKey] = priorLastRun;
      }
      this.settings.dailyPulseReviewState = priorReviewState;
      throw error;
    }
  }

  private async generateAndPersistDailyPulse(now: number, reviewed = false): Promise<boolean> {
    return this.dailyPulseOperationQueue.enqueue(async () => {
      try {
        const generated = await this.generateDailyPulse(now);
        await this.persistDailyPulseSuccess({
          completedAt: now,
          attemptedAt: now,
          warnings: generated.warnings,
          itemCount: generated.itemCount,
          config: this.automationStore.list().map(legacyConfigFromAutomation).find((c) => c && isDailyPulseAutomation(c)) ?? undefined,
          reviewed,
        });
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.settings.dailyPulseReviewState = dailyPulseReviewAfterRun(
          this.settings.dailyPulseReviewState,
          { status: "failed", error: message, retryable: true },
          now
        );
        try {
          await this.saveSettings();
        } catch (saveError) {
          console.warn("[Exo] Daily Pulse error state could not be saved:", saveError);
        }
        return false;
      }
    });
  }

  /** Explicit user-triggered refresh. It is allowed while the schedule is paused. */
  async runDailyPulseNow(now: number = Date.now()): Promise<boolean> {
    const ok = await this.generateAndPersistDailyPulse(now);
    await this.refreshCockpit();
    return ok;
  }

  /** Pull surface: generate on first explicit open, then mark current items reviewed. */
  async openDailyPulse(): Promise<void> {
    const reviewPath = this.paths.review;
    let file = this.app.vault.getAbstractFileByPath(reviewPath);
    if (!(file instanceof TFile)) {
      const ok = await this.generateAndPersistDailyPulse(Date.now(), true);
      if (!ok) {
        await this.refreshCockpit();
        new Notice("Daily Pulse could not be refreshed. Retry from Automations.");
        return;
      }
      file = this.app.vault.getAbstractFileByPath(reviewPath);
    }
    if (!(file instanceof TFile)) {
      await this.refreshCockpit();
      new Notice("Daily Pulse review note is unavailable.");
      return;
    }
    await this.app.workspace.openLinkText(reviewPath, "", "tab");
    await this.dailyPulseOperationQueue.enqueue(async () => {
      const state = this.settings.dailyPulseReviewState;
      if (state.lastSuccessAt > state.lastReviewedAt) {
        state.lastReviewedAt = Date.now();
        await this.saveSettings();
      }
    });
    await this.refreshCockpit();
  }

  private async openDailyPulseTarget(params: Record<string, string>): Promise<void> {
    switch (params.target) {
      case "task":
        if (this.settings.orchestrationEnabled) await this.activateBoard();
        else await this.app.workspace.openLinkText(this.paths.tasks, "", "tab");
        return;
      case "loop":
        await this.app.workspace.openLinkText(this.paths.openLoops, "", "tab");
        return;
      case "proposal":
        await this.openProposalsModal();
        return;
      case "automation":
        void this.activateHub("automations");
        return;
      case "note":
        if (params.path) await this.app.workspace.openLinkText(params.path, "", "tab");
        return;
    }
  }

  private async runScheduledDailyPulse(
    config: AutomationConfig,
    now: number
  ): Promise<void> {
    await this.dailyPulseOperationQueue.enqueue(async () => {
      const lastRunKey = automationLastRunKey(config);
      let warnings: DailyPulseCollectionWarning[] = [];
      let itemCount = 0;
      const result = await this.dailyPulseSlotRunner.run({
        config,
        lastRun: this.settings.scheduledLastRun[lastRunKey] ?? 0,
        now,
        execute: async () => {
          const generated = await this.generateDailyPulse(now);
          warnings = generated.warnings;
          itemCount = generated.itemCount;
          return { warningCount: warnings.length };
        },
      });

      if (result.status === "disabled" || result.status === "current") return;
      if (result.status === "failed") {
        this.settings.dailyPulseReviewState = dailyPulseReviewAfterRun(
          this.settings.dailyPulseReviewState,
          result,
          now
        );
        await this.saveSettings();
        return;
      }

      await this.persistDailyPulseSuccess({
        completedAt: result.completedAt,
        attemptedAt: now,
        warnings,
        itemCount,
        config,
      });
    });
  }

  /**
   * The run machinery's view of the automation files: one `AgentDef` per
   * enabled, non-system automation, all run by `runAgent`. Brains without an
   * automation are NOT listed: see `automationDef`.
   */
  private automationDefs(): AgentDef[] {
    const out: AgentDef[] = [];
    for (const a of this.automationStore.list()) {
      if (a.system) continue; // Daily Pulse runs through its own slot runner
      const def = this.automationDef(a);
      if (def) out.push(def);
    }
    return out;
  }

  /**
   * One automation as an `AgentDef`. Agent-backed automations borrow the real
   * brain (and keep responding to @mentions with the automation's own powers);
   * a prompt-only automation gets an inline brain with no agent file
   * (`invocable` empty) whose prompt is the run's standing task. Null when the
   * bound brain was deleted: the hub shows the problem.
   *
   * A brain here carries a `note-mention` trigger, and an enabled one fires a
   * run because a human typed its name in a note. Only an agent bound to an
   * enabled automation answers a mention, which is the opt-in; mention alone
   * stays invocation (chat, `invoke_agent`, Run now).
   */
  private automationDef(a: Automation): AgentDef | null {
    const contract = contractFromAutomation(a);
    if (!a.agent) {
      return {
        brain: { slug: a.slug, name: a.name, invocable: "", description: a.description, source: "vault", prompt: a.prompt },
        contract,
      };
    }
    const real = this.agentStore.get(a.agent);
    if (!real) return null;
    return { brain: real.brain, contract: { ...contract, triggers: [...contract.triggers, { on: "note-mention" }] } };
  }

  private scheduledRunsBusy = false;
  private async checkScheduledRuns(): Promise<void> {
    if (this.scheduledRunsBusy) return;
    if (!this.automationStore.isLoaded()) return;
    this.scheduledRunsBusy = true;
    try {
      // System automations (Daily Pulse) keep their dedicated slot runner.
      for (const a of this.automationStore.list()) {
        if (!a.system || !a.enabled) continue;
        const legacy = legacyConfigFromAutomation(a);
        if (!legacy) continue;
        try {
          await this.runScheduledDailyPulse(legacy, Date.now());
        } catch (err) {
          console.warn("[Exo] Daily Pulse failed:", err);
        }
      }
      // Everything else — playbook or agent-backed — through the shared gates.
      const due = dueScheduledAgentRuns(this.automationDefs(), this.settings.scheduledLastRun, Date.now());
      for (const run of due) {
        await this.runDueAutomation(run);
      }
    } finally {
      this.scheduledRunsBusy = false;
    }
  }

  /** Manual "Run now" from the hub: bypasses the schedule and the enabled
   *  flag, but not the run gate (concurrency, budget, duplicates). `refused`
   *  says why nothing ran, as opposed to a run that failed. */
  async runAutomationNow(a: Automation): Promise<{ ok: boolean; refused?: string }> {
    if (a.system === "daily-pulse") return { ok: await this.generateAndPersistDailyPulse(Date.now()) };
    const def = this.automationDef(a);
    if (!def) {
      new Notice(`Agent "${a.agent}" not found.`);
      return { ok: false, refused: `agent "${a.agent}" not found` };
    }
    const runKey = `${agentLastRunKey(a.slug)}::manual`;
    const gate = this.gateRun(def, runKey, { manual: true });
    if (!gate.ok) {
      new Notice(`Can't run now: ${gate.detail}.`);
      return { ok: false, refused: gate.detail };
    }
    return { ok: await this.runAgent(def, "manual", runKey) };
  }

  /** Gate one due automation run, then hand it to `runAgent`. Sequential:
   *  one at a time. */
  private async runDueAutomation(run: DueAgentRun): Promise<void> {
    const gate = this.gateRun(run.agent, run.runKey);
    if (!gate.ok) {
      this.diag.push("automations", `run skipped (${gate.reason}): ${gate.detail}`);
      return;
    }
    await this.runAgent(run.agent, run.reason, run.runKey);
  }

  /* ------------------------------ agent runs ----------------------------- */

  /** Estimated output tokens of one unattended agent run — the budget gate's
   *  input, mirroring PROPOSAL_TOKEN_ESTIMATE for the proposal pass. */
  private static readonly AGENT_RUN_TOKEN_ESTIMATE = 4000;
  /** Agent runs are sequential today (one CLI process at a time), so the cap is
   *  1; the gate is written against a number so raising it is a one-line change. */
  private static readonly AGENT_MAX_CONCURRENT = 1;
  /** Run keys currently queued or executing — the dedupe set for `gateAgentRun`. */
  private readonly agentRunsInFlight = new Set<string>();

  /** The one run gate every entry point (schedule, Run now, picker, delegation)
   *  passes through, so none of them can skip the budget or concurrency check. */
  private gateRun(agent: AgentDef, runKey: string, mode: { manual?: boolean; nested?: boolean } = {}): RunGate {
    return gateAgentRun({
      agent,
      lastRunAt: this.settings.scheduledLastRun[agentLastRunKey(agent.brain.slug)] ?? 0,
      now: Date.now(),
      running: this.agentRunsInFlight.size,
      maxConcurrent: ExoPlugin.AGENT_MAX_CONCURRENT,
      inFlightKeys: this.agentRunsInFlight,
      runKey,
      budgetAvailable: this.checkBackgroundBudget(ExoPlugin.AGENT_RUN_TOKEN_ESTIMATE),
      canSpawn: !Platform.isMobile,
      ...mode,
    });
  }

  /**
   * Execute one agent run through the headless profile — the same bounded
   * executor automations use, so read-only auto-allow, snapshot-before-write,
   * the per-step watchdog and Restore all come for free.
   *
   * Stamping both cursors on success (and only on success) is what makes
   * catch-up correct: a failed run stays due and retries on the next heartbeat.
   */
  async runAgent(
    agent: AgentDef,
    reason: string,
    runKey?: string,
    by = "exo",
    task?: { from: string; text: string },
    callerDepth = 0
  ): Promise<boolean> {
    const key = runKey ?? `${agentLastRunKey(agent.brain.slug)}::manual`;
    if (this.agentRunsInFlight.has(key)) return false;
    this.agentRunsInFlight.add(key);
    const name = agentRunName(agent, reason);
    const startedAt = Date.now();
    const today = new Date(startedAt).toISOString().slice(0, 10);
    const write = writeModeFor(agent.contract.autonomy);
    // A prompt-only automation: an inline brain with no agent file to delegate to.
    const inline = !agent.brain.invocable;
    const propose = proposeEligible(agent.contract, this.settings.proposalKernelEnabled);
    try {
      new Notice(`${agent.brain.name} — running (${reason})…`);
      const memory = await this.agentStore.loadMemory(agent, today);
      // This run's tools delegate as this agent, one level deeper than its caller.
      const headlessOpts: HeadlessOpts = {
        write,
        agentCaller: { slug: agent.brain.slug, depth: callerDepth + 1 },
        codexBridge: await this.headlessBridge(),
      };
      // Claude delegates to a true isolated subagent via an inline Agent()
      // instruction (buildAgentRunPrompt). Codex has no such primitive — its own
      // `collabAgentToolCall` is unrelated and has no notion of a named persona
      // file — so a Codex run instead adopts the agent's own instructions as
      // this session's system prompt and gets a plain first-person task prompt.
      // An inline brain has neither a subagent nor instructions to adopt: both
      // engines get the direct prompt with its own prompt as the task.
      const prompt =
        this.settings.provider === "codex" || inline
          ? buildDirectAgentRunPrompt(agent, reason, memory, task, this.paths.reports, propose)
          : buildAgentRunPrompt(agent, reason, memory, task, this.paths.reports, propose);
      if (this.settings.provider === "codex" && !inline) {
        headlessOpts.systemPrompt = buildAgentSystemPrompt(
          agent.brain,
          await readAgentBrainBody(this.app, agent.brain)
        );
      }
      const result = await runHeadlessPlaybook(this.app, this.settings, prompt, headlessOpts);
      // Unattended writes join the git safety net exactly like a chat turn's.
      if (result.writes.length) this.noteVaultWrite(result.writes);
      const proposed = propose ? await this.collectAgentProposals(agent, result.output, startedAt) : 0;
      // A note is earned, not automatic. An agent watching a folder runs far
      // more often than it finds anything, and a report per run turns a quiet
      // vault into a pile of files saying "no action needed". Anything that
      // actually happened — a write, a proposal, a failure — still gets its
      // report; only a run that declared itself empty is silent, and the ledger
      // records it either way.
      const substantive =
        !result.ok || result.writes.length > 0 || proposed > 0 || !isEmptyRun(result.output);
      // `output` decides WHERE the account goes; `substantive` decides WHETHER
      // there is one. A failure always writes a report whatever the mode — the
      // error has to land somewhere a human can find it.
      const wantsReport = substantive && (agent.contract.output === "report" || !result.ok);
      const path = wantsReport ? await writeReport(this.app, name, result, this.paths.reports) : "";
      const journalled =
        substantive && result.ok && agent.contract.output === "journal"
          ? await this.journalAgentRun(agent, result.output, startedAt)
          : false;
      // Write runs join the existing review/restore queue rather than a parallel
      // one, so a bad agent write is rolled back the same way as a bad playbook.
      // Only a run that actually wrote earns a restore record. An `act` agent
      // that decided nothing needed doing would otherwise leave a Restore
      // button that restores nothing — an affordance promising a rollback it
      // has no work to perform.
      // Recorded either way (see runPlaybook) — but only a run that actually
      // wrote earns a restore id. An `act` agent that decided nothing needed
      // doing would otherwise leave a Restore button with nothing to roll back.
      const recordId = await this.recordAutomationRun(name, startedAt, result, path, agent.contract.slug);
      const restoreId = write && result.writes.length > 0 ? recordId : null;
      // The ledger records every run, successful or not — a failed run that
      // leaves no trace is how a quietly broken agent stays invisible.
      await this.agentStore.appendRun({
        id: agentRunId(agent.brain.slug, startedAt),
        slug: agent.brain.slug,
        name: agent.brain.name,
        startedAt,
        durationMs: Date.now() - startedAt,
        outcome: result.ok ? "ok" : "failed",
        trigger: reason,
        tier: agent.contract.autonomy,
        ...(path ? { report: path } : {}),
        ...(restoreId ? { restoreId } : {}),
        writes: result.writes,
        by,
        ...(substantive ? {} : { summary: "Nothing to report." }),
      });
      if (result.ok) {
        const now = Date.now();
        this.settings.scheduledLastRun[key] = now;
        this.settings.scheduledLastRun[agentLastRunKey(agent.brain.slug)] = now;
        // A standing run (a schedule slot, or Run now) covers every schedule
        // slot, so running by hand at 06:59 is not repeated by the 07:00 slot.
        // Event runs and delegated tasks are not the standing job: they don't.
        const slots = scheduleSlotKeys(agent);
        if (!task && (reason === "manual" || slots.includes(key))) {
          for (const slot of slots) this.settings.scheduledLastRun[slot] = now;
        }
        await this.saveSettings();
      }
      this.recordBackgroundSpend(ExoPlugin.AGENT_RUN_TOKEN_ESTIMATE);
      const proposalNote = proposed > 0 ? ` · ${proposed} proposal${proposed === 1 ? "" : "s"} to review` : "";
      // A silent run gets a silent notice too — a toast per no-op is the same
      // interruption as a note per no-op.
      if (!result.ok) new Notice(`${agent.brain.name} failed (report: ${path})`);
      else if (wantsReport) new Notice(`${agent.brain.name} done → ${path}${proposalNote}`);
      else if (journalled) new Notice(`${agent.brain.name} — logged to today's daily note${proposalNote}`);
      // Prompt-only automations keep the playbook runs' OS notification.
      if (inline && path) this.notifyReportReady(name, result.ok, path);
      return result.ok;
    } catch (err) {
      console.warn(`[Exo] agent "${agent.brain.slug}" run failed:`, err);
      new Notice(`${agent.brain.name} — run failed.`);
      return false;
    } finally {
      this.agentRunsInFlight.delete(key);
    }
  }

  /**
   * Leave a run's one-line account in today's daily note.
   *
   * Returns whether a line landed — false when the run had nothing to say, or
   * when there is no daily note for today. Never creates the note: an agent
   * gets a section of a file the user already keeps, not a new file.
   */
  private async journalAgentRun(agent: AgentDef, output: string, at: number): Promise<boolean> {
    const summary = extractJournalLine(output);
    if (!summary) return false;
    const path = todayDailyNotePath(this.app);
    if (!path) return false;
    return this.agentStore.appendJournal(path, journalLine(agent.brain.name, at, summary));
  }

  /**
   * Turn a `propose` run's structured block into pending kernel proposals.
   *
   * This is what makes the `propose` tier worth having: instead of reading a
   * report and re-doing the work by hand, the run's conclusions land in the
   * existing proposals inbox with one-click accept — routed through the same
   * validated, deduplicated, inert channel as every other producer. The kernel
   * still disposes; the agent only proposes.
   *
   * The extraction/validation/persistence itself is `collectRunProposals`
   * (core/agent-runs.ts). Called only for a `proposeEligible` run, the same
   * rule that gave its prompt the contract.
   */
  private async collectAgentProposals(agent: AgentDef, output: string, startedAt: number): Promise<number> {
    return collectRunProposals(
      output,
      {
        convoId: `agent:${agent.brain.slug}`,
        turnId: agentRunId(agent.brain.slug, startedAt),
        createdAt: startedAt,
      },
      { store: this.proposalStore, diagnostic: (msg, err) => this.diag.push("agents", err ? `${msg}: ${err}` : msg) }
    );
  }

  /**
   * Hand work from one agent to another. Returns a human-readable result string
   * for the tool, never throws.
   *
   * This is the capability Notion does not have: its agents cannot call each
   * other at all, and chaining has to be faked through database triggers. Here
   * it is a gated tool call, with the whole chain recorded in the run ledger.
   */
  async invokeAgentFromAgent(target: string, task: string, from: AgentCaller = EXO_CALLER): Promise<string> {
    if (!(await this.agentsReady())) return "Named agents are disabled in Exo settings.";
    const { slug: caller, depth } = from;
    const callee = this.agentStore.resolve(target);
    // The caller's powers come from its automation file (can_call lives
    // there since v2); an unbound agent has no delegation allowlist.
    const callerAgent =
      caller === "exo" ? null : this.automationDefs().find((d) => d.brain.slug === caller) ?? null;

    const gate = gateAgentInvoke(caller, callee, callerAgent, depth);
    if (!gate.ok) return `Refused (${gate.reason}): ${gate.detail}.`;

    const runKey = `${agentLastRunKey(callee!.brain.slug)}::from:${caller}`;
    // A human asking through chat is a manual call; an agent asking is nested.
    const runGate = this.gateRun(callee!, runKey, { manual: caller === "exo", nested: caller !== "exo" });
    if (!runGate.ok) return `Refused (${runGate.reason}): ${runGate.detail}.`;

    const ok = await this.runAgent(callee!, `invoked by ${caller}`, runKey, caller, { from: caller, text: task }, depth);
    return ok
      ? `${callee!.brain.name} ran and reported to ${this.paths.reports}/. The run is in the agent ledger.`
      : `${callee!.brain.name} ran but did not finish cleanly — see the report in ${this.paths.reports}/.`;
  }

  /** "Run agent…" — pick an agent and run it now. A manual run bypasses the
   *  cooldown and the enabled flag (a human asked for it) but still respects
   *  concurrency and the background budget. */
  private async promptRunAgent(): Promise<void> {
    if (!(await this.agentsReady())) {
      new Notice("Named agents are off — enable them in Exo settings.");
      return;
    }
    const agents = this.agentStore.list();
    if (!agents.length) {
      new Notice("No agents found. Canonical vault agents live in _system/agents/<slug>/ bundles.");
      return;
    }
    new AgentPicker(this.app, agents, (agent) => {
      const runKey = `${agentLastRunKey(agent.brain.slug)}::manual`;
      const gate = this.gateRun(agent, runKey, { manual: true });
      if (!gate.ok) {
        new Notice(`Can't run now — ${gate.detail}.`);
        return;
      }
      void this.runAgent(agent, "manual", runKey);
    }).open();
  }

  /* --------------------------- automation runs --------------------------- */

  /** Sidecar (plugin dir) holding restorable write-run records — not vault
   *  notes: snapshots are machine state, not knowledge. */
  private automationRunsPath(): string {
    return `${this.manifest.dir}/automation-runs.json`;
  }

  async loadAutomationRuns(): Promise<AutomationRunRecord[]> {
    try {
      const raw = await this.app.vault.adapter.read(this.automationRunsPath());
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as AutomationRunRecord[]) : [];
    } catch {
      return []; // missing/corrupt file → empty history, never a blocked run
    }
  }

  /** Every change to the run history: one serialized read-modify-write, so two
   *  runs finishing together cannot drop each other's record. An unreadable
   *  file is kept aside as a copy, never overwritten, and a new history starts
   *  so later write runs still get their restore points. */
  private updateAutomationRuns(change: (records: AutomationRunRecord[]) => AutomationRunRecord[]): Promise<void> {
    return this.automationRunsWriteQueue.enqueue(async () => {
      const { adapter } = this.app.vault;
      const path = this.automationRunsPath();
      const raw = (await adapter.exists(path)) ? await adapter.read(path) : "[]";
      let records: AutomationRunRecord[] = [];
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error("not a run list");
        records = parsed as AutomationRunRecord[];
      } catch {
        const copy = `${this.manifest.dir}/automation-runs.corrupt-${Date.now()}.json`;
        await adapter.write(copy, raw);
        new Notice(`Exo: the automation run history was unreadable. A copy is in ${copy}; a new history starts now.`);
      }
      await adapter.write(path, JSON.stringify(change(records)));
    });
  }

  /** Persist one write-run record. Oversized snapshots are dropped (the report
   *  already flags what can't be auto-restored); history pruned to the last 20. */
  private async recordAutomationRun(
    name: string,
    startedAt: number,
    result: HeadlessResult,
    reportPath: string,
    slug?: string
  ): Promise<string | null> {
    try {
      const checkpoint = [...result.checkpoint.entries()].filter(
        ([, v]) => v === null || v.length <= MAX_AUTOMATION_SNAPSHOT
      );
      const rec: AutomationRunRecord = {
        id: `${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        startedAt,
        ok: result.ok,
        reportPath,
        writes: result.writes,
        checkpoint,
        slug,
      };
      await this.updateAutomationRuns((records) => pruneRuns([rec, ...records], 60));
      return rec.id;
    } catch (err) {
      console.warn("[Exo] couldn't persist the automation run record:", err);
      return null;
    }
  }

  /** Revert every file an automation run touched to its pre-run snapshot. */
  async restoreAutomationRun(id: string): Promise<string[]> {
    const rec = (await this.loadAutomationRuns()).find((r) => r.id === id);
    if (!rec) {
      new Notice("Run record not found — it may have been pruned.");
      return [];
    }
    const restored = await restoreRun(this.app, rec.checkpoint);
    const restoredAt = Date.now();
    // The notes are already back; failing to stamp the record must not hide that.
    await this.updateAutomationRuns((records) => records.map((r) => (r.id === id ? { ...r, restoredAt } : r)))
      .catch((err) => console.warn("[Exo] couldn't mark the run as restored:", err));
    new Notice(
      restored.length
        ? `Restored ${restored.length} note${restored.length === 1 ? "" : "s"} from "${rec.name}".`
        : `Nothing restorable in "${rec.name}".`
    );
    return restored;
  }

  /** Mark a write run as reviewed — it leaves the Cockpit "to review" pool. */
  async markAutomationRunReviewed(id: string): Promise<void> {
    const reviewedAt = Date.now();
    await this.updateAutomationRuns((records) => records.map((r) => (r.id === id ? { ...r, reviewedAt } : r)));
  }

}
