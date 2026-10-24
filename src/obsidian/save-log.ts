import type { SaveReceipt } from "../core/save-undo";
import { WriteQueue } from "../core/write-queue";
import type { LogFile } from "./harvest-log";

/** Receipts kept: enough to undo a session's saves. */
export const MAX_SAVES = 50;

/**
 * Receipts of "Save to note", in the plugin folder (`note-saves.json`): not in
 * the vault, not synced. Exact lines only, never a note body. Serialized
 * through one queue; a log that no longer parses is moved aside first.
 */
export class SaveLog {
  private readonly queue = new WriteQueue();

  constructor(private readonly file: LogFile) {}

  async list(): Promise<SaveReceipt[]> {
    try {
      const raw = await this.file.read();
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? (parsed as SaveReceipt[]) : [];
    } catch {
      return [];
    }
  }

  private async load(): Promise<SaveReceipt[]> {
    const raw = await this.file.read();
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as SaveReceipt[];
    } catch {
      /* fall through */
    }
    await this.file.preserveCorrupt(raw);
    return [];
  }

  record(r: SaveReceipt): Promise<void> {
    return this.queue.enqueue(async () => {
      const all = await this.load();
      await this.file.write(JSON.stringify([r, ...all].slice(0, MAX_SAVES)));
    });
  }

  /** Receipts not yet undone, newest first: what "Undo a save to note..." offers. */
  async undoable(): Promise<SaveReceipt[]> {
    return (await this.list()).filter((r) => !r.undoneAt);
  }

  async find(id: string): Promise<SaveReceipt | undefined> {
    return (await this.list()).find((r) => r.id === id);
  }

  markUndone(id: string, at: number): Promise<void> {
    return this.queue.enqueue(async () => {
      const all = await this.load();
      await this.file.write(JSON.stringify(all.map((r) => (r.id === id ? { ...r, undoneAt: at } : r))));
    });
  }
}
