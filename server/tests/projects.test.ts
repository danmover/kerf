import { describe, expect, it } from "vitest";
import { housekeeping } from "../src/housekeeping.js";
import { client, setup, signedIn } from "./helpers.js";

const v = (id: string, ts: number, source = `design "${id}"`) => ({ id, ts, author: "you" as const, message: `edit ${id}`, source });

describe("cloud projects", () => {
  it("needs a signed-in user", async () => {
    const { app } = setup();
    expect((await client(app).get("/api/projects")).status).toBe(401);
  });

  it("creates, updates and lists a project with its history", async () => {
    const { app } = setup();
    const c = await signedIn(app);
    let r = await c.put("/api/projects/prj_a", { baseRev: 0, name: "Gearbox", source: "one", template: "reducer", createdAt: 10, updatedAt: 20, versions: [v("ver_1", 10), v("ver_2", 20)] });
    expect(await c.json(r)).toEqual({ rev: 1 });
    r = await c.put("/api/projects/prj_a", { baseRev: 1, source: "two", updatedAt: 30, versions: [v("ver_3", 30)] });
    expect(await c.json(r)).toEqual({ rev: 2 });

    const list = await c.json<{ projects: { id: string; rev: number; name: string }[] }>(await c.get("/api/projects"));
    expect(list.projects).toEqual([expect.objectContaining({ id: "prj_a", rev: 2, name: "Gearbox", template: "reducer" })]);

    const full = await c.json<{ project: { source: string }; versions: { id: string }[] }>(await c.get("/api/projects/prj_a"));
    expect(full.project.source).toBe("two");
    expect(full.versions.map((x) => x.id)).toEqual(["ver_1", "ver_2", "ver_3"]);
    // only what changed after a revision the device already has
    const since = await c.json<{ versions: { id: string }[] }>(await c.get("/api/projects/prj_a?since=1"));
    expect(since.versions.map((x) => x.id)).toEqual(["ver_3"]);
  });

  it("answers a stale write with the current state", async () => {
    const { app } = setup();
    const c = await signedIn(app);
    await c.put("/api/projects/prj_a", { baseRev: 0, name: "A", source: "one" });
    await c.put("/api/projects/prj_a", { baseRev: 1, source: "from laptop" });
    const stale = await c.put("/api/projects/prj_a", { baseRev: 1, source: "from desktop" });
    expect(stale.status).toBe(409);
    const body = await c.json<{ project: { rev: number; source: string } }>(stale);
    expect(body.project).toMatchObject({ rev: 2, source: "from laptop" });
    // creating over an existing id also conflicts
    expect((await c.put("/api/projects/prj_a", { baseRev: 0, name: "A", source: "x" })).status).toBe(409);
  });

  it("says what is wrong with a project it refuses", async () => {
    const { app } = setup();
    const c = await signedIn(app);
    const big = await c.put("/api/projects/prj_a", { baseRev: 0, name: "A", source: "one", extra: { meta: "x".repeat(4_000_001) } });
    expect(big.status).toBe(400);
    expect((await c.json<{ message: string }>(big)).message).toBe("Too much project data.");
    // Zod's own wording is replaced with the field's name
    const long = await c.put("/api/projects/prj_a", { baseRev: 0, name: "A", source: "x".repeat(300_001) });
    expect((await c.json<{ message: string }>(long)).message).toBe("Check the source field.");
  });

  it("never duplicates a version sent twice", async () => {
    const { app } = setup();
    const c = await signedIn(app);
    await c.put("/api/projects/prj_a", { baseRev: 0, name: "A", source: "one", versions: [v("ver_1", 1)] });
    await c.put("/api/projects/prj_a", { baseRev: 1, versions: [v("ver_1", 1), v("ver_2", 2)] });
    const full = await c.json<{ versions: unknown[] }>(await c.get("/api/projects/prj_a"));
    expect(full.versions).toHaveLength(2);
  });

  it("keeps the newest 300 versions", async () => {
    const { app } = setup();
    const c = await signedIn(app);
    let rev = 0;
    for (let b = 0; b < 4; b++) {
      const batch = Array.from({ length: 100 }, (_, i) => v(`ver_${b * 100 + i}`, b * 100 + i));
      rev = (await c.json<{ rev: number }>(await c.put("/api/projects/prj_a", { baseRev: rev, name: "A", source: "s", versions: batch }))).rev;
    }
    const full = await c.json<{ versions: { id: string }[] }>(await c.get("/api/projects/prj_a"));
    expect(full.versions).toHaveLength(300);
    expect(full.versions[0].id).toBe("ver_100");
  });

  it("keeps accounts apart, even with the same project id", async () => {
    const { app } = setup();
    const dan = await signedIn(app, "dan@example.com");
    const eve = await signedIn(app, "eve@example.com");
    await dan.put("/api/projects/prj_same", { baseRev: 0, name: "Dan's", source: "secret" });
    expect((await eve.get("/api/projects/prj_same")).status).toBe(404);
    expect((await eve.json<{ projects: unknown[] }>(await eve.get("/api/projects"))).projects).toHaveLength(0);
    expect((await eve.put("/api/projects/prj_same", { baseRev: 0, name: "Eve's", source: "mine" })).status).toBe(200);
    expect((await dan.json<{ project: { source: string } }>(await dan.get("/api/projects/prj_same"))).project.source).toBe("secret");
    await eve.del("/api/projects/prj_same");
    expect((await dan.json<{ project: { deletedAt: number | null } }>(await dan.get("/api/projects/prj_same"))).project.deletedAt).toBeNull();
  });

  it("erases a deleted project and leaves a marker for other devices", async () => {
    const { app, deps } = setup();
    const c = await signedIn(app);
    await c.put("/api/projects/prj_a", { baseRev: 0, name: "A", source: "geometry", versions: [v("ver_1", 1)] });
    await c.put("/api/projects/prj_a/chat", { updatedAt: 5, data: { items: [1], history: [] } });
    const del = await c.json<{ rev: number }>(await c.del("/api/projects/prj_a"));
    expect(del.rev).toBe(2);
    const list = await c.json<{ projects: { deletedAt: number | null; rev: number }[] }>(await c.get("/api/projects"));
    expect(list.projects[0].deletedAt).toBeGreaterThan(0);
    expect(deps.db.get<{ n: number }>("SELECT count(*) AS n FROM versions")!.n).toBe(0);
    expect(deps.db.get<{ n: number }>("SELECT count(*) AS n FROM chats")!.n).toBe(0);
    expect(deps.db.get<{ source: string }>("SELECT source FROM projects")!.source).toBe("");
    // a device with unsynced work can bring it back
    expect((await c.put("/api/projects/prj_a", { baseRev: 2, name: "A", source: "restored" })).status).toBe(200);
  });

  it("keeps the most recent chat", async () => {
    const { app } = setup();
    const c = await signedIn(app);
    await c.put("/api/projects/prj_a", { baseRev: 0, name: "A", source: "s" });
    expect((await c.get("/api/projects/prj_a/chat")).status).toBe(404);
    await c.put("/api/projects/prj_a/chat", { updatedAt: 100, data: { items: ["new"], history: [] } });
    const older = await c.json<{ updatedAt: number }>(await c.put("/api/projects/prj_a/chat", { updatedAt: 50, data: { items: ["old"], history: [] } }));
    expect(older.updatedAt).toBe(100);
    const got = await c.json<{ data: { items: string[] } }>(await c.get("/api/projects/prj_a/chat"));
    expect(got.data.items).toEqual(["new"]);
    const list = await c.json<{ projects: { chatUpdatedAt: number }[] }>(await c.get("/api/projects"));
    expect(list.projects[0].chatUpdatedAt).toBe(100);
  });

  it("validates what it stores", async () => {
    const { app } = setup();
    const c = await signedIn(app);
    expect((await c.put("/api/projects/bad id!", { baseRev: 0, name: "A", source: "s" })).status).toBe(400);
    expect((await c.put("/api/projects/prj_a", { baseRev: 0, name: "A", source: "s", thumbnail: "javascript:alert(1)" })).status).toBe(400);
    expect((await c.put("/api/projects/prj_a", { baseRev: 0, name: "A", source: "x".repeat(300_001) })).status).toBe(400);
    expect((await c.put("/api/projects/prj_a", { baseRev: 0, name: "A\u0000B", source: "ok\u0007" })).status).toBe(200);
    const full = await c.json<{ project: { name: string; source: string } }>(await c.get("/api/projects/prj_a"));
    expect(full.project).toMatchObject({ name: "AB", source: "ok" });
  });

  it("keeps the branch each version was made on, and the project's branches", async () => {
    const { app } = setup();
    const c = await signedIn(app);
    const branches = [
      { id: "main", name: "main", from: "", base: "", head: "one", createdAt: 1, updatedAt: 1 },
      { id: "brn_abcd1234", name: "lighter", from: "main", base: "one", head: "two", createdAt: 2, updatedAt: 3 },
    ];
    await c.put("/api/projects/prj_a", { baseRev: 0, name: "A", source: "two", versions: [v("ver_1", 1, "one"), { ...v("ver_2", 3, "two"), branch: "brn_abcd1234" }], extra: { branches, branch: "brn_abcd1234" } });
    const full = await c.json<{ versions: { id: string; branch?: string }[] }>(await c.get("/api/projects/prj_a"));
    expect(full.versions.map((x) => x.branch ?? "main")).toEqual(["main", "brn_abcd1234"]);
    expect("branch" in full.versions[0]).toBe(false);
    const backup = await c.json<{ projects: { versions: { branch?: string }[]; branches: unknown[]; branch: string }[] }>(await c.get("/api/projects/export"));
    expect(backup.projects[0].versions[1].branch).toBe("brn_abcd1234");
    expect(backup.projects[0].branches).toHaveLength(2);
    expect(backup.projects[0].branch).toBe("brn_abcd1234");
    expect((await c.put("/api/projects/prj_a", { baseRev: 1, versions: [{ ...v("ver_3", 4), branch: "../etc" }] })).status).toBe(400);
  });

  it("exports every project as a Kerf backup file", async () => {
    const { app } = setup();
    const c = await signedIn(app);
    await c.put("/api/projects/prj_a", { baseRev: 0, name: "A", source: "one", versions: [v("ver_1", 1, "one")] });
    const res = await c.get("/api/projects/export");
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="kerf-account-.*\.kerfbackup"/);
    const body = await c.json<{ format: string; projects: { name: string; versions: unknown[] }[] }>(res);
    expect(body.format).toBe("kerf-backup");
    expect(body.projects[0]).toMatchObject({ format: "kerf-project", version: 1, name: "A", source: "one" });
    expect(body.projects[0].versions).toHaveLength(1);
  });
});

describe("housekeeping", () => {
  it("drops old markers, expired sessions, old usage and abandoned sign-ups, and nothing else", async () => {
    const { app, deps } = setup();
    const c = await signedIn(app);
    await c.put("/api/projects/prj_old", { baseRev: 0, name: "Old", source: "s" });
    await c.put("/api/projects/prj_new", { baseRev: 0, name: "New", source: "s" });
    await c.put("/api/projects/prj_live", { baseRev: 0, name: "Live", source: "s" });
    await c.del("/api/projects/prj_old");
    await c.del("/api/projects/prj_new");
    const day = 24 * 3600 * 1000;
    const now = Date.now();
    deps.db.run("UPDATE projects SET deleted_at = ? WHERE id = 'prj_old'", now - 91 * day);
    const userId = deps.db.get<{ id: string }>("SELECT id FROM users")!.id;
    deps.db.run("INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at) VALUES ('stale', ?, ?, ?, ?)", userId, now - 40 * day, now - 31 * day, now - day);
    deps.db.run("INSERT INTO usage (user_id, day, source, model) VALUES (?, '2020-01-01', 'account', 'claude-opus-5-5')", userId);
    deps.db.run("INSERT INTO usage (user_id, day, source, model) VALUES (?, ?, 'account', 'claude-opus-5-5')", userId, new Date(now).toISOString().slice(0, 10));

    // an invite-only sign-up whose link was never used, and one still in time
    deps.db.run("INSERT INTO users (id, email, name, password_hash, terms_version, created_at) VALUES ('usr_stale', 'stale@example.com', '', '', 't', ?)", now - 8 * day);
    deps.db.run("INSERT INTO users (id, email, name, password_hash, terms_version, created_at) VALUES ('usr_fresh', 'fresh@example.com', '', '', 't', ?)", now - day);

    housekeeping(deps, now);
    expect(deps.db.all<{ email: string }>("SELECT email FROM users ORDER BY email").map((r) => r.email)).toEqual(["dan@example.com", "fresh@example.com"]);
    const ids = deps.db.all<{ id: string }>("SELECT id FROM projects ORDER BY id").map((r) => r.id);
    expect(ids).toEqual(["prj_live", "prj_new"]);
    expect(deps.db.get<{ n: number }>("SELECT count(*) AS n FROM sessions")!.n).toBe(1);
    expect(deps.db.get<{ n: number }>("SELECT count(*) AS n FROM usage")!.n).toBe(1);
    expect((await c.get("/api/session")).status).toBe(200);
    expect((await c.json<{ user: unknown }>(await c.get("/api/session"))).user).not.toBeNull();
  });
});
