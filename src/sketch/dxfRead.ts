// Reading DXF drawings for sketches: the lines, arcs, circles, polylines,
// splines, ellipses and points in model space, with blocks expanded, in
// millimetres and flattened onto the drawing's XY plane. Centre, hidden and
// bend lines come back as guides (construction geometry), so they do not
// break the outline into pieces. Text, dimensions, hatches and the like are
// counted and left out. Any version of ASCII DXF; binary DXF is refused with
// a way round it.

import type { V2 } from "../kernel/recipe";
import { splineBeziers, type Bez } from "./curves";

export class DxfError extends Error {}

export type DxfCurve =
  | { t: "line"; a: V2; b: V2; guide: boolean }
  /** counter-clockwise from `a0` through `sweep` (radians, 0 < sweep < 2π) */
  | { t: "arc"; c: V2; r: number; a0: number; sweep: number; guide: boolean }
  | { t: "circle"; c: V2; r: number; guide: boolean }
  /** a whole ellipse: radii along its own axes, turned `angle` radians */
  | { t: "ellipse"; c: V2; rx: number; ry: number; angle: number; guide: boolean }
  /** a smooth curve through `pts`: a B-spline or a piece of an ellipse, sampled closely */
  | { t: "spline"; pts: V2[]; closed: boolean; guide: boolean }
  | { t: "point"; p: V2 };

export interface DxfDrawing {
  curves: DxfCurve[];
  /** the unit the file names ("millimetres", "inches"), or null when it does not say */
  unit: string | null;
  /** the unit the drawing was read in, after any guess or override */
  readAs: string;
  /** millimetres per drawing unit */
  scale: number;
  /** what was left out, by kind, with how many: { text: 3, dimension: 2 } */
  skipped: Record<string, number>;
  warnings: string[];
}

/** DXF $INSUNITS codes Kerf reads: name and millimetres per unit. */
const UNITS: Record<number, [string, number]> = {
  1: ["inches", 25.4],
  2: ["feet", 304.8],
  4: ["millimetres", 1],
  5: ["centimetres", 10],
  6: ["metres", 1000],
  8: ["microinches", 25.4e-6],
  9: ["mils", 0.0254],
  10: ["yards", 914.4],
  13: ["microns", 1e-3],
  14: ["decimetres", 100],
};

/** More curves than this (after blocks are expanded) is not an outline to sketch from. */
export const MAX_DXF_ENTITIES = 200_000;

// ---------------- group codes ----------------

interface Groups {
  code: Int32Array;
  val: string[];
}

function readGroups(text: string): Groups {
  const lines = text.split(/\r\n|\r|\n/);
  const n = Math.floor(lines.length / 2);
  const code = new Int32Array(n);
  const val: string[] = new Array(n);
  let k = 0;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const c = lines[i].trim();
    if (!c && i + 2 >= lines.length) break;
    const v = Number(c);
    if (!Number.isInteger(v)) throw new DxfError(`Line ${i + 1} of the file should be a DXF group code but reads "${c.slice(0, 24)}". The file may be damaged or not a DXF.`);
    code[k] = v;
    val[k++] = lines[i + 1].trim();
  }
  return { code: code.subarray(0, k), val: val.slice(0, k) };
}

/** One entity (or table entry, or block header): its type and its groups up to the next code 0. */
interface Raw {
  type: string;
  codes: number[];
  vals: string[];
}

const num = (r: Raw, code: number, d = 0) => {
  const k = r.codes.indexOf(code);
  const v = k < 0 ? NaN : Number(r.vals[k]);
  return Number.isFinite(v) ? v : d;
};
const str = (r: Raw, code: number, d = "") => {
  const k = r.codes.indexOf(code);
  return k < 0 ? d : r.vals[k];
};
const nums = (r: Raw, code: number) => r.codes.flatMap((c, k) => (c === code ? [Number(r.vals[k]) || 0] : []));

function readRaws(g: Groups, from: number, to: number): Raw[] {
  const out: Raw[] = [];
  let cur: Raw | null = null;
  for (let i = from; i < to; i++) {
    if (g.code[i] === 0) {
      cur = { type: g.val[i].toUpperCase(), codes: [], vals: [] };
      out.push(cur);
    } else if (cur) {
      cur.codes.push(g.code[i]);
      cur.vals.push(g.val[i]);
    }
  }
  return out;
}

// ---------------- 2D placement ----------------

/** x' = a x + b y + e, y' = c x + d y + f */
type Xf = [number, number, number, number, number, number];
const ID: Xf = [1, 0, 0, 1, 0, 0];
const mulXf = (m: Xf, n: Xf): Xf => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[0] * n[4] + m[1] * n[5] + m[4], m[2] * n[4] + m[3] * n[5] + m[5]];
const ap = (m: Xf, x: number, y: number): V2 => [m[0] * x + m[1] * y + m[4], m[2] * x + m[3] * y + m[5]];
const det = (m: Xf) => m[0] * m[3] - m[1] * m[2];
const turn = (deg: number): Xf => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, -s, s, c, 0, 0];
};
const move = (x: number, y: number): Xf => [1, 0, 0, 1, x, y];

/** A turn and an even scale, perhaps mirrored: circles stay circles. */
function similar(m: Xf): boolean {
  const s = Math.sqrt(Math.abs(det(m)));
  if (!(s > 1e-12)) return false;
  const e = 1e-6 * s;
  return det(m) > 0 ? Math.abs(m[0] - m[3]) < e && Math.abs(m[1] + m[2]) < e : Math.abs(m[0] + m[3]) < e && Math.abs(m[1] - m[2]) < e;
}

/** The ellipse the unit circle maps to under the linear part of `m`: radii and the turn of the first. */
function ellipseOf(m: Xf): { rx: number; ry: number; angle: number } {
  const [a, b, c, d] = m;
  const E = (a + d) / 2;
  const F = (a - d) / 2;
  const G = (c + b) / 2;
  const H = (c - b) / 2;
  const Q = Math.hypot(E, H);
  const R = Math.hypot(F, G);
  const a1 = Math.atan2(G, F);
  const a2 = Math.atan2(H, E);
  return { rx: Q + R, ry: Math.abs(Q - R), angle: (a2 + a1) / 2 };
}

/**
 * The object coordinate system of an entity with extrusion direction N (the
 * DXF arbitrary axis rule), seen from above: its x and y axes and its
 * elevation as a map onto the drawing's XY plane.
 */
function ocs(r: Raw, z = 0): { xf: Xf; flat: boolean } {
  let nx = num(r, 210, 0);
  let ny = num(r, 220, 0);
  let nz = num(r, 230, 1);
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l;
  ny /= l;
  nz /= l;
  if (Math.abs(nx) < 1e-12 && Math.abs(ny) < 1e-12) return { xf: nz < 0 ? [-1, 0, 0, 1, 0, 0] : ID, flat: true };
  // Ax = (Wy or Wz) × N, Ay = N × Ax
  let ax: [number, number, number] = Math.abs(nx) < 1 / 64 && Math.abs(ny) < 1 / 64 ? [nz, 0, -nx] : [-ny, nx, 0];
  const al = Math.hypot(...ax) || 1;
  ax = [ax[0] / al, ax[1] / al, ax[2] / al];
  const ay: [number, number, number] = [ny * ax[2] - nz * ax[1], nz * ax[0] - nx * ax[2], nx * ax[1] - ny * ax[0]];
  return { xf: [ax[0], ay[0], ax[1], ay[1], z * nx, z * ny], flat: Math.abs(nz) > 1 - 1e-9 };
}

// ---------------- sampling curves ----------------

const bezAt = (b: Bez, u: number): V2 => {
  const v = 1 - u;
  return [v * v * v * b.a[0] + 3 * v * v * u * b.c1[0] + 3 * v * u * u * b.c2[0] + u * u * u * b.b[0], v * v * v * b.a[1] + 3 * v * v * u * b.c1[1] + 3 * v * u * u * b.c2[1] + u * u * u * b.b[1]];
};

/** Distance from p to a polyline. */
function offLine(p: V2, line: V2[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i];
    const b = line[i + 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L = dx * dx + dy * dy;
    const t = L > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return best;
}

/**
 * The points a sketch spline passes through to follow a curve f(t) within
 * `tol`. A first set is spaced so each chord stays near the curve; then, where
 * the smooth curve through the points strays further than `tol`, a point is
 * added halfway along, until it follows everywhere. `breaks` are parameters
 * the points must include (knots). Closed: f(end) is f(start), and the
 * points go round without repeating it.
 */
function fitCurve(f: (t: number) => V2, breaks: number[], tol: number, closed = false, max = 400): V2[] {
  const ts: number[] = [breaks[0]];
  const off = (p0: V2, p1: V2, p: V2) => offLine(p, [p0, p1]);
  const split = (t0: number, p0: V2, t1: number, p1: V2, depth: number) => {
    const tm = (t0 + t1) / 2;
    const pm = f(tm);
    // the middle's distance from the chord, and the quarter points so an S-bend is not missed
    const far = depth < 1 || off(p0, p1, pm) > tol * 4 || off(p0, p1, f((t0 + tm) / 2)) > tol * 4 || off(p0, p1, f((tm + t1) / 2)) > tol * 4;
    if (depth < 12 && far && ts.length < max) {
      split(t0, p0, tm, pm, depth + 1);
      split(tm, pm, t1, p1, depth + 1);
    } else ts.push(t1);
  };
  for (let i = 0; i + 1 < breaks.length; i++) if (breaks[i + 1] > breaks[i]) split(breaks[i], f(breaks[i]), breaks[i + 1], f(breaks[i + 1]), 0);
  let T = ts;
  for (let round = 0; round < 12; round++) {
    const pts = (closed ? T.slice(0, -1) : T).map(f);
    const bez = splineBeziers(pts, closed);
    if (bez.length !== T.length - 1) break;
    const add: number[] = [];
    bez.forEach((b, i) => {
      const truth = Array.from({ length: 17 }, (_, k) => f(T[i] + ((T[i + 1] - T[i]) * k) / 16));
      let worst = 0;
      for (let k = 1; k < 16 && worst <= tol; k++) worst = Math.max(worst, offLine(bezAt(b, k / 16), truth));
      if (worst > tol) add.push((T[i] + T[i + 1]) / 2);
    });
    if (!add.length || T.length + add.length > max) break;
    T = [...T, ...add].sort((a, b) => a - b);
  }
  return (closed ? T.slice(0, -1) : T).map(f);
}

/** A point on a (possibly rational) B-spline at t, by de Boor's algorithm. */
function deBoor(p: number, U: number[], P: [number, number, number][], t: number): V2 {
  const n = P.length;
  let k = p;
  while (k < n - 1 && t >= U[k + 1]) k++;
  const d: [number, number, number][] = [];
  for (let j = 0; j <= p; j++) {
    const q = P[Math.min(n - 1, Math.max(0, j + k - p))];
    d.push([q[0] * q[2], q[1] * q[2], q[2]]);
  }
  for (let r = 1; r <= p; r++)
    for (let j = p; j >= r; j--) {
      const i = j + k - p;
      const den = U[i + p - r + 1] - U[i];
      const a = den > 1e-15 ? (t - U[i]) / den : 0;
      for (let c = 0; c < 3; c++) d[j][c] = (1 - a) * d[j - 1][c] + a * d[j][c];
    }
  const w = d[p][2] || 1;
  return [d[p][0] / w, d[p][1] / w];
}

// ---------------- reading ----------------

interface Layer {
  frozen: boolean;
  ltype: string;
}

interface Block {
  base: V2;
  ents: Raw[];
}

/** Linetypes drawn broken: centre lines, hidden lines, bend lines. */
const BROKEN = /^(center|centre|dash|hidden|phantom|dot|divide|border|acad_iso(0[2-9]|1[0-5]))/i;
/** Layers that hold guides rather than outline. */
const GUIDE_LAYER = /^(center|centre|centerlines?|centrelines?|construction|constr|hidden|bend|bends|bendlines?)$/i;

const KIND_WORDS: Record<string, string> = {
  TEXT: "text",
  MTEXT: "text",
  ATTDEF: "text",
  ATTRIB: "text",
  DIMENSION: "dimension",
  ARC_DIMENSION: "dimension",
  LEADER: "leader",
  MULTILEADER: "leader",
  MLEADER: "leader",
  HATCH: "hatch",
  SOLID: "filled area",
  TRACE: "filled area",
  WIPEOUT: "filled area",
  "3DFACE": "3D face",
  "3DSOLID": "solid",
  BODY: "solid",
  REGION: "region",
  MESH: "mesh",
  IMAGE: "image",
  TOLERANCE: "tolerance",
  XLINE: "construction line",
  RAY: "construction line",
};

/** Read a DXF drawing's model space as 2D curves in millimetres. */
export function readDxf(text: string, opts: { unit?: "mm" | "in" } = {}): DxfDrawing {
  if (/^AutoCAD Binary DXF/.test(text)) throw new DxfError("This is a binary DXF, which Kerf does not read. Save it from the CAD program as an ASCII (text) DXF and import that.");
  const g = readGroups(text);
  if (!g.code.length) throw new DxfError("The file is empty.");
  // sections
  const sections = new Map<string, [number, number]>();
  for (let i = 0; i < g.code.length; i++) {
    if (g.code[i] !== 0 || g.val[i] !== "SECTION") continue;
    const name = g.code[i + 1] === 2 ? g.val[i + 1].toUpperCase() : "";
    let j = i + 2;
    while (j < g.code.length && !(g.code[j] === 0 && g.val[j] === "ENDSEC")) j++;
    sections.set(name, [i + 2, j]);
    i = j;
  }
  const ent = sections.get("ENTITIES");
  if (!ent) throw new DxfError(sections.size ? "The DXF has no ENTITIES section, so there is nothing to draw." : "This does not look like a DXF: it has no sections. Save the drawing as DXF from the CAD program and try again.");

  // header: units
  let insunits = 0;
  let measurement = -1;
  const head = sections.get("HEADER");
  if (head)
    for (let i = head[0]; i < head[1]; i++) {
      if (g.code[i] !== 9) continue;
      if (g.val[i] === "$INSUNITS" && g.code[i + 1] === 70) insunits = Number(g.val[i + 1]) || 0;
      if (g.val[i] === "$MEASUREMENT" && g.code[i + 1] === 70) measurement = Number(g.val[i + 1]);
    }
  const warnings: string[] = [];
  const named = UNITS[insunits];
  let scale = named?.[1] ?? 1;
  let readAs = named?.[0] ?? "millimetres";
  if (opts.unit) {
    scale = opts.unit === "in" ? 25.4 : 1;
    readAs = opts.unit === "in" ? "inches" : "millimetres";
  } else if (!named) {
    if (insunits && !UNITS[insunits]) warnings.push(`The file's unit (code ${insunits}) is not one Kerf knows, so it was read in millimetres.`);
    else if (measurement === 0) {
      scale = 25.4;
      readAs = "inches";
      warnings.push("The file does not give its unit but is set up for imperial drawings, so Kerf read it in inches.");
    } else warnings.push("The file does not give its unit, so Kerf read it in millimetres.");
  }

  // layers
  const layers = new Map<string, Layer>();
  const tables = sections.get("TABLES");
  if (tables)
    for (const r of readRaws(g, tables[0], tables[1]))
      if (r.type === "LAYER") {
        const name = str(r, 2).toUpperCase();
        layers.set(name, { frozen: (num(r, 70) & 1) === 1 || num(r, 62, 7) < 0, ltype: str(r, 6, "CONTINUOUS") });
      }

  // blocks
  const blocks = new Map<string, Block>();
  const bsec = sections.get("BLOCKS");
  if (bsec) {
    let cur: Block | null = null;
    for (const r of readRaws(g, bsec[0], bsec[1])) {
      if (r.type === "BLOCK") {
        cur = { base: [num(r, 10), num(r, 20)], ents: [] };
        // external references and dimension pictures are not drawn from here
        const name = str(r, 2).toUpperCase();
        if (!(num(r, 70) & 4) && !name.startsWith("*D")) blocks.set(name, cur);
      } else if (r.type === "ENDBLK") cur = null;
      else cur?.ents.push(r);
    }
  }

  const curves: DxfCurve[] = [];
  const skipped: Record<string, number> = {};
  const skip = (what: string, n = 1) => (skipped[what] = (skipped[what] ?? 0) + n);
  let tilted = false;
  const top = readRaws(g, ent[0], ent[1]);
  let size = 0;
  for (const r of top) for (let k = 0; k < r.codes.length; k++) if (r.codes[k] === 10 || r.codes[k] === 11) size = Math.max(size, Math.abs(Number(r.vals[k]) || 0));
  // how far a curve brought in as a spline through points may stray from the original, in drawing units:
  // two hundredths of a millimetre (a tenth of a laser's kerf), or less for a small drawing
  const tol = Math.max(1e-7, Math.min(0.02 / scale, (size || 1) * 4e-4));

  /** the circle of radius r round the local origin, placed by m: an ellipse, or a circle when it stays round */
  const pushEllipse = (m: Xf, r: number, guide: boolean) => {
    const e = ellipseOf(m);
    const c = ap(m, 0, 0);
    if (Math.abs(e.rx - e.ry) <= 1e-9 * e.rx) curves.push({ t: "circle", c, r: r * e.rx, guide });
    else curves.push({ t: "ellipse", c, rx: r * e.rx, ry: r * e.ry, angle: e.angle, guide });
  };

  const emitArc = (m: Xf, c: V2, r: number, a0: number, sweep: number, guide: boolean) => {
    if (!(r > 0) || !(sweep > 0)) return;
    const full = sweep >= 2 * Math.PI - 1e-9;
    if (similar(m)) {
      const s = Math.sqrt(Math.abs(det(m)));
      const cc = ap(m, c[0], c[1]);
      if (full) return void curves.push({ t: "circle", c: cc, r: r * s, guide });
      const flip = det(m) < 0;
      const from = flip ? a0 + sweep : a0;
      const p = ap(m, c[0] + r * Math.cos(from), c[1] + r * Math.sin(from));
      curves.push({ t: "arc", c: cc, r: r * s, a0: Math.atan2(p[1] - cc[1], p[0] - cc[0]), sweep, guide });
      return;
    }
    // stretched unevenly: a circle becomes an ellipse, an arc a piece of one
    if (full) return void pushEllipse(mulXf(m, move(c[0], c[1])), r, guide);
    const pts = fitCurve((t) => ap(m, c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)), [a0, a0 + sweep / 2, a0 + sweep], tol);
    curves.push({ t: "spline", pts, closed: false, guide });
  };

  /** a polyline's vertices with the bulge of the segment after each */
  const emitPolyline = (m: Xf, V: { p: V2; bulge: number }[], closed: boolean, guide: boolean) => {
    const n = V.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const A = V[i].p;
      const B = V[(i + 1) % n].p;
      const b = V[i].bulge;
      const cl = Math.hypot(B[0] - A[0], B[1] - A[1]);
      if (cl < 1e-12) continue;
      if (Math.abs(b) < 1e-9) {
        curves.push({ t: "line", a: ap(m, A[0], A[1]), b: ap(m, B[0], B[1]), guide });
        continue;
      }
      // the centre sits off the chord's middle, to the left for a counter-clockwise bulge
      const ux = (B[0] - A[0]) / cl;
      const uy = (B[1] - A[1]) / cl;
      const off = (cl * (1 - b * b)) / (4 * b);
      const c: V2 = [(A[0] + B[0]) / 2 - uy * off, (A[1] + B[1]) / 2 + ux * off];
      const r = (cl * (1 + b * b)) / (4 * Math.abs(b));
      const sweep = 4 * Math.atan(Math.abs(b));
      const from = b > 0 ? A : B;
      emitArc(m, c, r, Math.atan2(from[1] - c[1], from[0] - c[0]), sweep, guide);
    }
  };

  const emit = (list: Raw[], xf: Xf, depth: number, inherit: { layer: string; ltype: string }) => {
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (curves.length > MAX_DXF_ENTITIES) throw new DxfError(`The drawing has more than ${MAX_DXF_ENTITIES.toLocaleString()} curves once its blocks are expanded, which is too many to sketch from.`);
      if (r.type === "SEQEND" || r.type === "VERTEX") continue;
      if (num(r, 67) === 1) {
        skip("paper space item");
        continue;
      }
      let layer = str(r, 8, "0").toUpperCase();
      if (layer === "0" && depth > 0) layer = inherit.layer;
      if (layer === "DEFPOINTS") continue;
      const L = layers.get(layer);
      if (L?.frozen || num(r, 60) === 1) {
        skip("hidden item");
        continue;
      }
      let lt = str(r, 6, "BYLAYER").toUpperCase();
      if (lt === "BYLAYER") lt = (L?.ltype ?? "CONTINUOUS").toUpperCase();
      if (lt === "BYBLOCK") lt = inherit.ltype;
      const guide = BROKEN.test(lt) || GUIDE_LAYER.test(layer);
      switch (r.type) {
        case "LINE": {
          curves.push({ t: "line", a: ap(xf, num(r, 10), num(r, 20)), b: ap(xf, num(r, 11), num(r, 21)), guide });
          break;
        }
        case "POINT":
          curves.push({ t: "point", p: ap(xf, num(r, 10), num(r, 20)) });
          break;
        case "CIRCLE":
        case "ARC": {
          const o = ocs(r, num(r, 30));
          tilted ||= !o.flat;
          const m = mulXf(xf, o.xf);
          const a0 = r.type === "CIRCLE" ? 0 : (num(r, 50) * Math.PI) / 180;
          let sweep = r.type === "CIRCLE" ? 2 * Math.PI : ((num(r, 51) - num(r, 50)) * Math.PI) / 180;
          while (sweep <= 0) sweep += 2 * Math.PI;
          while (sweep > 2 * Math.PI + 1e-12) sweep -= 2 * Math.PI;
          emitArc(m, [num(r, 10), num(r, 20)], num(r, 40), a0, sweep, guide);
          break;
        }
        case "LWPOLYLINE": {
          const o = ocs(r, num(r, 38));
          tilted ||= !o.flat;
          const V: { p: V2; bulge: number }[] = [];
          for (let k = 0; k < r.codes.length; k++) {
            const c = r.codes[k];
            const v = Number(r.vals[k]) || 0;
            if (c === 10) V.push({ p: [v, 0], bulge: 0 });
            else if (c === 20 && V.length) V[V.length - 1].p[1] = v;
            else if (c === 42 && V.length) V[V.length - 1].bulge = v;
          }
          emitPolyline(mulXf(xf, o.xf), V, (num(r, 70) & 1) === 1, guide);
          break;
        }
        case "POLYLINE": {
          const flags = num(r, 70);
          const verts: Raw[] = [];
          let j = i + 1;
          for (; j < list.length && list[j].type === "VERTEX"; j++) verts.push(list[j]);
          if (list[j]?.type === "SEQEND") j++;
          i = j - 1;
          if (flags & (16 | 64)) {
            skip("mesh");
            break;
          }
          const three = (flags & 8) === 8;
          const o = three ? { xf: ID, flat: true } : ocs(r, num(r, 30));
          tilted ||= !o.flat;
          // a spline-fit polyline is drawn through its fitted vertices, not its frame
          const use = verts.filter((v) => !(num(v, 70) & 16) && (!(flags & 4) || num(v, 70) & 8));
          emitPolyline(
            mulXf(xf, o.xf),
            use.map((v) => ({ p: [num(v, 10), num(v, 20)], bulge: three ? 0 : num(v, 42) })),
            (flags & 1) === 1,
            guide,
          );
          break;
        }
        case "ELLIPSE": {
          const c: V2 = [num(r, 10), num(r, 20)];
          const mj: [number, number, number] = [num(r, 11), num(r, 21), num(r, 31)];
          const k = num(r, 40, 1);
          let nx = num(r, 210, 0);
          let ny = num(r, 220, 0);
          let nz = num(r, 230, 1);
          const l = Math.hypot(nx, ny, nz) || 1;
          nx /= l;
          ny /= l;
          nz /= l;
          tilted ||= Math.abs(nz) < 1 - 1e-9;
          // the minor axis is the major turned a quarter about the extrusion direction
          const mn: V2 = [k * (ny * mj[2] - nz * mj[1]), k * (nz * mj[0] - nx * mj[2])];
          const t0 = num(r, 41, 0);
          let t1 = num(r, 42, 2 * Math.PI);
          while (t1 <= t0) t1 += 2 * Math.PI;
          const m = mulXf(xf, [mj[0], mn[0], mj[1], mn[1], c[0], c[1]]);
          if (t1 - t0 >= 2 * Math.PI - 1e-9) pushEllipse(m, 1, guide);
          else {
            const steps = Array.from({ length: 5 }, (_, q) => t0 + ((t1 - t0) * q) / 4);
            curves.push({ t: "spline", pts: fitCurve((t) => ap(m, Math.cos(t), Math.sin(t)), steps, tol), closed: false, guide });
          }
          break;
        }
        case "SPLINE": {
          const flags = num(r, 70);
          const p = Math.max(1, Math.round(num(r, 71, 3)));
          const U = nums(r, 40);
          const W = nums(r, 41);
          const xs = nums(r, 10);
          const ys = nums(r, 20);
          const P: [number, number, number][] = xs.map((x, q) => [x, ys[q] ?? 0, W.length === xs.length && W[q] > 0 ? W[q] : 1]);
          const gap = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
          const said = (flags & 1) === 1 || (flags & 2) === 2;
          let pts: V2[];
          // whether the points go round: the first is not repeated at the end
          let round = false;
          if (P.length > p && U.length === P.length + p + 1 && p > 1) {
            const lo = U[p];
            const hi = U[P.length];
            const f = (t: number) => {
              const q = deBoor(p, U, P, Math.min(hi, Math.max(lo, t)));
              return ap(xf, q[0], q[1]);
            };
            const breaks = [...new Set(U.slice(p, P.length + 1))].sort((x, y) => x - y);
            round = gap(f(lo), f(hi)) < tol;
            pts = fitCurve(f, breaks.length > 1 ? breaks : [lo, hi], tol, round);
          } else {
            // straight pieces between control points, or a curve through its fit points
            const fx = nums(r, 11);
            const fy = nums(r, 21);
            pts = (p === 1 || fx.length < 2 ? P.map((q): V2 => [q[0], q[1]]) : fx.map((x, q): V2 => [x, fy[q] ?? 0])).map((q) => ap(xf, q[0], q[1]));
            if (pts.length > 2 && gap(pts[0], pts[pts.length - 1]) < tol) {
              pts = pts.slice(0, -1);
              round = true;
            } else round = said && pts.length > 2;
          }
          if (pts.length < 2 || (round && pts.length < 3)) {
            skip("spline Kerf could not read");
            break;
          }
          if (p === 1) emitPolyline(ID, pts.map((q) => ({ p: q, bulge: 0 })), round, guide);
          else curves.push({ t: "spline", pts, closed: round, guide });
          break;
        }
        case "INSERT": {
          const b = blocks.get(str(r, 2).toUpperCase());
          // attributes follow an insert when it has them
          if (num(r, 66) === 1) {
            let j = i + 1;
            let n = 0;
            for (; j < list.length && list[j].type === "ATTRIB"; j++) n++;
            if (list[j]?.type === "SEQEND") j++;
            if (n) skip("text", n);
            i = j - 1;
          }
          if (!b) {
            skip("missing block");
            break;
          }
          if (depth > 12) {
            skip("block nested too deep");
            break;
          }
          const o = ocs(r, num(r, 30));
          tilted ||= !o.flat;
          const sx = num(r, 41, 1) || 1;
          const sy = num(r, 42, 1) || 1;
          const cols = Math.max(1, Math.min(1000, num(r, 70, 1)));
          const rows = Math.max(1, Math.min(1000, num(r, 71, 1)));
          const base = mulXf(mulXf(xf, o.xf), mulXf(move(num(r, 10), num(r, 20)), turn(num(r, 50))));
          const inner = mulXf([sx, 0, 0, sy, 0, 0], move(-b.base[0], -b.base[1]));
          const next = { layer, ltype: lt };
          for (let cI = 0; cI < cols; cI++) for (let rI = 0; rI < rows; rI++) emit(b.ents, mulXf(base, mulXf(move(cI * num(r, 44), rI * num(r, 45)), inner)), depth + 1, next);
          break;
        }
        default:
          skip(KIND_WORDS[r.type] ?? r.type.toLowerCase());
      }
    }
  };
  emit(top, ID, 0, { layer: "0", ltype: "CONTINUOUS" });
  if (tilted) warnings.push("Some curves were drawn on planes tilted from the drawing's XY plane; they were flattened onto it.");

  // into millimetres
  if (scale !== 1) {
    const S = (p: V2): V2 => [p[0] * scale, p[1] * scale];
    for (const c of curves) {
      if (c.t === "line") {
        c.a = S(c.a);
        c.b = S(c.b);
      } else if (c.t === "point") c.p = S(c.p);
      else if (c.t === "spline") c.pts = c.pts.map(S);
      else if (c.t === "ellipse") {
        c.c = S(c.c);
        c.rx *= scale;
        c.ry *= scale;
      } else {
        c.c = S(c.c);
        c.r *= scale;
      }
    }
  }
  return { curves, unit: named?.[0] ?? null, readAs, scale, skipped, warnings };
}
