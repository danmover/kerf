// The part of Cloudflare's D1 database API the sign-in server uses, so it
// typechecks without Cloudflare's type package. dev.ts provides the same
// shape over node:sqlite for tests and local runs.

export interface D1Result<T = unknown> {
  results: T[];
  meta: { changes: number };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<D1Result>;
  all<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
}
