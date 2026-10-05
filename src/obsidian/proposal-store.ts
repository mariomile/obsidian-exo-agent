import {
  evaluateProposal,
  fingerprintProposal,
  isMemoryProposalKind,
  parseProposalCandidates,
  pruneProposalRecords,
  type ProposalCandidate,
  type ProposalRecord,
  type ProposalValidationError,
} from "../core/proposals";
import { WriteQueue } from "../core/write-queue";

export const PROPOSALS_FILE = "proposals.json";

export interface ProposalMetrics {
  generated: number;
  accepted: number;
  dismissed: number;
  duplicates: number;
  parseErrors: number;
  routeErrors: number;
}

export type ProposalMetric = keyof ProposalMetrics;

export interface ProposalStoreData {
  version: 1;
  records: ProposalRecord[];
  metrics: ProposalMetrics;
}

export interface ProposalStoreSnapshot {
  data: ProposalStoreData;
  warnings: string[];
}

export interface PendingProposals {
  records: ProposalRecord[];
  metrics: ProposalMetrics;
  warnings: string[];
}

/**
 * Adapter rooted at the plugin directory. Production wiring can back this
 * with Obsidian's adapter or Node IO; tests need no Obsidian runtime.
 */
export interface ProposalFileAdapter {
  /** Return null when the relative plugin file does not exist. */
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
}

export type AppendProposalResult =
  | { status: "appended"; record: ProposalRecord }
  | { status: "duplicate"; duplicateOf: ProposalRecord }
  | { status: "invalid"; errors: ProposalValidationError[] };

export type ProposalRouteResult =
  | { ok: true; target: string }
  | { ok: false; error: string };

export type ProposalAcceptResult =
  | { ok: true; target: string; record: ProposalRecord; alreadyAccepted?: boolean }
  | { ok: false; error: string; record: ProposalRecord };

interface ParsedStore {
  data: ProposalStoreData;
  warnings: string[];
  quarantined: unknown[];
  /** Mutations refuse to overwrite an unreadable or incompatible whole file. */
  corrupt: boolean;
}

const METRIC_KEYS: readonly ProposalMetric[] = [
  "generated",
  "accepted",
  "dismissed",
  "duplicates",
  "parseErrors",
  "routeErrors",
];

function emptyMetrics(): ProposalMetrics {
  return {
    generated: 0,
    accepted: 0,
    dismissed: 0,
    duplicates: 0,
    parseErrors: 0,
    routeErrors: 0,
  };
}

function emptyData(): ProposalStoreData {
  return { version: 1, records: [], metrics: emptyMetrics() };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function candidateInput(candidate: ProposalCandidate): Record<string, unknown> {
  return { ...candidate.payload, rationale: candidate.rationale };
}

/** Reuse the kernel validator and return its sanitized candidate. */
function validateCandidate(candidate: ProposalCandidate) {
  return parseProposalCandidates(JSON.stringify([candidateInput(candidate)]));
}

function parseRecord(value: unknown): ProposalRecord | undefined {
  const object = asObject(value);
  if (!object) return undefined;
  if (typeof object.id !== "string" || !object.id.trim()) return undefined;
  if (object.status !== "pending" && object.status !== "accepted" && object.status !== "dismissed") return undefined;
  if (typeof object.rationale !== "string") return undefined;
  if (typeof object.fingerprint !== "string") return undefined;

  const source = asObject(object.source);
  if (!source
    || typeof source.convoId !== "string" || !source.convoId.trim()
    || typeof source.turnId !== "string" || !source.turnId.trim()
    || typeof source.createdAt !== "number" || !Number.isFinite(source.createdAt)) return undefined;

  const candidateResult = parseProposalCandidates(JSON.stringify([{
    ...asObject(object.payload),
    rationale: object.rationale,
  }]));
  if (candidateResult.status !== "ok" || candidateResult.value.length !== 1) return undefined;
  const candidate = candidateResult.value[0];
  if (object.kind !== candidate.kind || object.title !== candidate.title) return undefined;
  if (object.fingerprint !== fingerprintProposal(candidate.payload)) return undefined;

  const resolvedAt = object.resolvedAt;
  if (object.status !== "pending" && (typeof resolvedAt !== "number" || !Number.isFinite(resolvedAt))) return undefined;

  return {
    id: object.id,
    kind: candidate.kind,
    status: object.status,
    title: candidate.title,
    payload: candidate.payload,
    rationale: candidate.rationale,
    fingerprint: object.fingerprint,
    source: {
      convoId: source.convoId,
      turnId: source.turnId,
      createdAt: source.createdAt,
    },
    ...(object.status !== "pending" ? { resolvedAt: resolvedAt as number } : {}),
  };
}

function parseMetrics(value: unknown, warnings: string[]): ProposalMetrics {
  const object = asObject(value);
  const metrics = emptyMetrics();
  if (!object) {
    warnings.push("Proposal metrics are invalid; using zero values.");
    return metrics;
  }
  for (const key of METRIC_KEYS) {
    const metric = object[key];
    if (typeof metric === "number" && Number.isInteger(metric) && metric >= 0) {
      metrics[key] = metric;
    } else {
      warnings.push(`Proposal metric ${key} is invalid; using zero.`);
    }
  }
  return metrics;
}

function parseStore(raw: string): ParsedStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      data: emptyData(),
      warnings: [`Could not parse ${PROPOSALS_FILE}; the original file was left untouched.`],
      quarantined: [],
      corrupt: true,
    };
  }
  const object = asObject(parsed);
  if (!object || object.version !== 1 || !Array.isArray(object.records)) {
    return {
      data: emptyData(),
      warnings: [`${PROPOSALS_FILE} has an unsupported or invalid schema; the original file was left untouched.`],
      quarantined: [],
      corrupt: true,
    };
  }

  const warnings: string[] = [];
  const records: ProposalRecord[] = [];
  const quarantined: unknown[] = [];
  object.records.forEach((value, index) => {
    const record = parseRecord(value);
    if (record) records.push(record);
    else {
      quarantined.push(value);
      warnings.push(`Proposal record ${index} is invalid and was logically quarantined.`);
    }
  });
  return {
    data: { version: 1, records: pruneProposalRecords(records, Date.now()), metrics: parseMetrics(object.metrics, warnings) },
    warnings,
    quarantined,
    corrupt: false,
  };
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function proposalId(candidate: ProposalCandidate, source: ProposalRecord["source"], existing: readonly ProposalRecord[]): string {
  const fingerprint = fingerprintProposal(candidate.payload);
  const base = `proposal-${source.createdAt}-${stableHash(`${source.convoId}\u001f${source.turnId}\u001f${fingerprint}`)}`;
  let id = base;
  let suffix = 2;
  while (existing.some((record) => record.id === id)) id = `${base}-${suffix++}`;
  return id;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Versioned, durable proposal inbox. Every mutation re-reads and writes inside
 * one dedicated injected WriteQueue, preventing lost updates across producers
 * and acceptance UI actions.
 */
export class ProposalStore {
  private readonly acceptFlights = new Map<string, Promise<ProposalAcceptResult>>();

  constructor(
    private readonly files: ProposalFileAdapter,
    private readonly queue: WriteQueue,
    /** Routes memory kinds (loop, decision) the moment they are appended. */
    private readonly autoRoute?: (record: ProposalRecord) => Promise<ProposalRouteResult>
  ) {}

  async load(): Promise<ProposalStoreSnapshot> {
    const parsed = await this.read();
    return { data: parsed.data, warnings: parsed.warnings };
  }

  async listPending(): Promise<PendingProposals> {
    const snapshot = await this.load();
    return {
      records: snapshot.data.records.filter((record) => record.status === "pending"),
      metrics: snapshot.data.metrics,
      warnings: snapshot.warnings,
    };
  }

  append(candidate: ProposalCandidate, source: ProposalRecord["source"]): Promise<AppendProposalResult> {
    const validated = validateCandidate(candidate);
    if (validated.status === "invalid") {
      return Promise.resolve({ status: "invalid", errors: validated.errors });
    }
    const clean = validated.value[0];
    return this.mutate<AppendProposalResult>(({ data }) => {
      data.metrics.generated += 1;
      const duplicate = evaluateProposal(clean, data.records, source.createdAt);
      if (duplicate.status === "duplicate") {
        data.metrics.duplicates += 1;
        return { status: "duplicate", duplicateOf: duplicate.duplicateOf };
      }
      const record: ProposalRecord = {
        id: proposalId(clean, source, data.records),
        kind: clean.kind,
        status: "pending",
        title: clean.title,
        payload: clean.payload,
        rationale: clean.rationale,
        fingerprint: fingerprintProposal(clean.payload),
        source: { ...source },
      };
      data.records.push(record);
      return { status: "appended", record };
    }).then((result) => this.routeMemoryRecord(result));
  }

  /**
   * Memory kinds skip the pending step: accept through the normal route right
   * after the append commits (never inside its queue turn). A failed route leaves
   * the record pending, so the inbox still offers Retry.
   */
  private async routeMemoryRecord(result: AppendProposalResult): Promise<AppendProposalResult> {
    if (result.status !== "appended" || !this.autoRoute || !isMemoryProposalKind(result.record.kind)) {
      return result;
    }
    const accepted = await this.accept(result.record.id, this.autoRoute);
    return { status: "appended", record: accepted.record };
  }

  accept(
    id: string,
    route: (record: ProposalRecord) => Promise<ProposalRouteResult>
  ): Promise<ProposalAcceptResult> {
    const active = this.acceptFlights.get(id);
    if (active) return active;
    const flight = this.mutate<ProposalAcceptResult>(async ({ data }) => {
      const record = data.records.find((candidate) => candidate.id === id);
      if (!record) throw new Error(`Proposal not found: ${id}`);
      if (record.status === "accepted") {
        return { ok: true, target: "", record, alreadyAccepted: true };
      }
      if (record.status === "dismissed") throw new Error(`Proposal already dismissed: ${id}`);

      let routed: ProposalRouteResult;
      try {
        routed = await route(record);
      } catch (error) {
        routed = { ok: false, error: message(error) };
      }
      if (!routed.ok) {
        data.metrics.routeErrors += 1;
        return { ok: false, error: routed.error, record };
      }
      record.status = "accepted";
      record.resolvedAt = Date.now();
      data.metrics.accepted += 1;
      return { ok: true, target: routed.target, record };
    });
    this.acceptFlights.set(id, flight);
    const clearFlight = () => {
      if (this.acceptFlights.get(id) === flight) this.acceptFlights.delete(id);
    };
    void flight.then(clearFlight, clearFlight);
    return flight;
  }

  dismiss(id: string, now = Date.now()): Promise<ProposalRecord> {
    return this.mutate(({ data }) => {
      const record = data.records.find((candidate) => candidate.id === id);
      if (!record) throw new Error(`Proposal not found: ${id}`);
      if (record.status === "dismissed") return record;
      if (record.status === "accepted") throw new Error(`Proposal already accepted: ${id}`);
      record.status = "dismissed";
      record.resolvedAt = now;
      data.metrics.dismissed += 1;
      return record;
    }, now);
  }

  /**
   * Apply a user's name/prompt edit to a still-pending playbook proposal.
   * The patch is re-validated through the kernel and the title/fingerprint are
   * recomputed so a later Accept routes the edited, persisted values. Foundry
   * metadata carried on the payload is preserved. Never accepts the record.
   */
  updatePendingPlaybook(id: string, patch: { name: string; prompt: string }): Promise<ProposalRecord> {
    return this.mutate(({ data }) => {
      const record = data.records.find((candidate) => candidate.id === id);
      if (!record) throw new Error(`Proposal not found: ${id}`);
      if (record.kind !== "playbook" || record.payload.kind !== "playbook") {
        throw new Error(`Proposal is not a playbook: ${id}`);
      }
      if (record.status !== "pending") throw new Error(`Proposal is not pending: ${id}`);

      const merged = { ...record.payload, name: patch.name, prompt: patch.prompt };
      const validated = parseProposalCandidates(JSON.stringify([{ ...merged, rationale: record.rationale }]));
      if (validated.status !== "ok" || validated.value.length !== 1) {
        const detail = validated.status === "invalid"
          ? validated.errors.map((error) => `${error.path}: ${error.message}`).join("; ")
          : "invalid playbook edit";
        throw new Error(`Invalid playbook edit: ${detail}`);
      }
      const clean = validated.value[0];
      record.title = clean.title;
      record.payload = clean.payload;
      record.fingerprint = fingerprintProposal(clean.payload);
      return record;
    });
  }

  /**
   * Workflow signatures already represented by a pending or accepted playbook.
   * The Foundry passes these as blocked signatures so a recurring workflow never
   * distills a second proposal while one is still waiting or already saved.
   */
  async blockedWorkflowSignatures(): Promise<Set<string>> {
    const snapshot = await this.load();
    const signatures = new Set<string>();
    for (const record of snapshot.data.records) {
      if (record.payload.kind !== "playbook") continue;
      if (record.status !== "pending" && record.status !== "accepted") continue;
      if (record.payload.workflowSignature) signatures.add(record.payload.workflowSignature);
    }
    return signatures;
  }

  recordMetric(metric: ProposalMetric, amount = 1): Promise<ProposalMetrics> {
    if (!Number.isInteger(amount) || amount < 0) {
      return Promise.reject(new Error("Metric amount must be a non-negative integer"));
    }
    return this.mutate(({ data }) => {
      data.metrics[metric] += amount;
      return { ...data.metrics };
    });
  }

  private async read(): Promise<ParsedStore> {
    let raw: string | null;
    try {
      raw = await this.files.read(PROPOSALS_FILE);
    } catch (error) {
      return {
        data: emptyData(),
        warnings: [`Could not read ${PROPOSALS_FILE}: ${message(error)}`],
        quarantined: [],
        corrupt: true,
      };
    }
    return raw === null
      ? { data: emptyData(), warnings: [], quarantined: [], corrupt: false }
      : parseStore(raw);
  }

  /** The single queued read-modify-write path used by every mutation. */
  private mutate<T>(
    apply: (store: ParsedStore) => T | Promise<T>,
    now = Date.now()
  ): Promise<T> {
    return this.queue.enqueue(async () => {
      const parsed = await this.read();
      if (parsed.corrupt) {
        throw new Error(`Refusing to overwrite corrupt ${PROPOSALS_FILE}`);
      }
      const result = await apply(parsed);
      parsed.data.records = pruneProposalRecords(parsed.data.records, now);
      await this.files.write(PROPOSALS_FILE, JSON.stringify({
        version: 1,
        records: [...parsed.data.records, ...parsed.quarantined],
        metrics: parsed.data.metrics,
      }, null, 2));
      return result;
    });
  }
}
