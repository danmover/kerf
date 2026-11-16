-- Kerf sign-in server: one row per account. `computers` is a JSON list of
-- the computers the account is locked to ([{c, at, seen, app}]), at most
-- max_computers long. Apply with:
--   npx wrangler d1 execute kerf-access --remote --file access-server/schema.sql
CREATE TABLE IF NOT EXISTS users (
  name TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'user',
  verifier TEXT NOT NULL,
  salt TEXT NOT NULL,
  computers TEXT NOT NULL DEFAULT '[]',
  max_computers INTEGER NOT NULL DEFAULT 1,
  blocked INTEGER NOT NULL DEFAULT 0,
  fails INTEGER NOT NULL DEFAULT 0,
  fail_at INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  last_sign_in INTEGER,
  note TEXT
);
