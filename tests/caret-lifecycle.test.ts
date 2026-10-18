import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { workingAffordance } from "../src/core/working-visibility";

// Exercise the actual view methods without constructing the plugin/session tree.
// The markdown renderer is held at its async boundary to reproduce late completion.
const source = ts.createSourceFile("view.ts", readFileSync(new URL("../src/view.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const view = source.statements.find((n): n is ts.ClassDeclaration => ts.isClassDeclaration(n) && n.name?.text === "ChatView")!;
const methods = ["renderText", "clearCaret", "syncWorking"].map(name => {
  const method = view.members.find(n => ts.isMethodDeclaration(n) && n.name.getText(source) === name);
  if (!method) throw new Error(`Missing ChatView.${name}`);
  return method.getText(source);
}).join("\n");
const compiled = ts.transpileModule(`class Harness { ${methods} }`, { compilerOptions: { target: ts.ScriptTarget.ES2021 } }).outputText;

function fixture() {
  const callbacks: Array<() => void> = [];
  const createSpan = vi.fn(() => ({ remove: vi.fn() }));
  const tail = { isConnected: true, empty: vi.fn() };
  const factory = new Function("renderChatMarkdown", "swapTailChild", "advanceBoundary", "caretHost", "workingAffordance", `${compiled}; return Harness;`);
  const Harness = factory(
    () => ({ then: (done: () => void) => { callbacks.push(done); } }),
    (_owner: unknown, ctx: { tailChild: object }) => (ctx.tailChild = {}),
    () => 0,
    () => ({ createSpan }),
    workingAffordance,
  );
  const harness = new Harness();
  harness.ensureWorking = vi.fn();
  harness.hideWorking = vi.fn();
  harness.diag = { push: vi.fn() };
  const ctx = {
    curTextEl: {}, curRaw: "A completed sentence.", stableLen: 0,
    tailEl: tail, tailChild: {}, finalized: false, textStreaming: true,
    caretEl: null as null | { remove: () => void },
    convo: { streaming: true }, openCards: 0,
  };
  return { harness, ctx, tail, callbacks, createSpan };
}

describe("streaming caret lifecycle", () => {
  it("removes the caret when text stops while the parent turn remains running", () => {
    const f = fixture();
    const remove = vi.fn();
    f.ctx.caretEl = { remove };
    f.ctx.textStreaming = false;
    f.harness.syncWorking(f.ctx);
    expect(remove).toHaveBeenCalledOnce();
    expect(f.ctx.caretEl).toBeNull();
    expect(f.harness.ensureWorking).toHaveBeenCalledOnce();
  });

  it.each(["text ended", "superseded render", "finalized", "detached"])("blocks a late markdown callback after %s", reason => {
    const f = fixture();
    f.harness.renderText(f.ctx, true);
    if (reason === "text ended") f.ctx.textStreaming = false;
    if (reason === "superseded render") f.harness.renderText(f.ctx, true);
    if (reason === "finalized") f.ctx.finalized = true;
    if (reason === "detached") f.tail.isConnected = false;
    f.callbacks[0]!();
    expect(f.createSpan).not.toHaveBeenCalled();
  });

  it("allows only the newest render to place a caret after text resumes", () => {
    const f = fixture();
    f.harness.renderText(f.ctx, true);
    f.ctx.textStreaming = false;
    f.harness.syncWorking(f.ctx);
    f.ctx.textStreaming = true;
    f.harness.renderText(f.ctx, true);
    f.callbacks[0]!();
    expect(f.createSpan).not.toHaveBeenCalled();
    f.callbacks[1]!();
    expect(f.createSpan).toHaveBeenCalledOnce();
  });

  it("removes the writing indicator when an interactive card takes precedence", () => {
    const f = fixture();
    const remove = vi.fn();
    f.ctx.caretEl = { remove };
    f.ctx.openCards = 1;
    f.harness.syncWorking(f.ctx);
    expect(remove).toHaveBeenCalledOnce();
    expect(f.harness.hideWorking).toHaveBeenCalledOnce();
  });
});
