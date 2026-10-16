// The simulation engine end to end: the generated Sand Tunneller firmware on
// the virtual Nano, the plant from its wiring, in the sand pit world.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "../src/lang/evaluator";
import { runScenario } from "../src/sim/engine/run";
import { SandPit, type SandPitSpec, type TunnellerSpec } from "../src/sim/worlds/sandPit";

const model = evaluate(readFileSync(join(__dirname, "../src/demos/sand-tunneller.kerf"), "utf8"));

const pit: SandPitSpec = { length: 2000, width: 500, depth: 5000, axis: 100, density: 1.6, phi: 32, wallPhi: (2 / 3) * 32, start: 0, exitD: 250, ambient: 15 };
const robot: TunnellerSpec = {
  screws: [
    { motor: "m_front", d: 90, core: 72, pitch: 40, from: 42, to: 218, face: true, advance: 1, turn: 1 },
    { motor: "m_rear", d: 90, core: 72, pitch: 40, from: -452, to: -276, face: false, advance: 1, turn: -1 },
  ],
  delta: 19,
  body: { d: 60, from: -254, to: 18 },
  nose: 295,
  tail: -499,
  hinge: { x: 0, actuator: "steer", arm: 30, slope: 0.2, mid: 25, stop: 5.71, dir: 1, friction: 0.2 },
  imus: { imu: -86 },
};

describe("the Sand Tunneller in the pit", () => {
  it.each([["buried, as wired", 504, 1], ["buried, steering flipped", 504, -1]])("runs the expected variant %s", (_name, start, dir) => {
    const rb = { ...robot, hinge: { ...robot.hinge!, dir: dir as number } };
    const r = runScenario({ machine: model.machine!, designName: "Sand Tunneller", world: (v, seed) => new SandPit({ ...pit, start: start as number }, rb, v, seed), duration: 900, variants: ["expected"] });
    expect(r.error).toBeUndefined();
    const v = r.variants[0];
    console.log(v.stop, v.error, JSON.stringify(v.summary));
    console.log(v.events.map((e) => `${e.t.toFixed(1)} ${e.kind} ${e.text}`).join("\n"));
    console.log(JSON.stringify(Object.fromEntries(Object.entries(v.results).filter(([k]) => !k.startsWith("fw.")))));
    console.log(v.serial.slice(-12).map((l) => `${l.t.toFixed(1)} ${l.text}`).join("\n"));
    expect(v.error).toBeUndefined();
  }, 600_000);
});
