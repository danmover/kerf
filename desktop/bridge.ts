// Kerf's stdio bridge for Claude Code. "Connect Claude Code" in Settings →
// Claude registers this as Claude Code's `kerf` server, run by Kerf's own
// executable as plain Node (ELECTRON_RUN_AS_NODE=1). Claude Code starts it and
// talks MCP over its stdin and stdout, one JSON message per line; the bridge
// passes each message to the running Kerf over Kerf's local pipe
// (desktop/mcp.ts), and over 127.0.0.1 if the pipe isn't there.
//
// So Claude Code never makes an HTTP connection to Kerf: there's no port to
// keep right, no proxy or antivirus web filter in the way, and no token to
// paste. The bridge reads the current token from Kerf's settings file, so New
// token doesn't break the connection either.
//
// While Kerf is closed, the bridge still answers initialize and lists Kerf's
// tools (from the list Kerf saved last time it ran), so Claude Code shows
// Kerf as connected whatever order things start in. The first tool call opens
// Kerf and waits for it.

import { request } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { CLIENT_HEADER, DEFAULT_PORT, KERF_HEADER, MCP_INSTRUCTIONS, clientOf, initializeResult, pipePath } from "./mcp.js";

/** The tool list Kerf saves each time Claude Code lists its tools, for the bridge to offer while Kerf is closed. */
export const TOOLS_CACHE = "claude-code-tools.json";

export interface BridgeOptions {
  /** Kerf's data folder (Electron's userData), where its settings and pipe are */
  dataDir: string;
  input: NodeJS.ReadableStream;
  /** writes one message; the bridge adds no newline */
  write: (line: string) => void;
  log?: (text: string) => void;
  version: string;
  /** opens Kerf; called at most once per wait */
  launch: () => void;
  /** how long to wait for Kerf to open, 90 s by default */
  launchWaitMs?: number;
  /** how often to look while waiting */
  pollMs?: number;
}

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

/** What the bridge needs from Kerf's settings file, read fresh for every message so a new token or port is picked up at once. */
export function readKerf(dataDir: string): { enabled: boolean; port: number; token: string } {
  try {
    const cc = JSON.parse(readFileSync(join(dataDir, "desktop-settings.json"), "utf8"))?.claudeCode ?? {};
    return {
      enabled: cc.enabled === true,
      port: Number.isInteger(cc.port) ? cc.port : DEFAULT_PORT,
      token: typeof cc.token === "string" ? cc.token : "",
    };
  } catch {
    return { enabled: false, port: DEFAULT_PORT, token: "" };
  }
}

function cachedTools(dataDir: string): unknown[] | null {
  try {
    const t = JSON.parse(readFileSync(join(dataDir, TOOLS_CACHE), "utf8"))?.tools;
    return Array.isArray(t) && t.length ? t : null;
  } catch {
    return null;
  }
}

/** Kerf isn't listening: closed, starting, or with Claude Code turned off. */
export class Down extends Error {}

export type Reply = { status: number; body: string; kerf: string };

/** POST one message to Kerf over its pipe, or over 127.0.0.1 when there's no pipe (a Kerf from before pipes). */
async function toKerf(dataDir: string, body: string, signal?: AbortSignal, client = ""): Promise<Reply> {
  const kerf = readKerf(dataDir);
  const via = [{ socketPath: pipePath(dataDir) }, { host: "127.0.0.1", port: kerf.port }];
  for (let i = 0; i < via.length; i++) {
    try {
      return await post(via[i], kerf.token, body, signal, client);
    } catch (e) {
      if (!(e instanceof Down) || i === via.length - 1) throw e;
    }
  }
  throw new Down();
}

/** POST one message to wherever Kerf should be; Down when nothing listens there. */
export function post(target: { socketPath: string } | { host: string; port: number }, token: string, body: string, signal?: AbortSignal, client = ""): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let answered = false;
    const req = request(
      {
        ...target,
        path: "/mcp",
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": Buffer.byteLength(body),
          ...(client ? { [CLIENT_HEADER]: client } : {}),
        },
        signal,
      },
      (res) => {
        answered = true;
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), kerf: String(res.headers[KERF_HEADER] ?? "") }));
        res.on("error", reject);
      },
    );
    req.on("error", (e: NodeJS.ErrnoException) => {
      // nothing listening there; a reset after Kerf started answering is a real failure
      if (!answered && ["ENOENT", "ECONNREFUSED", "EACCES", "ENOTSOCK", "EPIPE"].includes(e.code ?? "")) reject(new Down());
      else reject(e);
    });
    req.end(body);
  });
}

const rpcError = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const toolError = (id: Rpc["id"], text: string) => ({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text }] } });

const OFF = "Kerf's tools for Claude Code are turned off. Ask the person to press Connect Claude Code in Kerf's Settings → Claude, then call this again.";
const NO_ANSWER = "Kerf didn't open in time. Ask the person to open Kerf (and a project in it), then call this again.";
const DROPPED = "Kerf closed or reloaded while it was running this. If it's open again, call this again.";

/** Run the bridge until the input ends. */
export function runBridge(o: BridgeOptions): Promise<void> {
  const log = o.log ?? (() => {});
  const inflight = new Map<string, AbortController>();
  let opening: Promise<boolean> | null = null;
  /** who the bridge serves, from initialize, passed on with every message */
  let client = "";
  const out = (v: unknown) => o.write(typeof v === "string" ? v : JSON.stringify(v));

  /** Open Kerf (once, however many calls are waiting) and wait until it answers. */
  const openKerf = () =>
    (opening ??= (async () => {
      log("Kerf isn't running: opening it");
      try {
        o.launch();
      } catch (e) {
        log(`couldn't open Kerf: ${(e as Error).message}`);
        return false;
      }
      const until = Date.now() + (o.launchWaitMs ?? 90_000);
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, o.pollMs ?? 500));
        try {
          if ((await toKerf(o.dataDir, JSON.stringify({ jsonrpc: "2.0", id: "kerf-bridge-wait", method: "ping" }), undefined, client)).status === 200) return true;
        } catch {
          /* still starting */
        }
      }
      return false;
    })().finally(() => (opening = null)));

  /** Kerf's reply to a request, re-addressed to the request's id when Kerf answered with an error status. */
  const relay = (msg: Rpc, r: Reply) => {
    if (r.status === 200) return out(r.body);
    let error = { code: -32603, message: `Kerf answered ${r.status}` };
    try {
      error = JSON.parse(r.body).error ?? error;
    } catch {
      /* not JSON */
    }
    out({ jsonrpc: "2.0", id: msg.id, error });
  };

  const onRequest = async (msg: Rpc, line: string) => {
    const key = String(msg.id);
    const ac = new AbortController();
    inflight.set(key, ac);
    const send = (v: unknown) => {
      // a cancelled request gets no reply
      if (!ac.signal.aborted) out(v);
    };
    try {
      if (msg.method === "ping") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
      if (msg.method === "initialize") client = clientOf(msg).replace(/[^\x20-\x7e]/g, "");
      try {
        const r = await toKerf(o.dataDir, line, ac.signal, client);
        if (!ac.signal.aborted) relay(msg, r);
        return;
      } catch (e) {
        if (ac.signal.aborted) return;
        if (!(e instanceof Down)) {
          log(`lost Kerf during ${msg.method}: ${(e as Error).message}`);
          return send(msg.method === "tools/call" ? toolError(msg.id, DROPPED) : rpcError(msg.id, -32603, DROPPED));
        }
      }
      // Kerf isn't listening
      if (msg.method === "initialize") return send(initializeResult(msg, MCP_INSTRUCTIONS, o.version));
      const tools = msg.method === "tools/list" ? cachedTools(o.dataDir) : null;
      if (tools) return send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
      if (msg.method !== "tools/list" && msg.method !== "tools/call") return send(rpcError(msg.id, -32601, `Kerf has no method ${msg.method}`));
      if (!readKerf(o.dataDir).enabled) return send(msg.method === "tools/call" ? toolError(msg.id, OFF) : rpcError(msg.id, -32603, OFF));
      if (!(await openKerf())) return send(msg.method === "tools/call" ? toolError(msg.id, NO_ANSWER) : rpcError(msg.id, -32603, NO_ANSWER));
      if (ac.signal.aborted) return;
      try {
        relay(msg, await toKerf(o.dataDir, line, ac.signal, client));
      } catch (e) {
        if (!ac.signal.aborted) send(msg.method === "tools/call" ? toolError(msg.id, DROPPED) : rpcError(msg.id, -32603, (e as Error).message));
      }
    } finally {
      inflight.delete(key);
    }
  };

  const onLine = (line: string) => {
    line = line.trim();
    if (!line) return;
    let msg: Rpc;
    try {
      msg = JSON.parse(line);
    } catch {
      return out(rpcError(null, -32700, "Parse error"));
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return out(rpcError(null, -32600, "Kerf takes one message at a time"));
    // a reply from Claude Code to something Kerf never asks: nothing to do
    if (typeof msg.method !== "string") return;
    if (msg.id === undefined || msg.id === null) {
      if (msg.method === "notifications/cancelled") {
        // dropping the request makes Kerf stop the call, as when Claude Code disconnects
        inflight.get(String(msg.params?.requestId))?.abort();
      }
      return;
    }
    void onRequest(msg, line);
  };

  return new Promise((resolve) => {
    const rl = createInterface({ input: o.input, crlfDelay: Infinity });
    rl.on("line", onLine);
    rl.on("close", () => {
      for (const ac of inflight.values()) ac.abort();
      resolve();
    });
  });
}
