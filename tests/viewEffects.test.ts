// The 3D view's effects that can be checked without a GPU: the part shader's additions land in three's physical
// shader (a three.js update that renames a chunk would silently drop them), and the lens used for the focus on the
// selection keeps its focal plane in place.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { partUniforms, patchPartMaterial } from "../src/ui/viewport/render/partShader";
import { shiftLens } from "../src/ui/viewport/render/pipeline";

describe("part shader", () => {
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
