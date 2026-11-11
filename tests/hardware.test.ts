// Fasteners and motors: the fastener catalogue and chooser, the motor
// catalogue's shapes and mount data, the motor chooser, the checks that
// screws have something to hold and motors are bolted on, and the parts
// list's hardware prices and parts on hand.

import { beforeAll, describe, expect, it } from "vitest";
import { bboxOf, buildPart, buildShape, solidVolume } from "../src/kernel/build";
import { CATALOG } from "../src/machine/catalog";
import { buildGeometry } from "../src/machine/geometry";
import { plugFor } from "../src/machine/harness/plugs";
import { initKernel } from "./helpers/kernel";

const MOTOR_KINDS = new Set(["gearmotor", "stepper", "servo", "bldc", "actuator"]);
const motors = CATALOG.filter((p) => MOTOR_KINDS.has(p.kind));

describe("motor catalogue", () => {
  beforeAll(() => initKernel(), 60_000);

  it("has motors of every family", () => {
    const frames = new Set(motors.filter((p) => p.kind === "stepper").map((p) => p.specs.frame));
    expect([...frames].sort((a, b) => Number(a) - Number(b))).toEqual([8, 11, 14, 17, 23, 34]);
    for (const g of ["gearmotor", "micro_gearmotor", "tt_motor", "outrunner", "servo", "actuator"]) expect(motors.some((p) => p.geom.g === g), g).toBe(true);
    expect(motors.length).toBeGreaterThanOrEqual(45);
  });

  it("builds every motor, and every rotating one has its mount data", () => {
    for (const p of motors) {
      const g = buildGeometry(p, {});
      for (const s of g.solids) expect(solidVolume(buildPart(s.recipe)), `${p.id} ${s.suffix || "body"}`).toBeGreaterThan(1);
      if (p.kind === "actuator") continue;
      const f = g.fields;
      expect(typeof f.scalars?.screw, p.id).toBe("string");
      expect(typeof f.scalars?.screw_depth, p.id).toBe("number");
      expect(f.shapes?.mount, p.id).toBeDefined();
      expect(solidVolume(buildShape(f.shapes!.mount)), `${p.id} mount`).toBeGreaterThan(1);
      // a ducted fan with no tabs is clamped by its housing's ends: its mount is the seat alone
      if (p.geom.g === "edf" && p.geom.dims.tabs === 0) expect(f.pointLists?.holes ?? [], `${p.id} holes`).toEqual([]);
      else expect(f.pointLists?.holes?.length, `${p.id} holes`).toBeGreaterThan(0);
    }
  }, 120_000);

  it("knows the screw each motor takes and how deep", () => {
    const screw = (id: string) => {
      const f = buildGeometry(CATALOG.find((p) => p.id === id)!, {}).fields.scalars!;
      return `${f.screw} ${f.screw_depth}`;
    };
    expect(screw("nema17_17hs4401")).toBe("M3 4.5");
    expect(screw("nema14_14hs11_1004s")).toBe("M3 3.5");
    expect(screw("nema8_8hs15_0604s")).toBe("M2 2.5");
    expect(screw("nema23_23hs22_2804s")).toBe("M5 0");
    expect(screw("nema34_80mm_4_5nm")).toBe("M6 0");
    expect(screw("gobilda_5203_19_2")).toBe("M4 6");
    expect(screw("pololu_37d_50")).toBe("M3 3");
    expect(screw("jga25_370_12v_46_8")).toBe("M3 4.5");
    expect(screw("pololu_micro_hp6v_100")).toBe("M1.6 2");
    expect(screw("tt_motor_48_6v")).toBe("M3 0");
    expect(screw("a2212_1000kv")).toBe("M3 3");
    expect(screw("sg90")).toBe("M2 0");
    expect(screw("mg996r")).toBe("M3 0");
  });

  it("centres a 37D gearbox's holes on the gearbox, not the offset shaft", () => {
    const holes = buildGeometry(CATALOG.find((p) => p.id === "pololu_37d_50")!, {}).fields.pointLists!.holes;
    const cx = holes.reduce((a, h) => a + h[0], 0) / holes.length;
    expect(cx).toBeCloseTo(-7, 5);
    expect(Math.hypot(holes[0][0] + 7, holes[0][1])).toBeCloseTo(15.5, 5);
  });
});

// ---------------------------------------------------------------- choosers

import { CALC_FNS } from "../src/machine/calcs";
import { evaluate } from "../src/lang/evaluator";
import { Obj, type Value } from "../src/lang/values";
import { fastenerChecks } from "../src/core/fastenerChecks";
import { bomRows, bomTotal } from "../src/persist/files";
import { chooseFastener, haveKey, parseHave } from "../src/library/fasteners";
import { threadSpec } from "../src/library/standards";
import { chooseMotor } from "../src/machine/motorSelect";

const ctx = {
  error: (msg: string): never => {
    throw new Error(msg);
  },
  geo: () => 0,
};
function calc(name: string, args: Record<string, Value>): Record<string, Value> {
  const r = CALC_FNS[name].call([], args, ctx as never);
  if (!(r instanceof Obj)) throw new Error("not a calculation");
  return r.fields;
}
const errors = (src: string) => evaluate(src).diagnostics.filter((d) => d.severity === "error").map((d) => d.message);

describe("calc.fastener", () => {
  it("chooses a stocked screw and insert for a printed joint", () => {
    const j = calc("fastener", { grip: 4, into: "insert", material: "PLA" });
    expect(j.insert).toBe(true);
    expect(["M2", "M2.5", "M3"]).toContain(j.size);
    expect(j.engage as number).toBeGreaterThanOrEqual(j.engage_min as number);
    expect(j.price as number).toBeGreaterThan(0);
    expect(String(j.name)).toMatch(/^M\d/);
  });

  it("runs a bolt a full thread past its nut", () => {
    const j = calc("fastener", { grip: 10, into: "nut", size: "M4" });
    const t = threadSpec("M4")!;
    expect(j.nut).toBe("hex");
    expect(j.length as number).toBeGreaterThanOrEqual(10 + t.nut_h + t.pitch);
  });

  it("fits a NEMA 17's shallow tapped holes without bottoming out", () => {
    const j = calc("fastener", { grip: 5, into: "tapped", material: "Aluminum 6061", depth: 4.5, size: "M3" });
    expect(j.length).toBe(8);
    expect(j.engage as number).toBeLessThanOrEqual(4.5);
  });

  it("goes up a size for a real load and records what it ruled out", () => {
    const r = chooseFastener({ grip: 5, into: "insert", material: "PETG", load: 2000, count: 4 });
    const best = r.ranked[0];
    expect(best.thread.d).toBeGreaterThanOrEqual(4);
    expect(best.margin).toBeGreaterThanOrEqual(1);
    expect(r.rejected.some((x) => /^M3/.test(x.name) && /carries/.test(x.why))).toBe(true);
  });

  it("prefers screws the user has, stainless outdoors, and inch sizes when asked", () => {
    const mine = calc("fastener", { grip: 4, into: "insert", have: ["M3x10 button", "M3 insert"] });
    expect([mine.size, mine.length, mine.head, mine.on_hand]).toEqual(["M3", 10, "button", true]);
    expect(String(calc("fastener", { grip: 4, into: "insert", env: "outdoor" }).grade)).toMatch(/^A[24]/);
    expect(String(calc("fastener", { grip: 6, into: "nut", inch: true }).size)).toMatch(/^#|\//);
  });

  it("reads loose on-hand text", () => {
    expect(parseHave("M3x6-20 button stainless")).toMatchObject({ kind: "screw", thread: "M3", lengths: [6, 20], head: "button", grade: "A2-70" });
    expect(parseHave("M4 nyloc nuts")).toMatchObject({ kind: "nut", thread: "M4", type: "nyloc" });
    expect(haveKey(["M3x6-20 socket"], "screw|M3|10|socket|12.9")).toBe(true);
    expect(haveKey(["M3x6-20 socket"], "screw|M3|25|socket|12.9")).toBe(false);
    expect(haveKey(["M3 nut"], "nut|M3|hex|8.8")).toBe(true);
  });
});

describe("hardware in a design", () => {
  it("builds every head type, nuts, washers, standoffs and circlips with prices", () => {
    const heads = ["socket", "button", "flat", "low", "pan", "hex", "set", "forming"];
    const src = [
      'design "hardware"',
      ...heads.map((h, i) => `component s${i} = lib.screw(M4, 12, head: "${h}") { at: (${i * 15}, 0, 0), axis: -Z }`),
      'component n = lib.nut(M4, type: "nyloc") { at: (0, 20, 0), axis: Z }',
      "component w = lib.washer(M4) { at: (15, 20, 0), axis: Z }",
      "component so = lib.standoff(M3, 10) { at: (30, 20, 0), axis: Z }",
      "component c = lib.circlip(8) { at: (45, 20, 0), axis: Z }",
      'component u = lib.screw("1/4-20", 19.05) { at: (60, 20, 0), axis: -Z }',
    ].join("\n");
    expect(errors(src)).toEqual([]);
    const rows = bomRows(evaluate(src));
    const hw = rows.filter((r) => r.kind === "Buy");
    expect(hw.length).toBe(heads.length + 5);
    for (const r of hw) {
      expect(r.price, r.description).toBeGreaterThan(0);
      expect(r.links.length, r.description).toBeGreaterThan(0);
    }
    expect(hw.find((r) => /Hex head/i.test(r.description))?.standard).toMatch(/4017/);
  });

  it("draws countersunk wood screws in gauge sizes, with a price and where to buy them", () => {
    expect(threadSpec("8G")).toMatchObject({ d: 4.2, clearance: 4.5, tap: 3, head_d: 8.4 });
    const src = `design "wood"\ncomponent s = lib.screw("8G", 20) { at: [(0, 0, 0), (20, 0, 0)], axis: -Z }\n`;
    expect(errors(src)).toEqual([]);
    const row = bomRows(evaluate(src)).find((r) => r.kind === "Buy")!;
    expect(row.description).toMatch(/Countersunk wood screw 8G × 20 mm/);
    expect(row.qty).toBe(2);
    expect(row.price).toBeGreaterThan(0);
    expect(row.links.length).toBeGreaterThan(0);
    // a gauge size is a wood screw and nothing else, and a metric size is never one
    expect(errors(`design "x"\ncomponent s = lib.screw("8G", 20, head: "pan") { at: (0, 0, 0), axis: -Z }`)[0]).toMatch(/not made in 8G/);
    expect(errors(`design "x"\ncomponent s = lib.screw(M4, 12, head: "wood") { at: (0, 0, 0), axis: -Z }`)[0]).toMatch(/gauge sizes/);
  });

  it("places the chosen screw and insert straight from calc.fastener", () => {
    const src = `design "lid"
let j = calc.fastener(grip: 3, into: "insert", material: "PETG", size: M3)
part base {
  material: "PETG"
  body box(30, 30, 10)
  cut hole(M3, fit: "insert", depth: 8, at: (0, 0, 10))
}
part lid {
  material: "PETG"
  body box(30, 30, 3, at: (0, 0, 10))
  cut hole(M3, through: true, at: (0, 0, 13))
}
component ins = lib.insert(j) { at: (0, 0, 10), axis: -Z }
component s = lib.screw(j) { at: (0, 0, 13), axis: -Z }
`;
    expect(errors(src)).toEqual([]);
    const items = fastenerChecks(evaluate(src));
    expect(items.map((i) => `${i.status} ${i.title}`)).toEqual(["pass Every screw has thread to hold"]);
  });
});

describe("fastener and motor-mount checks", () => {
  const motor = (screw: string) => `design "mount"
component m = lib.stepper("nema17_17hs4401") { at: (0, 0, 0), axis: Z }
part plate {
  material: "Aluminum 6061"
  body box(60, 60, 5)
  cut m.mount
}
${screw}
`;
  const checks = (src: string) => fastenerChecks(evaluate(src)).map((i) => `${i.status} ${i.title}`);

  it("passes a NEMA 17 bolted with M3×8 through a 5 mm plate", () => {
    expect(errors(motor(""))).toEqual([]);
    expect(checks(motor("component s = lib.screw(M3, 8) { at: with_z(m.holes, 5), axis: -Z }"))).toEqual(["pass Every screw has thread to hold", "pass m bolted on"]);
  });

  it("fails screws that bottom out in the motor's holes", () => {
    const c = fastenerChecks(evaluate(motor("component s = lib.screw(M3, 12) { at: with_z(m.holes, 5), axis: -Z }")));
    const bottom = c.find((i) => /bottoms out/.test(i.title))!;
    expect(bottom.status).toBe("fail");
    expect(bottom.fix).toMatch(/Use a 8 mm screw/);
  });

  it("warns about a motor with no screws", () => {
    expect(checks(motor(""))).toEqual(["warn m is not bolted on"]);
  });

  it("finds a screw with nothing to thread into and a bolt short of its nut", () => {
    const src = `design "joint"
part a { body box(20, 20, 4) cut hole(M4, through: true, at: (0, 0, 4)) }
part b { body box(20, 20, 4, at: (0, 0, 4)) cut hole(M4, through: true, at: (0, 0, 8)) }
component loose = lib.screw(M4, 8) { at: (0, 0, 8), axis: -Z }
`;
    expect(checks(src)).toEqual(["warn M4×8 loose has nothing to thread into"]);
    const nut = src.replace("component loose = lib.screw(M4, 8)", "component bolt = lib.screw(M4, 8)") + "component n = lib.nut(M4) { at: (0, 0, 0), axis: -Z }\n";
    expect(checks(nut)).toEqual(["fail M4×8 bolt does not reach n"]);
    expect(checks(nut.replace("lib.screw(M4, 8)", "lib.screw(M4, 10)"))).toEqual(["fail M4×10 bolt does not reach through n"]);
    expect(checks(nut.replace("lib.screw(M4, 8)", "lib.screw(M4, 12)"))).toEqual(["pass Every screw has thread to hold"]);
  });

  it("checks a stated load against the screw and what it threads into", () => {
    const src = (load: number) => `design "hang"
part a { material: "PLA" body box(20, 20, 4) cut hole(M3, fit: "insert", depth: 6, at: (0, 0, 4)) }
part b { material: "PLA" body box(20, 20, 3, at: (0, 0, 4)) cut hole(M3, through: true, at: (0, 0, 7)) }
component i = lib.insert(M3) { at: (0, 0, 4), axis: -Z }
component s = lib.screw(M3, 8, load: ${load}) { at: (0, 0, 7), axis: -Z }
`;
    const light = fastenerChecks(evaluate(src(100))).find((x) => /carries its load/.test(x.title))!;
    expect(light.status).toBe("pass");
    const heavy = fastenerChecks(evaluate(src(1500))).find((x) => /carries its load/.test(x.title))!;
    expect(heavy.status).toBe("fail");
    expect(heavy.detail).toMatch(/insert pull-out/);
  });
});

describe("wood screws", () => {
  const src = (load: number, depth = 10.5) => `design "foot on a board"
part base { material: "Wood" process: false body box(100, 100, 12) cut hole(d: 3, depth: ${depth}, at: (20, 0, 12), dir: -Z) }
part foot { material: "PETG CF" body box(40, 40, 10, at: (20, 0, 12)) cut hole(d: 4.5, depth: 10.1, at: (20, 0, 22), dir: -Z, csink: 8.4) }
component s = lib.screw("8G", 20, load: ${load}) { at: (20, 0, 22), axis: -Z }
`;

  it("counts a pilot hole in wood as thread and checks the pull-out against the load", () => {
    expect(errors(src(130))).toEqual([]);
    const items = fastenerChecks(evaluate(src(130)));
    expect(items.map((i) => `${i.status} ${i.title}`).sort()).toEqual(["pass 8G×20 s carries its load", "pass Every screw has thread to hold"]);
    expect(items.find((i) => i.id === "fasten:ok")!.detail).toMatch(/1 into pilot holes in wood/);
    // 10 mm of 4.2 mm thread in softwood: 108.25 × 0.5² × 4.2 × 10 / 3 = 379 N
    const load = items.find((i) => /carries its load/.test(i.title))!;
    expect(load.detail).toMatch(/378\.88 N before wood screw pull-out in softwood/);
    const heavy = fastenerChecks(evaluate(src(900))).find((i) => /carries its load/.test(i.title))!;
    expect(heavy.status).toBe("fail");
    expect(heavy.detail).toMatch(/wood screw pull-out/);
  });
});

describe("calc.motor_select", () => {
  it("picks a gearmotor for a slow torque duty", () => {
    const m = calc("motor_select", { kind: "gearmotor", torque: 300, speed: 60, voltage: 12 });
    expect(m.kind).toBe("gearmotor");
    expect(m.margin as number).toBeGreaterThanOrEqual(2);
    expect(m.speed_available as number).toBeGreaterThanOrEqual(54);
  });

  it("sizes a stepper for a belt axis from force, mass and speed", () => {
    const m = calc("motor_select", { kind: "stepper", force: 10, mass: 800, accel: 3000, travel_per_rev: 40, speed: 200, voltage: 24 });
    expect(String(m.id)).toMatch(/^nema(14|17)/);
    expect(m.margin as number).toBeGreaterThanOrEqual(1.5);
    expect(m.torque_needed as number).toBeCloseTo(((10 + 0.8 * 3) * 40) / (2 * Math.PI * 0.9), 1);
  });

  it("handles servos, brushless motors and actuators, and what the user has", () => {
    expect(calc("motor_select", { kind: "servo", torque: 1000 }).id).toBe("ds3218");
    expect(calc("motor_select", { kind: "bldc", torque: 50, speed: 6000, voltage: 11.1 }).id).toBe("a2212_1000kv");
    expect(calc("motor_select", { kind: "actuator", force: 200, stroke: 80 }).id).toBe("linear_actuator_12v_100mm_900n");
    expect(calc("motor_select", { kind: "actuator", force: 200, stroke: 80, prefer: "small" }).id).toBe("actuonix_p16p_100_256");
    expect(calc("motor_select", { kind: "stepper", torque: 100, speed: 100, have: ["17HS3401"] })).toMatchObject({ id: "nema17_17hs3401", on_hand: true });
  });

  it("explains why nothing fits", () => {
    expect(() => calc("motor_select", { kind: "servo", torque: 50000 })).toThrow(/no motor in the catalog meets this duty/);
    const r = chooseMotor({ torque: 300, speed: 60, kind: "gearmotor", continuous: 0.5, maxSize: 30, have: [], prefer: "cheap" });
    expect(r.ranked.every((c) => (c.part.geom.dims.gear_d ?? 0) <= 30)).toBe(true);
    expect(r.rejected.some((x) => /over the 30 mm limit/.test(x.why))).toBe(true);
  });
});

describe("parts on hand", () => {
  it("marks what the user has and leaves it out of the cost", () => {
    const m = evaluate(`design "x"
component m1 = lib.stepper("nema17_17hs4401") { at: (0, 0, 0), axis: Z }
component s = lib.screw(M3, 8) { at: [(0, 0, 5), (10, 0, 5)], axis: -Z }
component n = lib.nut(M3) { at: (20, 0, 0), axis: Z }
`);
    const all = bomTotal(bomRows(m));
    const rows = bomRows(m, ["17HS4401", "M3x6-20 socket"]);
    expect(rows.filter((r) => r.onHand).map((r) => r.item).sort()).toEqual(["screw", "stepper"]);
    const some = bomTotal(rows);
    expect(some.total + some.saved).toBeCloseTo(all.total, 2);
    expect(some.saved).toBeGreaterThan(9);
    expect(rows.find((r) => r.item === "nut")?.haveAs).toBe("M3 nut");
  });
});

describe("electronics drawn as the real part", () => {
  beforeAll(() => initKernel(), 60_000);

  it("details a LiPo, an ESC, a fuse holder, an XT pair and a load cell inside the same envelope", () => {
    const styled = CATALOG.filter((p) => p.geom.g === "box" && p.geom.style);
    expect(new Set(styled.map((p) => p.geom.style))).toEqual(new Set(["lipo", "esc", "fuse_maxi", "xt", "load_cell"]));
    for (const p of styled) {
      const { w, d, h } = p.geom.dims;
      const g = buildGeometry(p, {});
      expect(g.solids.length, p.id).toBeGreaterThan(1);
      for (const s of g.solids) {
        const shape = buildPart(s.recipe);
        expect(solidVolume(shape), `${p.id} ${s.suffix || "body"}`).toBeGreaterThan(0.1);
        const [lo, hi] = bboxOf(shape);
        // a label may stand 0.15 mm proud, as the old wrap band did; nothing else leaves the box the checks see
        for (const [i, half] of [[0, w / 2], [1, d / 2]] as const) {
          expect(lo[i], `${p.id} ${s.suffix}`).toBeGreaterThanOrEqual(-half - 0.2);
          expect(hi[i], `${p.id} ${s.suffix}`).toBeLessThanOrEqual(half + 0.2);
        }
        expect(lo[2], `${p.id} ${s.suffix}`).toBeGreaterThanOrEqual(-0.01);
        expect(hi[2], `${p.id} ${s.suffix}`).toBeLessThanOrEqual(h + 0.01);
      }
    }
  });

  it("takes their leads off where the real ones leave", () => {
    const part = (id: string) => CATALOG.find((p) => p.id === id)!;
    const lipo = part("lipo_4s_5000_xt90");
    expect(plugFor(lipo, "POS")).toMatchObject({ kind: "lead", out: [1, 0, 0] });
    expect(plugFor(lipo, "POS")!.at[0]).toBeCloseTo(lipo.geom.dims.w / 2);
    const esc = part("skywalker_60a_v2");
    expect(plugFor(esc, "B_PLUS")!.out).toEqual([-1, 0, 0]);
    for (const pin of ["PHASE_A", "PHASE_B", "PHASE_C", "SIG"]) expect(plugFor(esc, pin)!.out, pin).toEqual([1, 0, 0]);
    const xt = part("xt90s_pair");
    expect(plugFor(xt, "POS_A")!.out).toEqual([0, 0, -1]);
    expect(plugFor(xt, "POS_B")!.at[2]).toBe(xt.geom.dims.h);
    expect(plugFor(part("fuse_holder_maxi"), "OUT")!.out).toEqual([1, 0, 0]);
    expect(plugFor(part("tal221_500g"), "EXC_P")!.out).toEqual([0, 1, 0]);
  });
});
