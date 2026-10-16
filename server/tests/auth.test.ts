import { describe, expect, it } from "vitest";
import { client, ORIGIN, PASSWORD, setup, signedIn, TERMS } from "./helpers.js";

describe("accounts", () => {
  it("signs up, reports the session, and signs out", async () => {
    const { app } = setup();
    const c = client(app);
    let s = await c.json<{ user: unknown; server: { signup: string } }>(await c.get("/api/session"));
    expect(s.user).toBeNull();
    expect(s.server.signup).toBe("open");

    const res = await c.post("/api/auth/signup", { email: "Dan@Example.com ", password: PASSWORD, name: "Dan", termsVersion: TERMS });
    expect(res.status).toBe(201);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^__Host-kerf_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);

    s = await c.json(await c.get("/api/session"));
    expect(s.user).toMatchObject({ email: "dan@example.com", name: "Dan", emailVerified: false });

    expect((await c.post("/api/auth/logout")).status).toBe(200);
    s = await c.json(await c.get("/api/session"));
    expect(s.user).toBeNull();
  });

  it("stores only a hash of the session token and of the password", async () => {
    const { app, deps } = setup();
    const c = await signedIn(app);
    const token = c.cookie.split("=")[1];
    const row = deps.db.get<{ id_hash: string }>("SELECT id_hash FROM sessions");
    expect(row!.id_hash).not.toBe(token);
    const u = deps.db.get<{ password_hash: string }>("SELECT password_hash FROM users");
    expect(u!.password_hash).toMatch(/^scrypt\$32768\$8\$3\$/);
    expect(u!.password_hash).not.toContain(PASSWORD);
  });

  it("signs in with the right password only, with one message for both failures", async () => {
    const { app } = setup();
    await signedIn(app);
    const c = client(app);
    const wrong = await c.post("/api/auth/login", { email: "dan@example.com", password: "not the password at all" });
    const nobody = await c.post("/api/auth/login", { email: "nobody@example.com", password: "not the password at all" });
    expect(wrong.status).toBe(401);
    expect(nobody.status).toBe(401);
    expect((await c.json(wrong)).message).toBe((await c.json(nobody)).message);
    const ok = await c.post("/api/auth/login", { email: "DAN@example.com", password: PASSWORD });
    expect(ok.status).toBe(200);
    expect((await c.json<{ user: { email: string } }>(await c.get("/api/session"))).user.email).toBe("dan@example.com");
  });

  it("limits repeated sign-in attempts", async () => {
    const { app } = setup();
    await signedIn(app);
    const c = client(app);
    let last: Response | null = null;
    for (let i = 0; i < 9; i++) last = await c.post("/api/auth/login", { email: "dan@example.com", password: "wrong password " + i });
    expect(last!.status).toBe(429);
    expect(last!.headers.get("retry-after")).toBeTruthy();
  });

  it("refuses weak passwords and duplicate emails", async () => {
    const { app } = setup();
    const c = client(app);
    expect((await c.post("/api/auth/signup", { email: "a@example.com", password: "short", termsVersion: TERMS })).status).toBe(422);
    expect((await c.post("/api/auth/signup", { email: "abcdef@example.com", password: "abcdef-is-my-password", termsVersion: TERMS })).status).toBe(422);
    expect((await c.post("/api/auth/signup", { email: "a@example.com", password: "password123", termsVersion: TERMS })).status).toBe(422);
    expect((await c.post("/api/auth/signup", { email: "not-an-email", password: PASSWORD, termsVersion: TERMS })).status).toBe(400);
    await signedIn(app, "taken@example.com");
    expect((await client(app).post("/api/auth/signup", { email: "taken@example.com", password: PASSWORD, termsVersion: TERMS })).status).toBe(409);
  });

  it("only lets listed emails sign up when an allowlist is set", async () => {
    const { app } = setup({ KERF_SIGNUP: "", KERF_ALLOWED_EMAILS: "dan@example.com, *@team.example" });
    const c = client(app);
    expect((await c.json<{ server: { signup: string } }>(await c.get("/api/session"))).server.signup).toBe("allowlist");
    expect((await c.post("/api/auth/signup", { email: "eve@example.com", password: PASSWORD, termsVersion: TERMS })).status).toBe(403);
    expect((await c.post("/api/auth/signup", { email: "ann@team.example", password: PASSWORD, termsVersion: TERMS })).status).toBe(201);
    expect((await client(app).post("/api/auth/signup", { email: "dan@example.com", password: PASSWORD, termsVersion: TERMS })).status).toBe(201);
  });

  it("takes no sign-ups when closed", async () => {
    const { app } = setup({ KERF_SIGNUP: "closed" });
    expect((await client(app).post("/api/auth/signup", { email: "dan@example.com", password: PASSWORD, termsVersion: TERMS })).status).toBe(403);
  });

  it("refuses state changes from other sites", async () => {
    const { app } = setup();
    const c = await signedIn(app);
    const evil = await c.post("/api/account/sessions/revoke", { others: true }, { origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    const noHeader = await app.request(`${ORIGIN}/api/auth/logout`, { method: "POST", headers: { origin: ORIGIN, cookie: c.cookie } });
    expect(noHeader.status).toBe(403);
  });

  it("confirms an email address with the emailed link", async () => {
    const { app, mailer } = setup();
    const c = await signedIn(app);
    expect(mailer.sent).toHaveLength(1);
    const token = /#verify=([A-Za-z0-9_-]+)/.exec(mailer.sent[0].text)![1];
    expect(mailer.sent[0].text).toContain(`${ORIGIN}/#verify=`);
    expect((await c.post("/api/auth/verify", { token })).status).toBe(200);
    expect((await c.json<{ user: { emailVerified: boolean } }>(await c.get("/api/session"))).user.emailVerified).toBe(true);
    expect((await c.post("/api/auth/verify", { token })).status).toBe(400);
  });

  it("resets a forgotten password once, signing out every device", async () => {
    const { app, mailer } = setup();
    const laptop = await signedIn(app);
    const stranger = client(app);
    // the same answer whether or not the account exists
    expect((await stranger.post("/api/auth/request-reset", { email: "nobody@example.com" })).status).toBe(200);
    expect(mailer.sent.filter((m) => m.subject.includes("Reset"))).toHaveLength(0);
    expect((await stranger.post("/api/auth/request-reset", { email: "dan@example.com" })).status).toBe(200);
    const mail = mailer.sent.find((m) => m.subject.includes("Reset"))!;
    const token = /#reset=([A-Za-z0-9_-]+)/.exec(mail.text)![1];

    expect((await stranger.post("/api/auth/reset", { token, password: "short" })).status).toBe(422);
    expect((await stranger.post("/api/auth/reset", { token, password: "a whole new passphrase" })).status).toBe(200);
    expect((await stranger.json<{ user: unknown }>(await stranger.get("/api/session"))).user).not.toBeNull();
    expect((await laptop.json<{ user: unknown }>(await laptop.get("/api/session"))).user).toBeNull();
    expect((await client(app).post("/api/auth/reset", { token, password: "yet another passphrase" })).status).toBe(400);
    expect((await client(app).post("/api/auth/login", { email: "dan@example.com", password: "a whole new passphrase" })).status).toBe(200);
  });

  it("changes the password and signs out other devices", async () => {
    const { app } = setup();
    const a = await signedIn(app);
    const b = client(app);
    await b.post("/api/auth/login", { email: "dan@example.com", password: PASSWORD });
    expect((await a.post("/api/account/password", { current: "wrong", next: "brand new passphrase" })).status).toBe(403);
    expect((await a.post("/api/account/password", { current: PASSWORD, next: "brand new passphrase" })).status).toBe(200);
    expect((await a.json<{ user: unknown }>(await a.get("/api/session"))).user).not.toBeNull();
    expect((await b.json<{ user: unknown }>(await b.get("/api/session"))).user).toBeNull();
  });

  it("lists devices and signs one out", async () => {
    const { app } = setup();
    const a = await signedIn(app);
    const b = client(app);
    await b.post("/api/auth/login", { email: "dan@example.com", password: PASSWORD }, { "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/140.0" });
    const { sessions } = await a.json<{ sessions: { id: string; current: boolean; device: string }[] }>(await a.get("/api/account/sessions"));
    expect(sessions).toHaveLength(2);
    const other = sessions.find((s) => !s.current)!;
    expect(other.device).toBe("Chrome on Windows");
    await a.post("/api/account/sessions/revoke", { id: other.id });
    expect((await b.json<{ user: unknown }>(await b.get("/api/session"))).user).toBeNull();
    const { activity } = await a.json<{ activity: { event: string }[] }>(await a.get("/api/account/activity"));
    expect(activity.map((x) => x.event)).toContain("signed_out_device");
  });

  it("deletes an account and everything in it", async () => {
    const { app, deps } = setup();
    const c = await signedIn(app);
    await c.put("/api/projects/prj_one", { baseRev: 0, name: "Bracket", source: 'design "Bracket"', versions: [{ id: "ver_1", ts: 1, author: "you", message: "m", source: "s" }] });
    expect((await c.post("/api/account/delete", { password: "nope" })).status).toBe(403);
    expect((await c.post("/api/account/delete", { password: PASSWORD })).status).toBe(200);
    for (const t of ["users", "sessions", "projects", "versions", "activity"]) expect(deps.db.get<{ n: number }>(`SELECT count(*) AS n FROM ${t}`)!.n).toBe(0);
    expect((await c.post("/api/auth/login", { email: "dan@example.com", password: PASSWORD })).status).toBe(401);
  });

  it("blocks disabled accounts", async () => {
    const { app, deps } = setup();
    const c = await signedIn(app);
    deps.db.run("UPDATE users SET disabled = 1");
    expect((await c.json<{ user: unknown }>(await c.get("/api/session"))).user).toBeNull();
    expect((await client(app).post("/api/auth/login", { email: "dan@example.com", password: PASSWORD })).status).toBe(403);
  });
});
