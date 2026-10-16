// The signed-in account: profile, password, devices, activity, usage, export and deletion.

import { Hono } from "hono";
import { z } from "zod";
import { endSession, logActivity, requireUser } from "./auth.js";
import { hashPassword, passwordProblem, verifyPassword } from "./crypto.js";
import { claudeAccess } from "./claude.js";
import { HttpError, type AppEnv, type Deps, type User } from "./types.js";

export function sessionInfo(deps: Deps, user: User | undefined) {
  const { cfg } = deps;
  return {
    server: { version: cfg.version, signup: cfg.signup, mail: deps.mailer.available },
    user: user
      ? {
          id: user.id,
          email: user.email,
          name: user.name,
          emailVerified: !!user.email_verified_at,
          createdAt: user.created_at,
          termsVersion: user.terms_version,
        }
      : null,
    claude: user ? claudeAccess(deps, user) : null,
  };
}

function describeAgent(ua: string) {
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export function accountRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const { db } = deps;
  app.use("*", requireUser);

  app.patch("/", async (c) => {
    const body = z.object({ name: z.string().trim().max(80).optional(), termsVersion: z.string().min(1).max(40).optional() }).parse(await c.req.json());
    const user = c.get("user");
    if (body.name !== undefined) db.run("UPDATE users SET name = ? WHERE id = ?", body.name.replace(/[\u0000-\u001F\u007F]/g, ""), user.id);
    if (body.termsVersion !== undefined) db.run("UPDATE users SET terms_version = ? WHERE id = ?", body.termsVersion, user.id);
    return c.json({ ok: true });
  });

  app.post("/password", async (c) => {
    const body = z.object({ current: z.string().min(1).max(256), next: z.string().min(1).max(256) }).parse(await c.req.json());
    const user = c.get("user");
    const wait = deps.limiter.hit(`password:${user.id}`, 10, 60 * 60 * 1000);
    if (wait) throw new HttpError(429, "rate_limited", "Too many attempts. Try again later.");
    const row = db.get<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", user.id)!;
    if (!(await verifyPassword(body.current, row.password_hash))) throw new HttpError(403, "bad_password", "Your current password is not right.");
    const problem = passwordProblem(body.next, user.email);
    if (problem) throw new HttpError(422, "weak_password", problem);
    const hash = await hashPassword(body.next);
    db.tx(() => {
      db.run("UPDATE users SET password_hash = ? WHERE id = ?", hash, user.id);
      // other devices must sign in again with the new password
      db.run("DELETE FROM sessions WHERE user_id = ? AND id_hash != ?", user.id, c.get("sessionHash"));
    });
    logActivity(deps, user.id, "password_changed", c.get("ip"));
    return c.json({ ok: true });
  });

  app.get("/sessions", (c) => {
    const user = c.get("user");
    const rows = db.all<{ id_hash: string; created_at: number; last_seen_at: number; user_agent: string; ip: string }>(
      "SELECT id_hash, created_at, last_seen_at, user_agent, ip FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC",
      user.id,
      Date.now(),
    );
    return c.json({
      sessions: rows.map((r) => ({
        // the stored hash is already one-way; a shortened form is enough to name a session
        id: r.id_hash.slice(0, 16),
        current: r.id_hash === c.get("sessionHash"),
        device: describeAgent(r.user_agent),
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at,
        ip: r.ip,
      })),
    });
  });

  app.post("/sessions/revoke", async (c) => {
    const body = z.object({ id: z.string().min(8).max(64).optional(), others: z.boolean().optional() }).parse(await c.req.json());
    const user = c.get("user");
    const current = c.get("sessionHash");
    if (body.others) db.run("DELETE FROM sessions WHERE user_id = ? AND id_hash != ?", user.id, current);
    else if (body.id) db.run("DELETE FROM sessions WHERE user_id = ? AND substr(id_hash, 1, 16) = ? AND id_hash != ?", user.id, body.id.slice(0, 16), current);
    logActivity(deps, user.id, body.others ? "signed_out_other_devices" : "signed_out_device", c.get("ip"));
    return c.json({ ok: true });
  });

  app.get("/activity", (c) => {
    const rows = db.all<{ ts: number; event: string; ip: string; detail: string }>("SELECT ts, event, ip, detail FROM activity WHERE user_id = ? ORDER BY id DESC LIMIT 50", c.get("user").id);
    return c.json({ activity: rows });
  });

  app.get("/usage", (c) => {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const rows = db.all<{ day: string; source: string; model: string; requests: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number }>(
      "SELECT day, source, model, requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM usage WHERE user_id = ? AND day >= ? ORDER BY day",
      c.get("user").id,
      since,
    );
    return c.json({ usage: rows });
  });

  app.post("/delete", async (c) => {
    const body = z.object({ password: z.string().min(1).max(256) }).parse(await c.req.json());
    const user = c.get("user");
    const wait = deps.limiter.hit(`delete:${user.id}`, 5, 60 * 60 * 1000);
    if (wait) throw new HttpError(429, "rate_limited", "Too many attempts. Try again later.");
    const row = db.get<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", user.id)!;
    if (!(await verifyPassword(body.password, row.password_hash))) throw new HttpError(403, "bad_password", "That password is not right.");
    endSession(deps, c);
    // projects, versions, chats, sessions, tokens, usage and activity go with the account
    db.tx(() => {
      db.run("DELETE FROM chats WHERE user_id = ?", user.id);
      db.run("DELETE FROM versions WHERE user_id = ?", user.id);
      db.run("DELETE FROM users WHERE id = ?", user.id);
    });
    deps.log(`account deleted: ${user.id}`);
    return c.json({ ok: true });
  });

  return app;
}
