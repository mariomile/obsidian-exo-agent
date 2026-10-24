/**
 * Cockpit view-models (pure). The cockpit shell (`ui/cockpit-view.ts`) gathers
 * raw inputs (parsed loops, queue counts, file stats)
 * and these builders turn them into render-ready rows. Action-first contract:
 * every row carries a `CockpitAction` the shell maps to a handler — seed a
 * chat (`ask`), open a note (`open`), or run a command (`command`). No
 * `obsidian` import.
 */

import { activeLoops, dueLoops, type LoopEntry } from "./open-loops";
import { formatAge } from "./actions-hub";
import { normalizeUtilization } from "./rate-limit";

export interface CockpitAction {
  kind: "ask" | "open" | "command";
  arg: string;
}

export interface CockpitRow {
  label: string;
  sub?: string;
  badge?: string;
  action: CockpitAction;
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
    action: { kind: "ask", arg: `Let's close this loop: ${l.title}` },
  }));
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
 *  no rows (the shell then draws no tile). Staleness threshold is the
 *  vault's own 7-day rule. */
export function healthRows(h: HealthInput): CockpitRow[] {
  const rows: CockpitRow[] = [];
  if (h.inboxCount > 0) {
    rows.push({
      label: "Notes to triage",
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
        arg: `Let's refresh ${path}: it is stale. Reread its current state and propose updates.`,
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
