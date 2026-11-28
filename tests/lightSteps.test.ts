import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { fitShadowMap, lightSteps } from "../src/ui/viewport/render/studio";

// Soft shadows come from many samples of a picture, each with the lights somewhere else on their discs. A picture
// drawn between the 3D view's frames takes its samples in turn with the view's own, so where the lights stand for a
// sample must not depend on which sample was drawn before it.

/** The lights walked from sample 0 to `to`, moving only the one whose turn it is: how the places were first kept. */
function walked(to: number, casters: number): number[] {
  const at = new Array<number>(casters + 1).fill(0);
  for (let i = 1; i <= to; i++) {
    if (casters === 0) at[0] = i;
    else if (i % 2 === 0) at[0] = i / 2;
    else {
      const turn = (i - 1) / 2;
      at[1 + (turn % casters)] = Math.floor(turn / casters) + 1;
    }
  }
  return at;
}

describe("where the shadow-casting lights stand for a sample", () => {
  it("has every light at its centre for the first sample", () => {
    for (let n = 0; n <= 3; n++) expect(lightSteps(0, n)).toEqual(new Array(n + 1).fill(0));
  });

  it("moves a lone key at every sample", () => {
    expect([1, 2, 3, 40].map((i) => lightSteps(i, 0))).toEqual([[1], [2], [3], [40]]);
  });

  it("moves the key at even samples and the casters in turn at odd ones", () => {
    expect([1, 2, 3, 4, 5].map((i) => lightSteps(i, 1))).toEqual([[0, 1], [1, 1], [1, 2], [2, 2], [2, 3]]);
    expect([1, 2, 3, 4, 5, 6, 7].map((i) => lightSteps(i, 2))).toEqual([[0, 1, 0], [1, 1, 0], [1, 1, 1], [2, 1, 1], [2, 2, 1], [3, 2, 1], [3, 2, 2]]);
  });

  it("is where a walk from the first sample leaves them, for any sample asked on its own", () => {
    for (let n = 0; n <= 4; n++) for (let i = 0; i <= 200; i++) expect(lightSteps(i, n), `sample ${i}, ${n} casters`).toEqual(walked(i, n));
  });

  it("moves one light from each sample to the next", () => {
    for (let n = 0; n <= 4; n++)
      for (let i = 1; i <= 96; i++) {
        const a = lightSteps(i - 1, n);
        const b = lightSteps(i, n);
        expect(b.filter((s, k) => s !== a[k]).length, `sample ${i}, ${n} casters`).toBe(1);
      }
  });
});

// Each of those lights has a map its shadows are drawn into, sized to the model. A light set put in place after the
// model was laid out (a set changed, or one that waited for the graphics card) brings lights made then: with the 10
// units a new light's map sees, their shadows fell only on the middle of the model.
describe("the map a shadow-casting light draws its shadows into", () => {
  const size = new THREE.Vector3(120, 80, 40);
  // the model's corners, seen from a light twice its diagonal from its middle (the scene's placeLight)
  const held = (l: THREE.DirectionalLight, dir: THREE.Vector3) => {
    l.position.copy(dir.clone().normalize().multiplyScalar(size.length() * 2));
    l.target.position.set(0, 0, 0);
    l.updateMatrixWorld();
    l.target.updateMatrixWorld();
    l.shadow.updateMatrices(l);
    const corners = [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => new THREE.Vector3((x * size.x) / 2, (y * size.y) / 2, (z * size.z) / 2))));
    return corners.every((c) => l.shadow.getFrustum().containsPoint(c));
  };

  it("holds the whole model from any side once fitted", () => {
    for (const dir of [new THREE.Vector3(1, 0.4, 0.8), new THREE.Vector3(-1, -1, 0.2), new THREE.Vector3(0.1, 0.1, 1), new THREE.Vector3(0, -1, 0.05)]) {
      const l = new THREE.DirectionalLight();
      fitShadowMap(l.shadow, size);
      expect(held(l, dir), `from ${dir.toArray()}`).toBe(true);
    }
  });

  it("does not hold it as the renderer makes it", () => {
    expect(held(new THREE.DirectionalLight(), new THREE.Vector3(1, 0.4, 0.8))).toBe(false);
  });

  it("is the same for every light of a set, whenever each was made", () => {
    const key = new THREE.DirectionalLight();
    const later = new THREE.DirectionalLight();
    fitShadowMap(key.shadow, size);
    fitShadowMap(later.shadow, size);
    const c = (l: THREE.DirectionalLight) => [l.shadow.camera.left, l.shadow.camera.right, l.shadow.camera.top, l.shadow.camera.bottom, l.shadow.camera.near, l.shadow.camera.far, l.shadow.normalBias];
    expect(c(later)).toEqual(c(key));
    expect(c(key)[1]).toBeGreaterThan(10);
  });

  it("is never smaller than a small model needs", () => {
    const l = new THREE.DirectionalLight();
    fitShadowMap(l.shadow, new THREE.Vector3(1, 1, 1));
    expect(l.shadow.camera.right).toBe(17);
    expect(l.shadow.normalBias).toBeGreaterThan(0);
  });
});
