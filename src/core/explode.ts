// Smart exploded views: which way each part comes off, how far, and in what
// order, read from how the design holds together (holds.ts). Screws back out
// along their own axes with their washers; nuts drop off the far end. Parts
// come off the screw stacks and round fits they sit in along those axes, and
// a part comes off only after everything fastened onto it, carrying what
// sits on it. The biggest, best-connected part stays put. A part held only by
// touching comes off the way that frees it soonest, up when that is as good.
// Bought parts (a motor and its shaft), parts soldered to a board and
// inserts in their pockets stay together. `explode: (x, y, z)` on a part sets
// its direction; `explode: false` keeps it on what it sits on.
//
// The 3D view plays the plan step by step along the explode slider and runs
// it backwards for Play assembly; drawings use it for their exploded views.
// Pure model reading; no kernel calls.

import type { EvalPart, Model } from "./model";
import { findHolds, isTnut, worldBox, type Holds, type MeshLookup, type Stack } from "./holds";
import { findFits } from "../analysis/fits/detect";
import { axialOverlap, cylMid } from "../analysis/fits/geometry";
import { applyXforms, frameFor, vdot, vnorm, vsub, xformMatrix, type V3 } from "../kernel/recipe";
import { TriBVH } from "../mfg/bvh";

type Box = [V3, V3];

/** How a part comes off: the base stays, hardware leaves along its screw, parts along a stack, fit or contact, or with what they belong to. */
export type ExplodeVia = "base" | "screw" | "nut" | "washer" | "stack" | "fit" | "contact" | "set" | "rigid" | "free";

export interface ExplodeMove {
  id: string;
  /** the part it comes off (its offset adds to this one's), by id; none for a base */
  from?: string;
  /** unit direction it leaves along, world */
  dir: V3;
  /** how far it moves off what it comes off at full explode, mm */
  dist: number;
  /** disassembly step: 0 comes off first; a part comes off after everything fastened onto it */
  stage: number;
  via: ExplodeVia;
}

export interface ExplodePlan {
  /** by part id, parents before children */
  moves: Map<string, ExplodeMove>;
  /** steps that move something */
  stages: number;
  /** assembly order: each base, then every part after the one it goes on, its screws, washers and nuts once both sides are on */
  order: string[];
  /** the assembly's biggest extent, mm */
  size: number;
}

export interface ExplodeOptions {
  holds?: Holds;
  mesh?: MeshLookup;
  /** a part's box in the assembly (default: its recipe's, or its mesh's) */
  boxOf?: (p: EvalPart) => Box | null;
  /** only these parts (a drawing of some of the assembly) */
  parts?: EvalPart[];
}

const HARDWARE = new Set(["screw", "nut", "washer"]);
/** screws, nuts and washers come off their stacks; inserts and standoffs are parts of their own */
const isHardware = (p: EvalPart) => HARDWARE.has(p.libKind ?? "");
const instanceOf = (p: EvalPart) => p.id.split(".")[0];
/** names a design gives the part everything goes on */
const BASE_NAME = /(^|_)(base|frame|chassis|housing|body|case|enclosure|tray|deck|bed_frame|baseplate|base_plate)(_|$|\d)/i;
const UP: V3 = [0, 0, 1];
const AXES: V3[] = [
  [0, 0, 1],
  [0, 0, -1],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
];

const neg = (v: V3): V3 => [-v[0], -v[1], -v[2]];
const centre = (b: Box): V3 => [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2, (b[0][2] + b[1][2]) / 2];
const volume = (b: Box) => Math.max(1e-3, b[1][0] - b[0][0]) * Math.max(1e-3, b[1][1] - b[0][1]) * Math.max(1e-3, b[1][2] - b[0][2]);
/** the box's span along a direction: [min, max] of its corners */
function along(b: Box, d: V3): [number, number] {
  let lo = 0;
  let hi = 0;
  for (let k = 0; k < 3; k++) {
    const a = b[0][k] * d[k];
    const c = b[1][k] * d[k];
    lo += Math.min(a, c);
    hi += Math.max(a, c);
  }
  return [lo, hi];
}
/** how much of box a lies inside box b, 0 to 1 */
function insideShare(a: Box | null, b: Box | null): number {
  if (!a || !b) return 0;
  let v = 1;
  for (let k = 0; k < 3; k++) {
    const w = a[1][k] - a[0][k];
    const o = Math.min(a[1][k], b[1][k]) - Math.max(a[0][k], b[0][k]);
    if (o < 0) return 0;
    v *= w > 1e-6 ? o / w : 1;
  }
  return v;
}
const touch = (a: Box, b: Box, tol: number) => a[0].every((_, k) => a[0][k] <= b[1][k] + tol && b[0][k] <= a[1][k] + tol);
const shifted = (b: Box, o: V3): Box => [
  [b[0][0] + o[0], b[0][1] + o[1], b[0][2] + o[2]],
  [b[1][0] + o[0], b[1][1] + o[1], b[1][2] + o[2]],
];
const union = (a: Box | null, b: Box | null): Box | null =>
  !a ? b : !b ? a : [[Math.min(a[0][0], b[0][0]), Math.min(a[0][1], b[0][1]), Math.min(a[0][2], b[0][2])], [Math.max(a[1][0], b[1][0]), Math.max(a[1][1], b[1][1]), Math.max(a[1][2], b[1][2])]];

interface Unit {
  i: number;
  members: EvalPart[];
  /** the member the rest ride with: the biggest */
  rep: EvalPart;
  box: Box | null;
  vol: number;
  override?: V3 | false;
}

interface Edge {
  a: number;
  b: number;
  kind: "stack" | "fit" | "contact";
  /** stacks and fits: the line they come apart along, and how far they overlap along it */
  axis?: V3;
  /** stacks: how far b sits along the axis past a (b leaves along +axis from a) */
  order?: number;
  clear?: number;
  /** fits: which unit holds the hole */
  hole?: number;
  sign?: number;
}

const cache = new WeakMap<Holds, Map<string, ExplodePlan>>();

/** The exploded view of a design: each part's direction, distance and step. Cached per holds result and part list. */
export function planExplode(model: Model, opts: ExplodeOptions = {}): ExplodePlan {
  const holds = opts.holds ?? findHolds(model, opts.mesh);
  const parts = (opts.parts ?? model.parts).filter((p) => !p.hidden);
  const key = parts.map((p) => p.id).join("|") + (opts.boxOf ? "#b" : "");
  let byKey = cache.get(holds);
  const hit = byKey?.get(key);
  if (hit) return hit;
  const plan = compute(model, parts, holds, opts.boxOf ?? ((p) => worldBox(p, opts.mesh)), opts.mesh);
  if (!byKey) cache.set(holds, (byKey = new Map()));
  if (byKey.size > 8) byKey.clear();
  byKey.set(key, plan);
  return plan;
}

function compute(model: Model, parts: EvalPart[], holds: Holds, boxOf: (p: EvalPart) => Box | null, mesh?: MeshLookup): ExplodePlan {
  const ids = new Map(parts.map((p) => [p.id, p]));
  const boxes = new Map<string, Box | null>(parts.map((p) => [p.id, boxOf(p)]));
  let all: Box | null = null;
  for (const b of boxes.values()) all = union(all, b);
  const size = all ? Math.max(1, all[1][0] - all[0][0], all[1][1] - all[0][1], all[1][2] - all[0][2]) : 1;
  const mid: V3 = all ? centre(all) : [0, 0, 0];
  const moves = new Map<string, ExplodeMove>();
  if (parts.length < 2) return { moves, stages: 0, order: parts.map((p) => p.id), size };

  // ---- screws, nuts and washers on stacks: which body part they come off, on which side
  interface Hw {
    p: EvalPart;
    st: Stack;
    side: "head" | "tip";
    a: number;
    b: number;
  }
  const hwByStack = new Map<Stack, Hw[]>();
  const hwIds = new Set<string>();
  const stackBodies = new Map<Stack, { p: EvalPart; a: number; b: number }[]>();
  for (const st of holds.stacks) {
    if (!ids.has(st.screw.id) || hwIds.has(st.screw.id)) continue;
    const layers = [...st.layers].filter((l) => ids.has(l.part.id)).sort((x, y) => x.a - y.a);
    const bodies = layers.filter((l) => !isHardware(l.part) && l.part !== st.screw);
    // a host the rays missed (a tapped part past the tip)
    if (st.host && ids.has(st.host.id) && !isHardware(st.host) && !bodies.some((l) => l.part === st.host)) bodies.push({ part: st.host, a: st.length, b: st.length });
    // a profile a T-nut grips: the screw clamps it too, past its tip
    for (const j of holds.joins) if (j.kind === "screw" && j.a === st.screw && ids.has(j.b.id) && !isHardware(j.b) && !bodies.some((l) => l.part === j.b)) bodies.push({ part: j.b, a: st.length, b: st.length });
    if (!bodies.length) continue;
    stackBodies.set(
      st,
      bodies.map((l) => ({ p: l.part, a: l.a, b: l.b })),
    );
    const first = bodies[0].a;
    const hw: Hw[] = [{ p: st.screw, st, side: "head", a: -Infinity, b: st.length }];
    hwIds.add(st.screw.id);
    for (const l of layers) {
      if (!isHardware(l.part) || l.part === st.screw || hwIds.has(l.part.id)) continue;
      hw.push({ p: l.part, st, side: (l.a + l.b) / 2 < first ? "head" : "tip", a: l.a, b: l.b });
      hwIds.add(l.part.id);
    }
    if (st.host && ids.has(st.host.id) && isHardware(st.host) && !hwIds.has(st.host.id)) {
      hw.push({ p: st.host, st, side: "tip", a: st.length - 1, b: st.length });
      hwIds.add(st.host.id);
    }
    hwByStack.set(st, hw);
  }

  // ---- units: parts that come off as one
  const body = parts.filter((p) => !hwIds.has(p.id));
  const root: number[] = body.map((_, i) => i);
  const idx = new Map(body.map((p, i) => [p.id, i]));
  const find = (i: number): number => {
    while (root[i] !== i) i = root[i] = root[root[i]];
    return i;
  };
  const link = (a: EvalPart, b: EvalPart) => {
    const ia = idx.get(a.id);
    const ib = idx.get(b.id);
    if (ia === undefined || ib === undefined) return;
    const ra = find(ia);
    const rb = find(ib);
    if (ra !== rb) root[ra] = rb;
  };
  for (const j of holds.joins) if (j.kind === "bought" || j.kind === "board" || j.kind === "insert") link(j.a, j.b);
  const byInstance = new Map<string, EvalPart>();
  for (const p of body) {
    if (p.kind !== "component") continue;
    const first = byInstance.get(instanceOf(p));
    if (first) link(first, p);
    else byInstance.set(instanceOf(p), p);
  }
  const groups = new Map<number, EvalPart[]>();
  body.forEach((p, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), p]));
  const units: Unit[] = [];
  const unitOf = new Map<string, number>();
  for (const members of groups.values()) {
    let box: Box | null = null;
    for (const m of members) box = union(box, boxes.get(m.id) ?? null);
    const rep = members.reduce((best, m) => (volume(boxes.get(m.id) ?? [mid, mid]) > volume(boxes.get(best.id) ?? [mid, mid]) ? m : best), members[0]);
    const override = rep.explode ?? members.find((m) => m.explode !== undefined)?.explode;
    const u: Unit = { i: units.length, members, rep, box, vol: box ? volume(box) : 0, override };
    units.push(u);
    for (const m of members) unitOf.set(m.id, u.i);
  }

  // ---- what holds what to what
  const edges: Edge[] = [];
  const adj: Edge[][] = units.map(() => []);
  const strong = new Set<string>();
  const pair = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  const addEdge = (e: Edge) => {
    if (e.a === e.b) return;
    edges.push(e);
    adj[e.a].push(e);
    adj[e.b].push(e);
    if (e.kind !== "contact") strong.add(pair(e.a, e.b));
  };
  for (const [st, bodies] of stackBodies) {
    for (let i = 0; i + 1 < bodies.length; i++) {
      const ua = unitOf.get(bodies[i].p.id);
      const ub = unitOf.get(bodies[i + 1].p.id);
      if (ua === undefined || ub === undefined || ua === ub || strong.has(pair(ua, ub))) continue;
      addEdge({ a: ua, b: ub, kind: "stack", axis: st.axis, order: 1, clear: Math.max(0, bodies[i].b - bodies[i + 1].a) });
    }
  }
  for (const f of findFits(model).fits) {
    if (f.kind === "screw" || f.kind === "head") continue;
    for (const inst of f.instances) {
      const uh = unitOf.get(inst.hole.part.id);
      const us = unitOf.get(inst.shaft.part.id);
      if (uh === undefined || us === undefined || uh === us || strong.has(pair(uh, us))) continue;
      // the shaft leaves the hole toward the side it sticks out of
      const s = vdot(vsub(cylMid(inst.shaft), cylMid(inst.hole)), inst.hole.axis);
      addEdge({ a: uh, b: us, kind: "fit", axis: inst.hole.axis, clear: Math.max(0, axialOverlap(inst.hole, inst.shaft)), hole: uh, sign: Math.abs(s) > 0.05 ? Math.sign(s) : 0 });
    }
  }
  const tol = Math.max(0.3, size * 0.002);
  for (let a = 0; a < units.length; a++) {
    const ba = units[a].box;
    if (!ba) continue;
    for (let b = a + 1; b < units.length; b++) {
      const bb = units[b].box;
      if (bb && !strong.has(pair(a, b)) && touch(ba, bb, tol)) addEdge({ a, b, kind: "contact" });
    }
  }

  // ---- a tree from each base: fastened and fitted joins first, then touching
  const strongDeg = units.map((u) => adj[u.i].filter((e) => e.kind !== "contact").length);
  // the base: big, fastened to much, and standing on the floor
  const floor = Math.min(...units.map((u) => u.box?.[0][2] ?? Infinity));
  const onFloor = (u: Unit) => !!u.box && u.box[0][2] <= floor + Math.max(0.5, 0.01 * size);
  const named = (u: Unit) => u.members.some((m) => BASE_NAME.test(m.name));
  const score = (u: Unit) => Math.cbrt(u.vol) * (1 + 0.5 * strongDeg[u.i]) * (onFloor(u) ? 1.5 : 1) * (named(u) ? 3 : 1) * (u.override === undefined ? 1 : 0.5);
  const parent = new Array<number>(units.length).fill(-2);
  const via = new Array<Edge | undefined>(units.length);
  const bfs: number[] = [];
  const roots: number[] = [];
  const unreached = () => units.filter((u) => parent[u.i] === -2);
  while (bfs.length < units.length) {
    const left = unreached();
    const r = left.reduce((best, u) => (score(u) > score(best) ? u : best), left[0]).i;
    parent[r] = -1;
    roots.push(r);
    bfs.push(r);
    const queue = [r];
    for (;;) {
      while (queue.length) {
        const u = queue.shift()!;
        for (const e of adj[u]) {
          if (e.kind === "contact") continue;
          const v = e.a === u ? e.b : e.a;
          if (parent[v] !== -2) continue;
          parent[v] = u;
          via[v] = e;
          bfs.push(v);
          queue.push(v);
        }
      }
      // then a part only touching: onto the biggest placed part it sits against, or, when it sits inside
      // the boxes of the parts it touches (a connector inside an enclosure, on its board), the smallest of those
      const cands = new Map<number, { u: number; e: Edge }[]>();
      for (const e of edges) {
        if (e.kind !== "contact") continue;
        const [u, v] = parent[e.a] !== -2 && parent[e.b] === -2 ? [e.a, e.b] : parent[e.b] !== -2 && parent[e.a] === -2 ? [e.b, e.a] : [-1, -1];
        if (u >= 0) cands.set(v, [...(cands.get(v) ?? []), { u, e }]);
      }
      let pick: { v: number; u: number; e: Edge } | null = null;
      for (const [v, list] of cands) {
        const inside = (u: number) => insideShare(units[v].box, units[u].box) > 0.9;
        const outer = list.filter((c) => !inside(c.u));
        const best = outer.length ? outer.reduce((b, c) => (units[c.u].vol > units[b.u].vol ? c : b)) : list.reduce((b, c) => (units[c.u].vol < units[b.u].vol ? c : b));
        if (!pick || units[best.u].vol > units[pick.u].vol || (best.u === pick.u && units[v].vol > units[pick.v].vol)) pick = { v, u: best.u, e: best.e };
      }
      if (!pick) break;
      parent[pick.v] = pick.u;
      via[pick.v] = pick.e;
      bfs.push(pick.v);
      queue.push(pick.v);
    }
  }

  // ---- which way and how far each unit comes off what it sits on
  const gapFor = (ext: number) => Math.max(3, 0.1 * size + 0.35 * Math.min(ext, 0.5 * size));
  const off: V3[] = units.map(() => [0, 0, 0]);
  const unitMove: { dir: V3; dist: number; via: ExplodeVia }[] = units.map(() => ({ dir: UP, dist: 0, via: "base" as ExplodeVia }));
  const placed: number[] = [];
  const descends = (x: number, w: number) => {
    for (let q = parent[x]; q >= 0; q = parent[q]) if (q === w) return true;
    return false;
  };
  // how far the screws backed out of a part stand off it, so what comes off after keeps clear of them too
  const screwReach = new Map<number, { out: V3; r: number }>();
  for (const [st, bodies] of stackBodies) {
    const u = unitOf.get(bodies[0].p.id);
    if (u === undefined) continue;
    const r = Math.max(2.5, 0.06 * size, 0.6 * st.length) + st.length + headHeight(st);
    const was = screwReach.get(u);
    if (!was || r > was.r) screwReach.set(u, { out: neg(st.axis), r });
  }
  const withScrews = (u: number, b: Box): Box => {
    const sr = screwReach.get(u);
    const k = sr ? sr.out.findIndex((x) => Math.abs(x) > 0.99) : -1;
    if (!sr || k < 0) return b;
    const out: Box = [[...b[0]], [...b[1]]];
    if (sr.out[k] > 0) out[1][k] += sr.r;
    else out[0][k] -= sr.r;
    return out;
  };
  const rootOf = (v: number) => {
    while (parent[v] >= 0) v = parent[v];
    return v;
  };
  /** whether a part inside another runs into that one's walls going this way (needs meshes) */
  const walled = (u: Unit, d: V3, around: number[]) => {
    if (!mesh || !u.box) return false;
    const conts = [...new Set(around)].filter((c) => c !== u.i && units[c].box && insideShare(u.box, units[c].box) > 0.5);
    return conts.length > 0 && blocked(u.box, d, conts.flatMap((c) => units[c].members), mesh);
  };
  for (const v of bfs) {
    const u = units[v];
    const p = parent[v];
    const bv = u.box;
    if (p === -1) {
      // a second base: apart from the first, away from the middle
      if (roots[0] !== v) {
        const c = vsub(bv ? centre(bv) : applyXforms([0, 0, 0], u.rep.xf), mid);
        const n = Math.hypot(...c);
        unitMove[v] = { dir: n > 1e-6 ? vnorm(c) : UP, dist: gapFor(0), via: "free" };
      }
    } else {
      const e = via[v]!;
      const bp = units[p].box;
      let dir: V3 = UP;
      let clear = 0;
      let how: ExplodeVia = e.kind;
      let alongWith = false;
      const loose = u.members.length === 1 && u.rep.libKind === "screw" ? u.rep.fastener?.outward : undefined;
      if (u.override || loose) {
        // its own direction, or a screw on no stack backing out of its head's way
        dir = vnorm(u.override || loose!);
        clear = bv && bp ? Math.max(0, along(bp, dir)[1] - along(bv, dir)[0]) : 0;
        if (loose && !u.override) how = "screw";
      } else if (e.kind === "stack") {
        // b sits past a along the axis
        dir = v === e.b ? e.axis! : neg(e.axis!);
        clear = e.clear ?? 0;
      } else if (e.kind === "fit") {
        // away from what it sits on (a gear off the end of a motor's shaft); when that is level, the shaft
        // leaves the hole on the side it sticks out of and the hole part the other way
        const towardChild = bv && bp ? vdot(vsub(centre(bv), centre(bp)), e.axis!) : 0;
        const s = Math.abs(towardChild) > 0.02 * size ? Math.sign(towardChild) : e.sign ? (v === e.hole ? -e.sign : e.sign) : Math.sign(towardChild) || 1;
        dir = s > 0 ? e.axis! : neg(e.axis!);
        clear = e.clear ?? 0;
        // inside a case: out of its open side (a gear out of the back of a gearbox, not through its front wall)
        if (walled(u, dir, [p, rootOf(p)]) && !walled(u, neg(dir), [p, rootOf(p)])) dir = neg(dir);
      } else if (bv && bp && insideShare(bv, bp) > 0.5 && unitMove[p].dist > 0) {
        // a part among another's that comes off (a connector on a board in its case) goes with it, a little ahead
        dir = unitMove[p].dir;
        alongWith = true;
      } else if (bv && bp) {
        // the way out that frees it soonest, up when that is about as good, never back through what it sits on
        const c = vsub(centre(bv), centre(bp));
        let best = Infinity;
        for (const d of AXES) {
          const travel = Math.max(0, along(bp, d)[1] - along(bv, d)[0]);
          const cost = travel - (d[2] > 0.5 ? 0.04 * size : 0) + (vdot(c, d) < -1e-6 ? size : 0) + (walled(u, d, [p, rootOf(p)]) ? 2 * size : 0);
          if (cost < best) {
            best = cost;
            dir = d;
            clear = travel;
          }
        }
      }
      // a part inside what it sits on (a board in its case) comes all the way out of it
      if (bv && bp && !alongWith && insideShare(bv, bp) > 0.5) clear = Math.max(clear, along(bp, dir)[1] - along(bv, dir)[0]);
      let dist = u.override === false ? 0 : alongWith ? 0.5 * gapFor(0) : clear + gapFor(bv ? along(bv, dir)[1] - along(bv, dir)[0] : 0);
      if (u.override === false) how = "rigid";
      const o0 = off[p];
      // keep clear of what has already come off along the way: push on past it
      if (bv && dist > 0) {
        for (let pass = 0; pass < 3; pass++) {
          const o: V3 = [o0[0] + dir[0] * dist, o0[1] + dir[1] * dist, o0[2] + dir[2] * dist];
          const mine = withScrews(v, shifted(bv, o));
          let push = 0;
          for (const w of placed) {
            if (w === p || !units[w].box) continue;
            const bw = units[w].box!;
            // parts that overlap where they are drawn (one inside the other) are left to the tree
            if (touch(bv, bw, -tol)) continue;
            const theirs = withScrews(w, shifted(bw, off[w]));
            if (!touch(mine, theirs, -tol)) continue;
            // a part that was in front of this one going the same way (a lid over a board) goes on further instead
            const wm = unitMove[w];
            if (wm.dist > 0 && vdot(wm.dir, dir) > 0.9 && along(bw, dir)[0] >= along(bv, dir)[1] - tol) {
              const d = along(mine, dir)[1] - along(theirs, dir)[0] + 0.5 * gapFor(0);
              if (d > 0 && d < 2 * size) {
                wm.dist += d;
                for (const x of placed) if (x === w || descends(x, w)) off[x] = [off[x][0] + wm.dir[0] * d, off[x][1] + wm.dir[1] * d, off[x][2] + wm.dir[2] * d];
              }
              continue;
            }
            push = Math.max(push, along(theirs, dir)[1] - along(mine, dir)[0] + 0.5 * gapFor(0));
          }
          if (push <= 0 || push > 2 * size) break;
          dist += push;
        }
      }
      unitMove[v] = { dir, dist, via: how };
      off[v] = [o0[0] + dir[0] * dist, o0[1] + dir[1] * dist, o0[2] + dir[2] * dist];
    }
    placed.push(v);
  }

  // ---- hardware: off its stack, the screw and head washers outward from the head, nuts and washers past the tip
  interface HwMove {
    p: EvalPart;
    unit: number;
    dir: V3;
    dist: number;
    via: ExplodeVia;
    /** the stack's units, so assembly puts it in once all of them are on */
    stackUnits: number[];
    rank: number;
  }
  const hwMoves: HwMove[] = [];
  for (const [st, hw] of hwByStack) {
    const bodies = stackBodies.get(st)!;
    const stackUnits = [...new Set(bodies.map((b) => unitOf.get(b.p.id)!).filter((u) => u !== undefined))];
    const headU = unitOf.get(bodies[0].p.id)!;
    const tipU = unitOf.get(bodies[bodies.length - 1].p.id)!;
    const gap = Math.max(2.5, 0.06 * size, 0.6 * st.length);
    const out = neg(st.axis);
    // head side, nearest the part first: each clear of the last (s runs from the seat toward the tip)
    const head = hw.filter((h) => h.side === "head").sort((x, y) => (x.p === st.screw ? 1 : y.p === st.screw ? -1 : y.a - x.a));
    let cursor = -bodies[0].a;
    head.forEach((h, k) => {
      // outward coordinate t = -s: the screw spans from its tip (-length) to its head
      const lo = h.p === st.screw ? -st.length : -h.b;
      const hi = h.p === st.screw ? headHeight(st) : -h.a;
      const shift = Math.max(0, cursor + gap * (h.p === st.screw ? 1 : 0.5) - lo);
      cursor = hi + shift;
      const o = h.p.explode;
      hwMoves.push({ p: h.p, unit: headU, dir: o ? vnorm(o) : out, dist: o === false ? 0 : shift, via: h.p === st.screw ? (st.set ? "set" : "screw") : "washer", stackUnits, rank: k });
    });
    const tip = hw.filter((h) => h.side === "tip").sort((x, y) => x.a - y.a);
    cursor = bodies[bodies.length - 1].b;
    tip.forEach((h, k) => {
      // a T-nut stays in its slot
      const stay = isTnut(h.p) || h.p.explode === false;
      const shift = stay ? 0 : Math.max(0, cursor + gap * 0.6 - h.a);
      cursor = h.b + shift;
      const o = h.p.explode;
      hwMoves.push({ p: h.p, unit: tipU, dir: o ? vnorm(o) : st.axis, dist: shift, via: h.p.libKind === "washer" ? "washer" : "nut", stackUnits, rank: head.length + k });
    });
  }

  // ---- steps: a part comes off after everything on it (fasteners first)
  const height = new Array<number>(units.length).fill(0);
  // a part on a stack comes off once its screw is out
  const hasHw = new Set(hwMoves.filter((h) => h.dist > 0).flatMap((h) => h.stackUnits));
  for (let k = bfs.length - 1; k >= 0; k--) {
    const v = bfs[k];
    if (hasHw.has(v)) height[v] = Math.max(height[v], 1);
    const p = parent[v];
    if (p >= 0) height[p] = Math.max(height[p], height[v] + (unitMove[v].dist > 0 ? 1 : 0));
  }
  let stages = 0;
  const add = (m: ExplodeMove) => {
    moves.set(m.id, m);
    if (m.dist > 0) stages = Math.max(stages, m.stage + 1);
  };
  for (const v of bfs) {
    const u = units[v];
    const p = parent[v];
    const mv = unitMove[v];
    add({ id: u.rep.id, from: p >= 0 ? units[p].rep.id : undefined, dir: mv.dir, dist: mv.dist, stage: height[v], via: mv.via });
    for (const m of u.members) if (m !== u.rep) add({ id: m.id, from: u.rep.id, dir: mv.dir, dist: 0, stage: height[v], via: "rigid" });
  }
  for (const h of hwMoves) add({ id: h.p.id, from: units[h.unit].rep.id, dir: h.dir, dist: h.dist, stage: 0, via: h.via });

  // ---- assembly order: depth first from each base, bigger subassemblies first; hardware once its whole stack is on
  const children = units.map(() => [] as number[]);
  for (const v of bfs) if (parent[v] >= 0) children[parent[v]].push(v);
  for (const c of children) c.sort((x, y) => height[y] - height[x] || units[y].vol - units[x].vol);
  const pos = new Array<number>(units.length).fill(0);
  const unitOrder: number[] = [];
  const visit = (v: number) => {
    pos[v] = unitOrder.length;
    unitOrder.push(v);
    for (const c of children[v]) visit(c);
  };
  for (const r of roots) visit(r);
  const hwAfter = new Map<number, HwMove[]>();
  for (const h of hwMoves) {
    const last = h.stackUnits.reduce((b, u) => (pos[u] > pos[b] ? u : b), h.stackUnits[0] ?? h.unit);
    hwAfter.set(last, [...(hwAfter.get(last) ?? []), h]);
  }
  const order: string[] = [];
  for (const v of unitOrder) {
    order.push(units[v].rep.id, ...units[v].members.filter((m) => m !== units[v].rep).map((m) => m.id));
    for (const h of (hwAfter.get(v) ?? []).sort((x, y) => x.rank - y.rank)) order.push(h.p.id);
  }
  return { moves, stages, order, size };
}

const bvhs = new WeakMap<object, TriBVH>();
/**
 * Whether a box going along d runs into the walls of these parts: rays from its middle and round it, out to where
 * it leaves their boxes, most of them meeting a wall.
 */
function blocked(b: Box, d: V3, walls: EvalPart[], mesh: MeshLookup): boolean {
  const c = centre(b);
  const { u, v } = frameFor(d);
  const eu = 0.3 * (along(b, u)[1] - along(b, u)[0]);
  const ev = 0.3 * (along(b, v)[1] - along(b, v)[0]);
  const from: V3[] = [c, [c[0] + u[0] * eu, c[1] + u[1] * eu, c[2] + u[2] * eu], [c[0] - u[0] * eu, c[1] - u[1] * eu, c[2] - u[2] * eu], [c[0] + v[0] * ev, c[1] + v[1] * ev, c[2] + v[2] * ev], [c[0] - v[0] * ev, c[1] - v[1] * ev, c[2] - v[2] * ev]];
  let hits = 0;
  let tried = 0;
  for (const o of from) {
    let hit = false;
    for (const w of walls) {
      const m = mesh(w.hash);
      if (!m || !m.positions.length) continue;
      let bvh = bvhs.get(m);
      if (!bvh) bvhs.set(m, (bvh = new TriBVH(m.positions, m.indices)));
      // into the part's own frame: placements are rotations, mirrors and moves, so the inverse is the transpose
      const M = xformMatrix(w.xf);
      const x = o[0] - M[12];
      const y = o[1] - M[13];
      const z = o[2] - M[14];
      const lo: V3 = [M[0] * x + M[1] * y + M[2] * z, M[4] * x + M[5] * y + M[6] * z, M[8] * x + M[9] * y + M[10] * z];
      const ld: V3 = [M[0] * d[0] + M[1] * d[1] + M[2] * d[2], M[4] * d[0] + M[5] * d[1] + M[6] * d[2], M[8] * d[0] + M[9] * d[1] + M[10] * d[2]];
      tried++;
      if (bvh.raycast(lo[0], lo[1], lo[2], ld[0], ld[1], ld[2], 0, 1e6, -1, true)) hit = true;
    }
    if (hit) hits++;
  }
  return tried > 0 && hits >= 3;
}

/** How far a screw's head stands above its seat, mm. */
function headHeight(st: Stack): number {
  const f = st.screw.fastener;
  if (!f) return 0.6 * st.d;
  return Math.max(0, -vdot(vsub(f.headTop, st.seat), st.axis));
}

/** How far along its own move a part with this step is at an explode amount, stepping through the plan in order (0 to 1). */
export function stepProgress(stage: number, stages: number, f: number): number {
  if (f <= 0) return 0;
  if (f >= 1 || stages <= 1) return Math.min(1, Math.max(0, f));
  const lap = 0.4;
  const w = 1 / (stages - (stages - 1) * lap);
  const t = Math.min(1, Math.max(0, (f - stage * w * (1 - lap)) / w));
  return t * t * (3 - 2 * t);
}

/**
 * Every part's offset from where it is drawn. `progress` gives each part's own share of its move (0 home, 1 all
 * the way); by default the plan is played in order at explode amount `f`. Parts carry what comes off them.
 */
export function explodeOffsets(plan: ExplodePlan, f: number, progress?: (m: ExplodeMove) => number): Map<string, V3> {
  const out = new Map<string, V3>();
  const share = progress ?? ((m: ExplodeMove) => stepProgress(m.stage, plan.stages, f));
  for (const m of plan.moves.values()) {
    const base = (m.from && out.get(m.from)) || [0, 0, 0];
    const k = m.dist > 0 ? m.dist * share(m) : 0;
    out.set(m.id, [base[0] + m.dir[0] * k, base[1] + m.dir[1] * k, base[2] + m.dir[2] * k]);
  }
  return out;
}

/** Offsets for a drawing's exploded view: every part all the way out, scaled by its spread (1 the usual, 2 twice as far). */
export function spreadOffsets(plan: ExplodePlan, spread: number): Map<string, V3> {
  return explodeOffsets(plan, 1, () => spread);
}
