/**
 * The `exo-chats` sidebar — every AI conversation in one left-hand list,
 * grouped by state (what needs you, what is running, what you have open) or,
 * in `days` mode, by the day it was last touched. It is also the mission deck:
 * the Inbox above the search field (ui/inbox-panel), and a decision you can
 * take from the row itself when a chat is blocked on a permission.
 *
 * THE BOUNDARY. This pane owns no conversation. It reads them through
 * `plugin.listChatRows()` and it CHANGES them only through plugin wrappers —
 * `main.ts` / `ui/convo-bridge.ts` — which is why nothing here holds a
 * `ChatView`, imports one, or knows the shape of one. That was true when the
 * pane only browsed; it is load-bearing now that it decides. An inline Allow
 * resolves the same permission card the transcript would, through the card's
 * own settle path (`ui/chat-actions.ts` `decidePermission`), so there is one
 * verdict path and not two. A test enforces the rule the comment states
 * (`tests/chat-list-state.test.ts`, "the chats pane's reader/owner boundary").
 *
 * What the pane may do on its own is unchanged: clicking a row reveals the
 * conversation in whatever Exo pane is open — a row click never moves the chat
 * and never spawns one. (The header `+` does spawn one; that is an explicit
 * gesture, not a side effect of browsing.)
 *
 * All tiering, filtering and grouping is decided by `core/chat-rows`, and what
 * a row SAYS by `core/chat-list-state` — both pure; this file owns the DOM, the
 * clock read, and the gestures.
 */
import { ItemView, Menu, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import type ExoPlugin from "../main";
import {
  buildChatList,
  needsYou,
  rowAge,
  modelLabel,
  type ChatRow,
  type ChatSection,
  type ChatListMode,
} from "../core/chat-rows";
import type { ChatSectionKey } from "../core/chat-rows";
import { openChatRowMenu } from "./chat-row-menu";
import { addAutoSettleItems } from "./auto-settle-menu";
import {
  chatDot,
  chatRowSig,
  isSectionCollapsed,
  rowPreview,
  rowStatusText,
  toggleSectionCollapsed,
  type ChatDot,
} from "../core/chat-list-state";
import { reconcileList, type CardModel } from "./keyed-reconcile";
import { clickable, isolateActivation } from "./dom";
import { recallChats, reindexChats, recallHost, isRecallUnavailable } from "./chat-recall";
import { addScheduledButton } from "./scheduled-ui";
import { mountInbox } from "./inbox-panel";

export const CHATS_VIEW_TYPE = "exo-chats";
export const CHATS_ICON = "hi-messages";

/** Per-pane prefix for the header/list id pairs that wire `aria-controls` and
 *  `aria-labelledby`. Obsidian allows the same view type in two leaves, and two
 *  panes minting the same ids would point every header at the first pane's
 *  lists — a screen reader would then announce the wrong section. */
let paneSeq = 0;

/** How often the list re-derives. Nothing announces a change to the chats, so
 *  this tick is the only freshness the pane has — it also advances the
 *  relative-time labels. reconcileList diffs by signature, so a tick with no
 *  change touches no DOM.
 *
 *  This is also the live phrase's SAMPLE RATE, and that is an accepted
 *  tradeoff, not an oversight. Nothing fires on a tool call, so a running row
 *  picks the phrase up on the next tick: a burst of sub-second tool calls will be caught
 *  mid-call sometimes and between calls ("Working") others. What the row must
 *  never do is show a phrase for a tool that has finished — and it cannot, the
 *  phrase is deleted on the result. Sampling the truth is fine; a push on every
 *  tool call would be a new event surface bought for a phrase. */
const BACKSTOP_MS = 5000;

/** The three empty states, kept distinct on purpose. `open-exo` means the data
 *  exists on disk but no ChatView is mounted to read it — rendering "no chats"
 *  there would be a lie about the user's own history, which is exactly why the
 *  bridge returns `null` instead of `[]`. */
type EmptyKind = "open-exo" | "no-chats" | "no-matches";

/** What the gutter dot says out loud. Shape and colour are the visual channel;
 *  a screen reader gets neither, so the meaning is spelled out. */
const DOT_LABEL: Record<ChatDot, string> = {
  running: "Running",
  "needs-you": "Needs you",
  unseen: "Unseen reply",
};

export class ChatListView extends ItemView {
  private query = "";
  private listHost: HTMLElement | null = null;
  /** The Inbox, pinned above the search field. Outside `listHost` on purpose:
   *  no section owns it, so no collapsed section or half-typed search can put
   *  away what waits for you. */
  private inboxHost: HTMLElement | null = null;
  private emptyHost: HTMLElement | null = null;
  private searchEl: HTMLInputElement | null = null;
  /** Which empty state is currently painted, so the 5s backstop doesn't rebuild
   *  it (and steal focus from its button) on every tick. Same reasoning as the
   *  hub's `renderedTab` guard. `null` means the list itself is on screen. */
  private emptyKind: EmptyKind | null = null;
  /** Visible row ids, in painted order — the axis the arrow keys move along.
   *  Recomputed every paint so the cursor can never point at a row that was
   *  filtered out or archived since the last keystroke. */
  private order: string[] = [];
  /** Ids from the last semantic pass, and the query they answered. Both are
   *  kept so a stale result can be recognised and dropped: the pass is ~0.8s
   *  and the user keeps typing, so answers routinely arrive for a query that is
   *  no longer on screen. */
  private semanticIds: string[] = [];
  private semanticFor = "";
  private semanticTimer: number | null = null;
  /** Keyboard cursor. Applied as a class after reconciliation rather than
   *  carried in the row signature: putting it in the signature would rebuild two
   *  rows on every arrow press, which drops focus and defeats the point. */
  private cursor: string | null = null;
  /** Namespace for this pane's aria ids — see `paneSeq`. */
  private readonly uid = `exo-chats-${++paneSeq}`;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: ExoPlugin) {
    super(leaf);
  }

  getViewType(): string { return CHATS_VIEW_TYPE; }
  getDisplayText(): string { return "Exo chats"; }
  getIcon(): string { return CHATS_ICON; }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("mva-root");
    this.contentEl.addClass("mva-chats");
    this.buildChrome();
    // The backstop is wired BEFORE the first paint, deliberately. A paint that
    // throws while the ChatView is still restoring — which is exactly what a
    // plugin reload produces — must not be able to leave this pane with no
    // backstop. Painting first turned one transient failure into a permanently
    // dead view: chrome on screen, zero rows, and nothing ever scheduled to try
    // again. A render may fail and retry; a timer that was never registered
    // never retries.
    this.registerInterval(window.setInterval(() => this.paint(), BACKSTOP_MS));
    // The ChatView may still be restoring when this first paints — one delayed
    // catch-up picks the conversations up without waiting for the backstop.
    // Registered, not bare: an unmanaged
    // timer fires after onClose and paints into detached DOM. Timer ids are a
    // shared space, so registerInterval clears a setTimeout just as well.
    this.registerInterval(window.setTimeout(() => this.paint(), 800));
    // Runs, suggestions and queue answers move on disk, not on this tick: the
    // feed says when, so the Inbox does not wait five seconds to agree. The
    // whole pane: an Inbox action (dismiss, mark read) moves the rows too.
    this.register(this.plugin.inbox.onChange(() => this.paint()));
    this.paint();
    // Bring the semantic index up to date in the background. Incremental and
    // pipeline-free when nothing changed, so opening the pane costs ~50ms; the
    // expensive case is a first build, which is exactly when you want it to
    // happen unattended rather than on the first search.
    void reindexChats(recallHost(this.pluginDir()));
  }

  /* ------------------------------- chrome ------------------------------- */

  private buildChrome(): void {
    const root = this.contentEl;
    root.empty();

    const head = root.createDiv({ cls: "mva-chats-head" });
    head.createSpan({ cls: "mva-chats-heading mva-type-eyebrow", text: "Chats" });
    const sort = head.createEl("button", { cls: "mva-icon-btn", attr: { "aria-label": "Grouping" } });
    setIcon(sort, "arrow-down-narrow-wide");
    sort.onclick = (e) => this.groupingMenu(e);
    const add = head.createEl("button", { cls: "mva-icon-btn", attr: { "aria-label": "New chat" } });
    setIcon(add, "plus");
    add.onclick = () => void this.plugin.newConversation();
    addScheduledButton(head, this.plugin);

    // Above the search field: the one band no filter or collapsed section can
    // empty. Built once and left empty; `:empty` collapses it in CSS.
    this.inboxHost = root.createDiv({ cls: "mva-inbox mva-chats-inbox" });

    const search = root.createEl("input", {
      cls: "mva-chats-search",
      attr: { type: "search", placeholder: "Search chats" },
    });
    search.addEventListener("input", () => {
      this.query = search.value;
      // A new filter invalidates the old cursor position; re-anchor to the top
      // so Enter after typing opens the best match, not a stale row.
      this.cursor = null;
      this.paint();
      this.scheduleSemantic();
    });
    search.addEventListener("keydown", (e) => this.onKey(e));
    this.searchEl = search;

    const body = root.createDiv({ cls: "mva-chats-body" });
    // Two siblings, not one host: `reconcileList` orders by child INDEX, so a
    // section header or an empty-state box sharing a container would occupy an
    // index and shuffle the rows out of the order the model asked for
    // (keyed-reconcile.ts:23-32). `listHost` holds only sections, each of which
    // holds a header plus its own reconciled list — so no reconciled container
    // ever contains anything but rows.
    this.listHost = body.createDiv({ cls: "mva-chats-sections" });
    this.emptyHost = body.createDiv({ cls: "mva-chats-empty" });
    // tabindex so the list itself can hold focus and answer arrow keys after a
    // click, without stealing them from the search field when that has focus.
    body.tabIndex = 0;
    body.addEventListener("keydown", (e) => this.onKey(e));
  }

  /**
   * Grouping picker. A menu with both options checked/unchecked rather than a
   * button that flips: the two readings are peers, and a toggle would force you
   * to click it to find out which one you are in.
   */
  private groupingMenu(e: MouseEvent): void {
    const menu = new Menu();
    const pick = (mode: ChatListMode, title: string, icon: string) =>
      menu.addItem((i) =>
        i
          .setTitle(title)
          .setIcon(icon)
          .setChecked(this.mode() === mode)
          .onClick(() => {
            this.plugin.settings.chatsMode = mode;
            void this.plugin.saveSettings();
            // The cursor indexes into the painted order, which is about to be a
            // different order entirely.
            this.cursor = null;
            this.paint();
          }),
      );
    pick("activity", "Group by activity", "layers");
    pick("days", "Group by day", "calendar-days");
    addAutoSettleItems(menu, this.plugin.settings.chatsAutoSettleDays, (days) => {
      this.plugin.settings.chatsAutoSettleDays = days;
      void this.plugin.saveSettings();
      this.paint();
    });
    menu.showAtMouseEvent(e);
  }

  focusSearch(): void { this.searchEl?.focus(); this.searchEl?.select(); }

  private mode(): ChatListMode {
    return this.plugin.settings.chatsMode === "days" ? "days" : "activity";
  }

  /* ------------------------------ semantic ------------------------------ */

  /**
   * Run the semantic pass once the typing stops. Debounced, not per keystroke:
   * a query costs ~0.8s and spawning one per character would queue a dozen
   * processes to answer questions the user has already moved past.
   */
  private scheduleSemantic(): void {
    if (this.semanticTimer !== null) window.clearTimeout(this.semanticTimer);
    const q = this.query.trim();
    // Clearing the box must clear the Related section immediately — leaving it
    // would show results for a search that is no longer on screen.
    if (!q) {
      this.semanticIds = [];
      this.semanticFor = "";
      return;
    }
    if (isRecallUnavailable()) return;
    this.semanticTimer = window.setTimeout(() => {
      void recallChats(recallHost(this.pluginDir()), q).then((ids) => {
        // `null` means the pass could not run; keep whatever was already there
        // rather than blanking a good section on a transient failure.
        if (ids === null) return;
        // The answer is only valid for the query it was asked about.
        if (this.query.trim() !== q) return;
        this.semanticIds = ids;
        this.semanticFor = q;
        this.paint();
      });
    }, 350);
  }

  private pluginDir(): string {
    const base = this.app.vault.adapter as unknown as { basePath?: string };
    return `${base.basePath ?? ""}/${this.plugin.manifest.dir ?? ""}`;
  }

  /* -------------------------------- paint ------------------------------- */

  private paint(): void {
    if (!this.listHost) return;
    // BEFORE the empty states, deliberately: the Inbox answers "what is waiting
    // on me", and a search that matches nothing must not take that off screen.
    this.paintInbox();
    const sources = this.plugin.listChatRows();
    if (sources === null) return this.renderEmpty("open-exo");
    // One clock read per paint: grouping and the row labels must agree, and two
    // Date.now() calls a few lines apart can straddle a minute boundary.
    const now = Date.now();
    const vm = buildChatList(sources, {
      query: this.query,
      now,
      mode: this.mode(),
      autoSettleDays: this.plugin.settings.chatsAutoSettleDays,
      // Only feed the ranking back in if it answered the query on screen.
      semanticIds: this.semanticFor === this.query.trim() ? this.semanticIds : [],
    });
    if (vm.total === 0) return this.renderEmpty("no-chats");
    if (vm.matched === 0) return this.renderEmpty("no-matches");
    if (this.emptyKind !== null) {
      this.emptyKind = null;
      this.emptyHost?.empty();
    }
    // Density is decided PER ROW, not per section: anything running, open or
    // pinned is something you are choosing between and earns the metadata line,
    // wherever it happens to sit. That is what keeps the day view useful — the
    // grouping changes, the information does not. The model already ordered the
    // sections and dropped the empty ones, and it owns the section KEYS: a key
    // has to survive a label being reworded, so this file never derives one
    // from display text.
    this.renderSections(vm.sections, now);
    // Only what is on screen is on the arrow-key axis: a collapsed section's
    // rows are not painted, so leaving them in the order would make Down walk
    // the cursor into nothing and Enter open a chat the user cannot see.
    this.order = vm.sections
      .filter((s) => !this.collapsed(s.key))
      .flatMap((s) => s.items)
      .map((r) => r.id);
    if (this.cursor && !this.order.includes(this.cursor)) this.cursor = null;
    this.paintCursor(false);
  }

  /** The Inbox (core/inbox, ui/inbox-panel): same model and panel as the Cockpit. */
  private paintInbox(): void {
    if (this.inboxHost) mountInbox(this.inboxHost, this.plugin.inbox.current(), this.plugin.inbox.handlers);
  }

  /* ------------------------------ keyboard ------------------------------ */

  /**
   * Move the cursor along the painted order. `delta` of 0 just re-anchors,
   * which is what a fresh arrow press after a filter change should do. Wraps at
   * neither end on purpose: in a list this long, wrapping from the oldest chat
   * back to the newest reads as a glitch rather than a convenience.
   */
  private moveCursor(delta: number): void {
    if (this.order.length === 0) return;
    const at = this.cursor ? this.order.indexOf(this.cursor) : -1;
    const next = at === -1 ? (delta < 0 ? this.order.length - 1 : 0) : at + delta;
    if (next < 0 || next >= this.order.length) return;
    this.cursor = this.order[next];
    this.paintCursor(true);
  }

  private paintCursor(scroll: boolean): void {
    const host = this.listHost;
    if (!host) return;
    host.querySelectorAll<HTMLElement>(".mva-chats-row.is-cursor").forEach((el) => el.removeClass("is-cursor"));
    if (!this.cursor) return;
    const el = host.querySelector<HTMLElement>(`.mva-chats-row[data-id="${CSS.escape(this.cursor)}"]`);
    if (!el) return;
    el.addClass("is-cursor");
    if (scroll) el.scrollIntoView({ block: "nearest" });
  }

  /** Arrow keys traverse, Enter opens, Escape clears the filter then the focus.
   *  Bound on the search field AND the list, so the gesture works whether you
   *  arrived by typing or by clicking into the pane. */
  private onKey(e: KeyboardEvent): void {
    if (e.key === "ArrowDown") { e.preventDefault(); this.moveCursor(1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); this.moveCursor(-1); return; }
    if (e.key === "Enter" && this.cursor) {
      e.preventDefault();
      void this.plugin.revealConversation(this.cursor);
      return;
    }
    if (e.key !== "Escape") return;
    e.preventDefault();
    // Two-step: the first Escape clears a filter you can see, the second gives
    // the pane back. Clearing and blurring at once loses the filtered list
    // before you have read it.
    if (this.query) {
      this.query = "";
      if (this.searchEl) this.searchEl.value = "";
      this.paint();
      return;
    }
    this.searchEl?.blur();
  }

  /* ------------------------------ sections ------------------------------ */

  private collapsed(key: ChatSectionKey): boolean {
    return isSectionCollapsed(this.plugin.settings.chatsCollapsed, key, this.query.trim().length > 0);
  }

  /** Flip one section and persist it on the gesture, not on some later save:
   *  the state must survive a reload, and a crash in between would drop it. */
  private toggleSection(key: ChatSectionKey): void {
    if (this.query.trim()) return; // sections stay open while searching
    this.plugin.settings.chatsCollapsed = toggleSectionCollapsed(
      this.plugin.settings.chatsCollapsed,
      key,
    );
    void this.plugin.saveSettings();
    // The cursor may have been sitting on a row that just went off screen;
    // `paint` re-derives the order and drops it if so.
    this.paint();
  }

  /**
   * One reconciled list per section, with the section's header as its SIBLING.
   * Sections are keyed by `ChatSectionKey` and reused across paints, so a chat
   * moving from Running to Settled does not reflash the whole list.
   *
   * Collapsing is a STATE on the reused section, never a rebuild: the header,
   * its handler and its aria wiring are built once and only the class, the
   * count and `aria-expanded` change. A collapsed section reconciles to an empty
   * list rather than hiding a full one — the rows would otherwise stay in the
   * accessibility tree, and building rows nobody can see costs a paint on every
   * 5s tick for a section the user explicitly put away.
   */
  private renderSections(specs: readonly ChatSection[], now: number): void {
    const host = this.listHost;
    if (!host) return;
    const wanted = new Set<string>(specs.map((s) => s.key));
    // A static snapshot: removing from a live HTMLCollection mid-iteration skips
    // siblings.
    for (const el of Array.from(host.children) as HTMLElement[]) {
      if (!wanted.has(el.dataset.section ?? "")) el.remove();
    }
    specs.forEach((spec, i) => {
      let sec = Array.from(host.children).find(
        (el) => (el as HTMLElement).dataset.section === spec.key,
      ) as HTMLElement | undefined;
      if (!sec) sec = this.buildSection(spec);
      // Reading host.children live is correct here: after iteration i-1 the
      // first i slots already hold the first i sections, so a match can only sit
      // at an index >= i and insertBefore always moves it forward.
      if (host.children[i] !== sec) host.insertBefore(sec, host.children[i] ?? null);
      const collapsed = this.collapsed(spec.key);
      sec.toggleClass("is-collapsed", collapsed);
      const header = sec.querySelector<HTMLElement>(".mva-chats-group-label");
      header?.setAttribute("aria-expanded", String(!collapsed));
      // The count exists ONLY while collapsed, and that is what makes collapsing
      // safe: a header that hides its rows without saying how many it is hiding
      // turns "put this away" into "forget this exists". Expanded, the rows are
      // right there and the number would be noise.
      sec
        .querySelector<HTMLElement>(".mva-chats-group-count")
        ?.setText(collapsed ? String(spec.items.length) : "");
      const list = sec.querySelector<HTMLElement>(".mva-chats-group-list");
      if (!list) return;
      reconcileList(list, collapsed ? [] : spec.items.map((r) => this.rowModel(r, now)));
    });
  }

  /**
   * The section shell: a header that toggles, and the list it controls. Built
   * once per key and reused, so the click handler is registered once — a header
   * rebuilt on every paint would drop keyboard focus mid-interaction.
   *
   * The header is a `div` made operable by `clickable` (role=button, tabIndex,
   * Enter/Space), not a `<button>`: on a real button, Obsidian's own
   * `button:not(.clickable-icon)` rule out-specifies a single-class selector and
   * strips the padding and background out from under it.
   */
  private buildSection(spec: ChatSection): HTMLElement {
    const sec = createDiv({ cls: "mva-chats-group" });
    sec.dataset.section = spec.key;
    // `day:This week` is a legal section key and an ILLEGAL id: `aria-controls`
    // and `aria-labelledby` are space-separated id LISTS, so a key with a space
    // in it would resolve to two ids that do not exist and silently unwire the
    // whole relationship. Slugged, not indexed by paint order — the id has to
    // survive a section being dropped and re-added.
    const slug = spec.key.replace(/[^a-zA-Z0-9]+/g, "-");
    const headerId = `${this.uid}-h-${slug}`;
    const listId = `${this.uid}-l-${slug}`;
    const header = sec.createDiv({ cls: "mva-chats-group-label mva-type-eyebrow", attr: { id: headerId } });
    // A rotation, not two icons: swapping chevron-right for chevron-down would
    // re-run setIcon on every toggle and lose the transition that makes the
    // gesture legible.
    setIcon(header.createSpan({ cls: "mva-chats-group-chevron" }), "chevron-right");
    header.createSpan({ cls: "mva-chats-group-name", text: spec.label });
    header.createSpan({ cls: "mva-chats-group-count" });
    header.setAttribute("aria-controls", listId);
    clickable(header, () => this.toggleSection(spec.key));
    const list = sec.createDiv({ cls: "mva-chats-group-list", attr: { id: listId } });
    list.setAttribute("role", "region");
    list.setAttribute("aria-labelledby", headerId);
    return sec;
  }

  private renderEmpty(kind: EmptyKind): void {
    this.listHost?.empty();
    const host = this.emptyHost;
    if (!host || this.emptyKind === kind) return;
    this.emptyKind = kind;
    host.empty();
    const box = host.createDiv({ cls: "mva-chats-empty-box" });
    if (kind === "open-exo") {
      box.createDiv({ cls: "mva-chats-empty-text", text: "Open Exo to see your chats" });
      const btn = box.createEl("button", { cls: "mva-btn", text: "Open Exo" });
      // Repaint on the promise, not on the next backstop tick: without this the
      // pane the user just acted on sits empty for up to BACKSTOP_MS and the button reads as dead.
      btn.onclick = () => void this.plugin.activateView().then(() => this.paint());
      return;
    }
    if (kind === "no-chats") {
      box.createDiv({ cls: "mva-chats-empty-text", text: "No conversations yet" });
      return;
    }
    box.createDiv({ cls: "mva-chats-empty-text", text: "No chats match" });
    const clear = box.createEl("button", { cls: "mva-btn", text: "Clear search" });
    clear.onclick = () => {
      this.query = "";
      if (this.searchEl) this.searchEl.value = "";
      this.paint();
    };
  }

  /* --------------------------------- rows ------------------------------- */

  /** One model builder for both densities, so `reconcileList` sees a single
   *  keyed identity per conversation even when a row crosses a section. */
  private rowModel(r: ChatRow, now: number): CardModel {
    // Running, open or pinned, or a search hit whose matching line must show.
    const rich = r.lane != null || r.open || r.pinned || !!r.snippet;
    // The rendered AGE LABEL, not the raw `updatedAt` — see `chatRowSig`, which
    // owns the rest of that argument and everything a painted row depends on.
    const age = rowAge(r, now);
    return {
      key: r.id,
      sig: chatRowSig(r, { rich, age }),
      build: () => (rich ? this.buildRichRow(r, now) : this.buildCompactRow(r, now)),
    };
  }

  /**
   * Rich row — title and age, the last exchange, then a metadata line: status
   * when something is happening, otherwise provider, model and how many turns
   * are yours. Three lines is the budget. The model earns its place because
   * choosing between an Opus chat and a Sonnet one is a real decision, and the
   * title alone never tells you which is which. Built DETACHED —
   * `reconcileList` owns insertion and ordering.
   */
  private buildRichRow(r: ChatRow, now: number): HTMLElement {
    const row = createDiv({ cls: "mva-chats-row is-rich" });
    // `is-needs-input` still colours the status text; the running and unseen
    // row classes went with the rails they were the only consumers of — the
    // gutter dot carries those two states now, and a class nothing styles is a
    // hook that quietly rots.
    if (r.lane === "needs-input") row.addClass("is-needs-input");
    // The attention rung: a row that wants a human reads at full luminosity and
    // everything healthy sits one step down. Membership is `needsYou`'s own
    // definition (core/chat-rows `activityKey`) — blocked, or finished badly —
    // so the brightest rows on screen are exactly the section's rows, wherever
    // grouping happens to have put them.
    if (needsYou(r)) row.addClass("is-attention");
    if (r.open) row.addClass("is-active");

    this.dotInto(row, r);
    const head = row.createDiv({ cls: "mva-chats-line" });
    head.createSpan({ cls: "mva-chats-name mva-type-title", text: r.title });
    // Markers trail the title, never precede it: a leading icon shifts the title
    // right on exactly the rows that have one, so the column breaks on the few
    // rows and holds on the many. Left gutter = live state, title column, then
    // trailing markers and age.
    if (r.pinned) setIcon(head.createSpan({ cls: "mva-chats-pin", attr: { "aria-label": "Pinned" } }), "pin");
    head.createSpan({ cls: "mva-chats-age", text: rowAge(r, now) });

    // The preview line carries the last exchange — or, while a tool is actually
    // running, what that tool is doing ("Searching the vault"). Same line, so a
    // turn starting never adds a row height; `is-activity` makes it one
    // truncated line instead of two wrapped ones, because a phrase that wrapped
    // would reflow the row on every tool call. A conversation streaming its very
    // first turn can still have nothing to say: omit the line rather than
    // repeating the title under it.
    const preview = rowPreview(r);
    if (preview.text) {
      const line = row.createDiv({ cls: "mva-chats-preview mva-type-body", text: preview.text });
      if (preview.live) line.addClass("is-activity");
    }

    const status = rowStatusText(r);
    const meta = row.createDiv({ cls: "mva-chats-meta" });
    if (status) meta.createSpan({ cls: "mva-chats-status", text: status });
    else if (!r.lane && r.unseen) meta.createSpan({ cls: "mva-chats-status is-unseen", text: "New reply" });
    meta.createSpan({ text: modelLabel(r.provider, r.model) });
    meta.createSpan({ cls: "mva-chats-count", text: `${r.messageCount}` });
    this.badgeInto(meta, r);
    this.decideInto(row, r);
    row.dataset.id = r.id;
    this.wireRow(row, r);
    return row;
  }

  /**
   * Inline Allow / Deny, on a row blocked on a permission and nowhere else.
   *
   * The rule line is the point: `Bash(git)` says what a yes covers, so the
   * decision is legible where it is taken and the transcript is not the only
   * place the scope is written down. It is `permRuleLine`'s own output, carried
   * through the row source — the sidebar never paraphrases a permission.
   *
   * Two verdicts, not the card's three. "Always allow" writes a standing rule,
   * and a standing rule is not something a single click in a sidebar should be
   * able to grant; that decision stays where the full detail of the call is.
   *
   * `isolateActivation` is what makes them buttons rather than parts of the
   * row: the row reveals the conversation on click AND on Enter/Space, and its
   * Enter handling would otherwise cancel the button's own activation — so
   * answering a prompt from the keyboard would yank the pane to the chat and
   * settle nothing (tests/dom.test.ts).
   */
  private decideInto(row: HTMLElement, r: ChatRow): void {
    if (!r.permRule) return;
    const box = row.createDiv({ cls: "mva-chats-decide" });
    box.createSpan({ cls: "mva-chats-rule", text: r.permRule });
    const act = (label: string, cls: string, verdict: "allow" | "deny") => {
      const btn = box.createEl("button", { cls, text: label });
      btn.setAttr("aria-label", `${label} ${r.permRule} in "${r.title}"`);
      isolateActivation(btn);
      btn.onclick = () => this.decide(r, verdict);
    };
    act("Allow", "mva-btn mva-btn-primary mva-chats-decide-btn", "allow");
    act("Deny", "mva-btn mva-chats-decide-btn", "deny");
  }

  /** Take the verdict through the plugin — never through the view that owns the
   *  conversation (see the file header). A false answer means the prompt was
   *  already settled somewhere else, which is worth saying: the row was showing
   *  a decision that no longer existed. */
  private decide(r: ChatRow, verdict: "allow" | "deny"): void {
    if (!this.plugin.decidePermission(r.id, verdict)) {
      new Notice("That request was already answered.");
    }
    this.paint();
  }

  /**
   * The status dot, in a gutter that is ALWAYS reserved — the element is
   * created for every row, whether or not it carries a state, so the titles sit
   * on one vertical line and the list does not jitter as a chat starts running
   * or goes quiet. That stability is the whole reason this replaced the left
   * rails, which painted three unrelated meanings into the same 2px channel.
   *
   * The state is carried as a class, not a colour: filled / ring / small is the
   * signal, colour only reinforces it, so the row still reads under a theme that
   * flattens the palette and for someone who cannot separate orange from green.
   * The label is what a screen reader gets — the shape means nothing to it.
   */
  private dotInto(row: HTMLElement, r: ChatRow): void {
    const dot = chatDot(r);
    const el = row.createSpan({ cls: "mva-chats-dot" });
    if (!dot) return;
    el.addClass(`is-${dot}`);
    el.setAttribute("aria-label", DOT_LABEL[dot]);
  }

  /** The stopped/error marker, shared by both densities so a failed turn is
   *  never visible in one section and invisible in the other. */
  private badgeInto(host: HTMLElement, r: ChatRow): void {
    if (!r.badge) return;
    const mark = host.createSpan({
      cls: `mva-chats-badge is-${r.badge}`,
      attr: { "aria-label": r.badge === "error" ? "Last turn errored" : "Stopped" },
    });
    setIcon(mark, r.badge === "error" ? "octagon-x" : "circle-stop");
  }

  /** History row: one line — optional markers, title, right-aligned age. */
  private buildCompactRow(r: ChatRow, now: number): HTMLElement {
    const row = createDiv({ cls: "mva-chats-row is-compact" });
    // Same rung, and the same predicate as the rich row. This used to read
    // `r.badge` alone, with a comment arguing a blocked row could not reach
    // this density: an invariant asserted in prose, holding up a second copy
    // of a rule that lives in core.
    if (needsYou(r)) row.addClass("is-attention");
    if (r.open) row.addClass("is-active");
    this.dotInto(row, r);
    row.createSpan({ cls: "mva-chats-name mva-type-body", text: r.title });
    // Same rule as the rich row: markers trail, so the title column holds for
    // every row whether or not it is pinned or carries a badge.
    if (r.pinned) setIcon(row.createSpan({ cls: "mva-chats-pin", attr: { "aria-label": "Pinned" } }), "pin");
    this.badgeInto(row, r);
    row.createSpan({ cls: "mva-chats-age", text: rowAge(r, now) });
    row.dataset.id = r.id;
    this.wireRow(row, r);
    return row;
  }

  private wireRow(row: HTMLElement, r: ChatRow): void {
    clickable(row, () => void this.plugin.revealConversation(r.id));
    row.oncontextmenu = (e) =>
      openChatRowMenu(e, r, { app: this.app, plugin: this.plugin, repaint: () => this.paint() });
  }
}
