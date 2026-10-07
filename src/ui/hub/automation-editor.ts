/**
 * Automation editor — the in-hub form behind every card.
 *
 * The md file is the source of truth; this form exists so nobody ever has to
 * hand-edit it. Edits happen on a DRAFT copy and land on Save (a file write),
 * so closing without saving loses nothing and a half-typed schedule never
 * fires. `editingState` is module-level because the hub re-renders wholesale
 * on every action — the flag is what survives the re-render, not the DOM.
 *
 * Form language: the canonical recipe — `.mva-pv` fields, chip + `.mva-sel-pop`
 * popovers (never a native <select>), `.mva-btn` buttons, lucide icons only.
 */
import { Notice, setIcon } from "obsidian";
import { clickable } from "../dom";
import { openablePopover } from "../popover";
import { formatDuration, parseDuration } from "../../core/agents";
import {
  DEFAULT_AUTOMATION_COOLDOWN_MS,
  formatWhen,
  parseWhen,
  validateAutomation,
  whenSentence,
  type Automation,
  type AutomationMode,
  type AutomationWhen,
} from "../../core/automation-model";
import { automationSlug } from "../../obsidian/automation-store";
import { archiveAutomation, duplicate } from "./automation-actions";
import { renderMcpField } from "./automation-mcp-field";
import type { HubTabContext } from "./shared";

/** What the tab consults before rendering: are we editing, and what. */
export const editingState: { active: boolean; slug: string | null } = { active: false, slug: null };

/** Curated lucide set — enough range to tell automations apart at a glance,
 *  small enough that picking one is a decision, not a search. */
const AUTOMATION_ICONS = [
  "zap", "inbox", "calendar-check", "sun", "moon", "activity", "shield-check",
  "sparkles", "brain", "notebook-pen", "folder-sync", "tags", "link-2",
  "search-check", "list-checks", "mail", "rss", "trending-up", "archive",
  "broom", "compass", "heart-pulse", "layers", "watch",
] as const;

const MODE_CHOICES: readonly { value: AutomationMode; label: string; hint: string }[] = [
  { value: "report", label: "Report", hint: "Reads the vault, writes only a report note." },
  { value: "propose", label: "Propose", hint: "Records loops and decisions directly. Tasks and playbooks wait until you accept them." },
  { value: "act", label: "Act", hint: "Edits notes directly. Every run is snapshotted and restorable." },
];

export function openAutomationEditor(host: HTMLElement, ctx: HubTabContext): void {
  const store = ctx.plugin.automationStore;
  const existing = editingState.slug ? store.get(editingState.slug) : null;
  const draft: Automation = existing
    ? { ...existing, when: existing.when.map((w) => ({ ...w })), scope: [...existing.scope], ...(existing.mcp ? { mcp: [...existing.mcp] } : {}) }
    : {
        slug: "",
        name: "",
        description: "",
        icon: "zap",
        when: [{ on: "schedule", cadence: { kind: "daily", hour: 7 } }],
        mode: "report",
        scope: [],
        canCall: [],
        cooldownMs: DEFAULT_AUTOMATION_COOLDOWN_MS,
        enabled: true,
        prompt: "",
      };

  const close = () => {
    editingState.active = false;
    editingState.slug = null;
    ctx.rerender();
  };

  const pane = host.createDiv({ cls: "mva-auto2-editor" });

  // ── header: back · icon · title ────────────────────────────────────────
  const head = pane.createDiv({ cls: "mva-auto2-ed-head" });
  const back = head.createDiv({ cls: "mva-ag-action", attr: { "aria-label": "Back", role: "button", tabindex: "0" } });
  setIcon(back, "arrow-left");
  clickable(back, close);

  const iconBtn = head.createDiv({ cls: "mva-auto2-icon is-pick", attr: { "aria-label": "Icon", role: "button", tabindex: "0" } });
  const syncIcon = () => {
    iconBtn.empty();
    setIcon(iconBtn, draft.icon);
  };
  syncIcon();
  const iconWrap = head.createDiv({ cls: "mva-sel" });
  const iconPop = iconWrap.createDiv({ cls: "mva-sel-pop mva-auto2-iconpop" });
  iconPop.hide();
  const iconPopover = openablePopover({
    anchor: iconBtn,
    pop: iconPop,
    wrap: iconWrap,
    onOpen: () => {
      iconPop.empty();
      for (const id of AUTOMATION_ICONS) {
        const cell = iconPop.createDiv({ cls: "mva-auto2-iconcell", attr: { "aria-label": id, role: "button", tabindex: "0" } });
        cell.toggleClass("is-current", id === draft.icon);
        setIcon(cell, id);
        clickable(cell, () => {
          draft.icon = id;
          syncIcon();
          iconPopover.close();
        });
      }
    },
    focus: () => iconPop.querySelector<HTMLElement>(".is-current")?.focus(),
  });
  clickable(iconBtn, (e) => {
    e.stopPropagation();
    iconPopover.toggle();
  });

  head.createDiv({ cls: "mva-auto2-ed-title", text: existing ? "Edit automation" : "New automation" });
  head.createDiv({ cls: "mva-auto-spacer" });
  if (existing) {
    const dup = head.createEl("button", { cls: "mva-btn", text: "Duplicate" });
    dup.onclick = () => {
      dup.setAttr("disabled", "true");
      void duplicate(ctx.plugin, existing).then((copy) => {
        new Notice(`Saved "${copy.name}", paused.`);
        editingState.slug = copy.slug;
        ctx.rerender();
      });
    };
    const open = head.createEl("button", { cls: "mva-btn", text: "Open note" });
    open.onclick = () => void ctx.app.workspace.openLinkText(store.filePath(existing.slug), "", "tab");
  }

  // ── name + description ────────────────────────────────────────────────
  const field = (label: string): HTMLElement => {
    const f = pane.createDiv({ cls: "mva-pv mva-auto2-field" });
    f.createDiv({ cls: "mva-pv-label", text: label });
    return f;
  };

  const nameField = field("Name");
  const name = nameField.createEl("input", { cls: "mva-pv-input", attr: { type: "text", placeholder: "Inbox Triager" } });
  name.value = draft.name;
  name.oninput = () => (draft.name = name.value);

  const descField = field("What it does — one line, for future you");
  const desc = descField.createEl("input", { cls: "mva-pv-input", attr: { type: "text", placeholder: "Files new inbox notes to their Object-OS home" } });
  desc.value = draft.description;
  desc.oninput = () => (draft.description = desc.value);

  // ── when ──────────────────────────────────────────────────────────────
  const whenField = field("When it runs");
  const whenList = whenField.createDiv({ cls: "mva-auto2-whens" });
  const preview = whenField.createDiv({ cls: "mva-auto2-preview" });
  const syncPreview = () => {
    preview.setText(draft.when.length ? draft.when.map(whenSentence).join(" · ") : "Never — add a schedule or a trigger.");
  };
  const renderWhens = () => {
    whenList.empty();
    draft.when.forEach((w, i) => {
      const row = whenList.createDiv({ cls: "mva-auto2-whenrow" });
      whenPicker(row, w, (next) => {
        if (next) draft.when[i] = next;
        else draft.when.splice(i, 1);
        renderWhens();
      });
    });
    const add = whenList.createDiv({ cls: "mva-auto2-whenrow" });
    whenPicker(add, null, (next) => {
      if (next) draft.when.push(next);
      renderWhens();
    });
    syncPreview();
  };
  renderWhens();

  // ── permissions ───────────────────────────────────────────────────────
  const modeField = field("What it may do");
  const modes = modeField.createDiv({ cls: "mva-auto2-modes" });
  let scopeBox: HTMLElement | null = null;
  const renderScope = () => {
    scopeBox?.remove();
    scopeBox = null;
    if (draft.mode === "report") return;
    scopeBox = modeField.createDiv({ cls: "mva-auto2-scope" });
    scopeBox.createDiv({ cls: "mva-pv-label", text: "Folders it may write in, comma-separated" });
    const input = scopeBox.createEl("input", {
      cls: "mva-pv-input",
      attr: { type: "text", placeholder: "_inbox, Atlas, Active" },
    });
    input.value = draft.scope.map((g) => g.replace(/\/\*\*$/, "")).join(", ");
    input.oninput = () => {
      draft.scope = input.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => (s.includes("*") ? s : `${s.replace(/\/+$/, "")}/**`));
    };
  };
  const renderModes = () => {
    modes.empty();
    for (const c of MODE_CHOICES) {
      const card = modes.createDiv({ cls: "mva-auto2-mode", attr: { role: "button", tabindex: "0" } });
      card.toggleClass("is-current", draft.mode === c.value);
      card.createDiv({ cls: "mva-auto2-mode-label", text: c.label });
      card.createDiv({ cls: "mva-auto2-mode-hint", text: c.hint });
      clickable(card, () => {
        draft.mode = c.value;
        renderModes();
        renderScope();
      });
    }
  };
  renderModes();
  renderScope();

  // ── agent binding ─────────────────────────────────────────────────────
  const agentField = field("Run through an agent (optional)");
  const agents = ctx.plugin.agentStore.isLoaded() ? ctx.plugin.agentStore.list() : [];
  const agentChipWrap = agentField.createDiv({ cls: "mva-sel" });
  const agentChip = agentChipWrap.createDiv({ cls: "mva-sel-chip", attr: { "aria-label": "Agent" } });
  const syncAgentChip = () => agentChip.setText(draft.agent ?? "None — the prompt below is the whole brief");
  syncAgentChip();
  const agentPop = agentChipWrap.createDiv({ cls: "mva-sel-pop" });
  agentPop.hide();
  const agentPopover = openablePopover({
    anchor: agentChip,
    pop: agentPop,
    wrap: agentChipWrap,
    onOpen: () => {
      agentPop.empty();
      const none = agentPop.createDiv({ cls: "mva-sel-opt", attr: { tabindex: "0" } });
      const noneDot = none.createSpan({ cls: "mva-sel-opt-dot" });
      if (!draft.agent) setIcon(noneDot, "check");
      none.createSpan({ text: "None" });
      clickable(none, () => {
        draft.agent = undefined;
        syncAgentChip();
        agentPopover.close();
      });
      for (const def of agents) {
        const opt = agentPop.createDiv({ cls: "mva-sel-opt mva-sel-opt-tall", attr: { tabindex: "0" } });
        const dot = opt.createSpan({ cls: "mva-sel-opt-dot" });
        if (draft.agent === def.brain.slug) setIcon(dot, "check");
        const text = opt.createDiv({ cls: "mva-sel-opt-text" });
        text.createDiv({ text: def.brain.name });
        if (def.brain.description) text.createDiv({ cls: "mva-sel-opt-hint", text: def.brain.description });
        clickable(opt, () => {
          draft.agent = def.brain.slug;
          syncAgentChip();
          agentPopover.close();
        });
      }
    },
    focus: () => agentPop.querySelector<HTMLElement>(".mva-sel-opt")?.focus(),
  });
  clickable(agentChip, (e) => {
    e.stopPropagation();
    agentPopover.toggle();
  });

  // ── external tools (MCP) ──────────────────────────────────────────────
  renderMcpField(field("External tools (MCP servers) a run may load"), draft, ctx.plugin);

  // ── prompt ────────────────────────────────────────────────────────────
  const promptField = field("The prompt — what a run is told to do");
  const prompt = promptField.createEl("textarea", {
    cls: "mva-pv-input mva-auto2-prompt",
    attr: { rows: "8", placeholder: "Read every note in _inbox/ and move each to its Object-OS home…" },
  });
  prompt.value = draft.prompt;
  prompt.oninput = () => (draft.prompt = prompt.value);

  // ── cooldown ──────────────────────────────────────────────────────────
  const coolField = field("Cooldown: the least time between two runs a vault event starts");
  const cool = coolField.createEl("input", { cls: "mva-pv-input", attr: { type: "text", placeholder: "15m" } });
  cool.value = formatDuration(draft.cooldownMs);
  cool.oninput = () => (draft.cooldownMs = parseDuration(cool.value) ?? NaN);

  // ── footer: delete · cancel · save ────────────────────────────────────
  const foot = pane.createDiv({ cls: "mva-auto2-ed-foot" });
  if (existing) {
    const del = foot.createEl("button", { cls: "mva-btn", text: "Delete" });
    let armed = false;
    del.onclick = () => {
      if (!armed) {
        armed = true;
        del.setText("Sure? Archives the file");
        del.addClass("mva-btn-danger");
        window.setTimeout(() => {
          armed = false;
          if (!del.isConnected) return;
          del.setText("Delete");
          del.removeClass("mva-btn-danger");
        }, 4000);
        return;
      }
      void archiveAutomation(ctx.plugin, existing.slug).then(close);
    };
  }
  foot.createDiv({ cls: "mva-auto-spacer" });
  const problems = pane.createDiv({ cls: "mva-auto2-warn" });
  pane.insertBefore(problems, foot);
  const cancel = foot.createEl("button", { cls: "mva-btn", text: "Cancel" });
  cancel.onclick = close;
  const save = foot.createEl("button", { cls: "mva-btn mva-auto2-save", text: "Save" });
  save.onclick = () => {
    const errors = validateAutomation(draft);
    const slug = draft.slug || automationSlug(draft.name);
    if (!existing && store.get(slug)) errors.push(`An automation called "${store.get(slug)?.name}" already exists: pick another name.`);
    problems.setText(errors.join(" "));
    if (errors.length) return;
    draft.slug = slug;
    save.setAttr("disabled", "true");
    void store.save(draft).then(close);
  };
}

/* ------------------------------ when picker ------------------------------ */

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const WHEN_KINDS: { value: string; label: string }[] = [
  { value: "hourly", label: "every hour" },
  { value: "daily", label: "every day" },
  { value: "weekly", label: "every week" },
  { value: "create", label: "when a note is created in…" },
  { value: "modify", label: "when a note is modified in…" },
  { value: "rename", label: "when a note is renamed in…" },
  { value: "tag", label: "when a tag is added…" },
];

/** One chip that edits (or adds, when `current` is null) a `when` entry. */
function whenPicker(
  parent: HTMLElement,
  current: AutomationWhen | null,
  onPick: (next: AutomationWhen | null) => void
): void {
  const wrap = parent.createDiv({ cls: "mva-sel" });
  const chip = wrap.createDiv({ cls: "mva-sel-chip", attr: { "aria-label": "When" } });
  chip.setText(current ? formatWhen(current) : "+ add");
  const pop = wrap.createDiv({ cls: "mva-sel-pop" });
  pop.hide();

  const kindOf = (w: AutomationWhen | null): string =>
    !w ? "" : w.on === "schedule" ? w.cadence.kind : w.on === "vault-event" ? w.event : "tag";

  const popover = openablePopover({
    anchor: chip,
    pop,
    wrap,
    onOpen: () => {
      pop.empty();
      for (const k of WHEN_KINDS) {
        const opt = pop.createDiv({ cls: "mva-sel-opt", attr: { tabindex: "0" } });
        const dot = opt.createSpan({ cls: "mva-sel-opt-dot" });
        if (kindOf(current) === k.value) setIcon(dot, "check");
        opt.createSpan({ text: k.label });
        clickable(opt, () => {
          popover.close();
          onPick(defaultWhenFor(k.value, current));
        });
      }
      // Parameter fields for the current shape, edited in place.
      if (current?.on === "schedule" && current.cadence.kind !== "hourly") {
        const hourRow = pop.createDiv({ cls: "mva-auto-popfield" });
        hourRow.createSpan({ cls: "mva-pv-label", text: "At hour" });
        const hour = hourRow.createEl("input", { cls: "mva-pv-input mva-auto-hour", attr: { type: "number", min: "0", max: "23" } });
        hour.value = String(current.cadence.hour);
        hour.onchange = () => {
          const h = Math.min(23, Math.max(0, Number(hour.value) || 0));
          onPick({ on: "schedule", cadence: current.cadence.kind === "daily" ? { kind: "daily", hour: h } : { kind: "weekly", day: current.cadence.kind === "weekly" ? current.cadence.day : 1, hour: h } });
        };
      }
      if (current?.on === "schedule" && current.cadence.kind === "weekly") {
        const cadence = current.cadence;
        const dayRow = pop.createDiv({ cls: "mva-auto-popfield" });
        dayRow.createSpan({ cls: "mva-pv-label", text: "On" });
        for (const [i, d] of DAY_LABELS.entries()) {
          const opt = dayRow.createDiv({ cls: "mva-sel-opt", attr: { tabindex: "0" } });
          if (i === cadence.day) opt.addClass("is-current");
          opt.createSpan({ text: d });
          clickable(opt, () => {
            popover.close();
            onPick({ on: "schedule", cadence: { kind: "weekly", day: i, hour: cadence.hour } });
          });
        }
      }
      if (current?.on === "vault-event") {
        const ev = current;
        const pathRow = pop.createDiv({ cls: "mva-auto-popfield" });
        pathRow.createSpan({ cls: "mva-pv-label", text: "Folder" });
        const path = pathRow.createEl("input", { cls: "mva-pv-input", attr: { type: "text", placeholder: "_inbox/" } });
        path.value = ev.path.replace(/\/\*\*$/, "/");
        path.onchange = () => {
          const parsed = parseWhen(`on ${ev.event} in ${path.value || "**"}`);
          if (parsed) onPick(parsed);
        };
      }
      if (current?.on === "tag") {
        const tagRow = pop.createDiv({ cls: "mva-auto-popfield" });
        tagRow.createSpan({ cls: "mva-pv-label", text: "Tag" });
        const tag = tagRow.createEl("input", { cls: "mva-pv-input", attr: { type: "text", placeholder: "#todo" } });
        tag.value = current.tag;
        tag.onchange = () => {
          const parsed = parseWhen(`on tag ${tag.value}`);
          if (parsed) onPick(parsed);
          else new Notice(`"${tag.value}" is not a tag: one word, like #todo.`);
        };
      }
      if (current) {
        const rm = pop.createDiv({ cls: "mva-sel-opt mva-auto2-remove", attr: { tabindex: "0" } });
        const dot = rm.createSpan({ cls: "mva-sel-opt-dot" });
        setIcon(dot, "x");
        rm.createSpan({ text: "remove" });
        clickable(rm, () => {
          popover.close();
          onPick(null);
        });
      }
    },
    focus: () => pop.querySelector<HTMLElement>(".mva-sel-opt")?.focus(),
  });
  clickable(chip, (e) => {
    e.stopPropagation();
    popover.toggle();
  });
}

/** A sensible starting value when the user picks a shape, carrying over what
 *  transfers (the hour, the folder). */
function defaultWhenFor(kind: string, prev: AutomationWhen | null): AutomationWhen {
  const hour = prev?.on === "schedule" && prev.cadence.kind !== "hourly" ? prev.cadence.hour : 7;
  const path = prev?.on === "vault-event" ? prev.path : "_inbox/**";
  if (kind === "hourly") return { on: "schedule", cadence: { kind: "hourly" } };
  if (kind === "daily") return { on: "schedule", cadence: { kind: "daily", hour } };
  if (kind === "weekly") return { on: "schedule", cadence: { kind: "weekly", day: 1, hour } };
  if (kind === "tag") return { on: "tag", tag: "#todo" };
  return { on: "vault-event", event: kind as "create" | "modify" | "rename", path };
}
