// A magnetic suspension wind tunnel: a magnet floated under a lift coil and
// steered by four coils beneath it, read by a 3-axis Hall sensor, in the air
// stream of a PWM fan. The field maths, the chips on the bus, coils wired in
// series, and the generated ESP32 firmware flying the simulated rig: lift-off,
// weighing the model, moves, a wind run that reads drag, landing, and the
// cut-outs when a part fails.

import { describe, expect, it } from "vitest";
import { catalogPart } from "../src/machine/catalog";
import { buildNetlist } from "../src/machine/erc";
import { generateFirmware } from "../src/machine/firmware";
import { FIELD_PLUGS } from "../src/machine/harness/fieldPlugs";
import { plugFor } from "../src/machine/harness/plugs";
import { coilChain, shuntFacing, shuntSides } from "../src/machine/shunts";
import { evaluate } from "../src/lang/evaluator";
import { Ina3221, PwmFan, Sdp8xx, Tmag5273, type ShuntTap } from "../src/sim/engine/fielddevs";
import { runSpec } from "../src/sim/build";
import { CoilField, MagnetField, blockageFactor, dipoleWrench, tunnelSpeed, turnsThatFit, wheelerInductance, windingResistance, type Vec3 } from "../src/sim/mech/field";
import { FRAME, type MechBody, type MechModel } from "../src/sim/mech/model";
import type { M3, V3 } from "../src/sim/mech/solver";

const G = 9.80665;
const FCPU = 240e6;
const diag = (a: number): M3 => [a, 0, 0, 0, a, 0, 0, 0, a];
/** a repeatable stand-in for the simulator's random source */
const rngOf = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

// the rig: test section 60 x 50 mm round the origin (X downstream, Z up). The lift coil's centre is 38 mm above
// the hover point, the field sensor 30 mm below it with the nulling winding round it, and the four steering coils
// under the floor. The model rests on a 3 mm pad with its magnet 12.46 mm under the hover point.
const REST_Z = -0.01246;

function design(scenario: string, extra = "", lift = `wire lift.M_MINUS -> nullc.M_PLUS
wire nullc.M_MINUS -> inaA.CH1P`, magZ = -18.46) {
  return evaluate(
    `design "Mag tunnel"
component fc = lib.controller("feather_esp32_v2") { at: (0, -80, -80) }
component psu = lib.psu("psu_12v_5a") { at: (200, 0, -80) }
component lift = lib.coil("coil_lift_84x18") { at: (0, 0, 29) }
component nullc = lib.coil("coil_null_39x3") { at: (0, 0, -28.5), axis: -Z }
component s1 = lib.coil("coil_steer_29x18") { at: (15, 15, -52) }
component s2 = lib.coil("coil_steer_29x18") { at: (-15, 15, -52) }
component s3 = lib.coil("coil_steer_29x18") { at: (-15, -15, -52) }
component s4 = lib.coil("coil_steer_29x18") { at: (15, -15, -52) }
component mag = lib.magnet("magnet_12x12_n45") { at: (0, 0, ${magZ}) }
component hall = lib.sensor("tmag5273_breakout") { at: (0, 0, -32.05) }
component drv = lib.motor_driver("drv8871_breakout") { at: (60, -80, -80) }
component tb1 = lib.motor_driver("tb6612fng") { at: (90, -80, -80) }
component tb2 = lib.motor_driver("tb6612fng") { at: (120, -80, -80) }
component inaA = lib.sensor("ina3221_breakout") { at: (60, -120, -80) }
component inaB = lib.sensor("ina3221_breakout_41") { at: (110, -120, -80) }
component gauge = lib.sensor("sdp810_500pa") { at: (-100, -60, 40) }
component fan = lib.fan("fan_arctic_s12038_8k") { at: (300, 0, 0), axis: X }
net GND: psu.VNEG, fc.GND, drv.GND, tb1.GND, tb2.GND, inaA.GND, inaB.GND, hall.GND, gauge.GND, fan.GND, tb1.AIN2, tb1.BIN2, tb2.AIN2, tb2.BIN2
net V12: psu.VPOS, drv.VM, tb1.VM, tb2.VM, fan.V12
net V3: fc.V3, tb1.VCC, tb2.VCC, tb1.AIN1, tb1.BIN1, tb2.AIN1, tb2.BIN1, gauge.VDD
net QT: fc.QT_3V, hall.VIN, inaA.VIN, inaB.VIN
net SDA: fc.SDA, hall.SDA, inaA.SDA, inaB.SDA, gauge.SDA
net SCL: fc.SCL, hall.SCL, inaA.SCL, inaB.SCL, gauge.SCL
wire fc.D27 -> drv.AIN1
wire fc.D33 -> drv.AIN2
wire fc.D32 -> tb1.PWMA
wire fc.D14 -> tb1.PWMB
wire fc.A0 -> tb2.PWMA
wire fc.A1 -> tb2.PWMB
net STBY: fc.A5, tb1.STBY, tb2.STBY
wire fc.MISO -> fan.PWM
wire fc.MOSI -> fan.TACH
wire drv.AOUT1 -> lift.M_PLUS
${lift}
wire inaA.CH1N -> drv.AOUT2
wire tb1.AO1 -> s1.M_PLUS
wire s1.M_MINUS -> inaA.CH2P
wire inaA.CH2N -> tb1.AO2
wire tb1.BO1 -> s2.M_PLUS
wire s2.M_MINUS -> inaA.CH3P
wire inaA.CH3N -> tb1.BO2
wire tb2.AO1 -> s3.M_PLUS
wire s3.M_MINUS -> inaB.CH1P
wire inaB.CH1N -> tb2.AO2
wire tb2.BO1 -> s4.M_PLUS
wire s4.M_MINUS -> inaB.CH2P
wire inaB.CH2N -> tb2.BO2
firmware lev { board: fc, behaviour: "magnetic levitation wind tunnel", hover: 12.46, model_g: 14.5, model_d: 20, section: "60, 50" ${extra} }
${scenario}`,
    { skipGeometry: true },
  );
}

/** a 20 mm ball with a 6 mm flat under it and the magnet at its centre, standing on the launch pad */
function rig(opts: { model?: boolean; mass?: number; moment?: number } = {}): MechModel {
  const c: V3 = [0, 0, REST_Z];
  const pts: V3[] = [];
  const R = 0.01;
  const flatZ = -Math.sqrt(R * R - 0.003 * 0.003);
  for (let lat = -75; lat <= 75; lat += 15)
    for (let lon = 0; lon < 360; lon += 15) {
      const z = R * Math.sin((lat * Math.PI) / 180);
      if (z < flatZ) continue;
      const r = R * Math.cos((lat * Math.PI) / 180);
      pts.push([c[0] + r * Math.cos((lon * Math.PI) / 180), c[1] + r * Math.sin((lon * Math.PI) / 180), c[2] + z]);
    }
  pts.push([c[0], c[1], c[2] + R]);
  for (let k = 0; k < 8; k++) pts.push([c[0] + 0.003 * Math.cos((k * Math.PI) / 4), c[1] + 0.003 * Math.sin((k * Math.PI) / 4), c[2] + flatZ]);
  const model: MechBody = { id: "model", label: "model", parts: [], mass: opts.mass ?? 0.0145, com: c, inertia: diag(5e-7), points: pts, boxes: [] };
  const area = (Math.PI / 4) * 0.02 * 0.02;
  const steer = (name: string, x: number, y: number) => ({ comp: name, body: FRAME, c: [x, y, -0.043] as V3, axis: [0, 0, 1] as V3, ri: 0.004, ro: 0.0145, h: 0.018, turns: 665 });
  return {
    bodies: [model],
    joints: [],
    drives: [],
    links: [],
    springs: [],
    loads: [],
    wheels: [],
    tracks: [],
    loose: [],
    ground: null,
    base: "fixed",
    gravity: [0, 0, -G],
    mounts: { mag: "model" },
    field: {
      coils: [
        { comp: "lift", body: FRAME, c: [0, 0, 0.038], axis: [0, 0, 1], ri: 0.022, ro: 0.042, h: 0.018, turns: 548 },
        { comp: "nullc", body: FRAME, c: [0, 0, -0.03], axis: [0, 0, -1], ri: 0.0174, ro: 0.0196, h: 0.003, turns: 25 },
        steer("s1", 0.015, 0.015),
        steer("s2", -0.015, 0.015),
        steer("s3", -0.015, -0.015),
        steer("s4", 0.015, -0.015),
      ],
      magnets: opts.model === false ? [] : [{ comp: "mag", body: "model", at: c, axis: [0, 0, 1], moment: opts.moment ?? 1.458, radius: 0.006, length: 0.012 }],
      sensors: [{ comp: "hall", body: FRAME, at: [0, 0, -0.03], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }],
      // southern Australia, Y north
      earth: [0, 22e-6, 55e-6],
    },
    tunnels: [
      { name: "tunnel", body: "model", fan: "fan", at: [0, 0, 0], flow: [1, 0, 0], up: [0, 0, 1], width: 0.06, height: 0.05, length: 0.12, cda: 0.47 * area, cla: 0, cya: 0, area, d: 0.02, loss: 2.2, contraction: 6, gauge: "gauge", turbulence: 0.008, shed: 0.06, strouhal: 0.2, points: pts, mu: 0.3, rho: 1.2, pad: { w: 0.014, h: 0.003 } },
    ],
    power: {},
    notes: [],
  };
}

/** run the generated firmware on the rig: what was typed, and for how long */
function fly(cmds: string, seconds: number, opts: { extra?: string; scn?: string; rig?: Parameters<typeof rig>[0] } = {}) {
  const m = design(`scenario "Fly" {\n  world: sim.bench()\n  duration: ${seconds}s\n  console: [${cmds}]\n  ${opts.scn ?? ""}\n}`, opts.extra);
  expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const def = m.scenarios![0];
  const v = runSpec({ ...def.spec, mech: rig(opts.rig), variants: ["expected"] }, m.machine!, m.name).variants[0];
  const said = v.serial.filter((l) => l.dir === "out").map((l) => l.text);
  const t = v.frames.t;
  /** a channel's mean and spread over a window of the run */
  const over = (ch: string, a: number, b: number) => {
    let n = 0;
    let sum = 0;
    let sq = 0;
    for (let i = 0; i < t.length; i++)
      if (t[i] >= a && t[i] <= b) {
        const x = v.frames.series[ch][i];
        n++;
        sum += x;
        sq += x * x;
      }
    const mean = sum / n;
    return { mean, sd: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
  };
  return { v, said, over, r: v.results as Record<string, number> };
}

describe("field maths", () => {
  const lift = new CoilField({ c: [0, 0, 0.038], axis: [0, 0, 1], ri: 0.022, ro: 0.042, h: 0.018, turns: 548 });

  it("gives a coil's field on its axis as the textbook loop formula summed over the winding does", () => {
    // a single thin loop: B = µ0 I R² / 2 (R² + z²)^1.5
    const loop = new CoilField({ c: [0, 0, 0], axis: [0, 0, 1], ri: 0.0199, ro: 0.0201, h: 0.0002, turns: 1 });
    const want = (4e-7 * Math.PI * 0.02 * 0.02) / (2 * (0.02 * 0.02 + 0.03 * 0.03) ** 1.5);
    expect(loop.at([0, 0, 0.03])[2]).toBeCloseTo(want, 8);
    // the lift coil at the hover point 38 mm under its centre
    expect(lift.at([0, 0, 0])[2] * 1000).toBeCloseTo(2.889, 2);
    // off the axis below the coil the field leans in toward the axis on its way up
    expect(lift.at([0.002, 0, 0])[0]).toBeLessThan(0);
  });

  it("pulls a magnet with the gradient of the field along its moment", () => {
    const w = dipoleWrench([lift], [1], [0, 0, 0], [0, 0, 1.458]);
    expect(w.force[2]).toBeCloseTo(0.1925, 3);
    expect(Math.hypot(w.force[0], w.force[1])).toBeLessThan(1e-6);
    // a magnet lying across the field is turned toward it
    const t = dipoleWrench([lift], [1], [0, 0, 0], [1.458, 0, 0]);
    expect(Math.abs(t.torque[1])).toBeCloseTo(1.458 * lift.at([0, 0, 0])[2], 5);
  });

  it("sizes a winding: turns that fit, resistance and inductance", () => {
    expect(turnsThatFit(0.022, 0.042, 0.018, 0.71e-3)).toBeGreaterThanOrEqual(548);
    expect(windingResistance(110, 0.71e-3)).toBeCloseTo(4.78, 1);
    expect(wheelerInductance(0.022, 0.042, 0.018, 548) * 1000).toBeCloseTo(17.5, 0);
    // the catalog's coils carry the same numbers
    const part = catalogPart("coil_lift_84x18")!;
    expect(part.specs.r_ohm).toBeCloseTo(windingResistance(Number(part.specs.wire_m), 0.71e-3), 1);
  });

  it("a nulling winding round the sensor cancels the lift coil's field there", () => {
    const nullc = new CoilField({ c: [0, 0, -0.03], axis: [0, 0, -1], ri: 0.0174, ro: 0.0196, h: 0.003, turns: 25 });
    const s: Vec3 = [0, 0, -0.03];
    const own = lift.at(s)[2];
    expect(own * 1000).toBeCloseTo(0.845, 2);
    expect(Math.abs(own + nullc.at(s)[2])).toBeLessThan(0.02 * own);
    // and adds a little lift from below
    expect(dipoleWrench([nullc], [1], [0, 0, 0], [0, 0, 1.458]).force[2]).toBeGreaterThan(0.01);
  });

  it("a magnet's field falls with the cube of the distance along its axis", () => {
    const mag = new MagnetField(0.006, 0.012, 1.458);
    const b30 = mag.at([0, 0, 0], [0, 0, 1], [0, 0, -0.03])[2];
    const b60 = mag.at([0, 0, 0], [0, 0, 1], [0, 0, -0.06])[2];
    expect(b30 * 1000).toBeGreaterThan(10);
    expect(b30 * 1000).toBeLessThan(11.5);
    expect(b30 / b60).toBeGreaterThan(7.6);
    expect(b30 / b60).toBeLessThan(8.4);
  });

  it("finds the tunnel's air speed where the fan's curve meets the circuit's losses", () => {
    const fan = { flowMax: 370 / 3600, pressureMax: 363 };
    const v = tunnelSpeed(fan, 1, 0.06 * 0.05, 2.2, 1.2);
    expect(v).toBeGreaterThan(13);
    expect(v).toBeLessThan(16.5);
    // the fan laws: half speed, half the air speed
    expect(tunnelSpeed(fan, 0.5, 0.06 * 0.05, 2.2, 1.2)).toBeCloseTo(v / 2, 1);
    expect(blockageFactor(314e-6, 0.003)).toBeCloseTo(1.026, 2);
  });
});

describe("the chips on the bus", () => {
  it("INA3221: three shunt channels, a conversion cycle set by the config register", () => {
    const tap: ShuntTap = { amps: 0.75, ripple: 0, pwmHz: 0, bus: 0.04 };
    const ina = new Ina3221("ina", FCPU, 0.05, [() => tap, () => ({ ...tap, amps: -0.3 }), () => undefined], rngOf(5));
    expect(ina.cycle()).toBeGreaterThan(0.005);
    // three channels, shunt only, 140 µs x 4 samples
    ina.write([0x00, 0x73, 0x05], 0);
    expect(ina.cycle()).toBeCloseTo(3 * 140e-6 * 4, 6);
    const read = (reg: number, t: number) => {
      ina.write([reg], t);
      const b = ina.read(2, t);
      return ((b[0] << 8) | b[1]) << 16 >> 16;
    };
    const t = 0.01 * FCPU;
    // 40 µV a step in the top 13 bits, through a 0.05 Ω shunt
    expect(((read(0x01, t) >> 3) * 40e-6) / 0.05).toBeCloseTo(0.75, 1);
    expect(((read(0x03, t) >> 3) * 40e-6) / 0.05).toBeCloseTo(-0.3, 1);
    expect(Math.abs(read(0x05, t) >> 3)).toBeLessThan(4);
    expect(read(0xfe, t) & 0xffff).toBe(0x5449);
    // frozen: the registers stop following the current
    ina.hold = true;
    tap.amps = 1.5;
    expect(((read(0x01, 0.02 * FCPU) >> 3) * 40e-6) / 0.05).toBeCloseTo(0.75, 1);
  });

  it("TMAG5273: three axes in one burst, two ranges, and it clips past its range", () => {
    const part = catalogPart("tmag5273_breakout")!;
    let b: [number, number, number] = [0.001, -0.002, 0.03];
    const tm = new Tmag5273("hall", FCPU, part, () => ({ b, ripple: [0, 0, 0], hz: 0 }), () => 25, rngOf(9));
    const w = (reg: number, val: number, t: number) => tm.write([reg, val], t);
    w(0x00, 0x10, 0);
    w(0x02, 0x70, 0);
    w(0x03, 0x03, 0);
    w(0x01, 0x12, 0);
    const burst = (t: number) => {
      tm.write([0x12], t);
      const d = tm.read(7, t);
      return [0, 1, 2].map((a) => ((((d[2 * a] << 8) | d[2 * a + 1]) << 16) >> 16) / 32768);
    };
    const hi = burst(0.01 * FCPU).map((x) => x * 80);
    // within the chip's 5 % gain error and 0.3 mT offset
    expect(hi[2]).toBeGreaterThan(30 * 0.94 - 0.4);
    expect(hi[2]).toBeLessThan(30 * 1.06 + 0.4);
    expect(hi[0]).toBeCloseTo(1, 0);
    expect(hi[1]).toBeCloseTo(-2, 0);
    // the ±40 mT range reads the same field with twice the counts
    w(0x03, 0x00, 0.011 * FCPU);
    b = [0.001, -0.002, 0.012];
    const lo = burst(0.02 * FCPU).map((x) => x * 40);
    expect(lo[2]).toBeGreaterThan(12 * 0.94 - 0.4);
    expect(lo[2]).toBeLessThan(12 * 1.06 + 0.4);
    // 60 mT is past it
    b = [0, 0, 0.06];
    expect(burst(0.03 * FCPU)[2]).toBeGreaterThan(0.999);
    expect(tm.clipped).toBeGreaterThan(0);
  });

  it("SDP810: a start command, 8 ms to the first result, pressure and scale with checksums", () => {
    const part = catalogPart("sdp810_500pa")!;
    const sdp = new Sdp8xx("gauge", FCPU, part, () => 120, () => 24, rngOf(3));
    expect(sdp.read(9, 0.05 * FCPU)).toEqual([]);
    sdp.write([0x36, 0x15], 0.05 * FCPU);
    expect(sdp.read(9, 0.055 * FCPU)).toEqual([]);
    const d = sdp.read(9, 0.07 * FCPU);
    expect(d.length).toBe(9);
    const crc = (a: number, b: number) => {
      let c = 0xff;
      for (const x of [a, b]) {
        c ^= x;
        for (let i = 0; i < 8; i++) c = c & 0x80 ? ((c << 1) ^ 0x31) & 0xff : (c << 1) & 0xff;
      }
      return c;
    };
    for (const i of [0, 3, 6]) expect(d[i + 2]).toBe(crc(d[i], d[i + 1]));
    const scale = (d[6] << 8) | d[7];
    expect(scale).toBe(60);
    const pa = ((((d[0] << 8) | d[1]) << 16) >> 16) / scale;
    // within 3 % of the reading
    expect(pa).toBeGreaterThan(115);
    expect(pa).toBeLessThan(125);
    expect(((((d[3] << 8) | d[4]) << 16) >> 16) / 200).toBeCloseTo(24, 1);
  });

  it("a four-wire fan follows its PWM wire, never below its minimum, and runs flat out with the wire off", () => {
    const fan = new PwmFan("fan", catalogPart("fan_arctic_s12038_8k")!);
    for (let i = 0; i < 6000; i++) fan.step(0.5, 12, 0.001);
    expect(fan.rpm).toBeGreaterThan(3600);
    expect(fan.rpm).toBeLessThan(4400);
    for (let i = 0; i < 12000; i++) fan.step(0, 12, 0.001);
    expect(fan.rpm).toBeGreaterThan(700);
    expect(fan.rpm).toBeLessThan(900);
    for (let i = 0; i < 8000; i++) fan.step(-1, 12, 0.001);
    expect(fan.rpm).toBeGreaterThan(7800);
    // no supply: it stops
    for (let i = 0; i < 20000; i++) fan.step(1, 0, 0.001);
    expect(fan.rpm).toBeLessThan(50);
  });
});

describe("coils in series and the shunts that read them", () => {
  const m = design("");
  const nl = buildNetlist(m.machine!);
  const coils = ["lift", "nullc", "s1", "s2", "s3", "s4"];

  it("follows a string of coils between a driver's two outputs", () => {
    expect(coilChain(nl, "drv[0].AOUT1", "drv[0].AOUT2", coils)).toEqual([
      { comp: "lift", sign: 1 },
      { comp: "nullc", sign: 1 },
    ]);
    expect(coilChain(nl, "tb1[0].AO1", "tb1[0].AO2", coils)).toEqual([{ comp: "s1", sign: 1 }]);
    // nothing joins outputs of two different channels
    expect(coilChain(nl, "tb1[0].AO1", "tb1[0].BO2", coils)).toBeUndefined();
  });

  it("knows which way round a coil sits when its leads are swapped", () => {
    const swapped = design("", "", `wire lift.M_MINUS -> nullc.M_MINUS\nwire nullc.M_PLUS -> inaA.CH1P`);
    const n2 = buildNetlist(swapped.machine!);
    expect(coilChain(n2, "drv[0].AOUT1", "drv[0].AOUT2", coils)).toEqual([
      { comp: "lift", sign: 1 },
      { comp: "nullc", sign: -1 },
    ]);
  });

  it("finds the shunt in series with a coil and which way it faces", () => {
    // the lift string's shunt sits after the nulling winding's END, reading positive for current in at START
    expect(shuntFacing(shuntSides(nl, "inaA", 1), "nullc")).toEqual({ sign: 1, atMinus: true });
    expect(shuntFacing(shuntSides(nl, "inaA", 1), "s1")).toBeUndefined();
    expect(shuntFacing(shuntSides(nl, "inaB", 2), "s4")).toEqual({ sign: 1, atMinus: true });
  });

  it("gives every component its place in the design, for firmware that works from the geometry", () => {
    const at = (n: string) => m.machine!.components.find((c) => c.name === n)!.at;
    expect(at("lift")).toEqual([0, 0, 29]);
    expect(at("hall")).toEqual([0, 0, -32.05]);
  });
});

describe("the levitation firmware generator", () => {
  const m = design("");
  const fw = generateFirmware(m.machine!, m.name)[0];
  const file = (end: string) => fw.files.find((f) => f.path.endsWith(end))!.content;
  const def = (name: string) => Number(new RegExp(`#define ${name} ([-0-9.e]+)`).exec(file("config.h"))![1]);
  const list = (name: string) =>
    new RegExp(`${name}\\[[^=]*= \\{(.*)\\};`)
      .exec(file("config.h"))![1]
      .replace(/[{}f]/g, "")
      .split(",")
      .map(Number);

  it("writes an ESP32 sketch, its settings and a bench guide", () => {
    expect(fw.target).toBe("arduino");
    expect(fw.warnings).toEqual([]);
    expect(fw.files.map((f) => f.path.split("/").pop())).toEqual(["lev.ino", "config.h", "README.md"]);
    expect(fw.summary).toMatch(/magnetic levitation/);
    expect(file("README.md")).toMatch(/coilcal/);
  });

  it("takes the pins and the current monitors from the wiring", () => {
    // DRV8871: IN1 held high, IN2 switched, driving for the PWM's low time; TB6612: PWM pins, standby on GPIO4
    expect(list("COIL_PWM")).toEqual([33, 32, 14, 26, 25]);
    expect(list("COIL_HIGH")).toEqual([27, -1, -1, -1, -1]);
    expect(list("COIL_INV")).toEqual([1, 0, 0, 0, 0]);
    expect(list("DRIVER_EN")).toEqual([4]);
    expect(list("COIL_INA")).toEqual([0x40, 0x40, 0x40, 0x41, 0x41]);
    expect(list("COIL_CH")).toEqual([1, 2, 3, 1, 2]);
    expect(list("COIL_SIGN")).toEqual([1, 1, 1, 1, 1]);
    expect(def("PIN_FAN_PWM")).toBe(21);
    expect(def("PIN_FAN_TACH")).toBe(19);
    // 20 kHz with the 11 bits an 80 MHz timer leaves
    expect(def("PWM_BITS")).toBe(11);
  });

  it("works the magnetic constants out from where the parts sit", () => {
    // the lift string is the lift coil and its nulling winding: their resistances add
    expect(list("COIL_R")[0]).toBeCloseTo(4.79 + 0.314, 2);
    expect(file("config.h")).toMatch(/Coil 0 lifts \(lift \+ nullc\)/);
    // nulled at the sensor; a steering coil is not
    const cb = list("COIL_B");
    expect(Math.hypot(cb[0], cb[1], cb[2])).toBeLessThan(0.02);
    expect(Math.hypot(cb[3], cb[4], cb[5])).toBeCloseTo(1.81, 1);
    expect(list("COIL_NULL_TURNS")).toEqual([25, 0, 0, 0, 0]);
    expect(def("FIELD_HOVER_MT")).toBeCloseTo(10.96, 1);
    expect(def("FIELD_REST_MT")).toBeCloseTo(55, 0);
    // lift per amp at the hover point: the lift coil's 192 mN and the nulling winding's 13
    const kl = list("TAB_KL");
    const k0 = Math.round((0 - def("Z_TAB_0")) / def("Z_TAB_STEP"));
    expect(kl[k0]).toBeCloseTo(0.2055, 2);
    // the tables keep their precision (metres need more than four decimals)
    expect(def("Z_TAB_STEP")).toBeCloseTo((0.012 + 0.01546) / 32, 6);
    // each steering coil pushes 15 mN per amp sideways and pulls 15 down
    const sf = list("STEER_F");
    expect(sf.slice(0, 3).map((x) => Math.round(x * 1000))).toEqual([15, 15, -15]);
    // a leaning magnet makes the steering push harder than its plain constants say
    expect(def("STEER_EFF")).toBeGreaterThan(1.2);
    expect(def("STEER_EFF")).toBeLessThan(1.5);
    expect(def("K_SIDE")).toBeGreaterThan(1);
    expect(def("K_SIDE")).toBeLessThan(5);
  });

  it("says what is missing instead of writing a sketch that cannot fly", () => {
    const bare = evaluate(
      `design "No sensor"
component fc = lib.controller("feather_esp32_v2") { at: (0, -80, -80) }
component lift = lib.coil("coil_lift_84x18") { at: (0, 0, 29) }
component mag = lib.magnet("magnet_12x12_n45") { at: (0, 0, -18.46) }
firmware lev { board: fc, behaviour: "magnetic levitation" }`,
      { skipGeometry: true },
    );
    const none = generateFirmware(bare.machine!, bare.name)[0];
    expect(none.files).toEqual([]);
    expect(none.warnings.join(" ")).toMatch(/TMAG5273|field sensor/i);
  });

  it("warns when the sensor would be driven past its range at rest", () => {
    // the magnet resting 3.5 mm nearer the sensor
    const near = design("", "", undefined, -22);
    const w = generateFirmware(near.machine!, near.name)[0].warnings.join(" ");
    expect(w).toMatch(/past its 80 mT range/);
  });
});

describe("the generated firmware flying the simulated rig", () => {
  it("lifts off, weighs the model, moves it, reads drag in the wind and lands", { timeout: 120_000 }, () => {
    const f = fly('sim.type("launch", at: 1s), sim.type("step x 1", at: 4.2s), sim.type("fan 100", at: 6s), sim.type("fan 0", at: 12s), sim.type("land", at: 13.5s)', 16);
    expect(f.v.faults).toEqual([]);
    expect(f.said.join("\n")).not.toMatch(/FAULT/);
    // the lift coil and its nulling winding carry one current
    expect(f.v.notes.join(" ")).toMatch(/lift, nullc are wired in series/);
    // it floats where it was told to, within a tenth of a millimetre, and steadily
    const z = f.over("tunnel.z", 3.2, 4.2);
    expect(Math.abs(z.mean)).toBeLessThan(0.15);
    expect(z.sd).toBeLessThan(0.04);
    expect(f.over("tunnel.touching", 3.2, 13.4).mean).toBe(0);
    // the pad gave the sensor its scale, so the weight comes out right: 14.5 g
    const grams = Number(/the model weighs ([0-9.]+) g/.exec(f.said.find((l) => /^tare/.test(l))!)![1]);
    expect(grams).toBeGreaterThan(14.5 * 0.97);
    expect(grams).toBeLessThan(14.5 * 1.03);
    // a 1 mm sideways step really moves it about 1 mm
    const step = f.said.find((l) => /^step x/.test(l))!;
    expect(step).toMatch(/within 10 % after \d+ ms/);
    expect(f.over("tunnel.x", 5.0, 5.6).mean).toBeGreaterThan(0.85);
    expect(f.over("tunnel.x", 5.0, 5.6).mean).toBeLessThan(1.15);
    // full wind: about 14.7 m/s, and the drag read from the coil currents matches the air's real push on the ball
    const speed = f.over("tunnel.speed", 10, 12).mean;
    expect(speed).toBeGreaterThan(13.5);
    expect(speed).toBeLessThan(16);
    const drag = f.over("tunnel.drag", 10, 12).mean * 1000;
    const read = f.over("fw.dragMn", 10, 12);
    expect(drag).toBeGreaterThan(17);
    expect(read.mean).toBeGreaterThan(drag * 0.93);
    expect(read.mean).toBeLessThan(drag * 1.07);
    expect(f.over("fw.cdNow", 10, 12).mean).toBeCloseTo(0.47, 1);
    // it held against the wind without touching anything, inside the steering coils' limit
    expect(Math.abs(f.over("tunnel.x", 10, 12).mean)).toBeLessThan(1);
    expect(f.r["tunnel.landings"]).toBe(1);
    expect(f.r["tunnel.floating"]).toBe(false);
    expect(f.r["tunnel.z"]).toBeCloseTo(-12.46, 1);
    expect(f.said[f.said.length - 1]).toMatch(/idle \(model on its pad\)/);
    expect(f.r["hall.clipped"]).toBe(0);
    // the loop fits its 2 ms
    expect(f.r["fw.overruns"]).toBe(0);
  });

  it("runs a speed sweep and prints a drag coefficient at each speed", { timeout: 120_000 }, () => {
    const f = fly('sim.type("launch", at: 1s), sim.type("sweep", at: 4.2s)', 15.5, { extra: ', sweep: "50, 100", sweep_settle_s: 2.5, sweep_avg_s: 1' });
    const rows = f.said.filter((l) => /^S,/.test(l)).map((l) => l.split(",").map(Number));
    expect(rows.length).toBe(2);
    // S,point,fan %,rpm,m/s,Re,drag mN,Cd,side,lift,sway
    expect(rows[0][4]).toBeGreaterThan(6.5);
    expect(rows[1][4]).toBeGreaterThan(13.5);
    expect(rows[1][5]).toBeGreaterThan(17000);
    for (const r of rows) {
      expect(r[7]).toBeGreaterThan(0.43);
      expect(r[7]).toBeLessThan(0.5);
    }
    expect(f.said.join("\n")).toMatch(/sweep done/);
    // and keeps the range of them where a design's scenario can ask for it
    expect(f.r["fw.sweepCdLo"]).toBeGreaterThan(0.43);
    expect(f.r["fw.sweepCdHi"]).toBeLessThan(0.5);
    expect(f.r["fw.sweepCdHi"]).toBeGreaterThanOrEqual(f.r["fw.sweepCdLo"]);
  });

  it("flies a build that is not quite the design: a heavier model with a weaker magnet", { timeout: 120_000 }, () => {
    const f = fly('sim.type("launch", at: 1s)', 5, { rig: { mass: 0.0165, moment: 1.37 } });
    expect(f.said.join("\n")).not.toMatch(/FAULT/);
    expect(Math.abs(f.over("tunnel.z", 3.5, 5).mean)).toBeLessThan(0.2);
    expect(f.over("tunnel.z", 3.5, 5).sd).toBeLessThan(0.04);
    // the tunnel's own measure of how far it moves about where it sits, over the last full second
    expect(f.r["tunnel.wander"]).toBeGreaterThan(0);
    expect(f.r["tunnel.wander"]).toBeLessThan(0.05);
  });

  it("drops the coils when the field sensor stops answering, a coil comes off or a monitor freezes", { timeout: 120_000 }, () => {
    const hall = fly('sim.type("launch", at: 1s)', 5, { scn: "faults: [sim.unplug(hall, at: 4s)]" });
    expect(hall.said.join("\n")).toMatch(/FAULT: field sensor stopped answering/);
    expect(hall.r["lift.amps"]).toBe(0);
    const coil = fly('sim.type("launch", at: 1s)', 5, { scn: "faults: [sim.unplug(s2, at: 4s)]" });
    expect(coil.said.join("\n")).toMatch(/coil 2 \(steering\) carries no current/);
    expect(coil.said.join("\n")).toMatch(/FAULT: no current in a coil/);
    const mon = fly('sim.type("launch", at: 1s)', 5, { scn: "faults: [sim.stuck(inaB, at: 4s)]" });
    expect(mon.said.join("\n")).toMatch(/FAULT: current monitor frozen/);
    // the fault holds until it is cleared
    expect(mon.said[mon.said.length - 1]).toMatch(/state: fault/);
  });

  it("checks the coils with the model out, and will not launch without one", { timeout: 120_000 }, () => {
    const f = fly('sim.type("zero", at: 1s), sim.type("coilcal", at: 2s), sim.type("launch", at: 6.5s)', 7, { rig: { model: false } });
    const text = f.said.join("\n");
    expect(text).toMatch(/zero: .* mT stored/);
    expect(text).toMatch(/coil 0 \(lift\): 0\.0\d+ mT\/A at the sensor with its nulling winding \(worth 0\.84\d mT\/A\): stored/);
    expect(text).toMatch(/coil 4 \(steering\): 1\.[78]\d+ mT\/A at the sensor, the design says 1\.810: stored/);
    expect(text).not.toMatch(/BACKWARDS|WRONG WAY/);
    expect(text).toMatch(/no model on the pad/);
  });
});

describe("where the wires leave the coils, sensor boards and gauge", () => {
  it("has a place on the real part for every wire it lists", () => {
    for (const [id, table] of Object.entries(FIELD_PLUGS)) {
      const part = catalogPart(id);
      expect(part, id).toBeDefined();
      for (const pin of Object.keys(table)) {
        expect(part!.pins.some((p) => p.id === pin), `${id}.${pin}`).toBe(true);
        expect(plugFor(part!, pin)).toBe(table[pin]);
      }
    }
  });

  it("puts the current monitor's power and data on its header pads and each coil's wires in its screw terminals", () => {
    const ina = catalogPart("ina3221_breakout")!;
    expect(plugFor(ina, "VIN")).toMatchObject({ kind: "solder", out: [0, 0, 1] });
    expect(plugFor(ina, "CH1P")).toMatchObject({ kind: "ferrule", out: [0, 1, 0] });
    // a channel's two contacts are 3.5 mm apart, on the board's far edge from the header
    expect(plugFor(ina, "CH1N")!.at[0] - plugFor(ina, "CH1P")!.at[0]).toBeCloseTo(3.5);
    expect(plugFor(ina, "CH3N")!.at[1]).toBeGreaterThan(0);
    expect(plugFor(ina, "SDA")!.at[1]).toBeLessThan(0);
  });

  it("brings a coil's two ends out of its winding, not its bore, and the Hall board's lead out of its socket", () => {
    const steer = catalogPart("coil_steer_29x18")!;
    for (const pin of ["M_PLUS", "M_MINUS"]) {
      const p = plugFor(steer, pin)!;
      expect(p.kind).toBe("lead");
      // outside the bobbin's 5.5 mm core, leaving downwards past its lower flange
      expect(Math.hypot(p.at[0], p.at[1])).toBeGreaterThan(14.5);
      expect(p.out).toEqual([0, 0, -1]);
    }
    const lift = catalogPart("coil_lift_84x18")!;
    expect(Math.hypot(...plugFor(lift, "M_PLUS")!.at.slice(0, 2))).toBeGreaterThanOrEqual(42);
    const hall = catalogPart("tmag5273_breakout")!;
    const ends = ["GND", "VIN", "SDA", "SCL"].map((pin) => plugFor(hall, pin)!);
    for (const e of ends) expect(e).toMatchObject({ kind: "lead", out: [1, 0, 0] });
    // four wires a millimetre apart, beyond the board's end
    expect(ends[0].at[1] - ends[3].at[1]).toBeCloseTo(3);
    expect(ends[0].at[0]).toBeGreaterThan(12.65);
  });
});
