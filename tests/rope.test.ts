// Ropes, winch drums and sheaves (lib.rope): the path a taut rope takes, the
// drum and sheave it reads from a part's own shape, and the checks that follow
// it through the motion: taut all the way, turns left on the drum, sheaves big
// enough, fleet angle, strength, and what holds the drum against the pull.

import { describe, expect, it } from "vitest";
import { fullCheck, problems, type FullCheck } from "./helpers/fullcheck";
import type { CheckItem } from "../src/core/checks";
import type { MeshEntry } from "../src/core/engine";
import { massVolume } from "../src/core/model";
import { materialDensity } from "../src/library/standards";
import { LetGoRun, letGoLine, planLetGo, type LetGoPlan } from "../src/sim/mech/letGo";
import { ropeLineAt } from "../src/machine/ropes";

const noErrors = (r: FullCheck) => expect(r.model.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
const find = (items: CheckItem[], id: string) => {
  const f = items.find((i) => i.id === id);
  if (!f) throw new Error(`no ${id} in ${items.map((i) => i.id).filter((i) => /rope|gravity|held/.test(i)).join(", ")}`);
  return f;
};
// a car on a tower, raised by a rope from a drum at the foot, up over a sheave at the head and down to the car
const hoist = (o: { rope?: string; car?: string; carAt?: number; travel?: number; top?: number; drum?: string; tie?: string; more?: string; args?: string; lifts?: boolean; material?: string } = {}) => `
design "hoist"
part base { body box(300, 400, 10, at: (0, 40, -10))  held: "bolted to the floor"  material: "Steel" }
part tower { body box(40, 40, 700)  held: "welded to the base"  material: "Steel" }
part car { body box(160, 160, 20, at: (0, 0, ${o.carAt ?? 100}))  cut box(40.2, 40.2, 40, at: (0, 0, ${(o.carAt ?? 100) - 10}))  slides: Z  travel: ${o.travel ?? 400}  material: "${o.material ?? "Aluminum 6061"}"  ${o.car ?? ""} }
part top { body cylinder(${o.top ?? 72}, 10, at: (-5, ${60 + (o.top ?? 72) / 2 + 1.5}, 650), dir: X)  held: "its axle"  material: "Nylon" }
part drum { body cylinder(72, 30, at: (-15, ${60 + (o.top ?? 72) + 3 - 37.5}, 45), dir: X)  ${o.drum ?? "spin: 1"}  axis: X  axis_at: (0, ${60 + (o.top ?? 72) + 3 - 37.5}, 45)  held: "its shaft"  material: "Aluminum 6061" }
component hoist = lib.rope("${o.rope ?? "wire_rope_7x19_3mm"}", path: [drum, top, ${o.tie ?? `(0, 60, ${(o.carAt ?? 100) + 20})`}]${o.lifts === false ? "" : ", lifts: car"}${o.args ?? ""})
${o.more ?? ""}
`;
const motor = (id: string) => `component m1 = lib.gearmotor("${id}") { at: (-45, 97.5, 45), axis: X  turns_with: drum  held: "screwed to its bracket" }`;

// two parts of rope: up from the drum, over the head sheave, down round a sheave on the car and up to the head
const reeved = `
design "reeved"
part base { body box(300, 500, 10, at: (0, 90, -10))  held: "bolted to the floor"  material: "Steel" }
part tower { body box(40, 40, 700)  held: "welded to the base"  material: "Steel" }
part head { body box(40, 70, 20, at: (0, 55, 680))  held: "welded to the tower"  material: "Steel" }
part car { body box(160, 160, 20, at: (0, 0, 100))  cut box(40.2, 40.2, 40, at: (0, 0, 90))  slides: Z  travel: 400  material: "Aluminum 6061" }
part block { body cylinder(72, 10, at: (-5, 65, 160), dir: X)  rides: car  held: "its axle on the car"  material: "Nylon" }
part top { body cylinder(72, 10, at: (-5, 140, 650), dir: X)  held: "its axle"  material: "Nylon" }
part drum { body cylinder(72, 30, at: (-15, 140, 45), dir: X)  spin: 1  axis: X  axis_at: (0, 140, 45)  held: "its shaft"  material: "Aluminum 6061" }
component hoist = lib.rope("wire_rope_7x19_3mm", path: [drum, top, block, (0, 27.5, 680)], lifts: car)
`;
// a weight on a rope from a beam, nothing moving
const hung = (o: { tie?: string; top?: string } = {}) => `
design "hung"
part post { body box(40, 40, 400)  held: "bolted to the floor"  material: "Steel" }
part beam { body box(40, 240, 20, at: (0, 100, 400))  held: "welded to the post"  material: "Steel" }
part weight { body box(60, 60, 60, at: (0, 150, 100))  material: "Steel" }
component line = lib.rope("dyneema_3mm", path: [${o.top ?? "(0, 150, 400)"}, ${o.tie ?? "(0, 150, 160)"}])
`;
// a boom on a pin at its foot, held up by a rope from its tip to the top of a mast
const boom = (drum = "") => `
design "boom"
part base { body box(300, 100, 10, at: (100, 0, -10))  held: "bolted down"  material: "Steel" }
part mast { body box(20, 20, 400)  held: "welded to the base"  material: "Steel" }
part boom { body box(300, 16, 16, at: (160, 0, 40))  spin: 0.2  axis: Y  axis_at: (10, 0, 48)  held: "its pivot pin"  material: "Aluminum 6061" }
${drum}
component stay = lib.rope("dyneema_2mm", path: [${drum ? "reel" : "(0, 0, 400)"}, (300, 0, 56)])
`;

// the same hoist from the library's own drum and sheave
const bought = `
design "bought"
part base { body box(300, 400, 10, at: (0, 40, -10))  held: "bolted to the floor"  material: "Steel" }
part tower { body box(40, 40, 700)  held: "welded to the base"  material: "Steel" }
part car { body box(160, 160, 20, at: (0, 0, 100))  cut box(40.2, 40.2, 40, at: (0, 0, 90))  slides: Z  travel: 400  material: "Aluminum 6061" }
component top = lib.sheave(tread: 72, rope: 3) { at: (-4.13, 97.5, 650), axis: X  held: "its axle" }
component drum = lib.drum(d: 72, width: 30, rope: 3) { at: (-19.32, 97.5, 45), axis: X  spin: 1  held: "its shaft" }
component hoist = lib.rope("wire_rope_7x19_3mm", path: [drum, top, (0, 60, 120)], lifts: car)
`;

const SLOW = 60000;
const G = 9.80665;

/** The design as "Let go" sets it up: what holds each joint, and what it raises first. */
async function letGo(src: string): Promise<LetGoPlan> {
  const r = await fullCheck(src);
  noErrors(r);
  const mesh = (h: string) => (r.core.get(h) ? r.core.mesh(h, "preview") : undefined);
  const geom = (h: string): MeshEntry | undefined => {
    const e = r.core.get(h);
    return e ? { preview: r.core.mesh(h, "preview"), volume: e.volume, bbox: [[0, 0, 0], [0, 0, 0]], rev: 0 } : undefined;
  };
  const p = planLetGo(r.model, geom, r.kernel, mesh, (q) => massVolume(q, r.core.get(q.hash)?.volume, materialDensity(q.material)));
  if (!p || "error" in p) throw new Error(p ? p.error : "nothing to let go");
  return p;
}
/** Runs it to rest; `down` is when the car reached the bottom of its travel, s. */
function settle(p: LetGoPlan): { run: LetGoRun; down: number } {
  const run = new LetGoRun(p);
  let down = -1;
  for (let t = 0; t < 20 && !run.settled; t += 0.001) {
    run.advance(0.001);
    if (down < 0 && run.sys.joints.get("car")!.coord < 0.001) down = run.t;
  }
  return { run, down };
}

describe("a rope from a winch drum", () => {
  it("works out the lift's travel per turn, stays taut and counts the turns on the drum", async () => {
    const r = await fullCheck(hoist());
    noErrors(r);
    // one turn of a 72 mm drum with 3 mm rope winds 2π × 37.5 mm
    const car = r.model.parts.find((p) => p.name === "car")!;
    expect(car.motion!.perTurn).toBeCloseTo(2 * Math.PI * 37.5, 2);
    const rope = r.model.machine!.ropes[0];
    expect(rope.nodes.map((n) => n.kind)).toEqual(["drum", "sheave", "tie"]);
    expect(rope.cutLength).toBe(2050);
    const path = find(r.report.items, "rope:path:hoist");
    expect(path.status).toBe("pass");
    expect(path.title).toBe("hoist runs from drum to a tie on car");
    expect(path.detail).toMatch(/buy 2050 mm, which leaves 90 mm at each tied end/);
    const run = find(r.report.items, "rope:run:hoist");
    expect(run.status).toBe("pass");
    expect(run.detail).toMatch(/^The path takes up 400 mm of rope through the motion, and the drum winds exactly that/);
    // three turns as drawn, and the 400 mm it winds in adds 1.7
    const drum = find(r.report.items, "rope:drum:hoist:drum");
    expect(drum.status).toBe("warn");
    expect(drum.title).toBe("drum has no flanges");
    expect(drum.detail).toMatch(/between 3 and 4\.7 turns/);
    expect(find(r.report.items, "rope:bend:hoist").status).toBe("pass");
    expect(find(r.report.items, "rope:fleet:hoist").status).toBe("pass");
    // the rope touches what it runs on and is tied to, and is not swept against the car it moves with
    expect(problems(r.report).filter((x) => /^(int|sweep|held)/.test(x))).toEqual([]);
  }, SLOW);

  it("turns the drum the way its rope runs, whichever way spin: is written", async () => {
    for (const drum of ["spin: 1", "spin: -1", "spin: 2.5"]) {
      const r = await fullCheck(hoist({ drum }));
      noErrors(r);
      expect(find(r.report.items, "rope:run:hoist").status).toBe("pass");
    }
    const fast = await fullCheck(hoist({ drum: "spin: 2.5" }));
    expect(fast.model.parts.find((p) => p.name === "car")!.motion!.perTurn).toBeCloseTo(2.5 * 2 * Math.PI * 37.5, 2);
  }, SLOW);

  it("fails a travel per turn that does not match what the drum winds, with the figure that does", async () => {
    const r = await fullCheck(hoist({ car: "per_turn: 100" }));
    const run = find(r.report.items, "rope:run:hoist");
    expect(run.status).toBe("fail");
    expect(run.title).toBe("hoist would have to stretch as it moves");
    expect(run.fix).toMatch(/^Set per_turn: 235\.6\d on car \(one turn of drum winds 235\.6 mm of rope\)/);
  }, SLOW);

  it("pays rope out for a lift drawn at the top, and fails a drum that runs out", async () => {
    const down = (args = "") => hoist({ carAt: 500, travel: -400, args });
    // left to Kerf: three turns stay on at the bottom
    const auto = find((await fullCheck(down())).report.items, "rope:drum:hoist:drum");
    expect(auto.detail).toMatch(/between 3\.\d and 4\.\d turns/);
    const two = find((await fullCheck(down(", wraps: 2"))).report.items, "rope:drum:hoist:drum");
    expect(two.status).toBe("fail");
    expect(two.title).toBe("hoist leaves under two turns on drum");
    expect(two.fix).toMatch(/^Give the rope wraps: 5 /);
    const one = find((await fullCheck(down(", wraps: 1"))).report.items, "rope:drum:hoist:drum");
    expect(one.status).toBe("fail");
    expect(one.title).toBe("hoist runs out on drum");
  }, SLOW);

  it("halves the pull and doubles the rope with a sheave on the load", async () => {
    const r = await fullCheck(reeved);
    noErrors(r);
    expect(r.model.parts.find((p) => p.name === "car")!.motion!.perTurn).toBeCloseTo(Math.PI * 37.5, 2);
    expect(find(r.report.items, "rope:run:hoist").detail).toMatch(/^The path takes up 800 mm of rope/);
    const load = find(r.report.items, "rope:load:hoist");
    expect(load.detail).toMatch(/^car and what moves with it weigh 1\.34 kg, shared by 2 parts of rope, which puts 6\.6 N in the rope\./);
    expect(find(r.report.items, "rope:drum:hoist:drum").detail).toMatch(/between 3 and 6\.4 turns/);
    expect(problems(r.report).filter((x) => /^(int|sweep|held)/.test(x))).toEqual([]);
  }, SLOW);
});

describe("what holds a winch", () => {
  it("fails a drum nothing holds: the load unwinds it", async () => {
    const r = await fullCheck(hoist());
    const f = find(r.report.items, "gravity:falls:car");
    expect(f.status).toBe("fail");
    expect(f.title).toBe("Nothing stops drum unwinding, so car falls");
    expect(f.detail).toMatch(/^car weighs 1\.3 kg \(13 N\)\. hoist carries that to drum: 0\.48 N·m about drum \(13 N at 37\.5 mm from its axis\)\./);
    expect(f.fix).toMatch(/turns_with: drum/);
  }, SLOW);

  it("takes a ratchet that is not drawn at the design's word", async () => {
    const r = await fullCheck(hoist({ car: 'held: "ratchet on the winch"' }));
    const f = find(r.report.items, "gravity:stated:car");
    expect(f.status).toBe("info");
    expect(f.detail).toMatch(/Nothing drawn holds drum against it, and the design says car is held by "ratchet on the winch"/);
    expect(r.report.items.some((i) => i.id === "gravity:falls:car")).toBe(false);
  }, SLOW);

  it("checks the winch motor against the rope's pull at the drum", async () => {
    // 13 N at 37.5 mm is 0.48 N·m: easy for 2.65 N·m of stall, hard for 0.79
    const easy = await fullCheck(hoist({ more: motor("pololu_37d_70") }));
    noErrors(easy);
    const carried = find(easy.report.items, "gravity:carried:car");
    expect(carried.status).toBe("pass");
    expect(carried.detail).toBe("car weighs 1.3 kg (13 N), carried through its 400 mm of travel by its rope: 13 N in hoist. drum is held against that by m1, checked on its own.");
    const m = find(easy.report.items, "gravity:motor:m1");
    expect(m.status).toBe("pass");
    expect(m.title).toBe("m1 holds car up");
    expect(m.detail).toBe("The pull of hoist on drum (13 N at 37.5 mm from its axis), which is the weight of car, puts up to 0.48 N·m on m1: 18 % of its 2.65 N·m stall torque.");
    const hard = find((await fullCheck(hoist({ more: motor("pololu_37d_19") }))).report.items, "gravity:motor:m1");
    expect(hard.status).toBe("warn");
    expect(hard.title).toBe("m1 works hard holding car");
    expect(hard.detail).toMatch(/61 % of its 0\.79 N·m stall torque/);
    // a steel car is beyond it: the motor fails and nothing else says the car is held
    const steel = await fullCheck(hoist({ material: "Steel", more: motor("pololu_37d_19") }));
    const no = find(steel.report.items, "gravity:motor:m1");
    expect(no.status).toBe("fail");
    expect(no.title).toBe("m1 cannot hold car up");
    expect(no.detail).toMatch(/puts up to 1\.38 N·m on m1: more than its 0\.79 N·m stall torque\. It stalls there, and lets car fall\.$/);
    expect(steel.report.items.some((i) => i.id === "gravity:carried:car")).toBe(false);
  }, SLOW);

  it("holds a boom on a stay tied at both ends, and says the stay stops it swinging", async () => {
    const r = await fullCheck(boom());
    noErrors(r);
    const held = find(r.report.items, "gravity:carried:boom");
    expect(held.status).toBe("pass");
    expect(held.detail).toMatch(/stay holds it there with up to 1\.9 N in the rope\. Both its ends are tied\.$/);
    const run = find(r.report.items, "rope:run:stay");
    expect(run.status).toBe("fail");
    expect(run.fix).toMatch(/^Both ends are tied, so the path must stay the same length as the parts move/);
  }, SLOW);
});

describe("a rope's strength and what it runs on", () => {
  it("sets the pull against a fifth of the breaking load", async () => {
    const ok = find((await fullCheck(hoist())).report.items, "rope:load:hoist");
    expect(ok.status).toBe("pass");
    expect(ok.title).toBe("hoist carries 13 N, 1 % of its working load");
    expect(ok.detail).toMatch(/^car weighs 1\.3 kg, which puts 13 N in the rope\. Stainless wire rope 7x19, 3 mm breaks at 4\.69 kN, and ropes are worked at a fifth of that: 938 N here/);
    // 2 kN on 2 mm 7x7, which breaks at 2.24 kN
    const weak = find((await fullCheck(hoist({ rope: "wire_rope_7x7_2mm", args: ", pull: 2000N" }))).report.items, "rope:load:hoist");
    expect(weak.status).toBe("fail");
    expect(weak.title).toBe("hoist is far too weak for 2 kN");
    expect(weak.fix).toMatch(/^Use a rope that breaks at 10 kN or more/);
  }, SLOW);

  it("holds each rope to the smallest pulley its maker's table allows", async () => {
    // 7x19 wants 24 diameters: 72 mm for 3 mm rope
    const fits = find((await fullCheck(hoist())).report.items, "rope:bend:hoist");
    expect(fits.status).toBe("pass");
    expect(fits.detail).toMatch(/The smallest it runs on is 24 times its 3 mm diameter/);
    const thick = find((await fullCheck(hoist({ rope: "wire_rope_7x19_6mm" }))).report.items, "rope:bend:hoist");
    expect(thick.status).toBe("warn");
    expect(thick.fix).toMatch(/^Make drum and top at least 144 mm where the rope sits/);
    // under half the recommended size fails
    const tiny = await fullCheck(hoist({ top: 30, args: ", flip: [top]" }));
    noErrors(tiny);
    const small = find(tiny.report.items, "rope:bend:hoist");
    expect(small.status).toBe("fail");
    expect(small.detail).toMatch(/^top is 30 mm where the rope sits, 10 times the rope's 3 mm\./);
    // Dyneema runs on eight diameters
    expect(find((await fullCheck(hoist({ top: 30, rope: "dyneema_3mm", args: ", flip: [top]" }))).report.items, "rope:bend:hoist").status).toBe("pass");
  }, SLOW);

  it("fails a rope that leads off its sheave at an angle", async () => {
    const r = await fullCheck(hoist({ tie: "(30, 60, 120)" }));
    const f = find(r.report.items, "rope:fleet:hoist");
    expect(f.status).toBe("fail");
    expect(f.detail).toMatch(/^It meets top 13° off square\./);
  }, SLOW);

  it("fails an end tied to nothing", async () => {
    const r = await fullCheck(hoist({ tie: "(200, 60, 120)", lifts: false }));
    const f = find(r.report.items, "rope:tie:hoist:end");
    expect(f.status).toBe("fail");
    expect(f.title).toBe("hoist is tied to nothing at its last end");
    // with no load Kerf can work out, it says so and gives the working load
    expect(find(r.report.items, "rope:noload:hoist").detail).toMatch(/Its working load is 938 N/);
  }, SLOW);
});

describe("a weight hanging on a rope", () => {
  it("is held, with its weight in the rope", async () => {
    const r = await fullCheck(hung());
    noErrors(r);
    expect(problems(r.report)).toEqual([]);
    const f = find(r.report.items, "rope:hang:line:weight");
    expect(f.status).toBe("pass");
    expect(f.detail).toBe("weight (1.7 kg) hangs on one part of the rope and nothing else, which puts 17 N in it.");
    expect(find(r.report.items, "rope:load:line").title).toBe("line carries 17 N, under 1 % of its working load");
  }, SLOW);

  it("warns when it will swing: tied off centre, or on a rope that leads off plumb", async () => {
    const off = find((await fullCheck(hung({ tie: "(0, 170, 160)", top: "(0, 170, 400)" }))).report.items, "rope:hang:line:weight");
    expect(off.status).toBe("warn");
    expect(off.title).toBe("weight will swing on line");
    expect(off.detail).toMatch(/Its centre of mass is 20 mm to the side of where the rope holds it/);
    const lean = await fullCheck(hung({ top: "(0, 60, 400)" }));
    const f = find(lean.report.items, "rope:hang:line:weight");
    expect(f.status).toBe("warn");
    expect(f.detail).toMatch(/The rope leads up 20\.6° off vertical/);
    // a rope's end drawn into what it is tied to is not a clash
    expect(find(lean.report.items, "int:beam|line").title).toBe("line is tied to beam");
    expect(problems(lean.report).filter((x) => x.startsWith("int"))).toEqual([]);
  }, SLOW);
});

describe("a hoist let go", () => {
  const fall = Math.sqrt((2 * 0.4) / G);

  it("drops the car and unwinds a drum nothing holds, by the rope's length a turn", async () => {
    const p = await letGo(hoist());
    expect(p.mech.links).toMatchObject([{ kind: "ratio", name: "hoist", a: "drum", b: "car" }]);
    // 37.5 mm of rope a radian: the barrel's radius and half the rope
    expect(Math.abs((p.mech.links[0] as { ratio: number }).ratio)).toBeCloseTo(0.0375, 4);
    expect(p.holds).toEqual([]);
    expect(p.raised).toEqual(["car"]);
    const { run, down } = settle(p);
    expect(run.settled).toBe(true);
    expect(run.sys.joints.get("car")!.coord).toBeCloseTo(0, 3);
    expect(Math.abs(run.sys.joints.get("drum")!.coord)).toBeCloseTo(0.4 / 0.0375, 2);
    // a little slower than free fall: the car has the drum to spin up
    expect(down).toBeGreaterThan(fall);
    expect(down).toBeLessThan(fall * 1.2);
    expect(letGoLine(run)).toBe("car, raised to the top of its travel and let go, dropped 400 mm; drum turned 1.7 times.");
  }, SLOW);

  it("stays where it is when the winch motor can hold the pull", async () => {
    const p = await letGo(hoist({ more: motor("pololu_37d_70") }));
    expect(p.holds).toMatchObject([{ joint: "drum", by: "by m1" }]);
    expect(p.holds[0].limit).toBeCloseTo(2.648, 2);
    expect(p.raised).toEqual([]);
    expect(p.free).toEqual([]);
    const { run } = settle(p);
    expect(run.settled).toBe(true);
    expect(run.moves()).toEqual([]);
    expect(letGoLine(run)).toBe("Nothing moved: everything is held.");
  }, SLOW);

  it("drags a motor too weak for the load round, slower than it would fall", async () => {
    const free = settle(await letGo(hoist({ material: "Steel" })));
    const p = await letGo(hoist({ material: "Steel", more: motor("pololu_37d_19") }));
    expect(p.holds).toMatchObject([{ joint: "drum", by: "by m1" }]);
    expect(p.holds[0].limit).toBeCloseTo(0.785, 2);
    expect(p.raised).toEqual(["car"]);
    const { run, down } = settle(p);
    expect(run.settled).toBe(true);
    expect(run.sys.joints.get("car")!.coord).toBeCloseTo(0, 3);
    expect(Math.abs(run.sys.joints.get("drum")!.coord)).toBeCloseTo(0.4 / 0.0375, 2);
    expect(down).toBeGreaterThan(free.down * 1.2);
  }, SLOW);
});

describe("the library's drum and sheave", () => {
  it("are read like drawn ones: the rope on the barrel and in the groove, the turns that fit", async () => {
    const r = await fullCheck(bought);
    noErrors(r);
    expect(problems(r.report).filter((x) => x.startsWith("rope"))).toEqual([]);
    expect(find(r.report.items, "rope:run:hoist").status).toBe("pass");
    // the barrel's 72 mm and the rope's 3: 75 mm × π a turn
    expect(r.model.parts.find((p) => p.name === "car")!.motion!.perTurn).toBeCloseTo(2 * Math.PI * 37.5, 1);
    expect(find(r.report.items, "rope:drum:hoist:drum").detail).toMatch(/10 turns fit side by side/);
    expect(find(r.report.items, "rope:bend:hoist").status).toBe("pass");
  }, SLOW);
});

describe("a rope drawn moving", () => {
  it("keeps its length: what the path gives up is wound onto the drum", async () => {
    const r = await fullCheck(bought);
    const rope = r.model.machine!.ropes[0];
    const up = (z: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, z, 1];
    const len = (line: number[][]) => line.slice(1).reduce((n, p, i) => n + Math.hypot(p[0] - line[i][0], p[1] - line[i][1], p[2] - line[i][2]), 0);
    // how far round the drum's axis the line goes before it leaves for the sheave, in turns
    const turns = (line: number[][]) => {
      let a = 0;
      for (let i = 1; i < line.length && Math.abs(Math.hypot(line[i][1] - 97.5, line[i][2] - 45) - 37.5) < 1e-6; i++) {
        let d = Math.atan2(line[i][2] - 45, line[i][1] - 97.5) - Math.atan2(line[i - 1][2] - 45, line[i - 1][1] - 97.5);
        if (d > Math.PI) d -= 2 * Math.PI;
        if (d < -Math.PI) d += 2 * Math.PI;
        a += d;
      }
      return Math.abs(a) / (2 * Math.PI);
    };
    const drawn = ropeLineAt(rope.nodes, rope.rope.d, rope.length, [null, null, null])!;
    expect(drawn[drawn.length - 1]).toEqual([0, 60, 120]);
    expect(len(drawn)).toBeCloseTo(rope.length, 0);
    expect(turns(drawn)).toBeCloseTo(3, 2);
    // the car 200 mm up: the tied end goes with it, and 200 mm more rope is on the drum
    const raised = ropeLineAt(rope.nodes, rope.rope.d, rope.length, [null, null, up(200)])!;
    expect(raised[raised.length - 1]).toEqual([0, 60, 320]);
    expect(len(raised)).toBeCloseTo(rope.length, 0);
    expect(turns(raised)).toBeCloseTo(3 + 200 / (2 * Math.PI * 37.5), 2);
    // the rope's anchor stays where it is along the barrel
    expect(raised[0][0]).toBeCloseTo(drawn[0][0], 2);
    // nowhere for it to run: the tied end inside the circle the rope makes round the sheave
    expect(ropeLineAt(rope.nodes, rope.rope.d, rope.length, [null, null, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 20, 530, 1]])).toBeNull();
  }, SLOW);
});
