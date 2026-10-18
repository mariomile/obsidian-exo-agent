/**
 * Streaming-caret placement (pure). MarkdownRenderer output is block-level, so
 * appending the caret to the tail container drops it on its own line — the
 * caret must live INSIDE the last text-bearing block. Structural interface so
 * the walk is unit-testable without a DOM (vitest runs environment: "node").
 */

export interface CaretNode {
  tagName: string;
  lastElementChild: CaretNode | null;
  textContent: string | null;
  classList?: Pick<DOMTokenList, "contains">;
}

/** Block-ish elements the walk may descend into (never inline: STRONG/EM/A/SPAN). */
const BLOCKS = new Set([
  "P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI",
  "BLOCKQUOTE", "PRE", "CODE", "TABLE", "TBODY", "THEAD", "TR", "TD", "TH", "DIV",
]);

/** Elements the caret may be appended into (text hosts). */
const HOSTS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "TD", "TH", "CODE", "DIV"]);

/**
 * Find the element the streaming caret should be appended into: descend the
 * tail's last block child to the deepest last block, then accept it only if
 * it's a text host with non-blank content. `null` = render no caret this tick
 * (empty tail, trailing hr/image, empty paragraph) — a caret must never sit
 * alone on an empty line; the working row / active step is the fallback signal.
 */
export function caretHost(tail: CaretNode): CaretNode | null {
  let cur = tail.lastElementChild;
  if (!cur || !BLOCKS.has(cur.tagName)) return null;
  while (cur.lastElementChild && BLOCKS.has(cur.lastElementChild.tagName)) {
    if (cur.classList?.contains("mva-ui-preview")) return null;
    cur = cur.lastElementChild;
  }
  if (!HOSTS.has(cur.tagName)) return null;
  if (!(cur.textContent ?? "").trim()) return null;
  return cur;
}
