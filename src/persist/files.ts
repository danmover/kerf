// File import and export. Imported files are untrusted: they are size-limited,
// schema-validated and only ever treated as text and numbers.

import { z } from "zod";
import type { MeshData } from "../kernel/build";
import { xformMatrix, type Xform } from "../kernel/recipe";
import type { EvalPart, Model } from "../core/model";
import { catalogPart, isHad, searchLinks, shopLinks, type ShopLink } from "../machine/catalog";
import { haveKey, retailLengths, type HeadType } from "../library/fasteners";
import { threadSpec } from "../library/standards";
import type { CatalogPart } from "../machine/types";
import { IMPORT_META_VERSION, MAX_BODIES, MAX_STEP_BYTES, type ImportMeta, type ProjectImport } from "../kernel/imports";
import { cleanName } from "../kernel/stepText";
import { fromBase64, gunzip, sha256Hex } from "./blobs";
import type { BranchRecord, ScriptRecord } from "./db";
import { MAX_SCRIPTS, MAX_SCRIPT_CHARS, SCRIPT_ID, cleanScripts } from "../scripts/records";

// no generated code: the page CSP forbids eval
z.config({ jitless: true });

/** a plain .kerf source file */
export const MAX_SOURCE_FILE_BYTES = 5 * 1024 * 1024;
/** a project file, which can carry the brief's reference photos and PDFs and imported STEP files */
export const MAX_IMPORT_BYTES = 150 * 1024 * 1024;
export const MAX_BACKUP_BYTES = 400 * 1024 * 1024;
export const MAX_SOURCE_CHARS = 300_000;

const cleanText = (s: string, max: number) =>
  s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .slice(0, max);

const BranchIdSchema = z.string().regex(/^(main|brn_[a-z0-9]{4,32})$/);

const VersionSchema = z.object({
  ts: z.number().finite(),
  author: z.enum(["you", "claude", "system"]),
  message: z.string().max(2000),
  source: z.string().max(MAX_SOURCE_CHARS),
  branch: BranchIdSchema.optional(),
});

// a line of work in the project (see src/core/branches.ts)
const BranchSchema = z.object({
  id: BranchIdSchema,
  name: z.string().min(1).max(60),
  from: z.union([BranchIdSchema, z.literal("")]),
  base: z.string().max(MAX_SOURCE_CHARS),
  head: z.string().max(MAX_SOURCE_CHARS),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  meets: z
    .array(z.object({ kind: z.enum(["merged", "took"]), source: z.string().max(MAX_SOURCE_CHARS), base: z.string().max(MAX_SOURCE_CHARS), ts: z.number().finite() }))
    .max(20)
    .optional(),
});

// a script saved with the project (see src/scripts/)
const ScriptSchema = z.object({
  id: z.string().regex(SCRIPT_ID),
  name: z.string().min(1).max(60),
  code: z.string().max(MAX_SCRIPT_CHARS),
  onChange: z.boolean().optional(),
  updatedAt: z.number().finite(),
});

// a reference photo, sketch or PDF from the brief
const AssetSchema = z
  .object({
    id: z.string().regex(/^ast_[a-z0-9]{4,32}$/),
    kind: z.enum(["image", "pdf"]),
    mime: z.enum(["image/jpeg", "image/png", "image/webp", "application/pdf"]),
    name: z.string().max(200),
    data: z.string().max(15_000_000).regex(/^[A-Za-z0-9+/]*={0,2}$/),
  })
  .refine((a) => (a.kind === "pdf") === (a.mime === "application/pdf"), "kind and mime disagree");

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

// an imported STEP file's stored bytes as base64: a little over 4/3 of the largest STEP file
const ImportFileSchema = z.object({ hash: HashS, encoding: z.enum(["gzip", "raw"]), data: z.string().max(Math.ceil((MAX_STEP_BYTES * 4) / 3) + 16) });
type ImportFileEntry = z.infer<typeof ImportFileSchema>;

const ProjectFileSchema = z.object({
  format: z.literal("kerf-project"),
  version: z.union([z.literal(1), z.literal(2)]),
  name: z.string().min(1).max(200),
  source: z.string().max(MAX_SOURCE_CHARS),
  template: z.string().max(60).optional(),
  createdAt: z.number().finite().optional(),
  versions: z.array(VersionSchema).max(300).optional(),
  assets: z.array(AssetSchema).max(300).optional(),
  imports: z.array(ImportSchema).max(60).optional(),
  importFiles: z.array(ImportFileSchema).max(60).optional(),
  branches: z.array(BranchSchema).max(50).optional(),
  branch: BranchIdSchema.optional(),
  scripts: z.array(ScriptSchema).max(MAX_SCRIPTS).optional(),
});

export type ProjectFile = z.infer<typeof ProjectFileSchema>;

const BackupSchema = z.object({
  format: z.literal("kerf-backup"),
  version: z.union([z.literal(1), z.literal(2)]),
  exportedAt: z.number().finite().optional(),
  projects: z.array(ProjectFileSchema).max(500),
  importFiles: z.array(ImportFileSchema).max(1000).optional(),
});

export interface ImportedProject {
  name: string;
  source: string;
  template: string;
  versions: z.infer<typeof VersionSchema>[];
  assets: z.infer<typeof AssetSchema>[];
  imports: ProjectImport[];
  /** its branches, main first, and the one that was open (absent: main) */
  branches?: BranchRecord[];
  branch?: string;
  /** its scripts; none runs after each change until the user turns that on here */
  scripts?: ScriptRecord[];
}

/** What reading a file produced: projects, the bytes of the STEP files they import, and anything that was dropped. */
export interface ImportResult {
  projects: ImportedProject[];
  /** STEP file bytes by hash */
  files: Map<string, Uint8Array>;
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

const cleanProject = (p: ProjectFile, files: Map<string, Uint8Array>, warnings: string[]): ImportedProject => {
  const seen = new Set<string>();
  const imports: ProjectImport[] = [];
  for (const i of p.imports ?? []) {
    const name = cleanName(i.name, 60);
    if (!name || seen.has(name)) continue;
    if (!files.has(i.hash)) {
      warnings.push(`“${name}” in “${cleanText(p.name, 120)}” is missing its STEP file and was left out.`);
      continue;
    }
    seen.add(name);
    imports.push({ name, hash: i.hash, file: cleanName(i.file, 200), size: files.get(i.hash)!.byteLength, addedAt: i.addedAt ?? Date.now(), meta: cleanMeta(i.meta) });
  }
  const branches = cleanBranches(p);
  const known = new Set(branches?.map((b) => b.id) ?? ["main"]);
  const scripts = cleanScripts(p.scripts, { keepOnChange: false });
  return {
    name: cleanText(p.name, 120),
    source: cleanText(p.source, MAX_SOURCE_CHARS),
    template: p.template ?? "imported",
    // a version of a branch the file doesn't have shows on main
    versions: (p.versions ?? []).map(({ branch, ...v }) => ({ ...v, message: cleanText(v.message, 500), source: cleanText(v.source, MAX_SOURCE_CHARS), ...(branch && branch !== "main" && known.has(branch) ? { branch } : {}) })),
    assets: (p.assets ?? []).map((a) => ({ ...a, name: cleanText(a.name, 160) })),
    imports,
    ...(branches ? { branches, ...(p.branch && p.branch !== "main" && known.has(p.branch) ? { branch: p.branch } : {}) } : {}),
    ...(scripts ? { scripts } : {}),
  };
};

/** A file's branches as Kerf keeps them: main first, one of each id and name, each made from one that is there. */
function cleanBranches(p: ProjectFile): BranchRecord[] | undefined {
  const out: BranchRecord[] = [];
  const names = new Set<string>();
  for (const b of p.branches ?? []) {
    const name = cleanText(b.name, 40).replace(/\s+/g, " ").trim();
    const key = name.toLowerCase();
    if (!name || names.has(key) || out.some((x) => x.id === b.id) || (b.id === "main") !== (key === "main")) continue;
    names.add(key);
    out.push({ ...b, name, base: cleanText(b.base, MAX_SOURCE_CHARS), head: cleanText(b.head, MAX_SOURCE_CHARS), ...(b.meets ? { meets: b.meets.map((m) => ({ ...m, source: cleanText(m.source, MAX_SOURCE_CHARS), base: cleanText(m.base, MAX_SOURCE_CHARS) })) } : {}) });
  }
  const byId = new Map(out.map((b) => [b.id, b]));
  if (byId.get("main")?.from !== "") return undefined;
  // each made from a branch the file has, and so on back to main; main first
  const reachesMain = (b: BranchRecord) => {
    const seen = new Set<string>();
    for (let x: BranchRecord | undefined = b; x; x = byId.get(x.from)) {
      if (x.id === "main") return true;
      if (seen.has(x.id)) return false;
      seen.add(x.id);
    }
    return false;
  };
  const kept = out.filter(reachesMain).sort((a, b) => (a.id === "main" ? -1 : b.id === "main" ? 1 : 0));
  return kept.length > 1 ? kept : undefined;
}

/** Unpack embedded STEP files, keeping only ones whose bytes match their hash and look like STEP. */
async function readImportFiles(list: ImportFileEntry[], warnings: string[]): Promise<Map<string, Uint8Array>> {
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
      const files = await readImportFiles([...(parsed.data.importFiles ?? []), ...parsed.data.projects.flatMap((p) => p.importFiles ?? [])], warnings);
      return { projects: parsed.data.projects.map((p) => cleanProject(p, files, warnings)), files, warnings };
    }
    if (file.size > MAX_IMPORT_BYTES) throw new Error(`That file is ${(file.size / 1e6).toFixed(1)} MB. Kerf imports project files up to ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`);
    const parsed = ProjectFileSchema.safeParse(json);
    if (!parsed.success) throw new Error(`This is not a Kerf project file (${describeIssue(parsed.error)}).`);
    const warnings: string[] = [];
    const files = await readImportFiles(parsed.data.importFiles ?? [], warnings);
    return { projects: [cleanProject(parsed.data, files, warnings)], files, warnings };
  }
  if (file.size > MAX_SOURCE_FILE_BYTES) throw new Error(`That file is ${(file.size / 1e6).toFixed(1)} MB. Kerf imports source files up to 5 MB.`);
  if (text.length > MAX_SOURCE_CHARS) throw new Error("That source file is longer than Kerf supports (300,000 characters).");
  if (/[\u0000]/.test(text)) throw new Error("That file is binary, not Kerf source. Import a .kerf or .kerfproj file.");
  return { projects: [{ name: cleanText(base, 120), source: cleanText(text, MAX_SOURCE_CHARS), template: "imported", versions: [], assets: [], imports: [] }], files: new Map(), warnings: [] };
}

/** An imported STEP file's stored bytes, ready for a project file or backup. */
export interface PackedFile {
  hash: string;
  encoding: "gzip" | "raw";
  data: string;
}

/** Extra content for a project file: brief references, imported STEP files with their bytes, branches and scripts. */
export interface ProjectFileExtras {
  assets?: ProjectFile["assets"];
  imports?: ProjectImport[];
  importFiles?: PackedFile[];
  branches?: BranchRecord[];
  branch?: string;
  scripts?: ScriptRecord[];
}

export function projectFile(
  name: string,
  source: string,
  template: string,
  createdAt: number,
  versions: { ts: number; author: "you" | "claude" | "system"; message: string; source: string; branch?: string }[],
  { assets = [], imports = [], importFiles = [], branches = [], branch, scripts = [] }: ProjectFileExtras = {},
): string {
  // version 1 stays readable by older Kerf builds when nothing is imported (they skip the branches)
  const f: ProjectFile = { format: "kerf-project", version: imports.length ? 2 : 1, name, source, template, createdAt, versions, ...(assets.length ? { assets } : {}), ...(imports.length ? { imports, importFiles } : {}), ...(branches.length > 1 ? { branches, ...(branch ? { branch } : {}) } : {}), ...(scripts.length ? { scripts } : {}) };
  return JSON.stringify(f, null, 1);
}

export function backupFile(projects: ProjectFile[], importFiles: PackedFile[] = []): string {
  return JSON.stringify(importFiles.length ? { format: "kerf-backup", version: 2, exportedAt: Date.now(), projects, importFiles } : { format: "kerf-backup", version: 1, exportedAt: Date.now(), projects }, null, 1);
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

export interface BomRow {
  qty: number;
  item: string;
  description: string;
  standard: string;
  material: string;
  kind: string;
  /** unit price in USD: the component's price:, the catalog's typical price, or a buy item's price */
  price?: number;
  /** how the price was worked out, e.g. "$8 per metre" */
  priceNote?: string;
  /** the best place to buy: the design's buy: link, else the maker or distributor page */
  link?: string;
  /** every shop link: direct pages first, then marketplace searches */
  links: ShopLink[];
  catalogId?: string;
  /** cut length in mm for stock items */
  length?: number;
  /** the user has it already (Settings → Making → Parts you have): not counted in the cost */
  onHand?: boolean;
  /** what to add to the on-hand list for this row ("M3x10 socket 12.9", "17HS4401") */
  haveAs?: string;
}

/** The on-hand line for a library hardware key (see screwKey): what "I have it" adds. */
function haveText(key: string): string | undefined {
  const [kind, size, a, b, c] = key.split("|");
  switch (kind) {
    case "screw":
      return `${size}x${a} ${b} ${c}`;
    case "nut":
      return `${size} ${a === "hex" ? "" : a === "tslot20" ? "T-slot " : `${a} `}nut`;
    case "washer":
      return `${size} ${a === "large" ? "large " : ""}washer`;
    case "insert":
      return `${size} insert`;
    case "standoff":
      return `${size}x${a} standoff`;
    case "circlip":
      return `circlip ${size} mm`;
    default:
      return undefined;
  }
}

/** Price per metre when the catalog says so (profiles), else per piece. */
function catalogPrice(p: CatalogPart, length?: number): { price?: number; note?: string } {
  if (p.price_usd === undefined) return {};
  if (p.price_per === "m" && length) return { price: Math.round(p.price_usd * (length / 1000) * 100) / 100, note: `$${p.price_usd} per metre` };
  return { price: p.price_usd };
}

/** Metric screws, nuts and washers a hardware store keeps on the shelf (Bunnings, Mitre 10 and the like), by parts-list key. */
function hardwareStore(key: string | undefined): boolean {
  if (!key) return false;
  const [kind, size, a, b] = key.split("|");
  const t = /^M\d+$/.test(size ?? "") ? threadSpec(size) : undefined;
  if (!t) return false;
  if (kind === "nut") return ["hex", "nyloc", "flange"].includes(a);
  if (kind === "washer") return true;
  if (kind === "screw") return retailLengths(b as HeadType, t).includes(Number(a));
  return false;
}

/** Bill of materials grouped by identical description, with purchased extras from buy statements. */
/**
 * The parts list: one row per distinct part with its quantity, price and
 * where to buy it. `have` is what the user already has (free text, as in
 * Settings): matching rows are marked on hand.
 */
export function bomRows(model: Model, have: readonly string[] = []): BomRow[] {
  const rows = new Map<string, BomRow>();
  const seenInstance = new Set<string>();
  const comps = new Map((model.machine?.components ?? []).map((c) => [c.name, c]));
  for (const p of model.parts) {
    // count multi-solid components (motor body + shaft) once per instance
    const instance = p.id.split(".")[0];
    if (p.kind === "component" && seenInstance.has(instance)) continue;
    seenInstance.add(instance);
    // process: false is bought or already on hand, not made
    const made = p.kind === "part" && !p.processNone;
    const description = p.bom?.description ?? (made ? `Custom part: ${p.label}` : p.kind === "part" ? `${p.label} (bought, or one you have)` : p.label);
    const kind = made ? "Make" : "Buy";
    const cp = p.bom?.catalogId ? catalogPart(p.bom.catalogId) : undefined;
    const mc = cp ? comps.get(p.name) : undefined;
    let price: number | undefined;
    let priceNote: string | undefined;
    let links: ShopLink[] = [];
    if (cp) {
      const c = catalogPrice(cp, p.bom?.length);
      price = mc?.price ?? c.price;
      priceNote = mc?.price !== undefined ? undefined : c.note;
      links = shopLinks(cp);
      if (mc?.buyUrl) links = [{ vendor: "Design link", url: mc.buyUrl, direct: true }, ...links.filter((l) => l.url !== mc.buyUrl)];
    } else if (p.bom?.price !== undefined) {
      // library hardware (screws, nuts, washers, inserts): a typical pack price each and marketplace searches
      price = p.bom.price;
      priceNote = p.bom.priceNote;
      links = p.bom.search ? searchLinks(p.bom.search) : [];
      if (p.bom.search && hardwareStore(p.bom.key)) links = [{ vendor: "Bunnings", url: `https://www.bunnings.com.au/search/products?q=${encodeURIComponent(p.bom.search)}`, direct: false }, ...links];
    }
    const onHand = have.length > 0 && (cp ? isHad(cp, have) : p.bom?.key ? haveKey(have, p.bom.key) : false);
    const link = links.find((l) => l.direct)?.url;
    const key = `${kind}|${description}|${p.material}|${price ?? ""}|${link ?? ""}`;
    const row = rows.get(key);
    // a bought catalog part's material is only its colour in the model; stock cut to length keeps it
    const material = cp && !cp.cut_to_length ? "" : p.material;
    if (row) row.qty++;
    else {
      const haveAs = kind === "Make" ? undefined : cp ? (cp.mpn ?? cp.id) : p.bom?.key ? haveText(p.bom.key) : undefined;
      rows.set(key, { qty: 1, item: made ? p.name : p.imported ? p.imported.file : (cp?.kind ?? p.libKind ?? p.name), description, standard: p.bom?.standard ?? "", material, kind, price, priceNote, link, links, catalogId: cp?.id, length: p.bom?.length, onHand: onHand || undefined, haveAs });
    }
  }
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const it of model.machine?.items ?? []) {
    const links: ShopLink[] = [...(it.buyUrl ? [{ vendor: "Design link", url: it.buyUrl, direct: true }] : []), ...searchLinks(it.search ?? it.label)];
    const onHand = have.some((h) => norm(h).length >= 4 && norm(it.label).includes(norm(h)));
    rows.set(`Buy|item|${it.label}|${rows.size}`, { qty: it.qty, item: "item", description: it.label, standard: "", material: "", kind: "Buy", price: it.price, link: it.buyUrl, links, onHand: onHand || undefined, haveAs: it.label });
  }
  return [...rows.values()].sort((a, b) => (a.kind === b.kind ? a.item.localeCompare(b.item) : a.kind === "Make" ? -1 : 1));
}

/** Sum of qty × price over priced rows still to buy, how many rows have no price, and what the parts on hand save. */
export function bomTotal(rows: BomRow[]): { total: number; unpriced: number; saved: number } {
  let total = 0;
  let unpriced = 0;
  let saved = 0;
  for (const r of rows) {
    if (r.kind !== "Buy") continue;
    if (r.onHand) saved += (r.price ?? 0) * r.qty;
    else if (r.price === undefined) unpriced++;
    else total += r.price * r.qty;
  }
  return { total: Math.round(total * 100) / 100, unpriced, saved: Math.round(saved * 100) / 100 };
}

export function csvEscape(s: string | number | undefined): string {
  const t = s === undefined ? "" : String(s);
  // neutralise spreadsheet formula injection
  const safe = /^[=+\-@\t\r]/.test(t) ? "'" + t : t;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function bomCsv(model: Model): string {
  const lines = [["Qty", "Make/Buy", "Item", "Description", "Material", "Standard", "Price", "Link"].join(",")];
  for (const r of bomRows(model)) lines.push([r.qty, r.kind, r.item, r.description, r.material, r.standard, r.price !== undefined ? r.price.toFixed(2) : "", r.link ?? r.links[0]?.url ?? ""].map(csvEscape).join(","));
  return lines.join("\n") + "\n";
}

export type { EvalPart };
