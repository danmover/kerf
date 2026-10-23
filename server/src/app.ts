// The Kerf server: the API under /api and, in production, the built app itself
// from the same origin, with the same security headers a static host would send.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "@hono/node-server/serve-static";
import { ZodError } from "zod";
import { accountRoutes, sessionInfo } from "./account.js";
import { authRoutes, loadSession } from "./auth.js";
import { claudeRoutes, MAX_REQUEST_BYTES } from "./claude.js";
import { fileRoutes, MAX_FILE_BYTES } from "./files.js";
import { projectRoutes } from "./projects.js";
import { mountChatGPT } from "./chatgpt.js";
import { apiHeaders, clientIp, loadHeaderRules, sameOrigin } from "./security.js";
import { HttpError, type AppEnv, type Deps } from "./types.js";

const limit = (maxSize: number) =>
  bodyLimit({
    maxSize,
    onError: (c) => c.json({ error: "too_large", message: "That request is too large." }, 413),
  });

export function createApp(deps: Deps) {
  const { cfg } = deps;
  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      if (err.extra && typeof err.extra.retryAfter === "number") c.header("Retry-After", String(err.extra.retryAfter));
      return c.json({ error: err.code, message: err.message, ...err.extra }, err.status);
    }
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const field = issue?.path.join(".");
      return c.json({ error: "invalid", message: issue?.message && !/^(Invalid|Expected|Too (big|small):|Unrecognized)/.test(issue.message) ? issue.message : `Check the ${field || "request"} field.` }, 400);
    }
    if (err instanceof SyntaxError) return c.json({ error: "invalid", message: "The request body is not valid JSON." }, 400);
    deps.log(`error on ${c.req.method} ${c.req.path}: ${(err instanceof Error ? err.stack ?? err.message : String(err)).replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-…")}`);
    return c.json({ error: "server_error", message: "Something went wrong on the server." }, 500);
  });

  app.use("*", async (c, next) => {
    c.set("ip", clientIp(c, cfg));
    await next();
  });

  // ---------- API ----------
  app.use("/api/*", apiHeaders(cfg), sameOrigin(cfg), loadSession(deps));
  app.get("/api/health", (c) => c.json({ ok: true, version: cfg.version }));
  app.get("/api/session", (c) => c.json(sessionInfo(deps, c.get("user"))));
  mountChatGPT(app, deps);
  app.use("/api/auth/*", limit(64 * 1024));
  app.route("/api/auth", authRoutes(deps));
  app.use("/api/account/*", limit(64 * 1024));
  app.use("/api/account", limit(64 * 1024));
  app.route("/api/account", accountRoutes(deps));
  app.use("/api/projects/*", limit(48 * 1024 * 1024));
  app.route("/api/projects", projectRoutes(deps));
  app.use("/api/files/*", limit(MAX_FILE_BYTES + 1024));
  app.route("/api/files", fileRoutes(deps));
  app.use("/api/claude/*", limit(MAX_REQUEST_BYTES));
  app.route("/api/claude", claudeRoutes(deps));
  app.all("/api/*", (c) => c.json({ error: "not_found", message: "No such API endpoint." }, 404));

  // ---------- the app ----------
  const dir = cfg.staticDir;
  if (dir && existsSync(join(dir, "index.html"))) {
    const rules = loadHeaderRules(join(dir, "_headers"));
    app.use("*", async (c, next) => {
      await next();
      const path = c.req.path;
      for (const r of rules) if (r.pattern.test(path)) for (const [k, v] of r.headers) c.res.headers.set(k, v);
      if (cfg.secure) c.res.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
      // file names under /assets carry a content hash, so they never change
      c.res.headers.set("Cache-Control", path.startsWith("/assets/") && c.res.status === 200 ? "public, max-age=31536000, immutable" : "no-cache");
    });
    app.get("/_headers", (c) => c.notFound());
    // rejects "..", encoded paths and doubled slashes; "/" serves index.html
    app.get("*", serveStatic({ root: dir }));
  }
  app.notFound((c) => c.text("Not found", 404));
  return app;
}
