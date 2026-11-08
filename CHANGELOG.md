# Changelog

## [Unreleased]

### Changed

- **Breaking:** AI chat titles, automatic memory, turn suggestions, playbook distillation and agent-folder seeding now run on your **default provider** rather than always on Claude.
  - Claude users: nothing changes (titles still use Haiku, background passes the *Background AI model*).
  - Codex users: these now run on your default Codex model and count against your Codex plan.
  - If you want them on Claude, set the default provider to Claude in Settings → General.
- The Obsidian tools bridge script in the plugin folder is now `exo-mcp-bridge.mjs`. The old `codex-bridge.mjs` is deleted on first use.
- Settings → General shows one block of rows per provider (default model, binary path, custom models).

### Added

- **opencode as a third provider, including local models.**
  - Each chat runs its own `opencode acp` process (opencode 2.0 or newer).
  - Models come from your opencode config: Ollama, LM Studio and vLLM servers it finds on your machine, any OpenAI-compatible endpoint in `opencode.json`, or a cloud provider.
  - A *Refresh models* button in Settings lists what opencode can run.
- opencode asks before every tool call, through Exo's usual permission cards. Exo also turns off opencode's git snapshots of the vault, its formatters and its language servers. Your `opencode.json` and opencode's background service aren't changed.
- opencode reaches the Obsidian vault tools over HTTP, so it doesn't need `node` on your `PATH`.

### Fixed

- A chat whose provider isn't Claude or Codex no longer reopens as a Claude chat.
- A Claude session no longer wipes Codex's live model list from the model picker.
