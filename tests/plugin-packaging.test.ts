import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageCss, settingsBlocks } from "../scripts/package-css.mjs";
import { deployToPluginDir, PLUGIN_FILES } from "../scripts/deploy.mjs";

const source = readFileSync("styles.css", "utf8");
const SETTINGS = /\/\*\s*@settings[\s\S]*?\*\//g;

/**
 * The stylesheet as a sequence of preludes and declarations, with every
 * difference that cannot change what a rule matches or sets taken out:
 * comments, runs of whitespace, space around selector combinators and
 * punctuation, the last `;` of a block, quotes around an identifier-valued
 * attribute selector. Any other change (a declaration, a selector, a value, an
 * order) survives the normalisation and fails the comparison. It is not
 * string-aware (comment-like text inside a quoted value is stripped on both
 * sides), so string literals are compared separately by `strings` below.
 */
function shape(css: string): string[] {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\s+/g, " ");
  const out: string[] = [];
  for (const m of flat.matchAll(/([^{};]*)([{};])/g)) {
    let piece = m[1].trim();
    if (m[2] === "{") {
      piece = piece
        .replace(/ ?([>+~,]) ?/g, "$1")
        .replace(/^(@media|@supports|@container) \(/, "$1(")
        .replace(/^@.*/, (at) => at.replace(/: /g, ":"))
        .replace(/(\[[\w-]+[\^*$|~]?=)"(-?[A-Za-z_][\w-]*)"\]/g, "$1$2]");
    } else {
      piece = piece
        .replace(/^([\w-]+) ?: ?/, "$1:")
        .replace(/ ?, ?/g, ",")
        .replace(/\( /g, "(")
        .replace(/ \)/g, ")")
        .replace(/ !important$/, "!important");
    }
    // `a:b;}` and `a:b}` close the same block: both read as `a:b;` then `}`.
    if (m[2] === "{") out.push(piece + "{");
    else {
      if (piece) out.push(piece + ";");
      if (m[2] === "}") out.push("}");
    }
  }
  return out;
}

/**
 * Every quoted string literal outside comments, in order, quotes included. An
 * attribute selector's identifier value (`[class^="mva-"]`) is left out: esbuild
 * drops those quotes, which `shape` already accounts for.
 */
function strings(css: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < css.length; i++) {
    if (css[i] === "\\") i++;
    else if (css.startsWith("/*", i)) i = css.indexOf("*/", i + 2) + 1;
    else if (css[i] === '"' || css[i] === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== css[i]) j += css[j] === "\\" ? 2 : 1;
      const lit = css.slice(i, j + 1);
      if (!(css[i - 1] === "=" && /^.-?[A-Za-z_][\w-]*.$/.test(lit))) out.push(lit);
      i = j;
    }
  }
  return out;
}

describe("packageCss (the styles.css a plugin folder receives)", () => {
  it("keeps every rule, declaration and their order, and only drops layout and comments", async () => {
    const packed = await packageCss(source);
    expect(packed.length).toBeLessThan(source.length * 0.7);
    expect(shape(packed)).toEqual(shape(source));
  });

  it("keeps the Style Settings block byte for byte, between the same rules", async () => {
    const packed = await packageCss(source);
    const blocks = source.match(SETTINGS) ?? [];
    expect(blocks).toHaveLength(1);
    expect(packed.match(SETTINGS)).toEqual(blocks);
    const [before, after] = source.split(blocks[0]);
    const [pBefore, pAfter] = packed.split(blocks[0]);
    expect(shape(pBefore)).toEqual(shape(before));
    expect(shape(pAfter)).toEqual(shape(after));
    // Every other comment is gone.
    expect(packed.replace(SETTINGS, "")).not.toContain("/*");
  });

  it("keeps non-ASCII content literal", async () => {
    const packed = await packageCss('.a::before { content: "·"; }\n');
    expect(packed).toBe('.a::before{content:"·"}\n');
  });

  it("keeps every quoted string literal unchanged and in order", async () => {
    const lits = strings(source);
    expect(lits.length).toBeGreaterThan(10);
    expect(strings(await packageCss(source))).toEqual(lits);
  });

  it("reads braces inside strings as text: a top-level block after `content: \"{\"` is kept", async () => {
    const css = '.a { content: "{"; }\n/* @settings\nname: x\n*/\n.b { color: red; }\n';
    expect(await packageCss(css)).toBe('.a{content:"{"}\n/* @settings\nname: x\n*/\n.b{color:red}\n');
  });

  it("refuses a block inside a declaration list, even after `content: \"}\"`, instead of splitting the rule", async () => {
    await expect(packageCss(".a { color: red; /* @settings\nname: x\n*/ }")).rejects.toThrow(/declaration list/);
    await expect(packageCss('.a { content: "}"; /* @settings\nname: x\n*/ color: red; }')).rejects.toThrow(
      /declaration list/,
    );
  });

  it("keeps a block between rules inside an at-rule, in place", async () => {
    const css = "@media (min-width: 1px) {\n  .a { color: red; }\n  /* @settings\nname: m\n*/\n  .b { color: blue; }\n}\n";
    expect(await packageCss(css)).toBe("@media(min-width:1px){.a{color:red}\n/* @settings\nname: m\n*/\n.b{color:blue}}\n");
  });

  it("does not take comment-like text in a string or an unquoted url() for a block", async () => {
    const quoted = '.a { content: "/* @settings name: fake */"; }\n.b { color: red; }\n';
    expect(settingsBlocks(quoted)).toEqual([]);
    expect(await packageCss(quoted)).toBe('.a{content:"/* @settings name: fake */"}.b{color:red}\n');
    const url = ".a { background: url(x/*y.png); }\n/* @settings\nname: q\n*/\n.b { c: d; }\n";
    expect(settingsBlocks(url)).toHaveLength(1);
    expect(await packageCss(url)).toBe(".a{background:url(x/*y.png)}\n/* @settings\nname: q\n*/\n.b{c:d}\n");
    // An escaped quote does not end the string, so its `{` is text too (esbuild
    // picks the other quote mark for the same value).
    const escaped = '.a { content: "\\"{"; }\n/* @settings\nname: e\n*/\n';
    expect(await packageCss(escaped)).toBe(".a{content:'\"{'}\n/* @settings\nname: e\n*/\n");
  });
});

describe("deployToPluginDir", () => {
  let root: string;
  let dir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "exo-pack-src-"));
    dir = join(mkdtempSync(join(tmpdir(), "exo-pack-out-")), "plugin");
    writeFileSync(join(root, "main.js"), "console.log(1);\n");
    writeFileSync(join(root, "manifest.json"), '{"id":"exo-agent"}\n');
    writeFileSync(join(root, "styles.css"), source);
  });
  const read = (d: string, f: string) => readFileSync(join(d, f), "utf8");

  it("production: packs styles.css, copies the rest as built, leaves the sources alone", async () => {
    await deployToPluginDir(dir, { production: true, root });
    expect(readdirSync(dir).sort()).toEqual([...PLUGIN_FILES].sort());
    expect(read(dir, "styles.css")).toBe(await packageCss(source));
    expect(read(dir, "main.js")).toBe(read(root, "main.js"));
    expect(read(dir, "manifest.json")).toBe(read(root, "manifest.json"));
    expect(read(root, "styles.css")).toBe(source);
  });

  it("dev: copies styles.css as written", async () => {
    await deployToPluginDir(dir, { production: false, root });
    expect(read(dir, "styles.css")).toBe(source);
  });

  it("a packing failure deploys nothing, so no half-updated plugin folder", async () => {
    writeFileSync(join(root, "styles.css"), ".a { /* @settings\nname: x\n*/ }");
    await expect(deployToPluginDir(dir, { production: true, root })).rejects.toThrow();
    expect(existsSync(dir)).toBe(false);
  });

  describe("never into the source folder (a production deploy rewrites styles.css)", () => {
    const unchanged = () => {
      expect(read(root, "styles.css")).toBe(source);
      expect(read(root, "main.js")).toBe("console.log(1);\n");
      expect(read(root, "manifest.json")).toBe('{"id":"exo-agent"}\n');
    };
    it("the same path", async () => {
      await expect(deployToPluginDir(root, { production: true, root })).rejects.toThrow(/source folder/);
      await expect(deployToPluginDir(join(root, "."), { production: false, root })).rejects.toThrow(/source folder/);
      unchanged();
    });
    it("a symlink to it, as the folder or as its parent", async () => {
      const alias = join(mkdtempSync(join(tmpdir(), "exo-pack-alias-")), "link");
      symlinkSync(root, alias);
      await expect(deployToPluginDir(alias, { production: true, root })).rejects.toThrow(/source folder/);
      await expect(deployToPluginDir(join(alias, "sub", ".."), { production: true, root })).rejects.toThrow(
        /source folder/,
      );
      unchanged();
    });
    it("a folder whose styles.css is the source file (symlink or hard link)", async () => {
      mkdirSync(dir, { recursive: true });
      linkSync(join(root, "styles.css"), join(dir, "styles.css"));
      await expect(deployToPluginDir(dir, { production: true, root })).rejects.toThrow(/source folder/);
      expect(existsSync(join(dir, "main.js"))).toBe(false);
      const other = join(mkdtempSync(join(tmpdir(), "exo-pack-out-")), "plugin");
      mkdirSync(other);
      symlinkSync(join(root, "styles.css"), join(other, "styles.css"));
      await expect(deployToPluginDir(other, { production: true, root })).rejects.toThrow(/source folder/);
      unchanged();
    });
  });

  it("an existing folder gets every file replaced", async () => {
    mkdirSync(dir, { recursive: true });
    for (const f of PLUGIN_FILES) writeFileSync(join(dir, f), "stale");
    await deployToPluginDir(dir, { production: true, root });
    for (const f of PLUGIN_FILES) expect(read(dir, f)).not.toBe("stale");
  });
});

describe("release workflow", () => {
  const yml = readFileSync(".github/workflows/release.yml", "utf8");

  it("builds into a staging folder and attests and uploads exactly the deployed files from it", () => {
    const stage = /OBSIDIAN_PLUGIN_DIR: (.+)\n\s+run: pnpm release:check/.exec(yml)?.[1].trim();
    expect(stage).toBeTruthy();
    const attested = /subject-path: \|\n((?:\s+\S.*\n)+?)\n/.exec(yml)?.[1].trim().split(/\s*\n\s*/);
    expect(attested).toEqual(PLUGIN_FILES.map((f) => `${stage}/${f}`));
    const out = /OUT: (.+)/.exec(yml)?.[1].trim();
    expect(out).toBe(stage);
    const assets = /ASSETS="([^"]+)"/.exec(yml)?.[1].split(" ");
    expect(assets).toEqual(PLUGIN_FILES.map((f) => `$OUT/${f}`));
    // Nothing is shipped from the repo root any more.
    expect(yml).not.toMatch(/\[ -f styles\.css \]/);
  });
});
