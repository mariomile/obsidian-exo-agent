import { setIcon } from "obsidian";
import type { ChatView } from "../view";
import type { Convo } from "./convo-types";
import { ADAPTERS } from "../providers/registry";
import { clickable } from "./dom";
import { formatCompactDate, formatRelativeDays } from "../core/history";

/** One temporal group: a header row plus its cards. The cards stay DIRECT
 *  children of the grid — the group header is a sibling, not a wrapper — so
 *  every existing `.mva-card` consumer (bulk selection, `visibleCardIds`,
 *  `refreshSelectionUI`) keeps working without knowing groups exist. */
export function renderHistoryGroup(
  view: ChatView,
  grid: HTMLElement,
  label: string,
  items: Convo[],
  doneConvoIds: Set<string>,
  retiredContext = false,
): void {
  if (items.length === 0) return;
  grid.createDiv({ cls: "mva-gallery-group-header", text: label });
  for (const c of items) renderCard(view, grid, c, doneConvoIds, retiredContext);
}

function renderCard(
  view: ChatView,
  grid: HTMLElement,
  c: Convo,
  doneConvoIds: Set<string>,
  retiredContext = false,
): void {
  const card = grid.createDiv({ cls: "mva-card" });
  // Cards carry their id in the DOM: the bulk bar needs a DOM-to-id mapping
  // that survives the grid re-render the search box triggers.
  card.dataset.convoId = c.id;
  // A conversation is "active" when it's the focused tab, and "open" when it's
  // any of the tabs currently in the tab strip. Both get a visible marker so the
  // gallery mirrors what's open above it.
  const isActive = c === view.active;
  const isOpen = view.openTabs.includes(c.id);
  if (isActive) card.addClass("is-active");
  if (isOpen) card.addClass("is-open");
  setCardSelected(card, view.gallery.gallerySelection.has(c.id));
  addCardDelete(view, card, grid, c);
  const head = card.createDiv({ cls: "mva-card-head" });
  const dot = head.createSpan({ cls: "mva-dot" });
  dot.style.background = ADAPTERS[c.provider].brandColor;
  dot.style.color = ADAPTERS[c.provider].brandColor;

  // Detect placeholder conversations and render with distinct styling for consistency
  const isPlaceholder = !c.title || (c.title === "New chat" && c.messages.length === 0);
  const titleEl = head.createSpan({ cls: "mva-card-title" + (isPlaceholder ? " is-placeholder" : "") });

  if (isPlaceholder) {
    setIcon(titleEl, "pencil");
    titleEl.append("New chat");
  } else {
    titleEl.setText(c.title || "New chat");
  }

  // Why this chat left the active board: a completed orchestration task
  // ("Done") beats a plain manual archive ("Archived") when both are true.
  const badges = head.createDiv({ cls: "mva-card-badges" });
  if (doneConvoIds.has(c.id)) {
    badges.createSpan({ cls: "mva-card-status-badge is-done", text: "Done" });
  } else if (c.archived) {
    badges.createSpan({ cls: "mva-card-status-badge is-archived", text: "Archived" });
  }
  // Only the exception is drawn: a conversation that resumes with its full
  // context says nothing, exactly like an idle tab draws no mark. `unknown`
  // draws nothing either — see resumeStatus's contract. Not an `else` on the
  // block above: a chat can be archived AND no longer resumable, and hiding
  // the second fact behind the first would lose the one that costs context.
  if (view.gallery.resumeStatusOf(c) === "restarts") {
    // One word, deliberately. The badge cluster is `flex: 0 0 auto` and never
    // wraps or compresses, so every character it costs comes straight out of
    // `.mva-card-title` — and cards are ~180px wide. The full sentence in
    // title/aria-label is ~105px of a ~152px head, leaving about three
    // characters of title; with "Archived" and "Active" alongside it the
    // demanded width doubles the space available and `overflow: hidden` clips
    // the Open/Active badge off the card. "Restart" is one word, ~45px, in
    // line with "Active", and matches the one-word badge family. The full
    // sentence lives in title/aria-label, so the meaning is a hover or a
    // screen reader away, not lost.
    badges.createSpan({
      cls: "mva-card-status-badge is-restarts",
      text: "Restart",
      attr: {
        title: "Restarts from scratch: the session is no longer available.",
        "aria-label": "Restarts from scratch: the session is no longer available.",
      },
    });
  }
  if (isOpen) {
    badges.createSpan({
      cls: "mva-card-open-badge" + (isActive ? " is-active" : ""),
      text: isActive ? "Active" : "Open",
    });
  }

  const preview = view.convoPreview(c);
  card.createDiv({ cls: "mva-card-preview", text: preview || "Empty conversation" });

  const meta = card.createDiv({ cls: "mva-card-meta" });
  meta.createSpan({ text: ADAPTERS[c.provider].displayName });
  const count = c.messages.filter((m) => m.role === "user" && !m.auto).length;
  meta.createSpan({ text: `${count} message${count === 1 ? "" : "s"}` });
  if (c.updatedAt) meta.createSpan({ text: formatCompactDate(c.updatedAt) });
  // Only inside the retired group: elsewhere the retirement date answers a
  // question nobody asked, here it explains why the card is in this group.
  if (retiredContext && c.retiredAt) {
    meta.createSpan({ text: `ritirata ${formatRelativeDays(c.retiredAt)}` });
  }

  clickable(card, (e) => {
    // Cmd/Ctrl-click toggles selection; a plain click still opens the chat.
    // Once anything is selected, a plain click toggles too — otherwise the
    // first stray click would blow away a multi-selection.
    const mod = e as MouseEvent | KeyboardEvent;
    if (mod.metaKey || mod.ctrlKey || view.gallery.gallerySelection.size > 0) {
      if (view.gallery.gallerySelection.has(c.id)) view.gallery.gallerySelection.delete(c.id);
      else view.gallery.gallerySelection.add(c.id);
      setCardSelected(card, view.gallery.gallerySelection.has(c.id));
      view.gallery.renderBulkBar();
      return;
    }
    view.gallery.hideGallery();
    view.switchTo(c);
  });
}

/** Trash button on a gallery card: two-step confirm (arm → delete), reusing the
 *  note-revert arming pattern. Never bubbles to the card's open handler. */
function addCardDelete(view: ChatView, card: HTMLElement, grid: HTMLElement, c: Convo): void {
  const del = card.createSpan({ cls: "mva-gal-del", attr: { "aria-label": "Delete conversation" } });
  setIcon(del, "trash-2");
  let armed = false;
  let disarmTimer: number | null = null;
  const outside = (ev: MouseEvent) => {
    if (ev.target !== del && !del.contains(ev.target as Node)) disarm();
  };
  const disarm = () => {
    armed = false;
    del.removeClass("is-armed");
    del.setAttr("aria-label", "Delete conversation");
    if (disarmTimer) {
      window.clearTimeout(disarmTimer);
      disarmTimer = null;
    }
    document.removeEventListener("click", outside, true);
  };
  clickable(del, (e) => {
    e.stopPropagation();
    if (!armed) {
      armed = true;
      del.addClass("is-armed");
      del.setAttr("aria-label", "Click again to delete");
      disarmTimer = window.setTimeout(disarm, 3000);
      document.addEventListener("click", outside, true);
      return;
    }
    disarm();
    deleteConvo(view, c, card, grid);
  });
}

/** Permanently drop a conversation from the gallery: `deleteConversation` does
 *  the store mutation, and this adds the card cleanup that only this surface
 *  owns — the gallery stays open, so its DOM has to settle in place instead of
 *  being rebuilt. */
function deleteConvo(view: ChatView, c: Convo, card: HTMLElement, grid: HTMLElement): void {
  view.deleteConversation(c.id);
  card.remove();
  // Group headers are SIBLINGS of the cards, not wrappers, so removing the
  // last card of a group leaves its header standing above the next group's
  // cards. A header owns exactly the cards that immediately follow it, so
  // "no card right after me" is precisely "my group is now empty" — one pass
  // over a static NodeList settles every header, in any order.
  grid.querySelectorAll<HTMLElement>(".mva-gallery-group-header").forEach((h) => {
    if (!h.nextElementSibling?.classList.contains("mva-card")) h.remove();
  });
  if (!grid.querySelector(".mva-card")) {
    grid.createDiv({ cls: "mva-empty-sub", text: "No conversations yet." });
  }
}

/** Paint selection state on a card. The class and `aria-pressed` move together
 *  so selection is never visible to sighted users only: `clickable()` gives
 *  every card `role="button"`, and a button with no `aria-pressed` announces
 *  no state at all. */
export function setCardSelected(card: HTMLElement, selected: boolean): void {
  card.toggleClass("is-selected", selected);
  card.setAttr("aria-pressed", String(selected));
}
