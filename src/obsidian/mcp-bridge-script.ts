/**
 * The stdio MCP server codex spawns (written to the plugin dir by main.ts).
 * Dependency-free .mjs: newline-delimited JSON-RPC 2.0 on stdio; forwards
 * tools/list and tools/call to the plugin's loopback executor via a
 * hand-rolled node:http request (NOT global fetch/undici — undici's default
 * headersTimeout is 300s, so an ask_user the human answers after >5 min dies
 * with UND_ERR_HEADERS_TIMEOUT and the answer is lost). Env: EXO_BRIDGE_PORT,
 * EXO_BRIDGE_TOKEN.
 */
export const MCP_BRIDGE_SCRIPT = `#!/usr/bin/env node
// Exo ↔ Codex obsidian-tools bridge (generated — do not edit; regenerated on plugin load).
import http from "node:http";

const PORT = process.env.EXO_BRIDGE_PORT;
const TOKEN = process.env.EXO_BRIDGE_TOKEN;
const HEADERS = { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" };

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const reply = (id, result) => out({ jsonrpc: "2.0", id, result });
const replyErr = (id, code, message) => out({ jsonrpc: "2.0", id, error: { code, message } });
const errResult = (text) => ({ content: [{ type: "text", text }], isError: true });

// Dependency-free node:http helper — replaces global fetch (undici) so a
// long-lived ask_user request is never killed by undici's hidden 300s
// headersTimeout. setTimeout(0) disables node:http's own socket timeout too;
// Connection: close avoids keep-alive close races on repeated calls.
function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: Number(PORT), path, method, headers: { ...HEADERS, Connection: "close" } },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(b));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.setTimeout(0); // ask_user can wait for the human indefinitely
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification — ignore
  try {
    if (method === "initialize") {
      reply(id, {
        protocolVersion: (params && params.protocolVersion) || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "exo-obsidian-bridge", version: "1.0.0" },
      });
    } else if (method === "tools/list") {
      reply(id, { tools: await request("GET", "/tools") });
    } else if (method === "tools/call") {
      const body = JSON.stringify({ tool: params && params.name, input: (params && params.arguments) || {} });
      reply(id, await request("POST", "/call", body));
    } else if (method === "ping") {
      reply(id, {});
    } else {
      replyErr(id, -32601, "Method not found: " + method);
    }
  } catch (e) {
    // Executor unreachable (plugin reloaded?) — degrade as a tool error.
    if (method === "tools/call") reply(id, errResult("Obsidian bridge unreachable: " + (e && e.message)));
    else replyErr(id, -32603, "Bridge error: " + (e && e.message));
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // not JSON — ignore
    }
    void handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0));
`;
