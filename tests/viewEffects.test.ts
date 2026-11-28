// The 3D view's effects that can be checked without a GPU: the part shader's additions land in three's physical
// shader (a three.js update that renames a chunk would silently drop them), and the lens used for the focus on the
// selection keeps its focal plane in place.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { partUniforms, patchPartMaterial } from "../src/ui/viewport/render/partShader";
import { shiftLens } from "../src/ui/viewport/render/pipeline";

/** The body of the function `name` in a shader's text, braces and all. */
function bodyOf(src: string, name: string): string {
  const m = new RegExp(`(float|vec2|vec3|vec4|mat3|void)\\s+${name}\\s*\\([^)]*\\)\\s*\\{`).exec(src);
  if (!m) throw new Error(`no function ${name}`);
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`${name} does not end`);
}

describe("part shader", () => {
  // A width (fwidth, dFdx, dFdy) or a texture read that picks its own level, asked for inside a branch, is one
  // Direct3D's compiler has to work free of the branch first: it has broken a shader of this app before (PR #185).
  it("takes every width at the top of main, never inside a branch or a function", () => {
    const mat = new THREE.MeshPhysicalMaterial();
    patchPartMaterial(mat, partUniforms());
    const shader = { uniforms: {} as Record<string, THREE.IUniform>, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
    mat.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, undefined as unknown as THREE.WebGLRenderer);
    const f = shader.fragmentShader;
    const asks = /\b(fwidth|dFdx|dFdy|texture2D|texture|textureCube)\s*\(/;
    for (const name of ["kHash", "kNoise", "kNoiseG", "kThread", "kW", "kViewZ", "kChangedHere", "kSweepAt", "kDetail", "kMake", "kTangentFrame", "kPerturb"]) expect(bodyOf(f, name), name).not.toMatch(asks);
    // in main: only on a line of its own level (the renderer's own pieces are still to be put in, and are not looked at)
    const main = bodyOf(f, "main");
    let depth = 0;
    const inside: string[] = [];
    for (const line of main.split("\n")) {
      if (!line.trim().startsWith("#") && !line.trim().startsWith("//") && depth > 1 && asks.test(line)) inside.push(line.trim());
      for (const c of line) depth += c === "{" ? 1 : c === "}" ? -1 : 0;
    }
    expect(inside).toEqual([]);
    // and they are there: the part's own point, the view's, a thread's place and the scan's
    for (const taken of ["kPx = dFdx(vKObj);", "kPy = dFdy(vKObj);", "kVx = dFdx(vViewPosition);", "kVy = dFdy(vViewPosition);", "kThW = fwidth(vThread);", "vec2 kDh = vec2(dFdx(kH), dFdy(kH));"]) expect(main).toContain(taken);
    expect(main.indexOf("kPx = dFdx(vKObj);")).toBeLessThan(main.indexOf("#include <clipping_planes_fragment>"));
  });

  it("works a value's width out from the part's own point as fwidth would", () => {
    // kW(g) = |g . dp/dx| + |g . dp/dy|: for a value that changes by g a mm, what fwidth gives for it
    const px = new THREE.Vector3(0.2, -0.1, 0.05);
    const py = new THREE.Vector3(0.03, 0.25, -0.4);
    const kW = (g: THREE.Vector3) => Math.abs(g.dot(px)) + Math.abs(g.dot(py));
    const value = (p: THREE.Vector3) => (p.x + p.y) / 0.4;
    const at = new THREE.Vector3(3, 4, 5);
    const fwidth = Math.abs(value(at.clone().add(px)) - value(at)) + Math.abs(value(at.clone().add(py)) - value(at));
    expect(kW(new THREE.Vector3(1, 1, 0)) / 0.4).toBeCloseTo(fwidth, 9);
  });

  it("adds the change test, the change glow and the click ripple to the physical shader", () => {
    const mat = new THREE.MeshPhysicalMaterial();
    const u = partUniforms();
    patchPartMaterial(mat, u);
    const shader = { uniforms: {} as Record<string, THREE.IUniform>, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
    mat.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, undefined as unknown as THREE.WebGLRenderer);
    const f = shader.fragmentShader;
    // the old shape is dropped where the new one covers it, before anything is lit
    expect(f).toMatch(/#include <clipping_planes_fragment>\s+float kChanged = 1\.0;/);
    expect(f).toContain("if (uChange.x > 1.5 && kChanged < 0.5) discard;");
    expect(f).toContain("uFlash * (uChange.x > 0.5 ? kChanged");
    expect(f).toContain("uGlow * uRippleAmt.x * exp(-kr * kr)");
    // its helpers come before main, and vViewPosition (which they are given) is declared by three
    expect(f.indexOf("float kChangedHere(")).toBeLessThan(f.indexOf("void main()"));
    expect(f).toContain("varying vec3 vViewPosition;");
    for (const k of ["uChange", "tChange", "uChangeView", "uRipple", "uRippleAmt"]) expect(shader.uniforms[k]).toBe(u[k as keyof typeof u]);
    expect(u.uChange.value.x).toBe(0);
    expect(u.uRippleAmt.value.x).toBe(0);
  });
});

describe("focus lens", () => {
  const camera = () => {
    const c = new THREE.PerspectiveCamera(40, 1.5, 1, 5000);
    c.position.set(30, -200, 80);
    c.lookAt(0, 0, 0);
    c.updateMatrixWorld();
    c.updateProjectionMatrix();
    return c;
  };
  const ahead = (c: THREE.PerspectiveCamera, d: number, side = 0, up = 0) =>
    c.position.clone().add(c.getWorldDirection(new THREE.Vector3()).multiplyScalar(d)).add(new THREE.Vector3(side, up, 0).applyQuaternion(c.quaternion));

  it("keeps the focal plane where it was on screen and moves what is nearer or farther", () => {
    const c = camera();
    const focus = 180;
    const pts = [ahead(c, focus), ahead(c, focus, 25, -10), ahead(c, focus * 0.4, 5, 3), ahead(c, focus * 3, -40, 20)];
    const before = pts.map((p) => p.clone().project(c));
    shiftLens(c, 2.5, -1.5, focus);
    const after = pts.map((p) => p.clone().project(c));
    for (const k of [0, 1]) {
      expect(after[k].x).toBeCloseTo(before[k].x, 9);
      expect(after[k].y).toBeCloseTo(before[k].y, 9);
    }
    for (const k of [2, 3]) expect(Math.hypot(after[k].x - before[k].x, after[k].y - before[k].y)).toBeGreaterThan(1e-3);
    // nearer and farther points move opposite ways
    expect(Math.sign(after[2].x - before[2].x)).toBe(-Math.sign(after[3].x - before[3].x));
  });
});
