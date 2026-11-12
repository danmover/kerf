// Local persistence in IndexedDB. Everything stays in this browser profile;
// nothing is uploaded. Falls back to memory when IndexedDB is unavailable
// (some private-browsing modes), and the UI warns that work will not persist.

import type { ProjectImport } from "../kernel/imports";
import { dismissToast, toast } from "../app/ui";

export interface ProjectRecord {
  id: string;
  name: string;
  source: string;
  template: string;
  createdAt: number;
  updatedAt: number;
  thumbnail?: string;
  /** STEP files imported into the project; their bytes are in the blobs store */
  imports?: ProjectImport[];
  /** the id of the branch open now (see src/core/branches.ts); absent means main */
  branch?: string;
  /** the project's branches, main first, once it has more than main */
  branches?: BranchRecord[];
  /** the user's own scripts for this design (see src/scripts/): automation run by hand, by Claude or after each change */
  scripts?: ScriptRecord[];
}

/** A script saved with a project: JavaScript that drives Kerf through the `kerf` API in a sandbox. */
export interface ScriptRecord {
  /** stays when the script is renamed */
  id: string;
  name: string;
  code: string;
  /** run again after each change to the design, as checks of the user's own */
  onChange?: boolean;
  updatedAt: number;
}

/** A line of work in a project: made from another branch, merged back into it, or left as an alternative. */
export interface BranchRecord {
  /** "main", or an id that stays when the branch is renamed */
  id: string;
  name: string;
  /** the id of the branch it was made from ("" for main) */
  from: string;
  /** the design when it was made: the starting point both branches share */
  base: string;
  /** its latest design; for the branch open now, the project's source is newer */
  head: string;
  createdAt: number;
  updatedAt: number;
  /**
   * where it met its parent since: its own design when that went into the parent (merged), or the parent's when it took
   * the parent's changes (took), with the base that merge was worked out from
   */
  meets?: { kind: "merged" | "took"; source: string; base: string; ts: number }[];
}

/** Bytes of an imported file, shared by every project that imports the same file. */
export interface BlobRecord {
  hash: string;
  data: ArrayBuffer;
  encoding: "gzip" | "raw";
  size: number;
  createdAt: number;
}

export interface VersionRecord {
  id: string;
  projectId: string;
  ts: number;
  author: "you" | "claude" | "system";
  message: string;
  source: string;
  /** the id of the branch it was made on; absent on main */
  branch?: string;
}

/** A file the user added to a project, such as a reference photo, sketch or datasheet. */
export interface AssetRecord {
  /** projectId + ":" + id, so a copied project keeps the ids its source refers to */
  key: string;
  id: string;
  projectId: string;
  kind: "image" | "pdf";
  mime: string;
  name: string;
  size: number;
  width?: number;
  height?: number;
  data: Blob;
  thumb?: Blob;
  createdAt: number;
}

export interface ChatRecord {
  projectId: string;
  /** display items and API history, both JSON-safe */
  items: unknown[];
  history: unknown[];
  /** what the saved thinking blocks were made with; see src/ai/history.ts */
  binding?: string;
  validBefore?: number;
  updatedAt: number;
}

/** A finished simulation run, kept with its project so it can be replayed after Kerf restarts (see src/sim/saved.ts). */
export interface SimRunRecord {
  /** projectId | savedAt | runKey | label (see src/sim/saved.ts) */
  key: string;
  projectId: string;
  /** the scenario's label */
  label: string;
  /** what the run was made from: the same key gives the same result */
  runKey: string;
  savedAt: number;
  bytes: number;
  /** the RunResult, as the worker sent it */
  result: unknown;
}

const DB_NAME = "kerf";
const DB_VERSION = 4;
const MAX_VERSIONS = 300;

type StoreName = "projects" | "versions" | "chats" | "vault" | "assets" | "blobs" | "sims";

let dbPromise: Promise<IDBDatabase | null> | null = null;
export let persistent = true;

const memory: Record<StoreName, Map<string, unknown>> = {
  projects: new Map(),
  versions: new Map(),
  chats: new Map(),
  vault: new Map(),
  assets: new Map(),
  blobs: new Map(),
  sims: new Map(),
};

function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      persistent = false;
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
      if (!db.objectStoreNames.contains("versions")) {
        const v = db.createObjectStore("versions", { keyPath: "id" });
        v.createIndex("projectId", "projectId");
      }
      if (!db.objectStoreNames.contains("chats")) db.createObjectStore("chats", { keyPath: "projectId" });
      if (!db.objectStoreNames.contains("vault")) db.createObjectStore("vault", { keyPath: "id" });
      if (!db.objectStoreNames.contains("assets") || req.transaction!.objectStore("assets").keyPath !== "key") {
        // a pre-release STEP import build kept file bytes in "assets"; those now live in "blobs"
        if (db.objectStoreNames.contains("assets")) db.deleteObjectStore("assets");
        const a = db.createObjectStore("assets", { keyPath: "key" });
        a.createIndex("projectId", "projectId");
      }
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs", { keyPath: "hash" });
      if (!db.objectStoreNames.contains("sims")) {
        const r = db.createObjectStore("sims", { keyPath: "key" });
        r.createIndex("projectId", "projectId");
      }
    };
    let blocked = 0;
    req.onsuccess = () => {
      if (blocked) dismissToast(blocked);
      // let a newer Kerf in another tab upgrade the database instead of being blocked by this one
      req.result.onversionchange = () => {
        req.result.close();
        toast({ kind: "warn", title: "Kerf was updated in another tab", detail: "Reload this tab to keep working. Changes made here from now on are not saved." }, 0);
      };
      resolve(req.result);
    };
    req.onerror = () => {
      persistent = false;
      resolve(null);
    };
    // an older Kerf tab still has the database open: wait for it rather than run without saving
    req.onblocked = () => (blocked = toast({ kind: "warn", title: "Close other Kerf tabs to finish updating", detail: "Another tab is running an older version of Kerf. Your projects open here as soon as it is closed or reloaded." }, 0));
  });
  return dbPromise;
}

function keyOf(store: StoreName, v: unknown): string {
  const r = v as Record<string, string>;
  return store === "chats" ? r.projectId : store === "assets" || store === "sims" ? r.key : store === "blobs" ? r.hash : r.id;
}

async function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  if (!db) return undefined;
  return new Promise<T | undefined>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const req = fn(s);
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error ?? new Error("Storage error"));
    t.onabort = () => reject(t.error ?? new Error("Storage was aborted (the disk may be full)"));
  });
}

export async function getAll<T>(store: StoreName): Promise<T[]> {
  const db = await open();
  if (!db) return [...memory[store].values()] as T[];
  return ((await tx<T[]>(store, "readonly", (s) => s.getAll() as IDBRequest<T[]>)) ?? []) as T[];
}

export async function getOne<T>(store: StoreName, key: string): Promise<T | undefined> {
  const db = await open();
  if (!db) return memory[store].get(key) as T | undefined;
  return tx<T>(store, "readonly", (s) => s.get(key) as IDBRequest<T>);
}

export async function put<T>(store: StoreName, value: T): Promise<void> {
  const db = await open();
  if (!db) {
    memory[store].set(keyOf(store, value), structuredClone(value));
    return;
  }
  await tx(store, "readwrite", (s) => s.put(value));
}

export async function remove(store: StoreName, key: string): Promise<void> {
  const db = await open();
  if (!db) {
    memory[store].delete(key);
    return;
  }
  await tx(store, "readwrite", (s) => s.delete(key));
}

export async function versionsFor(projectId: string): Promise<VersionRecord[]> {
  const db = await open();
  let all: VersionRecord[];
  if (!db) all = [...(memory.versions.values() as Iterable<VersionRecord>)].filter((v) => v.projectId === projectId);
  else all = ((await tx<VersionRecord[]>("versions", "readonly", (s) => s.index("projectId").getAll(projectId) as IDBRequest<VersionRecord[]>)) ?? []) as VersionRecord[];
  return all.sort((a, b) => a.ts - b.ts);
}

export async function addVersion(v: VersionRecord): Promise<void> {
  await put("versions", v);
  const all = await versionsFor(v.projectId);
  if (all.length > MAX_VERSIONS) {
    for (const old of all.slice(0, all.length - MAX_VERSIONS)) await remove("versions", old.id);
  }
}

export async function assetsFor(projectId: string): Promise<AssetRecord[]> {
  const db = await open();
  if (!db) return [...(memory.assets.values() as Iterable<AssetRecord>)].filter((a) => a.projectId === projectId);
  return ((await tx<AssetRecord[]>("assets", "readonly", (s) => s.index("projectId").getAll(projectId) as IDBRequest<AssetRecord[]>)) ?? []) as AssetRecord[];
}

/** Saved simulation runs of a project, newest first. */
export async function simRunsFor(projectId: string): Promise<SimRunRecord[]> {
  const db = await open();
  let all: SimRunRecord[];
  if (!db) all = [...(memory.sims.values() as Iterable<SimRunRecord>)].filter((r) => r.projectId === projectId);
  else all = ((await tx<SimRunRecord[]>("sims", "readonly", (s) => s.index("projectId").getAll(projectId) as IDBRequest<SimRunRecord[]>)) ?? []) as SimRunRecord[];
  return all.sort((a, b) => b.savedAt - a.savedAt);
}

/** Keys of a project's saved runs, without reading the runs themselves. */
export async function simRunKeysFor(projectId: string): Promise<string[]> {
  const db = await open();
  if (!db) return [...(memory.sims.values() as Iterable<SimRunRecord>)].filter((r) => r.projectId === projectId).map((r) => r.key);
  return (((await tx<IDBValidKey[]>("sims", "readonly", (s) => s.index("projectId").getAllKeys(projectId))) ?? []) as string[]).map(String);
}

export async function deleteProjectData(projectId: string): Promise<void> {
  for (const v of await versionsFor(projectId)) await remove("versions", v.id);
  for (const a of await assetsFor(projectId)) await remove("assets", a.key);
  for (const k of await simRunKeysFor(projectId)) await remove("sims", k);
  await remove("chats", projectId);
  await remove("projects", projectId);
}

export async function clearEverything(): Promise<void> {
  const db = await open();
  if (!db) {
    for (const m of Object.values(memory)) m.clear();
    return;
  }
  for (const store of ["projects", "versions", "chats", "vault", "assets", "blobs", "sims"] as StoreName[]) await tx(store, "readwrite", (s) => s.clear());
}

/** Hashes of every stored import file (keys only, so large files are not read). */
export async function blobKeys(): Promise<string[]> {
  const db = await open();
  if (!db) return [...memory.blobs.keys()];
  return (((await tx<IDBValidKey[]>("blobs", "readonly", (s) => s.getAllKeys())) ?? []) as string[]).map(String);
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? { usage: e.usage ?? 0, quota: e.quota ?? 0 } : null;
  } catch {
    return null;
  }
}

export function newId(prefix: string) {
  const b = crypto.getRandomValues(new Uint8Array(9));
  return prefix + "_" + Array.from(b, (x) => x.toString(36).padStart(2, "0")).join("").slice(0, 14);
}

export async function ensureOpen() {
  await open();
  return persistent;
}
