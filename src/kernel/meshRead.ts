// Reads triangle meshes from STL (binary or text), OBJ and 3MF files into plain
// arrays in millimetres, one mesh per object the file names. Nothing here uses
// OpenCASCADE, so it runs in the kernel worker and in tests alike; meshRepair
// cleans the result and meshImport turns it into solids.

import { unzip } from "../persist/zip";
import { MESH_FILE } from "./imports";
import { cleanName } from "./stepText";

export class MeshReadError extends Error {}

/** One object of a mesh file, before repair. Vertices may repeat: STL stores each triangle's corners on their own. */
export interface RawMesh {
  name: string;
  /** x, y, z per vertex in millimetres */
  positions: Float32Array | Float64Array;
  /** three vertex indices per triangle, counter-clockwise seen from outside when the file is well made */
  triangles: Uint32Array;
  /** colour of the whole object (sRGB hex), when the file gives one */
  color?: string;
  /** per triangle, an index into `palette`, when the triangles carry their own colours */
  triColor?: Uint16Array;
  palette?: string[];
}

export interface MeshFile {
  format: MeshFormat;
  meshes: RawMesh[];
  /** the unit the file declares, or null when the format has none (STL, OBJ) and millimetres were assumed */
  unit: string | null;
  title: string;
  warnings: string[];
}

export type MeshFormat = "stl" | "obj" | "3mf";

export const MESH_EXTENSIONS = MESH_FILE;

export function meshFormat(file: string): MeshFormat | null {
  const m = MESH_FILE.exec(file);
  return m ? (m[1].toLowerCase() as MeshFormat) : null;
}

const stem = (file: string) => file.replace(/^.*[\\/]/, "").replace(MESH_FILE, "") || file;

const latin1 = (b: Uint8Array) => new TextDecoder("latin1").decode(b);
const utf8 = (b: Uint8Array) => new TextDecoder("utf-8").decode(b);

/** Read any mesh file Kerf knows, by its name. Units are converted to millimetres. */
export async function readMeshFile(data: Uint8Array, file: string): Promise<MeshFile> {
  const format = meshFormat(file) ?? sniff(data);
  if (!format) throw new MeshReadError("Kerf imports meshes as STL, OBJ or 3MF files.");
  const name = cleanName(stem(file), 80) || "Mesh";
  if (format === "stl") return { format, meshes: parseStl(data, name), unit: null, title: name, warnings: [] };
  if (format === "obj") return { format, ...parseObj(utf8(data), name), unit: null, title: name };
  return { format, ...(await parse3mf(data, name)) };
}

function sniff(data: Uint8Array): MeshFormat | null {
  if (data[0] === 0x50 && data[1] === 0x4b) return "3mf";
  const head = latin1(data.subarray(0, 512));
  if (/^\s*solid\b/i.test(head)) return "stl";
  if (/^\s*(#|v |o |g |mtllib )/m.test(head)) return "obj";
  if (data.byteLength >= 84) {
    const n = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(80, true);
    if (84 + n * 50 === data.byteLength) return "stl";
  }
  return null;
}

// ---------------------------------------------------------------- STL

export function parseStl(data: Uint8Array, name = "Mesh"): RawMesh[] {
  if (data.byteLength >= 84) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const n = dv.getUint32(80, true);
    const size = 84 + n * 50;
    // text files can start with "solid" as binary headers often do too: the size decides
    if (n > 0 && (size === data.byteLength || (size < data.byteLength && data.byteLength - size < 4096 && !isTextStl(data)))) return [binaryStl(dv, n, name)];
  }
  if (isTextStl(data)) {
    const out = textStl(latin1(data), name);
    if (out.length) return out;
  }
  throw new MeshReadError("This is not an STL file Kerf can read: it is neither a binary STL nor a text one with facets.");
}

function isTextStl(data: Uint8Array) {
  const head = latin1(data.subarray(0, 1024));
  return /^\s*solid\b/i.test(head) && /\b(facet|endsolid)\b/i.test(latin1(data.subarray(0, Math.min(data.byteLength, 1 << 16))));
}

function binaryStl(dv: DataView, n: number, name: string): RawMesh {
  const positions = new Float32Array(n * 9);
  const triangles = new Uint32Array(n * 3);
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50 + 12;
    for (let k = 0; k < 9; k++) positions[t * 9 + k] = dv.getFloat32(o + k * 4, true);
    triangles[t * 3] = t * 3;
    triangles[t * 3 + 1] = t * 3 + 1;
    triangles[t * 3 + 2] = t * 3 + 2;
  }
  return { name, positions, triangles };
}

function textStl(text: string, name: string): RawMesh[] {
  const out: RawMesh[] = [];
  const solid = /solid[ \t]*([^\r\n]*)([\s\S]*?)(?:endsolid[^\r\n]*|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = solid.exec(text))) {
    const body = m[2];
    const pos: number[] = [];
    const tri: number[] = [];
    const loop = /outer\s+loop([\s\S]*?)endloop/gi;
    let l: RegExpExecArray | null;
    while ((l = loop.exec(body))) {
      const v = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
      const first = pos.length / 3;
      let k: RegExpExecArray | null;
      let count = 0;
      while ((k = v.exec(l[1]))) {
        pos.push(+k[1], +k[2], +k[3]);
        count++;
      }
      // a loop of more than three corners is a flat polygon: fan it out
      for (let j = 1; j + 1 < count; j++) tri.push(first, first + j, first + j + 1);
    }
    if (tri.length) out.push({ name: cleanName(m[1], 80) || name, positions: Float64Array.from(pos), triangles: Uint32Array.from(tri) });
  }
  // several solids that share a name are one object to the user
  if (out.length > 1 && out.every((o) => o.name === out[0].name)) return out.map((o, i) => ({ ...o, name: `${o.name} ${i + 1}` }));
  return out;
}

// ---------------------------------------------------------------- polygons

type P3 = [number, number, number];

/** Newell's normal of a polygon (not normalised): robust for slightly bent and concave ones. */
export function newell(pts: P3[]): P3 {
  let x = 0,
    y = 0,
    z = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    x += (a[1] - b[1]) * (a[2] + b[2]);
    y += (a[2] - b[2]) * (a[0] + b[0]);
    z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [x, y, z];
}

/**
 * Triangles that fill a polygon given as 3D corners, by ear clipping in its own
 * plane: indices into `pts`, wound the same way as the polygon. Null when the
 * outline crosses itself so badly that no ear can be cut.
 */
export function earClip(pts: P3[]): number[] | null {
  const n = pts.length;
  if (n < 3) return [];
  if (n === 3) return [0, 1, 2];
  const N = newell(pts);
  const len = Math.hypot(N[0], N[1], N[2]);
  if (len < 1e-30) return null;
  // drop the axis the normal points along most
  const ax = Math.abs(N[0]) > Math.abs(N[1]) ? (Math.abs(N[0]) > Math.abs(N[2]) ? 0 : 2) : Math.abs(N[1]) > Math.abs(N[2]) ? 1 : 2;
  const u = (ax + 1) % 3;
  const v = (ax + 2) % 3;
  const sign = N[ax] >= 0 ? 1 : -1;
  const x = pts.map((p) => p[u]);
  const y = pts.map((p) => p[v] * sign);
  const idx = Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  const cross = (a: number, b: number, c: number) => (x[b] - x[a]) * (y[c] - y[a]) - (y[b] - y[a]) * (x[c] - x[a]);
  const inside = (a: number, b: number, c: number, p: number) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length];
      const b = idx[i];
      const c = idx[(i + 1) % idx.length];
      if (cross(a, b, c) <= 0) continue;
      let ear = true;
      for (const p of idx) {
        if (p === a || p === b || p === c) continue;
        if (inside(a, b, c, p)) {
          ear = false;
          break;
        }
      }
      if (!ear) continue;
      out.push(a, b, c);
      idx.splice(i, 1);
      cut = true;
      break;
    }
    if (!cut) return null;
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

/** Triangles for a polygon face: ear clipping, or a fan when the outline is too tangled to clip. */
function polygonTriangles(pts: P3[]): number[] {
  if (pts.length === 3) return [0, 1, 2];
  const ears = earClip(pts);
  if (ears) return ears;
  const out: number[] = [];
  for (let j = 1; j + 1 < pts.length; j++) out.push(0, j, j + 1);
  return out;
}

// ---------------------------------------------------------------- OBJ

export function parseObj(text: string, name = "Mesh"): { meshes: RawMesh[]; warnings: string[] } {
  const v: number[] = [];
  const warnings: string[] = [];
  // objects ("o") become meshes of their own; groups ("g") often split one closed surface by material, so they do not
  type Group = { name: string; faces: number[] };
  const groups: Group[] = [];
  let cur: Group = { name: "", faces: [] };
  let bad = 0;
  let p = 0;
  const L = text.length;
  while (p < L) {
    let e = text.indexOf("\n", p);
    if (e < 0) e = L;
    let line = text.slice(p, e);
    p = e + 1;
    // a backslash at the end joins the next line
    while (line.endsWith("\\") && p < L) {
      let e2 = text.indexOf("\n", p);
      if (e2 < 0) e2 = L;
      line = line.slice(0, -1) + text.slice(p, e2);
      p = e2 + 1;
    }
    line = line.trim();
    if (!line || line[0] === "#") continue;
    const sp = line.search(/\s/);
    const key = sp < 0 ? line : line.slice(0, sp);
    const rest = sp < 0 ? "" : line.slice(sp + 1).trim();
    if (key === "v") {
      const t = rest.split(/\s+/);
      v.push(+t[0] || 0, +t[1] || 0, +t[2] || 0);
    } else if (key === "f" || key === "fo") {
      const count = v.length / 3;
      const ids: number[] = [];
      for (const tok of rest.split(/\s+/)) {
        const i = parseInt(tok, 10);
        if (!Number.isFinite(i) || i === 0) continue;
        const k = i > 0 ? i - 1 : count + i;
        if (k < 0 || k >= count) {
          bad++;
          ids.length = 0;
          break;
        }
        ids.push(k);
      }
      if (ids.length < 3) continue;
      if (ids.length === 3) cur.faces.push(ids[0], ids[1], ids[2]);
      else {
        const pts = ids.map((k) => [v[k * 3], v[k * 3 + 1], v[k * 3 + 2]] as P3);
        for (const t of polygonTriangles(pts)) cur.faces.push(ids[t]);
      }
    } else if (key === "o") {
      if (cur.faces.length) groups.push(cur);
      cur = { name: cleanName(rest, 80), faces: [] };
    }
  }
  if (cur.faces.length) groups.push(cur);
  if (bad) warnings.push(`${bad} face${bad === 1 ? "" : "s"} pointed at corners the file does not have and ${bad === 1 ? "was" : "were"} left out.`);
  if (!groups.length) throw new MeshReadError("This OBJ file has no faces: it may hold only points or lines.");
  const meshes = groups.map((g, gi) => {
    // each object gets its own copy of the corners it uses
    const map = new Map<number, number>();
    const pos: number[] = [];
    const tri = new Uint32Array(g.faces.length);
    for (let i = 0; i < g.faces.length; i++) {
      const k = g.faces[i];
      let j = map.get(k);
      if (j === undefined) {
        j = pos.length / 3;
        map.set(k, j);
        pos.push(v[k * 3], v[k * 3 + 1], v[k * 3 + 2]);
      }
      tri[i] = j;
    }
    return { name: g.name || (groups.length > 1 ? `${name} ${gi + 1}` : name), positions: Float64Array.from(pos), triangles: tri };
  });
  return { meshes, warnings };
}

// ---------------------------------------------------------------- 3MF

const UNIT_MM: Record<string, number> = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

/** Row-major 3MF transform "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32": p' = p·M. */
type M43 = number[];
const IDENT: M43 = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function parseTransform(s: string | undefined): M43 {
  if (!s) return IDENT;
  const t = s.trim().split(/\s+/).map(Number);
  return t.length === 12 && t.every(Number.isFinite) ? t : IDENT;
}

/** a then b */
function compose(a: M43, b: M43): M43 {
  const out = new Array<number>(12);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 3; c++) {
      let s = r === 3 ? b[9 + c] : 0;
      for (let k = 0; k < 3; k++) s += a[r * 3 + k] * b[k * 3 + c];
      out[r * 3 + c] = s;
    }
  return out;
}

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]] = unescapeXml(m[3] ?? m[4] ?? "");
  return out;
}

const unescapeXml = (s: string) =>
  s.indexOf("&") < 0 ? s : s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[e.toLowerCase()] ?? (e[1] === "x" || e[1] === "X" ? String.fromCodePoint(parseInt(e.slice(2), 16)) : String.fromCodePoint(parseInt(e.slice(1), 10))));

/** The local part of a tag name: "m:colorgroup" → "colorgroup". */
const local = (tag: string) => tag.slice(tag.indexOf(":") + 1);

function hexColor(s: string | undefined): string | undefined {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec((s ?? "").trim());
  return m ? `#${m[1].toLowerCase()}` : undefined;
}

interface Obj3mf {
  id: string;
  name: string;
  type: string;
  pid?: string;
  pindex?: number;
  pos?: Float64Array;
  tri?: Uint32Array;
  /** per triangle a colour (index into the model's palette) or -1 */
  triColor?: Int32Array;
  components: { objectid: string; path?: string; transform: M43 }[];
}

interface Model3mf {
  unit: string;
  title: string;
  objects: Map<string, Obj3mf>;
  build: { objectid: string; path?: string; transform: M43 }[];
  /** property groups: id → colours */
  groups: Map<string, (string | undefined)[]>;
}

function parseModel(xml: string): Model3mf {
  const model: Model3mf = { unit: "millimeter", title: "", objects: new Map(), build: [], groups: new Map() };
  const title = /<(?:\w+:)?metadata[^>]*name\s*=\s*"Title"[^>]*>([^<]*)</i.exec(xml);
  if (title) model.title = cleanName(unescapeXml(title[1]), 80);
  const tag = /<(\/?)([\w:]+)([^>]*?)(\/?)>/g;
  let obj: Obj3mf | null = null;
  let group: (string | undefined)[] | null = null;
  let pos: number[] = [];
  let tri: number[] = [];
  let tcol: number[] = [];
  let inBuild = false;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(xml))) {
    const close = m[1] === "/";
    const name = local(m[2]);
    const self = m[4] === "/";
    // the two tags that make up nearly all of a file are read without the general attribute parser
    if (name === "vertex" && obj) {
      const a = m[3];
      pos.push(num(a, "x"), num(a, "y"), num(a, "z"));
      continue;
    }
    if (name === "triangle" && obj) {
      const s = m[3];
      tri.push(num(s, "v1"), num(s, "v2"), num(s, "v3"));
      if (s.indexOf("pid=") >= 0 || s.indexOf("p1=") >= 0) {
        const a = attrs(s);
        const g = model.groups.get(a.pid ?? obj.pid ?? "");
        const idx = a.p1 !== undefined ? +a.p1 : (obj.pindex ?? 0);
        tcol.push(g && g[idx] ? colorIndex(model, g[idx]!) : -1);
      } else tcol.push(-2);
      continue;
    }
    if (close) {
      if (name === "object" && obj) {
        if (tri.length) {
          obj.pos = Float64Array.from(pos);
          obj.tri = Uint32Array.from(tri);
          if (tcol.some((c) => c !== -2)) obj.triColor = Int32Array.from(tcol, (c) => (c === -2 ? -1 : c));
        }
        model.objects.set(obj.id, obj);
        obj = null;
      } else if (name === "build") inBuild = false;
      else if (name === "basematerials" || name === "colorgroup") group = null;
      continue;
    }
    const a = attrs(m[3]);
    switch (name) {
      case "model":
        if (a.unit) model.unit = a.unit.toLowerCase();
        break;
      case "basematerials":
      case "colorgroup":
        group = [];
        if (a.id) model.groups.set(a.id, group);
        if (self) group = null;
        break;
      case "base":
        group?.push(hexColor(a.displaycolor));
        break;
      case "color":
        group?.push(hexColor(a.color));
        break;
      case "object":
        obj = { id: a.id, name: cleanName(a.name ?? "", 80), type: (a.type ?? "model").toLowerCase(), pid: a.pid, pindex: a.pindex !== undefined ? +a.pindex : undefined, components: [] };
        pos = [];
        tri = [];
        tcol = [];
        if (self) {
          model.objects.set(obj.id, obj);
          obj = null;
        }
        break;
      case "component":
        obj?.components.push({ objectid: a.objectid, path: a["p:path"] ?? a.path, transform: parseTransform(a.transform) });
        break;
      case "build":
        inBuild = !self;
        break;
      case "item":
        if (inBuild) model.build.push({ objectid: a.objectid, path: a["p:path"] ?? a.path, transform: parseTransform(a.transform) });
        break;
    }
  }
  return model;
}

/** A number attribute read straight from a tag's text, for the tags a file holds millions of. */
function num(a: string, key: string): number {
  const pat = `${key}=`;
  let i = a.indexOf(pat);
  // the name has to start an attribute: "v1" is not the end of "pv1"
  while (i > 0 && a.charCodeAt(i - 1) > 32) i = a.indexOf(pat, i + 1);
  if (i < 0) return 0;
  const q = i + pat.length;
  const end = a.indexOf(a[q], q + 1);
  return +a.slice(q + 1, end) || 0;
}

/** Colours are pooled per model so triangles can share a small palette. */
const palettes = new WeakMap<Model3mf, string[]>();
function colorIndex(model: Model3mf, c: string): number {
  let p = palettes.get(model);
  if (!p) palettes.set(model, (p = []));
  let i = p.indexOf(c);
  if (i < 0) {
    i = p.length;
    p.push(c);
  }
  return i;
}

async function parse3mf(data: Uint8Array, fallback: string): Promise<Omit<MeshFile, "format">> {
  let files: Map<string, Uint8Array>;
  try {
    files = await unzip(data);
  } catch {
    throw new MeshReadError("This 3MF file could not be opened: it is not a ZIP package, or it is damaged.");
  }
  const byLower = new Map<string, string>();
  for (const k of files.keys()) byLower.set(k.replace(/^\//, "").toLowerCase(), k);
  const read = (path: string): Uint8Array | undefined => {
    const k = byLower.get(path.replace(/^\//, "").toLowerCase());
    return k === undefined ? undefined : files.get(k);
  };
  let root = "3D/3dmodel.model";
  const rels = read("_rels/.rels");
  if (rels) {
    for (const r of utf8(rels).match(/<Relationship\b[^>]*>/gi) ?? []) {
      const a = attrs(r);
      if (/3dmodel$/i.test(a.Type ?? "") && a.Target) root = a.Target;
    }
  }
  const models = new Map<string, Model3mf>();
  const modelAt = (path: string): Model3mf | undefined => {
    const key = path.replace(/^\//, "").toLowerCase();
    if (models.has(key)) return models.get(key);
    const bytes = read(path);
    const m = bytes ? parseModel(utf8(bytes)) : undefined;
    if (m) models.set(key, m);
    return m;
  };
  const top = modelAt(root);
  if (!top) throw new MeshReadError("This 3MF file has no 3D model in it (no 3D/3dmodel.model).");
  const warnings: string[] = [];
  const scale = UNIT_MM[top.unit] ?? 1;
  if (!(top.unit in UNIT_MM)) warnings.push(`The file gives its unit as "${top.unit}"; Kerf read it as millimetres.`);
  const settings = slicerSettings(read);

  const meshes: RawMesh[] = [];
  let skipped = 0;
  for (const item of top.build) {
    const pos: number[] = [];
    const tri: number[] = [];
    const colors: number[] = [];
    const palette: string[] = [];
    let objName = "";
    let objColor: string | undefined;
    const addColor = (c: string | undefined) => {
      if (!c) return -1;
      let i = palette.indexOf(c);
      if (i < 0) palette.push(c), (i = palette.length - 1);
      return i;
    };
    const visit = (model: Model3mf, id: string, xf: M43, depth: number) => {
      const o = model.objects.get(id);
      if (!o || depth > 16) return;
      if (o.type !== "model" && o.type !== "solidsupport") {
        skipped++;
        return;
      }
      objName ||= o.name;
      if (o.pid !== undefined && !objColor) objColor = model.groups.get(o.pid)?.[o.pindex ?? 0];
      if (o.pos && o.tri) {
        const base = pos.length / 3;
        const P = o.pos;
        for (let i = 0; i < P.length; i += 3) {
          const x = P[i],
            y = P[i + 1],
            z = P[i + 2];
          pos.push((x * xf[0] + y * xf[3] + z * xf[6] + xf[9]) * scale, (x * xf[1] + y * xf[4] + z * xf[7] + xf[10]) * scale, (x * xf[2] + y * xf[5] + z * xf[8] + xf[11]) * scale);
        }
        // a mirroring transform turns the triangles inside out: wind them back
        const det = xf[0] * (xf[4] * xf[8] - xf[5] * xf[7]) - xf[1] * (xf[3] * xf[8] - xf[5] * xf[6]) + xf[2] * (xf[3] * xf[7] - xf[4] * xf[6]);
        const pal = palettes.get(model) ?? [];
        for (let t = 0; t < o.tri.length; t += 3) {
          const a = o.tri[t] + base,
            b = o.tri[t + 1] + base,
            c = o.tri[t + 2] + base;
          if (det < 0) tri.push(a, c, b);
          else tri.push(a, b, c);
          const ci = o.triColor ? o.triColor[t / 3] : -1;
          colors.push(ci >= 0 ? addColor(pal[ci]) : -1);
        }
      }
      for (const c of o.components) {
        const sub = c.path ? modelAt(c.path) : model;
        if (sub) visit(sub, c.objectid, compose(c.transform, xf), depth + 1);
      }
    };
    const start = item.path ? modelAt(item.path) : top;
    if (!start) continue;
    visit(start, item.objectid, item.transform, 0);
    if (!tri.length) continue;
    const slicer = settings.get(item.objectid);
    objColor ??= slicer?.color;
    const name = slicer?.name || objName || (top.build.length > 1 ? `${top.title || fallback} ${meshes.length + 1}` : top.title || fallback);
    const mesh: RawMesh = { name, positions: Float64Array.from(pos), triangles: Uint32Array.from(tri), color: objColor };
    if (palette.length > 1 || (palette.length === 1 && colors.some((c) => c < 0))) {
      // triangles without their own colour take the object's
      const fill = addColor(objColor ?? palette[0]);
      mesh.triColor = Uint16Array.from(colors, (c) => (c < 0 ? fill : c));
      mesh.palette = palette;
    } else if (palette.length === 1) mesh.color ??= palette[0];
    meshes.push(mesh);
  }
  if (skipped) warnings.push(`${skipped} support or helper object${skipped === 1 ? " was" : "s were"} left out.`);
  if (!meshes.length) throw new MeshReadError("This 3MF file places no objects on its build plate, so there is nothing to import.");
  return { meshes, unit: top.unit in UNIT_MM ? top.unit : null, title: top.title || fallback, warnings };
}

/**
 * Object names and filament colours that Bambu Studio and Orca Slicer keep
 * beside the model, by build object id. Other slicers' files have none.
 */
function slicerSettings(read: (path: string) => Uint8Array | undefined): Map<string, { name?: string; color?: string }> {
  const out = new Map<string, { name?: string; color?: string }>();
  const cfg = read("Metadata/model_settings.config");
  if (!cfg) return out;
  let filament: string[] = [];
  const proj = read("Metadata/project_settings.config");
  if (proj) {
    try {
      const j = JSON.parse(utf8(proj)) as { filament_colour?: string[] };
      filament = (j.filament_colour ?? []).map((c) => hexColor(c) ?? "");
    } catch {
      /* colours stay as the model gives them */
    }
  }
  const xml = utf8(cfg);
  const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/gi;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(xml))) {
    const id = attrs(m[1]).id;
    if (!id) continue;
    const meta = new Map<string, string>();
    // the object's own metadata comes before its <part> entries
    const head = m[2].split(/<part\b/i)[0];
    for (const t of head.match(/<metadata\b[^>]*>/gi) ?? []) {
      const a = attrs(t);
      if (a.key) meta.set(a.key, a.value ?? "");
    }
    const ext = parseInt(meta.get("extruder") ?? "", 10);
    out.set(id, { name: cleanName(meta.get("name") ?? "", 80) || undefined, color: Number.isFinite(ext) && ext >= 1 ? filament[ext - 1] || undefined : undefined });
  }
  return out;
}
