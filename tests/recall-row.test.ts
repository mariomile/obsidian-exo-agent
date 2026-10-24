import { describe, it, expect } from "vitest";
import { bubbleThenRecall, renderRecallRow } from "../src/ui/recall-row";
import type { TurnRecall } from "../src/obsidian/turn-recall";

/** Just enough DOM for the recall row: element tree, classes, attributes and
 *  click handlers. */
class El {
  children: El[] = [];
  readonly classes = new Set<string>();
  readonly attrs: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  text = "";
  tabIndex = -1;
  private readonly handlers = new Map<string, ((e: unknown) => void)[]>();

  constructor(
    readonly tag = "div",
    o: { cls?: string; text?: string; attr?: Record<string, string>; href?: string } = {},
  ) {
    for (const c of (o.cls ?? "").split(/\s+/).filter(Boolean)) this.classes.add(c);
    this.text = o.text ?? "";
    Object.assign(this.attrs, o.attr ?? {});
  }
  private child(tag: string, o: object): El {
    const el = new El(tag, o);
    this.children.push(el);
    return el;
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
  hasClass(c: string): boolean {
    return this.classes.has(c);
  }
  toggleClass(c: string, on: boolean): void {
    if (on) this.classes.add(c);
    else this.classes.delete(c);
  }
  setAttr(k: string, v: string): void {
    this.attrs[k] = v;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  addEventListener(type: string, h: (e: unknown) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), h]);
  }
  click(): void {
    for (const h of this.handlers.get("click") ?? []) h({ preventDefault: () => {} });
  }
  all(): El[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  find(cls: string): El[] {
    return this.all().filter((e) => e.classes.has(cls));
  }
}

const recall: TurnRecall = {
  block: "x",
  notes: [{ path: "Notes/Pricing.md", excerpt: "Pro is 29" }],
  chats: [{ id: "c7", title: "Pricing call", date: "2026-09-23", snippet: "tiers", msgIndex: 4 }],
};

function render() {
  const turn = new El();
  const opened: string[] = [];
  const chats: [string, number | null][] = [];
  renderRecallRow(turn as unknown as HTMLElement, recall, {
    openPath: (p) => opened.push(p),
    openChat: (id, i) => chats.push([id, i]),
  });
  const items = turn.find("mva-recall-item");
  return { turn, opened, chats, noteItem: items[0], chatItem: items[1] };
}

describe("renderRecallRow", () => {
  it("a recalled chat is a link that opens that chat at the matching message", () => {
    const { chatItem, chats, opened } = render();
    const link = chatItem.find("mva-recall-text")[0];
    expect(link.tag).toBe("a");
    expect(link.text).toBe("Pricing call");
    expect(link.attrs.role).toBe("button");
    expect(link.attrs["aria-label"]).toBe("Open chat");
    link.click();
    expect(chats).toEqual([["c7", 4]]);
    expect(opened).toEqual([]);
  });

  it("a recalled note still opens its path", () => {
    const { noteItem, opened, chats } = render();
    const link = noteItem.find("mva-recall-text")[0];
    expect(link.tag).toBe("a");
    expect(link.text).toBe("Notes/Pricing.md");
    link.click();
    expect(opened).toEqual(["Notes/Pricing.md"]);
    expect(chats).toEqual([]);
  });

  it("no control in the row is a button element", () => {
    const { turn } = render();
    expect(turn.all().filter((e) => e.tag === "button")).toEqual([]);
  });

  it("a superseded note says so and links the note that replaced it", () => {
    const turn = new El();
    const opened: string[] = [];
    const demoted: TurnRecall = {
      block: "x",
      notes: [{ path: "D/2026-09-25-memoria.md", excerpt: "" }, { path: "D/2026-09-24-vault-lean.md", excerpt: "lean", supersededBy: "D/2026-09-25-memoria.md" }],
      chats: [],
    };
    renderRecallRow(turn as unknown as HTMLElement, demoted, { openPath: (p) => opened.push(p), openChat: () => {} });
    const [current, old] = turn.find("mva-recall-item");
    expect(current.find("mva-recall-meta").map((e) => e.text)).toEqual(["note"]);
    expect(old.find("mva-recall-meta").map((e) => e.text)).toEqual(["superseded", "by"]);
    const links = old.find("mva-recall-text");
    expect(links.map((l) => [l.tag, l.text])).toEqual([["a", "D/2026-09-24-vault-lean.md"], ["a", "2026-09-25-memoria"]]);
    links[1].click();
    expect(opened).toEqual(["D/2026-09-25-memoria.md"]);
  });
});

describe("bubbleThenRecall", () => {
  const open = { openPath: () => {}, openChat: () => {} };

  it("renders the bubble before recall starts, and does not wait on it", () => {
    const order: string[] = [];
    const turn = new El();
    void bubbleThenRecall(
      () => (order.push("bubble"), turn as unknown as HTMLElement),
      () => (order.push("recall"), new Promise<TurnRecall | null>(() => {})),
      open,
    );
    // Recall never resolves, yet the bubble is already there and the row is not.
    expect(order).toEqual(["bubble", "recall"]);
    expect(turn.find("mva-recall")).toEqual([]);
  });

  it("hangs the row under the bubble once recall resolves, and hands the recall back", async () => {
    const turn = new El();
    let resolve!: (r: TurnRecall | null) => void;
    const pending = bubbleThenRecall(() => turn as unknown as HTMLElement, () => new Promise((r) => (resolve = r)), open);
    expect(turn.find("mva-recall")).toEqual([]);
    resolve(recall);
    expect(await pending).toBe(recall);
    expect(turn.find("mva-recall")).toHaveLength(1);
  });

  it("no bubble (a retry reusing one) still returns the recall for the prompt", async () => {
    expect(await bubbleThenRecall(() => null, () => Promise.resolve(recall), open)).toBe(recall);
  });

  it("recall skipped: null, no row", async () => {
    const turn = new El();
    expect(await bubbleThenRecall(() => turn as unknown as HTMLElement, () => null, open)).toBeNull();
    expect(turn.find("mva-recall")).toEqual([]);
  });
});
