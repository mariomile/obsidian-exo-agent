/**
 * Codex session toolset: the pure half of the Codex ↔ Obsidian bridge's
 * sandbox honesty (no Obsidian imports).
 *
 * Bridge tool handlers run in the Obsidian process and BYPASS codex's own
 * sandbox, so a read-only sandbox must get read tools only. `ask_user` is the
 * deliberate exception: it mutates nothing (blocking the turn on a question
 * card is user interaction, not a write), and a read-only session that cannot
 * ask a clarifying question would be needlessly dumber than its Claude twin.
 *
 * When the sandbox is not read-only, the input array is returned AS-IS (same
 * reference): the tool list sent to sessions stays byte-identical to a build
 * where this function is not in the path.
 */

/** Interaction tools that stay in a read-only sandbox besides the read set.
 *  Exported so the approval router (`codex-approval.ts`) permits exactly what
 *  this filter offers: one list, so a tool can never be offered and then refused. */
export const INTERACTION_TOOLS = new Set(["ask_user"]);

const MCP_PREFIX = "mcp__obsidian__";

export function bridgeSessionToolset<T extends { name: string }>(
  all: T[],
  readOnlySandbox: boolean,
  readToolNames: Iterable<string>
): T[] {
  if (!readOnlySandbox) return all;
  const readBasenames = new Set(
    [...readToolNames].map((n) => (n.startsWith(MCP_PREFIX) ? n.slice(MCP_PREFIX.length) : n))
  );
  return all.filter((t) => readBasenames.has(t.name) || INTERACTION_TOOLS.has(t.name));
}

/**
 * Map ask-card answers to the id-keyed record a Codex app-server reply needs.
 * The card resolves answers keyed by `header` (that is what the user saw);
 * codex addresses questions by `id`. Missing answers become "" so every id is
 * present in the reply: the app-server's answer shape expects a string per
 * question, and an absent key would be dropped by the reply serializer.
 */
export function mapUserInputAnswers(
  questions: { id: string; header: string }[],
  answers: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(questions.map((q) => [q.id, answers[q.header] ?? ""]));
}
