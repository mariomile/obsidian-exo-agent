import { describe, it, expect } from "vitest";
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { toolsManifest, callBridgeTool, authOk, startMcpBridge } from "../src/obsidian/mcp-bridge";
import { buildObsidianTools } from "../src/obsidian/tools";
import type { App } from "obsidian";

const echo = tool("echo", "Echo the input back.", { text: z.string() }, async (a) => ({
  content: [{ type: "text", text: `echo:${a.text}` }],
}));
const boom = tool("boom", "Always throws.", {}, async () => {
  throw new Error("kaboom");
});

describe("toolsManifest", () => {
  it("exposes name, description, and a JSON schema with the right properties", () => {
    const m = toolsManifest([echo]);
    expect(m[0].name).toBe("echo");
    expect(m[0].description).toContain("Echo");
    expect(m[0].inputSchema).toMatchObject({ type: "object" });
    expect((m[0].inputSchema as { properties?: Record<string, unknown> }).properties).toHaveProperty("text");
  });
});

describe("callBridgeTool", () => {
  it("validates input and runs the handler", async () => {
    const r = await callBridgeTool([echo], "echo", { text: "hi" });
    expect(r).toEqual({ content: [{ type: "text", text: "echo:hi" }] });
  });

  it("rejects invalid input as an MCP error result, not a throw", async () => {
    const r = await callBridgeTool([echo], "echo", { text: 5 });
    expect(r.isError).toBe(true);
  });

  it("unknown tool and handler throw both become isError results", async () => {
    expect((await callBridgeTool([echo], "nope", {})).isError).toBe(true);
    const r = await callBridgeTool([boom], "boom", {});
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("kaboom");
  });
});

describe("ask_user through the bridge executor", () => {
  it("a dismissal reaches codex as a normal MCP result, never isError", async () => {
    const tools = buildObsidianTools({} as App, {
      askBridge: async () => {
        throw new Error("cancelled");
      },
    });
    const res = await callBridgeTool(tools, "ask_user", {
      questions: [{ question: "Which?", header: "Approach", options: [{ label: "A" }, { label: "B" }] }],
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toMatch(/dismissed/i);
  });
});

describe("authOk", () => {
  it("accepts only the exact bearer token", () => {
    expect(authOk("Bearer abc", "abc")).toBe(true);
    expect(authOk("Bearer abd", "abc")).toBe(false);
    expect(authOk(undefined, "abc")).toBe(false);
    expect(authOk("abc", "abc")).toBe(false);
  });
});

describe("startMcpBridge (live http)", () => {
  it("serves /tools and /call with auth, 401 without", async () => {
    const b = await startMcpBridge();
    try {
      b.setTools([echo]);
      const base = `http://127.0.0.1:${b.port}`;
      const h = { Authorization: `Bearer ${b.token}` };
      const list = await (await fetch(`${base}/tools`, { headers: h })).json();
      expect(list[0].name).toBe("echo");
      const call = await (
        await fetch(`${base}/call`, {
          method: "POST",
          headers: { ...h, "Content-Type": "application/json" },
          body: JSON.stringify({ tool: "echo", input: { text: "x" } }),
        })
      ).json();
      expect(call.content[0].text).toBe("echo:x");
      expect((await fetch(`${base}/tools`)).status).toBe(401);
    } finally {
      b.stop();
    }
  });

  it("speaks MCP over HTTP on /mcp, with the same auth", async () => {
    const b = await startMcpBridge();
    try {
      b.setTools([echo]);
      const url = `http://127.0.0.1:${b.port}/mcp`;
      const h = { Authorization: `Bearer ${b.token}`, "Content-Type": "application/json" };
      const rpc = (body: unknown) => fetch(url, { method: "POST", headers: h, body: JSON.stringify(body) });
      const init = await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })).json();
      expect(init.result.protocolVersion).toBe("2025-03-26");
      expect(init.result.capabilities).toHaveProperty("tools");
      expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
      const list = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
      expect(list.result.tools[0].name).toBe("echo");
      const call = await (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "y" } } })).json();
      expect(call).toMatchObject({ id: 3, result: { content: [{ type: "text", text: "echo:y" }] } });
      const unknown = await (await rpc({ jsonrpc: "2.0", id: 4, method: "resources/list" })).json();
      expect(unknown.error.code).toBe(-32601);
      expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(401);
    } finally {
      b.stop();
    }
  });
});
