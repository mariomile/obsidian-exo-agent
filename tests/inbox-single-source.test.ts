import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Source contract for the Inbox (Release 2): one model decides what waits for
 * the user. A second surface that counted runs, the Daily Pulse or unseen chats
 * on its own would drift from `core/inbox`, which is exactly the "three counts
 * that never agree" this release removed.
 *
 * Usage, not imports: a namespace import (`import * as inbox`) or a re-export
 * would slip past an import check. Comments are stripped first, so a comment
 * that names a rule is not a use of it.
 */

const SRC = join(__dirname, "..", "src");

const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const files: { path: string; code: string }[] = readdirSync(SRC, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ path: f.split("\\").join("/"), code: stripComments(readFileSync(join(SRC, f), "utf8")) }));

/** Files whose code names `symbol`. */
function usersOf(symbol: string): string[] {
  const re = new RegExp(`\\b${symbol}\\b`);
  return files.filter((f) => re.test(f.code)).map((f) => f.path).sort();
}

/** Files whose code matches `re`. */
function matching(re: RegExp): string[] {
  return files.filter((f) => re.test(f.code)).map((f) => f.path).sort();
}

describe("Inbox single source", () => {
  it("the Daily Pulse review rule is read only by core/inbox", () => {
    expect(usersOf("dailyPulseNeedsReview")).toEqual(["core/daily-pulse.ts", "core/inbox.ts"]);
  });

  it("the read rule and the visibility rule live in core/inbox and are read only by the chat surfaces", () => {
    expect(usersOf("isUnseen")).toEqual(["core/chat-rows.ts", "core/inbox.ts", "view.ts"]);
    expect(usersOf("isListedChat")).toEqual(["core/chat-rows.ts", "core/inbox.ts"]);
  });

  it("no file restates a rule inline", () => {
    // Unreviewed write run: core/automations `awaitsReview` (and the failed-run
    // rule next to it in core/inbox) is the only place these fields meet.
    expect(matching(/reviewedAt\s*&&\s*!\s*[\w.]*restoredAt|restoredAt\s*&&\s*!\s*[\w.]*reviewedAt/)).toEqual([
      "core/automations.ts",
      "core/inbox.ts",
    ]);
    expect(matching(/writes\.length\s*>\s*0\s*&&/)).toEqual(["core/automations.ts"]);
    // Unseen: a turn newer than the visit or read watermark.
    expect(matching(/>\s*Math\.max\([^)]*(lastActiveAt|seenAt)/)).toEqual(["core/inbox.ts"]);
    // Visibility: not archived and not an empty husk.
    expect(matching(/archived\s*&&\s*deriveLane/)).toEqual(["core/inbox.ts"]);
  });

  it("the attention models it replaced are gone", () => {
    for (const symbol of ["buildAttention", "convoAttention", "liveAttention", "needsStripSig", "unreviewedWriteRuns"]) {
      expect(usersOf(symbol), symbol).toEqual([]);
    }
  });
});
