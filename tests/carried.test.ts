import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { fitRigid, followers, type RigidMotion } from "../src/analysis/carried";
import type { StructuralResult } from "../src/analysis/fe/structural";
import type { V3 } from "../src/kernel/recipe";

const moved = (r: RigidMotion, x: V3): V3 => {
  const p = [x[0] - r.c[0], x[1] - r.c[1], x[2] - r.c[2]];
  return [r.t[0] + r.w[1] * p[2] - r.w[2] * p[1], r.t[1] + r.w[2] * p[0] - r.w[0] * p[2], r.t[2] + r.w[0] * p[1] - r.w[1] * p[0]];
};

describe("a rigid motion fitted to how points move", () => {
  it("finds the shift and turn that moved them", () => {
    const pts: number[] = [];
    for (let i = 0; i < 40; i++) pts.push(Math.sin(i * 1.3) * 20, Math.cos(i * 0.7) * 15, i * 0.9 - 10);
    const truth: RigidMotion = { c: [3, -2, 5], t: [0.01, -0.02, 0.005], w: [1e-3, -2e-3, 5e-4] };
    const U = new Float32Array(pts.length);
    for (let v = 0; v < pts.length / 3; v++) U.set(moved(truth, [pts[3 * v], pts[3 * v + 1], pts[3 * v + 2]]), 3 * v);
    const fit = fitRigid(pts, U, Array.from({ length: pts.length / 3 }, (_, i) => i));
    for (const k of [0, 1, 2]) expect(fit.w[k]).toBeCloseTo(truth.w[k], 4);
    for (const x of [[0, 0, 0], [50, 10, -20]] as V3[]) {
      const a = moved(fit, x);
      const b = moved(truth, x);
      for (const k of [0, 1, 2]) expect(a[k]).toBeCloseTo(b[k], 4);
    }
  });
});

describe("parts carried on an analysed part", () => {
  const src = `design "t"
part arm { body box(20, 4, 40) }
part sign { body box(10, 0.5, 8, at: (0, 2.25, 30)) }
part print { body box(6, 0.2, 4, at: (0, 2.6, 32)) }
part wall { process: false  body box(60, 10, 4, at: (0, -5, -4)) }
`;
  const boxes: Record<string, [V3, V3]> = {
    arm: [[-10, -2, 0], [10, 2, 40]],
    sign: [[-5, 2, 30], [5, 2.5, 38]],
    print: [[-3, 2.5, 32], [3, 2.7, 36]],
    wall: [[-30, -10, -4], [30, 0, 0]],
  };
  // the arm leans over about its root: a point z up it moves -1e-3·z along y, and in its one mode it swings about y
  const pos: number[] = [];
  for (let x = -10; x <= 10; x += 5) for (const y of [-2, 2]) for (let z = 0; z <= 40; z += 2) pos.push(x, y, z);
  const n = pos.length / 3;
  const disp = new Float32Array(3 * n);
  const mode = new Float32Array(3 * n);
  for (let v = 0; v < n; v++) {
    disp[3 * v + 1] = -1e-3 * pos[3 * v + 2];
    mode[3 * v] = pos[3 * v + 2] / 40;
    mode[3 * v + 2] = -pos[3 * v] / 40;
  }

  it("moves what rides on it with the bit it sits on, and what rides on that the same way; not what it stands on", () => {
    const model = evaluate(src);
    const arm = model.parts.find((p) => p.name === "arm")!;
    const result = { parts: [{ id: arm.id, name: "arm", positions: new Float32Array(pos), disp, modes: [mode] }] } as unknown as StructuralResult;
    const f = followers(model, result, (p) => boxes[p.name]);
    const name = (id: string) => model.parts.find((p) => p.id === id)!.name;
    expect(f.map((x) => name(x.id))).toEqual(["sign", "print"]);
    for (const x of f) expect(x.host).toBe(arm.id);
    const sign = f[0];
    // turned about x as the arm is, so its top end moves the way the arm's does there
    expect(sign.disp.w[0]).toBeCloseTo(1e-3, 5);
    expect(moved(sign.disp, [0, 2.25, 38])[1]).toBeCloseTo(-0.038, 3);
    expect(sign.modes).toHaveLength(1);
    expect(moved(sign.modes[0], [0, 2.25, 38])[0]).toBeCloseTo(38 / 40, 2);
    expect(f[1].disp).toEqual(sign.disp);
  });
});
