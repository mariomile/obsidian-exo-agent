/**
 * Scoring for the recall eval (`pnpm eval:recall`): did a turn's recall serve
 * the sources a question needs? Pure; the live harness in
 * `tests/live/recall-eval.live.test.ts` fetches the lanes and calls
 * `rankRecall`, this file only judges the result.
 *
 * Ranks are counted per kind: a turn injects notes and past chats as two
 * separate lists, so a chat is "rank 1" when it is the first chat injected.
 */
import { chatLines, localDate, type ChatRecord } from "./recent-chats";
import type { ChatRecall, NoteRecall } from "./turn-recall";

/** A chat is named by title and date in the fixture (ids are private to the
 *  store); `id` is filled by {@link resolveChats}. */
export interface ChatRef {
  title: string;
  date: string;
  id?: string;
}

export type Expectation = { note: string } | { chat: ChatRef };

export interface EvalCase {
  id: string;
  question: string;
  /** Any one in the top k is a hit; all of them is a full hit. */
  expect: Expectation[];
  /** Notes that must not be served as current (superseded ones). */
  mustNotLead?: string[];
}

export type RecallItem = { kind: "note"; path: string; supersededBy?: string } | { kind: "chat"; id: string };

export interface CaseScore {
  hit: boolean;
  full: boolean;
  /** Best rank of any expected source, at any depth; null when none was served. */
  firstRank: number | null;
  /** Reciprocal rank, 0 outside the top k. */
  rr: number;
  /** A must-not-lead note sits in the top k without a supersede label. */
  trapLeads: boolean;
}

export interface EvalSummary {
  cases: number;
  hitAt5: number;
  fullAt5: number;
  mrr: number;
  traps: number;
}

/** What one recall served, as the eval reads it: notes, then chats. */
export function recallItems(r: { notes: readonly (NoteRecall & { supersededBy?: string })[]; chats: readonly ChatRecall[] }): RecallItem[] {
  return [
    ...r.notes.map((n): RecallItem => ({ kind: "note", path: n.path, ...(n.supersededBy ? { supersededBy: n.supersededBy } : {}) })),
    ...r.chats.map((c): RecallItem => ({ kind: "chat", id: c.id })),
  ];
}

/** 1-based rank of an expectation among the items of its own kind, or null. */
function rankOf(ranked: readonly RecallItem[], e: Expectation): number | null {
  if ("note" in e) {
    const i = ranked.filter((r) => r.kind === "note").findIndex((r) => r.kind === "note" && r.path === e.note);
    return i < 0 ? null : i + 1;
  }
  if (!e.chat.id) return null;
  const i = ranked.filter((r) => r.kind === "chat").findIndex((r) => r.kind === "chat" && r.id === e.chat.id);
  return i < 0 ? null : i + 1;
}

export function scoreCase(ranked: readonly RecallItem[], c: EvalCase, k = 5): CaseScore {
  const ranks = c.expect.map((e) => rankOf(ranked, e));
  const found = ranks.filter((r): r is number => r !== null);
  const firstRank = found.length ? Math.min(...found) : null;
  const topNotes = ranked.filter((r) => r.kind === "note").slice(0, k);
  return {
    hit: firstRank !== null && firstRank <= k,
    full: ranks.every((r) => r !== null && r <= k),
    firstRank,
    rr: firstRank !== null && firstRank <= k ? 1 / firstRank : 0,
    trapLeads: (c.mustNotLead ?? []).some((p) => topNotes.some((r) => r.kind === "note" && r.path === p && !r.supersededBy)),
  };
}

export function summarize(results: readonly CaseScore[]): EvalSummary {
  return {
    cases: results.length,
    hitAt5: results.filter((r) => r.hit).length,
    fullAt5: results.filter((r) => r.full).length,
    mrr: results.length ? results.reduce((a, r) => a + r.rr, 0) / results.length : 0,
    traps: results.filter((r) => r.trapLeads).length,
  };
}

export function formatSummary(s: EvalSummary): string {
  return `hit@5 ${s.hitAt5}/${s.cases} · full@5 ${s.fullAt5}/${s.cases} · MRR ${s.mrr.toFixed(2)} · traps ${s.traps}`;
}

/** Fill each chat expectation's id from the store: exact title, and the date
 *  (any message on that local day) only to break a tie between equal titles. */
export function resolveChats(c: EvalCase, chats: readonly ChatRecord[]): EvalCase {
  const resolve = (ref: ChatRef): ChatRef => {
    const named = chats.filter((x) => x.title === ref.title);
    const onDay = named.filter((x) => chatLines(x.messages).some((l) => l.at !== undefined && localDate(l.at) === ref.date));
    const pick = named.length === 1 ? named[0] : onDay[0];
    return pick ? { ...ref, id: pick.id } : ref;
  };
  return { ...c, expect: c.expect.map((e) => ("chat" in e ? { chat: resolve(e.chat) } : e)) };
}
