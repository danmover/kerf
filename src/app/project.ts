// Projects, autosave and design history. Every change to a design is a
// change to its source text; this module records those changes as versions
// and provides undo and redo across editor, panel and AI edits.

import { create } from "zustand";
import * as db from "../persist/db";
import type { ProjectRecord, VersionRecord } from "../persist/db";
import { loadSource, setSource, useDesign } from "../core/engine";
import { describeChange } from "../core/sourceEdit";
import type { Model } from "../core/model";
import { templateById } from "../demos/templates";
import { backupFile, download, projectFile, readImportFile, safeFileName, type PackedFile, type ProjectFile } from "../persist/files";
import { copyAssets, exportAssets, importAssets, releaseAssetUrls } from "../persist/assets";
import { collectUnusedBlobs, getPackedBlob, putBlob, toBase64 } from "../persist/blobs";
import { onImportsChanged, setImports } from "../core/imports";
import type { ProjectImport } from "../kernel/imports";
import { go, toast, errorText } from "./ui";
import { resetView, useView } from "./view";
import { forgetAllRuns, forgetRuns } from "../agents/progress";

export type SaveState = "saved" | "saving" | "unsaved" | "error" | "memory";

/** A temporary source shown in the viewport and checks without becoming a version. */
export interface Preview {
  key: string;
  label: string;
  /** makes the previewed source real; shown as Apply on the preview banner */
  apply?: () => void;
  /** no banner (live adjustment while dragging a value) */
  quiet?: boolean;
}

interface ProjectState {
  projects: ProjectRecord[];
  loaded: boolean;
  current: ProjectRecord | null;
  versions: VersionRecord[];
  undo: string[];
  redo: string[];
  save: SaveState;
  saveError: string;
  preview: Preview | null;
}

export const useProject = create<ProjectState>(() => ({
  projects: [],
  loaded: false,
  current: null,
  versions: [],
  undo: [],
  redo: [],
  save: "saved",
  saveError: "",
  preview: null,
}));

const get = useProject.getState;
const set = useProject.setState;

/** last committed source and its model, the base for the next version's summary */
let committed: { source: string; model: Model | null } = { source: "", model: null };
let typingTimer: ReturnType<typeof setTimeout> | null = null;
/** the real source while a preview is showing */
let previewBase: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const openListeners = new Set<(p: ProjectRecord) => void>();
export const onProjectOpen = (fn: (p: ProjectRecord) => void) => {
  openListeners.add(fn);
  return () => openListeners.delete(fn);
};
const deleteListeners = new Set<(id: string) => void>();
export const onProjectDeleted = (fn: (id: string) => void) => {
  deleteListeners.add(fn);
  return () => deleteListeners.delete(fn);
};

export async function refreshProjects() {
  const persistent = await db.ensureOpen();
  const projects = (await db.getAll<ProjectRecord>("projects")).sort((a, b) => b.updatedAt - a.updatedAt);
  set({ projects, loaded: true, save: persistent ? get().save : "memory" });
}

export async function createProject(templateId: string, name?: string, source?: string, imports?: ProjectImport[]): Promise<ProjectRecord> {
  const t = templateById(templateId);
  const src = source ?? t?.source ?? "";
  const now = Date.now();
  const nameFromSrc = /design\s+"([^"]{1,120})"/.exec(src)?.[1];
  const p: ProjectRecord = { id: db.newId("prj"), name: name ?? (templateId === "blank" ? "Untitled design" : nameFromSrc ?? t?.name ?? "Untitled design"), source: src, template: templateId, createdAt: now, updatedAt: now };
  if (imports?.length) p.imports = imports;
  await db.put("projects", p);
  await db.addVersion({ id: db.newId("ver"), projectId: p.id, ts: now, author: "system", message: t ? `Created from “${t.name}”` : "Created", source: src });
  await refreshProjects();
  return p;
}

export async function openProject(id: string) {
  await flushPending();
  const p = await db.getOne<ProjectRecord>("projects", id);
  if (!p) {
    toast({ kind: "error", title: "That project no longer exists" });
    await refreshProjects();
    return;
  }
  const versions = await db.versionsFor(id);
  resetView();
  releaseAssetUrls();
  previewBase = null;
  set({ current: p, versions, undo: [], redo: [], save: db.persistent ? "saved" : "memory", preview: null });
  // the evaluator needs the imported files' analysis before it reads the source
  setImports(p.imports ?? []);
  loadSource(p.source);
  committed = { source: p.source, model: useDesign.getState().model };
  // an empty design starts on its brief
  if (!committed.model?.parts.length) useView.setState({ dockTab: "brief", dockOpen: true });
  for (const l of openListeners) l(p);
  go({ name: "workspace" });
}

export async function closeProject() {
  endPreview();
  await flushPending();
  set({ current: null, versions: [], undo: [], redo: [] });
  setImports([]);
  await refreshProjects();
  go({ name: "home" });
}

/** Change the open project's imported files and save the record. */
export async function setProjectImports(imports: ProjectImport[]) {
  const cur = get().current;
  if (!cur) return;
  set({ current: { ...cur, imports } });
  setImports(imports);
  await flushPending();
  await saveNow();
}

// analysis computed on this device (for a file from a project file or an older Kerf) is stored with the project
onImportsChanged((list, reason) => {
  const cur = get().current;
  if (reason !== "analysed" || !cur) return;
  set({ current: { ...cur, imports: list } });
  scheduleSave();
});

function scheduleSave() {
  const cur = get().current;
  if (!cur) return;
  set({ save: db.persistent ? "unsaved" : "memory" });
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveNow(), 500);
}

async function saveNow() {
  saveTimer = null;
  const cur = get().current;
  if (!cur) return;
  const source = previewBase ?? useDesign.getState().source;
  const updated: ProjectRecord = { ...cur, source, updatedAt: Date.now() };
  set({ current: updated, save: db.persistent ? "saving" : "memory" });
  try {
    await db.put("projects", updated);
    set({ save: db.persistent ? "saved" : "memory", saveError: "" });
  } catch (e) {
    set({ save: "error", saveError: errorText(e) });
    toast({ kind: "error", title: "Could not save", detail: `${errorText(e)}. Export the project to keep a copy.` }, 9000);
  }
}

async function addVersion(author: VersionRecord["author"], message: string, source: string) {
  const cur = get().current;
  if (!cur) return;
  const v: VersionRecord = { id: db.newId("ver"), projectId: cur.id, ts: Date.now(), author, message, source };
  set((s) => ({ versions: [...s.versions, v].slice(-300) }));
  try {
    await db.addVersion(v);
  } catch {
    /* the version stays in memory; saveNow reports storage problems */
  }
}

function summarise(model: Model | null, fallback: string) {
  const parts = model ? describeChange(committed.model, model) : [];
  return parts.length ? parts.slice(0, 4).join(", ") : fallback;
}

/**
 * Apply a whole new source as one undoable change with a version entry.
 * Used by the parameter panel, the AI, restore and the structure tree.
 */
export function commitSource(source: string, author: VersionRecord["author"], message?: string, opts: { undoBase?: string } = {}) {
  // a commit made while previewing builds on what was previewed; one undo goes back past both
  const base = settlePreview();
  if (base !== null && source === base) return setSource(base);
  if (typingTimer) commitTyping();
  if (source === committed.source && source === useDesign.getState().source) return useDesign.getState().model!;
  // a parallel build previews uncommitted states; undo goes back to before it started
  const prev = opts.undoBase ?? base ?? useDesign.getState().source;
  const model = setSource(source);
  set((s) => ({ undo: [...s.undo, prev].slice(-200), redo: [] }));
  void addVersion(author, message ?? summarise(model, "Edited design"), source);
  committed = { source, model };
  scheduleSave();
  adoptDesignName(model);
  return model;
}

/** A project still called "Untitled design" takes the name the design gives itself. */
function adoptDesignName(model: Model | null) {
  const cur = get().current;
  const name = model?.name?.trim();
  if (!cur || !name || cur.name !== "Untitled design" || name === cur.name) return;
  void renameProject(cur.id, name);
}

/** Live edit from the code editor: evaluate now, record a version once typing pauses. */
export function typeSource(source: string) {
  settlePreview();
  setSource(source);
  scheduleSave();
  if (typingTimer) clearTimeout(typingTimer);
  typingTimer = setTimeout(commitTyping, 1500);
}

function commitTyping() {
  if (typingTimer) clearTimeout(typingTimer);
  typingTimer = null;
  const { source, model } = useDesign.getState();
  if (source === committed.source) return;
  set((s) => ({ undo: [...s.undo, committed.source].slice(-200), redo: [] }));
  void addVersion("you", summarise(model, "Edited source"), source);
  committed = { source, model };
  adoptDesignName(model);
}

/** Something that undo and redo must wait for, such as a parallel build writing the design; returns why. */
let undoGuard: () => string | null = () => null;
export function setUndoGuard(fn: () => string | null) {
  undoGuard = fn;
}
function undoBlocked() {
  const why = undoGuard();
  if (why) toast({ kind: "info", title: why });
  return !!why;
}

export function undo() {
  // undo while previewing just ends the preview
  if (previewBase !== null) return endPreview(), true;
  if (undoBlocked()) return false;
  if (typingTimer) commitTyping();
  const { undo: u } = get();
  if (!u.length) return false;
  const prev = u[u.length - 1];
  const cur = useDesign.getState().source;
  const model = setSource(prev);
  committed = { source: prev, model };
  set((s) => ({ undo: s.undo.slice(0, -1), redo: [...s.redo, cur] }));
  scheduleSave();
  return true;
}

export function redo() {
  if (previewBase !== null) return endPreview(), true;
  if (undoBlocked()) return false;
  const { redo: r } = get();
  if (!r.length) return false;
  const next = r[r.length - 1];
  const cur = useDesign.getState().source;
  const model = setSource(next);
  committed = { source: next, model };
  set((s) => ({ redo: s.redo.slice(0, -1), undo: [...s.undo, cur] }));
  scheduleSave();
  return true;
}

export function restoreVersion(v: VersionRecord) {
  const when = new Date(v.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  commitSource(v.source, "you", `Restored the version from ${when}`);
  toast({ kind: "success", title: "Version restored", detail: "Undo brings back what you had before." });
}

// ---------- previews ----------

/**
 * Show another source in the viewport and checks without recording it. The
 * first preview remembers the real source; later ones replace the shown one.
 */
export function previewSource(preview: Preview, source: string) {
  if (typingTimer) commitTyping();
  if (previewBase === null) previewBase = useDesign.getState().source;
  set({ preview });
  setSource(source);
}

/** Return to the real source. With a key, only that preview ends. */
export function endPreview(key?: string) {
  if (previewBase === null || (key && get().preview?.key !== key)) return;
  const base = previewBase;
  previewBase = null;
  set({ preview: null });
  setSource(base);
}

/** End a preview that is only for looking (comparing with before), so an edit builds on the real design. */
export function endComparison() {
  const p = get().preview;
  if (p && !p.apply && !p.quiet) endPreview();
}

/** The real source, whether or not a preview is showing. */
export function realSource(): string {
  return previewBase ?? useDesign.getState().source;
}

/** Stop previewing and keep what is shown; returns the real source it replaced. */
function settlePreview(): string | null {
  if (previewBase === null) return null;
  const base = previewBase;
  previewBase = null;
  set({ preview: null });
  return base;
}

export async function flushPending() {
  if (typingTimer) commitTyping();
  if (saveTimer) {
    clearTimeout(saveTimer);
    await saveNow();
  }
}

export async function renameProject(id: string, name: string) {
  const clean = name.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 120);
  if (!clean) return;
  const p = await db.getOne<ProjectRecord>("projects", id);
  if (!p) return;
  const updated = { ...p, name: clean, updatedAt: Date.now() };
  await db.put("projects", updated);
  if (get().current?.id === id) set({ current: { ...get().current!, name: clean } });
  await refreshProjects();
}

export async function duplicateProject(id: string) {
  await flushPending();
  const p = await db.getOne<ProjectRecord>("projects", id);
  if (!p) return;
  const copy = await createProject(p.template, `${p.name} copy`, p.source, p.imports);
  await copyAssets(p.id, copy.id);
  if (p.thumbnail) await db.put("projects", { ...copy, thumbnail: p.thumbnail });
  await refreshProjects();
  toast({ kind: "success", title: "Project duplicated" });
}

export async function deleteProject(id: string) {
  await db.deleteProjectData(id);
  forgetRuns(id);
  if (get().current?.id === id) set({ current: null });
  for (const l of deleteListeners) l(id);
  await collectUnusedBlobs().catch(() => 0);
  await refreshProjects();
}

/**
 * The open project changed on another device (account sync). Shows the new
 * design without recording a local edit; undo goes back to what was here.
 * With no record, only the version list is reloaded.
 */
export function applyRemoteProject(p: ProjectRecord | null, id: string) {
  const cur = get().current;
  if (!cur || cur.id !== id) return;
  if (p && !typingTimer) {
    const prev = useDesign.getState().source;
    set({ current: p });
    // files imported on the other device (their bytes arrived with the project)
    const names = (l?: ProjectImport[]) => (l ?? []).map((i) => `${i.name}:${i.hash}`).join("|");
    if (names(p.imports) !== names(cur.imports)) setImports(p.imports ?? []);
    if (p.source !== prev) {
      const model = setSource(p.source);
      committed = { source: p.source, model };
      set((s) => ({ undo: [...s.undo, prev].slice(-200), redo: [] }));
      toast({ kind: "info", title: "Updated from another device", detail: "Undo brings back what was here." }, 4000);
    }
  }
  void db.versionsFor(id).then((versions) => {
    if (get().current?.id === id) set({ versions });
  });
}

/** Stored bytes of the files a set of projects import, for project files and backups. */
async function packImportFiles(imports: ProjectImport[]): Promise<{ files: PackedFile[]; missing: string[] }> {
  const files: PackedFile[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const i of imports) {
    if (seen.has(i.hash)) continue;
    seen.add(i.hash);
    const a = await getPackedBlob(i.hash);
    if (a) files.push({ hash: i.hash, encoding: a.encoding, data: toBase64(a.data) });
    else missing.push(i.file);
  }
  return { files, missing };
}

export async function exportProject(id: string) {
  await flushPending();
  const p = await db.getOne<ProjectRecord>("projects", id);
  if (!p) return;
  const versions = (await db.versionsFor(id)).map((v) => ({ ts: v.ts, author: v.author, message: v.message, source: v.source }));
  const assets = await exportAssets(id, [p.source, ...versions.map((v) => v.source)]);
  const imports = p.imports ?? [];
  const { files, missing } = await packImportFiles(imports);
  const kept = imports.filter((i) => files.some((a) => a.hash === i.hash));
  download(projectFile(p.name, p.source, p.template, p.createdAt, versions, { assets, imports: kept, importFiles: files }), safeFileName(p.name, "kerfproj"), "application/json");
  if (missing.length) toast({ kind: "warn", title: "Some imported files were left out", detail: `This browser does not have ${missing.join(", ")}.` }, 9000);
}

/** Imports a file; returns the project to open when the file held exactly one. */
export async function importProject(file: File): Promise<ProjectRecord | null> {
  try {
    const { projects: imported, files, warnings } = await readImportFile(file);
    for (const [hash, data] of files) await putBlob(hash, data);
    if (warnings.length) toast({ kind: "warn", title: "Part of the file could not be used", detail: [...new Set(warnings)].slice(0, 3).join(" ") }, 9000);
    let last: ProjectRecord | null = null;
    for (const imp of imported) {
      last = await createProject("imported", imp.name, imp.source, imp.imports);
      if (imp.template !== "imported") await db.put("projects", { ...last, template: imp.template });
      for (const v of imp.versions) await db.addVersion({ id: db.newId("ver"), projectId: last.id, ts: v.ts, author: v.author, message: v.message, source: v.source });
      await importAssets(last.id, imp.assets);
    }
    await refreshProjects();
    if (imported.length === 1) {
      toast({ kind: "success", title: `Imported “${imported[0].name}”` });
      return last;
    }
    toast({ kind: "success", title: `Imported ${imported.length} projects` });
    return null;
  } catch (e) {
    toast({ kind: "error", title: "Import failed", detail: errorText(e) }, 9000);
    return null;
  }
}

/** Downloads every project, with its history, as one backup file. */
export async function exportAllProjects() {
  await flushPending();
  const projects = await db.getAll<ProjectRecord>("projects");
  if (!projects.length) return toast({ kind: "warn", title: "No projects to back up" });
  const files: ProjectFile[] = [];
  const { files: importFiles } = await packImportFiles(projects.flatMap((p) => p.imports ?? []));
  const have = new Set(importFiles.map((a) => a.hash));
  for (const p of projects) {
    const versions = (await db.versionsFor(p.id)).map((v) => ({ ts: v.ts, author: v.author, message: v.message, source: v.source }));
    const assets = await exportAssets(p.id, [p.source, ...versions.map((v) => v.source)]);
    const imports = (p.imports ?? []).filter((i) => have.has(i.hash));
    files.push({ format: "kerf-project", version: imports.length ? 2 : 1, name: p.name, source: p.source, template: p.template, createdAt: p.createdAt, versions, ...(assets.length ? { assets } : {}), ...(imports.length ? { imports } : {}) });
  }
  const stamp = new Date().toISOString().slice(0, 10);
  download(backupFile(files, importFiles), `kerf-backup-${stamp}.kerfbackup`, "application/json");
  toast({ kind: "success", title: "Backup downloaded", detail: `${files.length} project${files.length > 1 ? "s" : ""} with their history. Import the file on any browser to restore them.` });
}

export async function saveThumbnail(dataUrl: string) {
  const cur = get().current;
  if (!cur || dataUrl.length > 400_000) return;
  const p = await db.getOne<ProjectRecord>("projects", cur.id);
  if (!p) return;
  // keep the in-memory record in step so the next autosave does not drop it
  if (get().current?.id === cur.id) set({ current: { ...get().current!, thumbnail: dataUrl } });
  await db.put("projects", { ...p, source: get().current?.source ?? p.source, thumbnail: dataUrl });
}

export async function clearAllData() {
  await db.clearEverything();
  forgetAllRuns();
  setImports([]);
  set({ projects: [], current: null, versions: [], undo: [], redo: [] });
}
