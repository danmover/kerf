// The Kerf server process: configuration, database, HTTP server and shutdown.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Db } from "./db.js";
import { createMailer } from "./mail.js";
import { housekeeping } from "./housekeeping.js";
import { RateLimiter } from "./security.js";

// the bundler fills this in; under tsx it is read from the package file
declare const __KERF_VERSION__: string | undefined;
const version = typeof __KERF_VERSION__ === "string" ? __KERF_VERSION__ : (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

let cfg;
try {
  cfg = loadConfig(process.env, version);
} catch (e) {
  console.error(`Kerf server not started: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const db = new Db(join(cfg.dataDir, "kerf.db"));
const deps = { cfg, db, mailer: createMailer(cfg), limiter: new RateLimiter(), fetch: globalThis.fetch.bind(globalThis), log };
const app = createApp(deps);

housekeeping(deps);
const daily = setInterval(() => housekeeping(deps), 24 * 3600 * 1000);
daily.unref();

const server = serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.host }, (info) => {
  log(`Kerf server ${cfg.version} on http://${info.address}:${info.port} (${cfg.production ? "production" : "development"}), public origin ${cfg.origin}`);
  log(`sign-ups: ${cfg.signup}${cfg.signup === "allowlist" ? ` (${cfg.allowedEmails.length} allowed)` : ""} · email: ${cfg.smtpUrl ? "SMTP" : cfg.production ? "off" : "printed here"} · shared Claude key: ${cfg.shared ? `on for ${cfg.shared.emails.length} pattern(s)` : "off"}`);
  if (!cfg.staticDir) log("serving the API only");
});

function shutdown() {
  log("shutting down");
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
