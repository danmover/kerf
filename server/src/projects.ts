// Cloud copies of projects, their version history and chats, for sync between devices.
//
// Each project has a revision number. A device sends changes with the revision
// it last saw (baseRev); if another device got there first the server answers
// 409 with its current state, and the client merges and tries again. Versions
// are append-only and keyed by the client's id, so retries never duplicate them.

import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "./auth.js";
import { HttpError, type AppEnv, type Deps } from "./types.js";

export const LIMITS = {
  sourceChars: 300_000,
  thumbnailChars: 400_000,
  chatChars: 4_000_000,
  extraChars: 4_000_000,
  versionsPerProject: 300,
  versionsPerRequest: 100,
  projectsPerUser: 2000,
  bytesPerUser: 500 * 1024 * 1024,
};

const clean = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
const projectId = z.string().regex(/^[A-Za-z0-9_-]{4,64}$/);
const ts = z.number().int().nonnegative().max(8.64e15);

const Version = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/),
  ts,
  author: z.enum(["you", "claude", "system"]),
  message: z.string().max(2000),
  source: z.string().max(LIMITS.sourceChars),
});

const Push = z.object({
  baseRev: z.number().int().nonnegative(),
  name: z.string().trim().min(1).max(200).optional(),
  source: z.string().max(LIMITS.sourceChars).optional(),
  template: z.string().max(60).optional(),
  createdAt: ts.optional(),
  updatedAt: ts.optional(),
  thumbnail: z
    .string()
    .max(LIMITS.thumbnailChars)
    .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/)
    .nullable()
    .optional(),
  versions: z.array(Version).max(LIMITS.versionsPerRequest).optional(),
  /** project fields the app keeps that the server stores without reading, such as the list of imported files */
  extra: z
    .record(z.string(), z.unknown())
    .refine((x) => JSON.stringify(x).length <= LIMITS.extraChars, "Too much project data.")
    .optional(),
});

interface ProjectRow {
  id: string;
  name: string;
  source: string;
  template: string;
  thumbnail: string | null;
  created_at: number;
  updated_at: number;
  rev: number;
  deleted_at: number | null;
  extra: string;
}

const head = (p: ProjectRow) => ({ id: p.id, name: p.name, source: p.source, template: p.template, thumbnail: p.thumbnail, extra: JSON.parse(p.extra || "{}") as Record<string, unknown>, createdAt: p.created_at, updatedAt: p.updated_at, rev: p.rev, deletedAt: p.deleted_at });

/** Everything an account stores: projects with their history and chats, plus files. */
export function accountBytes(deps: Deps, userId: string): number {
  return (
    deps.db.get<{ n: number }>("SELECT coalesce(sum(bytes), 0) AS n FROM projects WHERE user_id = ?", userId)!.n +
    deps.db.get<{ n: number }>("SELECT coalesce(sum(length(data)), 0) AS n FROM files WHERE user_id = ?", userId)!.n
  );
}

export function checkQuota(deps: Deps, userId: string) {
  const used = accountBytes(deps, userId);
  if (used > LIMITS.bytesPerUser) throw new HttpError(413, "quota", `Your account is full (${Math.round(used / 1048576)} MB of ${LIMITS.bytesPerUser / 1048576} MB). Delete projects you no longer need.`);
}

export function projectRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const { db } = deps;
  app.use("*", requireUser);
  app.use("*", async (c, next) => {
    const wait = deps.limiter.hit(`api:${c.get("user").id}`, 600, 60 * 1000);
    if (wait) throw new HttpError(429, "rate_limited", "Too many requests. Try again shortly.", { retryAfter: wait });
    await next();
  });

  const get = (userId: string, id: string) => db.get<ProjectRow>("SELECT * FROM projects WHERE user_id = ? AND id = ?", userId, id);

  const recount = (userId: string, id: string) =>
    db.run(
      `UPDATE projects SET bytes =
         length(source) + coalesce(length(thumbnail), 0) + length(extra)
         + coalesce((SELECT sum(length(source) + length(message)) FROM versions WHERE user_id = ?1 AND project_id = ?2), 0)
         + coalesce((SELECT length(data) FROM chats WHERE user_id = ?1 AND project_id = ?2), 0)
       WHERE user_id = ?1 AND id = ?2`,
      userId,
      id,
    );


  app.get("/", (c) => {
    const rows = db.all<ProjectRow & { chat_updated_at: number | null }>(
      `SELECT p.id, p.name, p.template, p.created_at, p.updated_at, p.rev, p.deleted_at, p.bytes, c.updated_at AS chat_updated_at
       FROM projects p LEFT JOIN chats c ON c.user_id = p.user_id AND c.project_id = p.id
       WHERE p.user_id = ? ORDER BY p.updated_at DESC`,
      c.get("user").id,
    );
    return c.json({
      projects: rows.map((r) => ({ id: r.id, name: r.name, template: r.template, createdAt: r.created_at, updatedAt: r.updated_at, rev: r.rev, deletedAt: r.deleted_at, chatUpdatedAt: r.chat_updated_at })),
    });
  });

  // a portable backup of every project, in the same format as the app's own
  // backup file, with the STEP files and reference images the projects use.
  // It is streamed a project at a time, since files can make it large.
  app.get("/export", (c) => {
    const user = c.get("user");
    const rows = db.all<{ id: string }>("SELECT id FROM projects WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC", user.id);
    const file = (hash: unknown) =>
      typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash) ? db.get<{ encoding: string; data: Uint8Array }>("SELECT encoding, data FROM files WHERE user_id = ? AND hash = ?", user.id, hash) : undefined;
    const importHashes = new Set<string>();
    function* pieces(): Generator<string> {
      yield `{"format":"kerf-backup","version":2,"exportedAt":${Date.now()},"projects":[`;
      let first = true;
      for (const r of rows) {
        const p = get(user.id, r.id);
        if (!p) continue;
        const extra = JSON.parse(p.extra || "{}") as { imports?: { hash?: unknown }[]; assets?: { id: string; kind: string; mime: string; name: string; hash: unknown }[] };
        const imports = Array.isArray(extra.imports) ? extra.imports.filter((i) => file(i?.hash)) : [];
        for (const i of imports) importHashes.add(i.hash as string);
        const assets = (Array.isArray(extra.assets) ? extra.assets : []).flatMap((a) => {
          const f = file(a?.hash);
          // reference files are stored as they are: a JPEG or PDF is already compressed
          return f && f.encoding === "raw" ? [{ id: a.id, kind: a.kind, mime: a.mime, name: a.name, data: Buffer.from(f.data).toString("base64") }] : [];
        });
        const versions = db.all<{ ts: number; author: string; message: string; source: string }>("SELECT ts, author, message, source FROM versions WHERE user_id = ? AND project_id = ? ORDER BY ts", user.id, p.id);
        const out = { format: "kerf-project", version: imports.length ? 2 : 1, name: p.name, source: p.source, template: p.template, createdAt: p.created_at, versions, ...(assets.length ? { assets } : {}), ...(imports.length ? { imports } : {}) };
        yield (first ? "" : ",") + JSON.stringify(out);
        first = false;
      }
      yield `],"importFiles":[`;
      first = true;
      for (const hash of importHashes) {
        const f = file(hash);
        if (!f) continue;
        yield (first ? "" : ",") + JSON.stringify({ hash, encoding: f.encoding, data: Buffer.from(f.data).toString("base64") });
        first = false;
      }
      yield "]}";
    }
    const it = pieces();
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        const next = it.next();
        if (next.done) ctrl.close();
        else ctrl.enqueue(enc.encode(next.value));
      },
    });
    c.header("Content-Type", "application/json; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="kerf-account-${new Date().toISOString().slice(0, 10)}.kerfbackup"`);
    return c.body(body);
  });

  app.get("/:id", (c) => {
    const id = projectId.parse(c.req.param("id"));
    const since = Number(c.req.query("since") ?? 0) || 0;
    const user = c.get("user");
    const p = get(user.id, id);
    if (!p) throw new HttpError(404, "not_found", "That project is not in your account.");
    const versions = db.all<{ id: string; ts: number; author: string; message: string; source: string }>(
      "SELECT id, ts, author, message, source FROM versions WHERE user_id = ? AND project_id = ? AND seq > ? ORDER BY ts",
      user.id,
      id,
      since,
    );
    return c.json({ project: head(p), versions });
  });

  app.put("/:id", async (c) => {
    const id = projectId.parse(c.req.param("id"));
    const body = Push.parse(await c.req.json());
    const user = c.get("user");
    const now = Date.now();
    const result = db.tx(() => {
      const p = get(user.id, id);
      if (!p) {
        if (body.baseRev !== 0 || body.source === undefined || !body.name) throw new HttpError(409, "conflict", "This project changed on the server.", { project: null });
        const count = db.get<{ n: number }>("SELECT count(*) AS n FROM projects WHERE user_id = ?", user.id)!.n;
        if (count >= LIMITS.projectsPerUser) throw new HttpError(413, "quota", `An account can hold ${LIMITS.projectsPerUser} projects. Delete some you no longer need.`);
        db.run(
          "INSERT INTO projects (user_id, id, name, source, template, thumbnail, extra, created_at, updated_at, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
          user.id,
          id,
          clean(body.name).slice(0, 120),
          clean(body.source),
          body.template ?? "blank",
          body.thumbnail ?? null,
          JSON.stringify(body.extra ?? {}),
          body.createdAt ?? now,
          body.updatedAt ?? now,
        );
      } else {
        if (p.rev !== body.baseRev) throw new HttpError(409, "conflict", "This project changed on another device.", { project: head(p) });
        db.run(
          `UPDATE projects SET name = ?, source = ?, template = ?, thumbnail = ?, extra = ?, updated_at = ?, rev = rev + 1, deleted_at = NULL WHERE user_id = ? AND id = ?`,
          body.name !== undefined ? clean(body.name).slice(0, 120) : p.name,
          body.source !== undefined ? clean(body.source) : p.source,
          body.template ?? p.template,
          body.thumbnail !== undefined ? body.thumbnail : p.thumbnail,
          body.extra !== undefined ? JSON.stringify(body.extra) : p.extra,
          body.updatedAt ?? now,
          user.id,
          id,
        );
      }
      const rev = get(user.id, id)!.rev;
      for (const v of body.versions ?? []) {
        db.run(
          "INSERT OR IGNORE INTO versions (user_id, project_id, id, ts, author, message, source, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          user.id,
          id,
          v.id,
          v.ts,
          v.author,
          clean(v.message).slice(0, 500),
          clean(v.source),
          rev,
        );
      }
      // keep the newest versions, as the app does locally
      db.run(
        `DELETE FROM versions WHERE user_id = ?1 AND project_id = ?2 AND id NOT IN
           (SELECT id FROM versions WHERE user_id = ?1 AND project_id = ?2 ORDER BY ts DESC LIMIT ?3)`,
        user.id,
        id,
        LIMITS.versionsPerProject,
      );
      recount(user.id, id);
      checkQuota(deps, user.id);
      return { rev };
    });
    return c.json(result);
  });

  app.delete("/:id", async (c) => {
    const id = projectId.parse(c.req.param("id"));
    const user = c.get("user");
    const rev = db.tx(() => {
      const p = get(user.id, id);
      if (!p) return 0;
      if (p.deleted_at) return p.rev;
      // the design and its history are erased; a small marker tells other devices to remove their copy
      db.run("DELETE FROM chats WHERE user_id = ? AND project_id = ?", user.id, id);
      db.run("DELETE FROM versions WHERE user_id = ? AND project_id = ?", user.id, id);
      db.run("UPDATE projects SET source = '', thumbnail = NULL, extra = '{}', deleted_at = ?, updated_at = ?, rev = rev + 1, bytes = 0 WHERE user_id = ? AND id = ?", Date.now(), Date.now(), user.id, id);
      return p.rev + 1;
    });
    return c.json({ ok: true, rev });
  });

  app.get("/:id/chat", (c) => {
    const id = projectId.parse(c.req.param("id"));
    const row = db.get<{ data: string; updated_at: number }>("SELECT data, updated_at FROM chats WHERE user_id = ? AND project_id = ?", c.get("user").id, id);
    if (!row) throw new HttpError(404, "not_found", "No chat saved for this project.");
    return c.json({ data: JSON.parse(row.data) as unknown, updatedAt: row.updated_at });
  });

  app.put("/:id/chat", async (c) => {
    const id = projectId.parse(c.req.param("id"));
    const user = c.get("user");
    const raw = await c.req.text();
    if (raw.length > LIMITS.chatChars + 200) throw new HttpError(413, "too_large", "This chat is too long to sync. Clear older messages or start a new chat.");
    const body = z.object({ updatedAt: ts, data: z.object({ items: z.array(z.unknown()), history: z.array(z.unknown()) }).passthrough() }).parse(JSON.parse(raw));
    const updatedAt = db.tx(() => {
      const p = get(user.id, id);
      if (!p || p.deleted_at) throw new HttpError(404, "not_found", "That project is not in your account.");
      const cur = db.get<{ updated_at: number }>("SELECT updated_at FROM chats WHERE user_id = ? AND project_id = ?", user.id, id);
      // the most recent conversation wins
      if (cur && cur.updated_at >= body.updatedAt) return cur.updated_at;
      db.run(
        "INSERT INTO chats (user_id, project_id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, project_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
        user.id,
        id,
        JSON.stringify(body.data),
        body.updatedAt,
      );
      recount(user.id, id);
      checkQuota(deps, user.id);
      return body.updatedAt;
    });
    return c.json({ updatedAt });
  });

  return app;
}
