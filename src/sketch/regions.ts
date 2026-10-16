// Closed profiles from solved sketch geometry. Non-construction curves are
// joined end to end into loops; loops nested inside others become holes
// (even-odd by depth). Open ends, branches and crossings are reported with
// the names of the geometry involved so the editor can point at them.

import type { ProfileRegion, Seg2, V2 } from "../kernel/recipe";

export interface ProfileLine {
  id: string;
  a: string;
  b: string;
}
export interface ProfileArc {
  id: string;
  c: string;
  a: string;
  b: string;
}
export interface ProfileCircle {
  id: string;
  c: string;
  r: number;
}

export interface Loop {
  segs: Seg2[];
  curves: string[];
  /** signed area, positive when counter-clockwise */
  area: number;
  /** polyline approximation, for containment tests and display */
  poly: V2[];
}

/** A rounded (fillet) or cut (chamfer) corner where two profile lines meet. */
export interface CornerSpec {
  at: string;
  r: number;
  kind: "fillet" | "chamfer";
  /** the statement it came from */
  src: number;
}

export interface Profile {
  regions: ProfileRegion[];
  /** loops as polygons, outer boundaries first, for display */
  fills: { outer: V2[]; holes: V2[][] }[];
  area: number;
  loops: number;
  error?: { message: string; refs: string[] };
  /** curves left out because they do not belong to a closed loop (only when other loops are closed) */
  open?: { message: string; refs: string[] };
  /** corners that were rounded or cut, for display */
  corners: { src: number; at: string; seg: Seg2 }[];
  /** corner statements that could not be applied */
  cornerIssues: { src: number; message: string }[];
}

const EPS = 1e-5;

export function buildProfile(points: Record<string, V2>, lines: ProfileLine[], arcs: ProfileArc[], circles: ProfileCircle[], cornerSpecs: CornerSpec[] = []): Profile {
  const empty: Profile = { regions: [], fills: [], area: 0, loops: 0, corners: [], cornerIssues: [] };
  // merge points that sit on top of each other into one node
  const ids = Object.keys(points);
  const node = new Map<string, string>();
  for (const id of ids) {
    if (node.has(id)) continue;
    node.set(id, id);
  }
  const used = new Set<string>();
  for (const l of lines) used.add(l.a).add(l.b);
  for (const a of arcs) used.add(a.a).add(a.b);
  const usedList = [...used];
  for (let i = 0; i < usedList.length; i++) {
    for (let j = 0; j < i; j++) {
      const p = points[usedList[i]];
      const q = points[usedList[j]];
      if (Math.abs(p[0] - q[0]) < EPS && Math.abs(p[1] - q[1]) < EPS) {
        node.set(usedList[i], node.get(usedList[j])!);
        break;
      }
    }
  }
  const N = (id: string) => node.get(id) ?? id;

  interface Edge {
    id: string;
    a: string;
    b: string;
    arc?: ProfileArc;
  }
  const edges: Edge[] = [];
  for (const l of lines) {
    if (N(l.a) === N(l.b)) return { ...empty, error: { message: `Line ${l.id} has zero length`, refs: [l.id] } };
    edges.push({ id: l.id, a: N(l.a), b: N(l.b) });
  }
  for (const a of arcs) {
    if (N(a.a) === N(a.b)) return { ...empty, error: { message: `Arc ${a.id} starts and ends at the same point; use a circle for a full round`, refs: [a.id] } };
    edges.push({ id: a.id, a: N(a.a), b: N(a.b), arc: a });
  }
  let at = new Map<string, Edge[]>();
  const link = () => {
    at = new Map();
    for (const e of edges) {
      at.set(e.a, [...(at.get(e.a) ?? []), e]);
      at.set(e.b, [...(at.get(e.b) ?? []), e]);
    }
  };
  link();
  // curves with a loose end are not part of any loop: leave them out when something else closes
  const firstOpen = [...at].find(([, list]) => list.length === 1);
  const openIds: string[] = [];
  for (let dangling = firstOpen; dangling; ) {
    const e = dangling[1][0];
    openIds.push(e.id);
    edges.splice(edges.indexOf(e), 1);
    link();
    dangling = [...at].find(([, list]) => list.length === 1);
  }
  let open: Profile["open"];
  if (firstOpen) {
    const [n, list] = firstOpen;
    const msg = `The profile is open at ${n}: only ${list[0].id} ends there. Close the loop, or make the curve construction geometry.`;
    if (!edges.length && !circles.length) return { ...empty, error: { message: msg, refs: [n, list[0].id] } };
    open = { message: `${openIds.join(", ")} ${openIds.length > 1 ? "are" : "is"} not part of a closed loop and ${openIds.length > 1 ? "are" : "is"} left out of the profile.`, refs: openIds };
  }
  for (const [n, list] of at) {
    if (list.length > 2)
      return { ...empty, error: { message: `${list.length} curves meet at ${n} (${list.map((e) => e.id).join(", ")}). A profile needs simple loops; make the extra curves construction geometry.`, refs: [n, ...list.map((e) => e.id)] } };
  }

  // walk the loops
  const loops: Loop[] = [];
  const seen = new Set<string>();
  const corners: Profile["corners"] = [];
  const cornerIssues: Profile["cornerIssues"] = [];
  const pending = new Map<string, CornerSpec>();
  for (const c of cornerSpecs) {
    const n = N(c.at);
    if (pending.has(n)) cornerIssues.push({ src: c.src, message: `The corner at ${c.at} is already rounded by an earlier statement` });
    else pending.set(n, c);
  }
  for (const e0 of edges) {
    if (seen.has(e0.id)) continue;
    const segs: Seg2[] = [];
    const curves: string[] = [];
    const starts: string[] = [];
    const start = e0.a;
    let cur = e0;
    let from = e0.a;
    for (let guard = 0; guard <= edges.length; guard++) {
      seen.add(cur.id);
      curves.push(cur.id);
      starts.push(from);
      const to = cur.a === from ? cur.b : cur.a;
      const pa = pos(points, from, node);
      const pb = pos(points, to, node);
      if (cur.arc) {
        const c = points[cur.arc.c];
        const fwd = from === N(cur.arc.a);
        segs.push(arcSeg(c, pa, pb, fwd));
      } else segs.push({ k: "l", a: pa, b: pb });
      if (to === start) break;
      const next = at.get(to)!.find((x) => x !== cur && !seen.has(x.id));
      if (!next) break;
      from = to;
      cur = next;
    }
    const rounded = applyCorners(segs, curves, starts, pending, corners, cornerIssues);
    if ("error" in rounded) return { ...empty, cornerIssues, error: rounded.error };
    loops.push(makeLoop(rounded.segs, rounded.curves));
  }
  for (const c of pending.values()) cornerIssues.push({ src: c.src, message: `There is no profile corner at ${c.at} to ${c.kind === "fillet" ? "round" : "chamfer"}` });
  for (const c of circles) {
    if (!(c.r > 1e-9)) return { ...empty, error: { message: `Circle ${c.id} has no size`, refs: [c.id] } };
    loops.push(makeLoop([{ k: "c", c: points[c.c], r: c.r }], [c.id]));
  }
  if (!loops.length) return empty;

  // crossings
  for (let i = 0; i < loops.length; i++) {
    const self = selfCrossing(loops[i]);
    if (self) return { ...empty, loops: loops.length, error: { message: `The loop through ${loops[i].curves.join(", ")} crosses itself near ${fmt(self)}`, refs: loops[i].curves } };
    for (let j = 0; j < i; j++) {
      const hit = loopsCross(loops[i], loops[j]);
      if (hit) {
        const a = nearestCurve(loops[i], hit);
        const b = nearestCurve(loops[j], hit);
        return { ...empty, loops: loops.length, error: { message: `${a} crosses ${b} near ${fmt(hit)}. Profiles can sit inside each other but must not overlap.`, refs: [a, b] } };
      }
    }
  }

  // nesting: depth = number of loops around a loop
  const parent: number[] = loops.map(() => -1);
  const depth: number[] = loops.map(() => 0);
  loops.forEach((L, i) => {
    let best = -1;
    loops.forEach((M, j) => {
      if (i === j || Math.abs(M.area) <= Math.abs(L.area)) return;
      if (inside(L.poly[0], M.poly)) {
        depth[i]++;
        if (best < 0 || Math.abs(M.area) < Math.abs(loops[best].area)) best = j;
      }
    });
    parent[i] = best;
  });
  const regions: ProfileRegion[] = [];
  const fills: Profile["fills"] = [];
  let area = 0;
  loops.forEach((L, i) => {
    if (depth[i] % 2) return;
    const holes = loops.filter((_, j) => parent[j] === i && depth[j] === depth[i] + 1);
    const outer = L.area < 0 ? reverseLoop(L) : L;
    const hs = holes.map((h) => (h.area > 0 ? reverseLoop(h) : h));
    regions.push({ outer: outer.segs, holes: hs.map((h) => h.segs) });
    fills.push({ outer: outer.poly, holes: hs.map((h) => h.poly) });
    area += Math.abs(L.area) - holes.reduce((s, h) => s + Math.abs(h.area), 0);
  });
  return { regions, fills, area, loops: loops.length, corners, cornerIssues, open };
}

/** Round or cut the corners of one loop. Consumes the specs it uses from `pending`. */
function applyCorners(
  segs: Seg2[],
  curves: string[],
  starts: string[],
  pending: Map<string, CornerSpec>,
  out: Profile["corners"],
  issues: Profile["cornerIssues"],
): { segs: Seg2[]; curves: string[] } | { error: { message: string; refs: string[] } } {
  const n = segs.length;
  const work = segs.map((s) => (s.k === "l" ? { k: "l" as const, a: [...s.a] as V2, b: [...s.b] as V2 } : s));
  const insertAfter = new Map<number, { seg: Seg2; id: string }>();
  for (let i = 0; i < n; i++) {
    const spec = pending.get(starts[i]);
    if (!spec) continue;
    pending.delete(starts[i]);
    const prevI = (i - 1 + n) % n;
    const prev = work[prevI];
    const next = work[i];
    if (prev.k !== "l" || next.k !== "l" || prevI === i) {
      issues.push({ src: spec.src, message: `${spec.kind === "fillet" ? "Fillets" : "Chamfers"} join two lines; the corner at ${spec.at} joins ${curves[prevI]} and ${curves[i]}` });
      continue;
    }
    const P = next.a;
    const u1 = unit([prev.a[0] - P[0], prev.a[1] - P[1]]);
    const u2 = unit([next.b[0] - P[0], next.b[1] - P[1]]);
    const cos = Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]));
    const theta = Math.acos(cos);
    if (theta > Math.PI - 1e-6) {
      issues.push({ src: spec.src, message: `${curves[prevI]} and ${curves[i]} are in line at ${spec.at}; there is no corner to ${spec.kind === "fillet" ? "round" : "chamfer"}` });
      continue;
    }
    const t = spec.kind === "fillet" ? spec.r / Math.tan(theta / 2) : spec.r;
    const T1: V2 = [P[0] + u1[0] * t, P[1] + u1[1] * t];
    const T2: V2 = [P[0] + u2[0] * t, P[1] + u2[1] * t];
    prev.b = T1;
    next.a = T2;
    let seg: Seg2;
    if (spec.kind === "fillet") {
      const bis = unit([u1[0] + u2[0], u1[1] + u2[1]]);
      const dc = spec.r / Math.sin(theta / 2);
      seg = { k: "a", a: T1, b: T2, m: [P[0] + bis[0] * (dc - spec.r), P[1] + bis[1] * (dc - spec.r)] };
    } else seg = { k: "l", a: T1, b: T2 };
    insertAfter.set(prevI, { seg, id: `${spec.kind}@${spec.at}` });
    out.push({ src: spec.src, at: spec.at, seg });
  }
  // a line shortened from both ends must keep some length, pointing the same way
  for (let i = 0; i < n; i++) {
    const w = work[i];
    const o = segs[i];
    if (w.k !== "l" || o.k !== "l") continue;
    const dot = (w.b[0] - w.a[0]) * (o.b[0] - o.a[0]) + (w.b[1] - w.a[1]) * (o.b[1] - o.a[1]);
    if (dot < 1e-9) {
      const len = Math.hypot(o.b[0] - o.a[0], o.b[1] - o.a[1]);
      return { error: { message: `The rounded corners on ${curves[i]} need more than its ${fmtLen(len)} mm. Use a smaller radius or a longer line.`, refs: [curves[i]] } };
    }
  }
  const outSegs: Seg2[] = [];
  const outCurves: string[] = [];
  for (let i = 0; i < n; i++) {
    outSegs.push(work[i]);
    outCurves.push(curves[i]);
    const ins = insertAfter.get(i);
    if (ins) {
      outSegs.push(ins.seg);
      outCurves.push(ins.id);
    }
  }
  return { segs: outSegs, curves: outCurves };
}

const unit = (v: V2): V2 => {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
};
const fmtLen = (x: number) => String(Math.round(x * 100) / 100);

function pos(points: Record<string, V2>, nodeId: string, node: Map<string, string>): V2 {
  // the node id is one of the merged point ids; every member shares its position
  const p = points[nodeId];
  if (p) return [p[0], p[1]];
  for (const [id, n] of node) if (n === nodeId) return [points[id][0], points[id][1]];
  return [0, 0];
}

/** An arc segment traversed from a to b; fwd means counter-clockwise (the arc's own direction). */
function arcSeg(c: V2, a: V2, b: V2, fwd: boolean): Seg2 {
  const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const t0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
  const t1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
  // counter-clockwise sweep of the arc itself (from its start to its end)
  const ccwFrom = fwd ? t0 : t1;
  const ccwTo = fwd ? t1 : t0;
  let sweep = ccwTo - ccwFrom;
  while (sweep <= 0) sweep += 2 * Math.PI;
  const tm = ccwFrom + sweep / 2;
  return { k: "a", a, b, m: [c[0] + r * Math.cos(tm), c[1] + r * Math.sin(tm)] };
}

/** Centre, radius and signed sweep of an arc segment as traversed. */
export function arcGeometry(s: Extract<Seg2, { k: "a" }>) {
  const [ax, ay] = s.a;
  const [bx, by] = s.b;
  const [mx, my] = s.m;
  const d = 2 * (ax * (my - by) + mx * (by - ay) + bx * (ay - my));
  const a2 = ax * ax + ay * ay;
  const m2 = mx * mx + my * my;
  const b2 = bx * bx + by * by;
  const cx = (a2 * (my - by) + m2 * (by - ay) + b2 * (ay - my)) / d;
  const cy = (a2 * (bx - mx) + m2 * (ax - bx) + b2 * (mx - ax)) / d;
  const r = Math.hypot(ax - cx, ay - cy);
  const t0 = Math.atan2(ay - cy, ax - cx);
  const tm = Math.atan2(my - cy, mx - cx);
  const t1 = Math.atan2(by - cy, bx - cx);
  // counter-clockwise if going t0 → tm → t1 increases the angle
  const ccw = norm(tm - t0) < norm(t1 - t0);
  const sweep = ccw ? norm(t1 - t0) : -norm(t0 - t1);
  return { c: [cx, cy] as V2, r, t0, sweep };
}
const norm = (a: number) => {
  let x = a % (2 * Math.PI);
  if (x < 0) x += 2 * Math.PI;
  return x;
};

/** Points along a segment, excluding its end point. */
export function sampleSeg(s: Seg2, stepDeg = 3): V2[] {
  if (s.k === "l") return [s.a];
  if (s.k === "c") {
    const n = 120;
    return Array.from({ length: n }, (_, i) => [s.c[0] + s.r * Math.cos((2 * Math.PI * i) / n), s.c[1] + s.r * Math.sin((2 * Math.PI * i) / n)] as V2);
  }
  const g = arcGeometry(s);
  const n = Math.max(4, Math.ceil(Math.abs(g.sweep) / ((stepDeg * Math.PI) / 180)));
  return Array.from({ length: n }, (_, i) => {
    const t = g.t0 + (g.sweep * i) / n;
    return [g.c[0] + g.r * Math.cos(t), g.c[1] + g.r * Math.sin(t)] as V2;
  });
}

function makeLoop(segs: Seg2[], curves: string[]): Loop {
  const poly = segs.flatMap((s) => sampleSeg(s));
  let area = 0;
  for (const s of segs) {
    if (s.k === "l") area += (s.a[0] * s.b[1] - s.b[0] * s.a[1]) / 2;
    else if (s.k === "c") area += Math.PI * s.r * s.r;
    else {
      const g = arcGeometry(s);
      const t1 = g.t0 + g.sweep;
      area += 0.5 * (g.r * g.r * g.sweep + g.r * (g.c[0] * (Math.sin(t1) - Math.sin(g.t0)) - g.c[1] * (Math.cos(t1) - Math.cos(g.t0))));
    }
  }
  return { segs, curves, area, poly };
}

function reverseLoop(L: Loop): Loop {
  const segs: Seg2[] = [...L.segs].reverse().map((s) => (s.k === "l" ? { k: "l", a: s.b, b: s.a } : s.k === "a" ? { k: "a", a: s.b, b: s.a, m: s.m } : { k: "c", c: s.c, r: s.r }));
  // a full circle has no direction in its recipe; its polygon is reversed for consistency
  return { segs, curves: [...L.curves].reverse(), area: -L.area, poly: [...L.poly].reverse() };
}

function inside(p: V2, poly: V2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function segCross(a: V2, b: V2, c: V2, d: V2): V2 | null {
  const r0 = b[0] - a[0];
  const r1 = b[1] - a[1];
  const s0 = d[0] - c[0];
  const s1 = d[1] - c[1];
  const den = r0 * s1 - r1 * s0;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * s1 - (c[1] - a[1]) * s0) / den;
  const u = ((c[0] - a[0]) * r1 - (c[1] - a[1]) * r0) / den;
  const e = 1e-9;
  if (t > e && t < 1 - e && u > e && u < 1 - e) return [a[0] + t * r0, a[1] + t * r1];
  return null;
}

function bbox(poly: V2[]) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of poly) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1 };
}

function selfCrossing(L: Loop): V2 | null {
  const P = L.poly;
  const n = P.length;
  if (n < 4) return null;
  for (let i = 0; i < n; i++) {
    const a = P[i];
    const b = P[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const hit = segCross(a, b, P[j], P[(j + 1) % n]);
      if (hit) return hit;
    }
  }
  return null;
}

function loopsCross(A: Loop, B: Loop): V2 | null {
  const ba = bbox(A.poly);
  const bb = bbox(B.poly);
  if (ba.x1 < bb.x0 || bb.x1 < ba.x0 || ba.y1 < bb.y0 || bb.y1 < ba.y0) return null;
  const P = A.poly;
  const Q = B.poly;
  for (let i = 0; i < P.length; i++) {
    const a = P[i];
    const b = P[(i + 1) % P.length];
    for (let j = 0; j < Q.length; j++) {
      const hit = segCross(a, b, Q[j], Q[(j + 1) % Q.length]);
      if (hit) return hit;
    }
  }
  return null;
}

function nearestCurve(L: Loop, p: V2): string {
  let best = L.curves[0];
  let bestD = Infinity;
  L.segs.forEach((s, i) => {
    const pts = [...sampleSeg(s), s.k === "c" ? sampleSeg(s)[0] : s.b];
    for (let k = 0; k + 1 < pts.length; k++) {
      const d = distToSeg(p, pts[k], pts[k + 1]);
      if (d < bestD) {
        bestD = d;
        best = L.curves[i];
      }
    }
  });
  return best;
}

export function distToSeg(p: V2, a: V2, b: V2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

const fmt = (p: V2) => `(${Math.round(p[0] * 100) / 100}, ${Math.round(p[1] * 100) / 100})`;
