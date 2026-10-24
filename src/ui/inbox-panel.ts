/**
 * The Inbox panel (Release 2): one rendering of `core/inbox`, mounted at the
 * top of the Chats sidebar and in the Cockpit. Both mount the same panel over
 * the same `Inbox`, so they cannot disagree.
 *
 * Three sections, in the model's order: Requests (something waits for your
 * answer), Errors (something broke), New (something finished). Absent when
 * empty: the host stays empty and CSS `:empty` collapses it, so at rest the
 * panel does not exist. No cap: every item is a row, and rows wrap instead of
 * truncating, because a title cut to "Inbox Tri..." answers nothing.
 *
 * Rebuilt only when what it shows moves (`inboxSig`): the sidebar paints every
 * few seconds, and a rebuild would drop the focus ring off a row the user is
 * tabbing through.
 */
import { setIcon } from "obsidian";
import { inboxSig, type Inbox, type InboxHandlers, type InboxItem, type InboxKind } from "../core/inbox";
import { clickable, isolateActivation } from "./dom";

const SECTIONS: readonly { kind: InboxKind; label: string; bulk?: string }[] = [
  { kind: "request", label: "Requests" },
  { kind: "error", label: "Errors", bulk: "Dismiss all" },
  { kind: "result", label: "New", bulk: "Mark all read" },
];

const painted = new WeakMap<HTMLElement, string>();

function iconFor(it: InboxItem): string {
  if (it.kind === "error") return "alert-triangle";
  switch (it.source) {
    case "chat":
      return it.id.endsWith(":perm") ? "shield-alert" : it.id.endsWith(":ask") ? "message-circle-question" : "message-square";
    case "runs":
      return "file-diff";
    case "proposals":
      return "lightbulb";
    case "pulse":
      return "sunrise";
    case "answer":
      return "mail-check";
    default:
      return "circle";
  }
}

/** A small inline control: a span made operable, isolated from the row's own click. */
function action(host: HTMLElement, label: string, run: () => void, primary = false): void {
  const el = host.createSpan({ cls: `mva-btn mva-inbox-act${primary ? " mva-btn-primary" : ""}`, text: label });
  clickable(el, run);
  isolateActivation(el);
}

function renderRow(list: HTMLElement, it: InboxItem, h: InboxHandlers): void {
  const row = list.createDiv({ cls: `mva-inbox-row is-${it.kind}` });
  setIcon(row.createSpan({ cls: "mva-inbox-icon" }), iconFor(it));
  const body = row.createDiv({ cls: "mva-inbox-body" });
  body.createDiv({ cls: "mva-inbox-name", text: it.title });
  body.createDiv({ cls: "mva-inbox-detail", text: it.detail });
  clickable(row, () => h.open(it));

  const acts = body.createDiv({ cls: "mva-inbox-acts" });
  if (it.permRule) {
    action(acts, "Allow", () => h.decide(it, "allow"), true);
    action(acts, "Deny", () => h.decide(it, "deny"));
  }
  if (it.source === "runs" && it.runIds?.length) {
    action(acts, `Mark ${it.runIds.length} reviewed`, () => h.markReviewed(it));
  }
  if (it.kind === "error" && (it.source === "run" || it.source === "pulse")) {
    action(acts, "Run again", () => h.retry(it));
  }
  if (it.verbs.includes("archive")) action(acts, "Dismiss", () => h.clear([it]));
  if (it.verbs.includes("read")) action(acts, "Mark read", () => h.clear([it]));
  if (!acts.hasChildNodes()) acts.remove();
}

/** Paint `inbox` into `host`, or leave it untouched when nothing it shows moved. */
export function mountInbox(host: HTMLElement, inbox: Inbox, h: InboxHandlers): void {
  const sig = inboxSig(inbox.items);
  if (painted.get(host) === sig) return;
  painted.set(host, sig);
  host.empty();
  if (inbox.count === 0) return;

  host.createDiv({ cls: "mva-inbox-head mva-type-eyebrow", text: `Inbox · ${inbox.count}` });
  for (const s of SECTIONS) {
    const items = inbox.items.filter((i) => i.kind === s.kind);
    if (!items.length) continue;
    const section = host.createDiv({ cls: "mva-inbox-section" });
    const head = section.createDiv({ cls: "mva-inbox-section-head" });
    head.createSpan({ cls: "mva-inbox-section-label", text: `${s.label} · ${items.length}` });
    if (s.bulk && items.length > 1) {
      const bulk = head.createSpan({ cls: "mva-inbox-bulk", text: s.bulk });
      clickable(bulk, () => h.clear(items));
    }
    const list = section.createDiv({ cls: "mva-inbox-list" });
    for (const it of items) renderRow(list, it, h);
  }
}
