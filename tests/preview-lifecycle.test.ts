import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
  class MockComponent {
    children: MockComponent[] = [];
    callbacks: Array<() => void> = [];
    unloaded = false;
    unloadCount = 0;
    register(callback: () => void) { this.callbacks.push(callback); }
    addChild(child: MockComponent) { this.children.push(child); return child; }
    removeChild(child: MockComponent) {
      this.children = this.children.filter(value => value !== child);
      child.unload();
      return child;
    }
    unload() {
      if (this.unloaded) return;
      this.unloaded = true;
      this.unloadCount++;
      for (const child of [...this.children]) child.unload();
      for (const callback of this.callbacks) callback();
    }
  }
  return { Component: MockComponent };
});

import { Component } from "obsidian";
import { disposeTranscriptPreviews, ownedPreviewComponent, previewTargetAlive } from "../src/obsidian/preview-lifecycle";

interface MockComponent extends Component {
  children: MockComponent[];
  unloaded: boolean;
  unloadCount: number;
}

function realm() {
  const observers: Observer[] = [];
  class Observer {
    disconnected = false;
    target: Node | null = null;
    options: MutationObserverInit | null = null;
    constructor(readonly callback: MutationCallback) { observers.push(this); }
    observe(target: Node, options: MutationObserverInit) { this.target = target; this.options = options; }
    disconnect() { this.disconnected = true; }
    deliver() {
      if (!this.disconnected) this.callback([], this as unknown as MutationObserver);
    }
  }
  const document = { defaultView: { MutationObserver: Observer } };
  class Element {
    parent: Element | null = null;
    children: Element[] = [];
    ownerDocument = document;
    constructor(readonly transcript = false) {}
    get parentElement() { return this.parent; }
    append(node: Element) {
      node.remove();
      this.children.push(node);
      node.parent = this;
    }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
      this.parent = null;
    }
    contains(node: Element) {
      for (let current: Element | null = node; current; current = current.parent) {
        if (current === this) return true;
      }
      return false;
    }
    closest(selector: string) {
      if (selector !== ".mva-list") throw new Error(`Unexpected selector: ${selector}`);
      for (let current: Element | null = this; current; current = current.parent) {
        if (current.transcript) return current;
      }
      return null;
    }
    asHtml() { return this as unknown as HTMLElement; }
  }
  return { Element, observers, deliver: () => { for (const observer of observers) observer.deliver(); } };
}

function fixture() {
  const r = realm();
  const root = new r.Element();
  const list = new r.Element(true);
  const turn = new r.Element();
  const node = new r.Element();
  root.append(list); list.append(turn); turn.append(node);
  const owner = new Component() as MockComponent;
  const child = ownedPreviewComponent(owner, node.asHtml()) as MockComponent;
  return { ...r, root, list, turn, node, owner, child };
}

describe("transcript-owned preview resources", () => {
  it("shares one observer between previews and releases only removed nodes", () => {
    const f = fixture();
    const other = new f.Element(); f.turn.append(other);
    const second = ownedPreviewComponent(f.owner, other.asHtml()) as MockComponent;
    expect(f.observers).toHaveLength(1);
    expect(f.observers[0]!.target).toBe(f.list);
    expect(f.observers[0]!.options).toEqual({ childList: true, subtree: true });

    f.node.remove(); f.deliver();
    expect(f.child.unloaded).toBe(true);
    expect(f.owner.children).toEqual([second]);
    expect(second.unloaded).toBe(false);
    expect(f.observers[0]!.disconnected).toBe(false);

    other.remove(); f.deliver();
    expect(second.unloaded).toBe(true);
    expect(f.owner.children).toEqual([]);
    expect(f.observers[0]!.disconnected).toBe(true);
  });

  it("unloads previews in a removed subtree or a cleared transcript", () => {
    const f = fixture();
    const secondTurn = new f.Element();
    const other = new f.Element(); f.list.append(secondTurn); secondTurn.append(other);
    const second = ownedPreviewComponent(f.owner, other.asHtml()) as MockComponent;
    f.turn.remove(); f.deliver();
    expect(f.child.unloaded).toBe(true);
    expect(second.unloaded).toBe(false);
    secondTurn.remove(); f.deliver();
    expect(second.unloaded).toBe(true);
    expect(f.observers[0]!.disconnected).toBe(true);
  });

  it("preserves a detached transcript when switching tabs", () => {
    const f = fixture();
    f.list.remove(); f.deliver();
    expect(f.child.unloaded).toBe(false);
    f.root.append(f.list); f.deliver();
    expect(f.child.unloaded).toBe(false);
    expect(f.observers[0]!.disconnected).toBe(false);
    f.owner.unload();
  });

  it("preserves a preview moved or reinserted inside the same transcript before delivery", () => {
    const f = fixture();
    const otherTurn = new f.Element(); f.list.append(otherTurn);
    f.node.remove(); otherTurn.append(f.node); f.deliver();
    expect(f.child.unloaded).toBe(false);
    f.owner.unload();
  });

  it("releases a preview moved outside its captured transcript", () => {
    const f = fixture();
    const otherList = new f.Element(true); f.root.append(otherList);
    otherList.append(f.node); f.deliver();
    expect(f.child.unloaded).toBe(true);
    expect(f.owner.children).toEqual([]);
  });

  it("explicitly disposes permanently deleted conversations, even while detached", () => {
    const f = fixture();
    f.list.remove();
    disposeTranscriptPreviews(f.list.asHtml());
    disposeTranscriptPreviews(f.list.asHtml());
    expect(f.child.unloadCount).toBe(1);
    expect(f.owner.children).toEqual([]);
    expect(f.observers[0]!.disconnected).toBe(true);
  });

  it("disconnects on owner or child cleanup and creates a fresh registry afterward", () => {
    const f = fixture();
    f.owner.removeChild(f.child);
    expect(f.observers[0]!.disconnected).toBe(true);
    const second = ownedPreviewComponent(f.owner, f.node.asHtml()) as MockComponent;
    expect(f.observers).toHaveLength(2);
    expect(f.observers[1]!.disconnected).toBe(false);
    f.owner.unload();
    expect(second.unloaded).toBe(true);
    expect(f.observers[1]!.disconnected).toBe(true);
  });

  it("uses each transcript's document realm, including popouts", () => {
    const first = fixture(); const popout = fixture();
    first.node.remove(); first.deliver();
    expect(first.child.unloaded).toBe(true);
    expect(popout.child.unloaded).toBe(false);
    expect(popout.observers[0]!.disconnected).toBe(false);
    popout.node.remove(); popout.deliver();
    expect(popout.child.unloaded).toBe(true);
  });

  it("falls back to owner cleanup when no transcript has been attached", () => {
    const r = realm();
    const node = new r.Element();
    const owner = new Component() as MockComponent;
    const child = ownedPreviewComponent(owner, node.asHtml()) as MockComponent;
    expect(r.observers).toHaveLength(0);
    owner.unload();
    expect(child.unloaded).toBe(true);
  });

  it("invalidates asynchronous publication as soon as the preview node is removed", async () => {
    const f = fixture();
    let resolve!: (value: string) => void;
    const pending = new Promise<string>(yes => { resolve = yes; });
    let disposed = false;
    const publish = vi.fn();
    f.child.register(() => { disposed = true; });
    const read = pending.then(source => { if (!disposed) publish(source); });
    f.node.remove(); f.deliver();
    resolve("late file contents"); await read;
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("asynchronous preview targets", () => {
  it("keeps a target alive while its reusable transcript is detached", () => {
    const f = fixture();
    const alive = previewTargetAlive(f.node.asHtml());
    f.list.remove();
    expect(alive()).toBe(true);
    f.root.append(f.list);
    expect(alive()).toBe(true);
    f.owner.unload();
  });

  it("rejects a removed target even when its transcript started detached", () => {
    const f = fixture(); f.list.remove();
    const alive = previewTargetAlive(f.node.asHtml());
    expect(alive()).toBe(true);
    f.node.remove();
    expect(alive()).toBe(false);
    f.owner.unload();
  });

  it("permanently invalidates a deleted transcript with no preview registry", () => {
    const r = realm();
    const list = new r.Element(true);
    const node = new r.Element(); list.append(node);
    const alive = previewTargetAlive(node.asHtml());
    expect(r.observers).toHaveLength(0);
    disposeTranscriptPreviews(list.asHtml());
    expect(alive()).toBe(false);
    const root = new r.Element(); root.append(list);
    expect(alive()).toBe(false);
    expect(previewTargetAlive(node.asHtml())()).toBe(false);
  });

  it("tracks a captured parent outside a transcript, including detached parents", () => {
    const r = realm();
    const parent = new r.Element(); const node = new r.Element(); parent.append(node);
    const alive = previewTargetAlive(node.asHtml());
    expect(alive()).toBe(true);
    node.remove();
    expect(alive()).toBe(false);
  });

  it.each([false, true])("preserves the standalone connected-state fallback, initially %s", connected => {
    const node = { closest: () => null, parentElement: null, isConnected: connected };
    const alive = previewTargetAlive(node as unknown as HTMLElement);
    expect(alive()).toBe(true);
    node.isConnected = false;
    expect(alive()).toBe(!connected);
  });
});
