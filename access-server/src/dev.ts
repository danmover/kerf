// The sign-in server on Node, for tests and for trying the desktop app's
// sign-in locally: the same handler as the Worker, over node:sqlite in place
// of D1. Not for production (the Worker is).
//
//   KERF_ACCESS_KEY_FILE=key.pem PORT=8799 npx tsx access-server/src/dev.ts
//
// With no key file it makes a throwaway key and prints its public half, for a
// desktop build made with KERF_ACCESS_TEST_PUBLIC_KEY (scripts/build-desktop.mjs).

import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import type { D1Database, D1PreparedStatement, D1Result } from "./d1.js";
import { handle, type Env } from "./api.js";

/** D1's API over a node:sqlite database. */
export function sqliteD1(file = ":memory:"): D1Database & { raw: DatabaseSync } {
  const db = new DatabaseSync(file);
  db.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  const statement = (sql: string, args: unknown[] = []): D1PreparedStatement => {
    const s = () => db.prepare(sql);
    const vals = args as (string | number | null)[];
    return {
      bind: (...more: unknown[]) => statement(sql, [...args, ...more]),
      first: async <T,>() => (s().get(...vals) as T | undefined) ?? null,
      run: async (): Promise<D1Result> => ({ results: [], meta: { changes: Number(s().run(...vals).changes) } }),
      all: async <T,>(): Promise<D1Result<T>> => ({ results: s().all(...vals) as T[], meta: { changes: 0 } }),
    };
  };
  return { prepare: (sql: string) => statement(sql), raw: db };
}

/** An Env with a throwaway or given owner key. */
export function devEnv(pem?: string, db: D1Database = sqliteD1()): Env & { pem: string } {
  const key = pem ? createPrivateKey(pem) : generateKeyPairSync("ed25519").privateKey;
  const text = key.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    DB: db,
    SIGNING_KEY: text,
    OWNER_PUBLIC_KEY: createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64"),
    TICKET_DAYS: process.env.KERF_ACCESS_TICKET_DAYS,
    pem: text,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.env.KERF_ACCESS_KEY_FILE;
  const env = devEnv(file ? readFileSync(file, "utf8") : undefined, sqliteD1(process.env.KERF_ACCESS_DB ?? ":memory:"));
  const port = Number(process.env.PORT ?? 8799);
  serve({ fetch: (req) => handle(req, env), port, hostname: "127.0.0.1" });
  console.log(`Kerf sign-in server on http://127.0.0.1:${port}`);
  console.log(`KERF_ACCESS_TEST_PUBLIC_KEY=${env.OWNER_PUBLIC_KEY}`);
}
