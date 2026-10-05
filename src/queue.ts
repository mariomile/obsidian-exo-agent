/* Exo Queue — "Exo in your pocket" via Obsidian Sync (2026-07-10, mobile #7 v1).
 *
 * Remote-head architecture WITHOUT infrastructure: the phone writes a request
 * note into the configured queue folder; Obsidian Sync carries it to the desktop;
 * there the watcher runs it HEADLESS and READ-ONLY (runHeadlessPlaybook: only
 * auto-allowed read tools, every mutation denied) and appends the answer
 * INTO THE SAME NOTE; Sync carries the answer back to the phone. No server,
 * no pairing: the vault is the shared state, Sync is the transport.
 * (Prior art: Claude Dispatch — but here the bus is Sync. First in the ecosystem.)
 *
 * Request note contract:
 *   - any .md in the queue folder, body = prompt;
 *   - it gets processed if the frontmatter does NOT contain `exo-answered`;
 *   - the answer is appended as `## Risposta (Exo · read-only)` and the
 *     frontmatter receives `exo-answered: <ISO>` — written as RAW TEXT,
 *     never processFrontMatter (breaks unquoted wikilinks).
 *   - errors: up to 3 attempts with backoff persisted in the frontmatter;
 *     `exo-failed` closes only after the last failure.
 *
 * Guards: in-memory busy flag (never two concurrent drains), max 3 requests
 * per cycle (anti-avalanche after a lagging sync), non-empty body.
 */

import { Notice, TFile, TFolder, type App } from "obsidian";

import { runHeadlessPlaybook, type HeadlessOpts } from "./headless";
import type { MVASettings } from "./settings";
import { patchFrontmatter } from "./core/frontmatter-patch";

const MAX_PER_DRAIN = 3;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 5 * 60 * 1000;

interface ParsedNote {
  /** Frontmatter block INCLUDING the delimiters (or "" if absent). */
  fm: string;
  /** Body without frontmatter. */
  body: string;
}

export function parseNote(content: string): ParsedNote {
  if (content.startsWith("---\n")) {
    const end = content.indexOf("\n---", 4);
    if (end >= 0) {
      const close = content.indexOf("\n", end + 1);
      const fmEnd = close >= 0 ? close + 1 : content.length;
      return { fm: content.slice(0, fmEnd), body: content.slice(fmEnd) };
    }
  }
  return { fm: "", body: content };
}

export function queueRequestBody(body: string): string {
  return body.split(/\n## Errore \(Exo · tentativo \d+\/\d+\)\n/)[0].trim();
}

export function isPending(content: string): boolean {
  const { fm, body } = parseNote(content);
  if (/^exo-answered:/m.test(fm)) return false;
  if (/^exo-failed:/m.test(fm)) return false;
  return queueRequestBody(body).length > 0;
}

export function isQueueRetryDue(content: string, now = Date.now()): boolean {
  if (!isPending(content)) return false;
  const { fm } = parseNote(content);
  const raw = fm.match(/^exo-retry-after:\s*["']?([^"'\r\n]+)["']?/m)?.[1]?.trim();
  if (!raw) return true;
  const retryAt = Date.parse(raw);
  return !Number.isFinite(retryAt) || retryAt <= now;
}

/** Inserts `exo-answered` into the frontmatter (raw text, wikilink-safe). */
function stampAnswered(note: ParsedNote, iso: string): string {
  return patchFrontmatter(note.fm + note.body, { "exo-answered": iso }, ["exo-attempts", "exo-retry-after"]);
}

export function stampQueueFailure(note: ParsedNote, attempt: number, now: number): string {
  const exhausted = attempt >= MAX_ATTEMPTS;
  const changes: Record<string, unknown> = { "exo-attempts": attempt };
  if (exhausted) changes["exo-failed"] = new Date(now).toISOString();
  else changes["exo-retry-after"] = new Date(now + RETRY_BASE_MS * 2 ** (attempt - 1)).toISOString();
  return patchFrontmatter(
    note.fm + queueRequestBody(note.body),
    changes,
    exhausted ? ["exo-retry-after"] : []
  );
}

/** Counts pending requests in the queue (for the Autonomy panel) —
 *  same criteria as the drain: .md note, non-empty body, no exo-answered. */
export async function countPendingQueue(app: App, settings: MVASettings): Promise<number> {
  const folder = app.vault.getAbstractFileByPath(settings.exoQueueFolder);
  if (!(folder instanceof TFolder)) return 0;
  let n = 0;
  for (const child of folder.children) {
    if (!(child instanceof TFile) || child.extension !== "md") continue;
    try {
      if (isPending(await app.vault.cachedRead(child))) n++;
    } catch {
      /* unreadable — skip */
    }
  }
  return n;
}

/** One drain cycle of the queue. Returns how many requests it fulfilled. */
export async function drainExoQueue(
  app: App,
  settings: MVASettings,
  deps: {
    /** A fresh vault-tools bridge per request (Codex), so queue runs get the same tools as chat. */
    codexBridge: () => Promise<HeadlessOpts["codexBridge"]>;
    /** Reports the answered note to the git safety net. */
    noteWrite: (paths: readonly string[]) => void;
  }
): Promise<number> {
  const folder = app.vault.getAbstractFileByPath(settings.exoQueueFolder);
  if (!(folder instanceof TFolder)) return 0; // folder missing = empty queue
  const pending: TFile[] = [];
  for (const child of folder.children) {
    if (child instanceof TFile && child.extension === "md") pending.push(child);
  }
  // Stable order: oldest first (ctime), so answers arrive FIFO.
  pending.sort((a, b) => a.stat.ctime - b.stat.ctime);

  let done = 0;
  for (const file of pending) {
    if (done >= MAX_PER_DRAIN) break;
    const content = await app.vault.read(file);
    if (!isQueueRetryDue(content)) continue;

    const { fm, body } = parseNote(content);
    const prompt = queueRequestBody(body);
    const result = await runHeadlessPlaybook(app, settings, prompt, { codexBridge: await deps.codexBridge() });
    const iso = new Date().toISOString().slice(0, 16).replace("T", " ");

    const previousAttempts = Number(fm.match(/^exo-attempts:\s*(\d+)/m)?.[1] ?? 0) || 0;
    const attempt = previousAttempts + 1;
    const heading = result.ok
      ? "## Risposta (Exo · read-only)"
      : `## Errore (Exo · tentativo ${attempt}/${MAX_ATTEMPTS})`;
    const answer = result.ok
      ? result.output || "*(risposta vuota)*"
      : `${result.error ?? "errore sconosciuto"}\n\n${result.output}`.trim();
    const base = result.ok
      ? stampAnswered({ fm, body: prompt }, iso)
      : stampQueueFailure({ fm, body: prompt }, attempt, Date.now());
    const next = `${base.replace(/\s*$/, "")}\n\n${heading}\n\n${answer}\n`;

    // Reread before writing: if the note changed during execution
    // (edit from the phone mid-run), don't overwrite — the next
    // drain will pick it up on the new version.
    const latest = await app.vault.read(file);
    if (latest !== content) continue;
    await app.vault.modify(file, next);
    deps.noteWrite([file.path]);
    done++;
    if (result.ok) new Notice(`Exo queue: answer ready → ${file.basename}`);
    else if (attempt < MAX_ATTEMPTS) new Notice(`Exo queue: attempt ${attempt} failed — retrying later.`);
    else new Notice(`Exo queue: ${file.basename} failed after ${MAX_ATTEMPTS} attempts.`);
  }
  return done;
}
