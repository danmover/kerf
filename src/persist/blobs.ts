// Bytes of imported files (STEP): hashed, compressed and stored once per
// browser, whichever projects use them. Reference photos and PDFs from the
// brief are kept per project in assets.ts.

import * as db from "./db";
import type { BlobRecord, ProjectRecord } from "./db";

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function pipe(bytes: Uint8Array, stream: TransformStream<Uint8Array, Uint8Array>): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export const canCompress = () => typeof CompressionStream === "function" && typeof DecompressionStream === "function";

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new CompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>);
}

export async function gunzip(bytes: Uint8Array, maxBytes = 200 * 1024 * 1024): Promise<Uint8Array> {
  const out = await pipe(bytes, new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>);
  if (out.byteLength > maxBytes) throw new Error("A stored file is larger than Kerf allows once unpacked.");
  return out;
}

/** Store a file's bytes under their hash. Storing the same file twice keeps one copy. */
export async function putBlob(hash: string, bytes: Uint8Array): Promise<void> {
  if (await db.getOne<BlobRecord>("blobs", hash)) return;
  const packed = canCompress() ? await gzip(bytes) : bytes;
  const data = packed.slice().buffer;
  await db.put<BlobRecord>("blobs", { hash, data, encoding: canCompress() ? "gzip" : "raw", size: bytes.byteLength, createdAt: Date.now() });
}

/** A stored file's bytes, or null when this browser does not have them. */
export async function getBlob(hash: string): Promise<Uint8Array | null> {
  const rec = await db.getOne<BlobRecord>("blobs", hash);
  if (!rec) return null;
  const raw = new Uint8Array(rec.data);
  return rec.encoding === "gzip" ? gunzip(raw) : raw;
}

/** The stored (compressed) form, for project files and backups. */
export async function getPackedBlob(hash: string): Promise<{ encoding: "gzip" | "raw"; data: Uint8Array } | null> {
  const rec = await db.getOne<BlobRecord>("blobs", hash);
  return rec ? { encoding: rec.encoding, data: new Uint8Array(rec.data) } : null;
}

/** Delete files no project imports any more. */
export async function collectUnusedBlobs(): Promise<number> {
  const projects = await db.getAll<ProjectRecord>("projects");
  const used = new Set(projects.flatMap((p) => (p.imports ?? []).map((i) => i.hash)));
  let n = 0;
  for (const hash of await db.blobKeys()) {
    if (used.has(hash)) continue;
    await db.remove("blobs", hash);
    n++;
  }
  return n;
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
