import { App, DropdownComponent, PluginSettingTab, Setting } from "obsidian";
import type ExoPlugin from "./main";
import type { PermissionMode, ProviderId } from "./providers/types";
import { ADAPTERS } from "./providers/registry";
import { providerModels, BACKGROUND_MODEL_OPTIONS } from "./core/model-options";
import { parseMcpJson } from "./core/mcp-config";
import { DEFAULT_MEMORY_ROOT, LEGACY_MEMORY_ROOT } from "./core/paths";
import { renderCliDiagnostics } from "./ui/settings-cli";
import { renderComposerModels } from "./ui/settings-composer-models";

import { DEFAULT_SETTINGS, LEGACY_QUEUE_FOLDER, defaultModel, type MVASettings } from "./settings-schema";

export { DEFAULT_SETTINGS, type MVASettings };

export class MVASettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ExoPlugin) {
    super(app, plugin);
  }

  /** Remembered active tab across re-renders (not persisted to disk). */
  private activeTab = "General";

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Obsidian has no native settings tabs, so build a segmented bar of <button>s
    // (keyboard-operable for free) over one body container per tab; clicking a tab
    // shows its body and hides the rest. All settings live under exactly one tab.
    const tabNames = ["General", "Chat", "Agent & Permissions", "Memory", "Advanced"];
    const bar = containerEl.createDiv({ cls: "mva-settings-tabs" });
    const bodies = new Map<string, HTMLElement>();
    const btns = new Map<string, HTMLElement>();

    const select = (name: string) => {
      this.activeTab = name;
      for (const [n, b] of btns) b.toggleClass("is-active", n === name);
      for (const [n, el] of bodies) el.toggleClass("is-hidden", n !== name);
    };

    for (const name of tabNames) {
      const btn = bar.createEl("button", { cls: "mva-settings-tab", text: name });
      btn.onclick = () => select(name);
      btns.set(name, btn);
      bodies.set(name, containerEl.createDiv({ cls: "mva-settings-body" }));
    }

    this.renderGeneralTab(bodies.get("General")!);
    this.renderChatTab(bodies.get("Chat")!);
    this.renderAgentTab(bodies.get("Agent & Permissions")!);
    this.renderMemoryTab(bodies.get("Memory")!);
    this.renderAdvancedTab(bodies.get("Advanced")!);

    if (!bodies.has(this.activeTab)) this.activeTab = "General";
    select(this.activeTab);
  }

  /** A boolean toggle row — the repeated shape across the tabs. */
  private toggleSetting(
    el: HTMLElement,
    name: string,
    desc: string,
    key: keyof MVASettings,
    /** Run after the flag is saved — for flags that need to take effect now
     *  rather than at the next plugin load. */
    onAfter?: (value: boolean) => void | Promise<void>
  ): void {
    new Setting(el)
      .setName(name)
      .setDesc(desc)
      .addToggle((t) =>
        t.setValue(this.plugin.settings[key] as boolean).onChange(async (v) => {
          (this.plugin.settings[key] as boolean) = v;
          await this.plugin.saveSettings();
          await onAfter?.(v);
        })
      );
  }

  /* ------------------------------- General ------------------------------ */

  private renderGeneralTab(el: HTMLElement): void {
    const s = this.plugin.settings;

    new Setting(el)
      .setName("Default provider")
      .setDesc("The CLI backend every new conversation starts with.")
      .addDropdown((d) =>
        d
          .addOption("claude", "Claude")
          .addOption("codex", "Codex")
          .setValue(s.provider)
          .onChange(async (v) => {
            s.provider = v as ProviderId;
            await this.plugin.saveSettings();
          })
      );

    // The model each new chat starts with, per provider. Options = the provider's
    // built-ins + the custom ids from the textareas below; editing those textareas
    // repopulates these dropdowns live via fill().
    let claudeDd: DropdownComponent | undefined;
    let codexDd: DropdownComponent | undefined;
    let refreshComposerModels = () => {};
    const fill = (d: DropdownComponent, provider: ProviderId) => {
      d.selectEl.empty();
      const cur = defaultModel(s, provider);
      const opts = providerModels(
        ADAPTERS[provider].models(),
        provider === "codex" ? this.plugin.lastSessionCaps?.models : undefined,
        provider === "claude" ? s.claudeCustomModels : s.codexCustomModels
      );
      for (const o of opts) d.addOption(o.id, o.label);
      // Keep the current selection valid even if it isn't in the option list.
      if (cur && !opts.some((o) => o.id === cur)) d.addOption(cur, cur);
      d.setValue(cur);
    };

    new Setting(el)
      .setName("Default Claude model")
      .setDesc("Which Claude model new conversations start with — includes any custom Claude models set below.")
      .addDropdown((d) => {
        claudeDd = d;
        fill(d, "claude");
        d.onChange(async (v) => {
          s.claudeModel = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(el)
      .setName("Default Codex model")
      .setDesc("Which Codex model new conversations start with — includes any custom Codex models set below.")
      .addDropdown((d) => {
        codexDd = d;
        fill(d, "codex");
        d.onChange(async (v) => {
          s.codexModel = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(el)
      .setName("Claude binary path")
      .setDesc("Path to the `claude` CLI. Leave empty to auto-detect; run `which claude` (`where claude` on Windows) if detection fails.")
      .addText((t) =>
        t
          .setPlaceholder("auto-detect")
          .setValue(s.claudeBin)
          .onChange(async (v) => {
            s.claudeBin = v.trim();
            await this.plugin.saveSettings();
          })
      );
    renderCliDiagnostics(this.plugin, el, "claude", s.claudeBin);

    new Setting(el)
      .setName("Codex binary path")
      .setDesc("Path to the `codex` CLI. Leave empty to auto-detect; run `which codex` (`where codex` on Windows) if detection fails.")
      .addText((t) =>
        t
          .setPlaceholder("auto-detect")
          .setValue(s.codexBin)
          .onChange(async (v) => {
            s.codexBin = v.trim();
            await this.plugin.saveSettings();
          })
      );
    renderCliDiagnostics(this.plugin, el, "codex", s.codexBin);

    new Setting(el)
      .setName("Custom Claude models")
      .setDesc("Extra Claude model ids (comma- or newline-separated) added to the model picker and the default-model dropdown above.")
      .addTextArea((t) =>
        t
          .setPlaceholder("claude-opus-4-6\nclaude-sonnet-4-6")
          .setValue(s.claudeCustomModels)
          .onChange(async (v) => {
            s.claudeCustomModels = v;
            await this.plugin.saveSettings();
            if (claudeDd) fill(claudeDd, "claude");
            refreshComposerModels();
          })
      );

    new Setting(el)
      .setName("Custom Codex models")
      .setDesc("Extra Codex model ids (comma- or newline-separated) added to the model picker and the default-model dropdown above.")
      .addTextArea((t) =>
        t
          .setPlaceholder("gpt-5.6-terra\ngpt-5.4-mini")
          .setValue(s.codexCustomModels)
          .onChange(async (v) => {
            s.codexCustomModels = v;
            await this.plugin.saveSettings();
            if (codexDd) fill(codexDd, "codex");
            refreshComposerModels();
          })
      );

    refreshComposerModels = renderComposerModels(this.plugin, el);
  }

  /* -------------------------------- Chat -------------------------------- */

  private renderChatTab(el: HTMLElement): void {
    const s = this.plugin.settings;

    new Setting(el)
      .setName("Sending during a running turn")
      .setDesc(
        "Queue = your message waits and starts as the next turn. Steer = inject it into the running Claude or Codex turn so the agent can change course mid-flight."
      )
      .addDropdown((d) =>
        d
          .addOption("queue", "Queue (wait for the next turn)")
          .addOption("steer", "Steer (inject into the running turn)")
          .setValue(s.steerMode)
          .onChange(async (v) => {
            s.steerMode = v as "queue" | "steer";
            await this.plugin.saveSettings();
          })
      );

    this.toggleSetting(
      el,
      "Generate chat titles with AI (Haiku)",
      "After the first reply, rename the tab to a concise 3-6 word summary using Claude Haiku; off keeps the truncated first message.",
      "aiTitles"
    );
    this.toggleSetting(
      el,
      "In-note AI toolbar",
      "Select text in a note to get a floating toolbar: markdown formatting, rewrite with an inline diff (Edit), continue writing, or open the chat with it as context (Ask Exo).",
      "inlineAi"
    );
    this.toggleSetting(
      el,
      "Show selection in composer",
      "When you select text in a note, show it as a chip in the chat composer — click it to add the excerpt as context.",
      "showSelectionChip"
    );
    this.toggleSetting(
      el,
      "Inline note content as context",
      "Send the full text of attached notes (the current document + manual attachments) with each message, instead of just their paths. The model reads them directly rather than deciding whether to open them — stronger context, larger prompts.",
      "injectContextContent"
    );
    this.toggleSetting(
      el,
      "Debug context (console)",
      "Log the assembled active context before each turn to the developer console ([Exo][ctx]) — the chips you see vs. the text actually sent to the model. Use to diagnose missing selection/page context; leave off normally.",
      "debugContext"
    );
    new Setting(el)
      .setName("Connections")
      .setDesc(
        "Surfaces the other notes you mention in a note's text but haven't linked yet — the graph work Obsidian's native pane leaves to you — and lets you wire them with one click, right where you're reading."
      )
      .setHeading();
    this.toggleSetting(
      el,
      "Underline unlinked mentions",
      "As you read a note, dot-underline the names of your other notes that appear in its text but aren't linked yet. Click an underlined name to turn it into a [[wikilink]] — or dismiss it for good if it's just a coincidence (dismissals are remembered).",
      "connectionsInlineUnderline"
    );
    this.toggleSetting(
      el,
      "Broaden mention matching",
      "Also match plurals and simple word inflections in Italian and English — e.g. 'prodotti' matches a note titled 'Prodotto'. Finds more mentions, with a small risk of the odd false match; turn off if you see noise.",
      "connectionsStemming"
    );
    this.toggleSetting(
      el,
      "Surface related notes",
      "Show notes related to the active note in the empty state, before you send anything.",
      "featureSurfacing"
    );
    this.toggleSetting(
      el,
      "Wikilink-ify replies",
      "Turn mentions of existing note titles in replies into clickable [[wikilinks]].",
      "featureWikilinkify"
    );
    this.toggleSetting(
      el,
      "Reveal edited notes",
      "When the agent edits or creates a note, open it in a tab beside the chat so you watch it change live. Off by default — what the agent does is already visible in the chat itself; turn this on only if you want writes to also jump into your workspace.",
      "revealEditedNotes"
    );
    this.toggleSetting(
      el,
      "System notifications",
      "Send an OS notification when a turn finishes, a card needs an answer, or an error occurs — only while Obsidian is in the background.",
      "systemNotifications"
    );

    new Setting(el)
      .setName("Custom prompts")
      .setDesc(
        'Reusable prompts for the "/" menu, one per line as "Name | prompt text". Use {{variables}} for fill-in values and " >>> " to chain steps into a multi-step workflow.'
      )
      .addTextArea((t) => {
        t.setPlaceholder("Summarize | Summarize the current note in 5 bullets")
          .setValue(s.customPrompts.map((p) => `${p.name} | ${p.prompt}`).join("\n"))
          .onChange(async (v) => {
            s.customPrompts = v
              .split("\n")
              .map((line) => {
                const i = line.indexOf("|");
                if (i < 0) return null;
                const name = line.slice(0, i).trim();
                const prompt = line.slice(i + 1).trim();
                return name && prompt ? { name, prompt } : null;
              })
              .filter((x): x is { name: string; prompt: string } => x !== null);
            await this.plugin.saveSettings();
          });
        t.inputEl.rows = 5;
      });

    new Setting(el)
      .setName("System prompt")
      .setDesc("Optional persona/instructions prepended to every conversation. Leave empty to use the CLI's default.")
      .addTextArea((t) =>
        t
          .setPlaceholder("(use the CLI's default)")
          .setValue(s.systemPrompt)
          .onChange(async (v) => {
            s.systemPrompt = v;
            await this.plugin.saveSettings();
          })
      );
  }

  /* ------------------------- Agent & Permissions ------------------------ */

  private renderAgentTab(el: HTMLElement): void {
    const s = this.plugin.settings;

    this.toggleSetting(
      el,
      "Enable tools (agentic mode)",
      "Let the agent read, write, and edit files and run commands in your vault. Every sensitive action is still gated by the permission cards.",
      "toolsEnabled"
    );

    new Setting(el)
      .setName("Permission mode")
      .setDesc(
        "How tool use is approved. Ask prompts for each sensitive action; Accept edits auto-approves file edits; Plan only forbids changes; Bypass skips every prompt (dangerous)."
      )
      .addDropdown((d) =>
        d
          .addOption("default", "Ask (default)")
          .addOption("acceptEdits", "Accept edits")
          .addOption("plan", "Plan only")
          .addOption("bypassPermissions", "Bypass (dangerous)")
          .setValue(s.permissionMode)
          .onChange(async (v) => {
            s.permissionMode = v as PermissionMode;
            await this.plugin.saveSettings();
          })
      );

    this.toggleSetting(
      el,
      "Auto-allow read-only tools",
      "Skip the permission prompt for side-effect-free tools (Read, Glob, Grep, LS).",
      "autoAllowRead"
    );
    this.toggleSetting(
      el,
      "Remember 'Always allow' across sessions",
      "When you pick 'Always allow' on a permission card, also save it as an allow rule below so it survives a reload.",
      "rememberAlwaysAllow"
    );

    const rulesDesc =
      "One per line: ToolName or ToolName(argument). Deny wins, and both apply before the permission card. " +
      "Bash arguments match command-token boundaries; file paths match exactly unless they end in * (explicit prefix match). " +
      "A tool name can end in * to cover a whole MCP source — mcp__notion__* governs every tool that server exposes, including ones it adds later. A bare * is ignored.";
    new Setting(el)
      .setName("Always-allow rules")
      .setDesc(rulesDesc)
      .addTextArea((t) => {
        t.setPlaceholder("Bash(git status)\nread_note")
          .setValue(s.permAllowRules)
          .onChange(async (v) => {
            s.permAllowRules = v;
            await this.plugin.saveSettings();
          });
        t.inputEl.rows = 4;
        t.inputEl.addClass("mva-mono-input");
      });

    new Setting(el)
      .setName("Deny rules")
      .setDesc(rulesDesc)
      .addTextArea((t) => {
        t.setPlaceholder("Bash(rm)\nWrite")
          .setValue(s.permDenyRules)
          .onChange(async (v) => {
            s.permDenyRules = v;
            await this.plugin.saveSettings();
          });
        t.inputEl.rows = 4;
        t.inputEl.addClass("mva-mono-input");
      });

    this.toggleSetting(
      el,
      "Run Claude Code hooks",
      "Execute hooks in .claude/settings.json (vault + global) — PreToolUse guards, formatters, notifications — matching Claude Code. Hooks run at session start and on every tool call, so heavy or network-bound ones slow turns down; turn off if Exo feels sluggish.",
      "runHooks"
    );

    new Setting(el)
      .setName("Codex sandbox")
      .setDesc("Filesystem access granted to Codex when tools are enabled.")
      .addDropdown((d) =>
        d
          .addOptions({
            "read-only": "Read-only",
            "workspace-write": "Workspace write",
            "danger-full-access": "Full access (danger)",
          })
          .setValue(s.codexSandbox)
          .onChange(async (v) => {
            s.codexSandbox = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(el)
      .setName("Codex approval policy")
      .setDesc("When Codex pauses to ask before running a command.")
      .addDropdown((d) =>
        d
          .addOptions({
            untrusted: "Untrusted (ask often)",
            "on-request": "On request",
            granular: "Granular",
            never: "Never",
          })
          .setValue(s.codexApproval)
          .onChange(async (v) => {
            s.codexApproval = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(el).setName("Safety net").setHeading();

    this.toggleSetting(
      el,
      "Auto-commit vault changes to git",
      "Silently commits only the paths Exo wrote, so its mutations are recoverable without staging your manual or other-agent changes. No-op when the vault isn't a git repo or git isn't available; never blocks a chat turn.",
      "vaultAutoCommit"
    );

    new Setting(el)
      .setName("Auto-commit fallback interval")
      .setDesc(
        "Minutes between safety-net retries for paths Exo has tracked, independent of the debounce after a write."
      )
      .addText((t) =>
        t
          .setPlaceholder("15")
          .setValue(String(s.vaultAutoCommitIntervalMinutes))
          .onChange(async (v) => {
            const n = Number.parseInt(v, 10);
            if (Number.isFinite(n) && n > 0) s.vaultAutoCommitIntervalMinutes = n;
            await this.plugin.saveSettings();
          })
      );
  }

  /* ------------------------------- Memory ------------------------------- */

  private renderMemoryTab(el: HTMLElement): void {
    const s = this.plugin.settings;
    const paths = this.plugin.paths;

    this.toggleSetting(
      el,
      "Read vault memory",
      `Boot each conversation with context from ${paths.root}/ (vault-context, preferences, rules, open loops).`,
      "memoryReadEnabled"
    );
    this.toggleSetting(
      el,
      "Write vault memory",
      `Let the agent record decisions and open loops into ${paths.root}/, and let automatic memory write into your notes.`,
      "memoryWriteEnabled"
    );
    this.toggleSetting(
      el,
      "Automatic memory",
      `After a chat goes idle (or you switch away), Exo reads it and adds or updates one-line facts in your existing notes, following the memory rules in AGENTS.md when your vault has them; anything without an obvious home lands in ${paths.inbox}/. Before each message it recalls related notes and past chats. Every harvest is one git commit (or a snapshot without git) you can undo with "Undo last memory write". Uses the background AI budget below.`,
      "autoMemory"
    );
    this.toggleSetting(
      el,
      "The agent is the folder (identity)",
      `Hydrate every conversation from ${paths.agentDir}/: three human-readable shared-kernel blocks (SOUL = principles, USER = working model of you, NOW = current focus) used by Exo and external agents. Adds the rethink_memory tool (NOW rewrites directly, USER requires a rationale, SOUL is propose-only). Off by default; with it off, boot is unchanged and the folder is never read. Rollout: run "Exo: Seed agent folder", review USER.md, then flip this on.`,
      "agentFolderEnabled"
    );

    new Setting(el).setName("Background AI").setHeading();

    this.toggleSetting(
      el,
      "Suggestion inbox",
      "Keep typed suggestions inert until you explicitly accept or dismiss them. Turning this off hides the inbox and stops all proposal routing without deleting retained suggestions.",
      "proposalKernelEnabled"
    );

    if (s.proposalKernelEnabled) {
      this.toggleSetting(
        el,
        "Suggestions after healthy turns",
        "After a completed turn, run a quiet background pass that can add up to three concrete suggestions. Off by default; suggestions never change the vault or settings before Accept.",
        "proposalTurnSuggestions"
      );
    }

    this.toggleSetting(
      el,
      "Enable background AI passes",
      "Master switch for every background LLM pass (automatic memory, suggestions, playbook distillation). Turn off to silence all of them at once regardless of their individual toggles.",
      "backgroundPassesEnabled"
    );

    new Setting(el)
      .setName("Background daily token budget")
      .setDesc(
        "Shared daily cap (UTC) across all background passes. When exhausted, background passes skip silently until the next day. Set 0 for unlimited."
      )
      .addText((t) =>
        t
          .setPlaceholder("200000")
          .setValue(String(s.backgroundDailyTokenBudget))
          .onChange(async (v) => {
            const n = Number.parseInt(v, 10);
            if (Number.isFinite(n) && n >= 0) s.backgroundDailyTokenBudget = n;
            await this.plugin.saveSettings();
          })
      );

    new Setting(el)
      .setName("Background AI model")
      .setDesc(
        "Model used by background LLM passes (automatic memory and the other background passes). Floor is Sonnet: Haiku is never offered here."
      )
      .addDropdown((d) => {
        for (const o of BACKGROUND_MODEL_OPTIONS) d.addOption(o.id, o.label);
        // Keep an out-of-list saved value (custom id, or a retired option) selectable
        // rather than silently snapping to the first option.
        if (!BACKGROUND_MODEL_OPTIONS.some((o) => o.id === s.backgroundModel)) {
          d.addOption(s.backgroundModel, s.backgroundModel);
        }
        d.setValue(s.backgroundModel);
        d.onChange(async (v) => {
          s.backgroundModel = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(el)
      .setName("Automations")
      .setDesc(
        `Run playbooks unattended on a schedule (hourly / daily / weekly at a set time). Read-only runs produce a report in ${this.plugin.paths.reports}/; write-enabled runs may also edit vault notes, with every touched file snapshotted so the whole run can be restored. Prompts with {{variables}} can't be scheduled.`
      )
      .addButton((b) => {
        b.setButtonText(`Manage… (${s.automations.length})`).onClick(() => {
          void this.plugin.activateHub("automations");
        });
      });

    new Setting(el)
      .setName("External tools in playbooks")
      .setDesc(
        "Let playbook runs read your connected external tools via MCP (Gmail, Slack, Calendar, Readwise…) — how the Morning Digest pulls from other apps. Strictly read-only: read tools are auto-allowed, anything that mutates is auto-denied. Slower session start when on."
      )
      .addToggle((t) =>
        t.setValue(s.playbookExternalTools).onChange(async (v) => {
          s.playbookExternalTools = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(el)
      .setName("Learning loop")
      .setDesc(
        "Offer to save a flow as a reusable playbook when the same kind of task recurs — not after a single turn. Exo fingerprints your requests by topic and nudges only once a topic comes back (see threshold below). The offer is free; the distillation runs only if you accept."
      )
      .addToggle((t) =>
        t.setValue(s.learningLoop).onChange(async (v) => {
          s.learningLoop = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(el)
      .setName("Playbook after N repetitions")
      .setDesc(
        "How many times the same kind of task must recur before Exo proposes saving it as a playbook. 3 = rule of three. Lower = proposes sooner; higher = only well-worn habits."
      )
      .addText((t) =>
        t
          .setPlaceholder("3")
          .setValue(String(s.playbookThreshold))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            s.playbookThreshold = Number.isFinite(n) && n >= 2 ? n : 3;
            await this.plugin.saveSettings();
          })
      );

    new Setting(el)
      .setName("Open Cockpit on startup")
      .setDesc("Open the Exo Cockpit view automatically when Obsidian starts.")
      .addToggle((t) =>
        t.setValue(s.cockpitOnStartup).onChange(async (v) => {
          s.cockpitOnStartup = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(el)
      .setName("Exo Queue — Exo in tasca")
      .setDesc(
        "Il desktop evade le note-richiesta scritte (dal telefono, via Obsidian Sync) nella cartella coda: esegue il corpo della nota headless e READ-ONLY e appende la risposta nella stessa nota, che sincronizza indietro. Poll ogni 60s."
      )
      .addToggle((t) =>
        t.setValue(s.exoQueueEnabled).onChange(async (v) => {
          s.exoQueueEnabled = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(el)
      .setName("Memory folder")
      .setDesc(
        "Where Exo stores its memory (vault-relative). Auto-detected on first launch: " +
          `a vault with ${LEGACY_MEMORY_ROOT}/ keeps it, a fresh one uses ${DEFAULT_MEMORY_ROOT}/. Change it to point Exo ` +
          "at a different folder — existing files are NOT moved; clear the field to " +
          "return to auto-detection on the next launch."
      )
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_MEMORY_ROOT)
          .setValue(s.memoryRoot)
          .onChange(async (v) => {
            s.memoryRoot = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(el)
      .setName("Queue folder")
      .setDesc("Vault-relative path for request notes.")
      .addText((t) =>
        t
          .setPlaceholder(LEGACY_QUEUE_FOLDER)
          .setValue(s.exoQueueFolder)
          .onChange(async (v) => {
            s.exoQueueFolder = v.trim() || LEGACY_QUEUE_FOLDER;
            await this.plugin.saveSettings();
          })
      );
  }

  /* ------------------------------ Advanced ------------------------------ */

  private renderAdvancedTab(el: HTMLElement): void {
    this.toggleSetting(
      el,
      "Fast startup",
      "Skip external MCP servers at session start for snappier first responses. Turn off to load the MCP servers configured below.",
      "fastStartup"
    );
    this.toggleSetting(
      el,
      "Pre-warm the agent session",
      "Start the CLI session in the background the moment Exo opens, so your first message skips the cold start.",
      "prewarmSession"
    );
    this.toggleSetting(
      el,
      "Auto-compact (token saver)",
      "Summarize and compact the conversation automatically when the context window fills, so long chats don't re-bill the whole history each turn.",
      "autoCompactEnabled"
    );
    this.toggleSetting(
      el,
      "Context-saving mode",
      "Load Obsidian-native tool definitions on demand instead of always in context — saves tokens every turn, at the cost of an occasional extra discovery step. Claude only.",
      "contextSavingMode"
    );
    this.toggleSetting(
      el,
      "Obsidian tools",
      "Give the agent native vault tools (search, read, backlinks, neighborhood, create/edit notes, frontmatter) alongside the standard ones.",
      "obsidianToolsEnabled"
    );
    this.toggleSetting(
      el,
      "Native-first",
      "Disable the built-in file tools (Read/Grep/Glob/LS/Edit/Write) so vault work goes only through the Obsidian-native tools. Bash stays available (gated). Claude only.",
      "nativeFirst"
    );

    new Setting(el).setName("Agents").setHeading();
    this.toggleSetting(
      el,
      "Enable named agents",
      "Turns on the agent registry: `@agent` in the composer binds a turn to a specific agent, `/as <agent>` binds the whole conversation, and agents with a schedule trigger can run unattended. Vault agents come from human-readable `_system/agents/<slug>/` bundles; CLI files are runtime adapters. Each agent remains separately disabled until you turn it on.",
      "agentsEnabled",
      // Warm the registry the moment the flag flips. Without this the store
      // stays unloaded until some other consumer happens to ask for it, so
      // turning agents on and immediately creating a note in a watched folder
      // did nothing at all — the trigger driver sees an empty agent list and
      // drops the event before it even schedules.
      async (on) => {
        this.plugin.invalidateAgents();
        if (on) await this.plugin.agentsReady();
        await this.plugin.refreshAgentsUI();
      }
    );

    new Setting(el).setName("Orchestration Board").setHeading();
    this.toggleSetting(
      el,
      "Enable orchestration",
      "Turns on the Orchestration Board: the `add_task` chat tool, the \"Promote to task\" command, and the board itself, so work can be queued up and run as separate conversations instead of inline in this chat. Off by default. Turning it OFF never touches conversations already running — they keep going as normal chats; it only stops new tasks from being queued or started.",
      "orchestrationEnabled"
    );

    new Setting(el)
      .setName("Max concurrent tasks")
      .setDesc("How many Orchestration Board tasks the driver runs at the same time. Extra queued tasks wait their turn.")
      .addText((t) => {
        const s = this.plugin.settings;
        t.setPlaceholder("2")
          .setValue(String(s.orchestrationMaxConcurrent))
          .onChange(async (v) => {
            const n = Number.parseInt(v, 10);
            if (Number.isFinite(n) && n > 0) s.orchestrationMaxConcurrent = n;
            await this.plugin.saveSettings();
          });
      });

    new Setting(el).setName("Agent browser").setHeading();
    this.toggleSetting(
      el,
      "Enable agent browser",
      "Gives the agent a real, visible browser tab inside Obsidian (desktop only): it can open a page in front of you, read it, click, type, scroll and screenshot it, a tab you both share, instead of a blind web fetch. Off by default. Opening, navigating and interacting always ask through the standard permission card; only looking (snapshot, read, screenshot) rides the auto-allowed read tools.",
      "browserEnabled"
    );

    new Setting(el)
      .setName("Conversation history budget (MB)")
      .setDesc(
        "Soft ceiling for the conversation store. Going over it proposes a cleanup in the history — nothing is ever deleted automatically."
      )
      .addText((t) => {
        const s = this.plugin.settings;
        t.setPlaceholder("50")
          .setValue(String(s.retentionBudgetMb))
          .onChange(async (v) => {
            const n = Number.parseInt(v, 10);
            if (Number.isFinite(n) && n > 0) s.retentionBudgetMb = n;
            await this.plugin.saveSettings();
          });
      });

    new Setting(el)
      .setName("Tab strip size")
      .setDesc(
        "How many unpinned chats stay in the strip. Opening one more retires the least recently used — it stays in the history, nothing is deleted."
      )
      .addText((t) => {
        const s = this.plugin.settings;
        t.setPlaceholder("6")
          .setValue(String(s.stripMaxTabs))
          .onChange(async (v) => {
            const n = Number.parseInt(v, 10);
            if (Number.isFinite(n) && n > 0) s.stripMaxTabs = n;
            await this.plugin.saveSettings();
          });
      });

    new Setting(el).setName("Exo Collabo service")
      .setDesc("Base URL of your Exo Collabo deployment. Empty turns sharing off entirely.")
      .addText((t) => t.setPlaceholder("https://exo-collabo.up.railway.app").setValue(this.plugin.settings.collaboUrl)
        .onChange(async (v) => {
          this.plugin.settings.collaboUrl = v.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(el).setName("Exo Collabo API key")
      .setDesc("Authenticates document creation on that service. Per-document calls use the document's own token.")
      .addText((t) => t.setPlaceholder("hex secret").setValue(this.plugin.settings.collaboApiKey)
        .onChange(async (v) => {
          this.plugin.settings.collaboApiKey = v.trim();
          await this.plugin.saveSettings();
        }));
    void this.renderMcpSection(el);
  }

  /** MCP now has a dedicated control surface — the Connections pane — where you
   *  add / edit / enable / disable / remove servers, reconnect failed ones, and
   *  re-authenticate OAuth ones live. Settings keeps only the fast-startup gate
   *  (which silences external MCP entirely), a link to the pane, and the raw
   *  `.mcp.json` escape hatch for exotic configs or fixing an unparseable file. */
  private async renderMcpSection(containerEl: HTMLElement): Promise<void> {
    new Setting(containerEl).setName("MCP servers").setHeading();
    const root = containerEl.createDiv();
    await this.drawMcpManager(root);
  }

  private async drawMcpManager(root: HTMLElement): Promise<void> {
    root.empty();
    const redraw = () => void this.drawMcpManager(root);
    const adapter = this.plugin.app.vault.adapter;
    const path = ".mcp.json";
    const s = this.plugin.settings;

    // Primary path: manage MCP in the Connections pane.
    new Setting(root)
      .setName("Manage MCP servers in Connections")
      .setDesc("Add, edit, enable/disable, remove, reconnect, and re-authenticate servers live — plus one-tap import of what other tools already have.")
      .addButton((b) =>
        b
          .setButtonText("Open Connections")
          .setCta()
          .onClick(() => void this.plugin.activateConnections())
      );

    // Fast-startup gate: external MCP is skipped entirely while it's on. Say it
    // loudly, with the fix one click away — the #1 "where are my MCPs?" confusion.
    if (s.fastStartup) {
      new Setting(root)
        .setName("External MCP is OFF — Fast startup is on")
        .setDesc("Fast startup spawns sessions with strict MCP (Obsidian-native tools only). Turn it off to load your servers.")
        .addButton((b) =>
          b.setButtonText("Turn off Fast startup").onClick(async () => {
            s.fastStartup = false;
            await this.plugin.saveSettings();
            redraw();
          })
        );
    }

    let raw = '{\n  "mcpServers": {}\n}';
    try {
      if (await adapter.exists(path)) raw = await adapter.read(path);
    } catch {
      /* missing — use template */
    }
    const parsed = parseMcpJson(raw);
    if (parsed.error) {
      new Setting(root)
        .setName("Couldn't parse .mcp.json")
        .setDesc(`${parsed.error} — fix it in the raw editor below.`);
    }

    // Raw escape hatch, collapsed: the Connections pane covers the common cases;
    // exotic configs (or a broken file) still have a direct path.
    const details = root.createEl("details");
    details.createEl("summary", { text: "Advanced: edit raw .mcp.json", cls: "setting-item-description" });
    const status = details.createDiv({ cls: "setting-item-description" });
    const area = new Setting(details).setName(".mcp.json").setDesc("Must be valid JSON with an mcpServers key.");
    area.addTextArea((t) => {
      t.setValue(raw);
      t.inputEl.rows = 10;
      t.inputEl.addClass("mva-mono-input", "mva-full-width");
      area.addButton((b) =>
        b
          .setButtonText("Save")
          .setCta()
          .onClick(async () => {
            const next = t.getValue();
            const check = parseMcpJson(next);
            if (check.error) {
              status.setText(check.error);
              status.addClass("mod-error");
              return;
            }
            await adapter.write(path, next);
            redraw();
          })
      );
    });

    root.createEl("p", {
      cls: "setting-item-description",
      text: "Changes made here apply to NEW sessions — use Connections to reconnect the current one.",
    });
  }

}
