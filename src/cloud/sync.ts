// Keeps this browser's projects in step with the signed-in account.
//
// The browser stays the working copy: Kerf saves to IndexedDB as before and
// works offline. This module pushes changed projects, their new versions,
// chats and the files they use (imported STEP files, reference images) to the
// server, and pulls what other devices changed. When two devices
// edit the same project, the device that is pushing keeps its design as the
// current one and the other device's design is kept in the version history, so
// nothing is lost.

import { create } from "zustand";
import * as db from "../persist/db";
import type { AssetRecord, BlobRecord, ProjectRecord, VersionRecord, ChatRecord } from "../persist/db";
import { collectUnusedBlobs, gunzip, sha256Hex } from "../persist/blobs";
import { onAssetAdded } from "../persist/assets";
import type { ProjectImport } from "../kernel/imports";
import { retryMissingImports } from "../core/imports";
import { api, ApiError, getFile, putFile, type RemoteProject, type RemoteProjectSummary, type RemoteVersion, type StoredFile } from "./api";
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
  /** the server refused the chat last time it was sent (the user has been told) */
  chatRefused?: boolean;
  /** new versions may be waiting to be sent */
  vdirty?: boolean;
  /** a hash of the design as last sent or received, to tell real remote edits from thumbnail updates */
  src?: string;
  /** a reference file was added here and the account's list of them needs sending */
  adirty?: boolean;
  /** files the project uses weren't in the account yet when it arrived; when they were last looked for */
  filesPending?: number;
  /** the server refused this version of the project (its updatedAt); it is tried again once it changes */
  refused?: number;
  /** what the server said when it refused it */
  refusedWhy?: string;
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
  /** projects whose latest version the server refused, with what it said */
  refused: Record<string, string>;
  /** projects in this browser that are not in the account and wait for a decision */
  waiting: number;
  autoUpload: boolean;
}

export const useSync = create<SyncUi>(() => ({ state: "off", message: "", lastSync: 0, cloud: [], refused: {}, waiting: 0, autoUpload: true }));

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
  const refused = Object.fromEntries(Object.entries(meta.projects).flatMap(([id, m]) => (m.refused !== undefined ? [[id, m.refusedWhy ?? ""]] : [])));
  useSync.setState((s) => ({ cloud: Object.keys(meta.projects), refused, autoUpload: meta.autoUpload, waiting: waiting ?? s.waiting }));
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
            await pushProject(local, m);
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
        if (editedHere(local, m)) await pushProject(local, m, true);
        else await download(r.id, local);
      }
      if (r.chatUpdatedAt && r.chatUpdatedAt > meta.projects[r.id]!.chatAt) await pullChat(r.id, meta.projects[r.id]!);
    }

    locals = new Map((await db.getAll<ProjectRecord>("projects")).map((p) => [p.id, p]));
    for (const [id, m] of Object.entries(meta.projects)) if (m.filesPending && locals.has(id) && Date.now() - m.filesPending > FILE_RETRY) await retryFiles(id, m);
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
      if (await isDirty(local, m)) await pushProject(local, m);
      // a chat needs its project on the server first
      if (m.rev > 0) await pushChat(local, m);
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

/** Anything to send, including a new thumbnail or reference file. */
async function isDirty(local: ProjectRecord, m: ProjectMeta) {
  return editedHere(local, m) || thumbSig(local.thumbnail) !== m.thumb || !!m.adirty;
}

async function markAllUnsynced(projectId: string) {
  for (const v of (await db.versionsFor(projectId)) as SyncedVersion[]) if (v.synced) await db.put("versions", { ...v, synced: false });
}

const wire = (v: VersionRecord): RemoteVersion => ({ id: v.id, ts: v.ts, author: v.author, message: v.message.slice(0, 2000), source: v.source });

/** The server won't take this as it is (too large, or not valid); a full account is about every project, so it isn't one of these. */
const refusal = (e: unknown): e is ApiError => e instanceof ApiError && (e.status === 400 || (e.status === 413 && e.code !== "quota"));

/**
 * Sends one project, or merges it with a newer revision from another device
 * and sends the result. If the server refuses it, the other projects carry on:
 * this one stays in this browser until it changes.
 */
async function pushProject(local: ProjectRecord, m: ProjectMeta, mergeFirst = false) {
  // a refused version isn't sent again, but another device's changes are still taken in
  if (!mergeFirst && m.refused === local.updatedAt) return;
  try {
    await (mergeFirst ? merge(local, m) : push(local, m));
    m.refused = m.refusedWhy = undefined;
  } catch (e) {
    if (!refusal(e)) throw e;
    if (m.refused !== local.updatedAt) toast({ kind: "warn", title: `“${local.name}” isn't syncing`, detail: `${e.message} It stays in this browser, and Kerf tries again after your next change to it. Your other projects keep syncing.` }, 12000);
    m.refused = local.updatedAt;
    m.refusedWhy = e.message;
  }
}

/** The fields the server knows about; any others a project gains (such as imported files) travel as `extra`. */
const CORE = new Set(["id", "name", "source", "template", "createdAt", "updatedAt", "thumbnail"]);
const extraOf = (p: ProjectRecord): Record<string, unknown> => Object.fromEntries(Object.entries(p).filter(([k, v]) => !CORE.has(k) && v !== undefined));

async function push(local: ProjectRecord, m: ProjectMeta, depth = 0): Promise<void> {
  // a reference file added while this runs is sent by the next pass
  const filesAdded = !!m.adirty;
  m.adirty = false;
  try {
    await pushOnce(local, m, depth, filesAdded);
  } catch (e) {
    if (filesAdded) m.adirty = true;
    throw e;
  }
}

async function pushOnce(local: ProjectRecord, m: ProjectMeta, depth: number, filesAdded: boolean): Promise<void> {
  const pending = ((await db.versionsFor(local.id)) as SyncedVersion[]).filter((v) => !v.synced);
  const headChanged = m.rev === 0 || local.updatedAt !== m.at || thumbSig(local.thumbnail) !== m.thumb || filesAdded;
  if (!headChanged && !pending.length) {
    m.vdirty = false;
    return;
  }
  let rev = m.rev;
  const chunks: SyncedVersion[][] = [];
  for (let i = 0; i < pending.length; i += CHUNK) chunks.push(pending.slice(i, i + CHUNK));
  if (!chunks.length) chunks.push([]);
  // the files go first, so a device that sees the new revision can fetch them
  const assets = await sendFiles(local);
  for (let i = 0; i < chunks.length; i++) {
    const body: Record<string, unknown> = { baseRev: rev, versions: chunks[i].map(wire) };
    if (i === 0) Object.assign(body, { name: local.name, source: local.source, template: local.template, createdAt: local.createdAt, updatedAt: local.updatedAt, thumbnail: local.thumbnail ?? null, extra: { ...extraOf(local), ...(assets.length ? { assets } : {}) } });
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
  // reference files added there stay with the project (this device's list is sent next)
  if (!(await fetchFiles(local.id, [], filesOf(project.extra).assets))) m.filesPending = Date.now();
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
  // the files first, so the design builds with them when it opens
  const files = filesOf(project.extra);
  const complete = await fetchFiles(id, files.imports, files.assets);

  // an edit may have landed here while this was downloading; the next pass merges it
  const now = await db.getOne<ProjectRecord>("projects", id);
  if (local && now && now.updatedAt !== local.updatedAt) {
    again = true;
    return;
  }
  const { assets: _list, ...fields } = project.extra ?? {};
  const rec = { ...fields, id, name: project.name, source: project.source, template: project.template, createdAt: project.createdAt, updatedAt: project.updatedAt } as ProjectRecord;
  if (project.thumbnail) rec.thumbnail = project.thumbnail;
  await db.put("projects", rec);
  meta.projects[id] = { rev: project.rev, at: rec.updatedAt, thumb: thumbSig(rec.thumbnail), chatAt: m?.chatAt ?? 0, src: srcHash(rec.source), adirty: m?.adirty, filesPending: complete ? undefined : Date.now() };
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
  // imported files no other project here uses go too
  await collectUnusedBlobs().catch(() => 0);
  changedHere = true;
}

// ---------- files: imported STEP files and reference images ----------

/** How often to look again for files another device hasn't sent yet. */
const FILE_RETRY = 5 * 60_000;

/** A reference image or PDF as the account lists it with the project; its bytes and thumbnail are stored files. */
interface SyncedAsset {
  id: string;
  kind: "image" | "pdf";
  mime: string;
  name: string;
  size: number;
  width?: number;
  height?: number;
  createdAt: number;
  hash: string;
  thumb?: string;
}

const HASH = /^[a-f0-9]{64}$/;
const MIMES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const validAsset = (a: SyncedAsset) =>
  !!a && typeof a === "object" && /^ast_[a-z0-9]{4,32}$/.test(a.id) && (a.kind === "image" || a.kind === "pdf") && MIMES.has(a.mime) && (a.kind === "pdf") === (a.mime === "application/pdf") && typeof a.name === "string" && HASH.test(a.hash) && (a.thumb === undefined || HASH.test(a.thumb));

/** The files a project's account record says it uses. */
function filesOf(extra: Record<string, unknown> | undefined): { imports: ProjectImport[]; assets: SyncedAsset[] } {
  const imports = Array.isArray(extra?.imports) ? (extra.imports as ProjectImport[]).filter((i) => i && typeof i === "object" && HASH.test(i.hash)) : [];
  const assets = Array.isArray(extra?.assets) ? (extra.assets as SyncedAsset[]).filter(validAsset) : [];
  return { imports, assets };
}

// hashing a reference file once per session is enough: its contents never change
const assetHashes = new Map<string, string>();
async function hashOf(a: AssetRecord, variant: "data" | "thumb", blob: Blob) {
  const key = `${a.key}:${variant}:${a.createdAt}:${blob.size}`;
  let h = assetHashes.get(key);
  if (!h) assetHashes.set(key, (h = await sha256Hex(new Uint8Array(await blob.arrayBuffer()))));
  return h;
}

const rawFile = async (b: Blob): Promise<StoredFile> => ({ data: new Uint8Array(await b.arrayBuffer()), encoding: "raw", size: b.size });

/** Sends the files a project uses that the account doesn't have yet, and returns its list of reference files. */
async function sendFiles(local: ProjectRecord): Promise<SyncedAsset[]> {
  const sources = new Map<string, () => Promise<StoredFile | null>>();
  for (const i of local.imports ?? []) {
    sources.set(i.hash, async () => {
      const b = await db.getOne<BlobRecord>("blobs", i.hash);
      return b ? { data: new Uint8Array(b.data), encoding: b.encoding, size: b.size } : null;
    });
  }
  const assets: SyncedAsset[] = [];
  for (const a of await db.assetsFor(local.id)) {
    const hash = await hashOf(a, "data", a.data);
    const thumb = a.thumb ? await hashOf(a, "thumb", a.thumb) : undefined;
    assets.push({ id: a.id, kind: a.kind, mime: a.mime, name: a.name, size: a.size, width: a.width, height: a.height, createdAt: a.createdAt, hash, ...(thumb ? { thumb } : {}) });
    sources.set(hash, () => rawFile(a.data));
    if (a.thumb && thumb) sources.set(thumb, () => rawFile(a.thumb!));
  }
  const hashes = [...sources.keys()];
  for (let i = 0; i < hashes.length; i += 500) {
    const { missing } = await api<{ missing: string[] }>("POST", "/files/missing", { hashes: hashes.slice(i, i + 500) });
    for (const h of missing) {
      const f = await sources.get(h)?.();
      if (f?.data.byteLength) await putFile(h, f);
    }
  }
  return assets;
}

/** A file from the account, checked against its name (the SHA-256 of what it holds). */
async function fetchChecked(hash: string): Promise<StoredFile | null> {
  const f = await getFile(hash);
  if (!f) return null;
  try {
    const bytes = f.encoding === "gzip" ? await gunzip(f.data) : f.data;
    return (await sha256Hex(bytes)) === hash ? { ...f, size: bytes.byteLength } : null;
  } catch {
    return null;
  }
}

/** Fetches the files a project uses that this browser doesn't have. False when the account didn't have them all. */
async function fetchFiles(projectId: string, imports: ProjectImport[], assets: SyncedAsset[]): Promise<boolean> {
  let complete = true;
  for (const i of imports) {
    if (await db.getOne<BlobRecord>("blobs", i.hash)) continue;
    const f = await fetchChecked(i.hash);
    if (!f) {
      complete = false;
      continue;
    }
    await db.put<BlobRecord>("blobs", { hash: i.hash, data: f.data.slice().buffer, encoding: f.encoding, size: f.size, createdAt: Date.now() });
  }
  const have = new Set((await db.assetsFor(projectId)).map((a) => a.id));
  for (const a of assets) {
    if (have.has(a.id)) continue;
    const f = await fetchChecked(a.hash);
    if (!f) {
      complete = false;
      continue;
    }
    const data = new Blob([f.data as BlobPart], { type: a.mime });
    const t = a.thumb ? await fetchChecked(a.thumb) : null;
    const thumb = t ? new Blob([t.data as BlobPart], { type: "image/jpeg" }) : a.kind === "image" ? data : undefined;
    const rec: AssetRecord = { key: `${projectId}:${a.id}`, id: a.id, projectId, kind: a.kind, mime: a.mime, name: a.name.slice(0, 160), size: data.size, data, createdAt: a.createdAt };
    if (typeof a.width === "number" && typeof a.height === "number") Object.assign(rec, { width: a.width, height: a.height });
    if (thumb) rec.thumb = thumb;
    await db.put<AssetRecord>("assets", rec);
  }
  return complete;
}

/** Looks again for files another device hadn't sent when the project arrived. */
async function retryFiles(id: string, m: ProjectMeta) {
  let project: RemoteProject;
  try {
    ({ project } = await api<{ project: RemoteProject }>("GET", `/projects/${encodeURIComponent(id)}?since=${m.rev}`));
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) throw e;
    m.filesPending = undefined;
    return;
  }
  if (project.deletedAt) return;
  const files = filesOf(project.extra);
  m.filesPending = (await fetchFiles(id, files.imports, files.assets)) ? undefined : Date.now();
  if (!m.filesPending && useProject.getState().current?.id === id) retryMissingImports();
}

// ---------- chats ----------

const chatBusy = (id: string) => useChat.getState().projectId === id && (useChat.getState().busy || !!useChat.getState().pendingChoice);

async function pushChat(project: ProjectRecord, m: ProjectMeta) {
  const id = project.id;
  if (chatBusy(id)) return;
  const rec = await db.getOne<ChatRecord>("chats", id);
  if (!rec || rec.updatedAt <= m.chatAt) return;
  // the whole record travels, so fields the chat keeps (such as what its history is bound to) arrive intact
  const { projectId: _id, updatedAt, ...data } = rec;
  try {
    const r = await api<{ updatedAt: number }>("PUT", `/projects/${encodeURIComponent(id)}/chat`, { updatedAt, data });
    m.chatAt = r.updatedAt;
    m.chatRefused = undefined;
  } catch (e) {
    if (!refusal(e)) throw e;
    // not sent again until the chat changes; said once, not after every message
    m.chatAt = rec.updatedAt;
    if (!m.chatRefused) toast({ kind: "warn", title: `The chat in “${project.name}” isn't syncing`, detail: `${e.message} It stays in this browser. The design itself keeps syncing.` }, 12000);
    m.chatRefused = true;
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
          if (editedHere(p, m) || m.adirty) kept.push(p.name);
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

  // a reference file added to a project in the account is sent with it
  onAssetAdded((id) => {
    const m = meta.projects[id];
    if (!m) return;
    m.adirty = true;
    saveMeta();
    syncSoon(1500);
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
