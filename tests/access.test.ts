// The desktop sign-in (desktop/access/) against the sign-in server
// (access-server/src/api.ts), run together in-process: accounts lock to
// their first computer, the owner can move, block and remove them, and
// Kerf starts offline only on a ticket that hasn't run out.

import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { devEnv } from "../access-server/src/dev";
import { handle } from "../access-server/src/api";
import { AccessClient, type Fetch } from "../desktop/access/client";
import { codeFor, formatCode, normalizeCode } from "../desktop/access/computer";
import { AccessController } from "../desktop/access/controller";
import { passwordProof } from "../desktop/access/password";
import { AccessStore } from "../desktop/access/store";
import { readTicket } from "../desktop/access/ticket";

const SERVER = "https://access.test";

function world() {
  const env = devEnv();
  let clock = Date.parse("2026-11-16T05:00:00Z");
  let online = true;
  const fetchFn: Fetch = async (url, init) => {
    if (!online) throw new TypeError("fetch failed");
    return handle(new Request(url, init), env, clock);
  };
  const ownerKey = createPrivateKey(env.pem);
  /** a computer running Kerf: its own folder, code and (for the owner) key */
  const computer = (name: string, owner = false) => {
    const store = new AccessStore(mkdtempSync(join(tmpdir(), `kerf-access-${name}-`)));
    const client = new AccessClient(SERVER, fetchFn, owner ? ownerKey : null);
    return new AccessController(store, client, codeFor(name), env.OWNER_PUBLIC_KEY, "Kerf test", () => clock);
  };
  return {
    env,
    computer,
    fetchFn,
    setOnline: (v: boolean) => (online = v),
    advance: (ms: number) => (clock += ms),
    now: () => clock,
  };
}

/** the owner's PC with the owner signed in */
async function ownerPc(w: ReturnType<typeof world>) {
  const pc = w.computer("owner-pc", true);
  expect((await pc.screen()).ownerSetup).toBe(true);
  const r = await pc.setUpOwner("dan", "owner-password-1", true);
  expect(r.ok).toBe(true);
  return pc;
}

describe("computer codes", () => {
  it("are 16 characters from the machine ID, read back however they're typed", () => {
    const c = codeFor("4c4c4544-0042-3510-8051-b4c04f4e3132");
    expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
    expect(codeFor("4C4C4544-0042-3510-8051-B4C04F4E3132 ")).toBe(c);
    expect(codeFor("another machine")).not.toBe(c);
    expect(normalizeCode(formatCode(c).toLowerCase())).toBe(c);
    expect(normalizeCode("OOOO-IIII-LLLL-0000")).toBe("0000111111110000");
    expect(normalizeCode("too-short")).toBeNull();
  });
});

describe("sign-in", () => {
  it("sets up the owner on the PC with the owner key, and only there", async () => {
    const w = world();
    expect((await w.computer("friend").screen()).ownerSetup).toBe(false);
    const pc = await ownerPc(w);
    expect(pc.isOwner).toBe(true);
    expect(pc.info()?.owner).toBe(true);
    // once there is an owner, the owner PC shows the normal sign-in
    expect((await w.computer("owner-pc", true).screen()).ownerSetup).toBe(false);
  });

  it("locks an account to the first computer it signs in on, until the owner moves it", async () => {
    const w = world();
    const owner = await ownerPc(w);
    const made = await owner.owner({ op: "create", user: "Alice" });
    expect(made.ok).toBe(true);
    const password = made.ok ? made.password! : "";
    expect(password).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);

    const a = w.computer("alice-laptop");
    const first = await a.signIn("alice", password, false);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.session.offline).toBe(false);
      expect(first.session.ticket.c).toBe(codeFor("alice-laptop"));
      expect(first.session.account.partition).toBe("");
    }

    const b = w.computer("someone-else");
    const second = await b.signIn("alice", password, false);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.message).toMatch(/another computer/);

    // the owner sees where it is, and moves it
    const list = await owner.owner({ op: "list" });
    const alice = list.ok ? list.users!.find((u) => u.user === "alice") : undefined;
    expect(alice?.computers.map((c) => c.c)).toEqual([codeFor("alice-laptop")]);
    expect((await owner.owner({ op: "reset", user: "alice" })).ok).toBe(true);

    // the old computer's ticket stops working, and the next sign-in takes the place
    expect(await a.check(a.store.get("alice")!)).toBeNull();
    expect(a.notice).toMatch(/moved off this computer/);
    expect((await b.signIn("alice", password, false)).ok).toBe(true);
    expect((await a.signIn("alice", password, false)).ok).toBe(false);
  });

  it("lets the owner allow a second computer", async () => {
    const w = world();
    const owner = await ownerPc(w);
    await owner.owner({ op: "create", user: "bob", password: "bobs-password" });
    expect((await w.computer("bob-pc").signIn("bob", "bobs-password", false)).ok).toBe(true);
    expect((await w.computer("bob-mac").signIn("bob", "bobs-password", false)).ok).toBe(false);
    expect((await owner.owner({ op: "limit", user: "bob", maxComputers: 2 })).ok).toBe(true);
    expect((await w.computer("bob-mac").signIn("bob", "bobs-password", false)).ok).toBe(true);
  });

  it("turns away wrong passwords, then makes the account wait", async () => {
    const w = world();
    const owner = await ownerPc(w);
    await owner.owner({ op: "create", user: "carol", password: "carols-password" });
    const pc = w.computer("carol-pc");
    for (let i = 0; i < 5; i++) {
      const r = await pc.signIn("carol", "nope-nope-nope", false);
      expect(r.ok ? "" : r.message).toBe("Wrong username or password.");
    }
    const r = await pc.signIn("carol", "carols-password", false);
    expect(r.ok ? "" : r.message).toMatch(/Too many wrong passwords/);
    w.advance(16 * 60_000);
    expect((await pc.signIn("carol", "carols-password", false)).ok).toBe(true);
    // no such account reads the same as a wrong password
    const none = await pc.signIn("nobody", "whatever-123", false);
    expect(none.ok ? "" : none.message).toBe("Wrong username or password.");
  });

  it("switches an account off and on, and the owner can't lock themself out", async () => {
    const w = world();
    const owner = await ownerPc(w);
    await owner.owner({ op: "create", user: "dave", password: "daves-password" });
    const pc = w.computer("dave-pc");
    expect((await pc.signIn("dave", "daves-password", true)).ok).toBe(true);
    expect((await owner.owner({ op: "block", user: "dave", blocked: true })).ok).toBe(true);
    // a running Kerf finds out at its next check, and the saved ticket is dropped
    expect(await pc.check(pc.store.get("dave")!)).toBeNull();
    expect(pc.store.get("dave")!.ticket).toBe("");
    w.setOnline(false);
    expect((await pc.signIn("dave", "daves-password", false)).ok).toBe(false);
    w.setOnline(true);
    const blocked = await pc.signIn("dave", "daves-password", false);
    expect(blocked.ok ? "" : blocked.message).toMatch(/switched off/);
    await owner.owner({ op: "block", user: "dave", blocked: false });
    expect((await pc.signIn("dave", "daves-password", false)).ok).toBe(true);

    expect((await owner.owner({ op: "block", user: "dan", blocked: true })).ok).toBe(false);
    expect((await owner.owner({ op: "delete", user: "dan" })).ok).toBe(false);
    expect((await owner.owner({ op: "delete", user: "dave" })).ok).toBe(true);
    expect(await pc.check(pc.store.get("dave")!)).toBeNull();
  });

  it("starts offline on a saved ticket with the right password, until the ticket runs out", async () => {
    const w = world();
    const owner = await ownerPc(w);
    await owner.owner({ op: "create", user: "erin", password: "erins-password" });
    const pc = w.computer("erin-pc");
    expect((await pc.signIn("erin", "erins-password", false)).ok).toBe(true);
    w.setOnline(false);
    const off = await pc.signIn("erin", "erins-password", false);
    expect(off.ok && off.session.offline).toBe(true);
    const wrong = await pc.signIn("erin", "not-erins-password", false);
    expect(wrong.ok).toBe(false);
    w.advance(15 * 86_400_000);
    const late = await pc.signIn("erin", "erins-password", false);
    expect(late.ok ? "" : late.message).toMatch(/couldn't be reached/);
    // an account that never signed in here can't start offline
    const stranger = await w.computer("erin-pc").signIn("frank", "franks-password", false);
    expect(stranger.ok).toBe(false);
  });

  it("stays signed in, and carries on once after Kerf restarts itself", async () => {
    const w = world();
    const owner = await ownerPc(w);
    await owner.owner({ op: "create", user: "gina", password: "ginas-password" });
    const pc = w.computer("gina-pc");
    expect((await pc.signIn("gina", "ginas-password", false)).ok).toBe(true);
    expect(await pc.resume()).toBeNull();
    pc.markResume();
    expect((await pc.resume())?.account.user).toBe("gina");
    expect(await pc.resume()).toBeNull();
    pc.setStay(true);
    expect((await pc.resume())?.offline).toBe(false);
    pc.signOut();
    expect(await pc.resume()).toBeNull();
  });

  it("keeps each account's projects in its own storage; the first one keeps what was there", async () => {
    const w = world();
    const owner = await ownerPc(w);
    expect(owner.session?.account.partition).toBe("");
    await owner.owner({ op: "create", user: "kid", password: "kids-password" });
    // someone else signing in on the owner's PC
    const r = await owner.signIn("kid", "kids-password", false);
    expect(r.ok && r.session.account.partition).toBe("persist:kerf-user-kid");
  });

  it("only trusts tickets and owner requests signed with the owner key", async () => {
    const w = world();
    const owner = await ownerPc(w);
    const t = owner.session!.account.ticket;
    expect(readTicket(t, w.env.OWNER_PUBLIC_KEY)?.u).toBe("dan");
    // a changed payload
    const [, payload, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), u: "mallory" })).toString("base64url");
    expect(readTicket(`kerf1.${forged}.${sig}`, w.env.OWNER_PUBLIC_KEY)).toBeNull();
    // another key
    const other = devEnv();
    expect(readTicket(t, other.OWNER_PUBLIC_KEY)).toBeNull();
    // a stand-in server with its own key can't let anyone in
    const fake = new AccessController(
      new AccessStore(mkdtempSync(join(tmpdir(), "kerf-access-fake-"))),
      new AccessClient(SERVER, async (url, init) => handle(new Request(url, init), other, w.now()), createPrivateKey(other.pem)),
      codeFor("pc"),
      w.env.OWNER_PUBLIC_KEY,
      "Kerf test",
      () => w.now(),
    );
    await other.DB.prepare("INSERT INTO users (name, role, verifier, salt, computers, max_computers, blocked, fails, fail_at, created) VALUES ('x', 'user', 'v', 's', '[]', 1, 0, 0, 0, 0)").run();
    const r = await fake.signIn("x", "anything-at-all", false);
    expect(r.ok).toBe(false);

    // owner requests from a key that isn't the owner's
    const intruder = new AccessClient(SERVER, w.fetchFn, generateKeyPairSync("ed25519").privateKey);
    const list = await intruder.owner("GET", "/v1/owner/users");
    expect(list.ok ? 0 : (list as { status: number }).status).toBe(401);
    // and a signed request can't be replayed later
    const client = new AccessClient(SERVER, async (url, init) => {
      w.advance(10 * 60_000);
      return handle(new Request(url, init), w.env, w.now());
    }, createPrivateKey(w.env.pem));
    expect((await client.owner("GET", "/v1/owner/users")).ok).toBe(false);
  });

  it("never sends the password itself", async () => {
    const w = world();
    const owner = await ownerPc(w);
    const bodies: string[] = [];
    const spy = new AccessController(
      new AccessStore(mkdtempSync(join(tmpdir(), "kerf-access-spy-"))),
      new AccessClient(SERVER, async (url, init) => {
        bodies.push(init.body ?? "");
        return w.fetchFn(url, init);
      }),
      codeFor("spy"),
      w.env.OWNER_PUBLIC_KEY,
      "Kerf test",
      () => w.now(),
    );
    await owner.owner({ op: "create", user: "hana", password: "hanas-secret-pw" });
    await spy.signIn("hana", "hanas-secret-pw", false);
    expect(bodies.join("\n")).not.toContain("hanas-secret-pw");
    expect(bodies.join("\n")).toContain(await passwordProof("hana", "hanas-secret-pw"));
  });
});
