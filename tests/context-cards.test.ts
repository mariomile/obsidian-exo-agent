import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TFile, type App } from "obsidian";
import { ContextCards, type ContextCardSpec } from "../src/ui/context-cards";

vi.mock("node:fs", { spy: true });

/* ---------------------------------------------------------------------------
 * A DOM stand-in rich enough to host the real reconciler. `mounts` counts every
 * card element created, which is the work the reconciler exists to avoid.
 * ------------------------------------------------------------------------ */

let mounts = 0;

class El {
  children: El[] = [];
  parentElement: El | null = null;
  readonly classes = new Set<string>();
  readonly dataset: Record<string, string> = {};
  readonly attrs: Record<string, string> = {};
  text = "";
  src = "";
  tabIndex = -1;
  onerror: (() => void) | null = null;
  private readonly handlers = new Map<string, ((e: unknown) => void)[]>();

  constructor(
    readonly tag = "div",
    o: { cls?: string; text?: string; attr?: Record<string, string> } = {}
  ) {
    for (const c of (o.cls ?? "").split(/\s+/).filter(Boolean)) this.classes.add(c);
    this.text = o.text ?? "";
    Object.assign(this.attrs, o.attr ?? {});
    if (this.classes.has("mva-doc-card")) mounts++;
  }
  private child(tag: string, o: { cls?: string; text?: string; attr?: Record<string, string> }): El {
    return this.appendChild(new El(tag, o));
  }
  createDiv(o = {}): El {
    return this.child("div", o);
  }
  createSpan(o = {}): El {
    return this.child("span", o);
  }
  createEl(tag: string, o = {}): El {
    return this.child(tag, o);
  }
  appendChild(el: El): El {
    el.remove();
    el.parentElement = this;
    this.children.push(el);
    return el;
  }
  remove(): void {
    const p = this.parentElement;
    if (p) p.children.splice(p.children.indexOf(this), 1);
    this.parentElement = null;
  }
  empty(): void {
    for (const c of [...this.children]) c.remove();
    this.text = "";
    delete this.dataset.icon;
  }
  addClass(c: string): void {
    this.classes.add(c);
  }
  removeClass(c: string): void {
    this.classes.delete(c);
  }
  toggleClass(c: string, on: boolean): void {
    if (on) this.classes.add(c);
    else this.classes.delete(c);
  }
  setText(t: string): void {
    this.text = t;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  addEventListener(type: string, h: (e: unknown) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), h]);
  }
  click(): void {
    for (const h of this.handlers.get("click") ?? []) h({ stopPropagation: () => {} });
  }
  find(cls: string): El[] {
    return this.children.flatMap((c) => [...(c.classes.has(cls) ? [c] : []), ...c.find(cls)]);
  }
}

/* ------------------------------ a fake vault ------------------------------ */

const file = (path: string): TFile =>
  Object.assign(new TFile(), { path, extension: path.split(".").pop() ?? "" }) as TFile;

interface Deferred {
  path: string;
  resolve: (s: string) => void;
}

function vault() {
  const files = new Map<string, TFile>();
  const bodies = new Map<string, string>();
  const reads: Deferred[] = [];
  let manual = false;
  const app = {
    vault: {
      getAbstractFileByPath: (p: string) => files.get(p) ?? null,
      getResourcePath: (f: TFile) => `app://res/${f.path}?${(f as TFile & { rev?: number }).rev ?? 0}`,
      cachedRead: (f: TFile) =>
        manual
          ? new Promise<string>((resolve) => reads.push({ path: f.path, resolve }))
          : Promise.resolve(bodies.get(f.path) ?? ""),
    },
  } as unknown as App;
  return {
    app,
    reads,
    add(path: string, body = "") {
      files.set(path, file(path));
      bodies.set(path, body);
    },
    edit(path: string, body: string) {
      bodies.set(path, body);
    },
    holdReads() {
      manual = true;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const noop = () => {};
const doc = (path: string, label = "Document", extra: Partial<ContextCardSpec> = {}): ContextCardSpec =>
  ({ kind: "doc", path, label, onClick: noop, onRemove: noop, ...extra }) as ContextCardSpec;

describe("ContextCards", () => {
  let v: ReturnType<typeof vault>;
  let host: El;
  let cards: ContextCards;
  const cardEls = () => host.find("mva-doc-card");
  const thumbs = () => host.find("mva-doc-thumb");

  beforeEach(() => {
    mounts = 0;
    v = vault();
    v.add("A.md", "# Alpha\nbody a");
    v.add("B.md", "body b");
    v.add("pic.png");
    host = new El();
    cards = new ContextCards(v.app, host as unknown as HTMLElement);
  });

  const three = () => [doc("A.md", "Current Document"), doc("B.md"), doc("pic.png")];

  it("an unchanged refresh mounts zero cards (the old full rebuild mounted all of them again)", async () => {
    cards.render(three());
    await flush();
    expect(mounts).toBe(3);
    const before = cardEls();
    cards.render(three());
    await flush();
    expect(mounts).toBe(3); // was 6 over two refreshes: every refresh remounted 3
    expect(cardEls()).toEqual(before);
    expect(thumbs()[0].text).toBe("Alpha\nbody a");
  });

  it("paints the same DOM as a fresh mount", async () => {
    cards.render(three());
    await flush();
    const [a, , img] = cardEls();
    expect([...a.classes]).toEqual(["mva-doc-card"]);
    expect(a.find("mva-doc-title")[0]).toMatchObject({ text: "A", attrs: { title: "A.md" } });
    expect(a.find("mva-doc-kind")[0].text).toBe("Current Document");
    expect(a.find("mva-doc-x")[0].attrs["aria-label"]).toBe("Remove from context");
    expect(a.attrs.role).toBe("button");
    expect(img.find("mva-doc-thumb")[0].classes.has("is-image")).toBe(true);
    expect(img.find("mva-doc-thumb")[0].children[0]).toMatchObject({ tag: "img", src: "app://res/pic.png?0" });
  });

  it("an edited note refreshes its thumb in place, without a remount", async () => {
    cards.render(three());
    await flush();
    const card = cardEls()[1];
    v.edit("B.md", "now different");
    cards.render(three());
    await flush();
    expect(mounts).toBe(3);
    expect(cardEls()[1]).toBe(card);
    expect(thumbs()[1].text).toBe("now different");
  });

  it("an empty note becomes a file-text icon and back", async () => {
    cards.render([doc("B.md")]);
    await flush();
    v.edit("B.md", "---\na: 1\n---\n[[x]]");
    cards.render([doc("B.md")]);
    await flush();
    expect(thumbs()[0]).toMatchObject({ text: "", dataset: { icon: "file-text" } });
    expect(thumbs()[0].classes.has("is-icon")).toBe(true);
    v.edit("B.md", "back");
    cards.render([doc("B.md")]);
    await flush();
    expect(thumbs()[0].classes.has("is-icon")).toBe(false);
    expect(thumbs()[0].text).toBe("back");
  });

  it("drops a late thumb result overtaken by a newer read", async () => {
    v.holdReads();
    cards.render([doc("B.md")]);
    cards.render([doc("B.md")]);
    expect(v.reads).toHaveLength(2);
    v.reads[1].resolve("newer");
    await flush();
    v.reads[0].resolve("stale");
    await flush();
    expect(thumbs()[0].text).toBe("newer");
  });

  it("drops a late thumb result for a card that is gone or replaced", async () => {
    v.holdReads();
    cards.render([doc("B.md")]);
    const old = thumbs()[0];
    cards.render([doc("B.md", "Current Document")]); // label change: new card, new read
    v.reads[1].resolve("fresh");
    await flush();
    v.reads[0].resolve("late");
    await flush();
    expect(old.text).toBe("");
    expect(thumbs()).toHaveLength(1);
    expect(thumbs()[0].text).toBe("fresh");
    cards.render([]);
    v.add("C.md");
    cards.render([doc("C.md")]);
    v.reads[2].resolve("c body");
    await flush();
    expect(thumbs()[0].text).toBe("c body");
  });

  it("a rename remounts only the renamed card and keeps order", async () => {
    cards.render(three());
    await flush();
    const [a, , img] = cardEls();
    v.add("B2.md", "body b");
    cards.render([doc("A.md", "Current Document"), doc("B2.md"), doc("pic.png")]);
    await flush();
    expect(mounts).toBe(4);
    const now = cardEls();
    expect(now[0]).toBe(a);
    expect(now[2]).toBe(img);
    expect(now[1].find("mva-doc-title")[0].text).toBe("B2");
    expect(host.children[0].children).toHaveLength(3);
  });

  it("reorders reused cards without remounting them", async () => {
    cards.render(three());
    const [a, b, img] = cardEls();
    cards.render([doc("pic.png"), doc("A.md", "Current Document"), doc("B.md")]);
    expect(mounts).toBe(3);
    expect(cardEls()).toEqual([img, a, b]);
  });

  it("suggested to attached is a different card", () => {
    cards.render([doc("A.md", "Open note · click to attach", { suggested: true })]);
    expect(cardEls()[0].classes.has("is-suggested")).toBe(true);
    cards.render([doc("A.md", "Current Document")]);
    expect(mounts).toBe(2);
    expect(cardEls()[0].classes.has("is-suggested")).toBe(false);
  });

  it("clicks and removes call the latest callbacks of a reused card", () => {
    const calls: string[] = [];
    cards.render([doc("A.md", "Document", { onClick: () => calls.push("open1"), onRemove: () => calls.push("rm1") })]);
    cards.render([doc("A.md", "Document", { onClick: () => calls.push("open2"), onRemove: () => calls.push("rm2") })]);
    expect(mounts).toBe(1);
    cardEls()[0].click();
    host.find("mva-doc-x")[0].click();
    expect(calls).toEqual(["open2", "rm2"]);
  });

  it("selection card: unchanged is kept, a new selection remounts, source suffix follows the active doc", () => {
    const calls: string[] = [];
    const sel = (text: string, path: string, activePath: string | null): ContextCardSpec => ({
      kind: "selection",
      text,
      path,
      activePath,
      onClick: () => calls.push(`attach:${text}`),
      onRemove: () => calls.push("dismiss"),
    });
    cards.render([doc("A.md", "Current Document"), sel("hello", "A.md", "A.md")]);
    const card = cardEls()[1];
    expect([...card.classes]).toEqual(["mva-doc-card", "mva-sel-card"]);
    expect(card.find("mva-doc-kind")[0].text).toBe("Selection · 5 chars");
    expect(card.find("mva-doc-thumb")[0].dataset.icon).toBe("text-cursor-input");
    expect(card.find("mva-doc-x")[0].attrs["aria-label"]).toBe("Dismiss selection");
    cards.render([doc("A.md", "Current Document"), sel("hello", "A.md", "A.md")]);
    expect(mounts).toBe(2);
    cards.render([doc("A.md", "Current Document"), sel("hello", "A.md", null)]);
    expect(mounts).toBe(3);
    expect(cardEls()[1].find("mva-doc-kind")[0].text).toBe("Selection · 5 chars · A");
    cards.render([doc("A.md", "Current Document"), sel("hello world", "A.md", null)]);
    expect(mounts).toBe(4);
    cardEls()[1].click();
    host.find("mva-doc-x")[1].click();
    expect(calls).toEqual(["attach:hello world", "dismiss"]);
  });

  it("an empty list collapses the row, and the next render rebuilds it", () => {
    cards.render(three());
    cards.render([]);
    expect(host.children).toHaveLength(0);
    cards.render([doc("A.md")]);
    expect(host.children).toHaveLength(1);
    expect(host.children[0].classes.has("mva-doc-cards")).toBe(true);
    expect(mounts).toBe(4);
  });

  it("external paths get a folder or file icon and no vault read", () => {
    cards.render([doc(tmpdir(), "External"), doc("/definitely/not/here.txt", "External")]);
    const [dir, missing] = thumbs();
    expect(dir.dataset.icon).toBe("folder");
    expect(missing.dataset.icon).toBe("file");
    expect(dir.classes.has("is-icon")).toBe(true);
    cards.render([doc(tmpdir(), "External"), doc("/definitely/not/here.txt", "External")]);
    expect(mounts).toBe(2);
  });

  it("probes an external path once per render and notices when a folder becomes a file", () => {
    const path = mkdtempSync(join(tmpdir(), "exo-context-card-"));
    vi.mocked(statSync).mockClear();
    try {
      cards.render([doc(path, "External")]);
      expect(statSync).toHaveBeenCalledTimes(1);
      expect(thumbs()[0].dataset.icon).toBe("folder");

      rmSync(path, { recursive: true });
      writeFileSync(path, "now a file");
      cards.render([doc(path, "External")]);
      expect(statSync).toHaveBeenCalledTimes(2);
      expect(thumbs()[0].dataset.icon).toBe("file");
      expect(mounts).toBe(2);

      cards.render([doc(path, "External")]);
      expect(statSync).toHaveBeenCalledTimes(3);
      expect(mounts).toBe(2);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("an image that fails to load falls back to an icon, and the next refresh tries the image again", () => {
    cards.render([doc("pic.png")]);
    const failed = thumbs()[0].children[0];
    failed.onerror?.();
    expect(thumbs()[0]).toMatchObject({ dataset: { icon: "image" } });
    expect(thumbs()[0].classes.has("is-image")).toBe(false);
    expect(thumbs()[0].children).toHaveLength(0);
    cards.render([doc("pic.png")]);
    const retry = thumbs()[0].children[0];
    expect(retry).toMatchObject({ tag: "img", src: "app://res/pic.png?0" });
    expect(retry).not.toBe(failed);
    expect(thumbs()[0].classes.has("is-image")).toBe(true);
    expect(thumbs()[0].classes.has("is-icon")).toBe(false);
    expect(mounts).toBe(1);
  });

  it("a healthy image is kept across refreshes", () => {
    cards.render([doc("pic.png")]);
    const img = thumbs()[0].children[0];
    cards.render([doc("pic.png")]);
    cards.render([doc("pic.png")]);
    expect(thumbs()[0].children).toEqual([img]);
  });

  it("a late error from a replaced image cannot clear the current thumb", () => {
    const pic = v.app.vault.getAbstractFileByPath("pic.png") as TFile & { rev?: number };
    cards.render([doc("pic.png")]);
    const old = thumbs()[0].children[0];
    pic.rev = 1; // edited image: new resource path
    cards.render([doc("pic.png")]);
    const current = thumbs()[0].children[0];
    expect(current.src).toBe("app://res/pic.png?1");
    old.onerror?.();
    expect(thumbs()[0].children).toEqual([current]);
    expect(thumbs()[0].classes.has("is-image")).toBe(true);
    // ...and the stale error did not mark the card failed: the next refresh keeps it.
    cards.render([doc("pic.png")]);
    expect(thumbs()[0].children).toEqual([current]);
  });

  it("a markup-only edit adopts the new body without a repaint, so the next refresh skips the strip pass", async () => {
    const model = () => (cards as unknown as { records: { model: unknown }[] }).records[0].model as { raw: string };
    cards.render([doc("B.md")]);
    await flush();
    const textNode = thumbs()[0];
    let writes = 0;
    const setText = textNode.setText.bind(textNode);
    textNode.setText = (t: string) => {
      writes++;
      setText(t);
    };
    v.edit("B.md", "**body b**"); // same preview text once markup is stripped
    cards.render([doc("B.md")]);
    await flush();
    expect(writes).toBe(0);
    expect(textNode.text).toBe("body b");
    const adopted = model();
    expect(adopted.raw).toBe("**body b**");
    cards.render([doc("B.md")]);
    await flush();
    expect(model()).toBe(adopted); // unchanged body: the cached model is reused as is
    expect(writes).toBe(0);
  });

  it("a missing vault file shows a file icon", () => {
    cards.render([doc("gone.md")]);
    expect(thumbs()[0].dataset.icon).toBe("file");
  });
});
