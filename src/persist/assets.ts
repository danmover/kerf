// Files a user adds to a project as references: photos, sketches and PDF
// datasheets. Images are scaled to the size Claude reads best (1568 px on
// the long edge) and stored as JPEG with a small thumbnail. Everything stays
// in this browser's IndexedDB with the project.

import { useEffect, useState } from "react";
import * as db from "./db";
import type { AssetRecord } from "./db";

export const MAX_IMAGE_INPUT = 40 * 1024 * 1024;
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_EDGE = 1568;
const THUMB_EDGE = 360;

export const ASSET_ID_RE = /\bast_[a-z0-9]{4,32}\b/g;
export const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,image/bmp,application/pdf";

export type AssetKind = AssetRecord["kind"];

function canvasBlob(c: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("The image could not be encoded"))), type, quality));
}

async function decode(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    throw new Error("This image could not be read here. Use a JPEG, PNG or WebP file.");
  }
}

async function render(bmp: ImageBitmap, edge: number, quality: number): Promise<{ blob: Blob; width: number; height: number }> {
  const scale = Math.min(1, edge / Math.max(bmp.width, bmp.height));
  const width = Math.max(1, Math.round(bmp.width * scale));
  const height = Math.max(1, Math.round(bmp.height * scale));
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d")!;
  // transparent sketches and screenshots would turn black as JPEG
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, width, height);
  return { blob: await canvasBlob(c, "image/jpeg", quality), width, height };
}

const isPdf = async (b: Blob) => (await b.slice(0, 5).text()) === "%PDF-";

/** Store a file as a project asset. Throws a readable error for files Kerf cannot use. */
export async function addAsset(projectId: string, file: Blob, name: string): Promise<AssetRecord> {
  const type = file.type || (/\.pdf$/i.test(name) ? "application/pdf" : "");
  const base = { id: db.newId("ast"), projectId, name: name.replace(/[\u0000-\u001F\u007F]/g, "").slice(0, 160) || "file", createdAt: Date.now() };
  let rec: AssetRecord;
  if (type === "application/pdf") {
    if (file.size > MAX_PDF_BYTES) throw new Error(`That PDF is ${(file.size / 1e6).toFixed(1)} MB. Kerf takes PDFs up to 10 MB.`);
    if (!(await isPdf(file))) throw new Error("That file is not a readable PDF.");
    rec = { ...base, key: `${projectId}:${base.id}`, kind: "pdf", mime: "application/pdf", size: file.size, data: file };
  } else if (type.startsWith("image/")) {
    if (file.size > MAX_IMAGE_INPUT) throw new Error(`That image is ${(file.size / 1e6).toFixed(1)} MB, which is too large.`);
    const bmp = await decode(file);
    try {
      const full = await render(bmp, MAX_EDGE, 0.88);
      const thumb = await render(bmp, THUMB_EDGE, 0.8);
      rec = { ...base, key: `${projectId}:${base.id}`, kind: "image", mime: "image/jpeg", size: full.blob.size, width: full.width, height: full.height, data: full.blob, thumb: thumb.blob };
    } finally {
      bmp.close();
    }
  } else {
    throw new Error(`${name} is not an image or a PDF. Add photos, screenshots, sketches or PDF drawings.`);
  }
  await db.put("assets", rec);
  return rec;
}

export const getAsset = (projectId: string, id: string) => db.getOne<AssetRecord>("assets", `${projectId}:${id}`);

export async function removeAsset(projectId: string, id: string) {
  for (const variant of ["full", "thumb"]) {
    const k = `${projectId}:${id}:${variant}`;
    const u = urls.get(k);
    if (u) URL.revokeObjectURL(u);
    urls.delete(k);
  }
  await db.remove("assets", `${projectId}:${id}`);
}

function blobBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error ?? new Error("Could not read the file"));
    r.readAsDataURL(b);
  });
}

/** The content block that shows a stored file to Claude. */
export async function assetBlock(projectId: string, id: string, title?: string) {
  const a = await getAsset(projectId, id);
  if (!a) return null;
  const data = await blobBase64(a.data);
  if (a.kind === "pdf") return { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data }, ...(title ? { title: title.slice(0, 200) } : {}) };
  return { type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data } };
}

// ---------- object URLs for the UI ----------

const urls = new Map<string, string>();

export function useAssetUrl(projectId: string | undefined, id: string | undefined, variant: "thumb" | "full" = "thumb"): { url: string | null; kind: AssetKind | null; missing: boolean; name: string } {
  const key = projectId && id ? `${projectId}:${id}:${variant}` : "";
  const [state, setState] = useState<{ key: string; url: string | null; kind: AssetKind | null; missing: boolean; name: string }>({ key: "", url: null, kind: null, missing: false, name: "" });
  useEffect(() => {
    if (!projectId || !id) return;
    let live = true;
    void getAsset(projectId, id).then((a) => {
      if (!live) return;
      if (!a) return setState({ key, url: null, kind: null, missing: true, name: "" });
      let url = urls.get(key) ?? null;
      const blob = variant === "thumb" ? a.thumb : a.data;
      if (!url && blob) {
        url = URL.createObjectURL(blob);
        urls.set(key, url);
      }
      setState({ key, url, kind: a.kind, missing: false, name: a.name });
    });
    return () => {
      live = false;
    };
  }, [key, projectId, id, variant]);
  return state.key === key ? state : { url: null, kind: null, missing: false, name: "" };
}

/** Free cached object URLs (on closing a project). */
export function releaseAssetUrls() {
  for (const u of urls.values()) URL.revokeObjectURL(u);
  urls.clear();
}

// ---------- copying, export and import ----------

export async function copyAssets(fromProject: string, toProject: string) {
  for (const a of await db.assetsFor(fromProject)) await db.put("assets", { ...a, key: `${toProject}:${a.id}`, projectId: toProject });
}

export interface PortableAsset {
  id: string;
  kind: AssetKind;
  mime: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
  name: string;
  data: string;
}

/** Assets a project still refers to (in its source or any saved version), ready for a project file. */
export async function exportAssets(projectId: string, texts: string[]): Promise<PortableAsset[]> {
  const ids = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(ASSET_ID_RE)) ids.add(m[0]);
  const out: PortableAsset[] = [];
  for (const a of await db.assetsFor(projectId)) {
    if (!ids.has(a.id)) continue;
    out.push({ id: a.id, kind: a.kind, mime: a.kind === "pdf" ? "application/pdf" : "image/jpeg", name: a.name, data: await blobBase64(a.data) });
  }
  return out;
}

export async function importAssets(projectId: string, assets: PortableAsset[]) {
  for (const p of assets) {
    const bytes = Uint8Array.from(atob(p.data), (c) => c.charCodeAt(0));
    let data = new Blob([bytes], { type: p.mime });
    let mime = p.mime;
    let thumb: Blob | undefined;
    let width: number | undefined;
    let height: number | undefined;
    if (p.kind === "image") {
      const bmp = await decode(data).catch(() => null);
      if (!bmp) continue;
      try {
        // stored like an added image (JPEG at Claude's size), since that is how it is sent
        const full = await render(bmp, MAX_EDGE, 0.88);
        data = full.blob;
        mime = "image/jpeg";
        width = full.width;
        height = full.height;
        thumb = (await render(bmp, THUMB_EDGE, 0.8)).blob;
      } finally {
        bmp.close();
      }
    } else if (!(await isPdf(data))) continue;
    await db.put<AssetRecord>("assets", { key: `${projectId}:${p.id}`, id: p.id, projectId, kind: p.kind, mime, name: p.name, size: data.size, width, height, data, thumb, createdAt: Date.now() });
  }
}
