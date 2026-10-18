import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, Component, TFile } from "obsidian";
import { previewDocument } from "../src/core/ui-preview";

const mocks = vi.hoisted(() => ({ render: vi.fn(), mount: vi.fn() }));
vi.mock("../src/ui/ui-preview", () => ({ mountUiPreview: mocks.mount }));
vi.mock("obsidian", () => {
  class Owner {
    callbacks: Array<() => void> = [];
    children: Owner[] = [];
    register(callback: () => void) { this.callbacks.push(callback); }
    registerEvent() {}
    addChild(child: Owner) { this.children.push(child); return child; }
    unload() { this.children.forEach(child => child.unload()); this.callbacks.forEach(callback => callback()); }
  }
  return { Component: Owner, MarkdownRenderer: { render: mocks.render } };
});
import { Component as Owner } from "obsidian";
import { mountFileUiPreview, renderChatMarkdown } from "../src/obsidian/ui-previews";
import { disposeTranscriptPreviews } from "../src/obsidian/preview-lifecycle";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const app = {} as App;
function codeBlock(language: string, text: string) {
  const replaceWith = vi.fn();
  const pre = { classList: { contains: () => false }, closest: () => null, replaceWith };
  return { classList: { contains: (name: string) => name === `language-${language}` }, parentElement: pre, textContent: text, replaceWith };
}

beforeEach(() => {
  mocks.render.mockReset().mockResolvedValue(undefined);
  mocks.mount.mockReset().mockImplementation(() => ({ update: vi.fn(), dispose: vi.fn() }));
  vi.stubGlobal("createDiv", vi.fn(() => ({ closest: () => null, ownerDocument: { defaultView: null } })));
});
afterEach(() => vi.unstubAllGlobals());

describe("preview document boundary", () => {
  it("installs the restrictive policy before any generated executable content", () => {
    const source = '<!doctype html><script>document.body.dataset.ready="yes"</script><button>Run</button>';
    const document = previewDocument(source, "html");
    expect(document.indexOf("Content-Security-Policy")).toBeLessThan(document.indexOf("<script>"));
    expect(document).toContain(source);
    for (const directive of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'"]) {
      expect(document).toContain(directive);
    }
    expect(document).not.toContain("unsafe-eval");
  });
  it("preserves SVG markup and sizes it to the frame", () => {
    expect(previewDocument('<svg viewBox="0 0 50 20"><circle r="4"/></svg>', "svg"))
      .toContain('body>svg{max-width:100%;height:auto}');
  });
});

describe("assistant Markdown preview integration", () => {
  it("enhances HTML/SVG code after rendering without handling other languages", async () => {
    const blocks = [codeBlock("html", "<button>Open</button>"), codeBlock("svg", "<svg/>"), codeBlock("js", "alert(1)")];
    const element = { isConnected: true, closest: () => null, parentElement: null, querySelectorAll: () => blocks } as unknown as HTMLElement;
    await renderChatMarkdown(app, "markdown", element, "", new Owner());
    expect(mocks.render).toHaveBeenCalledOnce();
    expect(mocks.mount).toHaveBeenCalledTimes(2);
    expect(mocks.mount.mock.calls.map(call => call[3])).toEqual(["<button>Open</button>", "<svg/>"]);
    expect(blocks[2]!.replaceWith).not.toHaveBeenCalled();
  });
  it.each(["owner unloaded", "target removed"])("does not mount a late preview after %s", async reason => {
    const pending = deferred<void>();
    mocks.render.mockReturnValue(pending.promise);
    const block = codeBlock("html", "<p>Late</p>");
    const element = { isConnected: true, closest: () => null, parentElement: null, querySelectorAll: () => [block] };
    const owner = new Owner();
    const rendering = renderChatMarkdown(app, "markdown", element as unknown as HTMLElement, "", owner);
    if (reason === "owner unloaded") owner.unload();
    else element.isConnected = false;
    pending.resolve();
    await rendering;
    expect(mocks.mount).not.toHaveBeenCalled();
  });
  it.each(["tab detached", "target removed", "conversation deleted"])("handles a held render after %s", async reason => {
    const pending = deferred<void>();
    mocks.render.mockReturnValue(pending.promise);
    let retained = true;
    const list = { contains: () => retained } as unknown as HTMLElement;
    const element = {
      isConnected: reason === "tab detached", closest: () => list,
      querySelectorAll: () => [codeBlock("html", "<button>Ready</button>")],
    };
    const rendering = renderChatMarkdown(app, "markdown", element as unknown as HTMLElement, "", new Owner());
    element.isConnected = false;
    if (reason === "target removed") retained = false;
    if (reason === "conversation deleted") disposeTranscriptPreviews(list);
    pending.resolve();
    await rendering;
    expect(mocks.mount).toHaveBeenCalledTimes(reason === "tab detached" ? 1 : 0);
  });
});

describe("file preview reads", () => {
  function fixture() {
    const pending: ReturnType<typeof deferred<string>>[] = [];
    const handlers = new Map<string, (file: TFile) => void>();
    const file = { name: "screen.html", extension: "html" } as TFile;
    const status = { setText: vi.fn() };
    const parent = { createDiv: () => status, closest: () => null, ownerDocument: { defaultView: null } } as unknown as HTMLElement;
    const owner = new Owner();
    const fileApp = { vault: {
      cachedRead: () => { const read = deferred<string>(); pending.push(read); return read.promise; },
      on: (event: string, handler: (file: TFile) => void) => { handlers.set(event, handler); return {}; },
    } } as unknown as App;
    mountFileUiPreview(fileApp, owner as Component, parent, file);
    const preview = mocks.mount.mock.results[0]!.value;
    return { pending, handlers, file, owner, status, preview };
  }
  it("applies only the newest file contents when reads complete out of order", async () => {
    const f = fixture();
    f.handlers.get("modify")!(f.file);
    f.pending[1]!.resolve("new"); await tick();
    f.pending[0]!.resolve("old"); await tick();
    expect(f.preview.update.mock.calls).toEqual([["new"]]);
  });
  it("does not resurrect a deleted file's preview from a held read", async () => {
    const f = fixture();
    f.handlers.get("delete")!(f.file);
    f.pending[0]!.resolve("old"); await tick();
    expect(f.preview.update.mock.calls).toEqual([[""]]);
    expect(f.status.setText).toHaveBeenLastCalledWith("This preview file was deleted.");
  });
  it("blocks publication after the view unloads", async () => {
    const f = fixture(); f.owner.unload();
    f.pending[0]!.resolve("late"); await tick();
    expect(f.preview.update).not.toHaveBeenCalled();
  });
  it("shows a read failure instead of leaving a loading placeholder", async () => {
    const f = fixture(); f.pending[0]!.reject(new Error("missing")); await tick();
    expect(f.status.setText).toHaveBeenLastCalledWith("Preview unavailable. Open the file to inspect it.");
  });
});
