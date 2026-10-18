import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, Component } from "obsidian";

// Model only the DOM operations the real component uses. Navigation writes are
// recorded so lifecycle assertions cannot pass on a merely unchanged string.
const { ElementShim, ModalShim } = vi.hoisted(() => {
  type Options = { cls?: string; text?: string; attr?: Record<string, string> };
  class ElementShim {
    readonly children: ElementShim[] = [];
    readonly attrs = new Map<string, string>();
    readonly classes = new Set<string>();
    readonly listeners = new Map<string, ((event: Event) => void)[]>();
    parentElement: ElementShim | null = null;
    textContent = "";
    hidden = false;
    disabled = false;
    srcdocWrites: string[] = [];
    onclick: ((event: Event) => void) | null = null;

    constructor(readonly tagName: string, options: Options = {}) {
      this.textContent = options.text ?? "";
      this.addClass(...(options.cls ?? "").split(" ").filter(Boolean));
      for (const [name, value] of Object.entries(options.attr ?? {})) this.setAttribute(name, value);
    }
    createEl(tag: string, options?: Options): ElementShim {
      const child = new ElementShim(tag, options);
      child.parentElement = this;
      this.children.push(child);
      return child;
    }
    createDiv(options?: Options): ElementShim { return this.createEl("div", options); }
    addClass(...names: string[]): void { names.forEach((name) => this.classes.add(name)); }
    setText(text: string): void { this.textContent = text; }
    setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
    getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
    addEventListener(type: string, listener: (event: Event) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    remove(): void {
      if (!this.parentElement) return;
      this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
      this.parentElement = null;
    }
    set srcdoc(value: string) { this.srcdocWrites.push(value); }
    get srcdoc(): string { return this.srcdocWrites.at(-1) ?? ""; }
    fire(type: string, key?: string): void {
      if (type === "click" && this.disabled) return;
      const event = new Event(type, { bubbles: true });
      if (key) Object.defineProperty(event, "key", { value: key });
      let target: ElementShim | null = this;
      while (target) {
        if (type === "click") target.onclick?.(event);
        for (const listener of target.listeners.get(type) ?? []) listener(event);
        if (event.cancelBubble) break;
        target = target.parentElement;
      }
    }
    all(tag: string): ElementShim[] {
      return this.children.flatMap((child) => [
        ...(child.tagName === tag ? [child] : []), ...child.all(tag),
      ]);
    }
  }
  class ModalShim {
    static instances: ModalShim[] = [];
    readonly modalEl = new ElementShim("dialog");
    readonly titleEl = this.modalEl.createEl("h2");
    readonly contentEl = this.modalEl.createDiv();
    opened = false;
    closeCount = 0;
    constructor() { ModalShim.instances.push(this); }
    onOpen(): void {}
    onClose(): void {}
    open(): void { this.opened = true; this.onOpen(); }
    close(): void {
      if (!this.opened) return;
      this.opened = false;
      this.closeCount++;
      this.onClose();
    }
  }
  return { ElementShim, ModalShim };
});

vi.mock("obsidian", () => ({ Modal: ModalShim, setIcon: vi.fn() }));

import { mountUiPreview, type UiPreviewOptions } from "../src/ui/ui-preview";
import { previewDocument } from "../src/core/ui-preview";

const SOURCE = '<button onclick="this.textContent=\'Clicked\'">Try me</button>';
type Element = InstanceType<typeof ElementShim>;
const button = (root: Element, label: string): Element => {
  const found = root.all("button").find((el) => el.getAttribute("aria-label") === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};
const preview = (root: Element) => button(root, "Show interactive preview");
const code = (root: Element) => button(root, "Show preview source code");
const expand = (root: Element) => button(root, "Expand preview");

function fixture(options: UiPreviewOptions = {}) {
  const root = new ElementShim("section");
  const cleanups: (() => void)[] = [];
  const owner = { register: (cleanup: () => void) => cleanups.push(cleanup) };
  const controller = mountUiPreview(
    {} as App, owner as unknown as Component, root as unknown as HTMLElement, SOURCE, options,
  );
  return { root, controller, unload: () => cleanups.forEach((cleanup) => cleanup()) };
}

beforeEach(() => { ModalShim.instances.length = 0; });
afterEach(() => { ModalShim.instances.forEach((modal) => modal.close()); });

describe("UI preview component lifecycle", () => {
  it("keeps code inert and creates no iframe until Preview is selected", () => {
    const { root, controller } = fixture();
    expect(root.all("iframe")).toHaveLength(0);
    expect(root.all("code")[0].textContent).toBe(SOURCE);
    expect(root.all("pre")[0].hidden).toBe(false);
    expect(code(root).getAttribute("aria-pressed")).toBe("true");
    expect(button(root, "Reload preview").disabled).toBe(true);

    preview(root).fire("click");
    const [frame] = root.all("iframe");
    expect(frame.srcdoc).toBe(previewDocument(SOURCE, "html"));
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("title")).toBe("HTML preview");
    expect(root.all("pre")[0].hidden).toBe(true);
    expect(preview(root).getAttribute("aria-pressed")).toBe("true");
    controller.dispose();
  });

  it("removes the running iframe in Code and creates a fresh document on returning", () => {
    const { root, controller } = fixture({ initiallyOpen: true });
    const [first] = root.all("iframe");
    code(root).fire("click");
    expect(first.parentElement).toBeNull();
    expect(root.all("iframe")).toHaveLength(0);
    preview(root).fire("click");
    const [second] = root.all("iframe");
    expect(second).not.toBe(first);
    expect(second.srcdoc).toBe(previewDocument(SOURCE, "html"));
    expect(second.srcdocWrites).toHaveLength(1);
    controller.dispose();
  });

  it("updates inline and expanded source while equal-source updates preserve running state", () => {
    const { root, controller } = fixture({ initiallyOpen: true, title: "dashboard.html" });
    expand(root).fire("click");
    expand(root).fire("click");
    expect(ModalShim.instances).toHaveLength(1);
    const modal = ModalShim.instances[0];
    const [inlineFrame] = root.all("iframe");
    const [modalFrame] = modal.contentEl.all("iframe");
    expect(modal.titleEl.textContent).toBe("dashboard.html");
    controller.update(SOURCE);
    preview(root).fire("click");
    expect(inlineFrame.srcdocWrites).toHaveLength(1);
    expect(modalFrame.srcdocWrites).toHaveLength(1);

    const next = "<h1>Updated source</h1>";
    controller.update(next);
    for (const container of [root, modal.contentEl]) {
      expect(container.all("iframe")[0].srcdoc).toBe(previewDocument(next, "html"));
      expect(container.all("code")[0].textContent).toBe(next);
    }
    controller.dispose();
  });

  it("discards expanded frames on close and reopens with the latest source", () => {
    const { root, controller } = fixture();
    expand(root).fire("click");
    const firstModal = ModalShim.instances[0];
    const [firstFrame] = firstModal.contentEl.all("iframe");
    firstModal.close();
    expect(firstFrame.parentElement).toBeNull();
    expect(firstModal.contentEl.children).toHaveLength(0);
    const next = "<h1>New revision</h1>";
    controller.update(next);
    expect(root.all("iframe")).toHaveLength(0);
    expand(root).fire("click");
    expect(ModalShim.instances[1].contentEl.all("iframe")[0].srcdoc).toBe(previewDocument(next, "html"));
    controller.dispose();
  });

  it("clears both active previews for empty source and recovers when content arrives", () => {
    const { root, controller } = fixture({ initiallyOpen: true, language: "svg" });
    expand(root).fire("click");
    const modal = ModalShim.instances[0];
    controller.update("  \n ");
    for (const container of [root, modal.contentEl]) {
      expect(container.all("iframe")).toHaveLength(0);
      expect(button(container, "Reload preview").disabled).toBe(true);
      expect(container.all("div").find((el) => el.classes.has("mva-ui-preview-empty"))?.hidden).toBe(false);
    }
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20"/></svg>';
    controller.update(svg);
    for (const container of [root, modal.contentEl]) {
      expect(container.all("iframe")[0].srcdoc).toBe(previewDocument(svg, "svg"));
    }
    controller.dispose();
  });

  it("reloads explicitly without making Code mode execute a document", () => {
    const { root, controller } = fixture();
    button(root, "Reload preview").fire("click");
    expect(root.all("iframe")).toHaveLength(0);
    preview(root).fire("click");
    const [frame] = root.all("iframe");
    button(root, "Reload preview").fire("click");
    expect(frame.srcdocWrites).toHaveLength(2);
    expect(frame.srcdocWrites[1]).toBe(previewDocument(SOURCE, "html"));
    controller.dispose();
  });

  it("owner cleanup closes both views and prevents stale actions or updates resurrecting them", () => {
    const { root, controller, unload } = fixture({ initiallyOpen: true });
    const stalePreview = preview(root);
    const staleExpand = expand(root);
    const [inlineFrame] = root.all("iframe");
    expand(root).fire("click");
    const modal = ModalShim.instances[0];
    const [modalFrame] = modal.contentEl.all("iframe");
    unload();
    unload();
    controller.dispose();
    controller.update("<h1>Too late</h1>");
    stalePreview.fire("click");
    staleExpand.fire("click");
    expect(root.children).toHaveLength(0);
    expect(modal.contentEl.children).toHaveLength(0);
    expect(modal.closeCount).toBe(1);
    expect(inlineFrame.parentElement).toBeNull();
    expect(modalFrame.parentElement).toBeNull();
    expect(inlineFrame.srcdocWrites).toHaveLength(1);
    expect(modalFrame.srcdocWrites).toHaveLength(1);
    expect(ModalShim.instances).toHaveLength(1);
  });

  it("isolates toolbar clicks and Enter/Space activation from clickable artifact headers", () => {
    const { root, controller } = fixture();
    const headerClick = vi.fn();
    const headerKey = vi.fn();
    root.addEventListener("click", headerClick);
    root.addEventListener("keydown", headerKey);
    preview(root).fire("click");
    preview(root).fire("keydown", "Enter");
    code(root).fire("keydown", " ");
    expect(headerClick).not.toHaveBeenCalled();
    expect(headerKey).not.toHaveBeenCalled();
    code(root).fire("keydown", "ArrowRight");
    expect(headerKey).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
});
