// Ropes, winch drums and sheaves (lib.rope): the path a taut rope takes, the
// drum and sheave it reads from a part's own shape, and the checks that follow
// it through the motion.

import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { fullCheck, type FullCheck } from "./helpers/fullcheck";
import { closedSurface } from "../src/kernel/apart";

const noErrors = (r: FullCheck) => expect(r.model.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);

// a car on a tower, raised by a rope from a drum at the foot, up over a sheave at the head and down to the car
const hoist = (o: { rope?: string; car?: string; drum?: string; more?: string; args?: string } = {}) => `
design "hoist"
part base { body box(300, 400, 10, at: (0, 40, -10))  held: "bolted to the floor"  material: "Steel" }
part tower { body box(40, 40, 700)  held: "welded to the base"  material: "Steel" }
part car { body box(160, 160, 20, at: (0, 0, 100))  cut box(40.2, 40.2, 40, at: (0, 0, 90))  slides: Z  travel: 400  material: "Aluminum 6061"  ${o.car ?? ""} }
part top { body cylinder(72, 10, at: (-5, 97.5, 650), dir: X)  held: "its axle"  material: "Nylon" }
part drum { body cylinder(72, 30, at: (-15, 97.5, 45), dir: X)  spin: 1  axis: X  axis_at: (0, 97.5, 45)  ${o.drum ?? 'held: "its shaft"'}  material: "Aluminum 6061" }
component hoist = lib.rope("${o.rope ?? "wire_rope_7x19_3mm"}", path: [drum, top, (0, 60, 120)], lifts: car${o.args ?? ""})
${o.more ?? ""}
`;

describe("a rope's path", () => {
  it("probe", async () => {
    const out: unknown[] = [];
    for (const args of ["", ", wraps: 8", ", wraps: 20"]) {
      const r = await fullCheck(hoist({ args }));
      const p = r.model.parts.find((q) => q.name === "hoist")!;
      const t0 = Date.now();
      let err = "";
      let closed = false;
      let tris = 0;
      try {
        const e = r.core.build({ hash: p.hash, recipe: p.recipe, label: p.label }, "final");
        const m = r.core.mesh(p.hash, "final");
        closed = !!closedSurface(m);
        tris = m.indices.length / 3;
        out.push([args, closed, tris, e.volume, Date.now() - t0]);
      } catch (e) {
        err = String(e);
        out.push([args, "ERR", err, Date.now() - t0]);
      }
    }
    writeFileSync("/tmp/claude-0/-home-user/39efa6e3-61aa-5068-b60d-9c18bd0e26e7/scratchpad/rope-probe.json", JSON.stringify(out, null, 1));
  });
});
