// The checks that catch what a quick model most often gets wrong, each with a
// fix it can apply in one go: moving parts that collide or rub through their
// motion, designs that fall over, overlaps with how far to move what, and
// wiring that resets the controller, reuses a pin or clashes on the I2C bus.

import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { machineChecks } from "../src/machine/checks";
import { fullCheck } from "./helpers/fullcheck";
import type { CheckItem } from "../src/core/checks";

const pick = (items: CheckItem[], prefix: RegExp) => items.filter((i) => prefix.test(i.id)).map((i) => `${i.status} ${i.id}`);
const find = (items: CheckItem[], id: string) => items.find((i) => i.id === id)!;

// an arm turning about Z at the origin, 100 mm long, and a post beside it
const arm = (post: string) => `
design "arm"
part base { body box(240, 240, 10, at: (0, 0, -10)) }
part post { body box(10, 10, 60, at: ${post}) }
part arm { body box(100, 10, 8, at: (50, 0, 20))  spin: 1  axis: Z }
`;

describe("moving parts swept through their motion", () => {
  it("fails a turning arm that hits a post on the way round, saying how far out to move it", async () => {
    const { report } = await fullCheck(arm("(60, 40, 0)"));
    expect(pick(report.items, /^sweep:/)).toEqual(["fail sweep:hit:arm|post"]);
    const hit = find(report.items, "sweep:hit:arm|post");
    expect(hit.detail).toMatch(/At 3\d° into arm's turn, arm runs \d+(\.\d)? mm into post near \((5\d|6\d)\.?\d*, (4\d|5\d)/);
    expect(hit.detail).toMatch(/clear where they are drawn/);
    // the arm reaches 100.1 mm from the axis, the post's nearest corner is 65.2 mm from it
    expect(hit.fix).toMatch(/sweeps out to 100\.1 mm.*comes in to 65\.2 mm.*at least 101\.1 mm from the axis/);
  }, 60_000);

  it("warns when the arm only grazes a post it is well clear of at rest", async () => {
    const { report } = await fullCheck(arm("(0, 105.05, 0)"));
    expect(pick(report.items, /^sweep:/)).toEqual(["warn sweep:rub:arm|post"]);
    expect(find(report.items, "sweep:rub:arm|post").detail).toMatch(/well clear of post as drawn but comes into contact with it at 90° into arm's turn/);
  }, 60_000);

  it("passes a post the arm clears", async () => {
    const { report } = await fullCheck(arm("(0, 120, 0)"));
    expect(pick(report.items, /^sweep:/)).toEqual(["pass sweep:ok"]);
  }, 60_000);

  it("knows a round shaft turning in its bore changes nothing", async () => {
    const { report } = await fullCheck(`
design "shaft"
part frame { body box(60, 60, 10)  cut cylinder(d: 10.4, h: 20, at: (0, 0, -5)) }
part shaft { body cylinder(d: 10, h: 40, at: (0, 0, -15))  spin: 1  axis: Z }
`);
    expect(pick(report.items, /^sweep:/)).toEqual(["pass sweep:ok"]);
  }, 60_000);

  it("fails a piston that runs into a part below it at the bottom of its stroke", async () => {
    const { report } = await fullCheck(`
design "piston"
part crank { body cylinder(d: 50, h: 10, at: (0, -5, 0), dir: Y)  spin: 1  axis: Y }
part piston { body cylinder(d: 30, h: 20, at: (0, 0, 90))  slides: Z }
part rod { body box(8, 6, 80, at: (0, 0, 20))  links: [crank, piston]  pins: [(0, 0, 20), (0, 0, 100)] }
part stop { body box(15, 10, 5, at: (17.5, 0, 55)) }
`);
    const hit = find(report.items, "sweep:hit:piston|stop");
    expect(hit.status).toBe("fail");
    // bottom dead centre is half a turn of the crank from where it is drawn
    expect(hit.detail).toMatch(/At 1[5-9]\d° into crank's turn, piston runs \d/);
    expect(hit.fix).toMatch(/Move stop at least \d+(\.\d)? mm clear of piston's path/);
  }, 60_000);
});

describe("standing up", () => {
  const tower = (extra = "", brief = "") => `
design "tower"
${brief}
part base { body box(40, 40, 10)${extra} }
part tower { body box(20, 20, 300, at: (0, 0, 10)) }
part weight { body box(200, 40, 40, at: (90, 0, 310))  material: "Steel" }
part fan { body box(10, 10, 10, at: (0, 0, 350))  spin: 1  axis: Z }
`;

  it("fails a design whose centre of mass is outside its feet, saying which way and how much wider", async () => {
    const { report } = await fullCheck(tower());
    const tip = find(report.items, "tip:falls");
    expect(tip.status).toBe("fail");
    expect(tip.detail).toMatch(/318 mm up and 64 mm outside the footprint.*falls toward \+X/);
    expect(tip.fix).toMatch(/Widen the footprint toward \+X by at least 120 mm.*weight \(2\.51 kg, 330 mm up\)/);
    expect(tip.fix).not.toMatch(/fan/);
  }, 60_000);

  it("leaves a design that is bolted down, or whose brief says it is fixed in place", async () => {
    expect(pick((await fullCheck(tower(`  held: "bolted to the bench"`))).report.items, /^tip:/)).toEqual([]);
    expect(pick((await fullCheck(tower("", `brief {\n  setting: "Screwed to the wall above the bench"\n}`))).report.items, /^tip:/)).toEqual([]);
  }, 120_000);
});

describe("overlaps", () => {
  it("says how far to move which part, or that one is a copy or sunk in the other", async () => {
    const { report } = await fullCheck(`
design "overlap"
part a { body box(40, 40, 10) }
part b { body box(40, 40, 10, at: (0, 0, 8)) }
part c { body box(40, 40, 10, at: (100, 0, 0)) }
part d { body box(40, 40, 10, at: (100, 0, 0)) }
part e { body box(100, 100, 20, at: (0, 200, 0)) }
part f { body cylinder(d: 10, h: 10, at: (0, 200, 5)) }
`);
    expect(find(report.items, "int:a|b").fix).toMatch(/40 × 40 × 2 mm region.*2 mm deep along Z\. Move a 2\.1 mm along -Z \(or b along \+Z\)/);
    expect(find(report.items, "int:c|d").fix).toMatch(/the same shape in the same place: one is a copy/);
    expect(find(report.items, "int:e|f").fix).toMatch(/f sits wholly inside e.*cut f from e/);
  }, 60_000);
});

describe("wiring that only fails once it runs", () => {
  const base = `
design "x"
component ctrl = lib.controller("arduino_nano") { at: (0, 0, 0) }
`;
  const erc = (src: string) => {
    const m = evaluate(base + src);
    expect(m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
    return machineChecks(m.machine!);
  };

  it("fails two I2C devices at the same address on one bus", () => {
    const items = erc(`
component imu1 = lib.sensor("mpu6050") { at: (0, 50, 0) }
component imu2 = lib.sensor("mpu6050") { at: (0, 80, 0) }
net SDA: ctrl.A4, imu1.SDA, imu2.SDA
net SCL: ctrl.A5, imu1.SCL, imu2.SCL
net V5: ctrl.V5, imu1.VCC, imu2.VCC
net GND: ctrl.GND, imu1.GND, imu2.GND
`);
    const clash = items.find((i) => /^erc:i2c-addr:/.test(i.id))!;
    expect(clash.title).toBe("Two I2C devices at address 0x68");
    expect(clash.fix).toMatch(/second I2C bus.*address pin or jumper.*multiplexer/);
  });

  it("fails a servo on the controller's own 5 V pin: it resets the board each time it starts", () => {
    const items = erc(`
component s = lib.servo("mg996r") { at: (0, 50, 0) }
wire ctrl.V5 -> s.V_PLUS
wire ctrl.GND -> s.GND
wire ctrl.D9 -> s.SIG
`);
    const surge = items.find((i) => /^erc:surge:/.test(i.id))!;
    expect(surge.status).toBe("fail");
    expect(surge.detail).toMatch(/s draws about 2\.5 A from ctrl\.V5.*resets every time it starts/);
    expect(surge.fix).toMatch(/BEC or buck converter rated for 3 A.*join its ground/);
    expect(items.find((i) => /^erc:budget:/.test(i.id))?.fix).toMatch(/supply of their own/);
  });

  it("fails a pin used for two signals, naming free pins to move one to", () => {
    const items = erc(`
component s = lib.servo("mg996r") { at: (0, 50, 0) }
component imu1 = lib.sensor("mpu6050") { at: (0, 80, 0) }
wire ctrl.D9 -> s.SIG
wire ctrl.D9 -> imu1.INT
net GND: ctrl.GND, s.GND, imu1.GND
`);
    const twice = items.find((i) => /^erc:twice:/.test(i.id))!;
    expect(twice.status).toBe("fail");
    expect(twice.title).toBe("ctrl.D9 is used for two signals");
    expect(twice.fix).toMatch(/Give s\.SIG a pin of its own on ctrl \(free pins: D2, D3/);
  });
});
