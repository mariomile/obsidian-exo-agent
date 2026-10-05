#!/usr/bin/env node
/**
 * Version bump — single source of truth for a release's version number.
 *
 * Usage:  node scripts/bump.mjs <X.Y.Z>   (or: pnpm bump <X.Y.Z>)
 *
 * Updates, in lockstep, every file that carries the plugin version:
 *   - manifest.json           .version
 *   - package.json            .version
 *   - package-lock.json       .version and .packages[""].version (both fields
 *                             a lockfileVersion-3 lockfile carries)
 *   - versions.json           adds "<X.Y.Z>": "<minAppVersion>", reusing the
 *                             minAppVersion of the previous latest entry
 *
 * All four files are tab-indented; this script preserves that. It does NOT touch
 * dependency versions in the lockfile — only the two top-level project fields.
 * After running, rebuild (`pnpm build`) to refresh main.js.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const version = process.argv[2];
if (!version) {
  console.error("usage: node scripts/bump.mjs <X.Y.Z>");
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`error: "${version}" is not a valid X.Y.Z version`);
  process.exit(1);
}

/** Read a tab-indented JSON file. */
function readJson(name) {
  return JSON.parse(readFileSync(join(root, name), "utf8"));
}
/** Write a tab-indented JSON file with a trailing newline (matches repo style). */
function writeJson(name, obj) {
  writeFileSync(join(root, name), JSON.stringify(obj, null, "\t") + "\n");
}

// manifest.json + package.json — single `.version` field each.
const manifest = readJson("manifest.json");
const fromVersion = manifest.version;
manifest.version = version;
writeJson("manifest.json", manifest);

const pkg = readJson("package.json");
pkg.version = version;
writeJson("package.json", pkg);

// package-lock.json (lockfileVersion 3) carries the project version twice: the
// top-level field and packages[""].version. Leave every dependency version alone.
// The repo is pnpm-managed (pnpm-lock.yaml carries no project version), so the
// npm lockfile only exists on machines that ran `npm install` — skip when absent
// rather than dying mid-bump with manifest/package updated but versions.json not
// (this exact partial-bump happened on the 0.24.0 release).
const hasNpmLock = existsSync(join(root, "package-lock.json"));
if (hasNpmLock) {
  const lock = readJson("package-lock.json");
  lock.version = version;
  if (lock.packages && lock.packages[""]) lock.packages[""].version = version;
  writeJson("package-lock.json", lock);
}

// versions.json maps plugin version → minAppVersion. Reuse the previous latest
// entry's minAppVersion for the new key (Object insertion order = chronological).
const versions = readJson("versions.json");
const keys = Object.keys(versions);
const prevMinApp = keys.length ? versions[keys[keys.length - 1]] : manifest.minAppVersion;
versions[version] = prevMinApp;
writeJson("versions.json", versions);

console.log(`Bumped ${fromVersion} → ${version}`);
console.log(`  manifest.json      version = ${version}`);
console.log(`  package.json       version = ${version}`);
if (hasNpmLock) console.log(`  package-lock.json  version = ${version} (project fields only)`);
console.log(`  versions.json      "${version}": "${prevMinApp}"`);
console.log(`\nNext: pnpm build`);
// Il gate per-repo verifica questo plugin da solo. I difetti che sfuggono sono
// composizionali — vivono fra due plugin — e si vedono solo a suite montata.
// Non può stare in CI: serve un Obsidian in esecuzione.
console.log(`Poi, a Obsidian aperto: ~/Dev\\ Projects/marioverse-kit/suite-smoke.sh`);
