import { describe, it, expect, beforeAll } from "vitest";
import { renderSavePanel, answerIndex, type SavePanelDeps } from "../src/ui/save-panel";
import type { Provenance } from "../src/core/block-patch";
import type { SaveTarget } from "../src/core/save-target";
import type { SaveReceipt } from "../src/core/save-undo";
import type { Message } from "../src/core/model";
import { FakeEl, asEl } from "./fake-dom";

const P: Provenance = { convoId: "c1", msgIndex: 1, chatTitle: "Pricing", date: "2026-10-24" };

beforeAll(() => {
  // openablePopover listens on document for outside clicks; node has none.
  (globalThis as { document?: unknown }).document ??= { addEventListener() {}, removeEventListener() {} };
});

function setup(over: Partial<SavePanelDeps> & { notes?: Record<string, string> } = {}) {
  const notes = over.notes ?? { "Projects/Pricing.md": "# Pricing\n\n## Decisions\n- one\n\n## Notes\ntext\n" };
  const saves: { target: SaveTarget; text: string; provenance: Provenance }[] = [];
  const receipts: SaveReceipt[] = [];
  let picked: ((p: string) => void) | null = null;
  const deps: SavePanelDeps = {
    active: "Projects/Pricing.md",
    touched: [],
    provenance: P,
    read: async (p) => notes[p] ?? null,
    pick: (on) => {
      picked = on;
    },
    save: async (input) => {
      saves.push(input);
      const r: SaveReceipt = {
        id: "exo-abc123",
        op: "insert",
        path: input.target.path,
        section: input.target.section,
        lines: ["x"],
        provenance: input.provenance,
        savedAt: 1,
      };
      return r;
    },
    receipt: (_el, r) => void receipts.push(r),
    ...over,
  };
  const host = new FakeEl();
  const panel = renderSavePanel(asEl(host), "two", deps);
  return { host, panel, saves, receipts, notes, pick: (p: string) => picked?.(p) };
}

const saveBtn = (host: FakeEl) => host.byText("Save")!;
const diffText = (host: FakeEl) => host.find("mva-diff")[0]?.textContent ?? "";
const option = (host: FakeEl, label: string) => host.find("mva-sel-opt").find((o) => o.textContent === label)!;

describe("save panel", () => {
  it("defaults to the active note, end of note, and previews the block", async () => {
    const { host, panel } = setup();
    await panel.idle();
    expect(host.find("mva-gallery-chip").find((c) => c.hasClass("is-active"))?.textContent).toBe("Pricing");
    expect(host.find("mva-sel-chip")[0].textContent).toBe("End of note");
    expect(diffText(host)).toContain("two");
    expect(diffText(host)).toContain('[fonte: chat "Pricing"');
    expect(saveBtn(host).hasClass("is-disabled")).toBe(false);
  });

  it("no active note: only the picker, Save disabled until a note is chosen", async () => {
    const { host, panel, pick } = setup({ active: null });
    await panel.idle();
    expect(host.find("mva-gallery-chip").map((c) => c.textContent)).toEqual(["Choose note..."]);
    expect(host.textContent).toContain("Open a note or choose one to save into.");
    expect(saveBtn(host).hasClass("is-disabled")).toBe(true);
    host.byText("Choose note...")!.click();
    pick("Projects/Pricing.md");
    await panel.idle();
    expect(saveBtn(host).hasClass("is-disabled")).toBe(false);
    expect(host.find("mva-gallery-chip").find((c) => c.hasClass("is-active"))?.textContent).toBe("Pricing");
  });

  it("touched notes are offered after the active one", async () => {
    const { host, panel } = setup({ touched: ["CRM/People/Ada.md", "Projects/Pricing.md", "img.png"] });
    await panel.idle();
    expect(host.find("mva-gallery-chip").map((c) => c.textContent)).toEqual(["Pricing", "Ada", "Choose note..."]);
  });

  it("changing section re-renders the diff in that section", async () => {
    const { host, panel } = setup();
    await panel.idle();
    host.find("mva-sel-chip")[0].click();
    option(host, "## Decisions").click();
    expect(host.find("mva-sel-chip")[0].textContent).toBe("## Decisions");
    const d = diffText(host);
    expect(d).toContain("- one");
    expect(d).toMatch(/- two \[fonte: chat "Pricing"/);
  });

  it("New section... asks for a name and previews the heading", async () => {
    const { host, panel } = setup();
    await panel.idle();
    host.find("mva-sel-chip")[0].click();
    option(host, "New section...").click();
    expect(saveBtn(host).hasClass("is-disabled")).toBe(true);
    const name = host.all().find((c) => c.getAttribute("placeholder") === "Section name")!;
    name.input("Open questions");
    expect(diffText(host)).toContain("## Open questions");
    expect(saveBtn(host).hasClass("is-disabled")).toBe(false);
  });

  it("editing the text re-renders the diff; empty text is nothing to save", async () => {
    const { host, panel } = setup();
    await panel.idle();
    const field = host.all().find((c) => c.tag === "textarea")!;
    expect(field.value).toBe("two");
    field.input("three");
    expect(diffText(host)).toContain("three");
    field.input("   ");
    expect(host.textContent).toContain("Nothing to save.");
    expect(saveBtn(host).hasClass("is-disabled")).toBe(true);
  });

  it("Save calls the adapter with the exact target and provenance, then shows the receipt", async () => {
    const { host, panel, saves, receipts } = setup();
    await panel.idle();
    host.find("mva-sel-chip")[0].click();
    option(host, "## Decisions").click();
    saveBtn(host).click();
    await panel.idle();
    expect(saves).toEqual([
      {
        target: { path: "Projects/Pricing.md", section: { kind: "heading", heading: "Decisions", level: 2, occurrence: 0 } },
        text: "two",
        provenance: P,
      },
    ]);
    expect(receipts).toHaveLength(1);
    expect(host.find("mva-rethink")).toHaveLength(0);
  });

  it("a second press while saving does not save twice", async () => {
    const { host, panel, saves } = setup();
    await panel.idle();
    saveBtn(host).click();
    expect(saveBtn(host).hasClass("is-disabled")).toBe(true);
    saveBtn(host).click();
    await panel.idle();
    expect(saves).toHaveLength(1);
  });

  it("a failed write says so and lets Mario retry", async () => {
    const { host, panel } = setup({ save: async () => Promise.reject(new Error("disk")) });
    await panel.idle();
    saveBtn(host).click();
    await panel.idle();
    expect(host.textContent).toContain("Couldn't save to this note.");
    expect(saveBtn(host).hasClass("is-disabled")).toBe(false);
  });

  it("a section gone at save time asks for another and keeps the panel", async () => {
    const { host, panel, receipts } = setup({ save: async () => ({ error: "section-missing" }) });
    await panel.idle();
    saveBtn(host).click();
    await panel.idle();
    expect(host.textContent).toContain("Section not found. Pick another.");
    expect(receipts).toHaveLength(0);
    expect(host.find("mva-rethink")).toHaveLength(1);
  });

  it("Cancel closes without saving", async () => {
    const { host, panel, saves, notes } = setup();
    const before = { ...notes };
    await panel.idle();
    host.byText("Cancel")!.click();
    expect(saves).toEqual([]);
    expect(notes).toEqual(before);
    expect(host.find("mva-rethink")).toHaveLength(0);
  });

  it("every control is a span with role=button; no button or select element", async () => {
    const { host, panel } = setup();
    await panel.idle();
    host.find("mva-sel-chip")[0].click();
    const controls = [saveBtn(host), host.byText("Cancel")!, ...host.find("mva-gallery-chip"), ...host.find("mva-sel-chip"), ...host.find("mva-sel-opt")];
    for (const c of controls) {
      expect(c.tag === "span" || c.tag === "div").toBe(true);
      expect(c.getAttribute("role")).toBe("button");
    }
    expect(host.all().some((c) => c.tag === "button" || c.tag === "select")).toBe(false);
  });
});

describe("answerIndex", () => {
  const msgs: Message[] = [
    { role: "user", text: "q1" },
    { role: "assistant", segments: [{ t: "text", md: "a" }, { t: "tool", name: "x", input: {}, ok: true, output: "" }, { t: "text", md: "b" }] },
    { role: "user", text: "q2" },
    { role: "assistant", segments: [{ t: "text", md: "ab" }] },
  ];
  it("is the last assistant message whose text is the answer", () => {
    expect(answerIndex(msgs, "ab")).toBe(3);
  });
  it("falls back to the next index when the answer is not stored yet", () => {
    expect(answerIndex(msgs, "zzz")).toBe(4);
  });
});
