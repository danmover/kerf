// DXF drawings as sketch text: the curves a drawing holds become sketch
// lines, arcs, circles, splines, ellipses and points, joined where they
// meet (small gaps between loose ends are closed), written loop by loop in
// the order they run, and fixed where they were drawn so the outline is
// exact and fully defined. Deleting the fix lines frees the geometry to drag
// and dimension like anything drawn by hand.

import type { V2 } from "../kernel/recipe";
import { DxfError, type DxfCurve, type DxfDrawing } from "./dxfRead";
import { fmt, fmtPt, nextName } from "./edits";

/** More curves than this is too many to edit as a sketch. */
export const MAX_DXF_CURVES = 3000;

export interface DxfStatements {
  geometry: string[];
  constraints: string[];
  counts: { lines: number; arcs: number; circles: number; splines: number; ellipses: number; points: number; guides: number };
  curves: number;
  /** how far the drawing was moved so it sits on the sketch's origin, or null when it was not */
  moved: V2 | null;
  /** width and height of what came in, in mm */
  size: V2;
  /** gaps closed between loose ends */
  joined: number;
  /** curves drawn twice, left out */
  duplicates: number;
}

const dist = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const TAU = 2 * Math.PI;

/** End points of an open curve, in its own direction. */
function endsOf(c: DxfCurve): [V2, V2] | null {
  if (c.t === "line") return [c.a, c.b];
  if (c.t === "arc") return [
    [c.c[0] + c.r * Math.cos(c.a0), c.c[1] + c.r * Math.sin(c.a0)],
    [c.c[0] + c.r * Math.cos(c.a0 + c.sweep), c.c[1] + c.r * Math.sin(c.a0 + c.sweep)],
  ];
  if (c.t === "spline" && !c.closed) return [c.pts[0], c.pts[c.pts.length - 1]];
  return null;
}

/** The box round a curve. */
function boxOf(c: DxfCurve, grow: (p: V2) => void) {
  if (c.t === "line") return grow(c.a), grow(c.b);
  if (c.t === "point") return grow(c.p);
  if (c.t === "spline") return c.pts.forEach(grow);
  if (c.t === "circle") return grow([c.c[0] - c.r, c.c[1] - c.r]), grow([c.c[0] + c.r, c.c[1] + c.r]);
  if (c.t === "ellipse") {
    const w = Math.hypot(c.rx * Math.cos(c.angle), c.ry * Math.sin(c.angle));
    const h = Math.hypot(c.rx * Math.sin(c.angle), c.ry * Math.cos(c.angle));
    return grow([c.c[0] - w, c.c[1] - h]), grow([c.c[0] + w, c.c[1] + h]);
  }
  // an arc: its ends and the quarter points it passes
  for (const p of endsOf(c)!) grow(p);
  for (let q = Math.ceil(c.a0 / (Math.PI / 2)); q * (Math.PI / 2) < c.a0 + c.sweep; q++) grow([c.c[0] + c.r * Math.cos((q * Math.PI) / 2), c.c[1] + c.r * Math.sin((q * Math.PI) / 2)]);
}

/**
 * The statements that bring a DXF drawing into a sketch. `taken` holds the
 * names already used in the sketch; the new names are added to it.
 */
export function dxfStatements(d: DxfDrawing, taken: Set<string>, opts: { file: string; recentre?: boolean }): DxfStatements {
  const curves = d.curves.map((c) => structuredClone(c));
  if (!curves.length) {
    const left = Object.entries(d.skipped).map(([k, n]) => `${n} ${k}${n === 1 ? "" : "s"}`);
    throw new DxfError(`${opts.file} has no lines, arcs or curves in model space to bring in${left.length ? ` (only ${left.join(", ")})` : ""}.`);
  }
  if (curves.length > MAX_DXF_CURVES) throw new DxfError(`${opts.file} has ${curves.length.toLocaleString()} curves; Kerf brings up to ${MAX_DXF_CURVES.toLocaleString()} into a sketch. Simplify the drawing (join short lines into arcs and splines, or leave out detail) and try again.`);

  // where it sits
  const lo: V2 = [Infinity, Infinity];
  const hi: V2 = [-Infinity, -Infinity];
  const grow = (p: V2) => {
    lo[0] = Math.min(lo[0], p[0]);
    lo[1] = Math.min(lo[1], p[1]);
    hi[0] = Math.max(hi[0], p[0]);
    hi[1] = Math.max(hi[1], p[1]);
  };
  for (const c of curves) boxOf(c, grow);
  const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], 1e-6);
  // a drawing far from its own origin is moved to sit on the sketch's
  let moved: V2 | null = null;
  if (opts.recentre && (lo[0] > span || hi[0] < -span || lo[1] > span || hi[1] < -span)) {
    // by a round amount, so coordinates drawn on a grid stay on one
    const step = span >= 10 ? 1 : span >= 1 ? 0.1 : 0.001;
    moved = [-Math.round((lo[0] + hi[0]) / 2 / step) * step, -Math.round((lo[1] + hi[1]) / 2 / step) * step].map((v) => Math.round(v * 1000) / 1000 + 0) as V2;
    const M = (p: V2): V2 => [p[0] + moved![0], p[1] + moved![1]];
    for (const c of curves) {
      if (c.t === "line") (c.a = M(c.a)), (c.b = M(c.b));
      else if (c.t === "point") c.p = M(c.p);
      else if (c.t === "spline") c.pts = c.pts.map(M);
      else c.c = M(c.c);
    }
  }

  // ---- joining ends ----
  // ends within a hair of each other are the same point; then loose ends a little apart are pulled together
  const tight = Math.max(1e-7, span * 1e-7);
  const gapTol = Math.min(0.05, Math.max(0.01, span * 1e-4));
  const endPts: { c: number; k: 0 | 1; p: V2 }[] = [];
  curves.forEach((c, i) => {
    const e = endsOf(c);
    if (e) endPts.push({ c: i, k: 0, p: e[0] }, { c: i, k: 1, p: e[1] });
  });
  const cluster = new Int32Array(endPts.length).fill(-1);
  const pos: V2[] = [];
  const members: number[][] = [];
  const cell = (p: V2, s: number) => `${Math.floor(p[0] / s)},${Math.floor(p[1] / s)}`;
  const grid = new Map<string, number[]>();
  endPts.forEach((e, i) => {
    const [cx, cy] = cell(e.p, tight * 4).split(",").map(Number);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++)
      for (let dy = -1; dy <= 1 && found < 0; dy++)
        for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? [])
          if (dist(pos[j], e.p) <= tight) {
            found = j;
            break;
          }
    if (found < 0) {
      found = pos.length;
      pos.push(e.p);
      members.push([]);
      const key = `${cx},${cy}`;
      const l = grid.get(key);
      if (l) l.push(found);
      else grid.set(key, [found]);
    }
    cluster[i] = found;
    members[found].push(i);
  });
  // loose ends: a point with one curve ending there. Each is pulled onto the nearest other point close by,
  // another loose end or a corner, nearest first
  const deg = members.map((m) => m.length);
  const curvesAt = members.map((m) => new Set(m.map((e) => endPts[e].c)));
  const all = new Map<string, number[]>();
  pos.forEach((p, i) => {
    const key = cell(p, gapTol);
    const l = all.get(key);
    if (l) l.push(i);
    else all.set(key, [i]);
  });
  const near: [number, number, number][] = [];
  members.forEach((m, i) => {
    if (m.length !== 1) return;
    const own = endPts[m[0]].c;
    const [cx, cy] = cell(pos[i], gapTol).split(",").map(Number);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const j of all.get(`${cx + dx},${cy + dy}`) ?? []) {
          // not onto the other end of its own curve
          if (j === i || curvesAt[j].has(own)) continue;
          const g = dist(pos[i], pos[j]);
          if (g <= gapTol) near.push([g, i, j]);
        }
  });
  near.sort((x, y) => x[0] - y[0]);
  const into = members.map((_, i) => i);
  const root = (i: number) => {
    while (into[i] !== i) i = into[i];
    return i;
  };
  const done = new Uint8Array(members.length);
  let joined = 0;
  for (const [, i, j] of near) {
    if (done[i]) continue;
    const r = root(j);
    if (r === i) continue;
    // two loose ends meet halfway; a loose end comes to a corner
    if (deg[r] === 1) pos[r] = [(pos[r][0] + pos[i][0]) / 2, (pos[r][1] + pos[i][1]) / 2];
    if (deg[r] === 1) done[r] = 1;
    into[i] = r;
    deg[r] += deg[i];
    done[i] = 1;
    joined++;
  }
  const clusterOf = (e: number) => root(cluster[e]);

  // curves take the joined positions; an arc's centre moves onto the bisector of its new ends
  const endIdx = new Map<number, [number, number]>();
  for (let e = 0; e < endPts.length; e += 2) endIdx.set(endPts[e].c, [e, e + 1]);
  const sliver = new Set<number>();
  for (const [ci, [ea, eb]] of endIdx) {
    const c = curves[ci];
    const A = pos[clusterOf(ea)];
    const B = pos[clusterOf(eb)];
    const shut = clusterOf(ea) === clusterOf(eb);
    if (c.t === "line") (c.a = A), (c.b = B);
    else if (c.t === "spline") {
      c.pts[0] = A;
      c.pts[c.pts.length - 1] = B;
      // a spline that runs back to its start is a closed one
      if (shut) {
        endIdx.delete(ci);
        if (c.pts.length >= 4) curves[ci] = { t: "spline", pts: c.pts.slice(0, -1), closed: true, guide: c.guide };
        else sliver.add(ci);
      }
    } else if (c.t === "arc") {
      if (shut) {
        // an arc that closed up on itself is a circle; a speck of one is nothing
        endIdx.delete(ci);
        if (c.sweep > Math.PI) curves[ci] = { t: "circle", c: c.c, r: c.r, guide: c.guide };
        else sliver.add(ci);
        continue;
      }
      const chord = dist(A, B);
      const m: V2 = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
      const n: V2 = [-(B[1] - A[1]) / chord, (B[0] - A[0]) / chord];
      const k = (c.c[0] - m[0]) * n[0] + (c.c[1] - m[1]) * n[1];
      const cc: V2 = [m[0] + n[0] * k, m[1] + n[1] * k];
      const a0 = Math.atan2(A[1] - cc[1], A[0] - cc[0]);
      let sweep = Math.atan2(B[1] - cc[1], B[0] - cc[0]) - a0;
      while (sweep <= 0) sweep += TAU;
      while (sweep > TAU) sweep -= TAU;
      curves[ci] = { t: "arc", c: cc, r: dist(A, cc), a0, sweep, guide: c.guide };
    }
  }

  // ---- duplicates and slivers ----
  const q = (v: number) => Math.round(v / (gapTol * 2));
  const keys = new Map<string, number>();
  const keep: boolean[] = curves.map((_, i) => !sliver.has(i));
  let duplicates = 0;
  curves.forEach((c, i) => {
    if (!keep[i]) return;
    const e = endIdx.get(i);
    const ca = e ? clusterOf(e[0]) : -1;
    const cb = e ? clusterOf(e[1]) : -1;
    let key: string;
    if (c.t === "line") {
      if (ca === cb) return void (keep[i] = false);
      key = `l${Math.min(ca, cb)}:${Math.max(ca, cb)}`;
    } else if (c.t === "arc") {
      if (c.r * c.sweep < tight) return void (keep[i] = false);
      key = `a${ca}:${cb}:${q(c.c[0])}:${q(c.c[1])}`;
    } else if (c.t === "circle") {
      if (c.r < tight) return void (keep[i] = false);
      key = `c${q(c.c[0])}:${q(c.c[1])}:${q(c.r)}`;
    } else if (c.t === "ellipse") key = `e${q(c.c[0])}:${q(c.c[1])}:${q(c.rx)}:${q(c.ry)}:${Math.round(c.angle * 1e4)}`;
    else if (c.t === "point") key = `p${q(c.p[0])}:${q(c.p[1])}`;
    else key = `s${c.closed}:${c.pts.length}:${q(c.pts[0][0])}:${q(c.pts[0][1])}:${q(c.pts[c.pts.length >> 1][0])}:${q(c.pts[c.pts.length >> 1][1])}`;
    const was = keys.get(key);
    if (was === undefined) return void keys.set(key, i);
    duplicates++;
    // a guide drawn over an outline curve: keep the outline
    const wc = curves[was];
    if (wc.t !== "point" && c.t !== "point" && wc.guide && !c.guide) {
      keep[was] = false;
      keys.set(key, i);
    } else keep[i] = false;
  });

  // ---- order: piece by piece (outlines before guides), each chain from end to end and each loop round ----
  const byCluster = new Map<number, number[]>();
  for (const [ci, [ea, eb]] of endIdx) {
    if (!keep[ci]) continue;
    for (const cl of [clusterOf(ea), clusterOf(eb)]) {
      const l = byCluster.get(cl);
      if (l) l.push(ci);
      else byCluster.set(cl, [ci]);
    }
  }
  // the connected pieces, in the order the drawing lists them
  const piece = new Map<number, number>();
  const pieces: number[][] = [];
  for (const [ci] of endIdx) {
    if (!keep[ci] || piece.has(ci)) continue;
    const list: number[] = [];
    const stack = [ci];
    piece.set(ci, pieces.length);
    while (stack.length) {
      const c = stack.pop()!;
      list.push(c);
      for (const e of endIdx.get(c)!)
        for (const n of byCluster.get(clusterOf(e)) ?? [])
          if (!piece.has(n)) {
            piece.set(n, pieces.length);
            stack.push(n);
          }
    }
    pieces.push(list.sort((x, y) => x - y));
  }
  const allGuides = (list: number[]) => list.every((ci) => curves[ci].t !== "point" && (curves[ci] as { guide: boolean }).guide);
  pieces.sort((x, y) => Number(allGuides(x)) - Number(allGuides(y)) || x[0] - y[0]);
  const order: { i: number; rev: boolean }[] = [];
  const used = new Set<number>();
  const walk = (from: number) => {
    let at = from;
    for (;;) {
      const next = (byCluster.get(at) ?? []).filter((ci) => !used.has(ci)).sort((x, y) => x - y)[0];
      if (next === undefined) return;
      used.add(next);
      const [ea, eb] = endIdx.get(next)!;
      const rev = clusterOf(ea) !== at;
      order.push({ i: next, rev });
      at = rev ? clusterOf(ea) : clusterOf(eb);
    }
  };
  for (const list of pieces) {
    // an open chain starts at a loose end; a loop at the start of its first curve
    const ends = list.flatMap((ci) => endIdx.get(ci)!.map(clusterOf));
    const odd = ends.find((cl) => byCluster.get(cl)!.length % 2 === 1);
    if (odd !== undefined) walk(odd);
    for (const ci of list) if (!used.has(ci)) walk(clusterOf(endIdx.get(ci)![0]));
    for (const ci of list) if (!used.has(ci)) {
      used.add(ci);
      order.push({ i: ci, rev: false });
    }
  }
  // closed curves and points after the outlines, guides last
  const rest = curves.map((_, i) => i).filter((i) => keep[i] && !endIdx.has(i));
  rest.sort((x, y) => Number(curves[x].t !== "point" && (curves[x] as { guide: boolean }).guide) - Number(curves[y].t !== "point" && (curves[y] as { guide: boolean }).guide) || x - y);
  for (const i of rest) order.push({ i, rev: false });

  // ---- text ----
  const geometry: string[] = [];
  const fixes: string[] = [];
  const sizes: string[] = [];
  const counts = { lines: 0, arcs: 0, circles: 0, splines: 0, ellipses: 0, points: 0, guides: 0 };
  const refOf = new Map<number, string>();
  const fixed = new Set<number>();
  const at = (cl: number) => refOf.get(cl) ?? fmtPt(pos[cl]);
  const name = (cl: number, ref: string) => {
    if (!refOf.has(cl)) refOf.set(cl, ref);
  };
  for (const { i, rev } of order) {
    const c = curves[i];
    const pre = c.t !== "point" && c.guide ? "construction " : "";
    if (pre) counts.guides++;
    const e = endIdx.get(i);
    if (c.t === "line") {
      let [ca, cb] = [clusterOf(e![0]), clusterOf(e![1])];
      if (rev) [ca, cb] = [cb, ca];
      const id = nextName(taken, "l");
      geometry.push(`${pre}line ${id} = ${at(ca)} -> ${at(cb)}`);
      name(ca, `${id}.start`);
      name(cb, `${id}.end`);
      if (!fixed.has(ca) || !fixed.has(cb)) fixes.push(id);
      fixed.add(ca).add(cb);
      counts.lines++;
    } else if (c.t === "arc") {
      const [ca, cb] = [clusterOf(e![0]), clusterOf(e![1])];
      const id = nextName(taken, "a");
      geometry.push(`${pre}arc ${id} = ${at(ca)} -> ${at(cb)}, center: ${fmtPt(c.c)}`);
      name(ca, `${id}.start`);
      name(cb, `${id}.end`);
      for (const [cl, ref] of [
        [ca, `${id}.start`],
        [cb, `${id}.end`],
      ] as const)
        if (!fixed.has(cl)) {
          fixes.push(ref);
          fixed.add(cl);
        }
      fixes.push(`${id}.center`);
      counts.arcs++;
    } else if (c.t === "spline") {
      const id = nextName(taken, "s");
      if (c.closed) geometry.push(`${pre}spline ${id} = ${c.pts.map(fmtPt).join(", ")}, closed: true`);
      else {
        let [ca, cb] = [clusterOf(e![0]), clusterOf(e![1])];
        let mid = c.pts.slice(1, -1);
        if (rev) {
          [ca, cb] = [cb, ca];
          mid = mid.reverse();
        }
        geometry.push(`${pre}spline ${id} = ${[at(ca), ...mid.map(fmtPt), at(cb)].join(", ")}`);
        name(ca, `${id}.start`);
        name(cb, `${id}.end`);
        fixed.add(ca).add(cb);
      }
      fixes.push(id);
      counts.splines++;
    } else if (c.t === "circle") {
      const id = nextName(taken, "c");
      geometry.push(`${pre}circle ${id} = ${fmtPt(c.c)}, d: ${fmt(2 * c.r)}`);
      fixes.push(id);
      sizes.push(`diameter ${id} = ${fmt(2 * c.r)}`);
      counts.circles++;
    } else if (c.t === "ellipse") {
      const id = nextName(taken, "e");
      const deg = Math.round(((((c.angle * 180) / Math.PI) % 180) + 180) % 180 * 1000) / 1000;
      geometry.push(`${pre}ellipse ${id} = ${fmtPt(c.c)}, rx: ${fmt(c.rx)}, ry: ${fmt(c.ry)}${deg ? `, angle: ${fmt(deg)}` : ""}`);
      fixes.push(id);
      counts.ellipses++;
    } else {
      const id = nextName(taken, "p");
      geometry.push(`point ${id} = ${fmtPt(c.p)}`);
      fixes.push(id);
      counts.points++;
    }
  }
  // fix statements of a readable length
  const constraints: string[] = [];
  for (let k = 0; k < fixes.length; k += 16) constraints.push(`fix ${fixes.slice(k, k + 16).join(", ")}`);
  constraints.push(...sizes);

  const where = moved ? `, moved ${fmtPt(moved)} to sit on the origin` : "";
  geometry.unshift(`// from ${opts.file} (${d.readAs}${where}), fixed where it was drawn: delete the fix lines to drag and dimension it`);
  return {
    geometry,
    constraints,
    counts,
    curves: order.length,
    moved,
    size: [hi[0] - lo[0], hi[1] - lo[1]],
    joined,
    duplicates,
  };
}

/** "24 lines, 8 arcs and 4 circles": what came in, in words. */
export function dxfCountsText(c: DxfStatements["counts"]): string {
  const bits = (
    [
      [c.lines, "line"],
      [c.arcs, "arc"],
      [c.circles, "circle"],
      [c.splines, "spline"],
      [c.ellipses, "ellipse"],
      [c.points, "point"],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, w]) => `${n} ${w}${n === 1 ? "" : "s"}`);
  if (bits.length < 2) return bits[0] ?? "nothing";
  return `${bits.slice(0, -1).join(", ")} and ${bits[bits.length - 1]}`;
}
