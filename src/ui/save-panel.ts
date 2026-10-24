/**
 * "Save to note" under a turn: pick the note and the section, edit the text,
 * see the block diff, save. The panel only renders and collects; the write,
 * its receipt and its undo belong to `obsidian/note-save`. Reuses the inline
 * diff surface of the governed writes (`.mva-rethink`, `.mva-diff`) and the
 * custom `.mva-sel` control, so it adds no CSS.
 */
import type { App } from "obsidian";
import { formatSaveBlock, planInsert, type Provenance } from "../core/block-patch";
import { buildRecap } from "../core/recap";
import { listSections, sectionIsList, sectionLabel, suggestTargets, type SaveTarget, type SectionRef } from "../core/save-target";
import type { SaveReceipt } from "../core/save-undo";
import { saveToNote, type SaveError } from "../obsidian/note-save";
import type { SaveLog } from "../obsidian/save-log";
import { today } from "../obsidian/tool-kit";
import type { Convo } from "./convo-types";
import { clickable } from "./dom";
import { NotePicker } from "./pickers";
import { openablePopover } from "./popover";
import { mountSaveReceipt } from "./save-receipt";

export interface SavePanelDeps {
  /** The active note, the default target. */
  active: string | null;
  /** Notes the agent read or wrote in this chat, offered after the active one. */
  touched: string[];
  provenance: Provenance;
  /** Note content, or null when the note does not exist yet (it will be created). */
  read: (path: string) => Promise<string | null>;
  /** "Choose note...": open a picker and hand back the chosen path. */
  pick: (onPick: (path: string) => void) => void;
  save: (input: { target: SaveTarget; text: string; provenance: Provenance }) => Promise<SaveReceipt | { error: SaveError }>;
  /** Render the receipt row where the panel was. */
  receipt: (host: HTMLElement, r: SaveReceipt) => void;
}

const noteName = (path: string): string => path.replace(/^.*\//, "").replace(/\.md$/, "");
/** Shown in the preview only; the save draws its own anchor. */
const PREVIEW_ANCHOR = "exo-xxxxxx";

export function renderSavePanel(host: HTMLElement, text: string, deps: SavePanelDeps): { el: HTMLElement; idle: () => Promise<void>; close: () => void } {
  const wrap = host.createDiv({ cls: "mva-rethink" });
  let pending: Promise<void> = Promise.resolve();
  let target: string | null = deps.active;
  let content = "";
  let sections: SectionRef[] = [];
  let section: SectionRef = { kind: "end" };
  let body = text;
  let status = "";
  let saving = false;

  wrap.createSpan({ cls: "mva-rethink-chip", text: "Save to note" });
  const notesRow = wrap.createDiv({ cls: "mva-recap-chips" });
  const hint = wrap.createDiv({ cls: "mva-faint", text: "Open a note or choose one to save into." });
  const sectionRow = wrap.createDiv({ cls: "mva-pv-row" });
  const sel = sectionRow.createDiv({ cls: "mva-sel" });
  const selChip = sel.createDiv({ cls: "mva-sel-chip", attr: { "aria-label": "Section" } });
  const pop = sel.createDiv({ cls: "mva-sel-pop" });
  pop.hide();
  const nameField = sectionRow.createEl("input", { cls: "mva-pv-input", attr: { type: "text", placeholder: "Section name" } });
  nameField.hide();
  const field = wrap.createEl("textarea", { cls: "mva-pv-input", attr: { rows: "4" } });
  field.value = text;
  wrap.createSpan({ cls: "mva-rethink-chip", text: "Preview" });
  const diff = wrap.createDiv({ cls: "mva-diff" });
  const statusEl = wrap.createDiv({ cls: "mva-faint" });
  const actions = wrap.createDiv({ cls: "mva-tool-output-actions" });
  const saveBtn = actions.createSpan({ cls: "mva-btn mva-btn-primary", text: "Save" });
  const cancelBtn = actions.createSpan({ cls: "mva-btn", text: "Cancel" });

  const ready = (): boolean =>
    !saving && !!target && !!body.trim() && (section.kind !== "new" || !!section.heading.trim());

  const setDisabled = (on: boolean) => {
    saveBtn.toggleClass("is-disabled", on);
    saveBtn.setAttribute("aria-disabled", String(on));
  };
  const renderDiff = () => {
    diff.empty();
    statusEl.setText(status || (target && !body.trim() ? "Nothing to save." : ""));
    setDisabled(!ready());
    if (!ready()) return;
    const block = formatSaveBlock(body, deps.provenance, PREVIEW_ANCHOR, sectionIsList(content, section));
    const plan = planInsert(content, section, block);
    if ("error" in plan) return statusEl.setText("Section not found. Pick another.");
    for (const l of plan.diff) diff.createDiv({ cls: `mva-diff-line${l.kind === "add" ? " mva-add" : ""}`, text: l.text });
  };

  const renderSection = () => {
    selChip.setText(sectionLabel(section).replace(/^New section: .*$/, "New section..."));
    if (section.kind === "new") nameField.show();
    else nameField.hide();
  };

  const popover = openablePopover({
    anchor: selChip,
    pop,
    wrap: sel,
    onOpen: () => {
      pop.empty();
      const choices: SectionRef[] = [...sections, { kind: "end" }, { kind: "new", heading: "", level: 2 }];
      for (const ref of choices) {
        const label = ref.kind === "new" ? "New section..." : sectionLabel(ref);
        const opt = pop.createDiv({ cls: "mva-sel-opt" });
        opt.createSpan({ cls: "mva-sel-opt-label", text: label });
        clickable(opt, () => {
          section = ref.kind === "new" ? { ...ref, heading: nameField.value.trim() } : ref;
          status = "";
          popover.close();
          renderSection();
          renderDiff();
        });
      }
    },
  });
  clickable(selChip, (e) => {
    e.stopPropagation();
    popover.toggle();
  });

  const renderNotes = () => {
    notesRow.empty();
    const paths = suggestTargets({ activePath: deps.active, recalled: [], touched: deps.touched });
    if (target && !paths.includes(target)) paths.unshift(target);
    for (const p of paths) {
      const chip = notesRow.createSpan({ cls: "mva-gallery-chip", text: noteName(p) });
      chip.toggleClass("is-active", p === target);
      clickable(chip, () => setTarget(p));
    }
    const choose = notesRow.createSpan({ cls: "mva-gallery-chip", text: "Choose note..." });
    clickable(choose, () => deps.pick((p) => setTarget(p)));
    if (target) {
      hint.hide();
      sectionRow.show();
    } else {
      hint.show();
      sectionRow.hide();
    }
  };

  const load = (path: string): Promise<void> =>
    deps.read(path).then((c) => {
      if (target !== path) return;
      content = c ?? "";
      sections = listSections(content);
      renderDiff();
    });

  function setTarget(path: string): void {
    target = path;
    section = { kind: "end" };
    status = "";
    renderNotes();
    renderSection();
    pending = load(path);
  }

  nameField.addEventListener("input", () => {
    if (section.kind === "new") section = { ...section, heading: nameField.value.trim() };
    renderDiff();
  });
  field.addEventListener("input", () => {
    body = field.value;
    status = "";
    renderDiff();
  });
  const close = () => {
    popover.close();
    wrap.remove();
  };
  clickable(cancelBtn, close);
  clickable(saveBtn, () => {
    if (!ready() || !target) return;
    const input = { target: { path: target, section }, text: body, provenance: deps.provenance };
    saving = true;
    setDisabled(true);
    pending = deps.save(input).then((r) => {
      if ("error" in r) {
        saving = false;
        status = r.error === "nothing-to-save" ? "Nothing to save." : "Section not found. Pick another.";
        return target ? load(target) : undefined;
      }
      close();
      deps.receipt(host, r);
    }, () => {
      saving = false;
      status = "Couldn't save to this note.";
      renderDiff();
    });
  });

  renderNotes();
  renderSection();
  if (target) setTarget(target);
  else renderDiff();
  return { el: wrap, idle: () => pending, close };
}

const open = new WeakMap<HTMLElement, { el: HTMLElement; close: () => void }>();

/** The selected text inside `turnEl`, trimmed, or "". */
function selectionIn(turnEl: HTMLElement): string {
  const s = window.getSelection();
  return s && !s.isCollapsed && turnEl.contains(s.anchorNode) ? s.toString().trim() : "";
}

/** The turn's "Save to note" control: toggles the panel under `turnEl`, the
 *  text prefilled with the selection inside the answer, else the whole answer.
 *  The provenance link points at the turn's message (`data-msg`); a turn not
 *  stored yet points at the next one. */
export function bindSaveToNote(control: HTMLElement, app: App, log: SaveLog, turnEl: HTMLElement, answer: string, convo: Convo, rel: (p: string) => string): void {
  let pressed = "";
  // A mouse press collapses the selection before the click: read it first.
  control.addEventListener("mousedown", () => {
    pressed = selectionIn(turnEl);
  });
  clickable(control, () => {
    // From the keyboard the selection is still there when the panel opens.
    const picked = selectionIn(turnEl) || pressed;
    pressed = "";
    const prev = open.get(turnEl);
    open.delete(turnEl);
    if (prev?.el.isConnected) return prev.close();
    const recap = buildRecap(convo.messages, rel);
    const touched = [...recap.written.map((w) => w.path), ...recap.read];
    const msg = turnEl.dataset.msg;
    const panel = renderSavePanel(turnEl, picked || answer, {
      active: app.workspace.getActiveFile()?.path ?? null,
      touched,
      provenance: { convoId: convo.id, msgIndex: msg ? Number(msg) : convo.messages.length, chatTitle: convo.title, date: today() },
      read: async (p) => {
        const f = app.vault.getFileByPath(p);
        return f ? app.vault.cachedRead(f) : null;
      },
      pick: (on) => new NotePicker(app, on).open(),
      save: (input) => saveToNote(app, log, input),
      receipt: (el, r) => mountSaveReceipt(app, log, el, r),
    });
    open.set(turnEl, panel);
  });
}
