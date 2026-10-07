/**
 * The automation editor's "External tools" field: which MCP servers a run may
 * load (core/mcp-scope.ts). Three choices mirror the three file states: the
 * global setting (no `mcp:` line), none (`mcp: []`), or a picked list.
 *
 * The picker lists every server Exo knows by name: the ones runs have seen
 * load (settings.knownMcpServers), the last session's roster, and the two
 * config files. A name typed by hand that none of these has is kept, with a
 * note: it may exist on another machine.
 */
import { setIcon } from "obsidian";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import type ExoPlugin from "../../main";
import type { Automation } from "../../core/automation-model";
import { configuredMcpServers } from "../../core/mcp-guard";
import { unknownMcpNames } from "../../core/mcp-scope";
import { clickable } from "../dom";

const CHOICES = [
  { value: "default", label: "Global setting", hint: "Whatever Exo's playbook setting says: today, every server you have." },
  { value: "none", label: "None", hint: "Only Exo's own vault tools. Fastest start, smallest context." },
  { value: "some", label: "Only these", hint: "Loads just the servers you tick; every other one is kept out." },
] as const;

const readJson = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
};

/** Every server name Exo can vouch for, with its last known status. */
async function knownServers(plugin: ExoPlugin): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const name of plugin.settings.knownMcpServers ?? []) out.set(name, "");
  const base = (plugin.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.() ?? "";
  if (base) {
    const configured = configuredMcpServers(await readJson(join(homedir(), ".claude.json")), await readJson(join(base, ".mcp.json")), base);
    for (const s of configured) if (!out.has(s.name)) out.set(s.name, "");
  }
  for (const s of plugin.lastSessionCaps?.mcpServers ?? []) out.set(s.name, s.status);
  out.delete("obsidian");
  return out;
}

export function renderMcpField(field: HTMLElement, draft: Automation, plugin: ExoPlugin): void {
  const choices = field.createDiv({ cls: "mva-auto2-modes" });
  const box = field.createDiv({ cls: "mva-auto2-scope" });
  const note = field.createDiv({ cls: "mva-auto2-warn" });
  let known = new Map<string, string>();
  let filter = "";

  const state = (): "default" | "none" | "some" => (!draft.mcp ? "default" : draft.mcp.length ? "some" : "none");

  const syncNote = () => {
    const unknown = draft.mcp ? unknownMcpNames(draft.mcp, [...known.keys()]) : [];
    note.setText(unknown.length ? `Not seen on this machine: ${unknown.join(", ")}. Kept, in case it exists elsewhere.` : "");
  };

  const renderList = () => {
    box.empty();
    if (!draft.mcp || (!draft.mcp.length && !someOpen)) return;
    const search = box.createEl("input", { cls: "mva-pv-input", attr: { type: "text", placeholder: "Filter, or type a server name and press Enter" } });
    search.value = filter;
    const list = box.createDiv();
    const paint = () => {
      list.empty();
      const picked = new Set(draft.mcp ?? []);
      const names = [...new Set([...picked, ...known.keys()])].sort((a, b) => Number(picked.has(b)) - Number(picked.has(a)) || a.localeCompare(b));
      for (const name of names) {
        if (filter && !name.toLowerCase().includes(filter.toLowerCase())) continue;
        const opt = list.createDiv({ cls: "mva-sel-opt mva-sel-opt-tall", attr: { tabindex: "0", role: "checkbox", "aria-checked": String(picked.has(name)) } });
        const dot = opt.createSpan({ cls: "mva-sel-opt-dot" });
        if (picked.has(name)) setIcon(dot, "check");
        const text = opt.createDiv({ cls: "mva-sel-opt-text" });
        text.createDiv({ text: name });
        const status = known.get(name);
        if (status) text.createDiv({ cls: "mva-sel-opt-hint", text: status });
        clickable(opt, () => {
          const next = new Set(draft.mcp ?? []);
          if (next.has(name)) next.delete(name);
          else next.add(name);
          draft.mcp = [...next];
          paint();
          syncNote();
          renderChoices();
        });
      }
    };
    search.oninput = () => {
      filter = search.value;
      paint();
    };
    search.onkeydown = (e) => {
      const name = search.value.trim();
      if (e.key !== "Enter" || !name) return;
      e.preventDefault();
      draft.mcp = [...new Set([...(draft.mcp ?? []), name])];
      filter = "";
      search.value = "";
      paint();
      syncNote();
      renderChoices();
    };
    paint();
  };

  const renderChoices = () => {
    choices.empty();
    const current = state();
    for (const c of CHOICES) {
      const card = choices.createDiv({ cls: "mva-auto2-mode", attr: { role: "button", tabindex: "0" } });
      card.toggleClass("is-current", current === c.value);
      card.createDiv({ cls: "mva-auto2-mode-label", text: c.label });
      card.createDiv({ cls: "mva-auto2-mode-hint", text: c.hint });
      clickable(card, () => {
        if (c.value === current) return;
        draft.mcp = c.value === "default" ? undefined : c.value === "none" ? [] : (draft.mcp?.length ? draft.mcp : []);
        // "Only these" with nothing ticked yet is a list being built, not None.
        someOpen = c.value === "some";
        renderChoices();
        renderList();
        syncNote();
      });
    }
    if (someOpen && current === "none") {
      choices.querySelectorAll(".mva-auto2-mode").forEach((el, i) => el.toggleClass("is-current", i === 2));
    }
  };

  let someOpen = state() === "some";
  renderChoices();
  renderList();
  void knownServers(plugin).then((k) => {
    known = k;
    if (field.isConnected) {
      renderList();
      syncNote();
    }
  });
}
