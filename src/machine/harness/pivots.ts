// Pivots the wiring crosses, such as a gimbal's two axes: which body each
// wired part rides on (from the design's sim.pivot joints), where a cable
// from one body to the next crosses each joint, and the space each moving
// body sweeps through its travel.
//
// A cable crosses a joint beside its bearing, as close to the axis as there
// is room, so turning the joint twists the cable a little instead of
// stretching it. Of the two ends of the axis it takes the one that keeps its
// run shortest, except that signal wires cross at the other end from motor
// leads when that costs them little: switching motor current next to an I2C
// or servo signal line is how a bench rig gets glitches. On the body a joint
// hangs on, cables keep out of the space the joint's moving parts sweep
// through, so the moving parts never catch them.

import type { Model } from "../../core/model";
import type { V3 } from "../../kernel/recipe";
import type { HarnessWire } from "./harness";
import type { RouteEnd, RouteKeepOut, RouteVia } from "./route";
import { transform, type SolidGeometry, type SolidPlaced } from "./solids";

export interface PivotJoint {
  name: string;
  /** a point on the axis, assembly coordinates (mm) */
  at: V3;
  /** the axis, unit */
  axis: V3;
  /** travel either way from the design pose, degrees */
  limits: [number, number];
  /** ids of the solids that turn on it: its own body, not the bodies hung on it */
  parts: string[];
  /** the joint whose body it hangs on, or null for the frame */
  parent: string | null;
}

/** One cable's way across one joint. */
export interface PivotCrossing {
  wire: string;
  joint: string;
  /** the end of the axis it crosses at: +1 along the axis, -1 against it */
  side: 1 | -1;
  /** it was moved to this end to keep it apart from the motor leads */
  apart: boolean;
}

export interface CrossingPlan {
  /** per wire id: the points it passes on its way across each joint, and what each leg between them keeps out of */
  wires: Map<string, { via: RouteVia[]; legAvoid: number[] }>;
  /** the moving bodies' sweeps */
  keepOut: RouteKeepOut[];
  crossings: PivotCrossing[];
  /** the joints crossed, with the bit their sweep uses */
  joints: { name: string; bit: number }[];
}

const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

/** Every pivot in the design's scenarios, once each by name (a scenario that welds a joint still has it free in another). */
export function pivotJoints(model: Model): PivotJoint[] {
  const items = new Map<string, { what: string[]; on: string | null; at: V3; axis: V3; limits?: [number, number] }>();
  for (const sc of model.scenarios ?? [])
    for (const it of sc.spec.mechanism?.items ?? []) {
      if (it.k !== "pivot" || !it.at || !it.axis || items.has(it.name)) continue;
      items.set(it.name, { what: it.what, on: it.on, at: it.at, axis: it.axis, limits: it.limits });
    }
  if (!items.size) return [];
  const ids = new Map<string, string[]>();
  for (const p of model.parts) if (!p.hidden) ids.set(p.name, [...(ids.get(p.name) ?? []), p.id]);
  // the joint each member rides on
  const jointOf = new Map<string, string>();
  for (const [name, it] of items) for (const w of it.what) if (!jointOf.has(w)) jointOf.set(w, name);
  return [...items].map(([name, it]) => ({
    name,
    at: it.at,
    axis: norm(it.axis),
    limits: it.limits ?? [-30, 30],
    parts: it.what.flatMap((w) => ids.get(w) ?? []),
    parent: it.on === null ? null : (jointOf.get(it.on) ?? null),
  }));
}

/** 4x4 column-major: turn by `deg` about the line through `at` along `axis`, after m. */
function turnAbout(m: number[], at: V3, axis: V3, deg: number): number[] {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const t = 1 - c;
  const [x, y, z] = axis;
  const R = [t * x * x + c, t * x * y + s * z, t * x * z - s * y, t * x * y - s * z, t * y * y + c, t * y * z + s * x, t * x * z + s * y, t * y * z - s * x, t * z * z + c];
  const rot = (v: V3): V3 => [R[0] * v[0] + R[3] * v[1] + R[6] * v[2], R[1] * v[0] + R[4] * v[1] + R[7] * v[2], R[2] * v[0] + R[5] * v[1] + R[8] * v[2]];
  const cx = rot([m[0], m[1], m[2]]);
  const cy = rot([m[4], m[5], m[6]]);
  const cz = rot([m[8], m[9], m[10]]);
  const o = add(rot([m[12] - at[0], m[13] - at[1], m[14] - at[2]]), at);
  return [cx[0], cx[1], cx[2], 0, cy[0], cy[1], cy[2], 0, cz[0], cz[1], cz[2], 0, o[0], o[1], o[2], 1];
}

/** Motor leads switch heavy current; signal wires and multi-core signal cables are what picks it up. */
const isMotor = (w: HarnessWire) => w.row.kind === "motor";
const isSignal = (w: HarnessWire) => w.row.kind === "signal" || w.row.kind === "cable";

/**
 * Where each cable that runs between bodies crosses their joints, and the sweeps the cables on each body keep out
 * of. `ends` are the cables' run ends as the router gets them; `firstBit` is the first keep-out bit free.
 */
export function planCrossings(joints: PivotJoint[], wires: HarnessWire[], ends: Map<string, { a: RouteEnd; b: RouteEnd }>, geos: SolidGeometry[], placed: SolidPlaced[], firstBit = 0): CrossingPlan {
  const out: CrossingPlan = { wires: new Map(), keepOut: [], crossings: [], joints: [] };
  if (!joints.length) return out;
  const byName = new Map(joints.map((j) => [j.name, j]));
  const bodyOf = new Map<string, string>();
  for (const j of joints) for (const id of j.parts) if (!bodyOf.has(id)) bodyOf.set(id, j.name);
  // a part's sub-solids (servo_1.horn) ride with it
  const body = (id: string): string | null => bodyOf.get(id) ?? bodyOf.get(id.split(".")[0]) ?? null;
  const up = (b: string | null): (string | null)[] => {
    const chain: (string | null)[] = [];
    for (let k: string | null = b, n = 0; n < 32; n++) {
      chain.push(k);
      if (k === null) break;
      k = byName.get(k)?.parent ?? null;
    }
    return chain;
  };
  // every solid of a joint's body and the bodies hung on it
  const under = new Map<string, Set<string>>();
  for (const j of joints) {
    const set = new Set<string>();
    for (const k of joints) if (up(k.name).includes(j.name)) for (const id of k.parts) set.add(id);
    under.set(j.name, set);
  }
  const localBox = geos.map((g) => {
    const lo: V3 = [Infinity, Infinity, Infinity];
    const hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < g.positions.length; i += 3)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], g.positions[i + k]);
        hi[k] = Math.max(hi[k], g.positions[i + k]);
      }
    return [lo, hi] as [V3, V3];
  });
  const corners = (pl: SolidPlaced, m = pl.m) => {
    const [lo, hi] = localBox[pl.geo];
    if (!Number.isFinite(lo[0])) return [];
    return Array.from({ length: 8 }, (_, c) => transform(m, c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2]));
  };
  const inBody = (j: PivotJoint) => placed.filter((pl) => pl.id && (under.get(j.name)!.has(pl.id) || under.get(j.name)!.has(pl.id.split(".")[0])));
  // where the moving body ends along its axis, each way: a cable crosses just past it
  const ends2 = new Map<string, [V3, V3]>();
  const endsOf = (j: PivotJoint): [V3, V3] => {
    let got = ends2.get(j.name);
    if (got) return got;
    let lo = Infinity;
    let hi = -Infinity;
    for (const pl of inBody(j))
      for (const p of corners(pl)) {
        const s = dot([p[0] - j.at[0], p[1] - j.at[1], p[2] - j.at[2]], j.axis);
        lo = Math.min(lo, s);
        hi = Math.max(hi, s);
      }
    if (!Number.isFinite(lo)) lo = hi = 0;
    got = [add(j.at, j.axis, lo - 2), add(j.at, j.axis, hi + 2)];
    ends2.set(j.name, got);
    return got;
  };

  // ---- each cable's joints, and the end of each axis it crosses at
  interface Run {
    w: HarnessWire;
    joints: PivotJoint[];
    /** the body each leg is on: legs[i] before crossing joints[i], the last after them all */
    legs: (string | null)[];
    sides: (1 | -1)[];
    apart: boolean[];
  }
  const runs: Run[] = [];
  for (const w of wires) {
    const a = body(w.ends[0].partId);
    const b = body(w.ends[1].partId);
    if (a === b) continue;
    const ua = up(a);
    const ub = up(b);
    const lca = ua.find((x) => ub.includes(x)) ?? null;
    const climb = ua.slice(0, ua.indexOf(lca)) as string[];
    const drop = (ub.slice(0, ub.indexOf(lca)) as string[]).reverse();
    const js = [...climb, ...drop].map((n) => byName.get(n)!).filter(Boolean);
    if (!js.length) continue;
    const legs: (string | null)[] = [a];
    for (const n of climb) legs.push(byName.get(n)?.parent ?? null);
    for (const n of drop) legs.push(n);
    runs.push({ w, joints: js, legs, sides: js.map(() => 1), apart: js.map(() => false) });
  }
  if (!runs.length) return out;
  const pathLen = (r: Run, sides: (1 | -1)[]) => {
    const e = ends.get(r.w.id);
    if (!e) return 0;
    let p = e.a.p;
    let L = 0;
    r.joints.forEach((j, i) => {
      const c = endsOf(j)[sides[i] > 0 ? 1 : 0];
      L += dist(p, c);
      p = c;
    });
    return L + dist(p, e.b.p);
  };
  // a part's own multi-wire lead (a load cell's four wires, a fan's three motor leads) crosses as one cable: the runs
  // that leave the same part's lead over the same joints share their sides
  const lead = new Map<string, number>();
  const group = runs.map((_, i) => i);
  const root = (i: number): number => (group[i] === i ? i : (group[i] = root(group[i])));
  runs.forEach((r, i) => {
    for (const e of r.w.ends) {
      if (e.spec.kind !== "lead") continue;
      const k = `${e.partId}|${r.joints.map((j) => j.name).join(",")}`;
      const was = lead.get(k);
      if (was === undefined) lead.set(k, i);
      else group[root(i)] = root(was);
    }
  });
  const cables = new Map<number, Run[]>();
  runs.forEach((r, i) => cables.set(root(i), [...(cables.get(root(i)) ?? []), r]));
  const total = (rs: Run[], sides: (1 | -1)[]) => rs.reduce((s, r) => s + pathLen(r, sides), 0);
  const setSides = (rs: Run[], sides: (1 | -1)[]) => rs.forEach((r) => (r.sides = [...sides]));
  for (const rs of cables.values()) {
    // the shortest way across, trying both ends of every joint (a gimbal has two, so four ways at most)
    const n = rs[0].joints.length;
    let best = Infinity;
    for (let mask = 0; mask < 1 << n; mask++) {
      const sides = rs[0].joints.map((_, i) => ((mask >> i) & 1 ? -1 : 1) as 1 | -1);
      const L = total(rs, sides);
      if (L < best - 1e-6) {
        best = L;
        setSides(rs, sides);
      }
    }
  }
  // signal wires cross at the other end from the motor leads where that adds little to their run (supply and ground
  // wires don't mind the company, and stay on their shortest way)
  for (const j of new Set(runs.flatMap((r) => r.joints))) {
    const k = (r: Run) => r.joints.indexOf(j);
    const at = [...cables.values()].filter((rs) => rs[0].joints.includes(j));
    const motor = at.flat().filter((r) => isMotor(r.w));
    if (!motor.length) continue;
    const plus = motor.filter((r) => r.sides[k(r)] > 0).length;
    const hot = plus * 2 >= motor.length ? 1 : -1;
    for (const rs of at) {
      if (rs.some((r) => isMotor(r.w)) || !rs.some((r) => isSignal(r.w)) || rs[0].sides[k(rs[0])] !== hot) continue;
      const sides = [...rs[0].sides];
      sides[k(rs[0])] = -hot as 1 | -1;
      const now = total(rs, rs[0].sides);
      const then = total(rs, sides);
      if (then - now <= Math.max(120 * rs.length, 0.35 * now)) {
        setSides(rs, sides);
        for (const r of rs) r.apart[k(r)] = true;
      }
    }
  }

  // ---- the sweeps: each crossed joint's moving parts at five places through its travel
  const crossed = [...new Set(runs.flatMap((r) => r.joints))];
  const bits = new Map<string, number>();
  for (const j of crossed) {
    if (firstBit + bits.size >= 16) break;
    const bit = 1 << (firstBit + bits.size);
    bits.set(j.name, bit);
    out.joints.push({ name: j.name, bit });
    const [l0, l1] = j.limits;
    const angles = [l0, l0 / 2, 0, l1 / 2, l1].filter((a, i, all) => all.indexOf(a) === i);
    for (const pl of inBody(j)) {
      const [lo, hi] = localBox[pl.geo];
      if (!Number.isFinite(lo[0])) continue;
      // small hardware sweeps inside what it holds
      if (Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) < 4) continue;
      for (const a of angles) out.keepOut.push({ lo, hi, bit, m: turnAbout(pl.m, j.at, j.axis, a) });
    }
  }
  // a leg on a body keeps out of the sweeps of the crossed joints that hang on that body
  const avoidOn = (b: string | null) => {
    let m = 0;
    for (const j of crossed) if (j.parent === b && bits.has(j.name)) m |= bits.get(j.name)!;
    return m;
  };
  for (const r of runs) {
    out.wires.set(r.w.id, {
      via: r.joints.map((j, i) => ({ c: endsOf(j)[r.sides[i] > 0 ? 1 : 0], axis: j.axis, at: j.at })),
      legAvoid: r.legs.map(avoidOn),
    });
    r.joints.forEach((j, i) => out.crossings.push({ wire: r.w.id, joint: j.name, side: r.sides[i], apart: r.apart[i] }));
  }
  return out;
}
