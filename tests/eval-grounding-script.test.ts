import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Runs the real script under real Node: it loads src/core/grounding.ts as it is,
// so an import Node cannot strip (or a syntax it cannot run) fails here, not in
// the first `pnpm eval:grounding` after a release.
describe("scripts/eval-grounding.mjs", () => {
  it("scores a fixture vault end to end", () => {
    const vault = mkdtempSync(join(tmpdir(), "exo-eval-grounding-"));
    try {
      const plugin = join(vault, ".obsidian/plugins/exo-agent");
      mkdirSync(plugin, { recursive: true });
      mkdirSync(join(vault, "Knowledge"), { recursive: true });
      mkdirSync(join(vault, "Agents/Exo"), { recursive: true });
      writeFileSync(join(vault, "Knowledge/Pricing.md"), "---\naliases: [Tariffe]\n---\nPro is 29.\n");
      writeFileSync(join(vault, "Knowledge/Pricing 2025.md"), "old\n");
      writeFileSync(join(vault, "SOUL.md"), "root soul\n");
      writeFileSync(join(vault, "Agents/Exo/SOUL.md"), "exo soul\n");

      const turn = (id: string, userAt: number, notes: object[]) => ({ convoId: id, msgIndex: 0, userAt, at: userAt, notes });
      writeFileSync(
        join(plugin, "recall-log.json"),
        JSON.stringify([
          turn("cites", 1, [{ path: "Knowledge/Pricing.md" }]),
          turn("ignores", 2, [{ path: "Knowledge/Pricing.md" }]),
          turn("stale", 3, [{ path: "Knowledge/Pricing 2025.md", supersededBy: "Knowledge/Pricing.md" }]),
          turn("ambiguous", 4, [{ path: "Agents/Exo/SOUL.md" }]),
          turn("rewound", 5, [{ path: "Knowledge/Pricing.md" }]),
        ]),
      );
      const convo = (id: string, at: number, md: string) => ({
        id,
        messages: [
          { role: "user", text: "q", at },
          { role: "assistant", segments: [{ t: "text", md }] },
        ],
      });
      writeFileSync(
        join(plugin, "conversations.json"),
        JSON.stringify([
          convo("cites", 1, "See [[Tariffe]]."),
          convo("ignores", 2, "No links."),
          convo("stale", 3, "It was [[Pricing 2025]]."),
          convo("ambiguous", 4, "Per [[SOUL]]."),
          convo("rewound", 99, "Unrelated [[Pricing]]."),
        ]),
      );

      const out = execFileSync(
        process.execPath,
        ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", resolve(__dirname, "../scripts/eval-grounding.mjs")],
        { env: { ...process.env, EXO_VAULT: vault }, encoding: "utf8" },
      );
      expect(out).toMatch(/logged turns:\s+5 \(1 without a reply to join/);
      expect(out).toMatch(/turns scored:\s+4\n/);
      expect(out).toMatch(/citation rate:\s+3\/4 \(75%\)/);
      expect(out).toMatch(/superseded as current:\s+1\s/);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});
