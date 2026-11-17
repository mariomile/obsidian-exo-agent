import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createServer, type Server } from "http";
import { writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { MCP_BRIDGE_SCRIPT } from "../src/obsidian/mcp-bridge-script";
import { startMcpBridge } from "../src/obsidian/mcp-bridge";

const TOKEN = "test-token";
let server: Server;
let port = 0;
let script = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const ok = req.headers.authorization === `Bearer ${TOKEN}`;
    res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
    if (!ok) return void res.end("{}");
    if (req.url === "/tools") {
      res.end(JSON.stringify([{ name: "echo", description: "d", inputSchema: { type: "object" } }]));
    } else {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => res.end(JSON.stringify({ content: [{ type: "text", text: `got:${JSON.parse(b).input.q}` }] })));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as { port: number }).port;
  script = join(tmpdir(), `exo-bridge-test-${process.pid}.mjs`);
  await writeFile(script, MCP_BRIDGE_SCRIPT);
});

afterAll(async () => {
  server.close();
  await rm(script, { force: true });
});

function rpc(child: ChildProcess, msg: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("rpc timeout")), 5000);
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (!line.trim()) continue;
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        resolve(JSON.parse(line));
        return;
      }
    };
    child.stdout?.on("data", onData);
    child.stdin?.write(JSON.stringify(msg) + "\n");
  });
}

describe("mcp-bridge script (real node child)", () => {
  it("answers initialize, tools/list, tools/call end-to-end", async () => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, EXO_BRIDGE_PORT: String(port), EXO_BRIDGE_TOKEN: TOKEN, ELECTRON_RUN_AS_NODE: "1" },
    });
    try {
      const init = await rpc(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
      expect(init.result).toMatchObject({ protocolVersion: "2025-06-18" });
      const list = await rpc(child, { jsonrpc: "2.0", id: 2, method: "tools/list" });
      expect((list.result as { tools: Array<{ name: string }> }).tools[0].name).toBe("echo");
      const call = await rpc(child, {
        jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { q: "hi" } },
      });
      expect(JSON.stringify(call.result)).toContain("got:hi");
      const unknown = await rpc(child, { jsonrpc: "2.0", id: 4, method: "nope" });
      expect((unknown.error as { code: number }).code).toBe(-32601);
    } finally {
      child.kill();
    }
  });
});

describe("no-timeout posture", () => {
  it("the script keeps the hand-rolled node:http transport (undici's hidden 300s headersTimeout is the documented regression)", () => {
    expect(MCP_BRIDGE_SCRIPT).toContain("node:http");
    expect(MCP_BRIDGE_SCRIPT).toContain("req.setTimeout(0)");
    expect(MCP_BRIDGE_SCRIPT).not.toContain("fetch(");
  });

  it("a call whose handler resolves only after a human-scale delay still answers, through the REAL bridge and the REAL script", async () => {
    const bridge = await startMcpBridge();
    bridge.setTools([
      {
        name: "ask_user",
        description: "d",
        inputSchema: {},
        handler: async () => {
          await new Promise((r) => setTimeout(r, 1500));
          return { content: [{ type: "text", text: '{"Approach":"A"}' }] };
        },
      } as never,
    ]);
    const child = spawn(process.execPath, [script], {
      env: {
        ...process.env,
        EXO_BRIDGE_PORT: String(bridge.port),
        EXO_BRIDGE_TOKEN: bridge.token,
        ELECTRON_RUN_AS_NODE: "1",
      },
    });
    try {
      const call = await rpc(child, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ask_user", arguments: {} },
      });
      expect(JSON.stringify(call.result)).toContain("Approach");
      expect(JSON.stringify(call.result)).not.toContain("isError");
    } finally {
      child.kill();
      bridge.stop();
    }
  }, 15_000);
});
