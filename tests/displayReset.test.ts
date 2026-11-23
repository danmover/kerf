// Showing a stress result crashed the 3D view on Windows and it came back and crashed again for ever. Two parts:
// the results shader's section-cut code took Direct3D's compiler about 6 s (the card dropped the view's drawing
// context each time), and the view drew the same thing again after every reset. The cut code is now only compiled
// in while a section shows the inside, without branches or derivatives, and repeated resets take the results off
// and then stop the view.

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { afterReset, LOSS_WINDOW_MS } from "../src/ui/viewport/resetGuard";
import { ResultsOverlay } from "../src/ui/viewport/resultsOverlay";
import type { StructuralResult } from "../src/analysis/fe/structural";

describe("a graphics card that keeps resetting", () => {
  it("waits for the drawing context after one reset", () => {
    expect(afterReset([], 1000, true)).toEqual({ times: [1000], step: "wait" });
  });

  it("takes the results off after a second reset with them on screen, and starts the count again", () => {
    expect(afterReset([1000], 20_000, true)).toEqual({ times: [20_000], step: "hide-results" });
  });

  it("stops the view after a third reset with nothing left to take away", () => {
    const a = afterReset([], 0, false);
    const b = afterReset(a.times, 10_000, false);
    expect(b.step).toBe("wait");
    expect(afterReset(b.times, 20_000, false).step).toBe("stop");
  });

  it("forgets resets from long ago", () => {
    expect(afterReset([0, 1000], LOSS_WINDOW_MS + 2000, false)).toEqual({ times: [LOSS_WINDOW_MS + 2000], step: "wait" });
  });
});

/** a one-triangle result with a volume inside, enough for the overlay's material */
function result(): StructuralResult {
  const part = {
    id: "p",
    name: "plate",
    positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    disp: new Float32Array(9),
    stress: new Float32Array([1, 2, 3]),
    strain: new Float32Array(3),
    safety: new Float32Array([5, 4, 3]),
  };
  const at: [number, number, number] = [0, 0, 0];
  const n = 2 * 2 * 2;
  return {
    parts: [part],
    supports: [],
    loads: [],
    gravity: null,
    hotSpots: [],
    ranges: { stress: [0, 3], disp: [0, 0], strain: [0, 0], safety: [3, 5] },
    maxStress: { value: 3, at },
    maxDisp: { value: 0, at },
    maxStrain: { value: 0, at },
    minSafety: { value: 3, at },
    interior: { origin: [0, 0, 0], step: [5, 5, 5], n: [2, 2, 2], stress: new Float32Array(n), util: new Float32Array(n), disp: new Float32Array(3 * n) },
  } as unknown as StructuralResult;
}

/** what three would compile for the overlay's material: its shader after onBeforeCompile, with the material's defines */
function compiled(o: ResultsOverlay) {
  const mat = (o as unknown as { material: THREE.MeshStandardMaterial }).material;
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader } as THREE.WebGLProgramParametersWithUniforms;
  mat.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  // keep only what the preprocessor keeps: the KERF_CAP blocks when the material defines it
  const on = "KERF_CAP" in (mat.defines ?? {});
  const kept: string[] = [];
  const stack: boolean[] = [];
  for (const line of shader.fragmentShader.split("\n")) {
    const t = line.trim();
    if (t === "#ifdef KERF_CAP") stack.push(on);
    else if (t === "#else" && stack.length) stack[stack.length - 1] = !stack[stack.length - 1];
    else if (t === "#endif" && stack.length) stack.pop();
    else if (stack.every(Boolean)) kept.push(line);
  }
  return { fragment: kept.join("\n"), cacheKey: mat.customProgramCacheKey(), defines: { ...mat.defines } };
}

describe("the results shader", () => {
  // labels are drawn on 2D canvases; a stand-in is enough here
  const ctx = new Proxy({}, { get: (_t, k) => (k === "measureText" ? () => ({ width: 40 }) : () => undefined), set: () => true });
  (globalThis as { document?: unknown }).document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };

  it("has no section-cut code (3D textures, a loop over them) until a section shows the inside", () => {
    const o = new ResultsOverlay(result());
    const { fragment } = compiled(o);
    expect(o.capCompiled).toBe(false);
    expect(fragment).not.toMatch(/sampler3D|kerfCapColor\(/);
    o.dispose();
  });

  it("puts it in when a section cuts the result, without branches or derivatives, and takes it out again", () => {
    const o = new ResultsOverlay(result());
    o.setClipping([new THREE.Plane(new THREE.Vector3(1, 0, 0), -5)]);
    expect(o.capCompiled).toBe(true);
    const { fragment, defines } = compiled(o);
    // the standard material's own define stays
    expect(defines).toHaveProperty("STANDARD");
    const cap = fragment.slice(fragment.indexOf("vec3 kerfCapColor()"), fragment.indexOf("}", fragment.indexOf("vec3 kerfCapColor()")));
    expect(cap).toContain("textureLod(uVolT");
    expect(cap).not.toMatch(/\btexture\(|\bif\b|\bfor\b|return 0\.0|fwidth|dFd/);
    // no branch on which side is facing around the cut face's code
    expect(fragment).not.toMatch(/if \(!gl_FrontFacing\)/);
    o.setClipping(null);
    expect(o.capCompiled).toBe(false);
    o.dispose();
  });

  it("leaves the cut code out for a mode shape, which has no values inside", () => {
    const r = result();
    r.modal = { modes: [{ freq: 50, peak: { at: [0, 0, 0] } }] } as unknown as StructuralResult["modal"];
    r.parts[0].modes = [new Float32Array(9)];
    const o = new ResultsOverlay(r);
    o.setClipping([new THREE.Plane(new THREE.Vector3(1, 0, 0), -5)]);
    o.configure({ field: "stress", scale: 1, animate: false, safetyTarget: 2, mode: 0 });
    expect(o.capCompiled).toBe(false);
    o.configure({ field: "stress", scale: 1, animate: false, safetyTarget: 2, mode: null });
    expect(o.capCompiled).toBe(true);
    o.dispose();
  });
});
