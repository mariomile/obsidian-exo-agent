/**
 * Proposal Kernel — pure parsing, validation, deduplication and retention.
 *
 * This module deliberately has no Obsidian imports and performs no IO. Model
 * output enters through `parseProposalCandidates`; only validated records may
 * later be routed to a side-effecting store. Memory kinds (loop, decision) are
 * routed as soon as they are validated and deduped; action kinds (task,
 * playbook) are routed only once the user accepts them.
 */

export type ProposalKind = "task" | "loop" | "decision" | "playbook";
/**
 * Memory kinds (open-loops ledger, decisions) are written the moment they are
 * validated and deduped: review happens after the fact, never before. Actions
 * (`task`, `playbook`) stay pending until the user accepts.
 */
export function isMemoryProposalKind(kind: ProposalKind): boolean {
  return kind === "loop" || kind === "decision";
}

export type ProposalStatus = "pending" | "accepted" | "dismissed";

export type ProposalPayload =
  | { kind: "task"; title: string; prompt: string; model?: string }
  | { kind: "loop"; title: string; note: string; resurface?: string; tags?: string[] }
  | { kind: "decision"; title: string; context: string; decision: string; rationale?: string }
  | {
      kind: "playbook";
      name: string;
      prompt: string;
      /** Optional Workflow Foundry metadata; ignored by dedup and the router. */
      outcome?: string;
      inputs?: string[];
      capabilities?: string[];
      why?: string;
      workflowSignature?: string;
    };

export interface ProposalRecord {
  id: string;
  kind: ProposalKind;
  status: ProposalStatus;
  title: string;
  payload: ProposalPayload;
  rationale: string;
  fingerprint: string;
  source: {
    convoId: string;
    turnId: string;
    createdAt: number;
  };
  resolvedAt?: number;
  /** Last routing failure while the record stayed pending; cleared on success. */
  lastError?: string;
}

/** A validated, still-inert proposal before persistence assigns identity/source. */
export interface ProposalCandidate {
  kind: ProposalKind;
  title: string;
  payload: ProposalPayload;
  rationale: string;
}

export type ProposalValidationCode =
  | "invalid_json"
  | "expected_array"
  | "too_many"
  | "invalid_type"
  | "invalid_kind"
  | "required"
  | "too_long"
  | "invalid_date";

export interface ProposalValidationError {
  code: ProposalValidationCode;
  path: string;
  message: string;
}

/** Shared result shape for parser/validation and duplicate classification. */
export type ProposalResult<T> =
  | { status: "ok"; value: T }
  | { status: "invalid"; errors: ProposalValidationError[] }
  | { status: "duplicate"; value: T; duplicateOf: ProposalRecord };

export type ProposalParseResult<T> =
  | { status: "ok"; value: T }
  | { status: "invalid"; errors: ProposalValidationError[] };

type ValidationResult<T> = ProposalParseResult<T>;

export const PROPOSAL_LIMITS = {
  candidates: 3,
  title: 120,
  rationale: 500,
  content: 4_000,
  resolvedRetentionDays: 30,
  resolvedRecords: 200,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

function validationError(
  code: ProposalValidationCode,
  path: string,
  message: string
): ValidationResult<never> {
  return { status: "invalid", errors: [{ code, path, message }] };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredString(
  object: Record<string, unknown>,
  key: string,
  path: string,
  max: number
): ValidationResult<string> {
  const value = object[key];
  if (typeof value !== "string") {
    return validationError("invalid_type", path, `${key} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) return validationError("required", path, `${key} is required`);
  if (trimmed.length > max) {
    return validationError("too_long", path, `${key} must be at most ${max} characters`);
  }
  return { status: "ok", value: trimmed };
}

function optionalString(
  object: Record<string, unknown>,
  key: string,
  path: string,
  max?: number
): ValidationResult<string | undefined> {
  if (object[key] === undefined) return { status: "ok", value: undefined };
  return requiredString(object, key, path, max ?? Number.MAX_SAFE_INTEGER);
}

/** Calendar-valid local date, intentionally independent of runtime timezone. */
export function isValidLocalDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function parseTags(object: Record<string, unknown>, path: string): ValidationResult<string[] | undefined> {
  const value = object.tags;
  if (value === undefined) return { status: "ok", value: undefined };
  if (!Array.isArray(value)) return validationError("invalid_type", path, "tags must be an array of strings");
  const tags: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const tag: unknown = value[index];
    if (typeof tag !== "string") {
      return validationError("invalid_type", `${path}[${index}]`, "tag must be a string");
    }
    const trimmed = tag.trim();
    if (!trimmed) return validationError("required", `${path}[${index}]`, "tag cannot be empty");
    tags.push(trimmed);
  }
  return { status: "ok", value: tags };
}

/** Validate an optional array of trimmed, non-empty, length-capped strings. */
function parseStringArray(
  object: Record<string, unknown>,
  key: string,
  path: string,
  max: number
): ValidationResult<string[] | undefined> {
  const value = object[key];
  if (value === undefined) return { status: "ok", value: undefined };
  if (!Array.isArray(value)) return validationError("invalid_type", path, `${key} must be an array of strings`);
  const items: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const item: unknown = value[index];
    if (typeof item !== "string") {
      return validationError("invalid_type", `${path}[${index}]`, `${key} entries must be strings`);
    }
    const trimmed = item.trim();
    if (!trimmed) return validationError("required", `${path}[${index}]`, `${key} entries cannot be empty`);
    if (trimmed.length > max) {
      return validationError("too_long", `${path}[${index}]`, `${key} entries must be at most ${max} characters`);
    }
    items.push(trimmed);
  }
  return { status: "ok", value: items };
}

/** Foundry signatures are opaque machine strings; length-cap them and trust no further. */
const WORKFLOW_SIGNATURE_MAX = 200;

function validateCandidate(value: unknown, index: number): ValidationResult<ProposalCandidate> {
  const path = `$[${index}]`;
  const object = asObject(value);
  if (!object) return validationError("invalid_type", path, "candidate must be an object");
  if (typeof object.kind !== "string") {
    return validationError("invalid_type", `${path}.kind`, "kind must be a string");
  }

  const rationale = requiredString(object, "rationale", `${path}.rationale`, PROPOSAL_LIMITS.rationale);
  if (rationale.status !== "ok") return rationale;

  switch (object.kind) {
    case "task": {
      const title = requiredString(object, "title", `${path}.title`, PROPOSAL_LIMITS.title);
      if (title.status !== "ok") return title;
      const prompt = requiredString(object, "prompt", `${path}.prompt`, PROPOSAL_LIMITS.content);
      if (prompt.status !== "ok") return prompt;
      const model = optionalString(object, "model", `${path}.model`);
      if (model.status !== "ok") return model;
      return {
        status: "ok",
        value: {
          kind: "task",
          title: title.value,
          payload: {
            kind: "task",
            title: title.value,
            prompt: prompt.value,
            ...(model.value ? { model: model.value } : {}),
          },
          rationale: rationale.value,
        },
      };
    }
    case "loop": {
      const title = requiredString(object, "title", `${path}.title`, PROPOSAL_LIMITS.title);
      if (title.status !== "ok") return title;
      const note = requiredString(object, "note", `${path}.note`, PROPOSAL_LIMITS.content);
      if (note.status !== "ok") return note;
      const resurface = optionalString(object, "resurface", `${path}.resurface`, 10);
      if (resurface.status !== "ok") return resurface;
      if (resurface.value && !isValidLocalDate(resurface.value)) {
        return validationError("invalid_date", `${path}.resurface`, "resurface must be a valid local YYYY-MM-DD date");
      }
      const tags = parseTags(object, `${path}.tags`);
      if (tags.status !== "ok") return tags;
      return {
        status: "ok",
        value: {
          kind: "loop",
          title: title.value,
          payload: {
            kind: "loop",
            title: title.value,
            note: note.value,
            ...(resurface.value ? { resurface: resurface.value } : {}),
            ...(tags.value ? { tags: tags.value } : {}),
          },
          rationale: rationale.value,
        },
      };
    }
    case "decision": {
      const title = requiredString(object, "title", `${path}.title`, PROPOSAL_LIMITS.title);
      if (title.status !== "ok") return title;
      const context = requiredString(object, "context", `${path}.context`, PROPOSAL_LIMITS.content);
      if (context.status !== "ok") return context;
      const decision = requiredString(object, "decision", `${path}.decision`, PROPOSAL_LIMITS.content);
      if (decision.status !== "ok") return decision;
      return {
        status: "ok",
        value: {
          kind: "decision",
          title: title.value,
          payload: {
            kind: "decision",
            title: title.value,
            context: context.value,
            decision: decision.value,
            rationale: rationale.value,
          },
          rationale: rationale.value,
        },
      };
    }
    case "playbook": {
      const name = requiredString(object, "name", `${path}.name`, PROPOSAL_LIMITS.title);
      if (name.status !== "ok") return name;
      const prompt = requiredString(object, "prompt", `${path}.prompt`, PROPOSAL_LIMITS.content);
      if (prompt.status !== "ok") return prompt;
      const outcome = optionalString(object, "outcome", `${path}.outcome`, PROPOSAL_LIMITS.rationale);
      if (outcome.status !== "ok") return outcome;
      const why = optionalString(object, "why", `${path}.why`, PROPOSAL_LIMITS.rationale);
      if (why.status !== "ok") return why;
      const workflowSignature = optionalString(object, "workflowSignature", `${path}.workflowSignature`, WORKFLOW_SIGNATURE_MAX);
      if (workflowSignature.status !== "ok") return workflowSignature;
      const inputs = parseStringArray(object, "inputs", `${path}.inputs`, PROPOSAL_LIMITS.title);
      if (inputs.status !== "ok") return inputs;
      const capabilities = parseStringArray(object, "capabilities", `${path}.capabilities`, PROPOSAL_LIMITS.title);
      if (capabilities.status !== "ok") return capabilities;
      return {
        status: "ok",
        value: {
          kind: "playbook",
          title: name.value,
          payload: {
            kind: "playbook",
            name: name.value,
            prompt: prompt.value,
            ...(outcome.value ? { outcome: outcome.value } : {}),
            ...(inputs.value ? { inputs: inputs.value } : {}),
            ...(capabilities.value ? { capabilities: capabilities.value } : {}),
            ...(why.value ? { why: why.value } : {}),
            ...(workflowSignature.value ? { workflowSignature: workflowSignature.value } : {}),
          },
          rationale: rationale.value,
        },
      };
    }
    default:
      return validationError("invalid_kind", `${path}.kind`, `unsupported proposal kind: ${object.kind}`);
  }
}

/** Strip exactly one optional markdown code fence, rejecting all other prose. */
function unwrapJson(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

/** Parse a strict JSON array containing zero to three validated candidates. */
export function parseProposalCandidates(raw: string): ProposalParseResult<ProposalCandidate[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapJson(raw));
  } catch {
    return validationError("invalid_json", "$", "output must contain only a valid JSON array");
  }
  if (!Array.isArray(parsed)) return validationError("expected_array", "$", "output must be a JSON array");
  if (parsed.length > PROPOSAL_LIMITS.candidates) {
    return validationError("too_many", "$", `at most ${PROPOSAL_LIMITS.candidates} candidates are allowed`);
  }

  const candidates: ProposalCandidate[] = [];
  for (let index = 0; index < parsed.length; index++) {
    const result = validateCandidate(parsed[index], index);
    if (result.status !== "ok") return result;
    candidates.push(result.value);
  }
  return { status: "ok", value: candidates };
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

function canonicalPayload(payload: ProposalPayload): string {
  switch (payload.kind) {
    case "task":
      return [payload.kind, payload.title, payload.prompt, payload.model ?? ""].map(normalize).join("\u001f");
    case "loop":
      return [
        payload.kind,
        payload.title,
        payload.note,
        payload.resurface ?? "",
        [...(payload.tags ?? [])].map(normalize).sort().join("\u001e"),
      ].map(normalize).join("\u001f");
    case "decision":
      return [payload.kind, payload.title, payload.context, payload.decision, payload.rationale ?? ""].map(normalize).join("\u001f");
    case "playbook":
      return [payload.kind, payload.name, payload.prompt].map(normalize).join("\u001f");
  }
}

/** Stable two-lane FNV-1a fingerprint over normalized kind, target and content. */
export function fingerprintProposal(payload: ProposalPayload): string {
  const input = canonicalPayload(payload);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `proposal-v1-${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

function resolutionTime(record: ProposalRecord): number {
  return record.resolvedAt ?? record.source.createdAt;
}

/**
 * Pending records always deduplicate. Accepted records deduplicate through the
 * inclusive 30-day window; dismissed and older accepted records do not.
 */
export function evaluateProposal(
  candidate: ProposalCandidate,
  existing: readonly ProposalRecord[],
  now: number
): ProposalResult<ProposalCandidate> {
  const fingerprint = fingerprintProposal(candidate.payload);
  const cutoff = now - PROPOSAL_LIMITS.resolvedRetentionDays * DAY_MS;
  const duplicate = existing.find((record) =>
    record.fingerprint === fingerprint
    && (record.status === "pending" || (record.status === "accepted" && resolutionTime(record) >= cutoff))
  );
  return duplicate
    ? { status: "duplicate", value: candidate, duplicateOf: duplicate }
    : { status: "ok", value: candidate };
}

/** Keep all pending plus the newest 200 resolved records from the last 30 days. */
export function pruneProposalRecords(
  records: readonly ProposalRecord[],
  now: number
): ProposalRecord[] {
  const cutoff = now - PROPOSAL_LIMITS.resolvedRetentionDays * DAY_MS;
  const pending = records.filter((record) => record.status === "pending");
  const resolved = records
    .filter((record) => record.status !== "pending" && resolutionTime(record) >= cutoff)
    .sort((a, b) => resolutionTime(b) - resolutionTime(a))
    .slice(0, PROPOSAL_LIMITS.resolvedRecords);
  return [...pending, ...resolved];
}

/** One quiet line suitable for a compact inbox/list preview. */
export function formatProposalPreview(candidate: ProposalCandidate, maxLength = 180): string {
  const kind = `${candidate.kind[0].toUpperCase()}${candidate.kind.slice(1)}`;
  const rationale = candidate.rationale.replace(/\s+/g, " ").trim();
  const preview = `${kind} · ${candidate.title}${rationale ? ` — ${rationale}` : ""}`;
  if (preview.length <= maxLength) return preview;
  return `${preview.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
