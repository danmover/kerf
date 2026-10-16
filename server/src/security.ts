// Request hygiene: client IP, same-origin checks, rate limits and the static
// security headers shared with public/_headers.

import { readFileSync } from "node:fs";
import type { Context, MiddlewareHandler } from "hono";
import type { Config } from "./config.js";

// ---------- client IP ----------

export function clientIp(c: Context, cfg: Config): string {
  const h = (n: string) => c.req.header(n)?.trim();
  const fromProxy =
    cfg.trustProxy === "fly"
      ? h("fly-client-ip")
      : cfg.trustProxy === "cloudflare"
        ? h("cf-connecting-ip")
        : cfg.trustProxy === "x-forwarded-for"
          ? h("x-forwarded-for")?.split(",").at(-1)?.trim()
          : undefined;
  if (fromProxy) return fromProxy.slice(0, 64);
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? "unknown";
}

// ---------- same-origin requests only ----------

/**
 * Every state-changing API call must come from Kerf's own page: the Origin
 * header must match, and a custom header (which a cross-site form or simple
 * request cannot set) must be present. Together with SameSite=Strict cookies
 * this blocks cross-site request forgery.
 */
export function sameOrigin(cfg: Config): MiddlewareHandler {
  return async (c, next) => {
    const m = c.req.method;
    if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS") {
      const origin = c.req.header("origin");
      if (origin !== cfg.origin) return c.json({ error: "cross_origin", message: "This request did not come from Kerf." }, 403);
      if (c.req.header("x-kerf") !== "1") return c.json({ error: "missing_header", message: "This request did not come from Kerf." }, 403);
    }
    await next();
  };
}

// ---------- rate limits ----------

interface Bucket {
  count: number;
  reset: number;
}

/** Fixed-window counters in memory. Enough for a single server; use a shared store if you run several. */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private sweep = 0;

  /** Returns 0 when allowed, or the seconds to wait. */
  hit(key: string, limit: number, windowMs: number, now = Date.now()): number {
    if (++this.sweep % 500 === 0) for (const [k, b] of this.buckets) if (b.reset <= now) this.buckets.delete(k);
    let b = this.buckets.get(key);
    if (!b || b.reset <= now) {
      b = { count: 0, reset: now + windowMs };
      this.buckets.set(key, b);
    }
    b.count++;
    return b.count > limit ? Math.ceil((b.reset - now) / 1000) : 0;
  }

  /** Like hit, but only looks: 0 when under the limit, or the seconds to wait. */
  peek(key: string, limit: number, now = Date.now()): number {
    const b = this.buckets.get(key);
    return b && b.reset > now && b.count >= limit ? Math.ceil((b.reset - now) / 1000) : 0;
  }

  /** Forget a key, e.g. failed logins after a success. */
  clear(key: string) {
    this.buckets.delete(key);
  }
}

export function tooMany(c: Context, wait: number, what = "requests") {
  c.header("Retry-After", String(wait));
  return c.json({ error: "rate_limited", message: `Too many ${what}. Try again in ${wait < 90 ? `${wait} seconds` : `${Math.ceil(wait / 60)} minutes`}.`, retryAfter: wait }, 429);
}

// ---------- static security headers ----------

export interface HeaderRule {
  pattern: RegExp;
  headers: [string, string][];
}

/** Parses the Netlify/Cloudflare `_headers` format so the server applies exactly the same policy as a static host. */
export function parseHeadersFile(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let cur: HeaderRule | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      const path = line.trim();
      const re = "^" + path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$";
      cur = { pattern: new RegExp(re), headers: [] };
      rules.push(cur);
    } else if (cur) {
      const i = line.indexOf(":");
      if (i > 0) cur.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    }
  }
  return rules;
}

export function loadHeaderRules(file: string): HeaderRule[] {
  try {
    return parseHeadersFile(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

/** Headers for every API response: never cached, never framed, never sniffed. */
export function apiHeaders(cfg: Config): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    c.header("Cross-Origin-Resource-Policy", "same-origin");
    if (cfg.secure) c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  };
}
