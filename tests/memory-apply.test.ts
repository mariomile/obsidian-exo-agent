import { describe, it, expect } from "vitest";
import { applyDecisions, type ApplyEnv, type ApplyVault } from "../src/core/memory-apply";
import { harvestBlocklist, HARVEST_MAX_WRITES, type Decision } from "../src/core/memory-harvest";
import { exoPaths } from "../src/core/paths";
import { makeExclusion } from "../src/core/vault-exclusions";
import { parseLoopsFile } from "../src/core/open-loops";

function fakeVault(files: Record<string, string>) {
  const store = new Map(Object.entries(files));
  const created: string[] = [];
  const vault: ApplyVault = {
    exists: (p) => store.has(p),
    edit: async (p, fn) => {
      const cur = store.get(p);
      if (cur === undefined) return false;
      const next = fn(cur);
      if (next === null) return false;
      store.set(p, next);
      return true;
    },
    create: async (p, c) => {
      if (store.has(p)) throw new Error(`create over ${p}`);
      created.push(p);
      store.set(p, c);
    },
  };
  return { vault, store, created };
}

const P = exoPaths("_exo");
const TAIL = ' [fonte: chat "Planning" (obsidian://exo-chat?id=c-1&msg=0); dal: 2026-09-25]';
const INBOX = "_exo/memory/inbox/2026-09-25.md";
function envFor(vault: ApplyVault, offered: string[]): ApplyEnv {
  return {
    exists: (p) => vault.exists(p),
    inboxPath: INBOX,
    blocked: harvestBlocklist(P),
    excluded: makeExclusion([], ["Input/"]),
    today: "2026-09-25",
    now: 1_790_000_000_000,
    offered: new Set(offered),
    ledgerPath: P.openLoops,
    provenance: { convoId: "c-1", chatTitle: "Planning", date: "2026-09-25" },
  };
}

describe("applyDecisions", () => {
  it("ADD appends one bullet to the named section and records the exact line", async () => {
    const { vault, store } = fakeVault({ "CRM/Anna.md": "# Anna\n## Work\n- Designer\n" });
    const res = await applyDecisions(
      vault,
      [{ op: "add", candidate: 0, path: "CRM/Anna.md", section: "Work", text: "Leads design at Acme" }],
      envFor(vault, ["CRM/Anna.md"]),
    );
    expect(store.get("CRM/Anna.md")).toBe(`# Anna\n## Work\n- Designer\n- Leads design at Acme${TAIL}\n`);
    expect(res.writes).toEqual([{ path: "CRM/Anna.md", op: "add", text: "Leads design at Acme", lines: [`- Leads design at Acme${TAIL}`] }]);
  });

  it("UPDATE replaces only the exact line and records both lines; a line not there exactly once is rejected", async () => {
    const { vault, store } = fakeVault({ "P/context.md": "- Status: beta\n- Owner: Mario\n- Owner: Mario\n" });
    const res = await applyDecisions(
      vault,
      [
        { op: "update", candidate: 0, path: "P/context.md", oldLine: "- Status: beta", newText: "Status: live" },
        { op: "update", candidate: 1, path: "P/context.md", oldLine: "- Owner: Mario", newText: "Owner: Anna" },
        { op: "update", candidate: 2, path: "P/context.md", oldLine: "- Status: alpha", newText: "x" },
      ],
      envFor(vault, ["P/context.md"]),
    );
    expect(store.get("P/context.md")).toBe("- Status: live (dal 2026-09-25; prima Status: beta)\n- Owner: Mario\n- Owner: Mario\n");
    expect(res.writes).toEqual([
      {
        path: "P/context.md",
        op: "update",
        text: "Status: live",
        lines: ["- Status: live (dal 2026-09-25; prima Status: beta)"],
        replaced: "- Status: beta",
      },
    ]);
    expect(res.rejected).toHaveLength(2);
  });

  it("UPDATE on frontmatter is refused even when the model asks for it", async () => {
    const before = "---\nstatus: beta\n---\n# P\n";
    const { vault, store } = fakeVault({ "P/context.md": before });
    const res = await applyDecisions(
      vault,
      [{ op: "update", candidate: 0, path: "P/context.md", oldLine: "status: beta", newText: "status: live" }],
      envFor(vault, ["P/context.md"]),
    );
    expect(res.writes).toEqual([]);
    expect(store.get("P/context.md")).toBe(before);
  });

  it("NOOP writes nothing", async () => {
    const { vault, store } = fakeVault({ "a.md": "x\n" });
    const res = await applyDecisions(vault, [{ op: "noop", candidate: 0 }], envFor(vault, ["a.md"]));
    expect(res.writes).toEqual([]);
    expect(store.get("a.md")).toBe("x\n");
  });

  it("only notes shown to the decider are writable, whatever the model answers", async () => {
    const { vault, store } = fakeVault({ "CRM/Anna.md": "- a\n", "CRM/Bob.md": "- b\n" });
    const res = await applyDecisions(
      vault,
      [{ op: "add", candidate: 0, path: "CRM/Bob.md", text: "not offered" }],
      envFor(vault, ["CRM/Anna.md"]),
    );
    expect(res.writes).toEqual([]);
    expect(res.rejected[0].reason).toBe("not a note shown to the decider");
    expect(store.get("CRM/Bob.md")).toBe("- b\n");
  });

  it("guardrails reject ignored, kernel, mechanism and non-existent paths without touching them", async () => {
    const files = {
      "Input/Readwise/Book.md": "book\n",
      "_exo/agent/USER.md": "user\n",
      "_exo/vault-context.md": "ctx\n",
      ".obsidian/x.md": "cfg\n",
    };
    const { vault, store, created } = fakeVault(files);
    const targets = [...Object.keys(files), "CRM/New Person.md"];
    const decisions: Decision[] = targets.map((path, i) => ({ op: "add", candidate: i, path, text: "note" }));
    const res = await applyDecisions(vault, decisions, envFor(vault, targets));
    expect(res.writes).toEqual([]);
    expect(res.rejected.map((r) => r.reason)).toEqual([
      "synced source folder",
      "agent kernel or Exo mechanism file",
      "agent kernel or Exo mechanism file",
      "hidden or config folder",
      "note does not exist",
    ]);
    expect(created).toEqual([]);
    for (const [p, c] of Object.entries(files)) expect(store.get(p)).toBe(c);
  });

  it("creates today's inbox note when needed, and records its starter content", async () => {
    const { vault, store, created } = fakeVault({});
    const res = await applyDecisions(
      vault,
      [
        { op: "add", candidate: 0, path: INBOX, text: "rclone has a gdrive remote" },
        { op: "add", candidate: 1, path: INBOX, text: "second fact" },
      ],
      envFor(vault, []),
    );
    expect(created).toEqual([INBOX]);
    expect(store.get(INBOX)).toMatch(new RegExp(`# Memory inbox: 2026-09-25\\n- rclone has a gdrive remote \\[fonte: chat "Planning" \\(obsidian://exo-chat\\?id=c-1&msg=0\\); dal: 2026-09-25\\]\\n- second fact \\[fonte[^\\n]*\\]\\n$`));
    expect(res.writes[0].created).toContain("# Memory inbox: 2026-09-25");
    expect(res.writes[1].created).toBeUndefined();
  });

  it("an open loop becomes a well-formed ledger entry; UPDATE on the ledger is refused", async () => {
    const ledger = "## loop-1\n- title: Old\n- opened: 2026-09-01T00:00:00.000Z\n- status: open\n\nold note\n";
    const { vault, store } = fakeVault({ [P.openLoops]: ledger });
    const res = await applyDecisions(
      vault,
      [
        { op: "add", candidate: 0, path: P.openLoops, text: "Call Anna back about the design role" },
        { op: "update", candidate: 1, path: P.openLoops, oldLine: "- title: Old", newText: "title: New" },
      ],
      envFor(vault, [P.openLoops]),
    );
    const loops = parseLoopsFile(store.get(P.openLoops)!);
    expect(loops.map((l) => l.title)).toEqual(["Old", "Call Anna back about the design role"]);
    expect(loops[0].note).toBe("old note"); // the previous loop is untouched
    expect(res.rejected.map((r) => r.reason)).toEqual(["the open-loops ledger only takes new loops"]);
  });

  it("drops edits that carry a credential", async () => {
    const { vault, store } = fakeVault({ "a.md": "- x\n" });
    const res = await applyDecisions(
      vault,
      [{ op: "add", candidate: 0, path: "a.md", text: "deploy token: ghp_abcdefghijklmnopqrstuvwxyz0123" }],
      envFor(vault, ["a.md"]),
    );
    expect(res.writes).toEqual([]);
    expect(res.rejected[0].reason).toBe("looks like a credential");
    expect(store.get("a.md")).toBe("- x\n");
  });

  it(`stops at ${HARVEST_MAX_WRITES} writes per harvest`, async () => {
    const { vault } = fakeVault({ "a.md": "" });
    const decisions: Decision[] = Array.from({ length: HARVEST_MAX_WRITES + 3 }, (_, i) => ({
      op: "add" as const,
      candidate: i,
      path: "a.md",
      text: `fact number ${i}`,
    }));
    const res = await applyDecisions(vault, decisions, envFor(vault, ["a.md"]));
    expect(res.writes).toHaveLength(HARVEST_MAX_WRITES);
    expect(res.rejected.filter((r) => r.reason === "write limit reached")).toHaveLength(3);
  });
});
