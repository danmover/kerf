# Kerf server

An optional server that adds accounts to Kerf. Without it, Kerf runs entirely in the browser exactly as before. With it, people can:

- sign in, and confirm or reset their password by email;
- sync projects, version history and chats between browsers, with offline edits merged when they reconnect;
- keep their Claude API key on their account instead of in the browser. The server stores it encrypted and adds it to Claude requests, so the key never comes back to any browser.

It is one Node.js process with a SQLite database. It serves the built app and the API from the same origin, so the app's strict Content Security Policy doesn't change.

## Run it on your computer

You need Node.js 22.13 or newer.

```bash
npm install
npm run dev:full        # app on http://localhost:5173, server on :8787
```

On Windows PowerShell, use `npm.cmd run dev:full`.

The app's dev server passes `/api` to the Kerf server. In development, sign-ups are open, emails (confirmation and password reset) are printed in the terminal instead of being sent, and data goes in `server/data/`.

To try the production build on one port:

```bash
npm run build && npm run build:server
KERF_ORIGIN=http://localhost:8787 npm start      # http://localhost:8787
```

`npm run build:server` bundles the server into `server/dist/`, so a deployment needs only Node.js, `server/dist/` and the app's `dist/`, without `node_modules`.

## Configuration

Everything is set with environment variables. With `NODE_ENV=production`, the server refuses to start with unsafe settings, such as an `http` origin or a missing secret key.

| Variable | Default | What it does |
| --- | --- | --- |
| `KERF_ORIGIN` | `http://localhost:5173` in development, required in production | The public address, such as `https://kerf.example.com`. It must be `https` in production. Requests from any other origin are refused, and links in emails point here. |
| `KERF_SECRET_KEY` | A key kept in the data folder in development, required in production | 32 random bytes, base64-encoded, which encrypt the Claude keys people save. Generate one with `npm run -s server:secret`. **If you lose it, saved Claude keys can't be read, and people have to add them again. Nothing else is affected.** |
| `KERF_SIGNUP` | `open` in development, `allowlist` in production | `open` lets anyone sign up. `allowlist` lets only `KERF_ALLOWED_EMAILS` sign up. `closed` allows no sign-ups; create accounts with the admin commands instead. |
| `KERF_ALLOWED_EMAILS` | none | Comma-separated: `dan@example.com, *@team.example`. In production, an empty list with `allowlist` means nobody can sign up. |
| `SMTP_URL` | none | For example `smtps://user:pass@smtp.example.com:465`. Without it, production sends no email, so confirmation and "forgot password" are unavailable; reset passwords with the admin commands instead. |
| `MAIL_FROM` | `Kerf <no-reply@your-host>` | The sender of account emails. |
| `KERF_TRUST_PROXY` | `none` | Where to find the visitor's IP, used for rate limits and the device list: `fly` (Fly-Client-IP), `cloudflare` (CF-Connecting-IP), `x-forwarded-for` (the last entry, for one reverse proxy such as Caddy or nginx), or `none` (the connection itself). Set it only when a proxy you control is in front; otherwise visitors could fake their IP. |
| `KERF_DATA_DIR` | `server/data`, or `/data` in production | Where `kerf.db` is kept. |
| `KERF_STATIC_DIR` | `dist` | The built app. Set it empty to serve the API only. |
| `PORT`, `HOST` | `8787` and `127.0.0.1`, or `8080` and `0.0.0.0` in production | Where the server listens. |
| `KERF_SHARED_ANTHROPIC_KEY` | none | Optional. A Claude key you pay for, which listed accounts may use when they haven't added their own. It is off unless this variable and the next are both set. |
| `KERF_SHARED_CLAUDE_EMAILS` | none | Who may use the shared key, in the same format as `KERF_ALLOWED_EMAILS`. |
| `KERF_SHARED_DAILY_TOKENS` | `1000000` | Each account's daily allowance on the shared key. Input, output and cache writes count in full, and cache reads count a tenth. On the shared key, requests are also capped at 64k output tokens, and server-side tools (web search, code execution) are refused. |

## Deploy to Fly.io

The repository has a `Dockerfile` and a `fly.toml`. Hosting costs money, so check Fly's pricing first. The settings here use one small machine that stops when idle, plus a 1 GB volume.

1. Install `flyctl` and sign in: `fly auth login`.
2. Create the app, and put its name in `fly.toml` (`app = ...`), along with the region nearest you (`primary_region`):
   ```bash
   fly apps create your-kerf
   ```
3. Create the volume in the same region:
   ```bash
   fly volumes create kerf_data --size 1 --region lhr
   ```
4. Set the secrets. Keep a copy of the secret key in your password manager.
   ```bash
   fly secrets set KERF_ORIGIN=https://your-kerf.fly.dev \
     KERF_SECRET_KEY="$(npm run -s server:secret)" \
     KERF_ALLOWED_EMAILS=you@example.com
   # optional: email for confirmations and password resets
   fly secrets set SMTP_URL='smtps://user:pass@smtp.example.com:465' MAIL_FROM='Kerf <kerf@example.com>'
   ```
5. Deploy as a single machine. SQLite lives on one volume, so the app must not be scaled past one machine:
   ```bash
   fly deploy --ha=false
   ```
6. Open `https://your-kerf.fly.dev`, sign up with the allowed email, and check Settings → Account.

Later:

- `fly deploy --ha=false` ships a new version. Database changes apply on start.
- `fly ssh console -C "kerf-admin list"` lists accounts. Every admin command below works the same way.
- `fly logs` shows the log. The server logs errors and its own start-up, never request bodies, keys or passwords.

For a custom domain, run `fly certs add kerf.example.com`, point the DNS where it says, then set `KERF_ORIGIN` to the new address.

## Deploy anywhere else with Docker

```bash
docker build -t kerf .
docker run -d --name kerf --restart unless-stopped -p 127.0.0.1:8080:8080 -v kerf-data:/data \
  -e KERF_ORIGIN=https://kerf.example.com -e KERF_SECRET_KEY=... \
  -e KERF_ALLOWED_EMAILS=you@example.com -e KERF_TRUST_PROXY=x-forwarded-for kerf
```

Put an HTTPS reverse proxy in front. With Caddy, the whole configuration is:

```
kerf.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

The container runs as an unprivileged user, and it reports its health from `/api/health`. Render, Railway and similar hosts work the same way: deploy the Dockerfile, attach a persistent disk at `/data`, set the variables above, and run one instance.

## Before you invite anyone

- [ ] `KERF_SECRET_KEY` is stored somewhere safe.
- [ ] Sign-ups are limited (`allowlist` or `closed`), unless you mean to open them.
- [ ] `SMTP_URL` is set, so people can confirm their address and reset a forgotten password.
- [ ] Backups are running (below).
- [ ] The Terms, Privacy notice and Acceptable use policy have had legal review. They are drafts, and the app says so on every page.

## Admin commands

Locally, run `npm run server:admin -- <command>`. In the container, run `kerf-admin <command>`.

```
list                           list accounts
create-user <email> [name]     create an account and print a one-time password
reset-password <email>         set a new one-time password and sign out every device
disable <email>                block sign-in and sign out every device
enable <email>                 allow sign-in again
delete-user <email>            delete an account and everything in it
backup <file>                  write a consistent copy of the database to <file>
secret                         print a new KERF_SECRET_KEY
```

## Backups

Everything is in one file, `kerf.db`, on the data volume. `kerf-admin backup /data/backup-YYYY-MM-DD.db` writes a consistent copy while the server runs. Fly also takes daily snapshots of volumes (`fly volumes list`, then `fly volumes snapshots list <volume id>`). A backup holds Claude keys only in encrypted form, so restoring one needs the same `KERF_SECRET_KEY`.

## Security

- **Passwords.** Passwords are hashed with scrypt (N=2^15, r=8, p=3). They must be at least 12 characters, not a common password, and not the email's name.
- **Sign-in limits.** Attempts are rate-limited per IP and per account. Failed sign-ins get the same message whether or not the account exists, and so does the "forgot password" form.
- **Sessions.** Each session is a random token in a `__Host-` cookie that is HttpOnly, Secure and SameSite=Strict. Only a hash of the token is stored. A session ends after 30 days unused, or 90 days at most. Changing or resetting the password signs out the other devices.
- **Cross-site requests.** Every request that changes something must come from `KERF_ORIGIN` and carry an `x-kerf` header, so other sites can't act for a signed-in user.
- **Claude keys.** Saved keys are encrypted with AES-256-GCM, bound to the account, and checked with Anthropic before they are saved. Only the last 4 characters are ever shown back. The proxy forwards only the four Claude endpoints Kerf uses. It drops every browser header, and it replaces the user ID with a pseudonym. It limits each account to 60 requests a minute and 4 at a time, and records token counts but never message content.
- **Projects.** Projects are checked and size-limited: 300k characters of source, 300 versions per project, and 500 MB per account. Writes use revision numbers, so a stale device can never overwrite newer work; its edits are merged instead.
- **Headers.** Every API response is `no-store`, with a `default-src 'none'` CSP. The app gets the same headers as `public/_headers`, plus HSTS.
- **Housekeeping.** Once a day, the server removes expired sessions and email links, deleted-project markers older than 90 days, and usage counts older than about 13 months.

The rate limits are kept in memory. That is right for one instance; a deployment with several instances would need a shared store.

## Code

```
src/index.ts        entry: Node version check, then main.ts
src/main.ts         config, database, HTTP server, shutdown
src/app.ts          routes, error handling, static files and headers
src/config.ts       environment variables
src/db.ts           SQLite schema and migrations
src/auth.ts         sign-up, sign-in, sessions, email links
src/account.ts      profile, password, devices, activity, usage, delete
src/projects.ts     project sync API
src/claude.ts       Claude key storage and the proxy
src/housekeeping.ts daily clean-up
src/security.ts     origin check, rate limiter, headers
src/crypto.ts       password hashing, tokens, key encryption
src/mail.ts         email
src/admin-cli.ts    admin commands
tests/              Vitest tests (npm test runs them with the app's tests)
```
