/**
 * Automations tab — the single surface for everything that runs unattended.
 *
 * v2: one unified model. Each automation is a readable file
 * (`<memoryRoot>/automations/<slug>.md`); this tab renders one card per file —
 * icon, name, description and a SENTENCE ("Runs daily at 07:00 · read-only ·
 * last run 16h ago") — with Run now and an enabled toggle. Clicking a card
 * opens the in-hub editor (automation-editor.ts); clicking the last-run line
 * expands that automation's own run timeline with diff/restore.
 *
 * Design language: canonical form recipe — `.mva-pv-label` quiet labels,
 * `.mva-btn` buttons, popovers never native selects. Cards are geometry +
 * hover, no schema chips: the file's vocabulary stays in the file.
 */
import { Notice, TFile, setIcon } from "obsidian";
import { clickable } from "../dom";
import { NoteDiffModal } from "../note-diff";
import { basename as noteBasename } from "../../obsidian/graph";
import {
  legacyRuns,
  runsForSlug,
  type AutomationRunRecord,
} from "../../core/automations";
import {
  modeSentence,
  whenSentence,
  type Automation,
} from "../../core/automation-model";
import { dailyPulseMetaLabel } from "../../core/daily-pulse";
import { formatAge } from "../../core/actions-hub";
import type { HubTabContext } from "./shared";
import { openAutomationEditor, editingState } from "./automation-editor";
import { describeAutomationInChat, duplicate } from "./automation-actions";

export async function renderAutomationsTab(host: HTMLElement, ctx: HubTabContext): Promise<void> {
  host.empty();

  // The automation being edited can vanish under us — deleted on another
  // device, or the file removed by hand. Without this the editor would quietly
  // become a blank "New automation" form still claiming to edit something.
  if (editingState.active && editingState.slug && !ctx.plugin.automationStore.get(editingState.slug)) {
    editingState.active = false;
    editingState.slug = null;
    new Notice("That automation is gone — showing the list instead.");
  }
  if (editingState.active) {
    openAutomationEditor(host, ctx);
    return;
  }

  host.createDiv({
    cls: "mva-auto-sub",
    text: "Everything that runs without you. Each automation is a note you can read — click a card to edit it.",
  });

  const store = ctx.plugin.automationStore;
  const autos = store.list();
  const errors = store.errors();
  const runs = await ctx.plugin.loadAutomationRuns();

  const list = host.createDiv({ cls: "mva-auto2-list" });

  for (const err of errors) {
    if (autos.some((a) => a.slug === err.slug)) continue; // parse warnings show on the card
    const card = list.createDiv({ cls: "mva-auto2-card is-error" });
    const icon = card.createDiv({ cls: "mva-auto2-icon" });
    setIcon(icon, "alert-triangle");
    const main = card.createDiv({ cls: "mva-auto2-main" });
    main.createDiv({ cls: "mva-auto2-name", text: err.slug });
    main.createDiv({ cls: "mva-auto2-warn", text: `This file couldn't be read as an automation: ${err.problem}` });
    const open = card.createEl("button", { cls: "mva-btn", text: "Open note" });
    open.onclick = () => void ctx.app.workspace.openLinkText(store.filePath(err.slug), "", "tab");
  }

  if (!autos.length && !errors.length) {
    const empty = list.createDiv({ cls: "mva-auto2-empty" });
    empty.createDiv({ text: "Nothing runs on its own yet." });
    empty.createDiv({
      cls: "mva-auto2-warn",
      text: "An automation is a prompt plus a moment: a schedule, or something happening in the vault.",
    });
  }

  for (const a of autos) renderCard(list, a, runs, ctx);

  const foot = host.createDiv({ cls: "mva-auto-foot" });
  const add = foot.createEl("button", { cls: "mva-btn", text: "New automation" });
  add.onclick = () => {
    editingState.active = true;
    editingState.slug = null;
    ctx.rerender();
  };
  const words = foot.createEl("button", { cls: "mva-btn", text: "Describe it in a chat" });
  words.onclick = () => void describeAutomationInChat(ctx.plugin);

  renderLegacyRuns(host, runs, autos.map((a) => a.name), ctx);
}

/* ------------------------------- one card ------------------------------- */

function renderCard(
  list: HTMLElement,
  a: Automation,
  runs: AutomationRunRecord[],
  ctx: HubTabContext
): void {
  const store = ctx.plugin.automationStore;
  const card = list.createDiv({ cls: "mva-auto2-card" });
  card.toggleClass("is-off", !a.enabled);

  const icon = card.createDiv({ cls: "mva-auto2-icon" });
  setIcon(icon, a.icon || "zap");

  const main = card.createDiv({ cls: "mva-auto2-main" });
  const nameRow = main.createDiv({ cls: "mva-auto2-name", text: a.name });
  if (a.agent) {
    const badge = nameRow.createSpan({ cls: "mva-auto2-agent", text: a.agent });
    badge.setAttribute("aria-label", "Runs through this agent");
  }
  if (a.description) main.createDiv({ cls: "mva-auto2-desc", text: a.description });

  const parts = a.when.map(whenSentence);
  const sentence = parts.length ? parts.join(" · ") : "Never runs — no schedule or trigger yet";
  main.createDiv({ cls: "mva-auto2-say", text: `${sentence} · ${modeSentence(a.mode)}` });

  const problem = store.errors().find((e) => e.slug === a.slug);
  if (problem) main.createDiv({ cls: "mva-auto2-warn", text: problem.problem });

  // Last-run line — click to expand this automation's timeline.
  const own = runsForSlug(runs, a.slug, a.name);
  const meta = main.createDiv({ cls: "mva-auto2-meta" });
  if (a.system === "daily-pulse") meta.setText(dailyPulseMetaLabel(ctx.plugin.settings.dailyPulseReviewState));
  else if (own.length) meta.setText(`last run ${formatAge(own[0].startedAt, Date.now(), "—")}${own[0].ok ? "" : " · failed"}`);
  // Not "never ran": until v2 only write runs were recorded, so an automation
  // that reported every morning still has no history to show. Say what is
  // actually true — there are no records — rather than a claim about the past.
  else meta.setText("no runs recorded yet");
  const runsKey = `auto-runs:${a.slug}`;
  if (own.length) {
    meta.addClass("is-openable");
    meta.setAttribute("role", "button");
    meta.setAttribute("tabindex", "0");
    clickable(meta, () => {
      ctx.toggleExpanded(runsKey);
      ctx.rerender();
    });
    meta.onclick = (e) => e.stopPropagation();
  }

  // Whole-card click opens the editor; inner controls stop propagation.
  clickable(card, () => {
    editingState.active = true;
    editingState.slug = a.slug;
    ctx.rerender();
  });

  const actions = card.createDiv({ cls: "mva-auto2-actions" });
  actions.onclick = (e) => e.stopPropagation();

  const run = actions.createEl("button", { cls: "mva-btn", text: "Run now" });
  run.onclick = () => {
    run.setAttr("disabled", "true");
    run.setText("Running…");
    void ctx.plugin.runAutomationNow(a).finally(() => {
      if (!card.isConnected) return;
      run.removeAttribute("disabled");
      run.setText("Run now");
      ctx.rerender();
    });
  };

  const copy = actions.createDiv({ cls: "mva-ag-action", attr: { "aria-label": "Duplicate (paused)", role: "button", tabindex: "0" } });
  setIcon(copy, "copy");
  clickable(copy, () => void duplicate(ctx.plugin, a).then(() => ctx.rerender()));

  const toggle = actions.createDiv({ cls: "mva-ag-toggle", attr: { role: "button", tabindex: "0" } });
  toggle.toggleClass("is-on", a.enabled);
  toggle.setAttribute("aria-label", a.enabled ? "Pause automation" : "Enable automation");
  clickable(toggle, () => {
    void store.save({ ...a, enabled: !a.enabled }).then(() => ctx.rerender());
  });

  if (ctx.expanded(runsKey) && own.length) {
    const timeline = list.createDiv({ cls: "mva-auto2-timeline" });
    for (const r of own.slice(0, 8)) renderRunRow(timeline, r, ctx);
  }
}

/* ---------------------------- run timeline ---------------------------- */

/** Pre-v2 records that no automation owns — visible but out of the way. */
function renderLegacyRuns(
  host: HTMLElement,
  runs: AutomationRunRecord[],
  claimedNames: string[],
  ctx: HubTabContext
): void {
  const old = legacyRuns(runs, claimedNames);
  if (!old.length) return;
  const key = "auto-runs:legacy";
  const head = host.createDiv({ cls: "mva-pv-label mva-auto2-legacy", text: `Older runs (${old.length})` });
  head.setAttribute("role", "button");
  head.setAttribute("tabindex", "0");
  clickable(head, () => {
    ctx.toggleExpanded(key);
    ctx.rerender();
  });
  if (!ctx.expanded(key)) return;
  const wrap = host.createDiv({ cls: "mva-auto2-timeline" });
  for (const r of old.slice(0, 8)) renderRunRow(wrap, r, ctx);
}

function renderRunRow(host: HTMLElement, r: AutomationRunRecord, ctx: HubTabContext): void {
  const wrap = host.createDiv();
  const row = wrap.createDiv({ cls: "mva-auto-runrow" });
  const when = new Date(r.startedAt);
  const stamp = `${String(when.getDate()).padStart(2, "0")}/${String(when.getMonth() + 1).padStart(2, "0")} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  const state = r.restoredAt ? " · restored" : r.reviewedAt ? " · reviewed" : "";
  const writes = r.writes.length ? ` · ${r.writes.length} note${r.writes.length === 1 ? "" : "s"}` : "";
  const label = row.createSpan({
    cls: "mva-auto-runlabel",
    text: `${stamp}${writes}${r.ok ? "" : " · failed"}${state}`,
  });
  row.createDiv({ cls: "mva-auto-spacer" });

  // The label toggles a per-file list (diff + open) for the run's writes.
  if (r.writes.length) {
    label.addClass("is-openable");
    let filesEl: HTMLElement | null = null;
    clickable(label, () => {
      if (filesEl) {
        filesEl.remove();
        filesEl = null;
        return;
      }
      filesEl = wrap.createDiv({ cls: "mva-auto-runfiles" });
      for (const path of r.writes) {
        const f = filesEl.createDiv({ cls: "mva-auto-runfile" });
        const name = f.createSpan({ cls: "mva-auto-runlabel", text: noteBasename(path) });
        clickable(name, () => void ctx.app.workspace.openLinkText(path, "", "tab"));
        f.createDiv({ cls: "mva-auto-spacer" });
        const entry = r.checkpoint.find(([p]) => p === path);
        const diff = f.createEl("button", { cls: "mva-btn", text: entry ? "Diff" : "No snapshot" });
        if (entry) diff.onclick = () => void showDiff(ctx, path, entry[1]);
        else diff.setAttr("disabled", "true");
      }
    });
  }

  if (!r.reviewedAt && !r.restoredAt && r.writes.length) {
    const reviewed = row.createEl("button", { cls: "mva-btn", text: "Reviewed" });
    reviewed.onclick = () => {
      reviewed.setAttr("disabled", "true");
      void ctx.plugin.markAutomationRunReviewed(r.id).finally(() => ctx.rerender());
    };
  }

  if (r.reportPath) {
    const report = row.createEl("button", { cls: "mva-btn", text: "Report" });
    report.onclick = () => void ctx.app.workspace.openLinkText(r.reportPath, "", "tab");
  }

  if (r.checkpoint.length && !r.restoredAt) {
    const restore = row.createEl("button", { cls: "mva-btn", text: "Restore" });
    let armed = false;
    restore.onclick = () => {
      if (!armed) {
        armed = true;
        restore.setText("Sure?");
        restore.addClass("mva-btn-danger");
        window.setTimeout(() => {
          armed = false;
          if (!restore.isConnected) return;
          restore.setText("Restore");
          restore.removeClass("mva-btn-danger");
        }, 4000);
        return;
      }
      restore.setAttr("disabled", "true");
      void ctx.plugin.restoreAutomationRun(r.id).finally(() => ctx.rerender());
    };
  }
}

async function showDiff(ctx: HubTabContext, path: string, before: string | null): Promise<void> {
  let after = "";
  const f = ctx.app.vault.getAbstractFileByPath(path);
  if (f instanceof TFile) {
    try {
      after = await ctx.app.vault.read(f);
    } catch {
      /* unreadable — show as empty */
    }
  }
  new NoteDiffModal(ctx.app, noteBasename(path), before, after, () => {
    void ctx.app.workspace.openLinkText(path, "", "tab");
  }).open();
}
