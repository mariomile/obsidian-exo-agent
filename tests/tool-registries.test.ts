import { describe, it, expect } from "vitest";
import type { App } from "obsidian";
import {
  createObsidianToolServer,
  OBSIDIAN_READ_TOOLS,
  OBSIDIAN_MEMORY_TOOLS,
} from "../src/obsidian/tools";
import { memoryCaps } from "../src/core/memory-caps";

const PREFIX = "mcp__obsidian__";

/** Bare tool names actually registered on the server. The SDK adds the
 *  `mcp__obsidian__` prefix at runtime, so the classifier Sets (which use the
 *  full names) must match these stripped of the prefix. Every optional feature
 *  flag is enabled so the full possible tool surface registers. */
const fakeStatus = {
  url: "u",
  title: "t",
  loading: false,
  scrollY: 0,
  scrollHeight: 0,
  viewportHeight: 0,
  ownerConvoId: null,
};
/** The agent browser registers only behind a live bridge, so the fullest
 *  surface needs one: without it the three browser read tools would be listed
 *  in OBSIDIAN_READ_TOOLS but absent from the server, which is exactly the
 *  drift the first assertion below exists to catch. */
const fakeBrowserBridge = {
  open: async () => fakeStatus,
  navigate: async () => fakeStatus,
  snapshot: async () => ({ status: fakeStatus, elements: [] }),
  readPage: async () => ({ status: fakeStatus, text: "", total: 0 }),
  screenshot: async () => ({ status: fakeStatus, pngB64: "" }),
  click: async () => fakeStatus,
  type: async () => fakeStatus,
  scroll: async () => fakeStatus,
};

/** Collabo tools register only behind a configured service (resolved from the
 *  app via getExo, not a curried bridge), so the fullest surface needs a fake
 *  exo plugin instance with collaboUrl set — the same reason browser needs a
 *  fake bridge above. */
const fakeExoPlugin = {
  settings: {
    collaboUrl: "https://exo-collabo.example",
    collaboApiKey: "",
    collaboShares: {},
  },
  loadAutomationRuns: async () => [],
  runPlaybook: async () => true,
};

function registeredBareNames(): Set<string> {
  const app = {
    vault: {},
    workspace: {},
    metadataCache: {},
    plugins: { plugins: { "exo-agent": fakeExoPlugin } },
  } as unknown as App;
  const server = createObsidianToolServer(app, {
    alwaysLoad: true,
    memory: memoryCaps(
      { memoryReadEnabled: true, memoryWriteEnabled: true, agentFolderEnabled: true, autoMemory: true, backgroundPassesEnabled: true },
      { surface: "chat" },
    ),
    askBridge: async () => ({}),
    rethinkBridge: async () => "",
    convoId: "convo-test",
    browserBridge: fakeBrowserBridge,
  });
  const reg = (server.instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  return new Set(Object.keys(reg));
}

describe("obsidian tool classifier registries stay in sync with registered tools", () => {
  const registered = registeredBareNames();

  const cases: Array<[string, Set<string>]> = [
    ["OBSIDIAN_READ_TOOLS", OBSIDIAN_READ_TOOLS],
    ["OBSIDIAN_MEMORY_TOOLS", OBSIDIAN_MEMORY_TOOLS],
  ];

  for (const [label, set] of cases) {
    it(`every ${label} entry maps to a registered tool (no drift)`, () => {
      const missing = [...set]
        .map((n) => n.replace(PREFIX, ""))
        .filter((bare) => !registered.has(bare));
      expect(missing, `${label} lists tools not registered on the server: ${missing.join(", ")}`).toEqual([]);
    });
  }

  it("all classifier entries carry the mcp__obsidian__ prefix", () => {
    const all = [...OBSIDIAN_READ_TOOLS, ...OBSIDIAN_MEMORY_TOOLS];
    expect(all.filter((n) => !n.startsWith(PREFIX))).toEqual([]);
  });

  /**
   * The OTHER direction, which this file could not see. A read-only tool once
   * shipped absent from `OBSIDIAN_READ_TOOLS`, so every call raised a write
   * permission card — and the listed -> registered check above passes just as
   * happily with the tool missing.
   *
   * A full inverse (every registered tool is classified) is not the rule: most
   * tools are writes and belong to no Set. So the rule is stated where it is
   * knowable — a tool whose name says it only reads must be classified as one.
   */
  /**
   * The browser observers do not match the list_/get_ name heuristic below, so
   * they get their own rule: looking at the shared tab writes nothing and
   * changes nothing, and must not raise a permission card. The mutating five
   * (open/navigate/click/type/scroll) must stay OUT: their card, showing the
   * URL or selector, is the evidence trail for a shared, visible surface.
   */
  it("the browser observers are read-only and the mutators are not", () => {
    for (const bare of ["browser_snapshot", "browser_read_page", "browser_screenshot"]) {
      expect(registered.has(bare), `${bare} is not registered`).toBe(true);
      expect(OBSIDIAN_READ_TOOLS.has(`${PREFIX}${bare}`), bare).toBe(true);
    }
    for (const bare of ["browser_open", "browser_navigate", "browser_click", "browser_type", "browser_scroll"]) {
      expect(registered.has(bare), `${bare} is not registered`).toBe(true);
      expect(OBSIDIAN_READ_TOOLS.has(`${PREFIX}${bare}`), bare).toBe(false);
    }
  });

  it("propose_correction is never auto-allowed, so the read-only sandbox keeps it out", () => {
    expect(OBSIDIAN_READ_TOOLS.has(`${PREFIX}propose_correction`)).toBe(false);
  });

  it("every list_*/get_* tool on the server is classified read-only", () => {
    const readShaped = [...registered].filter((n) => /^(list|get)_/.test(n));
    expect(readShaped.length, "the name heuristic matched nothing — it has stopped testing anything").toBeGreaterThan(5);
    const unclassified = readShaped.filter((bare) => !OBSIDIAN_READ_TOOLS.has(`${PREFIX}${bare}`));
    expect(
      unclassified,
      `these read-shaped tools raise a write permission card: ${unclassified.join(", ")}. ` +
        "Add them to OBSIDIAN_READ_TOOLS, or rename them if they are not actually read-only.",
    ).toEqual([]);
  });
});
