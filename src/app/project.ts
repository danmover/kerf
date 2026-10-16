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
import { backupFile, download, projectFile, readImport, safeFileName, type ProjectFile } from "../persist/files";
import { go, toast, errorText } from "./ui";
import { resetView } from "./view";

export type SaveState = "saved" | "saving" | "unsaved" | "error" | "memory";

interface ProjectState {
  projects: ProjectRecord[];
  loaded: boolean;
  current: ProjectRecord | null;
  versions: VersionRecord[];
  undo: string[];
  redo: string[];
  save: SaveState;
  saveError: string;
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
}));

const get = useProject.getState;
const set = useProject.setState;

/** last committed source and its model, the base for the next version's summary */
let committed: { source: string; model: Model | null } = { source: "", model: null };
let typingTimer: ReturnType<typeof setTimeout> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const openListeners = new Set<(p: ProjectRecord) => void>();
export const onProjectOpen = (fn: (p: ProjectRecord) => void) => {
  openListeners.add(fn);
  return () => openListeners.delete(fn);
};

export async function refreshProjects() {
  const persistent = await db.ensureOpen();
  const projects = (await db.getAll<ProjectRecord>("projects")).sort((a, b) => b.updatedAt - a.updatedAt);
  set({ projects, loaded: true, save: persistent ? get().save : "memory" });
}

export async function createProject(templateId: string, name?: string, source?: string): Promise<ProjectRecord> {
  const t = templateById(templateId);
  const src = source ?? t?.source ?? "";
  const now = Date.now();
  const nameFromSrc = /design\s+"([^"]{1,120})"/.exec(src)?.[1];
  const p: ProjectRecord = { id: db.newId("prj"), name: name ?? (templateId === "blank" ? "Untitled design" : nameFromSrc ?? t?.name ?? "Untitled design"), source: src, template: templateId, createdAt: now, updatedAt: now };
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
  set({ current: p, versions, undo: [], redo: [], save: db.persistent ? "saved" : "memory" });
  loadSource(p.source);
  committed = { source: p.source, model: useDesign.getState().model };
  for (const l of openListeners) l(p);
  go({ name: "workspace" });
}

export async function closeProject() {
  await flushPending();
  set({ current: null, versions: [], undo: [], redo: [] });
  await refreshProjects();
  go({ name: "home" });
}

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
  const source = useDesign.getState().source;
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
export function commitSource(source: string, author: VersionRecord["author"], message?: string) {
  if (typingTimer) commitTyping();
  if (source === committed.source && source === useDesign.getState().source) return useDesign.getState().model!;
  const prev = useDesign.getState().source;
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

export function undo() {
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
  const copy = await createProject(p.template, `${p.name} copy`, p.source);
  if (p.thumbnail) await db.put("projects", { ...copy, thumbnail: p.thumbnail });
  await refreshProjects();
  toast({ kind: "success", title: "Project duplicated" });
}

export async function deleteProject(id: string) {
  await db.deleteProjectData(id);
  if (get().current?.id === id) set({ current: null });
  await refreshProjects();
}

export async function exportProject(id: string) {
  await flushPending();
  const p = await db.getOne<ProjectRecord>("projects", id);
  if (!p) return;
  const versions = (await db.versionsFor(id)).map((v) => ({ ts: v.ts, author: v.author, message: v.message, source: v.source }));
  download(projectFile(p.name, p.source, p.template, p.createdAt, versions), safeFileName(p.name, "kerfproj"), "application/json");
}

/** Imports a file; returns the project to open when the file held exactly one. */
export async function importProject(file: File): Promise<ProjectRecord | null> {
  try {
    const imported = await readImport(file);
    let last: ProjectRecord | null = null;
    for (const imp of imported) {
      last = await createProject("imported", imp.name, imp.source);
      if (imp.template !== "imported") await db.put("projects", { ...last, template: imp.template });
      for (const v of imp.versions) await db.addVersion({ id: db.newId("ver"), projectId: last.id, ts: v.ts, author: v.author, message: v.message, source: v.source });
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
  for (const p of projects) {
    const versions = (await db.versionsFor(p.id)).map((v) => ({ ts: v.ts, author: v.author, message: v.message, source: v.source }));
    files.push({ format: "kerf-project", version: 1, name: p.name, source: p.source, template: p.template, createdAt: p.createdAt, versions });
  }
  const stamp = new Date().toISOString().slice(0, 10);
  download(backupFile(files), `kerf-backup-${stamp}.kerfbackup`, "application/json");
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
  set({ projects: [], current: null, versions: [], undo: [], redo: [] });
}
