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
import { recallChatScores, recallHost } from "../ui/chat-recall";
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

/** `p`, or null once `ms` pass or it fails. */
function withinBudget<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(null), ms);
    p.then(
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

/** One pass over the notes, minus excluded paths: names and aliases for the
 *  title lane, supersede markers (links resolved to paths) for the index. */
function scanNotes(app: App, exclude: PathFilter) {
  const files = app.vault.getMarkdownFiles().filter((f) => !exclude(f.path));
  const names = [];
  const markers = [];
  for (const f of files) {
    const cache = app.metadataCache.getFileCache(f);
    names.push({ path: f.path, basename: f.basename, aliases: parseFrontMatterAliases(cache?.frontmatter) ?? [] });
    const links = (cache?.frontmatterLinks ?? [])
      .filter((l) => /^supersede(s|d_by)(\.|$)/.test(l.key))
      .map((l) => ({ key: l.key, target: app.metadataCache.getFirstLinkpathDest(l.link, f.path)?.path ?? l.link }));
    markers.push(markersOf(f.path, cache?.frontmatter, links));
  }
  return { names, supersede: buildSupersedeIndex(markers) };
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
  const basePath = (app.vault.adapter as { basePath?: string } | undefined)?.basePath;
  const semantic =
    input.pluginDir && basePath
      ? withinBudget(recallChatScores(recallHost(`${basePath}/${input.pluginDir}`), input.message, SEMANTIC_DEPTH), SEMANTIC_BUDGET_MS)
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
