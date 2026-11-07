// Where a fan moves air: the space in front of its intake that it draws from,
// and the jet behind it. Cables are kept out of both: the router treats them
// as nearly solid, and the wiring checks fail a cable left in one. A cable
// drawn into an intake is cut by the blades; one in the jet flutters, wears
// through and blocks thrust. Each zone is a cone along the fan's axis, and
// only the part of it that the axis can see counts (a cell behind a duct's
// wall is out of the flow even when the cone reaches it).

import type { Model } from "../../core/model";
import { xformMatrix, type V3 } from "../../kernel/recipe";
import { catalogPart } from "../catalog";

export interface FlowZone {
  /** the fan's main solid, and its component instance name */
  partId: string;
  comp: string;
  kind: "intake" | "jet";
  /** where the zone starts (the intake face or the exhaust face), assembly coordinates */
  o: V3;
  /** the way the zone runs from o, away from the fan (unit) */
  dir: V3;
  /** radius at o, mm, and how much it grows per mm along dir */
  r0: number;
  grow: number;
  /** length along dir, mm */
  len: number;
}

/** Jets spread at about this half angle once they leave the duct (tan 5°). */
const JET_SPREAD = 0.0875;
/** How far in front of an intake the air is drawn fast enough to pull a loose cable in, in fan diameters. */
const INTAKE_REACH = 0.6;
/** How far a jet is kept clear, in fan diameters (the router's region ends it sooner on a bench). */
const JET_REACH = 8;

const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const num = (d: Record<string, number>, k: string, def: number) => (typeof d[k] === "number" ? d[k] : def);

/** The intake and jet of every ducted fan in the design. */
export function flowZones(model: Model): FlowZone[] {
  const out: FlowZone[] = [];
  const counts = new Map((model.machine?.components ?? []).map((c) => [c.name, c.count]));
  for (const p of model.parts) {
    if (p.hidden || p.kind !== "component" || p.id.includes(".") || !p.bom?.catalogId) continue;
    const part = catalogPart(p.bom.catalogId);
    if (part?.geom.g !== "edf") continue;
    const d = part.geom.dims;
    const od = num(d, "od", 70);
    const fd = num(d, "fan_d", 64);
    const L = num(d, "length", 66);
    const m = xformMatrix(p.xf);
    const at = (x: number, y: number, z: number): V3 => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
    const axis = norm([m[8], m[9], m[10]]);
    const inst = p.id.match(/#(\d+)$/);
    const comp = (counts.get(p.name) ?? 1) > 1 && inst ? `${p.name}[${Number(inst[1]) - 1}]` : p.name;
    // the housing's local +Z points out of the intake; the air comes in from there and leaves at z = -L
    out.push({ partId: p.id, comp, kind: "intake", o: at(0, 0, 0), dir: axis, r0: od / 2 + 6, grow: 0.25, len: INTAKE_REACH * fd });
    out.push({ partId: p.id, comp, kind: "jet", o: at(0, 0, -L), dir: [-axis[0], -axis[1], -axis[2]], r0: fd / 2 + 2, grow: JET_SPREAD, len: JET_REACH * fd });
  }
  return out;
}

/** Is p inside the zone's cone (ignoring what shades it)? Returns its distance along the axis, or -1. */
export function inCone(z: FlowZone, p: V3): number {
  const v: V3 = [p[0] - z.o[0], p[1] - z.o[1], p[2] - z.o[2]];
  const s = v[0] * z.dir[0] + v[1] * z.dir[1] + v[2] * z.dir[2];
  if (s < 0 || s > z.len) return -1;
  const q: V3 = [v[0] - z.dir[0] * s, v[1] - z.dir[1] * s, v[2] - z.dir[2] * s];
  return Math.hypot(q[0], q[1], q[2]) <= z.r0 + z.grow * s ? s : -1;
}

/** The zone's axis-aligned bounds, for marking a grid. */
export function zoneBounds(z: FlowZone): [V3, V3] {
  const r = z.r0 + z.grow * z.len;
  const e: V3 = [z.o[0] + z.dir[0] * z.len, z.o[1] + z.dir[1] * z.len, z.o[2] + z.dir[2] * z.len];
  const lo: V3 = [0, 0, 0];
  const hi: V3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    // a disc of radius r across dir reaches r * sqrt(1 - dir_k^2) along axis k
    const ext = (rr: number) => rr * Math.sqrt(Math.max(0, 1 - z.dir[k] * z.dir[k]));
    lo[k] = Math.min(z.o[k] - ext(z.r0), e[k] - ext(r));
    hi[k] = Math.max(z.o[k] + ext(z.r0), e[k] + ext(r));
  }
  return [lo, hi];
}

/** A fan zone's name in the checks: "the EDF's jet". */
export const zoneWord = (z: FlowZone) => (z.kind === "intake" ? "intake" : "jet");
