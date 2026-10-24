import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../src/cli", () => ({ resolveCli: vi.fn(async () => ({ bin: "node", pathEnv: "" })) }));

import { spawn } from "node:child_process";
import { parseChatScores, recallChatScores, recallHost } from "../src/obsidian/chat-recall";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

const fakeChild = (): FakeChild => Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: vi.fn() });

const spawned = vi.mocked(spawn);

/** A plugin dir, with or without a built chat index. */
function pluginDir(indexed: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "exo-chat-recall-"));
  if (indexed) {
    mkdirSync(join(dir, "chat-index"));
    writeFileSync(join(dir, "chat-index", "meta.json"), "{}");
  }
  return dir;
}

describe("chat recall subprocess", () => {
  beforeEach(() => spawned.mockReset());

  it("no chat index, no spawn: the semantic lane is simply absent", async () => {
    expect(await recallChatScores(recallHost(pluginDir(false)), "pricing tiers")).toBeNull();
    expect(spawned).not.toHaveBeenCalled();
  });

  it("with an index, runs the query and parses the scored ids", async () => {
    const child = fakeChild();
    spawned.mockReturnValue(child as never);
    const pending = recallChatScores(recallHost(pluginDir(true)), "pricing tiers");
    await vi.waitFor(() => expect(spawned).toHaveBeenCalled());
    child.stdout.emit("data", Buffer.from("0.91\tabc\n0.80\tdef\n"));
    child.emit("close", 0);
    expect(await pending).toEqual([
      { id: "abc", score: 0.91 },
      { id: "def", score: 0.8 },
    ]);
  });

  it("an abort kills the child and resolves null", async () => {
    const child = fakeChild();
    spawned.mockReturnValue(child as never);
    const ctrl = new AbortController();
    const pending = recallChatScores(recallHost(pluginDir(true)), "pricing tiers", 12, ctrl.signal);
    await vi.waitFor(() => expect(spawned).toHaveBeenCalled());
    ctrl.abort();
    expect(await pending).toBeNull();
    expect(child.kill).toHaveBeenCalled();
  });

  it("an already aborted signal spawns nothing", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await recallChatScores(recallHost(pluginDir(true)), "pricing tiers", 12, ctrl.signal)).toBeNull();
    expect(spawned).not.toHaveBeenCalled();
  });
});

describe("parseChatScores", () => {
  it("keeps well-formed score/id lines, best first as written", () => {
    expect(parseChatScores("0.9\ta\nnot a line\nx\tc\n0.5\t d \n")).toEqual([
      { id: "a", score: 0.9 },
      { id: "d", score: 0.5 },
    ]);
  });
});
