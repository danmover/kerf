// The account download (server) must be a backup the app can import, files included.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readImportFile } from "../src/persist/files";
import { ORIGIN, setup, signedIn } from "../server/tests/helpers";

const bytes = (s: string) => new TextEncoder().encode(s);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("account download", () => {
  it("carries the projects' STEP files and reference images, and Kerf can import it", async () => {
    const { app } = setup();
    const c = await signedIn(app);
    const put = (body: Uint8Array) =>
      app.request(`${ORIGIN}/api/files/${sha(body)}`, {
        method: "PUT",
        headers: { origin: ORIGIN, "x-kerf": "1", cookie: c.cookie, "content-type": "application/octet-stream", "x-kerf-encoding": "raw", "x-kerf-size": String(body.byteLength) },
        body: body as BodyInit,
      });
    const step = bytes("ISO-10303-21; a circuit board");
    const photo = bytes("a reference photo");
    expect((await put(step)).status).toBe(200);
    expect((await put(photo)).status).toBe(200);
    const imports = [{ name: "board", hash: sha(step), file: "board.step", size: step.byteLength, addedAt: 1, meta: null }];
    const assets = [{ id: "ast_photo1", kind: "image", mime: "image/jpeg", name: "front.jpg", size: photo.byteLength, createdAt: 1, hash: sha(photo) }];
    await c.put("/api/projects/prj_a", { baseRev: 0, name: "Case", source: 'brief { references: ["ast_photo1"] }', extra: { imports, assets } });
    await c.put("/api/projects/prj_b", { baseRev: 0, name: "Plain", source: "s" });

    const res = await c.get("/api/projects/export");
    expect(res.headers.get("content-disposition")).toMatch(/\.kerfbackup"$/);
    const text = await res.text();
    const backup = JSON.parse(text) as { importFiles: { hash: string }[]; projects: { name: string; assets?: { data: string }[] }[] };
    expect(backup.importFiles.map((f) => f.hash)).toEqual([sha(step)]);
    expect(Buffer.from(backup.projects.find((p) => p.name === "Case")!.assets![0].data, "base64").toString()).toBe("a reference photo");

    const read = await readImportFile(new File([text], "account.kerfbackup"));
    const project = read.projects.find((p) => p.name === "Case")!;
    expect(project.imports.map((i) => i.hash)).toEqual([sha(step)]);
    expect(project.assets.map((a) => a.id)).toEqual(["ast_photo1"]);
    expect(new TextDecoder().decode(read.files.get(sha(step)))).toBe("ISO-10303-21; a circuit board");
    expect(read.projects.find((p) => p.name === "Plain")).toBeTruthy();
  });
});
