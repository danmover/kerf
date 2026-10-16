import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { Mailer } from "./mail.js";
import type { RateLimiter } from "./security.js";

export interface User {
  id: string;
  email: string;
  name: string;
  email_verified_at: number | null;
  terms_version: string;
  created_at: number;
  disabled: number;
  claude_key_enc: string | null;
  claude_key_hint: string | null;
  claude_key_saved_at: number | null;
}

export interface Deps {
  cfg: Config;
  db: Db;
  mailer: Mailer;
  limiter: RateLimiter;
  /** the fetch used to reach the Claude API (replaced in tests) */
  fetch: typeof fetch;
  log: (msg: string) => void;
}

export interface AppEnv {
  Variables: {
    user: User;
    sessionHash: string;
    ip: string;
  };
}

/** Errors the client can show as-is. */
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 402 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 503,
    readonly code: string,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}
