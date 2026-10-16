import { beforeAll, expect, it } from "vitest";
import * as R from "replicad";
import { loadOC } from "./occ";
import { buildPartFull } from "../src/kernel/build";
import { evaluate } from "../src/lang/evaluator";

beforeAll(loadOC, 60000);

const SRC = `design "Modelling check"

part plate {
  body box(60, 40, 4) as base
  add screw_boss(at: (-20, 0, 4), size: M3, h: 8, gussets: 3) as b1
  add screw_boss(at: (20, 0, 4), size: M3, h: 8, fit: "tap")
  add snap_hook(at: (0, 15, 4), length: 12, t: 1.6, w: 6, catch: 0.8, facing: Y)
  add rib((-10, -15, 4), (10, -15, 4), t: 1.2, h: 5)
  add gusset((10, -15, 4), along: X, size: 4, t: 1.2)
  add emboss(text("KERF", size: 6), at: (0, -5, 4), facing: Z, h: 0.6)
  cut engrave(text("v1", size: 4, font: "mono"), at: (0, 0, 0), facing: -Z, depth: 0.4)
  cut oring_groove(d: 20, cs: 1.5, at: (0, 0, 4), type: "face") as groove
  fillet(3, edges: both(base.edges, "vertical"))
  cosmetic {
    chamfer(0.3, edges: base.tip)
  }
}

part bottle {
  body loft([circle(40), rounded(rect(44, 44), 8), circle(30), circle(24)], heights: [0, 40, 70, 80], wall: 1.6) as shell_body
  add tube(od: 28, id: 20.8, h: 2, at: (0, 0, 80)) as collar
  add thread(d: 26, pitch: 3, form: "trapezoid", length: 10, at: (0, 0, 82), clearance: 0.15, bore: 20.8) as neck
  chamfer(0.5, edges: both(collar.edges, "convex"))
  material: "PETG"
  at: (100, 0, 0)
}

part cap {
  body knurl(d: 36, h: 14, count: 40, depth: 0.6) as grip
  cut thread(d: 26, pitch: 3, form: "trapezoid", length: 11, at: (0, 0, -0.01), internal: true, clearance: 0.15) as inner
  cut cylinder(d: 34, h: 2, at: (0, 0, 12))
  at: (160, 0, 0)
}

part handle {
  body box(30, 20, 4)
  add pipe(path([(-10, 0, 4), (-10, 0, 20), (10, 0, 20), (10, 0, 4)], r: 5), d: 6) as grip
  fillet(1.5, edges: grip.root)
  at: (0, 80, 0)
}

part knob {
  body revolve(outline([(0, 0), (12, 0), spline_to((14, 6)), spline_to((10, 12)), (0, 12)]), axis: Z) as dome
  cut hole(M4, fit: "thread", depth: 8, at: (0, 0, 0), dir: Z)
  add extrude(ngon(6, af: 10) - circle(4), h: 3, at: (0, 0, 12))
  at: (40, 80, 0)
}

part twisty {
  body box(30, 20, 10)
  draft(3, faces: "vertical", pull: Z)
  add extrude(rect(20, 10, r: 2), h: 30, twist: 90, scale: 0.6, at: (0, 0, 10))
  add sweep(circle(3), helix(d: 26, pitch: 8, h: 24, at: (0, 0, 12)))
  at: (80, 80, 0)
}
`;

it("evaluates and builds", () => {
  (globalThis as { __kerfProfile?: boolean }).__kerfProfile = true;
  const m = evaluate(SRC);
  for (const d of m.diagnostics) console.log("DIAG", d.severity, d.message);
  expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  for (const p of m.parts) {
    let t = performance.now();
    const fast = buildPartFull(p.recipe);
    const tf = performance.now() - t;
    t = performance.now();
    const det = buildPartFull(p.recipe, { detail: true });
    const td = performance.now() - t;
    console.log(p.name, "fast", Math.round(tf), "ms vol", Math.round(R.measureVolume(fast.shape)), "| detail", Math.round(td), "ms vol", Math.round(R.measureVolume(det.shape)), det.warnings, p.features);
  }
}, 120000);
