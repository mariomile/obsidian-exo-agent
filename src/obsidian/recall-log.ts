import type { App } from "obsidian";
import type { RecallLogEntry } from "../core/grounding";
import { WriteQueue } from "../core/write-queue";
import type { LogFile } from "./harvest-log";

/** Entries kept: enough turns for `eval:grounding` to say something. */
export const MAX_RECALL_ENTRIES = 500;

/**
 * What each turn's recall injected, in the plugin folder (`recall-log.json`):
 * Exo's bookkeeping, never synced. Paths only, no note bodies. Serialized
 * through one queue; a log that no longer parses is moved aside first.
 */
export class RecallLog {
  private readonly queue = new WriteQueue();

  constructor(private readonly file: LogFile) {}

  async list(): Promise<RecallLogEntry[]> {
    try {
      const raw = await this.file.read();
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? (parsed as RecallLogEntry[]) : [];
    } catch {
      return [];
    }
  }

  private async load(): Promise<RecallLogEntry[]> {
    const raw = await this.file.read();
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as RecallLogEntry[];
    } catch {
      /* fall through */
    }
    await this.file.preserveCorrupt(raw);
    return [];
  }

  append(entry: RecallLogEntry): Promise<void> {
    return this.queue.enqueue(async () => {
      const all = await this.load();
      await this.file.write(JSON.stringify([...all, entry].slice(-MAX_RECALL_ENTRIES)));
    });
  }
}

const logs = new WeakMap<App, Map<string, RecallLog>>();

/** The one log for a plugin folder (vault-relative), so every turn shares its queue. */
export function recallLogFor(app: App, pluginDir: string): RecallLog {
  const forApp = logs.get(app) ?? new Map<string, RecallLog>();
  logs.set(app, forApp);
  let log = forApp.get(pluginDir);
  if (!log) {
    const path = `${pluginDir}/recall-log.json`;
    const adapter = app.vault.adapter;
    log = new RecallLog({
      read: async () => ((await adapter.exists(path)) ? adapter.read(path) : null),
      write: (content) => adapter.write(path, content),
      preserveCorrupt: (content) => adapter.write(`${pluginDir}/recall-log.corrupt-${Date.now()}.json`, content),
    });
    forApp.set(pluginDir, log);
  }
  return log;
}
