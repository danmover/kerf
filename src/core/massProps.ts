// Mass properties of parts and of the whole design: mass, centre of mass,
// the inertia tensor about the centre (and about any point), its principal
// moments and axes, and radii of gyration. Each solid's volume integrals come
// from its mesh (signed tetrahedra from a point near it, the divergence
// theorem), scaled to the kernel's exact volume, and its mass from the part's
// material or the mass: it is given, so a bought part that says what it
// weighs keeps that weight spread through its shape.

import type { MeshData } from "../kernel/build";
import { partMass, type EvalPart, type Model } from "./model";
import { applyXforms, type Xform } from "../kernel/recipe";
import { materialDensity } from "../library/standards";
import { symEigen } from "./mates";

type V3 = [number, number, number];
/** row-major 3 × 3 */
export type M3 = [number, number, number, number, number, number, number, number, number];

/** A solid's volume integrals, world coordinates: V, its centre and ∫ (x − c)(x − c)ᵀ dV. */
export interface Moments {
  volume: number;
  com: V3;
  /** mm⁵ */
  cov: M3;
}

export interface MassProps {
  /** grams */
  mass: number;
  /** centre of mass, mm (world) */
  com: V3;
  /** inertia tensor about the centre of mass along the world axes, g·mm² (Ixx Ixy Ixz / Iyx Iyy Iyz / Izx Izy Izz) */
  inertia: M3;
  /** principal moments, g·mm², smallest first, and their axes (unit vectors, world) */
  principal: { moments: V3; axes: [V3, V3, V3] };
  /** radii of gyration about the principal axes, mm */
  gyration: V3;
  /** solids counted, and solids still building (missing from the sums) */
  solids: number;
  pending: number;
}

const momentCache = new WeakMap<MeshData, Map<string, Moments>>();

/** A mesh's volume, centre and second moments where its part is placed; the volume scaled to `exact` when given. */
export function meshMoments(m: MeshData, xf: Xform[], exact?: number): Moments {
  const key = `${JSON.stringify(xf)}|${exact ?? ""}`;
  const hit = momentCache.get(m)?.get(key);
  if (hit) return hit;
  const pos = m.positions;
  const n = pos.length / 3;
  const w = new Float64Array(pos.length);
  for (let i = 0; i < n; i++) {
    const p: V3 = [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
    const q = xf.length ? applyXforms(p, xf) : p;
    w[3 * i] = q[0];
    w[3 * i + 1] = q[1];
    w[3 * i + 2] = q[2];
  }
  const o: V3 = n ? [w[0], w[1], w[2]] : [0, 0, 0];
  let V = 0;
  const m1 = [0, 0, 0];
  const C = new Float64Array(9);
  const idx = m.indices;
  for (let t = 0; t < idx.length; t += 3) {
    const a = [w[3 * idx[t]] - o[0], w[3 * idx[t] + 1] - o[1], w[3 * idx[t] + 2] - o[2]];
    const b = [w[3 * idx[t + 1]] - o[0], w[3 * idx[t + 1] + 1] - o[1], w[3 * idx[t + 1] + 2] - o[2]];
    const c = [w[3 * idx[t + 2]] - o[0], w[3 * idx[t + 2] + 1] - o[1], w[3 * idx[t + 2] + 2] - o[2]];
    const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    V += det / 6;
    const s = [a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]];
    for (let k = 0; k < 3; k++) m1[k] += (det / 24) * s[k];
    // ∫ x xᵀ over the tetrahedron (0, a, b, c): det/120 · (a aᵀ + b bᵀ + c cᵀ + s sᵀ)
    for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) C[3 * i + k] += (det / 120) * (a[i] * a[k] + b[i] * b[k] + c[i] * c[k] + s[i] * s[k]);
  }
  // a mirrored part comes out inside-out
  if (V < 0) {
    V = -V;
    for (let k = 0; k < 3; k++) m1[k] = -m1[k];
    for (let i = 0; i < 9; i++) C[i] = -C[i];
  }
  let out: Moments;
  if (V > 1e-12) {
    const cl = [m1[0] / V, m1[1] / V, m1[2] / V];
    const k = exact && exact > 0 ? exact / V : 1;
    out = {
      volume: V * k,
      com: [o[0] + cl[0], o[1] + cl[1], o[2] + cl[2]],
      cov: Array.from({ length: 9 }, (_, i) => k * (C[i] - V * cl[Math.floor(i / 3)] * cl[i % 3])) as M3,
    };
  } else {
    // an open mesh: a solid box of its volume in the middle of its box
    const lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], w[3 * i + k]);
        hi[k] = Math.max(hi[k], w[3 * i + k]);
      }
    const vol = exact ?? 0;
    const h = n ? [0, 1, 2].map((k) => (hi[k] - lo[k]) / 2) : [0, 0, 0];
    out = { volume: vol, com: n ? ([0, 1, 2].map((k) => (lo[k] + hi[k]) / 2) as V3) : [0, 0, 0], cov: [(vol * h[0] * h[0]) / 3, 0, 0, 0, (vol * h[1] * h[1]) / 3, 0, 0, 0, (vol * h[2] * h[2]) / 3] };
  }
  (momentCache.get(m) ?? momentCache.set(m, new Map()).get(m)!).set(key, out);
  return out;
}

/** Point masses with second moments (grams, mm, g·mm² of each about its own centre) summed about their common centre. */
export function combine(items: { mass: number; com: V3; second: M3 }[], solids: number, pending: number): MassProps {
  const mass = items.reduce((s, it) => s + it.mass, 0);
  const com: V3 = [0, 0, 0];
  if (mass > 0) for (const it of items) for (let k = 0; k < 3; k++) com[k] += (it.mass * it.com[k]) / mass;
  // second moment about the common centre (parallel axes), then I = tr(S)·1 − S
  const S = new Array<number>(9).fill(0);
  for (const it of items) {
    const d = [it.com[0] - com[0], it.com[1] - com[1], it.com[2] - com[2]];
    for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) S[3 * i + k] += it.second[3 * i + k] + it.mass * d[i] * d[k];
  }
  const tr = S[0] + S[4] + S[8];
  const inertia = S.map((x, i) => (i % 4 === 0 ? tr : 0) - x) as M3;
  return { mass, com, inertia, ...principalOf(inertia, mass), solids, pending };
}

/** The principal moments and axes of an inertia tensor (smallest first), and the radii of gyration about them. */
export function principalOf(I: M3, mass: number): { principal: MassProps["principal"]; gyration: V3 } {
  const { values, V } = symEigen(Float64Array.from(I), 3);
  const order = [0, 1, 2].sort((a, b) => values[a] - values[b]);
  const axes = order.map((j) => {
    const v: V3 = [V[j], V[3 + j], V[6 + j]];
    // point each axis the way of the world axis it is nearest, so the answer reads the same every time
    const big = [0, 1, 2].reduce((a, b) => (Math.abs(v[b]) > Math.abs(v[a]) + 1e-9 ? b : a), 0);
    return (v[big] < 0 ? v.map((x) => -x || 0) : v.map((x) => x || 0)) as V3;
  }) as [V3, V3, V3];
  const moments = order.map((j) => Math.max(0, values[j])) as V3;
  return { principal: { moments, axes }, gyration: moments.map((x) => (mass > 0 ? Math.sqrt(x / mass) : 0)) as V3 };
}

/** The inertia tensor about another point (parallel axes): I_p = I_c + m (|d|² 1 − d dᵀ), d = c − p. */
export function inertiaAbout(mp: MassProps, p: V3): M3 {
  const d = [mp.com[0] - p[0], mp.com[1] - p[1], mp.com[2] - p[2]];
  const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  return mp.inertia.map((x, i) => x + mp.mass * ((i % 4 === 0 ? dd : 0) - d[Math.floor(i / 3)] * d[i % 3])) as M3;
}

/** What massProperties needs of each built solid: its mesh and its exact volume. */
export type SolidLookup = (hash: string) => { mesh?: MeshData; volume: number } | undefined;

/**
 * Mass properties of the design's visible parts, or of those `only` keeps. A component's mass: (a bought part's
 * catalogue weight) is shared over its solids by volume.
 */
export function massProperties(model: Model, solid: SolidLookup, only?: (p: EvalPart) => boolean): MassProps {
  const items: { mass: number; com: V3; second: M3 }[] = [];
  let pending = 0;
  // a mass: given on a part with several solids (a component) is the whole part's: share it by volume
  const given = new Map<string, { mass: number; volume: number }>();
  const keep = model.parts.filter((p) => !p.hidden && (!only || only(p)));
  for (const p of keep) {
    if (p.mass === undefined) continue;
    const key = p.kind === "component" ? p.id.split(".")[0] : p.id;
    const g = given.get(key) ?? { mass: p.mass, volume: 0 };
    g.volume += solid(p.hash)?.volume ?? 0;
    given.set(key, g);
  }
  for (const p of keep) {
    const s = solid(p.hash);
    if (!s?.mesh) {
      pending++;
      continue;
    }
    const mo = meshMoments(s.mesh, p.xf, s.volume);
    const key = p.kind === "component" ? p.id.split(".")[0] : p.id;
    const g = given.get(key);
    const grams = g ? (g.volume > 0 ? (g.mass * mo.volume) / g.volume : g.mass) : (partMass(p, mo.volume, materialDensity(p.material)) ?? 0);
    const rho = mo.volume > 0 ? grams / mo.volume : 0;
    items.push({ mass: grams, com: mo.com, second: mo.cov.map((x) => x * rho) as M3 });
  }
  return combine(items, items.length, pending);
}

const f = (x: number, d = 2) => {
  const r = Math.abs(x) < 1e-9 ? 0 : x;
  return Math.abs(r) >= 1e6 || (Math.abs(r) < 1e-3 && r !== 0) ? r.toExponential(3) : String(+r.toFixed(d));
};
const v3 = (v: V3, d = 2) => `(${v.map((x) => f(x, d)).join(", ")})`;

/** Mass properties as text (kg·mm² for inertia), for the assistant and reports. */
export function massPropsText(mp: MassProps, about?: V3): string {
  const kg = (x: number) => x / 1000;
  const I = mp.inertia.map(kg);
  const lines = [
    `mass ${f(mp.mass, 1)} g`,
    `centre of mass ${v3(mp.com)} mm`,
    `inertia about the centre of mass, world axes (kg·mm²): Ixx ${f(I[0], 3)}, Iyy ${f(I[4], 3)}, Izz ${f(I[8], 3)}, Ixy ${f(I[1], 3)}, Iyz ${f(I[5], 3)}, Ixz ${f(I[2], 3)} (products of inertia as the tensor's off-diagonal terms, −∫xy dm)`,
    `principal moments (kg·mm²): ${mp.principal.moments.map((x, i) => `${f(kg(x), 3)} about ${v3(mp.principal.axes[i], 3)}`).join("; ")}`,
    `radii of gyration about those axes: ${mp.gyration.map((x) => f(x, 1)).join(", ")} mm`,
  ];
  if (about) {
    const Ia = inertiaAbout(mp, about).map(kg);
    lines.push(`inertia about ${v3(about)} (kg·mm²): Ixx ${f(Ia[0], 3)}, Iyy ${f(Ia[4], 3)}, Izz ${f(Ia[8], 3)}, Ixy ${f(Ia[1], 3)}, Iyz ${f(Ia[5], 3)}, Ixz ${f(Ia[2], 3)}`);
  }
  if (mp.pending) lines.push(`${mp.pending} solid${mp.pending > 1 ? "s are" : " is"} still building and not counted yet`);
  return lines.join("\n");
}
