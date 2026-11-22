// Gravity through the motion: the force or torque the parts' real weight puts
// on each drive at every position, against known answers, and the checks made
// from it: a lift that nothing holds up, what carries a lift staying with it
// the whole way, a carriage that runs off its guide, a motor or servo that
// cannot hold its arm, and parts that hang free keeping level.

import { describe, expect, it } from "vitest";
import { fullCheck, type FullCheck } from "./helpers/fullcheck";
import type { CheckItem } from "../src/core/checks";
import { massVolume } from "../src/core/model";
import { findHolds } from "../src/core/holds";
import { massBodies } from "../src/core/stability";
import { G, driveLoads, type DriveLoad } from "../src/core/gravityChecks";
import { materialDensity } from "../src/library/standards";

const gravity = (r: FullCheck) => r.report.items.filter((i) => /^(gravity|held):/.test(i.id)).map((i) => `${i.status} ${i.id}`).sort();
const find = (items: CheckItem[], id: string) => {
  const hit = items.find((i) => i.id === id);
  if (!hit) throw new Error(`no ${id} in: ${items.map((i) => i.id).join(", ")}`);
  return hit;
};
const noErrors = (r: FullCheck) => expect(r.model.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);

/** The drives of a design and what gravity puts on them, as the checks work it out. */
async function loadsOf(src: string): Promise<{ loads: DriveLoad[]; grams: (name: string) => number }> {
  const r = await fullCheck(src);
  noErrors(r);
  const mesh = (h: string) => (r.core.get(h) ? r.core.mesh(h, "preview") : undefined);
  const parts = r.model.parts.filter((p) => r.kernel.boxes?.[p.id]);
  const bodies = massBodies(parts, r.kernel.boxes!, mesh, (p) => massVolume(p, r.core.get(p.hash)?.volume, materialDensity(p.material)));
  const loads = driveLoads(r.model, findHolds(r.model, mesh), bodies);
  return { loads, grams: (name) => bodies.filter((b) => b.p.name === name).reduce((a, b) => a + b.g, 0) };
}

// a car that runs 400 mm up a square tower it fits round
const lift = (o: { car?: string; extra?: string; tower?: number; travel?: number; base?: number } = {}) => `
design "lift"
part base { body box(${o.base ?? 300}, ${o.base ?? 300}, 10, at: (0, 0, -10))  held: "bolted to the floor"  material: "Steel" }
part tower { body box(40, 40, ${o.tower ?? 600})  held: "welded to the base"  material: "Steel" }
part car { body box(160, 160, 20, at: (0, 0, 100))  cut box(40.2, 40.2, 40, at: (0, 0, 90))  slides: Z  travel: ${o.travel ?? 400}  material: "Aluminum 6061"  ${o.car ?? ""} }
${o.extra ?? ""}
`;
// a bar that turns on a level pin through one end
const arm = (o: { bar?: string; extra?: string } = {}) => `
design "arm"
part base { body box(100, 100, 10, at: (0, 0, -10))  held: "bolted down"  material: "Steel" }
part post { body box(20, 20, 100, at: (0, 30, 0))  held: "welded to the base"  material: "Steel" }
part arm { body ${o.bar ?? "box(200, 20, 10, at: (100, 0, 100))"}  spin: 1  axis: Y  axis_at: (0, 0, 105)  held: "its pivot pin"  material: "Aluminum 6061" }
${o.extra ?? ""}
`;
const servo = (more = "") => `component s1 = lib.servo("sg90") { at: (0, -20, 105), axis: Y  turns_with: arm  held: "screwed to the post"  ${more} }`;

describe("what gravity puts on a drive", () => {
  it("is a lift's whole weight, the same at every position", async () => {
    const { loads, grams } = await loadsOf(lift());
    expect(loads).toHaveLength(1);
    const d = loads[0];
    expect(d.kind).toBe("lift");
    expect(d.lead.name).toBe("car");
    const weight = (grams("car") / 1000) * G;
    expect(d.mass).toBeCloseTo(grams("car") / 1000, 9);
    expect(weight).toBeGreaterThan(10);
    for (const f of d.load) expect(f).toBeCloseTo(weight, 6);
    // it settles at the bottom, where it is drawn
    expect(d.restDeg).toBe(0);
    expect(d.rise).toBeCloseTo(400, 3);
  });

  it("is weight × lever arm × cos(angle) for a bar on a pin", async () => {
    const { loads, grams } = await loadsOf(arm());
    expect(loads).toHaveLength(1);
    const d = loads[0];
    expect(d.kind).toBe("turn");
    // the bar's centre is 100 mm out along X from the pin
    const peak = (grams("arm") / 1000) * G * 100;
    d.angles.forEach((deg, i) => expect(d.load[i]).toBeCloseTo(-peak * Math.cos((deg * Math.PI) / 180), 3));
    expect(Math.abs(d.peak)).toBeCloseTo(peak, 3);
    expect(d.peakDeg % 180).toBe(0);
    // let go, it hangs straight down
    expect(d.restDeg).toBe(90);
  });

  it("reaches a crank through its rod by the slider's speed (virtual work)", async () => {
    // a 500 g piston on a 20 mm crank and an 80 mm rod; the crank is balanced and the rod weighs nothing
    const { loads } = await loadsOf(`
design "slider crank"
part crank { body cylinder(d: 50, h: 10, at: (0, -5, 0), dir: Y)  spin: 1  axis: Y  held: "its shaft" }
part piston { body cylinder(d: 30, h: 20, at: (0, 0, 90))  slides: Z  mass: 500  held: "its bore" }
part rod { body box(8, 6, 80, at: (0, 0, 20))  links: [crank, piston]  pins: [(0, 0, 20), (0, 0, 100)]  mass: 0.001  held: "its pins" }
`);
    expect(loads).toHaveLength(1);
    const d = loads[0];
    expect(d.lead.name).toBe("crank");
    const r = 20;
    const L = 80;
    // the piston's height above the crank is r·cos a + √(L² − r²·sin² a); the torque is its weight times how
    // fast that changes with the crank's angle
    const want = d.angles.map((deg) => {
      const a = (deg * Math.PI) / 180;
      return 0.5 * G * (-r * Math.sin(a) - (r * r * Math.sin(a) * Math.cos(a)) / Math.sqrt(L * L - r * r * Math.sin(a) ** 2));
    });
    // (which way round counts as positive is the crank's own business)
    const k = d.angles.indexOf(d.peakDeg);
    const sign = Math.sign(d.load[k]) === Math.sign(want[k]) ? 1 : -1;
    const worst = Math.max(...d.load.map((x, i) => Math.abs(x - sign * want[i])));
    // within 0.05 % of the 98 N·mm peak
    expect(worst).toBeLessThan(0.05);
    expect(Math.abs(d.peak)).toBeGreaterThan(95);
  });

  it("leaves a gondola hanging level: its weight acts at its pin, and the gondola needs no holding", async () => {
    const wheel = (gondolas: string) => `
design "wheel"
part stand { body box(40, 10, 150, at: (0, 20, -150))  held: "bolted down"  material: "Steel" }
part wheel { body cylinder(d: 220, h: 6, at: (0, -3, 0), dir: Y)  spin: 1  axis: Y  held: "its axle"  material: "Aluminum 6061" }
${gondolas}
`;
    const gondola = (n: number, x: number) => `part g${n} { body box(20, 10, 30, at: (${x}, -20, -40))  rides: wheel  spin: -1  axis: Y  axis_at: (${x}, 0, 0)  held: "its pin"  material: "Steel" }`;
    // one gondola 100 mm out: the wheel carries its weight at the pin, not at the gondola's own centre below it
    const one = await loadsOf(wheel(gondola(1, 100)));
    const w = one.loads.find((d) => d.lead.name === "wheel")!;
    expect(Math.abs(w.peak)).toBeCloseTo((one.grams("g1") / 1000) * G * 100, 2);
    // and the gondola, hanging under its pin all the way round, has nothing turning it
    const g = one.loads.find((d) => d.lead.name === "g1")!;
    expect(Math.abs(g.peak)).toBeLessThan(0.01);
    // two opposite each other balance
    const two = await loadsOf(wheel(`${gondola(1, 100)}\n${gondola(2, -100)}`));
    expect(Math.abs(two.loads.find((d) => d.lead.name === "wheel")!.peak)).toBeLessThan(0.01);
  });
});

describe("a lift needs something to hold it up", () => {
  it("fails one that only has guides, and says what would carry it", async () => {
    const r = await fullCheck(lift());
    noErrors(r);
    // its guide keeps it in line, so it is not floating: the fault is that nothing carries it
    expect(gravity(r)).toEqual(["fail gravity:falls:car", "pass held:ok"]);
    const f = find(r.report.items, "gravity:falls:car");
    expect(f.title).toBe("Nothing holds car up");
    expect(f.detail).toMatch(/^car weighs 1\.\d+ kg \(1\d N\), and it is free to slide 400 mm up from where it is drawn\./);
    expect(f.fix).toMatch(/lead screw.*belt.*actuator.*rolls_on: car.*held: "hoist rope"; it must carry 1\d N\.$/);
  });

  it("takes a hoist that is not drawn at its word, and says what it must carry", async () => {
    const r = await fullCheck(lift({ car: 'held: "its hoist rope"' }));
    expect(gravity(r)).toEqual(["info gravity:stated:car", "pass held:ok"]);
    expect(find(r.report.items, "gravity:stated:car").detail).toMatch(/held by "its hoist rope", so that must carry 1\d N through all 400 mm of travel/);
  });

  it("fails a carriage that runs off the end of its guide", async () => {
    const r = await fullCheck(lift({ tower: 350, car: 'held: "its hoist rope"' }));
    const f = find(r.report.items, "held:leaves:car");
    expect(f.status).toBe("fail");
    expect(f.title).toBe("car runs off tower");
    // the tower ends at 350 and the car starts at 100: it is off it 250 mm up
    expect(f.detail).toMatch(/travels 400 mm, but 25[01] mm along it leaves tower and from there touches nothing/);
    expect(f.fix).toMatch(/Make tower at least 15\d mm longer/);
  });

  // a rubber drive tyre on the frame, pressed on the side of the car
  const tyre = (z: number) => `part tyre { body cylinder(d: 50, h: 10, at: (104.5, -5, ${z}), dir: Y)  material: "TPU"  axis: Y  axis_at: (104.5, 0, ${z})  spin: 3  rolls_on: car  held: "its motor" }`;

  it("counts a drive tyre only while it stays on the lift", async () => {
    // the tyre meets the 20 mm thick car where it is drawn and nothing else of it: the car climbs off it
    const short = await fullCheck(lift({ extra: tyre(110) }));
    noErrors(short);
    const f = find(short.report.items, "gravity:carried:car");
    expect(f.status).toBe("fail");
    expect(f.title).toBe("tyre lets go of car part way");
    expect(f.detail).toMatch(/The grip of a driven wheel \(tyre\) carries it for the first 1\d mm of its 400 mm travel, then the two part/);
    expect(f.fix).toMatch(/^Give car a face as long as its travel for tyre to run on/);
    // a strip up the car's side as long as the travel keeps the tyre on it all the way
    const long = await fullCheck(lift({ car: "add box(10, 20, 420, at: (75, 0, 100))", extra: tyre(505) }));
    noErrors(long);
    const ok = find(long.report.items, "gravity:carried:car");
    expect(ok.status).toBe("pass");
    expect(ok.title).toBe("car is held up by tyre");
    expect(ok.detail).toMatch(/carried through its 400 mm of travel by the grip of a driven wheel \(tyre\)\. Grip against that weight is not worked out yet/);
  });

  it("does not take a wheel the lift only passes for what carries it", async () => {
    // the tyre is 200 mm up the travel: the car meets it on the way, as a drop ride's platform meets its spinners
    const r = await fullCheck(lift({ car: 'held: "its hoist rope"', extra: tyre(310) }));
    noErrors(r);
    expect(gravity(r)).toEqual(["info gravity:stated:car", "pass held:ok"]);
    expect(find(r.report.items, "roll:ok:tyre|car").status).toBe("pass");
  });

  it("counts a driven wheel on the lift that climbs a part that stays put", async () => {
    const climber = 'part tyre { body cylinder(d: 50, h: 10, at: (44.5, -5, 150), dir: Y)  material: "TPU"  rides: car  spin: 3  axis: Y  axis_at: (44.5, 0, 150)  rolls_on: tower  held: "its motor, on the car" }';
    const r = await fullCheck(lift({ extra: climber }));
    noErrors(r);
    const ok = find(r.report.items, "gravity:carried:car");
    expect(ok.status).toBe("pass");
    expect(ok.detail).toMatch(/by the grip of its own driven wheel \(tyre on tower\)/);
    // a tower that ends early: the wheel runs off its top 200 mm up
    const off = find((await fullCheck(lift({ extra: climber, tower: 350 }))).report.items, "gravity:carried:car");
    expect(off.status).toBe("fail");
    expect(off.detail).toMatch(/carries it for the first 20\d mm of its 400 mm travel/);
    expect(off.fix).toMatch(/^Make tower as long as car's travel where tyre runs on it/);
  });

  // a 50 mm stroke, 300 N linear actuator standing beside the base with its rod under the car
  const actuator = (more = "turns_with: car") => `component act = lib.part("actuonix_p16p_50_256", travel: 0) { at: (60, 0, -1), axis: Z  ${more}  held: "its clevis pin" }`;

  it("holds an actuator to its push and its stroke", async () => {
    const ok = find((await fullCheck(lift({ travel: 40, base: 100, extra: actuator() }))).report.items, "gravity:carried:car");
    expect(ok.status).toBe("pass");
    expect(ok.detail).toMatch(/carried through its 40 mm of travel by its actuator \(act\): \d % of the 300 N it pushes\.$/);
    // 400 mm of travel on 50 mm of stroke
    const far = find((await fullCheck(lift({ base: 100, extra: actuator() }))).report.items, "gravity:carried:car");
    expect(far.status).toBe("fail");
    expect(far.detail).toMatch(/Its actuator \(act\) carries it for the first 50 mm of its 400 mm travel/);
    expect(far.fix).toMatch(/at least 400 mm of stroke \(this one has 50 mm\)/);
    // a 40 kg car on a 300 N actuator
    const heavy = find((await fullCheck(lift({ travel: 40, base: 100, car: "mass: 40000", extra: actuator() }))).report.items, "gravity:carried:car");
    expect(heavy.status).toBe("fail");
    expect(heavy.title).toBe("act cannot lift car");
    expect(heavy.detail).toMatch(/car with act weighs 40\.\d+ kg \(39\d N\), more than the 300 N the actuator pushes at most/);
    // a rod that is not fixed to the car is left behind
    const loose = find((await fullCheck(lift({ travel: 40, base: 100, extra: actuator("") }))).report.items, "gravity:carried:car");
    expect(loose.status).toBe("fail");
    expect(loose.title).toBe("act does not go with car");
    expect(loose.fix).toMatch(/^Fix the end of the actuator's rod to car/);
  });

  it("leaves a level slide alone: there is no weight along its travel", async () => {
    const r = await fullCheck(lift().replace("slides: Z", "slides: X").replace("cut box(40.2, 40.2, 40, at: (0, 0, 90))", "").replace("box(160, 160, 20, at: (0, 0, 100))", "box(60, 60, 20, at: (0, 0, 600))"));
    expect(r.report.items.filter((i) => i.id.startsWith("gravity:"))).toEqual([]);
  });
});

describe("a part that turns out of balance needs something to hold it", () => {
  it("says so when nothing is on its shaft", async () => {
    const r = await fullCheck(arm());
    noErrors(r);
    const f = find(r.report.items, "gravity:free:arm");
    expect(f.status).toBe("info");
    expect(f.detail).toMatch(/^arm weighs 10\d g and is free to turn\. Its weight puts up to 0\.1\d N·m on arm's shaft \(with the drive at 0°\), and no motor or servo is on it, so let go it swings round to rest with the drive at 90°\.$/);
    expect(f.fix).toMatch(/turns_with: arm/);
  });

  it("holds a servo to the weight on it at the worst position", async () => {
    // 108 g with its centre 100 mm out: 0.11 N·m on a 0.18 N·m micro servo
    const hard = find((await fullCheck(arm({ extra: servo() }))).report.items, "gravity:motor:s1");
    expect(hard.status).toBe("warn");
    expect(hard.title).toBe("s1 works hard holding arm");
    expect(hard.detail).toMatch(/The weight of arm \(10\d g\) puts up to 0\.11 N·m on s1, with the drive at 0°: 6\d % of its 0\.18 N·m stall torque/);
    // a 60 mm bar is easy for it
    const easy = find((await fullCheck(arm({ bar: "box(60, 20, 10, at: (30, 0, 100))", extra: servo() }))).report.items, "gravity:motor:s1");
    expect(easy.status).toBe("pass");
    expect(easy.detail).toMatch(/: \d % of its 0\.18 N·m stall torque\.$/);
    // a 400 mm steel bar is beyond it
    const no = find((await fullCheck(arm({ bar: "box(400, 20, 10, at: (200, 0, 100))", extra: servo() }).replace('"Aluminum 6061" }\n\ncomponent', '"Steel" }\n\ncomponent'))).report.items, "gravity:motor:s1");
    expect(no.status).toBe("fail");
    expect(no.title).toBe("s1 cannot hold arm up");
    expect(no.fix).toMatch(/calc\.motor_select\(\)/);
  });

  it("warns when a motor's load: is lighter than the weight alone", async () => {
    const r = await fullCheck(arm({ extra: servo("load: 20") }));
    const f = find(r.report.items, "gravity:load:s1");
    expect(f.status).toBe("warn");
    expect(f.detail).toMatch(/puts up to 0\.11 N·m on s1, with the drive at 0°, but its load: is 20 N·mm/);
    // a load: that covers the weight is the motor checks' business
    const ok = await fullCheck(arm({ extra: servo("load: 150") }));
    expect(ok.report.items.filter((i) => i.id.startsWith("gravity:"))).toEqual([]);
  });

  it("has nothing to say about a balanced rotor", async () => {
    const r = await fullCheck(arm({ bar: "box(200, 20, 10, at: (0, 0, 100))" }));
    expect(r.report.items.filter((i) => i.id.startsWith("gravity:"))).toEqual([]);
  });
});
