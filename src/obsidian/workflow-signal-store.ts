import type { WriteQueue } from "../core/write-queue";
import {
  EMPTY_WORKFLOW_SIGNAL_LEDGER,
  recordWorkflowOccurrence,
  type RecordWorkflowOptions,
  type RecordWorkflowResult,
  type WorkflowIntent,
  type WorkflowSignal,
  type WorkflowSignalLedger,
} from "../core/workflow-signals";

export interface WorkflowSignalStoreAdapter {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}

const INTENTS = new Set<WorkflowIntent>([
  "research",
  "summarize",
  "write",
  "edit",
  "plan",
  "analysis",
  "organize",
  "automate",
  "communicate",
  "task",
  "other",
]);

const TOOLS = new Set([
  "vault.search",
  "vault.read",
  "vault.list",
  "vault.write",
  "web.search",
  "web.fetch",
  "shell",
  "skill",
  "agent",
  "external.mcp",
  "capability.other",
]);

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9:_-]{1,160}$/.test(value);
}

function isWorkflowSignal(value: unknown): value is WorkflowSignal {
  if (!value || typeof value !== "object") return false;
  const signal = value as Partial<WorkflowSignal>;
  return isSafeId(signal.id)
    && typeof signal.signature === "string"
    && /^[a-z.-]+\|[a-z.>-]+\|[a-z-]+$/.test(signal.signature)
    && typeof signal.intent === "string"
    && INTENTS.has(signal.intent)
    && Array.isArray(signal.tools)
    && signal.tools.every((tool) => typeof tool === "string" && TOOLS.has(tool))
    && typeof signal.createdAt === "number"
    && Number.isFinite(signal.createdAt)
    && signal.createdAt >= 0
    && isSafeId(signal.convoId)
    && isSafeId(signal.turnId)
    && typeof signal.succeeded === "boolean";
}

/** The stored ledger, or null when the file exists but is not one: readers
 *  treat that as empty, a writer must leave it alone. */
function readLedger(raw: string | null): WorkflowSignalLedger | null {
  if (!raw) return { version: 1, signals: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<WorkflowSignalLedger>;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.signals)) return null;
    return { version: 1, signals: parsed.signals.filter(isWorkflowSignal) };
  } catch {
    return null;
  }
}

export function parseWorkflowSignalLedger(raw: string | null): WorkflowSignalLedger {
  return readLedger(raw) ?? { version: 1, signals: [] };
}

export class WorkflowSignalStore {
  constructor(
    private readonly adapter: WorkflowSignalStoreAdapter,
    private readonly queue: WriteQueue
  ) {}

  async load(): Promise<WorkflowSignalLedger> {
    return parseWorkflowSignalLedger(await this.adapter.read());
  }

  record(
    signal: WorkflowSignal,
    now: number,
    options: RecordWorkflowOptions = {}
  ): Promise<RecordWorkflowResult> {
    return this.queue.enqueue(async () => {
      const ledger = readLedger(await this.adapter.read());
      if (!ledger) throw new Error("workflow signal ledger is unreadable; left untouched");
      const result = recordWorkflowOccurrence(ledger, signal, now, options);
      if (JSON.stringify(result.ledger) !== JSON.stringify(ledger)) {
        await this.adapter.write(JSON.stringify(result.ledger, null, 2));
      }
      return result;
    });
  }
}

export { EMPTY_WORKFLOW_SIGNAL_LEDGER };
