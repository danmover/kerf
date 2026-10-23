// Server configuration, read once from the environment. Production refuses to
// start with settings that would be unsafe on the internet.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type TrustProxy = "none" | "fly" | "cloudflare" | "x-forwarded-for";
export type SignupMode = "open" | "allowlist" | "closed";

export interface Config {
  production: boolean;
  port: number;
  host: string;
  /** the public origin, e.g. https://kerf.example.com; requests from any other origin are refused */
  origin: string;
  secure: boolean;
  dataDir: string;
  /** where the built app lives; null when the server only serves the API */
  staticDir: string | null;
  /** 32-byte key that encrypts stored Claude API keys */
  secretKey: Buffer;
  signup: SignupMode;
  allowedEmails: string[];
  smtpUrl: string | null;
  mailFrom: string;
  anthropicBaseUrl: string;
  /** an operator-paid key that listed, confirmed accounts may use, with a daily token budget each */
  shared: { key: string; emails: string[]; dailyTokens: number; models: string[] } | null;
  trustProxy: TrustProxy;
  version: string;
  /** Pre-registered OAuth client for the ChatGPT MCP connection; disabled until configured. */
  chatgpt: { clientId: string; clientSecret: string; redirectUris: string[] } | null;
}

type Env = Record<string, string | undefined>;

const list = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

/** `dan@example.com` matches exactly; `*@example.com` matches the whole domain; `*` matches anyone. */
export function emailAllowed(email: string, patterns: string[]): boolean {
  const e = email.toLowerCase();
  return patterns.some((p) => p === "*" || p === e || (p.startsWith("*@") && e.endsWith(p.slice(1))));
}

function readSecret(env: Env, production: boolean, dataDir: string): Buffer {
  const raw = env.KERF_SECRET_KEY?.trim();
  if (raw) {
    const key = Buffer.from(raw, "base64");
    if (key.length !== 32) throw new Error("KERF_SECRET_KEY must be 32 random bytes, base64-encoded. Generate one with: npm run server:secret");
    return key;
  }
  if (production) throw new Error("KERF_SECRET_KEY is required in production. Generate one with: npm run server:secret");
  // development: a key kept beside the dev database, so saved API keys survive restarts
  const file = join(dataDir, "dev-secret.key");
  if (existsSync(file)) return Buffer.from(readFileSync(file, "utf8").trim(), "base64");
  const key = randomBytes(32);
  writeFileSync(file, key.toString("base64"), { mode: 0o600 });
  return key;
}

export function loadConfig(env: Env = process.env, version = "0.0.0"): Config {
  const production = env.NODE_ENV === "production";
  const port = Number(env.PORT ?? (production ? 8080 : 8787));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`PORT is not a valid port: ${env.PORT}`);

  const origin = (env.KERF_ORIGIN ?? (production ? "" : "http://localhost:5173")).replace(/\/+$/, "");
  if (!origin) throw new Error("KERF_ORIGIN is required in production, e.g. https://kerf.example.com");
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`KERF_ORIGIN is not a URL: ${origin}`);
  }
  if (url.origin !== origin) throw new Error(`KERF_ORIGIN must be an origin only (scheme, host and port), e.g. ${url.origin}`);
  const secure = url.protocol === "https:";
  if (production && !secure) throw new Error("KERF_ORIGIN must use https in production");

  const dataDir = resolve(env.KERF_DATA_DIR ?? (production ? "/data" : "server/data"));
  mkdirSync(dataDir, { recursive: true });

  const staticDir = env.KERF_STATIC_DIR === "" ? null : resolve(env.KERF_STATIC_DIR ?? "dist");

  const allowedEmails = list(env.KERF_ALLOWED_EMAILS);
  const signupEnv = env.KERF_SIGNUP?.trim().toLowerCase();
  if (signupEnv && !["open", "closed", "allowlist"].includes(signupEnv)) throw new Error("KERF_SIGNUP must be open, allowlist or closed");
  // safe default on the internet: only listed emails may sign up, and nobody when the list is empty
  const signup: SignupMode = signupEnv === "closed" ? "closed" : signupEnv === "open" ? "open" : allowedEmails.length || production ? "allowlist" : "open";

  const sharedKey = env.KERF_SHARED_ANTHROPIC_KEY?.trim();
  const sharedEmails = list(env.KERF_SHARED_CLAUDE_EMAILS);
  const dailyTokens = Number(env.KERF_SHARED_DAILY_TOKENS ?? 1_000_000);
  if (!Number.isFinite(dailyTokens) || dailyTokens < 0) throw new Error("KERF_SHARED_DAILY_TOKENS must be a number of tokens");
  // empty means any Claude model
  const sharedModels = list(env.KERF_SHARED_MODELS);

  const trust = (env.KERF_TRUST_PROXY ?? "none").toLowerCase() as TrustProxy;
  if (!["none", "fly", "cloudflare", "x-forwarded-for"].includes(trust)) throw new Error("KERF_TRUST_PROXY must be none, fly, cloudflare or x-forwarded-for");

  const anthropicBaseUrl = (env.KERF_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, "");
  if (production && !anthropicBaseUrl.startsWith("https://")) throw new Error("KERF_ANTHROPIC_BASE_URL must use https in production");

  const clientId = env.KERF_CHATGPT_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.KERF_CHATGPT_CLIENT_SECRET?.trim() ?? "";
  const redirectUris = (env.KERF_CHATGPT_REDIRECT_URIS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (clientId || clientSecret || redirectUris.length) {
    if (!clientId || clientSecret.length < 32 || !redirectUris.length) throw Error("Set KERF_CHATGPT_CLIENT_ID, KERF_CHATGPT_CLIENT_SECRET (at least 32 characters), and KERF_CHATGPT_REDIRECT_URIS together.");
    for (const redirect of redirectUris) { const u = new URL(redirect); if (u.protocol !== "https:" || u.hash || u.username || u.password) throw Error("ChatGPT redirect URIs must be exact HTTPS URLs without fragments or credentials."); }
  }
  return {
    production,
    port,
    host: env.HOST ?? (production ? "0.0.0.0" : "127.0.0.1"),
    origin,
    secure,
    dataDir,
    staticDir,
    secretKey: readSecret(env, production, dataDir),
    signup,
    allowedEmails,
    smtpUrl: env.SMTP_URL?.trim() || null,
    mailFrom: env.MAIL_FROM?.trim() || `Kerf <no-reply@${url.hostname}>`,
    anthropicBaseUrl,
    shared: sharedKey && sharedEmails.length ? { key: sharedKey, emails: sharedEmails, dailyTokens, models: sharedModels } : null,
    trustProxy: trust,
    version,
    chatgpt: clientId ? { clientId, clientSecret, redirectUris } : null,
  };
}
