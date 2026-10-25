import { TFile, type App } from "obsidian";
import type { ExoPaths } from "../core/paths";
import type { MemoryCaps } from "../core/memory-caps";
import type { ChatMessage } from "../core/recent-chats";
import { localDate } from "../core/recent-chats";
import {
  buildDecidePrompt,
  buildExtractPrompt,
  buildTranscript,
  checkTarget,
  explicitRulePaths,
  harvestCommitMessage,
  harvestBlocklist,
  harvestSlice,
  isHarvestDue,
  normalizeTarget,
  safeTitle,
  keywordsOf,
  matchingLines,
  memoryRulesSection,
  noteHeadings,
  parseCandidates,
  parseDecisions,
  worthExtracting,
  HARVEST_COMMIT_PREFIX,
  type CandidateContext,
  type NoteContext,
  type TargetEnv,
} from "../core/memory-harvest";
import { applyDecisions, type ApplyVault } from "../core/memory-apply";
import type { WriteQueue } from "../core/write-queue";
import { checkGitRepo, headSha, isWorktreeDirty, runGitCommit, type GitRun } from "./git";
import type { HarvestLog, HarvestRecord } from "./harvest-log";
import { searchVaultNotes, vaultExclusion } from "./vault-search";

/** A conversation as the harvester sees it. */
export interface HarvestChat {
  id: string;
  title: string;
  messages: readonly ChatMessage[];
  harvestedIndex?: number;
  streaming: boolean;
  lastActivityAt: number;
}

/** The live conversation store (the chat view), or null when it isn't mounted. */
export interface HarvestSource {
  chats(): HarvestChat[];
  markHarvested(id: string, index: number): void;
}

export interface HarvesterDeps {
  app: App;
  caps(): MemoryCaps;
  paths(): ExoPaths;
  source(): HarvestSource | null;
  /** A tool-less background model call; "" on failure. */
  utility(prompt: string, signal: AbortSignal): Promise<{ text: string; tokens: number | null }>;
  budget: { check(estimate: number): boolean; record(tokens: number): void };
  /** Shared memory write queue: harvest writes serialize with rethink_memory. */
  writeQueue: WriteQueue;
  /** The open-loops ledger's queue, shared with `open_loop`/`close_loop`. */
  loopsWriteQueue: WriteQueue;
  /** Git runner at the vault root, or null without a filesystem adapter. */
  git(): GitRun | null;
  log: HarvestLog;
  notify(message: string): void;
  diag(message: string): void;
}

/** Budget pre-check estimates, recorded as spend when the provider reports none. */
const EXTRACT_ESTIMATE = 6000;
const DECIDE_ESTIMATE = 9000;
/** After a failed model call, leave that conversation alone this long. */
const FAILURE_BACKOFF_MS = 60 * 60 * 1000;
const NOTES_PER_CANDIDATE = 3;
const MAX_ROUTING_NOTES = 8;

/**
 * Memory harvest, impure half: finds due conversations, runs extract → decide
 * → apply, commits the touched notes, records the harvest for the digest and
 * undo, and advances the conversation's watermark. One run at a time; a
 * conversation the user leaves mid-run is picked up right after.
 */
export class MemoryHarvester {
  private running: Promise<void> | null = null;
  private readonly leavingIds = new Set<string>();
  private readonly failedAt = new Map<string, number>();
  private readonly abort = new AbortController();

  constructor(private readonly d: HarvesterDeps) {}

  dispose(): void {
    this.abort.abort();
  }

  /** Heartbeat and plugin-load catch-up: harvest every due conversation. */
  tick(): Promise<void> {
    if (!this.running) {
      this.running = this.runDue().finally(() => {
        this.running = null;
        if (this.leavingIds.size) void this.tick();
      });
    }
    return this.running;
  }

  /** The user switched away from or closed `convoId`: harvest it now. */
  leaving(convoId: string): void {
    if (!this.d.caps().autoCapture) return;
    this.leavingIds.add(convoId);
    void this.tick();
  }

  private async runDue(): Promise<void> {
    // Claim the pending leaves FIRST: every exit below consumes them, so the
    // re-tick in `tick()`'s finally only ever follows leaves that arrived
    // during this run, never loops on ones this run could not serve.
    const leaving = new Set(this.leavingIds);
    this.leavingIds.clear();
    if (!this.d.caps().autoCapture || this.abort.signal.aborted) return;
    const source = this.d.source();
    if (!source) return; // no view yet: the idle heartbeat picks these up later
    const now = Date.now();
    for (const chat of source.chats()) {
      if (this.abort.signal.aborted) return;
      const backoff = this.failedAt.get(chat.id);
      if (backoff && now - backoff < FAILURE_BACKOFF_MS) continue;
      const state = {
        messageCount: chat.messages.length,
        harvestedIndex: chat.harvestedIndex,
        streaming: chat.streaming,
        lastActivityAt: chat.lastActivityAt,
      };
      if (!isHarvestDue(state, now, leaving.has(chat.id))) continue;
      try {
        await this.harvest(chat, source);
      } catch (err) {
        this.failedAt.set(chat.id, Date.now());
        this.d.diag(`harvest failed ${chat.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** One conversation, end to end. Returns the record when anything was written. */
  async harvest(chat: HarvestChat, source: HarvestSource): Promise<HarvestRecord | null> {
    const now = Date.now();
    const today = localDate(now);
    const { lines, end } = harvestSlice(chat.messages, chat.harvestedIndex, now);
    if (!worthExtracting(lines)) {
      source.markHarvested(chat.id, end);
      return null;
    }

    // Step 1: extract candidate facts.
    const extracted = await this.call(buildExtractPrompt(buildTranscript(lines), today), EXTRACT_ESTIMATE);
    if (extracted === null) return null; // budget denied: retry on a later tick
    if (!extracted) {
      this.failedAt.set(chat.id, now);
      return null;
    }
    const candidates = parseCandidates(extracted);
    if (!candidates.length) {
      source.markHarvested(chat.id, end);
      this.d.diag(`harvest ${chat.id}: no facts`);
      return null;
    }

    // Step 2: decide per fact, with the notes it could touch in view.
    const env = this.targetEnv(today);
    const rules = await this.memoryRules();
    const routingNotes = await this.routingNotes(rules, env);
    const items: CandidateContext[] = [];
    for (const candidate of candidates) {
      const keywords = keywordsOf(`${candidate.entity ?? ""} ${candidate.statement}`);
      items.push({ candidate, notes: await this.candidateNotes(keywords, routingNotes, env) });
    }
    const paths = this.d.paths();
    const decided = await this.call(
      buildDecidePrompt({
        today,
        rules,
        routingNotes,
        inboxPath: env.inboxPath,
        agentLessonPath: `${paths.agentMemory}/exo.md`,
        items,
      }),
      DECIDE_ESTIMATE,
    );
    if (decided === null) return null;
    if (!decided) {
      this.failedAt.set(chat.id, now);
      return null;
    }
    const decisions = parseDecisions(decided, candidates.length);
    if (this.abort.signal.aborted) return null; // unloading: write nothing

    // Settle the watermark BEFORE writing: a crash mid-apply must not replay
    // these messages into a second harvest of the same facts.
    source.markHarvested(chat.id, end);

    // The notes the decider saw are the only ones it may write (plus the inbox).
    const offered = new Set([...routingNotes, ...items.flatMap((it) => it.notes)].map((n) => n.path));
    const targets = [
      ...new Set(
        decisions.flatMap((d) => (d.op === "noop" ? [] : [normalizeTarget(d.path)])).filter((p) => p === env.inboxPath || offered.has(p)),
      ),
    ];
    // Notes with the user's uncommitted edits are written but never committed:
    // committing them would sweep those edits into the harvest (and undo would
    // then revert them). Checked before writing, so the harvest's own edit
    // doesn't count.
    const git = await this.repo();
    const dirty = new Set<string>();
    if (git) {
      for (const p of targets) {
        try {
          if (await isWorktreeDirty(git, [p])) dirty.add(p);
        } catch {
          dirty.add(p); // unknown state: treat as dirty, never commit it
        }
      }
    }

    // Apply under the guardrails, serialized with every other memory writer
    // (and with the loops tools when the ledger is a target).
    const apply = () =>
      this.d.writeQueue.enqueue(() =>
        applyDecisions(this.vault(), decisions, {
          ...env,
          today,
          now,
          offered,
          ledgerPath: paths.openLoops,
          provenance: { convoId: chat.id, chatTitle: safeTitle(chat.title), date: today },
        }),
      );
    const result = targets.includes(paths.openLoops) ? await this.d.loopsWriteQueue.enqueue(apply) : await apply();
    for (const r of result.rejected) this.d.diag(`harvest rejected ${r.decision.op}: ${r.reason}`);
    if (!result.writes.length) {
      this.d.diag(`harvest ${chat.id}: ${candidates.length} facts, nothing new`);
      return null;
    }

    const title = safeTitle(chat.title);
    const written = [...new Set(result.writes.map((w) => w.path))];
    const uncommitted = written.filter((p) => dirty.has(p));
    const clean = written.filter((p) => !dirty.has(p));
    const cleanWrites = result.writes.filter((w) => !dirty.has(w.path)).length;
    const sha = git && clean.length ? await this.commit(git, clean, harvestCommitMessage(cleanWrites, title)) : undefined;
    const record: HarvestRecord = {
      id: `h-${now.toString(36)}`,
      at: now,
      convoId: chat.id,
      title,
      writes: result.writes,
      ...(sha ? { sha } : {}),
      ...(sha && uncommitted.length ? { uncommitted } : {}),
    };
    await this.d.log.append(record);
    const n = result.writes.length;
    this.d.notify(`Exo remembered ${n} ${n === 1 ? "thing" : "things"} from "${title}". Undo: "Undo last memory write".`);
    this.d.diag(`harvest ${chat.id}: ${n} writes${sha ? ` ${sha.slice(0, 8)}` : ""}${uncommitted.length ? `, ${uncommitted.length} uncommitted` : ""}`);
    return record;
  }

  /** A budgeted utility call: null when the ledger denies it, "" on failure. */
  private async call(prompt: string, estimate: number): Promise<string | null> {
    if (!this.d.budget.check(estimate)) {
      this.d.diag("harvest skipped: background budget exhausted or disabled");
      return null;
    }
    const { text, tokens } = await this.d.utility(prompt, this.abort.signal);
    this.d.budget.record(tokens ?? estimate);
    return text.trim();
  }

  private targetEnv(today: string): TargetEnv {
    const paths = this.d.paths();
    return {
      exists: (p) => this.d.app.vault.getAbstractFileByPath(p) instanceof TFile,
      inboxPath: `${paths.inbox}/${today}.md`,
      blocked: harvestBlocklist(paths),
      excluded: vaultExclusion(this.d.app, ["Input/", `${paths.reports}/`]),
    };
  }

  private async readNote(path: string): Promise<string | null> {
    const f = this.d.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return null;
    try {
      return await this.d.app.vault.cachedRead(f);
    } catch {
      return null;
    }
  }

  /** The vault's own memory routing rules: the memory section of AGENTS.md. */
  private async memoryRules(): Promise<string> {
    const agents = await this.readNote("AGENTS.md");
    return agents ? memoryRulesSection(agents) : "";
  }

  /** The notes the rules name (plus the agent-lesson note), with their sections. */
  private async routingNotes(rules: string, env: TargetEnv): Promise<NoteContext[]> {
    const paths = this.d.paths();
    const named = [...explicitRulePaths(rules), `${paths.agentMemory}/exo.md`];
    const out: NoteContext[] = [];
    for (const path of new Set(named)) {
      if (out.length >= MAX_ROUTING_NOTES) break;
      if (checkTarget(path, env)) continue;
      const content = await this.readNote(path);
      if (content !== null) out.push({ path, headings: noteHeadings(content), lines: [] });
    }
    return out;
  }

  /** Search hits for one fact, each with its sections and the lines that
   *  share the fact's keywords (so an UPDATE can quote one exactly), plus the
   *  routing notes that contain such lines. */
  private async candidateNotes(
    keywords: readonly string[],
    routingNotes: readonly NoteContext[],
    env: TargetEnv,
  ): Promise<NoteContext[]> {
    const out: NoteContext[] = [];
    const seen = new Set<string>();
    const add = async (path: string, requireLines: boolean): Promise<void> => {
      if (seen.has(path) || checkTarget(path, env)) return;
      const content = await this.readNote(path);
      if (content === null) return;
      const lines = matchingLines(content, keywords);
      if (requireLines && !lines.length) return;
      seen.add(path);
      out.push({ path, headings: noteHeadings(content), lines });
    };
    const { hits } = await searchVaultNotes(this.d.app, keywords.slice(0, 8).join(" "), NOTES_PER_CANDIDATE * 2, env.excluded);
    for (const hit of hits) {
      if (out.length >= NOTES_PER_CANDIDATE) break;
      await add(hit.path, false);
    }
    for (const note of routingNotes) await add(note.path, true);
    return out;
  }

  private vault(): ApplyVault {
    const vault = this.d.app.vault;
    return {
      exists: (path) => vault.getAbstractFileByPath(path) instanceof TFile,
      edit: async (path, fn) => {
        const f = vault.getAbstractFileByPath(path);
        if (!(f instanceof TFile)) return false;
        let changed = false;
        // vault.process: the read-modify-write is atomic against the editor.
        await vault.process(f, (current) => {
          const next = fn(current);
          if (next === null) return current;
          changed = true;
          return next;
        });
        return changed;
      },
      create: async (path, content) => {
        const parts = path.split("/").slice(0, -1);
        for (let i = 1; i <= parts.length; i++) {
          const dir = parts.slice(0, i).join("/");
          if (!vault.getAbstractFileByPath(dir)) {
            try {
              await vault.createFolder(dir);
            } catch {
              /* created concurrently */
            }
          }
        }
        await vault.create(path, content);
      },
    };
  }

  /** A git runner for the vault when it is a git repo, else null. */
  private async repo(): Promise<GitRun | null> {
    const git = this.d.git();
    if (!git) return null;
    const { isGitRepo, gitAvailable } = await checkGitRepo(git);
    return isGitRepo && gitAvailable ? git : null;
  }

  /** Commit ONLY `paths`; the harvest commit's sha, or undefined when the
   *  commit did not happen. */
  private async commit(git: GitRun, paths: string[], message: string): Promise<string | undefined> {
    try {
      await runGitCommit(git, paths, message);
      const sha = await headSha(git);
      const subject = (await git(["log", "-1", "--format=%s", sha])).trim();
      return subject.startsWith(HARVEST_COMMIT_PREFIX) ? sha : undefined;
    } catch (err) {
      this.d.diag(`harvest commit failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }
}
