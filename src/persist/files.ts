// File import and export. Imported files are untrusted: they are size-limited,
// schema-validated and only ever treated as text and numbers.

import { z } from "zod";
import type { MeshData } from "../kernel/build";
import { xformMatrix, type Xform } from "../kernel/recipe";
import type { EvalPart, Model } from "../core/model";
import { catalogPart, searchLinks, shopLinks, type ShopLink } from "../machine/catalog";
import type { CatalogPart } from "../machine/types";

// no generated code: the page CSP forbids eval
z.config({ jitless: true });

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
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

const ProjectFileSchema = z.object({
  format: z.literal("kerf-project"),
  version: z.literal(1),
  name: z.string().min(1).max(200),
  source: z.string().max(MAX_SOURCE_CHARS),
  template: z.string().max(60).optional(),
  createdAt: z.number().finite().optional(),
  versions: z.array(VersionSchema).max(300).optional(),
});

export type ProjectFile = z.infer<typeof ProjectFileSchema>;

const BackupSchema = z.object({
  format: z.literal("kerf-backup"),
  version: z.literal(1),
  exportedAt: z.number().finite().optional(),
  projects: z.array(ProjectFileSchema).max(500),
});

export interface ImportedProject {
  name: string;
  source: string;
  template: string;
  versions: z.infer<typeof VersionSchema>[];
}

const cleanProject = (p: ProjectFile): ImportedProject => ({
  name: cleanText(p.name, 120),
  source: cleanText(p.source, MAX_SOURCE_CHARS),
  template: p.template ?? "imported",
  versions: (p.versions ?? []).map((v) => ({ ...v, message: cleanText(v.message, 500), source: cleanText(v.source, MAX_SOURCE_CHARS) })),
});

const describeIssue = (e: z.ZodError) => {
  const issue = e.issues[0];
  return `${issue?.path.join(".") || "format"}: ${issue?.message ?? "invalid"}`;
};

/** Reads a .kerf source file, a .kerfproj project or a Kerf backup into one or more projects. */
export async function readImport(file: File): Promise<ImportedProject[]> {
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
      return parsed.data.projects.map(cleanProject);
    }
    if (file.size > MAX_IMPORT_BYTES) throw new Error(`That file is ${(file.size / 1e6).toFixed(1)} MB. Kerf imports project files up to 5 MB.`);
    const parsed = ProjectFileSchema.safeParse(json);
    if (!parsed.success) throw new Error(`This is not a Kerf project file (${describeIssue(parsed.error)}).`);
    return [cleanProject(parsed.data)];
  }
  if (file.size > MAX_IMPORT_BYTES) throw new Error(`That file is ${(file.size / 1e6).toFixed(1)} MB. Kerf imports source files up to 5 MB.`);
  if (text.length > MAX_SOURCE_CHARS) throw new Error("That source file is longer than Kerf supports (300,000 characters).");
  if (/[\u0000]/.test(text)) throw new Error("That file is binary, not Kerf source. Import a .kerf or .kerfproj file.");
  return [{ name: cleanText(base, 120), source: cleanText(text, MAX_SOURCE_CHARS), template: "imported", versions: [] }];
}

export function projectFile(name: string, source: string, template: string, createdAt: number, versions: { ts: number; author: "you" | "claude" | "system"; message: string; source: string }[]): string {
  const f: ProjectFile = { format: "kerf-project", version: 1, name, source, template, createdAt, versions };
  return JSON.stringify(f, null, 1);
}

export function backupFile(projects: ProjectFile[]): string {
  return JSON.stringify({ format: "kerf-backup", version: 1, exportedAt: Date.now(), projects }, null, 1);
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
}

/** Price per metre when the catalog says so (profiles), else per piece. */
function catalogPrice(p: CatalogPart, length?: number): { price?: number; note?: string } {
  if (p.price_usd === undefined) return {};
  if (p.price_per === "m" && length) return { price: Math.round(p.price_usd * (length / 1000) * 100) / 100, note: `$${p.price_usd} per metre` };
  return { price: p.price_usd };
}

/** Bill of materials grouped by identical description, with purchased extras from buy statements. */
export function bomRows(model: Model): BomRow[] {
  const rows = new Map<string, BomRow>();
  const seenInstance = new Set<string>();
  const comps = new Map((model.machine?.components ?? []).map((c) => [c.name, c]));
  for (const p of model.parts) {
    // count multi-solid components (motor body + shaft) once per instance
    const instance = p.id.split(".")[0];
    if (p.kind === "component" && seenInstance.has(instance)) continue;
    seenInstance.add(instance);
    const description = p.bom?.description ?? (p.kind === "part" ? `Custom part: ${p.label}` : p.label);
    const kind = p.kind === "part" ? "Make" : "Buy";
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
    }
    const link = links.find((l) => l.direct)?.url;
    const key = `${kind}|${description}|${p.material}|${price ?? ""}|${link ?? ""}`;
    const row = rows.get(key);
    // a bought catalog part's material is only its colour in the model; stock cut to length keeps it
    const material = cp && !cp.cut_to_length ? "" : p.material;
    if (row) row.qty++;
    else rows.set(key, { qty: 1, item: p.kind === "part" ? p.name : (cp?.kind ?? p.libKind ?? p.name), description, standard: p.bom?.standard ?? "", material, kind, price, priceNote, link, links, catalogId: cp?.id, length: p.bom?.length });
  }
  for (const it of model.machine?.items ?? []) {
    const links: ShopLink[] = [...(it.buyUrl ? [{ vendor: "Design link", url: it.buyUrl, direct: true }] : []), ...searchLinks(it.search ?? it.label)];
    rows.set(`Buy|item|${it.label}|${rows.size}`, { qty: it.qty, item: "item", description: it.label, standard: "", material: "", kind: "Buy", price: it.price, link: it.buyUrl, links });
  }
  return [...rows.values()].sort((a, b) => (a.kind === b.kind ? a.item.localeCompare(b.item) : a.kind === "Make" ? -1 : 1));
}

/** Sum of qty × price over priced rows, and how many rows have no price. */
export function bomTotal(rows: BomRow[]): { total: number; unpriced: number } {
  let total = 0;
  let unpriced = 0;
  for (const r of rows) {
    if (r.kind !== "Buy") continue;
    if (r.price === undefined) unpriced++;
    else total += r.price * r.qty;
  }
  return { total: Math.round(total * 100) / 100, unpriced };
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
