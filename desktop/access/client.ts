// Talking to the sign-in server (access-server/). Sign-ins and ticket
// refreshes are plain JSON; owner requests are signed with the owner key on
// the owner's PC, which never leaves that PC.

import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

/** What the server said, or that it couldn't be reached. */
export type Reply<T> = ({ ok: true } & T) | { ok: false; offline: false; status: number; error: string; message: string } | { ok: false; offline: true; message: string };

/** The owner key, if this computer has it and it is the key this build trusts. */
export function loadOwnerKey(accessDir: string, spki: string): KeyObject | null {
  try {
    const key = createPrivateKey(readFileSync(join(accessDir, "owner-key.pem")));
    const pub = createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64");
    return pub === spki ? key : null;
  } catch {
    return null;
  }
}

/** The text an owner request signs; access-server/src/api.ts checks the same. */
export function ownerMessage(method: string, path: string, time: string, nonce: string, body: string) {
  return `kerf-owner-v1\n${method.toUpperCase()}\n${path}\n${time}\n${nonce}\n${createHash("sha256").update(body).digest("hex")}`;
}

export class AccessClient {
  constructor(
    readonly server: string,
    private fetchFn: Fetch,
    private ownerKey: KeyObject | null = null,
    private timeoutMs = 8000,
    private clock: () => number = Date.now,
  ) {}

  get isOwnerComputer() {
    return !!this.ownerKey;
  }

  private async call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply<T>> {
    if (!this.server) return { ok: false, offline: true, message: "This copy of Kerf has no sign-in server set." };
    const text = body === undefined ? "" : JSON.stringify(body);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(this.server + path, {
        method,
        headers: { ...(text ? { "content-type": "application/json" } : {}), ...headers },
        ...(text ? { body: text } : {}),
        signal: ctl.signal,
      });
      const raw = await res.text();
      let v: Record<string, unknown> = {};
      try {
        v = JSON.parse(raw);
      } catch {
        /* not JSON: a proxy or captive portal page */
      }
      if (res.status >= 200 && res.status < 300 && v && typeof v === "object") return { ok: true, ...(v as T) };
      if (typeof v?.error === "string") return { ok: false, offline: false, status: res.status, error: v.error, message: String(v.message ?? v.error) };
      return { ok: false, offline: true, message: `Kerf's sign-in server didn't answer properly (${res.status}).` };
    } catch (e) {
      const why = (e as Error)?.name === "AbortError" ? "took too long to answer" : "couldn't be reached";
      return { ok: false, offline: true, message: `Kerf's sign-in server ${why}. Check this computer's internet connection.` };
    } finally {
      clearTimeout(timer);
    }
  }

  signIn(user: string, proof: string, computer: string, app: string) {
    return this.call<{ ticket: string; user: string; role: string; firstSignInHere?: boolean }>("POST", "/v1/sign-in", { user, proof, computer, app });
  }

  refresh(ticket: string, app: string) {
    return this.call<{ ticket: string; user: string; role: string }>("POST", "/v1/refresh", { ticket, app });
  }

  /** An owner request, signed with the owner key. */
  owner<T>(method: "GET" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<Reply<T>> {
    if (!this.ownerKey) return Promise.resolve({ ok: false, offline: false, status: 401, error: "not-owner", message: "Only the owner's computer can do that." });
    const text = body === undefined ? "" : JSON.stringify(body);
    const time = String(this.clock());
    const nonce = randomBytes(18).toString("base64url");
    const sig = sign(null, Buffer.from(ownerMessage(method, path, time, nonce, text)), this.ownerKey).toString("base64url");
    return this.call<T>(method, path, body, { "x-kerf-owner-time": time, "x-kerf-owner-nonce": nonce, "x-kerf-owner-signature": sig });
  }
}
