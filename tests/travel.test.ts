// Cables that move with the machine: the design is posed from its own show_x,
// show_y and show_z, the cables to whatever moves ride drag chains or a service
// loop sized for full travel, and those links keep their length, bend no
// tighter than their wires allow and clear every part at every pose.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "../src/lang/evaluator";
import { machinePose } from "../src/machine/pose";
import { buildHarness } from "../src/machine/harness/harness";
import { flexLengths, flexPath, planTravel, travelOffsets, type FlexLink, type PartBox } from "../src/machine/harness/travel";
import { xformMatrix, type V3 } from "../src/kernel/recipe";
import { recipeBounds } from "../src/analysis/fits/geometry";

const SRC = readFileSync(join(__dirname, "../src/demos/printer.kerf"), "utf8");
const model = evaluate(SRC);
const pose = machinePose(SRC, model);

/** Each part's box in the assembly from its recipe (the app uses its meshes). */
const boxes: PartBox[] = model.parts.flatMap((p) => {
  const b = recipeBounds(p.recipe);
  if (!b) return [];
  const m = xformMatrix(p.xf);
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c++) {
    const q = [c & 1 ? b[1][0] : b[0][0], c & 2 ? b[1][1] : b[0][1], c & 4 ? b[1][2] : b[0][2]];
    for (let k = 0; k < 3; k++) {
      const v = m[k] * q[0] + m[4 + k] * q[1] + m[8 + k] * q[2] + m[12 + k];
      lo[k] = Math.min(lo[k], v);
      hi[k] = Math.max(hi[k], v);
    }
  }
  return [{ id: p.id, lo, hi, removable: !!p.removable, made: p.kind !== "component" }];
});
const harness = buildHarness(model);
const plan = planTravel(pose, boxes, harness)!;

const moves = (id: string) => pose.moves.get(id)?.map((v) => v.map((x) => Math.round(x * 1000) / 1000 || 0));

describe("posing the printer", () => {
  it("finds what each axis moves, including carriages and belts drawn at the pose", () => {
    expect(pose.axes).toEqual([true, true, true]);
    expect(pose.range).toEqual([
      [0, 220],
      [0, 220],
      [0, 250],
    ]);
    // the carriage plate is drawn at the nozzle's X and the gantry's Z
    expect(moves("x_carriage")).toEqual([
      [1, 0, 0],
      [0, 0, 0],
      [0, 0, 1],
    ]);
    // the bed moves the other way: the nozzle's Y on the bed grows as the bed comes forward
    expect(moves("bed_carriage")?.[1]).toEqual([0, -1, 0]);
    // the X belt rides up and down with the gantry; the Y belt stays on the frame
    expect(moves("belt_x")).toEqual([
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 1],
    ]);
    expect(moves("belt_y")).toBeUndefined();
    expect(moves("base_mid")).toBeUndefined();
  });
});

describe("cables through full travel", () => {
  it("puts the toolhead and bed cables in drag chains and the gantry's in a service loop", () => {
    expect(plan.carriers.map((c) => c.label).sort()).toEqual(["bed", "gantry", "toolhead"]);
    expect(plan.links.map((l) => `${l.id} ${l.kind}`).sort()).toEqual(["X chain", "Y chain", "Z loop"]);
    const link = (id: string) => plan.links.find((l) => l.id === id)!;
    // the hotend, its fans and the probe ride the X chain; the bed heater and thermistor the Y chain
    expect(link("X").wires.length).toBeGreaterThanOrEqual(4);
    expect(link("Y").wires.length).toBeGreaterThanOrEqual(2);
    // everything on the toolhead goes through the gantry's loop first
    for (const w of link("X").wires) expect(link("Z").wires).toContain(w);
  });

  it("passes length, bend and snag checks at every pose", () => {
    expect(plan.checks).toHaveLength(3);
    for (const c of plan.checks) expect(c.status, `${c.title}: ${c.detail}`).toBe("pass");
    for (const l of plan.links) {
      expect(l.R).toBeGreaterThanOrEqual(l.minR - 1e-6);
      if (l.chain) expect(l.chain.aMax - l.chain.aMin).toBeGreaterThanOrEqual(219);
    }
  });

  it("keeps each link's length as the machine moves", () => {
    for (const l of plan.links) {
      for (const f of [0, 0.25, 0.5, 0.75, 1]) {
        const at = pose.range.map(([a, b]) => a + (b - a) * f) as V3;
        const { pts, tight } = flexPath(l, moved(l, at), 1);
        let len = 0;
        for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
        expect(tight).toBe(false);
        expect(Math.abs(len - l.L) / l.L, `${l.id} at ${at}`).toBeLessThan(0.02);
      }
    }
  });

  it("counts the links in each moving cable's cut length", () => {
    const lens = flexLengths(plan);
    const x = plan.links.find((l) => l.id === "X")!;
    const z = plan.links.find((l) => l.id === "Z")!;
    expect(lens.get(x.wires[0])).toBeCloseTo(x.L + z.L, 6);
  });

  it("moves each carrier's parts with its axes", () => {
    const off = travelOffsets(plan, [220, 0, 250]);
    const [x, y, z] = [pose.s0[0], pose.s0[1], pose.s0[2]];
    const near = (a: V3 | undefined, b: V3) => a!.forEach((v, k) => expect(v).toBeCloseTo(b[k], 6));
    near(off.get("x_carriage"), [220 - x, 0, 250 - z]);
    near(off.get("bed_carriage"), [0, y, 0]);
    expect(off.get("base_mid")).toBeUndefined();
  });
});

/** The moving end where the child is at axis values `at`, in the parent's frame where the design shows it. */
function moved(l: FlexLink, at: V3): V3 {
  const G: V3 = [...l.G0];
  for (let k = 0; k < 3; k++) {
    const d = at[k] - pose.s0[k];
    for (let j = 0; j < 3; j++) G[j] += l.rel[k][j] * d;
  }
  return G;
}
