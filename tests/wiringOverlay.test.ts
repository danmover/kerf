// The cables in the 3D view are built once for what they are built from. A design is read again at every edit and
// its wiring mostly comes back the same: building every cable again each time held the page for a good part of a
// second on a large harness.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "../src/lang/evaluator";
import { buildHarness } from "../src/machine/harness/harness";
import type { RoutedWire } from "../src/machine/harness/route";
import { WiringOverlay } from "../src/ui/viewport/wiring/overlay";

const demo = (name: string) => evaluate(readFileSync(join(__dirname, `../src/demos/${name}.kerf`), "utf8"));
const host = () => ({ partGroup: () => undefined, requestRender: () => undefined });
/** a route for a wire: a straight run between two points */
const run = (id: string, z: number): RoutedWire => ({ id, points: [[0, 0, z], [40, 0, z], [40, 30, z]], length: 70, through: 0, straight: false, r: 1 }) as RoutedWire;

describe("the cables in the 3D view", () => {
  it("are built once, and left as they are when asked to be built from the same again", () => {
    const model = demo("printer");
    const o = new WiringOverlay(host());
    const h = buildHarness(model);
    const routes = new Map(h.wires.slice(0, 3).map((w) => [w.id, run(w.id, 5)]));
    expect(o.set(h, routes, model.parts)).toBe(true);
    expect(o.size).toBe(h.wires.length);
    const cables = [...o.object.children];
    // the design read again: another harness and other routes, saying the same
    const again = buildHarness(demo("printer"));
    expect(again).not.toBe(h);
    expect(o.set(again, new Map([...routes].map(([id, r]) => [id, { ...r, points: r.points.map((p) => [...p]) as RoutedWire["points"] }])), demo("printer").parts)).toBe(false);
    expect(o.object.children).toEqual(cables);
    expect(o.object.children.every((c, i) => c === cables[i])).toBe(true);
    o.dispose();
  });

  it("are built again when a route, a part's place, or the harness changes", () => {
    const model = demo("printer");
    const o = new WiringOverlay(host());
    const h = buildHarness(model);
    const id = h.wires[0].id;
    expect(o.set(h, new Map([[id, run(id, 5)]]), model.parts)).toBe(true);
    // a route that goes another way
    expect(o.set(h, new Map([[id, run(id, 9)]]), model.parts)).toBe(true);
    expect(o.set(h, new Map([[id, run(id, 9)]]), model.parts)).toBe(false);
    // a part moved
    const moved = model.parts.map((p, i) => (i === 0 ? { ...p, xf: [...p.xf, { kind: "translate", v: [1, 0, 0] }] } : p)) as typeof model.parts;
    expect(o.set(h, new Map([[id, run(id, 9)]]), moved)).toBe(true);
    // a wire fewer
    expect(o.set({ ...h, wires: h.wires.slice(1) }, new Map(), moved)).toBe(true);
    expect(o.size).toBe(h.wires.length - 1);
    o.dispose();
  });

  it("are built again after the view let go of them", () => {
    const model = demo("printer");
    const o = new WiringOverlay(host());
    const h = buildHarness(model);
    expect(o.set(h, null, model.parts)).toBe(true);
    o.dispose();
    expect(o.size).toBe(0);
    expect(o.set(h, null, model.parts)).toBe(true);
    expect(o.size).toBe(h.wires.length);
    o.dispose();
  });
});
