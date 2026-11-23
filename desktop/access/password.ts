// Passwords never leave the computer. The sign-in server gets a scrypt proof
// (salted with the username, so the same password gives different proofs for
// different accounts), and for starting offline this computer keeps a salted
// hash of that proof.

import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export const MIN_PASSWORD = 8;

/** What the server checks: 32 bytes of scrypt(password, "kerf-access-v1:" + user), base64url. */
export function passwordProof(user: string, password: string): Promise<string> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFC"), "kerf-access-v1:" + user, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key.toString("base64url")))),
  );
}

export function localVerifier(proof: string, salt = randomBytes(16).toString("base64url")) {
  return { salt, verifier: createHash("sha256").update(Buffer.from(salt, "base64url")).update(Buffer.from(proof, "base64url")).digest("base64url") };
}

export function checkLocal(proof: string, salt: string, verifier: string): boolean {
  const a = Buffer.from(localVerifier(proof, salt).verifier, "base64url");
  const b = Buffer.from(verifier, "base64url");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Why a new password won't do, or "". */
export function passwordProblem(password: string): string {
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (password.length > 200) return "That password is too long.";
  return "";
}

/** A password for a new account that's easy to read out: four groups of four. */
export function makePassword(): string {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(16);
  let s = "";
  for (let i = 0; i < 16; i++) s += chars[bytes[i] % chars.length] + (i % 4 === 3 && i < 15 ? "-" : "");
  return s;
}
