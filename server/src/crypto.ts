// Passwords, tokens and the encryption of stored Claude API keys.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));

// scrypt with N=2^15, r=8, p=3: one of OWASP's recommended settings (32 MiB per hash).
const PARAMS = { N: 2 ** 15, r: 8, p: 3 };
const MAXMEM = 96 * 1024 * 1024;

// a few logins at once is fine; a flood queues instead of exhausting memory
let running = 0;
const waiting: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 4) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await limited(() => scrypt(password.normalize("NFKC"), salt, 32, { ...PARAMS, maxmem: MAXMEM }));
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const key = await limited(() => scrypt(password.normalize("NFKC"), Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM }));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A hash to verify against when the account does not exist, so both paths take the same time. */
let dummy: Promise<string> | null = null;
export const dummyHash = () => (dummy ??= hashPassword(randomBytes(12).toString("base64")));

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const sha256 = (s: string) => createHash("sha256").update(s).digest("base64url");
export const newId = (prefix: string) => `${prefix}_${randomBytes(12).toString("base64url")}`;

/** A stable pseudonymous id for a user, sent to Anthropic as metadata.user_id for abuse tracking. */
export const pseudonym = (secret: Buffer, userId: string) => createHmac("sha256", secret).update(`anthropic-user:${userId}`).digest("hex").slice(0, 32);

// ---------- stored secrets ----------
// AES-256-GCM, with the user's id as associated data so a ciphertext copied to
// another account does not decrypt. Format: v1.<iv>.<ciphertext+tag>, base64url.

export function seal(secretKey: Buffer, plaintext: string, userId: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", secretKey, iv);
  c.setAAD(Buffer.from(userId));
  const body = Buffer.concat([c.update(plaintext, "utf8"), c.final(), c.getAuthTag()]);
  return `v1.${iv.toString("base64url")}.${body.toString("base64url")}`;
}

export function unseal(secretKey: Buffer, sealed: string, userId: string): string | null {
  try {
    const [v, ivB, bodyB] = sealed.split(".");
    if (v !== "v1" || !ivB || !bodyB) return null;
    const body = Buffer.from(bodyB, "base64url");
    const d = createDecipheriv("aes-256-gcm", secretKey, Buffer.from(ivB, "base64url"));
    d.setAAD(Buffer.from(userId));
    d.setAuthTag(body.subarray(body.length - 16));
    return Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// ---------- password rules ----------
// NIST 800-63B style: long enough, not a known-bad password, no composition rules.

const COMMON = new Set(
  "password password1 password123 passw0rd 123456789012 1234567890123 qwertyuiopas qwerty123456 letmein12345 iloveyou1234 welcome12345 admin1234567 changeme1234 kerfkerfkerf 111111111111 000000000000 abcdefghijkl abc123abc123 football1234 baseball1234 monkey123456 dragon123456 sunshine1234 trustno1trust".split(" "),
);

export function passwordProblem(password: string, email: string): string | null {
  if (password.length < 12) return "Use at least 12 characters. A few unrelated words make a strong password that is easy to remember.";
  if (password.length > 256) return "That password is too long. Use 256 characters or fewer.";
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(password)) return "That password is too common. Pick something less predictable.";
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  if (local.length >= 4 && lower.includes(local)) return "Don't include your email address in the password.";
  return null;
}
