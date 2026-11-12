// The view cube: every face, edge and corner looks from its own direction, each face reads the right way up when
// looked at square on, and the arrows beside it step round to the faces to either side.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CUBE_FACES, cellDir, cubeMatrix, dirKey, dirName, faceFor, squareOn, toCss, type V3 } from "../src/ui/viewport/viewCubeMath";

/** the camera's orientation looking at the origin from a direction, Z up, as the viewport's presets set it */
function cameraFrom(d: V3): THREE.Quaternion {
  const cam = new THREE.PerspectiveCamera();
  cam.up.set(0, 0, 1);
  const v = new THREE.Vector3(...d);
  if (Math.abs(v.normalize().z) > 0.99999) v.set(0, -0.0001, Math.sign(v.z));
  cam.position.copy(v.normalize().multiplyScalar(100));
  cam.lookAt(0, 0, 0);
  return cam.quaternion.clone();
}

/** a face's CSS rotation (the rotateX()/rotateY() it is placed with), as the CSS transforms spec writes the matrices */
function cssRotation(css: string): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  const r = /rotate([XY])\((-?\d+)deg\)/.exec(css);
  if (!r) return m;
  const a = (+r[2] * Math.PI) / 180,
    c = Math.round(Math.cos(a)),
    s = Math.round(Math.sin(a));
  return r[1] === "X" ? m.set(1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1) : m.set(c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1);
}

const round = (v: THREE.Vector3): V3 => [Math.round(v.x) || 0, Math.round(v.y) || 0, Math.round(v.z) || 0];

describe("view cube", () => {
  it("looks from 26 directions: six faces, twelve edges, eight corners", () => {
    const seen = new Map<string, number>();
    for (const f of CUBE_FACES) for (const j of [-1, 0, 1]) for (const i of [-1, 0, 1]) seen.set(dirKey(cellDir(f, i, j)), (seen.get(dirKey(cellDir(f, i, j))) ?? 0) + 1);
    expect(seen.size).toBe(26);
    const counts = [...seen.values()].sort();
    expect(counts.filter((c) => c === 1)).toHaveLength(6);
    expect(counts.filter((c) => c === 2)).toHaveLength(12);
    expect(counts.filter((c) => c === 3)).toHaveLength(8);
    const front = CUBE_FACES.find((f) => f.name === "front")!;
    expect(cellDir(front, 0, 0)).toEqual([0, -1, 0]);
    // the front's top right corner looks from the top, front and right
    expect(cellDir(front, 1, -1)).toEqual([1, -1, 1]);
    expect(dirName([1, -1, 1])).toBe("top front right");
    expect(faceFor([0, 0, 1])).toBe("top");
    expect(faceFor([1, -1, 0])).toBeNull();
  });

  it("places each face where its directions say, and reads it the right way up square on", () => {
    for (const f of CUBE_FACES) {
      // the face's own right, down and outward directions on the CSS cube, back in the model's axes
      const R = cssRotation(f.css);
      const axis = (x: number, y: number, z: number) => round(new THREE.Vector3(...toCss(round(new THREE.Vector3(x, y, z).applyMatrix4(R)))));
      expect(axis(1, 0, 0), `${f.name} right`).toEqual(f.u);
      expect(axis(0, 1, 0), `${f.name} down`).toEqual(f.v);
      expect(axis(0, 0, 1), `${f.name} outward`).toEqual(f.n);
      // looked at from straight in front of it, the face shows unturned and unmirrored
      const onScreen = cubeMatrix(cameraFrom(f.n)).multiply(R);
      const e = onScreen.elements;
      for (const [k, want] of [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1].entries()) expect(e[k], `${f.name} [${k}]`).toBeCloseTo(want, 3);
    }
  });

  it("turns with the camera: the iso view shows the front, right and top", () => {
    const m = cubeMatrix(cameraFrom([0.9, -1.25, 0.85]));
    const facing = CUBE_FACES.filter((f) => new THREE.Vector3(0, 0, 1).applyMatrix4(cssRotation(f.css)).applyMatrix4(m).z > 0).map((f) => f.name);
    expect(facing.sort()).toEqual(["front", "right", "top"]);
  });

  it("knows the face looked at square on, and the faces to step to", () => {
    expect(squareOn(cameraFrom([0, -1, 0]))).toEqual({ face: "front", right: "right", left: "left", up: "top", down: "bottom" });
    expect(squareOn(cameraFrom([1, 0, 0]))).toEqual({ face: "right", right: "back", left: "front", up: "top", down: "bottom" });
    // from the top, up the screen is the back
    expect(squareOn(cameraFrom([0, 0, 1]))).toEqual({ face: "top", right: "right", left: "left", up: "back", down: "front" });
    expect(squareOn(cameraFrom([0.9, -1.25, 0.85]))).toBeNull();
  });
});
