// Threads drawn on their stand-in cylinders in the 3D view, and the real ones kept for export and close-ups.

import { beforeAll, describe, expect, it } from "vitest";
import { loadOC } from "./occt";
import { KernelCore } from "../src/kernel/core";
import { readThreadCode, threadCode, threadMarks, displayBuilt, hasThreads, THREAD_STRIDE } from "../src/kernel/threadMarks";
import type { MeshData } from "../src/kernel/build";
import type { PartRecipe, ThreadSpec3 } from "../src/kernel/recipe";
import { evaluate } from "../src/lang/evaluator";
import { closeEnough, pickMesh, threadPitch } from "../src/ui/viewport/threadLod";

beforeAll(loadOC, 60000);

const M3: ThreadSpec3 = { d: 3, pitch: 0.5, form: "iso", starts: 1, left: false, clearance: 0 };

/** marked vertices of a mesh: [code, pitches along, cos·P, sin·P] each, with the vertex position */
function marked(m: MeshData) {
  const out: { code: number; u: number; P: number; p: [number, number, number] }[] = [];
  const t = m.thread;
  if (!t) return out;
  for (let v = 0; v < t.length / THREAD_STRIDE; v++) {
    const j = v * THREAD_STRIDE;
    if (t[j] === 0) continue;
    out.push({ code: t[j], u: t[j + 1], P: Math.hypot(t[j + 2], t[j + 3]), p: [m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]] });
  }
  return out;
}

function parts(src: string) {
  const m = evaluate(src);
  expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return m.parts;
}

describe("thread codes", () => {
  it("read back what they hold, at any number of turns", () => {
    for (const [k, form, len, pitch] of [[1, "iso", 12, 0.5], [-2, "trapezoid", 30, 3], [1, "buttress", 0.4, 0.8]] as const) {
      const r = readThreadCode(threadCode({ k, form, len, pitch }));
      expect(r).toMatchObject({ hand: Math.sign(k), form, starts: Math.abs(k) });
      expect(r!.turns).toBeCloseTo(len / pitch, 3);
    }
    expect(readThreadCode(0)).toBeNull();
  });
});

describe("thread marks", () => {
  it("follow a thread through the transforms around it, and a mirror turns its hand", () => {
    const thread = { t: "thread" as const, spec: M3, length: 10, at: [0, 0, 0] as [number, number, number], dir: [0, 0, 1] as [number, number, number], internal: false, lead: 0 };
    const recipe: PartRecipe = {
      base: { t: "box", w: 1, d: 1, h: 1, at: [20, 0, 0], r: 0 },
      ops: [
        { op: "add", shape: { t: "xform", shape: thread, xf: [{ op: "translate", v: [5, 0, 0] }, { op: "rotate", angle: 90, origin: [0, 0, 0], axis: [0, 0, 1] }] } },
        { op: "add", shape: { t: "xform", shape: thread, xf: [{ op: "mirror", origin: [0, -8, 0], normal: [0, 1, 0] }] } },
      ],
    } as PartRecipe;
    const [a, b] = threadMarks(recipe);
    // translated to x 5, then turned 90° about Z: now at y 5, still along Z
    expect(a.o[0]).toBeCloseTo(0, 6);
    expect(a.o[1]).toBeCloseTo(5, 6);
    expect(a.a[2]).toBeCloseTo(1, 6);
    expect(a.k).toBe(1);
    expect(b.o[1]).toBeCloseTo(-16, 6);
    expect(b.k).toBe(-1);
    expect(hasThreads(recipe)).toBe(true);
  });
});

describe("display meshes", () => {
  const core = new KernelCore();

  it("draw a screw's thread on its plain shank: a fraction of the real thread's triangles, only between its ends", () => {
    const [short, long] = parts(`design "hw"
component s = lib.screw(M3, 12) { at: (0, 0, 0), axis: -Z }
component l = lib.screw(M4, 40) { at: (20, 0, 0), axis: -Z }
`);
    for (const p of [short, long]) {
      const item = { hash: p.hash, recipe: p.recipe, label: p.label };
      expect(displayBuilt(p.recipe)).toBe(false);
      core.build(item, "display");
      const display = core.mesh(p.hash, "display");
      core.build(item, "final");
      const real = core.mesh(p.hash, "final");
      expect(real.thread, p.id).toBeUndefined();
      const marks = marked(display);
      expect(marks.length, p.id).toBeGreaterThan(20);
      // the real thread costs many times the triangles
      expect(display.indices.length * 8, p.id).toBeLessThan(real.indices.length);
      const [mk] = threadMarks(p.recipe);
      const turns = readThreadCode(marks[0].code)!.turns;
      expect(turns, p.id).toBeCloseTo(mk.len / mk.pitch, 3);
      for (const v of marks) {
        expect(v.P, p.id).toBeCloseTo(mk.pitch, 4);
        // on the stand-in cylinder
        expect(Math.hypot(v.p[0], v.p[1]), p.id).toBeCloseTo(mk.r, 3);
      }
      // the vertices the shader draws a thread at lie between its ends (a shank on the same face lies outside them)
      const along = marks.map((v) => v.u);
      expect(Math.max(...along), p.id).toBeGreaterThan(turns * 0.9);
      expect(threadPitch(display)).toBeCloseTo(mk.pitch, 4);
    }
    // the M4 x 40 has a plain shank above its thread, on the same axis and diameter
    const lm = marked(core.mesh(long.hash, "display"));
    const [lk] = threadMarks(long.recipe);
    const outside = lm.filter((v) => v.u < -0.05 || v.u > lk.len / lk.pitch + 0.05);
    const inside = lm.filter((v) => v.u >= -0.05 && v.u <= lk.len / lk.pitch + 0.05);
    expect(inside.length).toBeGreaterThan(0);
    // either the shank is a face of its own (not marked) or its vertices sit outside the thread's ends
    for (const v of outside) expect(v.p[2]).not.toBeCloseTo(lk.o[2] + 0.5 * lk.len, 0);
  }, 120000);

  it("mark a nut's internal thread, and not a cylinder of the same size elsewhere in the part", () => {
    const [nut] = parts(`design "hw"
component n = lib.nut(M3) { at: (0, 0, 0), axis: Z }
`);
    core.build({ hash: nut.hash, recipe: nut.recipe, label: nut.label }, "display");
    const nm = marked(core.mesh(nut.hash, "display"));
    expect(nm.length).toBeGreaterThan(10);

    const thread = { t: "thread" as const, spec: M3, length: 8, at: [0, 0, 0] as [number, number, number], dir: [0, 0, 1] as [number, number, number], internal: false, lead: 0 };
    const [mk0] = threadMarks({ base: thread, ops: [] } as PartRecipe);
    // a pin of exactly the stand-in's diameter, off the thread's axis
    const recipe: PartRecipe = { base: thread, ops: [{ op: "add", shape: { t: "cyl", d: mk0.r * 2, h: 8, at: [10, 0, 0], dir: [0, 0, 1] } }] } as PartRecipe;
    core.build({ hash: "twin", recipe, label: "twin" }, "preview");
    const tm = marked(core.mesh("twin", "preview"));
    expect(tm.length).toBeGreaterThan(0);
    for (const v of tm) expect(Math.hypot(v.p[0], v.p[1])).toBeCloseTo(mk0.r, 3);
  }, 60000);

  it("keep other detail in a display build of their own, with the threads still drawn", () => {
    const recipe: PartRecipe = {
      base: { t: "knurl", d: 16, h: 8, at: [0, 0, 0], dir: [0, 0, 1], count: 24, depth: 0.5, style: "straight" },
      ops: [{ op: "add", shape: { t: "thread", spec: { ...M3, d: 6, pitch: 1 }, length: 10, at: [0, 0, 8], dir: [0, 0, 1], internal: false, lead: 0 } }],
    } as PartRecipe;
    expect(displayBuilt(recipe)).toBe(true);
    const item = { hash: "knob", recipe, label: "knob" };
    core.build(item, "preview");
    core.build(item, "display");
    core.build(item, "final");
    const fast = core.mesh("knob", "preview");
    const display = core.mesh("knob", "display");
    const real = core.mesh("knob", "final");
    // the display build has the knurl's ridges (many more faces than the fast cylinder) and a drawn thread
    expect(display.faceGroups!.length).toBeGreaterThan(fast.faceGroups!.length + 20);
    expect(marked(display).length).toBeGreaterThan(10);
    expect(display.indices.length).toBeLessThan(real.indices.length);
  }, 120000);
});

describe("the view's choice of mesh", () => {
  const mesh = (n: number): MeshData => ({ positions: new Float32Array(n), normals: new Float32Array(n), indices: new Uint32Array(n), edges: new Float32Array() });
  it("shows the drawn threads unless real ones are wanted, falling back to what there is", () => {
    const preview = mesh(3);
    const display = mesh(6);
    const final = mesh(9);
    const all = { preview, display, final, volume: 1, bbox: [[0, 0, 0], [1, 1, 1]] as [[number, number, number], [number, number, number]], rev: 1 };
    expect(pickMesh(all, false)?.quality).toBe("display");
    expect(pickMesh(all, true)?.quality).toBe("final");
    expect(pickMesh({ ...all, display: undefined }, false)?.quality).toBe("final");
    expect(pickMesh({ ...all, final: undefined }, true)?.quality).toBe("display");
    expect(pickMesh({ ...all, display: undefined, final: undefined }, true)?.quality).toBe("preview");
    expect(pickMesh(undefined, false)).toBeNull();
  });

  it("switches to the real thread when a pitch spans several pixels, and back a little further out", () => {
    // M3 pitch 0.5 mm, 1000 px tall view, 45° field of view: 7 px a pitch at about 86 mm
    expect(closeEnough(0.5, 60, 45, 1000, false)).toBe(true);
    expect(closeEnough(0.5, 200, 45, 1000, false)).toBe(false);
    // between the two thresholds it stays as it was
    expect(closeEnough(0.5, 100, 45, 1000, true)).toBe(true);
    expect(closeEnough(0.5, 100, 45, 1000, false)).toBe(false);
    expect(closeEnough(0, 10, 45, 1000, false)).toBe(false);
  });
});
