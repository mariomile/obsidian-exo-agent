/**
 * Agent journal — the one-line account an agent leaves in the daily note.
 *
 * The alternative to a report note per run. An agent that quietly files your
 * inbox every day should read as a line in your day, not as a second inbox of
 * "no action needed" files to clear.
 *
 * Pure: the daily note's path and its content come from the caller.
 */

/** Marker a run uses to hand back its one-line summary. */
export const JOURNAL_MARKER = "JOURNAL:";

/** Heading the lines are collected under, so they stay together and a human
 *  can fold them away. */
export const JOURNAL_HEADING = "### 🤖 Agents";

/** A journal line is a glance, not a report. Anything longer is a report that
 *  lost its way. */
export const JOURNAL_MAX = 180;

/**
 * The summary a run wants recorded.
 *
 * Prefers the explicit `JOURNAL:` marker. Falls back to the first real line of
 * prose, because an agent that did the work and forgot the marker still did the
 * work — a missing line in the daily note would hide it. Returns null only when
 * there is genuinely nothing to say.
 */
export function extractJournalLine(output: string): string | null {
  const text = (output ?? "").replace(/```[\s\S]*?```/g, "\n");
  const lines = text.split(/\r?\n/);

  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${JOURNAL_MARKER}(?:\\*\\*)?\\s*(.+)$`));
    if (m) return clamp(stripMarkup(m[1]));
  }

  for (const line of lines) {
    const t = stripMarkup(line);
    // Skip headings, list bullets of a longer report, and frontmatter fences.
    if (!t || /^[#>|-]/.test(line.trim()) || t.startsWith("---")) continue;
    return clamp(t);
  }
  return null;
}

function stripMarkup(s: string): string {
  return s.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}

function clamp(s: string): string {
  return s.length > JOURNAL_MAX ? `${s.slice(0, JOURNAL_MAX - 1).trimEnd()}…` : s;
}

/** `- 14:32 **Inbox Triager** — filed 2 notes into Atlas/` */
export function journalLine(agentName: string, at: number, summary: string, timeLabel?: string): string {
  const d = new Date(at);
  const time = timeLabel ?? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `- ${time} **${agentName}** — ${clamp(stripMarkup(summary))}`;
}

/**
 * Insert `line` under `heading`, creating the heading at the end when absent.
 *
 * Appends within the section rather than at the top so the day reads in order,
 * and never touches anything outside it — the daily note is the user's, and an
 * agent gets one section of it.
 */
export function appendUnderHeading(content: string, heading: string, line: string): string {
  const lines = content.split(/\r?\n/);
  // Match on the heading's text at any level: the user may demote the section
  // to fit their note, and a second section at the end would follow.
  const text = heading.replace(/^#+\s*/, "");
  const headingIdx = lines.findIndex((l) => /^#+\s/.test(l.trim()) && l.trim().replace(/^#+\s*/, "") === text);

  if (headingIdx === -1) {
    const body = content.replace(/\s+$/, "");
    const prefix = body ? `${body}\n\n` : "";
    return `${prefix}${heading}\n\n${line}\n`;
  }

  // Walk to the end of this section: the next heading of the same or higher
  // level, or the end of the note.
  const level = lines[headingIdx].trim().match(/^#+/)?.[0].length ?? 2;
  let end = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const h = lines[i].match(/^(#+)\s/);
    if (h && h[1].length <= level) {
      end = i;
      break;
    }
  }

  // Land after the last non-empty line of the section, keeping one blank line
  // before whatever follows.
  let insertAt = end;
  while (insertAt > headingIdx + 1 && !lines[insertAt - 1].trim()) insertAt--;
  lines.splice(insertAt, 0, line);
  return lines.join("\n");
}

/** True when the line is already present — a re-run must not double-log. */
export function journalAlreadyHas(content: string, line: string): boolean {
  return content.includes(line);
}

/**
 * The contract that teaches a run to produce its journal line.
 *
 * Explicitly asks for what happened rather than what was considered: a daily
 * note full of "reviewed the inbox" is noise wearing a summary's clothes.
 */
export function journalContract(): string {
  return [
    "",
    `Finish with a single line starting \`${JOURNAL_MARKER}\` — it is the only trace of this run a human will read.`,
    `Example: \`${JOURNAL_MARKER} filed 2 captures into Atlas/, left 1 unclear\``,
    "Rules: one line, under 180 characters, in the language of the vault. State what CHANGED, not what you looked at — \"reviewed the inbox\" tells the reader nothing. If nothing changed, use the nothing-to-report reply instead of an empty journal line.",
    "",
  ].join("\n");
}
