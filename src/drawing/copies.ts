// Copies of a made part share one drawing: four vanes written once and turned
// into place, six feet typed out one by one, a left and a right side cut the
// same are each one sheet that says how many to make. A part is a copy when it
// is the same solid moved and turned: the same material, finish and process,
// and the same volume moments up to third order once its box is turned onto
// the other's. Those moments tell a left hand from a right, so a mirror image
// is only a copy when the part is symmetric, and two plates of one size with
// their holes in different places stay two sheets.

import type { EvalPart } from "../core/model";

export interface CopyMesh {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
}
/** a part's mesh in its own frame (before its placement), as built */
export type MeshOf = (p: EvalPart) => CopyMesh | undefined;

/** exponents (a, b, c) of the monomials x^a y^b z^c up to third order */
const EXPS: [number, number, number][] = [];
for (let d = 0; d <= 3; d++) for (let a = d; a >= 0; a--) for (let b = d - a; b >= 0; b--) EXPS.push([a, b, d - a - b]);
const INDEX = new Map(EXPS.map((e, i) => [e.join(","), i]));

interface Solid {
  size: [number, number, number];
  /** volume integrals of the monomials about the box centre; the first is the volume */
  m: Float64Array;
  /** half the box diagonal, the length the moments are compared at */
  len: number;
}

const solids = new WeakMap<object, Solid | null>();

/** The solid's box and moments, from its closed triangle mesh (each triangle with the box centre makes a tetrahedron). */
function solidOf(mesh: CopyMesh): Solid | null {
  const hit = solids.get(mesh.positions as object);
  if (hit !== undefined) return hit;
  const P = mesh.positions;
  const I = mesh.indices;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < P.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], P[i + k]);
      hi[k] = Math.max(hi[k], P[i + k]);
    }
  const c = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
  const m = new Float64Array(EXPS.length);
  const add = (w: number, x: number, y: number, z: number) => {
    const px = [1, x, x * x, x * x * x];
    const py = [1, y, y * y, y * y * y];
    const pz = [1, z, z * z, z * z * z];
    for (let j = 0; j < EXPS.length; j++) m[j] += w * px[EXPS[j][0]] * py[EXPS[j][1]] * pz[EXPS[j][2]];
  };
  const at = (i: number) => [P[3 * i] - c[0], P[3 * i + 1] - c[1], P[3 * i + 2] - c[2]];
  for (let t = 0; t + 2 < I.length; t += 3) {
    const a = at(I[t]);
    const b = at(I[t + 1]);
    const d = at(I[t + 2]);
    const v = (a[0] * (b[1] * d[2] - b[2] * d[1]) - a[1] * (b[0] * d[2] - b[2] * d[0]) + a[2] * (b[0] * d[1] - b[1] * d[0])) / 6;
    if (!v) continue;
    // a five-point rule on the tetrahedron (centre, a, b, d), exact for cubics
    const s = [a[0] + b[0] + d[0], a[1] + b[1] + d[1], a[2] + b[2] + d[2]];
    add(-0.8 * v, s[0] / 4, s[1] / 4, s[2] / 4);
    add(0.45 * v, s[0] / 6, s[1] / 6, s[2] / 6);
    for (const q of [a, b, d]) add(0.45 * v, q[0] / 3 + s[0] / 6, q[1] / 3 + s[1] / 6, q[2] / 3 + s[2] / 6);
  }
  // a mesh wound inside out still gives the solid's moments
  if (m[0] < 0) for (let j = 0; j < m.length; j++) m[j] = -m[j];
  const size: [number, number, number] = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  const solid = m[0] > 0 ? { size, m, len: Math.max(Math.hypot(...size) / 2, 1) } : null;
  solids.set(mesh.positions as object, solid);
  return solid;
}

const PERMS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];
const permSign = (p: number[]) => (p[0] < p[1] ? 1 : -1) * (p[0] < p[2] ? 1 : -1) * (p[1] < p[2] ? 1 : -1);

/**
 * Is b the solid a turned onto its box (det 1), or mirrored onto it (det -1)? Tries each way of laying a's box
 * on b's (axis i of a along axis s[i] of b, flipped where g[i] is -1) and compares every moment.
 */
function sameSolid(a: Solid, b: Solid, det: number): boolean {
  if (Math.abs(a.m[0] - b.m[0]) > 1e-4 * a.m[0]) return false;
  const side = Math.max(0.02, 1e-4 * a.len);
  for (const s of PERMS)
    for (let f = 0; f < 8; f++) {
      const g = [f & 1 ? -1 : 1, f & 2 ? -1 : 1, f & 4 ? -1 : 1];
      if (permSign(s) * g[0] * g[1] * g[2] !== det) continue;
      if ([0, 1, 2].some((i) => Math.abs(a.size[i] - b.size[s[i]]) > side)) continue;
      const fits = EXPS.every((e, j) => {
        // b's monomial e, written in a's coordinates
        const ea = [e[s[0]], e[s[1]], e[s[2]]];
        const sign = g[0] ** ea[0] * g[1] ** ea[1] * g[2] ** ea[2];
        const want = sign * a.m[INDEX.get(ea.join(","))!];
        return Math.abs(b.m[j] - want) <= 1e-4 * a.m[0] * a.len ** (e[0] + e[1] + e[2]);
      });
      if (fits) return true;
    }
  return false;
}

/**
 * The parts that are copies of an earlier one in the list, each mapped to that earlier part's name. Without meshes
 * only parts built from the same recipe and placed the same way round count as copies.
 */
export function copiesOf(parts: EvalPart[], meshOf?: MeshOf): Map<string, string> {
  const out = new Map<string, string>();
  const firsts: { p: EvalPart; solid: Solid | null; flip: number; how: string }[] = [];
  for (const p of parts) {
    const mesh = meshOf?.(p);
    const solid = mesh ? solidOf(mesh) : null;
    const flip = p.xf.filter((x) => x.op === "mirror").length % 2;
    const how = [p.material ?? "", p.finish ?? "", p.process?.id ?? ""].join("|");
    const first = firsts.find((r) => r.how === how && (r.solid && solid ? sameSolid(r.solid, solid, r.flip === flip ? 1 : -1) : r.p.hash === p.hash && r.flip === flip));
    if (first) out.set(p.name, first.p.name);
    else firsts.push({ p, solid, flip, how });
  }
  return out;
}

/**
 * The part recipe (as JSON) that a part copies, when it is another part moved, turned or mirrored with shape_of()
 * and nothing added: it has that part's holes and sizes, so that part's drawing is its drawing too.
 */
export function copySource(p: EvalPart): string | undefined {
  if (p.recipe.ops.length) return undefined;
  interface Node {
    t?: string;
    shape?: Node;
    part?: unknown;
  }
  let b = p.recipe.base as Node | undefined;
  while (b?.t === "xform") {
    const inner = b.shape;
    if (inner?.t === "part" && inner.part) return JSON.stringify(inner.part);
    b = inner;
  }
  return undefined;
}

/** The words every copy's name shares, at its start or else at its end: Gondola for Gondola 1 to 6, Side for Left side and Right side. */
export function sharedName(names: string[]): string | undefined {
  const words = names.map((n) => n.split(/[\s_]+/).filter(Boolean));
  const same = (pick: (w: string[], i: number) => string | undefined) => {
    const out: string[] = [];
    for (let i = 0; ; i++) {
      const w = pick(words[0], i);
      if (w === undefined || !words.every((ws) => pick(ws, i)?.toLowerCase() === w.toLowerCase())) return out;
      out.push(w);
    }
  };
  const lead = same((w, i) => w[i]);
  const tail = same((w, i) => w[w.length - 1 - i]).reverse();
  const shared = (lead.length ? lead : tail).join(" ");
  return shared ? shared[0].toUpperCase() + shared.slice(1) : undefined;
}
