// Mechanism physics: rigid bodies on joints, gears, screws, cams, clutches,
// springs, wheels on a floor, catalog motors driving them, and the design
// language's sim.mechanism(...) resolved against built parts.

import { describe, expect, it } from "vitest";
import { MechSystem } from "../src/sim/mech/system";
import { FRAME, type MechBody, type MechModel } from "../src/sim/mech/model";
import { MechWorld } from "../src/sim/worlds/mechanism";
import { runMechanism } from "../src/sim/mech/runMech";
import { resolveMechanism } from "../src/sim/mech/resolve";
import { evaluate } from "../src/lang/evaluator";
import type { M3, V3 } from "../src/sim/mech/solver";
import type { MeshEntry } from "../src/core/engine";
import { emptyMachine, type MachineData } from "../src/machine/types";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runSpec } from "../src/sim/build";
import { outcomesFor } from "../src/sim/runtime";

const G = 9.80665;

function diag(a: number, b = a, c = a): M3 {
  return [a, 0, 0, 0, b, 0, 0, 0, c];
}

function body(id: string, mass: number, com: V3, I: M3 = diag(1e-6)): MechBody {
  return { id, label: id, parts: [], mass, com, inertia: I, points: [], boxes: [] };
}

function mech(m: Partial<MechModel>): MechModel {
  return { bodies: [], joints: [], drives: [], links: [], springs: [], loads: [], wheels: [], tracks: [], loose: [], ground: null, base: "fixed", gravity: [0, 0, -G], mounts: {}, power: {}, notes: [], ...m };
}

function run(sys: MechSystem, seconds: number, dt = 1e-3, each?: (t: number) => void) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    sys.step(dt);
    each?.(sys.solver.t);
  }
}

describe("rigid bodies and joints", () => {
  it("a pendulum keeps its energy and swings at the right period", () => {
    const L = 0.5;
    const m = mech({ bodies: [body("bob", 1, [L, 0, 0])], joints: [{ kind: "pivot", name: "bob", body: "bob", on: FRAME, at: [0, 0, 0], axis: [0, 1, 0] }] });
    const sys = new MechSystem(m);
    const j = sys.joints.get("bob")!;
    const e0 = sys.solver.energy();
    // released level, it passes the bottom after a quarter of its (large-swing) period
    let tBottom = -1;
    run(sys, 3, 1e-3, (t) => {
      if (tBottom < 0 && j.coord > Math.PI / 2) tBottom = t;
    });
    expect(Math.abs(sys.solver.energy() - e0) / (m.bodies[0].mass * G * L)).toBeLessThan(0.01);
    // a quarter period of a pendulum released from 90°: 1.8541 √(L/g)
    expect(tBottom).toBeCloseTo(1.8541 * Math.sqrt(L / G), 2);
  });

  it("a spring and mass ring at their natural frequency", () => {
    const k = 2000;
    const mass = 0.5;
    const m = mech({ gravity: [0, 0, 0], bodies: [body("slide", mass, [0, 0, 0])], joints: [{ kind: "slider", name: "slide", body: "slide", on: FRAME, at: [0, 0, 0], axis: [1, 0, 0], spring: k, free: 0.01 }] });
    const sys = new MechSystem(m);
    const j = sys.joints.get("slide")!;
    const crossings: number[] = [];
    let prev = j.coord - 0.01;
    run(sys, 1, 5e-4, (t) => {
      const x = j.coord - 0.01;
      if (prev < 0 && x >= 0) crossings.push(t);
      prev = x;
    });
    const period = (crossings.at(-1)! - crossings[0]) / (crossings.length - 1);
    expect(period).toBeCloseTo(2 * Math.PI * Math.sqrt(mass / k), 3);
  });

  it("a four-bar linkage stays closed as its crank turns", () => {
    // ground link 0.1 m, crank 0.03, coupler 0.09, rocker 0.07, all in the XZ plane turning about Y
    const A: V3 = [0, 0, 0];
    const D: V3 = [0.1, 0, 0];
    const B: V3 = [0, 0, 0.03];
    // C from the two circles: |C - B| = 0.09, |C - D| = 0.07
    const solveC = (bx: number, bz: number): V3 => {
      // C on the circle about D of radius 0.07 at distance 0.09 from B (upper branch)
      const dx = D[0] - bx;
      const dz = D[2] - bz;
      const d = Math.hypot(dx, dz);
      const a = (0.09 ** 2 - 0.07 ** 2 + d * d) / (2 * d);
      const h = Math.sqrt(0.09 ** 2 - a * a);
      return [bx + (a * dx) / d - (h * dz) / d, 0, bz + (a * dz) / d + (h * dx) / d];
    };
    const C = solveC(B[0], B[2]);
    const mid = (p: V3, q: V3): V3 => [(p[0] + q[0]) / 2, 0, (p[2] + q[2]) / 2];
    const m = mech({
      gravity: [0, 0, 0],
      bodies: [body("crank", 0.05, mid(A, B)), body("coupler", 0.08, mid(B, C)), body("rocker", 0.06, mid(D, C))],
      joints: [
        { kind: "pivot", name: "crank", body: "crank", on: FRAME, at: A, axis: [0, 1, 0] },
        { kind: "pivot", name: "coupler", body: "coupler", on: "crank", at: B, axis: [0, 1, 0] },
        { kind: "pivot", name: "rocker", body: "rocker", on: FRAME, at: D, axis: [0, 1, 0] },
        { kind: "pivot", name: "close", body: "coupler", on: "rocker", at: C, axis: [0, 1, 0] },
      ],
      drives: [{ kind: "turn", name: "hand", joint: "crank", speed: [[0, 2 * Math.PI]], limit: 50 }],
    });
    const sys = new MechSystem(m);
    const crank = sys.joints.get("crank")!;
    const rocker = sys.joints.get("rocker")!;
    let worst = 0;
    run(sys, 1, 1e-3, () => {
      // where the crank pin is, the rocker must follow the closed-form position
      const th = crank.coord;
      const b: V3 = [0.03 * Math.sin(th), 0, 0.03 * Math.cos(th)];
      const c = solveC(b[0], b[2]);
      const want = Math.atan2(c[0] - D[0], c[2] - D[2]) - Math.atan2(C[0] - D[0], C[2] - D[2]);
      // rotation about +Y takes +Z towards +X
      worst = Math.max(worst, Math.abs(Math.atan2(Math.sin(rocker.coord - want), Math.cos(rocker.coord - want))));
    });
    expect(crank.coord).toBeGreaterThan(2 * Math.PI * 0.95);
    expect(worst).toBeLessThan(0.01);
  });
});

describe("gears, screws, chains, cams and clutches", () => {
  const gearPair = (backlash: number) =>
    mech({
      gravity: [0, 0, 0],
      bodies: [body("g1", 0.05, [0, 0, 0], diag(2e-5)), body("g2", 0.2, [0.06, 0, 0], diag(3e-4))],
      joints: [
        { kind: "pivot", name: "g1", body: "g1", on: FRAME, at: [0, 0, 0], axis: [0, 0, 1], frictionPerLoad: 0 },
        { kind: "pivot", name: "g2", body: "g2", on: FRAME, at: [0.06, 0, 0], axis: [0, 0, 1], friction: 0.01 },
      ],
      links: [{ kind: "gears", name: "mesh", a: "g1", b: "g2", ca: [0, 0, 0], cb: [0.06, 0, 0], ra: 0.02, backlash, efficiency: 0.98 }],
      drives: [{ kind: "turn", name: "in", joint: "g1", speed: [[0, 2 * Math.PI], [0.5, 2 * Math.PI], [0.51, -2 * Math.PI]], limit: 5 }],
    });

  it("spur gears turn at their tooth ratio, the other way", () => {
    const sys = new MechSystem(gearPair(0));
    run(sys, 0.4);
    const g1 = sys.joints.get("g1")!;
    const g2 = sys.joints.get("g2")!;
    // 20 mm and 40 mm pitch radii: half the speed, opposite sense
    expect(g2.speed / g1.speed).toBeCloseTo(-0.5, 2);
    expect(sys.meshes[0].force).toBeGreaterThan(0.01 / 0.04 * 0.9);
  });

  it("backlash shifts the output by the gap when the drive reverses", () => {
    const bl = 0.0005;
    const sys = new MechSystem(gearPair(bl));
    const g1 = sys.joints.get("g1")!;
    const g2 = sys.joints.get("g2")!;
    // driving forward the teeth bear on one flank, driving back on the other: the output lags by the gap
    run(sys, 0.5);
    const fwd = g2.coord + 0.5 * g1.coord;
    run(sys, 0.4);
    const back = g2.coord + 0.5 * g1.coord;
    expect(Math.abs(back - fwd)).toBeGreaterThan((bl / 0.04) * 0.8);
    expect(Math.abs(back - fwd)).toBeLessThan((bl / 0.04) * 1.2);
  });

  const screwLift = (lead: number, mu: number, d: number) => {
    // a vertical screw on the frame, a 5 kg nut on a vertical slider; nothing turns the screw
    const frictionArm = (mu / Math.cos((15 * Math.PI) / 180)) * 0.45 * d;
    return new MechSystem(
      mech({
        bodies: [body("screw", 0.1, [0, 0, 0.1], diag(1e-5, 1e-5, 2e-6)), body("nut", 5, [0, 0, 0.1], diag(1e-3))],
        joints: [
          { kind: "pivot", name: "screw", body: "screw", on: FRAME, at: [0, 0, 0], axis: [0, 0, 1] },
          { kind: "slider", name: "nut", body: "nut", on: FRAME, at: [0, 0, 0.1], axis: [0, 0, 1] },
        ],
        links: [{ kind: "thread", name: "thread", screw: "screw", follower: "nut", point: [0, 0, 0.1], k: -lead / (2 * Math.PI), backlash: 0, frictionArm, what: "lead screw" }],
      }),
    );
  };

  it("a fine lead screw holds its load without power", () => {
    // 2 mm lead on 8 mm with a plastic nut: lead angle 4.5°, friction angle 8.8°
    const sys = screwLift(0.002, 0.15, 0.008);
    run(sys, 1);
    expect(Math.abs(sys.joints.get("nut")!.coord)).toBeLessThan(2e-4);
  });

  it("a steep ball screw is driven back by its load", () => {
    const sys = screwLift(0.01, 0.005, 0.012);
    run(sys, 0.3);
    const nut = sys.joints.get("nut")!;
    expect(nut.coord).toBeLessThan(-0.01);
    // the screw spins to let it down: turns = travel / lead
    expect(Math.abs(sys.joints.get("screw")!.coord / (2 * Math.PI)) * 0.01).toBeCloseTo(Math.abs(nut.coord), 3);
  });

  it("a chain drive turns its sprockets at the tooth ratio and a slipping clutch limits the torque", () => {
    const m = mech({
      gravity: [0, 0, 0],
      bodies: [body("s1", 0.05, [0, 0, 0], diag(1e-5)), body("s2", 0.1, [0.2, 0, 0], diag(1e-4)), body("drum", 0.5, [0.2, 0.05, 0], diag(2e-3))],
      joints: [
        { kind: "pivot", name: "s1", body: "s1", on: FRAME, at: [0, 0, 0], axis: [0, 1, 0] },
        { kind: "pivot", name: "s2", body: "s2", on: FRAME, at: [0.2, 0, 0], axis: [0, 1, 0] },
        { kind: "pivot", name: "drum", body: "drum", on: FRAME, at: [0.2, 0.05, 0], axis: [0, 1, 0] },
      ],
      links: [
        { kind: "ratio", name: "chain", a: "s1", b: "s2", ratio: 15 / 45, slack: 0, efficiency: 0.98 },
        { kind: "clutch", name: "clutch", a: "s2", b: "drum", torque: 0.05, oneWay: false },
      ],
      drives: [{ kind: "turn", name: "in", joint: "s1", speed: [[0, 30]], limit: 10 }],
    });
    const sys = new MechSystem(m);
    run(sys, 0.5);
    expect(sys.joints.get("s2")!.speed).toBeCloseTo(10, 1);
    // the drum spins up through the slipping clutch at torque / inertia
    const cl = sys.clutches[0];
    expect(cl.slipTime).toBeGreaterThan(0.1);
    expect(sys.joints.get("drum")!.speed).toBeLessThan(10);
  });

  it("a spring-return cam follower leaves the cam when it turns too fast", () => {
    const lift = Array.from({ length: 72 }, (_, i) => 0.005 * (1 - Math.cos((2 * Math.PI * i) / 72)));
    const camRig = (rpm: number) =>
      new MechSystem(
        mech({
          gravity: [0, 0, 0],
          bodies: [body("cam", 0.2, [0, 0, 0], diag(1e-4)), body("follower", 0.2, [0, 0, 0.04])],
          joints: [
            { kind: "pivot", name: "cam", body: "cam", on: FRAME, at: [0, 0, 0], axis: [0, 1, 0] },
            { kind: "slider", name: "follower", body: "follower", on: FRAME, at: [0, 0, 0.04], axis: [0, 0, 1] },
          ],
          links: [{ kind: "cam", name: "cam", cam: "cam", follower: "follower", lift, phase: 0, grooved: false }],
          springs: [{ name: "return", a: FRAME, b: "follower", pa: [0, 0, 0.1], pb: [0, 0, 0.04], k: 500, c: 0, free: 0.07, push: 0 }],
          drives: [{ kind: "turn", name: "motor", joint: "cam", speed: [[0, (rpm * 2 * Math.PI) / 60]], limit: 20 }],
        }),
      );
    const slow = camRig(60);
    run(slow, 2);
    expect(slow.cams[0].maxGap).toBeLessThan(2e-4);
    const fast = camRig(1200);
    run(fast, 0.5);
    expect(fast.cams[0].maxGap).toBeGreaterThan(5e-4);
  });
});

describe("wheels and the floor", () => {
  const cart = (slope: number) => {
    const s = (slope * Math.PI) / 180;
    const wheels = [
      ["fl", 0.1, 0.08],
      ["fr", 0.1, -0.08],
      ["rl", -0.1, 0.08],
      ["rr", -0.1, -0.08],
    ] as const;
    return mech({
      base: "free",
      gravity: [-G * Math.sin(s), 0, -G * Math.cos(s)],
      bodies: [{ ...body(FRAME, 2, [0, 0, 0.05], diag(0.01)), points: [] }, ...wheels.map(([id, x, y]) => body(id, 0.05, [x, y, 0.03], diag(2e-5, 4e-5, 2e-5)))],
      joints: wheels.map(([id, x, y]) => ({ kind: "pivot" as const, name: id, body: id, on: FRAME, at: [x, y, 0.03] as V3, axis: [0, 1, 0] as V3, frictionPerLoad: 0 })),
      wheels: wheels.map(([id, x, y]) => ({ name: id, joint: id, centre: [x, y, 0.03] as V3, axis: [0, 1, 0] as V3, radius: 0.03, grip: 0.8 })),
      ground: { floor: { p: [0, 0, 0], n: [0, 0, 1] }, blocks: [], mu: 0.8, roll: 0.01, label: "concrete" },
    });
  };

  it("a cart stands still on a level floor", () => {
    const sys = new MechSystem(cart(0));
    run(sys, 0.5);
    expect(Math.abs(sys.frame.x[0])).toBeLessThan(1e-4);
    expect(sys.frame.x[2]).toBeCloseTo(0.05, 3);
  });

  it("a cart rolls down a slope at about g sin θ", () => {
    const sys = new MechSystem(cart(10));
    run(sys, 1);
    // x = a t² / 2; the wheels' own inertia and rolling resistance take a little
    const a = (2 * -sys.frame.x[0]) / 1;
    const ideal = G * Math.sin((10 * Math.PI) / 180);
    expect(a).toBeGreaterThan(ideal * 0.8);
    expect(a).toBeLessThan(ideal * 1.01);
    // rolling, not sliding
    expect(sys.wheels.every((w) => w.slipTime < 0.05)).toBe(true);
  });
});

describe("catalog motors in the mechanism", () => {
  const machine = { components: [{ name: "m1", catalogId: "gobilda_5203_19.2".replace(".", "_"), kind: "gearmotor" }], wires: [], nets: [], calcs: [], firmware: [], tests: [], items: [], boards: [], belts: [] } as unknown as MachineData;

  it("a gearmotor lifting an arm slows under the load and draws more current", () => {
    // a 0.3 m arm with 0.5 kg at its end, level at the start, on the motor's shaft: 1.5 N·m of its 2.4 N·m stall
    const m = mech({
      bodies: [body("arm", 0.5, [0.3, 0, 0], diag(1e-4, 1e-3, 1e-3))],
      joints: [{ kind: "pivot", name: "arm", body: "arm", on: FRAME, at: [0, 0, 0], axis: [0, -1, 0], limits: [-0.1, 1.5], frictionPerLoad: 0 }],
      drives: [{ kind: "motor", joint: "arm", comp: "m1", sign: 1 }],
    });
    const r = runMechanism({ machine, world: (v) => new MechWorld(m, v, null, 20), duration: 1, variants: ["expected"] });
    const v = r.variants[0];
    expect(v.error).toBeUndefined();
    // it raises the arm onto its upper stop
    expect(v.results["arm.hit_stop"]).toBe(true);
    expect(v.results["arm.angle_max"] as number).toBeGreaterThan(80);
    // well below its 312 rpm free speed while lifting, and drawing far more than its 0.25 A free current
    expect(v.results["arm.max_rpm"] as number).toBeLessThan(250);
    expect(v.results["arm.max_rpm"] as number).toBeGreaterThan(60);
    expect(v.results["m1.peak_amps"] as number).toBeGreaterThan(3);
    expect(v.frames.series["arm.rpm"].length).toBeGreaterThan(50);
  });
});

describe("sim.mechanism in the design language", () => {
  const SRC = `design "Swing arm"
part base { material: "Aluminum 6061"  body box(120, 60, 10) }
part arm { material: "Aluminum 6061"  body box(200, 20, 10, at: (100, 0, 245)) }
scenario "Falls on its stop" {
  mechanism: sim.mechanism(
    sim.pivot(arm, at: (0, 0, 250), axis: -Y, limits: (-90deg, 10deg)),
    sim.payload(on: arm, mass: 200g, at: (100, 0, 250)),
  )
  duration: 8s
  expect "Hits the stop": arm.hit_stop
}
`;

  it("reads the items and runs without firmware", () => {
    const model = evaluate(SRC);
    expect(model.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
    const def = model.scenarios![0];
    expect(def.spec.physicsOnly).toBe(true);
    expect(def.spec.duration).toBe(8);
    expect(def.spec.mechanism!.items.map((i) => i.k)).toEqual(["pivot", "payload"]);
  });

  it("resolves masses from the parts' shapes and runs", () => {
    const model = evaluate(SRC);
    const def = model.scenarios![0];
    // a box mesh for every part from its recipe's box size
    const geom = (hash: string): MeshEntry | undefined => {
      const p = model.parts.find((x) => x.hash === hash)!;
      return p.name === "base" ? boxMesh([120, 60, 10], [0, 0, 5]) : boxMesh([200, 20, 10], [100, 0, 250]);
    };
    const r = resolveMechanism(def.spec, model, geom, true);
    if (!("mech" in r)) throw new Error(JSON.stringify(r));
    const arm = r.mech.bodies.find((b) => b.id === "arm")!;
    // 200 × 20 × 10 mm of aluminium (2.7 g/cm³) is 108 g, plus the 200 g payload
    expect(arm.mass).toBeCloseTo(0.308, 3);
    expect(r.mech.joints[0].limits![0]).toBeCloseTo(-Math.PI / 2, 5);
    expect(r.mech.notes.join(" ")).toMatch(/plain 8 mm pin/);
    // released level, the arm swings down (negative about -Y) onto its -90° stop, clear of the bench top
    const res = runSpec({ ...def.spec, mech: r.mech, variants: ["expected"] }, emptyMachine(), model.name);
    const v = res.variants[0];
    expect(v.results["arm.hit_stop"]).toBe(true);
    expect(v.results["arm.angle_min"] as number).toBeLessThan(-85);
    expect(v.results["arm.angle_min"] as number).toBeGreaterThan(-95);
    // it settles on the stop and the run ends early instead of idling to 8 s
    expect(v.stop).toBe("everything stopped");
    expect(v.frames.t[v.frames.t.length - 1]).toBeLessThan(6);
    expect(outcomesFor(def, res)!.map((o) => o.status)).toEqual(["pass"]);
    // playback draws each part on its body
    expect(v.scene.bodies.find((b) => b.id === "arm")?.parts).toEqual([model.parts.find((p) => p.name === "arm")!.id]);
  });
});

describe("firmware driving a mechanism", () => {
  it("the Sand Tunneller's firmware turns its front screw as a rigid body through its real motor and driver", () => {
    const src = readFileSync(join(__dirname, "../src/demos/sand-tunneller.kerf"), "utf8");
    const model = evaluate(`${src}
scenario "Front screw on the bench" {
  world: sim.bench(load: 0)
  mechanism: sim.mechanism(sim.pivot(front_screw, drive: m_front), auto: false)
  duration: 180s
  variants: ["expected"]
  expect "Turns": abs(front_screw.turns) > 1
}
`);
    expect(model.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
    const def = model.scenarios!.find((d) => d.label === "Front screw on the bench")!;
    expect(def.spec.physicsOnly).toBeUndefined();
    const r = resolveMechanism(def.spec, model, () => boxMesh([40, 40, 40]), true);
    if (!("mech" in r)) throw new Error(JSON.stringify(r));
    // the screw turns on its spin: axis, in the bearings found on it
    expect(r.mech.joints[0].axis).toEqual([1, 0, 0]);
    const res = runSpec({ ...def.spec, mech: r.mech }, model.machine!, model.name);
    const v = res.variants[0];
    expect(v.error).toBeUndefined();
    expect(v.results.faults).toBe(0);
    // the motor model and the rigid screw agree on how far it turned
    const screw = v.results["front_screw.turns"] as number;
    expect(Math.abs(screw)).toBeGreaterThan(1);
    expect(Math.abs(v.results["m_front.turns"] as number)).toBeGreaterThan(1);
    expect(v.frames.series["front_screw.rpm"]).toBeDefined();
    expect(outcomesFor(def, res)!.find((o) => o.label === "Turns")?.status).toBe("pass");
  }, 120_000);
});

/** a closed box mesh centred on the origin, the way the kernel would mesh `box(...)` centred */
function boxMesh(s: V3, at: V3 = [0, 0, 0]): MeshEntry {
  const [a, b, c] = [s[0] / 2, s[1] / 2, s[2] / 2];
  const p: number[] = [];
  for (const z of [-c, c]) for (const y of [-b, b]) for (const x of [-a, a]) p.push(at[0] + x, at[1] + y, at[2] + z);
  // outward-facing triangles of the 6 faces
  const q = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ];
  const idx: number[] = [];
  for (const [i, j, k, l] of q) idx.push(i, j, k, i, k, l);
  const mesh = { positions: Float32Array.from(p), normals: new Float32Array(p.length), indices: Uint32Array.from(idx), edges: new Float32Array(0) };
  return { preview: mesh, volume: s[0] * s[1] * s[2], bbox: [[at[0] - a, at[1] - b, at[2] - c], [at[0] + a, at[1] + b, at[2] + c]], rev: 0 };
}
