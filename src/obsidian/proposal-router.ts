/**
 * Explicit side-effect router for proposals being written to their targets:
 * memory kinds right after they are validated, action kinds once the user accepts.
 *
 * The router owns no persistence primitives itself. Production wiring injects
 * the existing queued/raw-preserving stores, while tests use structural fakes.
 * Every dependency failure is converted to a route result so ProposalStore can
 * leave the record pending, keep the error, and offer Retry.
 */
import type { ProposalPayload, ProposalRecord } from "../core/proposals";
import type { NewBacklogTask } from "../core/tasks";
import type { ProposalRouteResult } from "./proposal-store";

export type ProposalAcceptanceResult = ProposalRouteResult;

export interface OpenLoopCreateInput {
  proposalId: string;
  title: string;
  note: string;
  resurface?: string;
  tags?: string[];
}

export interface DecisionCaptureInput {
  proposalId: string;
  title: string;
  context: string;
  decision: string;
  rationale: string;
}

export interface ProposalAcceptanceDeps {
  /** The shared TaskStore.create surface; never write tasks.md in this router. */
  tasks: {
    create(task: NewBacklogTask & { proposalId: string }): Promise<{ id: string }>;
  };
  /** Production implementation must use the shared Open Loops WriteQueue. */
  loops: {
    create(loop: OpenLoopCreateInput): Promise<{ id: string; path: string }>;
  };
  /** Production implementation must create the decision with raw-preserving frontmatter patching. */
  decisions: {
    captureRawPreserving(decision: DecisionCaptureInput): Promise<{ path: string }>;
  };
  /**
   * `save` is the serialized settings mutation boundary. It must re-check the
   * requested name case-insensitively inside its serialized operation and may
   * return a further-disambiguated name if another save won a race.
   */
  playbooks: {
    save(playbook: { proposalId: string; name: string; prompt: string }): Promise<{ name: string }>;
  };
}

function failure(error: unknown): ProposalAcceptanceResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    error: message || "Proposal routing failed.",
  };
}

/** Compile-time exhaustiveness guard which also remains safe for corrupt runtime data. */
function unsupportedPayload(payload: never): ProposalAcceptanceResult {
  const kind = (payload as { kind?: unknown } | null)?.kind;
  return {
    ok: false,
    error: typeof kind === "string"
      ? `Unsupported proposal payload kind "${kind}".`
      : "Invalid proposal payload.",
  };
}

/** Route one proposal through its safe store. Never throws. */
export async function routeAcceptedProposal(
  record: ProposalRecord,
  deps: ProposalAcceptanceDeps
): Promise<ProposalAcceptanceResult> {
  try {
    const rawPayload = record.payload as unknown;
    if (typeof rawPayload !== "object" || rawPayload === null || Array.isArray(rawPayload)) {
      return { ok: false, error: "Invalid proposal payload." };
    }
    const payloadKind = (rawPayload as { kind?: unknown }).kind;
    if (typeof payloadKind !== "string") {
      return { ok: false, error: "Invalid proposal payload." };
    }
    if (record.kind !== payloadKind) {
      return {
        ok: false,
        error: `Proposal kind "${record.kind}" does not match payload kind "${payloadKind}".`,
      };
    }

    const payload = rawPayload as ProposalPayload;
    switch (payload.kind) {
      case "task": {
        const created = await deps.tasks.create({
          proposalId: record.id,
          title: payload.title,
          prompt: payload.prompt,
          ...(payload.model ? { model: payload.model } : {}),
        });
        return { ok: true, target: created.id };
      }
      case "loop": {
        const created = await deps.loops.create({
          proposalId: record.id,
          title: payload.title,
          note: payload.note,
          ...(payload.resurface ? { resurface: payload.resurface } : {}),
          ...(payload.tags?.length ? { tags: payload.tags } : {}),
        });
        return { ok: true, target: created.id, path: created.path };
      }
      case "decision": {
        const created = await deps.decisions.captureRawPreserving({
          proposalId: record.id,
          title: payload.title,
          context: payload.context,
          decision: payload.decision,
          rationale: payload.rationale ?? record.rationale,
        });
        return { ok: true, target: created.path };
      }
      case "playbook": {
        const created = await deps.playbooks.save({ proposalId: record.id, name: payload.name, prompt: payload.prompt });
        return { ok: true, target: created.name };
      }
      default:
        return unsupportedPayload(payload);
    }
  } catch (error) {
    return failure(error);
  }
}
