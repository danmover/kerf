// Refined meshes kept between sessions, by geometry hash. The exact-tolerance meshes, the display meshes with drawn
// threads and the detailed builds are most of the time a design takes to reach its finished look (the detail worker
// spent about 40 s of the robot dog's 80); opening the design again, or undoing back to a shape seen before, finds
// them here instead.
//
// They live in a database of their own ("kerf-geometry"), apart from the user's projects: it can be cleared at any
// time and nothing is lost but time. Rows from another build of Kerf are never used (its kernel may build differently)
// and are deleted when this build first opens the database. The oldest rows go once the total passes LIMIT_BYTES.

import type { MeshData } from "../kernel/build";
import type { V3 } from "../kernel/recipe";

export type KeptQuality = "display" | "final";

export interface KeptMesh {
  mesh: MeshData;
  volume: number;
  bbox: [V3, V3];
  /** the detailed build's warnings, said again when the mesh is used */
  warnings?: string[];
}

interface MeshRow extends KeptMesh {
  key: string;
}

/** Small rows beside the meshes, so pruning reads sizes without reading meshes. */
interface SizeRow {
  key: string;
  build: string;
  bytes: number;
  used: number;
}

const DB_NAME = "kerf-geometry";
const DB_VERSION = 1;
const LIMIT_BYTES = 600 * 1024 * 1024;
const BUILD = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";

let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meshes")) db.createObjectStore("meshes", { keyPath: "key" });
      if (!db.objectStoreNames.contains("sizes")) db.createObjectStore("sizes", { keyPath: "key" });
    };
    req.onsuccess = () => {
      const db = req.result;
      // another tab with a newer Kerf may upgrade it: let go rather than block that tab
      db.onversionchange = () => {
        db.close();
        dbPromise = Promise.resolve(null);
      };
      resolve(db);
      void dropOtherBuilds(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

const keyOf = (hash: string, quality: KeptQuality) => `${quality}:${hash}`;

function bytesOf(m: MeshData): number {
  let n = 0;
  for (const a of [m.positions, m.normals, m.indices, m.edges, m.faceGroups, m.edgeGroups, m.colors, m.thread]) n += a?.byteLength ?? 0;
  return n;
}

function done(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error ?? new Error("Storage error"));
    t.onabort = () => reject(t.error ?? new Error("Storage was aborted"));
  });
}

/** Kept meshes of these parts, made by this build; missing ones are left out. Never throws. */
export async function keptMeshes(wanted: { hash: string; quality: KeptQuality }[]): Promise<Map<string, KeptMesh>> {
  const out = new Map<string, KeptMesh>();
  if (!wanted.length) return out;
  try {
    const db = await open();
    if (!db) return out;
    const t = db.transaction(["meshes", "sizes"], "readonly");
    const meshes = t.objectStore("meshes");
    const sizes = t.objectStore("sizes");
    const fresh = new Set<string>();
    for (const w of wanted) {
      const key = keyOf(w.hash, w.quality);
      const s = sizes.get(key);
      s.onsuccess = () => {
        if ((s.result as SizeRow | undefined)?.build !== BUILD) return;
        fresh.add(key);
        const m = meshes.get(key);
        m.onsuccess = () => {
          const row = m.result as MeshRow | undefined;
          if (row) out.set(key, { mesh: row.mesh, volume: row.volume, bbox: row.bbox, warnings: row.warnings });
        };
      };
    }
    await done(t);
    if (fresh.size) void touch([...fresh]);
  } catch {
    // a cache that can't be read is an empty one
  }
  return out;
}

/** The key keptMeshes uses for a part's mesh of one quality. */
export const keptKey = keyOf;

const pending = new Map<string, MeshRow>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Keep a refined mesh for later sessions (written a moment later, with others that arrive meanwhile). */
export function keepMesh(hash: string, quality: KeptQuality, kept: KeptMesh) {
  if (typeof indexedDB === "undefined") return;
  const key = keyOf(hash, quality);
  pending.set(key, { key, ...kept });
  flushTimer ??= setTimeout(() => void flush(), 1500);
}

async function flush() {
  flushTimer = null;
  const rows = [...pending.values()];
  pending.clear();
  if (!rows.length) return;
  try {
    const db = await open();
    if (!db) return;
    const t = db.transaction(["meshes", "sizes"], "readwrite");
    const now = Date.now();
    for (const r of rows) {
      t.objectStore("meshes").put(r);
      t.objectStore("sizes").put({ key: r.key, build: BUILD, bytes: bytesOf(r.mesh), used: now } satisfies SizeRow);
    }
    await done(t);
    await prune(db);
  } catch {
    // full or unavailable: the meshes are built again next time
  }
}

/** Mark rows as just used, so pruning takes the ones not opened for longest. */
async function touch(keys: string[]) {
  try {
    const db = await open();
    if (!db) return;
    const t = db.transaction("sizes", "readwrite");
    const s = t.objectStore("sizes");
    const now = Date.now();
    for (const k of keys) {
      const r = s.get(k);
      r.onsuccess = () => {
        const row = r.result as SizeRow | undefined;
        if (row) s.put({ ...row, used: now });
      };
    }
    await done(t);
  } catch {
    // only the order of pruning is lost
  }
}

async function prune(db: IDBDatabase) {
  const t = db.transaction("sizes", "readonly");
  const req = t.objectStore("sizes").getAll();
  await done(t);
  const rows = (req.result as SizeRow[]).sort((a, b) => a.used - b.used);
  let total = rows.reduce((n, r) => n + r.bytes, 0);
  const drop: string[] = [];
  for (const r of rows) {
    if (total <= LIMIT_BYTES) break;
    drop.push(r.key);
    total -= r.bytes;
  }
  await remove(db, drop);
}

/** Rows another build of Kerf made: its kernel may not build the same shapes. */
async function dropOtherBuilds(db: IDBDatabase) {
  try {
    const t = db.transaction("sizes", "readonly");
    const req = t.objectStore("sizes").getAll();
    await done(t);
    await remove(
      db,
      (req.result as SizeRow[]).filter((r) => r.build !== BUILD).map((r) => r.key),
    );
  } catch {
    // tried again next session
  }
}

async function remove(db: IDBDatabase, keys: string[]) {
  if (!keys.length) return;
  const t = db.transaction(["meshes", "sizes"], "readwrite");
  for (const k of keys) {
    t.objectStore("meshes").delete(k);
    t.objectStore("sizes").delete(k);
  }
  await done(t);
}

/** Forget every kept mesh (Settings → storage, or a test). */
export async function clearKeptMeshes() {
  pending.clear();
  try {
    const db = await open();
    if (!db) return;
    const t = db.transaction(["meshes", "sizes"], "readwrite");
    t.objectStore("meshes").clear();
    t.objectStore("sizes").clear();
    await done(t);
  } catch {
    // nothing kept to clear
  }
}

/** Write what is waiting now (for tests, and before the page goes). */
export function flushKeptMeshes(): Promise<void> {
  if (flushTimer) clearTimeout(flushTimer);
  return flush();
}
