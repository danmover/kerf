// Kerf's design tools as a local MCP server, so the person's own Claude Code
// (signed in with their Claude plan through Claude Code's own login) can work
// on the open design. Kerf never sees or handles their Claude credentials:
// Claude Code calls these tools like any other MCP server, and the page runs
// them exactly as it does for Kerf's chat.
//
// Streamable HTTP, stateless: every POST carries one JSON-RPC message and gets
// a JSON reply. Only this computer can connect (127.0.0.1), and only with the
// bearer token shown in Settings → Claude.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

export const DEFAULT_PORT = 47615;
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY = 20 * 1024 * 1024;

/** What the page answers for the server. */
export interface McpBackend {
  /** tools/list or tools/call, run in the page; `signal` aborts when Claude Code cancels the call or disconnects */
  request(method: "tools/list" | "tools/call", params: unknown, signal: AbortSignal): Promise<unknown>;
  instructions: string;
  version: string;
}

export interface RunningMcp {
  port: number;
  url: string;
  close(): Promise<void>;
}

export const newToken = () => randomBytes(32).toString("base64url");

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const rpcError = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

function sameToken(header: string | undefined, token: string) {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: ServerResponse, status: number, body?: unknown) {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) }).end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** The reply to one JSON-RPC message, or null for a notification. */
export async function handleRpc(msg: Rpc, backend: McpBackend, signal: AbortSignal, cancels: Map<string, AbortController>): Promise<unknown | null> {
  if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(msg?.id, -32600, "Invalid request");
  const isNote = msg.id === undefined || msg.id === null;
  if (msg.method === "notifications/cancelled") {
    cancels.get(String(msg.params?.requestId))?.abort();
    return null;
  }
  if (isNote) return null;
  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "kerf", title: "Kerf", version: backend.version },
          instructions: backend.instructions,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id: msg.id, result: {} };
    case "tools/list":
    case "tools/call": {
      const ac = new AbortController();
      const key = String(msg.id);
      cancels.set(key, ac);
      const stop = () => ac.abort();
      signal.addEventListener("abort", stop, { once: true });
      try {
        return { jsonrpc: "2.0", id: msg.id, result: await backend.request(msg.method, msg.params ?? {}, ac.signal) };
      } catch (e) {
        return rpcError(msg.id, -32603, (e as Error).message || "Kerf could not run that");
      } finally {
        cancels.delete(key);
        signal.removeEventListener("abort", stop);
      }
    }
    default:
      return rpcError(msg.id, -32601, `Kerf has no method ${msg.method}`);
  }
}

/** Start listening on 127.0.0.1, from `port` upward when it is taken. */
export function startMcp(opts: { port: number; token: string; backend: McpBackend }): Promise<RunningMcp> {
  const cancels = new Map<string, AbortController>();
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // a web page can't reach this: it needs the token, and pages always send an Origin
    if (url.pathname !== "/mcp") return send(res, 404);
    if (req.headers.origin) return send(res, 403);
    if (!sameToken(req.headers.authorization, opts.token)) return send(res, 401, rpcError(null, -32001, "Kerf needs the token from Settings → Claude"));
    if (req.method === "GET" || req.method === "DELETE") return send(res, 405);
    if (req.method !== "POST") return send(res, 405);
    let msg: Rpc;
    try {
      msg = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, rpcError(null, -32700, "Parse error"));
    }
    if (Array.isArray(msg)) return send(res, 400, rpcError(null, -32600, "Kerf takes one message per request"));
    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) ac.abort();
    });
    const reply = await handleRpc(msg, opts.backend, ac.signal, cancels);
    if (reply === null) return send(res, 202);
    send(res, 200, reply);
  });
  // tool calls such as a stress analysis can take minutes
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  return new Promise((resolve, reject) => {
    let port = opts.port;
    const tryListen = () => {
      server.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE" && port < opts.port + 10) {
          port++;
          tryListen();
        } else reject(e);
      });
      server.listen(port, "127.0.0.1", () => {
        server.removeAllListeners("error");
        port = (server.address() as { port: number }).port;
        resolve({
          port,
          url: `http://127.0.0.1:${port}/mcp`,
          close: () =>
            new Promise<void>((r) => {
              for (const c of cancels.values()) c.abort();
              server.closeAllConnections();
              server.close(() => r());
            }),
        });
      });
    };
    tryListen();
  });
}
