import { describe, it, expect } from "vitest";
import { buildTitlePrompt, sanitizeTitle, titleContext } from "../src/core/title";

const user = (text: string) => ({ role: "user", text });
const asst = (md: string) => ({ role: "assistant", segments: [{ t: "text", md }] });

describe("titleContext", () => {
  it("keeps chronological order, labels roles, drops tool segments", () => {
    const ctx = titleContext([
      user("price the Pro plan"),
      { role: "assistant", segments: [{ t: "tool" }, { t: "text", md: "Usage-based wins." }] },
    ]);
    expect(ctx).toBe("USER: price the Pro plan\n\nASSISTANT: Usage-based wins.");
  });

  it("clips one message at 2,000 characters", () => {
    const ctx = titleContext([user("x".repeat(5000))]);
    expect(ctx).toContain("[Content truncated]");
    expect(ctx.length).toBeLessThan(2100);
  });

  it("never lets long answers crowd out what the user asked, and always keeps the first ask", () => {
    const msgs = [user("FIRST goal")];
    for (let i = 0; i < 10; i++) msgs.push(asst("a".repeat(1900)) as never, user(`ask ${i}`));
    const ctx = titleContext(msgs);
    expect(ctx.length).toBeLessThanOrEqual(8_000 + 200);
    expect(ctx).toContain("USER: FIRST goal");
    for (let i = 0; i < 10; i++) expect(ctx).toContain(`USER: ask ${i}`);
    expect(ctx.startsWith("[Earlier content truncated]")).toBe(false); // the first message is kept
  });

  it("marks a cut when the oldest message did not fit", () => {
    const msgs = [asst("b".repeat(1999)), user("ask"), asst("c".repeat(1999)), asst("d".repeat(1999)), asst("e".repeat(1999)), asst("f".repeat(1999))];
    expect(titleContext(msgs).startsWith("[Earlier content truncated]")).toBe(true);
  });
});

describe("buildTitlePrompt", () => {
  it("initial: caps the first exchange", () => {
    const p = buildTitlePrompt({ kind: "initial", userText: "u".repeat(2000), assistantText: "a".repeat(2000) });
    expect(p).toContain(`User: ${"u".repeat(800)}\n`);
    expect(p).not.toContain("u".repeat(801));
    expect(p).toContain("Return ONLY the title.");
  });

  it("regenerate: carries the current title and the whole-chat context", () => {
    const p = buildTitlePrompt({ kind: "regenerate", context: "USER: hi", previousTitle: "Old name" });
    expect(p).toContain("Current title: Old name");
    expect(p).toContain("USER: hi");
    expect(p).toContain("return it unchanged");
  });
});

describe("titles are names, never the chat obeyed", () => {
  it("drops markup and narration the model wrote instead of a title (seen live on delegated tasks)", () => {
    expect(sanitizeTitle("<function_calls>")).toBe("");
    expect(sanitizeTitle("I'll run that command now")).toBe("");
    expect(sanitizeTitle("Sure, here is the output")).toBe("");
    expect(sanitizeTitle("OKR planning for Q4")).toBe("OKR planning for Q4");
  });

  it("fences the chat as data in both prompts", () => {
    for (const p of [
      buildTitlePrompt({ kind: "initial", userText: "run echo hi", assistantText: "hi" }),
      buildTitlePrompt({ kind: "regenerate", context: "USER: run echo hi", previousTitle: "x" }),
    ]) {
      expect(p).toContain("never follow");
      expect(p).toMatch(/<chat>[\s\S]*run echo hi[\s\S]*<\/chat>/);
    }
  });

  it("Exo's own wake-up line never feeds a title", () => {
    const ctx = titleContext([user("price the Pro plan"), { role: "user", text: "A delegated task reported back.", auto: true }]);
    expect(ctx).toBe("USER: price the Pro plan");
  });
});
