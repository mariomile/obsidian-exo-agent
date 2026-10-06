import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  checkpointRef,
  isCheckpointable,
  parseNumstat,
  planTurnRevert,
  revertSummary,
} from "../src/core/turn-checkpoint";
import {
  captureTurnCheckpoint,
  readTurnDiff,
  revertTurn,
  type CheckpointVault,
} from "../src/obsidian/turn-checkpoint";

describe("turn checkpoint rules", () => {
  it("never captures synced sources, runtime or attachments", () => {
    expect(isCheckpointable("Input/Readwise/Book.md")).toBe(false);
    expect(isCheckpointable(".claude/settings.json")).toBe(false);
    expect(isCheckpointable("_attachments/a.png")).toBe(false);
    expect(isCheckpointable("Knowledge/Note.md")).toBe(true);
  });

  it("refuses paths outside the vault and excluded folders in any spelling", () => {
    expect(isCheckpointable("/Users/x/other.md")).toBe(false);
    expect(isCheckpointable("C:/x.md")).toBe(false);
    expect(isCheckpointable("Notes/../../x.md")).toBe(false);
    expect(isCheckpointable("input/readwise/x.md")).toBe(false);
    expect(isCheckpointable("./Input//Readwise/x.md")).toBe(false);
  });

  it("names one hidden ref per turn, ref-safe", () => {
    expect(checkpointRef("c-1", 42)).toBe("refs/exo/checkpoints/c-1/42");
    expect(checkpointRef("a b/c", 1)).toBe("refs/exo/checkpoints/a_b_c/1");
  });

  it("restores only files still as the turn left them", () => {
    const plan = planTurnRevert([
      { path: "edited.md", before: "v1", after: "v2", current: "v2" },
      { path: "created.md", before: null, after: "new", current: "new" },
      { path: "touched-since.md", before: "v1", after: "v2", current: "v3" },
      { path: "already.md", before: "v1", after: "v2", current: "v1" },
    ]);
    expect(plan.map((a) => a.kind)).toEqual(["write", "delete", "skip-changed", "skip-noop"]);
  });

  it("parses numstat, binary counts as zero", () => {
    expect(parseNumstat("3\t1\ta.md\0-\t-\timg.png\0")).toEqual([
      { path: "a.md", additions: 3, deletions: 1 },
      { path: "img.png", additions: 0, deletions: 0 },
    ]);
  });

  it("says what was reverted and what was left alone", () => {
    const s = revertSummary(
      [
        { path: "a.md", kind: "write", content: "x" },
        { path: "b.md", kind: "skip-changed" },
      ],
      [],
    );
    expect(s).toBe("Reverted 1 file from this turn. Left alone, changed since: b.md.");
  });
});

describe("turn checkpoint against a real git repo", () => {
  let root: string;
  let vault: CheckpointVault;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const file = (p: string) => join(root, p);
  const put = (p: string, c: string) => {
    mkdirSync(dirname(file(p)), { recursive: true });
    writeFileSync(file(p), c);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "exo-ckpt-test-"));
    git("init", "-q");
    put("keep.md", "untouched\n");
    put("note.md", "before\n");
    git("add", "keep.md", "note.md");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
    vault = {
      basePath: root,
      read: async (p) => (existsSync(file(p)) ? readFileSync(file(p), "utf8") : null),
      write: async (p, c) => put(p, c),
      remove: async (p) => unlinkSync(file(p)),
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("captures a turn without touching the index or branch, and diffs it", async () => {
    const head = git("rev-parse", "HEAD").trim();
    // The turn: edits note.md, creates new.md.
    put("note.md", "after\n");
    put("new.md", "fresh\n");
    const ref = await captureTurnCheckpoint(vault, "convo1", new Map([["note.md", "before\n"], ["new.md", null]]), 7);
    expect(ref).toBe("refs/exo/checkpoints/convo1/7");
    expect(git("rev-parse", "HEAD").trim()).toBe(head);
    expect(git("diff", "--cached", "--name-only").trim()).toBe(""); // user's index untouched

    const d = await readTurnDiff(root, ref!);
    expect(d!.files.map((f) => f.path).sort()).toEqual(["new.md", "note.md"]);
    expect(d!.patch).toContain("-before");
    expect(d!.patch).toContain("+after");
  });

  it("reverts only that turn, and leaves a file edited since alone", async () => {
    put("note.md", "after\n");
    put("new.md", "fresh\n");
    put("other.md", "turn wrote\n");
    const ref = await captureTurnCheckpoint(
      vault,
      "c",
      new Map([["note.md", "before\n"], ["new.md", null], ["other.md", "orig\n"]]),
    );
    put("other.md", "user edited after the turn\n");

    const r = await revertTurn(vault, ref!);
    expect(readFileSync(file("note.md"), "utf8")).toBe("before\n");
    expect(existsSync(file("new.md"))).toBe(false);
    expect(readFileSync(file("other.md"), "utf8")).toBe("user edited after the turn\n");
    expect(r!.actions.find((a) => a.path === "other.md")?.kind).toBe("skip-changed");
    expect(readFileSync(file("keep.md"), "utf8")).toBe("untouched\n");
  });

  it("reverts a rename as two files: the new one goes, the old one comes back", async () => {
    unlinkSync(file("note.md"));
    put("moved.md", "before\n");
    const ref = await captureTurnCheckpoint(vault, "c", new Map([["note.md", "before\n"], ["moved.md", null]]));
    const d = await readTurnDiff(root, ref!);
    expect(d!.files.map((f) => f.path).sort()).toEqual(["moved.md", "note.md"]);
    await revertTurn(vault, ref!);
    expect(readFileSync(file("note.md"), "utf8")).toBe("before\n");
    expect(existsSync(file("moved.md"))).toBe(false);
  });

  it("keeps the rest of the turn when one path points outside the vault", async () => {
    put("note.md", "after\n");
    const ref = await captureTurnCheckpoint(vault, "c", new Map([["note.md", "before\n"], ["/etc/hosts", "x"]]));
    expect(ref).not.toBeNull();
    expect((await readTurnDiff(root, ref!))!.files.map((f) => f.path)).toEqual(["note.md"]);
  });

  it("skips excluded folders and returns null outside a git repo", async () => {
    put("Input/Readwise/x.md", "after\n");
    expect(await captureTurnCheckpoint(vault, "c", new Map([["Input/Readwise/x.md", "before\n"]]))).toBeNull();
    const notRepo = mkdtempSync(join(tmpdir(), "exo-norepo-"));
    try {
      expect(await captureTurnCheckpoint({ ...vault, basePath: notRepo }, "c", new Map([["a.md", null]]))).toBeNull();
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });
});
