import { describe, expect, it } from "vitest";
import { runStructural, type FeaPart, type StructuralInput, type StructuralResult } from "../src/analysis/fe/structural";
import type { TriMesh, V3 } from "../src/analysis/fe/voxel";
import { mechMaterial } from "../src/analysis/materials";
import { largeText, structuralSummary } from "../src/analysis/summary";
import type { StructuralSpec } from "../src/analysis/spec";
import { evaluate } from "../src/lang/evaluator";

/** Closed box surface with its faces split into a grid, so results can be read at points along it. */
function gridBox(lo: V3, hi: V3, div: V3): TriMesh {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let a = 0; a < 3; a++)
    for (const side of [0, 1]) {
      const u = (a + 1) % 3,
        v = (a + 2) % 3;
      const nu = div[u],
        nv = div[v];
      const base = pos.length / 3;
      for (let j = 0; j <= nv; j++)
        for (let i = 0; i <= nu; i++) {
          const p = [0, 0, 0];
          p[a] = side ? hi[a] : lo[a];
          p[u] = lo[u] + ((hi[u] - lo[u]) * i) / nu;
          p[v] = lo[v] + ((hi[v] - lo[v]) * j) / nv;
          pos.push(...p);
        }
      for (let j = 0; j < nv; j++)
        for (let i = 0; i < nu; i++) {
          const q = base + i + (nu + 1) * j;
          if (side) idx.push(q, q + 1, q + nu + 2, q, q + nu + 2, q + nu + 1);
          else idx.push(q, q + nu + 2, q + 1, q, q + nu + 1, q + nu + 2);
        }
    }
  return { positions: new Float64Array(pos), indices: new Uint32Array(idx) };
}

const part = (name: string, lo: V3, hi: V3): FeaPart => ({ id: name, name, mesh: gridBox(lo, hi, [20, 4, 4]), material: 0 });

/** The displacement of the mesh vertex nearest p. */
function dispAt(r: StructuralResult, p: V3): V3 {
  const f = r.parts[0];
  let best = -1,
    bd = Infinity;
  for (let v = 0; v < f.positions.length / 3; v++) {
    const d = Math.hypot(f.positions[3 * v] - p[0], f.positions[3 * v + 1] - p[1], f.positions[3 * v + 2] - p[2]);
    if (d < bd) {
      bd = d;
      best = v;
    }
  }
  return [f.disp[3 * best], f.disp[3 * best + 1], f.disp[3 * best + 2]];
}

const common = { target: 8000, printed: false, buildDir: [0, 0, 1] as V3, safety: 2 };

// A 100 × 10 × 2 mm steel strip held at one end, with an end load P = EI/L² that stays pointing down: the exact
// (elastica) tip deflection is 0.3017 L down and 0.0564 L in; beam theory, which assumes it hardly moves, says L/3 down.
const L = 100;
const EI = (200000 * 10 * 2 ** 3) / 12;
const strip = (large: boolean | undefined): StructuralInput => ({
  label: "strip",
  parts: [part("strip", [0, 0, 0], [L, 10, 2])],
  materials: [mechMaterial("Steel")],
  supports: [{ region: { t: "face", part: "strip", dir: [-1, 0, 0] } }],
  loads: [{ t: "force", region: { t: "face", part: "strip", dir: [1, 0, 0] }, f: [0, 0, -EI / L ** 2] }],
  ...common,
  ...(large !== undefined ? { large } : {}),
});

describe("large deflection", { timeout: 240_000 }, () => {
  const lin = runStructural(strip(false));
  const big = runStructural(strip(undefined));

  it("matches the exact answer for a strip bent far by an end load", () => {
    expect(lin.large).toBeUndefined();
    const [lu, , lv] = dispAt(lin, [L, 5, 1]);
    expect(-lv / L).toBeGreaterThan(0.32); // the straight-line answer overshoots
    expect(Math.abs(lu)).toBeLessThan(0.5);
    expect(lin.warnings.join(" ")).toMatch(/deflects a lot.*large_deflection: true solves it/);

    expect(big.large).toMatchObject({ auto: true, converged: true });
    expect(big.large!.linearTurn).toBeGreaterThan(10);
    const [u, , v] = dispAt(big, [L, 5, 1]);
    expect(-v / L).toBeCloseTo(0.3017, 1);
    expect(Math.abs(-v / L - 0.3017) / 0.3017).toBeLessThan(0.02);
    expect(Math.abs(-u / L - 0.0564) / 0.0564).toBeLessThan(0.03);
    // the tip turns about 26° (exact 0.4605 rad)
    expect(big.large!.turn).toBeGreaterThan(23);
    expect(big.large!.turn).toBeLessThan(30);
    expect(big.warnings.join(" ")).not.toMatch(/deflects a lot/);
    // the support still carries the load
    const R = big.supports[0].reaction;
    expect(R[2]).toBeCloseTo(EI / L ** 2, 0);
    expect(Math.abs(R[0])).toBeLessThan(1);
  });

  it("says what it did in the summary", () => {
    const t = largeText(big)!;
    expect(t).toMatch(/solved with the parts turning as they bend \(up to \d+(\.\d)?°\), switched on because the small-deflection answer turned parts \d+°/);
    expect(largeText(lin)).toBeNull();
    const spec: StructuralSpec = {
      kind: "structural",
      label: "Strip",
      parts: ["strip"],
      supports: strip(undefined).supports,
      loads: strip(undefined).loads,
      safety: 2,
      buildDir: [0, 0, 1],
      resolution: "draft",
      span: { start: 0, end: 0 },
    };
    const text = structuralSummary(spec, { status: "done", result: big, resolution: "draft" });
    expect(text).toMatch(/\nLarge deflection: solved with the parts turning/);
  });

  it("stiffens a strap held at both ends as it stretches", () => {
    // 60 × 10 × 1 mm steel strap, both ends held, 300 N in the middle: it sags far enough that it pulls on its ends
    // like a rope, carrying the load in tension as well as bending, so it sags much less than the bending-only answer.
    const strap = (large: boolean | undefined): StructuralInput => ({
      label: "strap",
      parts: [part("s", [0, 0, 0], [60, 10, 1])],
      materials: [mechMaterial("Steel")],
      supports: [{ region: { t: "face", part: "s", dir: [-1, 0, 0] } }, { region: { t: "face", part: "s", dir: [1, 0, 0] } }],
      loads: [{ t: "force", region: { t: "box", at: [30, 5, 1], size: [2, 12, 1] }, f: [0, 0, -300] }],
      ...common,
      ...(large !== undefined ? { large } : {}),
    });
    const a = runStructural(strap(false));
    const b = runStructural(strap(undefined));
    expect(b.large).toMatchObject({ auto: true, converged: true });
    // switched on by the stiffening, not by how far it turns
    expect(b.large!.linearTurn).toBeLessThan(10);
    expect(largeText(b)).toMatch(/was off by more than 3 %/);
    expect(b.maxDisp.value).toBeLessThan(0.7 * a.maxDisp.value);
    const [r0, r1] = b.supports.map((s) => s.reaction);
    // the supports pull the ends outward (the strap is in tension), equal and opposite, many times the load; the
    // linear answer has none
    expect(r0[0]).toBeLessThan(-600);
    expect(r1[0]).toBeGreaterThan(600);
    expect(Math.abs(r0[0] + r1[0])).toBeLessThan(0.02 * r1[0]);
    expect(r0[2] + r1[2]).toBeCloseTo(300, 0);
    expect(Math.abs(a.supports[0].reaction[0])).toBeLessThan(0.1 * r1[0]);
  });

  it("follows a snap arm pushed far by a set distance", () => {
    // a 20 × 6 × 1.6 mm PETG arm pushed 6 mm sideways by a straight edge on its tip's top edge, free to slide along it
    // (one row of nodes, so the push does not stop the tip turning)
    const snap = (large: boolean | undefined): StructuralInput => ({
      label: "snap",
      parts: [part("a", [0, 0, 0], [20, 6, 1.6])],
      materials: [mechMaterial("PETG")],
      supports: [{ region: { t: "face", part: "a", dir: [-1, 0, 0] } }, { region: { t: "box", at: [20, 3, 1.75], size: [0.1, 8, 0.1] }, dir: [0, 0, 1], move: [0, 0, 6] }],
      loads: [],
      ...common,
      ...(large !== undefined ? { large } : {}),
    });
    const a = runStructural(snap(false));
    const b = runStructural(snap(undefined));
    expect(b.large).toMatchObject({ auto: true, converged: true });
    // the tip swings round, so it comes back along the arm (about 0.19 of the push for a tip load)
    const [u, , w] = dispAt(b, [20, 3, 0.8]);
    expect(Math.abs(w - 6)).toBeLessThan(0.2);
    expect(u).toBeLessThan(-0.7);
    expect(u).toBeGreaterThan(-1.6);
    expect(Math.abs(dispAt(a, [20, 3, 0.8])[0])).toBeLessThan(0.3);
    // pushing it that far takes more force than the straight-line answer says (about 10 % more for a 30 % push)
    const fa = a.supports[1].reaction[2],
      fb = b.supports[1].reaction[2];
    expect(b.supports[1].nodes).toBeLessThan(30);
    expect(fb / fa).toBeGreaterThan(1.05);
    expect(fb / fa).toBeLessThan(1.22);
  });

  it("stays linear for small loads and when switched off", () => {
    const small = runStructural({ ...strip(undefined), loads: [{ t: "force", region: { t: "face", part: "strip", dir: [1, 0, 0] }, f: [0, 0, -1] }] });
    expect(small.large).toBeUndefined();
    const forced = runStructural({ ...strip(true), loads: [{ t: "force", region: { t: "face", part: "strip", dir: [1, 0, 0] }, f: [0, 0, -1] }] });
    expect(forced.large).toMatchObject({ auto: false, converged: true });
    // a tiny load moves the same either way
    expect(Math.abs(forced.maxDisp.value - small.maxDisp.value) / small.maxDisp.value).toBeLessThan(0.01);
  });

  it("keeps the linear answer, with a note, where it cannot follow yet", () => {
    const r = runStructural({ ...strip(undefined), buckling: { modes: 1 } });
    expect(r.large).toBeUndefined();
    expect(r.warnings.join(" ")).toMatch(/Parts turn up to \d+° under the loads.*with buckling Kerf cannot solve it for large deflection yet/);
  });
});

describe("large_deflection in an analysis block", () => {
  const design = `design "s"
part arm {
  material: "PETG"
  body box(20, 6, 1.6)
}
part base { body box(10, 10, 10, at: (-5, 0, 0)) }
`;
  const errors = (src: string) => evaluate(src).diagnostics.filter((d) => d.severity === "error").map((d) => d.message);

  it("is a flag or a true/false property", () => {
    const on = evaluate(design + `analysis "a" {\n  parts: [arm]\n  fix: face(arm, -X)\n  load: force(face(arm, +X), (0, 0, 5))\n  large_deflection\n}`);
    expect(on.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect((on.analyses[0] as StructuralSpec).large).toBe(true);
    const off = evaluate(design + `analysis "a" {\n  parts: [arm]\n  fix: face(arm, -X)\n  load: force(face(arm, +X), (0, 0, 5))\n  large_deflection: false\n}`);
    expect((off.analyses[0] as StructuralSpec).large).toBe(false);
    const unset = evaluate(design + `analysis "a" {\n  parts: [arm]\n  fix: face(arm, -X)\n  load: force(face(arm, +X), (0, 0, 5))\n}`);
    expect((unset.analyses[0] as StructuralSpec).large).toBeUndefined();
  });

  it("refuses what it cannot follow yet", () => {
    expect(errors(design + `analysis "a" {\n  parts: [arm, base]\n  fix: face(base, -X)\n  load: force(face(arm, +X), (0, 0, 5))\n  touching: [arm, base]\n  large_deflection\n}`)[0]).toMatch(
      /large_deflection solves the parts bending and turning far .* which touching parts cannot follow yet/,
    );
    expect(errors(design + `analysis "a" {\n  parts: [arm]\n  fix: face(arm, -X)\n  load: force(face(arm, +X), (0, 0, 5))\n  cycles: 1e6\n  large_deflection\n}`).join(" ")).toMatch(/which fatigue cannot follow yet/);
  });
});
