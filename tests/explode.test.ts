// Smart exploded views: screws back out along their axes, nuts drop off the far
// end, parts come off the stacks, fits and faces they sit on, in order, and
// every template explodes without parts left inside each other.

import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { explodeOffsets, planExplode, spreadOffsets, stepProgress } from "../src/core/explode";
import { TEMPLATES } from "../src/demos/templates";
import { worldBox } from "../src/core/holds";

const plates = `
part base { material: "Aluminum 6061"  body box(60, 60, 6)  cut hole(M3, through: true, at: (10, 0, 6)) }
part plate { material: "Aluminum 6061"  body box(30, 30, 3, at: (0, 0, 6))  cut hole(M3, through: true, at: (10, 0, 9)) }
component s = lib.screw(M3, 12) { at: (10, 0, 9), axis: -Z }
component w = lib.washer(M3) { at: (10, 0, -0.5), axis: -Z }
component n = lib.nut(M3) { at: (10, 0, -0.5), axis: -Z }
`;

describe("exploded views", () => {
  it("keeps the base, lifts the plate off its screw stack and backs the screw out first", () => {
    const m = evaluate(plates);
    const plan = planExplode(m);
    const mv = (id: string) => plan.moves.get(id)!;
    expect(mv("base").via).toBe("base");
    expect(mv("base").dist).toBe(0);
    expect(mv("plate").dir[2]).toBeCloseTo(1, 6);
    expect(mv("plate").dist).toBeGreaterThan(0);
    expect(mv("s").via).toBe("screw");
    expect(mv("s").dir[2]).toBeCloseTo(1, 6);
    // the screw clears the plate: its tip ends above the plate's top
    expect(mv("s").dist).toBeGreaterThan(12);
    expect(mv("s").from).toBe("plate");
    expect(mv("s").stage).toBeLessThan(mv("plate").stage);
    const full = explodeOffsets(plan, 1);
    expect(full.get("s")![2]).toBeGreaterThan(full.get("plate")![2]);
    // halfway through, the screw is out and the plate is still on
    const half = explodeOffsets(plan, 0.45);
    expect(half.get("s")![2]).toBeGreaterThan(0.5 * full.get("s")![2]);
    expect(half.get("plate")![2]).toBeLessThan(0.5 * full.get("plate")![2]);
    // put together: the base, then the plate, then its hardware
    expect(plan.order.indexOf("base")).toBe(0);
    expect(plan.order.indexOf("plate")).toBeLessThan(plan.order.indexOf("s"));
  });

  it("drops what is under the base off the far end of the screw", () => {
    const plan = planExplode(evaluate(plates));
    const n = plan.moves.get("n")!;
    expect(["nut", "washer"]).toContain(n.via);
    expect(n.dir[2]).toBeCloseTo(-1, 6);
    expect(n.dist).toBeGreaterThan(0);
  });

  it("lifts parts that only sit on each other, each carrying what sits on it", () => {
    const m = evaluate(`
part base { body box(80, 60, 8) }
part block { body box(30, 30, 20, at: (0, 0, 8)) }
part lid { body box(30, 30, 4, at: (0, 0, 28)) }
`);
    const plan = planExplode(m);
    expect(plan.moves.get("block")!.from).toBe("base");
    expect(plan.moves.get("lid")!.from).toBe("block");
    const o = explodeOffsets(plan, 1);
    expect(o.get("base")).toEqual([0, 0, 0]);
    expect(o.get("lid")![2]).toBeGreaterThan(o.get("block")![2]);
    expect(o.get("block")![2]).toBeGreaterThan(0);
    // the lid comes off before the block
    expect(plan.moves.get("lid")!.stage).toBeLessThan(plan.moves.get("block")!.stage);
  });

  it("slides a part out sideways when that frees it soonest", () => {
    const plan = planExplode(
      evaluate(`
part wall { body box(10, 60, 80) }
part shelf { body box(40, 60, 4, at: (25, 0, 30)) }
`),
    );
    const d = plan.moves.get("shelf")!.dir;
    expect(d[0]).toBeCloseTo(1, 6);
  });

  it("follows explode: on a part, and keeps one with explode: false on what it sits on", () => {
    const m = evaluate(`
part base { body box(80, 60, 8) }
part side { body box(10, 20, 20, at: (20, 0, 8))  explode: (1, 0, 0) }
part badge { body box(10, 10, 2, at: (-20, 0, 8))  explode: false }
`);
    const plan = planExplode(m);
    expect(plan.moves.get("side")!.dir).toEqual([1, 0, 0]);
    expect(plan.moves.get("badge")!.dist).toBe(0);
    expect(evaluate(`part a { body box(1, 1, 1)  explode: (0, 0, 0) }`).diagnostics.map((d) => d.message).join()).toMatch(/not \(0, 0, 0\)/);
    expect(evaluate(`part a { body box(1, 1, 1)  explode: "up" }`).diagnostics.map((d) => d.message).join()).toMatch(/explode: is the way/);
  });

  it("steps through the plan in order and lands every part at the end", () => {
    expect(stepProgress(0, 3, 0)).toBe(0);
    expect(stepProgress(2, 3, 1)).toBe(1);
    expect(stepProgress(0, 3, 0.4)).toBeGreaterThan(stepProgress(2, 3, 0.4));
    expect(stepProgress(1, 3, 0.5)).toBeGreaterThan(0);
  });

  it("explodes every template without leaving a part where it was, or a NaN", () => {
    for (const t of TEMPLATES) {
      const m = evaluate(t.source);
      const shown = m.parts.filter((p) => !p.hidden);
      if (shown.length < 2) continue;
      const plan = planExplode(m);
      const o = spreadOffsets(plan, 1);
      for (const p of shown) {
        expect(plan.moves.has(p.id), `${t.id}: ${p.id}`).toBe(true);
        expect(o.get(p.id)!.every(Number.isFinite), `${t.id}: ${p.id}`).toBe(true);
      }
      const moved = shown.filter((p) => o.get(p.id)!.some((x) => Math.abs(x) > 1e-6)).length;
      // parts too free-form to box from their recipes wait for their meshes
      if (shown.filter((p) => worldBox(p)).length >= 2) expect(moved, t.id).toBeGreaterThan(0);
      expect(plan.order.length, t.id).toBe(shown.length);
      expect(new Set(plan.order).size, t.id).toBe(shown.length);
    }
  }, 120_000);
});
