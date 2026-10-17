// Serves the production build to the desktop window from Kerf's own
// kerf://app origin. Every response carries the same security headers a
// static host or the Kerf server gives it, read from the build's _headers
// file, so the kernel worker is still the only code allowed eval.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { loadHeaderRules } from "../server/src/security.js";

export const SCHEME = "kerf";
export const HOST = "app";
export const ORIGIN = `${SCHEME}://${HOST}`;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  // WebAssembly.instantiateStreaming refuses any other type
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" } });

/** A request handler for the kerf: scheme that serves the files under `root`. */
export function staticHandler(root: string) {
  const base = resolve(root);
  const rules = loadHeaderRules(resolve(base, "_headers"));
  return async (req: Request): Promise<Response> => {
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    const url = new URL(req.url);
    if (url.host !== HOST) return notFound();
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return notFound();
    }
    // the probe for a Kerf server (GET /api/session) gets a 404: the desktop app runs on its own
    if (path.includes("\0") || path === "/_headers" || path.startsWith("/api/")) return notFound();
    const file = resolve(base, "." + (path === "/" ? "/index.html" : path));
    if (!file.startsWith(base + sep)) return notFound();
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return notFound();
    const headers = new Headers({
      "Content-Type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": String(info.size),
      "Cache-Control": "no-cache",
    });
    for (const r of rules) if (r.pattern.test(url.pathname)) for (const [k, v] of r.headers) headers.set(k, v);
    const body = req.method === "HEAD" ? null : (Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>);
    return new Response(body, { status: 200, headers });
  };
}
