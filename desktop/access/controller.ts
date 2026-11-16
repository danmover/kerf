// Who is using Kerf on this computer, decided before Kerf's window opens:
// sign-in with the server (which locks each account to its first computer),
// starting offline on a ticket that hasn't run out, staying signed in, and the
// owner's account tools. No Electron here, so tests can drive it directly;
// desktop/access/gate.ts puts it on screen.

import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { AccessClient, type Reply } from "./client.js";
import { formatCode } from "./computer.js";
import { checkLocal, localVerifier, makePassword, passwordProblem, passwordProof } from "./password.js";
import { AccessStore, type LocalAccount } from "./store.js";
import { ticketFor, type Ticket } from "./ticket.js";

export const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export interface SignedIn {
  account: LocalAccount;
  ticket: Ticket;
  /** the server couldn't be reached, so Kerf started on the saved ticket */
  offline: boolean;
}

export type Result = { ok: true; session: SignedIn } | { ok: false; message: string; field?: "user" | "password" };

/** A person's account as the owner sees it in Settings → Account. */
export interface OwnerUser {
  user: string;
  role: string;
  computers: { c: string; at: number; seen: number; app?: string }[];
  maxComputers: number;
  blocked: boolean;
  created: number;
  lastSignIn: number | null;
  note: string;
}

export type OwnerOp =
  | { op: "list" }
  | { op: "create"; user: string; password?: string; maxComputers?: number; note?: string }
  | { op: "password"; user: string; password?: string }
  | { op: "reset"; user: string }
  | { op: "block"; user: string; blocked: boolean }
  | { op: "limit"; user: string; maxComputers: number }
  | { op: "delete"; user: string };

export type OwnerResult = { ok: true; users?: OwnerUser[]; user?: OwnerUser; password?: string } | { ok: false; message: string };

/** Signed out on purpose, for "Restart Kerf" style relaunches: the next start skips the sign-in once. */
const RESUME_MS = 90_000;

export class AccessController {
  session: SignedIn | null = null;
  /** shown on the sign-in screen next time it opens, e.g. why the person was signed out */
  notice = "";

  constructor(
    readonly store: AccessStore,
    readonly client: AccessClient,
    readonly computer: string,
    private spki: string,
    private appTag: string,
    private clock: () => number = Date.now,
  ) {}

  private now() {
    return this.store.now(this.clock());
  }

  private valid(a: LocalAccount | null) {
    return a ? ticketFor(a.ticket, this.spki, a.user, this.computer, this.now()) : null;
  }

  /** What the sign-in screen shows. */
  async screen() {
    const accounts = this.store.data.accounts.filter((a) => a.ticket || a.salt);
    const last = [...accounts].sort((a, b) => b.lastSignIn - a.lastSignIn)[0]?.user ?? "";
    let ownerSetup = false;
    if (this.client.isOwnerComputer) {
      const r = await this.client.owner<{ users: OwnerUser[] }>("GET", "/v1/owner/users");
      ownerSetup = r.ok && !r.users.some((u) => u.role === "owner");
    }
    const notice = this.notice;
    this.notice = "";
    return { computer: formatCode(this.computer), accounts: accounts.map((a) => a.user), last, stay: !!this.store.data.stay, ownerSetup, server: !!this.client.server, notice };
  }

  /** Sign in with the server, or, when it can't be reached, with the ticket and password kept here. */
  async signIn(userIn: string, password: string, stay: boolean): Promise<Result> {
    const user = userIn.trim().toLowerCase();
    if (!USERNAME.test(user)) return { ok: false, message: "That isn't a Kerf username.", field: "user" };
    if (!password) return { ok: false, message: "Type your password.", field: "password" };
    const proof = await passwordProof(user, password);
    const r = await this.client.signIn(user, proof, this.computer, this.appTag);
    if (r.ok) {
      const ticket = ticketFor(r.ticket, this.spki, user, this.computer, this.now());
      if (!ticket) return { ok: false, message: "The sign-in server's answer wasn't signed by this Kerf's owner, so Kerf can't trust it." };
      const account = this.store.put({ user, role: ticket.r, ticket: r.ticket, ...localVerifier(proof), lastSignIn: this.now() }, this.now());
      this.store.data.stay = stay ? user : this.store.data.stay === user ? null : this.store.data.stay;
      this.store.save();
      return { ok: true, session: (this.session = { account, ticket, offline: false }) };
    }
    if (!r.offline) {
      // the server knows this account and says no: don't let a saved ticket carry on without it
      if (["blocked", "locked", "gone", "moved"].includes(r.error)) {
        this.store.dropTicket(user);
        this.store.save();
      }
      return { ok: false, message: r.message, field: r.error === "wrong" ? "password" : undefined };
    }
    const local = this.store.get(user);
    const ticket = this.valid(local);
    if (local && ticket && checkLocal(proof, local.salt, local.verifier)) {
      local.lastSignIn = this.now();
      this.store.data.stay = stay ? user : this.store.data.stay === user ? null : this.store.data.stay;
      this.store.save();
      return { ok: true, session: (this.session = { account: local, ticket, offline: true }) };
    }
    if (local && ticket) {
      await new Promise((res) => setTimeout(res, 800));
      return { ok: false, message: "Wrong username or password.", field: "password" };
    }
    return { ok: false, message: local ? `${r.message} Kerf can start offline only for 14 days after a sign-in.` : r.message };
  }

  /** The owner's first sign-in on the owner's PC: makes the owner account on the server, then signs in. */
  async setUpOwner(userIn: string, password: string, stay: boolean): Promise<Result> {
    const user = userIn.trim().toLowerCase();
    if (!USERNAME.test(user)) return { ok: false, message: "Usernames are 2 to 32 lowercase letters, digits, dots, dashes or underscores.", field: "user" };
    const bad = passwordProblem(password);
    if (bad) return { ok: false, message: bad, field: "password" };
    const r = await this.client.owner("PUT", `/v1/owner/users/${user}`, { proof: await passwordProof(user, password), role: "owner", maxComputers: 1 });
    if (!r.ok) return { ok: false, message: r.message };
    return this.signIn(user, password, stay);
  }

  /** At launch: carry on as whoever stays signed in here (or just restarted Kerf), checking with the server when it can. */
  async resume(): Promise<SignedIn | null> {
    const resumed = this.takeResume();
    const user = resumed ?? this.store.data.stay;
    if (!user) return null;
    const local = this.store.get(user);
    if (!this.valid(local)) return null;
    return this.check(local!);
  }

  /** Swap the ticket for a fresh one. null when the server says this account may no longer be used here. */
  async check(local: LocalAccount): Promise<SignedIn | null> {
    const r = await this.client.refresh(local.ticket, this.appTag);
    if (r.ok) {
      const ticket = ticketFor(r.ticket, this.spki, local.user, this.computer, this.now());
      if (ticket) {
        local.ticket = r.ticket;
        local.role = ticket.r;
        local.lastSignIn = this.now();
        this.store.save();
        return (this.session = { account: local, ticket, offline: false });
      }
    } else if (!r.offline) {
      this.store.dropTicket(local.user);
      this.store.save();
      this.notice = r.message;
      if (this.session?.account.user === local.user) this.session = null;
      return null;
    }
    const ticket = this.valid(local);
    return ticket ? (this.session = { account: local, ticket, offline: true }) : null;
  }

  signOut() {
    if (this.session && this.store.data.stay === this.session.account.user) this.store.data.stay = null;
    this.store.save();
    this.session = null;
  }

  /** Before Kerf restarts itself (a graphics switch): the next launch carries on as the same account, once. */
  markResume() {
    if (!this.session) return;
    mkdirSync(this.store.dir, { recursive: true });
    writeFileSync(join(this.store.dir, "resume.json"), JSON.stringify({ user: this.session.account.user, until: this.clock() + RESUME_MS, nonce: randomBytes(8).toString("hex") }));
  }

  private takeResume(): string | null {
    const file = join(this.store.dir, "resume.json");
    try {
      const v = JSON.parse(readFileSync(file, "utf8"));
      rmSync(file, { force: true });
      return typeof v?.user === "string" && Number(v.until) > this.clock() ? v.user : null;
    } catch {
      return null;
    }
  }

  get isOwner() {
    return this.client.isOwnerComputer && this.session?.ticket.r === "owner";
  }

  info() {
    const s = this.session;
    return s
      ? { user: s.account.user, role: s.ticket.r, computer: formatCode(this.computer), offline: s.offline, until: s.ticket.exp, owner: this.isOwner, stay: this.store.data.stay === s.account.user, others: this.store.data.accounts.length - 1 }
      : null;
  }

  setStay(on: boolean) {
    if (!this.session) return;
    const u = this.session.account.user;
    this.store.data.stay = on ? u : this.store.data.stay === u ? null : this.store.data.stay;
    this.store.save();
  }

  /** The owner's account tools, signed with the owner key. */
  async owner(o: OwnerOp): Promise<OwnerResult> {
    if (!this.isOwner) return { ok: false, message: "Only the owner, signed in on the owner's PC, can manage accounts." };
    const path = (u: string) => {
      const user = String(u ?? "").trim().toLowerCase();
      return USERNAME.test(user) ? { user, path: `/v1/owner/users/${user}` } : null;
    };
    const done = (r: Reply<{ users?: OwnerUser[]; user?: OwnerUser }>, password?: string): OwnerResult =>
      r.ok ? { ok: true, users: r.users, user: r.user, ...(password ? { password } : {}) } : { ok: false, message: r.message };
    if (o.op === "list") return done(await this.client.owner("GET", "/v1/owner/users"));
    const p = path(o.user);
    if (!p) return { ok: false, message: "Usernames are 2 to 32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit." };
    switch (o.op) {
      case "create":
      case "password": {
        const password = o.password || makePassword();
        const bad = passwordProblem(password);
        if (bad) return { ok: false, message: bad };
        const proof = await passwordProof(p.user, password);
        const body = o.op === "create" ? { proof, role: "user", maxComputers: o.maxComputers ?? 1, note: o.note ?? "" } : { proof };
        return done(await this.client.owner(o.op === "create" ? "PUT" : "PATCH", p.path, body), password);
      }
      case "reset":
        return done(await this.client.owner("PATCH", p.path, { resetComputers: true }));
      case "block":
        if (p.user === this.session?.account.user) return { ok: false, message: "You can't switch off your own account." };
        return done(await this.client.owner("PATCH", p.path, { blocked: !!o.blocked }));
      case "limit":
        return done(await this.client.owner("PATCH", p.path, { maxComputers: o.maxComputers }));
      case "delete":
        if (p.user === this.session?.account.user) return { ok: false, message: "You can't remove your own account." };
        return done(await this.client.owner("DELETE", p.path));
    }
    return { ok: false, message: "Unknown request." };
  }
}
