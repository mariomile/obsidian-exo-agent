import { describe, expect, test } from "vitest";
import { sessionSignature } from "../src/core/session-signature";
import { DEFAULT_SETTINGS } from "../src/settings-schema";

const claude = { id: "c1", provider: "claude" as const, model: "sonnet" };
const codex = { id: "c2", provider: "codex" as const, model: "gpt-5" };
const sig = (c: typeof claude | typeof codex, over: Partial<typeof DEFAULT_SETTINGS> = {}) =>
  sessionSignature(c, { ...DEFAULT_SETTINGS, ...over }, "{}");

describe("sessionSignature", () => {
  test("plan mode and other live permission modes do not respawn", () => {
    expect(sig(claude, { permissionMode: "plan" })).toBe(sig(claude, { permissionMode: "default" }));
    expect(sig(claude, { permissionMode: "acceptEdits" })).toBe(sig(claude, { permissionMode: "default" }));
  });

  test("entering bypass does respawn: the CLI only accepts it at launch", () => {
    expect(sig(claude, { permissionMode: "bypassPermissions" })).not.toBe(sig(claude, { permissionMode: "default" }));
  });

  test("flipping the browser flag respawns", () => {
    expect(sig(claude, { browserEnabled: true })).not.toBe(sig(claude, { browserEnabled: false }));
  });

  test("Codex settings leave Claude sessions alone, and the reverse", () => {
    expect(sig(claude, { codexSandbox: "danger-full-access" })).toBe(sig(claude));
    expect(sig(claude, { codexBin: "/x/codex" })).toBe(sig(claude));
    expect(sig(codex, { claudeBin: "/x/claude" })).toBe(sig(codex));
    expect(sig(codex, { codexSandbox: "danger-full-access" })).not.toBe(sig(codex));
  });
});
