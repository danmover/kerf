// Mesh file formats for export: 3MF (for slicers, with colours and one
// object per part), OBJ with a material library, and a flat print-plate
// layout. Pure functions over mesh data, so they are tested without a browser.

import type { MeshData } from "../kernel/build";
import type { ZipEntry } from "./zip";

/** A mesh placed in the assembly: `matrix` is a column-major 4×4 (as kernel/recipe xformMatrix gives). */
export interface PlacedMesh {
  name: string;
  /** sRGB hex */
  color: string;
  material?: string;
  mesh: MeshData;
  matrix: number[];
}

export const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export const translation = (x: number, y: number, z: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

const num = (v: number) => {
  const s = (Math.abs(v) < 5e-7 ? 0 : v).toFixed(4);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
};

const xmlEsc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

/**
 * Merge vertices that share a position. Kernel meshes repeat a vertex on each
 * face that meets it (so each face keeps its own normal); slicers want one
 * closed surface. Degenerate triangles left after merging are dropped.
 */
export function weld(mesh: MeshData, tolerance = 1e-4): { positions: number[]; triangles: number[] } {
  const P = mesh.positions;
  const map = new Map<string, number>();
  const remap = new Uint32Array(P.length / 3);
  const positions: number[] = [];
  const q = 1 / tolerance;
  for (let i = 0; i < P.length / 3; i++) {
    const key = `${Math.round(P[i * 3] * q)},${Math.round(P[i * 3 + 1] * q)},${Math.round(P[i * 3 + 2] * q)}`;
    let idx = map.get(key);
    if (idx === undefined) {
      idx = positions.length / 3;
      map.set(key, idx);
      positions.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
    }
    remap[i] = idx;
  }
  const triangles: number[] = [];
  const I = mesh.indices;
  for (let t = 0; t < I.length; t += 3) {
    const a = remap[I[t]];
    const b = remap[I[t + 1]];
    const c = remap[I[t + 2]];
    if (a !== b && b !== c && a !== c) triangles.push(a, b, c);
  }
  return { positions, triangles };
}

/** Axis-aligned bounds of a mesh in its own coordinates. */
export function meshBounds(mesh: MeshData): { min: [number, number, number]; max: [number, number, number] } {
  const P = mesh.positions;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = P[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  if (!P.length) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

const hex6 = (c: string) => {
  const h = c.replace("#", "");
  const full = h.length === 3 ? h.replace(/./g, (x) => x + x) : h.padEnd(6, "0").slice(0, 6);
  return /^[0-9a-fA-F]{6}$/.test(full) ? full.toUpperCase() : "B4BCCC";
};

/** The 3D model XML of a 3MF package. Identical meshes are written once and placed by build items. */
export function threeMfModel(items: PlacedMesh[], title: string): string {
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">');
  out.push(`<metadata name="Title">${xmlEsc(title)}</metadata>`);
  out.push('<metadata name="Application">Kerf</metadata>');
  out.push(`<metadata name="CreationDate">${new Date().toISOString().slice(0, 10)}</metadata>`);
  out.push("<resources>");
  const looks: string[] = [];
  const lookIndex = new Map<string, number>();
  for (const it of items) {
    const key = `${it.material ?? ""}|${hex6(it.color)}`;
    if (!lookIndex.has(key)) {
      lookIndex.set(key, looks.length);
      looks.push(`<base name="${xmlEsc(it.material || "part")}" displaycolor="#${hex6(it.color)}FF"/>`);
    }
  }
  out.push(`<basematerials id="1">${looks.join("")}</basematerials>`);
  const objects = new Map<string, number>();
  const builds: string[] = [];
  let nextId = 2;
  for (const it of items) {
    const key = `${lookIndex.get(`${it.material ?? ""}|${hex6(it.color)}`)}`;
    // one object per mesh and look; repeats of a part only add a build item
    const objKey = `${meshKey(it.mesh)}|${key}`;
    let id = objects.get(objKey);
    if (id === undefined) {
      id = nextId++;
      objects.set(objKey, id);
      const { positions, triangles } = weld(it.mesh);
      const v: string[] = [];
      for (let i = 0; i < positions.length; i += 3) v.push(`<vertex x="${num(positions[i])}" y="${num(positions[i + 1])}" z="${num(positions[i + 2])}"/>`);
      const t: string[] = [];
      for (let i = 0; i < triangles.length; i += 3) t.push(`<triangle v1="${triangles[i]}" v2="${triangles[i + 1]}" v3="${triangles[i + 2]}"/>`);
      out.push(`<object id="${id}" type="model" name="${xmlEsc(it.name)}" pid="1" pindex="${key}"><mesh><vertices>${v.join("")}</vertices><triangles>${t.join("")}</triangles></mesh></object>`);
    }
    const m = it.matrix;
    // 3MF matrices act on row vectors: the 12 numbers are the column-major 4×4 without its last row
    const tf = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10], m[12], m[13], m[14]].map(num).join(" ");
    builds.push(`<item objectid="${id}" transform="${tf}"/>`);
  }
  out.push("</resources>");
  out.push(`<build>${builds.join("")}</build>`);
  out.push("</model>");
  return out.join("\n");
}

const meshIds = new WeakMap<MeshData, number>();
let meshCounter = 0;
function meshKey(m: MeshData) {
  let k = meshIds.get(m);
  if (k === undefined) meshIds.set(m, (k = ++meshCounter));
  return k;
}

/** The files of a 3MF package, ready to zip. */
export function threeMfFiles(items: PlacedMesh[], title: string): ZipEntry[] {
  return [
    {
      name: "[Content_Types].xml",
      data: '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
    },
    {
      name: "_rels/.rels",
      data: '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
    },
    { name: "3D/3dmodel.model", data: threeMfModel(items, title) },
  ];
}

/** Wavefront OBJ in world coordinates (millimetres) and its material library. */
export function writeObj(items: PlacedMesh[], mtlName: string, title: string): { obj: string; mtl: string } {
  const obj: string[] = [`# ${title.replace(/[\r\n]/g, " ")}`, "# Exported from Kerf. Units: millimetres, Z up.", `mtllib ${mtlName}`];
  const mtl: string[] = ["# Kerf materials"];
  const mats = new Map<string, string>();
  let base = 1;
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 60) || "part";
  for (const it of items) {
    const h = hex6(it.color);
    const mkey = `${safe(it.material ?? "part")}_${h}`;
    if (!mats.has(mkey)) {
      mats.set(mkey, mkey);
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
      mtl.push("", `newmtl ${mkey}`, `Kd ${num(r)} ${num(g)} ${num(b)}`, "Ka 0 0 0", "Ks 0.25 0.25 0.25", "Ns 64", "d 1", "illum 2");
    }
    const m = it.matrix;
    const P = it.mesh.positions;
    const N = it.mesh.normals;
    obj.push("", `o ${safe(it.name)}`, `usemtl ${mkey}`);
    const count = P.length / 3;
    for (let i = 0; i < count; i++) {
      const x = P[i * 3];
      const y = P[i * 3 + 1];
      const z = P[i * 3 + 2];
      obj.push(`v ${num(m[0] * x + m[4] * y + m[8] * z + m[12])} ${num(m[1] * x + m[5] * y + m[9] * z + m[13])} ${num(m[2] * x + m[6] * y + m[10] * z + m[14])}`);
    }
    for (let i = 0; i < count; i++) {
      const x = N[i * 3] ?? 0;
      const y = N[i * 3 + 1] ?? 0;
      const z = N[i * 3 + 2] ?? 1;
      const nx = m[0] * x + m[4] * y + m[8] * z;
      const ny = m[1] * x + m[5] * y + m[9] * z;
      const nz = m[2] * x + m[6] * y + m[10] * z;
      const l = Math.hypot(nx, ny, nz) || 1;
      obj.push(`vn ${num(nx / l)} ${num(ny / l)} ${num(nz / l)}`);
    }
    const I = it.mesh.indices;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] + base;
      const b = I[t + 1] + base;
      const c = I[t + 2] + base;
      obj.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`);
    }
    base += count;
  }
  return { obj: obj.join("\n") + "\n", mtl: mtl.join("\n") + "\n" };
}

/** Column-major 4×4 product a·b (apply b first). */
export function mul4(a: number[], b: number[]): number[] {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}

// the six ways to rest a part on an axis-aligned face: the face whose outward
// normal is `dir` ends up facing down (-Z); all proper rotations, never mirrors
const RESTS: { dir: [number, number, number]; m: number[] }[] = [
  { dir: [0, 0, -1], m: IDENTITY },
  { dir: [0, 0, 1], m: [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1] },
  { dir: [1, 0, 0], m: [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1] },
  { dir: [-1, 0, 0], m: [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1] },
  { dir: [0, 1, 0], m: [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1] },
  { dir: [0, -1, 0], m: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1] },
];

/**
 * How to turn a part so it prints lying down: onto its largest flat face
 * among the six axis-aligned sides, and on a tie the side that leaves it
 * lowest. Parts that are already down on their best face keep their pose.
 * Returns a rotation (column-major 4×4) and the area resting on the bed.
 */
export function restingRotation(mesh: MeshData, tolerance = 0.02): { matrix: number[]; contact: number; height: number } {
  const P = mesh.positions;
  const I = mesh.indices;
  let best = { matrix: IDENTITY, contact: -1, height: Infinity };
  if (!P.length) return { matrix: IDENTITY, contact: 0, height: 0 };
  for (const { dir, m } of RESTS) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < P.length; i += 3) {
      const d = P[i] * dir[0] + P[i + 1] * dir[1] + P[i + 2] * dir[2];
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    // area of triangles lying in the extreme plane along `dir`
    let contact = 0;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3;
      const b = I[t + 1] * 3;
      const c = I[t + 2] * 3;
      const on = (k: number) => hi - (P[k] * dir[0] + P[k + 1] * dir[1] + P[k + 2] * dir[2]) <= tolerance;
      if (!on(a) || !on(b) || !on(c)) continue;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      contact += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    }
    const height = hi - lo;
    const better = contact > best.contact * 1.02 + 1e-6 || (contact >= best.contact * 0.98 && height < best.height - tolerance);
    if (better) best = { matrix: m, contact, height };
  }
  return best;
}

/** Bounds of a mesh after a 4×4 transform. */
export function transformedBounds(mesh: MeshData, m: number[]): { min: [number, number, number]; max: [number, number, number] } {
  const { min, max } = meshBounds(mesh);
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? max[0] : min[0];
    const y = i & 2 ? max[1] : min[1];
    const z = i & 4 ? max[2] : min[2];
    const w = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], w[k]);
      hi[k] = Math.max(hi[k], w[k]);
    }
  }
  return { min: lo, max: hi };
}

/**
 * Lay boxes out flat on a print bed, in rows, biggest first. Returns the
 * offset to add to each box's minimum corner so it sits on z = 0 at its spot.
 * The plate grows past `width` only when a single part is wider than the bed.
 */
export function layoutPlate(sizes: { w: number; d: number }[], width = 220, gap = 6): { x: number; y: number }[] {
  const order = sizes.map((s, i) => ({ ...s, i })).sort((a, b) => b.d - a.d || b.w - a.w);
  const out: { x: number; y: number }[] = new Array(sizes.length);
  let x = 0;
  let y = 0;
  let rowD = 0;
  for (const s of order) {
    if (x > 0 && x + s.w > width) {
      x = 0;
      y += rowD + gap;
      rowD = 0;
    }
    out[s.i] = { x, y };
    x += s.w + gap;
    rowD = Math.max(rowD, s.d);
  }
  return out;
}
