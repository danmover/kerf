import { beforeAll, describe, expect, it } from "vitest";
import { runStructural, type StructuralInput, type StructuralResult } from "../src/analysis/fe/structural";
import type { ShellPlies } from "../src/analysis/fe/shells";
import { mechMaterial } from "../src/analysis/materials";
import { structuralInput } from "../src/analysis/runtime";
import type { StructuralSpec } from "../src/analysis/spec";
import { structuralSummary } from "../src/analysis/summary";
import { KernelCore } from "../src/kernel/core";
import { evaluate } from "../src/lang/evaluator";
import { initKernel } from "./helpers/kernel";
import { effectiveEnu, fibreField, laminate, layupText, newPlyCheck, parseLayup, plyCheck, plyMaterial, plyQ, PLY_MATERIALS, qBar, type FibreMesh } from "../src/analysis/fe/laminate";
import { shellFrame } from "../src/analysis/fe/shellElement";
import type { V3 } from "../src/analysis/fe/voxel";

const CARBON = PLY_MATERIALS.carbon;
const rad = (d: number) => (d * Math.PI) / 180;
const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

describe("stacking codes", () => {
  it("reads the usual notation", () => {
    expect(parseLayup("[0/±45/90]s")).toEqual([0, 45, -45, 90, 90, -45, 45, 0]);
    expect(parseLayup("[0/90]2s")).toEqual([0, 90, 0, 90, 90, 0, 90, 0]);
    expect(parseLayup("[0₂/±45]s")).toEqual([0, 0, 45, -45, -45, 45, 0, 0]);
    expect(parseLayup("[0_2/∓30]")).toEqual([0, 0, -30, 30]);
    expect(parseLayup("[(0/90)2/45]")).toEqual([0, 90, 0, 90, 45]);
    expect(parseLayup("0, 45, -45, 90")).toEqual([0, 45, -45, 90]);
    expect(parseLayup("[+-45]2s")).toEqual([45, -45, 45, -45, -45, 45, -45, 45]);
    expect(parseLayup("[0/−90/0]T")).toEqual([0, 90, 0]);
    expect(parseLayup("[±45/0₃]s")).toEqual([45, -45, 0, 0, 0, 0, 0, 0, -45, 45]);
  });
  it("says what is wrong with a bad one", () => {
    expect(parseLayup("[0/45")).toEqual({ error: expect.stringMatching(/not closed/) });
    expect(parseLayup("0/100")).toEqual({ error: expect.stringMatching(/past 90/) });
    expect(parseLayup("0/x")).toEqual({ error: expect.stringMatching(/"x" is not an angle/) });
    expect(parseLayup("")).toEqual({ error: expect.stringMatching(/empty/) });
  });
  it("writes a stack back short", () => {
    expect(layupText([0, 45, -45, 90, 90, -45, 45, 0])).toBe("[0/±45/90]s");
    expect(layupText([0, 0, 45, -45, -45, 45, 0, 0])).toBe("[0₂/±45]s");
    expect(layupText([0, 90, 45])).toBe("[0/90/45]");
  });
  it("knows its materials by their usual names", () => {
    expect(plyMaterial("Carbon UD")?.key).toBe("carbon");
    expect(plyMaterial("3k twill")?.key).toBe("carbon woven");
    expect(plyMaterial("E-glass")?.key).toBe("glass");
    expect(plyMaterial("kevlar")?.key).toBe("aramid");
    expect(plyMaterial("unobtainium")).toBeUndefined();
  });
});

describe("lamination theory", () => {
  it("turns a ply's stiffness as its strain energy says", () => {
    const [Q11, Q12, Q22, Q66] = plyQ(CARBON);
    for (const deg of [0, 17, 45, -60, 90]) {
      const a = rad(deg);
      const Qb = qBar(CARBON, a);
      const e: V3 = [1e-3, -4e-4, 7e-4];
      // the same strain in the ply's axes, and its energy there
      const c = Math.cos(a),
        s = Math.sin(a);
      const e1 = c * c * e[0] + s * s * e[1] + s * c * e[2];
      const e2 = s * s * e[0] + c * c * e[1] - s * c * e[2];
      const g12 = 2 * s * c * (e[1] - e[0]) + (c * c - s * s) * e[2];
      const W = Q11 * e1 * e1 + 2 * Q12 * e1 * e2 + Q22 * e2 * e2 + Q66 * g12 * g12;
      let Wb = 0;
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) Wb += e[i] * Qb[3 * i + j] * e[j];
      expect(rel(Wb, W)).toBeLessThan(1e-12);
    }
    // +45°: pulled along x it shears one way, the other way at −45°
    expect(qBar(CARBON, rad(45))[2]).toBeCloseTo((Q11 - Q22) / 4, 6);
    expect(qBar(CARBON, rad(-45))[2]).toBeCloseTo(-(Q11 - Q22) / 4, 6);
  });
  it("lays a quasi-isotropic stack as stiff as Kerf's carbon plate, the same every way", () => {
    const stack = parseLayup("[0/±45/90]s") as number[];
    for (const turn of [0, 22.5, 60]) {
      const L = laminate(stack.map((d) => ({ m: CARBON, t: 0.12, a: rad(d + turn) })));
      const { Ex, Ey, nu } = effectiveEnu(L);
      expect(rel(Ex, 50250)).toBeLessThan(0.01);
      expect(rel(Ey, Ex)).toBeLessThan(1e-9);
      expect(nu).toBeCloseTo(0.308, 2);
      expect(L.t).toBeCloseTo(0.96, 12);
    }
  });
  it("measures a symmetric wall's coupling and bending about its outer surface", () => {
    const stack = parseLayup("[0/90]s") as number[];
    const t = 0.12;
    const L = laminate(stack.map((d) => ({ m: CARBON, t, a: rad(d) })));
    const h = 4 * t;
    // about the middle: B = 0, D = Σ Q̄ (z³) / 3; moved to the outer surface: B = −(h/2) A, D = D_mid + (h²/4) A
    const Q0 = qBar(CARBON, 0),
      Q90 = qBar(CARBON, rad(90));
    const zm = [h / 2, h / 2 - t, 0, -t, -h / 2];
    const Dmid = new Float64Array(9);
    [Q0, Q90, Q90, Q0].forEach((Q, k) => {
      for (let r = 0; r < 9; r++) Dmid[r] += (Q[r] * (zm[k] ** 3 - zm[k + 1] ** 3)) / 3;
    });
    for (let r = 0; r < 9; r++) {
      expect(L.B[r]).toBeCloseTo((-h / 2) * L.A[r], 6);
      expect(L.D[r]).toBeCloseTo(Dmid[r] + (h * h * L.A[r]) / 4, 6);
    }
    expect(L.rhoT).toBeCloseTo(1.55 * h, 12);
  });
});

describe("Tsai–Wu", () => {
  const pc = newPlyCheck();
  /** the wall strain that gives a ply at angle a its own stresses (σ1, σ2, τ12) */
  function strainFor(m: typeof CARBON, s1: number, s2: number, t12: number, a: number): V3 {
    const e1 = s1 / m.E1 - (m.nu12 * s2) / m.E1;
    const e2 = s2 / m.E2 - (m.nu12 * s1) / m.E1;
    const g12 = t12 / m.G12;
    // back to the wall's axes
    const c = Math.cos(a),
      s = Math.sin(a);
    return [c * c * e1 + s * s * e2 - s * c * g12, s * s * e1 + c * c * e2 + s * c * g12, 2 * s * c * (e1 - e2) + (c * c - s * s) * g12];
  }
  it("fails a ply at each of its own strengths, whatever its angle", () => {
    for (const deg of [0, 30, -75]) {
      const a = rad(deg);
      const cases: [number, number, number, number][] = [
        [CARBON.Xt, 0, 0, 0],
        [-CARBON.Xc, 0, 0, 1],
        [0, CARBON.Yt, 0, 2],
        [0, -CARBON.Yc, 0, 3],
        [0, 0, CARBON.S, 4],
      ];
      for (const [s1, s2, t12, mode] of cases) {
        const e = strainFor(CARBON, s1, s2, t12, a);
        plyCheck(CARBON, e[0], e[1], e[2], a, pc);
        expect(pc.u).toBeCloseTo(1, 6);
        expect(pc.mode).toBe(mode);
        expect(pc.s1).toBeCloseTo(s1, 3);
        expect(pc.s2).toBeCloseTo(s2, 3);
      }
    }
  });
  it("scales its utilisation with the load, and counts both ways of a cloth as fibres", () => {
    const e = strainFor(CARBON, 600, 10, 20, 0);
    plyCheck(CARBON, e[0], e[1], e[2], 0, pc);
    const u1 = pc.u;
    plyCheck(CARBON, 2 * e[0], 2 * e[1], 2 * e[2], 0, pc);
    expect(pc.u / u1).toBeCloseTo(2, 9);
    const W = PLY_MATERIALS["carbon woven"];
    const ew = strainFor(W, 0, W.Yt, 0, 0);
    plyCheck(W, ew[0], ew[1], ew[2], 0, pc);
    expect(pc.mode).toBe(0);
    expect(pc.f).toBeCloseTo(1, 6);
  });
});

/** a part's shell triangles for fibreField: frames from shellFrame, node normals averaged by area */
function fibreMesh(P: number[], T: number[]): FibreMesh {
  const ne = T.length / 3;
  const R: number[] = [],
    xy: number[] = [],
    area: number[] = [];
  const nodeN = new Float64Array(P.length);
  for (let e = 0; e < ne; e++) {
    const pt = (k: number) => P.slice(3 * T[3 * e + k], 3 * T[3 * e + k] + 3);
    const fr = shellFrame(pt(0), pt(1), pt(2));
    R.push(...fr.R);
    xy.push(...fr.xy);
    area.push(fr.area);
    for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) nodeN[3 * T[3 * e + k] + c] += fr.area * fr.R[6 + c];
  }
  for (let v = 0; v < P.length / 3; v++) {
    const l = Math.hypot(nodeN[3 * v], nodeN[3 * v + 1], nodeN[3 * v + 2]) || 1;
    for (let c = 0; c < 3; c++) nodeN[3 * v + c] /= l;
  }
  return { corners: T, R, xy, area, nodeP: P, nodeN };
}

/** an open tube's side about an axis through the origin: n round, m along, outward */
function tube(axis: V3, r: number, L: number, n: number, m: number): { P: number[]; T: number[] } {
  const a = (() => {
    const l = Math.hypot(...axis);
    return axis.map((x) => x / l) as V3;
  })();
  const u = Math.abs(a[0]) < 0.9 ? ([1, 0, 0] as V3) : ([0, 1, 0] as V3);
  const cr = (p: V3, q: V3): V3 => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
  const e1 = (() => {
    const c = cr(a, u);
    const l = Math.hypot(...c);
    return c.map((x) => x / l) as V3;
  })();
  const e2 = cr(a, e1);
  const P: number[] = [],
    T: number[] = [];
  for (let j = 0; j <= m; j++)
    for (let i = 0; i < n; i++) {
      const th = (2 * Math.PI * i) / n,
        z = (L * j) / m;
      for (let c = 0; c < 3; c++) P.push(r * Math.cos(th) * e1[c] + r * Math.sin(th) * e2[c] + z * a[c]);
    }
  for (let j = 0; j < m; j++)
    for (let i = 0; i < n; i++) {
      const p = j * n + i,
        q = j * n + ((i + 1) % n);
      T.push(p, q, q + n, p, q + n, p + n);
    }
  return { P, T };
}

/** the 0° direction of triangle e in the world */
function zeroDir(mesh: FibreMesh, phi: Float64Array, e: number): V3 {
  const R = mesh.R;
  return [0, 1, 2].map((c) => Math.cos(phi[e]) * R[9 * e + c] + Math.sin(phi[e]) * R[9 * e + 3 + c]) as V3;
}

describe("where the fibres run", () => {
  it("lays 0° along a tube's axis, whichever way it runs", () => {
    const ax: V3 = [1, 1, 0.3];
    const l = Math.hypot(...ax);
    const t = tube(ax, 15, 200, 24, 20);
    const mesh = fibreMesh(t.P, t.T);
    const f = fibreField(mesh, "auto");
    expect(f.how).toBe("tubes");
    expect(f.tubeShare).toBeGreaterThan(0.9);
    for (let e = 0; e < f.phi.length; e++) {
      const d = zeroDir(mesh, f.phi, e);
      expect(Math.abs(d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2]) / l).toBeGreaterThan(0.99);
    }
  });
  it("lays 0° along a direction on a flat plate, and along its length when none is given", () => {
    // a 200 × 50 plate in the plane z = 0, facing +z
    const P: number[] = [],
      T: number[] = [];
    const nx = 20,
      ny = 5;
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) P.push((200 * i) / nx, (50 * j) / ny, 0);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const p = j * (nx + 1) + i;
        T.push(p, p + 1, p + nx + 2, p, p + nx + 2, p + nx + 1);
      }
    const mesh = fibreMesh(P, T);
    const along = fibreField(mesh, "auto");
    expect(along.how).toBe("length");
    const ac = fibreField(mesh, [0, 1, 0]);
    expect(ac.how).toBe("direction");
    for (let e = 0; e < along.phi.length; e++) {
      expect(Math.abs(zeroDir(mesh, along.phi, e)[0])).toBeGreaterThan(0.999);
      expect(Math.abs(zeroDir(mesh, ac.phi, e)[1])).toBeGreaterThan(0.999);
    }
    // straight down onto the plate: no way along it, so 0° follows the plate's length and says so
    const down = fibreField(mesh, [0, 0, 1]);
    expect(down.fallback).toBeCloseTo(1, 6);
    expect(Math.abs(zeroDir(mesh, down.phi, 0)[0])).toBeGreaterThan(0.999);
  });
});

// ---------- plies in the shell solver ----------

type Mesh = { positions: Float32Array; indices: Uint32Array };

/** A closed box surface, two triangles a face, outward. */
function boxMesh(lo: V3, hi: V3): Mesh {
  const [x0, y0, z0] = lo,
    [x1, y1, z1] = hi;
  const P: number[] = [];
  const T: number[] = [];
  const quad = (a: V3, b: V3, c: V3, d: V3) => {
    const o = P.length / 3;
    P.push(...a, ...b, ...c, ...d);
    T.push(o, o + 1, o + 2, o, o + 2, o + 3);
  };
  quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]);
  quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
  quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]);
  quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
  quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
  return { positions: new Float32Array(P), indices: new Uint32Array(T) };
}

/** A closed cylinder (a rod) along z, n sides and m rings along it (so the display has points along it), outward. */
function rodMesh(R: number, L: number, n: number, m = 1): Mesh {
  const P: number[] = [0, 0, 0, 0, 0, L];
  const T: number[] = [];
  for (let k = 0; k <= m; k++)
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      P.push(R * Math.cos(a), R * Math.sin(a), (L * k) / m);
    }
  const at = (k: number, i: number) => 2 + k * n + (i % n);
  for (let i = 0; i < n; i++) {
    T.push(0, at(0, i + 1), at(0, i), 1, at(m, i), at(m, i + 1));
    for (let k = 0; k < m; k++) T.push(at(k, i), at(k, i + 1), at(k + 1, i + 1), at(k, i), at(k + 1, i + 1), at(k + 1, i));
  }
  return { positions: new Float32Array(P), indices: new Uint32Array(T) };
}

const CF = mechMaterial("Carbon fiber");

function pliesOf(code: string, mat = CARBON, extra: Partial<ShellPlies> = {}): ShellPlies {
  const angles = parseLayup(code) as number[];
  return { plies: angles.map((angle) => ({ angle, m: mat, t: mat.t })), patches: [], label: `${code} of ${mat.label}`, ...extra };
}

const input = (over: Partial<StructuralInput>): StructuralInput => ({
  label: "plies",
  parts: [],
  materials: [CF],
  supports: [],
  loads: [],
  target: 30000,
  printed: false,
  buildDir: [0, 0, 1],
  safety: 2,
  elements: "shells",
  ...over,
});

/** the display vertex of part 0 nearest p */
function vertexAt(r: StructuralResult, p: V3): number {
  const f = r.parts[0];
  let best = 0,
    bd = Infinity;
  for (let i = 0; i < f.positions.length / 3; i++) {
    const dd = Math.hypot(f.positions[3 * i] - p[0], f.positions[3 * i + 1] - p[1], f.positions[3 * i + 2] - p[2]);
    if (dd < bd) {
      bd = dd;
      best = i;
    }
  }
  return best;
}

/** classical lamination theory for a symmetric wall pulled along 0° with N per width and nothing across: its plies' worst Tsai–Wu utilisation */
function pulledU(code: string, N: number, mat = CARBON): number {
  const angles = parseLayup(code) as number[];
  const L = laminate(angles.map((d) => ({ m: mat, t: mat.t, a: rad(d) })));
  // compliance of A: strains from (N, 0, 0)
  const A = L.A;
  const det = A[0] * (A[4] * A[8] - A[5] * A[7]) - A[1] * (A[3] * A[8] - A[5] * A[6]) + A[2] * (A[3] * A[7] - A[4] * A[6]);
  const a11 = (A[4] * A[8] - A[5] * A[7]) / det,
    a21 = -(A[3] * A[8] - A[5] * A[6]) / det,
    a31 = (A[3] * A[7] - A[4] * A[6]) / det;
  const pc = newPlyCheck();
  let u = 0;
  for (const d of angles) u = Math.max(u, plyCheck(mat, a11 * N, a21 * N, a31 * N, rad(d), pc).u);
  return u;
}

describe("plies in the shell solver", { timeout: 120_000 }, () => {
  const R = 30,
    Lt = 300,
    F = 3000;
  const tension = (code: string, extra: Partial<ShellPlies> = {}) =>
    runStructural(
      input({
        parts: [{ id: "tube", name: "tube", mesh: rodMesh(R, Lt, 48, 12), material: 0, shell: { kind: "laminate", plies: pliesOf(code, CARBON, extra) } }],
        supports: [{ region: { t: "face", part: "tube", dir: [0, 0, -1] } }],
        loads: [{ t: "force", region: { t: "face", part: "tube", dir: [0, 0, 1] }, f: [0, 0, F] }],
      }),
    );
  /** the wall's stretch between a quarter and three quarters of its length */
  const stretch = (r: StructuralResult) => {
    const at = (z: number) => r.parts[0].disp[3 * vertexAt(r, [R, 0, z]) + 2];
    return at((3 * Lt) / 4) - at(Lt / 4);
  };

  it("stretches a tube with its fibres along it as stiff as the fibres, and fails them at their strength", () => {
    const r = tension("[0]8");
    const w = r.shells!.parts[0];
    expect(w.plies!.fibre).toBe("along its tubes");
    expect(w.t).toBeCloseTo(0.96, 6);
    const t = 0.96,
      Rm = R - t / 2;
    const exact = (F * (Lt / 2)) / (CARBON.E1 * 2 * Math.PI * Rm * t);
    expect(rel(stretch(r), exact)).toBeLessThan(0.03);
    // halfway along, the fibres carry it all: σ1 = F / A
    const mid = r.parts[0].safety[vertexAt(r, [R, 0, Lt / 2])];
    expect(rel(mid, (CARBON.Xt * 2 * Math.PI * Rm * t) / F)).toBeLessThan(0.03);
    // its weight is its plies'
    expect(rel(r.mass, ((w.area * t) / 1000) * CARBON.density)).toBeLessThan(0.02);
  });
  it("stretches a hoop-wound tube as soft as the resin across its fibres, and cracks it there", () => {
    const r = tension("[90]8");
    const t = 0.96,
      Rm = R - t / 2;
    const exact = (F * (Lt / 2)) / (CARBON.E2 * 2 * Math.PI * Rm * t);
    expect(rel(stretch(r), exact)).toBeLessThan(0.03);
    const mid = r.parts[0].safety[vertexAt(r, [R, 0, Lt / 2])];
    expect(rel(mid, (CARBON.Yt * 2 * Math.PI * Rm * t) / F)).toBeLessThan(0.03);
    expect(r.shells!.parts[0].plies!.perPly.every((p) => p.failure === "matrix tension" || p.failure === "matrix compression" || p.failure === "shear")).toBe(true);
  });
  it("finds a quasi-isotropic tube's first ply to crack where lamination theory does", () => {
    const code = "[0/±45/90]s";
    const r = tension(code);
    const t = 0.96,
      Rm = R - t / 2;
    const u = pulledU(code, F / (2 * Math.PI * Rm));
    const mid = r.parts[0].safety[vertexAt(r, [R, 0, Lt / 2])];
    expect(rel(mid, 1 / u)).toBeLessThan(0.03);
    // and it is as stiff as Kerf's quasi-isotropic carbon
    expect(rel(stretch(r), (F * (Lt / 2)) / (50250 * 2 * Math.PI * Rm * t))).toBeLessThan(0.04);
    const text = r.shells!.notes.join("; ");
    expect(text).toMatch(/tube as its plies under its outer surface: \[0\/±45\/90\]s of T700-class carbon UD, 0\.96 mm, 0° along its tubes/);
    expect(text).toMatch(/Tsai–Wu/);
    expect(r.minSafety.mode).toBe("ply");
    expect(r.minSafety.ply!.index).toBeGreaterThanOrEqual(1);
  });
  it("adds a zone's plies inside the stack, thickening and strengthening the wall there", () => {
    const zone = { region: { t: "box" as const, at: [0, 0, Lt / 2] as V3, size: [3 * R, 3 * R, 80] as V3 }, plies: (parseLayup("[0/90]s") as number[]).map((angle) => ({ angle, m: CARBON, t: CARBON.t })), label: "the middle band" };
    const plain = tension("[0/±45/90]s");
    const r = tension("[0/±45/90]s", { patches: [zone] });
    const w = r.shells!.parts[0];
    expect(w.tMax).toBeCloseTo(0.96 + 0.48, 6);
    expect(w.plies!.stack.filter((p) => p.zone === "the middle band")).toHaveLength(4);
    // 80 mm of the tube's side gets 0.48 mm more
    const added = 2 * Math.PI * R * 80 * 0.48 * 1.55 * 1e-3;
    expect(rel(r.mass - plain.mass, added)).toBeLessThan(0.1);
    const mid = (x: StructuralResult) => x.parts[0].safety[vertexAt(x, [R, 0, Lt / 2])];
    expect(mid(r)).toBeGreaterThan(1.3 * mid(plain));
    expect(r.shells!.notes.join("; ")).toMatch(/with more plies in the middle band/);
  });
  it("bends a strip with its fibres along it or across it as stiff as they are that way", () => {
    const L = 200,
      b = 20,
      t = 0.96,
      Fz = 0.5;
    const strip = (fibre: V3) =>
      runStructural(
        input({
          parts: [{ id: "strip", name: "strip", mesh: boxMesh([0, 0, 0], [L, b, t]), material: 0, shell: { kind: "wall", plies: pliesOf("[0]8", CARBON, { fibre }) } }],
          supports: [{ region: { t: "face", part: "strip", dir: [-1, 0, 0] } }],
          loads: [{ t: "force", region: { t: "face", part: "strip", dir: [1, 0, 0] }, f: [0, 0, -Fz] }],
        }),
      );
    const I = (b * t ** 3) / 12;
    const tip = (r: StructuralResult) => -r.parts[0].disp[3 * vertexAt(r, [L, b / 2, t]) + 2];
    const along = strip([1, 0, 0]),
      across = strip([0, 1, 0]);
    expect(rel(tip(along), (Fz * L ** 3) / (3 * CARBON.E1 * I))).toBeLessThan(0.04);
    expect(rel(tip(across), (Fz * L ** 3) / (3 * CARBON.E2 * I))).toBeLessThan(0.04);
    expect(along.shells!.parts[0].plies!.fibre).toBe("along X");
  });
});

describe("plies in an analysis block", { timeout: 120_000 }, () => {
  beforeAll(initKernel);
  /** evaluate a design and build its first structural analysis's input from the parts' real meshes */
  function prepare(src: string) {
    const m = evaluate(src);
    const errs = m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
    if (errs.length) throw new Error(errs.join("; "));
    const spec = m.analyses.find((a) => a.kind === "structural") as StructuralSpec;
    const parts = m.parts.filter((p) => spec.parts.includes(p.name));
    const core = new KernelCore();
    for (const p of parts) core.build({ hash: p.hash, recipe: p.recipe, label: p.label });
    const prep = structuralInput(spec, parts, false, new Map(), (h) => core.mesh(h, "preview"));
    return { spec, input: prep?.input, error: prep?.error };
  }
  const TUBE = `part tube {
  material: "Carbon fiber"
  process: mfg.carbon_layup(pull: Y, wall: 1.2)
  body cylinder(d: 40, h: 400)
}
`;
  const design = (body: string, extra = "") => `design "t"
${TUBE}${extra}analysis "Bend" {
  parts: [tube${extra ? ", block" : ""}]
  fix: face(tube, -Z)
  load: force(face(tube, +Z), (100, 0, 0))
${body}
}
`;

  it("reads stacks, zones and the fibres' direction, and reports every ply", () => {
    const { spec, input } = prepare(design('  layup: [plies("0", "carbon woven"), plies("[0/±45/90]s"), plies("[0/90]", zone: zone(at: (0, 0, 0), r: 40), name: "the root")]'));
    expect(spec.layup).toHaveLength(3);
    expect(spec.layup![0]).toMatchObject({ material: "carbon woven", code: "[0]", angles: [0] });
    expect(spec.layup![1].angles).toEqual([0, 45, -45, 90, 90, -45, 45, 0]);
    expect(spec.layup![2].zone).toMatchObject({ t: "sphere", r: 40 });
    const sh = input!.parts[0].shell!;
    expect(sh.plies!.plies).toHaveLength(9);
    expect(sh.plies!.patches).toHaveLength(1);
    expect(sh.plies!.label).toBe("[0] of 3K twill carbon cloth, then [0/±45/90]s of T700-class carbon UD");
    const r = runStructural(input!);
    const w = r.shells!.parts[0];
    expect(w.plies!.t).toBeCloseTo(0.22 + 0.96, 6);
    expect(w.plies!.perPly).toHaveLength(11);
    expect(w.plies!.perPly[9]).toMatchObject({ ply: 10, angle: 0, zone: "the root" });
    expect(r.minSafety.mode).toBe("ply");
    const text = structuralSummary(spec, { status: "done", result: r, resolution: "standard" });
    expect(text).toMatch(/judged against the Tsai–Wu strength of ply \d+ \(/);
    expect(text).toMatch(/Walls: tube \(\[0\] of 3K twill carbon cloth, then \[0\/±45\/90\]s of T700-class carbon UD, .* 0° along its tubes/);
    expect(text).toMatch(/Plies \(from the outside in, each one's lowest Tsai–Wu factor\): tube: 1 0° /);
    expect(text).toMatch(/with more plies in the root/);
  });
  it("lays 0° along a direction when asked", () => {
    const { spec, input } = prepare(design('  layup: plies([0, 90, 90, 0])\n  fibre: (1, 1, 0)'));
    expect(spec.fibre![0]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(input!.parts[0].shell!.plies!.fibre).toEqual(spec.fibre);
    expect(spec.layup![0].code).toBe("[0/90]s");
    const tubes = prepare(design('  layup: plies("[0/90]s")\n  fiber: "tubes"'));
    expect(tubes.spec.fibre).toBe("tubes");
  });
  it("says what is wrong with plies it cannot use", () => {
    const err = (body: string, extra = "") =>
      evaluate(design(body, extra))
        .diagnostics.filter((d) => d.severity === "error")
        .map((d) => d.message)
        .join("; ");
    expect(err('  layup: plies("[0/45")')).toMatch(/plies\(\): a "\[" is not closed/);
    expect(err('  layup: plies("[0/90]s", "unobtainium")')).toMatch(/"unobtainium" is not a ply material Kerf knows/);
    expect(err("  fibre: X")).toMatch(/give the plies too/);
    expect(err('  layup: plies("[0/90]s")\n  elements: "solid"')).toMatch(/elements: "solid" cannot follow them/);
    expect(err('  layup: plies("[0/90]", zone: zone(at: (0, 0, 0), r: 40))')).toMatch(/only zones' plies/);
    expect(err('  layup: "[0/90]s"')).toMatch(/layup: should be plies/);
    // solved as solids with a metal part, so the plies cannot be followed
    const { error } = prepare(design('  layup: plies("[0/90]s")', 'part block {\n  material: "Steel"\n  at: (0, 0, -20)\n  body box(20, 20, 20)\n}\n'));
    expect(error).toMatch(/block is not a thin wall, so the parts are solved as solids/);
  });
});
