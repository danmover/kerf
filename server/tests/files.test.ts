import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { housekeeping } from "../src/housekeeping.js";
import { client, ORIGIN, setup, signedIn } from "./helpers.js";

const bytes = (s: string) => new TextEncoder().encode(s);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function putFile(app: ReturnType<typeof setup>["app"], cookie: string, hash: string, body: Uint8Array, encoding = "raw") {
  return app.request(`${ORIGIN}/api/files/${hash}`, {
    method: "PUT",
    headers: { origin: ORIGIN, "x-kerf": "1", cookie, "content-type": "application/octet-stream", "x-kerf-encoding": encoding, "x-kerf-size": String(body.byteLength) },
    body,
  });
}

describe("project files", () => {
  it("stores a file once per account and gives it back", async () => {
    const { app } = setup();
    expect((await client(app).post("/api/files/missing", { hashes: [] })).status).toBe(401);
    const c = await signedIn(app);
    const step = bytes("ISO-10303-21; a bracket");
    const h = sha(step);
    expect(await c.json(await c.post("/api/files/missing", { hashes: [h] }))).toEqual({ missing: [h] });
    expect((await putFile(app, c.cookie, h, step)).status).toBe(200);
    expect((await putFile(app, c.cookie, h, step)).status).toBe(200);
    expect(await c.json(await c.post("/api/files/missing", { hashes: [h] }))).toEqual({ missing: [] });

    const got = await c.get(`/api/files/${h}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("x-kerf-encoding")).toBe("raw");
    expect(got.headers.get("x-kerf-size")).toBe(String(step.byteLength));
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(step);

    // another account can't read it, and names must be hashes
    const eve = await signedIn(app, "eve@example.com");
    expect((await eve.get(`/api/files/${h}`)).status).toBe(404);
    expect((await putFile(app, c.cookie, "../../etc", step)).status).toBe(404);
    expect((await putFile(app, c.cookie, "abc", step)).status).toBe(400);
  });

  it("keeps project data the server doesn't read, within limits", async () => {
    const { app } = setup();
    const c = await signedIn(app);
    const extra = { imports: [{ id: "imp_1", name: "board.step", hash: "a".repeat(64) }] };
    await c.put("/api/projects/prj_a", { baseRev: 0, name: "A", source: "s", extra });
    expect((await c.json<{ project: { extra: unknown } }>(await c.get("/api/projects/prj_a"))).project.extra).toEqual(extra);
    // left alone when a push doesn't mention it
    await c.put("/api/projects/prj_a", { baseRev: 1, source: "t" });
    expect((await c.json<{ project: { extra: unknown } }>(await c.get("/api/projects/prj_a"))).project.extra).toEqual(extra);
    expect((await c.put("/api/projects/prj_a", { baseRev: 2, extra: { big: "x".repeat(300_000) } })).status).toBe(400);
  });

  it("removes files no project uses any more", async () => {
    const { app, deps } = setup();
    const c = await signedIn(app);
    const kept = bytes("kept");
    const dropped = bytes("dropped");
    await putFile(app, c.cookie, sha(kept), kept);
    await putFile(app, c.cookie, sha(dropped), dropped);
    await c.put("/api/projects/prj_a", { baseRev: 0, name: "A", source: "s", extra: { imports: [{ hash: sha(kept) }] } });
    await c.put("/api/projects/prj_b", { baseRev: 0, name: "B", source: "s", extra: { imports: [{ hash: sha(dropped) }] } });
    await c.del("/api/projects/prj_b");

    housekeeping(deps);
    expect(deps.db.all("SELECT hash FROM files")).toHaveLength(2);
    housekeeping(deps, Date.now() + 2 * 24 * 3600 * 1000);
    expect(deps.db.all<{ hash: string }>("SELECT hash FROM files").map((r) => r.hash)).toEqual([sha(kept)]);
  });
});
