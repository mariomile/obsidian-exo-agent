import { describe, it, expect } from "vitest";
import {
  exoPaths,
  detectMemoryRoot,
  DEFAULT_MEMORY_ROOT,
  LEGACY_MEMORY_ROOT,
} from "../src/core/paths";

describe("exoPaths", () => {
  it("derives every path from a fresh-install root", () => {
    const p = exoPaths("_exo");
    expect(p.root).toBe("_exo");
    expect(p.memory).toBe("_exo/memory");
    expect(p.inbox).toBe("_exo/memory/inbox");
    expect(p.queue).toBe("_exo/exo-queue");
    expect(p.vaultContext).toBe("_exo/vault-context.md");
    expect(p.preferences).toBe("_exo/memory/preferences/preferences.md");
    expect(p.agentDir).toBe("_exo/agent");
    expect(p.agents).toBe("_exo/agents");
    expect(p.agentRuns).toBe("_exo/agents/runs");
    expect(p.agentMemory).toBe("_exo/memory/agents");
  });

  it("keeps the agent identity layer and the agent registry distinct", () => {
    const p = exoPaths("_exo");
    expect(p.agentDir).not.toBe(p.agents); // `agent/` = persona blocks, `agents/` = the registry
  });

  it("reproduces the exact legacy _system/ layout (marioverse must not move)", () => {
    const p = exoPaths(LEGACY_MEMORY_ROOT);
    expect(p.vaultContext).toBe("_system/vault-context.md");
    expect(p.inbox).toBe("_system/memory/inbox");
    expect(p.queue).toBe("_system/exo-queue");
    expect(p.review).toBe("_system/review.md");
    expect(p.rules).toBe("_system/memory/rules");
    expect(p.workflowSignals).toBe("_system/memory/workflow-signals.json");
  });

  it("falls back to the default root on empty input", () => {
    expect(exoPaths("").root).toBe(DEFAULT_MEMORY_ROOT);
  });

  it("trims trailing slashes from a user-entered root", () => {
    expect(exoPaths("MyMemory/").memory).toBe("MyMemory/memory");
  });
});

describe("detectMemoryRoot", () => {
  it("keeps _system/ for an existing install", () => {
    expect(detectMemoryRoot(true)).toBe(LEGACY_MEMORY_ROOT);
  });
  it("adopts _exo/ for a fresh vault", () => {
    expect(detectMemoryRoot(false)).toBe(DEFAULT_MEMORY_ROOT);
  });
});
