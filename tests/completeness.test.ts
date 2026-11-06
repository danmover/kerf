// A design is only done when it is really put together: every screw hole has
// its screw, every frame joint something joining it, hardware a held: note
// names is drawn, and electronics are real catalogue parts. The fastener
// planner fills in what is missing with hardware-store screws, nuts, T-nuts,
// corner brackets and joining plates.

import { describe, expect, it } from "vitest";
import { fullCheck, problems } from "./helpers/fullcheck";
import { applyFastenPlan, planFasteners } from "../src/core/autoFasten";
import { evaluate } from "../src/lang/evaluator";
import { assembleReport } from "../src/core/checks";

const notPassing = (items: { id: string; status: string }[], prefix: string) => items.filter((i) => i.id.startsWith(prefix) && i.status !== "pass" && i.status !== "info");

async function fasten(src: string) {
  const r = await fullCheck(src);
  const mesh = (h: string) => (r.core.get(h) ? r.core.mesh(h, "preview") : undefined);
  const plan = planFasteners(r.model, mesh, { kernel: r.kernel });
  return { before: r, plan, next: applyFastenPlan(src, r.model, plan) };
}

const FRAME = `
component rail = lib.extrusion("vslot_2020", length: 200) { at: (-100, 0, 10), axis: X }
component post = lib.extrusion("vslot_2020", length: 150) { at: (40, 0, 20), axis: Z }
part tray {
  material: "PETG"
  body box(60, 40, 4, at: (-50, 0, 20))
  cut hole(M5, through: true, at: (-60, 0, 20), dir: Z)
  cut hole(M5, through: true, at: (-40, 0, 20), dir: Z)
}
`;

describe("completeness checks", () => {
  it("fails a held: note that names screws nobody drew", () => {
    const m = evaluate(`
part base { material: "PETG"  body box(80, 80, 5) }
part cover { material: "PETG"  held: "four M3 screws into the base"  body box(80, 80, 3, at: (0, 0, 5)) }
`);
    const items = notPassing(assembleReport(m).items, "complete:undrawn");
    expect(items.map((i) => i.status)).toEqual(["fail"]);
  });

  it("lets a bought part's own supplied hardware stay undrawn", () => {
    const m = evaluate(`
part base { material: "Aluminium 6061"  body box(80, 80, 5) }
part caliper { material: "Aluminium 6061"  process: false  held: "its own two M5 bolts, supplied with it, through the base"  body box(40, 20, 20, at: (0, 0, 5)) }
`);
    expect(notPassing(assembleReport(m).items, "complete:undrawn")).toEqual([]);
  });

  it("fails profiles that only touch, and passes a corner bracket joint", async () => {
    const bare = await fullCheck(`
component rail = lib.extrusion("vslot_2020", length: 200) { at: (-100, 0, 10), axis: X }
component post = lib.extrusion("vslot_2020", length: 150) { at: (0, 0, 20), axis: Z }
`);
    expect(notPassing(bare.report.items, "complete:joint").map((i) => i.status)).toEqual(["fail"]);
    const joined = await fullCheck(`
component rail = lib.extrusion("vslot_2020", length: 200) { at: (-100, 0, 10), axis: X }
component post = lib.extrusion("vslot_2020", length: 150) { at: (0, 0, 20), axis: Z }
component br = lib.corner_bracket("2020") { at: (10, 0, 20), axis: Z }
component s_a = lib.screw(M5, 8, head: "button") { at: (20, 0, 23), axis: -Z }
component n_a = lib.nut(M5, type: "tslot20") { at: (20, 0, 20), axis: -Z, rotate: 90 }
component s_b = lib.screw(M5, 8, head: "button") { at: (13, 0, 32.5), axis: -X }
component n_b = lib.nut(M5, type: "tslot20") { at: (10, 0, 32.5), axis: -X }
`);
    expect(notPassing(joined.report.items, "complete:joint")).toEqual([]);
    expect(problems(joined.report, ["fail"])).toEqual([]);
  }, 120_000);
});

describe("the fastener planner", () => {
  it("screws a printed tray to a profile with T-nuts and brackets the joint, leaving nothing failing", async () => {
    const { before, plan, next } = await fasten(FRAME);
    expect(notPassing(before.report.items, "complete:empty-holes")).toHaveLength(1);
    expect(plan.skipped).toEqual([]);
    expect(plan.done).toEqual(
      expect.arrayContaining([
        { part: "tray", text: "2 screws, 2 T-nuts" },
        { part: "post", text: expect.stringMatching(/corner bracket/) },
      ]),
    );
    // hardware a hardware store sells: M5 button screws in stocked lengths
    expect(next).toMatch(/lib\.screw\(M5, (8|10|12), head: "button"\)/);
    expect(next).toMatch(/lib\.nut\(M5, type: "tslot20"\)/);
    expect(next).toMatch(/lib\.corner_bracket\("2020"\)/);
    const after = await fullCheck(next);
    expect(problems(after.report, ["fail"])).toEqual([]);
    expect(notPassing(after.report.items, "complete:")).toEqual([]);
    // run again, it has nothing more to add
    const again = await fasten(next);
    expect(again.plan.groups).toEqual([]);
  }, 180_000);

  it("says why a hole it cannot fasten was left", async () => {
    const { plan } = await fasten(`
part block { material: "PETG"  body box(40, 40, 10, at: (0, 60, 0)) }
part plate { material: "PETG"  body box(40, 40, 5, at: (0, 60, 10))  cut hole(M3, through: true, at: (-10, 60, 10), dir: Z) }
`);
    expect(plan.groups).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].part).toBe("plate");
    expect(plan.skipped[0].why).toMatch(/block has no hole on its axis/);
  }, 120_000);

  it("bolts a profile standing on another with a joining plate when the bracket's key is blocked", async () => {
    // a beam along the rail's top face, beside the post, leaves no room to turn a key in a corner bracket's screws there
    const { plan, next } = await fasten(`
component rail = lib.extrusion("vslot_2020", length: 200) { at: (-100, 0, 10), axis: X }
component post = lib.extrusion("vslot_2020", length: 150) { at: (0, 0, 20), axis: Z }
component beam_l = lib.extrusion("vslot_2020", length: 80) { at: (-100, 0, 30), axis: X }
component beam_r = lib.extrusion("vslot_2020", length: 80) { at: (20, 0, 30), axis: X }
`);
    expect(plan.done).toContainEqual({ part: "post", text: "1 joining plate, 5 screws, 5 T-nuts" });
    expect(next).toMatch(/lib\.joining_plate\("L"\)/);
    // two profiles lying along each other are not a corner joint: said, not guessed at
    expect(plan.skipped.map((s) => s.why)).toEqual([expect.stringMatching(/rail meets beam_l/), expect.stringMatching(/rail meets beam_r/)]);
    const after = await fullCheck(next);
    expect(notPassing(after.report.items, "complete:joint").map((i) => i.id)).toEqual(["complete:joint:rail:beam_l", "complete:joint:rail:beam_r"]);
    expect(problems(after.report, ["fail"]).filter((l) => /post/.test(l))).toEqual([]);
  }, 180_000);
});
