// What the cable card says about a cable: both ends (part, pin, connector, which way it goes in, how it latches,
// the firmware pin), the current it carries against its rating, the circuit it is on, and the cut list.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "../src/lang/evaluator";
import { buildHarness } from "../src/machine/harness/harness";
import { cableDetails, cableLoads, circuitOf, cutListCsv } from "../src/machine/harness/details";
import { plugGuide } from "../src/machine/harness/plugGuide";
import type { PlugKind } from "../src/machine/harness/plugs";

const demo = (name: string) => evaluate(readFileSync(join(__dirname, `../src/demos/${name}.kerf`), "utf8"));

describe("cable details", () => {
  const printer = demo("printer");
  const ph = buildHarness(printer);
  const pm = printer.machine!;
  const at = (from: string, to: string) => {
    const w = ph.wires.find((w) => `${w.ends[0].comp}.${w.ends[0].pin}` === from && `${w.ends[1].comp}.${w.ends[1].pin}` === to);
    if (!w) throw new Error(`no cable ${from} to ${to}`);
    return cableDetails(pm, ph, w);
  };

  it("describes both ends of every printer cable", () => {
    for (const w of ph.wires) {
      const d = cableDetails(pm, ph, w);
      expect(d.ends).toHaveLength(2);
      for (const e of d.ends) {
        expect(e.connector.length).toBeGreaterThan(2);
        expect(e.approach.length).toBeGreaterThan(2);
        expect(e.guide.make.length).toBeGreaterThan(2);
        expect(e.guide.mate.length).toBeGreaterThan(2);
        // the contacts this cable lands on are marked in the housing's row
        expect(e.contacts.some((c) => c.mine)).toBe(true);
      }
      expect(d.steps.length).toBeGreaterThan(0);
    }
  });

  it("names the stepper plug, its latch, its contacts and the firmware pins", () => {
    const x = at("skr.XM", "x_motor.PLUG");
    const [board, motor] = x.ends;
    expect(board.connector).toMatch(/JST XH 2\.5 mm, 4-way/);
    expect(board.latch).toBeTruthy();
    expect(board.contacts.map((c) => c.label)).toEqual(["black", "green", "red", "blue"]);
    expect(board.firmware).toMatch(/step PB13/);
    expect(board.guide.make).toMatch(/XHP-4/);
    // the motor's end cap is a 6-way PH with two empty places
    expect(motor.connector).toMatch(/JST PH 2\.0 mm, 6-way/);
    expect(motor.contacts.filter((c) => c.mine)).toHaveLength(4);
    expect(x.amps).toBeGreaterThan(1);
  });

  it("follows the supply current through the fuse and back on the ground", () => {
    const supply = at("psu.V_PLUS", "fuse.IN");
    const board = at("fuse.OUT", "skr.POWER");
    const buck = at("fuse.OUT", "buck.IN_POS");
    const back = at("psu.V_MINUS", "skr.POWER_GND");
    expect(supply.volts).toBe(24);
    // what comes into the fuse goes out on its two cables
    expect(supply.amps!).toBeCloseTo(board.amps! + buck.amps!, 3);
    // the board's current comes back on its ground
    expect(back.amps!).toBeCloseTo(board.amps!, 3);
    // the bed heater is the big load, and nothing is over its rating
    expect(board.amps!).toBeGreaterThan(8);
    for (const [, l] of cableLoads(pm, ph)) if (l.amps !== undefined && l.rating !== undefined) expect(l.amps).toBeLessThanOrEqual(l.rating);
  });

  it("lights the circuit supply to ground", () => {
    const board = ph.wires.find((w) => w.ends[1].comp === "skr" && w.ends[1].pin === "POWER")!;
    const ground = ph.wires.find((w) => w.ends[1].comp === "skr" && w.ends[1].pin === "POWER_GND")!;
    const lit = circuitOf(ph, board.id);
    expect(lit).toContain(board.id);
    expect(lit).toContain(ground.id);
    // a signal cable is not part of the 24 V circuit
    const stop = ph.wires.find((w) => w.ends[0].pin === "XSTOP")!;
    expect(lit).not.toContain(stop.id);
  });

  it("carries the same current through a switch in series", () => {
    const amp = demo("practice-amp");
    const h = buildHarness(amp);
    const sw = h.wires.filter((w) => w.ends.some((e) => e.comp === "power_sw"));
    expect(sw).toHaveLength(2);
    const [a, b] = sw.map((w) => cableDetails(amp.machine!, h, w).amps!);
    expect(a).toBeGreaterThan(1);
    expect(a).toBeCloseTo(b, 6);
  });

  it("writes a cut list with a line per cable", () => {
    const csv = cutListCsv(pm, ph, undefined).trim().split("\n");
    expect(csv[0]).toMatch(/^Wire,Net,Carries,Gauge \(AWG\),Colour,Cut \(mm\),From/);
    expect(csv).toHaveLength(ph.wires.length + 1);
    // a value that a spreadsheet would run as a formula is kept as text
    for (const line of csv.slice(1)) for (const cell of line.split(",")) expect(cell).not.toMatch(/^[=+@]/);
  });

  it("explains how to make, fit and unplug every kind of plug", () => {
    const kinds: PlugKind[] = ["xh", "ph", "dupont", "ferrule", "fork", "ring", "usb_c", "usb_micro", "usb_a", "xt60", "lead", "solder", "lug", "barrel", "spade", "sh", "lever", "bare", "ufl"];
    for (const k of kinds) {
      const g = plugGuide(k, 3, 20);
      for (const s of [g.make, g.mate, g.hold, g.unplug]) expect(s.length, k).toBeGreaterThan(3);
    }
    expect(plugGuide("ferrule", 1, 14).make).toMatch(/2\.5 mm²/);
  });
});
