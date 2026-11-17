import { Notice } from "obsidian";
import { homedir } from "os";
import { scanSkillDirs, assignSkillState, type DiscoveryItem } from "../../core/connections-scan";
import { importSkill, removeSkill } from "../../core/connections-install";
import { confirmModal } from "../confirm-modal";
import {
  BUILTIN_TOOLS,
  FILE_BUILTINS,
  NATIVE_MEMORY,
  NATIVE_READ,
  NATIVE_WRITE,
  gatherFromScopes,
  gatherFromVault,
  gatherHooks,
  gatherOtherProjectSkills,
  gatherCodexSkills,
  mergeByName,
  type NamedItem,
} from "../../core/capability-scan";
import { skillSections, matchesQuery } from "../../core/hub-sections";
import { PROFILES } from "../../providers/profiles";
import { reconcileList, type CardModel } from "../keyed-reconcile";
import { buildAccordionGroupHeader, buildGroupHeader, buildRowScaffold, buildSearchBox, type HubTabContext } from "./shared";

/**
 * The Skills tab — everything the agent knows how to do. Vault-installed
 * skills first (removable), then importable skills from other projects /
 * Codex grouped by origin, a collapsed count for the hundreds already
 * available globally (not 281 rows), and compact chip sections for the rest
 * of the agent's vocabulary: Commands (/), Sub-agents (@), Hooks, Tools.
 * Chip sections prefer the live session inventory (CLI system/init) and fall
 * back to disk scans before the first spawn / on Codex.
 */

export async function gatherSkills(ctx: HubTabContext): Promise<DiscoveryItem[]> {
  const home = homedir();
  const caps = ctx.plugin.lastSessionCaps;
  const projectRoots = [`${home}/Dev Projects`, `${home}/Projects`];
  const dirs = [...await gatherOtherProjectSkills(projectRoots), await gatherCodexSkills()];
  const skillItems = scanSkillDirs(dirs);
  // "Already have" = the live session's loaded skills UNION the on-disk global
  // catalog. Union, not `??`: caps is authoritative when present but null
  // pre-init and on Codex; the disk scan (symlink-aware) covers that gap so a
  // skill Exo already has is never offered as importable.
  const haveNames = new Set<string>([
    ...(caps?.skills ?? []),
    ...(await gatherFromScopes("skills")).map((s) => s.name),
  ]);
  const vaultNames = new Set<string>((await gatherFromVault(ctx.app, "skills")).map((s) => s.name));
  return assignSkillState(skillItems, haveNames, vaultNames);
}

export async function renderSkillsTab(host: HTMLElement, ctx: HubTabContext): Promise<void> {
  const skills = await gatherSkills(ctx);
  const { vault, groups, haveCount } = skillSections(skills);
  const query = ctx.filterText();
  const searching = query.trim().length > 0;

  const models: CardModel[] = [];
  models.push({ key: "search", sig: "static", build: () => buildSearchBox(ctx, "Search skills…") });

  // "In this vault" — the user's own skills, open by default (HubView seeds
  // this key into expandedKeys). Importable groups below start closed: with
  // dozens of project origins, a flat list was the whole point of this
  // accordion — nothing to navigate if it opens pre-expanded anyway. A live
  // search overrides both: matching groups auto-open (VSCode's tree-search
  // idiom) and empty ones disappear; clearing the query restores whatever the
  // user had manually set, since search never touches ctx.expanded itself.
  const vaultKey = "skills:vault";
  const searchingVault = searching && vault.length > 0;
  const shownVault = searchingVault ? vault.filter((it) => matchesQuery(query, it.name, it.desc)) : vault;
  if (!searchingVault || shownVault.length) {
    const vaultOpen = searchingVault ? true : ctx.expanded(vaultKey);
    models.push({
      key: "hdr:vault",
      sig: `${shownVault.length}:${vaultOpen}`,
      build: () => buildAccordionGroupHeader(ctx, vaultKey, "In this vault", shownVault.length, searchingVault ? true : undefined),
    });
    if (vaultOpen) {
      if (!shownVault.length) {
        models.push({ key: "vault-empty", sig: "empty", build: () => createDiv({ cls: "mva-conn-empty", text: "No skills installed in this vault yet." }) });
      }
      for (const it of shownVault) models.push({ key: `skill:${it.name}`, sig: "active", build: () => buildSkillRow(it, ctx) });
    }
  }

  for (const group of groups) {
    const shownItems = searching ? group.items.filter((it) => matchesQuery(query, it.name, it.desc)) : group.items;
    if (searching && !shownItems.length) continue; // no match anywhere in this origin — hide it entirely
    const key = `skills:origin:${group.origin}`;
    const isOpen = searching ? true : ctx.expanded(key);
    models.push({
      key: `hdr:${group.origin}`,
      sig: `${shownItems.length}:${isOpen}`,
      build: () => buildAccordionGroupHeader(ctx, key, group.origin, shownItems.length, searching ? true : undefined),
    });
    if (isOpen) {
      for (const it of shownItems) models.push({ key: `skill:${it.name}`, sig: "importable", build: () => buildSkillRow(it, ctx) });
    }
  }
  if (!vault.length && !groups.length && !haveCount) {
    models.push({ key: "skills-empty", sig: "empty", build: () => createDiv({ cls: "mva-conn-empty", text: "No skills found anywhere Exo looks." }) });
  }
  if (haveCount && !searching) {
    models.push({ key: "have-summary", sig: `${haveCount}`, build: () => {
      const s = createDiv({ cls: "mva-conn-have-summary" });
      s.setText(`${haveCount} skills already in Exo — not shown`);
      return s;
    } });
  }

  models.push(...await vocabularySections(ctx));
  reconcileList(host, models);
}

/* ------------------- agent vocabulary (chip sections) ------------------- */

/** One keyed chip section: uppercase header + wrapping chip list, capped at
 *  MAX_CHIPS with a "+N more" expander. The whole section is one reconcile
 *  model whose sig is the content hash — it rebuilds only when names change. */
const MAX_CHIPS = 24;

function chipSection(
  key: string,
  title: string,
  count: number,
  fill: (body: HTMLElement) => void,
  sig: string
): CardModel {
  return {
    key,
    sig,
    build: () => {
      const sec = createDiv({ cls: "mva-hub-chipsec" });
      sec.appendChild(buildGroupHeader(title, count || undefined));
      const body = sec.createDiv({ cls: "mva-caps-body" });
      fill(body);
      return sec;
    },
  };
}

function chip(parent: HTMLElement, label: string, active: boolean, desc?: string, onClick?: () => void): HTMLElement {
  const el = parent.createSpan({ cls: `mva-caps-chip ${active ? "is-on" : "is-off"}` });
  el.createSpan({ cls: "mva-caps-dot" });
  el.createSpan({ cls: "mva-caps-label", text: label });
  if (desc) {
    el.setAttr("aria-label", desc);
    el.setAttr("title", desc);
  }
  if (onClick) {
    el.addClass("is-clickable");
    el.onclick = onClick;
  }
  return el;
}

/** `ctx` present → each chip inserts `<prefix><name> ` into the active chat's
 *  composer on click (Commands `/`, Sub-agents `@`); omit it for informational
 *  chips (Tools) that aren't meant to be typed into a prompt. */
function chipList(body: HTMLElement, items: NamedItem[], prefix: string, ctx?: HubTabContext, active = true): void {
  const render = (it: NamedItem) => chip(
    body,
    `${prefix}${it.name}`,
    active,
    it.desc ?? (ctx ? "Click to insert in the composer" : undefined),
    ctx ? () => void ctx.plugin.insertIntoComposer(`${prefix}${it.name} `) : undefined
  );
  for (const it of items.slice(0, MAX_CHIPS)) render(it);
  const rest = items.slice(MAX_CHIPS);
  if (rest.length) {
    const more = chip(body, `+${rest.length} more`, false, "Show all");
    more.addClass("is-clickable");
    more.onclick = () => {
      more.remove();
      for (const it of rest) render(it);
    };
  }
}

async function vocabularySections(ctx: HubTabContext): Promise<CardModel[]> {
  const s = ctx.plugin.settings;
  const caps = ctx.plugin.lastSessionCaps;
  // `nativeFirst` and the "native" badge describe the in-process server.
  const claude = PROFILES[s.provider].toolWiring === "in-process";
  const agentic = s.toolsEnabled;
  const nativeOn = s.obsidianToolsEnabled && agentic && claude;

  // Commands + sub-agents: live inventory first, disk scan fallback.
  const commands: NamedItem[] = caps?.commands?.length
    ? caps.commands.map((name) => ({ name }))
    : mergeByName(await gatherFromVault(ctx.app, "commands"), await gatherFromScopes("commands"));
  const agents: NamedItem[] = caps?.agents?.length
    ? caps.agents.map((name) => ({ name }))
    : mergeByName(await gatherFromVault(ctx.app, "agents"), await gatherFromScopes("agents"));

  // Hooks: per-event matcher counts, vault + global scope.
  const base = (ctx.app.vault.adapter as unknown as { getBasePath?(): string }).getBasePath?.();
  const vaultHooks = base ? await gatherHooks(`${base}/.claude/settings.json`) : [];
  const globalHooks = await gatherHooks(`${homedir()}/.claude/settings.json`);

  // Tools: the session's real inventory minus MCP tools (those live on the MCP
  // tab), falling back to the builtin list on older CLIs / before first init.
  const liveCore = caps?.tools?.filter((t) => !t.startsWith("mcp__"));
  const core = liveCore?.length ? [...liveCore].sort((a, b) => a.localeCompare(b)) : BUILTIN_TOOLS;

  const out: CardModel[] = [];
  out.push(chipSection("sec:commands", "Commands", commands.length, (body) => {
    if (!commands.length) body.createDiv({ cls: "mva-conn-empty", text: "None found." });
    chipList(body, commands, "/", ctx);
  }, commands.map((c) => c.name).join(",")));

  out.push(chipSection("sec:agents", "Sub-agents", agents.length, (body) => {
    if (!agents.length) body.createDiv({ cls: "mva-conn-empty", text: "None found." });
    chipList(body, agents, "@", ctx);
  }, agents.map((a) => a.name).join(",")));

  const hookSig = [...vaultHooks, ...globalHooks].map((h) => `${h.event}:${h.count}`).join(",") + `:${s.runHooks}`;
  out.push(chipSection("sec:hooks", "Hooks", vaultHooks.length + globalHooks.length, (body) => {
    if (!s.runHooks) chip(body, "Disabled in settings", false, "Turn on 'Run Claude Code hooks' in settings");
    if (!vaultHooks.length && !globalHooks.length) {
      body.createDiv({
        cls: "mva-conn-empty",
        text: "No hooks configured. Hooks in .claude/settings.json run automatically (PreToolUse guards, formatters, notifications).",
      });
      return;
    }
    for (const h of vaultHooks) chip(body, `${h.event} ×${h.count}`, s.runHooks, "vault");
    for (const h of globalHooks) chip(body, `${h.event} ×${h.count}`, s.runHooks, "global");
  }, hookSig));

  const toolSig = core.join(",") + `:${agentic}:${nativeOn}:${s.nativeFirst}`;
  out.push(chipSection("sec:tools", "Tools", core.length, (body) => {
    for (const t of core) {
      const active = agentic && !(s.nativeFirst && claude && FILE_BUILTINS.has(t));
      chip(body, t, active);
    }
    if (nativeOn) {
      for (const t of NATIVE_READ) chip(body, t, true);
      for (const t of NATIVE_WRITE) chip(body, t, true);
      const memory = ctx.plugin.memoryCaps();
      for (const t of NATIVE_MEMORY) chip(body, t, memory.ledgerWrite, "memory write");
      chip(body, "recent_chats", memory.chatSearch, "memory read");
    }
  }, toolSig));

  return out;
}

function buildSkillRow(it: DiscoveryItem, ctx: HubTabContext): HTMLElement {
  const { row, right } = buildRowScaffold(it.name, it.origin, it.desc);
  row.toggleClass("is-muted", it.state === "have");

  if (it.state === "active") {
    right.createSpan({ cls: "mva-conn-state", text: "in vault" });
    const btn = right.createEl("button", { cls: "mva-btn", text: "Remove" });
    btn.onclick = () => void doRemoveSkill(ctx, it, btn);
  } else if (it.state === "have") {
    right.createSpan({ cls: "mva-conn-state is-muted", text: "already in Exo" });
  } else {
    const btn = right.createEl("button", { cls: "mva-btn", text: "Import" });
    btn.onclick = () => void doImport(ctx, it, btn);
  }
  return row;
}

async function doImport(ctx: HubTabContext, it: DiscoveryItem, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    const dest = `${ctx.base()}/.claude/skills/${it.name}`;
    const res = await importSkill(it.path!, dest);
    if (res === "exists") {
      const overwrite = await confirmModal(ctx.app, {
        title: "Overwrite skill?",
        body: `A skill named "${it.name}" already exists in the vault. Overwrite it?`,
        cta: "Overwrite",
      });
      if (!overwrite) { btn.disabled = false; return; }
      await importSkill(it.path!, dest, { overwrite: true });
    }
    new Notice(`Skill "${it.name}" imported into the vault.`);
    ctx.rerender();
  } catch (e) {
    new Notice(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    btn.disabled = false;
  }
}

async function doRemoveSkill(ctx: HubTabContext, it: DiscoveryItem, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    await removeSkill(`${ctx.base()}/.claude/skills/${it.name}`);
    new Notice(`Skill "${it.name}" removed from the vault.`);
    ctx.rerender();
  } catch (e) {
    new Notice(`Removal failed: ${e instanceof Error ? e.message : String(e)}`);
    btn.disabled = false;
  }
}
