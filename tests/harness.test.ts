// The 3D wiring is drawn from the same wire list as the build pack: every wire
// in the demos must get a real plug at each end, the router must take cables
// round parts rather than through them, and routed runs must become the wire
// list's cut lengths.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "../src/lang/evaluator";
import { buildHarness, routeRequests } from "../src/machine/harness/harness";
import { routeCables, type RouteGeometry } from "../src/machine/harness/route";
import { cutLength, wireList } from "../src/machine/wiring";

const demo = (name: string) => evaluate(readFileSync(join(__dirname, `../src/demos/${name}.kerf`), "utf8"));

/** A closed box mesh from lo to hi. */
function boxGeo(lo: [number, number, number], hi: [number, number, number]): RouteGeometry {
  const p: number[] = [];
  for (let c = 0; c < 8; c++) p.push(c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2]);
  const quads = [
    [0, 1, 3, 2],
    [4, 6, 7, 5],
    [0, 4, 5, 1],
    [2, 3, 7, 6],
    [0, 2, 6, 4],
    [1, 5, 7, 3],
  ];
  const idx = quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]);
  return { positions: new Float32Array(p), indices: new Uint32Array(idx) };
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe("wiring harness", () => {
  it("puts a real plug on both ends of every printer wire", () => {
    const model = demo("printer");
    const h = buildHarness(model);
    expect(h.wires.length).toBe(wireList(model.machine!).length);
    const kinds = new Map(h.wires.flatMap((w) => w.ends.map((e) => [`${e.comp}.${e.pin}`, e.spec.kind] as const)));
    // the board's headers, the motors' sockets and the supply's barrier strip
    expect(kinds.get("skr.XM")).toBe("xh");
    expect(kinds.get("x_motor.PLUG")).toBe("ph");
    expect(kinds.get("psu.V_PLUS")).toBe("fork");
    expect(kinds.get("skr.POWER")).toBe("ferrule");
    expect(kinds.get("pi.USB")).toBe("usb_micro");
    // a stepper cable has four conductors in the usual colours
    const xm = h.wires.find((w) => w.ends.some((e) => e.pin === "XM"))!;
    expect(xm.wires.map((w) => w.name)).toEqual(["black", "green", "red", "blue"]);
    // the supply's −V takes its wires on its separate screws
    const minus = h.wires.flatMap((w) => w.ends).filter((e) => e.comp === "psu" && e.pin === "V_MINUS");
    expect(new Set(minus.map((e) => e.frame.o.join())).size).toBe(3);
  });

  it("solders the amp's jacks at their lugs and plugs the brick into the DC jack", () => {
    const h = buildHarness(demo("practice-amp"));
    const end = (comp: string, pin: string, other: string) => h.wires.flatMap((w) => (w.ends.some((e) => e.comp === other) ? w.ends : [])).find((e) => e.comp === comp && e.pin === pin)!;
    expect(end("jack_in", "TIP", "j_in").spec.kind).toBe("lug");
    expect(end("dc_in", "PIN", "psu").spec.kind).toBe("barrel");
    expect(end("dc_in", "PIN", "j_dc").spec.kind).toBe("lug");
    expect(end("spk", "PLUS", "amp").spec.kind).toBe("spade");
    expect(end("amp", "OUT_P", "spk").spec.kind).toBe("ferrule");
  });

  it("routes a cable round a wall instead of through it", () => {
    const wall = boxGeo([-5, -60, 0], [5, 60, 80]);
    const floor = boxGeo([-120, -120, -10], [120, 120, 0]);
    const res = routeCables({
      geos: [wall, floor],
      placed: [
        { geo: 0, m: IDENTITY },
        { geo: 1, m: IDENTITY },
      ],
      wires: [{ id: "W1", a: { p: [-60, 0, 10], dir: [0, 0, 1] }, b: { p: [60, 0, 10], dir: [0, 0, 1] }, d: 2 }],
    });
    const w = res.wires[0];
    expect(w.straight).toBe(false);
    expect(w.through).toBe(0);
    // over the top or round an end: well over the 120 mm straight line
    expect(w.length).toBeGreaterThan(160);
    for (const p of w.points) expect(Math.abs(p[0]) > 5 || Math.abs(p[1]) > 60 || p[2] > 80).toBe(true);
  });

  it("routes every printer cable and the wire list takes the routed lengths", () => {
    const model = demo("printer");
    const h = buildHarness(model);
    const req = routeRequests(h);
    // thick cables are routed first so thin ones follow them
    expect(req[0].d).toBeGreaterThanOrEqual(req[req.length - 1].d);
    const runs = new Map(h.wires.map((w, i) => [w.id, 300 + i]));
    const rows = wireList(model.machine!, undefined, runs);
    for (const r of rows) {
      expect(r.lengthRouted).toBe(true);
      expect(r.lengthMm).toBe(cutLength(runs.get(r.id)!));
    }
    expect(cutLength(300)).toBe(450);
    expect(cutLength(301)).toBe(500);
  });
});
