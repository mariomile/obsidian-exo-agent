import { describe, expect, it } from "vitest";
import { recoverApprovalTool, routeCodexElicitation, type InFlightMcpCall } from "../src/core/codex-approval";
import { decidePermission } from "../src/core/permissions";

/** The read-classification Exo already uses (a slice of OBSIDIAN_READ_TOOLS:
 *  the real Set is built in src/obsidian/tools.ts, which imports obsidian). */
const READ_TOOLS = new Set(["mcp__obsidian__read_note", "mcp__obsidian__list_notes"]);

/** Codex 0.147.0's MCP tool-call approval, captured off the wire. */
function approval(over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) {
  return {
    threadId: "019ff150",
    turnId: "019ff150-bfaf",
    serverName: "obsidian",
    mode: "form",
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      persist: ["session", "always"],
      tool_description: "List notes in the vault (read-only).",
      tool_params: { folder: "A" },
      ...meta,
    },
    message: 'Allow the obsidian MCP server to run tool "list_notes"?',
    requestedSchema: { type: "object", properties: {} },
    ...over,
  };
}

const inFlight = (...calls: InFlightMcpCall[]): InFlightMcpCall[] => calls;

const route = (
  params: Record<string, unknown>,
  calls: InFlightMcpCall[],
  readOnlySandbox = false,
) => routeCodexElicitation({ params, inFlight: calls, readOnlySandbox, readTools: READ_TOOLS });

describe("codex MCP tool-call approvals", () => {
  it("does NOT treat an approval request as an elicitation form", () => {
    // The bug: empty requestedSchema.properties made this look like a form with
    // zero questions, and the zero-question branch replied decline.
    const decision = route(approval(), inFlight({ server: "obsidian", tool: "list_notes", args: { folder: "A" } }));
    expect(decision.kind).not.toBe("form");
  });

  it("keeps a GENUINE elicitation on the form path, untouched", () => {
    const form = {
      serverName: "notion",
      message: "Which audience?",
      requestedSchema: { type: "object", properties: { audience: { type: "string" } } },
    };
    expect(route(form, inFlight()).kind).toBe("form");
    // ...even while an unrelated tool call is in flight.
    expect(route(form, inFlight({ server: "notion", tool: "search", args: {} })).kind).toBe("form");
  });

  it("recovers the tool name from the preceding in-flight mcpToolCall item", () => {
    const decision = route(approval(), inFlight({ server: "obsidian", tool: "list_notes", args: { folder: "A" } }));
    expect(decision).toEqual({ kind: "permission", tool: "mcp__obsidian__list_notes", input: { folder: "A" } });
  });

  it("a read-classified tool ends up auto-allowed by Exo's OWN permission rules", () => {
    const decision = route(
      approval({ message: 'Allow the obsidian MCP server to run tool "read_note"?' }, { tool_params: { path: "B.md" } }),
      inFlight({ server: "obsidian", tool: "read_note", args: { path: "B.md" } }),
    );
    expect(decision.kind).toBe("permission");
    if (decision.kind !== "permission") return;
    expect(
      decidePermission({
        tool: decision.tool,
        argText: "",
        isRead: READ_TOOLS.has(decision.tool),
        isMemoryTool: false,
        alreadyAllowed: false,
        autoAllowRead: true,
        memoryWriteEnabled: true,
        permDenyRules: "",
        permAllowRules: "",
      }),
    ).toBe("auto-allow");
  });

  it("a MUTATING tool goes to the permission card, never straight through", () => {
    const decision = route(
      approval({ message: 'Allow the obsidian MCP server to run tool "create_note"?' }, { tool_params: { path: "C.md" } }),
      inFlight({ server: "obsidian", tool: "create_note", args: { path: "C.md" } }),
    );
    expect(decision).toEqual({ kind: "permission", tool: "mcp__obsidian__create_note", input: { path: "C.md" } });
    expect(
      decidePermission({
        tool: "mcp__obsidian__create_note",
        argText: "",
        isRead: READ_TOOLS.has("mcp__obsidian__create_note"),
        isMemoryTool: false,
        alreadyAllowed: false,
        autoAllowRead: true,
        memoryWriteEnabled: true,
        permDenyRules: "",
        permAllowRules: "",
      }),
    ).toBe("card");
  });

  it("DECLINES when the tool name cannot be recovered (no matching item in flight)", () => {
    expect(route(approval(), inFlight()).kind).toBe("decline");
    // Right server missing: another server's call in flight proves nothing.
    expect(route(approval(), inFlight({ server: "notion", tool: "search", args: { folder: "A" } })).kind).toBe("decline");
    // No server name at all.
    expect(route(approval({ serverName: undefined }), inFlight({ server: "obsidian", tool: "list_notes", args: { folder: "A" } })).kind)
      .toBe("decline");
  });

  it("a read-only sandbox NEVER lets a mutating bridge tool through", () => {
    const decision = route(
      approval({ message: 'Allow the obsidian MCP server to run tool "create_note"?' }, { tool_params: { path: "C.md" } }),
      inFlight({ server: "obsidian", tool: "create_note", args: { path: "C.md" } }),
      true,
    );
    expect(decision.kind).toBe("decline");
    // Read tools still work under the read-only sandbox.
    expect(route(approval(), inFlight({ server: "obsidian", tool: "list_notes", args: { folder: "A" } }), true).kind)
      .toBe("permission");
  });

  it("lets ask_user through a READ-ONLY sandbox: it is a question, not a write", () => {
    // The sandbox toolset (bridgeSessionToolset) deliberately KEEPS ask_user in a
    // read-only session. The router has to agree, or the tool is offered and
    // then refused on every call.
    const params = approval(
      { message: 'Allow the obsidian MCP server to run tool "ask_user"?' },
      { tool_params: { questions: [{ question: "A or B?" }] } },
    );
    const calls = inFlight({ server: "obsidian", tool: "ask_user", args: { questions: [{ question: "A or B?" }] } });
    expect(route(params, calls, true)).toEqual({
      kind: "permission",
      tool: "mcp__obsidian__ask_user",
      input: { questions: [{ question: "A or B?" }] },
    });
    // ...and identically when the sandbox is not read-only.
    expect(route(params, calls, false).kind).toBe("permission");
  });

  it("the read-only sandbox gate is scoped to the obsidian bridge, not to codex's own MCP servers", () => {
    const decision = routeCodexElicitation({
      params: approval({ serverName: "notion", message: 'Allow the notion MCP server to run tool "create_page"?' }),
      inFlight: inFlight({ server: "notion", tool: "create_page", args: { folder: "A" } }),
      readOnlySandbox: true,
      readTools: READ_TOOLS,
    });
    expect(decision).toEqual({ kind: "permission", tool: "mcp__notion__create_page", input: { folder: "A" } });
  });
});

describe("correlating an approval with its tool call", () => {
  it("picks the call whose arguments match, when several are in flight at once", () => {
    const calls = inFlight(
      { server: "obsidian", tool: "list_notes", args: { folder: "A" } },
      { server: "obsidian", tool: "create_note", args: { path: "C.md" } },
    );
    expect(recoverApprovalTool(approval(), calls)).toBe("list_notes");
    expect(recoverApprovalTool(approval({}, { tool_params: { path: "C.md" } }), calls)).toBe("create_note");
  });

  it("matches arguments regardless of key order", () => {
    const calls = inFlight({ server: "obsidian", tool: "create_note", args: { path: "C.md", content: "hi" } });
    expect(recoverApprovalTool(approval({}, { tool_params: { content: "hi", path: "C.md" } }), calls)).toBe("create_note");
  });

  it("falls back to the tool name codex quotes in its own prompt, when arguments cannot separate the candidates", () => {
    const calls = inFlight(
      { server: "obsidian", tool: "list_notes", args: { folder: "A" } },
      { server: "obsidian", tool: "search_notes", args: { folder: "A" } },
    );
    expect(recoverApprovalTool(approval(), calls)).toBe("list_notes");
  });

  it("DECLINES rather than guessing when the candidates stay ambiguous", () => {
    const calls = inFlight(
      { server: "obsidian", tool: "list_notes", args: { folder: "A" } },
      { server: "obsidian", tool: "search_notes", args: { folder: "A" } },
    );
    // Message wording drifted: no quoted name to break the tie.
    expect(recoverApprovalTool(approval({ message: "Allow this tool call?" }), calls)).toBeNull();
    // Quoted name names a tool that is not in flight: the signals disagree.
    expect(recoverApprovalTool(approval({ message: 'run tool "delete_note"?' }), calls)).toBeNull();
  });

  it("uses the single in-flight call when the approval carries NO arguments to contradict it", () => {
    // Arguments are a corroborator, not a requirement. A tool called with no
    // arguments sends `tool_params` absent or empty: neither can disagree with
    // anything, so one candidate is still one answer.
    const calls = inFlight({ server: "obsidian", tool: "list_notes", args: {} });
    expect(recoverApprovalTool(approval({}, { tool_params: undefined }), calls)).toBe("list_notes");
    expect(recoverApprovalTool(approval({}, { tool_params: {} }), calls)).toBe("list_notes");
    // ...and the in-flight side may be the empty one instead.
    const noArgs = inFlight({ server: "obsidian", tool: "list_notes", args: undefined });
    expect(recoverApprovalTool(approval({}, { tool_params: {} }), noArgs)).toBe("list_notes");
  });

  it("DECLINES when the approval's arguments match NO in-flight call", () => {
    // The security case: arguments that contradict the only candidate mean the
    // correlation is wrong. Returning it anyway would classify the approval as
    // the harmless call in flight while codex unblocks a different, gated one.
    const calls = inFlight({ server: "obsidian", tool: "read_note", args: { path: "A.md" } });
    expect(recoverApprovalTool(approval({}, { tool_params: { path: "DANGER.md" } }), calls)).toBeNull();
    // Same tool, wrong arguments: still a contradiction, still no answer.
    expect(recoverApprovalTool(approval({ message: 'run tool "read_note"?' }, { tool_params: { path: "B.md" } }), calls))
      .toBeNull();
    // End to end: the router refuses instead of auto-allowing the read tool it
    // can see while codex unblocks the mutating one it cannot.
    expect(route(approval({}, { tool_params: { path: "DANGER.md" } }), calls).kind).toBe("decline");
  });
});
