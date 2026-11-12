// Composite laminates for the shell elements: plies of fibres in resin, each stiff and strong along its fibres and
// weak across them, laid at their own angles into one wall.
//
// A ply's stiffness in its own axes (1 along the fibres, 2 across them) turned to its angle gives Q̄; summed through
// the wall from the outer surface inward it gives the wall's stretching, coupling and bending stiffness A, B, D
// (classical lamination theory). Each ply is checked at its top and bottom against its own strengths by Tsai–Wu: the
// factor on the loads at which the first ply cracks (first-ply failure), and the way it goes by the largest of its
// stresses over their strengths. Stress along the fibres over their strength gives the factor that breaks fibres,
// which a laminate usually holds to after its resin first cracks.
//
// Angles are in degrees from the 0° direction, counterclockwise as seen from outside the part (about the outward
// normal). Plies are listed from the outside in: ply 1 is the one laid against the mould.

import { symEigen } from "./vibration";
import type { V3 } from "./voxel";

export interface PlyMaterial {
  key: string;
  /** what it is, for the report */
  label: string;
  /** woven cloth: fibres both ways, as stiff and strong across as along */
  woven: boolean;
  /** MPa: along the fibres (1), across them (2), in-plane shear; and Poisson's ratio ν12 */
  E1: number;
  E2: number;
  G12: number;
  nu12: number;
  /** strengths, MPa: along the fibres in tension and compression, across them, and in-plane shear */
  Xt: number;
  Xc: number;
  Yt: number;
  Yc: number;
  S: number;
  /** cured ply thickness, mm */
  t: number;
  /** cured density, g/cm³ */
  density: number;
}

/**
 * Typical cured-ply values (epoxy resin, autoclave or press cured). Carbon UD is standard-modulus (T700-class) prepreg
 * at about 60 % fibre by volume: laid quasi-isotropic it is as stiff as Kerf's "Carbon fiber" plate (about 50 GPa).
 * E-glass and aramid are the classic textbook laminae (Tsai and Hahn). A data sheet's figures for the prepreg
 * actually bought replace these for sign-off.
 */
export const PLY_MATERIALS: Record<string, PlyMaterial> = {
  carbon: { key: "carbon", label: "T700-class carbon UD", woven: false, E1: 130000, E2: 9000, G12: 4800, nu12: 0.3, Xt: 2200, Xc: 1400, Yt: 55, Yc: 200, S: 90, t: 0.12, density: 1.55 },
  "carbon im": { key: "carbon im", label: "T800-class intermediate-modulus carbon UD", woven: false, E1: 160000, E2: 9000, G12: 5000, nu12: 0.32, Xt: 2700, Xc: 1500, Yt: 60, Yc: 210, S: 95, t: 0.12, density: 1.57 },
  "carbon hm": { key: "carbon hm", label: "M40J-class high-modulus carbon UD", woven: false, E1: 225000, E2: 6500, G12: 4500, nu12: 0.3, Xt: 2400, Xc: 1200, Yt: 45, Yc: 170, S: 75, t: 0.12, density: 1.6 },
  "carbon woven": { key: "carbon woven", label: "3K twill carbon cloth", woven: true, E1: 60000, E2: 60000, G12: 4500, nu12: 0.05, Xt: 650, Xc: 570, Yt: 650, Yc: 570, S: 100, t: 0.22, density: 1.5 },
  glass: { key: "glass", label: "E-glass UD", woven: false, E1: 38600, E2: 8270, G12: 4140, nu12: 0.26, Xt: 1062, Xc: 610, Yt: 31, Yc: 118, S: 72, t: 0.125, density: 1.8 },
  "glass woven": { key: "glass woven", label: "E-glass cloth (7781 satin)", woven: true, E1: 24000, E2: 24000, G12: 4200, nu12: 0.12, Xt: 420, Xc: 380, Yt: 420, Yc: 380, S: 70, t: 0.25, density: 1.9 },
  aramid: { key: "aramid", label: "aramid (Kevlar 49) UD", woven: false, E1: 76000, E2: 5500, G12: 2300, nu12: 0.34, Xt: 1400, Xc: 235, Yt: 12, Yc: 53, S: 34, t: 0.13, density: 1.38 },
};

const tidy = (s: string) => s.trim().toLowerCase().replace(/[_\-–]+/g, " ").replace(/\s+/g, " ");

const ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries({
    "carbon ud": "carbon",
    ud: "carbon",
    cfrp: "carbon",
    "carbon fiber": "carbon",
    "carbon fibre": "carbon",
    "carbon sm": "carbon",
    "standard modulus": "carbon",
    t700: "carbon",
    "t700 ud": "carbon",
    "carbon t700": "carbon",
    "intermediate modulus": "carbon im",
    im: "carbon im",
    t800: "carbon im",
    "carbon t800": "carbon im",
    "high modulus": "carbon hm",
    hm: "carbon hm",
    m40j: "carbon hm",
    "carbon m40j": "carbon hm",
    woven: "carbon woven",
    twill: "carbon woven",
    "3k": "carbon woven",
    "3k twill": "carbon woven",
    "carbon twill": "carbon woven",
    "carbon cloth": "carbon woven",
    "carbon fabric": "carbon woven",
    "woven carbon": "carbon woven",
    "e glass": "glass",
    "glass ud": "glass",
    "glass fiber": "glass",
    "glass fibre": "glass",
    fiberglass: "glass",
    fibreglass: "glass",
    gfrp: "glass",
    "glass cloth": "glass woven",
    "glass fabric": "glass woven",
    "woven glass": "glass woven",
    "fiberglass cloth": "glass woven",
    "fibreglass cloth": "glass woven",
    kevlar: "aramid",
    "kevlar 49": "aramid",
    "aramid ud": "aramid",
  }).map(([k, v]) => [tidy(k), v]),
);

export function plyMaterial(name: string): PlyMaterial | undefined {
  const k = tidy(name);
  return PLY_MATERIALS[k] ?? (ALIASES[k] ? PLY_MATERIALS[ALIASES[k]] : undefined);
}

// ---------- the stacking code ----------

const SUB = "₀₁₂₃₄₅₆₇₈₉";

/**
 * The plies of a stacking code, from the outside in: "[0/±45/90]s" → 0, 45, −45, 90, 90, −45, 45, 0. Groups in
 * brackets or parentheses repeat with a count after them ("[0/90]2" → 0, 90, 0, 90; "0₂" or "0_2" → 0, 0), and "s"
 * after a group mirrors it (a symmetric laminate; "2s" repeats it twice, then mirrors). "±45" is +45 then −45, "∓45"
 * the other way. A comma does as well as a slash.
 */
export function parseLayup(code: string): number[] | { error: string } {
  let s = code
    .replace(/\s+/g, "")
    .replace(/[−–]/g, "-")
    .replace(/°/g, "")
    .replace(/\+-|\+\/-/g, "±")
    .replace(/-\+/g, "∓")
    .replace(/ₛ/g, "s");
  s = s.replace(/[₀-₉]+/g, (m) => `_${[...m].map((c) => SUB.indexOf(c)).join("")}`);
  let i = 0;
  const fail = (why: string) => ({ error: `${why} in "${code}"` });
  const count = (): number | null => {
    const m = /^_?(\d+)/.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    return Number(m[1]);
  };
  const seq = (close: string | null): number[] | { error: string } => {
    const out: number[] = [];
    for (;;) {
      const c = s[i];
      if (c === undefined) {
        if (close) return fail(`a "${close === "]" ? "[" : "("}" is not closed`);
        return out;
      }
      let part: number[];
      if (c === "[" || c === "(") {
        i++;
        const inner = seq(c === "[" ? "]" : ")");
        if ("error" in inner) return inner;
        part = inner;
        const n = count();
        if (n !== null) {
          if (n < 1) return fail("a group repeats at least once");
          part = Array.from({ length: n }, () => part).flat();
        }
        if (s[i] === "s" || s[i] === "S") {
          i++;
          part = [...part, ...[...part].reverse()];
        } else if (s[i] === "T" || s[i] === "t") i++;
      } else {
        let sign: "+" | "-" | "±" | "∓" = "+";
        if (c === "+" || c === "-" || c === "±" || c === "∓") {
          sign = c;
          i++;
        }
        const m = /^\d+(\.\d+)?/.exec(s.slice(i));
        if (!m) return fail(s[i] === undefined ? "an angle is missing at the end" : `"${s[i]}" is not an angle`);
        i += m[0].length;
        const a = Number(m[0]);
        if (a > 90) return fail(`${a}° is past 90°: a ply's angle runs from -90° to 90°`);
        part = sign === "±" ? [a, -a] : sign === "∓" ? [-a, a] : [sign === "-" ? -a : a];
        const n = count();
        if (n !== null) {
          if (n < 1) return fail("a ply repeats at least once");
          part = Array.from({ length: n }, () => part).flat();
        }
      }
      out.push(...part);
      if (out.length > 400) return fail("more than 400 plies");
      const sep = s[i];
      if (sep === "/" || sep === ",") {
        i++;
        continue;
      }
      if (sep === undefined) {
        if (close) return fail(`a "${close === "]" ? "[" : "("}" is not closed`);
        return out;
      }
      if (sep === close) {
        i++;
        return out;
      }
      return fail(`"${sep}" should be a "/" between plies`);
    }
  };
  if (!s) return { error: "the layup is empty" };
  const got = seq(null);
  if ("error" in got) return got;
  if (!got.length) return { error: `no plies in "${code}"` };
  // 90° and −90° are the same fibres; −0 is 0
  return got.map((a) => (a === -90 ? 90 : a === 0 ? 0 : a));
}

/** A layup written back short: "[0/±45/90]s" for a symmetric one whose ±pairs are neighbours, else every ply. */
export function layupText(angles: number[]): string {
  const n = angles.length;
  const sym = n >= 2 && n % 2 === 0 && angles.every((a, k) => a === angles[n - 1 - k]);
  const half = sym ? angles.slice(0, n / 2) : angles;
  const parts: string[] = [];
  for (let k = 0; k < half.length; k++) {
    const a = half[k],
      b = half[k + 1];
    if (a !== 0 && a !== 90 && b === -a) {
      parts.push(`${a > 0 ? "±" : "∓"}${Math.abs(a)}`);
      k++;
    } else parts.push(String(a));
  }
  // runs of the same ply as a count: 0/0/0 → 0₃
  const runs: string[] = [];
  for (const p of parts) {
    const last = runs[runs.length - 1];
    const m = last ? /^(.*?)([₀-₉]*)$/.exec(last) : null;
    if (m && m[1] === p) {
      const c = m[2] ? Number([...m[2]].map((d) => SUB.indexOf(d)).join("")) : 1;
      runs[runs.length - 1] = p + [...String(c + 1)].map((d) => SUB[Number(d)]).join("");
    } else runs.push(p);
  }
  return `[${runs.join("/")}]${sym ? "s" : ""}`;
}

// ---------- stiffness ----------

/** a ply's own plane-stress stiffness in its axes: Q11, Q12, Q22, Q66 */
export function plyQ(m: PlyMaterial): [number, number, number, number] {
  const nu21 = (m.nu12 * m.E2) / m.E1;
  const d = 1 - m.nu12 * nu21;
  return [m.E1 / d, (m.nu12 * m.E2) / d, m.E2 / d, m.G12];
}

/** a ply's stiffness turned to angle a (radians, counterclockwise from x to its fibres): Q̄, rows ε_x ε_y γ_xy */
export function qBar(m: PlyMaterial, a: number, out = new Float64Array(9)): Float64Array {
  const [Q11, Q12, Q22, Q66] = plyQ(m);
  const c = Math.cos(a),
    s = Math.sin(a);
  const c2 = c * c,
    s2 = s * s,
    sc = s * c;
  const q11 = Q11 * c2 * c2 + 2 * (Q12 + 2 * Q66) * s2 * c2 + Q22 * s2 * s2;
  const q12 = (Q11 + Q22 - 4 * Q66) * s2 * c2 + Q12 * (s2 * s2 + c2 * c2);
  const q22 = Q11 * s2 * s2 + 2 * (Q12 + 2 * Q66) * s2 * c2 + Q22 * c2 * c2;
  const q16 = (Q11 - Q12 - 2 * Q66) * sc * c2 + (Q12 - Q22 + 2 * Q66) * sc * s2;
  const q26 = (Q11 - Q12 - 2 * Q66) * sc * s2 + (Q12 - Q22 + 2 * Q66) * sc * c2;
  const q66 = (Q11 + Q22 - 2 * Q12 - 2 * Q66) * s2 * c2 + Q66 * (s2 * s2 + c2 * c2);
  out[0] = q11;
  out[1] = q12;
  out[2] = q16;
  out[3] = q12;
  out[4] = q22;
  out[5] = q26;
  out[6] = q16;
  out[7] = q26;
  out[8] = q66;
  return out;
}

/** one ply as laid in a wall: its material, thickness (mm) and angle in the wall's axes (radians) */
export interface LaidPly {
  m: PlyMaterial;
  t: number;
  a: number;
}

export interface Laminate {
  /** stretching, coupling and bending stiffness (3 × 3 each, rows ε_x ε_y γ_xy), about the outer surface */
  A: Float64Array;
  B: Float64Array;
  D: Float64Array;
  /** the plies' faces from the outer surface (0) inward: ply k lies between z[k + 1] and z[k] (z ≤ 0) */
  z: Float64Array;
  t: number;
  /** mass per area: Σ density × thickness, g/cm³ · mm */
  rhoT: number;
}

/** Classical lamination theory: the wall's A, B, D from its plies, laid from the outer surface (z = 0) inward. */
export function laminate(plies: LaidPly[]): Laminate {
  const A = new Float64Array(9),
    B = new Float64Array(9),
    D = new Float64Array(9);
  const z = new Float64Array(plies.length + 1);
  const q = new Float64Array(9);
  let top = 0,
    rhoT = 0;
  plies.forEach((p, k) => {
    const bot = top - p.t;
    qBar(p.m, p.a, q);
    const a = top - bot,
      b = (top * top - bot * bot) / 2,
      d = (top ** 3 - bot ** 3) / 3;
    for (let r = 0; r < 9; r++) {
      A[r] += q[r] * a;
      B[r] += q[r] * b;
      D[r] += q[r] * d;
    }
    rhoT += p.m.density * p.t;
    z[k + 1] = bot;
    top = bot;
  });
  return { A, B, D, z, t: -top, rhoT };
}

/** the in-plane stiffness of a wall as one even material: E and ν from its A matrix (stretching only) */
export function effectiveEnu(L: Laminate): { Ex: number; Ey: number; G: number; nu: number } {
  // compliance a = A⁻¹; Ex = 1/(t a11), Ey = 1/(t a22), G = 1/(t a66), ν = −a12/a11
  const A = L.A;
  const det = A[0] * (A[4] * A[8] - A[5] * A[7]) - A[1] * (A[3] * A[8] - A[5] * A[6]) + A[2] * (A[3] * A[7] - A[4] * A[6]);
  const a11 = (A[4] * A[8] - A[5] * A[7]) / det;
  const a22 = (A[0] * A[8] - A[2] * A[6]) / det;
  const a66 = (A[0] * A[4] - A[1] * A[3]) / det;
  const a12 = -(A[1] * A[8] - A[2] * A[7]) / det;
  return { Ex: 1 / (L.t * a11), Ey: 1 / (L.t * a22), G: 1 / (L.t * a66), nu: -a12 / a11 };
}

// ---------- strength ----------

export const PLY_FAILURES = ["fibre tension", "fibre compression", "matrix tension", "matrix compression", "shear"] as const;
export type PlyFailure = (typeof PLY_FAILURES)[number];

/** what each failure is, in words */
export function failureWords(f: PlyFailure, woven = false): string {
  switch (f) {
    case "fibre tension":
      return "fibres breaking in tension";
    case "fibre compression":
      return "fibres buckling and crushing in compression";
    case "matrix tension":
      return woven ? "the cloth's resin cracking" : "the resin cracking between the fibres (pulled across them)";
    case "matrix compression":
      return "the resin crushing across the fibres";
    case "shear":
      return "the resin shearing between the fibres";
  }
}

/** the strength that a failure is judged against, MPa */
export function failureStrength(m: PlyMaterial, f: PlyFailure): number {
  return f === "fibre tension" ? m.Xt : f === "fibre compression" ? m.Xc : f === "matrix tension" ? m.Yt : f === "matrix compression" ? m.Yc : m.S;
}

/** scratch result of plyCheck */
export interface PlyCheck {
  /** Tsai–Wu utilisation: 1 / the factor on the stresses that fails the ply (0 unstressed) */
  u: number;
  /** stress along the fibres over their strength (either way across a woven cloth) */
  f: number;
  /** index into PLY_FAILURES: the largest of the stresses over their strengths */
  mode: number;
  /** the ply's stresses in its own axes, MPa */
  s1: number;
  s2: number;
  t12: number;
}

export function newPlyCheck(): PlyCheck {
  return { u: 0, f: 0, mode: 0, s1: 0, s2: 0, t12: 0 };
}

/**
 * A ply at angle a (radians, in the wall's axes) under the wall's strain there (ε_x, ε_y, γ_xy): its stresses along
 * and across its fibres and the Tsai–Wu utilisation. Tsai–Wu in plane stress, F12 = −½√(F11 F22):
 * F1σ1 + F2σ2 + F11σ1² + F22σ2² + F66τ² + 2F12σ1σ2 = 1 at failure; the factor R on the stresses that reaches it
 * solves aR² + bR = 1, so u = 1/R = (b + √(b² + 4a)) / 2, which scales with the stresses.
 */
export function plyCheck(m: PlyMaterial, ex: number, ey: number, gxy: number, a: number, out: PlyCheck): PlyCheck {
  const c = Math.cos(a),
    s = Math.sin(a);
  const e1 = c * c * ex + s * s * ey + s * c * gxy;
  const e2 = s * s * ex + c * c * ey - s * c * gxy;
  const g12 = 2 * s * c * (ey - ex) + (c * c - s * s) * gxy;
  const [Q11, Q12, Q22, Q66] = plyQ(m);
  const s1 = Q11 * e1 + Q12 * e2,
    s2 = Q12 * e1 + Q22 * e2,
    t12 = Q66 * g12;
  const F1 = 1 / m.Xt - 1 / m.Xc,
    F2 = 1 / m.Yt - 1 / m.Yc;
  const F11 = 1 / (m.Xt * m.Xc),
    F22 = 1 / (m.Yt * m.Yc),
    F66 = 1 / (m.S * m.S);
  const F12 = -0.5 * Math.sqrt(F11 * F22);
  const qa = F11 * s1 * s1 + F22 * s2 * s2 + F66 * t12 * t12 + 2 * F12 * s1 * s2;
  const qb = F1 * s1 + F2 * s2;
  out.u = Math.max(0, (qb + Math.sqrt(Math.max(0, qb * qb + 4 * qa))) / 2);
  const r1 = s1 >= 0 ? s1 / m.Xt : -s1 / m.Xc;
  const r2 = s2 >= 0 ? s2 / m.Yt : -s2 / m.Yc;
  const r6 = Math.abs(t12) / m.S;
  out.f = m.woven ? Math.max(r1, r2) : r1;
  // a cloth's "across" is fibres too
  out.mode = r1 >= r2 && r1 >= r6 ? (s1 >= 0 ? 0 : 1) : r2 >= r6 ? (m.woven ? (s2 >= 0 ? 0 : 1) : s2 >= 0 ? 2 : 3) : 4;
  out.s1 = s1;
  out.s2 = s2;
  out.t12 = t12;
  return out;
}

// ---------- where the fibres run ----------

/** where 0° runs: "auto" (along the tubes on a part made of tubes, else along its length), "tubes", or a direction */
export type FibreRule = "auto" | "tubes" | V3;

/** one part's shell triangles, for laying out the fibres */
export interface FibreMesh {
  /** corners of each triangle (node numbers) */
  corners: ArrayLike<number>;
  /** each triangle's axes in the world: rows x, y, z (z the outward normal), 9 per triangle */
  R: ArrayLike<number>;
  /** each triangle's corners in its own axes, 6 per triangle (x1 = y1 = y2 = 0) */
  xy: ArrayLike<number>;
  area: ArrayLike<number>;
  /** the nodes' positions and normals, 3 per node */
  nodeP: ArrayLike<number>;
  nodeN: ArrayLike<number>;
}

export interface FibreField {
  /** per triangle: the angle of 0° from its own x axis, radians, counterclockwise about its outward normal */
  phi: Float64Array;
  /** how 0° was laid: along the tubes, along the part's length, or along the direction asked for */
  how: "tubes" | "length" | "direction";
  /** the direction 0° follows where it is not along tubes */
  dir: V3;
  /** share of the surface (by area) where the direction asked for runs nearly square to it, so 0° follows the part there */
  fallback: number;
  /** share of the surface (by area) that curves clearly more one way than the other, like a tube */
  tubeShare: number;
}

const dot3 = (a: ArrayLike<number>, ao: number, b: ArrayLike<number>, bo: number) => a[ao] * b[bo] + a[ao + 1] * b[bo + 1] + a[ao + 2] * b[bo + 2];

/**
 * The 0° direction on each triangle. Along a tube it is the way the surface curves least (the tube's axis), from the
 * curvature the corners' normals show, smoothed over the neighbours; elsewhere it is a direction laid onto the
 * surface: the one asked for, or the part's length (its longest spread). The angles are of lines: 0° and 180° are
 * the same fibres.
 */
export function fibreField(mesh: FibreMesh, rule: FibreRule): FibreField {
  const ne = mesh.area.length;
  const R = mesh.R,
    xy = mesh.xy,
    C = mesh.corners;
  const nn = mesh.nodeP.length / 3;
  let totalA = 0;
  for (let e = 0; e < ne; e++) totalA += mesh.area[e];
  // the part's spread: its longest axis, and its size
  const cen: V3 = [0, 0, 0];
  for (let e = 0; e < ne; e++)
    for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) cen[c] += (mesh.area[e] / 3) * mesh.nodeP[3 * C[3 * e + k] + c];
  for (let c = 0; c < 3; c++) cen[c] /= totalA || 1;
  const cov = new Float64Array(9);
  for (let e = 0; e < ne; e++)
    for (let k = 0; k < 3; k++) {
      const v = C[3 * e + k];
      const d = [mesh.nodeP[3 * v] - cen[0], mesh.nodeP[3 * v + 1] - cen[1], mesh.nodeP[3 * v + 2] - cen[2]];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[3 * i + j] += (mesh.area[e] / 3) * d[i] * d[j];
    }
  const eig = symEigen(cov, 3);
  const order = [0, 1, 2].sort((i, j) => eig.val[j] - eig.val[i]);
  const axisOf = (k: number): V3 => [eig.vec[order[k]], eig.vec[3 + order[k]], eig.vec[6 + order[k]]];
  const size = 4 * Math.sqrt(Math.max(eig.val[order[0]], 1e-12) / Math.max(totalA, 1e-12)) + 1e-9;

  // ---- curvature: per triangle from its corners' normals, as a tensor in the world, averaged to the nodes ----
  const Sw = new Float64Array(6 * ne);
  for (let e = 0; e < ne; e++) {
    const x2 = xy[6 * e + 2],
      x3 = xy[6 * e + 4],
      y3 = xy[6 * e + 5];
    const A2 = x2 * y3;
    if (!(Math.abs(A2) > 0)) continue;
    const bx = [-y3 / A2, y3 / A2, 0];
    const by = [(x3 - x2) / A2, -x3 / A2, x2 / A2];
    let g00 = 0,
      g01 = 0,
      g10 = 0,
      g11 = 0;
    for (let k = 0; k < 3; k++) {
      const v = C[3 * e + k];
      const nx = dot3(mesh.nodeN, 3 * v, R, 9 * e),
        ny = dot3(mesh.nodeN, 3 * v, R, 9 * e + 3);
      g00 += nx * bx[k];
      g01 += nx * by[k];
      g10 += ny * bx[k];
      g11 += ny * by[k];
    }
    const s12 = (g01 + g10) / 2;
    toWorld(R, e, g00, g11, s12, Sw, 6 * e);
  }
  const Sn = nodeAverage(Sw, mesh, nn);
  const an = new Float64Array(ne);
  const tubeDir = new Float64Array(3 * ne);
  let tubeArea = 0;
  for (let e = 0; e < ne; e++) {
    const S = cornerMean(Sn, C, e);
    const [k11, k22, k12] = inPlane(R, e, S);
    const m = (k11 + k22) / 2,
      r = Math.hypot((k11 - k22) / 2, k12);
    const la = m + r,
      lb = m - r;
    // the eigenvector of la at angle th; the axis is the one that curves least
    const th = 0.5 * Math.atan2(2 * k12, k11 - k22);
    const ax = Math.abs(la) <= Math.abs(lb) ? th : th + Math.PI / 2;
    const big = Math.max(Math.abs(la), Math.abs(lb)),
      small = Math.min(Math.abs(la), Math.abs(lb));
    an[e] = (big - small) / (big + small + 1 / size);
    for (let c = 0; c < 3; c++) tubeDir[3 * e + c] = Math.cos(ax) * R[9 * e + c] + Math.sin(ax) * R[9 * e + 3 + c];
    if (an[e] > TUBE) tubeArea += mesh.area[e];
  }
  const tubeShare = totalA > 0 ? tubeArea / totalA : 0;
  const how: FibreField["how"] = rule === "tubes" || (rule === "auto" && tubeShare > 0.5) ? "tubes" : Array.isArray(rule) ? "direction" : "length";
  let dir: V3 = Array.isArray(rule) ? norm3(rule as V3) : axisOf(0);

  // ---- the direction laid onto each triangle; where it runs nearly square to it, the tube's axis or the part's next spread ----
  const phi = new Float64Array(ne);
  let fallbackA = 0;
  const angleOf = (e: number, d: ArrayLike<number>, o = 0) => Math.atan2(dot3(d, o, R, 9 * e + 3), dot3(d, o, R, 9 * e));
  const laid = (e: number, d: V3): number | null => {
    const n = 9 * e + 6;
    const dn = d[0] * R[n] + d[1] * R[n + 1] + d[2] * R[n + 2];
    const along = Math.sqrt(Math.max(0, 1 - dn * dn));
    return along < 0.3 ? null : angleOf(e, d);
  };
  if (how !== "tubes") {
    const second = axisOf(1);
    for (let e = 0; e < ne; e++) {
      const p = laid(e, dir);
      if (p !== null) phi[e] = p;
      else {
        fallbackA += mesh.area[e];
        phi[e] = an[e] > TUBE ? angleOf(e, tubeDir, 3 * e) : (laid(e, how === "direction" ? axisOf(0) : second) ?? laid(e, second) ?? 0);
      }
    }
    return { phi, how, dir, fallback: totalA > 0 ? fallbackA / totalA : 0, tubeShare };
  }

  // ---- along the tubes: each triangle held to its axis as firmly as it is tube-like, the part's length faintly,
  // smoothed over the neighbours so joints between tubes blend ----
  const target = new Float64Array(6 * ne);
  for (let e = 0; e < ne; e++) {
    const w = an[e] > 0.3 ? an[e] : 0;
    addLine(target, 6 * e, tubeDir, 3 * e, w);
    // the part's length, laid on the triangle
    const n = 9 * e + 6;
    const dn = dir[0] * R[n] + dir[1] * R[n + 1] + dir[2] * R[n + 2];
    const p: V3 = [dir[0] - dn * R[n], dir[1] - dn * R[n + 1], dir[2] - dn * R[n + 2]];
    const pl = Math.hypot(p[0], p[1], p[2]);
    if (pl > 0.3) addLine(target, 6 * e, [p[0] / pl, p[1] / pl, p[2] / pl], 0, 0.05);
  }
  let T = Float64Array.from(target);
  for (let it = 0; it < 12; it++) {
    const Tn = nodeAverage(T, mesh, nn);
    const next = new Float64Array(6 * ne);
    for (let e = 0; e < ne; e++) {
      const S = cornerMean(Tn, C, e);
      for (let c = 0; c < 6; c++) next[6 * e + c] = 0.4 * target[6 * e + c] + 0.6 * S[c];
    }
    T = next;
  }
  for (let e = 0; e < ne; e++) {
    const S = T.subarray(6 * e, 6 * e + 6);
    const [t11, t22, t12] = inPlane(R, e, S);
    phi[e] = t11 === 0 && t22 === 0 && t12 === 0 ? 0 : 0.5 * Math.atan2(2 * t12, t11 - t22);
  }
  return { phi, how, dir, fallback: 0, tubeShare };
}

/** curvature anisotropy above which a triangle counts as part of a tube */
const TUBE = 0.6;

function norm3(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** a symmetric in-plane tensor (s11, s22, s12 in the triangle's axes) as a world tensor: xx yy zz xy yz zx */
function toWorld(R: ArrayLike<number>, e: number, s11: number, s22: number, s12: number, out: Float64Array, o: number) {
  const x = 9 * e,
    y = 9 * e + 3;
  const comp = (i: number, j: number) => s11 * R[x + i] * R[x + j] + s22 * R[y + i] * R[y + j] + s12 * (R[x + i] * R[y + j] + R[y + i] * R[x + j]);
  out[o] = comp(0, 0);
  out[o + 1] = comp(1, 1);
  out[o + 2] = comp(2, 2);
  out[o + 3] = comp(0, 1);
  out[o + 4] = comp(1, 2);
  out[o + 5] = comp(2, 0);
}

/** a line d (unit) as the tensor w·d dᵀ, added */
function addLine(out: Float64Array, o: number, d: ArrayLike<number>, d0: number, w: number) {
  const a = d[d0],
    b = d[d0 + 1],
    c = d[d0 + 2];
  out[o] += w * a * a;
  out[o + 1] += w * b * b;
  out[o + 2] += w * c * c;
  out[o + 3] += w * a * b;
  out[o + 4] += w * b * c;
  out[o + 5] += w * c * a;
}

/** a world tensor (xx yy zz xy yz zx) seen in a triangle's plane: s11, s22, s12 */
function inPlane(R: ArrayLike<number>, e: number, S: ArrayLike<number>): [number, number, number] {
  const q = (u: number, v: number) => {
    const a = [R[u], R[u + 1], R[u + 2]],
      b = [R[v], R[v + 1], R[v + 2]];
    return (
      S[0] * a[0] * b[0] + S[1] * a[1] * b[1] + S[2] * a[2] * b[2] + S[3] * (a[0] * b[1] + a[1] * b[0]) + S[4] * (a[1] * b[2] + a[2] * b[1]) + S[5] * (a[2] * b[0] + a[0] * b[2])
    );
  };
  const x = 9 * e,
    y = 9 * e + 3;
  return [q(x, x), q(y, y), q(x, y)];
}

/** per-triangle tensors (6 each) averaged to the nodes by area */
function nodeAverage(T: Float64Array, mesh: FibreMesh, nn: number): Float64Array {
  const out = new Float64Array(6 * nn);
  const w = new Float64Array(nn);
  const ne = mesh.area.length;
  for (let e = 0; e < ne; e++)
    for (let k = 0; k < 3; k++) {
      const v = mesh.corners[3 * e + k];
      const a = mesh.area[e];
      w[v] += a;
      for (let c = 0; c < 6; c++) out[6 * v + c] += a * T[6 * e + c];
    }
  for (let v = 0; v < nn; v++) if (w[v] > 0) for (let c = 0; c < 6; c++) out[6 * v + c] /= w[v];
  return out;
}

function cornerMean(Tn: Float64Array, C: ArrayLike<number>, e: number): Float64Array {
  const out = new Float64Array(6);
  for (let k = 0; k < 3; k++) {
    const v = C[3 * e + k];
    for (let c = 0; c < 6; c++) out[c] += Tn[6 * v + c] / 3;
  }
  return out;
}
