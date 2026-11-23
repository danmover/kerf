// Round belts and O-rings used as belts (lib.round_belt): the path round the
// pulleys, the stretch the belt is fitted at and the pull that puts in each
// strand, and the checks that follow: the stretch its makers work to, the
// smallest pulley, grooves that fit, pulleys that turn at the speeds the belt
// gives them, and the grip before it slips. A belt-driven winch whose belt
// cannot pass the load lets it fall in "Let go"; one that grips holds it.

import { describe, expect, it } from "vitest";
import { fullCheck, problems, type FullCheck } from "./helpers/fullcheck";
import type { CheckItem } from "../src/core/checks";
import type { MeshEntry } from "../src/core/engine";
import { massVolume } from "../src/core/model";
import { materialDensity } from "../src/library/standards";
import { LetGoRun, letGoLine, planLetGo, type LetGoPlan } from "../src/sim/mech/letGo";
import { capstan, cordTension, gripForce, puCord, rubberCord, stretchedD } from "../src/machine/roundBelts";
import { RUBBERS } from "../src/library/bands";

const SLOW = 60000;
const noErrors = (r: FullCheck) => expect(r.model.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
const find = (items: CheckItem[], id: string) => {
  const f = items.find((i) => i.id === id);
  if (!f) throw new Error(`no ${id} in ${items.map((i) => i.id).filter((i) => /rbelt|gravity/.test(i)).join(", ")}`);
  return f;
};
const errorOf = async (src: string) => (await fullCheck(src)).model.diagnostics.filter((d) => d.severity === "error").map((d) => d.message).join("\n");

// a pulley with a 4 mm groove between two rims, turning about Y
const wheel = (name: string, d: number, x: number, more: string, o: { rim?: number; groove?: number } = {}) => {
  const w = o.groove ?? 4;
  return `part ${name} { body cylinder(${d}, ${w}, at: (${x}, ${-w / 2}, 60), dir: Y)  add cylinder(${d + (o.rim ?? 8)}, 2, at: (${x}, ${-w / 2 - 2}, 60), dir: Y)  add cylinder(${d + (o.rim ?? 8)}, 2, at: (${x}, ${w / 2}, 60), dir: Y)  axis: Y  axis_at: (${x}, 0, 60)  held: "its shaft"  material: "Aluminum 6061"  ${more} }`;
};
// a 20 mm pulley driving a 60 mm one 120 mm away
const drive = (o: { small?: number; big?: string; args?: string; cs?: number; smallMore?: { rim?: number; groove?: number } } = {}) => `
design "belt drive"
part plate { body box(220, 6, 140, at: (60, 10, 0))  held: "bolted down"  material: "Aluminum 6061" }
${wheel("small", o.small ?? 20, 0, "spin: 1", o.smallMore)}
${wheel("big", 60, 120, o.big ?? "spin: 0.36435")}
component belt = lib.round_belt(cs: ${o.cs ?? 3}, path: [small, big]${o.args ?? ""})
`;

describe("a round belt's cord", () => {
  it("pulls as its maker's figures say, and an O-ring as its rubber does", () => {
    const pu = puCord("pu", 3);
    const area = (Math.PI * 9) / 4;
    // MISUMI: 1.2 N/mm² at 5 % stretch, 1.8 at 10 %
    expect(cordTension(pu, 0.05)).toBeCloseTo(1.2 * area, 6);
    expect(cordTension(pu, 0.1)).toBeCloseTo(1.8 * area, 6);
    expect(cordTension(pu, 0.08)).toBeCloseTo(1.56 * area, 6);
    expect(cordTension(pu, 0)).toBe(0);
    expect(pu.minPulley).toBe(20);
    expect(puCord("pu", 5).minPulley).toBe(40);
    expect(puCord("pu", 7).minPulley).toBe(60);
    expect(puCord("pu92", 3).minPulley).toBe(30);
    const ring = rubberCord(RUBBERS.epdm, 70, 3);
    expect(ring.minPulley).toBe(12);
    expect([ring.stretchMin, ring.stretchMax]).toEqual([0.08, 0.12]);
    // rubber stiffens less than in proportion at first: 10 % stretch pulls less than twice what 5 % does
    expect(cordTension(ring, 0.1)).toBeGreaterThan(cordTension(ring, 0.05));
    expect(cordTension(ring, 0.1)).toBeLessThan(2 * cordTension(ring, 0.05));
    // a cord keeps its volume as it stretches
    expect(stretchedD(3, 0.1) ** 2 * 1.1).toBeCloseTo(9, 9);
  });

  it("grips by the capstan relation", () => {
    expect(capstan(0.5, 180)).toBeCloseTo(Math.exp(0.5 * Math.PI), 9);
    // 10 N in each strand at rest, tight side e^(μθ) times the slack side when it lets go, the two still adding to 20 N
    const k = capstan(0.7, 160);
    const f = gripForce(10, 0.7, 160);
    const slack = 20 / (k + 1);
    expect(f).toBeCloseTo(k * slack - slack, 9);
    expect(gripForce(0, 0.7, 160)).toBe(0);
  });
});

describe("a round belt round two pulleys", () => {
  it("is laid on the middle of its cord, fitted at 5 % stretch and welded to the length that gives", async () => {
    const r = await fullCheck(drive());
    noErrors(r);
    expect(problems(r.report)).toEqual([]);
    const b = r.model.machine!.roundBelts[0];
    // the stretched cord is thinner: its middle runs at the groove's radius plus half of that
    const dS = 3 / Math.sqrt(1.05);
    expect(b.nodes.map((n) => n.r)).toEqual([expect.closeTo(10 + dS / 2, 6), expect.closeTo(30 + dS / 2, 6)]);
    // an open belt round two pulleys: 2·sqrt(C² − (R − r)²) + the two arcs
    const [r1, r2, C] = [10 + dS / 2, 30 + dS / 2, 120];
    const a = Math.asin((r2 - r1) / C);
    expect(b.length).toBeCloseTo(2 * Math.sqrt(C * C - (r2 - r1) ** 2) + r1 * (Math.PI - 2 * a) + r2 * (Math.PI + 2 * a), 1);
    expect(b.nodes[0].wrap).toBeCloseTo(180 - (2 * a * 180) / Math.PI, 3);
    expect(b.nodes[1].wrap).toBeCloseTo(180 + (2 * a * 180) / Math.PI, 3);
    expect(b.stretch).toBe(0.05);
    expect(b.made).toBeCloseTo(b.length / 1.05, 1);
    expect(b.tension).toBeCloseTo(cordTension(puCord("pu", 3), 0.05), 2);
    expect(find(r.report.items, "rbelt:path:belt").detail).toBe("Round belt, 3 mm polyurethane 88A: 378.2 mm round the path along the middle of the cord. Weld it to 360.2 mm, which is 5 % stretch.");
    expect(find(r.report.items, "rbelt:stretch:belt").title).toBe("belt is fitted at 5 % stretch: 8.5 N in each strand");
    expect(find(r.report.items, "rbelt:pulley:belt").status).toBe("pass");
    expect(find(r.report.items, "rbelt:groove:belt").status).toBe("pass");
    // with nothing said about its load, what it can pass is given, not judged
    const g = find(r.report.items, "rbelt:grip:belt");
    expect(g.status).toBe("info");
    expect(g.title).toBe("belt can pass 147 N·mm at small before it slips");
    expect(g.detail).toMatch(/friction of 0\.7 on aluminium .* 161° of wrap on small, the tight side can carry 7\.1 times the slack side/);
    // the belt is a part of the design: on the parts list, by the length to weld it to
    const part = r.model.parts.find((p) => p.name === "belt")!;
    expect(part.material).toBe("TPU");
    expect(part.bom?.description).toBe("Polyurethane round belt 3 mm (88A), welded to 360.2 mm");
  }, SLOW);

  it("holds its pulleys to the speeds it gives them", async () => {
    const ok = find((await fullCheck(drive())).report.items, "rbelt:ratio:belt");
    expect(ok.status).toBe("pass");
    expect(ok.detail).toMatch(/^big turns 0\.364 times for each turn of small/);
    const off = find((await fullCheck(drive({ big: "spin: 0.3333" }))).report.items, "rbelt:ratio:belt");
    expect(off.status).toBe("fail");
    expect(off.title).toBe("big does not turn at the speed belt gives it");
    expect(off.fix).toBe("Set spin: 0.3643 on big, or spin: 0.9148 on small.");
    // an open belt turns both pulleys the same way
    const back = find((await fullCheck(drive({ big: "spin: -0.36435" }))).report.items, "rbelt:ratio:belt");
    expect(back.status).toBe("fail");
    expect(back.fix).toMatch(/^Set spin: 0\.3643 on big/);
    // a pulley the belt runs round and the design leaves still
    const still = find((await fullCheck(drive({ big: "" }))).report.items, "rbelt:ratio:belt");
    expect(still.status).toBe("warn");
    expect(still.title).toBe("belt turns big, and the design leaves it still");
    expect(still.fix).toBe("Give big axis:, axis_at: and spin: 0.3643.");
  }, SLOW);

  it("checks the torque it is asked to pass against its grip", async () => {
    const slips = find((await fullCheck(drive({ args: ", torque: 0.3Nm, drive: small" }))).report.items, "rbelt:grip:belt");
    expect(slips.status).toBe("fail");
    expect(slips.title).toBe("belt slips: it can pass 147 N·mm and has 300 N·mm to pass");
    const near = find((await fullCheck(drive({ args: ", torque: 0.12Nm" }))).report.items, "rbelt:grip:belt");
    expect(near.status).toBe("warn");
    expect(near.title).toBe("belt is close to slipping: 82 % of its grip");
    const holds = find((await fullCheck(drive({ args: ", torque: 0.08Nm" }))).report.items, "rbelt:grip:belt");
    expect(holds.status).toBe("pass");
    expect(holds.title).toBe("belt grips: 55 % of what it can pass");
    // stretched harder it pulls harder and grips more
    const tight = find((await fullCheck(drive({ args: ", torque: 0.12Nm, stretch: 8" }))).report.items, "rbelt:grip:belt");
    expect(tight.status).toBe("pass");
  }, SLOW);

  it("fails a slack belt, and warns past the stretch its makers work to", async () => {
    const slack = await fullCheck(drive({ args: ", length: 390" }));
    const s = find(slack.report.items, "rbelt:stretch:belt");
    expect(s.status).toBe("fail");
    expect(s.title).toBe("belt hangs slack");
    expect(s.fix).toMatch(/^Weld it to 36\d mm, which is stretch: 5\.$/);
    expect(slack.report.items.some((i) => i.id === "rbelt:grip:belt")).toBe(false);
    const over = find((await fullCheck(drive({ args: ", stretch: 12" }))).report.items, "rbelt:stretch:belt");
    expect(over.status).toBe("warn");
    expect(over.title).toBe("belt is stretched 12 %, past the 8 % it is meant to work at");
    expect(find((await fullCheck(drive({ args: ", stretch: 20" }))).report.items, "rbelt:stretch:belt").status).toBe("fail");
  }, SLOW);

  it("fails a pulley under the maker's smallest, a groove the cord does not fit, and warns of a pulley with no groove", async () => {
    const small = find((await fullCheck(drive({ small: 14, big: "spin: 0.2684" }))).report.items, "rbelt:pulley:belt");
    expect(small.status).toBe("fail");
    expect(small.title).toBe("small is too small for belt");
    expect(small.detail).toBe("small is 14 mm at the bottom of its groove. MISUMI's smallest pulley for this belt: 20 mm for this 3 mm cord.");
    const narrow = find((await fullCheck(drive({ smallMore: { groove: 2.4 } }))).report.items, "rbelt:groove:belt");
    expect(narrow.status).toBe("fail");
    expect(narrow.title).toBe("belt does not fit small");
    const bare = find((await fullCheck(drive({ smallMore: { rim: 0 } }))).report.items, "rbelt:groove:belt");
    expect(bare.status).toBe("warn");
    expect(bare.title).toBe("Nothing keeps belt on small");
  }, SLOW);
});

describe("an O-ring as a belt", () => {
  it("takes its stretch from its size, and is held to 8 to 12 %", async () => {
    const r = await fullCheck(drive({ args: ', rubber: "EPDM", id: 106', big: "spin: 0.36375" }));
    noErrors(r);
    expect(problems(r.report)).toEqual([]);
    const b = r.model.machine!.roundBelts[0];
    expect(b.made).toBeCloseTo(Math.PI * 109, 1);
    expect(b.stretch).toBeGreaterThan(0.08);
    expect(b.stretch).toBeLessThan(0.12);
    const s = find(r.report.items, "rbelt:stretch:belt");
    expect(s.status).toBe("pass");
    // rubber held stretched relaxes: the grip is worked out from what is left after a year
    expect(s.detail).toMatch(/Apple Rubber gives 8 to 12 % stretch for O-ring drive belts\. .* rubber held stretched relaxes: about [\d.]+ N is left in each strand after a year/);
    expect(find(r.report.items, "rbelt:grip:belt").detail).toMatch(/\(what a year held stretched leaves\)/);
    expect(find(r.report.items, "rbelt:pulley:belt").detail).toMatch(/four times the cord at the bottom of the groove: 12 mm for this 3 mm cord/);
    expect(r.model.parts.find((p) => p.name === "belt")!.bom?.description).toBe("O-ring 106 × 3 mm, EPDM 70A");
    // a ring far too small for the path
    const tight = find((await fullCheck(drive({ args: ', rubber: "EPDM", id: 85' }))).report.items, "rbelt:stretch:belt");
    expect(tight.status).toBe("fail");
    expect(tight.title).toMatch(/^belt is stretched 36\.\d %, past the 12 % it is meant to work at$/);
    expect(tight.fix).toMatch(/^Use an O-ring of about 106\.\d mm inside diameter \(10 % stretch\)/);
  }, SLOW);

  it("says what it is given wrongly", async () => {
    expect(await errorOf(drive({ args: ', rubber: "leather"' }))).toMatch(/"leather" is not a belt material/);
    expect(await errorOf(drive({ args: ", id: 80" }))).toMatch(/id: is an O-ring's inside diameter/);
    expect(await errorOf(drive({ args: ", stretch: 5, length: 300" }))).toMatch(/give one of id:/);
    expect(await errorOf(drive().replace("path: [small, big]", "path: [small]"))).toMatch(/a belt needs two pulleys or more/);
    expect(await errorOf(drive().replace("path: [small, big]", "path: [small, plate]"))).toMatch(/plate has no round shape for the belt to run on/);
  }, SLOW);
});

// a hoist whose drum is driven through a round belt from a gearmotor on the small pulley
const groove = (name: string, d: number, y: number, more: string) => `part ${name} { body cylinder(${d}, 4, at: (-40, ${y}, 45), dir: X)  add cylinder(${d + 8}, 2, at: (-42, ${y}, 45), dir: X)  add cylinder(${d + 8}, 2, at: (-36, ${y}, 45), dir: X)  material: "Aluminum 6061"  ${more} }`;
const winch = (o: { cs: number; small: number; spin: string }) => `
design "belt winch"
part base { body box(300, 500, 10, at: (0, 90, -10))  held: "bolted to the floor"  material: "Steel" }
part tower { body box(40, 40, 700)  held: "welded to the base"  material: "Steel" }
part car { body box(160, 160, 20, at: (0, 0, 100))  cut box(40.2, 40.2, 40, at: (0, 0, 90))  slides: Z  travel: 400  material: "Aluminum 6061" }
part top { body cylinder(72, 10, at: (-5, 97.5, 650), dir: X)  held: "its axle"  material: "Nylon" }
part drum { body cylinder(72, 30, at: (-15, 97.5, 45), dir: X)  spin: 1  axis: X  axis_at: (0, 97.5, 45)  held: "its shaft"  material: "Aluminum 6061" }
component hoist = lib.rope("wire_rope_7x19_3mm", path: [drum, top, (0, 60, 120)], lifts: car)
${groove("bigp", 60, 97.5, 'turns_with: drum  held: "keyed to the drum\'s shaft"')}
${groove("smallp", o.small, 217.5, `spin: ${o.spin}  axis: X  axis_at: (-40, 217.5, 45)  held: "the motor's shaft"`)}
component m1 = lib.gearmotor("pololu_37d_70") { at: (-70, 217.5, 45), axis: X  turns_with: smallp  held: "screwed to its bracket" }
component belt = lib.round_belt(cs: ${o.cs}, path: [smallp, bigp])
`;
async function letGo(src: string): Promise<{ r: FullCheck; plan: LetGoPlan }> {
  const r = await fullCheck(src);
  noErrors(r);
  const mesh = (h: string) => (r.core.get(h) ? r.core.mesh(h, "preview") : undefined);
  const geom = (h: string): MeshEntry | undefined => {
    const e = r.core.get(h);
    return e ? { preview: r.core.mesh(h, "preview"), volume: e.volume, bbox: [[0, 0, 0], [0, 0, 0]], rev: 0 } : undefined;
  };
  const p = planLetGo(r.model, geom, r.kernel, mesh, (q) => massVolume(q, r.core.get(q.hash)?.volume, materialDensity(q.material)));
  if (!p || "error" in p) throw new Error(p ? p.error : "nothing to let go");
  return { r, plan: p };
}
function settle(p: LetGoPlan): { run: LetGoRun; down: number } {
  const run = new LetGoRun(p);
  let down = -1;
  for (let t = 0; t < 20 && !run.settled; t += 0.001) {
    run.advance(0.001);
    if (down < 0 && run.sys.joints.get("car")!.coord < 0.001) down = run.t;
  }
  return { run, down };
}

describe("a winch driven through a round belt", () => {
  it("holds its load when the belt grips", async () => {
    const { r, plan } = await letGo(winch({ cs: 4, small: 30, spin: "-1.8849" }));
    expect(find(r.report.items, "rbelt:ratio:belt").status).toBe("pass");
    const g = find(r.report.items, "rbelt:grip:belt");
    expect(g.status).toBe("pass");
    expect(g.detail).toMatch(/The pull of hoist on drum \(13 N at 37\.5 mm from its axis\) is held by m1 through this belt, which makes it 15 N of pull to pass\.$/);
    expect(find(r.report.items, "gravity:carried:car").status).toBe("pass");
    expect(find(r.report.items, "gravity:motor:m1").title).toBe("m1 holds car up");
    // the solver ties the motor's pulley to the drum through the belt, no further than its grip
    expect(plan.mech.links).toContainEqual(expect.objectContaining({ kind: "ratio", name: "belt", a: "smallp", b: "drum", grip: expect.closeTo(0.739, 2) }));
    expect(plan.holds).toMatchObject([{ joint: "smallp", by: "by m1" }]);
    expect(plan.raised).toEqual([]);
    const { run } = settle(plan);
    expect(letGoLine(run)).toBe("Nothing moved: everything is held.");
  }, SLOW);

  it("lets its load down when the belt slips, slower than it would fall", async () => {
    const { r, plan } = await letGo(winch({ cs: 3, small: 20, spin: "-2.7446" }));
    const g = find(r.report.items, "rbelt:grip:belt");
    expect(g.status).toBe("fail");
    expect(g.title).toBe("belt slips: it can pass 147 N·mm and has 174 N·mm to pass");
    // the motor is strong enough; the belt is what lets go
    const m = find(r.report.items, "gravity:motor:m1");
    expect(m.status).toBe("pass");
    expect(m.title).toBe("m1 is strong enough to hold car up");
    expect(m.detail).toMatch(/It holds it through belt, which slips before that/);
    expect(r.report.items.some((i) => i.id === "gravity:carried:car")).toBe(false);
    expect(plan.raised).toEqual(["car"]);
    const { run, down } = settle(plan);
    expect(run.settled).toBe(true);
    expect(run.sys.joints.get("car")!.coord).toBeCloseTo(0, 3);
    // the motor's pulley stays where it is: the belt slides round it
    expect(Math.abs(run.sys.joints.get("smallp")!.coord)).toBeLessThan(0.01);
    expect(Math.abs(run.sys.joints.get("drum")!.coord)).toBeCloseTo(0.4 / 0.0375, 1);
    // dragged by the belt's friction all the way: well over twice the time of a free fall
    expect(down).toBeGreaterThan(2 * Math.sqrt(0.8 / 9.80665));
  }, SLOW);
});
