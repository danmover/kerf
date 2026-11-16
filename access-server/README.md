# Kerf sign-in server

A Cloudflare Worker (free plan) with one D1 database that decides who may use
the Kerf desktop app, and on which computer. The app's half is in
`desktop/access/`.

- The owner makes each account in Kerf's **Settings → Account**, signed in on
  the PC that holds the owner key (`%APPDATA%\Kerf\access\owner-key.pem`).
  Owner requests are signed with that key; there is no admin password.
- An account locks to the first computer that signs in with it. Others are
  turned away until the owner presses **Move** (or allows more computers).
- A sign-in returns a ticket signed with the owner key. The app checks it
  against the public key built into it (`desktop/access/config.ts`), so a
  stand-in server can't let anyone in. Kerf starts offline on a ticket for up
  to `TICKET_DAYS` (14) days, and checks again every few hours while open.
- Passwords never reach the server: the app sends a scrypt proof, and the
  database keeps a salted SHA-256 of it.

## Setting it up (once, from the owner's PC)

```
cd access-server
npx wrangler login                      # opens the browser: Allow
npx wrangler d1 create kerf-access      # put the database_id it prints into wrangler.toml
npx wrangler d1 execute kerf-access --remote --file schema.sql
npx wrangler deploy                     # prints https://kerf-access.<you>.workers.dev
cmd /c "npx wrangler secret put SIGNING_KEY < %APPDATA%\Kerf\access\owner-key.pem"
```

Then put the address in `ACCESS_SERVER` in `desktop/access/config.ts` and
build the app. Check it with `curl https://kerf-access.<you>.workers.dev/v1/health`.

Never commit or paste the owner key. If it is lost, no new accounts can be
made: generate a new key, change `OWNER_PUBLIC_KEY` here and in
`desktop/access/config.ts`, put the new secret, and ship a new build.

## Trying it locally

```
KERF_ACCESS_KEY_FILE=test-key.pem PORT=8799 npx tsx access-server/src/dev.ts
KERF_ACCESS_SERVER=http://127.0.0.1:8799 KERF_ACCESS_TEST_PUBLIC_KEY=<printed key> node scripts/build-desktop.mjs
```

`dev.ts` runs the same handler on Node with node:sqlite in place of D1. A
build with those variables trusts the test key: never give it to anyone.
`tests/access.test.ts` runs the server and the app's sign-in together.
