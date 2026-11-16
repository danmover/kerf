// Tickets from the sign-in server (access-server/src/api.ts): which
// account, on which computer, until when, signed with the owner key. The app
// trusts nothing about a sign-in it can't check here against the public key
// it was built with.

import { createPublicKey, verify, type KeyObject } from "node:crypto";

export interface Ticket {
  v: 1;
  /** username */
  u: string;
  /** the computer code it was signed in on */
  c: string;
  /** "owner" or "user" */
  r: string;
  iat: number;
  exp: number;
}

const PREFIX = "kerf1.";
const CONTEXT = "kerf-ticket-v1.";
const keys = new Map<string, KeyObject>();

const publicKey = (spki: string) => {
  let k = keys.get(spki);
  if (!k) keys.set(spki, (k = createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" })));
  return k;
};

/** The ticket's contents if the owner key signed it, else null. Says nothing about whether it has run out. */
export function readTicket(ticket: unknown, spki: string): Ticket | null {
  if (typeof ticket !== "string" || !ticket.startsWith(PREFIX) || ticket.length > 2000) return null;
  const [payload, sig, extra] = ticket.slice(PREFIX.length).split(".");
  if (!payload || !sig || extra !== undefined) return null;
  try {
    if (!verify(null, Buffer.from(CONTEXT + payload), publicKey(spki), Buffer.from(sig, "base64url"))) return null;
    const t = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Ticket;
    const ok = t && t.v === 1 && typeof t.u === "string" && typeof t.c === "string" && typeof t.r === "string" && Number.isFinite(t.iat) && Number.isFinite(t.exp);
    return ok ? t : null;
  } catch {
    return null;
  }
}

/** A ticket this computer may start Kerf with: signed, for this computer and account, and not run out. */
export function ticketFor(ticket: unknown, spki: string, user: string, computer: string, now: number): Ticket | null {
  const t = readTicket(ticket, spki);
  return t && t.u === user && t.c === computer && t.exp > now ? t : null;
}
