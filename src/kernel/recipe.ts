// Geometry recipes: plain, serializable descriptions of solids.
// The evaluator produces them; the kernel worker turns them into exact
// B-rep solids with OpenCASCADE. Recipes are hashed so unchanged parts
// are never rebuilt.

export type V3 = [number, number, number];
export type V2 = [number, number];

export type Xform =
  | { op: "rotate"; angle: number; origin: V3; axis: V3 }
  | { op: "translate"; v: V3 }
  | { op: "mirror"; origin: V3; normal: V3 };

/**
 * A closed 2D outline in a plane. Profiles are drawn in (u, v) coordinates
 * and placed in 3D by the shape that uses them (extrude, sweep, loft, revolve).
 */
export type Profile =
  | { t: "circle"; d: number; c: V2 }
  | { t: "ellipse"; w: number; h: number; c: V2 }
  | { t: "rect"; w: number; h: number; r: number; c: V2 }
  | { t: "poly"; pts: V2[]; r: number }
  | { t: "text"; text: string; size: number; font: FontName; align: "left" | "center" | "right"; c: V2 }
  /** a closed path of lines, three-point arcs and cubic Bézier curves */
  | { t: "path2"; start: V2; segs: ProfileSeg[] }
  | { t: "offset"; p: Profile; d: number }
  | { t: "fillet2"; p: Profile; r: number }
  | { t: "union2"; ps: Profile[] }
  | { t: "diff2"; a: Profile; b: Profile[] }
  | { t: "common2"; a: Profile; b: Profile }
  /** rotate by rot degrees about the origin, then move by `by` */
  | { t: "place2"; p: Profile; rot: number; by: V2 };

export type ProfileSeg = { s: "line"; to: V2 } | { s: "arc"; via: V2; to: V2 } | { s: "bezier"; c1: V2; c2: V2; to: V2 };

export type FontName = "sans" | "mono";

/** A 3D curve for sweeps. */
export type Path3 =
  | { t: "poly"; pts: V3[]; r: number }
  | { t: "spline"; pts: V3[] }
  | { t: "helix"; pitch: number; h: number; d: number; at: V3; dir: V3; left: boolean }
  | { t: "arc3"; a: V3; b: V3; c: V3 };

/** A placed profile: origin o, in-plane x axis u, normal n (v = n × u). */
export interface Frame {
  o: V3;
  u: V3;
  n: V3;
}

export type ThreadForm = "iso" | "trapezoid" | "square" | "buttress";

export type ShapeRecipe =
  | { t: "box"; w: number; d: number; h: number; at: V3; r: number }
  | { t: "cyl"; d: number; h: number; at: V3; dir: V3 }
  | { t: "tube"; od: number; id: number; h: number; at: V3; dir: V3 }
  | { t: "cone"; d1: number; d2: number; h: number; at: V3; dir: V3 }
  | { t: "sphere"; d: number; at: V3 }
  | { t: "prism"; pts: V2[]; h: number; at: V3; dir: V3; rot: number }
  | { t: "rrect"; w: number; h: number; r: number; depth: number; at: V3; dir: V3; center: boolean }
  | { t: "revolve"; pts: V2[]; at: V3; dir: V3 }
  | { t: "flight"; d: number; core_d: number; pitch: number; length: number; tip: number; root: number; at: V3; dir: V3; left: boolean }
  | { t: "gear"; m: number; z: number; w: number; bore: number; at: V3; dir: V3; phase: number; pa: number; backlash: number }
  | { t: "hole"; d: number; depth: number; at: V3; dir: V3; cbore?: V2; csink?: number; lead?: number; thread?: ThreadSpec3; threadName?: string; fit?: string }
  | { t: "xform"; shape: ShapeRecipe; xf: Xform[] }
  | { t: "union"; shapes: ShapeRecipe[] }
  /** a body of an imported file, STEP or mesh (by content hash); body -1 is the whole file */
  | { t: "import"; asset: string; body: number }
  /** sketch profile pushed along the plane normal from `start` to `start + h` */
  | { t: "sk_extrude"; o: V3; u: V3; n: V3; regions: ProfileRegion[]; h: number; start: number }
  /** sketch profile turned about an axis in the sketch plane (point, direction in sketch coordinates) */
  | { t: "sk_revolve"; o: V3; u: V3; n: V3; regions: ProfileRegion[]; axis: [V2, V2]; angle: number }
  /** a with every b removed (hollow lofts) */
  | { t: "diff"; a: ShapeRecipe; b: ShapeRecipe[] }
  /**
   * a profile pushed along n by h; twist turns it (degrees over h), scale shrinks or grows the far end, taper leans
   * the sides in by that many degrees (out when negative). until "next": h is only a limit, and the part's shape
   * where the extrusion is added or cut decides where it stops (the kernel trims it there)
   */
  | { t: "extrude"; p: Profile; h: number; f: Frame; twist: number; scale: number; taper?: number; until?: "next" }
  | { t: "sweep"; p: Profile; path: Path3; rot: number; frenet: boolean }
  /** matched: the sections already have the same edges from the same start (aero tubes), so they are skinned as drawn, not resampled */
  | { t: "loft"; secs: { p: Profile; f: Frame }[]; ruled: boolean; matched?: boolean }
  | { t: "revolve2"; p: Profile; f: Frame; angle: number }
  /** a helical thread; detailed builds model the real form, fast builds a plain cylinder at the pitch diameter */
  | { t: "thread"; spec: ThreadSpec3; length: number; at: V3; dir: V3; internal: boolean; lead: number; bore?: number; fastD?: number }
  /** a knurled or ridged grip; fast builds use a plain cylinder */
  | { t: "knurl"; d: number; h: number; at: V3; dir: V3; count: number; depth: number; style: "straight" | "fluted" }
  /** a simple stand-in for fast builds and the full shape for detailed ones (a belt without and with its teeth) */
  | { t: "lod"; fast: ShapeRecipe; detail: ShapeRecipe }
  /** copies of shapes placed without fusing them (a chain's links): each shape built once, everything gathered in one compound */
  | { t: "instances"; items: { shape: ShapeRecipe; xfs: Xform[][] }[] }
  /** a sheet-metal part laid flat: each region of the built part cut out and moved onto the flat, plus its bends laid flat */
  | { t: "unfold"; part: PartRecipe; pieces: { region: ShapeRecipe; xf: Xform[] }[]; bends: ShapeRecipe[] }
  /** one half of a two-part mould round a part (placed by xf), split across the pull at `split` (null: where the part is widest) */
  | { t: "mould"; part: PartRecipe; xf: Xform[]; half: "top" | "bottom"; pull: V3; split: number | null; wall: number; shrink: number; keys: number; sprue: number; vents: number; bolt: number }
  /** another part's solid where it sits (xf), brought into the frame of the part that uses it (into: that part's placement undone) */
  | { t: "part"; part: PartRecipe; xf: Xform[]; into?: Xform[] };

/** Steepest taper an extrusion takes, degrees from straight. */
export const MAX_TAPER = 80;
/** How far an extrusion that runs until: "next" may reach, mm (the kernel stops it at the part long before). */
export const UNTIL_LIMIT = 2000;

/** One piece of a closed sketch loop, in sketch-plane coordinates. Arcs pass through m. */
/** A sketch loop's pieces: line, three-point arc, full circle, cubic Bézier (a spline's piece) and full ellipse (rot in degrees). */
export type Seg2 = { k: "l"; a: V2; b: V2 } | { k: "a"; a: V2; m: V2; b: V2 } | { k: "c"; c: V2; r: number } | { k: "b"; a: V2; c1: V2; c2: V2; b: V2 } | { k: "e"; c: V2; rx: number; ry: number; rot: number };

/** A face to build: one outer loop (counter-clockwise) and the holes inside it. */
export interface ProfileRegion {
  outer: Seg2[];
  holes: Seg2[][];
}

export interface ThreadSpec3 {
  /** nominal (major) diameter */
  d: number;
  pitch: number;
  form: ThreadForm;
  starts: number;
  left: boolean;
  /** radial clearance per side: external threads shrink, internal grow */
  clearance: number;
}

/** Fixed names for edge or face sets. */
export type SelPreset = "all" | "top" | "bottom" | "vertical" | "horizontal" | "convex" | "concave" | "sharp";
export const SEL_PRESETS: SelPreset[] = ["all", "top", "bottom", "vertical", "horizontal", "convex", "concave", "sharp"];

/**
 * Edge or face selection, resolved by the kernel against the shape at the
 * moment the modifier runs. Feature names refer to `add ... as name` (or
 * body/cut/intersect) earlier in the same part.
 */
export type Sel =
  | SelPreset
  | { s: "feat"; f: string; part: "faces" | "edges" | "root" | "tip" }
  | { s: "between"; a: string; b: string }
  | { s: "near"; p: V3; r: number }
  | { s: "plane"; n: V3; d: number }
  | { s: "along"; d: V3 }
  | { s: "facing"; d: V3 }
  | { s: "circle"; d: number }
  | { s: "box"; lo: V3; hi: V3 }
  | { s: "or"; a: Sel[] }
  | { s: "and"; a: Sel[] }
  | { s: "minus"; a: Sel; b: Sel };

/** @deprecated kept for older recipes; any Sel works */
export type EdgeSel = "vertical" | "top" | "bottom" | "all";

/** A face to leave open when shelling: the outermost face in a direction, or a face selection. */
export type OpenSpec = { dir: V3 } | { sel: Sel };

export type PartOp = (
  | { op: "add" | "cut" | "intersect"; shape: ShapeRecipe; name?: string }
  | { op: "shell"; t: number; open: V3 | OpenSpec[] }
  | { op: "fillet" | "chamfer"; r: number | V2; edges: Sel }
  | { op: "draft"; angle: number; faces: Sel; pull: V3; neutral: V3 }
) & {
  /** cosmetic detail: skipped in fast builds, and dropped (with a warning) if it fails */
  cosmetic?: boolean;
};

export interface PartRecipe {
  base: ShapeRecipe | null;
  /** feature name of the body (`body ... as name`) */
  baseName?: string;
  ops: PartOp[];
}

/** True when a fast build and a detailed build of this recipe differ. */
export function hasDetail(p: PartRecipe): boolean {
  if (p.base && shapeHasDetail(p.base)) return true;
  return p.ops.some((o) => o.cosmetic || ("shape" in o && shapeHasDetail(o.shape)));
}

export function shapeHasDetail(r: ShapeRecipe): boolean {
  switch (r.t) {
    case "thread":
    case "knurl":
    case "lod":
      return true;
    case "hole":
      return !!r.thread;
    case "xform":
      return shapeHasDetail(r.shape);
    case "union":
      return r.shapes.some(shapeHasDetail);
    case "diff":
      return shapeHasDetail(r.a) || r.b.some(shapeHasDetail);
    case "instances":
      return r.items.some((it) => shapeHasDetail(it.shape));
    case "part":
      return hasDetail(r.part);
    default:
      return false;
  }
}

/** Fonts a recipe needs loaded before it can be built. */
export function fontsIn(p: PartRecipe): FontName[] {
  const out = new Set<FontName>();
  const prof = (q: Profile): void => {
    switch (q.t) {
      case "text":
        out.add(q.font);
        return;
      case "offset":
      case "fillet2":
      case "place2":
        return prof(q.p);
      case "union2":
        return q.ps.forEach(prof);
      case "diff2":
        prof(q.a);
        return q.b.forEach(prof);
      case "common2":
        prof(q.a);
        return prof(q.b);
    }
  };
  const shape = (r: ShapeRecipe): void => {
    switch (r.t) {
      case "extrude":
      case "sweep":
      case "revolve2":
        return prof(r.p);
      case "loft":
        return r.secs.forEach((s) => prof(s.p));
      case "xform":
        return shape(r.shape);
      case "union":
        return r.shapes.forEach(shape);
      case "diff":
        shape(r.a);
        return r.b.forEach(shape);
      case "lod":
        shape(r.fast);
        return shape(r.detail);
      case "instances":
        return r.items.forEach((it) => shape(it.shape));
      case "part":
        return fontsIn(r.part).forEach((f) => out.add(f));
    }
  };
  if (p.base) shape(p.base);
  for (const o of p.ops) if ("shape" in o) shape(o.shape);
  return [...out];
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

/** Placement frame for a profile at `at`, facing `dir`, spun by `rot` degrees about dir. */
export function frameAt(at: V3, dir: V3, rot = 0): Frame {
  const { u, v, n } = frameFor(dir);
  if (!rot) return { o: at, u, n };
  const a = (rot * Math.PI) / 180;
  return { o: at, u: vadd(vscale(u, Math.cos(a)), vscale(v, Math.sin(a))), n };
}

/** World point of profile coordinates (x, y) in a frame. */
export function framePoint(f: Frame, x: number, y: number): V3 {
  const v = vcross(f.n, f.u);
  return vadd(f.o, vadd(vscale(f.u, x), vscale(v, y)));
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
    else if (x.op === "rotate") q = rotateAbout(q, x.origin, x.axis, x.angle);
    else q = reflect(q, x.origin, x.normal);
  }
  return q;
}

export function applyXformsToDir(d: V3, xf: Xform[]): V3 {
  let q = d;
  for (const x of xf) {
    if (x.op === "rotate") q = rotateAbout(q, [0, 0, 0], x.axis, x.angle);
    else if (x.op === "mirror") q = reflect(q, [0, 0, 0], x.normal);
  }
  return q;
}

/** Undo a transform chain: a world point back into the part's own coordinates. */
export function inverseXforms(p: V3, xf: Xform[]): V3 {
  let q = p;
  for (let i = xf.length - 1; i >= 0; i--) {
    const x = xf[i];
    if (x.op === "translate") q = vsub(q, x.v);
    else if (x.op === "rotate") q = rotateAbout(q, x.origin, x.axis, -x.angle);
    else q = reflect(q, x.origin, x.normal);
  }
  return q;
}

/** Mirror point p through the plane with the given origin and normal. */
export function reflect(p: V3, origin: V3, normal: V3): V3 {
  const n = vnorm(normal);
  const k = 2 * vdot(vsub(p, origin), n);
  return vsub(p, vscale(n, k));
}

/** Column-major 4x4 matrix (three.js layout) for a transform chain. */
export function xformMatrix(xf: Xform[]): number[] {
  let m = identity();
  for (const x of xf) {
    const step = x.op === "translate" ? translation(x.v) : x.op === "rotate" ? rotationAbout(x.origin, x.axis, x.angle) : reflection(x.origin, x.normal);
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
function reflection(o: V3, normal: V3): number[] {
  const [x, y, z] = vnorm(normal);
  const r = [1 - 2 * x * x, -2 * x * y, -2 * x * z, 0, -2 * x * y, 1 - 2 * y * y, -2 * y * z, 0, -2 * x * z, -2 * y * z, 1 - 2 * z * z, 0, 0, 0, 0, 1];
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
