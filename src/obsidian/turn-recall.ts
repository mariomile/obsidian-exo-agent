import { parseFrontMatterAliases, type App } from "obsidian";
import type { ChatRecord } from "../core/recent-chats";
import {
  chatsFromIds,
  formatRecallBlock,
  matchPastChats,
  rankRecall,
  recallKeywords,
  semanticHits,
  shouldRecall,
  titleLane,
  RECALL_LANE_DEPTH,
  RECALL_MAX_CHATS,
  RECALL_MAX_NOTES,
  type ChatRecall,
  type NoteRecall,
  type TitleHit,
} from "../core/turn-recall";
import { buildSupersedeIndex, markersOf, type MarkerFix, type SupersedeIndex } from "../core/supersede";
import { proposeMarkerFixes } from "./corrections";
import { searchVaultNotes, vaultExclusion } from "./vault-search";
import { vaultBasePath } from "./tool-kit";
import { recallChatScores, recallHost } from "./chat-recall";
import type { PathFilter } from "../core/vault-exclusions";

/** What recall found for one outbound message. */
export interface TurnRecall {
  block: string;
  notes: NoteRecall[];
  chats: ChatRecall[];
}

/** How long the turn waits for the semantic chat index. It runs alongside the
 *  vault search, so this is the most it can add to a turn; late means the
 *  lexical chats alone. */
export const SEMANTIC_BUDGET_MS = 1500;
/** Chat ids asked of the semantic index. */
const SEMANTIC_DEPTH = 12;

/** `start`'s result, or null once `ms` pass or it fails. Giving up aborts the
 *  signal `start` was handed, so the work stops with the wait. */
function withinBudget<T>(start: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T | null> {
  const ctrl = new AbortController();
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      ctrl.abort();
      resolve(null);
    }, ms);
    start(ctrl.signal).then(
      (v) => {
        window.clearTimeout(timer);
        resolve(v);
      },
      () => {
        window.clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/** Frontmatter keys that carry supersede links. */
export const SUPERSEDE_KEY = /^supersede(s|d_by)(\.|$)/;

/** What recall reads of one note: its names and its supersede links, resolved
 *  to paths. */
export interface ScannedNote {
  path: string;
  basename: string;
  frontmatter: Record<string, unknown> | null | undefined;
  links: { key: string; target: string }[];
}

/** Names and aliases for the title lane, supersede markers for the index. */
export function indexNotes(notes: readonly ScannedNote[]) {
  return {
    names: notes.map((n) => ({ path: n.path, basename: n.basename, aliases: parseFrontMatterAliases(n.frontmatter) ?? [] })),
    supersede: buildSupersedeIndex(notes.map((n) => markersOf(n.path, n.frontmatter ?? undefined, n.links))),
  };
}

/** One pass over the notes, minus excluded paths. */
function scanNotes(app: App, exclude: PathFilter) {
  const files = app.vault.getMarkdownFiles().filter((f) => !exclude(f.path));
  return indexNotes(
    files.map((f) => {
      const cache = app.metadataCache.getFileCache(f);
      const links = (cache?.frontmatterLinks ?? [])
        .filter((l) => SUPERSEDE_KEY.test(l.key))
        .map((l) => ({ key: l.key, target: app.metadataCache.getFirstLinkpathDest(l.link, f.path)?.path ?? l.link }));
      return { path: f.path, basename: f.basename, frontmatter: cache?.frontmatter, links };
    }),
  );
}

/**
 * Per-turn recall, impure half: fetch the lanes (Sonar or the built-in scorer,
 * note names, lexical and semantic past chats) and let `rankRecall` fuse them
 * into the budgeted `[vault-recall]` block. `pluginDir` (vault-relative) turns
 * the semantic chat lane on. Null when the message is too short, a slash
 * command, or nothing matched. Never throws: recall must not cost a turn.
 */
export async function recallForTurn(
  app: App,
  input: { message: string; convoId: string; chats: readonly ChatRecord[]; now: number; exclude?: PathFilter; pluginDir?: string },
): Promise<TurnRecall | null> {
  if (!shouldRecall(input.message)) return null;
  const keywords = recallKeywords(input.message);
  if (!keywords.length) return null;
  const basePath = input.pluginDir ? vaultBasePath(app) : "";
  const semantic =
    input.pluginDir && basePath
      ? withinBudget((signal) => recallChatScores(recallHost(`${basePath}/${input.pluginDir}`), input.message, SEMANTIC_DEPTH, signal), SEMANTIC_BUDGET_MS)
      : Promise.resolve(null);
  let sonar: NoteRecall[] = [];
  let title: TitleHit[] = [];
  let supersede: { index: SupersedeIndex; fixes: MarkerFix[] } | undefined;
  try {
    const exclude = input.exclude ?? vaultExclusion(app);
    const scan = scanNotes(app, exclude);
    supersede = scan.supersede;
    title = titleLane(keywords, scan.names).slice(0, RECALL_LANE_DEPTH);
    const { hits } = await searchVaultNotes(app, keywords.join(" "), RECALL_LANE_DEPTH, exclude);
    sonar = hits.map((h) => ({ path: h.path, excerpt: h.excerpt }));
  } catch {
    /* search failed: chats alone may still recall something */
  }
  const lexicalChats = matchPastChats(input.chats, keywords, { excludeId: input.convoId, now: input.now });
  const scored = await semantic;
  const { notes, chats } = rankRecall(
    { sonar, title, lexicalChats, semanticChats: scored && chatsFromIds(semanticHits(scored), input.chats, { excludeId: input.convoId }) },
    { maxNotes: RECALL_MAX_NOTES, maxChats: RECALL_MAX_CHATS, supersede: supersede?.index },
  );
  // A recalled note whose markers disagree becomes a correction proposal.
  const recalled = new Set(notes.map((n) => n.path));
  const fixes = supersede?.fixes.filter((f) => recalled.has(f.path)) ?? [];
  if (fixes.length) void proposeMarkerFixes(app, fixes, input.convoId).catch(() => {});
  const block = formatRecallBlock(notes, chats);
  return block ? { block, notes, chats } : null;
}
