// Where the wiring goes on machines with fans and pivots: cables stay out of a
// ducted fan's intake and jet, cross a pivot beside its axis (where turning
// it barely moves them), and a net that feeds a group of parts far from its
// supply is one trunk that splits near them, not a wire per pin. A ducted
// fan's motor leads leave its housing's side.

import { describe, expect, it } from "vitest";
import type { V3 } from "../src/kernel/recipe";
import { routeWithField, type RouteGeometry, type RoutePlaced } from "../src/machine/harness/route";
import { Solids } from "../src/machine/harness/solids";
import { runWiring } from "../src/machine/harness/wiringRun";
import { flowZones, inCone, type FlowZone } from "../src/machine/harness/flow";
import type { PivotJoint } from "../src/machine/harness/pivots";
import { wiringItems } from "../src/machine/harness/checks";
import { plugFor } from "../src/machine/harness/plugs";
import type { Harness, HarnessWire, PlugEnd } from "../src/machine/harness/harness";
import { catalogPart } from "../src/machine/catalog";
import { componentPositions, wireList } from "../src/machine/wiring";
import { evaluate } from "../src/lang/evaluator";
import type { Model } from "../src/core/model";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function box(lo: V3, hi: V3): RouteGeometry {
  const p: number[] = [];
  for (let c = 0; c < 8; c++) p.push(c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2]);
  const quads = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ];
  return { positions: new Float32Array(p), indices: new Uint32Array(quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d])) };
}

const X: V3 = [1, 0, 0];
const Y: V3 = [0, 1, 0];
const neg = (v: V3): V3 => [-v[0], -v[1], -v[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function end(partId: string, pin: string, o: V3, z: V3): PlugEnd {
  const x = Math.abs(z[0]) > 0.9 ? Y : X;
  const frame = { o, x, y: cross(z, x), z };
  return { partId, comp: partId, pin, label: pin, part: partId, spec: { kind: "lead", at: [0, 0, 0], out: z, row: x, ways: 1 }, local: frame, frame };
}
const wire = (id: string, a: PlugEnd, b: PlugEnd, d: number): HarnessWire => ({ id, row: { id } as HarnessWire["row"], ends: [a, b], wires: [{ color: "#c00", name: "red", d }], d });

describe("cables and a ducted fan's airflow", () => {
  // a 70 mm fan housing pointing up, its jet blowing down past a floor 230 mm below
  const geos = [box([-35, -35, -66], [35, 35, 0]), box([-160, -160, -240], [160, 160, -230])];
  const placed: RoutePlaced[] = [
    { geo: 0, m: IDENTITY, id: "edf" },
    { geo: 1, m: IDENTITY, id: "floor" },
  ];
  const jet: FlowZone = { partId: "edf", comp: "edf", kind: "jet", o: [0, 0, -66], dir: [0, 0, -1], r0: 34, grow: 0.0875, len: 512 };
  const wires = [{ id: "W1", a: { p: [-120, 0, -150] as V3, dir: neg(X) }, b: { p: [120, 0, -150] as V3, dir: X }, d: 3 }];
  const inJet = (p: V3) => inCone(jet, p) >= 0;

  it("runs a cable across the jet when nothing says where the air goes", () => {
    const { result } = routeWithField({ geos, placed, wires }, new Solids(geos, placed));
    expect(result.wires[0].straight).toBe(false);
    expect(result.wires[0].points.some(inJet)).toBe(true);
  });

  it("takes it round the jet instead, all the way along", () => {
    const { result, field } = routeWithField({ geos, placed, wires, flow: [jet] }, new Solids(geos, placed));
    const run = result.wires[0];
    expect(run.straight).toBe(false);
    expect(run.points.filter(inJet)).toEqual([]);
    // the grid marks the jet, so the wiring checks can tell
    expect(field.flow?.(0, 0, -150)).toBe(true);
    expect(field.flow?.(0, 120, -150)).toBe(false);
  });

  it("fails a cable left in the jet, naming the fan", () => {
    const h: Harness = { wires: [wire("W1", end("a", "P", [-120, 0, -150], neg(X)), end("b", "P", [120, 0, -150], X), 3)], sockets: [] };
    const findings = { cableHits: [], crossings: [], plugHits: [], plugClashes: [], leadBlocked: [], pullBlocked: [], splices: [], openings: [], freeSpans: [], ties: [], outside: [], unrouted: [], ms: 0, flow: [{ wire: "W1", zone: 0, part: "edf", comp: "edf", kind: "jet" as const, length: 80, at: [0, 0, -150] as V3 }] };
    const items = wiringItems(h, findings, [], { parts: [], scenarios: [] } as unknown as Model);
    const it = items.find((i) => i.id === "wiring:flow:edf")!;
    expect(it.status).toBe("fail");
    expect(it.title).toContain("jet");
  });
});

describe("cables across a pivot", () => {
  // a block on a pivot along X at z = 100, between two posts that carry its bearings; a box on the base and a chip
  // on the block, wired together
  const geos = [box([-40, -20, 80], [40, 20, 120]), box([60, -15, 0], [80, 15, 120]), box([-80, -15, 0], [-60, 15, 120]), box([-200, -150, -10], [200, 150, 0]), box([100, 60, 0], [140, 100, 30]), box([-10, -10, 120], [10, 10, 126])];
  const ids = ["body", "post_r", "post_l", "base", "esc", "chip"];
  const placed: RoutePlaced[] = ids.map((id, geo) => ({ geo, m: IDENTITY, id }));
  const joint: PivotJoint = { name: "tilt", at: [0, 0, 100], axis: [1, 0, 0], limits: [-30, 30], parts: ["body", "chip"], parent: null };
  const h: Harness = { wires: [wire("W1", end("esc", "OUT", [100, 80, 15], neg(X)), end("chip", "IN", [0, 0, 126], [0, 0, 1]), 2)], sockets: [] };

  it("crosses beside the bearing, close to the axis, and says how much slack to leave", () => {
    const run = runWiring({ geos, placed, wires: [] }, { harness: h, mounts: [], screws: [], pivots: [joint] });
    const w = run.result.wires[0];
    expect(w.straight).toBe(false);
    const c = run.findings!.pivots!;
    expect(c.map((x) => [x.wire, x.joint])).toEqual([["W1", "tilt"]]);
    // just past the block's end on the +X side (nearer the box it comes from), right by the axis
    expect(c[0].side).toBe(1);
    expect(c[0].r!).toBeLessThan(8);
    expect(c[0].at![0]).toBeGreaterThan(40);
    expect(c[0].at![0]).toBeLessThan(62);
    // and the cable really goes there
    expect(Math.min(...w.points.map((p) => dist(p, c[0].at!)))).toBeLessThan(6);
    const model = { parts: [], scenarios: [{ spec: { mechanism: { items: [{ k: "pivot", name: "tilt", limits: [-30, 30] }] } } }] } as unknown as Model;
    const info = wiringItems(h, run.findings!, [], model).find((i) => i.id === "wiring:pivots")!;
    expect(info.status).toBe("info");
    expect(info.detail).toMatch(/slack/);
  });

  it("goes the short way round without the pivot", () => {
    const run = runWiring({ geos, placed, wires: [] }, { harness: h, mounts: [], screws: [] });
    expect(run.findings!.pivots).toBeUndefined();
    const w = run.result.wires[0];
    // nothing makes it pass by the axis
    expect(Math.min(...w.points.map((p) => Math.hypot(p[1], p[2] - 100)))).toBeGreaterThan(10);
  });
});

describe("nets that feed a far group of parts", () => {
  const src = (servo: string) => `
design "Trunk"
component esc = lib.esc("skywalker_60a_v2") { at: (0, 0, 0) }
component estop = lib.switch("estop_jaycar_sp0786") { at: (0, -400, 0) }
component feather = lib.controller("feather_esp32_v2") { at: (620, 40, 0) }
component servo_a = lib.servo("${servo}") { at: (600, 0, 0) }
component servo_b = lib.servo("${servo}") { at: (660, 0, 0) }
component servo_c = lib.servo("${servo}") { at: (600, 60, 0) }
component servo_d = lib.servo("${servo}") { at: (660, 60, 0) }
net GND: estop.NO_4, esc.BEC_GND, servo_a.GND, servo_b.GND, servo_c.GND, servo_d.GND, feather.GND
net V5: esc.BEC_5V, servo_a.V_PLUS, servo_b.V_PLUS, servo_c.V_PLUS, servo_d.V_PLUS
wire feather.A1 -> estop.NO_3
`;

  it("starts the ground at the ESC's supply, not at the far e-stop's sense contact", () => {
    const m = evaluate(src("savox_sh0264mg"));
    // where the parts are is not known: the e-stop's contact is the first power-side pin, as it always was
    const blind = wireList(m.machine!).filter((r) => r.net === "GND");
    expect(new Set(blind.map((r) => `${r.from.comp}.${r.from.pin}`))).toEqual(new Set(["estop.NO_4"]));
    // it is 400 mm from everything else: the ground starts at the ESC's BEC, the supply that feeds the rest
    const rows = wireList(m.machine!, componentPositions(m)).filter((r) => r.net === "GND");
    expect(rows.length).toBe(blind.length);
    expect(rows.find((r) => r.to.comp === "estop" || r.from.comp === "estop")).toMatchObject({ from: { comp: "esc", pin: "BEC_GND" } });
  });

  it("runs one trunk to the group and short branches from there", () => {
    const m = evaluate(src("savox_sh0264mg"));
    const all = wireList(m.machine!, componentPositions(m));
    expect(all.length).toBe(wireList(m.machine!).length);
    const gnd = all.filter((r) => r.net === "GND");
    const fromHub = gnd.filter((r) => r.from.comp === "esc");
    // one trunk to the servos and the board, and the e-stop's own wire
    expect(fromHub.map((r) => r.to.comp).sort()).toEqual(["estop", "servo_a"]);
    const trunk = fromHub.find((r) => r.to.comp === "servo_a")!;
    expect(trunk.note).toMatch(/Trunk to/);
    // the branches stay in the group
    for (const r of gnd.filter((x) => x.from.comp !== "esc")) expect(r.lengthMm!).toBeLessThan(400);
    const v5 = all.filter((r) => r.net === "V5");
    expect(v5.filter((r) => r.from.comp === "esc").length).toBe(1);
  });

  it("sizes a trunk for every part past it", () => {
    // four big servos stall at 2.5 A each: their shared trunk is heavier than the branches
    const m = evaluate(src("mg996r"));
    const v5 = wireList(m.machine!, componentPositions(m)).filter((r) => r.net === "V5");
    const trunk = v5.find((r) => r.from.comp === "esc")!;
    const branch = v5.find((r) => r.from.comp !== "esc")!;
    expect(trunk.gauge!).toBeLessThan(branch.gauge!);
  });

  it("keeps the star on a heavy supply net", () => {
    const m = evaluate(src("savox_sh0264mg").replace(/net V5:(.*)/, "net V5:$1 { gauge: 16 }"));
    const v5 = wireList(m.machine!, componentPositions(m)).filter((r) => r.net === "V5");
    expect(v5.every((r) => r.from.comp === "esc")).toBe(true);
  });
});

describe("a ducted fan's leads and airflow", () => {
  it("takes the motor leads out of the housing's side, over the stator", () => {
    const edf = catalogPart("xfly_edf_64_12b_3200kv")!;
    const d = edf.geom.dims;
    const az = ((d.lead_az ?? 0) * Math.PI) / 180;
    const zs: number[] = [];
    for (const pin of ["PHASE_A", "PHASE_B", "PHASE_C"]) {
      const p = plugFor(edf, pin)!;
      expect(p.kind).toBe("lead");
      expect(Math.hypot(p.at[0], p.at[1])).toBeGreaterThan(d.od / 2);
      expect(Math.atan2(p.at[1], p.at[0])).toBeCloseTo(az, 3);
      expect(p.out[2]).toBe(0);
      // between the intake and the exhaust, not out of either end
      expect(p.at[2]).toBeLessThan(-0.5 * d.length);
      expect(p.at[2]).toBeGreaterThan(-0.9 * d.length);
      zs.push(p.at[2]);
    }
    expect(new Set(zs).size).toBe(3);
  });

  it("finds the intake and jet of a fan in a design", () => {
    const m = evaluate(`design "Fan"\ncomponent edf = lib.bldc("xfly_edf_64_12b_3200kv") { at: (0, 0, 100), axis: Z }\n`);
    const zones = flowZones(m);
    expect(zones.map((z) => z.kind)).toEqual(["intake", "jet"]);
    const [intake, jet] = zones;
    expect(intake.dir[2]).toBeCloseTo(1);
    expect(jet.dir[2]).toBeCloseTo(-1);
    expect(inCone(intake, [0, 0, 120])).toBeGreaterThan(0);
    expect(inCone(jet, [0, 0, 0])).toBeGreaterThan(0);
    expect(inCone(jet, [120, 0, 0])).toBe(-1);
  });
});
