/**
 * One transient, tool-less session: spawn, send one prompt, collect its text,
 * dispose. The shared lifecycle behind every one-shot caller — inline
 * Edit/Continue, AI titles, background utility passes — so each keeps only
 * its own policy (model choice, timeout, logging).
 */
import { resolveCli } from "../cli";
import { ADAPTERS } from "./registry";
import { PROFILES, providerStr } from "./profiles";
import type { AgentEvent, ProviderId } from "./types";
import type { MVASettings } from "../settings-schema";

export interface TransientRun {
  provider: ProviderId;
  settings: MVASettings;
  cwd: string;
  model: string;
  effort: string;
  prompt: string;
  /** Aborting disposes the session; the run then rejects. */
  signal: AbortSignal;
  /** Short tag for the dispose reasons ("title", "utility-pass", …). */
  tag: string;
  onDelta?: (text: string) => void;
  /** Fires once the CLI reported its init snapshot (a cold-spawn timing hook). */
  onCaps?: () => void;
  /** input+output tokens of the turn, when the provider exposes them. */
  onUsage?: (tokens: number) => void;
}

/** Resolves with the full streamed text; rejects on CLI or turn failure. */
export async function runTransient(r: TransientRun): Promise<string> {
  const cli = await resolveCli(PROFILES[r.provider].cliName, providerStr(r.settings, r.provider, "bin"));
  const session = ADAPTERS[r.provider].createSession({
    cli,
    model: r.model,
    effort: r.effort,
    cwd: r.cwd,
    permissionMode: "default",
    toolsEnabled: false, // pure text in, text out
    fastStartup: true,
  });
  if (r.onCaps) session.onCaps = r.onCaps;
  const onAbort = () => {
    try {
      session.dispose(`${r.tag}-aborted`);
    } catch {
      /* already torn down */
    }
  };
  if (r.signal.aborted) onAbort();
  else r.signal.addEventListener("abort", onAbort);
  let out = "";
  try {
    await session.send(r.prompt, (e: AgentEvent) => {
      if (e.kind !== "text-delta") return;
      out += e.text;
      r.onDelta?.(e.text);
    });
    // Read BEFORE dispose: lastTurnTokens() is filled synchronously by the turn
    // that just settled send(); a disposed session may never answer a round-trip.
    const tokens = session.lastTurnTokens?.();
    if (typeof tokens === "number") r.onUsage?.(tokens);
  } finally {
    r.signal.removeEventListener("abort", onAbort);
    session.dispose(`${r.tag}-run-end`);
  }
  return out;
}
