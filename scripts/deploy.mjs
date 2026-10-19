// Copy the built plugin into a plugin folder (a vault's `.obsidian/plugins/exo-agent`,
// or the release staging folder in CI). A production build packs styles.css
// (see package-css.mjs); a dev build copies it as written, so it stays readable
// while iterating. The source files in the repo are never rewritten.
import { existsSync, readFileSync, copyFileSync, mkdirSync, writeFileSync, realpathSync, statSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { packageCss } from "./package-css.mjs";

/** The files Obsidian installs for a plugin, and the release ships. */
export const PLUGIN_FILES = ["main.js", "manifest.json", "styles.css"];

/** `p` with symlinks resolved, also when it does not exist yet (through its nearest existing parent). */
function realPath(p) {
  let head = resolve(p);
  const rest = [];
  while (!existsSync(head) && dirname(head) !== head) {
    rest.unshift(basename(head));
    head = dirname(head);
  }
  return join(realpathSync.native(head), ...rest);
}

/** A destination that is the source folder, or holds the source files themselves (symlink, hard link). */
function assertNotSource(dir, root) {
  const same = new Error(`${dir} is the source folder; deploy into a plugin folder instead`);
  if (realPath(dir) === realPath(root)) throw same;
  for (const f of PLUGIN_FILES) {
    const [from, to] = [join(root, f), join(dir, f)];
    if (!existsSync(from) || !existsSync(to)) continue;
    const [a, b] = [statSync(from), statSync(to)];
    if (a.dev === b.dev && a.ino === b.ino) throw same;
  }
}

export async function deployToPluginDir(dir, { production, root = "." }) {
  const src = (f) => join(root, f);
  // Checked before anything is read or written: a production deploy rewrites styles.css.
  assertNotSource(dir, root);
  // Packed before anything is copied: a packing failure leaves the folder as it was.
  const css =
    production && existsSync(src("styles.css")) ? await packageCss(readFileSync(src("styles.css"), "utf8")) : null;
  mkdirSync(dir, { recursive: true });
  for (const f of PLUGIN_FILES) {
    if (!existsSync(src(f))) continue;
    if (f === "styles.css" && css !== null) writeFileSync(join(dir, f), css);
    else copyFileSync(src(f), join(dir, f));
  }
}
