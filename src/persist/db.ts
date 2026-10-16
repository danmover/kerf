// Local persistence in IndexedDB. Everything stays in this browser profile;
// nothing is uploaded. Falls back to memory when IndexedDB is unavailable
// (some private-browsing modes), and the UI warns that work will not persist.

export interface ProjectRecord {
  id: string;
  name: string;
  source: string;
  template: string;
  createdAt: number;
  updatedAt: number;
  thumbnail?: string;
}

export interface VersionRecord {
  id: string;
  projectId: string;
  ts: number;
  author: "you" | "claude" | "system";
  message: string;
  source: string;
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

const DB_NAME = "kerf";
const DB_VERSION = 1;
const MAX_VERSIONS = 300;

type StoreName = "projects" | "versions" | "chats" | "vault";

let dbPromise: Promise<IDBDatabase | null> | null = null;
export let persistent = true;

const memory: Record<StoreName, Map<string, unknown>> = {
  projects: new Map(),
  versions: new Map(),
  chats: new Map(),
  vault: new Map(),
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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      persistent = false;
      resolve(null);
    };
    req.onblocked = () => {
      persistent = false;
      resolve(null);
    };
  });
  return dbPromise;
}

function keyOf(store: StoreName, v: unknown): string {
  const r = v as Record<string, string>;
  return store === "chats" ? r.projectId : r.id;
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

export async function deleteProjectData(projectId: string): Promise<void> {
  for (const v of await versionsFor(projectId)) await remove("versions", v.id);
  await remove("chats", projectId);
  await remove("projects", projectId);
}

export async function clearEverything(): Promise<void> {
  const db = await open();
  if (!db) {
    for (const m of Object.values(memory)) m.clear();
    return;
  }
  for (const store of ["projects", "versions", "chats", "vault"] as StoreName[]) await tx(store, "readwrite", (s) => s.clear());
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
