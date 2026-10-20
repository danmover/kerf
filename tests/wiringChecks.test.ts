// The wiring and mounting checks: the router keeps each cable's whole
// thickness out of the parts and apart from the other cables, takes cables
// through holes and into hollow parts, and the checks catch what is left:
// a cable forced through a wall, a plug that runs into a part or another
// plug, and boards that rest on a shelf with nothing holding them.

import { describe, expect, it } from "vitest";
import type { V3 } from "../src/kernel/recipe";
import { routeWithField, type RouteGeometry, type RoutePlaced } from "../src/machine/harness/route";
import { Solids } from "../src/machine/harness/solids";
import { checkWiring } from "../src/machine/harness/clash";
import { checkMounts, type MountSpec, type ScrewSpec } from "../src/machine/harness/mounts";
import { wiringItems } from "../src/machine/harness/checks";
import type { Harness, HarnessWire, PlugEnd } from "../src/machine/harness/harness";
import type { PlugKind } from "../src/machine/harness/plugs";
import type { Model } from "../src/core/model";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A closed box mesh from lo to hi; inward-facing when `inward` (the inside of a hollow). */
function boxTris(lo: V3, hi: V3, inward = false, base = 0): { p: number[]; i: number[] } {
  const p: number[] = [];
  for (let c = 0; c < 8; c++) p.push(c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2]);
  const quads = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ];
  const i = quads.flatMap(([a, b, c, d]) => (inward ? [a, c, b, a, d, c] : [a, b, c, a, c, d])).map((k) => k + base);
  return { p, i };
}
const box = (lo: V3, hi: V3): RouteGeometry => {
  const t = boxTris(lo, hi);
  return { positions: new Float32Array(t.p), indices: new Uint32Array(t.i) };
};
/** A sealed hollow box: walls `wall` thick, nothing through them. */
const hollow = (lo: V3, hi: V3, wall: number): RouteGeometry => {
  const a = boxTris(lo, hi);
  const b = boxTris([lo[0] + wall, lo[1] + wall, lo[2] + wall], [hi[0] - wall, hi[1] - wall, hi[2] - wall], true, 8);
  return { positions: new Float32Array([...a.p, ...b.p]), indices: new Uint32Array([...a.i, ...b.i]) };
};

const X: V3 = [1, 0, 0];
const Y: V3 = [0, 1, 0];
const Z: V3 = [0, 0, 1];
const neg = (v: V3): V3 => [-v[0], -v[1], -v[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** A plug end at o going in along z (pointing away from its part). */
function end(partId: string, pin: string, o: V3, z: V3, kind: PlugKind = "lead", x: V3 = Math.abs(z[0]) > 0.9 ? Y : X): PlugEnd {
  const frame = { o, x, y: cross(z, x), z };
  return { partId, comp: partId, pin, label: pin, part: partId, spec: { kind, at: [0, 0, 0], out: z, row: x, ways: 2 }, local: frame, frame };
}
function wire(id: string, a: PlugEnd, b: PlugEnd, d: number): HarnessWire {
  return { id, row: { id } as HarnessWire["row"], ends: [a, b], wires: [{ color: "#c00", name: "red", d }], d };
}
const harness = (wires: HarnessWire[]): Harness => ({ wires, sockets: [] });

/** Route a harness's wires through the solids and check them. */
function routeAndCheck(h: Harness, geos: RouteGeometry[], placed: RoutePlaced[]) {
  const solids = new Solids(geos, placed);
  const wires = h.wires.map((w) => ({ id: w.id, a: { p: w.ends[0].frame.o, dir: w.ends[0].frame.z }, b: { p: w.ends[1].frame.o, dir: w.ends[1].frame.z }, d: w.d }));
  const { result, field } = routeWithField({ geos, placed, wires }, solids);
  return { result, solids, findings: checkWiring(h, result.wires, solids, field) };
}

/** Distance from p to a box, negative inside it. */
function boxDist(p: V3, lo: V3, hi: V3): number {
  const d = [0, 1, 2].map((k) => Math.max(lo[k] - p[k], p[k] - hi[k]));
  const out = Math.hypot(...d.map((v) => Math.max(0, v)));
  return out > 0 ? out : Math.max(...d);
}

describe("cable routing", () => {
  it("keeps a thick cable's whole radius off a block in its way", () => {
    const lo: V3 = [-10, -30, -30];
    const hi: V3 = [10, 30, 30];
    const h = harness([wire("W1", end("a", "P", [-50, 0, 0], neg(X)), end("b", "P", [50, 0, 0], X), 6)]);
    const { result, findings } = routeAndCheck(h, [box(lo, hi)], [{ geo: 0, m: IDENTITY, id: "block" }]);
    const run = result.wires[0];
    expect(run.straight).toBe(false);
    for (const p of run.points) expect(boxDist(p, lo, hi)).toBeGreaterThan(3 - 0.35);
    expect(findings.cableHits).toEqual([]);
  });

  it("lays cables through one gap side by side, not through each other", () => {
    // two blocks leave a 16 mm slot; four 4 mm cables cross through it
    const geos = [box([-10, -60, -40], [10, -8, 40]), box([-10, 8, -40], [10, 60, 40])];
    const placed: RoutePlaced[] = [
      { geo: 0, m: IDENTITY, id: "left" },
      { geo: 1, m: IDENTITY, id: "right" },
    ];
    const wires = [0, 1, 2, 3].map((k) => wire(`W${k + 1}`, end(`a${k}`, "P", [-50, (k - 1.5) * 12, -20 + k * 10], neg(X)), end(`b${k}`, "P", [50, (1.5 - k) * 12, 20 - k * 10], X), 4));
    const { result, findings } = routeAndCheck(harness(wires), geos, placed);
    expect(result.wires.every((w) => !w.straight)).toBe(true);
    expect(findings.cableHits).toEqual([]);
    expect(findings.crossings.filter((c) => c.depth > 0.6)).toEqual([]);
  });

  it("takes a cable into a sealed box through its wall, and says so", () => {
    // the hollow inside the box is free space, so the far end can be reached, but only through a wall
    const h = harness([wire("W1", end("a", "P", [-60, 0, 0], neg(X)), end("b", "P", [0, 0, 0], X), 3)]);
    const { result, findings } = routeAndCheck(h, [hollow([-20, -20, -20], [20, 20, 20], 3)], [{ geo: 0, m: IDENTITY, id: "case" }]);
    expect(result.wires[0].straight).toBe(false);
    expect(findings.cableHits.map((c) => [c.wire, c.part, c.through])).toEqual([["W1", "case", true]]);
    const items = wiringItems(h, findings, [], { parts: [] } as unknown as Model);
    expect(items.find((i) => i.id === "wiring:through:case")?.status).toBe("fail");
  });
});

describe("plugs", () => {
  it("finds a plug that points into a part, and two plugs in one place", () => {
    const geos = [box([-20, -20, 0], [20, 20, 20])];
    const placed: RoutePlaced[] = [{ geo: 0, m: IDENTITY, id: "wall" }];
    // an XH plug whose pins point down into the block, and two side by side at the same spot
    const into = end("brd", "J1", [0, 0, 25], neg(Z), "xh");
    const a = end("brd2", "J2", [60, 0, 0], X, "xh");
    const b = end("brd2", "J3", [60, 2, 0], X, "xh");
    const h = harness([wire("W1", into, end("m", "P", [-60, 0, 30], neg(X)), 1.5), wire("W2", a, end("m2", "P", [120, 0, 0], X), 1.5), wire("W3", b, end("m3", "P", [120, 20, 0], X), 1.5)]);
    const { findings } = routeAndCheck(h, geos, placed);
    expect(findings.plugHits.map((p) => [p.wire, p.part])).toEqual([["W1", "wall"]]);
    expect(findings.plugClashes.map((c) => [c.a.wire, c.b.wire])).toEqual([["W2", "W3"]]);
  });
});

describe("how boards are held", () => {
  // a 50 × 30 board, 1.6 thick, with two holes, sitting on a shelf
  const board: MountSpec = { comp: "brd", partId: "brd", label: "Board", m: IDENTITY, body: [[-25, -15, 0], [25, 15, 1.6]], board: true, holes: [{ x: -20, y: -10, d: 3.2 }, { x: 20, y: 10, d: 3.2 }] };
  const geos = [box([-25, -15, 0], [25, 15, 1.6]), box([-40, -30, -6], [40, 30, 0]), box([-1.5, -1.5, -8], [1.5, 1.5, 0]), box([-1.2, -1.2, -0.01], [1.2, 1.2, 2.1])];
  const solidsWith = (extra: RoutePlaced[] = []) =>
    new Solids(geos, [{ geo: 0, m: IDENTITY, id: "brd", comp: "brd", role: "mount" }, { geo: 1, m: IDENTITY, id: "shelf", role: "made" }, ...extra]);
  const screw = (x: number, y: number): ScrewSpec => ({ id: `s${x}`, seat: [x, y, 1.6], axis: [0, 0, -1], length: 8, d: 3 });
  // a screw's own shank, for the board's holes to find
  const shank = (x: number, y: number): RoutePlaced => ({ geo: 2, m: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 1.6, 1], id: `s${x}`, role: "fastener" });

  it("calls a board resting on a shelf loose", () => {
    const [r] = checkMounts([board], [], solidsWith());
    expect(r.verdict).toBe("loose");
    expect(r.free.map((f) => f.local)).toContain("+z");
    const items = wiringItems(harness([]), null, [r], { parts: [] } as unknown as Model);
    expect(items[0]).toMatchObject({ id: "mount:brd", status: "fail" });
  });

  it("holds it with screws through two holes into the shelf", () => {
    const [r] = checkMounts([board], [screw(-20, -10), screw(20, 10)], solidsWith([shank(-20, -10), shank(20, 10)]));
    expect(r.verdict).toBe("screwed");
    expect(r.screwed).toEqual(["s-20", "s20"]);
  });

  it("warns about one screw unless a peg stops it turning, takes the design's word for tape, and fails a board in mid-air", () => {
    expect(checkMounts([board], [screw(-20, -10)], solidsWith([shank(-20, -10)]))[0].verdict).toBe("one-screw");
    // a peg on the shelf through the other hole stops it turning
    const peg: RoutePlaced = { geo: 3, m: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 20, 10, 0, 1], id: "shelf", role: "made" };
    expect(checkMounts([board], [screw(-20, -10)], solidsWith([shank(-20, -10), peg]))[0].verdict).toBe("screwed");
    expect(checkMounts([{ ...board, held: "double-sided foam tape" }], [], solidsWith())[0].verdict).toBe("declared");
    const lifted = { ...board, m: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 50, 1] };
    const air = new Solids(geos, [{ geo: 0, m: lifted.m, id: "brd", comp: "brd", role: "mount" }, { geo: 1, m: IDENTITY, id: "shelf", role: "made" }]);
    expect(checkMounts([lifted], [], air)[0].verdict).toBe("floating");
  });
});
