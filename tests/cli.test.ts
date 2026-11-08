import { describe, it, expect } from "vitest";
import { buildPathEnv, fixedPathCandidates, versionManagerCandidates, firstExisting, claudeInstallChannel } from "../src/cli";

const HOME = "/home/u";

describe("fixedPathCandidates", () => {
  it("lists canonical install locations in priority order", () => {
    expect(fixedPathCandidates("claude", HOME)).toEqual([
      "/home/u/.claude/local/claude",
      "/home/u/.claude/bin/claude",
      "/home/u/.local/bin/claude",
      "/home/u/.local/node/bin/claude",
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ]);
  });

  it("covers the opencode curl installer's ~/.opencode/bin", () => {
    expect(fixedPathCandidates("opencode", HOME)).toContain("/home/u/.opencode/bin/opencode");
  });
});

describe("versionManagerCandidates", () => {
  it("orders volta, asdf, bun, npm-global, then nvm dirs (newest first)", () => {
    const cands = versionManagerCandidates("claude", HOME, {
      platform: "linux",
      nvmVersions: ["v22.0.0", "v20.0.0"],
    });
    expect(cands).toEqual([
      "/home/u/.volta/bin/claude",
      "/home/u/.asdf/shims/claude",
      "/home/u/.bun/bin/claude",
      "/home/u/.npm-global/bin/claude",
      "/home/u/.nvm/versions/node/v22.0.0/bin/claude",
      "/home/u/.nvm/versions/node/v20.0.0/bin/claude",
    ]);
  });

  it("includes $npm_config_prefix/bin after npm-global when set, and omits it when unset", () => {
    const withPrefix = versionManagerCandidates("codex", HOME, {
      platform: "linux",
      npmConfigPrefix: "/opt/npm",
    });
    expect(withPrefix).toContain("/opt/npm/bin/codex");
    // Sits right after ~/.npm-global/bin.
    expect(withPrefix.indexOf("/opt/npm/bin/codex")).toBe(
      withPrefix.indexOf("/home/u/.npm-global/bin/codex") + 1
    );

    const withoutPrefix = versionManagerCandidates("codex", HOME, { platform: "linux" });
    expect(withoutPrefix.some((c) => c.includes("/opt/npm/"))).toBe(false);
  });

  it("adds the Obsidian-app-adjacent dir only on macOS", () => {
    const mac = versionManagerCandidates("claude", HOME, {
      platform: "darwin",
      execPath: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
    });
    expect(mac).toContain("/Applications/Obsidian.app/Contents/MacOS/claude");

    const linux = versionManagerCandidates("claude", HOME, {
      platform: "linux",
      execPath: "/usr/bin/obsidian",
    });
    expect(linux.some((c) => c.includes("Obsidian.app"))).toBe(false);
  });

  it("puts nvm dirs LAST — after every other version-manager location", () => {
    const cands = versionManagerCandidates("claude", HOME, {
      platform: "darwin",
      execPath: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
      npmConfigPrefix: "/opt/npm",
      nvmVersions: ["v22.0.0"],
    });
    const nvmIdx = cands.findIndex((c) => c.includes("/.nvm/"));
    expect(nvmIdx).toBe(cands.length - 1);
    // Every non-nvm candidate precedes the nvm one.
    expect(cands.slice(0, nvmIdx).every((c) => !c.includes("/.nvm/"))).toBe(true);
  });
});

describe("firstExisting", () => {
  it("returns the first candidate the injected predicate accepts", () => {
    const exists = (p: string) => p === "/b" || p === "/c";
    expect(firstExisting(["/a", "/b", "/c"], exists)).toBe("/b");
  });

  it("returns null when nothing exists", () => {
    expect(firstExisting(["/a", "/b"], () => false)).toBeNull();
  });

  describe("claudeInstallChannel", () => {
    it("classifies the native installer (~/.local/share/claude) as native", () => {
      // The launcher ~/.local/bin/claude symlinks into the versions store.
      const realpath = () => "/home/u/.local/share/claude/versions/2.1.237";
      expect(claudeInstallChannel("/home/u/.local/bin/claude", realpath)).toBe("native");
    });

    it("follows the launcher symlink into node_modules → npm", () => {
      // A global npm install: <prefix>/bin/claude → <prefix>/lib/node_modules/…
      const realpath = () => "/opt/npm/lib/node_modules/@anthropic-ai/claude-code/cli.js";
      expect(claudeInstallChannel("/opt/npm/bin/claude", realpath)).toBe("npm");
    });

    it("defaults to native when realpath reveals no node_modules (homebrew, bare path)", () => {
      expect(claudeInstallChannel("/opt/homebrew/bin/claude", (p) => p)).toBe("native");
    });

    it("treats a broken symlink (realpath returns the path as-is) as native", () => {
      expect(claudeInstallChannel("/home/u/.local/bin/claude", (p) => p)).toBe("native");
    });
  });

  it("pins the incident: a canonical fixed path beats a stale nvm hit", () => {
    // Both a fixed path AND a stale nvm copy 'exist'. Checked as one ordered list
    // (fixed first), the canonical path must win — the shape of today's bug fix.
    const fixed = fixedPathCandidates("claude", HOME);
    const vm = versionManagerCandidates("claude", HOME, {
      platform: "linux",
      nvmVersions: ["v18.0.0"],
    });
    const staleNvm = vm[vm.length - 1];
    const liveHomebrew = "/opt/homebrew/bin/claude";
    const exists = (p: string) => p === liveHomebrew || p === staleNvm;
    expect(firstExisting([...fixed, ...vm], exists)).toBe(liveHomebrew);
  });
});

describe("buildPathEnv", () => {
  it("puts the bin dir and install dirs first, then the npm global bin, the login-shell PATH, then the app PATH, deduped", () => {
    const env = buildPathEnv("/home/u/.local/bin/claude", HOME, {
      npmPrefix: "/home/u/.hermes/node",
      loginShellPath: "/home/u/.nvm/versions/node/v24.0.0/bin:/usr/local/bin:/usr/bin",
      appPath: "/usr/bin:/bin",
    });
    expect(env.split(":")).toEqual([
      "/home/u/.local/bin",
      "/home/u/.local/node/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/home/u/.hermes/node/bin",
      "/home/u/.nvm/versions/node/v24.0.0/bin",
      "/usr/bin",
      "/bin",
    ]);
  });

  it("works when neither npm nor the login shell answered", () => {
    expect(buildPathEnv("claude", HOME, { npmPrefix: null, loginShellPath: "", appPath: "/usr/bin" })).toBe(
      "/home/u/.local/bin:/home/u/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin"
    );
  });
});
