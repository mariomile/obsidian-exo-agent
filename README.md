<p align="center">
  <img src="assets/exo-logo.svg" width="96" height="96" alt="Exo logo" />
</p>

# Exo Agent

An agentic AI assistant in your Obsidian sidebar, powered by the **Claude CLI** or the **Codex CLI**. Your vault is the agent's working directory. Custom-rendered, theme-aware chat UI — no terminal.

## Screenshots

<p align="center">
  <img src="assets/screenshots/empty-state.png" width="900" alt="Exo in the sidebar next to a note: the new-chat empty state with suggestions, your prompts, and notes related to the open note" />
</p>
<p align="center"><em>Exo in the sidebar, next to the note you are working on: suggestions, your saved prompts, and notes related to the open one.</em></p>

<p align="center">
  <img src="assets/screenshots/chat.png" width="900" alt="A conversation in which Exo reads the open note and lists its overdue tasks" />
</p>
<p align="center"><em>Ask about the open note: Exo reads it and answers with the overdue tasks, linking the file it touched.</em></p>

<p align="center">
  <img src="assets/screenshots/model-picker.png" width="380" alt="The model picker in the composer, listing the Claude models" />
</p>
<p align="center"><em>Model, effort, and permission sit in the composer, one click away.</em></p>

<p align="center">
  <img src="assets/screenshots/capabilities.png" width="900" alt="The Capabilities hub overview: session, system, and Exo Queue" />
</p>
<p align="center"><em>The Capabilities hub: session state, skills, MCP servers, playbooks, automations, and memory in one place.</em></p>

## Features

- **Custom chat UI** — streaming markdown, message bubbles, theme-agnostic (built on Obsidian's native CSS variables; transparent panel that adapts to any theme).
- **Two backends, switchable** — Claude (via the Claude Agent SDK pointed at your installed CLI) and Codex (via a persistent `codex app-server` thread). Switch per conversation from the header.
- **Agentic** — the agent can Read / Write / Edit / Bash / Search with the vault as its working directory.
- **Permission gating** — tool calls surface as cards; sensitive actions can prompt with **Allow once / Always allow / Deny**. Claude uses Exo's tool gate; Codex combines its sandbox with app-server command/file approvals routed through the same UI.
- **Tool-call cards** — running / success / error, with diff preview for edits and command + output for shell.
- **Knowledge-work native** — answers stream with a live caret; assistant replies can be **inserted into the active note** or copied as markdown; tool cards link the **note they touched** (click to open it in the graph). The new-chat **empty state** centres the Exo mark with a soft breathing aura and gathers **Suggestions**, **Your prompts**, and related notes around it.
- **Unified composer** — one input box with the textarea and all controls inside. A single **`+`** opens a themed popover to attach a note, file, folder, or image; a **⚙ tune dialog** consolidates model, effort, and permission in one place, with an always-visible **permission dot** (green / amber / red) so the active mode is never a surprise. Typing while the agent streams **queues** the message by default (steer is a setting). The send button lives in the box. Colours follow the active theme — the provider brand colour only tints the identity mark.
- **Context panel** — in a wide full-page pane, a side panel summarizes the conversation: web sources searched, notes read, files created / edited, and skills used. It grows with its content and appears only when there's room (never in the sidebar).
- **Persistent sessions** — Claude conversations keep one warm SDK process across turns (streaming-input), so follow-ups skip cold start and context is retained. A footer shows live **context-window usage**.
- **Reasoning** — the model's thinking streams into a collapsible block.
- **Fast startup** — skips global hooks + MCP per turn for snappier responses (toggle in settings).
- **Resilient** — a clear setup card when the CLI isn't signed in; retry any turn.

### Obsidian-native (Claude; all toggleable in settings)

- **Native tools** — an in-process MCP server gives the agent graph- and metadata-aware tools alongside the standard ones: `search_vault`, `read_note`, `get_backlinks`, `get_neighborhood`, `list_notes`, `list_tags`, `get_active_context`, `create_note` (tag/frontmatter aware), `append_to_note`, `update_frontmatter`, `add_links`, `open_note`. `search_vault` uses the **Sonar** plugin's search index when it is installed and ready, and falls back to a built-in scorer otherwise.
- **Memory**: your vault is Exo's memory. Each conversation boots with context from the memory folder (vault-context, preferences, active rules, open loops); after a chat goes idle Exo writes what it learned into your own notes, and before each message it recalls related notes and past chats. See [Memory](#memory).
- **Touched-notes footer** — after each turn, a grouped footer shows what the agent **Edited** (with an ×N edit count, plus per-note hover **diff** and two-step **revert** on live turns) and what it **Read**. Replies are **wikilink-ified** by default (mentions of existing notes become clickable `[[links]]`); related notes surface in the empty state.
- **Named agents** *(off by default)* — your `.claude/agents/*.md` become callable teammates. `@agent` in the composer routes one turn to that subagent; `/as <agent>` binds the whole chat. Each agent gets a contract file in your memory root — triggers (schedule, a note landing in a folder, a tag appearing, an `@mention` inside a note), an autonomy tier (`notify` / `propose` / `act`), read and write globs, and an allowlist of agents it may hand work to. Unattended runs go through the same checkpointed headless profile as automations, so every write is restorable, and each one is recorded in an append-only monthly ledger. An **Agents** pane shows what will run without you asking. Turning the feature on never enables an individual agent: each stays off until you flip it. Works on both backends, but not identically: on **Claude**, binding delegates to a real isolated subagent that enforces the brain's declared tools; on **Codex**, which has no subagent primitive, binding instead hands the current turn the agent's own instructions directly — no isolation from the surrounding chat, and the brain's tool list is advisory only. See `docs/specs/2026-08-01-agents-design.md`.
- **Composer power-ups** — `/` opens a palette of custom prompts + your vault's `.claude/` commands and skills; `@` mentions a file or folder to add it as context. **Settings are organized into tabs** (General / Chat / Agent & Permissions / Memory / Advanced), including a **default model per provider** that every new chat starts with, and **AI-generated chat titles** (a quick Haiku pass names the tab after the first exchange).
- **Context as document cards** — the active note and anything you attach (via `@` or "+ Note") appear as uniform cards above the composer: images preview as thumbnails, notes show a text preview, other files show an icon — each with a title, a *Current Document* / *Document* label, click-to-open and remove.
- **History** — conversations **persist to disk** (survive reload, with session resume). The history button opens a **card gallery** with per-conversation previews (title, snippet, provider, message count, date); click a card to reopen it. Copy any reply.

## Mobile

**Unsupported** — `isDesktopOnly: true` in `manifest.json`; `src/cli.ts` imports Node's `child_process`, `os`, `fs`, and `path` to spawn the local `claude`/`codex` CLI, which isn't available on mobile.

## Requirements

- Desktop Obsidian (uses Node child processes — `isDesktopOnly`).
- The `claude` and/or `codex` CLI installed and logged in. Paths auto-detect; override in settings if needed.
- Optional: the [Sonar](https://github.com/mariomile/obsidian-sonar) plugin. If present, `search_vault` uses its index for better ranking.

## Privacy & Security

**Network use.** Exo sends no telemetry and never phones home to the plugin author. The model traffic comes from the **`claude`** and/or **`codex`** CLI you already have installed and signed in on your machine, which Exo spawns as a local child process (this is why the plugin is desktop-only; see `isDesktopOnly` in `manifest.json`): `claude` calls Anthropic's API, `codex` calls OpenAI's API, each with **your own CLI login / API key**, never a key or account belonging to Exo or its author. Exo itself makes exactly two kinds of request, both through Obsidian's `requestUrl`:
- **CLI update check**: at most once a day, a GET to `https://registry.npmjs.org/@anthropic-ai/claude-code/latest` to read the latest published version number. Nothing about you or your vault is sent.
- **Exo Collabo** (opt-in, off until you set a service URL and API key in settings): when you run the share/import commands or the agent uses the collabo tools, the note you chose is sent to the service URL *you* configured.

**What leaves your machine, and to whom.** When you send a message, the prompt text plus whatever context Exo attaches (the active note, `@`-mentioned files/folders, tool results, and — if you enable the Obsidian-native layer — your memory folder's content) is passed to the CLI process, which forwards it to Anthropic (Claude) or OpenAI (Codex) as part of your own authenticated session with them. That data goes only to the provider you're using, governed by your own account/agreement with them — **nothing is sent to, or visible to, the Exo author.**

**Your vault is the agent's working directory.** The CLI is launched with your vault as its working directory, so the agent can read, write, and edit files in your vault (and run shell commands) as directed by your prompts and its own reasoning.

**What gates what the agent can do:**
- **Claude backend** — Exo's permission system surfaces each tool call (Read/Write/Edit/Bash/etc.) as a card before it runs; sensitive actions (Edit, Write, unlisted Bash commands) require **Allow once / Always allow / Deny**, with a per-session allowlist and auto-allow limited to read-only tools. You control the permission mode (e.g. more/less restrictive) from the composer.
- **Codex backend** — persistent streaming turns, Stop/steer/native compact, sandbox controls, and per-action command/file approvals routed through Exo's permission UI.

**What the plugin touches outside the Obsidian API** (the capabilities Obsidian's automated review flags, and why each exists):
- **Shell execution (`child_process`)**: spawning the `claude` / `codex` CLIs is the whole plugin. It also runs `node --version` / `<cli> --version` to find the binaries, `npm install -g @anthropic-ai/claude-code` or `claude update` when you click *Update now*, `claude mcp login/logout` from the Connections pane, and `node chat-recall.mjs` for the optional semantic chat search.
- **Filesystem outside the vault (`fs`)**: reads the CLI install locations to resolve binaries; reads `~/.claude/` (skills, agents, MCP config, session transcripts) for the Skills/Connections panes and resume checks, and deletes a chat's CLI transcript there only when you free that chat; writes two helper scripts (`codex-bridge.mjs`, `chat-recall.mjs`) into the plugin's own folder.
- **Environment variables**: the spawned CLIs inherit your environment with an augmented `PATH` (GUI apps don't get your login shell's `PATH`), and `$SHELL` is used to locate them. Nothing is read to identify you or your machine, and nothing leaves it.
- **Vault enumeration**: `@`-mentions, the daily pulse, agent triggers and the agent's vault tools (search, backlinks, tags) list vault files. The list stays on your machine unless a prompt sends a file's content to your provider, as described above.
- **Clipboard**: *Copy* buttons write to it; *Import a document from Collabo* reads a pasted share link from it, only when you run that command.
- **Dynamic code (`new Function`)**: not Exo's code. It's a one-line feature probe (`new Function("")`) in the zod validator vendored inside the bundled Claude Agent SDK, which checks whether it may JIT-compile schemas.

In short: Exo is a thin, local UI over CLIs you already trust and are already signed into. Beyond the daily version check and the opt-in Collabo service it adds no network surface of its own, but it does give the agent read/write access to your vault, scoped by the permission/sandbox settings above.

## Install

**Via [BRAT](https://github.com/TfTHacker/obsidian42-brat)** (recommended for now):

1. Install the BRAT community plugin.
2. *Add beta plugin* → `mariomile/obsidian-exo-agent`.
3. Enable **Exo Agent** in Community Plugins, then open it from the ribbon or the command palette (*Exo Agent: Open chat*).

**Manual:** download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/mariomile/obsidian-exo-agent/releases/latest) into `<vault>/.obsidian/plugins/exo-agent/`, then enable it.

## Vault memory setup

Exo's Obsidian-native features (vault memory, the cockpit, open loops, the task board) read and write a fixed set of files under a **memory folder** in your vault — configurable, editable any time in Settings. A fresh vault gets a neutral `_exo/`; a vault that already has a `_system/` layer (an earlier Exo install, or a vault built around it) keeps that automatically, with nothing to migrate.

On a fresh vault, the first new chat offers a **one-time picker** for how much to set up:

- **Full memory** — the operational layer plus a guided knowledge-OS starter: vault-context, preferences, and hand-fillable identity blocks (`persona`/`human`/`now`) you can either fill in yourself or hand to **Exo Agent: Seed agent folder** to draft from what you've already written.
- **Just the essentials**: only what Exo's own features need (task board, open loops, reports), no imposed structure or content.
- **Not now** — creates nothing; Exo runs from your `CLAUDE.md`/`AGENTS.md` alone. Set it up later from Settings whenever you want.

Whichever you pick, it's remembered — you won't see the picker again. Run **Exo Agent: Set up vault memory** from the command palette any time to (re-)apply the full scaffold (idempotent — safe to re-run, fills in only what's missing; nothing that already exists is ever touched).

This only creates Exo's own memory-folder files — it doesn't require or impose any particular note-organization scheme (folders like `Active/`, `Atlas/`, etc. are entirely up to you).

## Memory

Exo has no memory store of its own. **Your vault is the memory**: everything Exo remembers is a line in a Markdown note you own, can read, edit and link. Automatic memory is on by default (Settings, Memory, *Automatic memory*).

**What Exo remembers.** When a chat has been idle for about ten minutes, or as soon as you switch away from it or close it, Exo reads the new messages and pulls out the facts worth keeping weeks from now: your preferences and how you work, facts about people, companies and projects, and lessons for the agent itself. Task chatter, one-off instructions and anything that looks like a password, token or key are never kept. If Obsidian was closed, the pending chats are caught up the next time it starts.

**Where it goes.** For each fact Exo searches your vault (with [Sonar](https://github.com/mariomile/obsidian-sonar) when installed), reads the note it would touch, and decides: add one line, update one line, or leave it. If your vault's `AGENTS.md` has a `## Memory` (or `## Memoria`) section, Exo follows the routing written there, so you decide which note holds what. It only ever:

- appends one bullet to an **existing** note (under the right section when there is one), or
- replaces **one existing line** with the new value, keeping the old one as a trace, e.g. `Head of design (since 2026-09-25; previously designer)`.

It only writes to notes it actually read for that fact, never creates notes (except a daily inbox, `<memory folder>/memory/inbox/YYYY-MM-DD.md`, for facts with no obvious home), and writes at most 8 lines per chat. It never touches frontmatter, headings, tables or code blocks; hidden folders (`.obsidian/`, `.archive/`), `Input/` or Readwise imports, or anything in Obsidian's *Excluded files* (paths and `/regex/` entries alike); any `AGENTS.md`/`CLAUDE.md`; or Exo's own files (agent kernel `SOUL`/`USER`/`NOW`, vault-context, rules, decisions, tasks, automations, agent contracts, reports, settled chats). An open loop becomes a proper new entry in the open-loops ledger.

**Before each message** Exo searches the vault and your chats from the last 60 days for what you're asking about, and quietly adds the top matches as background (a *Recalled N* row under your message shows exactly what). Short messages, slash commands, Exo's own reports, hidden folders and your excluded files are skipped. The agent can also read your recent conversations on demand with the `recent_chats` tool.

**Review and undo.** Each harvest shows a notice (*Exo remembered 2 things from "Pricing"*), and the Memory tab of the Capabilities hub lists recent memory writes line by line, each with an **Undo** button. In a git vault every harvest is one commit, `exo: memory harvest: <n> scritture (<chat title>)`, touching only those notes; undo is a `git revert` (`exo: memory revert: <sha>`), refused if you changed those notes since. A note that already had your own uncommitted edits is written but left out of the commit, so your edits never end up in Exo's commit. Without git (and for those uncommitted notes), undo removes exactly the lines Exo added and puts back the line it replaced; it refuses if one of those lines is no longer there. No copy of your notes is kept for this, and there is no size limit. You can also run **Exo Agent: Undo last memory write**, or just ask Exo to undo it.

**Cost.** Harvesting uses the background model and counts against the daily background budget (Settings, Memory, *Background AI*); when the budget runs out it waits for the next day. Turn off *Automatic memory* to stop both harvesting and per-message recall, or *Write vault memory* to stop every write.

## Develop

```bash
pnpm install
pnpm dev      # watch + auto-deploy (see .obsidian-plugin-dir)
pnpm build    # typecheck + production bundle
```

Create a `.obsidian-plugin-dir` file containing the absolute path to your vault's
`.obsidian/plugins/exo-agent` folder to auto-deploy on each build.

## Architecture

- `src/main.ts` — plugin entry (view registration, ribbon, command, settings).
- `src/view.ts` — the chat `ItemView` (header, message list, tool/permission cards, composer, history, context chips).
- `src/providers/` — `ProviderAdapter` interface + `claude.ts` (Agent SDK) and `codex.ts` (CLI) adapters, normalized into a single `AgentEvent` stream.
- `src/cli.ts` — robust CLI path resolution (Obsidian doesn't inherit the shell PATH).
- `src/ui/tools.ts` — tool metadata + detail/diff rendering.
- `src/ui/hub/` — the Capabilities hub: a view shell plus one renderer per tab (overview, skills, mcp, playbooks, automations, memory). Pure halves in `src/core/hub-sections.ts` and `src/core/capability-scan.ts`.
- `src/obsidian/capability-tools.ts` — the same hub, agent-callable: `list_capabilities`, `manage_mcp_server`, `manage_skill`. Per-source notes live at `.claude/mcp/<name>.md` (`src/core/mcp-docs.ts`).
- `src/core/agent*.ts` — named agents: registry and turn binding, run gates, event-trigger matching, run ledger and per-agent memory, seed contracts. Pure and unit-tested; the Obsidian halves are `src/obsidian/agent-store.ts`, `src/obsidian/agent-triggers.ts` and `src/ui/agents-view.ts`. See `docs/specs/2026-08-01-agents-design.md`.

## Status

Implemented: text + reasoning streaming, agentic tools with permission gating, persistent Claude and Codex sessions, Codex tool cards/Stop/steer/native compact, theme-aware transparent UI, context chips + multi-note attach, persistent conversation history, parallel conversations with a message queue + stop, `/` and `@` palettes, effort + permission selectors, the **Capabilities hub** (skills, MCP, playbooks, automations, memory in one pane), and the full Obsidian-native layer (graph tools, configurable-root memory read/write, graph UI). Codex reaches Obsidian-native tools through Exo's loopback MCP bridge.

## Try it

See it running in the [Obsidianverse sample vault](https://github.com/mariomile/obsidianverse-sample-vault), a small, fictional vault with the whole plugin suite pre-configured.

## License

MIT
