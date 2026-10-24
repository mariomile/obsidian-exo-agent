/**
 * Patch selected top-level YAML frontmatter keys without parsing and
 * re-serializing the whole block. Obsidian's `processFrontMatter()` normalizes
 * every value and can corrupt vault-specific YAML such as unquoted wikilinks
 * (`company: [[Acme]]`). Keeping untouched lines byte-for-byte is therefore a
 * correctness requirement for agent-driven edits.
 */

function yamlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function yamlValue(value: unknown): string {
  if (value === undefined) return "null";
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

function topLevelKey(line: string): string | null {
  if (!line || /^[ \t#-]/.test(line)) return null;
  const colon = line.indexOf(":");
  if (colon <= 0) return null;
  const raw = line.slice(0, colon).trim();
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw;
}

/** Where `key`'s block (its line plus indented continuation lines) sits. */
function keySpan(lines: readonly string[], key: string): { start: number; end: number } | null {
  const start = lines.findIndex((candidate) => topLevelKey(candidate) === key);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && topLevelKey(lines[end]) === null) end++;
  return { start, end };
}

function replaceKeyBlock(block: string, key: string, replacement: readonly string[], newline: string): string {
  const lines = block ? block.split(/\r?\n/) : [];
  const span = keySpan(lines, key);
  if (!span) lines.push(...replacement);
  else lines.splice(span.start, span.end - span.start, ...replacement);
  return lines.join(newline);
}

/** Where the frontmatter block sits: the offsets of its first byte and of the
 *  newline before its closing fence. Exported because it is the only correct
 *  reader of that shape in the repo, and anything that re-derives it inline
 *  ends up re-deriving the line endings too. */
export function frontmatterBounds(content: string): { start: number; end: number } | null {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return null;
  const match = /\r?\n---(?:\r?\n|$)/g;
  match.lastIndex = content.indexOf("\n") + 1;
  const closing = match.exec(content);
  if (!closing) return null;
  return { start: content.indexOf("\n") + 1, end: closing.index };
}

/** The line ending a document already uses. A file written by an editor that
 *  uses CRLF must come back CRLF, fences included. */
export const documentNewline = (content: string): string =>
  content.includes("\r\n") ? "\r\n" : "\n";

/** Merge/remove top-level keys while preserving every unrelated frontmatter byte. */
export function patchFrontmatter(
  content: string,
  changes: Record<string, unknown>,
  removeKeys: readonly string[] = []
): string {
  const entries = Object.entries(changes);
  if (!entries.length && !removeKeys.length) return content;

  const bounds = frontmatterBounds(content);
  if (!bounds) {
    if (!entries.length) return content;
    const lines = entries.map(([key, value]) => `${yamlKey(key)}: ${yamlValue(value)}`).join("\n");
    return `---\n${lines}\n---\n${content}`;
  }

  const newline = documentNewline(content);
  let block = content.slice(bounds.start, bounds.end);
  for (const key of removeKeys) {
    block = replaceKeyBlock(block, key, [], newline);
  }
  for (const [key, value] of entries) {
    const line = `${yamlKey(key)}: ${yamlValue(value)}`;
    block = replaceKeyBlock(block, key, [line], newline);
  }
  return content.slice(0, bounds.start) + block + content.slice(bounds.end);
}

/** The raw lines of top-level `key` (continuation lines included, no CR), or
 *  [] when the key or the frontmatter is absent. */
export function frontmatterKeyLines(content: string, key: string): string[] {
  const bounds = frontmatterBounds(content);
  if (!bounds) return [];
  const lines = content.slice(bounds.start, bounds.end).split(/\r?\n/);
  const span = keySpan(lines, key);
  return span ? lines.slice(span.start, span.end) : [];
}

/** Put back `key` as exactly `lines` ([] removes it). A frontmatter left with
 *  nothing in it is removed, fences included, when `dropEmpty` is set. */
export function setFrontmatterKeyLines(content: string, key: string, lines: readonly string[], dropEmpty = false): string {
  const bounds = frontmatterBounds(content);
  if (!bounds) return lines.length ? `---\n${lines.join("\n")}\n---\n${content}` : content;
  const block = replaceKeyBlock(content.slice(bounds.start, bounds.end), key, lines, documentNewline(content));
  if (dropEmpty && !block.trim()) return content.slice(bounds.end).replace(/^\r?\n---(?:\r?\n|$)/, "");
  return content.slice(0, bounds.start) + block + content.slice(bounds.end);
}
