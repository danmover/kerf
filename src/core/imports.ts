// Imported STEP files of the open project: keeps their bytes in memory,
// loads them into the geometry kernel (again after a kernel restart), and
// hands their analysis to the evaluator.

import { create } from "zustand";
import { kernel } from "../kernel/client";
import { IMPORT_META_VERSION, importTable, type ImportMeta, type ProjectImport } from "../kernel/imports";
import type { PartRecipe, ShapeRecipe } from "../kernel/recipe";
import { setEvalImports } from "../lang/imports";
import { getBlob } from "../persist/blobs";
import type { Model } from "./model";

export interface ImportStatus {
  state: "loading" | "ready" | "error" | "missing";
  error?: string;
}

interface ImportsState {
  list: ProjectImport[];
  /** by content hash */
  status: Record<string, ImportStatus>;
}

export const useImports = create<ImportsState>(() => ({ list: [], status: {} }));

const get = useImports.getState;

/** File bytes by hash, kept so a restarted kernel can be given them again without reading storage. */
const bytes = new Map<string, Uint8Array>();
/** Loads into the current kernel, by hash. */
const loads = new Map<string, Promise<void>>();
const listeners = new Set<(list: ProjectImport[], reason: "analysed" | "loaded") => void>();

/** Called when stored analysis changed (the project should save it) or a file finished loading (the design should rebuild). */
export function onImportsChanged(fn: (list: ProjectImport[], reason: "analysed" | "loaded") => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(reason: "analysed" | "loaded") {
  for (const l of listeners) l(get().list, reason);
}

function publish(list: ProjectImport[]) {
  setEvalImports(
    importTable(list),
    list.filter((i) => !i.meta).map((i) => i.name),
  );
}

function setStatus(hash: string, s: ImportStatus) {
  useImports.setState((st) => ({ status: { ...st.status, [hash]: s } }));
}

/** Make `list` the project's imports. Files no longer listed are dropped from the kernel. */
export function setImports(list: ProjectImport[]) {
  const keep = new Set(list.map((i) => i.hash));
  for (const h of [...loads.keys()]) {
    if (keep.has(h)) continue;
    kernel.dropImport(h);
    loads.delete(h);
    bytes.delete(h);
  }
  const status = Object.fromEntries(Object.entries(get().status).filter(([h]) => keep.has(h)));
  useImports.setState({ list, status });
  publish(list);
  for (const i of list) void ensureLoaded(i);
}

/** Give bytes that were just read from a file, so loading does not wait for storage. */
export function primeBytes(hash: string, data: Uint8Array) {
  bytes.set(hash, data);
}

/** Forget a file that was read but not kept (it failed to import). */
export function forgetBytes(hash: string) {
  if (get().list.some((i) => i.hash === hash)) return;
  bytes.delete(hash);
  loads.delete(hash);
  kernel.dropImport(hash);
}

export function importBytes(hash: string): Uint8Array | undefined {
  return bytes.get(hash);
}

function ensureLoaded(i: ProjectImport): Promise<void> {
  const running = loads.get(i.hash);
  if (running) return running;
  const job = load(i).catch((e) => setStatus(i.hash, { state: "error", error: e instanceof Error ? e.message : String(e) }));
  loads.set(i.hash, job);
  return job;
}

async function load(i: ProjectImport) {
  setStatus(i.hash, { state: "loading" });
  const data = bytes.get(i.hash) ?? (await getBlob(i.hash));
  if (!data) {
    setStatus(i.hash, { state: "missing", error: `This browser does not have ${i.file}. Use Replace to import it again.` });
    return;
  }
  bytes.set(i.hash, data);
  await kernel.ready();
  const stored = i.meta && i.meta.version === IMPORT_META_VERSION ? i.meta : null;
  let meta = await kernel.importStep(i.hash, i.file, data, !stored);
  // stored analysis must describe the same bodies the kernel now has; otherwise analyse again
  if (stored && !sameBodies(stored, meta)) meta = await kernel.importStep(i.hash, i.file, data, true);
  else if (stored) meta = stored;
  if (meta !== i.meta) {
    const list = get().list.map((x) => (x.hash === i.hash ? { ...x, meta } : x));
    useImports.setState({ list });
    publish(list);
    emit("analysed");
  }
  setStatus(i.hash, { state: "ready" });
  emit("loaded");
}

function sameBodies(a: ImportMeta, b: ImportMeta) {
  return a.bodies.length === b.bodies.length && a.bodies.every((x, k) => x.faces === b.bodies[k].faces && Math.abs(x.volume - b.bodies[k].volume) <= 1e-6 * Math.max(1, Math.abs(x.volume)));
}

/** Read a new file into the kernel and return its analysis (the caller stores it). */
export async function analyseFile(hash: string, file: string, data: Uint8Array): Promise<ImportMeta> {
  bytes.set(hash, data);
  await kernel.ready();
  const meta = await kernel.importStep(hash, file, data, true);
  // the kernel now holds this file: later loads reuse it
  loads.set(hash, Promise.resolve());
  setStatus(hash, { state: "ready" });
  return meta;
}

/** Resolves once every listed file has loaded (or failed). */
export async function importsLoaded(): Promise<void> {
  await Promise.all(get().list.map((i) => loads.get(i.hash) ?? ensureLoaded(i)));
}

/** Files this browser didn't have may have arrived (from the account): try those again. */
export function retryMissingImports() {
  for (const i of get().list) {
    if (get().status[i.hash]?.state !== "missing") continue;
    loads.delete(i.hash);
    void ensureLoaded(i);
  }
}

/** The kernel restarted: everything it held is gone, so load the files again. */
export function reloadImports() {
  loads.clear();
  for (const i of get().list) void ensureLoaded(i);
}

function shapeUsesImport(r: ShapeRecipe): boolean {
  switch (r.t) {
    case "import":
      return true;
    case "xform":
      return shapeUsesImport(r.shape);
    case "union":
      return r.shapes.some(shapeUsesImport);
    default:
      return false;
  }
}

export function recipeUsesImport(p: PartRecipe): boolean {
  return (!!p.base && shapeUsesImport(p.base)) || p.ops.some((o) => "shape" in o && shapeUsesImport(o.shape));
}

export function modelUsesImports(model: Model): boolean {
  return model.parts.some((p) => p.imported || recipeUsesImport(p.recipe));
}

/** Which components place each import, by import name. */
export function importUsers(model: Model | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of model?.parts ?? []) {
    if (!p.imported) continue;
    const users = out.get(p.imported.file) ?? [];
    if (!users.includes(p.name)) users.push(p.name);
    out.set(p.imported.file, users);
  }
  return out;
}
