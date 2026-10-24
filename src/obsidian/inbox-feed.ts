/**
 * The Inbox's data and its verbs (Release 2). `core/inbox` decides what counts;
 * this gathers what it counts and writes back what the user did about it.
 *
 * Two speeds of source. Chats, the Daily Pulse state and the read marks are in
 * memory, so `current()` reads them fresh on every paint. Automation runs,
 * pending suggestions and Exo Queue answers live on disk, so `refresh()` loads
 * them into a snapshot: it runs after every write to one of them (main.ts
 * `refreshInbox`) and on a minute tick while at least one surface is
 * subscribed. Every surface paints from `current()`, so the sidebar and the
 * Cockpit can never show two different counts.
 *
 * Every verb mutates the source (a chat's `seenAt`, a run's `reviewedAt`, the
 * pulse's `lastReviewedAt`); queue answers alone go to `settings.inboxSeen`.
 */
import { Notice, TFile, TFolder } from "obsidian";
import type ExoPlugin from "../main";
import { buildInbox, pruneSeen, type Inbox, type InboxAnswer, type InboxHandlers, type InboxItem } from "../core/inbox";
import { parseAnsweredStamp } from "../core/cockpit";
import type { AutomationRunRecord } from "../core/automations";

const REFRESH_MS = 60_000;
/** Queue notes scanned for an answer stamp, most recently modified first.
 *  Bounded: a queue folder is a working set, not an archive. */
const ANSWER_SCAN = 20;

interface Snapshot {
  runs: AutomationRunRecord[];
  proposals: number;
  answers: InboxAnswer[];
}

export class InboxFeed {
  private snap: Snapshot = { runs: [], proposals: 0, answers: [] };
  private readonly listeners = new Set<() => void>();
  /** The minute tick, alive only while a surface is subscribed. */
  private timer: number | null = null;
  /** Bumped per `refresh()`: a load that finishes after a newer one started is dropped. */
  private seq = 0;

  constructor(private readonly plugin: ExoPlugin) {}

  /** The first load, and the tick's teardown on unload. Called once from `onload`. */
  start(): void {
    this.plugin.register(() => this.stopTick());
    this.plugin.app.workspace.onLayoutReady(() => {
      // Runs are filed by the automation list: repaint when it loads or changes.
      this.plugin.automationStore.onChange(() => this.emit());
      void this.refresh();
    });
  }

  /** Reload the on-disk sources, then tell every surface. Tolerant: a source
   *  that fails to load contributes nothing rather than blocking the rest. */
  async refresh(): Promise<void> {
    const mine = ++this.seq;
    const p = this.plugin;
    const [runs, proposals, answers] = await Promise.all([
      p.loadAutomationRuns().catch(() => []),
      p.settings.proposalKernelEnabled
        ? p.listPendingProposals().then(({ records }) => records.length).catch(() => 0)
        : Promise.resolve(0),
      this.queueAnswers(),
    ]);
    if (mine !== this.seq) return; // a newer refresh owns the snapshot
    this.snap = { runs, proposals, answers };
    this.emit();
  }

  /** The Inbox as of `now`: synchronous, so a paint never waits on disk. */
  current(now = Date.now()): Inbox {
    const s = this.plugin.settings;
    const rows = this.plugin.listChatRows();
    return buildInbox({
      chats: rows ? rows.map((r) => ({ ...r, focused: r.focused === true })) : null,
      runs: this.snap.runs,
      automations: this.plugin.automationStore.list(),
      proposals: this.snap.proposals,
      pulse: s.dailyPulseReviewState,
      answers: this.snap.answers,
      seen: s.inboxSeen,
      now,
    });
  }

  /** Subscribe to "the Inbox may have moved". Returns the unsubscribe. The
   *  first subscriber starts the minute tick, the last one stops it. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    if (this.timer === null) {
      this.timer = window.setInterval(() => void this.refresh(), REFRESH_MS);
      void this.refresh();
    }
    return () => {
      this.listeners.delete(cb);
      if (this.listeners.size === 0) this.stopTick();
    };
  }

  private stopTick(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  /** Exo Queue notes that carry an answer stamp. */
  private async queueAnswers(): Promise<InboxAnswer[]> {
    const { vault } = this.plugin.app;
    const folder = vault.getAbstractFileByPath(this.plugin.settings.exoQueueFolder);
    if (!(folder instanceof TFolder)) return []; // no queue folder
    const notes = folder.children
      .filter((f): f is TFile => f instanceof TFile && f.extension === "md")
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, ANSWER_SCAN);
    const out: InboxAnswer[] = [];
    for (const f of notes) {
      const t = parseAnsweredStamp(await vault.cachedRead(f).catch(() => ""));
      if (t != null) out.push({ path: f.path, name: f.basename, answeredAt: t });
    }
    return out;
  }

  /* -------------------------------- verbs -------------------------------- */

  /** The handlers every Inbox panel is mounted with. */
  readonly handlers: InboxHandlers = {
    open: (it) => void this.open(it),
    decide: (it, verdict) => {
      if (!this.plugin.decidePermission(it.target, verdict)) new Notice("That request was already answered.");
      this.emit();
    },
    clear: (items) => void this.clear(items),
    markReviewed: (it) => void this.plugin.markAutomationRunsReviewed(it.runIds ?? []),
    retry: (it) => void this.retry(it),
  };

  /** Row click: resolve a request or an error, read a result. */
  private async open(it: InboxItem): Promise<void> {
    const p = this.plugin;
    switch (it.source) {
      case "chat":
        await p.revealConversation(it.target);
        return;
      case "runs":
      case "run":
        await p.activateHub("automations");
        return;
      case "proposals":
        await p.openProposalsModal();
        return;
      case "pulse":
        if (it.kind === "error") await p.activateHub("automations");
        else await p.openDailyPulse();
        return;
      case "answer":
        await p.app.workspace.openLinkText(it.target, "", "tab");
        await this.clear([it]);
        return;
    }
  }

  /** Dismiss errors and mark results read, each on its own source. */
  private async clear(items: readonly InboxItem[]): Promise<void> {
    const p = this.plugin;
    const now = Date.now();
    const chats = items.filter((i) => i.source === "chat").map((i) => i.target);
    if (chats.length) p.markSeen(chats);
    const runIds = items.filter((i) => i.source === "run").flatMap((i) => i.runIds ?? []);
    let save = false;
    if (items.some((i) => i.source === "pulse")) {
      p.settings.dailyPulseReviewState.lastReviewedAt = now;
      save = true;
    }
    const answers = items.filter((i) => i.source === "answer");
    if (answers.length) {
      const seen: Record<string, number> = { ...p.settings.inboxSeen };
      for (const a of answers) seen[a.id] = now;
      p.settings.inboxSeen = pruneSeen(seen, now);
      save = true;
    }
    if (save) await p.saveSettings();
    if (runIds.length) await p.markAutomationRunsReviewed(runIds);
    else this.emit();
  }

  /** Try a failed run or a failed Daily Pulse again. */
  private async retry(it: InboxItem): Promise<void> {
    const p = this.plugin;
    if (it.source === "pulse") {
      await p.runDailyPulseNow();
      return;
    }
    const a = p.automationStore.get(it.target);
    if (!a) {
      new Notice(`Automation "${it.title}" not found.`);
      return;
    }
    await p.runAutomationNow(a);
  }
}
