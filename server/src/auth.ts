// Sign-up, sign-in, sessions, email verification and password reset.

import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { emailAllowed } from "./config.js";
import { deviceMark, deviceMarkValid, dummyHash, hashPassword, newId, passwordProblem, randomToken, sha256, verifyPassword } from "./crypto.js";
import { resetEmail, signupEmail, verifyEmail } from "./mail.js";
import { tooMany } from "./security.js";
import { HttpError, type AppEnv, type Deps, type User } from "./types.js";

const DAY = 24 * 60 * 60 * 1000;
export const SESSION_IDLE = 30 * DAY;
export const SESSION_MAX = 90 * DAY;
const HOUR = 60 * 60 * 1000;
const TOKEN_TTL = { verify: DAY, reset: HOUR, signup: DAY } as const;
type TokenKind = keyof typeof TOKEN_TTL;

export const cookieName = (secure: boolean) => (secure ? "__Host-kerf_session" : "kerf_session");
const deviceCookie = (secure: boolean) => (secure ? "__Host-kerf_device" : "kerf_device");

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]{2,}$/, "That doesn't look like an email address.");
const password = z.string().min(1).max(256);

export function logActivity(deps: Deps, userId: string, event: string, ip: string, detail = "") {
  deps.db.run("INSERT INTO activity (user_id, ts, event, ip, detail) VALUES (?, ?, ?, ?, ?)", userId, Date.now(), event, ip, detail.slice(0, 300));
  // keep the newest 200 events per account
  deps.db.run("DELETE FROM activity WHERE user_id = ? AND id NOT IN (SELECT id FROM activity WHERE user_id = ? ORDER BY id DESC LIMIT 200)", userId, userId);
}

function startSession(deps: Deps, c: Context<AppEnv>, userId: string) {
  const token = randomToken(32);
  const now = Date.now();
  deps.db.run(
    "INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?, ?)",
    sha256(token),
    userId,
    now,
    now,
    now + SESSION_IDLE,
    (c.req.header("user-agent") ?? "").slice(0, 300),
    c.get("ip"),
  );
  setCookie(c, cookieName(deps.cfg.secure), token, { httpOnly: true, secure: deps.cfg.secure, sameSite: "Strict", path: "/", maxAge: SESSION_IDLE / 1000 });
  // remember that this browser has signed in to this account (see deviceMark)
  const email = deps.db.get<{ email: string }>("SELECT email FROM users WHERE id = ?", userId)?.email;
  if (email) setCookie(c, deviceCookie(deps.cfg.secure), deviceMark(deps.cfg.secretKey, email), { httpOnly: true, secure: deps.cfg.secure, sameSite: "Strict", path: "/", maxAge: 365 * DAY / 1000 });
  return sha256(token);
}

function endSession(deps: Deps, c: Context<AppEnv>) {
  const token = getCookie(c, cookieName(deps.cfg.secure));
  if (token) deps.db.run("DELETE FROM sessions WHERE id_hash = ?", sha256(token));
  deleteCookie(c, cookieName(deps.cfg.secure), { path: "/", secure: deps.cfg.secure });
}

/** Loads the signed-in user, if any, and keeps the session alive while it is used. */
export function loadSession(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getCookie(c, cookieName(deps.cfg.secure));
    if (token && token.length < 100) {
      const hash = sha256(token);
      const row = deps.db.get<User & { s_created: number; s_seen: number; s_expires: number }>(
        "SELECT u.*, s.created_at AS s_created, s.last_seen_at AS s_seen, s.expires_at AS s_expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?",
        hash,
      );
      const now = Date.now();
      if (row && !row.disabled && row.s_expires > now && row.s_created + SESSION_MAX > now) {
        const { s_created: _c, s_seen, s_expires: _e, ...user } = row;
        c.set("user", user as User);
        c.set("sessionHash", hash);
        if (now - s_seen > 10 * 60 * 1000) deps.db.run("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?", now, Math.min(now + SESSION_IDLE, row.s_created + SESSION_MAX), hash);
      } else if (row) {
        deps.db.run("DELETE FROM sessions WHERE id_hash = ?", hash);
      }
    }
    await next();
  };
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get("user")) return c.json({ error: "signed_out", message: "Sign in to continue." }, 401);
  await next();
};

function issueToken(deps: Deps, userId: string, kind: TokenKind) {
  const token = randomToken(32);
  deps.db.run("DELETE FROM tokens WHERE user_id = ? AND kind = ?", userId, kind);
  deps.db.run("INSERT INTO tokens (hash, user_id, kind, expires_at) VALUES (?, ?, ?, ?)", sha256(token), userId, kind, Date.now() + TOKEN_TTL[kind]);
  return token;
}

const EXPIRED: Record<TokenKind, string> = {
  verify: "This confirmation link has expired or was already used.",
  reset: "This reset link has expired or was already used. Ask for a new one.",
  signup: "This link has expired or was already used. Sign up again to get a new one.",
};

function useToken(deps: Deps, token: string, kind: TokenKind): string {
  const row = deps.db.get<{ user_id: string; expires_at: number; used_at: number | null }>("SELECT user_id, expires_at, used_at FROM tokens WHERE hash = ? AND kind = ?", sha256(token), kind);
  if (!row || row.used_at || row.expires_at < Date.now()) throw new HttpError(400, "bad_token", EXPIRED[kind]);
  deps.db.run("UPDATE tokens SET used_at = ? WHERE hash = ?", Date.now(), sha256(token));
  return row.user_id;
}

async function sendVerification(deps: Deps, user: { id: string; email: string }) {
  if (!deps.mailer.available) return;
  const token = issueToken(deps, user.id, "verify");
  await deps.mailer.send({ to: user.email, ...verifyEmail(deps.cfg.origin, token) }).catch((e) => deps.log(`verification email failed: ${e instanceof Error ? e.message : e}`));
}

export function authRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const { db, cfg, limiter } = deps;

  app.post("/signup", async (c) => {
    const body = z.object({ email, password: password.optional(), name: z.string().trim().max(80).optional(), termsVersion: z.string().min(1).max(40) }).parse(await c.req.json());
    if (cfg.signup === "closed") throw new HttpError(403, "signup_closed", "This Kerf server is not taking new sign-ups.");
    if (cfg.signup === "allowlist" && !emailAllowed(body.email, cfg.allowedEmails)) throw new HttpError(403, "signup_not_allowed", "This Kerf server only takes sign-ups from invited email addresses.");
    const wait = limiter.hit(`signup:${c.get("ip")}`, 5, HOUR);
    if (wait) return tooMany(c, wait, "sign-ups from this network");
    if (cfg.signup === "allowlist") return invite(c, body);

    // open sign-up: the account works straight away; the email is confirmed later
    if (!body.password) throw new HttpError(400, "bad_request", "Choose a password.");
    const problem = passwordProblem(body.password, body.email);
    if (problem) throw new HttpError(422, "weak_password", problem);
    if (db.get("SELECT 1 FROM users WHERE email = ?", body.email)) throw new HttpError(409, "email_taken", "There is already an account with this email. Sign in, or reset the password if you forgot it.");
    const id = newId("usr");
    const hash = await hashPassword(body.password);
    db.run("INSERT INTO users (id, email, name, password_hash, terms_version, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, body.email, body.name ?? "", hash, body.termsVersion, Date.now());
    logActivity(deps, id, "signed_up", c.get("ip"));
    startSession(deps, c, id);
    await sendVerification(deps, { id, email: body.email });
    return c.json({ ok: true }, 201);
  });

  /**
   * Invite-only sign-up: the address must prove itself before the account
   * exists. The emailed link is where the password is chosen, so nobody can
   * claim an invited address, or a shared key that comes with it, without
   * its inbox.
   */
  async function invite(c: Context<AppEnv>, body: { email: string; name?: string; termsVersion: string }) {
    if (!deps.mailer.available) throw new HttpError(503, "no_mail", "This server can't send email, so it can't confirm new accounts. Ask whoever runs it to create yours.");
    const wait = limiter.hit(`signup-email:${body.email}`, 3, HOUR);
    if (wait) return tooMany(c, wait, "emails to this address");
    const existing = db.get<{ id: string; password_hash: string; email_verified_at: number | null }>("SELECT id, password_hash, email_verified_at FROM users WHERE email = ?", body.email);
    if (existing && (existing.password_hash || existing.email_verified_at)) throw new HttpError(409, "email_taken", "There is already an account with this email. Sign in, or reset the password if you forgot it.");
    // a pending account has no password, so it can't be signed in to until the link is used
    const id = existing?.id ?? newId("usr");
    if (existing) db.run("UPDATE users SET name = ?, terms_version = ? WHERE id = ?", body.name ?? "", body.termsVersion, id);
    else db.run("INSERT INTO users (id, email, name, password_hash, terms_version, created_at) VALUES (?, ?, ?, '', ?, ?)", id, body.email, body.name ?? "", body.termsVersion, Date.now());
    const token = issueToken(deps, id, "signup");
    try {
      await deps.mailer.send({ to: body.email, ...signupEmail(cfg.origin, token) });
    } catch (e) {
      deps.log(`sign-up email failed: ${e instanceof Error ? e.message : e}`);
      throw new HttpError(503, "mail_failed", "The server couldn't send the email. Try again in a few minutes.");
    }
    return c.json({ ok: true, confirm: "email" }, 202);
  }

  app.post("/login", async (c) => {
    const body = z.object({ email, password }).parse(await c.req.json());
    const ip = c.get("ip");
    const wait = limiter.hit(`login-ip:${ip}`, 30, 15 * 60 * 1000);
    if (wait) return tooMany(c, wait, "sign-in attempts");
    // failures count against the address, but a browser that has signed in to
    // this account before isn't locked out by failures from elsewhere
    const failHere = `login-fail:${ip}:${body.email}`;
    const failAnywhere = `login-fail:${body.email}`;
    const known = deviceMarkValid(cfg.secretKey, body.email, getCookie(c, deviceCookie(cfg.secure)));
    const locked = limiter.peek(failHere, 8) || (known ? 0 : limiter.peek(failAnywhere, 50));
    if (locked) return tooMany(c, locked, "failed sign-ins");
    const user = db.get<User & { password_hash: string }>("SELECT * FROM users WHERE email = ?", body.email);
    // an account still waiting for its emailed link has no password yet
    const ok = await verifyPassword(body.password, user?.password_hash || (await dummyHash()));
    if (!user || !ok) {
      limiter.hit(failHere, 8, 15 * 60 * 1000);
      limiter.hit(failAnywhere, 50, HOUR);
      if (user) logActivity(deps, user.id, "sign_in_failed", ip);
      throw new HttpError(401, "bad_credentials", "That email and password don't match an account.");
    }
    if (user.disabled) throw new HttpError(403, "disabled", "This account is disabled. Contact whoever runs this Kerf server.");
    limiter.clear(failHere);
    startSession(deps, c, user.id);
    logActivity(deps, user.id, "signed_in", ip, (c.req.header("user-agent") ?? "").slice(0, 160));
    return c.json({ ok: true });
  });

  app.post("/logout", (c) => {
    endSession(deps, c);
    return c.json({ ok: true });
  });

  app.post("/request-reset", async (c) => {
    const body = z.object({ email }).parse(await c.req.json());
    if (!deps.mailer.available) throw new HttpError(503, "no_mail", "This server can't send email, so passwords can't be reset by link. Ask whoever runs it to reset yours.");
    const ip = c.get("ip");
    const wait = limiter.hit(`reset-ip:${ip}`, 10, 60 * 60 * 1000) || limiter.hit(`reset:${body.email}`, 3, 60 * 60 * 1000);
    if (wait) return tooMany(c, wait, "reset requests");
    const user = db.get<User>("SELECT * FROM users WHERE email = ?", body.email);
    if (user && !user.disabled) {
      const token = issueToken(deps, user.id, "reset");
      logActivity(deps, user.id, "reset_requested", ip);
      await deps.mailer.send({ to: user.email, ...resetEmail(cfg.origin, token) }).catch((e) => deps.log(`reset email failed: ${e instanceof Error ? e.message : e}`));
    }
    // the same answer whether or not the account exists
    return c.json({ ok: true });
  });

  /** Sets the password from an emailed link: a reset, or the last step of an invite-only sign-up. */
  async function passwordFromLink(c: Context<AppEnv>, kind: "reset" | "signup") {
    const body = z.object({ token: z.string().min(20).max(100), password }).parse(await c.req.json());
    const wait = limiter.hit(`reset-use:${c.get("ip")}`, 20, HOUR);
    if (wait) return tooMany(c, wait, "attempts");
    const row = db.get<{ user_id: string }>("SELECT user_id FROM tokens WHERE hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?", sha256(body.token), kind, Date.now());
    const user = row && db.get<User>("SELECT * FROM users WHERE id = ?", row.user_id);
    if (!user) throw new HttpError(400, "bad_token", EXPIRED[kind]);
    if (user.disabled) throw new HttpError(403, "disabled", "This account is disabled. Contact whoever runs this Kerf server.");
    const problem = passwordProblem(body.password, user.email);
    if (problem) throw new HttpError(422, "weak_password", problem);
    useToken(deps, body.token, kind);
    const hash = await hashPassword(body.password);
    db.tx(() => {
      // the link proves the address, so it is confirmed too
      db.run("UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?", hash, Date.now(), user.id);
      // a reset signs out every device
      db.run("DELETE FROM sessions WHERE user_id = ?", user.id);
    });
    logActivity(deps, user.id, kind === "reset" ? "password_reset" : "signed_up", c.get("ip"));
    startSession(deps, c, user.id);
    return c.json({ ok: true });
  }

  app.post("/reset", (c) => passwordFromLink(c, "reset"));
  app.post("/finish-signup", (c) => passwordFromLink(c, "signup"));

  app.post("/verify", async (c) => {
    const body = z.object({ token: z.string().min(20).max(100) }).parse(await c.req.json());
    const wait = limiter.hit(`verify:${c.get("ip")}`, 30, 60 * 60 * 1000);
    if (wait) return tooMany(c, wait, "attempts");
    const userId = useToken(deps, body.token, "verify");
    db.run("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?", Date.now(), userId);
    logActivity(deps, userId, "email_confirmed", c.get("ip"));
    return c.json({ ok: true });
  });

  app.post("/resend-verification", requireUser, async (c) => {
    const user = c.get("user");
    if (user.email_verified_at) return c.json({ ok: true });
    const wait = limiter.hit(`resend:${user.id}`, 3, 60 * 60 * 1000);
    if (wait) return tooMany(c, wait, "emails");
    await sendVerification(deps, user);
    return c.json({ ok: true });
  });

  return app;
}

export { endSession, startSession };
