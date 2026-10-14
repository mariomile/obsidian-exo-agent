/**
 * The five `collabo_*` tools. Same shape as browser-tools: this module depends
 * only on a bridge interface, so the tool surface is testable with a fake and
 * tools.ts never reaches into plugin internals.
 *
 * There is deliberately no accept, reject or rewrite tool. In Exo Collabo the
 * owner promotes a proposal to canonical text in the web client; an agent that
 * could accept its own suggestion would make the review gate decorative.
 */
import * as z from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { App } from "obsidian";
import { ok, err, getExo } from "./tool-kit";
import { obsidianHttp } from "./collabo-http";
import {
  fetchState,
  fnv1a,
  postOp,
  pendingEvents,
  ackEvents,
  type CollaboConfig,
} from "../core/collab-bridge";
import type { AnyTool } from "./sdk-tool";

/** Idempotency keys derived from the operation's own content, not the clock.
 *  A tool-loop retry (the model times out waiting for a result and calls the
 *  same tool again) repeats the same arguments, so `Date.now()` minted a
 *  fresh key every time and the service's own dedup — the guarantee the
 *  design doc promises ("a network retry cannot duplicate a comment or
 *  suggestion") — never fired. Hashing the fields that make the operation
 *  what it is means an identical retry produces the identical key, and a
 *  genuinely different comment or suggestion (even on the same document)
 *  produces a different one.
 *
 *  Fields go through `JSON.stringify` as an array, not a plain-space join:
 *  a join has no field-boundary marker, so `text="Fix typo", quote="in the
 *  intro"` and `text="Fix typo in the", quote="intro"` joined to the
 *  identical string and hashed to the identical key, silently dropping the
 *  second, genuinely different comment. `JSON.stringify` escapes each
 *  field's own quotes, so no value can forge a fake field boundary. */
export function commentIdempotencyKey(slug: string, text: string, quote?: string): string {
  return `exo-comment-${fnv1a(JSON.stringify([slug, text, quote ?? ""]))}`;
}

export function suggestionIdempotencyKey(
  slug: string,
  kind: "insert" | "delete" | "replace",
  quote: string,
  content?: string,
): string {
  return `exo-suggest-${fnv1a(JSON.stringify([slug, kind, quote, content ?? ""]))}`;
}

export interface CollaboShareSummary {
  path: string;
  slug: string;
  role: string;
  /** True when this vault created the document and holds its owner secret.
   *  False for a document merely imported from someone else's link: a
   *  comment or suggestion posted on it is visible to that owner and their
   *  other collaborators, not just to Mario. */
  owned: boolean;
}

/** The honest test for "this vault created it": whether it holds the
 *  document's owner secret. A share recorded from an import never gets one
 *  (see `collabo-commands.ts`), so it reads as not-owned here without any
 *  extra bookkeeping. Exported and pure so the derivation is testable
 *  without the live app that `collaboBridgeFrom` needs. */
export function isOwnedShare(share: { ownerSecret: string }): boolean {
  return share.ownerSecret !== "";
}

/** What the plugin implements. Every method is scoped to one document by slug;
 *  credentials never reach the model. */
export interface CollaboToolBridge {
  shares(): CollaboShareSummary[];
  read(slug: string): Promise<{ markdown: string; updatedAt: string | null }>;
  /** Everything that happened on the document since the last call, already
   *  acknowledged so each event is reported once. */
  events(slug: string): Promise<{ id: number; type: string; by: string | null; at: string | null }[]>;
  comment(slug: string, text: string, quote?: string): Promise<void>;
  suggest(
    slug: string,
    kind: "insert" | "delete" | "replace",
    quote: string,
    content?: string,
  ): Promise<void>;
}

async function run(fn: () => Promise<ReturnType<typeof ok>>): Promise<ReturnType<typeof ok>> {
  try {
    return await fn();
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export function buildCollaboTools(bridge: CollaboToolBridge): AnyTool[] {
  const listShares = tool(
    "collabo_list_shares",
    "List the notes connected to Exo Collabo, with the slug, role and whether each one is yours or was received from someone else. Start here: every other collabo tool needs a slug.",
    {},
    async () =>
      run(async () => {
        const rows = bridge.shares();
        if (!rows.length) return ok("No shared documents yet.");
        return ok(
          rows
            .map(
              (r) =>
                `${r.path} (slug ${r.slug}, ${r.role}, ${r.owned ? "yours" : "received from someone else"})`,
            )
            .join("\n"),
        );
      }),
  );

  const read = tool(
    "collabo_read",
    "Read the current accepted text of a shared document. Pending suggestions are not included: this is what the owner has promoted.",
    { slug: z.string().describe("Document slug from collabo_list_shares") },
    async (args: { slug: string }) =>
      run(async () => {
        const state = await bridge.read(args.slug);
        return ok(`updatedAt: ${state.updatedAt ?? "unknown"}\n\n${state.markdown}`);
      }),
  );

  const events = tool(
    "collabo_events",
    "See what people did on a shared document since you last checked: comments added, suggestions accepted or rejected. Check this before re-proposing anything, because a rejected suggestion is an answer, not a failure to retry.",
    { slug: z.string().describe("Document slug from collabo_list_shares") },
    async (args: { slug: string }) =>
      run(async () => {
        const rows = await bridge.events(args.slug);
        if (!rows.length) return ok("Nothing new since the last check.");
        return ok(
          rows.map((e) => `${e.at ?? "unknown time"}: ${e.type} by ${e.by ?? "someone"}`).join("\n"),
        );
      }),
  );

  const comment = tool(
    "collabo_comment",
    "Leave a comment on a shared document. Use this to raise a question or flag something rather than changing the text. Check collabo_list_shares first: if the document was received from someone else rather than shared by Mario, the comment is visible to that owner and any other collaborators and is posted as Exo, so say which document you are commenting on.",
    {
      slug: z.string().describe("Document slug from collabo_list_shares"),
      text: z.string().describe("The comment body"),
      quote: z.string().optional().describe("Exact text from the document to anchor the comment to"),
    },
    async (args: { slug: string; text: string; quote?: string }) =>
      run(async () => {
        await bridge.comment(args.slug, args.text, args.quote);
        return ok("Comment posted. It is visible to everyone on the document.");
      }),
  );

  const suggest = tool(
    "collabo_suggest",
    "Propose a change to a shared document. It stays a proposal until the owner accepts it: you cannot accept your own suggestion. Check collabo_list_shares first: if the document was received from someone else rather than shared by Mario, the suggestion is visible to that owner and any other collaborators and is posted as Exo, so say which document you are proposing on.",
    {
      slug: z.string().describe("Document slug from collabo_list_shares"),
      kind: z.enum(["insert", "delete", "replace"]).describe("What kind of change this is"),
      quote: z.string().describe("Exact text from the document this applies to"),
      content: z.string().optional().describe("The new text, for insert and replace"),
    },
    async (args: { slug: string; kind: "insert" | "delete" | "replace"; quote: string; content?: string }) =>
      run(async () => {
        await bridge.suggest(args.slug, args.kind, args.quote, args.content);
        return ok("Suggestion posted. It becomes part of the document only when the owner accepts it.");
      }),
  );

  return [listShares, read, events, comment, suggest];
}

/** Observers only. The two proposing tools are absent on purpose: their
 *  permission card is the record that the agent wrote into a surface other
 *  people are reading. `collabo_events` belongs here despite acknowledging as
 *  it reads: the ack moves a private cursor, it changes no document and no
 *  collaborator can see it. */
export const COLLABO_READ_TOOLS: string[] = [
  "mcp__obsidian__collabo_list_shares",
  "mcp__obsidian__collabo_read",
  "mcp__obsidian__collabo_events",
];

/** Resolve the live bridge from the app, or undefined when no service is
 *  configured. Undefined is the normal case and must leave the session tool
 *  list byte-identical to before this feature existed. */
export function collaboBridgeFrom(app: App): CollaboToolBridge | undefined {
  const exo = getExo(app);
  const baseUrl = exo?.settings.collaboUrl?.trim();
  if (!exo || !baseUrl) return undefined;
  const cfg: CollaboConfig = { baseUrl, apiKey: exo.settings.collaboApiKey.trim() };
  const shares = exo.settings.collaboShares;
  /** Credentials never reach the model: it names a slug, we find the token. */
  const tokenFor = (slug: string): string => {
    const hit = Object.values(shares).find((s) => s.slug === slug);
    if (!hit) throw new Error(`No shared document with slug ${slug}.`);
    return hit.accessToken;
  };
  return {
    shares: () =>
      Object.entries(shares).map(([path, s]) => ({
        path,
        slug: s.slug,
        role: s.role,
        owned: isOwnedShare(s),
      })),
    read: (slug) => fetchState(obsidianHttp, cfg, slug, tokenFor(slug)),
    events: async (slug) => {
      const token = tokenFor(slug);
      const rows = await pendingEvents(obsidianHttp, cfg, slug, token, 0);
      // Ack through the last id so the queue stays bounded and the agent is
      // told about each event once. Reporting the same rejection every turn
      // would read as new information and invite a re-proposal.
      if (rows.length) {
        await ackEvents(obsidianHttp, cfg, slug, token, Math.max(...rows.map((r) => r.id)));
      }
      return rows;
    },
    comment: async (slug, text, quote) => {
      await postOp(
        obsidianHttp,
        cfg,
        slug,
        tokenFor(slug),
        { type: "comment.add", by: "ai:exo", text, quote },
        commentIdempotencyKey(slug, text, quote),
      );
    },
    suggest: async (slug, kind, quote, content) => {
      await postOp(
        obsidianHttp,
        cfg,
        slug,
        tokenFor(slug),
        { type: "suggestion.add", by: "ai:exo", kind, quote, content },
        suggestionIdempotencyKey(slug, kind, quote, content),
      );
    },
  };
}
