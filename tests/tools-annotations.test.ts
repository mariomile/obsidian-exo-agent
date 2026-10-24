import { describe, it, expect } from "vitest";
import { createObsidianToolServer, OBSIDIAN_READ_TOOLS } from "../src/obsidian/tools";

/** Registered tool handlers on the SDK MCP server instance. */
function registeredTools(server: ReturnType<typeof createObsidianToolServer>) {
  return (server.instance as unknown as {
    _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<any> }>;
  })._registeredTools;
}

interface FakeAnnotation {
  id: string;
  notePath: string;
  quote: string;
  body: string;
  status: "active" | "resolved" | "orphaned";
}

/** Fake Obsidian App with an optional aiditor plugin exposing the read/action API,
 *  plus a settable active file so scope:'note' resolution can be exercised. */
function fakeApp(opts: { annotations?: FakeAnnotation[]; withAiditor?: boolean; activePath?: string } = {}) {
  const anns = opts.annotations ?? [];
  const resolvedCalls: string[] = [];
  const aiditor = {
    getAnnotations: (f: { notePath?: string; status?: string | string[] } = {}) => {
      const statuses = f.status === undefined
        ? ["active", "orphaned"]
        : Array.isArray(f.status)
          ? f.status
          : [f.status];
      const set = new Set(statuses);
      return anns.filter((a) => set.has(a.status) && (f.notePath === undefined || a.notePath === f.notePath));
    },
    resolveAnnotation: (id: string) => {
      resolvedCalls.push(id);
      return anns.some((a) => a.id === id);
    },
  };
  const app = {
    vault: { getMarkdownFiles: () => [] },
    workspace: {
      getActiveFile: () => (opts.activePath ? ({ path: opts.activePath } as any) : null),
      activeEditor: undefined,
    },
    metadataCache: {},
    plugins: { plugins: opts.withAiditor === false ? {} : { aiditor } },
  } as any;
  return { app, resolvedCalls };
}

function makeServer(app: any) {
  // Read-only construction (no memory writes) — the annotation
  // tools are unconditional so this default shape registers them.
  return createObsidianToolServer(app, { alwaysLoad: true, memoryWrite: false, memoryRead: true });
}

describe("annotation tools registration", () => {
  it("registers list_annotations (read) and resolve_annotation (write)", () => {
    const { app } = fakeApp();
    const names = Object.keys(registeredTools(makeServer(app)));
    expect(names).toContain("list_annotations");
    expect(names).toContain("resolve_annotation");
  });

  it("auto-allows list_annotations as read-only but NOT resolve_annotation", () => {
    expect(OBSIDIAN_READ_TOOLS.has("mcp__obsidian__list_annotations")).toBe(true);
    expect(OBSIDIAN_READ_TOOLS.has("mcp__obsidian__resolve_annotation")).toBe(false);
  });
});

describe("list_annotations behavior", () => {
  const anns: FakeAnnotation[] = [
    { id: "a", notePath: "Note A.md", quote: "quote a", body: "body a", status: "active" },
    { id: "o", notePath: "Note A.md", quote: "quote o", body: "body o", status: "orphaned" },
    { id: "r", notePath: "Note A.md", quote: "quote r", body: "body r", status: "resolved" },
    { id: "b", notePath: "Note B.md", quote: "quote b", body: "body b", status: "active" },
  ];

  it("defaults to the active note and the open set (active + orphaned)", async () => {
    const { app } = fakeApp({ annotations: anns, activePath: "Note A.md" });
    const res = await registeredTools(makeServer(app))["list_annotations"].handler({}, {});
    const text = res.content[0].text as string;
    expect(text).toContain("a · active");
    expect(text).toContain("o · orphaned");
    expect(text).not.toContain("r · resolved");
    expect(text).not.toContain("Note B.md"); // scoped to the active note
  });

  it("scope:'vault' returns open annotations across all notes", async () => {
    const { app } = fakeApp({ annotations: anns, activePath: "Note A.md" });
    const res = await registeredTools(makeServer(app))["list_annotations"].handler({ scope: "vault" }, {});
    const text = res.content[0].text as string;
    expect(text).toContain("Note A.md");
    expect(text).toContain("Note B.md");
  });

  it("status:'all' widens to include resolved; status:'resolved' narrows to it", async () => {
    const { app } = fakeApp({ annotations: anns, activePath: "Note A.md" });
    const tools = registeredTools(makeServer(app));
    const all = (await tools["list_annotations"].handler({ status: "all" }, {})).content[0].text as string;
    expect(all).toContain("r · resolved");
    const only = (await tools["list_annotations"].handler({ status: "resolved" }, {})).content[0].text as string;
    expect(only).toContain("r · resolved");
    expect(only).not.toContain("a · active");
  });

  it("degrades gracefully when no note is active and scope defaults to note", async () => {
    const { app } = fakeApp({ annotations: anns }); // no activePath
    const res = await registeredTools(makeServer(app))["list_annotations"].handler({}, {});
    expect(res.content[0].text).toMatch(/No active note/i);
  });

  it("degrades gracefully when aiditor is not enabled", async () => {
    const { app } = fakeApp({ annotations: anns, withAiditor: false, activePath: "Note A.md" });
    const res = await registeredTools(makeServer(app))["list_annotations"].handler({}, {});
    expect(res.content[0].text).toMatch(/AIditor plugin isn't enabled/i);
  });
});

describe("resolve_annotation behavior", () => {
  const anns: FakeAnnotation[] = [
    { id: "a", notePath: "Note A.md", quote: "q", body: "b", status: "active" },
  ];

  it("delegates to aiditor.resolveAnnotation and reports success", async () => {
    const { app, resolvedCalls } = fakeApp({ annotations: anns, activePath: "Note A.md" });
    const res = await registeredTools(makeServer(app))["resolve_annotation"].handler({ id: "a" }, {});
    expect(res.isError).toBeFalsy();
    expect(resolvedCalls).toEqual(["a"]);
  });

  it("returns an error for an unknown id", async () => {
    const { app } = fakeApp({ annotations: anns, activePath: "Note A.md" });
    const res = await registeredTools(makeServer(app))["resolve_annotation"].handler({ id: "missing" }, {});
    expect(res.isError).toBe(true);
  });

  it("errors cleanly when aiditor is not enabled", async () => {
    const { app } = fakeApp({ annotations: anns, withAiditor: false });
    const res = await registeredTools(makeServer(app))["resolve_annotation"].handler({ id: "a" }, {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/AIditor plugin isn't enabled/i);
  });
});
