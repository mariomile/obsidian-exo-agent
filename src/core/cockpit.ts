/**
 * Cockpit view-models (pure). The cockpit shell (`ui/cockpit-view.ts`) gathers
 * raw inputs (parsed loops/tasks, conversation index, queue scans, file stats)
 * and these builders turn them into render-ready rows. Action-first contract:
 * every row carries a `CockpitAction` the shell maps to a handler — seed a
 * chat (`ask`), open a conversation (`convo`), open a note (`open`), or run a
 * command (`command`). No `obsidian` import.
 */

import { activeLoops, dueLoops, type LoopEntry } from "./open-loops";
import { formatAge } from "./actions-hub";
import { normalizeUtilization } from "./rate-limit";
import type { TaskEntry, TaskStatus } from "./tasks";

export interface CockpitAction {
  kind: "ask" | "convo" | "open" | "command";
  arg: string;
}

export interface CockpitRow {
  label: string;
  sub?: string;
  badge?: string;
  action: CockpitAction;
}

export type AttentionItem =
  | { kind: "blocked" | "streaming" | "answer"; label: string; target: string }
  | { kind: "runs" | "pulse"; label: string };

const DAY = 86_400_000;

/** The "waits for YOU" strip: blocked turns first (they gate work), then
 *  running turns, then queue answers fresh within 24h. Capped — it's a strip,
 *  not a list. */
export function buildAttention(
  input: {
    convos: { id: string; title: string; blocked: boolean; streaming: boolean }[];
    answers: { path: string; name: string; answeredAt: number }[];
    /** Automation write runs awaiting review (unreviewedWriteRuns count). */
    unreviewedRuns?: number;
    /** Daily Pulse items generated since the review note was last opened. */
    dailyPulseItems?: number;
    now: number;
  },
  cap = 6
): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const c of input.convos) {
    if (c.blocked) out.push({ kind: "blocked", label: `"${c.title}" is waiting for your OK`, target: c.id });
  }
  if (input.dailyPulseItems) {
    const n = input.dailyPulseItems;
    out.push({
      kind: "pulse",
      label: `Daily Pulse · ${n} item${n === 1 ? "" : "s"}`,
    });
  }
  if (input.unreviewedRuns) {
    const n = input.unreviewedRuns;
    out.push({
      kind: "runs",
      label: n === 1 ? "1 automation run to review" : `${n} automation runs to review`,
    });
  }
  for (const c of input.convos) {
    if (!c.blocked && c.streaming) out.push({ kind: "streaming", label: `"${c.title}" is working`, target: c.id });
  }
  for (const a of input.answers) {
    if (input.now - a.answeredAt < DAY) out.push({ kind: "answer", label: `Answer ready: ${a.name}`, target: a.path });
  }
  return out.slice(0, cap);
}

/** Active loops, due first (then oldest first). Clicking seeds a closing chat. */
export function loopRows(loops: LoopEntry[], now: number, cap = 6): CockpitRow[] {
  const act = activeLoops(loops);
  const due = new Set(dueLoops(loops, now).map((l) => l.id));
  const sorted = [...act].sort(
    (a, b) => Number(due.has(b.id)) - Number(due.has(a.id)) || a.openedAt - b.openedAt
  );
  return sorted.slice(0, cap).map((l) => ({
    label: l.title,
    sub: formatAge(l.openedAt, now, ""),
    ...(due.has(l.id) ? { badge: "due" } : {}),
    action: { kind: "ask", arg: `Chiudiamo questo loop: ${l.title}` },
  }));
}

/** Board columns by live-ness: what's moving (or stuck) before what's parked. */
const TASK_ORDER: TaskStatus[] = ["running", "needs-input", "review", "queued", "backlog"];

export function taskRows(tasks: TaskEntry[], cap = 6): CockpitRow[] {
  const open = tasks.filter((t) => TASK_ORDER.includes(t.status));
  open.sort(
    (a, b) =>
      TASK_ORDER.indexOf(a.status) - TASK_ORDER.indexOf(b.status) ||
      Date.parse(b.updated) - Date.parse(a.updated)
  );
  return open.slice(0, cap).map((t) => ({
    label: t.title,
    sub: t.status,
    action: { kind: "command", arg: "exo-agent:open-orchestration-board" },
  }));
}

export interface ResumeConvo {
  id: string;
  title: string;
  updatedAt?: number;
  preview?: string;
}

export function resumeRows(convos: ResumeConvo[], now: number, cap = 5): CockpitRow[] {
  return [...convos]
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, cap)
    .map((c) => ({
      label: c.title || "Untitled",
      ...(c.preview ? { sub: c.preview } : {}),
      badge: formatAge(c.updatedAt ?? null, now, ""),
      action: { kind: "convo", arg: c.id },
    }));
}

/** One-line preview from a persisted transcript: the last non-empty text
 *  (user text or assistant text segments), whitespace-collapsed, capped. */
export function previewFromMessages(
  messages: Array<{ role: string; text?: string; auto?: true; segments?: Array<{ t: string; md?: string }> }>,
  max = 70
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.auto) continue; // Exo's own wake-up line, not what the chat is about
    const raw =
      m.role === "user"
        ? (m.text ?? "")
        : (m.segments ?? [])
            .filter((s) => s.t === "text")
            .map((s) => s.md ?? "")
            .join(" ");
    const t = raw.replace(/\s+/g, " ").trim();
    if (t) return t.length >= max ? t.slice(0, max - 1) + "…" : t;
  }
  return "";
}

/** The note that carries current state (NOW.md, else vault-context) and its
 *  age in days. */
export interface StateNote {
  path: string;
  ageDays: number;
}

export interface HealthInput {
  inboxCount: number;
  /** Null when the state note is missing or unreadable: no stale row then. */
  stateNote: StateNote | null;
  lastReport: { path: string; name: string; mtime: number } | null;
  now: number;
}

/** Maintenance debt made visible. Only real signals — a healthy vault renders
 *  no rows (the shell shows the tile's empty copy). Staleness threshold is the
 *  vault's own 7-day rule. */
export function healthRows(h: HealthInput): CockpitRow[] {
  const rows: CockpitRow[] = [];
  if (h.inboxCount > 0) {
    rows.push({
      label: "Inbox to triage",
      badge: String(h.inboxCount),
      action: { kind: "ask", arg: "/inbox-triage" },
    });
  }
  if (h.stateNote && h.stateNote.ageDays > 7) {
    const { path, ageDays } = h.stateNote;
    rows.push({
      label: `${path.split("/").pop()} stale`,
      badge: `${Math.floor(ageDays)}d`,
      action: {
        kind: "ask",
        arg: `Rinfreschiamo ${path}: è stale. Rileggi lo stato attuale e proponi gli aggiornamenti.`,
      },
    });
  }
  if (h.lastReport) {
    rows.push({
      label: `Report: ${h.lastReport.name}`,
      sub: formatAge(h.lastReport.mtime, h.now, ""),
      action: { kind: "open", arg: h.lastReport.path },
    });
  }
  return rows;
}

/** Plan-quota chip value: "43% used", "limit reached", or null (hide — API-key
 *  sessions and unknown states get no fake chip). */
export function quotaValue(rate: { status: string; utilization?: number } | null | undefined): string | null {
  if (!rate) return null;
  if (rate.status === "rejected") return "limit reached";
  const pct = normalizeUtilization(rate.utilization);
  return typeof pct === "number" ? `${pct}% used` : null;
}

/** Epoch ms of the queue's `exo-answered: YYYY-MM-DD HH:mm` stamp (local time,
 *  matching how queue.ts writes it), or null when absent. */
export function parseAnsweredStamp(content: string): number | null {
  const m = content.match(/^exo-answered:\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/m);
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  return Number.isFinite(t) ? t : null;
}
