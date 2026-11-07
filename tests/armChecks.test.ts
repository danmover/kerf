// Checks and sim plumbing the desktop robot arm leans on: a bolt head held in a hex pocket needs no spanner, a
// KY-023 stick's plugs go on along its right-angle header, and a scenario with like: that only changes the bench
// keeps the other scenario's mechanism.

import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { catalogPart } from "../src/machine/catalog";
import { plugFor } from "../src/machine/harness/plugs";
import { fullCheck } from "./helpers/fullcheck";

describe("robot arm checks", () => {
  it("passes tool access for a hex head held in a hex pocket, even turned in its pocket", { timeout: 120_000 }, async () => {
    const src = `design "Captive head"
part post {
  material: "PETG"
  process: mfg.fdm(build: Z, bridge: 25)
  body box(40, 40, 20, at: (0, 0, 0))
  cut cylinder(d: 8.4, h: 22, at: (0, 0, -1))
  cut extrude(rotate(ngon(6, af: 13.3), 30), 5.6, at: (0, 0, -0.01)) as head_pocket
}
component bolt = lib.screw(M8, 30, head: "hex") { at: (0, 0, 5.5), axis: Z }
component nut = lib.nut(M8, type: "nyloc") { at: (0, 0, 20), axis: Z }
`;
    const { model, report } = await fullCheck(src);
    const bolt = model.parts.find((p) => p.name === "bolt")!;
    const item = report.items.find((i) => i.id === `access:${bolt.id}`)!;
    expect(item.status).toBe("pass");
    expect(item.detail).toMatch(/hex pocket/);
    expect(report.items.filter((i) => i.category === "interference" && i.status === "fail")).toEqual([]);
  });

  it("puts a KY-023's plugs on its right-angle header, out of the board's -X end", () => {
    const ky = catalogPart("joystick_ky023")!;
    const pins = ["GND", "VCC", "VRX", "VRY", "SW"].map((id) => plugFor(ky, id)!);
    for (const p of pins) {
      expect(p.kind).toBe("dupont");
      expect(p.out).toEqual([-1, 0, 0]);
      expect(p.at[0]).toBe(-17);
    }
    expect(pins.map((p) => p.at[1])).toEqual([-5.08, -2.54, 0, 2.54, 5.08]);
  });

  it("keeps the mechanism from like: when a scenario only puts test signals on the bench", () => {
    const m = evaluate(
      `design "Like"
part frame { process: false  body box(100, 100, 10) }
part arm { process: false  body box(10, 10, 100, at: (0, 0, 10)) }
component ctrl = lib.controller("arduino_nano") { at: (0, -150, 0) }
component j1 = lib.sensor("joystick_ky023") { at: (-100, -250, 0), role: "left" }
wire ctrl.A0 -> j1.VRX
wire ctrl.A1 -> j1.VRY
net GND: ctrl.GND, j1.GND
net V5: ctrl.V5, j1.VCC
scenario "Swing" {
  mechanism: sim.mechanism(sim.pivot(arm, at: (0, 0, 10), axis: Z))
  firmware: none
  duration: 1s
}
scenario "Swing with the stick" {
  like: "Swing"
  world: sim.bench(signals: [sim.signal(on: "j1.VRX", volts: [(0s, 2.5V), (0.5s, 4.5V)])])
}`,
      { skipGeometry: true },
    );
    expect(m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
    const [a, b] = m.scenarios!;
    expect(b.spec.mechanism).toBeDefined();
    expect(b.spec.mechanism).toBe(a.spec.mechanism);
    expect(b.spec.world.kind).toBe("bench");
  });
});
