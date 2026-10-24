/**
 * Fuzzy pickers used by the command palette entries in main.ts. They live here
 * rather than in main.ts because they are self-contained modals with no plugin
 * state: main.ts is at its size ceiling and every new command needs the budget.
 */
import { App, FuzzySuggestModal, type TFile } from "obsidian";
import type { AgentDef } from "../core/agents";
import { writeModeFor } from "../core/agent-runs";

export class AgentPicker extends FuzzySuggestModal<AgentDef> {
  constructor(
    app: App,
    private agents: AgentDef[],
    private onPick: (a: AgentDef) => void
  ) {
    super(app);
    this.setPlaceholder("Run an agent now…");
  }
  getItems(): AgentDef[] {
    return this.agents;
  }
  getItemText(a: AgentDef): string {
    const tier = writeModeFor(a.contract.autonomy) ? "writes" : "read-only";
    return `${a.brain.name} — ${tier}${a.contract.enabled ? "" : " · disabled"}`;
  }
  onChooseItem(a: AgentDef): void {
    this.onPick(a);
  }
}

export class PlaybookPicker extends FuzzySuggestModal<{ name: string; prompt: string }> {
  constructor(
    app: App,
    private prompts: { name: string; prompt: string }[],
    private onPick: (p: { name: string; prompt: string }) => void,
    reportsDir: string
  ) {
    super(app);
    this.setPlaceholder(`Run a playbook (read-only, report to ${reportsDir}/)…`);
  }
  getItems(): { name: string; prompt: string }[] {
    return this.prompts;
  }
  getItemText(p: { name: string; prompt: string }): string {
    return p.name;
  }
  onChooseItem(p: { name: string; prompt: string }): void {
    this.onPick(p);
  }
}

/** "Choose note..." in the save panel: any markdown note in the vault. */
export class NotePicker extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private onPick: (path: string) => void
  ) {
    super(app);
    this.setPlaceholder("Choose a note to save into...");
  }
  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }
  getItemText(f: TFile): string {
    return f.path;
  }
  onChooseItem(f: TFile): void {
    this.onPick(f.path);
  }
}
