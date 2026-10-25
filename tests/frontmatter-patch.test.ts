import { describe, expect, it } from "vitest";
import { frontmatterKeyLines, patchFrontmatter, setFrontmatterKeyLines } from "../src/core/frontmatter-patch";

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

describe("a key's span ends at its value", () => {
  const input = "---\nstatus: active\n\n# group two\nsuperseded_by: \"[[A]]\"\n\n  # indented note\ntags:\n  - vault\n  # kept inside the list\n  - x\n\n# trailing\n---\nBody\n";

  it("replacing a key leaves the blank and comment lines after it where they are", () => {
    expect(patchFrontmatter(input, { status: "superseded" })).toBe(input.replace("status: active", 'status: "superseded"'));
    expect(patchFrontmatter(input, { superseded_by: "[[B]]" })).toBe(input.replace('"[[A]]"', '"[[B]]"'));
  });

  it("a block value keeps a comment inside the list but not the ones after it", () => {
    expect(frontmatterKeyLines(input, "tags")).toEqual(["tags:", "  - vault", "  # kept inside the list", "  - x"]);
    expect(frontmatterKeyLines(input, "status")).toEqual(["status: active"]);
    expect(patchFrontmatter(input, { tags: ["y"] })).toBe(input.replace("tags:\n  - vault\n  # kept inside the list\n  - x", 'tags: ["y"]'));
  });

  it("removing a key keeps the lines after it", () => {
    expect(patchFrontmatter(input, {}, ["status"])).toBe(input.replace("status: active\n", ""));
  });

  it("read, write and undo agree: putting the key's lines back restores every byte", () => {
    for (const key of ["status", "superseded_by", "tags"]) {
      const before = frontmatterKeyLines(input, key);
      const next = patchFrontmatter(input, { [key]: "new" });
      expect(setFrontmatterKeyLines(next, key, before)).toBe(input);
    }
  });
});
