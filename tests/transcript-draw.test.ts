import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ChatView } from "../src/view";
import type { Convo } from "../src/ui/convo-types";

/**
 * Opening the panel draws only the active chat; every other chat draws its
 * history on first use, through `ChatView.transcript` (see `Convo.drawn`).
 *
 * The hazard this guards: before the explicit flag, "drawn" was inferred from
 * an empty list. Anything appended to a never-drawn list (a new turn, the queue
 * chips, a delegated child's approval card) made it look drawn, and the history
 * never appeared when the tab was opened. These tests run the real `ChatView`
 * methods on a fake list element.
 */

vi.mock("electron", () => ({ webUtils: {}, shell: {}, ipcRenderer: {} }));
vi.mock("obsidian", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  const cls = ["Component", "Modal", "FuzzySuggestModal", "SuggestModal", "PluginSettingTab", "Setting", "Menu", "MarkdownView", "TFolder", "AbstractInputSuggest", "EditorSuggest", "Plugin", "Scope", "MarkdownRenderChild", "ItemView", "FileView", "TextFileView", "View", "Events", "FileSystemAdapter", "ButtonComponent", "TextAreaComponent", "DropdownComponent", "ToggleComponent", "TextComponent", "SliderComponent", "ExtraButtonComponent", "SearchComponent", "SettingGroup", "SecretComponent"];
  const fns = ["debounce", "normalizePath", "requestUrl", "moment", "addIcon", "getIcon", "setTooltip", "sanitizeHTMLToDom", "parseYaml", "stringifyYaml", "getAllTags", "prepareFuzzySearch", "renderResults", "htmlToMarkdown", "arrayBufferToBase64", "base64ToArrayBuffer", "setIcon"];
  const out: Record<string, unknown> = { ...real };
  for (const n of cls) if (!(n in out)) out[n] = class {};
  for (const n of fns) if (!(n in out)) out[n] = () => undefined;
  out.MarkdownRenderer = { render: () => Promise.resolve() };
  return out;
});

/** Just enough of Obsidian's HTMLElement helpers for the transcript paths. */
class El {
  children: El[] = [];
  parent: El | null = null;
  cls: string[];
  attrs: Record<string, string>;
  text: string;
  hidden = false;
  onclick: unknown = null;
  constructor(o: { cls?: string; attr?: Record<string, unknown>; text?: string } = {}) {
    this.cls = (o.cls ?? "").split(/\s+/).filter(Boolean);
    this.attrs = Object.fromEntries(Object.entries(o.attr ?? {}).map(([k, v]) => [k, String(v)]));
    this.text = o.text ?? "";
  }
  get childElementCount(): number { return this.children.length; }
  createDiv(o?: { cls?: string; attr?: Record<string, unknown>; text?: string }): El { return this.appendChild(new El(o)); }
  createSpan(o?: { cls?: string; attr?: Record<string, unknown>; text?: string }): El { return this.createDiv(o); }
  createEl(_tag: string, o?: { cls?: string; attr?: Record<string, unknown>; text?: string }): El { return this.createDiv(o); }
  appendChild(child: El): El {
    child.remove();
    child.parent = this;
    this.children.push(child);
    return child;
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  empty(): void { for (const c of [...this.children]) c.remove(); }
  hide(): void { this.hidden = true; }
  show(): void { this.hidden = false; }
  addClass(c: string): void { this.cls.push(c); }
  setAttr(k: string, v: string): void { this.attrs[k] = v; }
  querySelectorAll(sel: string): El[] {
    const want = sel.replace(/^\./, "");
    const hits: El[] = [];
    const walk = (e: El) => { for (const c of e.children) { if (c.cls.includes(want)) hits.push(c); walk(c); } };
    walk(this);
    return hits;
  }
  querySelector(sel: string): El | null { return this.querySelectorAll(sel)[0] ?? null; }
  closest(sel: string): El | null { return this.cls.includes(sel.replace(/^\./, "")) ? this : this.parent?.closest(sel) ?? null; }
  contains(node: El): boolean { return this === node || this.children.some(child => child.contains(node)); }
}

let View: typeof ChatView;
beforeAll(async () => {
  View = (await import("../src/view")).ChatView;
}, 30_000);

const user = (text: string) => ({ role: "user" as const, text, at: 1 });
const reply = (md: string) => ({ role: "assistant" as const, segments: [{ t: "text" as const, md }] });

const convo = (id: string, messages: unknown[] = [], over: Partial<Convo> = {}): Convo =>
  ({ id, listEl: new El({ cls: "mva-list" }), drawn: false, title: "t", messages, queue: [], pendingEl: null, allow: new Set(), ...over }) as unknown as Convo;

/** A ChatView without Obsidian: the real prototype, the collaborators stubbed. */
const viewWith = (all: Convo[]): ChatView => {
  const v = Object.create(View.prototype) as Record<string, unknown>;
  Object.assign(v, {
    app: {},
    plugin: { settings: {} },
    active: convo("active-elsewhere"),
    convos: all,
    allConvos: () => all,
    refreshTabs: vi.fn(),
    scrollConvo: vi.fn(),
    rebuildOutline: vi.fn(),
    updateRecap: vi.fn(),
    attachTouched: vi.fn(),
    attachActions: vi.fn(),
    clickable: vi.fn(),
    register: vi.fn(),
  });
  return v as unknown as ChatView;
};

/** The `data-msg` of every turn in the list, in order: the history as drawn. */
const turns = (c: Convo): string[] =>
  (c.listEl as unknown as El).querySelectorAll(".mva-turn").map((t) => t.attrs["data-msg"] ?? "live");

const lastChild = (c: Convo): El => {
  const kids = (c.listEl as unknown as El).children;
  return kids[kids.length - 1];
};

type Private = { addUserTurn: ChatView["addUserTurn"]; clearEmptyState(c: Convo): void };

describe("transcript(): a chat's history is drawn once, on first use", () => {
  it("draws an undrawn chat and marks it drawn", () => {
    const c = convo("a", [user("hi"), reply("hello")]);
    viewWith([c]).transcript(c);
    expect(c.drawn).toBe(true);
    expect(turns(c)).toEqual(["0", "1"]);
  });

  it("never redraws a drawn chat: live DOM appended after the draw survives", () => {
    const c = convo("a", [user("hi")]);
    const view = viewWith([c]);
    view.transcript(c).createDiv({ cls: "live-marker" });
    view.transcript(c);
    expect((c.listEl as unknown as El).querySelector(".live-marker")).not.toBeNull();
    expect(turns(c)).toEqual(["0"]);
  });

  it("an empty chat is drawn as empty, so the empty state can follow", () => {
    const c = convo("a");
    viewWith([c]).transcript(c);
    expect(c.drawn).toBe(true);
    expect(c.listEl.childElementCount).toBe(0);
  });
});

describe("a message reaching a chat that was never drawn keeps its history", () => {
  it("a new user turn lands after the full history, drawn exactly once", () => {
    const c = convo("bg", [user("one"), reply("two")]);
    const view = viewWith([c]) as unknown as Private;
    view.addUserTurn(c, "three");
    expect(turns(c)).toEqual(["0", "1", "2"]);
    expect(c.messages).toHaveLength(3);
  });

  it("the first step of an assistant turn draws the history first", () => {
    const c = convo("bg", [user("one")]);
    (viewWith([c]) as unknown as Private).clearEmptyState(c);
    expect(turns(c)).toEqual(["0"]);
  });

  it("a streaming reply in a background chat lands after the history and survives the tab being opened", () => {
    const c = convo("bg", [user("one"), reply("two"), user("three")]);
    const view = viewWith([c]);
    const ctx = (view as unknown as { addAssistantTurn(c: Convo, t: string): { el: El; bodyEl: El } }).addAssistantTurn(c, "three");
    ctx.bodyEl.createDiv({ cls: "streamed-text" });
    view.transcript(c); // the user opens the tab mid-stream
    expect(turns(c)).toEqual(["0", "1", "2", "live"]);
    expect(lastChild(c)).toBe(ctx.el);
    expect(ctx.el.parent).toBe(c.listEl);
    expect(ctx.el.querySelector(".streamed-text")).not.toBeNull();
  });

  it("queued messages go below the history, not into an empty list", () => {
    const c = convo("bg", [user("one"), reply("two")], { queue: [{ text: "later" }] } as Partial<Convo>);
    viewWith([c]).renderQueue(c);
    expect(turns(c)).toEqual(["0", "1"]);
    expect(lastChild(c).cls).toContain("mva-queue");
  });

  it("a delegated child's question card goes below the parent's history", async () => {
    const { surfaceChildBlock } = await import("../src/ui/delegation");
    const parent = convo("parent", [user("delegate this"), reply("on it")]);
    const child = convo("child", [], { parentConvoId: "parent", pendingDecision: null } as Partial<Convo>);
    surfaceChildBlock(viewWith([parent, child]), { convoId: "child", state: "needs-input", reason: "ask" } as never);
    expect(turns(parent)).toEqual(["0", "1"]);
    expect(lastChild(parent).cls).toContain("mva-perm");
  });
});

describe("source contract: what view.ts itself guarantees", () => {
  const view = readFileSync(join(__dirname, "..", "src", "view.ts"), "utf8");

  it("opening the panel draws only the active chat", () => {
    const start = view.indexOf("const c: Convo = {");
    const end = view.indexOf("this.listHost.appendChild(this.transcript(this.active));", start);
    expect(start, "restore()'s Convo literal moved").toBeGreaterThan(-1);
    expect(end, "restore() no longer attaches the active chat through transcript()").toBeGreaterThan(start);
    expect(view.slice(start, end)).not.toContain("renderConvoDom(");
    expect(view.slice(start, end)).toContain("drawn: false");
  });

  it("only renderConvoDom writes straight into a chat's list; every other append goes through transcript()", () => {
    const writes = /\.listEl\.(createDiv|createEl|createSpan|appendChild|insertBefore)\(/g;
    const start = view.indexOf("  private renderConvoDom(c: Convo): void {");
    const end = view.indexOf("\n  }\n", start);
    for (const w of view.matchAll(writes)) expect(w.index! > start && w.index! < end, `direct list write in view.ts at offset ${w.index}`).toBe(true);
    // Elsewhere in src/, only these write into a list directly, and both only
    // ever touch the active chat, which is drawn before it becomes active.
    const activeOnly = new Set(["ui/empty-state.ts", "ui/reentry.ts"]);
    const src = join(__dirname, "..", "src");
    const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts") && f !== "view.ts");
    const offenders = files.filter((f) => !activeOnly.has(f) && new RegExp(writes.source).test(readFileSync(join(src, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
