import { describe, expect, it } from "vitest";
import { lightSteps } from "../src/ui/viewport/render/studio";

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
