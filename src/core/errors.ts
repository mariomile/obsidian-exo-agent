/**
 * Human-readable mapping for known raw CLI failure strings. Turns opaque engine
 * output into a one-line explanation (plus an optional hint) the user can act
 * on, while the caller keeps the raw text as a secondary detail for debugging.
 *
 * Returns `null` for anything unrecognized — the caller then shows the raw text
 * unchanged. All matching is case-insensitive.
 */
export function describeCliFailure(raw: string): { message: string; hint?: string } | null {
  const m = (raw || "").toLowerCase();

  // Auth first: an auth failure can also mention "error"/"exited", so it must win
  // over the generic crash patterns below.
  if (isCliAuthFailure(m)) {
    return { message: "The CLI isn't logged in, or its login expired. Run `claude auth login` in a terminal, then retry." };
  }

  // Claude-plan usage limit (claude.ai subscription). Distinct from an API-key
  // "rate limit exceeded" 429 (left to surface raw): these phrasings only appear
  // when a plan's rolling window is exhausted. When the raw text carries a reset
  // clock (HH:MM) or an ISO timestamp, thread it into the hint.
  if (/usage limit|session limit|hit your (session|usage|plan|weekly) limit|reached your (usage|session|weekly) limit/.test(m)) {
    const clock = raw.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/);
    const iso = raw.match(/\d{4}-\d\d-\d\dT[0-9:.+Z-]+/);
    const when = clock?.[0] ?? iso?.[0];
    return {
      message: "You've hit your Claude plan's usage limit.",
      hint: when
        ? `It resets around ${when}.`
        : "It resets on a rolling window — try again later.",
    };
  }

  // Binary can't be found / launched.
  if (/enoent|command not found|not found|no such file/.test(m)) {
    return { message: "Claude CLI not found — set the binary path in Settings." };
  }

  // The SDK stream disappeared without a final result. Exo has already kept the
  // local transcript and will rebuild the provider process through the recovery
  // ladder, so the useful action is a retry — not a wall of transport detail.
  if (isEndedSessionFailure(m)) {
    return {
      message: "The Claude CLI session ended unexpectedly — retry to resume.",
      hint: "Your conversation is safe; Exo will reconnect with its saved context.",
    };
  }

  // Exo itself reloaded mid-turn (plugin update/reload) — the CLI session is
  // untouched on disk, so this reads exactly like a dropped connection: retry
  // resumes it, nothing was lost.
  if (/session disposed \(view-unload\)/.test(m)) {
    return {
      message: "Exo reloaded mid-response — retry to resume.",
      hint: "Your conversation is safe; Exo will reconnect with its saved context.",
    };
  }

  // Mid-turn engine crash — recoverable, the session resumes on the next message.
  if (/error_during_execution|\[ede_diagnostic\]/.test(m)) {
    return {
      message:
        "The Claude CLI crashed mid-turn — usually transient; your next message resumes the session.",
      hint: "If it keeps happening, update the CLI from Settings.",
    };
  }
  if (/process exited with code/.test(m)) {
    return {
      message:
        "The Claude CLI process exited unexpectedly — usually transient; your next message resumes the session.",
      hint: "If it keeps happening, update the CLI from Settings.",
    };
  }

  return null;
}

/** Exact provider-stream failures that the session recovery ladder can heal. */
/** The CLI has no usable login: never logged in, or its OAuth token expired and
 *  the refresh failed ("Failed to authenticate: OAuth session expired and could
 *  not be refreshed"). Not a session death: resuming or recapping cannot heal
 *  it, only a new `claude auth login` can. */
export function isCliAuthFailure(raw: string): boolean {
  return /not logged in|invalid api key|please run \/login|\/login\b|unauthorized|not authenticated|failed to authenticate|oauth session expired|oauth token (has )?expired/.test(
    (raw || "").toLowerCase(),
  );
}

export function isEndedSessionFailure(raw: string): boolean {
  return /claude session ended|session stream ended/.test((raw || "").toLowerCase());
}
