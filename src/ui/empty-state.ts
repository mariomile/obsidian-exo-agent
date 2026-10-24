import { App, setIcon } from "obsidian";
import { relatedNotes, basename as noteBasename } from "../obsidian/graph";
import { clickable } from "./dom";
import { buildRelatedChips } from "./related";
import type { MemorySetup } from "../core/vault-setup";

/** What the empty state needs from the view. Kept narrow: the collaborators the
 *  starter grid, custom-prompt list, and related-note surfacing call back into. */
export interface EmptyStateHost {
  app: App;
  /** The active conversation's transcript list — the `.mva-empty` mounts here. */
  listEl: HTMLElement;
  /** Custom Obsidian icon id for the Exo brand mark (EXO_ICON). */
  exoIcon: string;
  /** User-defined prompts (settings.customPrompts). */
  customPrompts: { name: string; prompt: string }[];
  /** Whether related-note surfacing is enabled (settings.featureSurfacing). */
  featureSurfacing: boolean;
  /** Run a prompt/workflow (seeds the composer or enqueues a workflow). */
  usePrompt(promptText: string): void;
  /** Attach a surfaced related note as context + focus the composer. */
  attachRelated(path: string): void;
  /** True when no memory-setup choice has been made yet AND memory writes are
   *  enabled — shows the onboarding picker. */
  vaultSetupNeeded: boolean;
  /** Records the onboarding choice and scaffolds accordingly
   *  (`ExoPlugin.applyMemorySetup`). */
  applyMemorySetup(preset: MemorySetup): void;
}

const STARTERS: [string, string, string][] = [
  ["file-text", "Summarize this note", "Summarize the current note in 5 concise bullets."],
  ["network", "Find related notes", "Find notes in my vault related to the current note and explain how they connect."],
  ["list-checks", "Extract action items", "Extract every action item and open question from the current note as a checklist."],
  ["pen-line", "Draft from outline", "Expand the outline in the current note into full prose in my voice."],
  ["sparkles", "Improve clarity", "Improve the clarity and flow of the current note without changing its meaning."],
  ["search", "Find gaps", "What's missing, unclear, or unsupported in the current note? List concrete gaps."],
];

export function renderEmptyState(host: EmptyStateHost): void {
  const empty = host.listEl.createDiv({ cls: "mva-empty" });
  // The Exo star is the still centre; the prompt clusters settle in around it.
  // Each block gets a --i so it eases up in a gentle stagger (reduced-motion off).
  const staggered: HTMLElement[] = [];
  const setup = renderSetupBanner(host, empty);
  if (setup) staggered.push(setup);
  const hero = empty.createDiv({ cls: "mva-empty-hero" });
  setIcon(hero.createDiv({ cls: "mva-empty-star", attr: { "aria-hidden": "true" } }), host.exoIcon);
  hero.createDiv({ cls: "mva-empty-title", text: "What are we working on?" });
  staggered.push(hero);
  const sugg = renderPromptList(
    host,
    empty,
    "Suggestions",
    STARTERS.map(([icon, label, prompt]) => ({ icon, label, prompt }))
  );
  if (sugg) staggered.push(sugg);
  const yours = renderPromptList(
    host,
    empty,
    "Your prompts",
    host.customPrompts.map((p) => ({ icon: "message-square", label: p.name, prompt: p.prompt }))
  );
  if (yours) staggered.push(yours);
  const related = renderSurfacing(host, empty);
  if (related) staggered.push(related);
  staggered.forEach((el, i) => el.style.setProperty("--i", String(i)));
}

/** The three onboarding choices, in escalating footprint. Each records the
 *  choice (dismissing the picker for good) and scaffolds accordingly. */
const MEMORY_SETUP_OPTIONS: { preset: MemorySetup; icon: string; title: string; desc: string }[] = [
  {
    preset: "full",
    icon: "sparkles",
    title: "Full memory",
    desc: "The operational layer plus a knowledge-OS scaffold (preferences, vault context, rules & decisions).",
  },
  {
    preset: "minimal",
    icon: "folder-plus",
    title: "Just the essentials",
    desc: "Only what Exo's memory features need — open loops, store, reports. No opinionated structure.",
  },
  {
    preset: "none",
    icon: "circle-slash",
    title: "Not now",
    desc: "Create nothing. Exo works from your CLAUDE.md; you can set memory up later in settings.",
  },
];

/** Onboarding memory-setup picker — reuses the `.mva-onboard` card pattern
 *  (styles.css, shared with the CLI-not-ready card in view.ts). Offers the
 *  None/Minimal/Full choice; picking any option records it and dismisses the
 *  picker for good. Returns null (renders nothing) when a choice is already
 *  made, so the empty state's stagger list stays correct. */
function renderSetupBanner(host: EmptyStateHost, parent: HTMLElement): HTMLElement | null {
  if (!host.vaultSetupNeeded) return null;
  const card = parent.createDiv({ cls: "mva-onboard" });
  setIcon(card.createDiv({ cls: "mva-onboard-icon" }), "folder-plus");
  card.createDiv({ cls: "mva-onboard-title", text: "Set up Exo's memory in this vault" });
  card.createDiv({
    cls: "mva-onboard-msg",
    text: "Pick how much Exo should scaffold. Nothing that already exists is ever touched.",
  });
  const opts = card.createDiv({ cls: "mva-onboard-opts" });
  for (const o of MEMORY_SETUP_OPTIONS) {
    const row = opts.createDiv({ cls: "mva-onboard-opt" });
    setIcon(row.createDiv({ cls: "mva-onboard-opt-icon" }), o.icon);
    const body = row.createDiv({ cls: "mva-onboard-opt-body" });
    body.createDiv({ cls: "mva-onboard-opt-title", text: o.title });
    body.createDiv({ cls: "mva-onboard-opt-desc", text: o.desc });
    clickable(row, () => host.applyMemorySetup(o.preset));
  }
  return card;
}

/** A labelled, tappable prompt list (Suggestions / Your prompts) with "Show N
 *  more". Returns the section element (or null when there's nothing to show) so
 *  the empty state can stagger its entrance. */
function renderPromptList(
  host: EmptyStateHost,
  parent: HTMLElement,
  label: string,
  items: { icon: string; label: string; prompt: string }[],
  limit = 3
): HTMLElement | null {
  if (!items.length) return null;
  const sec = parent.createDiv({ cls: "mva-es-section" });
  sec.createDiv({ cls: "mva-es-label", text: label });
  const list = sec.createDiv({ cls: "mva-starters" });
  const render = (n: number) => {
    list.empty();
    for (const it of items.slice(0, n)) {
      const row = list.createDiv({ cls: "mva-starter" });
      setIcon(row.createSpan({ cls: "mva-starter-icon" }), it.icon);
      row.createSpan({ text: it.label });
      clickable(row, () => host.usePrompt(it.prompt));
    }
    if (n < items.length) {
      const more = list.createDiv({ cls: "mva-starter mva-es-more" });
      setIcon(more.createSpan({ cls: "mva-starter-icon" }), "chevron-down");
      more.createSpan({ text: `Show ${items.length - n} more` });
      more.onclick = () => render(items.length);
    }
  };
  render(Math.min(limit, items.length));
  return sec;
}

/** Surface notes related to the active note (toggleable). Returns the wrapper
 *  (or null when nothing surfaces) so the empty state can stagger it in. */
function renderSurfacing(host: EmptyStateHost, empty: HTMLElement): HTMLElement | null {
  if (!host.featureSurfacing) return null;
  const file = host.app.workspace.getActiveFile();
  if (!file) return null;
  const related = relatedNotes(host.app, file, 5);
  if (!related.length) return null;
  return buildRelatedChips(
    empty,
    related,
    {
      wrapCls: "mva-surface",
      labelCls: "mva-surface-label",
      labelText: `Related to ${noteBasename(file.path)}`,
      rowCls: "mva-surface-chips",
      chipCls: "mva-surface-chip",
    },
    (p) => host.attachRelated(p)
  );
}
