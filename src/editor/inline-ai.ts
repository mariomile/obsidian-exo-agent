/**
 * In-note AI ("Inline AI") — a CodeMirror 6 extension that brings Exo into the
 * markdown editor. Selecting text raises a floating toolbar over the selection
 * with formatting actions (ported from Selection Sidekick) plus three AI
 * actions:
 *
 *   • format   — bold/italic/headings/lists/links, icon-only, keep-selection.
 *   • Edit     — rewrite the selection, reviewed as an INLINE diff in the
 *                document (old text dimmed/struck in place, new text green
 *                inline) with per-hunk ✓/✗ + keyboard; committed as one
 *                undoable transaction.
 *   • Continue — keep writing from the end of the selection, rendered as a green
 *                inline insertion you accept/reject the same way.
 *   • Ask Exo  — reveal the chat and seed the selection as quoted context.
 *
 * Design (v2 — see PRODUCT.md / the plan):
 *   - The rewrite is NON-DESTRUCTIVE: while streaming and while reviewing, the
 *     document is untouched. The diff is rendered by the CM6 decoration layer in
 *     `editor/inline-diff.ts` (a `StateField<InlineDiff|null>`), and committed
 *     exactly once — on Accept — via `commitInlineDiff` (a single undo step).
 *   - SOFT-LOCK: the target range is soft-locked during streaming and review.
 *     Editing elsewhere in the note is fine (offsets are mapped through the
 *     changes); editing the target range aborts the op (during streaming the
 *     controller aborts; during review the field self-clears and the controller
 *     tears its chrome down on the next update).
 *   - Chrome is minimal DOM anchored via `coordsAtPos`, appended to
 *     `document.body` (position:fixed) so it escapes editor overflow: the
 *     toolbar, the Edit instruction input, a live "rewriting…" stream chip, and
 *     a compact review action bar (Accept all / Reject + a keyboard hint). The
 *     per-hunk ✓/✗ controls live INLINE in the decoration layer.
 *
 * All pure logic (prompts, hunks, doc-range mapping, nav) lives in
 * `core/inline-ai` and is unit-tested; this file is the DOM/CM6 shell and is
 * intentionally not unit-tested.
 */
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { MarkdownView, setIcon } from "obsidian";
import type ExoPlugin from "../main";
import { computeHunks, hunkCount, type DiffPart } from "../core/inline-ai";
import { isComposingKey } from "../core/ime";
import { COMMANDS } from "./format/registry";
import { applyFormatCommand } from "./format-commands";
import { editorForView } from "./format/resolve-editor";
import {
  activeDiff,
  clearDiff,
  commitInlineDiff,
  inlineDiffExtension,
  setAllHunks,
  setDiff,
} from "./inline-diff";

/** Max chars of preceding context fed to Continue (keeps the call cheap/fast). */
const CONTINUE_CONTEXT_CHARS = 2000;

type Phase = "idle" | "edit-input" | "streaming" | "reviewing" | "error";

/** Per-editor controller: owns the floating toolbar, the instruction input, the
 *  live stream chip, and the review action bar for one CodeMirror view. The
 *  inline diff itself is owned by the `inlineDiffField` in `inline-diff.ts`. */
class InlineAiController {
  private bar: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private streamChip: HTMLElement | null = null;
  private actionBar: HTMLElement | null = null;
  private abort: AbortController | null = null;
  private phase: Phase = "idle";
  /** The selection the toolbar is anchored to (doc offsets); drives repositioning
   *  while the bar is up. Actions read the LIVE selection at click time, not this. */
  private barRange: { from: number; to: number } | null = null;
  /** Format buttons currently in the bar, so we can refresh `.is-active` without rebuild. */
  private formatButtons = new Map<string, HTMLElement>();
  /** The target range the current op operates on (doc offsets). Soft-locked while
   *  streaming/reviewing; mapped through edits made elsewhere. */
  private range: { from: number; to: number } | null = null;
  private readonly onScroll = () => this.reposition();

  constructor(
    private view: EditorView,
    private plugin: ExoPlugin
  ) {
    this.view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    window.addEventListener("scroll", this.onScroll, { passive: true, capture: true });
    window.addEventListener("resize", this.onScroll, { passive: true });
  }

  /** Format buttons always ship (they replace Selection Sidekick). AI actions
   *  stay behind the existing `inlineAi` toggle. */
  private get aiEnabled(): boolean {
    return this.plugin.settings.inlineAi;
  }

  update(u: ViewUpdate): void {
    if (!this.aiEnabled && (this.panel || this.streamChip || this.phase === "reviewing")) {
      this.cancel();
    }
    // Review mode: the decoration field owns range-mapping and self-clears when
    // the target range is edited. We only follow it: reposition the action bar,
    // or tear our chrome down if the field has cleared (edited/committed/escaped).
    if (this.phase === "reviewing") {
      if (!activeDiff(this.view)) this.teardownReview();
      else this.reposition();
      return;
    }
    // Streaming / edit-input / error: soft-lock the target range. Edits elsewhere
    // are fine (map the range and follow); editing the target range aborts.
    if (u.docChanged && (this.panel || this.streamChip)) {
      if (this.mapOrAbort(u)) return;
      this.reposition();
      return;
    }
    // Otherwise (re)evaluate the toolbar for the current selection.
    if (!this.panel && !this.streamChip && (u.selectionSet || u.docChanged || u.focusChanged)) {
      this.syncToolbar();
    }
  }

  /** Map the soft-locked range through this update's changes; abort if the
   *  target range itself was touched. Returns true if it aborted. */
  private mapOrAbort(u: ViewUpdate): boolean {
    if (!this.range) return false;
    const { from, to } = this.range;
    let touched = false;
    u.changes.iterChanges((fromA, toA) => {
      if (fromA < to && toA > from) touched = true;
    });
    if (touched) {
      this.cancel();
      return true;
    }
    this.range = { from: u.changes.mapPos(from, 1), to: u.changes.mapPos(to, -1) };
    return false;
  }

  /* ------------------------------- toolbar ------------------------------- */

  private syncToolbar(): void {
    const sel = this.view.state.selection.main;
    if (sel.empty || !this.view.hasFocus) {
      this.removeBar();
      return;
    }
    this.barRange = { from: sel.from, to: sel.to };
    // Reuse the existing bar (just reposition) so a drag-select doesn't rebuild
    // and re-flash the entrance on every tick. Actions read the live selection.
    if (this.bar) {
      this.refreshFormatActive();
      this.placeAbove(this.bar, sel.from);
      return;
    }
    this.showToolbar(sel.from);
  }

  private showToolbar(anchor: number): void {
    const bar = document.body.createDiv({ cls: "mva-inai-bar" });
    this.formatButtons.clear();
    const editor = editorForView(this.plugin.app, this.view);
    if (editor) {
      let prevGroup: string | null = null;
      for (const cmd of COMMANDS) {
        if (prevGroup && cmd.group !== prevGroup) this.addSep(bar);
        prevGroup = cmd.group;
        const btn = this.mkBtn(bar, cmd.label, cmd.icon, () => {
          const live = editorForView(this.plugin.app, this.view);
          if (!live) return;
          applyFormatCommand(this.plugin, cmd, live);
          this.refreshFormatActive();
        }, true);
        this.formatButtons.set(cmd.id, btn);
      }
      this.refreshFormatActive();
    }
    if (this.aiEnabled) {
      if (editor) this.addSep(bar);
      this.mkBtn(bar, "Edit", "wand-2", () => this.startEdit());
      this.mkBtn(bar, "Continue", "pen-line", () => this.startContinue());
      this.mkBtn(bar, "Ask Exo", "message-square", () => this.askExo());
    }
    bar.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.removeBar();
        this.view.focus();
      }
    });
    this.bar = bar;
    this.placeAbove(bar, anchor);
    window.requestAnimationFrame(() => bar.addClass("is-shown"));
  }

  /** preventDefault on mousedown so the click does not steal focus and collapse
   *  the selection before the action runs. */
  private mkBtn(
    parent: HTMLElement,
    label: string,
    icon: string,
    run: () => void,
    iconOnly = false,
  ): HTMLElement {
    const btn = parent.createEl("button", {
      cls: iconOnly ? "mva-inai-btn is-icon" : "mva-inai-btn",
      attr: { "aria-label": label, title: label },
    });
    setIcon(btn.createSpan({ cls: "mva-inai-ico" }), icon);
    if (!iconOnly) btn.createSpan({ text: label });
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      run();
    });
    return btn;
  }

  private addSep(parent: HTMLElement): void {
    parent.createDiv({ cls: "mva-inai-sep" });
  }

  private refreshFormatActive(): void {
    const editor = editorForView(this.plugin.app, this.view);
    if (!editor) return;
    for (const cmd of COMMANDS) {
      const btn = this.formatButtons.get(cmd.id);
      if (btn) btn.toggleClass("is-active", !!cmd.isActive?.(editor));
    }
  }

  private removeBar(): void {
    this.bar?.remove();
    this.bar = null;
    this.barRange = null;
    this.formatButtons.clear();
  }

  /** Live selection at action time, or null if it collapsed. */
  private liveSelection(): { from: number; to: number } | null {
    const sel = this.view.state.selection.main;
    return sel.empty ? null : { from: sel.from, to: sel.to };
  }

  /* ------------------------------- actions ------------------------------- */

  private startEdit(): void {
    const sel = this.liveSelection();
    if (!sel) return;
    const { from, to } = sel;
    this.removeBar();
    this.range = { from, to };
    this.phase = "edit-input";
    const panel = this.openPanel(to);
    const input = panel.createEl("textarea", {
      cls: "mva-inai-input",
      attr: { rows: "1", placeholder: "How should Exo edit this? (⏎ to run, esc to cancel)" },
    });
    const actions = panel.createDiv({ cls: "mva-inai-actions" });
    const runBtn = actions.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Edit" });
    const cancelBtn = actions.createEl("button", { cls: "mva-btn", text: "Cancel" });
    cancelBtn.onclick = () => this.cancel();
    const go = () => {
      const instruction = input.value.trim();
      if (!instruction) return;
      void this.runEdit(instruction);
    };
    runBtn.onclick = go;
    input.addEventListener("input", () => this.autosize(input));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !isComposingKey(e)) {
        e.preventDefault();
        go();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.cancel();
      }
    });
    window.setTimeout(() => input.focus(), 0);
  }

  private async runEdit(instruction: string): Promise<void> {
    if (!this.range) return;
    const { from, to } = this.range;
    const original = this.view.state.doc.sliceString(from, to);
    this.removePanel();
    this.phase = "streaming";
    const chip = this.renderStreamChip(to, "Rewriting…");
    this.abort = new AbortController();
    let live = "";
    try {
      const result = await this.plugin.oneShotStream(instruction, original, this.abort.signal, (d) => {
        live += d;
        chip.setText(live);
        this.reposition();
      });
      if (this.abort.signal.aborted) return;
      // this.range may have been mapped by edits elsewhere while streaming.
      const r = this.range;
      if (!r) return;
      this.enterReview(r.from, r.to, original, result.trim() || original);
    } catch (err) {
      if (!this.abort?.signal.aborted) this.renderError(err);
    }
  }

  private startContinue(): void {
    const sel = this.liveSelection();
    if (!sel) return;
    this.removeBar();
    this.range = { from: sel.to, to: sel.to };
    void this.runContinue(sel.to);
  }

  private async runContinue(at: number): Promise<void> {
    const doc = this.view.state.doc;
    const preceding = doc.sliceString(Math.max(0, at - CONTINUE_CONTEXT_CHARS), at);
    this.phase = "streaming";
    const chip = this.renderStreamChip(at, "Writing…");
    this.abort = new AbortController();
    let live = "";
    try {
      const result = await this.plugin.continueStream(preceding, this.abort.signal, (d) => {
        live += d;
        chip.setText(live);
        this.reposition();
      });
      if (this.abort.signal.aborted) return;
      const r = this.range;
      if (!r) return;
      this.enterContinueReview(r.to, result.trimEnd());
    } catch (err) {
      if (!this.abort?.signal.aborted) this.renderError(err);
    }
  }

  private askExo(): void {
    const sel = this.liveSelection();
    if (!sel) return;
    const text = this.view.state.doc.sliceString(sel.from, sel.to);
    this.removeBar();
    const path = this.plugin.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? "";
    void this.plugin.attachSelectionToChat(text, path);
  }

  /* ------------------------------- review -------------------------------- */

  /** Enter Edit review: compute the hunked diff and hand it to the decoration
   *  field. A no-op rewrite (no hunks) just tears down. */
  private enterReview(from: number, to: number, original: string, revised: string): void {
    const parts = computeHunks(original, revised);
    this.removeStreamChip();
    if (hunkCount(parts) === 0) {
      this.teardownAll();
      this.view.focus();
      return;
    }
    this.phase = "reviewing";
    // Collapse the selection so its highlight doesn't cover the inline diff.
    this.view.dispatch({ effects: setDiff.of({ from, to, parts }), selection: { anchor: from } });
    this.showActionBar(to);
    this.view.focus();
  }

  /** Enter Continue review: a one-hunk pure insertion (`before:""`) at `at`, so
   *  it renders as a green inline insertion with the same accept/commit path. */
  private enterContinueReview(at: number, continuation: string): void {
    this.removeStreamChip();
    if (!continuation) {
      this.renderError(new Error("Nothing to continue."));
      return;
    }
    const parts: DiffPart[] = [{ kind: "hunk", index: 0, before: "", after: continuation }];
    this.phase = "reviewing";
    this.range = { from: at, to: at };
    this.view.dispatch({ effects: setDiff.of({ from: at, to: at, parts }), selection: { anchor: at } });
    this.showActionBar(at);
    this.view.focus();
  }

  /** The compact review action bar (Accept all / Reject + keyboard hint). The
   *  per-hunk ✓/✗ controls live inline in the decoration layer. */
  private showActionBar(pos: number): void {
    this.removeActionBar();
    const bar = document.body.createDiv({ cls: "mva-inai-actionbar" });
    const accept = bar.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Accept all" });
    accept.onclick = () => this.acceptAllReview();
    const reject = bar.createEl("button", { cls: "mva-btn mva-btn-danger", text: "Reject" });
    reject.onclick = () => this.rejectReview();
    bar.createSpan({ cls: "mva-inai-hint", text: "Tab · y/n · ⌘⏎" });
    this.actionBar = bar;
    this.placeBelow(bar, pos);
    window.requestAnimationFrame(() => bar.addClass("is-shown"));
  }

  private acceptAllReview(): void {
    this.view.dispatch({ effects: setAllHunks.of(true) });
    commitInlineDiff(this.view); // single doc-changing transaction → field clears
    this.teardownReview();
    this.view.focus();
  }

  private rejectReview(): void {
    if (activeDiff(this.view)) this.view.dispatch({ effects: clearDiff.of(null) });
    this.teardownReview();
    this.view.focus();
  }

  private teardownReview(): void {
    this.removeActionBar();
    this.phase = "idle";
    this.range = null;
  }

  /* ------------------------------ rendering ------------------------------ */

  /** Open (or reset) the anchored panel below `pos` and return its body. Used by
   *  the Edit instruction input and the error state. */
  private openPanel(pos: number): HTMLElement {
    this.removePanel();
    const panel = document.body.createDiv({ cls: "mva-inai-panel" });
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.cancel();
      }
    });
    this.panel = panel;
    this.placeBelow(panel, pos);
    window.requestAnimationFrame(() => panel.addClass("is-shown"));
    return panel;
  }

  /** The live "rewriting…" chip anchored at the selection end: a spinner + label
   *  and the growing green text. Returns a `setText` to update it in place. */
  private renderStreamChip(pos: number, label: string): { setText: (t: string) => void } {
    this.removeStreamChip();
    const chip = document.body.createDiv({ cls: "mva-inai-streamchip" });
    const head = chip.createDiv({ cls: "mva-inai-head" });
    setIcon(head.createSpan({ cls: "mva-inai-spin" }), "loader-2");
    head.createSpan({ text: label });
    const body = chip.createDiv({ cls: "mva-inai-streamtext" });
    const actions = chip.createDiv({ cls: "mva-inai-actions" });
    const stop = actions.createEl("button", { cls: "mva-btn", text: "Stop" });
    stop.onclick = () => this.cancel();
    this.streamChip = chip;
    this.placeBelow(chip, pos);
    window.requestAnimationFrame(() => chip.addClass("is-shown"));
    return {
      setText: (t: string) => {
        body.textContent = t;
      },
    };
  }

  private renderError(err: unknown): void {
    this.removeStreamChip();
    this.phase = "error";
    const pos = this.range?.to ?? this.view.state.selection.main.to;
    const panel = this.openPanel(pos);
    panel.createDiv({
      cls: "mva-inai-error",
      text: `Inline AI failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    const actions = panel.createDiv({ cls: "mva-inai-actions" });
    const dismiss = actions.createEl("button", { cls: "mva-btn", text: "Dismiss" });
    dismiss.onclick = () => this.cancel();
    this.reposition();
  }

  /* ------------------------------ lifecycle ------------------------------ */

  /** Abort any stream, drop all chrome + any diff, restore the original
   *  selection. Used by Stop, Cancel, Dismiss, and the streaming soft-lock. */
  private cancel(): void {
    this.abort?.abort();
    this.abort = null;
    const r = this.range;
    this.teardownAll();
    if (r) {
      try {
        this.view.dispatch({ selection: { anchor: r.from, head: r.to } });
      } catch {
        /* doc shrank under us — ignore */
      }
    }
    this.view.focus();
  }

  private removePanel(): void {
    this.panel?.remove();
    this.panel = null;
  }

  private removeStreamChip(): void {
    this.streamChip?.remove();
    this.streamChip = null;
  }

  private removeActionBar(): void {
    this.actionBar?.remove();
    this.actionBar = null;
  }

  private teardownAll(): void {
    this.abort?.abort();
    this.abort = null;
    this.removeBar();
    this.removePanel();
    this.removeStreamChip();
    this.removeActionBar();
    if (activeDiff(this.view)) {
      try {
        this.view.dispatch({ effects: clearDiff.of(null) });
      } catch {
        /* view torn down — ignore */
      }
    }
    this.phase = "idle";
    this.range = null;
  }

  destroy(): void {
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    window.removeEventListener("scroll", this.onScroll, { capture: true });
    window.removeEventListener("resize", this.onScroll);
    this.teardownAll();
  }

  /* ----------------------------- positioning ----------------------------- */

  private reposition(): void {
    if (this.bar && this.barRange) this.placeAbove(this.bar, this.barRange.from);
    if (this.panel && this.range) this.placeBelow(this.panel, this.range.to);
    if (this.streamChip && this.range) this.placeBelow(this.streamChip, this.range.to);
    if (this.actionBar) {
      const d = activeDiff(this.view);
      if (d) this.placeBelow(this.actionBar, d.to);
    }
  }

  /** Anchor an element above `pos` (the toolbar). Fixed coords from CM; the
   *  element's own CSS transform lifts it above the line. Hidden if scrolled off. */
  private placeAbove(el: HTMLElement, pos: number): void {
    const c = this.view.coordsAtPos(pos);
    if (!c) {
      el.addClass("is-off");
      return;
    }
    el.removeClass("is-off");
    const left = Math.max(8, Math.min(c.left, window.innerWidth - el.offsetWidth - 8));
    el.style.left = `${left}px`;
    el.style.top = `${c.top}px`;
  }

  /** Anchor an element just below `pos`, so the selection stays visible above it.
   *  Clamped to the viewport. */
  private placeBelow(el: HTMLElement, pos: number): void {
    const c = this.view.coordsAtPos(pos);
    if (!c) {
      el.addClass("is-off");
      return;
    }
    el.removeClass("is-off");
    const left = Math.max(8, Math.min(c.left, window.innerWidth - el.offsetWidth - 8));
    el.style.left = `${left}px`;
    el.style.top = `${c.bottom + 6}px`;
  }

  private autosize(el: HTMLTextAreaElement): void {
    el.setCssStyles({ height: "auto" });
    el.setCssStyles({ height: `${Math.min(el.scrollHeight, 140)}px` });
    this.reposition();
  }
}

/** The registerable CodeMirror 6 extension: the controller's ViewPlugin bundled
 *  with the inline-diff decoration layer (field + keymap). Gated live behind
 *  `settings.inlineAi` for the AI actions only; formatting always shows. */
export function inlineAiExtension(plugin: ExoPlugin) {
  return [
    ViewPlugin.fromClass(
      class {
        private ctrl: InlineAiController;
        constructor(view: EditorView) {
          this.ctrl = new InlineAiController(view, plugin);
        }
        update(u: ViewUpdate): void {
          this.ctrl.update(u);
        }
        destroy(): void {
          this.ctrl.destroy();
        }
      }
    ),
    inlineDiffExtension(),
  ];
}
