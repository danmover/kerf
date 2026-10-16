// The admin commands (see admin.ts).

import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { hashPassword, newId, randomToken } from "./crypto.js";
import { Db } from "./db.js";

const HELP = `Kerf server admin

  secret                         print a new KERF_SECRET_KEY
  list                           list accounts
  create-user <email> [name]     create an account and print a one-time password
  reset-password <email>         set a new one-time password and sign out every device
  disable <email>                block sign-in and sign out every device
  enable <email>                 allow sign-in again
  delete-user <email>            delete an account and everything in it
  backup <file>                  write a consistent copy of the database to <file>
`;

const [cmd, ...args] = process.argv.slice(2);

if (!cmd || cmd === "help" || cmd === "--help") {
  console.log(HELP);
  process.exit(0);
}
if (cmd === "secret") {
  console.log(randomBytes(32).toString("base64"));
  process.exit(0);
}

const cfg = loadConfig(process.env);
const db = new Db(join(cfg.dataDir, "kerf.db"));
const user = (email: string | undefined) => {
  if (!email) throw new Error("Give the account's email.");
  const u = db.get<{ id: string; email: string }>("SELECT id, email FROM users WHERE email = ?", email.trim().toLowerCase());
  if (!u) throw new Error(`No account for ${email}.`);
  return u;
};
const date = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "-");

try {
  switch (cmd) {
    case "list": {
      const rows = db.all<{ email: string; name: string; created_at: number; disabled: number; email_verified_at: number | null; has_key: number; projects: number; bytes: number }>(
        `SELECT u.email, u.name, u.created_at, u.disabled, u.email_verified_at, u.claude_key_enc IS NOT NULL AS has_key,
                (SELECT count(*) FROM projects p WHERE p.user_id = u.id AND p.deleted_at IS NULL) AS projects,
                (SELECT coalesce(sum(bytes), 0) FROM projects p WHERE p.user_id = u.id) AS bytes
         FROM users u ORDER BY u.created_at`,
      );
      if (!rows.length) console.log("No accounts yet.");
      for (const r of rows)
        console.log(`${r.email.padEnd(36)} ${date(r.created_at)}  ${String(r.projects).padStart(4)} projects ${(r.bytes / 1048576).toFixed(1).padStart(7)} MB  key:${r.has_key ? "yes" : "no "}  ${r.email_verified_at ? "verified" : "unverified"}${r.disabled ? "  DISABLED" : ""}`);
      break;
    }
    case "create-user": {
      const email = args[0]?.trim().toLowerCase();
      if (!email || !email.includes("@")) throw new Error("Give an email address.");
      if (db.get("SELECT 1 FROM users WHERE email = ?", email)) throw new Error(`${email} already has an account.`);
      const password = randomToken(15);
      db.run("INSERT INTO users (id, email, name, password_hash, terms_version, created_at, email_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)", newId("usr"), email, args.slice(1).join(" "), await hashPassword(password), "admin-created", Date.now(), Date.now());
      console.log(`Created ${email}. One-time password (shown once; ask them to change it in Settings → Account):\n\n  ${password}\n`);
      break;
    }
    case "reset-password": {
      const u = user(args[0]);
      const password = randomToken(15);
      const hash = await hashPassword(password);
      db.tx(() => {
        db.run("UPDATE users SET password_hash = ? WHERE id = ?", hash, u.id);
        db.run("DELETE FROM sessions WHERE user_id = ?", u.id);
      });
      console.log(`New password for ${u.email} (shown once):\n\n  ${password}\n`);
      break;
    }
    case "disable":
    case "enable": {
      const u = user(args[0]);
      db.tx(() => {
        db.run("UPDATE users SET disabled = ? WHERE id = ?", cmd === "disable" ? 1 : 0, u.id);
        if (cmd === "disable") db.run("DELETE FROM sessions WHERE user_id = ?", u.id);
      });
      console.log(`${u.email} ${cmd}d.`);
      break;
    }
    case "delete-user": {
      const u = user(args[0]);
      db.tx(() => {
        db.run("DELETE FROM chats WHERE user_id = ?", u.id);
        db.run("DELETE FROM versions WHERE user_id = ?", u.id);
        db.run("DELETE FROM users WHERE id = ?", u.id);
      });
      console.log(`Deleted ${u.email} and all of its projects.`);
      break;
    }
    case "backup": {
      if (!args[0]) throw new Error("Give a file to write the backup to.");
      const file = resolve(args[0]);
      db.raw.prepare("VACUUM INTO ?").run(file);
      console.log(`Database copied to ${file}`);
      break;
    }
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  db.close();
}
