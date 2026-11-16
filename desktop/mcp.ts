// Kerf's design tools as a local MCP server, so the person's own Claude Code
// (signed in with their Claude plan through Claude Code's own login) can work
// on the open design. Kerf never sees or handles their Claude credentials:
// Claude Code calls these tools like any other MCP server, and the page runs
// them exactly as it does for Kerf's chat.
//
// Streamable HTTP, stateless: every POST carries one JSON-RPC message and gets
// a JSON reply. Only this computer can connect, and only with the bearer token
// kept in Kerf's settings. Kerf listens in two places:
// - a local pipe (a named pipe on Windows, a socket file elsewhere), which is
//   what Kerf's own stdio bridge (desktop/bridge.ts) uses. "Connect Claude
//   Code" registers that bridge, so Claude Code never makes an HTTP connection
//   at all: no port, no proxy, no token to paste, nothing for an antivirus
//   web filter to rewrite.
// - 127.0.0.1:<port>, for anything set up by hand with a URL and the token.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";

export const DEFAULT_PORT = 47615;
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY = 20 * 1024 * 1024;

/** What Claude Code is told when it connects, by the server or by the bridge while Kerf is closed. */
export const MCP_INSTRUCTIONS =
  "Kerf is the mechanical CAD app open on this computer. These tools read and change the design open in its window, and the person watches every change there live. Before you work on a design, call kerf_instructions once and follow it: it is Kerf's design guide and the reference for its design language. Start each task with get_design.";

/** Every reply carries this header with the running Kerf's id, so a self-check can tell Kerf's answer from another program's. */
export const KERF_HEADER = "x-kerf";
/** Kerf's bridge names the client it serves ("claude-code 2.1.325") on every message, for the status in Settings: it may have answered initialize itself while Kerf was closed. */
export const CLIENT_HEADER = "x-kerf-client";

/**
 * Where Kerf's local pipe is for a given data folder: a named pipe on Windows,
 * a socket file elsewhere. Both ends work it out from the same folder, so the
 * bridge finds the running Kerf without a port.
 */
export function pipePath(dataDir: string, platform: NodeJS.Platform = process.platform) {
  // the same folder written differently (relative, or in another case on Windows) is the same pipe
  const dir = platform === "win32" ? win32.resolve(dataDir).toLowerCase() : resolve(dataDir);
  const id = createHash("sha256").update(dir).digest("hex").slice(0, 16);
  if (platform === "win32") return `\\\\.\\pipe\\kerf-mcp-${id}`;
  // a socket path has to stay under about 104 bytes on macOS
  const inData = join(dir, "mcp.sock");
  return Buffer.byteLength(inData) < 100 ? inData : join(tmpdir(), `kerf-mcp-${id}.sock`);
}

/** What the page answers for the server. */
export interface McpBackend {
  /** tools/list or tools/call, run in the page; `signal` aborts when Claude Code cancels the call or disconnects */
  request(method: "tools/list" | "tools/call", params: unknown, signal: AbortSignal): Promise<unknown>;
  instructions: string;
  version: string;
}

/** What Kerf saw of a connection attempt, for the status line in Settings → AI → Claude Code. */
export type McpSeen =
  | { kind: "connected"; client: string }
  /** no-token: nothing after "Bearer" (or no Authorization header); wrong-token: an old or mistyped token */
  | { kind: "refused"; why: "no-token" | "wrong-token" };

export interface RunningMcp {
  port: number;
  url: string;
  /** the local pipe Kerf's bridge connects to, or null when it couldn't be opened (see pipeError) */
  pipe: string | null;
  pipeError: string;
  /** the id in every reply's x-kerf header */
  instance: string;
  close(): Promise<void>;
}

export const newToken = () => randomBytes(32).toString("base64url");

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const rpcError = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** The token in an Authorization header, or "" when there is none. */
const tokenIn = (header: string | undefined) => /^Bearer\s+(\S+)\s*$/i.exec(header ?? "")?.[1] ?? "";

function sameToken(sent: string, token: string) {
  const a = Buffer.from(sent);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

const REFUSED = {
  "no-token":
    "Kerf got no token. The easy fix: press Connect Claude Code in Kerf's Settings → AI → Claude Code, which sets Claude Code up without a token to copy. Or copy the HTTP connect command from Set up by hand there and run it as it is: it gives the whole header, Authorization: Bearer and the token.",
  "wrong-token":
    "Kerf turned down this token: it is old or mistyped. Press Connect Claude Code in Kerf's Settings → AI → Claude Code, which keeps up with new tokens by itself, or copy the HTTP connect command again from Set up by hand there.",
};

/** The name and version a client gave in its initialize, e.g. "claude-code 2.1.323". */
export function clientOf(msg: Pick<Rpc, "params">) {
  const c = msg.params?.clientInfo as { name?: unknown; title?: unknown; version?: unknown } | undefined;
  const name = typeof c?.name === "string" ? c.name : typeof c?.title === "string" ? c.title : "A program";
  return `${name}${typeof c?.version === "string" ? ` ${c.version}` : ""}`.slice(0, 80);
}

/** The answer to initialize: the version the client asked for when Kerf speaks it, else Kerf's newest. */
export function initializeResult(msg: { id?: Rpc["id"]; params?: Record<string, unknown> }, instructions: string, version: string) {
  const asked = String(msg.params?.protocolVersion ?? "");
  return {
    jsonrpc: "2.0",
    id: msg.id,
    result: {
      protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "kerf", title: "Kerf", version },
      instructions,
    },
  };
}

function send(res: ServerResponse, status: number, body?: unknown) {
  if (body === undefined) {
    // an explicit empty length, so even an empty reply is never sent chunked
    res.writeHead(status, status === 405 ? { allow: "POST", "content-length": 0 } : { "content-length": 0 }).end();
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
    case "initialize":
      return initializeResult(msg, backend.instructions, backend.version);
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

/** Ports Kerf tries before letting the system pick one. */
const PORT_TRIES = 10;

/**
 * Start listening on 127.0.0.1, from `port` upward when it is taken or reserved
 * (Windows keeps whole port ranges for Hyper-V and WSL), and on `pipe` when one
 * is given. A pipe that won't open is reported, not fatal: the URL still works.
 */
export async function startMcp(opts: { port: number; token: string; backend: McpBackend; onSeen?: (s: McpSeen) => void; pipe?: string }): Promise<RunningMcp> {
  const cancels = new Map<string, AbortController>();
  const instance = randomBytes(8).toString("hex");
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader(KERF_HEADER, instance);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // a web page can't reach this: it needs the token, and pages always send an Origin
    if (url.pathname !== "/mcp") return send(res, 404);
    if (req.headers.origin) return send(res, 403);
    const sent = tokenIn(req.headers.authorization);
    if (!sent || !sameToken(sent, opts.token)) {
      const why = sent ? "wrong-token" : "no-token";
      // GET is a client probing for a stream; count only real requests
      if (req.method === "POST") opts.onSeen?.({ kind: "refused", why });
      return send(res, 401, rpcError(null, -32001, REFUSED[why]));
    }
    if (req.method !== "POST") return send(res, 405);
    let msg: Rpc;
    try {
      msg = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, rpcError(null, -32700, "Parse error"));
    }
    if (Array.isArray(msg)) return send(res, 400, rpcError(null, -32600, "Kerf takes one message per request"));
    const via = req.headers[CLIENT_HEADER];
    if (msg?.method === "initialize") opts.onSeen?.({ kind: "connected", client: clientOf(msg) });
    else if (typeof via === "string" && via && msg?.method !== "ping") opts.onSeen?.({ kind: "connected", client: via.slice(0, 80) });
    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) ac.abort();
    });
    const reply = await handleRpc(msg, opts.backend, ac.signal, cancels);
    if (reply === null) return send(res, 202);
    send(res, 200, reply);
  };
  const make = () => {
    const server: Server = createServer((req, res) => void handle(req, res));
    // tool calls such as a stress analysis can take minutes
    server.requestTimeout = 0;
    server.headersTimeout = 60_000;
    return server;
  };

  const tcp = make();
  const port = await listenTcp(tcp, opts.port);
  let pipeServer: Server | null = null;
  let pipeError = "";
  if (opts.pipe) {
    pipeServer = make();
    try {
      await listenPipe(pipeServer, opts.pipe);
    } catch (e) {
      pipeServer = null;
      pipeError = (e as Error).message;
    }
  }
  const stop = (server: Server) =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    pipe: pipeServer ? opts.pipe! : null,
    pipeError,
    instance,
    close: async () => {
      for (const c of cancels.values()) c.abort();
      await Promise.all([stop(tcp), pipeServer && stop(pipeServer)]);
    },
  };
}

/** Listen from `first` upward; after PORT_TRIES taken or reserved ports, on any free one. */
function listenTcp(server: Server, first: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = first;
    const tryListen = () => {
      server.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code !== "EADDRINUSE" && e.code !== "EACCES") return reject(e);
        if (port === 0) return reject(e);
        port = port < first + PORT_TRIES ? port + 1 : 0;
        tryListen();
      });
      server.listen(port, "127.0.0.1", () => {
        server.removeAllListeners("error");
        resolve((server.address() as { port: number }).port);
      });
    };
    tryListen();
  });
}

/** Listen on a named pipe or socket file. A socket file left by a Kerf that crashed is cleared first; a live one is left alone. */
async function listenPipe(server: Server, path: string) {
  if (!path.startsWith("\\\\") && existsSync(path)) {
    const live = await new Promise<boolean>((r) => {
      const s = connect(path);
      s.once("connect", () => (s.destroy(), r(true)));
      s.once("error", () => r(false));
    });
    if (live) throw new Error("Another Kerf is already listening on its pipe.");
    unlinkSync(path);
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.removeAllListeners("error");
      resolve();
    });
  });
}
