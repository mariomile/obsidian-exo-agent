/**
 * Thumbnail for a composer context card. Extracted from composer.ts, which sits
 * at its size ceiling: it only reads the vault, so it needs nothing but `app`.
 */
import { setIcon, TFile, type App } from "obsidian";

const IMAGE_EXT = /^(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

/**
 * Fill a card thumbnail: image files get a real image preview, markdown gets a
 * tiny text preview ("document" look), everything else gets a file-type icon.
 */
export async function fillThumb(app: App, el: HTMLElement, path: string): Promise<void> {
  const f = app.vault.getAbstractFileByPath(path);
  if (!(f instanceof TFile)) {
    el.addClass("is-icon");
    setIcon(el, "file");
    return;
  }
  if (IMAGE_EXT.test(f.extension)) {
    el.addClass("is-image");
    const img = el.createEl("img");
    img.src = app.vault.getResourcePath(f);
    img.onerror = () => {
      el.empty();
      el.removeClass("is-image");
      el.addClass("is-icon");
      setIcon(el, "image");
    };
    return;
  }
  if (f.extension !== "md") {
    el.addClass("is-icon");
    setIcon(el, "file");
    return;
  }
  try {
    const txt = (await app.vault.cachedRead(f))
      .replace(/^---\n[\s\S]*?\n---\n?/, "") // drop frontmatter
      .replace(/!?\[\[[^\]]*\]\]/g, " ") // drop embeds / wikilinks
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // md links → their text
      .replace(/[#>*_`~]/g, "")
      .trim();
    if (txt) el.setText(txt.slice(0, 260));
    else {
      el.addClass("is-icon");
      setIcon(el, "file-text");
    }
  } catch {
    el.addClass("is-icon");
    setIcon(el, "file-text");
  }
}
