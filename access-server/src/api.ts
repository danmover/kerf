// Kerf's sign-in server (worker.ts is its Worker entry): a Cloudflare Worker with one D1 database, on the
// owner's own (free) Cloudflare account. It decides who may use the Kerf
// desktop app and on which computer:
//
// - the owner makes each account (username + password) from Kerf's Settings
//   → Account on the PC that holds the owner key;
// - an account locks to the first computer that signs in with it, and any
//   other computer is turned away until the owner resets it;
// - a sign-in returns a ticket signed with the owner key, which the app
//   checks against the public key built into it, so a stand-in server can't
//   let anyone in; the app keeps the ticket to start offline until it runs out.
//
// The server never sees a password: the app sends a scrypt proof of it
// (desktop/access/password.ts) and the database keeps a salted hash of that.
// Owner requests are signed with the owner key on the owner's PC; there is no
// admin password to leak. See access-server/README.md for setting it up.

import type { D1Database } from "./d1.js";

export interface Env {
  DB: D1Database;
  /** the owner key (PKCS#8 PEM), a Worker secret: `wrangler secret put SIGNING_KEY` */
  SIGNING_KEY: string;
  /** the owner key's public half (SPKI DER, base64), also built into the app */
  OWNER_PUBLIC_KEY: string;
  /** how long a ticket lets the app start without reaching this server, in days (default 14) */
  TICKET_DAYS?: string;
}

export const VERSION = 1;
const DAY = 86_400_000;
/** wrong passwords allowed before an account waits */
const MAX_FAILS = 5;
const FAIL_WAIT = 15 * 60_000;
/** how far an owner request's clock may be from the server's */
const OWNER_SKEW = 5 * 60_000;

export const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/;
/** a computer code without dashes: 16 Crockford base32 characters */
export const COMPUTER = /^[0-9A-HJKMNP-TV-Z]{16}$/;
const PROOF = /^[A-Za-z0-9_-]{43}$/;

interface Row {
  name: string;
  role: string;
  verifier: string;
  salt: string;
  computers: string;
  max_computers: number;
  blocked: number;
  fails: number;
  fail_at: number;
  created: number;
  last_sign_in: number | null;
  note: string | null;
}

interface Computer {
  /** the computer code */
  c: string;
  /** when it was locked to the account */
  at: number;
  /** its last sign-in */
  seen: number;
  /** what the app said it is, e.g. "Kerf 0.1.19 win32" */
  app?: string;
}

// ---------- encoding and crypto ----------

const enc = new TextEncoder();
type Bytes = Uint8Array<ArrayBuffer>;

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Bytes {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

const fromB64 = (s: string): Bytes => Uint8Array.from(atob(s.replace(/\s+/g, "")), (c) => c.charCodeAt(0));

async function sha256(data: Bytes | string): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

const keys = new Map<string, Promise<CryptoKey>>();

function signingKey(pem: string) {
  let k = keys.get(pem);
  if (!k) {
    const der = fromB64(pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, ""));
    k = crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
    keys.set(pem, k);
  }
  return k;
}

function publicKey(spki: string) {
  let k = keys.get(spki);
  if (!k) {
    k = crypto.subtle.importKey("spki", fromB64(spki), { name: "Ed25519" }, false, ["verify"]);
    keys.set(spki, k);
  }
  return k;
}

/** What the server stores for a password proof: SHA-256 of salt + proof. */
async function verifierFor(proof: string, salt: Uint8Array): Promise<Bytes> {
  const p = fromB64url(proof);
  const both = new Uint8Array(salt.length + p.length);
  both.set(salt);
  both.set(p, salt.length);
  return sha256(both);
}

// ---------- tickets (read by desktop/access/ticket.ts) ----------

export interface TicketBody {
  v: 1;
  /** username */
  u: string;
  /** the computer code it was signed in on */
  c: string;
  /** "owner" or "user" */
  r: string;
  iat: number;
  exp: number;
}

export const TICKET_PREFIX = "kerf1.";
/** what is signed: this, then the payload as base64url */
export const TICKET_CONTEXT = "kerf-ticket-v1.";

export async function signTicket(env: Env, body: TicketBody): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(body)));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, await signingKey(env.SIGNING_KEY), enc.encode(TICKET_CONTEXT + payload)));
  return `${TICKET_PREFIX}${payload}.${b64url(sig)}`;
}

async function readTicket(env: Env, ticket: unknown): Promise<TicketBody | null> {
  if (typeof ticket !== "string" || !ticket.startsWith(TICKET_PREFIX) || ticket.length > 2000) return null;
  const [payload, sig] = ticket.slice(TICKET_PREFIX.length).split(".");
  if (!payload || !sig) return null;
  try {
    const ok = await crypto.subtle.verify({ name: "Ed25519" }, await publicKey(env.OWNER_PUBLIC_KEY), fromB64url(sig), enc.encode(TICKET_CONTEXT + payload));
    if (!ok) return null;
    const body = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as TicketBody;
    return body && body.v === 1 && typeof body.u === "string" && typeof body.c === "string" ? body : null;
  } catch {
    return null;
  }
}

// ---------- owner requests ----------

/** The text an owner request signs (desktop/access/client.ts makes the same). */
export async function ownerMessage(method: string, path: string, time: string, nonce: string, body: string) {
  return `kerf-owner-v1\n${method.toUpperCase()}\n${path}\n${time}\n${nonce}\n${hex(await sha256(body))}`;
}

async function isOwner(req: Request, env: Env, path: string, body: string, now: number) {
  const time = req.headers.get("x-kerf-owner-time") ?? "";
  const nonce = req.headers.get("x-kerf-owner-nonce") ?? "";
  const sig = req.headers.get("x-kerf-owner-signature") ?? "";
  if (!/^\d{10,16}$/.test(time) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || !sig) return false;
  if (Math.abs(now - Number(time)) > OWNER_SKEW) return false;
  try {
    return await crypto.subtle.verify({ name: "Ed25519" }, await publicKey(env.OWNER_PUBLIC_KEY), fromB64url(sig), enc.encode(await ownerMessage(req.method, path, time, nonce, body)));
  } catch {
    return false;
  }
}

// ---------- responses ----------

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });

/** A refusal the app shows as it is. */
const no = (status: number, error: string, message: string) => json(status, { error, message });

const computersOf = (row: Row): Computer[] => {
  try {
    const v = JSON.parse(row.computers);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

function publicUser(row: Row) {
  return {
    user: row.name,
    role: row.role,
    computers: computersOf(row),
    maxComputers: row.max_computers,
    blocked: !!row.blocked,
    created: row.created,
    lastSignIn: row.last_sign_in,
    note: row.note ?? "",
  };
}

async function getUser(env: Env, name: string) {
  return env.DB.prepare("SELECT * FROM users WHERE name = ?1").bind(name).first<Row>();
}

async function body<T>(req: Request): Promise<{ text: string; value: T | null }> {
  const text = await req.text();
  if (text.length > 10_000) return { text, value: null };
  try {
    return { text, value: text ? (JSON.parse(text) as T) : ({} as T) };
  } catch {
    return { text, value: null };
  }
}

function ticketDays(env: Env) {
  const d = Number(env.TICKET_DAYS ?? 14);
  return Number.isFinite(d) && d >= 1 && d <= 90 ? d : 14;
}

// ---------- the API ----------

const WRONG = "Wrong username or password.";
const LOCKED = "This account is already in use on another computer. Each Kerf account works on one computer; ask the person who gave you access to move it to this one.";
const BLOCKED = "This account has been switched off. Ask the person who gave you access.";

/** Sign in with a password: the first computer to do so is the one the account is locked to. */
async function signIn(req: Request, env: Env, now: number) {
  const { value: b } = await body<{ user?: unknown; proof?: unknown; computer?: unknown; app?: unknown }>(req);
  if (!b) return no(400, "bad-request", "That request didn't make sense.");
  const user = String(b.user ?? "").trim().toLowerCase();
  const computer = String(b.computer ?? "");
  const proof = String(b.proof ?? "");
  const app = String(b.app ?? "").slice(0, 60);
  if (!USERNAME.test(user) || !PROOF.test(proof)) return no(401, "wrong", WRONG);
  if (!COMPUTER.test(computer)) return no(400, "bad-request", "Kerf couldn't say which computer this is.");
  const row = await getUser(env, user);
  if (!row) {
    // as slow as a real check, so a wrong name and a wrong password look the same
    await verifierFor(proof, new Uint8Array(16));
    return no(401, "wrong", WRONG);
  }
  if (row.fails >= MAX_FAILS && now - row.fail_at < FAIL_WAIT) {
    const mins = Math.ceil((FAIL_WAIT - (now - row.fail_at)) / 60_000);
    return no(429, "wait", `Too many wrong passwords. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`);
  }
  const ok = sameBytes(await verifierFor(proof, fromB64url(row.salt)), fromB64url(row.verifier));
  if (!ok) {
    const fails = now - row.fail_at < FAIL_WAIT ? row.fails + 1 : 1;
    await env.DB.prepare("UPDATE users SET fails = ?1, fail_at = ?2 WHERE name = ?3").bind(fails, now, user).run();
    return no(401, "wrong", WRONG);
  }
  if (row.blocked) return no(403, "blocked", BLOCKED);
  const list = computersOf(row);
  const known = list.find((c) => c.c === computer);
  if (!known && list.length >= row.max_computers) return no(403, "locked", LOCKED);
  const next = known ? list.map((c) => (c.c === computer ? { ...c, seen: now, app: app || c.app } : c)) : [...list, { c: computer, at: now, seen: now, ...(app ? { app } : {}) }];
  // only if nobody changed the list meanwhile, so two computers signing in at once can't both take the last place
  const r = await env.DB.prepare("UPDATE users SET computers = ?1, fails = 0, fail_at = 0, last_sign_in = ?2 WHERE name = ?3 AND computers = ?4")
    .bind(JSON.stringify(next), now, user, row.computers)
    .run();
  if (!r.meta.changes) return no(409, "busy", "Someone else signed in with this account at the same moment. Try again.");
  const ticket = await signTicket(env, { v: 1, u: user, c: computer, r: row.role, iat: now, exp: now + ticketDays(env) * DAY });
  return json(200, { ticket, user, role: row.role, firstSignInHere: !known });
}

/** Swap a ticket that hasn't run out for a fresh one, while the account is still allowed on its computer. */
async function refresh(req: Request, env: Env, now: number) {
  const { value: b } = await body<{ ticket?: unknown; app?: unknown }>(req);
  const t = await readTicket(env, b?.ticket);
  if (!t || t.exp < now) return no(401, "expired", "Please sign in again.");
  const row = await getUser(env, t.u);
  if (!row) return no(403, "gone", "This account no longer exists. Ask the person who gave you access.");
  if (row.blocked) return no(403, "blocked", BLOCKED);
  const list = computersOf(row);
  if (!list.some((c) => c.c === t.c)) return no(403, "moved", "This account was moved off this computer. Sign in again to use it here.");
  const app = String(b?.app ?? "").slice(0, 60);
  const next = list.map((c) => (c.c === t.c ? { ...c, seen: now, app: app || c.app } : c));
  await env.DB.prepare("UPDATE users SET computers = ?1, last_sign_in = ?2 WHERE name = ?3 AND computers = ?4").bind(JSON.stringify(next), now, t.u, row.computers).run();
  const ticket = await signTicket(env, { v: 1, u: t.u, c: t.c, r: row.role, iat: now, exp: now + ticketDays(env) * DAY });
  return json(200, { ticket, user: t.u, role: row.role });
}

async function owner(req: Request, env: Env, path: string, now: number) {
  const { text, value: b } = await body<{ proof?: unknown; role?: unknown; maxComputers?: unknown; blocked?: unknown; resetComputers?: unknown; note?: unknown }>(req);
  if (!(await isOwner(req, env, path, text, now))) return no(401, "not-owner", "Only the owner's computer can do that.");
  if (!b) return no(400, "bad-request", "That request didn't make sense.");
  if (path === "/v1/owner/users" && req.method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM users ORDER BY created").all<Row>();
    return json(200, { users: results.map(publicUser) });
  }
  const m = /^\/v1\/owner\/users\/([^/]+)$/.exec(path);
  if (!m) return no(404, "not-found", "Not found.");
  const name = decodeURIComponent(m[1]).toLowerCase();
  if (!USERNAME.test(name)) return no(400, "bad-name", "Usernames are 2 to 32 letters, digits, dots, dashes or underscores, starting with a letter or digit.");
  const role = b.role === "owner" ? "owner" : "user";
  const max = b.maxComputers === undefined ? undefined : Number(b.maxComputers);
  if (max !== undefined && !(Number.isInteger(max) && max >= 1 && max <= 10)) return no(400, "bad-request", "An account can be on 1 to 10 computers.");
  const note = b.note === undefined ? undefined : String(b.note).slice(0, 200);
  if (req.method === "PUT") {
    if (typeof b.proof !== "string" || !PROOF.test(b.proof)) return no(400, "bad-request", "No password given.");
    if (await getUser(env, name)) return no(409, "exists", `There is already an account called ${name}.`);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    await env.DB.prepare("INSERT INTO users (name, role, verifier, salt, computers, max_computers, blocked, fails, fail_at, created, last_sign_in, note) VALUES (?1, ?2, ?3, ?4, '[]', ?5, 0, 0, 0, ?6, NULL, ?7)")
      .bind(name, role, b64url(await verifierFor(b.proof, salt)), b64url(salt), max ?? 1, now, note ?? null)
      .run();
    return json(201, { user: publicUser((await getUser(env, name))!) });
  }
  const row = await getUser(env, name);
  if (!row) return no(404, "not-found", `There is no account called ${name}.`);
  if (req.method === "DELETE") {
    await env.DB.prepare("DELETE FROM users WHERE name = ?1").bind(name).run();
    return json(200, { deleted: name });
  }
  if (req.method === "PATCH") {
    const sets: string[] = [];
    const args: unknown[] = [];
    const set = (col: string, v: unknown) => {
      args.push(v);
      sets.push(`${col} = ?${args.length}`);
    };
    if (b.proof !== undefined) {
      if (typeof b.proof !== "string" || !PROOF.test(b.proof)) return no(400, "bad-request", "That password didn't come through.");
      const salt = crypto.getRandomValues(new Uint8Array(16));
      set("verifier", b64url(await verifierFor(b.proof, salt)));
      set("salt", b64url(salt));
      set("fails", 0);
    }
    if (b.blocked !== undefined) set("blocked", b.blocked ? 1 : 0);
    if (b.resetComputers === true) set("computers", "[]");
    if (max !== undefined) set("max_computers", max);
    if (b.role !== undefined) set("role", role);
    if (note !== undefined) set("note", note);
    if (!sets.length) return json(200, { user: publicUser(row) });
    args.push(name);
    await env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE name = ?${args.length}`).bind(...args).run();
    return json(200, { user: publicUser((await getUser(env, name))!) });
  }
  return no(405, "method", "Not allowed.");
}

export async function handle(req: Request, env: Env, now = Date.now()): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  try {
    if (path === "/v1/health" && req.method === "GET") return json(200, { ok: true, version: VERSION });
    if (path === "/v1/sign-in" && req.method === "POST") return await signIn(req, env, now);
    if (path === "/v1/refresh" && req.method === "POST") return await refresh(req, env, now);
    if (path.startsWith("/v1/owner/")) return await owner(req, env, path, now);
    return no(404, "not-found", "Not found.");
  } catch (e) {
    console.error(e);
    return no(500, "server", "Kerf's sign-in server had a problem. Try again in a minute.");
  }
}
