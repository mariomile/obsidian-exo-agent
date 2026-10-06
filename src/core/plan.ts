/**
 * Pure helpers for the plan-approval card (Trust Pack). The CLI's ExitPlanMode
 * tool arrives through Exo's `permission-request` event; its input shape was
 * verified live against the SDK (spike): `{ plan: string (markdown),
 * planFilePath: string (absolute path to a saved copy) }`. `view.ts` renders
 * whatever `planInputParts` extracts; if the markdown is inline (the observed
 * case) no file read is needed, otherwise the caller reads `filePath`.
 */

export interface PlanInputParts {
  /** Inline plan markdown from `input.plan`, when present. */
  md: string | null;
  /** Absolute path to a saved plan file from `input.planFilePath`, when present. */
  filePath: string | null;
}

/** Extract the plan markdown + optional file path from an ExitPlanMode input,
 *  tolerating a few plausible field names in case the SDK shape shifts. */
export function planInputParts(input: unknown): PlanInputParts {
  const rec = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const md =
    typeof rec.plan === "string" && rec.plan.trim()
      ? rec.plan
      : typeof rec.markdown === "string" && rec.markdown.trim()
        ? rec.markdown
        : null;
  const filePath =
    typeof rec.planFilePath === "string" && rec.planFilePath.trim()
      ? rec.planFilePath
      : typeof rec.planPath === "string" && rec.planPath.trim()
        ? rec.planPath
        : null;
  return { md, filePath };
}

/** One-line recap summary for a persisted plan segment (used by buildRecap). */
export function planRecapLabel(approved: boolean | null): string {
  if (approved === true) return "[plan: approved]";
  if (approved === false) return "[plan: revised]";
  return "[plan: pending]";
}

/** Settled state line shown on a resolved plan card. `building` adds the live
 *  "— building" nuance right after approval; restored cards pass it false. */
export function planStateText(approved: boolean | null, building = false, handedOff = false): string {
  if (handedOff) return "Implemented in";
  if (approved === true) return building ? "Plan approved — building" : "Plan approved";
  if (approved === false) return "Revision requested";
  return "Plan proposed";
}

/**
 * The first and only message of a "Build in new chat" child, as in T3 Code's
 * "Implement in new thread": the approved plan, nothing of the conversation
 * that produced it, so the build starts with a clean context.
 */
export function planHandoffPrompt(md: string): string {
  return `Implement this plan.\n\n${md.trim()}`;
}

/** What the planning chat's agent is told when its plan leaves for a new chat. */
export const PLAN_HANDOFF_DENY =
  "The user approved this plan and is building it in a separate chat. Stop here: do not implement it in this chat.";
