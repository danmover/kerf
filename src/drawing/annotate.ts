// Angles, radii, chamfers, arc lengths and ordinates: the ones Kerf reads off
// a part's views (fillets and rounded corners, chamfers cut across square
// corners, sloped edges) and the ones written in the drawing block. Also the
// ISO 21920-1 surface texture and ISO 2553 weld symbols, drawn as lines so
// SVG, PDF and DXF match.

import type { EvalPart } from "../core/model";
import type { Edge2 } from "../kernel/drawing";
import { vcross, vdot, vnorm, vsub, type V3 } from "../kernel/recipe";
import type { Feature } from "./features";
import { fmtNum, type Box, type Ink } from "./sheet";
import { generalAngle, type DrawingSpec, type WeldSpec } from "./spec";
import { textWidth } from "./text";
import { toView } from "./views";
import { close, principalViews, type DimContext, type DimDef, type DimText, type Finish, type Push, type WeldMark } from "./dims";

type P2 = [number, number];

const sub2 = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const len2 = (a: P2) => Math.hypot(a[0], a[1]);
const unit2 = (a: P2): P2 => {
  const l = len2(a) || 1;
  return [a[0] / l, a[1] / l];
};

/** A straight visible edge in view space. */
interface Seg {
  a: P2;
  b: P2;
  len: number;
  u: P2;
}

/** The visible straight edges of one item in a view, with collinear pieces joined. */
export function viewLines(edges: Edge2[], part = 0, max = 4000): Seg[] {
  const raw: Seg[] = [];
  for (const e of edges) {
    if (!e.vis || e.part !== part) continue;
    let p: number[] | null = null;
    if (e.g.t === "L") p = e.g.p;
    else if (e.g.t === "P" && e.g.p.length === 4) p = e.g.p;
    if (!p) continue;
    const a: P2 = [p[0], p[1]];
    const b: P2 = [p[2], p[3]];
    const l = len2(sub2(b, a));
    if (l < 1e-6) continue;
    raw.push({ a, b, len: l, u: unit2(sub2(b, a)) });
    if (raw.length > max) return [];
  }
  // bucket by the line each piece lies on, then join overlapping pieces along it
  const buckets = new Map<string, { t0: number; t1: number; n: P2; off: number; u: P2 }[]>();
  for (const s of raw) {
    let u = s.u;
    if (u[0] < -1e-9 || (Math.abs(u[0]) <= 1e-9 && u[1] < 0)) u = [-u[0], -u[1]];
    const n: P2 = [-u[1], u[0]];
    const off = n[0] * s.a[0] + n[1] * s.a[1];
    const k = `${Math.round(Math.atan2(u[1], u[0]) * 1e3)}|${Math.round(off * 200)}`;
    const ta = u[0] * s.a[0] + u[1] * s.a[1];
    const tb = u[0] * s.b[0] + u[1] * s.b[1];
    (buckets.get(k) ?? buckets.set(k, []).get(k)!).push({ t0: Math.min(ta, tb), t1: Math.max(ta, tb), n, off, u });
  }
  const out: Seg[] = [];
  for (const list of buckets.values()) {
    list.sort((x, y) => x.t0 - y.t0);
    let cur = { ...list[0] };
    const flush = () => {
      const { u, n, off } = cur;
      const a: P2 = [u[0] * cur.t0 + n[0] * off, u[1] * cur.t0 + n[1] * off];
      const b: P2 = [u[0] * cur.t1 + n[0] * off, u[1] * cur.t1 + n[1] * off];
      out.push({ a, b, len: cur.t1 - cur.t0, u });
    };
    for (const s of list.slice(1)) {
      if (s.t0 <= cur.t1 + 1e-3) cur.t1 = Math.max(cur.t1, s.t1);
      else {
        flush();
        cur = { ...s };
      }
    }
    flush();
  }
  return out;
}

const keyOf = (p: P2) => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`;

/** Lines meeting at each end point (rounded to 0.01 mm). */
function ends(segs: Seg[]): Map<string, number[]> {
  const m = new Map<string, number[]>();
  segs.forEach((s, i) => {
    for (const p of [s.a, s.b]) {
      // look in the neighbouring cells too, so ends that round apart still meet
      const k = keyOf(p);
      (m.get(k) ?? m.set(k, []).get(k)!).push(i);
    }
  });
  return m;
}

function meeting(m: Map<string, number[]>, segs: Seg[], p: P2, not: number): number[] {
  const out = new Set<number>();
  const [x, y] = [Math.round(p[0] * 100), Math.round(p[1] * 100)];
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (const i of m.get(`${x + dx},${y + dy}`) ?? []) {
        if (i === not) continue;
        const s = segs[i];
        if (len2(sub2(s.a, p)) < 0.02 || len2(sub2(s.b, p)) < 0.02) out.add(i);
      }
  return [...out];
}

/** Where two lines cross, or null when they are parallel. */
function cross(p: P2, u: P2, q: P2, w: P2): P2 | null {
  const d = u[0] * w[1] - u[1] * w[0];
  if (Math.abs(d) < 1e-9) return null;
  const t = ((q[0] - p[0]) * w[1] - (q[1] - p[1]) * w[0]) / d;
  return [p[0] + u[0] * t, p[1] + u[1] * t];
}

const square = (u: P2) => Math.abs(u[0]) > 0.9998 || Math.abs(u[1]) > 0.9998;

interface Round {
  c: P2;
  r: number;
  mid: P2;
}
interface Cham {
  mid: P2;
  text: string;
}
interface Ang {
  vertex: P2;
  legs: [P2, P2];
  lens: [number, number];
  deg: number;
}

/** What one view shows: arcs to call out by radius, chamfers, and sloped edges to dimension by angle. */
function readView(edges: Edge2[], frame: { dir: V3; x: V3; y: V3 }, feats: Feature[], part: EvalPart, maxExt: number, angles: boolean): { rounds: Round[]; chams: Cham[]; angs: Ang[] } {
  const along = (d: V3) => Math.abs(vdot(vnorm(d), frame.dir)) > 0.999;
  // features already called out in this view: their circles and slot corners are not radii to dimension
  const circles: { c: P2; r: number[] }[] = [];
  const slots: { c: P2; reach: number; r: number }[] = [];
  for (const f of feats) {
    if (f.t === "hole" && along(f.dir)) circles.push({ c: toView(f.at, frame), r: [f.d / 2, ...(f.cbore ? [f.cbore[0] / 2] : []), ...(f.csink ? [f.csink / 2] : [])] });
    if (f.t === "cyl" && along(f.dir)) circles.push({ c: toView(f.at, frame), r: [f.d / 2] });
    if (f.t === "slot" && along(f.dir)) slots.push({ c: toView(f.at, frame), reach: Math.hypot(f.w, f.h) / 2 + 0.01, r: f.r });
    if (f.t === "turned" && along(f.dir)) circles.push({ c: toView(f.at, frame), r: f.pts.map((p) => p[0]) });
  }
  // arcs, pieces of the same arc joined
  type A = { c: P2; r: number; sweep: number; best: { a0: number; a1: number } };
  const arcs: A[] = [];
  for (const e of edges) {
    if (!e.vis || e.part !== 0 || e.g.t !== "A") continue;
    const g = e.g;
    const sw = g.a1 - g.a0;
    if (sw >= Math.PI * 2 - 1e-6) continue;
    const hit = arcs.find((x) => close(x.c[0], g.c[0], 0.01) && close(x.c[1], g.c[1], 0.01) && close(x.r, g.r, 0.005));
    if (hit) {
      hit.sweep += sw;
      if (sw > hit.best.a1 - hit.best.a0) hit.best = { a0: g.a0, a1: g.a1 };
    } else arcs.push({ c: [g.c[0], g.c[1]], r: g.r, sweep: sw, best: { a0: g.a0, a1: g.a1 } });
  }
  const kept = arcs.filter((a) => {
    if (a.sweep >= Math.PI * 2 - 0.05 || a.sweep < (3 * Math.PI) / 180 || a.r < 0.2 || a.r > 4 * maxExt) return false;
    // part of a hole, bore or boss circle (cut by an edge, or split by the projection)
    if (circles.some((c) => close(c.c[0], a.c[0], 0.05) && close(c.c[1], a.c[1], 0.05) && c.r.some((r) => close(r, a.r, 0.01)))) return false;
    if (slots.some((s) => len2(sub2(a.c, s.c)) <= s.reach && close(a.r, s.r, 0.01))) return false;
    return true;
  });
  // concentric arcs (a bend's inside and outside, a shell's inner corner): sheet parts give the inside radius, others the outside
  const rounds: Round[] = [];
  for (const a of kept) {
    const twin = kept.filter((o) => close(o.c[0], a.c[0], 0.01) && close(o.c[1], a.c[1], 0.01));
    const pick = twin.reduce((x, y) => (part.sheet ? (y.r < x.r ? y : x) : y.r > x.r ? y : x));
    if (pick !== a) continue;
    const m = (a.best.a0 + a.best.a1) / 2;
    rounds.push({ c: a.c, r: a.r, mid: [a.c[0] + a.r * Math.cos(m), a.c[1] + a.r * Math.sin(m)] });
  }

  const segs = viewLines(edges);
  const at = ends(segs);
  const chamSet = new Set<number>();
  const chams: Cham[] = [];
  const small = Math.min(0.2 * maxExt, 20);
  segs.forEach((s, i) => {
    if (square(s.u) || s.len > small || s.len < 0.05) return;
    for (const na of meeting(at, segs, s.a, i)) {
      const A = segs[na];
      if (Math.abs(A.u[0] * s.u[1] - A.u[1] * s.u[0]) < 1e-3) continue;
      for (const nb of meeting(at, segs, s.b, i)) {
        const B = segs[nb];
        if (nb === na || Math.abs(A.u[0] * B.u[0] + A.u[1] * B.u[1]) > 0.02) continue;
        const C = cross(s.a, A.u, s.b, B.u);
        if (!C) continue;
        const d1 = len2(sub2(C, s.a));
        const d2 = len2(sub2(C, s.b));
        // legs further apart than 1 : 2.5 (steeper than about 22° or 68°) are a sloped face, not a chamfer
        if (d1 < 0.01 || d2 < 0.01 || d1 > small || d2 > small || Math.max(d1, d2) > 2.5 * Math.min(d1, d2)) continue;
        // the corner lies past the ends of both lines: the chamfer cut it off
        const outside = (L: Seg, p: P2) => {
          const far = len2(sub2(L.a, p)) < len2(sub2(L.b, p)) ? L.b : L.a;
          return len2(sub2(C, far)) > len2(sub2(p, far)) + 1e-6;
        };
        if (!outside(A, s.a) || !outside(B, s.b)) continue;
        const text = close(d1, d2, 0.01) ? `${fmtNum(d1)} × 45°` : `${fmtNum(Math.min(d1, d2))} × ${fmtNum(Math.max(d1, d2))}`;
        chams.push({ mid: [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2], text });
        chamSet.add(i);
        return;
      }
    }
  });

  const angs: Ang[] = [];
  if (angles) {
    segs.forEach((s, i) => {
      if (chamSet.has(i) || square(s.u) || s.len < 0.15 * maxExt) return;
      let best: (Ang & { score: number }) | null = null;
      for (const [p, q] of [
        [s.a, s.b],
        [s.b, s.a],
      ] as [P2, P2][]) {
        for (const n of meeting(at, segs, p, i)) {
          const R = segs[n];
          if (!square(R.u) || R.len < 0.08 * maxExt || chamSet.has(n)) continue;
          const r1 = unit2(sub2(q, p));
          const far = len2(sub2(R.a, p)) < len2(sub2(R.b, p)) ? R.b : R.a;
          const r2 = unit2(sub2(far, p));
          const deg = (Math.acos(Math.max(-1, Math.min(1, r1[0] * r2[0] + r1[1] * r2[1]))) * 180) / Math.PI;
          if (deg < 1 || deg > 179 || Math.abs(deg - 90) < 1) continue;
          // equal sides meeting at the same angle all round are a regular polygon (a hexagon): its flats say enough
          if (close(R.len, s.len, s.len * 0.02)) continue;
          if (!best || R.len > best.score) best = { vertex: p, legs: [r1, r2], lens: [s.len, R.len], deg, score: R.len };
        }
      }
      if (best) angs.push(best);
    });
  }
  return { rounds, chams, angs };
}

/**
 * Radii, chamfers and angles read off a single part's principal views. Each
 * radius and chamfer size is called out once, in the view that shows it most
 * often; radii that do not fit go into a note.
 */
export function edgeDims(ctx: DimContext, part: EvalPart, feats: Feature[], push: Push, what: string, notes: string[]) {
  const { plan } = ctx;
  if (part.gear || plan.spec.flat) return;
  const turned = feats.find((f): f is Extract<Feature, { t: "turned" }> => f.t === "turned");
  const drafted = part.recipe.ops.some((o) => o.op === "draft");
  type Seen = { vi: number; rounds: Round[]; chams: Cham[]; angs: Ang[]; centre: P2 };
  const seen: Seen[] = [];
  // principal views first, then sections (a bent bracket's bend radii may show only there)
  const order = [...principalViews(plan), ...plan.views.flatMap((v, i) => (v.kind === "section" ? [i] : []))];
  for (const vi of order) {
    const r = ctx.results[vi];
    const v = plan.views[vi];
    if (!r || v.kind === "iso" || v.synthetic) continue;
    const [u0, v0, u1, v1] = ctx.ext[vi];
    const maxExt = Math.max(u1 - u0, v1 - v0, 1e-3);
    const got = readView(r.edges, v.frame, feats, part, maxExt, !drafted);
    // a turned part shows each chamfer twice, above and below its axis
    if (turned && Math.abs(vdot(vnorm(turned.dir), v.frame.dir)) < 1e-3) {
      const o = toView(turned.at, v.frame);
      const ax = unit2([vdot(turned.dir, v.frame.x), vdot(turned.dir, v.frame.y)]);
      const mirror = (p: P2): P2 => {
        const d = sub2(p, o);
        const t = d[0] * ax[0] + d[1] * ax[1];
        return [o[0] + 2 * t * ax[0] - d[0], o[1] + 2 * t * ax[1] - d[1]];
      };
      const keep: Cham[] = [];
      for (const c of got.chams) if (!keep.some((k) => k.text === c.text && len2(sub2(mirror(c.mid), k.mid)) < 0.05)) keep.push(c);
      got.chams = keep;
      const ang: Ang[] = [];
      for (const a of got.angs) if (!ang.some((k) => close(k.deg, a.deg, 0.05))) ang.push(a);
      got.angs = ang;
    }
    seen.push({ vi, ...got, centre: [(u0 + u1) / 2, (v0 + v1) / 2] });
  }
  // radii that differ by modelling noise (R5.45 and R5.44) are one size
  const all = seen.flatMap((s) => s.rounds).sort((a, b) => a.r - b.r);
  for (let i = 0; i < all.length; ) {
    let j = i + 1;
    while (j < all.length && all[j].r - all[j - 1].r <= Math.max(0.02, 0.005 * all[j].r)) j++;
    const group = all.slice(i, j);
    const r = group.reduce((t, g) => t + g.r, 0) / group.length;
    for (const g of group) g.r = r;
    i = j;
  }
  // each size in the view that shows it most
  const bestView = <T>(key: (s: Seen) => T[], name: (t: T) => string) => {
    const where = new Map<string, { vi: number; list: T[] }>();
    for (const s of seen) {
      const by = new Map<string, T[]>();
      for (const t of key(s)) by.set(name(t), [...(by.get(name(t)) ?? []), t]);
      for (const [k, list] of by) if (!where.has(k) || where.get(k)!.list.length < list.length) where.set(k, { vi: s.vi, list });
    }
    return where;
  };
  const radii = bestView(
    (s) => s.rounds,
    (r) => fmtNum(r.r),
  );
  const perView = new Map<number, number>();
  const over: string[] = [];
  for (const [r, { vi, list }] of [...radii].sort((a, b) => b[1].list.length - a[1].list.length)) {
    const n = perView.get(vi) ?? 0;
    if (n >= 4) {
      over.push(`R${r}`);
      continue;
    }
    perView.set(vi, n + 1);
    // the leader goes to the arc highest in the view, so it does not cross the part
    const rep = list.reduce((a, b) => (b.mid[1] > a.mid[1] + 1e-6 || (close(b.mid[1], a.mid[1], 1e-6) && b.mid[0] > a.mid[0]) ? b : a));
    const main = `${list.length > 1 ? `${list.length}× ` : ""}R${r}`;
    push({ view: vi, kind: "callout", a: rep.c, b: rep.c, value: rep.r, text: { main }, touch: rep.mid, lead: rep.mid[0] >= rep.c[0] - 1e-6 ? "right" : "left", meta: { label: `Radius R${r} in ${what}`, part: part.id, kind: "radius" } });
  }
  if (over.length) notes.push(over.length === 1 ? `ALL UNDIMENSIONED RADII ${over[0]}.` : `UNDIMENSIONED RADII: ${over.join(", ")}.`);
  const chams = bestView(
    (s) => s.chams,
    (c) => c.text,
  );
  const perViewC = new Map<number, number>();
  for (const [text, { vi, list }] of [...chams].sort((a, b) => b[1].list.length - a[1].list.length)) {
    const n = perViewC.get(vi) ?? 0;
    if (n >= 3) continue;
    perViewC.set(vi, n + 1);
    const rep = list.reduce((a, b) => (b.mid[1] > a.mid[1] + 1e-6 ? b : a));
    const centre = seen.find((s) => s.vi === vi)!.centre;
    const size = Number(text.split(" ")[0]);
    push({ view: vi, kind: "callout", a: rep.mid, b: rep.mid, value: size, text: { main: `${list.length > 1 ? `${list.length}× ` : ""}${text}` }, touch: rep.mid, lead: rep.mid[0] >= centre[0] ? "right" : "left", meta: { label: `Chamfer ${text} in ${what}`, part: part.id, kind: "chamfer" } });
  }
  for (const s of seen) {
    const done: number[] = [];
    for (const a of [...s.angs].sort((x, y) => y.lens[0] - x.lens[0])) {
      if (done.length >= 3 || done.some((d) => close(d, a.deg, 0.05))) continue;
      done.push(a.deg);
      push({ view: s.vi, kind: "angle", a: a.vertex, b: a.vertex, value: a.deg, text: { main: `${fmtNum(a.deg, 1)}°` }, legs: a.legs, lens: a.lens, meta: { label: `Angle ${fmtNum(a.deg, 1)}° in ${what}`, part: part.id, general: generalAngle(ctx.spec.tolerance, Math.min(...a.lens)) ?? undefined } });
    }
  }
}

// ---------- written in the drawing block ----------

/** The principal view that looks most nearly along a direction. */
function facing(ctx: DimContext, n: V3): number {
  let best = -1;
  let score = -1;
  for (const vi of principalViews(ctx.plan)) {
    const s = Math.abs(vdot(vnorm(n), ctx.plan.views[vi].frame.dir));
    if (s > score + 1e-6) {
      best = vi;
      score = s;
    }
  }
  return best;
}

const angleBetween = (a: V3, b: V3) => (Math.acos(Math.max(-1, Math.min(1, vdot(vnorm(a), vnorm(b))))) * 180) / Math.PI;

/** angle(), radius(), chamfer(), arc_length() and ordinate() from the block. */
export function markDims(ctx: DimContext, push: Push, warnings: string[]) {
  const { plan, spec } = ctx;
  const findView = (name: string | undefined): number => (name ? plan.views.findIndex((v) => v.name === name || v.kind === name) : -1);
  const first = principalViews(plan)[0] ?? 0;
  for (const m of spec.marks) {
    const named = findView(m.view);
    if (m.view && named < 0) {
      warnings.push(`${m.t === "arc" ? "arc_length" : m.t}(): there is no "${m.view}" view on this drawing`);
      continue;
    }
    const meta = { auto: false, span: m.span };
    switch (m.t) {
      case "angle": {
        const n = vcross(vsub(m.a, m.vertex), vsub(m.b, m.vertex));
        if (Math.hypot(...n) < 1e-9) {
          warnings.push("angle(): the three points are in a line, so there is no angle");
          continue;
        }
        const vi = named >= 0 ? named : facing(ctx, n);
        const f = plan.views[vi].frame;
        const V = toView(m.vertex, f);
        const A = sub2(toView(m.a, f), V);
        const B = sub2(toView(m.b, f), V);
        if (len2(A) < 1e-6 || len2(B) < 1e-6) {
          warnings.push(`angle(): the ${plan.views[vi].name} view sees the angle edge-on`);
          continue;
        }
        const deg = angleBetween(vsub(m.a, m.vertex), vsub(m.b, m.vertex));
        const text: DimText = { main: m.text ?? `${fmtNum(deg, 1)}°`, suffix: m.tol ? `±${fmtNum(m.tol, 2)}°` : undefined };
        push({ view: vi, kind: "angle", a: V, b: V, value: deg, text, legs: [unit2(A), unit2(B)], lens: [len2(A), len2(B)], meta: { ...meta, label: `Angle ${fmtNum(deg, 1)}°`, a: m.vertex, b: m.a, tol: m.tol ? [m.tol, -m.tol] : undefined } });
        break;
      }
      case "radius": {
        let vi = named;
        if (vi < 0) {
          // the view that shows an arc of this radius round the point
          vi = principalViews(plan).find((i) => {
            const c = toView(m.at, plan.views[i].frame);
            return ctx.results[i]?.edges.some((e) => e.g.t === "A" && close(e.g.r, m.r, 1e-3) && close(e.g.c[0], c[0], 1e-3) && close(e.g.c[1], c[1], 1e-3));
          }) ?? first;
        }
        const f = plan.views[vi].frame;
        const c = toView(m.at, f);
        const dir = m.toward ? unit2(sub2(toView(m.toward, f), c)) : ([Math.SQRT1_2, Math.SQRT1_2] as P2);
        const touch: P2 = [c[0] + dir[0] * m.r, c[1] + dir[1] * m.r];
        const tol = m.tol;
        const sym = tol && close(tol[0], -tol[1], 1e-9);
        const text: DimText = { main: m.text ?? `R${fmtNum(m.r)}`, suffix: sym ? `±${fmtNum(tol![0], 3)}` : undefined, up: tol && !sym ? `${tol[0] >= 0 ? "+" : "−"}${fmtNum(Math.abs(tol[0]), 3)}` : undefined, lo: tol && !sym ? `${tol[1] >= 0 ? "+" : "−"}${fmtNum(Math.abs(tol[1]), 3)}` : undefined };
        push({ view: vi, kind: "callout", a: c, b: c, value: m.r, text, touch, lead: dir[0] >= 0 ? "right" : "left", meta: { ...meta, label: `Radius R${fmtNum(m.r)}`, a: m.at, kind: "radius", tol } });
        break;
      }
      case "chamfer": {
        const vi = named >= 0 ? named : first;
        const f = plan.views[vi].frame;
        const P = toView(m.at, f);
        const [u0, , u1] = ctx.ext[vi];
        const text = m.text ?? `${fmtNum(m.size)} × ${fmtNum(m.angle)}°`;
        push({ view: vi, kind: "callout", a: P, b: P, value: m.size, text: { main: text }, touch: P, lead: P[0] >= (u0 + u1) / 2 ? "right" : "left", meta: { ...meta, label: `Chamfer ${text}`, a: m.at, kind: "chamfer" } });
        break;
      }
      case "arc": {
        const n = vcross(vsub(m.a, m.center), vsub(m.b, m.center));
        const vi = named >= 0 ? named : Math.hypot(...n) > 1e-9 ? facing(ctx, n) : first;
        const f = plan.views[vi].frame;
        const C = toView(m.center, f);
        const A = sub2(toView(m.a, f), C);
        const B = sub2(toView(m.b, f), C);
        const r = len2(A);
        if (r < 1e-6) {
          warnings.push("arc_length(): the start point is on the centre");
          continue;
        }
        const a0 = Math.atan2(A[1], A[0]);
        let a1 = Math.atan2(B[1], B[0]);
        while (a1 <= a0 + 1e-9) a1 += Math.PI * 2;
        const value = r * (a1 - a0);
        push({ view: vi, kind: "arc", a: C, b: C, value, text: { main: m.text ?? fmtNum(value) }, arc: { c: C, r, a0, a1 }, meta: { ...meta, label: `Arc length ${fmtNum(value)}`, a: m.center, b: m.a } });
        break;
      }
      case "ordinate": {
        const vi = named >= 0 ? named : first;
        const f = plan.views[vi].frame;
        const O = toView(m.origin, f);
        const axes: (0 | 1)[] = m.axis === "x" ? [0] : m.axis === "y" ? [1] : [0, 1];
        for (const axis of axes) {
          const pts = [O, ...m.pts.map((p) => toView(p, f))];
          const seenVals: number[] = [];
          for (const P of pts) {
            const value = P[axis] - O[axis];
            if (seenVals.some((s) => close(s, value, 0.01))) continue;
            seenVals.push(value);
            push({ view: vi, kind: "ordinate", a: P, b: O, axis, value, text: { main: fmtNum(value) }, side: axis === 0 ? "bottom" : "left", meta: { ...meta, label: `Ordinate ${axis === 0 ? "X" : "Y"} ${fmtNum(value)}` } });
          }
        }
        break;
      }
    }
  }
}

/** roughness() and weld() on surface points: symbols on leaders. */
export function symbolDims(ctx: DimContext, push: Push, warnings: string[]) {
  const { plan, spec } = ctx;
  const findView = (name: string | undefined): number => (name ? plan.views.findIndex((v) => v.name === name || v.kind === name) : -1);
  const first = principalViews(plan)[0] ?? 0;
  const place = (at: V3, view: string | undefined, what: string): { vi: number; P: P2; lead: "left" | "right" } | null => {
    const named = findView(view);
    if (view && named < 0) {
      warnings.push(`${what}(): there is no "${view}" view on this drawing`);
      return null;
    }
    const vi = named >= 0 ? named : first;
    const P = toView(at, plan.views[vi].frame);
    const [u0, , u1] = ctx.ext[vi];
    return { vi, P, lead: P[0] >= (u0 + u1) / 2 ? "right" : "left" };
  };
  for (const r of spec.roughness) {
    if (!r.at) continue;
    const p = place(r.at, r.view, "roughness");
    if (!p) continue;
    const finish: Finish = { ra: r.ra, rz: r.rz, process: r.process, lay: r.lay, removal: r.removal };
    push({ view: p.vi, kind: "callout", a: p.P, b: p.P, value: r.ra ?? r.rz ?? 0, text: { main: "" }, touch: p.P, lead: p.lead, finish, meta: { label: `Surface texture ${finishText(finish)}`, auto: false, span: r.span, a: r.at, kind: "roughness", finish: finishText(finish) } });
  }
  for (const w of spec.welds) {
    const p = place(w.at, w.view, "weld");
    if (!p) continue;
    const weld = weldMark(w);
    push({ view: p.vi, kind: "callout", a: p.P, b: p.P, value: w.size ?? 0, text: { main: "" }, touch: p.P, lead: p.lead, weld, meta: { label: `Weld: ${weldText(weld)}`, auto: false, span: w.span, a: w.at, kind: "weld" } });
  }
}

/** roughness("id", …) puts a symbol on an automatic dimension or callout. */
export function applyRoughness(dims: DimDef[], spec: DrawingSpec, warnings: string[]) {
  for (const r of spec.roughness) {
    if (!r.id) continue;
    const d = dims.find((x) => x.meta.id === r.id);
    if (!d) {
      warnings.push(`roughness("${r.id}"): there is no dimension or callout with that id on this drawing`);
      continue;
    }
    d.finish = { ra: r.ra, rz: r.rz, process: r.process, lay: r.lay, removal: r.removal };
    d.meta = { ...d.meta, finish: finishText(d.finish), span: d.meta.span ?? r.span };
  }
}

/** The whole part's surface texture: written with roughness(ra: 3.2), or Ra 3.2 for a machined part. */
export function generalFinish(spec: DrawingSpec, machined: boolean): Finish | null {
  const g = spec.roughness.find((r) => !r.id && !r.at);
  if (g) return { ra: g.ra, rz: g.rz, process: g.process, lay: g.lay, removal: g.removal };
  return machined ? { ra: 3.2, removal: "required" } : null;
}

export function weldMark(w: WeldSpec): WeldMark {
  return { kind: w.kind, size: w.size, length: w.length, side: w.side, allRound: w.allRound, field: w.field, note: w.note };
}

export function finishText(f: Finish): string {
  const parts = [f.ra !== undefined ? `Ra ${fmtNum(f.ra, 3)}` : "", f.rz !== undefined ? `Rz ${fmtNum(f.rz, 3)}` : ""].filter(Boolean);
  if (f.process) parts.push(f.process.toUpperCase());
  if (f.lay) parts.push(`lay ${f.lay}`);
  if (f.removal === "prohibited") parts.push("no material removal");
  return parts.join(", ") || (f.removal === "required" ? "machined" : "any process");
}

const WELD_WORD: Record<string, string> = { fillet: "fillet", square: "square butt", v: "single-V butt", bevel: "single-bevel butt", u: "single-U butt", j: "single-J butt", plug: "plug", spot: "spot", seam: "seam", edge: "edge" };

export function weldText(w: WeldMark): string {
  const s = [`${WELD_WORD[w.kind]} weld`];
  const size = weldSize(w);
  if (size) s[0] += ` ${size}`;
  if (w.length) s[0] += ` × ${w.length}`;
  if (centred(w.kind)) s.push("centred on the joint");
  else s.push(w.side === "both" ? "both sides" : `${w.side} side`);
  if (w.allRound) s.push("all round");
  if (w.field) s.push("site weld");
  if (w.note) s.push(w.note);
  return s.join(", ");
}

const centred = (k: string) => k === "spot" || k === "seam";

function weldSize(w: WeldMark): string {
  if (w.size === undefined) return "";
  const prefix = w.kind === "fillet" ? "a" : w.kind === "plug" || w.kind === "spot" ? "d" : w.kind === "seam" ? "c" : w.kind === "edge" ? "" : "s";
  return `${prefix}${fmtNum(w.size)}`;
}

// ---------- angles and arcs on paper ----------

/** The paper geometry of an angle dimension: its arc, extension lines and text spot. */
export function angleGeom(d: DimDef, V: P2, scale: number, st: { size: number; arrow: number; first: number }) {
  // legs on paper (y down)
  const [l1, l2] = d.legs!;
  let s0 = Math.atan2(l1[1], l1[0]);
  let sw = Math.atan2(l2[1], l2[0]) - s0;
  while (sw < 0) sw += Math.PI * 2;
  if (sw > Math.PI) {
    s0 = Math.atan2(l2[1], l2[0]);
    sw = Math.PI * 2 - sw;
  }
  const lens = (d.lens ?? [10, 10]).map((l) => l * scale);
  let R = d.offset ?? Math.min(Math.max(Math.min(...lens) * 0.7, st.first + 4), 30);
  R = Math.max(R, (2 * st.arrow + 2) / Math.max(sw, 1e-3));
  R = Math.min(R, 45);
  const mid = s0 + sw / 2;
  const at = (a: number, r: number): P2 => [V[0] + r * Math.cos(a), V[1] - r * Math.sin(a)];
  return { s0, sw, R, mid, at, lens };
}

/** Points to measure an angle or arc dimension's reach by. */
export function angleReach(d: DimDef, V: P2, scale: number, st: { size: number; arrow: number; first: number }): P2[] {
  const g = d.kind === "arc" ? arcGeom(d, V, scale, st) : angleGeom(d, V, scale, st);
  const pts: P2[] = [];
  for (let k = 0; k <= 8; k++) pts.push(g.at(g.s0 + (g.sw * k) / 8, g.R + 1.5));
  const t = textSpot(g.at(g.mid, g.R + st.size * 0.9), g.mid, st.size);
  const w = textWidth(d.text.main + (d.text.suffix ? " " + d.text.suffix : ""), st.size);
  const x0 = t.anchor === "start" ? t.x : t.anchor === "end" ? t.x - w : t.x - w / 2;
  pts.push([x0, t.y - st.size * (d.kind === "arc" ? 1.4 : 1)], [x0 + w, t.y + 1]);
  return pts;
}

function textSpot(p: P2, a: number, size: number): { x: number; y: number; anchor: "start" | "middle" | "end" } {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const anchor = c > 0.35 ? "start" : c < -0.35 ? "end" : "middle";
  // above the arc the text stands on the point, below it hangs from it, beside it centres on it
  return { x: p[0], y: s < -0.35 ? p[1] + size * 0.75 : p[1] + (Math.abs(s) <= 0.35 ? size * 0.35 : 0), anchor };
}

export function arcGeom(d: DimDef, C: P2, scale: number, st: { size: number; arrow: number; first: number }) {
  const a = d.arc!;
  const s0 = a.a0;
  const sw = a.a1 - a.a0;
  const R = a.r * scale + (d.offset ?? st.first * 0.8);
  const at = (t: number, r: number): P2 => [C[0] + r * Math.cos(t), C[1] - r * Math.sin(t)];
  return { s0, sw, R, mid: s0 + sw / 2, at, lens: [a.r * scale, a.r * scale] };
}

/** Inks an angle (or arc length) dimension: the arc between the legs, arrows, extension lines and text. */
export function inkAngle(ink: Ink, d: DimDef, V: P2, scale: number, st: { size: number; arrow: number; first: number }, inkText: (t: DimText, x: number, y: number, anchor: "start" | "middle") => void) {
  const arc = d.kind === "arc";
  const g = arc ? arcGeom(d, V, scale, st) : angleGeom(d, V, scale, st);
  const { s0, sw, R, mid, at } = g;
  const gap = 1;
  const over = 1.5;
  // extension lines where the legs (or the arc's radii) stop short of the dimension arc
  for (const [k, a] of [s0, s0 + sw].entries()) {
    const reach = arc ? g.lens[0] : g.lens[k];
    if (arc || R + over > reach - 0.5) {
      const p = at(a, reach + gap);
      const q = at(a, R + over);
      ink.line(p[0], p[1], q[0], q[1]);
    }
  }
  ink.arc(V[0], V[1], R, s0, s0 + sw, "thin");
  const e0 = at(s0, R);
  const e1 = at(s0 + sw, R);
  // tangents: clockwise at the start, counter-clockwise at the end
  ink.arrow(e0[0], e0[1], Math.sin(s0), Math.cos(s0), st.arrow);
  ink.arrow(e1[0], e1[1], -Math.sin(s0 + sw), -Math.cos(s0 + sw), st.arrow);
  const t = textSpot(at(mid, R + st.size * 0.9), mid, st.size);
  const w = textWidth(d.text.main, st.size);
  const x0 = t.anchor === "start" ? t.x : t.anchor === "end" ? t.x - w - (d.text.suffix ? textWidth(" " + d.text.suffix, st.size) : 0) : t.x - w / 2;
  inkText(d.text, x0, t.y, "start");
  if (arc) {
    // the arc symbol over the value (ISO 129-1)
    const c = x0 + w / 2;
    const half = Math.min(w / 2, st.size * 0.6);
    const pts: number[] = [];
    for (let k = 0; k <= 8; k++) {
      const x = -half + (2 * half * k) / 8;
      pts.push(c + x, t.y - st.size * 0.95 - st.size * 0.28 * (1 - (x / half) ** 2));
    }
    ink.poly(pts, "thin");
  }
}

// ---------- surface texture (ISO 21920-1) ----------

/** Height of a surface texture symbol for a text size, and its width. */
export function finishSize(f: Finish, size: number): { w: number; h: number } {
  const H1 = size;
  const H2 = size * 2.15;
  const req = [f.ra !== undefined ? `Ra ${fmtNum(f.ra, 3)}` : "", f.rz !== undefined ? `Rz ${fmtNum(f.rz, 3)}` : ""].filter(Boolean).join(" ");
  const tw = Math.max(textWidth(req, size * 0.8), f.process ? textWidth(f.process.toUpperCase(), size * 0.8) : 0);
  return { w: H1 * 0.577 + H2 * 0.577 + (tw ? tw + 1.8 : 0) + 0.5, h: H2 + (f.process ? size * 0.9 : 0) };
}

/** Draws the symbol with its point at (x, y), standing up; returns its box. */
export function inkFinish(ink: Ink, x: number, y: number, f: Finish, size: number): Box {
  const H1 = size;
  const H2 = size * 2.15;
  const k = 0.577;
  const s = size * 0.8;
  ink.line(x - H1 * k, y - H1, x, y);
  ink.line(x, y, x + H2 * k, y - H2);
  if (f.removal === "required") ink.line(x - H1 * k, y - H1, x + H1 * k, y - H1);
  if (f.removal === "prohibited") ink.circle(x, y - H1 * 0.62, H1 * 0.31, "thin");
  const req = [f.ra !== undefined ? `Ra ${fmtNum(f.ra, 3)}` : "", f.rz !== undefined ? `Rz ${fmtNum(f.rz, 3)}` : ""].filter(Boolean).join(" ");
  const top = y - H2;
  const tx = x + H2 * k;
  const tw = Math.max(textWidth(req, s), f.process ? textWidth(f.process.toUpperCase(), s) : 0);
  if (tw) {
    ink.line(tx, top, tx + tw + 1.8, top);
    // the requirement under the line, the process above it
    const base = top + s * 0.95;
    if (req) ink.text(x + (y - base) * k + 0.9, base, req, s);
    if (f.process) ink.text(tx + 0.6, top - 0.7, f.process.toUpperCase(), s);
  }
  if (f.lay) {
    const lx = x + H1 * k * 0.9 + 0.8;
    const ly = y - 0.3;
    if (f.lay === "⊥" || f.lay.toLowerCase() === "perp") {
      ink.line(lx + s * 0.35, ly, lx + s * 0.35, ly - s * 0.75);
      ink.line(lx, ly, lx + s * 0.7, ly);
    } else ink.text(lx, ly, f.lay, s);
  }
  const { w, h } = finishSize(f, size);
  return [x - H1 * k, y - h, x - H1 * k + w, y];
}

/** The general requirement by the title block: the symbol, then a basic symbol in brackets when features have their own. */
export function generalFinishSize(f: Finish, size: number, others = true): { w: number; h: number } {
  const big = size * 1.25;
  const m = finishSize(f, big);
  return { w: m.w + (others ? textWidth("(", big) * 2 + finishSize({ removal: f.removal }, big * 0.8).w + 2.5 : 0), h: m.h };
}

/** Inks the general surface texture requirement with its right edge at x and its point on y. */
export function inkGeneralFinish(ink: Ink, right: number, y: number, f: Finish, size: number, others = true): Box {
  const big = size * 1.25;
  const { w, h } = generalFinishSize(f, size, others);
  const x0 = right - w;
  const k = 0.577 * big;
  ink.with("n", () => {
    const b = inkFinish(ink, x0 + k, y, f, big);
    if (!others) return;
    const bw = textWidth("(", big);
    let x = b[2] + 1;
    ink.text(x, y - big * 0.2, "(", big);
    x += bw + 0.3;
    const basic: Finish = { removal: f.removal };
    inkFinish(ink, x + k, y - big * 0.1, basic, big * 0.8);
    x += finishSize(basic, big * 0.8).w + 0.3;
    ink.text(x, y - big * 0.2, ")", big);
  });
  return [x0, y - h, right, y];
}

// ---------- welds (ISO 2553, system A) ----------

export function weldSizeOnPaper(w: WeldMark, size: number): { w: number; h: number } {
  const s = size * 0.85;
  const left = weldSize(w);
  const right = w.length ?? "";
  const tail = w.note ? textWidth(w.note, s) + 4 : 0;
  return { w: 4 + (left ? textWidth(left, s) + 1 : 0) + size * 1.4 + (right ? textWidth(right, s) + 1.5 : 0) + 4 + tail, h: size * 1.6 + (w.field ? size * 1.4 : 0) + 2 };
}

/** The reference line from the leader's end (E) toward side sx, the dashed identification line, the symbol and its sizes. */
export function inkWeld(ink: Ink, E: P2, sx: number, w: WeldMark, size: number): Box {
  const s = size * 0.85;
  const { w: L } = weldSizeOnPaper(w, size);
  const tail = w.note ? textWidth(w.note, s) + 4 : 0;
  const x0 = E[0];
  const y = E[1];
  const x1 = x0 + sx * (L - tail);
  ink.line(x0, y, x1, y);
  const both = w.side === "both";
  const centredK = centred(w.kind);
  // the dashed line, under the continuous one, for one-sided welds
  const dash = 1.2;
  if (!both && !centredK) ink.line(x0 + sx * 1, y + dash, x1, y + dash, "hidden");
  const h = size * 1.1;
  // symbol position: after the size on the side the text reads from
  const left = weldSize(w);
  const lw = left ? textWidth(left, s) + 1 : 0;
  const from = Math.min(x0, x1);
  const symX = from + (sx > 0 ? 4 + lw : 4 + (w.length ? textWidth(w.length, s) + 1.5 : 0) + tail * 0);
  const sides: ("up" | "down")[] = centredK ? [] : both ? ["up", "down"] : w.side === "arrow" ? ["up"] : ["down"];
  const base = (dir: "up" | "down") => (dir === "up" ? y : y + dash);
  for (const dir of sides) weldGlyph(ink, w.kind, symX, base(dir), dir === "up" ? -1 : 1, h);
  if (centredK) weldGlyph(ink, w.kind, symX, y, 0, h);
  // size before the symbol, length after it
  const textY = (dir: "up" | "down") => (dir === "up" ? y - 0.8 : y + dash + s * 0.95);
  const ty = sides[0] ? textY(sides[0]) : y - h * 0.55 - 0.8;
  if (left) ink.text(symX - 1, ty, left, s, "end");
  if (w.length) ink.text(symX + h + 1.5, ty, w.length, s);
  if (both && left) ink.text(symX - 1, textY("down"), left, s, "end");
  // all round: a circle at the bend; site weld: a flag on a staff
  if (w.allRound) ink.circle(x0, y, size * 0.45, "thin");
  if (w.field) {
    const top = y - size * 1.6 - 1;
    ink.line(x0, y, x0, top);
    ink.fill([x0, top, x0 + sx * size * 0.9, top + size * 0.35, x0, top + size * 0.7]);
  }
  // the tail carries the process or other notes
  if (w.note) {
    const tx = x1;
    ink.line(tx, y, tx + sx * 2, y - 2);
    ink.line(tx, y, tx + sx * 2, y + 2);
    ink.text(tx + sx * 2.8, y + s * 0.35, w.note, s, sx > 0 ? "start" : "end");
  }
  const xs = [x0, x1 + sx * tail];
  return [Math.min(...xs), y - (w.field ? size * 1.6 + 1 : h + 1), Math.max(...xs), y + dash + s + 1];
}

/** One weld symbol standing on the reference line at (x, y): up (−1), down (+1) or centred (0). */
function weldGlyph(ink: Ink, kind: WeldMark["kind"], x: number, y: number, dir: -1 | 0 | 1, h: number) {
  const up = (dy: number) => y + dir * dy;
  switch (kind) {
    case "fillet":
      ink.poly([x, up(0), x, up(h), x + h, up(0)], "thin", true);
      break;
    case "square":
      ink.line(x + h * 0.2, up(0), x + h * 0.2, up(h));
      ink.line(x + h * 0.8, up(0), x + h * 0.8, up(h));
      break;
    case "v":
      ink.line(x, up(h), x + h / 2, up(0));
      ink.line(x + h / 2, up(0), x + h, up(h));
      break;
    case "bevel":
      ink.line(x + h * 0.2, up(0), x + h * 0.2, up(h));
      ink.line(x + h * 0.2, up(0), x + h * 0.9, up(h));
      break;
    case "u": {
      const r = h * 0.35;
      ink.line(x + h / 2, up(0), x + h / 2, up(h * 0.25));
      // the bowl, opening away from the line
      const cy = up(h * 0.25 + r);
      ink.arc(x + h / 2, cy, r, dir < 0 ? Math.PI : 0, dir < 0 ? Math.PI * 2 : Math.PI, "thin");
      ink.line(x + h / 2 - r, cy, x + h / 2 - r, up(h));
      ink.line(x + h / 2 + r, cy, x + h / 2 + r, up(h));
      break;
    }
    case "j": {
      const r = h * 0.4;
      ink.line(x + h * 0.2, up(0), x + h * 0.2, up(h));
      const cy = up(h * 0.25 + r);
      ink.arc(x + h * 0.2, cy, r, dir < 0 ? Math.PI * 1.5 : 0, dir < 0 ? Math.PI * 2 : Math.PI * 0.5, "thin");
      ink.line(x + h * 0.2 + r, cy, x + h * 0.2 + r, up(h));
      break;
    }
    case "plug":
      ink.poly([x, up(0), x, up(h * 0.6), x + h, up(h * 0.6), x + h, up(0)], "thin");
      break;
    case "spot":
      ink.circle(x + h / 2, y, h * 0.45, "thin");
      break;
    case "seam":
      ink.circle(x + h / 2, y, h * 0.45, "thin");
      ink.line(x - 0.2, y - h * 0.15, x + h + 0.2, y - h * 0.15);
      ink.line(x - 0.2, y + h * 0.15, x + h + 0.2, y + h * 0.15);
      break;
    case "edge":
      ink.line(x + h * 0.25, up(0), x + h * 0.25, up(h * 0.6));
      ink.line(x + h * 0.75, up(0), x + h * 0.75, up(h * 0.6));
      ink.arc(x + h * 0.5, up(h * 0.6), h * 0.25, dir < 0 ? 0 : Math.PI, dir < 0 ? Math.PI : Math.PI * 2, "thin");
      break;
  }
}
