// File import and export. Imported files are untrusted: they are size-limited,
// schema-validated and only ever treated as text and numbers.

import { z } from "zod";
import type { MeshData } from "../kernel/build";
import { xformMatrix, type Xform } from "../kernel/recipe";
import type { EvalPart, Model } from "../core/model";
import { IMPORT_META_VERSION, MAX_BODIES, MAX_STEP_BYTES, type ImportMeta, type ProjectImport } from "../kernel/imports";
import { cleanName } from "../kernel/stepText";
import { fromBase64, gunzip, sha256Hex } from "./assets";

// no generated code: the page CSP forbids eval
z.config({ jitless: true });

/** a plain .kerf source file */
export const MAX_SOURCE_FILE_BYTES = 5 * 1024 * 1024;
/** a project file, which can carry imported STEP files */
export const MAX_IMPORT_BYTES = 150 * 1024 * 1024;
export const MAX_BACKUP_BYTES = 400 * 1024 * 1024;
export const MAX_SOURCE_CHARS = 300_000;

const cleanText = (s: string, max: number) =>
  s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .slice(0, max);

const VersionSchema = z.object({
  ts: z.number().finite(),
  author: z.enum(["you", "claude", "system"]),
  message: z.string().max(2000),
  source: z.string().max(MAX_SOURCE_CHARS),
});

const num = z.number().finite();
const V3S = z.tuple([num, num, num]);
const BoxS = z.tuple([V3S, V3S]);
const HashS = z.string().regex(/^[0-9a-f]{64}$/);

// what the kernel measured; checked like everything else in the file, and recomputed when it does not fit
const ImportMetaSchema = z.object({
  version: z.number().int(),
  file: z.string().max(300),
  bytes: z.number().int().nonnegative(),
  title: z.string().max(300),
  bodies: z
    .array(
      z.object({
        name: z.string().max(300),
        product: z.string().max(300),
        kind: z.enum(["solid", "shell", "faces"]),
        color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
        faceColors: z.boolean().optional(),
        volume: num,
        area: num,
        faces: z.number().int().nonnegative(),
        bbox: BoxS,
        center: V3S,
      }),
    )
    .max(MAX_BODIES),
  cylinders: z.array(z.object({ body: z.number().int().nonnegative(), d: num, hole: z.boolean(), start: V3S, end: V3S, sweep: num })).max(4000),
  bbox: BoxS,
  warnings: z.array(z.string().max(400)).max(20),
  ms: num,
});

const ImportSchema = z.object({
  name: z.string().min(1).max(120),
  hash: HashS,
  file: z.string().max(300),
  size: z.number().int().nonnegative(),
  addedAt: num.optional(),
  meta: ImportMetaSchema.nullable().optional(),
});

// base64 of the stored bytes: a little over 4/3 of the largest STEP file
const AssetSchema = z.object({ hash: HashS, encoding: z.enum(["gzip", "raw"]), data: z.string().max(Math.ceil((MAX_STEP_BYTES * 4) / 3) + 16) });
type AssetEntry = z.infer<typeof AssetSchema>;

const ProjectFileSchema = z.object({
  format: z.literal("kerf-project"),
  version: z.union([z.literal(1), z.literal(2)]),
  name: z.string().min(1).max(200),
  source: z.string().max(MAX_SOURCE_CHARS),
  template: z.string().max(60).optional(),
  createdAt: z.number().finite().optional(),
  versions: z.array(VersionSchema).max(300).optional(),
  imports: z.array(ImportSchema).max(60).optional(),
  assets: z.array(AssetSchema).max(60).optional(),
});

export type ProjectFile = z.infer<typeof ProjectFileSchema>;

const BackupSchema = z.object({
  format: z.literal("kerf-backup"),
  version: z.union([z.literal(1), z.literal(2)]),
  exportedAt: z.number().finite().optional(),
  projects: z.array(ProjectFileSchema).max(500),
  assets: z.array(AssetSchema).max(1000).optional(),
});

export interface ImportedProject {
  name: string;
  source: string;
  template: string;
  versions: z.infer<typeof VersionSchema>[];
  imports: ProjectImport[];
}

/** What reading a file produced: projects, the bytes of the STEP files they import, and anything that was dropped. */
export interface ImportResult {
  projects: ImportedProject[];
  assets: Map<string, Uint8Array>;
  warnings: string[];
}

const cleanMeta = (m: z.infer<typeof ImportMetaSchema> | null | undefined): ImportMeta | null => {
  if (!m || m.version !== IMPORT_META_VERSION || m.cylinders.some((c) => c.body >= m.bodies.length)) return null;
  return {
    ...m,
    file: cleanName(m.file, 200),
    title: cleanName(m.title),
    bodies: m.bodies.map((b) => ({ ...b, name: cleanName(b.name, 120), product: cleanName(b.product) })),
    warnings: m.warnings.map((w) => cleanText(w, 300)),
  };
};

const cleanProject = (p: ProjectFile, assets: Map<string, Uint8Array>, warnings: string[]): ImportedProject => {
  const seen = new Set<string>();
  const imports: ProjectImport[] = [];
  for (const i of p.imports ?? []) {
    const name = cleanName(i.name, 60);
    if (!name || seen.has(name)) continue;
    if (!assets.has(i.hash)) {
      warnings.push(`“${name}” in “${cleanText(p.name, 120)}” is missing its STEP file and was left out.`);
      continue;
    }
    seen.add(name);
    imports.push({ name, hash: i.hash, file: cleanName(i.file, 200), size: assets.get(i.hash)!.byteLength, addedAt: i.addedAt ?? Date.now(), meta: cleanMeta(i.meta) });
  }
  return {
    name: cleanText(p.name, 120),
    source: cleanText(p.source, MAX_SOURCE_CHARS),
    template: p.template ?? "imported",
    versions: (p.versions ?? []).map((v) => ({ ...v, message: cleanText(v.message, 500), source: cleanText(v.source, MAX_SOURCE_CHARS) })),
    imports,
  };
};

/** Unpack embedded STEP files, keeping only ones whose bytes match their hash and look like STEP. */
async function readAssets(list: AssetEntry[], warnings: string[]): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const a of list) {
    if (out.has(a.hash)) continue;
    try {
      const packed = fromBase64(a.data);
      const bytes = a.encoding === "gzip" ? await gunzip(packed, MAX_STEP_BYTES) : packed;
      if (bytes.byteLength > MAX_STEP_BYTES) throw new Error("too large");
      if (!/ISO-10303-21\s*;/.test(new TextDecoder("latin1").decode(bytes.subarray(0, 2048)))) throw new Error("not STEP");
      if ((await sha256Hex(bytes)) !== a.hash) throw new Error("hash mismatch");
      out.set(a.hash, bytes);
    } catch {
      warnings.push("An embedded STEP file was damaged and was left out.");
    }
  }
  return out;
}

const describeIssue = (e: z.ZodError) => {
  const issue = e.issues[0];
  return `${issue?.path.join(".") || "format"}: ${issue?.message ?? "invalid"}`;
};

/** Reads a .kerf source file, a .kerfproj project or a Kerf backup into one or more projects. */
export async function readImport(file: File): Promise<ImportedProject[]> {
  return (await readImportFile(file)).projects;
}

/** Like readImport, with the embedded STEP files and what had to be left out. */
export async function readImportFile(file: File): Promise<ImportResult> {
  if (file.size > MAX_BACKUP_BYTES) throw new Error(`That file is ${(file.size / 1e6).toFixed(1)} MB, which is larger than any Kerf file.`);
  const text = await file.text();
  const base = file.name.replace(/\.(kerf|kerfproj|kerfbackup|json|txt)$/i, "") || "Imported design";
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("The file looks like JSON but could not be read. It may be damaged.");
    }
    const format = typeof json === "object" && json !== null ? (json as { format?: unknown }).format : undefined;
    if (format === "kerf-backup") {
      const parsed = BackupSchema.safeParse(json);
      if (!parsed.success) throw new Error(`This Kerf backup is damaged (${describeIssue(parsed.error)}).`);
      if (!parsed.data.projects.length) throw new Error("This backup has no projects in it.");
      const warnings: string[] = [];
      const assets = await readAssets([...(parsed.data.assets ?? []), ...parsed.data.projects.flatMap((p) => p.assets ?? [])], warnings);
      return { projects: parsed.data.projects.map((p) => cleanProject(p, assets, warnings)), assets, warnings };
    }
    if (file.size > MAX_IMPORT_BYTES) throw new Error(`That file is ${(file.size / 1e6).toFixed(1)} MB. Kerf imports project files up to ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`);
    const parsed = ProjectFileSchema.safeParse(json);
    if (!parsed.success) throw new Error(`This is not a Kerf project file (${describeIssue(parsed.error)}).`);
    const warnings: string[] = [];
    const assets = await readAssets(parsed.data.assets ?? [], warnings);
    return { projects: [cleanProject(parsed.data, assets, warnings)], assets, warnings };
  }
  if (file.size > MAX_SOURCE_FILE_BYTES) throw new Error(`That file is ${(file.size / 1e6).toFixed(1)} MB. Kerf imports source files up to 5 MB.`);
  if (text.length > MAX_SOURCE_CHARS) throw new Error("That source file is longer than Kerf supports (300,000 characters).");
  if (/[\u0000]/.test(text)) throw new Error("That file is binary, not Kerf source. Import a .kerf or .kerfproj file.");
  return { projects: [{ name: cleanText(base, 120), source: cleanText(text, MAX_SOURCE_CHARS), template: "imported", versions: [], imports: [] }], assets: new Map(), warnings: [] };
}

export interface PackedAsset {
  hash: string;
  encoding: "gzip" | "raw";
  data: string;
}

export function projectFile(
  name: string,
  source: string,
  template: string,
  createdAt: number,
  versions: { ts: number; author: "you" | "claude" | "system"; message: string; source: string }[],
  imports: ProjectImport[] = [],
  assets: PackedAsset[] = [],
): string {
  // version 1 stays readable by older Kerf builds when nothing is imported
  const f: ProjectFile = imports.length ? { format: "kerf-project", version: 2, name, source, template, createdAt, versions, imports, assets } : { format: "kerf-project", version: 1, name, source, template, createdAt, versions };
  return JSON.stringify(f, null, 1);
}

export function backupFile(projects: ProjectFile[], assets: PackedAsset[] = []): string {
  return JSON.stringify(assets.length ? { format: "kerf-backup", version: 2, exportedAt: Date.now(), projects, assets } : { format: "kerf-backup", version: 1, exportedAt: Date.now(), projects }, null, 1);
}

export function safeFileName(name: string, ext: string) {
  const base = name.replace(/[^A-Za-z0-9 _.-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 80) || "design";
  return `${base}.${ext}`;
}

export function download(data: BlobPart, filename: string, type: string) {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Binary STL of placed meshes in world coordinates (millimetres). */
export function writeStl(items: { mesh: MeshData; xf: Xform[] }[], header = "Kerf export"): ArrayBuffer {
  let tris = 0;
  for (const it of items) tris += it.mesh.indices.length / 3;
  const buf = new ArrayBuffer(84 + tris * 50);
  const dv = new DataView(buf);
  const enc = new TextEncoder().encode(header.slice(0, 79));
  new Uint8Array(buf, 0, 80).set(enc);
  dv.setUint32(80, tris, true);
  let o = 84;
  for (const it of items) {
    const m = xformMatrix(it.xf);
    const P = it.mesh.positions;
    const I = it.mesh.indices;
    const tp = (i: number): [number, number, number] => {
      const x = P[i * 3];
      const y = P[i * 3 + 1];
      const z = P[i * 3 + 2];
      return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
    };
    for (let t = 0; t < I.length; t += 3) {
      const a = tp(I[t]);
      const b = tp(I[t + 1]);
      const c = tp(I[t + 2]);
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      for (const v of [nx, ny, nz, ...a, ...b, ...c]) {
        dv.setFloat32(o, v, true);
        o += 4;
      }
      dv.setUint16(o, 0, true);
      o += 2;
    }
  }
  return buf;
}

/** Bill of materials grouped by identical description. */
export function bomRows(model: Model): { qty: number; item: string; description: string; standard: string; material: string; kind: string }[] {
  const rows = new Map<string, { qty: number; item: string; description: string; standard: string; material: string; kind: string }>();
  const seenInstance = new Set<string>();
  for (const p of model.parts) {
    // count multi-solid components (motor body + shaft) once per instance
    const instance = p.id.split(".")[0];
    if (p.kind === "component" && seenInstance.has(instance)) continue;
    seenInstance.add(instance);
    const description = p.bom?.description ?? (p.kind === "part" ? `Custom part: ${p.label}` : p.label);
    const kind = p.kind === "part" ? "Make" : "Buy";
    const key = `${kind}|${description}|${p.material}`;
    const row = rows.get(key);
    if (row) row.qty++;
    else rows.set(key, { qty: 1, item: p.kind === "part" ? p.name : p.imported ? p.imported.file : p.libKind ?? p.name, description, standard: p.bom?.standard ?? "", material: p.material, kind });
  }
  return [...rows.values()].sort((a, b) => (a.kind === b.kind ? a.item.localeCompare(b.item) : a.kind === "Make" ? -1 : 1));
}

export function bomCsv(model: Model): string {
  const esc = (s: string | number) => {
    const t = String(s);
    // neutralise spreadsheet formula injection
    const safe = /^[=+\-@\t\r]/.test(t) ? "'" + t : t;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [["Qty", "Make/Buy", "Item", "Description", "Material", "Standard"].join(",")];
  for (const r of bomRows(model)) lines.push([r.qty, r.kind, r.item, r.description, r.material, r.standard].map(esc).join(","));
  return lines.join("\n") + "\n";
}

export type { EvalPart };
