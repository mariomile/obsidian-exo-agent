/**
 * Thumbnail for a composer context card. Extracted from composer.ts, which sits
 * at its size ceiling: it only reads the vault, so it needs nothing but `app`.
 *
 * Split in two so a reused card can be refreshed without a remount: `resolveThumb`
 * says WHAT the thumb shows (comparable by value), `applyThumb` paints it.
 */
import { setIcon, TFile, type App } from "obsidian";

const IMAGE_EXT = /^(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

/** What a thumb shows. `raw` on a text thumb is the note body it was derived
 *  from, so an unchanged note is recognised before the strip pass reruns. */
export type ThumbModel =
  | { kind: "icon"; icon: string }
  | { kind: "image"; src: string }
  | { kind: "text"; text: string; raw: string };

export function sameThumb(a: ThumbModel | null, b: ThumbModel): boolean {
  if (!a || a.kind !== b.kind) return false;
  if (a.kind === "icon") return a.icon === (b as typeof a).icon;
  if (a.kind === "image") return a.src === (b as typeof a).src;
  return a.text === (b as typeof a).text;
}

/** The markdown preview text: frontmatter, embeds and markup stripped. */
function previewText(raw: string): string {
  return raw
    .replace(/^---\n[\s\S]*?\n---\n?/, "") // drop frontmatter
    .replace(/!?\[\[[^\]]*\]\]/g, " ") // drop embeds / wikilinks
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // md links → their text
    .replace(/[#>*_`~]/g, "")
    .trim()
    .slice(0, 260);
}

/**
 * Image files get a real image preview, markdown gets a tiny text preview
 * ("document" look), everything else gets a file-type icon. Synchronous for
 * every kind but markdown, so those thumbs paint in the same frame as the card.
 * `prev` lets an unchanged note body skip the strip pass.
 */
export function resolveThumb(app: App, path: string, prev: ThumbModel | null = null): ThumbModel | Promise<ThumbModel> {
  const f = app.vault.getAbstractFileByPath(path);
  if (!(f instanceof TFile)) return { kind: "icon", icon: "file" };
  if (IMAGE_EXT.test(f.extension)) return { kind: "image", src: app.vault.getResourcePath(f) };
  if (f.extension !== "md") return { kind: "icon", icon: "file" };
  return app.vault.cachedRead(f).then(
    (raw): ThumbModel => {
      if (prev?.kind === "text" && prev.raw === raw) return prev;
      const text = previewText(raw);
      return text ? { kind: "text", text, raw } : { kind: "icon", icon: "file-text" };
    },
    (): ThumbModel => ({ kind: "icon", icon: "file-text" })
  );
}

/** Paint a model into a thumb, from a clean slate (same end state as a freshly
 *  created `.mva-doc-thumb`). A broken image falls back to an image icon and
 *  reports it through `onImageError`; an image already replaced by a later
 *  paint can no longer touch the thumb. */
export function applyThumb(el: HTMLElement, model: ThumbModel, onImageError?: () => void): void {
  el.empty();
  el.removeClass("is-icon");
  el.removeClass("is-image");
  if (model.kind === "icon") {
    el.addClass("is-icon");
    setIcon(el, model.icon);
  } else if (model.kind === "image") {
    el.addClass("is-image");
    const img = el.createEl("img");
    img.src = model.src;
    img.onerror = () => {
      if (img.parentElement !== el) return;
      el.empty();
      el.removeClass("is-image");
      el.addClass("is-icon");
      setIcon(el, "image");
      onImageError?.();
    };
  } else {
    el.setText(model.text);
  }
}
