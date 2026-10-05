import {
  App,
  TFile,
  TFolder,
  FuzzySuggestModal,
  setIcon,
  setTooltip,
  Notice,
} from "obsidian";
import { filePath, partitionFiles, pickedFolderRoot } from "./file-paths";
import { Autocomplete, type AcItem } from "./autocomplete";
import { buildDescIndex, codexSkillNames, type DescIndex } from "../core/capability-desc";
import { mergeSlashEntries } from "../core/slash";
import type ExoPlugin from "../main";
import { setProviderMark } from "./provider-mark";
import type {
  ContextUsage,
  ImageAttachment,
  PermissionMode,
  ProviderId,
  RateLimitInfo,
  RateLimitWindow,
  SessionCaps,
} from "../providers/types";
import { basename as noteBasename } from "../obsidian/graph";
import { clickable } from "./dom";
import { openablePopover } from "./popover";
import { PromptVarsModal, extractVars, fillVars } from "./prompt-vars";
import type { Convo } from "./convo-types";
import {
  badgeState,
  formatClock,
  formatResetRelative,
  normalizeUtilization,
  normalizeResetEpochMs,
  windowLabel,
} from "../core/rate-limit";
import { buildOptionRows, type SelectOption } from "../core/option-filter";
import { queryWords, matchesWords } from "../core/ac-token";
import { selectionPreview } from "../core/selection-preview";
import { clampEffort, effortOptionsFor } from "../core/model-tuning";
import { activeNoteState, contextModel, type ContextModel } from "../core/active-note";
import { isNoteVisible } from "../obsidian/note-visibility";
import { fillThumb } from "./context-thumb";
import { statSync } from "node:fs";

/** Semantic risk modifier class for a toolbar selector option/chip ("" = neutral). */
type RiskLevel = "" | "is-caution" | "is-danger";

function arrayBufferToBase64(buf: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Abbreviate a token count with k/M suffixes: 68000 → "68k", 711300 → "711.3k". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${Number((n / 1000).toFixed(1))}k`;
  return String(n);
}

function extToMime(ext: string): string {
  const e = ext.toLowerCase();
  if (e === "jpg" || e === "jpeg") return "image/jpeg";
  if (e === "gif") return "image/gif";
  if (e === "webp") return "image/webp";
  return "image/png";
}

/**
 * What the composer needs from the view. Kept narrow: the send/stop turn
 * controls, workflow submission, the shared model/provider/permission state, and
 * a handful of view services (open a note, register cleanup). The composer owns
 * everything else (its own DOM, popovers, images, context row, selection chip).
 */
export interface ComposerHost {
  plugin: ExoPlugin;
  /** The scroll host the composer pins itself to the bottom of. */
  listWrap: HTMLElement;
  /** The active conversation. */
  active: Convo;
  /** Active conversation is streaming (drives the send/stop button). */
  streaming: boolean;
  /** Selected provider/model (writable — a model pick can flip provider+model). */
  provider: ProviderId;
  model: string;
  /** The mode a plan-mode entry came from, restored on plan approval. */
  prePlanMode: PermissionMode;
  /** Latest capability snapshot (skills/commands/agents) for the autocomplete menus. */
  sessionCaps: SessionCaps | null;
  register(cb: () => void): void;
  send(): void;
  stop(source?: "esc" | "button"): void;
  submitWorkflow(c: Convo, steps: string[]): void;
  compactActive(instructions?: string): void;
  handleGoalCommand(c: Convo, text: string): void;
  resumeGoalLoop(c: Convo): void;
  togglePlanMode(): void;
  toggleResearchMode(): void;
  /** Drop the active conversation's `/as` binding (the chip's click target). */
  clearBoundAgent(): void;
  onProviderChange(next: ProviderId, explicitModel?: string): void;
  allModelChoices(): { id: string; label: string; provider: ProviderId }[];
  persist(): void;
  openNote(path: string): void;
  openArtifact(path: string): void;
}

/** A conversation's unsent composer state — text, image attachments, manual
 *  context and the "exclude current note" flag. Stashed on the Convo (runtime
 *  only) so every chat keeps its own draft across tab switches. */
export interface ComposerDraft {
  text: string;
  images: ImageAttachment[];
  attached: string[];
  /** The active note the user dismissed with ×; only that note stays off. */
  dismissedActive: string | null;
}

/** Collapsed growth cap for the input (px) — past this the expand affordance appears. */
const INPUT_CAP = 200;
/** Hard ceiling for the expanded input (px); the live cap is min(50% window, this). */
const INPUT_CAP_EXPANDED = 520;

export class Composer {
  private usageEl: HTMLElement | null = null;
  private contextPopoverEl: HTMLElement | null = null;
  private contextPopoverIsOpen: () => boolean = () => false;
  private closeContextPopover: () => void = () => {};
  private lastUsage: ContextUsage | null = null;
  private rateBadgeEl: HTMLElement | null = null;
  private lastRateLimit: RateLimitInfo | null = null;
  private composerEl!: HTMLElement;
  private compactNudgeEl: HTMLElement | null = null;
  private inputEl!: HTMLTextAreaElement;
  private inputWrapEl!: HTMLElement;
  private expandBtn!: HTMLButtonElement;
  private inputExpanded = false;
  private sendBtn!: HTMLButtonElement;
  // Three independent toolbar chips — Model, Effort, Permission — each expose a
  // refresh fn so external changes (provider switch, plan-mode toggle, model
  // pick) can re-sync their label without opening the chip's popover.
  // refreshModelChip also cascades into refreshEffortChip, since valid effort
  // tiers (and the label) depend on the chosen model; Permission only depends
  // on provider, and onProviderChange calls refreshPermChipFn directly.
  private refreshModelChip: () => void = () => {};
  private refreshEffortChip: () => void = () => {};
  private refreshPermChipFn: () => void = () => {};
  private refreshResearchChip: () => void = () => {};
  private refreshAgentChipFn: () => void = () => {};
  /** Agent slug picked from the `@` menu, binding the NEXT send only. Consumed
   *  by `takePendingAgent()`; a `/as` binding lives on the Convo instead. */
  private pendingAgent: string | null = null;
  private contextEl!: HTMLElement;
  private dismissedActive: string | null = null;
  private manualAttached: string[] = [];
  /** The active editor's current selection, mirrored ambiently into the composer. */
  private currentSelection: { text: string; path: string } | null = null;
  private pendingImages: ImageAttachment[] = [];
  private imagesEl!: HTMLElement;
  private goalPillEl!: HTMLElement;

  constructor(private host: ComposerHost) {}

  /** The Obsidian app, reached through the plugin — the composer never holds a
   *  direct `app` handle, so the host stays a narrow view contract. */
  private get app(): App {
    return this.host.plugin.app;
  }

  /* --------------------------- public surface ----------------------- */

  getInputEl(): HTMLTextAreaElement {
    return this.inputEl;
  }
  getSendBtn(): HTMLButtonElement {
    return this.sendBtn;
  }
  getComposerEl(): HTMLElement {
    return this.composerEl;
  }
  getInputValue(): string {
    return this.inputEl.value;
  }
  setInputValue(v: string): void {
    this.inputEl.value = v;
    // Programmatic sets (send clears, prompt seeds) must re-run growth so the
    // box deflates/auto-collapses without waiting for a keystroke.
    this.autoGrow();
  }
  focusInput(): void {
    window.setTimeout(() => this.inputEl?.focus(), 0);
  }
  /** Append text at the end of the current draft (a smart space between old
   *  and new content, none if the draft is empty or already ends in one), then
   *  focus — the palette/hub-chip insert idiom. */
  insertText(text: string): void {
    const v = this.inputEl.value;
    this.setInputValue(v + (v && !v.endsWith(" ") ? " " : "") + text);
    this.focusInput();
  }
  /** Snapshot the in-progress draft for the outgoing conversation. Arrays are
   *  handed over by reference — setDraft immediately replaces the composer's
   *  own, so the snapshot can't be mutated behind the convo's back. */
  getDraft(): ComposerDraft {
    return {
      text: this.inputEl.value,
      images: this.pendingImages,
      attached: this.manualAttached,
      dismissedActive: this.dismissedActive,
    };
  }
  /** Restore a conversation's draft (undefined → pristine empty composer). */
  setDraft(d: ComposerDraft | undefined): void {
    this.pendingImages = d?.images ?? [];
    this.manualAttached = d?.attached ?? [];
    this.dismissedActive = d?.dismissedActive ?? null;
    this.renderImageStrip();
    this.refreshContext();
    this.setInputValue(d?.text ?? ""); // re-runs autoGrow → expand state follows the draft
  }
  getPendingImages(): ImageAttachment[] {
    return this.pendingImages;
  }
  clearPendingImages(): void {
    this.pendingImages = [];
  }
  addManualAttached(path: string): void {
    if (!this.manualAttached.includes(path)) this.manualAttached.push(path);
  }
  setLastRateLimit(info: RateLimitInfo | null): void {
    this.lastRateLimit = info;
    this.refreshContextPopover();
  }
  resetSlashCache(): void {
    this.slashCache = null;
  }
  refreshModel(): void {
    this.refreshModelChip();
  }
  refreshPerm(): void {
    this.refreshPermChipFn();
  }
  refreshResearch(): void {
    this.refreshResearchChip();
  }

  refreshAgentChip(): void {
    this.refreshAgentChipFn();
  }

  /** Read and clear the one-turn `@agent` binding. */
  takePendingAgent(): string | null {
    const slug = this.pendingAgent;
    this.pendingAgent = null;
    this.refreshAgentChip();
    return slug;
  }

  /** Render (or hide) the goal pill from the conversation's goal state. */
  refreshGoal(c: Convo): void {
    this.goalPillEl.empty();
    const g = c.goal;
    if (!g || g.status === "idle") return;

    const pill = this.goalPillEl.createDiv({ cls: "mva-goal-pill" });

    if (g.status === "met") {
      pill.createSpan({ cls: "mva-goal-pill-label", text: `✓ Goal met in ${g.iterations} run${g.iterations === 1 ? "" : "s"}` });
      window.setTimeout(() => {
        if (c.goal?.status === "met") {
          c.goal = undefined;
          if (this.host.active === c) this.goalPillEl.empty();
        }
      }, 4000);
      return;
    }

    const cond = g.condition.length > 48 ? g.condition.slice(0, 47) + "…" : g.condition;

    if (g.status === "paused") {
      pill.createSpan({ cls: "mva-goal-pill-label", text: `🎯 ${g.iterations} runs, not met yet` });
      const cont = pill.createEl("button", { cls: "mva-goal-pill-btn", text: `Continue +${g.maxIterations}` });
      cont.onclick = () => this.host.resumeGoalLoop(c);
      const stop = pill.createEl("button", { cls: "mva-goal-pill-btn", text: "Stop" });
      stop.onclick = () => this.host.handleGoalCommand(c, "/goal clear");
      return;
    }

    // active
    pill.createSpan({ cls: "mva-goal-pill-label", text: `🎯 ${cond} · run ${g.windowRuns}/${g.maxIterations}` });
    const stop = pill.createEl("button", { cls: "mva-goal-pill-btn", text: "stop" });
    stop.onclick = () => this.host.handleGoalCommand(c, "/goal clear");
  }

  /* ---------------------------- context ----------------------------- */

  /** Build the composer (input box + toolbar) and mount it into `root`. */
  mount(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "mva-composer" });
    this.composerEl = bar;
    // The composer is pinned to the bottom of listWrap (CSS), overlapping the
    // transcript. Publish its live height as --mva-composer-h so the list can
    // reserve matching bottom padding (last message clears the bar) and the jump
    // pill / content fade sit just above it. Height changes as the textarea grows,
    // images/context rows appear, or the bar is hidden (gallery → 0).
    const syncHeight = () =>
      this.host.listWrap.style.setProperty("--mva-composer-h", `${bar.offsetHeight}px`);
    const composerResize = new ResizeObserver(syncHeight);
    composerResize.observe(bar);
    this.host.register(() => composerResize.disconnect());
    // One unified input box (the only surface, Craft-style): context cards and
    // image attachments live INSIDE the box, above the textarea, then controls at
    // the bottom — everything shares one rounded border instead of floating rows.
    const box = bar.createDiv({ cls: "mva-inputbox" });
    this.contextEl = box.createDiv({ cls: "mva-context" });
    this.imagesEl = box.createDiv({ cls: "mva-images is-hidden" });
    // Goal pill host: shown only while a /goal is active. Mounted above the input.
    this.goalPillEl = box.createDiv({ cls: "mva-goal-pill-host" });
    // The wrap exists only to anchor the expand affordance to the textarea's
    // top-right corner (context/image rows above it move the textarea around).
    this.inputWrapEl = box.createDiv({ cls: "mva-inputwrap" });
    this.inputEl = this.inputWrapEl.createEl("textarea", {
      cls: "mva-input mva-type-body",
      attr: { rows: "3", placeholder: "Message the agent…" },
    });
    this.expandBtn = this.inputWrapEl.createEl("button", {
      cls: "mva-icon-btn mva-input-expand",
      attr: { "aria-label": "Expand input", tabindex: "-1" },
    });
    setIcon(this.expandBtn, "chevrons-up-down");
    this.expandBtn.onclick = () => this.toggleInputExpand();
    this.inputEl.addEventListener("input", () => this.autoGrow());
    this.inputEl.addEventListener("paste", (e) => this.onPaste(e));
    bar.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        bar.addClass("is-drop");
      }
    });
    bar.addEventListener("dragleave", () => bar.removeClass("is-drop"));
    bar.addEventListener("drop", (e) => {
      bar.removeClass("is-drop");
      this.onDrop(e);
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && e.shiftKey) {
        e.preventDefault();
        this.host.togglePlanMode();
        return;
      }
      if (e.key === "Escape" && this.host.streaming) {
        e.preventDefault();
        this.host.stop("esc");
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.host.send(); // send() queues if the active conversation is streaming
      }
    });

    new Autocomplete(this.inputEl, box, [
      { trigger: "/", getItems: (q) => this.slashItems(q) },
      { trigger: "$", getItems: (q) => this.skillItems(q) },
      // Vault file names use spaces, so the file picker keeps matching past
      // whitespace: "@mario mil" narrows word-by-word instead of dying at the
      // first space.
      { trigger: "@", allowSpaces: true, getItems: (q) => this.atItems(q) },
    ]);

    this.buildToolbar(box);
  }

  /** Seed the composer with a selection quoted from a note (the in-note "Ask Exo"
   *  action) and focus it. The excerpt is rendered as a Markdown blockquote with
   *  a source line so the agent sees exactly what the user highlighted; the caret
   *  lands after it, ready for the question. */
  attachSelection(text: string, sourcePath: string): void {
    const src = sourcePath ? noteBasename(sourcePath) : "the current note";
    const quoted = text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
    const block = `From "${src}":\n${quoted}\n\n`;
    // Prepend the excerpt, leave the caret at the very end for the question.
    this.inputEl.value = block + this.inputEl.value;
    const caret = this.inputEl.value.length;
    this.inputEl.setSelectionRange(caret, caret);
    this.autoGrow();
    window.setTimeout(() => this.inputEl?.focus(), 0);
  }

  /** Mirror the active editor's current selection into the composer as an ambient
   *  "Selection" chip (see the selection observer). Empty `text` clears it. No-op
   *  when the (text, path) pair is unchanged, so the debounced observer can call
   *  freely without churning the DOM. */
  setCurrentSelection(text: string, path: string): void {
    const next = text ? { text, path } : null;
    const prev = this.currentSelection;
    if ((prev?.text ?? "") === (next?.text ?? "") && (prev?.path ?? "") === (next?.path ?? "")) return;
    this.currentSelection = next;
    this.refreshContext();
  }

  /* ----------------------------- images ----------------------------- */

  private onPaste(e: ClipboardEvent): void {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
    if (files.length) {
      e.preventDefault();
      this.attachFiles(files);
    }
  }

  private onDrop(e: DragEvent): void {
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) {
      e.preventDefault();
      this.attachFiles(files);
    }
  }

  private attachFiles(files: File[]): void {
    const { images, paths } = partitionFiles(files);
    if (images.length) void this.attachImages(images);
    for (const p of paths) this.addExternalPath(p);
  }

  private async attachImages(files: Blob[]): Promise<void> {
    for (const f of files) {
      try {
        const buf = await f.arrayBuffer();
        const dataB64 = arrayBufferToBase64(buf);
        this.pendingImages.push({
          mediaType: (f as File).type || "image/png",
          dataB64,
          name: (f as File).name || "pasted image",
        });
      } catch {
        new Notice("Couldn't read an image.");
      }
    }
    this.renderImageStrip();
  }

  /** Resolve `![[image]]` embeds in the text to base64 attachments (Obsidian-native). */
  async embeddedImages(text: string): Promise<ImageAttachment[]> {
    const out: ImageAttachment[] = [];
    const re = /!\[\[([^\]]+?\.(?:png|jpe?g|gif|webp))(?:\|[^\]]*)?\]\]/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const f = this.app.metadataCache.getFirstLinkpathDest(m[1], "");
      if (!f) continue;
      try {
        const buf = await this.app.vault.readBinary(f);
        out.push({
          mediaType: extToMime(f.extension),
          dataB64: arrayBufferToBase64(buf),
          name: f.name,
        });
      } catch {
        /* skip unreadable */
      }
    }
    return out;
  }

  renderImageStrip(): void {
    this.imagesEl.empty();
    this.imagesEl.toggleClass("is-hidden", this.pendingImages.length === 0);
    this.pendingImages.forEach((img, i) => {
      const chip = this.imagesEl.createDiv({ cls: "mva-img-chip" });
      const thumb = chip.createEl("img", { cls: "mva-img-thumb" });
      thumb.src = `data:${img.mediaType};base64,${img.dataB64}`;
      const x = chip.createSpan({ cls: "mva-img-x", attr: { "aria-label": "Remove image" } });
      setIcon(x, "x");
      clickable(x, () => {
        this.pendingImages.splice(i, 1);
        this.renderImageStrip();
      });
    });
  }

  /* --------------------------- autocomplete ------------------------- */

  private slashCache: { commands: string[]; skills: string[]; agents: string[]; ts: number; provider: string } | null =
    null;
  private static readonly SLASH_TTL = 30_000;

  // Descriptions are read from frontmatter across vault + global + plugin
  // scopes (a few hundred small files) — cache longer than the name list and
  // dedupe concurrent builds behind one promise.
  private descCache: { idx: DescIndex; ts: number } | null = null;
  private descBuild: Promise<DescIndex> | null = null;
  private static readonly DESC_TTL = 300_000;

  private loadDescs(): Promise<DescIndex> {
    if (this.descCache && Date.now() - this.descCache.ts < Composer.DESC_TTL) {
      return Promise.resolve(this.descCache.idx);
    }
    this.descBuild ??= buildDescIndex(this.app).then((idx) => {
      this.descCache = { idx, ts: Date.now() };
      this.descBuild = null;
      return idx;
    });
    return this.descBuild;
  }

  private async loadSlash(): Promise<{ commands: string[]; skills: string[]; agents: string[] }> {
    // Provider keys the cache: the Codex list carries ~/.codex/skills entries a
    // Claude session must not see (and vice versa) — a provider switch inside
    // the TTL would otherwise serve the wrong catalog.
    if (
      this.slashCache &&
      this.slashCache.provider === this.host.provider &&
      Date.now() - this.slashCache.ts < Composer.SLASH_TTL
    ) {
      return this.slashCache;
    }
    const commands: string[] = [];
    const skills: string[] = [];
    const agents: string[] = [];
    const base = (p: string) => p.split("/").pop()?.replace(/\.md$/, "") ?? p;
    try {
      const c = await this.app.vault.adapter.list(".claude/commands");
      for (const f of c.files) if (f.endsWith(".md")) commands.push(base(f));
    } catch {
      /* no commands dir */
    }
    try {
      const s = await this.app.vault.adapter.list(".claude/skills");
      for (const folder of s.folders) skills.push(folder.split("/").pop() ?? folder);
      for (const f of s.files) if (f.endsWith(".md")) skills.push(base(f));
    } catch {
      /* no skills dir */
    }
    try {
      const a = await this.app.vault.adapter.list(".claude/agents");
      for (const f of a.files) if (f.endsWith(".md")) agents.push(base(f));
    } catch {
      /* no agents dir */
    }
    // Built-in commands Exo handles client-side (not file-based, so the disk
    // scan above never sees them). Registering `goal` makes autocomplete show
    // it AND lets hoistSlashCommand recognize a mid-message /goal.
    if (!commands.includes("goal")) commands.push("goal");
    // Union with the session's live init snapshot (global + plugin + vault —
    // the vault scan above only ever saw the vault's own .claude/). Dedup keeps
    // the menus stable when both sources know the same name.
    const add = (into: string[], names: string[]) => {
      const seen = new Set(into);
      for (const n of names) if (!seen.has(n)) { seen.add(n); into.push(n); }
    };
    if (this.host.sessionCaps) {
      add(commands, this.host.sessionCaps.commands);
      add(skills, this.host.sessionCaps.skills);
      add(agents, this.host.sessionCaps.agents);
    }
    // Codex's app-server snapshot does not expose its native skill catalog, so
    // ~/.codex/skills is scanned directly — without this, Codex sessions only
    // ever saw the vault's own .claude/ skills.
    if (this.host.provider === "codex") {
      try {
        add(skills, await codexSkillNames());
      } catch {
        /* no ~/.codex — nothing to add */
      }
    }
    this.slashCache = { commands, skills, agents, ts: Date.now(), provider: this.host.provider };
    return this.slashCache;
  }

  /** `$` trigger — skills. */
  private async skillItems(query: string): Promise<AcItem[]> {
    const q = query.toLowerCase();
    const [{ skills }, descs] = await Promise.all([this.loadSlash(), this.loadDescs()]);
    return skills
      .filter((sk) => sk.toLowerCase().includes(q))
      .map((sk) => ({ label: sk, desc: descs.skills.get(sk), detail: "skill", icon: "sparkles", insert: `$${sk} ` }));
  }

  private async slashItems(query: string): Promise<AcItem[]> {
    const q = query.toLowerCase();
    const out: AcItem[] = [];
    // Built-in: /compact [instructions] — compaction, handled locally in send().
    if ("compact".includes(q)) {
      out.push({ label: "compact", detail: "compact context", icon: "scissors", insert: "/compact " });
    }
    for (const p of this.host.plugin.settings.customPrompts) {
      if (p.name.toLowerCase().includes(q)) {
        const isWorkflow = p.prompt.includes(" >>> ");
        out.push({
          label: p.name,
          detail: isWorkflow ? "workflow" : "prompt",
          icon: isWorkflow ? "list-ordered" : "message-square",
          insert: "",
          onSelect: () => this.usePrompt(p.prompt),
        });
      }
    }
    const [{ commands, skills }, descs] = await Promise.all([this.loadSlash(), this.loadDescs()]);
    // One row per name — the CLI's command roster already carries every skill,
    // so the two lists overlap and each skill would otherwise print twice.
    for (const { name, kind } of mergeSlashEntries(commands, skills)) {
      if (!name.toLowerCase().includes(q)) continue;
      // Either roster may be the one that indexed the frontmatter: a skill
      // exposed as `/name` can land in the command descriptions instead.
      const [own, alt] = kind === "skill" ? [descs.skills, descs.commands] : [descs.commands, descs.skills];
      const icon = kind === "skill" ? "sparkles" : "terminal";
      out.push({ label: name, desc: own.get(name) ?? alt.get(name), detail: kind, icon, insert: `/${name} ` });
    }
    return out;
  }

  private async atItems(query: string): Promise<AcItem[]> {
    // AND-match on words: "@people mario" finds Atlas/People/Mario Miletta.md
    // regardless of word order — each space-separated word must appear in the path.
    const words = queryWords(query);
    const out: AcItem[] = [];
    // Subagents first — reference a vault agent by @mention.
    const [{ agents }, descs] = await Promise.all([this.loadSlash(), this.loadDescs()]);
    // With agents on, the registry is the source of truth — one entry per agent.
    // The raw lists below cannot be deduped: the vault scan yields the FILENAME
    // (`ghostwriter`) and the CLI roster yields the INVOCABLE ID
    // (`Ghostwriter`), so the same agent appears twice under exact-match dedup.
    // The registry already reconciles the two.
    const plugin = this.host.plugin;
    if (plugin.settings.agentsEnabled && (await plugin.agentsReady())) {
      for (const { brain } of plugin.agentStore.list()) {
        if (!matchesWords(`${brain.name} ${brain.slug}`, words)) continue;
        out.push({
          label: brain.name,
          desc: brain.description,
          detail: "agent",
          icon: "bot",
          insert: `@${brain.slug} `,
          // Picking one is a real binding: the next send carries an explicit
          // delegation instruction instead of relying on the model to notice
          // the `@name` in the prose.
          onSelect: () => {
            this.pendingAgent = brain.slug;
            this.refreshAgentChip();
          },
        });
      }
    } else {
      for (const a of agents) {
        if (!matchesWords(a, words)) continue;
        out.push({ label: a, desc: descs.agents.get(a), detail: "subagent", icon: "bot", insert: `@${a} ` });
      }
    }
    for (const f of this.app.vault.getAllLoadedFiles()) {
      if (!f.path || f.path === "/") continue;
      if (!matchesWords(f.path, words)) continue;
      const isFolder = f instanceof TFolder;
      if (!isFolder && !(f instanceof TFile)) continue;
      const parent = f.parent && f.parent.path !== "/" ? f.parent.path : "";
      out.push({
        label: isFolder ? `${f.name}/` : f.name,
        detail: parent,
        icon: isFolder ? "folder" : "file-text",
        insert: `@${f.path}${isFolder ? "/" : ""} `,
        onSelect: () => {
          if (!this.manualAttached.includes(f.path)) this.manualAttached.push(f.path);
          this.refreshContext();
        },
      });
      if (out.length >= 40) break;
    }
    return out;
  }

  private static readonly EFFORT_OPTS: [string, string][] = [
    ["default", "Default"],
    ["low", "Low"],
    ["medium", "Medium"],
    ["high", "High"],
    ["xhigh", "Extra high"],
    ["max", "Max"],
  ];
  private static effortLabel(e: string): string {
    return Composer.EFFORT_OPTS.find(([v]) => v === e)?.[1] ?? e;
  }

  private buildToolbar(bar: HTMLElement): void {
    const tb = bar.createDiv({ cls: "mva-toolbar" });

    // Attach "+" — the single entry point for adding context (note / file /
    // folder / image). Leftmost in the toolbar; opens a themed popover (matching
    // the select chips) rather than the OS/Obsidian menu.
    this.buildAttachButton(tb);

    // Tuning cascade, left-aligned, each its own visible chip: Model → Effort →
    // Permission. Model comes first because the other two derive from it (the
    // chosen model gates which effort tiers are valid and which provider owns
    // the permission/sandbox setting). Three chips instead of one dial (07-06:
    // reverts the 07-05 consolidation) — a hidden "sliders" icon meant the
    // active model/effort/permission weren't visible without a click; each
    // chip now shows its own current value at rest.
    this.buildModelSelect(tb);
    this.buildEffortSelect(tb);
    this.buildPermissionSelect(tb);
    this.buildResearchToggle(tb);
    this.buildAgentChip(tb);

    tb.createDiv({ cls: "mva-spacer" });
    // Context usage as a compact circular counter (donut ring). Click opens the
    // detailed breakdown, including the active model's real context limit.
    const contextWrap = tb.createDiv({ cls: "mva-ctx-control" });
    this.usageEl = contextWrap.createDiv({
      cls: "mva-ctx-ring",
      attr: { "aria-label": "Context window", "aria-haspopup": "dialog", "aria-expanded": "false" },
    });
    const contextPop = contextWrap.createDiv({
      cls: "mva-ctx-pop",
      attr: { role: "dialog", "aria-label": "Context window details" },
    });
    contextPop.hide();
    this.contextPopoverEl = contextPop;
    const popover = openablePopover({
      anchor: this.usageEl,
      pop: contextPop,
      wrap: contextWrap,
      onOpen: () => {
        this.renderContextPopover(contextPop);
        void this.host.active.session?.refreshRateLimits?.();
        this.usageEl?.setAttribute("aria-expanded", "true");
      },
      onClose: () => this.usageEl?.setAttribute("aria-expanded", "false"),
    });
    this.contextPopoverIsOpen = popover.isOpen;
    this.closeContextPopover = popover.close;
    clickable(this.usageEl, (e) => {
      e.stopPropagation();
      popover.toggle();
    });
    this.host.register(() => popover.close());
    this.updateUsage(null);

    // Native plan/account quota badge — a quiet dot+percent that only appears
    // when any provider quota is nearing (≥80% / warning) or over its limit.
    // Detailed windows live in the context popover beside the ring.
    this.rateBadgeEl = tb.createDiv({ cls: "mva-rate-badge" });
    this.rateBadgeEl.hide();
    this.updateRateBadge();

    // Send button — lives inside the input box, right side.
    this.sendBtn = tb.createEl("button", { cls: "mva-send", attr: { "aria-label": "Send" } });
    setIcon(this.sendBtn, "arrow-up");
    setTooltip(this.sendBtn, "Send");
    this.sendBtn.onclick = () => (this.host.streaming ? this.host.stop() : void this.host.send());
  }

  /** Per-conversation Research Mode — icon-only binoculars toggle. State reads
   *  through the tooltip + is-active tint; clicking again exits (no x badge). */
  private buildResearchToggle(tb: HTMLElement): void {
    const chip = tb.createDiv({
      cls: "mva-research-chip",
      attr: { role: "button", tabindex: "0", "aria-label": "Toggle Research Mode" },
    });
    const refresh = () => {
      // mount() runs before ChatView.restore(), so the first paint has no active
      // conversation yet. Start safely off; restore() refreshes to the real state.
      const active = this.host.active?.researchMode.enabled ?? false;
      chip.empty();
      chip.toggleClass("is-active", active);
      chip.setAttribute("aria-pressed", String(active));
      const icon = chip.createSpan({ cls: "mva-research-chip-icon" });
      setIcon(icon, "binoculars");
      // Older bundled lucide sets predate the binoculars glyph — setIcon leaves
      // the span empty there, so fall back to the classic magnifier.
      if (!icon.querySelector("svg")) setIcon(icon, "search");
      setTooltip(chip, active ? "Exit Research Mode" : "Start Research Mode");
    };
    clickable(chip, () => this.host.toggleResearchMode());
    this.refreshResearchChip = refresh;
    refresh();
  }

  /**
   * Bound-agent chip — hidden until an agent is bound, so the toolbar stays
   * unchanged for anyone not using agents.
   *
   * Two bindings share one chip because they are the same idea at two
   * durations: a `@agent` pick binds the next send (shown as pending), `/as`
   * binds the tab. Clicking clears whichever is active.
   */
  private buildAgentChip(tb: HTMLElement): void {
    const chip = tb.createDiv({
      cls: "mva-agent-chip",
      attr: { role: "button", tabindex: "0", "aria-label": "Bound agent" },
    });
    const refresh = () => {
      const bound = this.host.active?.agent ?? null;
      const slug = this.pendingAgent ?? bound;
      chip.empty();
      if (!slug) {
        chip.hide();
        return;
      }
      chip.show();
      chip.toggleClass("is-pending", this.pendingAgent !== null);
      const icon = chip.createSpan({ cls: "mva-agent-chip-icon" });
      setIcon(icon, "bot");
      chip.createSpan({ cls: "mva-agent-chip-label", text: slug });
      setTooltip(
        chip,
        this.pendingAgent
          ? `Next message goes to ${slug} — click to cancel`
          : `This chat is bound to ${slug} — click to unbind (or type /as off)`
      );
    };
    clickable(chip, () => {
      if (this.pendingAgent) this.pendingAgent = null;
      else if (this.host.active) this.host.clearBoundAgent();
      refresh();
    });
    this.refreshAgentChipFn = refresh;
    refresh();
  }

  /** Model selector — unified picker across BOTH providers (no separate
   *  Provider chip), first in the cascade since Effort/Permission derive from
   *  it. The chip shows the chosen model's label at rest; its popover groups
   *  Claude/Codex options under quiet headers with a brand-color dot per row.
   *  Picking a model from the other backend switches provider+model together
   *  (that also flips Permission↔Sandbox — see onProviderChange). */
  private buildModelSelect(tb: HTMLElement): void {
    const wrap = tb.createDiv({ cls: "mva-sel" });
    const chip = wrap.createDiv({ cls: "mva-sel-chip", attr: { "aria-label": "Model" } });
    const pop = wrap.createDiv({ cls: "mva-sel-pop" });
    pop.hide();

    const refreshLabel = () => {
      chip.empty();
      setProviderMark(chip.createSpan({ cls: "mva-sel-mark" }), this.host.provider);
      chip.createSpan({ cls: "mva-sel-chip-label", text: this.modelLabel() });
    };

    const popover = openablePopover({
      anchor: chip,
      pop,
      wrap,
      onOpen: () =>
        this.renderOptionRows(
          pop,
          this.host.allModelChoices().map((m) => ({
            value: m.id,
            label: m.label,
            mark: m.provider,
            group: m.provider === "claude" ? "Claude" : "Codex",
          })),
          this.host.model,
          {
            onPick: (v) => {
              this.applyModelChoice(v);
              popover.close();
            },
            onEscape: () => popover.close(),
          }
        ),
      focus: () => pop.querySelector<HTMLElement>(".mva-sel-opt")?.focus(),
    });
    clickable(chip, (e) => {
      e.stopPropagation();
      popover.toggle();
    });
    this.host.register(() => popover.close());

    refreshLabel();
    // External-change hook (provider switch, model pick): re-label this chip,
    // then cascade into Effort — its valid tiers (and displayed label) depend
    // on the model. Permission doesn't depend on the model, only the
    // provider, and onProviderChange already calls refreshPerm() directly.
    this.refreshModelChip = () => {
      refreshLabel();
      this.refreshEffortChip();
    };
  }

  /** Effort selector — tiers are per-model (core/model-tuning.ts); a stale
   *  stored tier (e.g. "max" saved, then a Codex model restored) is clamped
   *  to the nearest valid one on every label refresh, so an invalid tier
   *  never reaches the CLI and the chip never shows a value the model
   *  doesn't support. Hidden entirely for models with no effort support. */
  private buildEffortSelect(tb: HTMLElement): void {
    const s = this.host.plugin.settings;
    const effortOpts = () => effortOptionsFor(this.host.provider, this.host.model);

    const wrap = tb.createDiv({ cls: "mva-sel" });
    const chip = wrap.createDiv({ cls: "mva-sel-chip", attr: { "aria-label": "Effort" } });
    const pop = wrap.createDiv({ cls: "mva-sel-pop" });
    pop.hide();

    const refreshLabel = () => {
      const eo = effortOpts();
      if (!eo) {
        wrap.hide();
        return;
      }
      wrap.show();
      // Display only: the stored tier is kept for models that offer it again.
      chip.setText(Composer.effortLabel(clampEffort(s.effort || "default", eo)));
    };

    const popover = openablePopover({
      anchor: chip,
      pop,
      wrap,
      onOpen: () => {
        const eo = effortOpts();
        if (!eo) return;
        this.renderOptionRows(pop, eo.map(([value, label]) => ({ value, label })), clampEffort(s.effort || "default", eo), {
          onPick: (v) => {
            s.effort = v;
            void this.host.plugin.saveSettings();
            refreshLabel();
            popover.close();
          },
          onEscape: () => popover.close(),
        });
      },
      focus: () => pop.querySelector<HTMLElement>(".mva-sel-opt")?.focus(),
    });
    clickable(chip, (e) => {
      e.stopPropagation();
      popover.toggle();
    });
    this.host.register(() => popover.close());

    refreshLabel();
    this.refreshEffortChip = refreshLabel;
  }

  /** Permission (Claude) / Sandbox (Codex) selector — the actual tool gate,
   *  last in the cascade. Provider-aware: Claude's `permissionMode` gates
   *  tool calls via `canUseTool`; Codex has no such hook, so its sandbox
   *  setting is what the chip shows and controls instead. Risk (caution/
   *  danger) colors the chip itself — no separate always-visible dot. */
  private buildPermissionSelect(tb: HTMLElement): void {
    const s = this.host.plugin.settings;

    const wrap = tb.createDiv({ cls: "mva-sel" });
    const chip = wrap.createDiv({ cls: "mva-sel-chip", attr: { "aria-label": "Permission mode" } });
    const pop = wrap.createDiv({ cls: "mva-sel-pop" });
    pop.hide();

    const refreshLabel = () => {
      const risk = this.host.provider === "codex" ? Composer.codexSandboxRisk(s.codexSandbox) : Composer.permRisk(s.permissionMode);
      chip.className = `mva-sel-chip${risk ? ` ${risk}` : ""}`;
      chip.setText(
        this.host.provider === "codex" ? Composer.codexSandboxLabel(s.codexSandbox) : Composer.permLabel(s.permissionMode)
      );
    };

    const popover = openablePopover({
      anchor: chip,
      pop,
      wrap,
      onOpen: () => {
        const options =
          this.host.provider === "codex"
            ? Composer.CODEX_SANDBOX_OPTS.map(([v, l]) => ({ value: v, label: l, risk: Composer.codexSandboxRisk(v) }))
            : Composer.PERM_OPTS.map(([v, l]) => ({ value: v, label: l, risk: Composer.permRisk(v) }));
        const current = this.host.provider === "codex" ? s.codexSandbox : s.permissionMode;
        this.renderOptionRows(pop, options, current, {
          onPick: (v) => {
            this.applyPermChoice(v);
            popover.close();
          },
          onEscape: () => popover.close(),
        });
      },
      focus: () => pop.querySelector<HTMLElement>(".mva-sel-opt")?.focus(),
    });
    clickable(chip, (e) => {
      e.stopPropagation();
      popover.toggle();
    });
    this.host.register(() => popover.close());

    refreshLabel();
    this.refreshPermChipFn = refreshLabel;
  }

  /** Apply a model pick from the tune dialog (mirrors the old model chip's
   *  onSelect): guard while streaming, switch provider+model together when the
   *  chosen model belongs to the other backend. */
  private applyModelChoice(v: string): void {
    if (this.host.streaming) {
      new Notice("Can't switch model while a reply is streaming.");
      return;
    }
    const found = this.host.allModelChoices().find((m) => m.id === v);
    if (!found) return;
    if (found.provider !== this.host.provider) {
      this.host.onProviderChange(found.provider, v);
      return;
    }
    // Re-picking the current model leaves the live counter untouched.
    if (this.host.model !== v) {
      // The pick belongs to this chat. A model switch creates a new provider
      // session on the next send: never carry the previous model's context
      // occupancy or limit into it.
      this.host.model = v;
      this.host.active.usage = undefined;
      this.host.persist();
      this.updateUsage(null);
    }
    // Effort options (and the current tier's validity) follow the model —
    // re-sync the whole cascade.
    this.refreshModelChip();
  }

  /** Apply a permission (Claude) or sandbox (Codex) pick; keeps setting, live
   *  session, and the permission chip in sync. */
  private applyPermChoice(v: string): void {
    const s = this.host.plugin.settings;
    if (this.host.provider === "codex") {
      s.codexSandbox = v;
      void this.host.plugin.saveSettings();
    } else {
      // Entering plan mode records the mode we came from, so a later plan approval
      // restores it (mirrors togglePlanMode).
      if (v === "plan" && s.permissionMode !== "plan") this.host.prePlanMode = s.permissionMode;
      s.permissionMode = v as typeof s.permissionMode;
      void this.host.plugin.saveSettings();
      this.host.active.session?.setPermissionMode?.(s.permissionMode);
    }
    this.refreshPermChipFn();
  }

  /**
   * Shared option-row renderer for BOTH the toolbar select chips and the tune
   * dialog — the single source of truth for grouped/flat option rows. Draws quiet
   * group headers (from buildOptionRows), an optional provider brand-dot, risk
   * coloring, and a check on the current value; wires roving ArrowUp/Down + Enter +
   * Escape keyboard nav onto `container` (focus lives on the container, never the
   * rows). Picking a row fires `onPick` and moves the check to it — chips close
   * afterwards; the dialog stays open, so the moved check reflects the new value.
   * Returns a `focus()` that seeds the keyboard cursor on the current row.
   */
  private renderOptionRows(
    container: HTMLElement,
    options: SelectOption[],
    current: string,
    cb: { onPick: (value: string) => void; onEscape?: () => void }
  ): () => void {
    container.empty();
    const optionEls: { el: HTMLElement; value: string; check: HTMLElement }[] = [];
    let activeIdx = -1;
    const setActive = (idx: number) => {
      if (!optionEls.length) {
        activeIdx = -1;
        return;
      }
      activeIdx = ((idx % optionEls.length) + optionEls.length) % optionEls.length;
      optionEls.forEach((o, i) => o.el.toggleClass("is-active", i === activeIdx));
      optionEls[activeIdx].el.scrollIntoView({ block: "nearest" });
    };
    const markSelected = (value: string) => {
      for (const o of optionEls) {
        const sel = o.value === value;
        o.el.toggleClass("is-selected", sel);
        o.check.style.visibility = sel ? "visible" : "hidden";
      }
    };
    const pick = (value: string) => {
      cb.onPick(value);
      markSelected(value);
    };
    for (const r of buildOptionRows(options, "")) {
      if (r.kind === "header") {
        container.createDiv({ cls: "mva-sel-group", text: r.group });
        continue;
      }
      const o = r.option;
      const row = container.createDiv({ cls: "mva-sel-opt" });
      if (o.risk) row.addClass(o.risk);
      if (o.mark) setProviderMark(row.createSpan({ cls: "mva-sel-mark" }), o.mark);
      row.createSpan({ cls: "mva-sel-opt-label", text: o.label });
      const check = row.createSpan({ cls: "mva-sel-opt-check" });
      setIcon(check, "check");
      const idx = optionEls.length;
      optionEls.push({ el: row, value: o.value, check });
      row.addEventListener("mouseenter", () => setActive(idx));
      row.onclick = () => pick(o.value);
    }
    markSelected(current);
    const curIdx = optionEls.findIndex((o) => o.value === current);
    setActive(curIdx >= 0 ? curIdx : 0);
    container.tabIndex = 0;
    container.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        setActive(activeIdx + 1);
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        setActive(activeIdx - 1);
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        const o = optionEls[activeIdx];
        if (o) pick(o.value);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        cb.onEscape?.();
      }
    });
    return () => container.focus();
  }

  /**
   * Single entry point for the composer footer's circular context counter
   * (donut ring). Sets --pct (0-100) and --ring-color on the ring element and
   * a hover/aria tooltip with the used/total breakdown. Called after every
   * 'usage' event and whenever model/provider changes so it stays in sync even
   * without a fresh event. NOTE: the >=75% compact nudge hooks in here — this
   * stays the one place usage state is rendered, so that trigger keeps firing.
   */
  updateUsage(u: ContextUsage | null): void {
    const ring = this.usageEl;
    if (!ring) return;
    this.lastUsage = u;

    ring.removeClass("is-caution");
    ring.removeClass("is-danger");

    // Fresh session / provider that doesn't report usage (Codex): empty ring.
    if (!u || !u.total) {
      ring.addClass("is-empty");
      ring.setCssProps({ "--pct": "0", "--ring-color": "var(--interactive-accent)" });
      const tip = "Context usage appears after the first reply · click for details";
      setTooltip(ring, tip);
      ring.setAttribute("aria-label", tip);
      this.hideCompactNudge();
      this.refreshContextPopover();
      return;
    }

    ring.removeClass("is-empty");
    const pct = Math.min(100, Math.round((u.used / u.total) * 100));
    const risk: RiskLevel = pct >= 90 ? "is-danger" : pct >= 75 ? "is-caution" : "";
    const color = pct >= 90 ? "var(--color-red)" : pct >= 75 ? "var(--color-orange)" : "var(--interactive-accent)";
    ring.setCssProps({ "--pct": String(pct), "--ring-color": color });
    if (risk) ring.addClass(risk);

    // Cost lives in the tooltip only (Codex omits it; Claude omits it when the
    // experimental SDK cost API is unavailable) — never a broken/empty footer.
    const costPart = typeof u.costUsd === "number" ? ` · $${u.costUsd.toFixed(2)}` : "";
    const tip = `Context: ${pct}% — ~${fmtTokens(u.used)} / ${fmtTokens(u.total)} tokens${costPart} · click for details`;
    setTooltip(ring, tip);
    ring.setAttribute("aria-label", tip);

    // Proactive one-shot nudge: once context crosses 75% (same threshold as the
    // ring's caution state), suggest compacting. Shown at most once per convo.
    if (pct >= 75) this.maybeShowCompactNudge();
    else this.hideCompactNudge();
    this.refreshContextPopover();
  }

  /** Keep an already-open context popover live while usage or the active model changes. */
  private refreshContextPopover(): void {
    if (this.contextPopoverEl && this.contextPopoverIsOpen()) this.renderContextPopover(this.contextPopoverEl);
  }

  /** Render the Claude-like context-window breakdown opened from the footer ring. */
  private renderContextPopover(pop: HTMLElement): void {
    pop.empty();

    const head = pop.createDiv({ cls: "mva-ctx-pop-head" });
    head.createSpan({ cls: "mva-ctx-pop-title", text: "Context window" });
    head.createSpan({ cls: "mva-ctx-pop-model", text: this.modelLabel(), attr: { title: this.host.model } });

    const u = this.lastUsage;
    if (!u || !u.total) {
      pop.createDiv({ cls: "mva-ctx-pop-empty", text: "The model limit will appear after the first reply." });
    } else {
      const pct = Math.min(100, Math.round((u.used / u.total) * 100));
      const risk: RiskLevel = pct >= 90 ? "is-danger" : pct >= 75 ? "is-caution" : "";
      const color = pct >= 90 ? "var(--color-red)" : pct >= 75 ? "var(--color-orange)" : "var(--interactive-accent)";
      const value = pop.createDiv({ cls: `mva-ctx-pop-value${risk ? ` ${risk}` : ""}` });
      value.createSpan({ cls: "mva-ctx-pop-used", text: `~${fmtTokens(u.used)}` });
      value.createSpan({ cls: "mva-ctx-pop-total", text: `/ ${fmtTokens(u.total)}` });
      value.createSpan({ cls: "mva-ctx-pop-pct", text: `${pct}%` });

      const track = pop.createDiv({ cls: "mva-ctx-pop-track" });
      track.createDiv({ cls: "mva-ctx-pop-fill" }).style.cssText = `width:${pct}%;background:${color};`;

      const meta = pop.createDiv({ cls: "mva-ctx-pop-meta" });
      meta.createSpan({ text: `Model limit: ${fmtTokens(u.total)} tokens` });
      if (typeof u.costUsd === "number") meta.createSpan({ text: ` · $${u.costUsd.toFixed(2)}` });
    }

    this.renderQuotaWindows(pop, this.lastRateLimit);

    if (this.host.active.session?.compact) {
      const action = pop.createEl("button", { cls: "mva-ctx-pop-action", text: "Compact now" });
      action.onclick = () => {
        this.closeContextPopover();
        this.host.compactActive();
      };
    }
  }

  /** Render native account/plan windows separately from the thread context window. */
  private renderQuotaWindows(pop: HTMLElement, info: RateLimitInfo | null): void {
    if (!info) return;
    const windows: RateLimitWindow[] = info.windows?.length
      ? info.windows
      : typeof info.utilization === "number"
        ? [{
            id: info.windowType ?? "usage",
            label: windowLabel(info.windowType),
            utilization: info.utilization,
            ...(typeof info.resetsAt === "number" ? { resetsAt: info.resetsAt } : {}),
          }]
        : [];
    if (!windows.length) return;

    const section = pop.createDiv({ cls: "mva-ctx-quota" });
    const head = section.createDiv({ cls: "mva-ctx-quota-head" });
    head.createSpan({ cls: "mva-ctx-quota-title", text: "Plan usage limits" });
    if (info.planType) head.createSpan({ cls: "mva-ctx-quota-plan", text: info.planType });

    for (const window of windows) {
      const row = section.createDiv({ cls: "mva-ctx-quota-row" });
      const rowHead = row.createDiv({ cls: "mva-ctx-quota-row-head" });
      rowHead.createSpan({ cls: "mva-ctx-quota-label", text: window.label });
      const pct = normalizeUtilization(window.utilization);
      const reset = formatResetRelative(window.resetsAt);
      rowHead.createSpan({
        cls: "mva-ctx-quota-meta",
        text: `${reset}  ${typeof pct === "number" ? `${pct}%` : "—"}`,
      });
      const track = row.createDiv({ cls: "mva-ctx-quota-track" });
      const fill = track.createDiv({ cls: "mva-ctx-quota-fill" });
      const width = pct ?? 0;
      const color = pct !== undefined && pct >= 90
        ? "var(--color-red)"
        : pct !== undefined && pct >= 80
          ? "var(--color-orange)"
          : "var(--interactive-accent)";
      fill.style.cssText = `width:${width}%;background:${color};`;
    }
  }

  /** Render the native plan/account quota badge from `lastRateLimit`. Hidden entirely
   *  when there's no snapshot (API-key sessions, or a plan with headroom) — no
   *  fake states. Visible as a quiet dot+percent at ≥80%/warning (caution) or a
   *  danger "limit" when the plan rejects. Pure thresholding lives in
   *  core/rate-limit.ts. */
  updateRateBadge(): void {
    const el = this.rateBadgeEl;
    if (!el) return;
    const info = this.lastRateLimit;
    el.removeClass("is-caution");
    el.removeClass("is-danger");
    if (!info) {
      el.hide();
      return;
    }
    const state = badgeState(info.status, info.utilization);
    if (!state.visible) {
      el.hide();
      return;
    }
    el.empty();
    el.createSpan({ cls: "mva-rate-dot" });
    el.createSpan({ cls: "mva-rate-pct", text: state.label });
    el.addClass(state.level === "danger" ? "is-danger" : "is-caution");
    // Tooltip: "Plan usage: N% of the {5-hour|weekly} window — resets HH:MM".
    // Prefer the native row label because Codex may identify the active window
    // only as `codex:primary` while the row carries the real 5-hour/weekly label.
    const activeWindow = info.windows?.find((window) => window.id === info.windowType)
      ?? info.windows?.[0];
    const win = activeWindow?.label ?? windowLabel(info.windowType);
    const resetMs = normalizeResetEpochMs(info.resetsAt ?? activeWindow?.resetsAt);
    const parts = [`Plan usage: ${state.label === "limit" ? "over" : state.label} of the ${win} window`];
    if (resetMs) parts.push(`resets ${formatClock(resetMs)}`);
    const tip = parts.join(" — ");
    setTooltip(el, tip);
    el.setAttribute("aria-label", tip);
    el.show();
  }

  /** Show the discreet ≥75% compaction nudge under the composer — one-shot per
   *  conversation. Marks the
   *  convo as nudged before rendering so it never re-appears. */
  private maybeShowCompactNudge(): void {
    const c = this.host.active;
    if (c.compactNudged) return; // one-shot per conversation
    if (!c.session?.compact) return; // nothing to compact yet
    if (this.compactNudgeEl) return; // already visible
    c.compactNudged = true;

    const row = this.composerEl.createDiv({ cls: "mva-compact-nudge" });
    setIcon(row.createSpan({ cls: "mva-compact-nudge-icon" }), "scissors");
    row.createSpan({
      cls: "mva-compact-nudge-text",
      text: "Context is filling up — compacting keeps the conversation sharp.",
    });
    const act = row.createEl("button", { cls: "mva-compact-nudge-act", text: "Compact now" });
    act.onclick = () => {
      this.hideCompactNudge();
      this.host.compactActive(); // no instructions — quick one-click compaction
    };
    const x = row.createSpan({ cls: "mva-compact-nudge-x", attr: { "aria-label": "Dismiss" } });
    setIcon(x, "x");
    x.onclick = () => this.hideCompactNudge();
    this.compactNudgeEl = row;
  }

  /** Remove the nudge row (visual only — the per-convo `compactNudged` flag
   *  persists, so the one-shot is never re-triggered). */
  hideCompactNudge(): void {
    this.compactNudgeEl?.remove();
    this.compactNudgeEl = null;
  }


  /* ---- Permission chip helpers ---- */
  private static readonly PERM_OPTS: [string, string][] = [
    ["default", "Ask"],
    ["acceptEdits", "Accept edits"],
    ["plan", "Plan"],
    ["auto", "Auto"],
    ["bypassPermissions", "Bypass"],
  ];
  private static permLabel(mode: string): string {
    return Composer.PERM_OPTS.find(([v]) => v === mode)?.[1] ?? mode;
  }
  /** Returns a CSS modifier class for risk coloring; empty string = safe mode. */
  private static permRisk(mode: string): RiskLevel {
    if (mode === "bypassPermissions") return "is-danger";
    if (mode === "acceptEdits" || mode === "auto") return "is-caution";
    return "";
  }

  /** Codex sandbox options (Codex has no canUseTool — its sandbox is the gate). */
  private static readonly CODEX_SANDBOX_OPTS: [string, string][] = [
    ["read-only", "Read-only"],
    ["workspace-write", "Workspace write"],
    ["danger-full-access", "Full access"],
  ];
  private static codexSandboxLabel(mode: string): string {
    return Composer.CODEX_SANDBOX_OPTS.find(([v]) => v === mode)?.[1] ?? mode;
  }
  private static codexSandboxRisk(mode: string): RiskLevel {
    if (mode === "danger-full-access") return "is-danger";
    if (mode === "workspace-write") return "is-caution";
    return "";
  }

  /** The context row and the outbound message both read this: one rule. */
  private context(): ContextModel {
    const p = this.app.workspace.getActiveFile()?.path ?? null;
    return contextModel(activeNoteState(p, !!p && isNoteVisible(this.app, p), this.dismissedActive), this.manualAttached);
  }

  contextPaths(): string[] {
    return this.context().paths;
  }

  /** The ambient selection currently advertised by the chip, or null. Bound to
   *  the SAME predicate the chip renders from (`selectionChipModel`) so that what
   *  the user sees as "selected text" is exactly what gets serialized into the
   *  outbound message — closing the display-state≠send-state disconnect. */
  contextSelection(): { text: string; path: string } | null {
    return this.selectionChipModel();
  }

  /** Debug snapshot of the context chips (active doc + manual attachments),
   *  for the `[Exo][ctx]` diagnostic line. */
  contextChips(): { doc: string | null; manual: string[] } {
    const { active, manual } = this.context();
    return { doc: active.kind === "attached" ? active.path : null, manual };
  }

  refreshContext(): void {
    if (!this.contextEl) return;
    this.contextEl.empty();
    // Every context note is a uniform card in a horizontal row (Craft-style):
    // the active note first ("Current Document"), then manual attachments.
    // The ADD affordances live inside the composer toolbar now (the "+" menu);
    // this row is purely the list of attached items — so when it's empty it
    // collapses entirely rather than leaving an empty bar.
    const { active, manual } = this.context();
    // The selection chip shows only while a live selection exists that isn't
    // already attached as its own text (once attached it becomes redundant with
    // the seeded excerpt in the input — see attachSelection).
    const sel = this.selectionChipModel();
    const hasAny = active.kind !== "none" || manual.length > 0 || !!sel;
    this.contextEl.toggleClass("is-empty", !hasAny);
    if (!hasAny) return;
    const cards = this.contextEl.createDiv({ cls: "mva-doc-cards" });
    const then = (change: () => void) => () => {
      change();
      this.refreshContext();
    };
    if (active.kind !== "none") {
      const dismiss = then(() => (this.dismissedActive = active.path));
      if (active.kind === "attached") {
        this.renderContextCard(cards, active.path, { label: "Current Document", onClick: () => this.host.openNote(active.path), onRemove: dismiss });
      } else {
        this.renderContextCard(cards, active.path, {
          label: "Open note · click to attach",
          suggested: true,
          onClick: then(() => this.manualAttached.push(active.path)),
          onRemove: dismiss,
        });
      }
    }
    for (const p of manual) {
      const external = Composer.isExternalPath(p);
      this.renderContextCard(cards, p, {
        label: external ? "External" : "Document",
        onClick: () => (external ? this.host.openArtifact(p) : this.host.openNote(p)),
        onRemove: then(() => (this.manualAttached = this.manualAttached.filter((x) => x !== p))),
      });
    }
    if (sel) this.renderSelectionCard(cards, sel.text, sel.path, active.kind === "attached" ? active.path : null);
  }

  /** The selection chip's model, or null when it shouldn't show: gated on the
   *  setting, a non-empty selection, and not-already-seeded into the composer.
   *  Kept separate so `refreshContext` stays a straight list build. */
  private selectionChipModel(): { text: string; path: string } | null {
    if (!this.host.plugin.settings.showSelectionChip) return null;
    const sel = this.currentSelection;
    if (!sel || !sel.text.trim()) return null;
    return sel;
  }

  /** A transient, click-to-attach card for the active editor's selection. Same
   *  card grammar as the document cards (thumb + body + ×) but visually a hair
   *  distinct (`.mva-sel-card`): a text-cursor thumb, a "Selection" kind line, a
   *  one-line preview + count, and a source-note suffix when the selection comes
   *  from a note other than the active-context doc. Clicking seeds the quoted
   *  excerpt into the composer via the existing `attachSelection` path; the ×
   *  dismisses the chip. Keyboard-operable via `clickable()`. */
  private renderSelectionCard(parent: HTMLElement, text: string, path: string, activePath: string | null): void {
    const { label, count } = selectionPreview(text);
    const card = parent.createDiv({ cls: "mva-doc-card mva-sel-card" });
    const thumb = card.createDiv({ cls: "mva-doc-thumb is-icon" });
    setIcon(thumb, "text-cursor-input");
    const body = card.createDiv({ cls: "mva-doc-body" });
    body.createDiv({ cls: "mva-doc-title", text: label || "Selection", attr: { title: label } });
    // Show the source note only when it isn't the active-context doc (which the
    // "Current Document" card already names), so the kind line stays terse.
    const fromOther = path && path !== activePath ? ` · ${noteBasename(path)}` : "";
    body.createDiv({ cls: "mva-doc-kind", text: `Selection · ${count}${fromOther}` });
    const x = card.createSpan({ cls: "mva-doc-x", attr: { "aria-label": "Dismiss selection" } });
    setIcon(x, "x");
    clickable(x, (e) => {
      e.stopPropagation();
      this.currentSelection = null;
      this.refreshContext();
    });
    // Click-to-attach: seed the quoted excerpt into the composer, then clear the
    // chip (the excerpt now lives in the input, so the chip would be redundant).
    clickable(card, () => {
      this.attachSelection(text, path);
      this.currentSelection = null;
      this.refreshContext();
    });
  }

  /** The composer "+" attach control: a themed popover (matching the select chips,
   *  not the OS/Obsidian menu) with the single set of attach actions — note / file
   *  / folder / image. Opens upward, closes on pick / outside-click / Esc. */
  private buildAttachButton(tb: HTMLElement): void {
    const wrap = tb.createDiv({ cls: "mva-sel mva-attach" });
    const btn = wrap.createDiv({ cls: "mva-tb-btn", attr: { "aria-label": "Attach" } });
    setIcon(btn, "plus");
    setTooltip(btn, "Attach note, file, folder, or image");
    const pop = wrap.createDiv({ cls: "mva-sel-pop mva-attach-pop" });
    pop.hide();
    const items: [string, string, () => void][] = [
      ["Add note", "plus", () => this.pickNote()],
      ["Attach file", "file-plus", () => this.pickExternal(false)],
      ["Attach folder", "folder-plus", () => this.pickExternal(true)],
      ["Attach image", "image", () => this.pickImage()],
    ];
    const popover = openablePopover({
      anchor: btn,
      pop,
      wrap,
      onOpen: () => {
        pop.empty();
        for (const [label, icon, run] of items) {
          const row = pop.createDiv({ cls: "mva-sel-opt" });
          setIcon(row.createSpan({ cls: "mva-attach-ico" }), icon);
          row.createSpan({ text: label });
          clickable(row, () => {
            popover.close();
            run();
          });
        }
      },
      focus: () => pop.querySelector<HTMLElement>(".mva-sel-opt")?.focus(),
    });
    clickable(btn, (e) => {
      e.stopPropagation();
      popover.toggle();
    });
    this.host.register(() => popover.close());
  }

  /** Electron file picker for images → reuses the paste/drop attachment path. */
  private pickImage(): void {
    const input = createEl("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      if (files.length) void this.attachImages(files);
    };
    input.click();
  }

  /** Electron file picker for paths OUTSIDE the vault. A hidden <input type=file>
   *  is enough: `webUtils.getPathForFile` resolves the absolute path (Electron 32+
   *  dropped `File.path`). Folder mode uses webkitdirectory and derives the folder
   *  root from the first entry's path minus its relative suffix. */
  private pickExternal(directory: boolean): void {
    const input = createEl("input");
    input.type = "file";
    if (directory) input.webkitdirectory = true;
    else input.multiple = true;
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      if (!files.length) return;
      if (directory) {
        const root = pickedFolderRoot(files[0]);
        if (root) this.addExternalPath(root);
      } else {
        for (const p of files.map(filePath)) if (p) this.addExternalPath(p);
      }
    };
    input.click();
  }

  private addExternalPath(p: string): void {
    if (!this.manualAttached.includes(p)) this.manualAttached.push(p);
    this.refreshContext();
  }

  /** Absolute (out-of-vault) context path? Vault attachments are vault-relative. */
  private static isExternalPath(p: string): boolean {
    return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
  }

  /** A uniform context card: text thumbnail + title + kind ("Current Document" /
   *  "Document" / "External"). External (absolute) paths open via the OS. A
   *  "suggested" card is the active note hidden behind the chat: not sent until
   *  clicked, which attaches it. */
  /** One context card: each kind (current, suggested, manual) declares its own
   *  label and click/remove behaviour at the call site. */
  private renderContextCard(
    parent: HTMLElement,
    path: string,
    spec: { label: string; suggested?: boolean; onClick: () => void; onRemove: () => void }
  ): void {
    const external = Composer.isExternalPath(path);
    const card = parent.createDiv({ cls: spec.suggested ? "mva-doc-card is-suggested" : "mva-doc-card" });
    const thumb = card.createDiv({ cls: "mva-doc-thumb" });
    if (external) {
      thumb.addClass("is-icon");
      let isDir = false;
      try {
        isDir = statSync(path).isDirectory();
      } catch {
        /* unreadable — treat as file */
      }
      setIcon(thumb, isDir ? "folder" : "file");
    } else {
      void fillThumb(this.app, thumb, path);
    }
    const body = card.createDiv({ cls: "mva-doc-body" });
    body.createDiv({ cls: "mva-doc-title", text: noteBasename(path), attr: { title: path } });
    body.createDiv({ cls: "mva-doc-kind", text: spec.label });
    const x = card.createSpan({ cls: "mva-doc-x", attr: { "aria-label": "Remove from context" } });
    setIcon(x, "x");
    clickable(x, (e) => {
      e.stopPropagation();
      spec.onRemove();
    });
    clickable(card, () => spec.onClick());
  }

  private pickNote(): void {
    new NotePicker(this.app, (f) => {
      if (!this.manualAttached.includes(f.path)) this.manualAttached.push(f.path);
      this.refreshContext();
    }).open();
  }

  /** Grow the textarea with its content, up to a cap: 200px collapsed, ~half the
   *  window when expanded. The expand affordance only exists while the content
   *  overflows the collapsed cap; when the text shrinks back (or is cleared on
   *  send) the box auto-collapses — expansion is a per-draft state, never sticky. */
  autoGrow(): void {
    const el = this.inputEl;
    el.setCssStyles({ height: "auto" });
    const overflows = el.scrollHeight > INPUT_CAP + 1;
    if (!overflows) this.setInputExpanded(false);
    const cap = this.inputExpanded ? Math.min(Math.round(window.innerHeight * 0.5), INPUT_CAP_EXPANDED) : INPUT_CAP;
    el.setCssStyles({ height: `${Math.min(el.scrollHeight, cap)}px` });
    this.expandBtn.toggleClass("is-visible", overflows);
  }

  private toggleInputExpand(): void {
    // Animate only the deliberate toggle — keystroke growth stays instant.
    this.inputWrapEl.addClass("is-anim");
    window.setTimeout(() => this.inputWrapEl.removeClass("is-anim"), 220);
    this.setInputExpanded(!this.inputExpanded);
    this.autoGrow();
    this.inputEl.focus();
  }

  private setInputExpanded(v: boolean): void {
    if (this.inputExpanded === v) return;
    this.inputExpanded = v;
    this.inputWrapEl.toggleClass("is-expanded", v);
    setIcon(this.expandBtn, v ? "chevrons-down-up" : "chevrons-up-down");
    this.expandBtn.setAttr("aria-label", v ? "Collapse input" : "Expand input");
  }

  /** Use a custom prompt. A single prompt is inserted into the composer; a
   *  workflow (steps separated by " >>> ") is queued and run in sequence.
   *  {{variables}} across all steps are collected once, then applied to each. */
  usePrompt(promptText: string): void {
    const steps = promptText.split(/\s+>>>\s+/).map((s) => s.trim()).filter(Boolean);
    const vars = extractVars(promptText);
    const run = (values: Record<string, string>) => {
      if (steps.length > 1) {
        // Turn orchestration lives in the view — hand it the resolved steps.
        this.host.submitWorkflow(this.host.active, steps.map((s) => fillVars(s, values)));
      } else {
        this.insertAtComposer(fillVars(promptText, values));
      }
    };
    if (vars.length === 0) {
      run({});
      return;
    }
    new PromptVarsModal(this.app, vars, run).open();
  }

  /** Insert text at the composer's caret (replacing any selection), then focus. */
  private insertAtComposer(text: string): void {
    const el = this.inputEl;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    const caret = start + text.length;
    el.setSelectionRange(caret, caret);
    el.focus();
    this.autoGrow();
  }

  private modelLabel(): string {
    const found = this.host.allModelChoices().find((m) => m.id === this.host.model);
    return found?.label || this.host.model || "Model";
  }
}

/* ---------------------- note picker (multi-attach) ---------------------- */
class NotePicker extends FuzzySuggestModal<TFile> {
  constructor(app: App, private onPick: (f: TFile) => void) {
    super(app);
    this.setPlaceholder("Attach a note to the conversation…");
  }
  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }
  getItemText(f: TFile): string {
    return f.path;
  }
  onChooseItem(f: TFile): void {
    this.onPick(f);
  }
}
