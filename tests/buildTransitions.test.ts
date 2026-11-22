// The build transitions of the 3D view that can be checked without a GPU: how a new part arrives (which way it fills,
// the order its outline draws in, how a bought part drops and a screw spins down), which way an edit sweeps through
// its part, and that the shaders carry the sweep, the fill direction, the pulse and the outline trace.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { arrivalKind, dropHeight, fillAt, fillAxis, screwLeft, screwTravel, traceAt, traceOrder } from "../src/ui/viewport/arrival";
import { boundsSweep, edgeSweep, editSweep, toolSweep } from "../src/ui/viewport/editSweep";
import { partUniforms, patchEdgeMaterial, patchPartMaterial } from "../src/ui/viewport/render/partShader";
import type { EvalPart } from "../src/core/model";
import type { PartRecipe, V3 } from "../src/kernel/recipe";

const part = (over: Partial<EvalPart>): EvalPart => ({ id: "p", name: "p", label: "p", kind: "part", group: "", color: "#888", material: "PLA", recipe: { base: null, ops: [] }, hash: "h", xf: [], locked: false, hidden: false, removable: false, span: { start: 0, end: 0 } as EvalPart["span"], deps: [], ...over }) as EvalPart;
const box = { min: [-40, -25, 0] as V3, max: [40, 25, 8] as V3 };
// a box stands on `at`, the middle of its bottom face
const plate: PartRecipe = { base: { t: "box", w: 80, d: 50, h: 8, at: [0, 0, 0], r: 0 }, ops: [] };
const near = (a: number[], b: number[]) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 6));

describe("arrival", () => {
  it("makes parts in place, drops bought ones in and screws the screws in", () => {
    expect(arrivalKind(part({}))).toBe("make");
    expect(arrivalKind(part({ kind: "component", libKind: "pcb" }))).toBe("drop");
    expect(arrivalKind(part({ processNone: true }))).toBe("drop");
    expect(arrivalKind(part({ kind: "component", libKind: "screw", fastener: { headTop: [0, 0, 0], outward: [0, 0, 1], key: 2.5, headD: 5.5, size: "M3" } }))).toBe("screw");
  });

  it("fills a part the way it is made", () => {
    const fdm = (settings: Record<string, unknown>) => part({ process: { id: "fdm", settings: settings as never } });
    // a print's given build direction, and its layer height
    expect(fillAxis(fdm({ build: [0, 0, -2], layer: 0.3 }), null, box)).toEqual({ axis: [0, 0, -1], frame: "part", layer: 0.3 });
    // else the way it rests on the bed: a flat plate lies on its big face
    const geo = new THREE.BoxGeometry(80, 50, 8).toNonIndexed();
    const positions = geo.getAttribute("position").array as Float32Array;
    const indices = Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
    const up = fillAxis(fdm({}), { positions, indices }, box);
    expect(Math.abs(up.axis[2])).toBeCloseTo(1, 6);
    expect(up.layer).toBe(0.2);
    expect(fillAxis(part({ process: { id: "cnc_mill", settings: {} } }), null, box).axis).toEqual([0, 0, -1]);
    expect(fillAxis(part({ process: { id: "cnc_lathe", settings: {} } }), null, box).axis).toEqual([1, 0, 0]);
    expect(fillAxis(part({}), null, box)).toEqual({ axis: [0, 0, 1], frame: "world", layer: 0 });
  });

  it("draws each edge of the outline from one end to the other", () => {
    // two edges: a straight one of two segments (3 + 1 long) and one of one segment
    const edges = [0, 0, 0, 3, 0, 0, 3, 0, 0, 4, 0, 0, 0, 0, 0, 0, 5, 0];
    near([...traceOrder(edges, [0, 4, 0, 4, 2, 1])], [0, 0.75, 0.75, 1, 0, 1]);
    // without the groups, joined segments make one edge
    near([...traceOrder(edges)], [0, 0.75, 0.75, 1, 0, 1]);
  });

  it("traces, fills, drops and screws in over its time", () => {
    expect(traceAt(0)).toBe(0);
    expect(traceAt(0.45)).toBe(1);
    expect(fillAt(0.2)).toBe(0);
    expect(fillAt(1)).toBe(1);
    expect(dropHeight(0)).toBe(1);
    expect(dropHeight(0.6)).toBeCloseTo(0, 6);
    expect(dropHeight(0.75)).toBeGreaterThan(0);
    expect(dropHeight(1)).toBe(0);
    expect(screwLeft(0)).toBe(1);
    expect(screwLeft(1)).toBe(0);
    const t = screwTravel(12, 5.5);
    expect(t.travel).toBeCloseTo(9.6, 6);
    expect(t.turns).toBeGreaterThan(2);
  });
});

describe("edit sweep", () => {
  const cut = (shape: object) => ({ ...plate, ops: [{ op: "cut", shape }] }) as PartRecipe;
  const add = (shape: object) => ({ ...plate, ops: [{ op: "add", shape }] }) as PartRecipe;

  it("drills a hole in from the top", () => {
    const s = editSweep(plate, cut({ t: "cyl", d: 10, h: 12, at: [22, 0, -2], dir: [0, 0, 1] }), box, box)!;
    expect(s.mode).toBe("across");
    near(s.origin, [22, 0, 10]);
    near(s.dir, [0, 0, -1]);
    expect(s.range).toBe(12);
    // a hole goes in from where it starts
    const h = toolSweep({ t: "hole", d: 5, depth: 6, at: [0, 0, 8], dir: [0, 0, -1] }, "cut", box)!;
    near(h.origin, [0, 0, 8]);
    near(h.dir, [0, 0, -1]);
  });

  it("grows an added boss from its base, and a lengthened one from where it ended", () => {
    const boss = { t: "cyl", d: 16, h: 16, at: [-20, 0, 8], dir: [0, 0, 1] };
    const s = editSweep(plate, add(boss), box, box)!;
    near(s.origin, [-20, 0, 8]);
    near(s.dir, [0, 0, 1]);
    const longer = editSweep(add(boss), add({ ...boss, h: 22 }), box, box)!;
    near(longer.origin, [-20, 0, 24]);
    expect(longer.range).toBeCloseTo(6, 6);
  });

  it("adds a box from the side it stands on, and cuts one in from outside", () => {
    const s = toolSweep({ t: "box", w: 20, d: 10, h: 6, at: [25, -20, 8], r: 0 }, "add", box)!;
    near(s.origin, [25, -20, 8]);
    near(s.dir, [0, 0, 1]);
    const c = toolSweep({ t: "box", w: 20, d: 10, h: 20, at: [45, 0, -6], r: 0 }, "cut", box)!;
    // it stands out of the part's +X side most (as a share of its size)
    near(c.dir, [-1, 0, 0]);
    near(c.origin, [55, 0, 4]);
  });

  it("fans a pattern out from its first copy", () => {
    const copies = { t: "union", shapes: [0, 10, 20].map((x) => ({ t: "cyl", d: 4, h: 12, at: [x, 0, -2], dir: [0, 0, 1] })) };
    const s = editSweep(plate, cut(copies), box, box)!;
    expect(s.mode).toBe("out");
    near(s.origin, [0, 0, 4]);
    expect(s.range).toBeGreaterThan(20);
    // a loop of holes adds a step each
    const row = { ...plate, ops: [0, 10, 20].map((x) => ({ op: "cut", shape: { t: "cyl", d: 4, h: 12, at: [x, 0, -2], dir: [0, 0, 1] } })) } as PartRecipe;
    expect(editSweep(plate, row, box, box)?.origin).toEqual([0, 0, 4]);
  });

  it("leaves a fillet to the edges, and follows a resized base by the side that moved", () => {
    const filleted = { ...plate, ops: [{ op: "fillet", r: 3, edges: "top" }] } as PartRecipe;
    expect(editSweep(plate, filleted, box, box)).toBeNull();
    const wider = { ...plate, base: { t: "box", w: 100, d: 50, h: 8, at: [10, 0, 0], r: 0 } } as PartRecipe;
    const s = editSweep(plate, wider, box, { min: [-40, -25, 0], max: [60, 25, 8] })!;
    near(s.origin, [10, 0, 4].map((x, i) => (i === 0 ? 40 : x)));
    near(s.dir, [1, 0, 0]);
    expect(boundsSweep(box, box)).toBeNull();
  });

  it("rolls along the edges that changed", () => {
    // a long new edge along X (a fillet's), the old outline otherwise the same
    const old = [-40, 25, 8, 40, 25, 8, -40, -25, 8, 40, -25, 8];
    const now = [-40, 25, 5, 40, 25, 5, -40, 22, 8, 40, 22, 8, -40, -25, 8, 40, -25, 8];
    const s = edgeSweep(old, now)!;
    expect(s.mode).toBe("across");
    expect(Math.abs(s.dir[0])).toBeCloseTo(1, 3);
    expect(s.range).toBeGreaterThan(75);
    // nothing moved: no sweep
    expect(edgeSweep(old, old)).toBeNull();
  });
});

describe("shaders", () => {
  it("sweeps a change, fills along a direction and pulses in the part shader", () => {
    const mat = new THREE.MeshPhysicalMaterial();
    const u = partUniforms();
    patchPartMaterial(mat, u);
    const shader = { uniforms: {} as Record<string, THREE.IUniform>, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
    mat.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, undefined as unknown as THREE.WebGLRenderer);
    const f = shader.fragmentShader;
    expect(f).toContain("float kSweepAt(vec3 p)");
    expect(f).toContain("if (kAhead < 0.0) discard;");
    expect(f).toContain("if (kBehind < 0.0) discard;");
    expect(f).toContain("dot(vKWorld, uScanDir.xyz)");
    expect(f).toContain("uPulse.rgb * uPulse.w");
    // cameraPosition, which the old shape's test uses, is one of three's own uniforms in the fragment shader
    expect(THREE.ShaderChunk.common + f).not.toContain("uniform vec3 cameraPosition;\nuniform vec3 cameraPosition;");
    for (const k of ["uScanDir", "uSweep", "uSweepDir", "uSweepFront", "uPulse"]) expect(shader.uniforms[k]).toBe(u[k as keyof typeof u]);
  });

  it("traces the outline in the edge shader, sharing the part's fill", () => {
    const mat = new THREE.LineBasicMaterial();
    const u = partUniforms();
    patchEdgeMaterial(mat, u);
    const shader = { uniforms: {} as Record<string, THREE.IUniform>, vertexShader: THREE.ShaderLib.basic.vertexShader, fragmentShader: THREE.ShaderLib.basic.fragmentShader };
    mat.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, undefined as unknown as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain("vKOrder = aOrder;");
    expect(shader.vertexShader).toContain("vKWorldE = (modelMatrix");
    expect(shader.fragmentShader).toContain("if (kHead < 0.0) discard;");
    expect(shader.uniforms.uScan).toBe(u.uScan);
    expect(shader.uniforms.uTrace).toBe(u.uTrace);
  });
});
