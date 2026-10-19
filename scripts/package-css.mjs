// The styles.css Obsidian loads: the source minus whitespace and comments. The
// source file stays as written (it is read by the style contract tests, which
// cite its line numbers); only the copy in a plugin folder is packed.
//
// esbuild packs the whole sheet with whitespace minification only (no syntax
// rewrites), and `charset: "utf8"` keeps characters like `·` literal instead of
// escaping them. Comments are dropped except `/* @settings ... */` blocks: Style
// Settings reads those from the loaded stylesheet at runtime. Each real block
// (found by a scanner that skips strings, escapes and unquoted `url()`, so
// comment-like text inside a value is not one) is swapped for a unique legal
// comment, which esbuild keeps in place, and put back byte for byte afterwards.
import { transform } from "esbuild";

/** Where a string that opens at `i` ends (exclusive). An unescaped newline ends a bad string. */
function stringEnd(css, i) {
  const q = css[i];
  for (let j = i + 1; j < css.length; j++) {
    if (css[j] === "\\") j++;
    else if (css[j] === q || css[j] === "\n") return j + 1;
  }
  return css.length;
}

/** `[start, end)` of every `@settings` comment outside strings and `url()`. */
export function settingsBlocks(css) {
  const blocks = [];
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === "\\") i += 2;
    else if (ch === '"' || ch === "'") i = stringEnd(css, i);
    else if (ch === "/" && css[i + 1] === "*") {
      const close = css.indexOf("*/", i + 2);
      if (close === -1) break;
      if (/^\/\*\s*@settings/.test(css.slice(i, close))) blocks.push([i, close + 2]);
      i = close + 2;
    } else if (/^url\(\s*[^\s"']/i.test(css.slice(i, i + 64)) && !/[\w-]/.test(css[i - 1] ?? "")) {
      // An unquoted url() runs to the first unescaped `)`.
      let j = i + 4;
      while (j < css.length && css[j] !== ")") j += css[j] === "\\" ? 2 : 1;
      i = j + 1;
    } else i++;
  }
  return blocks;
}

export async function packageCss(source) {
  if (!source.trim()) return "\n";
  const blocks = settingsBlocks(source);
  let tag = "exo-settings";
  while (source.includes(tag)) tag += "-";
  const marker = (n) => `/*! ${tag}-${n} */`;
  let marked = "";
  let at = 0;
  blocks.forEach(([start, end], n) => {
    marked += source.slice(at, start) + marker(n);
    at = end;
  });
  marked += source.slice(at);

  const { code } = await transform(marked, {
    loader: "css",
    minifyWhitespace: true,
    charset: "utf8",
    legalComments: "inline",
  });
  // esbuild keeps a legal comment only where a rule could start; one inside a
  // declaration list is dropped. Refuse rather than ship a sheet without it.
  let out = code.trim();
  blocks.forEach(([start, end], n) => {
    const parts = out.split(marker(n));
    if (parts.length !== 2) throw new Error("styles.css: @settings block inside a declaration list");
    out = parts[0].trimEnd() + "\n" + source.slice(start, end) + "\n" + parts[1];
  });
  return out.trim() + "\n";
}
