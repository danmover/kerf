// Keeps this browser's projects in step with the signed-in account.
//
// The browser stays the working copy: Kerf saves to IndexedDB as before and
// works offline. This module pushes changed projects, their new versions and
// chats to the server, and pulls what other devices changed. When two devices
// edit the same project, the device that is pushing keeps its design as the
// current one and the other device's design is kept in the version history, so
// nothing is lost.

import { create } from "zustand";
import * as db from "../persist/db";
import type { ProjectRecord, VersionRecord, ChatRecord } from "../persist/db";
import { api, ApiError, type RemoteProject, type RemoteProjectSummary, type RemoteVersion } from "./api";
import { onAccount, sessionEnded, useAccount } from "./account";
import { applyRemoteProject, closeProject, onProjectDeleted, onProjectOpen, refreshProjects, useProject } from "../app/project";
import { loadChat, resetChat, useChat } from "../ai/chat";
import { toast } from "../app/ui";

type SyncedVersion = VersionRecord & { synced?: boolean };

interface ProjectMeta {
  /** the server revision this browser last matched */
  rev: number;
  /** the local updatedAt at that point; a different value means unsent edits */
  at: number;
  /** a fingerprint of the thumbnail that was sent */
  thumb: string;
  /** the chat's updatedAt that was last sent or received */
  chatAt: number;
  /** new versions may be waiting to be sent */
  vdirty?: boolean;
  /** a hash of the design as last sent or received, to tell real remote edits from thumbnail updates */
  src?: string;
}

interface Meta {
  account: string | null;
  /** when this account was first used here; older local projects wait for the user's say before uploading */
  since: number;
  projects: Record<string, ProjectMeta>;
  /** cloud projects deleted here that the server has not confirmed yet */
  deleted: string[];
  /** projects the user chose to keep only in this browser */
  localOnly: string[];
  /** new projects go to the account automatically */
  autoUpload: boolean;
}

export type SyncState = "off" | "idle" | "syncing" | "offline" | "error";

interface SyncUi {
  state: SyncState;
  message: string;
  lastSync: number;
  /** ids of projects kept in the account */
  cloud: string[];
  /** projects in this browser that are not in the account and wait for a decision */
  waiting: number;
  autoUpload: boolean;
}

export const useSync = create<SyncUi>(() => ({ state: "off", message: "", lastSync: 0, cloud: [], waiting: 0, autoUpload: true }));

const KEY = "kerf.sync.v1";
const CHUNK = 100;
const freshMeta = (account: string | null): Meta => ({ account, since: Date.now(), projects: {}, deleted: [], localOnly: [], autoUpload: true });

function loadMeta(): Meta {
  try {
    const m = JSON.parse(localStorage.getItem(KEY) ?? "null") as Meta | null;
    if (m && typeof m === "object" && m.projects && Array.isArray(m.deleted)) return { ...freshMeta(m.account ?? null), ...m, localOnly: Array.isArray(m.localOnly) ? m.localOnly : [] };
  } catch {
    /* unreadable: start over */
  }
  return freshMeta(null);
}
let meta = loadMeta();
function saveMeta() {
  try {
    localStorage.setItem(KEY, JSON.stringify(meta));
  } catch {
    /* storage blocked: sync state lasts for this session */
  }
}

const thumbSig = (t?: string) => (t ? `${t.length}:${t.slice(-24)}` : "");
/** FNV-1a: a short fingerprint of a design's source. */
function srcHash(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return `${s.length}:${(h >>> 0).toString(16)}`;
}
const signedInId = () => {
  const s = useAccount.getState();
  return s.status === "signed-in" ? (s.info?.user?.id ?? null) : null;
};

function publish(waiting?: number) {
  useSync.setState((s) => ({ cloud: Object.keys(meta.projects), autoUpload: meta.autoUpload, waiting: waiting ?? s.waiting }));
}

// ---------- one sync pass ----------

let running: Promise<void> | null = null;
let again = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let changedHere = false;

export function syncSoon(ms = 1500) {
  if (!signedInId()) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void syncNow();
  }, ms);
}

export function syncNow(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        await pass();
      } while (again);
    } finally {
      running = null;
    }
  })();
  return running;
}

async function pass() {
  const userId = signedInId();
  if (!userId) {
    useSync.setState({ state: "off", message: "" });
    return;
  }
  if (meta.account !== userId) {
    meta = freshMeta(userId);
    saveMeta();
  }
  useSync.setState({ state: "syncing", message: "" });
  changedHere = false;
  try {
    for (const id of [...meta.deleted]) {
      await api("DELETE", `/projects/${encodeURIComponent(id)}`);
      meta.deleted = meta.deleted.filter((d) => d !== id);
    }

    const { projects: remote } = await api<{ projects: RemoteProjectSummary[] }>("GET", "/projects");
    let locals = new Map((await db.getAll<ProjectRecord>("projects")).map((p) => [p.id, p]));

    for (const r of remote) {
      const local = locals.get(r.id);
      let m = meta.projects[r.id];
      if (r.deletedAt) {
        if (m && local) {
          if (editedHere(local, m)) {
            // edited here after another device deleted it: keep the work by bringing it back
            m.rev = r.rev;
            await markAllUnsynced(r.id);
            await push(local, m);
          } else await removeLocal(local, "deleted on another device");
        }
        delete meta.projects[r.id];
        continue;
      }
      if (meta.localOnly.includes(r.id)) continue;
      if (!local) {
        await download(r.id, null);
        continue;
      }
      if (!m) m = meta.projects[r.id] = { rev: 0, at: -1, thumb: "", chatAt: 0 };
      if (r.rev > m.rev) {
        // a new thumbnail alone doesn't count as an edit: the other device's design wins
        if (editedHere(local, m)) await merge(local, m);
        else await download(r.id, local);
      }
      if (r.chatUpdatedAt && r.chatUpdatedAt > meta.projects[r.id]!.chatAt) await pullChat(r.id, meta.projects[r.id]!);
    }

    locals = new Map((await db.getAll<ProjectRecord>("projects")).map((p) => [p.id, p]));
    const onServer = new Set(remote.filter((r) => !r.deletedAt).map((r) => r.id));
    let waiting = 0;
    for (const local of locals.values()) {
      let m = meta.projects[local.id];
      if (!m) {
        if (meta.localOnly.includes(local.id)) continue;
        if (!meta.autoUpload || local.createdAt < meta.since) {
          waiting++;
          continue;
        }
        m = meta.projects[local.id] = { rev: 0, at: -1, thumb: "", chatAt: 0 };
      }
      if (!onServer.has(local.id) && m.rev > 0) {
        // the server no longer has it (an old deletion was purged): send it again in full
        m.rev = 0;
        await markAllUnsynced(local.id);
      }
      if (await isDirty(local, m)) await push(local, m);
      await pushChat(local.id, m);
    }
    // forget projects that are gone from this browser
    for (const id of Object.keys(meta.projects)) if (!locals.has(id)) delete meta.projects[id];
    meta.localOnly = meta.localOnly.filter((id) => locals.has(id));
    publish(waiting);
    useSync.setState({ state: "idle", message: "", lastSync: Date.now() });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      useSync.setState({ state: "off", message: "" });
      sessionEnded();
    } else if (e instanceof ApiError && e.status === 0) useSync.setState({ state: "offline", message: e.message });
    else useSync.setState({ state: "error", message: e instanceof Error ? e.message : String(e) });
  } finally {
    saveMeta();
    publish();
    if (changedHere) await refreshProjects();
  }
}

/** The design or its name changed here since the last sync. */
function editedHere(local: ProjectRecord, m: ProjectMeta) {
  return local.updatedAt !== m.at || m.rev === 0 || !!m.vdirty;
}

/** Anything to send, including a new thumbnail. */
async function isDirty(local: ProjectRecord, m: ProjectMeta) {
  return editedHere(local, m) || thumbSig(local.thumbnail) !== m.thumb;
}

async function markAllUnsynced(projectId: string) {
  for (const v of (await db.versionsFor(projectId)) as SyncedVersion[]) if (v.synced) await db.put("versions", { ...v, synced: false });
}

const wire = (v: VersionRecord): RemoteVersion => ({ id: v.id, ts: v.ts, author: v.author, message: v.message.slice(0, 2000), source: v.source });

/** The fields the server knows about; any others a project gains (such as imported files) travel as `extra`. */
const CORE = new Set(["id", "name", "source", "template", "createdAt", "updatedAt", "thumbnail"]);
const extraOf = (p: ProjectRecord): Record<string, unknown> => Object.fromEntries(Object.entries(p).filter(([k, v]) => !CORE.has(k) && v !== undefined));

async function push(local: ProjectRecord, m: ProjectMeta, depth = 0): Promise<void> {
  const pending = ((await db.versionsFor(local.id)) as SyncedVersion[]).filter((v) => !v.synced);
  const headChanged = m.rev === 0 || local.updatedAt !== m.at || thumbSig(local.thumbnail) !== m.thumb;
  if (!headChanged && !pending.length) {
    m.vdirty = false;
    return;
  }
  let rev = m.rev;
  const chunks: SyncedVersion[][] = [];
  for (let i = 0; i < pending.length; i += CHUNK) chunks.push(pending.slice(i, i + CHUNK));
  if (!chunks.length) chunks.push([]);
  for (let i = 0; i < chunks.length; i++) {
    const body: Record<string, unknown> = { baseRev: rev, versions: chunks[i].map(wire) };
    if (i === 0) Object.assign(body, { name: local.name, source: local.source, template: local.template, createdAt: local.createdAt, updatedAt: local.updatedAt, thumbnail: local.thumbnail ?? null, extra: extraOf(local) });
    try {
      rev = (await api<{ rev: number }>("PUT", `/projects/${encodeURIComponent(local.id)}`, body)).rev;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && depth < 2) {
        const current = (e.body as { project?: RemoteProject | null }).project;
        if (current === null) {
          // the server lost it: start over from revision 0
          m.rev = 0;
          await markAllUnsynced(local.id);
          return push((await db.getOne<ProjectRecord>("projects", local.id)) ?? local, m, depth + 1);
        }
        return merge((await db.getOne<ProjectRecord>("projects", local.id)) ?? local, m, depth + 1);
      }
      throw e;
    }
    for (const v of chunks[i]) await db.put("versions", { ...v, synced: true });
  }
  m.rev = rev;
  m.at = local.updatedAt;
  m.thumb = thumbSig(local.thumbnail);
  m.vdirty = false;
  m.src = srcHash(local.source);
}

/** Both sides changed: take the other device's history, keep this device's design current, then send it. */
async function merge(local: ProjectRecord, m: ProjectMeta, depth = 0) {
  const { project, versions } = await api<{ project: RemoteProject; versions: RemoteVersion[] }>("GET", `/projects/${encodeURIComponent(local.id)}?since=${m.rev}`);
  if (project.deletedAt) {
    m.rev = project.rev;
    await markAllUnsynced(local.id);
    return push(local, m, depth + 1);
  }
  const have = new Set((await db.versionsFor(local.id)).map((v) => v.id));
  for (const v of versions) if (!have.has(v.id)) await db.put("versions", { ...v, projectId: local.id, synced: true });
  // the other device really changed the design (not just its thumbnail or name)
  const changedThere = project.source !== local.source && srcHash(project.source) !== m.src;
  if (changedThere && !versions.some((v) => v.source === project.source)) {
    await db.put("versions", { id: db.newId("ver"), projectId: local.id, ts: project.updatedAt, author: "system", message: "The design as it was on another device", source: project.source, synced: false });
  }
  m.rev = project.rev;
  m.vdirty = true;
  if (changedThere) {
    toast({ kind: "info", title: `“${local.name}” also changed on another device`, detail: "Kerf kept the design open here. The other device's version is in the history if you want it." }, 9000);
  }
  if (useProject.getState().current?.id === local.id) applyRemoteProject(null, local.id);
  await push(local, m, depth + 1);
}

async function download(id: string, local: ProjectRecord | null) {
  const m = meta.projects[id];
  const { project, versions } = await api<{ project: RemoteProject; versions: RemoteVersion[] }>("GET", `/projects/${encodeURIComponent(id)}?since=${local && m ? m.rev : 0}`);
  const have = new Set((await db.versionsFor(id)).map((v) => v.id));
  for (const v of versions) if (!have.has(v.id)) await db.put("versions", { ...v, projectId: id, synced: true });
  await pruneVersions(id);

  // an edit may have landed here while this was downloading; the next pass merges it
  const now = await db.getOne<ProjectRecord>("projects", id);
  if (local && now && now.updatedAt !== local.updatedAt) {
    again = true;
    return;
  }
  const rec = { ...(project.extra ?? {}), id, name: project.name, source: project.source, template: project.template, createdAt: project.createdAt, updatedAt: project.updatedAt } as ProjectRecord;
  if (project.thumbnail) rec.thumbnail = project.thumbnail;
  await db.put("projects", rec);
  meta.projects[id] = { rev: project.rev, at: rec.updatedAt, thumb: thumbSig(rec.thumbnail), chatAt: m?.chatAt ?? 0, src: srcHash(rec.source) };
  changedHere = true;
  if (useProject.getState().current?.id === id) applyRemoteProject(rec, id);
}

async function pruneVersions(id: string) {
  const all = await db.versionsFor(id);
  for (const old of all.slice(0, Math.max(0, all.length - 300))) await db.remove("versions", old.id);
}

async function removeLocal(local: ProjectRecord, why: string) {
  if (useProject.getState().current?.id === local.id) {
    await closeProject();
    toast({ kind: "info", title: `“${local.name}” was ${why}` });
  }
  if (useChat.getState().projectId === local.id) resetChat();
  await db.deleteProjectData(local.id);
  changedHere = true;
}

// ---------- chats ----------

const chatBusy = (id: string) => useChat.getState().projectId === id && (useChat.getState().busy || !!useChat.getState().pendingChoice);

async function pushChat(id: string, m: ProjectMeta) {
  if (chatBusy(id)) return;
  const rec = await db.getOne<ChatRecord>("chats", id);
  if (!rec || rec.updatedAt <= m.chatAt) return;
  // the whole record travels, so fields the chat keeps (such as what its history is bound to) arrive intact
  const { projectId: _id, updatedAt, ...data } = rec;
  try {
    const r = await api<{ updatedAt: number }>("PUT", `/projects/${encodeURIComponent(id)}/chat`, { updatedAt, data });
    m.chatAt = r.updatedAt;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 413 || e.status === 400)) m.chatAt = rec.updatedAt;
    else throw e;
  }
}

async function pullChat(id: string, m: ProjectMeta) {
  if (chatBusy(id)) return;
  const local = await db.getOne<ChatRecord>("chats", id);
  const { data, updatedAt } = await api<{ data: Omit<ChatRecord, "projectId" | "updatedAt">; updatedAt: number }>("GET", `/projects/${encodeURIComponent(id)}/chat`);
  if (local && local.updatedAt > updatedAt) return;
  await db.put<ChatRecord>("chats", { ...data, projectId: id, updatedAt });
  m.chatAt = updatedAt;
  if (useChat.getState().projectId === id && !chatBusy(id)) await loadChat(id);
}

// ---------- decisions the user makes ----------

/** Send this browser's older projects to the account (all of them, or the listed ones). */
export function uploadToAccount(ids?: string[]) {
  void db.getAll<ProjectRecord>("projects").then((all) => {
    for (const p of all) {
      if (ids && !ids.includes(p.id)) continue;
      if (!meta.projects[p.id]) meta.projects[p.id] = { rev: 0, at: -1, thumb: "", chatAt: 0 };
      meta.localOnly = meta.localOnly.filter((x) => x !== p.id);
    }
    saveMeta();
    publish();
    void syncNow();
  });
}

/** Keep these projects only in this browser; the account copy is removed. */
export function keepOnThisDevice(ids: string[]) {
  for (const id of ids) {
    if (meta.projects[id] && !meta.deleted.includes(id)) meta.deleted.push(id);
    delete meta.projects[id];
    if (!meta.localOnly.includes(id)) meta.localOnly.push(id);
  }
  saveMeta();
  publish();
  void syncNow();
}

/** Projects waiting for a decision stay in this browser without being asked about again. */
export function keepWaitingLocal() {
  void db.getAll<ProjectRecord>("projects").then((all) => {
    for (const p of all) if (!meta.projects[p.id] && !meta.localOnly.includes(p.id)) meta.localOnly.push(p.id);
    saveMeta();
    publish(0);
  });
}

export function setAutoUpload(on: boolean) {
  meta.autoUpload = on;
  // turning it on applies to projects made from now on
  if (on) meta.since = Math.max(meta.since, Date.now());
  saveMeta();
  publish();
}

// ---------- wiring ----------

let started = false;

export function startSync() {
  if (started) return;
  started = true;
  publish();

  onAccount({
    signedIn: (userId) => {
      if (meta.account !== userId) {
        meta = freshMeta(userId);
        saveMeta();
        publish(0);
      }
      void syncNow();
    },
    beforeSignOut: async (removeLocal) => {
      await syncNow().catch(() => undefined);
      const kept: string[] = [];
      if (removeLocal) {
        const all = await db.getAll<ProjectRecord>("projects");
        for (const p of all) {
          const m = meta.projects[p.id];
          if (!m) continue;
          if (editedHere(p, m)) kept.push(p.name);
          else await removeLocal_(p);
        }
        await refreshProjects();
      }
      meta = freshMeta(null);
      saveMeta();
      publish(0);
      useSync.setState({ state: "off", message: "" });
      if (kept.length) toast({ kind: "warn", title: `Kept ${kept.length} project${kept.length > 1 ? "s" : ""} on this device`, detail: `${kept.join(", ")} had changes that hadn't reached your account yet. ${kept.length > 1 ? "They are" : "It is"} now only in this browser.` }, 12000);
    },
  });

  // a deleted cloud project is deleted from the account too
  onProjectDeleted((id) => {
    if (meta.projects[id]) {
      delete meta.projects[id];
      if (!meta.deleted.includes(id)) meta.deleted.push(id);
      saveMeta();
      publish();
      syncSoon(300);
    }
  });

  // local edits: send them shortly after they are saved
  useProject.subscribe((s, prev) => {
    if (s.save === "saved" && prev.save !== "saved") syncSoon(1500);
    if (s.current && prev.current?.id === s.current.id && s.versions !== prev.versions && meta.projects[s.current.id]) {
      // only versions made here need sending; ones that came from the account are marked synced
      const before = new Set(prev.versions.map((v) => v.id));
      if (s.versions.some((v) => !before.has(v.id) && !(v as SyncedVersion).synced)) {
        meta.projects[s.current.id].vdirty = true;
        syncSoon(1500);
      }
    }
    if (s.projects !== prev.projects) syncSoon(2500);
  });
  useChat.subscribe((s, prev) => {
    if (s.items !== prev.items && !s.busy) syncSoon(1500);
  });
  // opening a project fetches anything newer, such as a chat continued elsewhere
  onProjectOpen((p) => {
    if (meta.projects[p.id]) syncSoon(100);
  });
  useAccount.subscribe((s, prev) => {
    if (s.status === "signed-in" && prev.status !== "signed-in") syncSoon(50);
    if (s.status !== "signed-in" && prev.status === "signed-in") useSync.setState({ state: "off" });
  });
  const wake = () => document.visibilityState === "visible" && syncSoon(300);
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("online", wake);
  window.addEventListener("focus", wake);
  setInterval(() => {
    if (document.visibilityState === "visible") syncSoon(0);
  }, 30_000);
  if (signedInId()) syncSoon(50);
}

const removeLocal_ = (p: ProjectRecord) => removeLocal(p, "removed");
