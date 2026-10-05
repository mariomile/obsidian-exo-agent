import { Notice, setIcon } from "obsidian";
import type { ChatView } from "../view";
import type { Convo } from "./convo-types";
import { clickable } from "./dom";
import { renderHistoryGroup, setCardSelected } from "./gallery-cards";
import { groupByTime, matchesFilters } from "../core/history";
import type { HistoryFilter, FilterableConvo } from "../core/history";
import { retiredFromStrip } from "../core/working-set";
import { visibleSelection } from "../core/retention";
import { projectDirName, resumeStatus, eligibleForFreeing } from "../core/resume-status";
import type { ResumeStatus } from "../core/resume-status";
import { readdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";

/** The conversation history overlay ("gallery") and its bulk-selection cluster,
 *  lifted out of `ChatView` whole. One instance per view, created in the
 *  `ChatView` field initializer and never replaced: the gallery's lifecycle is
 *  open/closed, not created/destroyed.
 *
 *  It talks back to the view the same way `ui/gallery-cards.ts` already does —
 *  a `ChatView` handle plus its public members — rather than through a bespoke
 *  callback host, so the extraction adds no new mechanism to learn. What DID
 *  move here is the state: `galleryEl`, the selection, the filters and the
 *  on-disk session snapshot all have exactly the gallery's lifetime, and
 *  leaving them on the view would have been the extraction in name only. */
export class GalleryView {
  /** Ids selezionati nella cronologia per un'azione bulk. Runtime-only, azzerato
   *  a ogni apertura della gallery. */
  gallerySelection = new Set<string>();
  /** Active history filter chips. Runtime-only, cleared on every gallery open —
   *  same lifetime as `gallerySelection`, so reopening the history is always a
   *  clean slate and never a filter the user forgot they left on. */
  private historyFilters = new Set<HistoryFilter>();
  /** Session ids the Claude CLI holds for this vault, read once per gallery
   *  open. `null` means the read failed or the directory is absent — and then
   *  the UI shows NO resume badge at all, never "everything restarts". The
   *  distinction is the whole safety property: a false warning on all thirty
   *  cards at once is worse than the feature not existing. Runtime-only. */
  private sessionsOnDisk: Set<string> | null = null;
  /** Disarms the bulk bar's pending delete (timer + outside-click listener).
   *  Set while a bar is armed, so rebuilding or closing the gallery can never
   *  strand the document-level listener. */
  private bulkDisarm: (() => void) | null = null;
  /** Re-runs the open gallery's grid against current state, preserving the
   *  search text and the active chips. Non-null exactly while a gallery is up.
   *  Exists because `renderGrid` is a closure over `showGallery`'s locals, and
   *  an action that changes what the cards say — freeing a session file — has
   *  to repaint them without tearing the history down and losing the user's
   *  place in it. */
  private galleryRerender: (() => void) | null = null;
  /** The overlay element while the history is up; `null` means closed, and every
   *  guard in this file reads it as exactly that. */
  galleryEl: HTMLElement | null = null;

  constructor(private view: ChatView) {}

  /** Open/close the gallery. With a `preset` the caller is naming a destination
   *  (the strip counter says "open the retired ones"), so an already-open
   *  gallery showing something else SWITCHES to that preset instead of closing
   *  — silently closing would break the affordance the counter advertises.
   *  Clicking it again, once the preset is exactly what's on screen, closes:
   *  that keeps the counter a toggle for its own destination, and the
   *  no-preset header icon behaves exactly as before. */
  toggleGallery(preset?: HistoryFilter): void {
    if (this.galleryEl) {
      const alreadyThere = !preset || (this.historyFilters.size === 1 && this.historyFilters.has(preset));
      this.hideGallery();
      if (alreadyThere) return;
      void this.showGallery(preset);
      return;
    }
    void this.showGallery(preset);
  }

  hideGallery(): void {
    // The bulk bar's armed state owns a document-level listener; the bar is about
    // to be removed with its container, so drop it here or it outlives the DOM.
    this.bulkDisarm?.();
    this.bulkDisarm = null;
    // The grid it would repaint is about to be gone; holding the closure would
    // also pin the search input and every card it built.
    this.galleryRerender = null;
    this.galleryEl?.remove();
    this.galleryEl = null;
    // The session-id set is only ever read while the gallery is up, and every
    // render path sits downstream of a fresh read — so this frees ~800 strings
    // rather than fixing a bug. Dropping it also keeps the field's meaning
    // honest: null means "not read", which is exactly true once the history is
    // closed.
    this.sessionsOnDisk = null;
    this.view.listEl.show();
    this.view.composer.getComposerEl().show();
    this.view.rebuildOutline();
  }

  /** List the session ids the Claude CLI currently holds for this vault.
   *  Returns null on ANY failure: a missing, unreadable, or unidentifiable
   *  directory is an unknown, not a verdict. `resumeStatus` turns that null into
   *  `unknown` for every conversation, which draws nothing — whereas returning
   *  an empty Set would be a confident "none of them resume". */
  private async readSessionsOnDisk(): Promise<Set<string> | null> {
    try {
      const base = this.view.vaultPath();
      // No base path (mobile, or any non-filesystem adapter) encodes to "" and
      // would aim at ~/.claude/projects itself: a directory that reads just
      // fine and holds no .jsonl — a *successful* read meaning "nothing
      // resumes". Refuse to answer instead of answering wrongly.
      if (!base) return null;
      const dir = `${homedir()}/.claude/projects/${projectDirName(base)}`;
      const names = await readdir(dir);
      return new Set(names.filter((n) => n.endsWith(".jsonl")).map((n) => n.slice(0, -6)));
    } catch {
      return null;
    }
  }

  /** Resume status of one conversation as the gallery sees it. Single seam, so
   *  the badge and the "Restarts" chip cannot drift apart: they are the
   *  same call on the same input, not two expressions that agree today.
   *
   *  A Codex conversation always reports `unknown`: its session id is a Codex
   *  thread under ~/.codex, not a Claude CLI session file, so checking it
   *  against the Claude project directory would mark every Codex chat
   *  "restarts" — the exact false alarm this feature exists to avoid.
   *
   *  A conversation with no messages reports `unknown` too. It has no session
   *  because no turn ever ran, so "restarts" is technically true and completely
   *  uninformative: there is no context to lose. The gallery always shows the
   *  focused chat even when it is empty, so without this the freshly opened
   *  "New chat" card would permanently wear a warning about losing nothing. */
  resumeStatusOf(c: Convo): ResumeStatus {
    if (c.messages.length === 0) return "unknown";
    return resumeStatus(c, c.provider === "claude" ? this.sessionsOnDisk : null);
  }

  /** `preset` accepts one filter or a set of them: a single value is what the
   *  strip counter passes, while the internal rebuild sites hand back the
   *  filters that were active before they tore the gallery down, so an
   *  unrelated event never silently undoes the user's chip selection. */
  private async showGallery(preset?: HistoryFilter | readonly HistoryFilter[]): Promise<void> {
    this.gallerySelection.clear();
    this.historyFilters.clear();
    if (preset) for (const f of typeof preset === "string" ? [preset] : preset) this.historyFilters.add(f);
    if (!this.view.convos.includes(this.view.active)) this.view.convos.push(this.view.active);
    this.view.listEl.hide();
    this.view.composer.getComposerEl().hide();
    const wrap = this.view.listHost.createDiv({ cls: "mva-gallery-wrap" });
    this.galleryEl = wrap;
    this.view.rebuildOutline(); // drop the outline rail while the gallery is up
    wrap.createDiv({ cls: "mva-gallery-title", text: "Conversations" });

    // Plan on OPEN, not only on persist: the candidate list is runtime state and
    // restore() never persists, so a freshly reloaded plugin would show no
    // banner however far over budget the store is. Cheap on reopen — convoSizeOf
    // is memoized, so this re-measures only what actually changed.
    this.view.recomputeRetention();

    // Retention proposal (R3): over budget we SHOW, we never delete. The banner
    // is inert until the user acts on it — it only preselects the candidates.
    if (this.view.retentionCandidateIds.length > 0) {
      const banner = wrap.createDiv({ cls: "mva-gallery-retention" });
      const n = this.view.retentionCandidateIds.length;
      banner.createSpan({
        cls: "mva-gallery-retention-text",
        text: `La cronologia ha superato il budget. ${n} conversazion${n === 1 ? "e" : "i"} tra le più vecchie possono essere eliminate.`,
      });
      const act = banner.createSpan({ cls: "mva-gallery-retention-act", text: "Seleziona" });
      clickable(act, () => this.selectCandidates());
    }

    const sorted = [...this.view.convos]
      .filter((c) => c.messages.length > 0 || c === this.view.active)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

    if (sorted.length === 0) {
      wrap.createDiv({ cls: "mva-gallery" }).createDiv({ cls: "mva-empty-sub", text: "No conversations yet." });
      return;
    }

    // Which convos belong to a "done" orchestration task, for the gallery's
    // Done/Archiviata chip. taskStore exists even with Orchestration off, so
    // this is always safe — it just resolves empty in that case.
    const { tasks } = await this.view.plugin.taskStore.load();
    if (this.galleryEl !== wrap) return; // gallery was closed while we awaited
    const doneConvoIds = new Set(tasks.filter((t) => t.status === "done" && t.convo).map((t) => t.convo!));

    // Which chats still have a CLI session behind them. Read once per open, not
    // per card: the answer is the same for the whole grid, and the search box
    // re-runs renderGrid on every keystroke.
    this.sessionsOnDisk = await this.readSessionsOnDisk();
    // Second suspension point, second guard — the one above covers only the
    // await it follows. Without this, closing the history while the directory
    // read is in flight leaves us building chips and cards into a detached DOM.
    if (this.galleryEl !== wrap) return; // gallery was closed while we awaited

    // Filter chips, single-select (radio semantics): at most one is active at
    // a time, so the results are never a confusing intersection of several
    // chips at once. Declared before `renderGrid` on purpose: the DOM order is
    // banner → chips → search → grid, and the click handlers only dereference
    // `renderGrid`/`search` when the user clicks, long after both bindings are
    // initialised. Same shape as the search box's own `input` listener below.
    const chipsWrap = wrap.createDiv({ cls: "mva-gallery-chips" });
    const CHIP_LABELS: Record<HistoryFilter, string> = {
      open: "Open",
      retired: "Retired",
      archived: "Archived",
      olderThan30: "Older than 30 days",
      shortConvo: "Under 3 messages",
      restarts: "Restarts",
    };
    // Every chip's paint fn, so clicking one can repaint the whole row — the
    // one that just lost exclusivity needs to visibly turn off too, not just
    // the one that was clicked.
    const chipPaints: (() => void)[] = [];
    for (const key of Object.keys(CHIP_LABELS) as HistoryFilter[]) {
      const chip = chipsWrap.createDiv({ cls: "mva-gallery-chip" });
      chip.setText(CHIP_LABELS[key]);
      // Class and `aria-pressed` move together, same discipline as
      // setCardSelected: clickable() stamps role="button" on the chip, and a
      // button with no `aria-pressed` announces no state at all — the active
      // chip would be visible to sighted users only.
      const paint = () => {
        const on = this.historyFilters.has(key);
        chip.toggleClass("is-active", on);
        chip.setAttr("aria-pressed", String(on));
      };
      chipPaints.push(paint);
      paint();
      clickable(chip, () => {
        // Clicking the active chip clears it (show everything again);
        // clicking a different one replaces whatever was active — never adds.
        const wasOn = this.historyFilters.has(key);
        this.historyFilters.clear();
        if (!wasOn) this.historyFilters.add(key);
        for (const p of chipPaints) p();
        renderGrid(search.value);
      });
    }

    const searchWrap = wrap.createDiv({ cls: "mva-gallery-search-wrap" });
    setIcon(searchWrap.createSpan({ cls: "mva-gallery-search-ico" }), "search");
    const search = searchWrap.createEl("input", {
      cls: "mva-gallery-search",
      attr: { type: "text", placeholder: "Search conversations…" },
    });
    const grid = wrap.createDiv({ cls: "mva-gallery" });
    const renderGrid = (q: string) => {
      grid.empty();
      const ql = q.toLowerCase().trim();
      const active = [...this.historyFilters];
      const now = Date.now();
      // Hoisted: the open-tab set is the same for every conversation in this
      // pass, so building it per card would be one allocation per card for no
      // difference in result.
      const openTabIds = new Set(this.view.openTabs);
      // Chips restrict, then the text search restricts what is left, then the
      // grouping applies to the survivors (R5). Order matters only for cost:
      // the result is the same set either way, and `convoMatches` is the
      // expensive half, so it runs last.
      const filtered = sorted.filter((c) => {
        const asFilterable: FilterableConvo = {
          id: c.id,
          updatedAt: c.updatedAt,
          retiredAt: c.retiredAt,
          archived: c.archived,
          openTabIds,
          messages: c.messages,
          restarts: this.resumeStatusOf(c) === "restarts",
        };
        return matchesFilters(asFilterable, active, now) && (!ql || this.convoMatches(c, ql));
      });

      // "Recently retired" pulls from the ALREADY filtered set, and the rest
      // is the complement of it — so a conversation lands in exactly one group,
      // never in both its retired group and its time bucket.
      const retiredGroup = retiredFromStrip(filtered, this.view.openTabs, now);
      const retiredIds = new Set(retiredGroup.map((c) => c.id));
      const rest = filtered.filter((c) => !retiredIds.has(c.id));

      if (retiredGroup.length > 0) {
        renderHistoryGroup(this.view, grid, "Recently retired", retiredGroup, doneConvoIds, true);
      }
      for (const g of groupByTime(rest, now)) {
        renderHistoryGroup(this.view, grid, g.label, g.items, doneConvoIds);
      }

      if (filtered.length === 0) {
        grid.createDiv({ cls: "mva-empty-sub", text: "No matching conversations." });
      }
      // Filtering changes which cards exist, and the bulk bar counts only cards
      // the user can see — so the bar has to be recomputed with the grid, not
      // just when the selection itself changes.
      this.renderBulkBar();
    };
    search.addEventListener("input", () => renderGrid(search.value));
    // Re-render on demand from outside this closure, keeping whatever the user
    // has typed and toggled. Bound here rather than exposing renderGrid itself
    // so callers cannot accidentally reset the search box by passing "".
    this.galleryRerender = () => renderGrid(search.value);
    renderGrid("");
  }

  /* ------------------------ gallery bulk selection ---------------------- */

  /** Ids of the cards the grid is currently painting — i.e. what the user can
   *  actually see, after the search box has had its say. */
  private visibleCardIds(): Set<string> {
    const ids = new Set<string>();
    this.galleryEl?.querySelectorAll<HTMLElement>(".mva-card").forEach((el) => {
      const id = el.dataset.convoId;
      if (id) ids.add(id);
    });
    return ids;
  }

  /** The selection, restricted to what is on screen. Every consumer — the bar's
   *  count, the armed label, the delete itself — goes through this, so the
   *  number the user confirms and the set that is deleted are the same set by
   *  construction. See `visibleSelection` in core/retention for why. */
  private effectiveSelection(): string[] {
    return visibleSelection(this.gallerySelection, this.visibleCardIds());
  }

  /** Preselect the retention candidates so the user can review and confirm in
   *  one action. Selecting is not deleting: the bulk bar still asks. Under an
   *  active search the bar counts only the candidates actually on screen — the
   *  selection keeps the rest, and they come back when the filter clears. */
  private selectCandidates(): void {
    this.gallerySelection = new Set(this.view.retentionCandidateIds);
    this.refreshSelectionUI();
  }

  /** Paint the current selection onto the cards already on screen and refresh
   *  the bulk bar. Cards render their own `is-selected` from `gallerySelection`,
   *  so changing the selection in bulk needs no gallery teardown: the search
   *  box, the scroll position and the card DOM all survive. */
  private refreshSelectionUI(): void {
    this.galleryEl?.querySelectorAll<HTMLElement>(".mva-card").forEach((el) => {
      const id = el.dataset.convoId;
      setCardSelected(el, !!id && this.gallerySelection.has(id));
    });
    this.renderBulkBar();
  }

  /** The bulk action bar — visible only while something on screen is selected.
   *  Rebuilt on every selection change AND on every grid re-render, which also
   *  disarms a pending delete: neither growing the selection nor changing the
   *  filter can inherit a confirmation the user gave for a different set. */
  renderBulkBar(): void {
    // Always drop the previous bar's arm state first — it owns a timer and a
    // document-level listener that must not outlive the element.
    this.bulkDisarm?.();
    this.bulkDisarm = null;
    const wrap = this.galleryEl;
    if (!wrap) return;
    wrap.querySelector(".mva-gallery-bulk")?.remove();
    const selected = this.effectiveSelection();
    const n = selected.length;
    if (n === 0) return;
    const bar = wrap.createDiv({ cls: "mva-gallery-bulk" });
    bar.createSpan({ text: `${n} selezionat${n === 1 ? "a" : "e"}` });

    // Claude-only, exactly like the badge (`resumeStatusOf`): a Codex sessionId
    // names a thread under ~/.codex, a different id space entirely — matching it
    // against Claude's project directory is meaningless, and filtering here is
    // what keeps a Codex thread id from ever reaching an unlink call.
    //
    // `this.sessionsOnDisk` is the set showGallery() already read; the button and
    // the badge answer from the same snapshot, and neither costs a second scan.
    // Null (unread / unreadable) collapses to an empty set: no evidence, so
    // nothing is eligible and no control appears — the safe direction here.
    //
    // Indexed once rather than two `find()` scans per selected id: this runs on
    // every search keystroke, and the selection can be the entire history.
    const byId = new Map(this.view.convos.map((c) => [c.id, c] as const));
    const freeable = eligibleForFreeing(
      selected.filter((id) => byId.get(id)?.provider === "claude"),
      (id) => byId.get(id)?.sessionId,
      this.sessionsOnDisk ?? new Set(),
      this.view.active.id,
    );
    // No eligible session → no control at all. A button that looks actionable and
    // silently does nothing teaches the user the wrong thing about the action.
    const freeDisarm = freeable.length > 0 ? this.addBulkFree(bar, freeable) : null;

    const del = bar.createSpan({ cls: "mva-gallery-bulk-del", text: "Delete" });
    // Same arm/disarm shape as the per-card trash (addCardDelete): a 3s timer
    // plus a capturing outside-click. The N-conversation control must not be
    // guarded more weakly than the one-conversation one, which is what a bare
    // closure flag — armed until the bar happens to be rebuilt — amounted to.
    let armed = false;
    let disarmTimer: number | null = null;
    const outside = (ev: MouseEvent) => {
      if (ev.target !== del && !del.contains(ev.target as Node)) disarm();
    };
    const disarm = () => {
      armed = false;
      del.removeClass("is-armed");
      del.setText("Delete");
      if (disarmTimer) {
        window.clearTimeout(disarmTimer);
        disarmTimer = null;
      }
      document.removeEventListener("click", outside, true);
    };
    // The bar owns ONE teardown but can now hold two armed controls, and neither
    // hideGallery nor the next renderBulkBar knows which one the user touched —
    // so clear both.
    this.bulkDisarm = () => {
      freeDisarm?.();
      disarm();
    };
    clickable(del, () => {
      if (!armed) {
        armed = true;
        del.addClass("is-armed");
        del.setText(`Delete ${n} permanently`);
        disarmTimer = window.setTimeout(disarm, 3000);
        document.addEventListener("click", outside, true);
        return;
      }
      disarm();
      this.deleteSelected();
    });
    const cancel = bar.createSpan({ cls: "mva-gallery-bulk-cancel", text: "Cancel" });
    clickable(cancel, () => {
      this.gallerySelection.clear();
      this.refreshSelectionUI();
    });
  }

  /** The "free the session file" control, sitting between the count and
   *  `Elimina`. Returns its own disarm so the bar can tear down whichever
   *  control the user armed.
   *
   *  Deliberately lighter than `Elimina`: muted rather than error red, and NOT
   *  pushed right — that slot belongs to the one action that removes something
   *  the user reads. This removes a support file; the conversation itself is
   *  untouched. The two-stage confirm is `Elimina`'s exact shape (3s timer plus
   *  a capturing outside click) because the action is still irreversible — only
   *  the visual weight differs, never the guard.
   *
   *  `ids` are already the ELIGIBLE ones, each resolved to a session file the
   *  gallery just saw on disk. So the number on the button is the number of
   *  files that will actually go, never the raw selection count: a control that
   *  promises 5 and frees 2 is a control that lies. */
  private addBulkFree(bar: HTMLElement, ids: readonly string[]): () => void {
    const label = `Free ${ids.length} session${ids.length === 1 ? "" : "s"}`;
    const free = bar.createSpan({ cls: "mva-gallery-bulk-free", text: label });
    let armed = false;
    let disarmTimer: number | null = null;
    const outside = (ev: MouseEvent) => {
      if (ev.target !== free && !free.contains(ev.target as Node)) disarm();
    };
    const disarm = () => {
      armed = false;
      free.removeClass("is-armed");
      free.setText(label);
      if (disarmTimer) {
        window.clearTimeout(disarmTimer);
        disarmTimer = null;
      }
      document.removeEventListener("click", outside, true);
    };
    clickable(free, () => {
      if (!armed) {
        armed = true;
        free.addClass("is-armed");
        free.setText(`Confirm — free ${ids.length}`);
        disarmTimer = window.setTimeout(disarm, 3000);
        document.addEventListener("click", outside, true);
        return;
      }
      disarm();
      void this.freeAndRefresh(ids);
    });
    return disarm;
  }

  /** Free the session files, then make the open gallery tell the truth again.
   *
   *  The snapshot is stale the moment an unlink lands, and simply nulling it was
   *  wrong in two directions at once. Nulling blanks the resume badge for EVERY
   *  conversation on screen — including the ones whose session files were never
   *  touched — as soon as anything re-renders, which one keystroke in the search
   *  box is enough to trigger. And `disarm()` restores the resting label without
   *  rebuilding the bar, so the control would go on advertising "Free 2
   *  sessions" for files that no longer exist; a second click would unlink
   *  nothing and report "0 sessions freed". That is precisely the
   *  looks-actionable-but-isn't failure the eligibility rule exists to prevent,
   *  leaking back in on the far side of the action.
   *
   *  So: re-read, then repaint. This is not the second read the plan rules out —
   *  that rule keeps the eligibility DECISION on one consistent snapshot, while
   *  reading back a change we just made is the only way the next decision starts
   *  from the truth. Order is load-bearing: read first, so the rebuild sees it.
   *
   *  Both steps are skipped when the gallery closed mid-flight — `hideGallery`
   *  has already set the snapshot to null, which is then correct ("not read"),
   *  and the next open re-reads anyway. */
  private async freeAndRefresh(ids: readonly string[]): Promise<void> {
    const freed = await this.freeSessions(ids);
    if (this.galleryEl) {
      this.sessionsOnDisk = await this.readSessionsOnDisk();
      // Rebuilds the cards AND the bulk bar (renderGrid ends in renderBulkBar):
      // the freed conversations pick up the "Restart" badge immediately, the
      // untouched ones keep their badge, and the control recounts against what
      // is actually left — or disappears when nothing is.
      this.galleryRerender?.();
    }
    new Notice(`Freed ${freed} session${freed === 1 ? "" : "s"}. Content is untouched.`);
  }

  /** Delete the CLI session files for `ids`, and only those — never anything
   *  else in the shared projects directory. Every path is built from a
   *  `sessionId` the eligibility check already matched against a real file in
   *  this vault's own project directory, and `projectDirName` is reused rather
   *  than re-derived so the encoding cannot drift from the read that found them.
   *
   *  Best-effort per file: one failure (EACCES, a file already gone) must not
   *  stop the rest, and there is nothing useful to surface per file — the badge
   *  self-corrects on the next gallery open either way.
   *
   *  Nothing on the `Convo` is touched. Freeing a session is not editing a
   *  conversation, and leaving `sessionId` in place keeps the badge honest: it
   *  reports what the disk says, not what this method remembers doing. */
  private async freeSessions(ids: readonly string[]): Promise<number> {
    const base = this.view.vaultPath();
    if (!base) return 0;
    const dir = `${homedir()}/.claude/projects/${projectDirName(base)}`;
    let freed = 0;
    for (const id of ids) {
      const sessionId = this.view.convos.find((x) => x.id === id)?.sessionId;
      if (!sessionId) continue;
      try {
        await unlink(`${dir}/${sessionId}.jsonl`);
        freed++;
      } catch {
        /* best-effort: a failed unlink is not worth aborting the rest for */
      }
    }
    return freed;
  }

  /** Permanently drop every selected conversation. The only deletion path that
   *  this plan adds — and it is always user-confirmed (armed twice).
   *
   *  Deletes the VISIBLE selection, never the raw set: the count the user just
   *  confirmed came from the same call, so the blast radius can never exceed
   *  what the confirmation showed. */
  private deleteSelected(): void {
    const ids = this.effectiveSelection();
    const removed: string[] = [];
    for (const id of ids) {
      const c = this.view.convos.find((x) => x.id === id);
      if (!c || c === this.view.active) continue; // never delete the focused chat
      this.view.dropSession(c, "user-delete");
      const tabIdx = this.view.openTabs.indexOf(c.id);
      if (tabIdx !== -1) this.view.openTabs.splice(tabIdx, 1);
      const idx = this.view.convos.indexOf(c);
      if (idx !== -1) this.view.convos.splice(idx, 1);
      this.view.convoSizeCache.delete(id);
      removed.push(id);
    }
    // Clear the WHOLE selection, not just what was deleted: any id that was
    // selected but filtered out of view was never confirmed, so it must not
    // survive as a live selection into whatever the user does next.
    this.gallerySelection.clear();
    // Only what actually went away leaves the candidate list: a skipped active
    // chat is still over budget and must still be proposed next time.
    const gone = new Set(removed);
    this.view.retentionCandidateIds = this.view.retentionCandidateIds.filter((id) => !gone.has(id));
    this.view.persistTabs();
    this.view.persist();
    this.view.renderTabs();
    // Carry the active chips across the rebuild: the user chose them, and a
    // delete they asked for must not silently reset what they are looking at.
    const keepFilters = [...this.historyFilters];
    this.hideGallery();
    void this.showGallery(keepFilters);
    // The zero case is not "0 deleted": it happens when the selection held
    // only the active chat, which the loop skips. Say so, instead of reporting
    // a number that reads like an error.
    const n = removed.length;
    new Notice(
      n === 0
        ? "No conversation deleted: the active chat can't be deleted from here."
        : n === 1
          ? "1 conversation deleted."
          : `${n} conversations deleted.`
    );
  }

  /** True if the query matches a conversation's title or any of its message text. */
  private convoMatches(c: Convo, ql: string): boolean {
    if (c.title.toLowerCase().includes(ql)) return true;
    for (const m of c.messages) {
      const text =
        m.role === "user"
          ? m.text
          : m.segments.map((s) => (s.t === "text" ? s.md : "")).join(" ");
      if (text.toLowerCase().includes(ql)) return true;
    }
    return false;
  }

  /** Rebuild an OPEN gallery in place, replaying the active chips — and do
   *  nothing at all while a bulk selection is up, because `showGallery()`
   *  clears the selection. The only caller (an AI title landing behind the
   *  overlay) spells out why that guard matters at its call site. */
  rebuildIfIdle(): void {
    if (this.galleryEl && this.gallerySelection.size === 0) {
      const keepFilters = [...this.historyFilters];
      this.hideGallery();
      void this.showGallery(keepFilters);
    }
  }
}
