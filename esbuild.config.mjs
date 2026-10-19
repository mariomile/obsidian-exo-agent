import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { deployToPluginDir } from "./scripts/deploy.mjs";

const prod = process.argv[2] === "production";

// Deploy target: `.obsidian-plugin-dir` (gitignored) holds the absolute path to
// `.obsidian/plugins/exo-agent`, and by decision (2026-08-06) that's the LIVE
// marioverse.ai vault — single-vault workflow, no separate dev vault. Copying
// main.js here does NOT reload the running plugin by itself; only an explicit
// reload (disable/enable, or a full Obsidian restart) does. That reload is
// what destroys the ChatView and kills any in-flight turn with "Session
// disposed (view-unload)" (2026-08-05 investigation) — so treat *reloading*,
// not building, as the one-shot, deliberate step. The env var still overrides
// the file when a one-off different target is needed:
//   OBSIDIAN_PLUGIN_DIR=/path/to/other/vault/.obsidian/plugins/exo-agent pnpm build
const deployDir =
  process.env.OBSIDIAN_PLUGIN_DIR ||
  (existsSync(".obsidian-plugin-dir") ? readFileSync(".obsidian-plugin-dir", "utf8").trim() : null);

// A production build packs the deployed styles.css (whitespace and comments out,
// `@settings` kept; see scripts/package-css.mjs). The release workflow builds
// into a staging folder through this same variable and ships what lands there.
const deployPlugin = {
  name: "deploy",
  setup(build) {
    build.onEnd(async (result) => {
      if (!deployDir) return;
      // Never ship a stale main.js into the live vault on a failed build.
      if (result.errors.length > 0) return;
      try {
        await deployToPluginDir(deployDir, { production: prod });
        console.log(`[deploy] copied to ${deployDir}`);
      } catch (e) {
        console.warn(`[deploy] failed: ${e?.message ?? e}`);
        // A production build is what the release ships from the deploy folder:
        // fail it, so a release never goes out with missing or stale files.
        if (prod) process.exitCode = 1;
      }
    });
  },
};

// The Agent SDK calls bare `setTimeout(...).unref()` / `.refresh()` in its
// child-process kill-escalation and keepalive paths. In Obsidian's renderer the
// bare global is the DOM timer (returns a number), so `.unref()` throws an
// uncaught TypeError and aborts the cleanup continuation (the SIGKILL
// escalation never arms). Shadow the timer globals with Node-Timeout-like
// wrappers — module-scoped, SDK files only; the rest of the bundle keeps the
// untouched DOM globals. `refresh()` is emulated for real (cancel+reschedule)
// because the SDK uses it; `Symbol.toPrimitive` keeps `clearTimeout(wrapper)`
// working via WebIDL number coercion.
const sdkSafeTimers = {
  name: "sdk-safe-timers",
  setup(build) {
    const prelude =
      "const __exoWrapTimer=(set,clear)=>(fn,ms,...args)=>{let id=set(fn,ms,...args);return{unref(){return this},ref(){return this},hasRef(){return true},refresh(){clear(id);id=set(fn,ms,...args);return this},[Symbol.toPrimitive](){return id}};};" +
      "const setTimeout=__exoWrapTimer(globalThis.setTimeout.bind(globalThis),globalThis.clearTimeout.bind(globalThis));" +
      "const setInterval=__exoWrapTimer(globalThis.setInterval.bind(globalThis),globalThis.clearInterval.bind(globalThis));\n";
    build.onLoad({ filter: /claude-agent-sdk[\\/][^\\/]+\.mjs$/ }, (args) => {
      // esbuild only strips a shebang when it's the first line — drop it
      // ourselves since the prelude takes that spot.
      let src = readFileSync(args.path, "utf8");
      if (src.startsWith("#!")) src = src.slice(src.indexOf("\n") + 1);
      return { contents: prelude + src, loader: "js" };
    });
  },
};

// `import text from "./file?raw"` inlines the file as a string. Used for the
// chat-recall script: it runs out of process, but Obsidian only installs
// main.js/manifest.json/styles.css, so it has to travel inside the bundle.
const rawText = {
  name: "raw-text",
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: join(args.resolveDir, args.path.slice(0, -"?raw".length)),
      namespace: "raw-text",
    }));
    build.onLoad({ filter: /.*/, namespace: "raw-text" }, (args) => ({
      contents: readFileSync(args.path, "utf8"),
      loader: "text",
    }));
  },
};

// Node lists prefix-only builtins (node:test, node:sqlite…) already prefixed.
const builtins = builtinModules.filter((m) => !m.startsWith("node:"));
const prefixOnly = builtinModules.filter((m) => m.startsWith("node:"));

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
    // The Claude Agent SDK imports builtins with the `node:` prefix.
    ...builtins.map((m) => `node:${m}`),
    ...prefixOnly,
  ],
  format: "cjs",
  target: "es2021",
  // The Claude Agent SDK calls createRequire(import.meta.url); in a CJS bundle
  // that token would be undefined and throw at load. Map it to a runtime file
  // URL derived from __filename (always present in CJS / Electron).
  define: { "import.meta.url": "__mvaImportMetaUrl" },
  banner: {
    // Obsidian's plugin loader hands plugins a require() that returns null for
    // Node builtins while mobile emulation is on (body class `emulate-mobile`,
    // persisted across restarts via localStorage.EmulateMobile). Without this
    // guard the banner dies with a cryptic `Cannot read properties of null
    // (reading 'pathToFileURL')` — fail loudly with the fix instead.
    js: [
      "const __mvaNodeUrl = require('url');",
      "if (__mvaNodeUrl === null) {",
      "  new (require('obsidian').Notice)('Exo needs desktop Node access, but mobile emulation is on. Turn it off (Obsidian: \"Emulate mobile device\" toggle, or CLI: obsidian dev:mobile off), then re-enable Exo.', 0);",
      "  throw new Error('[exo] Node builtins unavailable: mobile emulation is enabled (localStorage.EmulateMobile). Disable it, then reload Exo.');",
      "}",
      "const __mvaImportMetaUrl = __mvaNodeUrl.pathToFileURL(__filename).href;",
    ].join('\n'),
  },
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
  plugins: [rawText, sdkSafeTimers, deployPlugin],
});

if (prod) {
  await ctx.rebuild();
  process.exit(); // 0, or 1 if the deploy failed (process.exitCode)
} else {
  await ctx.watch();
}
