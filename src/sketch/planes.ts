// Sketch planes as language values: XY, XZ and YZ, plane(origin:, normal:, x:)
// and -XY style flips. A plane is an object with origin, normal, x and y.

import { Obj, Vec, type Value } from "../lang/values";
import { vcross, vdot, vnorm, vscale, vsub, type V3 } from "../kernel/recipe";
import type { Frame } from "./types";

export function planeValue(f: Frame, label: string): Obj {
  return new Obj({ origin: new Vec([...f.o]), normal: new Vec([...f.n]), x: new Vec([...f.u]), y: new Vec([...f.v]) }, "plane", label);
}

/** Named planes. Each is seen from outside: XY from above, XZ from the front, YZ from the right. */
export const PLANES: Record<string, Frame> = {
  XY: { o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },
  XZ: { o: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], n: [0, -1, 0] },
  YZ: { o: [0, 0, 0], u: [0, 1, 0], v: [0, 0, 1], n: [1, 0, 0] },
};

export function planeConstants(): Record<string, Obj> {
  return Object.fromEntries(Object.entries(PLANES).map(([k, f]) => [k, planeValue(f, k)]));
}

export function isPlane(v: Value): v is Obj {
  return v instanceof Obj && v.kind === "plane";
}

export function frameOf(p: Obj): Frame {
  const g = (k: string): V3 => {
    const v = p.fields[k];
    return v instanceof Vec ? [v.v[0] ?? 0, v.v[1] ?? 0, v.v[2] ?? 0] : [0, 0, 0];
  };
  return { o: g("origin"), u: g("x"), v: g("y"), n: g("normal") };
}

/** The same plane seen from the other side: normal and x reversed, y kept. */
export function flipPlane(p: Obj): Obj {
  const f = frameOf(p);
  return planeValue({ o: f.o, u: vscale(f.u, -1), v: f.v, n: vscale(f.n, -1) }, p.label?.startsWith("-") ? p.label.slice(1) : `-${p.label ?? "plane"}`);
}

/** A plane through origin with the given normal; x is projected into the plane (or chosen when omitted). */
export function makeFrame(origin: V3, normal: V3, x?: V3): Frame {
  const n = vnorm(normal);
  let u: V3;
  if (x) u = vsub(x, vscale(n, vdot(x, n)));
  else if (Math.abs(n[2]) > 0.999) u = n[2] > 0 ? [1, 0, 0] : [-1, 0, 0];
  else u = vcross([0, 0, 1], n);
  if (Math.hypot(...u) < 1e-9) throw new Error("plane(): x must not be parallel to the normal");
  u = vnorm(u);
  return { o: origin, u, v: vcross(n, u), n };
}

export const toWorld = (f: Frame, x: number, y: number): V3 => [f.o[0] + f.u[0] * x + f.v[0] * y, f.o[1] + f.u[1] * x + f.v[1] * y, f.o[2] + f.u[2] * x + f.v[2] * y];
export const toLocal = (f: Frame, p: V3): [number, number] => {
  const d = vsub(p, f.o);
  return [vdot(d, f.u), vdot(d, f.v)];
};
