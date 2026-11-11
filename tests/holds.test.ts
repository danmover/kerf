// How parts hold together: each screw's stack (head, parts, nut or thread),
// loose screws whose nut or head stands off, parts riding on moving parts,
// and motion carried from a turning part to what is fastened to it.

import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { findHolds, motionOfPart } from "../src/core/holds";
import { holdChecks } from "../src/core/holdChecks";
import { KernelCore } from "../src/kernel/core";
import { initKernel } from "./helpers/kernel";
import { fullCheck } from "./helpers/fullcheck";
import { resolveMechanism } from "../src/sim/mech/resolve";
import { FRAME } from "../src/sim/mech/model";

const plates = (nutZ: number, headZ = 6) => `
part a { material: "Aluminum 6061"  body box(30, 30, 3)  cut hole(M3, through: true, at: (10, 0, 3)) }
part b { material: "Aluminum 6061"  body box(30, 30, 3, at: (0, 0, 3))  cut hole(M3, through: true, at: (10, 0, 6)) }
component s = lib.screw(M3, 12) { at: (10, 0, ${headZ}), axis: -Z }
component n = lib.nut(M3) { at: (10, 0, ${nutZ}), axis: -Z }
`;

describe("screw stacks", () => {
  it("clamps two plates between the head and a seated nut", () => {
    const h = findHolds(evaluate(plates(0)));
    expect(h.stacks).toHaveLength(1);
    const st = h.stacks[0];
    expect(st.host?.name).toBe("n");
    expect(st.hostKind).toBe("nut");
    expect(st.clamped.map((p) => p.name)).toEqual(["b", "a", "n"]);
    expect(st.gap).toBeUndefined();
    expect(st.tight).toBe(true);
    expect(h.joins.filter((j) => j.kind === "screw").map((j) => j.b.name).sort()).toEqual(["a", "b", "n"]);
  });

  it("calls a screw loose when its nut stands off the plate", () => {
    const h = findHolds(evaluate(plates(-1.5)));
    const st = h.stacks[0];
    expect(st.tight).toBe(false);
    expect(st.gap?.at).toBe("nut");
    expect(st.gap?.size).toBeCloseTo(1.5, 3);
    expect(st.gap?.after?.name).toBe("a");
    expect(h.joins.some((j) => j.kind === "screw")).toBe(false);
    expect(h.loose.get("s")?.play).toBeCloseTo(1.5, 3);
    expect(h.loose.has("n")).toBe(true);
  });

  it("calls a screw loose when its head stands off", () => {
    const h = findHolds(evaluate(plates(0, 7)));
    expect(h.stacks[0].gap?.at).toBe("head");
    expect(h.stacks[0].gap?.size).toBeCloseTo(1, 3);
  });

  it("finds a gap between clamped parts", () => {
    const src = plates(0).replace("box(30, 30, 3, at: (0, 0, 3))", "box(30, 30, 2, at: (0, 0, 4))").replace("hole(M3, through: true, at: (10, 0, 6))", "hole(M3, through: true, at: (10, 0, 6))");
    const st = findHolds(evaluate(src)).stacks[0];
    expect(st.gap?.at).toBe("between");
    expect(st.gap?.size).toBeCloseTo(1, 3);
    expect(st.gap?.after?.name).toBe("b");
    expect(st.gap?.before?.name).toBe("a");
  });

  it("clamps into a tapped hole", () => {
    const src = `
part a { material: "Aluminum 6061"  body box(30, 30, 3, at: (0, 0, 10))  cut hole(M3, through: true, at: (10, 0, 13)) }
part base { material: "Aluminum 6061"  body box(30, 30, 10)  cut hole(M3, fit: "tap", depth: 8, at: (10, 0, 10)) }
component s = lib.screw(M3, 8) { at: (10, 0, 13), axis: -Z }
`;
    const st = findHolds(evaluate(src)).stacks[0];
    expect(st.hostKind).toBe("tapped");
    expect(st.tight).toBe(true);
    expect(st.clamped.map((p) => p.name)).toEqual(["a", "base"]);
  });
});

describe("motion carried by fastenings", () => {
  const ride = (extra = "") => `
part base { material: "Aluminum 6061"  body cylinder(d: 200, h: 10) }
part deck {
  material: "Aluminum 6061"
  body cylinder(d: 180, h: 5, at: (0, 0, 20))
  cut hole(M4, through: true, at: (60, 0, 25))
  spin: 1
}
part seat {
  material: "PETG"
  body box(30, 30, 4, at: (60, 0, 25))
  cut hole(M4, through: true, at: (60, 0, 29))
}
component bolt = lib.screw(M4, 16) { at: (60, 0, 29), axis: -Z }
component nut = lib.nut(M4) { at: (60, 0, 20), axis: -Z }
${extra}
`;
  it("moves a bolted seat, its screw and nut with the turning deck", () => {
    const m = evaluate(ride());
    const h = findHolds(m);
    expect(h.stacks[0].tight).toBe(true);
    for (const id of ["seat", "bolt", "nut"]) {
      const p = m.parts.find((q) => q.id === id)!;
      expect(motionOfPart(p, h)?.ratio).toBe(1);
      expect(h.carried.get(id)?.from.name).toBe("deck");
    }
    expect(h.conflicts).toEqual([]);
  });

  it("reports a turning part bolted to the base on the floor", () => {
    const src = ride(`component lock = lib.screw(M4, 30) { at: (-60, 0, 25), axis: -Z }`).replace("cut hole(M4, through: true, at: (60, 0, 25))", "cut hole(M4, through: true, at: (60, 0, 25))\n  cut hole(M4, through: true, at: (-60, 0, 25))").replace("part base { material: \"Aluminum 6061\"  body cylinder(d: 200, h: 10) }", "part base { material: \"Aluminum 6061\"  body cylinder(d: 200, h: 20)  cut hole(M4, fit: \"tap\", depth: 12, at: (-60, 0, 20)) }");
    const h = findHolds(evaluate(src));
    expect(h.conflicts).toHaveLength(1);
    expect(h.conflicts[0].moving.map((p) => p.name)).toEqual(["deck"]);
    expect(h.conflicts[0].still.map((p) => p.name)).toEqual(["base"]);
    expect(h.conflicts[0].by).toContain("lock");
  });
});

describe("riding on a moving part", () => {
  const teacup = `
component sun = lib.spur_gear(m: 2, z: 30, width: 8) { at: (0, 0, 0), axis: Z }
part deck { body cylinder(d: 200, h: 5, at: (0, 0, 10))  spin: 1 }
component planet = lib.spur_gear(m: 2, z: 15, width: 8) { at: (45, 0, 0), axis: Z, mesh: sun, rides: deck }
part cup { body cylinder(d: 40, h: 30, at: (45, 0, 20))  rides: deck  turns_with: planet }
`;
  it("turns a planet round a fixed centre gear as its deck turns", () => {
    const m = evaluate(teacup.replace("  turns_with: planet", "  spin: 3"));
    const planet = m.parts.find((p) => p.name === "planet")!;
    expect(planet.motion?.parent?.ratio).toBe(1);
    // relative to the deck: the sun turns back at -1, so the planet turns +30/15 on its own axis
    expect(planet.motion?.ratio).toBeCloseTo(2, 9);
    const cup = m.parts.find((p) => p.name === "cup")!;
    expect(cup.motion?.parent).toBe(planet.motion?.parent);
    expect(cup.motion?.ratio).toBe(3);
  });

  it("will not take rides: with turns_with:", () => {
    const m = evaluate(teacup);
    expect(m.diagnostics.some((d) => /rides: and turns_with:/.test(d.message))).toBe(true);
  });

  it("fails a gear pinned to a turning deck with its teeth in a still centre gear", () => {
    const m = evaluate(`
part base { body cylinder(d: 240, h: 5, at: (0, 0, -20)) }
component sun = lib.spur_gear(m: 2, z: 30, width: 8) { at: (0, 0, 0), axis: Z }
part deck { body cylinder(d: 200, h: 5, at: (0, 0, 10))  cut hole(d: 5, through: true, at: (45, 0, 15))  spin: 1 }
component planet = lib.spur_gear(m: 2, z: 15, width: 8, bore: 5) { at: (45, 0, 0), axis: Z, mesh: sun }
component pin = lib.dowel(d: 5, length: 15) { at: (45, 0, 0), axis: Z }
`);
    const h = findHolds(m);
    expect(h.carried.get("planet")?.from.name).toBe("deck");
    const items = holdChecks(m, h);
    expect(items.map((i) => `${i.status} ${i.id}`)).toContain("fail motion:rides:planet");
    expect(items.find((i) => i.id === "motion:rides:planet")!.fix).toMatch(/rides: deck and mesh: sun/);
  });

  it("keeps a gear beside a still gear on a still frame still", () => {
    const m = evaluate(`
component a = lib.spur_gear(m: 2, z: 30, width: 8) { at: (0, 0, 0), axis: Z }
component b = lib.spur_gear(m: 2, z: 15, width: 8) { at: (45, 0, 0), axis: Z, mesh: a }
`);
    expect(m.parts.find((p) => p.name === "b")!.motion?.ratio).toBeCloseTo(0, 12);
  });
});

describe("hinges, clearances and countersinks", () => {
  const pair = (gap: number, nut: string) => `
part a { material: "Aluminum 6061"  body box(30, 30, 3)  cut hole(M3, through: true, at: (10, 0, 3)) }
part b { material: "Aluminum 6061"  body box(30, 30, 3, at: (0, 0, ${3 + gap}))  cut hole(M3, through: true, at: (10, 0, ${6 + gap})) }
component s = lib.screw(M3, 12) { at: (10, 0, ${6 + gap}), axis: -Z }
component n = lib.nut(M3${nut}) { at: (10, 0, 0), axis: -Z }
`;

  it("takes a lock nut left with running clearance as a hinge", () => {
    const h = findHolds(evaluate(pair(0.3, `, type: "nyloc"`)));
    const st = h.stacks[0];
    expect(st.hinge).toBe(true);
    expect(st.gap).toBeUndefined();
    expect(st.pivots.map((p) => p.name)).toEqual(["a"]);
    expect(h.joins.find((j) => j.b.name === "a")?.kind).toBe("pivot");
    expect(h.joins.find((j) => j.b.name === "b")?.kind).toBe("screw");
    expect(h.loose.size).toBe(0);
  });

  it("lets a screw draw parts together across a sliding clearance", () => {
    const st = findHolds(evaluate(pair(0.2, ""))).stacks[0];
    expect(st.tight).toBe(true);
    expect(st.hinge).toBe(false);
  });

  it("still calls a wider gap under a plain nut loose", () => {
    const st = findHolds(evaluate(pair(0.8, ""))).stacks[0];
    expect(st.gap?.at).toBe("between");
    expect(st.gap?.size).toBeCloseTo(0.8, 3);
  });

  // measured on the kernel's meshes: a countersunk head sits in its cone; a socket head on the cone's rim stands off
  const csk = (head: string) => `
part a { material: "Aluminum 6061"  body box(30, 30, 5)  cut hole(M4, through: true, csink: true, at: (0, 0, 5)) }
part b { material: "Aluminum 6061"  body box(30, 30, 6, at: (0, 0, -6))  cut hole(M4, fit: "tap", depth: 6, at: (0, 0, 0)) }
component s = lib.screw(M4, 10${head}) { at: (0, 0, 5), axis: -Z }
`;
  const measured = async (src: string) => {
    await initKernel();
    const m = evaluate(src);
    const core = new KernelCore();
    for (const p of m.parts) core.build({ hash: p.hash, recipe: p.recipe, label: p.label });
    return findHolds(m, (h) => (core.get(h) ? core.mesh(h, "preview") : undefined));
  };

  it("seats a countersunk head in its countersink", async () => {
    const st = (await measured(csk(`, head: "flat"`))).stacks[0];
    expect(st.measured).toBe(true);
    expect(st.tight).toBe(true);
    expect(st.clamped.map((p) => p.name)).toEqual(["a", "b"]);
  }, 60_000);

  it("finds a socket head standing on a countersink's rim", async () => {
    const st = (await measured(csk(""))).stacks[0];
    expect(st.gap?.at).toBe("head");
    expect(st.gap!.size).toBeGreaterThan(0.2);
  }, 60_000);
});

describe("gravity and contact: every part held", () => {
  const base = `part base { material: "Aluminum 6061"  body box(60, 60, 10)  cut hole(M4, through: true, at: (0, 0, 10)) }\n`;
  const items = async (src: string) => (await fullCheck(src)).report.items.filter((i) => /^(held|clamp)/.test(i.id));

  it("says a block only rests on the base when nothing fastens it", async () => {
    const it = await items(`${base}part block { material: "Aluminum 6061"  body box(20, 20, 10, at: (0, 0, 10)) }`);
    expect(it.map((i) => `${i.status} ${i.id}`)).toEqual(["fail held:rests:block"]);
    expect(it[0].fix).toMatch(/Fasten block to base/);
  }, 60_000);

  it("says a block floats when it touches nothing", async () => {
    const it = await items(`${base}part block { material: "Aluminum 6061"  body box(20, 20, 10, at: (0, 0, 12)) }`);
    expect(it.map((i) => `${i.status} ${i.id}`)).toEqual(["fail held:float:block"]);
  }, 60_000);

  it("takes a block at its word when it says it is glued", async () => {
    const it = await items(`${base}part block { material: "Aluminum 6061"  held: "epoxy"  body box(20, 20, 10, at: (0, 0, 10)) }`);
    expect(it.map((i) => `${i.status} ${i.id}`)).toEqual(["pass held:ok"]);
  }, 60_000);

  it("holds a block bolted down through the base with a seated nut", async () => {
    const it = await items(`${base}part block { material: "Aluminum 6061"  body box(20, 20, 10, at: (0, 0, 10))  cut hole(M4, through: true, at: (0, 0, 20)) }
component bolt = lib.screw(M4, 25) { at: (0, 0, 20), axis: -Z }
component nut = lib.nut(M4) { at: (0, 0, 0), axis: -Z }`);
    expect(it.map((i) => `${i.status} ${i.id}`).sort()).toEqual(["pass clamp:ok", "pass held:ok"]);
  }, 60_000);

  it("says the nut stands off and the block is not held when the nut is backed off", async () => {
    const it = await items(`${base}part block { material: "Aluminum 6061"  body box(20, 20, 10, at: (0, 0, 10))  cut hole(M4, through: true, at: (0, 0, 20)) }
component bolt = lib.screw(M4, 25) { at: (0, 0, 20), axis: -Z }
component nut = lib.nut(M4) { at: (0, 0, -2), axis: -Z }`);
    const ids = it.map((i) => `${i.status} ${i.id}`);
    expect(ids).toContain("fail clamp:nut:bolt:nut");
    expect(ids).toContain("fail held:rests:block");
    expect(it.find((i) => i.id === "clamp:nut:bolt:nut")!.fix).toMatch(/Move nut to at: \(0, 0, 0\)/);
  }, 60_000);

  it("holds a printed foot on a plywood board with a countersunk wood screw", async () => {
    const board = `part board { material: "Wood" process: false held: "on the bench" body box(100, 100, 12) cut hole(d: 3, depth: 10.5, at: (20, 0, 12), dir: -Z) }
part foot { material: "PETG CF" body box(40, 40, 10, at: (20, 0, 12)) cut hole(d: 4.5, depth: 10.1, at: (20, 0, 22), dir: -Z, csink: 8.4) }
`;
    const loose = await items(board);
    expect(loose.map((i) => `${i.status} ${i.id}`)).toEqual(["fail held:rests:foot"]);
    const screwed = await items(`${board}component s = lib.screw("8G", 20) { at: (20, 0, 22), axis: -Z }`);
    expect(screwed.map((i) => `${i.status} ${i.id}`).sort()).toEqual(["pass clamp:ok", "pass held:ok"]);
  }, 60_000);
});

describe("riding parts in the mechanism simulation", () => {
  const src = `design "Teacups"
part base { material: "Aluminum 6061"  body cylinder(d: 240, h: 10, at: (0, 0, -20)) }
component sun = lib.spur_gear(m: 2, z: 30, width: 8) { at: (0, 0, 0), axis: Z }
part deck {
  material: "Aluminum 6061"
  body cylinder(d: 200, h: 5, at: (0, 0, 10))
  cut hole(M4, through: true, at: (-60, 0, 15))
  spin: 1
}
component planet = lib.spur_gear(m: 2, z: 15, width: 8) { at: (45, 0, 0), axis: Z, mesh: sun, rides: deck }
part seat { material: "PETG"  body box(30, 30, 4, at: (-60, 0, 15))  cut hole(M4, through: true, at: (-60, 0, 19)) }
component bolt = lib.screw(M4, 16) { at: (-60, 0, 19), axis: -Z }
component nut = lib.nut(M4) { at: (-60, 0, 10), axis: -Z }
scenario "Spin" {
  mechanism: sim.mechanism()
  duration: 1s
}
`;
  it("pivots the planet on the deck, rolls it round the still sun, and moves the bolted seat with the deck", async () => {
    await initKernel();
    const model = evaluate(src);
    expect(model.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
    const core = new KernelCore();
    for (const p of model.parts) core.build({ hash: p.hash, recipe: p.recipe, label: p.label });
    const geom = (h: string) => {
      const e = core.get(h);
      return e ? { preview: core.mesh(h, "preview"), volume: e.volume, bbox: e.bbox, rev: 0 } : undefined;
    };
    const r = resolveMechanism(model.scenarios![0].spec, model, geom, true);
    if (!("mech" in r)) throw new Error(JSON.stringify(r));
    const planet = r.mech.joints.find((j) => j.name === "planet")!;
    expect(planet.on).toBe("deck");
    expect(r.mech.links.find((l) => l.kind === "gears" && l.a === "planet")).toMatchObject({ b: FRAME });
    const deck = r.mech.bodies.find((b) => b.id === "deck")!;
    const names = deck.parts.map((id) => model.parts.find((p) => p.id === id)!.name).sort();
    expect(names).toEqual(["bolt", "deck", "nut", "seat"]);
  }, 60_000);
});
