/**
 * Newline-delimited JSON-RPC over a child process's stdio: the transport
 * under the long-lived CLI adapters. Owns request ids, pending requests and
 * their timeouts, response routing, a bounded stderr tail, and teardown.
 * Server-initiated requests and notifications go to the caller's handlers.
 */
import type { ChildProcess, spawn as spawnFn } from "child_process";

export type RpcId = number | string;

export interface RpcHandlers {
  /** A server → client request; answer it with `respond` / `respondError`. */
  onRequest(id: RpcId, method: string, params: Record<string, unknown>): void;
  onNotification(method: string, params: Record<string, unknown>): void;
  /** The process died or errored on its own (not after `close`). */
  onExit(error: Error): void;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: number | null;
}

export class StdioRpc {
  private child: ChildProcess | null = null;
  private buffer = "";
  private nextId = 0;
  private pending = new Map<RpcId, Pending>();
  private tail: string[] = [];
  private closed = false;

  constructor(
    private o: {
      /** Name used in error messages ("opencode acp"). */
      label: string;
      /** Default request timeout; a request may override it, or pass null for none. */
      requestTimeoutMs: number;
      /** Add `"jsonrpc": "2.0"` to outgoing messages (ACP requires it). */
      tagJsonrpc: boolean;
    }
  ) {}

  start(
    spawn: typeof spawnFn,
    command: string,
    args: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv },
    handlers: RpcHandlers
  ): void {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, windowsHide: true });
    this.child = child;
    const exit = (error: Error) => {
      if (this.closed) return;
      this.close(error);
      handlers.onExit(error);
    };
    child.stdout?.on("data", (chunk: Buffer | string) => this.consume(chunk.toString(), handlers));
    child.stderr?.on("data", (chunk: Buffer | string) => this.captureStderr(chunk.toString()));
    child.stdin?.on("error", () => { /* close/error owns reporting */ });
    child.on("error", (error) => exit(error));
    child.on("close", (code, signal) => {
      const detail = this.tail.join("\n").trim();
      exit(new Error(detail || `${this.o.label} exited (code ${code ?? "null"}, signal ${signal ?? "none"})`));
    });
  }

  get alive(): boolean {
    return !this.closed && !!this.child;
  }

  stderrTail(): string[] {
    return [...this.tail];
  }

  request(method: string, params: Record<string, unknown>, timeoutMs: number | null = this.o.requestTimeoutMs): Promise<unknown> {
    if (!this.alive) return Promise.reject(new Error(`${this.o.label} is not running.`));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === null
        ? null
        : window.setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`${method} timed out after ${timeoutMs}ms.`));
          }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.write({ method, params });
  }

  respond(id: RpcId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: RpcId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  /** Reject every pending request with `reason` and stop the process. Idempotent;
   *  never calls `onExit`. */
  close(reason: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      if (p.timer !== null) window.clearTimeout(p.timer);
      p.reject(reason);
    }
    this.pending.clear();
    try {
      this.child?.stdin?.end();
      this.child?.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    this.child = null;
  }

  private write(message: Record<string, unknown>): void {
    if (this.closed || !this.child?.stdin?.writable) return;
    const body = this.o.tagJsonrpc ? { jsonrpc: "2.0", ...message } : message;
    this.child.stdin.write(`${JSON.stringify(body)}\n`);
  }

  private consume(chunk: string, handlers: RpcHandlers): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let msg: { id?: RpcId; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        continue; // a stray diagnostic line must not poison the transport
      }
      if (msg.method) {
        if (msg.id !== undefined) handlers.onRequest(msg.id, msg.method, msg.params ?? {});
        else handlers.onNotification(msg.method, msg.params ?? {});
        continue;
      }
      if (msg.id === undefined) continue;
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (p.timer !== null) window.clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message || "request failed"}`));
      else p.resolve(msg.result);
    }
  }

  private captureStderr(chunk: string): void {
    for (const line of chunk.split("\n")) {
      const text = line.trim();
      if (!text) continue;
      this.tail.push(text.length > 500 ? `${text.slice(0, 500)}…` : text);
      if (this.tail.length > 16) this.tail.shift();
    }
  }
}
