import { describe, expect, it } from "vitest";
import type { V3, Xform } from "../src/kernel/recipe";
import { applyXforms } from "../src/kernel/recipe";
import { bodyBox, freedomWords, movePoint, moveDir, pickAxis, pickPlane, solveMates, type FaceCatalogue, type MateBody, type MateGeom, type MateKind, type MateSpec, type PlacedCatalogue } from "../src/core/mates";

/** A box's flat faces, from lo to hi, in its own coordinates. */
function boxCat(lo: V3, hi: V3, rounds: FaceCatalogue["rounds"] = []): FaceCatalogue {
  const planes: FaceCatalogue["planes"] = [];
  for (let a = 0; a < 3; a++)
    for (const s of [-1, 1]) {
      const n: V3 = [0, 0, 0];
      n[a] = s;
      const p: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
      p[a] = s > 0 ? hi[a] : lo[a];
      const flo = lo.slice() as V3,
        fhi = hi.slice() as V3;
      flo[a] = fhi[a] = p[a];
      const u = (a + 1) % 3,
        v = (a + 2) % 3;
      planes.push({ p, n, area: (hi[u] - lo[u]) * (hi[v] - lo[v]), lo: flo, hi: fhi });
    }
  return { planes, rounds, box: [lo, hi] };
}

const body = (name: string, solids: PlacedCatalogue[]): MateBody => {
  const [lo, hi] = bodyBox(solids)!;
  return { name, c: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2], size: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 };
};
const geom = (g: MateGeom | string): MateGeom => {
  if (typeof g === "string") throw new Error(g);
  return g;
};
let count = 0;
const mate = (kind: MateKind, a: [string, MateGeom], b: [string, MateGeom], more: Partial<MateSpec> = {}): MateSpec => ({ name: `mate ${++count}`, kind, a: { body: a[0], geom: a[1], label: a[0] }, b: { body: b[0], geom: b[1], label: b[0] }, ...more });

// a 60 × 40 × 30 box at the origin, and a 60 × 40 × 10 lid drawn 20 mm above it, 5 mm along X and turned 3° about Z
const box: PlacedCatalogue[] = [{ cat: boxCat([0, 0, 0], [60, 40, 30], [{ p: [10, 10, 25], d: [0, 0, 1], r: 2.5, len: 10, area: 157 }]), xf: [] }];
const lidXf: Xform[] = [
  { op: "rotate", angle: 3, origin: [30, 20, 0], axis: [0, 0, 1] },
  { op: "translate", v: [5, 0, 50] },
];
const lid: PlacedCatalogue[] = [{ cat: boxCat([0, 0, 0], [60, 40, 10], [{ p: [10, 10, 5], d: [0, 0, 1], r: 2.5, len: 10, area: 157 }]), xf: lidXf }];
const bodies = () => [body("box", box), body("lid", lid)];

describe("picking faces", () => {
  it("takes the face farthest out that way, or the one nearest a point", () => {
    const top = geom(pickPlane("box", box, [0, 0, 1]));
    expect(top).toMatchObject({ t: "plane", n: [0, 0, 1] });
    expect((top as { p: V3 }).p[2]).toBeCloseTo(30, 9);
    const under = geom(pickPlane("lid", lid, [0, 0, -1]));
    expect((under as { p: V3 }).p[2]).toBeCloseTo(50, 9);
    expect(pickPlane("box", box, [1, 1, 0])).toMatch(/no flat face facing/);
    const near = geom(pickPlane("box", box, undefined, [61, 20, 15]));
    expect((near as { n: V3 }).n[0]).toBeCloseTo(1, 9);
  });

  it("takes a round face's axis by diameter or a point by it, and asks when it cannot tell", () => {
    const two: PlacedCatalogue[] = [{ cat: boxCat([0, 0, 0], [60, 40, 30], [{ p: [10, 10, 25], d: [0, 0, 1], r: 2.5, len: 10, area: 157 }, { p: [50, 30, 25], d: [0, 0, 1], r: 4, len: 10, area: 251 }]), xf: [] }];
    expect(pickAxis("box", two, {})).toMatch(/several axes/);
    expect(geom(pickAxis("box", two, { d: 8 }))).toMatchObject({ t: "axis", p: [50, 30, 25], r: 4 });
    expect(geom(pickAxis("box", two, { near: [11, 9, 30] }))).toMatchObject({ p: [10, 10, 25] });
    expect(pickAxis("box", two, { d: 6 })).toMatch(/no round face 6 mm across/);
  });
});

describe("solving mates", () => {
  it("sits a lid on a box and squares it up, fully placed", () => {
    const m = [
      mate("against", ["lid", geom(pickPlane("lid", lid, [0, 0, -1]))], ["box", geom(pickPlane("box", box, [0, 0, 1]))]),
      mate("flush", ["lid", geom(pickPlane("lid", lid, [1, 0, 0], applyXforms([60, 20, 5], lidXf)))], ["box", geom(pickPlane("box", box, [1, 0, 0]))]),
      mate("flush", ["lid", geom(pickPlane("lid", lid, undefined, applyXforms([30, 40, 5], lidXf)))], ["box", geom(pickPlane("box", box, [0, 1, 0]))]),
    ];
    const s = solveMates(bodies(), m);
    expect(s.outcomes.every((o) => o.status === "ok")).toBe(true);
    const mv = s.moves.get("lid")!;
    // the lid's own corner (0, 0, 0) lands on the box's top corner
    const corner = movePoint(mv, applyXforms([0, 0, 0], lidXf));
    expect(corner[0]).toBeCloseTo(0, 6);
    expect(corner[1]).toBeCloseTo(0, 6);
    expect(corner[2]).toBeCloseTo(30, 6);
    expect(s.free.find((f) => f.body === "lid")).toMatchObject({ dof: 0, words: "fully placed by its mates" });
    expect(s.moves.has("box")).toBe(false);
  });

  it("leaves what a mate does not fix where it is drawn, and says what is free", () => {
    const s = solveMates(bodies(), [mate("against", ["lid", geom(pickPlane("lid", lid, [0, 0, -1]))], ["box", geom(pickPlane("box", box, [0, 0, 1]))])]);
    const mv = s.moves.get("lid")!;
    // it only drops: still 5 mm along and still turned 3°
    const c0 = applyXforms([30, 20, 0], lidXf);
    const c1 = movePoint(mv, c0);
    expect(c1[0]).toBeCloseTo(c0[0], 6);
    expect(c1[1]).toBeCloseTo(c0[1], 6);
    expect(c1[2]).toBeCloseTo(30, 6);
    const f = s.free.find((x) => x.body === "lid")!;
    expect(f.dof).toBe(3);
    expect(f.words).toBe("turns about Z and slides in the plane across Z");
  });

  it("lines a pin up in a hole: it can still turn and slide in it, until a pin mate holds it along", () => {
    const pin: PlacedCatalogue[] = [{ cat: { planes: [], rounds: [{ p: [0, 0, 10], d: [0, 0, 1], r: 2.5, len: 20, area: 314 }], box: [[-2.5, -2.5, 0], [2.5, 2.5, 20]] }, xf: [{ op: "rotate", angle: 4, origin: [0, 0, 0], axis: [1, 0, 0] }, { op: "translate", v: [12, 11, 40] }] }];
    const b = [...bodies(), body("pin", pin)];
    const hole = geom(pickAxis("box", box, {}));
    const s = solveMates(b, [mate("concentric", ["pin", geom(pickAxis("pin", pin, {}))], ["box", hole])]);
    const mv = s.moves.get("pin")!;
    const d = moveDir(mv, applyXforms([0, 0, 1], [{ op: "rotate", angle: 4, origin: [0, 0, 0], axis: [1, 0, 0] }]));
    expect(Math.abs(d[2])).toBeCloseTo(1, 9);
    const tip = movePoint(mv, applyXforms([0, 0, 0], pin[0].xf));
    expect(tip[0]).toBeCloseTo(10, 6);
    expect(tip[1]).toBeCloseTo(10, 6);
    const f = s.free.find((x) => x.body === "pin")!;
    expect(f.dof).toBe(2);
    expect(f.words).toMatch(/^turns about an axis along Z through \(10, 10, [\d.]+\) and slides along Z$/);
    // a pin mate also centres it along the hole: only the turn is left
    const s2 = solveMates(b, [mate("pin", ["pin", geom(pickAxis("pin", pin, {}))], ["box", hole])]);
    const mid = movePoint(s2.moves.get("pin")!, applyXforms([0, 0, 10], pin[0].xf));
    expect(mid[2]).toBeCloseTo(25, 5);
    expect(s2.free.find((x) => x.body === "pin")!.dof).toBe(1);
  });

  it("leaves out a mate that cannot hold with the ones before it, and says by how much", () => {
    const step: PlacedCatalogue[] = [{ cat: boxCat([70, 0, 0], [90, 40, 35]), xf: [] }];
    const s = solveMates(
      [...bodies(), body("step", step)],
      [
        mate("against", ["lid", geom(pickPlane("lid", lid, [0, 0, -1]))], ["box", geom(pickPlane("box", box, [0, 0, 1]))]),
        mate("against", ["lid", geom(pickPlane("lid", lid, [0, 0, -1]))], ["step", geom(pickPlane("step", step, [0, 0, 1]))]),
      ],
    );
    expect(s.outcomes[0].status).toBe("ok");
    expect(s.outcomes[1].status).toBe("conflict");
    expect(s.outcomes[1].off).toBeCloseTo(5, 3);
    expect(s.outcomes[1].message).toMatch(/cannot hold with the mates before it \(off by 5 mm\), so it is left out/);
    expect(movePoint(s.moves.get("lid")!, applyXforms([0, 0, 0], lidXf))[2]).toBeCloseTo(30, 6);
  });

  it("moves a part mated to a moving one after it, and a part fastened rigidly with it", () => {
    const knob: PlacedCatalogue[] = [{ cat: { planes: [{ p: [0, 0, 0], n: [0, 0, -1], area: 50, lo: [-4, -4, 0], hi: [4, 4, 0] }], rounds: [{ p: [0, 0, 4], d: [0, 0, 1], r: 4, len: 8, area: 200 }], box: [[-4, -4, 0], [4, 4, 8]] }, xf: [{ op: "translate", v: [20, 15, 75] }] }];
    const screw: PlacedCatalogue[] = [{ cat: boxCat([0, 0, 0], [2, 2, 2]), xf: [{ op: "translate", v: [40, 20, 61] }] }];
    const s = solveMates(
      [...bodies(), body("knob", knob), body("screw", screw)],
      [
        mate("concentric", ["knob", geom(pickAxis("knob", knob, {}))], ["lid", geom(pickAxis("lid", lid, {}))]),
        mate("against", ["knob", geom(pickPlane("knob", knob, [0, 0, -1]))], ["lid", geom(pickPlane("lid", lid, [0, 0, 1]))]),
        mate("rigid", ["screw", { t: "body" }], ["lid", { t: "body" }]),
        mate("against", ["lid", geom(pickPlane("lid", lid, [0, 0, -1]))], ["box", geom(pickPlane("box", box, [0, 0, 1]))]),
      ],
    );
    expect(s.order.indexOf("lid")).toBeLessThan(s.order.indexOf("knob"));
    // the lid drops 20 mm onto the box; the knob sits on the lid's top (z 40) over its hole, and the screw drops with it
    const lidMove = s.moves.get("lid")!;
    const hole = movePoint(lidMove, applyXforms([10, 10, 10], lidXf));
    const knobBase = movePoint(s.moves.get("knob")!, applyXforms([0, 0, 0], knob[0].xf));
    expect(knobBase[0]).toBeCloseTo(hole[0], 5);
    expect(knobBase[1]).toBeCloseTo(hole[1], 5);
    expect(knobBase[2]).toBeCloseTo(40, 5);
    const sc = movePoint(s.moves.get("screw")!, [40, 20, 61]);
    const sameAsLid = movePoint(lidMove, [40, 20, 61]);
    for (let k = 0; k < 3; k++) expect(sc[k]).toBeCloseTo(sameAsLid[k], 9);
    expect(s.free.find((f) => f.body === "screw")!.words).toBe("moves with lid");
  });
});

describe("hinges, limits and dragging", () => {
  // a lid hinged along the box's back top edge (y 40, z 30), drawn shut
  const hinge: PlacedCatalogue[] = [{ cat: boxCat([0, 0, 30], [60, 40, 40], [{ p: [30, 40, 30], d: [1, 0, 0], r: 3, len: 60, area: 1100 }]), xf: [] }];
  const boxHinge: PlacedCatalogue[] = [{ cat: boxCat([0, 0, 0], [60, 40, 30], [{ p: [30, 40, 30], d: [1, 0, 0], r: 3, len: 60, area: 1100 }]), xf: [] }];
  const hb = () => [body("box", boxHinge), body("lid", hinge)];
  const pinMate = () => mate("pin", ["lid", geom(pickAxis("lid", hinge, {}))], ["box", geom(pickAxis("box", boxHinge, {}))]);
  const tilt = () => mate("angle", ["lid", geom(pickPlane("lid", hinge, [0, 0, 1]))], ["box", geom(pickPlane("box", boxHinge, [0, 0, 1]))], { min: 0, max: (100 * Math.PI) / 180 });

  it("turns on its hinge when dragged, and stops at its limit", () => {
    const s0 = solveMates(hb(), [pinMate(), tilt()]);
    expect(s0.free.find((f) => f.body === "lid")!.words).toMatch(/^turns about an axis along X through \([\d.]+, 40, 30\)$/);
    // pull the lid's front edge up and back over the hinge
    const front: V3 = [30, 0, 40];
    const up = solveMates(hb(), [pinMate(), tilt()], { start: s0.moves, drag: { body: "lid", point: front, target: [30, 40, 85] } });
    const p = movePoint(up.moves.get("lid")!, front);
    // still on the hinge: the front edge stays the lid's depth (and height) from the hinge axis
    expect(Math.hypot(p[1] - 40, p[2] - 30)).toBeCloseTo(Math.hypot(40, 10), 5);
    expect(p[2]).toBeGreaterThan(60);
    // pulled past 100° it stops there
    const far = solveMates(hb(), [pinMate(), tilt()], { start: s0.moves, drag: { body: "lid", point: front, target: [30, 120, -20] } });
    const n = moveDir(far.moves.get("lid")!, [0, 0, 1]);
    expect((Math.acos(n[2]) * 180) / Math.PI).toBeCloseTo(100, 3);
    expect(far.outcomes[1].status).toBe("limit");
  });

  it("holds a part drawn past a limit at that limit", () => {
    const open: PlacedCatalogue[] = [{ cat: hinge[0].cat, xf: [{ op: "rotate", angle: -120, origin: [30, 40, 30], axis: [1, 0, 0] }] }];
    const s = solveMates([body("box", boxHinge), body("lid", open)], [mate("pin", ["lid", geom(pickAxis("lid", open, {}))], ["box", geom(pickAxis("box", boxHinge, {}))]), mate("angle", ["lid", geom(pickPlane("lid", open, undefined, applyXforms([30, 20, 40], open[0].xf)))], ["box", geom(pickPlane("box", boxHinge, [0, 0, 1]))], { min: 0, max: (100 * Math.PI) / 180 })]);
    const n = moveDir(s.moves.get("lid")!, applyXforms([0, 0, 1], [{ op: "rotate", angle: -120, origin: [0, 0, 0], axis: [1, 0, 0] }]));
    expect((Math.acos(n[2]) * 180) / Math.PI).toBeCloseTo(100, 3);
  });
});

describe("free motions in words", () => {
  it("names a ball joint and a free part", () => {
    expect(freedomWords([{ w: [1, 0, 0], v: [0, 0, 0] }, { w: [0, 1, 0], v: [0, 0, 0] }, { w: [0, 0, 1], v: [0, 0, 0] }], [0, 0, 0], 10)).toBe("turns every way");
    expect(freedomWords([{ w: [0, 0, 0], v: [1, 0, 0] }], [0, 0, 0], 10)).toBe("slides along X");
  });
});

describe("parts drawn far from where their mates put them", () => {
  const blockCat: PlacedCatalogue[] = [{ cat: boxCat([0, 0, 0], [20, 20, 20]), xf: [{ op: "translate", v: [100, 0, 0] }] }];
  const two = () => [body("box", box), body("block", blockCat)];
  const top = () => geom(pickPlane("box", box, [0, 0, 1]));

  it("turns a part over when its face is drawn facing the wrong way for against()", () => {
    // the block's top against the box's top: it has to be turned upside down
    const s = solveMates(two(), [mate("against", ["block", geom(pickPlane("block", blockCat, [0, 0, 1]))], ["box", top()])]);
    expect(s.outcomes[0].status).toBe("ok");
    const n = moveDir(s.moves.get("block")!, [0, 0, 1]);
    expect(n[2]).toBeCloseTo(-1, 6);
  });

  it("stands a part square when it is drawn parallel and has to be perpendicular", () => {
    const s = solveMates(two(), [mate("perpendicular", ["block", geom(pickPlane("block", blockCat, [0, 0, 1]))], ["box", top()])]);
    expect(s.outcomes[0].status).toBe("ok");
    expect(Math.abs(moveDir(s.moves.get("block")!, [0, 0, 1])[2])).toBeLessThan(1e-6);
  });

  it("lines up axes drawn a quarter turn apart", () => {
    const s = solveMates(two(), [mate("concentric", ["block", { t: "axis", p: [110, 10, 10], d: [1, 0, 0] }], ["box", { t: "axis", p: [10, 10, 25], d: [0, 0, 1] }])]);
    expect(s.outcomes[0].status).toBe("ok");
    expect(Math.abs(moveDir(s.moves.get("block")!, [1, 0, 0])[2])).toBeCloseTo(1, 6);
    const p = movePoint(s.moves.get("block")!, [110, 10, 10]);
    expect(Math.hypot(p[0] - 10, p[1] - 10)).toBeLessThan(1e-6);
  });
});

describe("joints by the names other CAD gives them", () => {
  // a carriage drawn on its rod a little turned about it and off to one side; the rod runs along X at y 10, z 25
  const rod: PlacedCatalogue[] = [{ cat: boxCat([0, 0, 0], [200, 20, 20], [{ p: [100, 10, 25], d: [1, 0, 0], r: 4, len: 200, area: 5000 }]), xf: [] }];
  const carXf: Xform[] = [
    { op: "rotate", angle: 12, origin: [0, 10, 25], axis: [1, 0, 0] },
    { op: "translate", v: [60, 3, 2] },
  ];
  const car: PlacedCatalogue[] = [{ cat: boxCat([-15, -5, 15], [15, 25, 35], [{ p: [0, 10, 25], d: [1, 0, 0], r: 4, len: 30, area: 750 }]), xf: carXf }];
  const two = () => [body("rod", rod), body("car", car)];
  const axes = (): [[string, MateGeom], [string, MateGeom]] => [["car", geom(pickAxis("car", car, {}))], ["rod", geom(pickAxis("rod", rod, {}))]];

  it("a slider only slides: in line, kept from turning about the rod as drawn", () => {
    const [a, b] = axes();
    const s = solveMates(two(), [mate("slider", a, b)]);
    expect(s.outcomes[0].status).toBe("ok");
    const mv = s.moves.get("car")!;
    // on the rod's axis, and still turned 12° about it as it is drawn (a slider keeps the turn it is drawn with)
    const c = movePoint(mv, applyXforms([0, 10, 25], carXf));
    expect(Math.hypot(c[1] - 10, c[2] - 25)).toBeLessThan(1e-6);
    const f = s.free.find((x) => x.body === "car")!;
    expect(f.dof).toBe(1);
    expect(f.words).toBe("slides along X");
    // dragged up and round, it only slides along
    const grab = movePoint(mv, applyXforms([0, 10, 35], carXf));
    const d = solveMates(two(), [mate("slider", a, b)], { start: s.moves, drag: { body: "car", point: grab, target: [grab[0] + 40, grab[1] - 30, grab[2] + 30] } });
    const moved = movePoint(d.moves.get("car")!, applyXforms([0, 10, 35], carXf));
    expect(moved[0] - grab[0]).toBeCloseTo(40, 4);
    expect(moved[1]).toBeCloseTo(grab[1], 6);
    expect(moved[2]).toBeCloseTo(grab[2], 6);
    // a concentric (cylindrical) mate would let it turn as well
    expect(solveMates(two(), [mate("cylindrical", a, b)]).free.find((x) => x.body === "car")!.dof).toBe(2);
  });

  it("a revolute joint is a pin, a ball joint is two points together, a planar joint two faces in one plane", () => {
    const [a, b] = axes();
    const rev = solveMates(two(), [mate("revolute", a, b)]);
    const pin = solveMates(two(), [mate("pin", a, b)]);
    const at = (s: ReturnType<typeof solveMates>) => movePoint(s.moves.get("car")!, applyXforms([0, 10, 25], carXf));
    expect(at(rev)).toEqual(at(pin));
    expect(rev.free.find((x) => x.body === "car")!.words).toMatch(/^turns about an axis along X/);
    const ball = solveMates(two(), [mate("ball", ["car", { t: "point", p: applyXforms([0, 10, 25], carXf) }], ["rod", { t: "point", p: [0, 10, 25] }])]);
    expect(ball.free.find((x) => x.body === "car")!.words).toMatch(/^turns every way/);
    const puck = solveMates(two(), [mate("planar", ["car", geom(pickPlane("car", car, undefined, applyXforms([0, 10, 15], carXf)))], ["rod", geom(pickPlane("rod", rod, [0, 0, 1]))])]);
    expect(puck.outcomes[0].status).toBe("ok");
    expect(puck.free.find((x) => x.body === "car")!.dof).toBe(3);
  });
});
