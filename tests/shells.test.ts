import { beforeAll, describe, expect, it } from "vitest";
import { runStructural, type FeaPart, type StructuralInput, type StructuralResult } from "../src/analysis/fe/structural";
import { structuralInput } from "../src/analysis/runtime";
import type { StructuralSpec } from "../src/analysis/spec";
import { structuralSummary } from "../src/analysis/summary";
import { KernelCore } from "../src/kernel/core";
import { evaluate } from "../src/lang/evaluator";
import { initKernel } from "./helpers/kernel";
import type { V3 } from "../src/analysis/fe/voxel";
import { mechMaterial, type MechMaterial } from "../src/analysis/materials";
import { BlockSystem, factorBlocks, nodeLinks } from "../src/analysis/fe/sparse";
import { shellFrame, shellLocalK, shellStrains, toWorld18 } from "../src/analysis/fe/shellElement";

const STEEL = mechMaterial("Steel");

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

/** A closed cylinder (a rod) along z, n sides, outward. */
function rodMesh(R: number, L: number, n: number): Mesh {
  const P: number[] = [0, 0, 0, 0, 0, L];
  const T: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    P.push(R * Math.cos(a), R * Math.sin(a), 0, R * Math.cos(a), R * Math.sin(a), L);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const b0 = 2 + 2 * i,
      t0 = 3 + 2 * i,
      b1 = 2 + 2 * j,
      t1 = 3 + 2 * j;
    T.push(b0, b1, t1, b0, t1, t0, 0, b1, b0, 1, t0, t1);
  }
  return { positions: new Float32Array(P), indices: new Uint32Array(T) };
}

/** A thin cylindrical panel about the x axis: radius R (mid-surface), length L, half-angle th, wall t; outward. */
function roofMesh(R: number, L: number, th: number, t: number, nArc: number, nLen: number): Mesh {
  const P: number[] = [];
  const T: number[] = [];
  const at = (r: number, i: number, k: number) => {
    const a = -th + (2 * th * i) / nArc;
    return [(L * k) / nLen, r * Math.sin(a), r * Math.cos(a)];
  };
  const id = (side: number, i: number, k: number) => side * (nArc + 1) * (nLen + 1) + k * (nArc + 1) + i;
  for (const side of [0, 1]) for (let k = 0; k <= nLen; k++) for (let i = 0; i <= nArc; i++) P.push(...at(side ? R - t / 2 : R + t / 2, i, k));
  for (let k = 0; k < nLen; k++)
    for (let i = 0; i < nArc; i++) {
      const a = id(0, i, k),
        b = id(0, i + 1, k),
        c = id(0, i + 1, k + 1),
        d = id(0, i, k + 1);
      T.push(a, c, b, a, d, c);
      const A = id(1, i, k),
        B = id(1, i + 1, k),
        C = id(1, i + 1, k + 1),
        D = id(1, i, k + 1);
      T.push(A, B, C, A, C, D);
    }
  // the four edges
  for (let k = 0; k < nLen; k++) {
    for (const [i, flip] of [
      [0, false],
      [nArc, true],
    ] as [number, boolean][]) {
      const a = id(0, i, k),
        b = id(0, i, k + 1),
        c = id(1, i, k + 1),
        d = id(1, i, k);
      if (flip) T.push(a, b, c, a, c, d);
      else T.push(a, c, b, a, d, c);
    }
  }
  for (let i = 0; i < nArc; i++) {
    for (const [k, flip] of [
      [0, false],
      [nLen, true],
    ] as [number, boolean][]) {
      const a = id(0, i, k),
        b = id(0, i + 1, k),
        c = id(1, i + 1, k),
        d = id(1, i, k);
      if (flip) T.push(a, c, b, a, d, c);
      else T.push(a, b, c, a, c, d);
    }
  }
  return { positions: new Float32Array(P), indices: new Uint32Array(T) };
}

const part = (name: string, m: Mesh, shell: FeaPart["shell"], material = 0): FeaPart => ({ id: name, name, mesh: m, material, shell });

const base = (over: Partial<StructuralInput>): StructuralInput => ({
  label: "wall",
  parts: [],
  materials: [STEEL],
  supports: [],
  loads: [],
  target: 30000,
  printed: false,
  buildDir: [0, 0, 1],
  safety: 2,
  elements: "shells",
  ...over,
});

const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

/** the movement at the mesh vertex nearest p */
function dispAt(r: StructuralResult, p: V3, pi = 0): V3 {
  const f = r.parts[pi];
  let best = 0,
    bd = Infinity;
  for (let i = 0; i < f.positions.length / 3; i++) {
    const dd = Math.hypot(f.positions[3 * i] - p[0], f.positions[3 * i + 1] - p[1], f.positions[3 * i + 2] - p[2]);
    if (dd < bd) {
      bd = dd;
      best = i;
    }
  }
  return [f.disp[3 * best], f.disp[3 * best + 1], f.disp[3 * best + 2]];
}

describe("block sparse solver", () => {
  it("solves a mesh's system exactly", () => {
    const nx = 30,
      ny = 20,
      B = 6;
    const n = nx * ny;
    const pos = new Float64Array(3 * n);
    const els: number[][] = [];
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const v = j * nx + i;
        pos[3 * v] = i;
        pos[3 * v + 1] = j;
        pos[3 * v + 2] = 0.1 * Math.sin(i);
      }
    for (let j = 0; j + 1 < ny; j++)
      for (let i = 0; i + 1 < nx; i++) {
        const a = j * nx + i;
        els.push([a, a + 1, a + nx + 1], [a, a + nx + 1, a + nx]);
      }
    const { ptr, idx } = nodeLinks(n, els);
    const sys = new BlockSystem(n, B, pos, ptr, idx);
    const A = sys.matrix();
    let seed = 1;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
    for (const e of els) {
      const N = 3 * B;
      const M = Array.from({ length: N * N }, rnd);
      const ke = new Float64Array(N * N);
      for (let r = 0; r < N; r++)
        for (let c = 0; c < N; c++) {
          let s = 0;
          for (let m = 0; m < N; m++) s += M[r * N + m] * M[c * N + m];
          ke[r * N + c] = s + (r === c ? 0.01 : 0);
        }
      A.addElement(e, ke);
    }
    const f = factorBlocks(A);
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    const xTrue = Float64Array.from({ length: n * B }, rnd);
    const b = new Float64Array(n * B);
    A.mul(xTrue, b);
    f.solve(b);
    let err = 0;
    for (let i = 0; i < n * B; i++) err = Math.max(err, Math.abs(b[i] - xTrue[i]));
    expect(err).toBeLessThan(1e-9);
    // a fill far below a band's: nested dissection keeps the factor sparse
    expect(sys.fill / n).toBeLessThan(30);
  });
  it("finds a freedom with no stiffness", () => {
    const pos = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const { ptr, idx } = nodeLinks(3, [[0, 1, 2]]);
    const sys = new BlockSystem(3, 6, pos, ptr, idx);
    const A = sys.matrix();
    const ke = new Float64Array(18 * 18);
    for (let i = 0; i < 18; i++) ke[19 * i] = i === 8 ? 0 : 1;
    A.addElement([0, 1, 2], ke);
    const f = factorBlocks(A);
    expect(f.ok).toBe(false);
    if (!f.ok) expect(f.dof).toBe(8);
  });
});

describe("shell triangle", () => {
  const p1 = [0.3, -0.2, 0.1],
    p2 = [10.2, 1.1, -0.5],
    p3 = [3.1, 7.7, 2.2];
  const fr = shellFrame(p1, p2, p3);
  const el = shellLocalK(fr.xy, { E: 200000, nu: 0.3, z0: -2, z1: 0 });
  it("moves and turns freely as a rigid body", () => {
    const Kw = toWorld18(el.K, fr.R);
    const P = [p1, p2, p3];
    const modes: number[][] = [];
    for (let k = 0; k < 3; k++) {
      const q = new Array(18).fill(0);
      for (let a = 0; a < 3; a++) q[6 * a + k] = 1;
      modes.push(q);
    }
    for (let k = 0; k < 3; k++) {
      const w = [0, 0, 0];
      w[k] = 1;
      const q = new Array(18).fill(0);
      for (let a = 0; a < 3; a++) {
        const r = P[a];
        q[6 * a] = w[1] * r[2] - w[2] * r[1];
        q[6 * a + 1] = w[2] * r[0] - w[0] * r[2];
        q[6 * a + 2] = w[0] * r[1] - w[1] * r[0];
        q[6 * a + 3] = w[0];
        q[6 * a + 4] = w[1];
        q[6 * a + 5] = w[2];
      }
      modes.push(q);
    }
    let kmax = 0;
    for (let i = 0; i < 324; i++) kmax = Math.max(kmax, Math.abs(Kw[i]));
    for (const q of modes) {
      let f = 0;
      for (let i = 0; i < 18; i++) {
        let s = 0;
        for (let j = 0; j < 18; j++) s += Kw[i * 18 + j] * q[j];
        f = Math.max(f, Math.abs(s));
      }
      expect(f / kmax).toBeLessThan(1e-9);
    }
  });
  it("stretches and bends exactly as an even field asks (patch tests)", () => {
    const xy = fr.xy;
    const ql = new Float64Array(18);
    for (let a = 0; a < 3; a++) {
      const x = xy[2 * a],
        y = xy[2 * a + 1];
      ql[6 * a] = 0.001 * x + 0.002 * y;
      ql[6 * a + 1] = -0.0005 * x + 0.003 * y;
      ql[6 * a + 5] = 0.5 * (-0.0005 - 0.002);
      ql[6 * a + 2] = 0.005 * x * x - 0.01 * y * y + 0.004 * x * y;
      ql[6 * a + 3] = -0.02 * y + 0.004 * x;
      ql[6 * a + 4] = -(0.01 * x + 0.004 * y);
    }
    const out = new Float64Array(6);
    for (const L of [
      [1, 0, 0],
      [0.2, 0.3, 0.5],
      [0, 0, 1],
    ] as [number, number, number][]) {
      shellStrains(el, L, ql, out);
      expect(out[0]).toBeCloseTo(0.001, 9);
      expect(out[1]).toBeCloseTo(0.003, 9);
      expect(out[2]).toBeCloseTo(0.0015, 9);
      expect(out[3]).toBeCloseTo(-0.01, 9);
      expect(out[4]).toBeCloseTo(0.02, 9);
      expect(out[5]).toBeCloseTo(-0.008, 9);
    }
  });
});

describe("shells against textbook answers", { timeout: 60_000 }, () => {
  it("a cantilever strip bends as beam theory says", () => {
    const mat: MechMaterial = { ...STEEL, nu: 0 };
    const L = 200,
      b = 20,
      t = 2;
    const r = runStructural(
      base({
        parts: [part("strip", boxMesh([0, 0, 0], [L, b, t]), { kind: "wall" })],
        materials: [mat],
        supports: [{ region: { t: "face", part: "strip", dir: [-1, 0, 0] } }],
        loads: [{ t: "force", region: { t: "face", part: "strip", dir: [1, 0, 0] }, f: [0, 0, -10] }],
      }),
    );
    const I = (b * t ** 3) / 12;
    const exact = (10 * L ** 3) / (3 * mat.E * I);
    const tip = dispAt(r, [L, b / 2, t]);
    expect(rel(-tip[2], exact)).toBeLessThan(0.03);
    // the root's stress: M c / I
    const sRoot = (10 * L * (t / 2)) / I;
    expect(rel(r.maxStress.value, sRoot)).toBeLessThan(0.08);
    expect(r.equilibrium).toBeLessThan(1e-6);
  });
  it("a simply supported square plate under pressure deflects as Timoshenko's table says", () => {
    const a = 200,
      t = 2,
      q = 0.01;
    const r = runStructural(
      base({
        parts: [part("plate", boxMesh([0, 0, 0], [a, a, t]), { kind: "wall" })],
        supports: [
          { region: { t: "face", part: "plate", dir: [-1, 0, 0] }, dir: [0, 0, 1] },
          { region: { t: "face", part: "plate", dir: [1, 0, 0] }, dir: [0, 0, 1] },
          { region: { t: "face", part: "plate", dir: [0, -1, 0] }, dir: [0, 0, 1] },
          { region: { t: "face", part: "plate", dir: [0, 1, 0] }, dir: [0, 0, 1] },
          { region: { t: "sphere", at: [a / 2, a / 2, t], r: 1 }, dir: [1, 0, 0] },
          { region: { t: "sphere", at: [a / 2, a / 2, t], r: 1 }, dir: [0, 1, 0] },
          { region: { t: "sphere", at: [a / 2 + 40, a / 2, t], r: 1 }, dir: [0, 1, 0] },
        ],
        loads: [{ t: "pressure", region: { t: "face", part: "plate", dir: [0, 0, 1] }, p: q }],
      }),
    );
    const D = (STEEL.E * t ** 3) / (12 * (1 - STEEL.nu ** 2));
    const exact = (0.00406 * q * a ** 4) / D;
    expect(rel(r.maxDisp.value, exact)).toBeLessThan(0.03);
  });
  it("a simply supported square plate pushed on two edges buckles at k = 4", () => {
    const a = 200,
      t = 2,
      F = 1000;
    const AL: MechMaterial = { ...STEEL, name: "plate", E: 70000, nu: 0.3 };
    const r = runStructural(
      base({
        parts: [part("plate", boxMesh([0, 0, 0], [a, a, t]), { kind: "sheet", t })],
        materials: [AL],
        supports: [
          { region: { t: "face", part: "plate", dir: [-1, 0, 0] }, dir: [0, 0, 1] },
          { region: { t: "face", part: "plate", dir: [1, 0, 0] }, dir: [0, 0, 1] },
          { region: { t: "face", part: "plate", dir: [0, -1, 0] }, dir: [0, 0, 1] },
          { region: { t: "face", part: "plate", dir: [0, 1, 0] }, dir: [0, 0, 1] },
          { region: { t: "sphere", at: [a / 2, a / 2, t], r: 1 }, dir: [1, 0, 0] },
          { region: { t: "sphere", at: [a / 2, a / 2, t], r: 1 }, dir: [0, 1, 0] },
          { region: { t: "sphere", at: [a / 2 + 40, a / 2, t], r: 1 }, dir: [0, 1, 0] },
        ],
        loads: [
          { t: "force", region: { t: "face", part: "plate", dir: [1, 0, 0] }, f: [-F, 0, 0] },
          { t: "force", region: { t: "face", part: "plate", dir: [-1, 0, 0] }, f: [F, 0, 0] },
        ],
        buckling: { modes: 1 },
      }),
    );
    // N_cr = k π² D / b², k = 4 for a square plate, over the 200 mm edge
    const D = (AL.E * t ** 3) / (12 * (1 - AL.nu ** 2));
    const exact = (4 * Math.PI ** 2 * D) / a ** 2 * a / F;
    expect(rel(r.buckling!.factors[0], exact)).toBeLessThan(0.03);
    // one half-wave each way: the middle moves most
    expect(Math.hypot(r.buckling!.peaks[0][0] - a / 2, r.buckling!.peaks[0][1] - a / 2)).toBeLessThan(0.15 * a);
  });
  it("a thin carbon tube made as its outer surface bends as a tube of that wall", () => {
    const CF = mechMaterial("Carbon fiber");
    const R = 20,
      L = 400,
      t = 1;
    const r = runStructural(
      base({
        parts: [part("tube", rodMesh(R, L, 64), { kind: "laminate", t })],
        materials: [CF],
        supports: [{ region: { t: "face", part: "tube", dir: [0, 0, -1] } }],
        loads: [{ t: "force", region: { t: "face", part: "tube", dir: [0, 0, 1] }, f: [100, 0, 0] }],
      }),
    );
    const I = (Math.PI / 4) * (R ** 4 - (R - t) ** 4);
    const G = CF.E / (2 * (1 + CF.nu));
    const exact = (100 * L ** 3) / (3 * CF.E * I) + (100 * L) / (0.5 * G * 2 * Math.PI * (R - t / 2) * t);
    const tip = dispAt(r, [0, 0, L]);
    expect(rel(tip[0], exact)).toBeLessThan(0.04);
    // its weight is the laminate's, not a solid rod's
    const lam = CF.density * 1e-3 * (2 * Math.PI * (R - t / 2) * t * L + 2 * Math.PI * R * R * t);
    expect(rel(r.mass, lam)).toBeLessThan(0.05);
  });
  it("the Scordelis–Lo roof sags as the benchmark says", () => {
    // R 25, L 50, 40° each side, t 0.25, E 4.32e8, ν 0, its own weight 90 per area, held by end diaphragms
    const R = 25,
      L = 50,
      t = 0.25;
    const q = 90;
    const mat: MechMaterial = { ...STEEL, name: "roof", E: 4.32e8, nu: 0, density: q / (t * 1e-6 * 9.80665) };
    const r = runStructural(
      base({
        parts: [part("roof", roofMesh(R, L, (40 * Math.PI) / 180, t, 32, 8), { kind: "wall" })],
        materials: [mat],
        supports: [
          { region: { t: "face", part: "roof", dir: [-1, 0, 0] }, dir: [0, 1, 0] },
          { region: { t: "face", part: "roof", dir: [-1, 0, 0] }, dir: [0, 0, 1] },
          { region: { t: "face", part: "roof", dir: [1, 0, 0] }, dir: [0, 1, 0] },
          { region: { t: "face", part: "roof", dir: [1, 0, 0] }, dir: [0, 0, 1] },
          { region: { t: "sphere", at: [L / 2, 0, R + t / 2], r: 0.6 }, dir: [1, 0, 0] },
        ],
        loads: [],
        accel: [0, 0, -1],
      }),
    );
    const s = Math.sin((40 * Math.PI) / 180),
      c = Math.cos((40 * Math.PI) / 180);
    const edge = dispAt(r, [L / 2, (R + t / 2) * s, (R + t / 2) * c]);
    expect(rel(edge[2], -0.3024)).toBeLessThan(0.04);
  });
});

describe("thin walls in an analysis block", { timeout: 120_000 }, () => {
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
    if (!prep?.input) throw new Error(prep?.error ?? "no input");
    return { spec, input: prep.input };
  }
  const TUBE = `part tube {
  material: "Carbon fiber"
  process: mfg.carbon_layup(pull: Y, wall: 1.2)
  body cylinder(d: 40, h: 400)
}
`;

  it("analyses a carbon layup on its own as its laminate", () => {
    const { spec, input } = prepare(`design "t"
${TUBE}analysis "Bend" {
  parts: [tube]
  fix: face(tube, -Z)
  load: force(face(tube, +Z), (100, 0, 0))
}
`);
    expect(input.elements).toBe("shells");
    expect(input.elementsAuto).toBe(true);
    const r = runStructural(input);
    const w = r.shells!.parts[0];
    expect(w.kind).toBe("laminate");
    expect(w.t).toBeCloseTo(1.2, 6);
    // a cantilever tube of that wall under its outer surface: bending plus shear (half the wall's area carries it)
    const E = 50000,
      G = E / 2.6,
      R = 20,
      t = 1.2,
      L = 400;
    const I = (Math.PI / 4) * (R ** 4 - (R - t) ** 4);
    const A = Math.PI * (R ** 2 - (R - t) ** 2);
    const exact = (100 * L ** 3) / (3 * E * I) + (100 * L) / (G * (A / 2));
    expect(rel(r.maxDisp.value, exact)).toBeLessThan(0.03);
    // the laminate's own mass: its area (tube and ends) times the wall
    expect(rel(r.mass, ((w.area * t) / 1000) * 1.55)).toBeLessThan(0.02);
    const text = structuralSummary(spec, { status: "done", result: r, resolution: "standard" });
    expect(text).toMatch(/tube as a 1\.2 mm laminate under its outer surface/);
    expect(text).toMatch(/Walls: tube \(1\.2 mm laminate/);
  });

  it("analyses a sheet() bracket as its sheet", () => {
    const { input } = prepare(`design "b"
part bracket {
  material: "Aluminum 5052"
  body sheet(rect(60, 40), t: 1.5, flanges: [flange("left", 15)])
}
analysis "Push" {
  parts: [bracket]
  fix: face(bracket, -X)
  load: force(face(bracket, +X), (0, 0, -10))
}
`);
    expect(input.elements).toBe("shells");
    const r = runStructural(input);
    const w = r.shells!.parts[0];
    expect(w.kind).toBe("sheet");
    expect(w.t).toBeCloseTo(1.5, 6);
    // the base bends as a cantilever plate from the bend: about 58 mm long, 40 wide, 1.5 thick
    const I = (40 * 1.5 ** 3) / 12;
    const beam = (10 * 58 ** 3) / (3 * 70300 * I);
    expect(r.maxDisp.value).toBeGreaterThan(0.9 * beam);
    expect(r.maxDisp.value).toBeLessThan(1.25 * beam);
    // the bend carries the whole moment
    const sigma = (6 * 10 * 58) / (40 * 1.5 ** 2);
    expect(rel(w.stress, sigma)).toBeLessThan(0.15);
  });

  it("solves a layup with other parts as solid, and says so", () => {
    const { input } = prepare(`design "t"
${TUBE}part plate {
  material: "Steel"
  body box(60, 60, 5, at: (0, 0, -5), center: false)
}
analysis "Bend" {
  parts: [tube, plate]
  fix: face(plate, -Z)
  load: force(face(tube, +Z), (100, 0, 0))
}
`);
    expect(input.elements).toBeUndefined();
    expect(input.inputWarnings?.[0]).toMatch(/tube is a carbon layup, solved here as if solid carbon.*analyse it on its own/);
  });

  it("refuses shells with what they cannot follow, and takes shell or shells", () => {
    const errs = (extra: string) =>
      evaluate(`design "t"
${TUBE}analysis "a" {
  parts: [tube]
  fix: face(tube, -Z)
  load: force(face(tube, +Z), (100, 0, 0))
${extra}}
`)
        .diagnostics.filter((d) => d.severity === "error")
        .map((d) => d.message)
        .join(" ");
    expect(errs('  elements: "shells"\n  modes: 3\n')).toMatch(/elements: "shells" cannot follow natural frequencies yet/);
    expect(errs('  elements: "shell"\n')).toBe("");
    expect(errs('  elements: "plates"\n')).toMatch(/"shells" \(thin walls as their surface/);
  });

  it("falls back to solids for a part that is not one wall, unless shells were asked for", () => {
    const block = (auto: boolean) =>
      base({
        parts: [part("block", boxMesh([0, 0, 0], [20, 20, 20]), { kind: "wall" })],
        supports: [{ region: { t: "face", part: "block", dir: [0, 0, -1] } }],
        loads: [{ t: "force", region: { t: "face", part: "block", dir: [0, 0, 1] }, f: [0, 0, -100] }],
        target: 2000,
        ...(auto ? { elementsAuto: true } : {}),
      });
    expect(() => runStructural(block(false))).toThrow(/block .*Use elements: "solid"/);
    const r = runStructural(block(true));
    expect(r.shells).toBeUndefined();
    expect(r.warnings[0]).toMatch(/so it was solved with solid elements/);
  });
});
