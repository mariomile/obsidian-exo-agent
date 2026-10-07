import { MarkdownRenderer, Notice, setIcon } from "obsidian";
import { homedir } from "os";
import { readFile } from "fs/promises";
import {
  scanCodexMcp,
  scanClaudeGlobalMcp,
  assignMcpState,
  scanLiveCaps,
  toolNamePrefix,
  type ClaudeJson,
  type DiscoveryItem,
} from "../../core/connections-scan";
import { connectMcp, disconnectMcp, setMcpEnabled } from "../../core/connections-install";
import { parseMcpJson, summarizeServer } from "../../core/mcp-config";
import { mcpSections, matchesQuery } from "../../core/hub-sections";
import { localScopeServers, markSkippedObsidianMcp } from "../../core/mcp-guard";
import { findToolRule, toolPermissionStatus } from "../../core/permissions";
import { MCP_DOCS_DIR, mcpDocPath, mcpDocTemplate, isSafeDocName, hasMcpDocContent, summarizeMcpDoc } from "../../core/mcp-docs";
import { resolveCli, mcpLogin, mcpLogout } from "../../cli";
import { McpServerModal } from "../mcp-server-modal";
import { reconcileList, type CardModel } from "../keyed-reconcile";
import { buildAccordionRow, buildGroupHeader, buildRowScaffold, buildSearchBox, type HubTabContext } from "./shared";

/**
 * The MCP tab — control surface AND marketplace over what other tools already
 * have on the system: add a server, edit/enable/disable/remove vault-owned
 * ones, reconnect a failed one, authenticate/de-authenticate any of them
 * (including claude.ai account connectors), and one-tap import servers other
 * tools already have (never creating a duplicate).
 *
 * Action model by row:
 *  - vault-owned MCP → Edit · Enable/Disable · Remove (+ Reconnect/Re-auth on failure)
 *  - inherited / live-only MCP (global, connectors, plugins) → Reconnect (failed)
 *    · Re-auth (needs-auth or disabled) · Disconnect (connected); config itself
 *    is still managed at its own source (no Edit), but auth is not — `claude mcp
 *    login`/`logout` work on any server name regardless of where it's configured.
 *  - importable MCP (Codex) → Connect
 *
 * Reconnect respawns the active Exo session (which resumes, so the conversation
 * survives) to re-attempt connections and pick up new OAuth creds / .mcp.json
 * edits. Re-auth shells out to `claude mcp login <name>` (browser OAuth) —
 * for a claude.ai connector this is a server-side grant (the CLI just opens
 * the authorize URL; there's no local token to hold), so it only takes effect
 * on the *next* session start, not this one. Disconnect shells out to
 * `claude mcp logout <name>` to clear the local credential; for a claude.ai
 * connector this does NOT flip the account-level enable/disable toggle (that
 * still lives in claude.ai's own settings) — it only revokes what this CLI
 * can use, which is enough to stop it appearing in Exo's session.
 */

/** Read every MCP source, normalize, and diff against what Exo already has.
 *  `ourNames` = servers in the vault's own .mcp.json (ours to edit/remove, vs
 *  inherited/live-only servers configured at their own source). */
export async function gatherMcp(ctx: HubTabContext): Promise<{ items: DiscoveryItem[]; ourNames: Set<string> }> {
  const home = homedir();
  const caps = ctx.plugin.lastSessionCaps;

  let claudeJson: ClaudeJson = {};
  try { claudeJson = JSON.parse(await readFile(`${home}/.claude.json`, "utf8")) as ClaudeJson; } catch { /* absent */ }
  let codexToml = "";
  try { codexToml = await readFile(`${home}/.codex/config.toml`, "utf8"); } catch { /* absent */ }

  const liveStatus = new Map<string, string>((caps?.mcpServers ?? []).map((m) => [m.name, m.status]));

  // Vault-owned servers (.mcp.json) — both enabled and disabled, each carrying
  // its config so the row can Edit / Enable / Disable / Remove it.
  let vaultServers: { name: string; config: Record<string, unknown>; enabled: boolean }[] = [];
  try {
    const parsed = parseMcpJson(await ctx.app.vault.adapter.read(".mcp.json"));
    if (!parsed.error) vaultServers = parsed.servers;
  } catch { /* no .mcp.json yet */ }
  const ourNames = new Set(vaultServers.map((s) => s.name));
  const vaultItems: DiscoveryItem[] = vaultServers.map((s) => ({
    kind: "mcp",
    name: s.name,
    source: "vault",
    origin: "vault",
    state: "active",
    config: s.config,
    desc: summarizeServer(s.config),
    // Disabled servers report "disabled" (no live connection); enabled ones take
    // the live status, or "unknown" before the session finishes connecting.
    status: s.enabled ? liveStatus.get(s.name) ?? "unknown" : "disabled",
  }));

  // Importable / inherited servers from OTHER tools, minus anything already in
  // the vault (dedup — a vault server is never also offered to import).
  const external = [...scanCodexMcp(codexToml), ...scanClaudeGlobalMcp(claudeJson)].filter(
    (it) => !ourNames.has(it.name)
  );
  const activeNames = new Set<string>([
    ...(caps?.mcpServers ?? []).map((m) => m.name),
    ...vaultServers.filter((s) => s.enabled).map((s) => s.name),
  ]);
  const inheritedNames = new Set<string>(Object.keys(claudeJson.mcpServers ?? {}));
  const mcpFromConfig = assignMcpState(external, { activeNames, inheritedNames }).map((it) => ({
    ...it,
    status: liveStatus.get(it.name),
  }));
  // Everything the live session loaded that ISN'T in a local config file:
  // claude.ai account connectors + plugin servers. Read-only — shown so the
  // pane reflects ALL connected MCPs, not just the file-backed ones.
  const covered = new Set([...ourNames, ...mcpFromConfig.map((i) => i.name)]);
  const live = scanLiveCaps(caps?.mcpServers ?? [], covered);
  const vaultBase = (ctx.app.vault.adapter as { getBasePath?(): string }).getBasePath?.() ?? "";
  const localNames = new Set(Object.keys(localScopeServers(claudeJson, vaultBase)));
  return { items: markSkippedObsidianMcp([...vaultItems, ...mcpFromConfig, ...live], localNames), ourNames };
}

/** A standing allow/deny rule covering the WHOLE server, if the user wrote one.
 *  Deny is reported first: it's the one that wins at decision time. The probe
 *  is the source's tool-name prefix, so only a source-level rule
 *  (`mcp__notion__*`) matches — a rule naming one specific tool doesn't badge
 *  the row, because it doesn't govern the server. */
function governingRule(ctx: HubTabContext, it: DiscoveryItem): { kind: "deny" | "allow"; line: string } | null {
  const probe = toolNamePrefix(it);
  const s = ctx.plugin.settings;
  const deny = findToolRule(s.permDenyRules ?? "", probe);
  if (deny) return { kind: "deny", line: deny };
  const allow = findToolRule(s.permAllowRules ?? "", probe);
  return allow ? { kind: "allow", line: allow } : null;
}

/** Which servers already carry a filled-in doc note — drives the Docs button's
 *  label so "write one" and "read it" don't look the same. */
async function gatherDocumented(ctx: HubTabContext, names: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  await Promise.all(
    names.map(async (name) => {
      if (!isSafeDocName(name)) return;
      try {
        const raw = await ctx.app.vault.adapter.read(mcpDocPath(name));
        if (hasMcpDocContent(raw)) out.add(name);
      } catch {
        /* no doc yet */
      }
    })
  );
  return out;
}

/** The doc note's raw text, for the currently-open + documented rows only —
 *  reading every server's note on every render would be wasted I/O for rows
 *  the user never expands. */
async function readDocRaw(ctx: HubTabContext, name: string): Promise<string | null> {
  try {
    return await ctx.app.vault.adapter.read(mcpDocPath(name));
  } catch {
    return null;
  }
}

export async function renderMcpTab(host: HTMLElement, ctx: HubTabContext): Promise<void> {
  const { items: allItems, ourNames } = await gatherMcp(ctx);
  const query = ctx.filterText();
  const items = allItems.filter((it) => matchesQuery(query, it.name, it.origin, it.desc));
  const documented = await gatherDocumented(ctx, items.map((i) => i.name));
  const sections = mcpSections(items);

  const models: CardModel[] = [];
  models.push({ key: "search", sig: "static", build: () => buildSearchBox(ctx, "Search servers…") });
  // Always-present "Add MCP server" action — the control-surface entry point.
  models.push({ key: "add-mcp", sig: "add", build: () => buildAddMcp(ctx) });
  if (!allItems.length) {
    models.push({ key: "mcp-empty", sig: "empty", build: () => createDiv({ cls: "mva-conn-empty", text: "No MCP servers yet — add one above." }) });
  } else if (!items.length) {
    models.push({ key: "mcp-no-match", sig: query, build: () => createDiv({ cls: "mva-conn-empty", text: `No servers match "${query}".` }) });
  }
  const section = async (label: string, list: DiscoveryItem[]) => {
    if (!list.length) return;
    models.push({ key: `sec:${label}`, sig: `${list.length}`, build: () => buildGroupHeader(label, list.length) });
    for (const it of list) {
      const key = `mcp:${it.name}`;
      const isOpen = ctx.expanded(key);
      const docRaw = isOpen && documented.has(it.name) ? await readDocRaw(ctx, it.name) : null;
      models.push({
        key,
        sig: `${it.state}:${it.status ?? ""}:${ourNames.has(it.name)}:${documented.has(it.name)}:${governingRule(ctx, it)?.line ?? ""}:${isOpen}:${it.desc ?? ""}`,
        build: () => buildMcpAccordion(it, ourNames, documented, ctx, docRaw),
      });
    }
  };
  await section("Connected", sections.connected);
  await section("Disabled", sections.disabled);
  await section("Importable", sections.importable);
  await section("Inherited", sections.inherited);
  await section("Skipped in Exo", sections.skipped);
  reconcileList(host, models);
}

function buildAddMcp(ctx: HubTabContext): HTMLElement {
  const row = createDiv({ cls: "mva-conn-addrow" });
  const btn = row.createEl("button", { cls: "mva-btn mva-btn-primary", text: "+ Add MCP server" });
  btn.onclick = () =>
    new McpServerModal(ctx.app, {
      onSubmit: async (built) => {
        const adapter = ctx.app.vault.adapter;
        let raw = '{\n  "mcpServers": {}\n}';
        try { raw = await adapter.read(".mcp.json"); } catch { /* create fresh */ }
        await adapter.write(".mcp.json", connectMcp(raw, built.name, built.config));
        await applyAndRender(ctx, `MCP "${built.name}" added.`);
      },
    }).open();
  return row;
}

/** The collapsed row: status, recovery actions, quiet has-notes/has-rule
 *  indicators, and the vault-owned lifecycle buttons. Full detail (config,
 *  per-tool permissions, rendered notes) lives in the accordion body —
 *  wrapped around this by {@link buildMcpAccordion}. */
function buildMcpRow(it: DiscoveryItem, ourNames: Set<string>, documented: Set<string>, ctx: HubTabContext): HTMLElement {
  const { row, right } = buildRowScaffold(it.name, it.origin, it.desc);
  row.toggleClass("is-muted", it.state === "have");

  if (it.state === "active") {
    const dot = right.createSpan({ cls: "mva-conn-dot" });
    dot.toggleClass("is-connected", it.status === "connected");
    dot.toggleClass("is-failed", it.status === "failed" || it.status === "needs-auth");
    dot.toggleClass("is-disabled", it.status === "disabled");
    // Honest status: "active" only when actually connected; otherwise the
    // real reason (needs-auth / failed / disabled) so the user knows why.
    const label = !it.status || it.status === "connected" ? "active" : it.status;
    right.createSpan({ cls: "mva-conn-state", text: label });
    // Recovery + auth actions apply to ANY server (ours, inherited, connector)
    // since reconnect respawns the session and `claude mcp login`/`logout`
    // resolve by name regardless of where the server is configured.
    if (it.status === "failed") {
      const b = right.createEl("button", { cls: "mva-btn", text: "Reconnect" });
      b.onclick = () => void doReconnect(ctx, b);
    } else if (it.source === "claude-connector" && (it.status === "needs-auth" || it.status === "disabled")) {
      // claude.ai connectors are authorised and switched on in the account,
      // not by this CLI: send Mario where the toggle actually lives.
      const b = right.createEl("button", { cls: "mva-btn", text: "Open in claude.ai" });
      b.onclick = () => window.open("https://claude.ai/settings/connectors");
    } else if (it.status === "needs-auth" || it.status === "disabled") {
      // "disabled" here covers a claude.ai connector turned off at its own
      // source: login can't flip that account-level toggle, but it's the
      // only lever this panel has, and it does take a token that's merely
      // expired (vs. truly account-disabled) back to connected.
      const b = right.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Re-auth" });
      b.onclick = () => void doReauth(ctx, it, b);
    } else if (!ourNames.has(it.name) && (!it.status || it.status === "connected")) {
      // Connected inherited/connector/plugin server — no .mcp.json entry to
      // Enable/Disable here, but the credential this CLI holds can still be
      // revoked, which is enough to stop it appearing in Exo's next session.
      const b = right.createEl("button", { cls: "mva-btn mva-btn-danger", text: "Disconnect" });
      b.onclick = () => void doLogout(ctx, it, b);
    }
    // Quiet indicators only — a colour-and-icon glance at whether this server
    // has notes or a standing rule, not the detail itself (that's the
    // accordion body, one click away). Weakening a permission stays a
    // deliberate act in settings, never a click here.
    if (documented.has(it.name)) {
      const ind = right.createSpan({ cls: "mva-hub-indicator", attr: { "aria-label": "Has notes" } });
      setIcon(ind, "file-text");
      ind.setAttr("title", "Has notes — expand for details");
    }
    const gov = governingRule(ctx, it);
    if (gov) {
      const ind = right.createSpan({ cls: `mva-hub-indicator is-${gov.kind}`, attr: { "aria-label": gov.kind === "deny" ? "Denied by rule" : "Auto-allowed by rule" } });
      setIcon(ind, gov.kind === "deny" ? "shield-ban" : "shield-check");
      ind.setAttr("title", `Matches the ${gov.kind === "deny" ? "deny" : "always-allow"} rule: ${gov.line} — expand for details`);
    }
    // Full lifecycle only for servers WE wrote into .mcp.json — inherited /
    // live-only / connector servers are configured at their own source.
    if (ourNames.has(it.name)) {
      const edit = right.createEl("button", { cls: "mva-btn", text: "Edit" });
      edit.onclick = () => doEditMcp(ctx, it);
      const enabled = it.status !== "disabled";
      const toggle = right.createEl("button", { cls: "mva-btn", text: enabled ? "Disable" : "Enable" });
      toggle.onclick = () => void doToggleMcp(ctx, it, !enabled, toggle);
      const rm = right.createEl("button", { cls: "mva-btn mva-btn-danger", text: "Remove" });
      rm.onclick = () => void doRemoveMcp(ctx, it, rm);
    }
  } else if (it.state === "have") {
    right.createSpan({ cls: "mva-conn-state is-muted", text: "already in Exo" });
  } else {
    const btn = right.createEl("button", { cls: "mva-btn", text: "Connect" });
    btn.onclick = () => void doImport(ctx, it, btn);
  }
  return row;
}

/** The full row: collapsed header (above) wrapped in accordion behavior, body
 *  built lazily only when open (see {@link buildMcpBody}). */
function buildMcpAccordion(it: DiscoveryItem, ourNames: Set<string>, documented: Set<string>, ctx: HubTabContext, docRaw: string | null): HTMLElement {
  const header = buildMcpRow(it, ourNames, documented, ctx);
  return buildAccordionRow(ctx, `mcp:${it.name}`, header, () => buildMcpBody(it, ctx, docRaw));
}

/** Connection / Permissions / Documentation — the Craft-style detail. Read
 *  only throughout: this is where you SEE what governs a server, not where
 *  you change it (Edit/Enable/Remove stay on the header; permission rules
 *  stay in settings). */
function buildMcpBody(it: DiscoveryItem, ctx: HubTabContext, docRaw: string | null): HTMLElement {
  const body = createDiv({ cls: "mva-hub-accordion-body" });

  body.createDiv({ cls: "mva-hub-accordion-section-label", text: "Connection" });
  if (it.config) {
    body.createDiv({ cls: "mva-hub-conn-line", text: summarizeServer(it.config) });
  } else {
    body.createDiv({ cls: "mva-conn-empty", text: "Managed at its own source — no local config to show." });
  }

  body.createDiv({ cls: "mva-hub-accordion-section-label", text: "Permissions" });
  const caps = ctx.plugin.lastSessionCaps;
  const prefix = toolNamePrefix(it);
  const toolNames = caps?.tools?.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length)).sort() ?? null;
  if (!toolNames) {
    body.createDiv({ cls: "mva-conn-empty", text: "Tool list appears after this server connects." });
  } else if (!toolNames.length) {
    body.createDiv({ cls: "mva-conn-empty", text: "This server exposes no tools." });
  } else {
    const s = ctx.plugin.settings;
    for (const short of toolNames) {
      const status = toolPermissionStatus(`${prefix}${short}`, s.permAllowRules ?? "", s.permDenyRules ?? "");
      const permRow = body.createDiv({ cls: "mva-hub-perm-row" });
      permRow.createSpan({ cls: "mva-hub-perm-name", text: short });
      const cssState = status === "auto-allowed" ? "allowed" : status;
      const label = status === "auto-allowed" ? "auto-allowed" : status === "denied" ? "denied" : "asks each time";
      permRow.createSpan({ cls: `mva-hub-perm-status is-${cssState}`, text: label });
    }
  }

  body.createDiv({ cls: "mva-hub-accordion-section-label", text: "Documentation" });
  if (!isSafeDocName(it.name)) {
    body.createDiv({ cls: "mva-conn-empty", text: "Notes aren't available for this server's name." });
  } else {
    if (docRaw) {
      const preview = body.createDiv({ cls: "mva-hub-doc-preview markdown-rendered" });
      void MarkdownRenderer.render(ctx.app, summarizeMcpDoc(docRaw), preview, "", ctx.component);
      preview.createDiv({ cls: "mva-hub-doc-fade" });
    } else {
      body.createDiv({ cls: "mva-conn-empty", text: "No notes yet — describe what this server is for, so the agent knows when to use it." });
    }
    const notesBtn = body.createEl("button", { cls: "mva-btn mva-hub-notes-btn", text: docRaw ? "Edit notes" : "Add notes" });
    notesBtn.onclick = () => void openDocs(ctx, it);
  }

  return body;
}

/** Open a server's notes, seeding the template on first use. The note is plain
 *  vault markdown — the user edits it like any other, and the agent pulls it
 *  through `list_capabilities` when it needs to know what the server is for. */
async function openDocs(ctx: HubTabContext, it: DiscoveryItem): Promise<void> {
  const path = mcpDocPath(it.name);
  const adapter = ctx.app.vault.adapter;
  try {
    if (!(await adapter.exists(path))) {
      if (!(await adapter.exists(MCP_DOCS_DIR))) await adapter.mkdir(MCP_DOCS_DIR);
      await adapter.write(path, mcpDocTemplate(it.name, it.desc ?? ""));
    }
    await ctx.app.workspace.openLinkText(path, "", "tab");
    ctx.rerender();
  } catch (e) {
    new Notice(`Could not open the notes: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function doImport(ctx: HubTabContext, it: DiscoveryItem, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    const adapter = ctx.app.vault.adapter;
    let raw = '{\n  "mcpServers": {}\n}';
    try { raw = await adapter.read(".mcp.json"); } catch { /* create fresh */ }
    await adapter.write(".mcp.json", connectMcp(raw, it.name, it.config ?? {}));
    await applyAndRender(ctx, `MCP "${it.name}" connected.`);
  } catch (e) {
    new Notice(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    btn.disabled = false;
  }
}

/** Persist a `.mcp.json` change, then make it live: respawn the active session
 *  (which resumes, so the conversation survives) so the tools appear/vanish
 *  immediately. Falls back to a "applies next session" notice when no chat is
 *  open or a turn is running — the write already persisted regardless. */
async function applyAndRender(ctx: HubTabContext, okMsg: string): Promise<void> {
  const res = await ctx.plugin.reloadMcpConnections();
  new Notice(res.ok ? `${okMsg} Reconnected.` : `${okMsg} ${res.error ?? "Applies on the next session."}`);
  ctx.rerender();
}

async function doReconnect(ctx: HubTabContext, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.setText("Reconnecting…");
  const res = await ctx.plugin.reloadMcpConnections();
  new Notice(res.ok ? "Reconnected." : `Reconnect failed: ${res.error}`);
  ctx.rerender();
}

async function doReauth(ctx: HubTabContext, it: DiscoveryItem, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    const cli = await resolveCli("claude", ctx.plugin.settings.claudeBin);
    new Notice(`Opening browser to authenticate "${it.name}"…`);
    const res = await mcpLogin(cli, it.name, ctx.base());
    if (!res.ok) {
      const tail = res.output ? res.output.split("\n").filter(Boolean).slice(-1)[0] : "";
      new Notice(`Authentication failed for "${it.name}".${tail ? ` ${tail}` : ""}`);
      btn.disabled = false;
      return;
    }
    new Notice(`Authenticated "${it.name}". Reconnecting…`);
    await ctx.plugin.reloadMcpConnections();
    ctx.rerender();
  } catch (e) {
    new Notice(`Re-auth failed: ${e instanceof Error ? e.message : String(e)}`);
    btn.disabled = false;
  }
}

async function doLogout(ctx: HubTabContext, it: DiscoveryItem, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.setText("Disconnecting…");
  try {
    const cli = await resolveCli("claude", ctx.plugin.settings.claudeBin);
    const res = await mcpLogout(cli, it.name, ctx.base());
    if (!res.ok) {
      const tail = res.output ? res.output.split("\n").filter(Boolean).slice(-1)[0] : "";
      new Notice(`Disconnect failed for "${it.name}".${tail ? ` ${tail}` : ""}`);
      btn.disabled = false;
      btn.setText("Disconnect");
      return;
    }
    new Notice(`Disconnected "${it.name}". Reconnecting…`);
    await ctx.plugin.reloadMcpConnections();
    ctx.rerender();
  } catch (e) {
    new Notice(`Disconnect failed: ${e instanceof Error ? e.message : String(e)}`);
    btn.disabled = false;
    btn.setText("Disconnect");
  }
}

function doEditMcp(ctx: HubTabContext, it: DiscoveryItem): void {
  if (!it.config) return;
  new McpServerModal(ctx.app, {
    initial: { name: it.name, config: it.config },
    onSubmit: async (built) => {
      const adapter = ctx.app.vault.adapter;
      await adapter.write(".mcp.json", connectMcp(await adapter.read(".mcp.json"), built.name, built.config));
      await applyAndRender(ctx, `MCP "${built.name}" updated.`);
    },
  }).open();
}

async function doToggleMcp(ctx: HubTabContext, it: DiscoveryItem, enable: boolean, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    const adapter = ctx.app.vault.adapter;
    await adapter.write(".mcp.json", setMcpEnabled(await adapter.read(".mcp.json"), it.name, enable));
    await applyAndRender(ctx, `MCP "${it.name}" ${enable ? "enabled" : "disabled"}.`);
  } catch (e) {
    new Notice(`${enable ? "Enable" : "Disable"} failed: ${e instanceof Error ? e.message : String(e)}`);
    btn.disabled = false;
  }
}

async function doRemoveMcp(ctx: HubTabContext, it: DiscoveryItem, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    const adapter = ctx.app.vault.adapter;
    await adapter.write(".mcp.json", disconnectMcp(await adapter.read(".mcp.json"), it.name));
    await applyAndRender(ctx, `MCP "${it.name}" removed.`);
  } catch (e) {
    new Notice(`Removal failed: ${e instanceof Error ? e.message : String(e)}`);
    btn.disabled = false;
  }
}
