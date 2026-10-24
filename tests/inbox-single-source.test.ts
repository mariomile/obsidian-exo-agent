import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Source contract for the Inbox (Release 2): one model decides what waits for
 * the user. A second surface that counted runs or the Daily Pulse on its own
 * would drift from `core/inbox`, which is exactly the "three counts that never
 * agree" this release removed.
 */

const SRC = join(__dirname, "..", "src");

const files: { path: string; text: string }[] = readdirSync(SRC, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ path: f.split("\\").join("/"), text: readFileSync(join(SRC, f), "utf8") }));

/** Files whose import statements name `symbol`. */
function importersOf(symbol: string): string[] {
  const re = new RegExp(`import\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s*from`);
  return files.filter((f) => re.test(f.text)).map((f) => f.path).sort();
}

describe("Inbox single source", () => {
  it("only core/inbox and the Daily Pulse collector read the raw review predicates", () => {
    const allowed = ["core/inbox.ts", "obsidian/daily-pulse.ts"];
    for (const symbol of ["unreviewedWriteRuns", "dailyPulseNeedsReview"]) {
      expect(importersOf(symbol).filter((p) => !allowed.includes(p)), symbol).toEqual([]);
    }
  });

  it("the attention models it replaced are gone", () => {
    for (const symbol of ["buildAttention", "convoAttention", "liveAttention", "needsStripSig"]) {
      const re = new RegExp(`\\b${symbol}\\b`);
      expect(files.filter((f) => re.test(f.text)).map((f) => f.path), symbol).toEqual([]);
    }
  });
});
