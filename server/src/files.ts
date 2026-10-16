// Files that projects use (imported STEP files, reference photos and PDFs),
// stored once per account under the SHA-256 of their contents, the same way
// the app stores them in the browser. Projects refer to them by hash in their
// opaque `extra` data; files no live project refers to are removed by the
// daily housekeeping.

import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "./auth.js";
import { checkQuota } from "./projects.js";
import { HttpError, type AppEnv, type Deps } from "./types.js";

/** The largest file, as stored (compressed when the browser can). */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

const hash = z.string().regex(/^[a-f0-9]{64}$/, "A file is named by the SHA-256 of its contents.");

export function fileRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const { db } = deps;
  app.use("*", requireUser);
  app.use("*", async (c, next) => {
    const wait = deps.limiter.hit(`files:${c.get("user").id}`, 300, 60 * 1000);
    if (wait) throw new HttpError(429, "rate_limited", "Too many requests. Try again shortly.", { retryAfter: wait });
    await next();
  });

  /** Which of these files the account doesn't have yet. */
  app.post("/missing", async (c) => {
    const { hashes } = z.object({ hashes: z.array(hash).max(500) }).parse(await c.req.json());
    const user = c.get("user");
    const missing = hashes.filter((h) => !db.get("SELECT 1 FROM files WHERE user_id = ? AND hash = ?", user.id, h));
    return c.json({ missing });
  });

  app.put("/:hash", async (c) => {
    const h = hash.parse(c.req.param("hash"));
    const encoding = z.enum(["gzip", "raw"]).parse(c.req.header("x-kerf-encoding") ?? "raw");
    const size = z.coerce.number().int().nonnegative().max(1024 * 1024 * 1024).parse(c.req.header("x-kerf-size") ?? "0");
    const data = new Uint8Array(await c.req.arrayBuffer());
    if (!data.byteLength) throw new HttpError(400, "empty", "The file is empty.");
    if (data.byteLength > MAX_FILE_BYTES) throw new HttpError(413, "too_large", `Files over ${MAX_FILE_BYTES / 1048576} MB can't be synced.`);
    const user = c.get("user");
    db.tx(() => {
      db.run("INSERT OR IGNORE INTO files (user_id, hash, encoding, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?)", user.id, h, encoding, size, data, Date.now());
      checkQuota(deps, user.id);
    });
    return c.json({ ok: true });
  });

  app.get("/:hash", (c) => {
    const h = hash.parse(c.req.param("hash"));
    const row = db.get<{ encoding: string; size: number; data: Uint8Array }>("SELECT encoding, size, data FROM files WHERE user_id = ? AND hash = ?", c.get("user").id, h);
    if (!row) throw new HttpError(404, "not_found", "That file is not in your account.");
    return new Response(new Uint8Array(row.data), {
      headers: { "content-type": "application/octet-stream", "x-kerf-encoding": row.encoding, "x-kerf-size": String(row.size), "cache-control": "no-store" },
    });
  });

  return app;
}
