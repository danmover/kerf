// "Let go": the design under gravity with hands off, on the same solver the
// simulations use, held by exactly what the gravity and hold checks found
// holding it. A lift nothing carries drops, one the design says is held
// stays, an arm swings down unless its servo can hold it, a part fastened to
// nothing falls onto what is under it, and a bar on a pin swings with the
// period theory gives.

import { describe, expect, it } from "vitest";
import { fullCheck, type FullCheck } from "./helpers/fullcheck";
import type { MeshEntry } from "../src/core/engine";
import { massVolume } from "../src/core/model";
import { materialDensity } from "../src/library/standards";
import { LetGoRun, letGoLine, planLetGo, type LetGoOptions, type LetGoPlan } from "../src/sim/mech/letGo";

const G = 9.80665;

async function plan(src: string, opts?: LetGoOptions): Promise<{ r: FullCheck; plan: LetGoPlan | null }> {
  const r = await fullCheck(src);
  expect(r.model.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  const mesh = (h: string) => (r.core.get(h) ? r.core.mesh(h, "preview") : undefined);
  const geom = (h: string): MeshEntry | undefined => {
    const e = r.core.get(h);
    return e ? { preview: r.core.mesh(h, "preview"), volume: e.volume, bbox: [[0, 0, 0], [0, 0, 0]], rev: 0 } : undefined;
  };
  const p = planLetGo(r.model, geom, r.kernel, mesh, (q) => massVolume(q, r.core.get(q.hash)?.volume, materialDensity(q.material)), opts);
  if (p && "error" in p) throw new Error(p.error);
  return { r, plan: p };
}

/** Runs it to rest (or for `seconds`). */
function settle(p: LetGoPlan, seconds = 20, each?: (run: LetGoRun) => void): LetGoRun {
  const run = new LetGoRun(p);
  for (let t = 0; t < seconds && !run.settled; t += 0.001) {
    run.advance(0.001);
    each?.(run);
  }
  return run;
}

// a car on a square tower it fits round, drawn at the top of 300 mm of travel down
const lift = (o: { car?: string; z?: number; travel?: number } = {}) => `
design "lift"
part base { body box(300, 300, 10, at: (0, 0, -10))  held: "bolted to the floor"  material: "Steel" }
part tower { body box(40, 40, 600)  held: "welded to the base"  material: "Steel" }
part car { body box(160, 160, 20, at: (0, 0, ${o.z ?? 400}))  cut box(40.2, 40.2, 40, at: (0, 0, ${(o.z ?? 400) - 10}))  slides: Z  travel: ${o.travel ?? -300}  material: "Aluminum 6061"  ${o.car ?? ""} }
`;
// a bar that turns on a level pin through one end, high enough on its post to hang clear of the floor
const arm = (o: { bar?: string; extra?: string; material?: string } = {}) => `
design "arm"
part base { body box(100, 100, 10, at: (0, 0, -10))  held: "bolted down"  material: "Steel" }
part post { body box(20, 20, 450, at: (0, 30, 0))  held: "welded to the base"  material: "Steel" }
part arm { body ${o.bar ?? "box(200, 20, 10, at: (100, 0, 445))"}  spin: 1  axis: Y  axis_at: (0, 0, 450)  held: "its pivot pin"  material: "${o.material ?? "Aluminum 6061"}" }
${o.extra ?? ""}
`;
const servo = `component s1 = lib.servo("sg90") { at: (0, -20, 450), axis: Y  turns_with: arm  held: "screwed to the post" }`;

describe("a lift let go", () => {
  it("drops the length of its travel in the time free fall takes, and stops on its end stop", async () => {
    const { plan: p } = await plan(lift());
    expect(p!.holds).toEqual([]);
    expect(p!.free).toEqual(["car"]);
    expect(p!.raised).toEqual([]);
    let tDown = -1;
    const run = settle(p!, 20, (x) => {
      if (tDown < 0 && x.sys.joints.get("car")!.coord < -0.299) tDown = x.t;
    });
    expect(run.settled).toBe(true);
    expect(run.t).toBeLessThan(1.5);
    // 300 mm from rest: √(2 × 0.3 / g) = 0.247 s (its slide's friction acts on no side load)
    expect(tDown).toBeGreaterThan(0.24);
    expect(tDown).toBeLessThan(0.26);
    const mv = run.moves();
    expect(mv).toHaveLength(1);
    expect(mv[0].name).toBe("car");
    expect(mv[0].how).toBe("slid");
    expect(mv[0].amount).toBeCloseTo(300, 0);
    expect(mv[0].drop).toBeCloseTo(300, 0);
    expect(letGoLine(run)).toBe("car dropped 300 mm.");
    // the 3D view draws it 300 mm below where it is drawn
    const m = run.poses().get(p!.mech.bodies.find((b) => b.id === "car")!.parts[0])!;
    expect(m[14]).toBeCloseTo(-300, 0);
    expect(m[0]).toBeCloseTo(1, 6);
    expect(m[12]).toBeCloseTo(0, 3);
  });

  it("starts one drawn at the bottom from the top of its travel, and says so", async () => {
    const { plan: p } = await plan(lift({ z: 100, travel: 400 }));
    expect(p!.raised).toEqual(["car"]);
    const run = new LetGoRun(p!);
    run.advance(0.001);
    // raised 400 mm before it is let go
    const id = p!.mech.bodies.find((b) => b.id === "car")!.parts[0];
    expect(run.poses().get(id)![14]).toBeGreaterThan(399.9);
    while (!run.settled) run.advance(0.01);
    expect(run.poses().get(id)![14]).toBeCloseTo(0, 0);
    expect(letGoLine(run)).toBe("car, raised to the top of its travel and let go, dropped 400 mm.");
  });

  it("treats two lifts with the same travel as two: only the one nothing holds drops", async () => {
    const { plan: p } = await plan(`${lift()}
part tower2 { body box(40, 40, 600, at: (200, 0, 0))  held: "welded to the base"  material: "Steel" }
part car2 { body box(160, 160, 20, at: (200, 0, 400))  cut box(40.2, 40.2, 40, at: (200, 0, 390))  slides: Z  travel: -300  material: "Aluminum 6061"  held: "its hoist rope" }
`.replace("box(300, 300, 10, at: (0, 0, -10))", "box(600, 300, 10, at: (100, 0, -10))"));
    expect(p!.mech.bodies.map((b) => b.id).sort()).toEqual(["car", "car2", "frame"]);
    expect(p!.holds.map((h) => h.joint)).toEqual(["car2"]);
    const run = settle(p!);
    expect(letGoLine(run)).toBe("car dropped 300 mm.");
    expect(Math.abs(run.sys.joints.get("car2")!.coord)).toBeLessThan(1e-5);
  });

  it("stays where it is when the design says what holds it", async () => {
    const { plan: p } = await plan(lift({ car: 'held: "its hoist rope"' }));
    expect(p!.holds.map((h) => `${h.joint} ${h.by}`)).toEqual(["car as the design says it is held"]);
    expect(p!.free).toEqual([]);
    const run = settle(p!);
    expect(run.settled).toBe(true);
    expect(run.t).toBeLessThan(1);
    expect(run.moves()).toEqual([]);
    expect(Math.abs(run.sys.joints.get("car")!.coord)).toBeLessThan(1e-5);
    expect(letGoLine(run)).toBe("Nothing moved: everything is held.");
  });
});

describe("an arm let go", () => {
  it("swings down and comes to rest hanging under its pin", async () => {
    const { plan: p } = await plan(arm());
    expect(p!.free).toEqual(["arm"]);
    const run = settle(p!);
    expect(run.settled).toBe(true);
    const mv = run.moves();
    expect(mv).toHaveLength(1);
    expect(mv[0].how).toBe("swung");
    // level to straight down: a quarter turn (a plain pin's friction stops it a degree or two short)
    expect(mv[0].amount).toBeGreaterThan(86);
    expect(mv[0].amount).toBeLessThan(94);
    // its centre, 100 mm out, ends 100 mm lower
    expect(mv[0].drop).toBeGreaterThan(95);
    expect(letGoLine(run)).toMatch(/^arm swung (8[6-9]|9[0-4])°\.$/);
  });

  it("swings with the period theory gives for a bar on a pin", async () => {
    // no friction and no settling: what is checked is the solver and the bar's mass, centre and inertia from its shape
    const { plan: p } = await plan(arm(), { damping: 0 });
    for (const j of p!.mech.joints) {
      j.friction = 0;
      j.frictionPerLoad = 0;
    }
    const run = new LetGoRun(p!);
    const j = run.sys.joints.get("arm")!;
    // the moments it passes straight down, between two steps
    const bottoms: number[] = [];
    let prev = 0;
    for (let i = 0; i < 1400 && bottoms.length < 3; i++) {
      run.advance(0.001);
      const c = Math.abs(j.coord) - Math.PI / 2;
      if (i > 0 && c * prev < 0) bottoms.push(run.t - 0.001 * (c / (c - prev)));
      prev = c;
    }
    expect(bottoms).toHaveLength(3);
    // a 200 × 10 mm bar about a pin through its end face's middle: I = m (200² + 10²) / 12 + m 100², its centre 100 mm out
    const Leq = ((200 * 200 + 10 * 10) / 12 + 100 * 100) / 100 / 1000;
    // released level, a pendulum's period is 4 K(sin 45°) √(L / g) = 4 × 1.854075 √(L / g); it passes the bottom
    // a quarter of that in, and the same way again one period later
    const period = 4 * 1.854075 * Math.sqrt(Leq / G);
    expect(Math.abs(bottoms[2] - bottoms[0] - period) / period).toBeLessThan(0.001);
    expect(Math.abs(bottoms[0] - period / 4) / (period / 4)).toBeLessThan(0.005);
  });

  it("stays up on a servo that can hold it, and comes down on one that cannot", async () => {
    // 108 g with its centre 100 mm out: 0.11 N·m on a 0.18 N·m micro servo
    const ok = await plan(arm({ extra: servo }));
    expect(ok.plan!.holds).toHaveLength(1);
    expect(ok.plan!.holds[0].by).toBe("by s1");
    expect(ok.plan!.holds[0].limit).toBeCloseTo(0.18, 1);
    const held = settle(ok.plan!);
    expect(held.settled).toBe(true);
    expect(held.moves()).toEqual([]);
    // a 400 mm steel bar is 0.6 kg with its centre 200 mm out: 1.2 N·m, far past it
    const no = await plan(arm({ bar: "box(400, 20, 10, at: (200, 0, 445))", material: "Steel", extra: servo }));
    expect(no.r.report.items.find((i) => i.id === "gravity:motor:s1")?.status).toBe("fail");
    const fell = settle(no.plan!);
    const mv = fell.moves();
    expect(mv[0].how).toBe("swung");
    expect(mv[0].amount).toBeGreaterThan(80);
  });
});

describe("parts fastened to nothing", () => {
  const table = (extra: string) => `
design "table"
part top { body box(200, 200, 10, at: (0, 0, 90))  held: "screwed to the legs"  material: "Aluminum 6061" }
part leg { body box(20, 20, 90, at: (0, 0, 0))  held: "bolted to the floor"  material: "Steel" }
${extra}
`;

  it("fall onto what is under them", async () => {
    // a block drawn 50 mm above the table top, touching nothing
    const { r, plan: p } = await plan(table('part block { body box(30, 30, 30, at: (50, 0, 150))  material: "Steel" }'));
    expect(r.report.items.find((i) => i.id.startsWith("held:float:"))?.status).toBe("fail");
    expect(p!.mech.loose).toHaveLength(1);
    expect(p!.mech.off).toEqual([r.model.parts.find((x) => x.name === "block")!.id]);
    const run = settle(p!);
    expect(run.settled).toBe(true);
    const mv = run.moves();
    expect(mv).toHaveLength(1);
    expect(mv[0].name).toBe("block");
    expect(mv[0].how).toBe("fell");
    // 50 mm, onto the table top
    expect(mv[0].drop).toBeGreaterThan(49);
    expect(mv[0].drop).toBeLessThan(51.5);
    expect(letGoLine(run)).toMatch(/^block fell 5[01](\.\d)? mm\.$/);
    // and the 3D view moves the block's own part by that much
    const m = run.poses().get(r.model.parts.find((x) => x.name === "block")!.id)!;
    expect(m[14]).toBeLessThan(-49);
  });

  it("fall to the floor when nothing is under them", async () => {
    // beside the table: the floor is 150 mm below it
    const { plan: p } = await plan(table('part block { body box(30, 30, 30, at: (200, 0, 150))  material: "Steel" }'));
    const run = settle(p!);
    expect(run.settled).toBe(true);
    expect(run.moves()[0].drop).toBeGreaterThan(149);
    expect(run.moves()[0].drop).toBeLessThan(151.5);
  });

  it("leave a design where everything is held alone", async () => {
    const { r, plan: p } = await plan(table('part block { body box(30, 30, 30, at: (50, 0, 100))  held: "glued down"  material: "Steel" }'));
    expect(r.report.items.find((i) => i.id === "held:ok")?.status).toBe("pass");
    // nothing can move: there is nothing to let go
    expect(p).toBeNull();
  });
});
