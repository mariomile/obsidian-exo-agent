/**
 * The composer's context row: one card per attached item (active note,
 * suggested note, manual attachments, live selection). Extracted from
 * composer.ts, which sits at its size ceiling.
 *
 * Reconciled, not rebuilt: the row is refreshed on every leaf change, layout
 * change and selection move, and an unchanged row used to tear down and remount
 * every card (and re-read every note for its thumb). Each card is keyed by
 * everything it renders, so an unchanged card is kept as is, a changed one is
 * remounted, and click handlers read the latest spec so callbacks stay fresh.
 */
import { setIcon, type App } from "obsidian";
import { statSync } from "node:fs";
import { clickable } from "./dom";
import { applyThumb, resolveThumb, sameThumb, type ThumbModel } from "./context-thumb";
import { basename as noteBasename } from "../obsidian/graph";
import { selectionPreview } from "../core/selection-preview";

export type ContextCardSpec =
  | { kind: "doc"; path: string; label: string; suggested?: boolean; onClick: () => void; onRemove: () => void }
  | { kind: "selection"; text: string; path: string; activePath: string | null; onClick: () => void; onRemove: () => void };

interface CardRecord {
  key: string;
  el: HTMLElement;
  spec: ContextCardSpec;
  /** Vault doc cards only: the painted thumb and its pending-request token. */
  thumb: HTMLElement | null;
  model: ThumbModel | null;
  seq: number;
  alive: boolean;
}

/** Absolute (out-of-vault) context path? Vault attachments are vault-relative. */
export function isExternalPath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false; // unreadable: treat as file
  }
}

export class ContextCards {
  private row: HTMLElement | null = null;
  private records: CardRecord[] = [];

  constructor(
    private readonly app: App,
    private readonly host: HTMLElement
  ) {}

  /** Render the row. An empty list collapses it entirely (no empty bar). */
  render(specs: ContextCardSpec[]): void {
    if (!specs.length) {
      this.clear();
      return;
    }
    if (!this.row || this.row.parentElement !== this.host) {
      this.clear();
      this.row = this.host.createDiv({ cls: "mva-doc-cards" });
    }
    const pool = new Map<string, CardRecord[]>();
    for (const r of this.records) pool.set(r.key, [...(pool.get(r.key) ?? []), r]);
    const next = specs.map((spec) => {
      const externalIcon =
        spec.kind === "doc" && isExternalPath(spec.path) ? (isDirectory(spec.path) ? "folder" : "file") : null;
      const key = cardKey(spec, externalIcon);
      const reused = pool.get(key)?.shift();
      if (reused) {
        reused.spec = spec;
        this.refreshThumb(reused);
        return reused;
      }
      return this.mount(spec, key, externalIcon);
    });
    for (const left of pool.values()) for (const r of left) this.unmount(r);
    const row = this.row;
    const inOrder = next.length === row.children.length && next.every((r, i) => row.children[i] === r.el);
    if (!inOrder) for (const r of next) row.appendChild(r.el);
    this.records = next;
  }

  private clear(): void {
    for (const r of this.records) r.alive = false;
    this.records = [];
    this.row = null;
    this.host.empty();
  }

  private unmount(r: CardRecord): void {
    r.alive = false;
    r.el.remove();
  }

  private mount(spec: ContextCardSpec, key: string, externalIcon: "folder" | "file" | null): CardRecord {
    const el = this.row!.createDiv({ cls: cardClass(spec) });
    const r: CardRecord = { key, el, spec, thumb: null, model: null, seq: 0, alive: true };
    const thumb = el.createDiv({ cls: spec.kind === "selection" ? "mva-doc-thumb is-icon" : "mva-doc-thumb" });
    const body = el.createDiv({ cls: "mva-doc-body" });
    let removeLabel = "Remove from context";
    if (spec.kind === "selection") {
      setIcon(thumb, "text-cursor-input");
      const { label, count } = selectionPreview(spec.text);
      body.createDiv({ cls: "mva-doc-title", text: label || "Selection", attr: { title: label } });
      // Show the source note only when it isn't the active-context doc (which the
      // "Current Document" card already names), so the kind line stays terse.
      body.createDiv({ cls: "mva-doc-kind", text: `Selection · ${count}${fromOther(spec)}` });
      removeLabel = "Dismiss selection";
    } else {
      if (externalIcon !== null) {
        thumb.addClass("is-icon");
        setIcon(thumb, externalIcon);
      } else {
        r.thumb = thumb;
        this.refreshThumb(r);
      }
      body.createDiv({ cls: "mva-doc-title", text: noteBasename(spec.path), attr: { title: spec.path } });
      body.createDiv({ cls: "mva-doc-kind", text: spec.label });
    }
    const x = el.createSpan({ cls: "mva-doc-x", attr: { "aria-label": removeLabel } });
    setIcon(x, "x");
    clickable(x, (e) => {
      e.stopPropagation();
      r.spec.onRemove();
    });
    clickable(el, () => r.spec.onClick());
    return r;
  }

  /** (Re)resolve a vault card's thumb and paint it only when it changed. Runs on
   *  reuse too, so an edited note refreshes; a late result for a card that has
   *  since been unmounted, or overtaken by a newer request, is dropped. */
  private refreshThumb(r: CardRecord): void {
    const thumb = r.thumb;
    if (!thumb || r.spec.kind !== "doc") return;
    const seq = ++r.seq;
    const paint = (m: ThumbModel): void => {
      if (!r.alive || seq !== r.seq) return;
      const same = sameThumb(r.model, m);
      // Adopt the model even when it paints the same (a note whose markup changed
      // but whose preview didn't), so the next refresh compares the latest body.
      r.model = m;
      if (same) return;
      // A broken image paints its fallback icon and is remembered as that, so the
      // next refresh tries the image again (as a fresh mount did).
      applyThumb(thumb, m, () => (r.model = { kind: "icon", icon: "image" }));
    };
    const res = resolveThumb(this.app, r.spec.path, r.model);
    if (res instanceof Promise) void res.then(paint);
    else paint(res);
  }
}

function fromOther(spec: Extract<ContextCardSpec, { kind: "selection" }>): string {
  return spec.path && spec.path !== spec.activePath ? ` · ${noteBasename(spec.path)}` : "";
}

function cardClass(spec: ContextCardSpec): string {
  if (spec.kind === "selection") return "mva-doc-card mva-sel-card";
  return spec.suggested ? "mva-doc-card is-suggested" : "mva-doc-card";
}

/** Everything a card renders, callbacks aside. External cards include the
 *  folder/file probe, so a path that changes type remounts. */
function cardKey(spec: ContextCardSpec, externalIcon: "folder" | "file" | null): string {
  if (spec.kind === "selection") return JSON.stringify(["sel", spec.text, spec.path, fromOther(spec)]);
  return JSON.stringify(["doc", spec.path, spec.label, !!spec.suggested, externalIcon]);
}
