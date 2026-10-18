import { describe, it, expect } from "vitest";
import { caretHost, type CaretNode } from "../src/core/caret-host";

/** Build a stub node: n("P", "text") or n("UL", null, [n("LI", "a"), n("LI", "b")]). */
function n(tagName: string, text: string | null, children: CaretNode[] = []): CaretNode {
  return {
    tagName,
    lastElementChild: children.length ? children[children.length - 1] : null,
    textContent: text ?? children.map((c) => c.textContent ?? "").join(""),
  };
}

describe("caretHost", () => {
  it("never places the writing caret inside an interactive preview", () => {
    const preview = n("DIV", null, [n("DIV", "Preview help text")]);
    preview.classList = { contains: name => name === "mva-ui-preview" };
    expect(caretHost(n("DIV", null, [preview]))).toBeNull();
  });
  it("returns null for an empty tail (no element children)", () => {
    expect(caretHost(n("DIV", ""))).toBeNull();
  });

  it("hosts in a simple trailing paragraph", () => {
    const p = n("P", "hello");
    expect(caretHost(n("DIV", null, [p]))).toBe(p);
  });

  it("stops at the paragraph when it ends with inline markup", () => {
    const strong = n("STRONG", "bold");
    const p = n("P", null, [strong]);
    expect(caretHost(n("DIV", null, [p]))).toBe(p);
  });

  it("descends nested lists to the deepest last item", () => {
    const deep = n("LI", "deep");
    const inner = n("UL", null, [deep]);
    const li = n("LI", null, [n("P", "outer"), inner]);
    const ul = n("UL", null, [li]);
    expect(caretHost(n("DIV", null, [ul]))).toBe(deep);
  });

  it("returns null when the last block is empty/whitespace", () => {
    const p = n("P", "  \n ");
    expect(caretHost(n("DIV", null, [n("P", "before"), p]))).toBeNull();
  });

  it("returns null when the tail ends with a non-text block (hr)", () => {
    expect(caretHost(n("DIV", null, [n("P", "before"), n("HR", "")]))).toBeNull();
  });

  it("hosts inside code for a trailing fence", () => {
    const code = n("CODE", "const x = 1");
    const pre = n("PRE", null, [code]);
    expect(caretHost(n("DIV", null, [pre]))).toBe(code);
  });

  it("hosts in the last table cell", () => {
    const td = n("TD", "cell");
    const tr = n("TR", null, [td]);
    const tbody = n("TBODY", null, [tr]);
    const table = n("TABLE", null, [tbody]);
    expect(caretHost(n("DIV", null, [table]))).toBe(td);
  });

  it("returns null for an empty list (no LI to host in)", () => {
    expect(caretHost(n("DIV", null, [n("UL", "")]))).toBeNull();
  });
});
