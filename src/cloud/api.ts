// Talking to the optional Kerf server. Every call is same-origin, carries the
// header the server requires for state changes, and turns failures into
// messages the UI can show.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const isOffline = (e: unknown) => e instanceof ApiError && e.status === 0;

export async function api<T = Record<string, unknown>>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown, opts: { signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? { "x-kerf": "1" } : { "x-kerf": "1", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "offline", navigator.onLine ? "Could not reach the Kerf server." : "You appear to be offline.");
  }
  const type = res.headers.get("content-type") ?? "";
  const json = type.includes("application/json") ? ((await res.json().catch(() => ({}))) as Record<string, unknown>) : {};
  if (!res.ok) {
    const message = typeof json.message === "string" ? json.message : res.status >= 500 ? "The Kerf server had a problem. Try again." : `The request failed (${res.status}).`;
    throw new ApiError(res.status, typeof json.error === "string" ? json.error : "http_error", message, json);
  }
  return json as T;
}

// ---------- shapes the server returns ----------

export interface SessionInfo {
  server: { version: string; signup: "open" | "allowlist" | "closed"; mail: boolean };
  user: { id: string; email: string; name: string; emailVerified: boolean; createdAt: number; termsVersion: string } | null;
  claude: {
    account: { hint: string; savedAt: number } | null;
    shared: { dailyTokens: number; usedToday: number; needsConfirmedEmail: boolean } | null;
    source: "account" | "shared" | null;
  } | null;
}

export interface RemoteProjectSummary {
  id: string;
  name: string;
  template: string;
  createdAt: number;
  updatedAt: number;
  rev: number;
  deletedAt: number | null;
  chatUpdatedAt: number | null;
}

export interface RemoteVersion {
  id: string;
  ts: number;
  author: "you" | "claude" | "system";
  message: string;
  source: string;
}

export interface RemoteProject {
  id: string;
  name: string;
  source: string;
  template: string;
  thumbnail: string | null;
  /** the project's other fields (see extraOf in sync.ts), stored by the server without reading them */
  extra?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  rev: number;
  deletedAt: number | null;
}

/**
 * Asks whether a Kerf server is behind this page. A static host answers /api/session
 * with a 404 or with the app's own HTML, which means Kerf runs on its own.
 */
export async function probeSession(): Promise<{ kind: "server"; info: SessionInfo } | { kind: "none" } | { kind: "unreachable" }> {
  let res: Response;
  try {
    res = await fetch("/api/session", { credentials: "same-origin", headers: { "x-kerf": "1" } });
  } catch {
    return { kind: "unreachable" };
  }
  if (res.status >= 500 && res.status !== 501) return { kind: "unreachable" };
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("application/json")) return { kind: "none" };
  try {
    const info = (await res.json()) as SessionInfo;
    return info && typeof info === "object" && info.server && typeof info.server.version === "string" ? { kind: "server", info } : { kind: "none" };
  } catch {
    return { kind: "none" };
  }
}
