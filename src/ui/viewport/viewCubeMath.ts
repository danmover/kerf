// The view cube's geometry: the way each face, edge and corner looks from, how the cube turns with the camera, and
// which face is square on (for the arrows that step to the next face). Z is up; the front looks from -Y.

import * as THREE from "three";
import type { ViewPreset } from "../../app/view";

export type V3 = [number, number, number];
export type FaceName = Exclude<ViewPreset, "iso">;

export interface CubeFace {
  name: FaceName;
  label: string;
  /** the axis it faces, as the design language writes it */
  axis: string;
  /** outward normal, and the face's own right and down directions as it is read, in the model's axes */
  n: V3;
  u: V3;
  v: V3;
  /** where the face sits on a CSS cube centred on its origin, before moving out by half the side */
  css: string;
}

export const CUBE_FACES: CubeFace[] = [
  { name: "front", label: "FRONT", axis: "−Y", n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, -1], css: "" },
  { name: "right", label: "RIGHT", axis: "+X", n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, -1], css: "rotateY(90deg)" },
  { name: "back", label: "BACK", axis: "+Y", n: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, -1], css: "rotateY(180deg)" },
  { name: "left", label: "LEFT", axis: "−X", n: [-1, 0, 0], u: [0, -1, 0], v: [0, 0, -1], css: "rotateY(-90deg)" },
  { name: "top", label: "TOP", axis: "+Z", n: [0, 0, 1], u: [1, 0, 0], v: [0, -1, 0], css: "rotateX(90deg)" },
  { name: "bottom", label: "BOTTOM", axis: "−Z", n: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0], css: "rotateX(-90deg)" },
];

/** The direction looked from at cell (i, j) of a face: i across (-1 left, 0 middle, 1 right), j down (-1 top, 1 bottom). */
export function cellDir(f: CubeFace, i: number, j: number): V3 {
  return [0, 1, 2].map((k) => f.n[k] + i * f.u[k] + j * f.v[k]) as V3;
}

/** The key every cell looking from the same direction shares: an edge's two strips, a corner's three squares. */
export const dirKey = (d: V3) => d.join(",");

/** The face looking from straight along an axis, else null (an edge or a corner). */
export function faceFor(d: V3): FaceName | null {
  const nz = d.filter((x) => x !== 0).length;
  if (nz !== 1) return null;
  return CUBE_FACES.find((f) => f.n.every((x, k) => Math.sign(x) === Math.sign(d[k])))!.name;
}

/** How a direction is said: "front", "top front right". */
export function dirName(d: V3): string {
  const words: string[] = [];
  if (d[2]) words.push(d[2] > 0 ? "top" : "bottom");
  if (d[1]) words.push(d[1] > 0 ? "back" : "front");
  if (d[0]) words.push(d[0] > 0 ? "right" : "left");
  return words.join(" ");
}

// the model's axes (Z up) to the cube's CSS axes (x right, y down, z out of the screen) when it shows its front
const B = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, -1, 0, 0, 0, 0, 0, 1);
const FLIP_Y = new THREE.Matrix4().makeScale(1, -1, 1);

/** The cube's CSS transform for a camera orientation: the model's axes as the camera sees them, with y pointing down. */
export function cubeMatrix(q: THREE.Quaternion, out = new THREE.Matrix4()): THREE.Matrix4 {
  const view = new THREE.Matrix4().makeRotationFromQuaternion(q).transpose();
  return out.copy(FLIP_Y).multiply(view).multiply(B);
}

/** A matrix as a CSS matrix3d() (both are column-major). */
export const cssMatrix = (m: THREE.Matrix4) => `matrix3d(${m.elements.map((v) => (Math.abs(v) < 1e-9 ? 0 : +v.toFixed(6))).join(",")})`;

/** The model's axes to the cube's CSS axes, for placing things on the cube. */
export const toCss = (w: V3): V3 => [w[0], -w[2], -w[1]];

function snap(v: THREE.Vector3): V3 {
  const a = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)];
  const k = a[0] >= a[1] && a[0] >= a[2] ? 0 : a[1] >= a[2] ? 1 : 2;
  const out: V3 = [0, 0, 0];
  out[k] = Math.sign(v.getComponent(k)) || 1;
  return out;
}

export interface SquareOn {
  face: FaceName;
  /** the faces the arrows beside the cube step to: the one now to the right comes round to the front, and so on */
  right: FaceName;
  left: FaceName;
  up: FaceName;
  down: FaceName;
}

/** When the camera looks square at a face (within about 2 degrees): that face and the faces to either side of it on screen. */
export function squareOn(q: THREE.Quaternion): SquareOn | null {
  const back = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  if (Math.max(Math.abs(back.x), Math.abs(back.y), Math.abs(back.z)) < 0.9995) return null;
  const right = snap(new THREE.Vector3(1, 0, 0).applyQuaternion(q));
  const up = snap(new THREE.Vector3(0, 1, 0).applyQuaternion(q));
  const neg = (d: V3): V3 => [-d[0], -d[1], -d[2]];
  return { face: faceFor(snap(back))!, right: faceFor(right)!, left: faceFor(neg(right))!, up: faceFor(up)!, down: faceFor(neg(up))! };
}
