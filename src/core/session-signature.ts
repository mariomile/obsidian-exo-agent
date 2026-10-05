/**
 * The spawn-time configuration of one chat session, as a comparable string:
 * when it changes, the view respawns the session. Anything applied to a live
 * session stays out. The permission mode is applied live, so only entering or
 * leaving bypass (which the CLI accepts only at launch) counts. Each
 * provider's own settings count only for that provider's sessions.
 */
import type { ProviderId } from "../providers/types";
import type { MVASettings } from "../settings-schema";
import { effortFor } from "./model-tuning";

export function sessionSignature(
  c: { id: string; provider: ProviderId; model: string },
  s: MVASettings,
  memoryCapsJson: string
): string {
  const codex = c.provider === "codex";
  return [
    c.provider,
    c.model,
    effortFor(c.provider, c.model, s.effort),
    s.toolsEnabled,
    s.permissionMode === "bypassPermissions",
    s.fastStartup,
    s.runHooks,
    s.systemPrompt,
    s.obsidianToolsEnabled,
    s.nativeFirst,
    memoryCapsJson,
    s.autoCompactEnabled,
    s.contextSavingMode,
    codex ? s.codexSandbox : "",
    codex ? s.codexApproval : "",
    s.orchestrationEnabled,
    s.browserEnabled,
    codex ? s.codexBin : s.claudeBin,
    c.id,
  ].join("|");
}
