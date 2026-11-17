/**
 * Loopback executor for the Codex ↔ Obsidian tools bridge (spec 2026-07-14).
 * A tiny HTTP server on 127.0.0.1 (random port, bearer token) that runs the
 * SAME SdkMcpToolDefinition handlers the Claude SDK server uses. The stdio
 * MCP script codex spawns (mcp-bridge-script.ts) forwards tools/list and
 * tools/call here. Tool errors are MCP results (isError), never HTTP 5xx.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { randomBytes, timingSafeEqual } from "crypto";
import * as z from "zod";
import type { AnyTool } from "./sdk-tool";


interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

const errResult = (msg: string): ToolResult => ({ content: [{ type: "text", text: msg }], isError: true });

export function toolsManifest(tools: AnyTool[]): Array<{ name: string; description: string; inputSchema: unknown }> {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(z.object(t.inputSchema)),
  }));
}

export async function callBridgeTool(tools: AnyTool[], name: string, input: unknown): Promise<ToolResult> {
  const def = tools.find((t) => t.name === name);
  if (!def) return errResult(`Unknown tool: ${name}`);
  const parsed = z.object(def.inputSchema).safeParse(input ?? {});
  if (!parsed.success) return errResult(`Invalid input for ${name}: ${parsed.error.message}`);
  try {
    // `parsed.data` was just validated against this tool's own inputSchema.
    return await def.handler(parsed.data as never, {});
  } catch (e) {
    return errResult(`Tool ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function authOk(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const got = Buffer.from(header.slice(7));
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * MCP over HTTP (Streamable HTTP, JSON responses only, no sessions): the same
 * four methods the stdio relay script speaks, for a CLI that connects to a
 * remote MCP server itself (opencode) and so needs no `node` on PATH.
 * Returns the JSON-RPC reply, or null for a notification (HTTP 202).
 */
export async function mcpHttp(tools: AnyTool[], body: string): Promise<unknown> {
  let msg: { id?: string | number | null; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(body) as typeof msg;
  } catch {
    return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
  }
  const { id, method, params } = msg;
  if (id === undefined || id === null) return null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  if (method === "initialize") {
    return ok({
      protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "exo-obsidian-bridge", version: "1.0.0" },
    });
  }
  if (method === "tools/list") return ok({ tools: toolsManifest(tools) });
  if (method === "tools/call") return ok(await callBridgeTool(tools, String(params?.name ?? ""), params?.arguments ?? {}));
  if (method === "ping") return ok({});
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

export interface McpBridge {
  port: number;
  token: string;
  setTools(tools: AnyTool[]): void;
  stop(): void;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export function startMcpBridge(): Promise<McpBridge> {
  const token = randomBytes(32).toString("hex");
  let tools: AnyTool[] = [];
  let stopped = false;
  const server: Server = createServer((req, res) => void route(req, res));
  // ask_user can legitimately wait minutes for the human — never time out.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (!authOk(req.headers.authorization, token)) return send(401, { error: "unauthorized" });
      if (req.method === "GET" && req.url === "/tools") return send(200, toolsManifest(tools));
      if (req.method === "POST" && req.url === "/mcp") {
        const reply = await mcpHttp(tools, await readBody(req));
        if (reply === null) {
          res.writeHead(202);
          res.end();
          return;
        }
        return send(200, reply);
      }
      if (req.method === "POST" && req.url === "/call") {
        let parsed: { tool?: unknown; input?: unknown };
        try {
          parsed = JSON.parse(await readBody(req)) as { tool?: unknown; input?: unknown };
        } catch {
          return send(200, errResult("Malformed /call body."));
        }
        return send(200, await callBridgeTool(tools, String(parsed.tool ?? ""), parsed.input));
      }
      return send(404, { error: "not found" });
    } catch (e) {
      // Absolute backstop — a bridge failure must never 500 into a hung fetch.
      send(200, errResult(`Bridge error: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        token,
        setTools: (t) => (tools = t),
        stop: () => {
          if (stopped) return;
          stopped = true;
          server.closeAllConnections?.();
          server.close();
        },
      });
    });
  });
}
