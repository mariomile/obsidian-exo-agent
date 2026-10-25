/**
 * Text hygiene shared by memory harvest, saves and provenance lines: credential
 * detection, titles safe to write anywhere, one-line facts. No Obsidian import.
 */

/* ------------------------------- secrets -------------------------------- */

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\bbearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  /\b(?:password|passwd|pwd|passphrase|api[_ -]?key|secret|token|access[_ -]?key)\s*[:=]\s*\S{6,}/i,
  // env-style assignments: OPENAI_API_KEY=…, DB_PASSWORD: …
  /\b[A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD|PASSWD)[A-Z0-9_]*\s*[:=]\s*\S+/i,
  /\bsk_(?:live|test)_[A-Za-z0-9]+/,
  // credentials inside a URL: https://user:pass@host
  /:\/\/[^/\s:@]+:[^@\s]+@/,
  // Italian: "la password è …", "password e' …"
  /\bpassword\s+(?:è|e')\s*\S+/i,
];

/** True when `text` carries something that looks like a credential. */
export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

/** A chat title safe to put in a commit message, a Notice or the log. */
export function safeTitle(title: string): string {
  const t = title.replace(/\s+/g, " ").trim();
  return !t || containsSecret(t) ? "chat" : t;
}

/** One line, no leading bullet, no trailing whitespace. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/^[-*+]\s+/, "");
}
