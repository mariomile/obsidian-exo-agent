import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Component as ObsidianComponent } from "obsidian";

const { Component, mocks } = vi.hoisted(() => {
  class Component {
    readonly children = new Set<Component>();
    readonly cleanups: (() => void)[] = [];
    unloaded = false;
    register(cleanup: () => void): void { this.cleanups.push(cleanup); }
    addChild(child: Component): Component { this.children.add(child); return child; }
    removeChild(child: Component): Component {
      this.children.delete(child);
      child.unload();
      return child;
    }
    unload(): void {
      if (this.unloaded) return;
      this.unloaded = true;
      for (const child of this.children) child.unload();
      this.children.clear();
      this.cleanups.forEach((cleanup) => cleanup());
    }
  }
  return { Component, mocks: { markdown: vi.fn(), mount: vi.fn() } };
});

vi.mock("obsidian", () => ({ Component, MarkdownRenderer: { render: mocks.markdown } }));
vi.mock("../src/ui/ui-preview", () => ({ mountUiPreview: mocks.mount }));

import { renderChatMarkdown } from "../src/obsidian/ui-previews";
import { swapTailChild } from "../src/ui/tail-child";
import { advanceBoundary } from "../src/core/stream-scan";

/** Tree ownership matters here: emptying DOM must not implicitly unload its owner. */
class Node {
  children: Node[] = [];
  parentElement: Node | null = null;
  textContent = "";
  rootConnected = false;
  readonly ownerDocument = { defaultView: null };
  readonly classList = { contains: (name: string) => this.classes.includes(name) };
  constructor(readonly tag = "div", readonly classes: string[] = []) {}
  get isConnected(): boolean { return this.parentElement?.isConnected ?? this.rootConnected; }
  createDiv(options: { cls?: string } = {}): Node {
    return this.appendChild(new Node("div", (options.cls ?? "").split(" ")));
  }
  appendChild(child: Node): Node {
    child.remove();
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child: Node, before: Node): void {
    child.remove();
    child.parentElement = this;
    this.children.splice(this.children.indexOf(before), 0, child);
  }
  remove(): void {
    if (!this.parentElement) return;
    this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  replaceWith(next: Node): void {
    if (!this.parentElement) return;
    const parent = this.parentElement;
    const position = parent.children.indexOf(this);
    this.remove();
    next.parentElement = parent;
    parent.children.splice(position, 0, next);
  }
  empty(): void { [...this.children].forEach((child) => child.remove()); }
  descendants(): Node[] { return this.children.flatMap((child) => [child, ...child.descendants()]); }
  contains(node: Node): boolean { return node === this || this.descendants().includes(node); }
  querySelectorAll(selector: string): Node[] {
    if (selector !== "pre > code") throw new Error(`Unexpected selector: ${selector}`);
    return this.descendants().filter((node) => node.tag === "code" && node.parentElement?.tag === "pre");
  }
  closest(selector: string): Node | null {
    if (this.classes.includes(selector.slice(1))) return this;
    return this.parentElement?.closest(selector) ?? null;
  }
}

const source = ts.createSourceFile("view.ts", readFileSync(new URL("../src/view.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const view = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "ChatView")!;
const methods = ["renderText", "resetTextStream", "clearCaret"].map((name) => {
  const method = view.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(source) === name);
  if (!method) throw new Error(`Missing ChatView.${name}`);
  return method.getText(source);
}).join("\n");
const compiled = ts.transpileModule(`class Harness extends Component { ${methods} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2021 },
}).outputText;

function renderFence(markdown: string, element: Node): void {
  const fence = /^```(html|svg)\n([\s\S]*?)\n```$/.exec(markdown);
  if (!fence) throw new Error(`Unexpected Markdown fixture: ${markdown}`);
  const pre = element.appendChild(new Node("pre"));
  pre.appendChild(new Node("code", [`language-${fence[1]}`])).textContent = fence[2];
}

const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const fence = (language: "html" | "svg", label: string) =>
  `\`\`\`${language}\n${language === "html" ? `<button>${label}</button>` : `<svg><text>${label}</text></svg>`}\n\`\`\``;
const markers = (root: Node) => root.descendants().filter((node) => node.classes.includes("preview-marker"));

function fixture(language: "html" | "svg" = "html") {
  const factory = new Function("Component", "renderChatMarkdown", "swapTailChild", "advanceBoundary", "caretHost", `${compiled}; return Harness;`);
  const Harness = factory(Component, renderChatMarkdown, swapTailChild, advanceBoundary, () => null);
  const harness = new Harness();
  harness.app = {};
  harness.plugin = { settings: { featureWikilinkify: false } };
  harness.diag = { push: vi.fn() };
  harness.syncWorking = vi.fn();
  const root = new Node();
  root.rootConnected = true;
  const element = root.createDiv();
  const ctx = {
    curTextEl: element as Node | null, curRaw: fence(language, "Initial"), stableLen: 0,
    tailEl: null as Node | null, tailChild: null as ObsidianComponent | null,
    scanPos: 0, fenceOpen: false, lastBoundary: 0, curTextSeg: {},
    caretEl: null, finalized: false, textStreaming: false, sources: [], touched: [],
  };
  return { harness, ctx, root, element };
}

beforeEach(() => {
  mocks.markdown.mockReset().mockImplementation((_app, markdown: string, element: Node) => {
    renderFence(markdown, element);
    return Promise.resolve();
  });
  mocks.mount.mockReset().mockImplementation((_app, owner: InstanceType<typeof Component>, parent: Node, source: string) => {
    const marker = parent.createDiv({ cls: "preview-marker" });
    marker.textContent = source;
    owner.register(() => marker.remove());
    return { dispose: () => marker.remove(), update: vi.fn() };
  });
  vi.stubGlobal("createDiv", () => new Node());
});
afterEach(() => vi.unstubAllGlobals());

describe("UI previews at the shared tool/ask/error text boundary", () => {
  it.each(["html", "svg"] as const)("preserves a final %s fence without trailing blank lines until its view owner unloads", async (language) => {
    const f = fixture(language);
    expect(f.ctx.curRaw.endsWith("\n\n")).toBe(false);
    f.harness.renderText(f.ctx, true);
    await tick();
    const [streamingPreview] = markers(f.root);
    expect(streamingPreview.isConnected).toBe(true);
    expect(f.ctx.stableLen).toBe(0); // This fence still belongs to the transient tail.

    f.harness.resetTextStream(f.ctx);
    await tick();
    const finalPreviews = markers(f.root);
    expect(streamingPreview.isConnected).toBe(false);
    expect(finalPreviews).toHaveLength(1);
    expect(finalPreviews[0]).not.toBe(streamingPreview);
    expect(finalPreviews[0].textContent).toContain("Initial");
    expect(f.ctx.curTextEl).toBeNull();
    expect(f.ctx.tailChild).toBeNull();
    expect(f.harness.children.size).toBe(1);

    f.harness.unload();
    expect(finalPreviews[0].isConnected).toBe(false);
    expect(markers(f.root)).toHaveLength(0);
  });

  it.each(["stale first", "final first"])("prevents held Markdown from restoring an obsolete preview when completing %s", async (order) => {
    const pending: (() => void)[] = [];
    mocks.markdown.mockImplementation((_app, markdown: string, element: Node) => new Promise<void>((resolve) => {
      pending.push(() => { renderFence(markdown, element); resolve(); });
    }));
    const f = fixture();
    f.harness.renderText(f.ctx, true);
    const transientOwner = f.ctx.tailChild;
    f.ctx.curRaw = fence("html", "Final revision");
    f.harness.resetTextStream(f.ctx);
    expect(pending).toHaveLength(2);
    expect(transientOwner?.unloaded).toBe(true);
    const sequence = order === "stale first" ? [0, 1] : [1, 0];
    pending[sequence[0]]();
    await tick();
    expect(markers(f.root)).toHaveLength(order === "stale first" ? 0 : 1);
    pending[sequence[1]]();
    await tick();
    expect(mocks.mount).toHaveBeenCalledOnce();
    expect(markers(f.root)).toHaveLength(1);
    expect(markers(f.root)[0].textContent).toContain("Final revision");
    f.harness.unload();
    expect(markers(f.root)).toHaveLength(0);
  });

  it("keeps earlier completed segments alive through subsequent streaming-tail replacements", async () => {
    const f = fixture();
    f.harness.renderText(f.ctx, true);
    await tick();
    f.harness.resetTextStream(f.ctx);
    await tick();
    const [firstFinal] = markers(f.root);
    f.ctx.curTextEl = f.root.createDiv();
    f.ctx.curRaw = fence("svg", "Second segment");
    f.harness.renderText(f.ctx, true);
    await tick();
    f.harness.resetTextStream(f.ctx);
    await tick();
    expect(firstFinal.isConnected).toBe(true);
    expect(markers(f.root).map((node) => node.textContent)).toEqual([
      "<button>Initial</button>", "<svg><text>Second segment</text></svg>",
    ]);
    expect(f.harness.children.size).toBe(2);
    f.harness.unload();
    expect(markers(f.root)).toHaveLength(0);
  });

  it("does not mount a held final preview after the owning view unloads", async () => {
    let release!: () => void;
    mocks.markdown.mockImplementation((_app, markdown: string, element: Node) => new Promise<void>((resolve) => {
      release = () => { renderFence(markdown, element); resolve(); };
    }));
    const f = fixture();
    f.harness.resetTextStream(f.ctx);
    f.harness.unload();
    release();
    await tick();
    expect(mocks.mount).not.toHaveBeenCalled();
    expect(markers(f.root)).toHaveLength(0);
  });
});
