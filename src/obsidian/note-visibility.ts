import { FileView, WorkspaceSidedock, type App } from "obsidian";

/** True when some open view of `path` is on screen right now. A note in a
 *  background tab (e.g. behind a full-page chat) or in a collapsed sidebar is
 *  open but not shown. */
export function isNoteVisible(app: App, path: string): boolean {
  let shown = false;
  app.workspace.iterateAllLeaves((leaf) => {
    if (!shown && leaf.view instanceof FileView && leaf.view.file?.path === path) {
      const root = leaf.getRoot();
      const collapsed = root instanceof WorkspaceSidedock && root.collapsed;
      shown = !collapsed && leaf.view.containerEl.isShown();
    }
  });
  return shown;
}
