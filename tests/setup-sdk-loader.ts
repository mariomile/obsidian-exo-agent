import { vi } from "vitest";

// sdk-loader pulls the Agent SDK in with a bundled `require()`, which esbuild
// resolves but Node cannot (it would have to load a .ts file). Route it through
// Vitest's module graph instead, so a test's own
// `vi.mock("@anthropic-ai/claude-agent-sdk", ...)` still replaces what the
// session and tool builders get.
vi.mock("../src/providers/sdk-loader", async () => {
  const sdk = await import("../src/providers/sdk-exports");
  return { claudeSdk: () => sdk };
});
