import { App, TFile } from "obsidian";
import type { WriteQueue } from "../core/write-queue";
import { AGENT_DIR, isAgentBlock, type BlockName } from "../core/agent-self";

/**
 * The Agent Is the Folder — Obsidian-side block IO for the agent folder.
 *
 * The pure identity logic (registry, manifest parse, `compileIdentity`)
 * lives in `src/core/agent-self.ts`. This module is the thin,
 * impure glue that reads and writes the three block files through the SHARED
 * store write-queue, capturing a before-image so every governed write surfaces a
 * diff-with-undo in the activity feed (non-negotiable #4). It never decides
 * policy: the `rethink_memory` tool has already enforced the block's
 * rationale rule; this just enacts a block replacement and hands back the undo
 * snapshot.
 */

/** Snapshot of a block file taken immediately BEFORE a governed write — the
 *  undo target. `before === null` means the write CREATED the file. */
export interface BlockSnapshot {
  path: string;
  before: string | null;
}

/** Result of a governed block write: the previous content (for the feed diff)
 *  and the snapshot needed to undo it. */
export interface BlockWrite {
  block: BlockName;
  path: string;
  /** The content that was on disk before this write (""` when the file was created). */
  previous: string;
  /** The content this write put on disk. */
  next: string;
  snapshot: BlockSnapshot;
}

/** One block's current on-disk state. */
export interface BlockState {
  content: string;
  mtime?: number;
}

/** The vault path of a block file inside the identity-layer folder (e.g.
 *  `<agentDir>/NOW.md`). `agentDir` defaults to the configured location. */
export function blockPath(block: BlockName, agentDir: string = AGENT_DIR): string {
  return `${agentDir}/${block}.md`;
}

/**
 * Obsidian-side reader/writer for the identity blocks. Constructed with the
 * SHARED memory write-queue so its writes serialize against memory harvest
 * (single FIFO, no cross-writer clobber, w1-1).
 */
export class AgentFolder {
  constructor(
    private readonly app: App,
    /** THE shared store write-queue (plugin-scoped). */
    private readonly queue: WriteQueue,
    /** Identity-layer folder (`paths.agentDir`). Defaults to the legacy location. */
    private readonly agentDir: string = AGENT_DIR
  ) {}

  /** Read one block's content + mtime, or null when the file is absent/unreadable. */
  async readBlock(block: BlockName): Promise<BlockState | null> {
    const f = this.app.vault.getAbstractFileByPath(blockPath(block, this.agentDir));
    if (!(f instanceof TFile)) return null;
    try {
      return { content: await this.app.vault.cachedRead(f), mtime: f.stat?.mtime };
    } catch {
      return null;
    }
  }

  /**
   * Replace a block's WHOLE content through the write-queue, capturing a
   * before-image. This is the single governed write path for every block
   * (direct rewrite); the tier check happens upstream. Missing block file →
   * created (previous = ""); existing → modified. Returns the write descriptor
   * (previous + snapshot) so the caller can render the feed diff and wire undo.
   */
  async writeBlock(block: BlockName, next: string): Promise<BlockWrite> {
    const path = blockPath(block, this.agentDir);
    let previous = "";
    let before: string | null = null;
    await this.queue.enqueue(async () => {
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        before = await this.app.vault.read(existing);
        previous = before;
        await this.app.vault.modify(existing, ensureTrailingNewline(next));
      } else {
        before = null;
        previous = "";
        await this.ensureParentFolder(path);
        await this.app.vault.create(path, ensureTrailingNewline(next));
      }
    });
    return { block, path, previous, next, snapshot: { path, before } };
  }

  /**
   * Undo a governed block write by restoring its before-image, through the queue
   * so it can't interleave with a concurrent write. When the write CREATED the
   * file (`before === null`) the file is deleted; otherwise the previous content
   * is restored verbatim. Unlike the store's exact-tail undo, a block is a WHOLE
   * document owned solely by this path, so a straight before-image restore is
   * correct (last-writer-wins is documented; snapshot+undo is the recovery, §3).
   */
  async undo(write: BlockWrite): Promise<void> {
    await this.queue.enqueue(async () => {
      const f = this.app.vault.getAbstractFileByPath(write.snapshot.path);
      if (write.snapshot.before === null) {
        if (f instanceof TFile) await this.app.fileManager.trashFile(f);
        return;
      }
      if (f instanceof TFile) {
        await this.app.vault.modify(f, write.snapshot.before);
      } else {
        await this.ensureParentFolder(write.snapshot.path);
        await this.app.vault.create(write.snapshot.path, write.snapshot.before);
      }
    });
  }

  /** Create any missing parent folders for a vault path. */
  private async ensureParentFolder(path: string): Promise<void> {
    const slash = path.lastIndexOf("/");
    if (slash <= 0) return;
    const dir = path.slice(0, slash);
    if (this.app.vault.getAbstractFileByPath(dir)) return;
    try {
      await this.app.vault.createFolder(dir);
    } catch {
      /* already exists (race) — fine */
    }
  }
}

/** Idempotently guarantee exactly one trailing newline (block files are plain md). */
function ensureTrailingNewline(s: string): string {
  return `${s.replace(/\s+$/, "")}\n`;
}

/** Narrow an arbitrary string to a {@link BlockName} (tool-arg validation). */
export function asBlockName(s: string): BlockName | null {
  return isAgentBlock(s) ? s : null;
}
