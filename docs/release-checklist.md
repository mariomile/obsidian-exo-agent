# Release checklist

Run these before tagging a new version.

## Gates

```bash
pnpm lint      # eslint clean
pnpm lint:obsidian  # the Obsidian review bot's rule set (eslint-plugin-obsidianmd)
pnpm test      # vitest — all unit tests green (pure core/ logic)
pnpm smoke     # live contract test — see below
pnpm build     # contract ratchet (node) + tsc typecheck + esbuild production bundle
```

## `pnpm smoke` — what it is

A **release gate, not CI.** `scripts/smoke.mjs` runs a real, **billable** Claude
session against `@anthropic-ai/claude-agent-sdk` (the same version the plugin
bundles). It does not import plugin source. It verifies:

1. the `claude` binary resolves and `--version` succeeds;
2. a per-session `createSdkMcpServer` tool is actually registered — the init
   message must list it (guards the "MCP server binds to its first session"
   regression class, where custom tools silently vanish);
3. a minimal streaming-input turn completes with a non-error result.

Because it spends real tokens, it is intentionally **not** wired into `pnpm test`
or CI. Run it manually:

```bash
pnpm test && pnpm smoke
```

Override the binary with `CLAUDE_BIN=/path/to/claude pnpm smoke` if
auto-resolution misses it. Exit code `0` = pass, `1` = fail (with a clear
reason). Timeout is 120s.

## Version bump

`main` is protected (ruleset "Protect main"): no direct pushes, no force-push,
no deletion; every change lands through a PR with the `check` CI job green. So
the bump goes in its own PR (`chore(release): 0.x.y`); after it merges, push the
tag from the merged `main` (`git tag 0.x.y && git push origin 0.x.y`), which
triggers the Release workflow. Tags are not restricted.


Run the bump script — it updates `manifest.json`, `package.json`,
`package-lock.json` (both project version fields), and `versions.json` (adds
`"<version>": "<minAppVersion>"`, reusing the previous latest `minAppVersion`) in
lockstep:

```bash
pnpm bump 0.x.y
pnpm build   # refresh main.js
```

`minAppVersion` is `1.8.7` since 0.37.0 (`App.loadLocalStorage`); the script carries
the previous entry's value forward automatically.
