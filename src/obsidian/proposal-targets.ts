/**
 * Production-safe side-effect targets for accepted proposals.
 *
 * The targets depend only on structural adapters so their read-modify-write
 * guarantees can be tested without loading Obsidian. Plugin wiring must pass
 * the same shared queues used by the existing Open Loops and settings paths.
 */
import { formatLoop, parseLoopsFile, type LoopEntry } from "../core/open-loops";
import { patchFrontmatter } from "../core/frontmatter-patch";
import { uniquePlaybookName } from "../core/learning-loop";
import { exoPaths, LEGACY_MEMORY_ROOT } from "../core/paths";
import type { WriteQueue } from "../core/write-queue";
import type {
  DecisionCaptureInput,
  OpenLoopCreateInput,
  ProposalAcceptanceDeps,
} from "./proposal-router";

type OpenLoopTarget = ProposalAcceptanceDeps["loops"];
type TaskTarget = ProposalAcceptanceDeps["tasks"];
type DecisionTarget = ProposalAcceptanceDeps["decisions"];
type PlaybookTarget = ProposalAcceptanceDeps["playbooks"];

/** Legacy defaults for tests/fallback; the live plugin passes `plugin.paths`. */
export const OPEN_LOOPS_PATH = exoPaths(LEGACY_MEMORY_ROOT).openLoops;
export const DECISIONS_DIR = exoPaths(LEGACY_MEMORY_ROOT).decisions;

/** Invisible durable key carried by Markdown-backed proposal targets. */
export function proposalMarker(proposalId: string): string {
  return `<!-- exo-proposal:${encodeURIComponent(proposalId)} -->`;
}

function withMarker(content: string, proposalId: string): string {
  return `${content.trimEnd()}\n\n${proposalMarker(proposalId)}`;
}

/** Structural slice of TaskStore needed for atomic create-or-return. */
export interface ProposalTaskStore {
  createOnce(task: { title: string; prompt: string; model?: string }, marker: string): Promise<{ id: string }>;
}

export class TaskProposalTarget implements TaskTarget {
  constructor(private readonly tasks: ProposalTaskStore) {}

  create(input: Parameters<TaskTarget["create"]>[0]): Promise<{ id: string }> {
    const marker = proposalMarker(input.proposalId);
    return this.tasks.createOnce({
      title: input.title,
      prompt: withMarker(input.prompt, input.proposalId),
      ...(input.model ? { model: input.model } : {}),
    }, marker);
  }
}

/** Minimal shared vault surface used by both file-backed proposal targets. */
export interface ProposalTargetVaultAdapter {
  getFile(path: string): { path: string } | null;
  read(path: string): Promise<string>;
  create(path: string, content: string): Promise<void>;
  modify(path: string, content: string): Promise<void>;
  /** Ensure the parent directory for this file path exists. */
  ensureFolder(path: string): Promise<void>;
}

/** Open Loops target. Every create is a fresh queued read-modify-write. */
export class OpenLoopProposalTarget implements OpenLoopTarget {
  constructor(
    private readonly vault: ProposalTargetVaultAdapter,
    private readonly queue: WriteQueue,
    /** Called with each memory file written, so git autocommit covers it. */
    private readonly noteWrite: (paths: readonly string[]) => void,
    private readonly now: () => number = Date.now,
    private readonly openLoopsPath: string = OPEN_LOOPS_PATH
  ) {}

  create(input: OpenLoopCreateInput): Promise<{ id: string; path: string }> {
    return this.queue.enqueue(async () => {
      const existing = this.vault.getFile(this.openLoopsPath);
      const current = existing ? await this.vault.read(this.openLoopsPath) : "";
      const entries = current ? parseLoopsFile(current) : [];
      const marker = proposalMarker(input.proposalId);
      const prior = entries.find(({ note }) => note.includes(marker));
      if (prior) return { id: prior.id, path: this.openLoopsPath };

      // Date.now() alone can collide when two proposals are accepted in the
      // same millisecond. Re-check against the freshly-read ledger while still
      // inside the shared queue and advance the numeric suffix until unused.
      const taken = new Set(entries.map(({ id }) => id));
      let openedAt = this.now();
      while (taken.has(`loop-${openedAt}`)) openedAt++;

      const entry: LoopEntry = {
        id: `loop-${openedAt}`,
        title: input.title,
        note: withMarker(input.note, input.proposalId),
        openedAt,
        status: "open",
        ...(input.resurface ? { resurface: input.resurface } : {}),
        ...(input.tags?.length ? { tags: input.tags } : {}),
      };
      const content = `${[...entries, entry].map(formatLoop).join("\n\n")}\n`;

      if (existing) {
        await this.vault.modify(this.openLoopsPath, content);
      } else {
        await this.vault.ensureFolder(this.openLoopsPath);
        await this.vault.create(this.openLoopsPath, content);
      }
      this.noteWrite([this.openLoopsPath]);
      return { id: entry.id, path: this.openLoopsPath };
    });
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled";
}

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Decision target which never normalizes unrelated YAML through Obsidian. */
export class DecisionProposalTarget implements DecisionTarget {
  constructor(
    private readonly vault: ProposalTargetVaultAdapter,
    /** Called with each memory file written, so git autocommit covers it. */
    private readonly noteWrite: (paths: readonly string[]) => void,
    private readonly now: () => Date = () => new Date(),
    private readonly decisionsDir: string = DECISIONS_DIR
  ) {}

  async captureRawPreserving(input: DecisionCaptureInput): Promise<{ path: string }> {
    const date = localDate(this.now());
    const path = `${this.decisionsDir}/${date}-${slugify(input.title)}.md`;
    if (this.vault.getFile(path)) {
      const current = await this.vault.read(path);
      if (current.includes(proposalMarker(input.proposalId))) return { path };
      throw new Error(`Already exists: ${path}`);
    }

    const body =
      `# Decision: ${input.title}\n\n` +
      `## Contesto\n${input.context}\n\n` +
      `## Decisione\n${input.decision}\n\n` +
      `## Razionale\n${input.rationale}\n\n` +
      `${proposalMarker(input.proposalId)}\n`;
    const content = patchFrontmatter(body, {
      type: "decision",
      created_by: "exo",
      created: date,
      tags: ["type/decision"],
    });

    await this.vault.ensureFolder(path);
    // `create` is the final collision guard. A race rejects here rather than
    // falling back to modify, so an existing decision is never overwritten.
    await this.vault.create(path, content);
    this.noteWrite([path]);
    return { path };
  }
}

export interface ProposalPlaybookSettings {
  customPrompts: { name: string; prompt: string }[];
  proposalPlaybookReceipts?: Record<string, string>;
}

/** Live settings access; the getter prevents a stale settings snapshot. */
export interface ProposalPlaybookAccess {
  settings(): ProposalPlaybookSettings;
  saveSettings(): Promise<void>;
}

/** Serialized playbook target with a collision re-check inside its queue turn. */
export class PlaybookProposalTarget implements PlaybookTarget {
  constructor(
    private readonly queue: WriteQueue,
    private readonly access: ProposalPlaybookAccess
  ) {}

  save(playbook: { proposalId: string; name: string; prompt: string }): Promise<{ name: string }> {
    return this.queue.enqueue(async () => {
      const settings = this.access.settings();
      const receipts = settings.proposalPlaybookReceipts ??= {};
      const prior = receipts[playbook.proposalId];
      if (prior) return { name: prior };
      const name = uniquePlaybookName(
        playbook.name,
        settings.customPrompts.map(({ name: existing }) => existing)
      );
      const saved = { name, prompt: playbook.prompt };
      settings.customPrompts.push(saved);
      receipts[playbook.proposalId] = name;
      try {
        await this.access.saveSettings();
      } catch (error) {
        // Keep live memory aligned with durable settings when persistence
        // fails. The router will convert the rejection into a retry result.
        const index = settings.customPrompts.indexOf(saved);
        if (index >= 0) settings.customPrompts.splice(index, 1);
        delete receipts[playbook.proposalId];
        throw error;
      }
      return { name };
    });
  }
}

export interface ProposalAcceptanceTargetOptions {
  /** The plugin's one shared TaskStore instance. */
  tasks: ProposalTaskStore;
  vault: ProposalTargetVaultAdapter;
  /** The plugin's shared Open Loops queue. */
  loopsWriteQueue: WriteQueue;
  /** A queue dedicated to the complete settings mutation + save boundary. */
  playbooksWriteQueue: WriteQueue;
  playbooks: ProposalPlaybookAccess;
  nowMs?: () => number;
  nowDate?: () => Date;
  /** Open-loops ledger path (`paths.openLoops`). Absent → the legacy location. */
  openLoopsPath?: string;
  /** Decisions dir (`paths.decisions`). Absent → the legacy location. */
  decisionsDir?: string;
  /** Called with each memory file a proposal wrote, so git autocommit covers it. */
  noteWrite: (paths: readonly string[]) => void;
}

/** Build the exact dependency object consumed by `routeAcceptedProposal`. */
export function createProposalAcceptanceDeps(
  options: ProposalAcceptanceTargetOptions
): ProposalAcceptanceDeps {
  return {
    tasks: new TaskProposalTarget(options.tasks),
    loops: new OpenLoopProposalTarget(
      options.vault,
      options.loopsWriteQueue,
      options.noteWrite,
      options.nowMs,
      options.openLoopsPath ?? OPEN_LOOPS_PATH
    ),
    decisions: new DecisionProposalTarget(
      options.vault,
      options.noteWrite,
      options.nowDate,
      options.decisionsDir ?? DECISIONS_DIR
    ),
    playbooks: new PlaybookProposalTarget(options.playbooksWriteQueue, options.playbooks),
  };
}
