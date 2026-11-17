/**
 * Live check of the opencode adapter against a real `opencode acp` and a real
 * model — opt-in, never part of `pnpm test`:
 *
 *   EXO_LIVE_OPENCODE=1 pnpm vitest run tests/live/opencode-acp.live.test.ts
 *
 * Uses opencode's default model from the user's own config (a local model
 * server keeps it free). Runs in a temp directory, never a vault.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { OpencodeSession } from "../../src/providers/opencode";
import { startMcpBridge } from "../../src/obsidian/mcp-bridge";
import { resolveCli } from "../../src/cli";
import type { AgentEvent } from "../../src/providers/types";

const LIVE = process.env.EXO_LIVE_OPENCODE === "1";

const readNote = tool("read_note", "Read a note from the user's Obsidian vault by its title.", { target: z.string() }, async (a) => ({
  content: [{ type: "text", text: a.target === "Secrets" ? "The password is kiwi." : "No such note." }],
}));

describe.skipIf(!LIVE)("opencode ACP (live)", () => {
  it("reads through the Obsidian bridge, edits a file with permission, and resumes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "exo-opencode-live-"));
    await writeFile(join(dir, "notes.md"), "# Notes\n");
    const bridge = await startMcpBridge();
    bridge.setTools([readNote]);
    const cli = await resolveCli("opencode", process.env.OPENCODE_BIN ?? "");
    const opts = {
      cli,
      model: "",
      effort: "default",
      cwd: dir,
      permissionMode: "default" as const,
      toolsEnabled: true,
      fastStartup: true,
      mcpBridge: { port: bridge.port, token: bridge.token, scriptPath: "", stop: () => bridge.stop() },
    };
    const session = new OpencodeSession(opts);
    let sessionId: string | undefined;
    try {
      const events: AgentEvent[] = [];
      await session.send(
        "Use the obsidian read_note tool on the note 'Secrets', then write the password alone into a file named answer.md in the current directory. Reply with just the password.",
        (e) => {
          events.push(e);
          if (e.kind === "permission-request") e.resolve({ behavior: "allow" });
          if (e.kind === "turn-end") sessionId = e.sessionId;
        }
      );
      const asked = events.flatMap((e) => (e.kind === "permission-request" ? [e.tool] : []));
      expect(asked).toContain("mcp__obsidian__read_note");
      expect(asked).toContain("Write");
      const started = events.flatMap((e) => (e.kind === "tool-call-start" ? [e.name] : []));
      expect(started).toContain("mcp__obsidian__read_note");
      const text = events.flatMap((e) => (e.kind === "text-delta" ? [e.text] : [])).join("");
      expect(text.toLowerCase()).toContain("kiwi");
      expect((await readFile(join(dir, "answer.md"), "utf8")).toLowerCase()).toContain("kiwi");
      expect(events.some((e) => e.kind === "usage")).toBe(true);
      expect(session.lastTurnTokens()).toBeGreaterThan(0);
    } finally {
      session.dispose("live-test");
    }

    // A fresh process resumes the same opencode session with its context.
    const resumed = new OpencodeSession({ ...opts, mcpBridge: undefined, resumeSessionId: sessionId });
    try {
      let text = "";
      await resumed.send("What was the password? Answer from memory, without tools.", (e) => {
        if (e.kind === "text-delta") text += e.text;
        if (e.kind === "permission-request") e.resolve({ behavior: "deny" });
      });
      expect(text.toLowerCase()).toContain("kiwi");
    } finally {
      resumed.dispose("live-test");
      bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
