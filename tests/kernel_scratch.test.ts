import { beforeAll, expect, it } from "vitest";
import * as R from "replicad";
import { loadOC } from "./occ";
import { buildPartFull, buildShape } from "../src/kernel/build";
import type { PartRecipe } from "../src/kernel/recipe";

beforeAll(loadOC, 60000);
const vol = (s: R.Shape3D) => R.measureVolume(s);

it("named boss root fillet + hole rim chamfer", () => {
  const recipe: PartRecipe = {
    base: { t: "box", w: 40, d: 30, h: 5, at: [0, 0, 0], r: 0 },
    baseName: "plate",
    ops: [
      { op: "add", shape: { t: "cyl", d: 10, h: 8, at: [0, 0, 5], dir: [0, 0, 1] }, name: "boss" },
      { op: "cut", shape: { t: "hole", d: 4, depth: 20, at: [0, 0, 13], dir: [0, 0, -1] }, name: "bore" },
      { op: "fillet", r: 2, edges: { s: "feat", f: "boss", part: "root" } },
      { op: "chamfer", r: 0.6, edges: { s: "feat", f: "bore", part: "root" } },
      { op: "fillet", r: 1, edges: "vertical" },
      { op: "chamfer", r: 0.4, edges: { s: "minus", a: "convex", b: { s: "feat", f: "bore", part: "edges" } } , cosmetic: true },
    ],
  };
  const t = performance.now();
  const fast = buildPartFull(recipe);
  const det = buildPartFull(recipe, { detail: true });
  console.log("ms", performance.now() - t, vol(fast.shape), vol(det.shape), det.warnings);
  expect(vol(fast.shape)).toBeGreaterThan(40 * 30 * 5);
});

it("profiles, sweep, loft, thread, knurl", () => {
  const f = { o: [0, 0, 0] as [number, number, number], u: [1, 0, 0] as [number, number, number], n: [0, 0, 1] as [number, number, number] };
  const ex = buildShape({ t: "extrude", p: { t: "diff2", a: { t: "rect", w: 30, h: 20, r: 3, c: [0, 0] }, b: [{ t: "circle", d: 6, c: [0, 0] }] }, h: 5, f, twist: 0, scale: 1 });
  console.log("extrude", vol(ex));
  const txt = buildShape({ t: "extrude", p: { t: "text", text: "KERF", size: 8, font: "sans", align: "center", c: [0, 0] }, h: 1, f, twist: 0, scale: 1 });
  console.log("text", vol(txt), txt.boundingBox.bounds);
  const sw = buildShape({ t: "sweep", p: { t: "diff2", a: { t: "circle", d: 10, c: [0, 0] }, b: [{ t: "circle", d: 7, c: [0, 0] }] }, path: { t: "poly", pts: [[0, 0, 0], [0, 0, 30], [40, 0, 30], [40, 0, 0]], r: 8 }, rot: 0, frenet: false });
  console.log("pipe", vol(sw));
  const lf = buildShape({ t: "loft", secs: [{ p: { t: "rect", w: 40, h: 40, r: 6, c: [0, 0] }, f }, { p: { t: "circle", d: 30, c: [0, 0] }, f: { ...f, o: [0, 0, 50] } }], ruled: false });
  console.log("loft", vol(lf));
  let t = performance.now();
  const th = buildShape({ t: "thread", spec: { d: 30, pitch: 3, form: "trapezoid", starts: 2, left: false, clearance: 0.2 }, length: 12, at: [0, 0, 0], dir: [0, 0, 1], internal: false, lead: 0 }, true);
  console.log("thread", vol(th), performance.now() - t);
  t = performance.now();
  const kn = buildShape({ t: "knurl", d: 30, h: 15, at: [0, 0, 0], dir: [0, 0, 1], count: 40, depth: 0.6, style: "fluted" }, true);
  console.log("knurl fluted", vol(kn), performance.now() - t);
  t = performance.now();
  const rv = buildShape({ t: "revolve2", p: { t: "rect", w: 4, h: 10, r: 1, c: [12, 5] }, f, angle: 270 });
  console.log("revolve2", vol(rv), performance.now() - t);
  t = performance.now();
  const ks = buildShape({ t: "knurl", d: 30, h: 15, at: [0, 0, 0], dir: [0, 0, 1], count: 60, depth: 0.6, style: "straight" }, true);
  console.log("knurl straight", vol(ks), performance.now() - t);
}, 60000);
