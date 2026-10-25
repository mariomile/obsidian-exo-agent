import { describe, it, expect } from "vitest";
import { latestHarvestSha, reverseWrites, revertHarvestCommit, type UndoVault } from "../src/core/memory-undo";

/** Scripted git: answers by the first args, records every call. */
function fakeGit(answers: Record<string, string | Error>) {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    const key = Object.keys(answers)
      .sort((a, b) => b.length - a.length)
      .find((k) => args.join(" ").startsWith(k));
    const a = key === undefined ? "" : answers[key];
    if (a instanceof Error) throw a;
    return a;
  };
  return { run, calls };
}

const SHA = "a1b2c3d4e5f6";

describe("revertHarvestCommit", () => {
  it("reverts a harvest commit and commits ONLY its files with the revert message", async () => {
    const { run, calls } = fakeGit({
      [`log -1 --format=%s ${SHA}`]: "exo: memory harvest: 2 scritture (Pricing)\n",
      [`show --name-only --format= ${SHA}`]: "CRM/Anna.md\n_exo/memory/inbox/2026-09-25.md\n",
      [`log --format=%H ${SHA}..HEAD`]: "",
      "status --porcelain": "",
      "rev-parse HEAD": "ffff0000\n",
    });
    const res = await revertHarvestCommit(run, SHA);
    expect(res.ok).toBe(true);
    expect(res.revertSha).toBe("ffff0000");
    expect(calls).toContainEqual(["revert", "--no-commit", SHA]);
    expect(calls).toContainEqual([
      "commit",
      "-m",
      `exo: memory revert: ${SHA}`,
      "--",
      "CRM/Anna.md",
      "_exo/memory/inbox/2026-09-25.md",
    ]);
  });

  it("refuses a commit that is not a memory harvest", async () => {
    const { run, calls } = fakeGit({ [`log -1 --format=%s ${SHA}`]: "fix: typo\n" });
    const res = await revertHarvestCommit(run, SHA);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/not a memory harvest/);
    expect(calls.some((c) => c[0] === "revert")).toBe(false);
  });

  it("refuses when a touched file was committed again since", async () => {
    const { run, calls } = fakeGit({
      [`log -1 --format=%s ${SHA}`]: "exo: memory harvest: 1 scritture (x)",
      [`show --name-only --format= ${SHA}`]: "CRM/Anna.md\n",
      [`log --format=%H ${SHA}..HEAD`]: "9999\n",
      "status --porcelain": "",
    });
    const res = await revertHarvestCommit(run, SHA);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/changed since/);
    expect(calls.some((c) => c[0] === "revert")).toBe(false);
  });

  it("refuses when a touched file has uncommitted edits", async () => {
    const { run } = fakeGit({
      [`log -1 --format=%s ${SHA}`]: "exo: memory harvest: 1 scritture (x)",
      [`show --name-only --format= ${SHA}`]: "CRM/Anna.md\n",
      [`log --format=%H ${SHA}..HEAD`]: "",
      "status --porcelain": " M CRM/Anna.md\n",
    });
    expect((await revertHarvestCommit(run, SHA)).ok).toBe(false);
  });

  it("aborts the revert when git fails midway", async () => {
    const { run, calls } = fakeGit({
      [`log -1 --format=%s ${SHA}`]: "exo: memory harvest: 1 scritture (x)",
      [`show --name-only --format= ${SHA}`]: "a.md\n",
      [`log --format=%H ${SHA}..HEAD`]: "",
      "status --porcelain": "",
      "revert --no-commit": new Error("conflict"),
    });
    const res = await revertHarvestCommit(run, SHA);
    expect(res.ok).toBe(false);
    expect(calls).toContainEqual(["revert", "--abort"]);
  });

  it("reports an unknown sha", async () => {
    const { run } = fakeGit({ "log -1": new Error("bad revision") });
    expect((await revertHarvestCommit(run, "nope")).message).toMatch(/No commit/);
  });
});

describe("latestHarvestSha", () => {
  it("returns the newest harvest that no revert points at", async () => {
    const { run } = fakeGit({
      log: [
        "c3\texo: memory revert: c2",
        "c2\texo: memory harvest: 1 scritture (b)",
        "c1\texo: memory harvest: 3 scritture (a)",
      ].join("\n"),
    });
    expect(await latestHarvestSha(run)).toBe("c1");
  });
  it("null when every harvest was reverted, or none exist", async () => {
    expect(await latestHarvestSha(fakeGit({ log: "c2\texo: memory revert: c1\nc1\texo: memory harvest: 1 scritture (a)" }).run)).toBeNull();
    expect(await latestHarvestSha(fakeGit({ log: "" }).run)).toBeNull();
  });
});

describe("reverseWrites (no git, or uncommitted notes)", () => {
  function vault(files: Record<string, string>) {
    const store = new Map(Object.entries(files));
    const v: UndoVault = {
      read: async (p) => store.get(p) ?? null,
      process: async (p, fn) => {
        const cur = store.get(p);
        if (cur === undefined) throw new Error(`missing: ${p}`);
        store.set(p, fn(cur));
      },
      remove: async (p) => void store.delete(p),
    };
    return { v, store };
  }

  it("removes inserted lines and restores replaced ones, keeping the user's later edits", async () => {
    const { v, store } = vault({
      "a.md": "- one\n- user added later\n- Exo fact\n- Role: head (dal 2026-09-25; prima designer)\n",
    });
    const res = await reverseWrites(v, [
      { path: "a.md", op: "add", text: "Exo fact", lines: ["- Exo fact"] },
      {
        path: "a.md",
        op: "update",
        text: "Role: head",
        lines: ["- Role: head (dal 2026-09-25; prima designer)"],
        replaced: "- Role: designer",
      },
    ]);
    expect(res.ok).toBe(true);
    expect(store.get("a.md")).toBe("- one\n- user added later\n- Role: designer\n");
  });

  it("removes a note the harvest created once only its starter is left", async () => {
    const starter = "# Memory inbox: 2026-09-25\n";
    const { v, store } = vault({ "inbox.md": `${starter}- fact\n` });
    const res = await reverseWrites(v, [{ path: "inbox.md", op: "add", text: "fact", lines: ["- fact"], created: starter }]);
    expect(res.ok).toBe(true);
    expect(store.has("inbox.md")).toBe(false);
  });

  it("keeps a created note the user has since added to", async () => {
    const starter = "# Memory inbox: 2026-09-25\n";
    const { v, store } = vault({ "inbox.md": `${starter}- fact\n- mine\n` });
    await reverseWrites(v, [{ path: "inbox.md", op: "add", text: "fact", lines: ["- fact"], created: starter }]);
    expect(store.get("inbox.md")).toBe(`${starter}- mine\n`);
  });

  it("reverses a multi-line loop block", async () => {
    const block = ["## loop-9", "- title: Call Anna", "- opened: 2026-09-25T00:00:00.000Z", "- status: open", "", "Call Anna"];
    const { v, store } = vault({ "loops.md": `## loop-1\n- title: Old\n\nold\n\n${block.join("\n")}\n` });
    expect((await reverseWrites(v, [{ path: "loops.md", op: "add", text: "Call Anna", lines: block }])).ok).toBe(true);
    expect(store.get("loops.md")).toBe("## loop-1\n- title: Old\n\nold\n");
  });

  it("refuses, touching nothing, when any line was edited or duplicated since", async () => {
    const { v, store } = vault({ "a.md": "- Exo fact\n", "b.md": "- Exo fact reworded by hand\n" });
    const res = await reverseWrites(v, [
      { path: "a.md", op: "add", text: "Exo fact", lines: ["- Exo fact"] },
      { path: "b.md", op: "add", text: "Exo fact", lines: ["- Exo fact"] },
    ]);
    expect(res.ok).toBe(false);
    expect(store.get("a.md")).toBe("- Exo fact\n");
    const dup = vault({ "a.md": "- x\n- x\n" });
    expect((await reverseWrites(dup.v, [{ path: "a.md", op: "add", text: "x", lines: ["- x"] }])).ok).toBe(false);
  });

  it("fails visibly, keeping the user's edit, when the note changed between the read and the write", async () => {
    const { v, store } = vault({ "a.md": "- one\n- Exo fact\n" });
    const racing: UndoVault = {
      ...v,
      process: async (p, fn) => {
        store.set(p, "- one\n- Exo fact\n- typed just now\n");
        store.set(p, fn(store.get(p)!));
      },
    };
    const res = await reverseWrites(racing, [{ path: "a.md", op: "add", text: "Exo fact", lines: ["- Exo fact"] }]);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("a.md changed while undoing");
    expect(store.get("a.md")).toBe("- one\n- Exo fact\n- typed just now\n");
  });

  it("works on notes of any size (no snapshot limit)", async () => {
    const big = "- filler line\n".repeat(20_000);
    const { v, store } = vault({ "big.md": `${big}- fact\n` });
    expect((await reverseWrites(v, [{ path: "big.md", op: "add", text: "fact", lines: ["- fact"] }])).ok).toBe(true);
    expect(store.get("big.md")).toBe(big);
  });

  it("dryRun checks without writing", async () => {
    const { v, store } = vault({ "a.md": "- fact\n" });
    expect((await reverseWrites(v, [{ path: "a.md", op: "add", text: "fact", lines: ["- fact"] }], { dryRun: true })).ok).toBe(true);
    expect(store.get("a.md")).toBe("- fact\n");
  });
});
