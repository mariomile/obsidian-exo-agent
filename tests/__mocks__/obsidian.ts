/**
 * Minimal `obsidian` stub for vitest. The extracted `core/` modules are pure
 * and must not pull `obsidian` at runtime; this alias only exists so that if a
 * transitive import ever appears, the test loader resolves to an empty module
 * instead of crashing. Deliberately intentionally sparse — add exports only if
 * a test genuinely needs one.
 */
export class TFile {
  path = "";
  basename = "";
  extension = "";
  stat = { mtime: 0 };
}

export class TFolder {
  path = "";
  children: unknown[] = [];
}

/** Mutable so a test can assert the mobile branch of a desktop-only gate and
 *  put it back. Desktop is the default because that is where Exo runs. */
export const Platform = { isMobile: false, isDesktopApp: true };

/** Base class for the views the browser controller instanceof-checks. Real
 *  Obsidian gives it a leaf and a contentEl; nothing here needs either. */
export class ItemView {
  constructor(public leaf?: unknown) {}
}

/** User-facing feedback. Tests need it not to crash, and occasionally to read
 *  back what was said — a command whose only outcome is a Notice ("nothing is
 *  waiting on you") is otherwise untestable. */
export class Notice {
  static last = "";
  constructor(public message: string) {
    Notice.last = message;
  }
  hide(): void {}
}

/** Minimal case-insensitive substring matcher — just enough for
 *  `search_vault`'s built-in fallback scorer (tools.ts) to be exercised by a
 *  test without a live Obsidian search index. Real Obsidian's version does
 *  fuzzy matching; this only needs to find-or-not-find, since the fallback
 *  path under test cares about ranking/rendering, not match quality. */
export function prepareSimpleSearch(
  query: string
): (text: string) => { score: number; matches: [number, number][] } | null {
  const q = query.toLowerCase();
  return (text: string) => {
    const at = text.toLowerCase().indexOf(q);
    return at === -1 ? null : { score: 1, matches: [[at, at + q.length]] };
  };
}

/** Paints a lucide glyph into an element. Nothing here reads the icon back;
 *  the stub exists so a surface that labels its chips can be rendered in a
 *  test at all. */
export function setIcon(el: { dataset?: Record<string, string> }, icon: string): void {
  if (el.dataset) el.dataset.icon = icon;
}

/** Base class for a plain modal dialog. Nothing here needs to render; the
 *  stub exists so an obsidian/*.ts module that subclasses it (e.g.
 *  collabo-commands' ImportOverwriteModal) can be imported by a test at
 *  all — the same reason FuzzySuggestModal is stubbed below. */
export class Modal {
  constructor(public app: unknown) {}
  open(): void {}
  close(): void {}
  onOpen(): void {}
  onClose(): void {}
}

/** Base class for a fuzzy-matched picker modal. Nothing here needs to match
 *  or render; the stub exists so an obsidian/*.ts module that subclasses it
 *  (e.g. collabo-commands' RolePicker) can be imported by a test at all. */
export class FuzzySuggestModal<T> {
  constructor(public app: unknown) {}
  setPlaceholder(_text: string): void {}
  open(): void {}
  getItems(): T[] {
    return [];
  }
  getItemText(_item: T): string {
    return "";
  }
  onChooseItem(_item: T): void {}
}
