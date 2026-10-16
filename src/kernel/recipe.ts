// Geometry recipes: plain, serializable descriptions of solids.
// The evaluator produces them; the kernel worker turns them into exact
// B-rep solids with OpenCASCADE. Recipes are hashed so unchanged parts
// are never rebuilt.

export type V3 = [number, number, number];
export type V2 = [number, number];

export type Xform =
  | { op: "rotate"; angle: number; origin: V3; axis: V3 }
  | { op: "translate"; v: V3 };

export type ShapeRecipe =
  | { t: "box"; w: number; d: number; h: number; at: V3; r: number }
  | { t: "cyl"; d: number; h: number; at: V3; dir: V3 }
  | { t: "tube"; od: number; id: number; h: number; at: V3; dir: V3 }
  | { t: "cone"; d1: number; d2: number; h: number; at: V3; dir: V3 }
  | { t: "sphere"; d: number; at: V3 }
  | { t: "prism"; pts: V2[]; h: number; at: V3; dir: V3; rot: number }
  | { t: "rrect"; w: number; h: number; r: number; depth: number; at: V3; dir: V3; center: boolean }
  | { t: "revolve"; pts: V2[]; at: V3; dir: V3 }
  | { t: "gear"; m: number; z: number; w: number; bore: number; at: V3; dir: V3; phase: number; pa: number; backlash: number }
  | { t: "hole"; d: number; depth: number; at: V3; dir: V3; cbore?: V2; csink?: number }
  | { t: "xform"; shape: ShapeRecipe; xf: Xform[] }
  | { t: "union"; shapes: ShapeRecipe[] };

export type EdgeSel = "vertical" | "top" | "bottom" | "all";

export type PartOp =
  | { op: "add" | "cut" | "intersect"; shape: ShapeRecipe }
  | { op: "shell"; t: number; open: V3 }
  | { op: "fillet" | "chamfer"; r: number; edges: EdgeSel };

export interface PartRecipe {
  base: ShapeRecipe | null;
  ops: PartOp[];
}

// ---------- small vector math shared by evaluator, kernel and viewer ----------

export const vadd = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vsub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vscale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const vdot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vcross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const vlen = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const vnorm = (a: V3): V3 => {
  const l = vlen(a);
  return l < 1e-12 ? [0, 0, 1] : [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * Right-handed in-plane frame for a direction: profiles are drawn in (u, v)
 * and extruded along dir. Horizontal directions keep v pointing up (+Z) so
 * a wall cutout's height is always vertical.
 */
export function frameFor(dirIn: V3): { u: V3; v: V3; n: V3 } {
  const n = vnorm(dirIn);
  if (Math.abs(n[2]) > 0.999) {
    const u: V3 = [1, 0, 0];
    return { u, v: vcross(n, u), n };
  }
  const u = vnorm(vcross([0, 0, 1], n));
  return { u, v: vcross(n, u), n };
}

/** Rotate point p about an axis through origin by angle (degrees), right-handed. */
export function rotateAbout(p: V3, origin: V3, axis: V3, angleDeg: number): V3 {
  const k = vnorm(axis);
  const a = (angleDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const v = vsub(p, origin);
  const kxv = vcross(k, v);
  const kdv = vdot(k, v);
  const r: V3 = [
    v[0] * c + kxv[0] * s + k[0] * kdv * (1 - c),
    v[1] * c + kxv[1] * s + k[1] * kdv * (1 - c),
    v[2] * c + kxv[2] * s + k[2] * kdv * (1 - c),
  ];
  return vadd(r, origin);
}

export function applyXforms(p: V3, xf: Xform[]): V3 {
  let q = p;
  for (const x of xf) {
    if (x.op === "translate") q = vadd(q, x.v);
    else q = rotateAbout(q, x.origin, x.axis, x.angle);
  }
  return q;
}

export function applyXformsToDir(d: V3, xf: Xform[]): V3 {
  let q = d;
  for (const x of xf) if (x.op === "rotate") q = rotateAbout(q, [0, 0, 0], x.axis, x.angle);
  return q;
}

/** Column-major 4x4 matrix (three.js layout) for a transform chain. */
export function xformMatrix(xf: Xform[]): number[] {
  let m = identity();
  for (const x of xf) {
    const step = x.op === "translate" ? translation(x.v) : rotationAbout(x.origin, x.axis, x.angle);
    m = mul(step, m);
  }
  return m;
}

function identity(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
function translation(v: V3): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, v[0], v[1], v[2], 1];
}
function rotationAbout(o: V3, axis: V3, angleDeg: number): number[] {
  const [x, y, z] = vnorm(axis);
  const a = (angleDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const t = 1 - c;
  // rotation part (column-major)
  const r = [
    t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ];
  return mul(translation(o), mul(r, translation([-o[0], -o[1], -o[2]])));
}
export function mul(a: number[], b: number[]): number[] {
  const out = new Array(16).fill(0);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = s;
    }
  return out;
}

// ---------- hashing ----------

/** Deterministic JSON (sorted keys, rounded floats) for content hashing. */
export function stableStringify(v: unknown): string {
  if (typeof v === "number") return Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(o[k])).join(",") + "}";
}

/** FNV-1a 64-bit-ish hash (two 32-bit lanes) rendered as hex. */
export function hashString(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) ^ (h2 >>> 15);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

export const recipeHash = (r: unknown) => hashString(stableStringify(r));
