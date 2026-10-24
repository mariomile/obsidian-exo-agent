import { describe, expect, it } from "vitest";
import { patchFrontmatter, setFrontmatterKeyLines } from "../src/core/frontmatter-patch";

describe("patchFrontmatter", () => {
  it("preserves unrelated unquoted wikilinks byte-for-byte", () => {
    const input = `---\ncompany: [[Acme]]\nstatus: active\n---\n# Note\n`;
    expect(patchFrontmatter(input, { status: "done" })).toBe(
      `---\ncompany: [[Acme]]\nstatus: "done"\n---\n# Note\n`
    );
  });

  it("replaces a block value without leaving stale sequence items", () => {
    const input = `---\nrelated:\n  - "[[Old]]"\n  - "[[Other]]"\ncompany: [[Acme]]\n---\nBody`;
    expect(patchFrontmatter(input, { related: ["[[New]]"] })).toBe(
      `---\nrelated: ["[[New]]"]\ncompany: [[Acme]]\n---\nBody`
    );
  });

  it("adds frontmatter when absent", () => {
    expect(patchFrontmatter("# Note\n", { tags: ["type/note"] })).toBe(
      `---\ntags: ["type/note"]\n---\n# Note\n`
    );
  });

  it("appends a new key inside existing frontmatter", () => {
    const input = `---\ncompany: [[Acme]]\n---\nBody`;
    expect(patchFrontmatter(input, { related: ["[[One]]"] })).toBe(
      `---\ncompany: [[Acme]]\nrelated: ["[[One]]"]\n---\nBody`
    );
  });

  it("removes selected keys without touching adjacent wikilinks", () => {
    const input = `---\nevidence: 2\ncompany: [[Acme]]\nlast_confirmed: 2026-07-01\n---\nBody`;
    expect(patchFrontmatter(input, { status: "confirmed" }, ["evidence", "last_confirmed"])).toBe(
      `---\ncompany: [[Acme]]\nstatus: "confirmed"\n---\nBody`
    );
  });

  it("replaces an entire multiline value without leaving orphaned lines", () => {
    const input = `---\nsummary: |\n  first line\n\n  second line\ncompany: [[Acme]]\n---\nBody`;
    expect(patchFrontmatter(input, { summary: "short" })).toBe(
      `---\nsummary: "short"\ncompany: [[Acme]]\n---\nBody`
    );
  });

  it("a new frontmatter block on a CRLF note keeps the note's newlines", () => {
    expect(patchFrontmatter("# Note\r\nBody\r\n", { status: "superseded", superseded_by: "[[B]]" })).toBe(
      `---\r\nstatus: "superseded"\r\nsuperseded_by: "[[B]]"\r\n---\r\n# Note\r\nBody\r\n`
    );
    expect(setFrontmatterKeyLines("# Note\r\n", "status", ["status: active"])).toBe("---\r\nstatus: active\r\n---\r\n# Note\r\n");
  });
});
