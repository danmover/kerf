// Trim, extend and offset for the sketch editor. Like every sketch edit
// these take the source text and return new text. A trimmed curve keeps
// its name and the constraints that still make sense; its new end is tied
// to the curve it was cut at. Cutting a piece out of the middle leaves a
// second curve kept in line with the first (or on the same circle), and
// trimming a circle turns it into an arc. Extending runs a loose end on to
// the next curve it meets.

import type { V2 } from "../kernel/recipe";
import { applyChanges, bodyInsertAt, deleteSelection, fmt, fmtPt, lineEnd, lineSpan, nextName, PREFIX, takenNames, type Change } from "./edits";
import type { EvalSketch, SkConstraint, SkCurve } from "./types";

const TAU = 2 * Math.PI;
const wrap = (a: number) => ((a % TAU) + TAU) % TAU;

/** A curve as solved: lines run from a to b; arcs go anticlockwise from angle t0 through sweep. */
export type Geo = { kind: "line"; a: V2; b: V2 } | { kind: "circle"; c: V2; r: number } | { kind: "arc"; c: V2; r: number; t0: number; sweep: number };

const pos = (sk: EvalSketch, id: string): V2 => {
  const p = sk.points.find((q) => q.id === id) ?? sk.points.find((q) => q.id === sk.aliases[id]);
  return p ? [p.x, p.y] : [0, 0];
};

export function geoOf(sk: EvalSketch, c: SkCurve): Geo {
  if (c.kind === "line") return { kind: "line", a: pos(sk, c.pts[0]), b: pos(sk, c.pts[1]) };
  if (c.kind === "circle") return { kind: "circle", c: pos(sk, c.pts[0]), r: c.r ?? 1 };
  const [a, b, cc] = c.pts.map((id) => pos(sk, id));
  const t0 = Math.atan2(a[1] - cc[1], a[0] - cc[0]);
  let sweep = wrap(Math.atan2(b[1] - cc[1], b[0] - cc[0]) - t0);
  if (sweep < 1e-12) sweep = TAU;
  return { kind: "arc", c: cc, r: Math.hypot(a[0] - cc[0], a[1] - cc[1]), t0, sweep };
}

/** The point at parameter t: 0..1 along a line or an arc, 0..1 once round a circle (outside 0..1 runs on past the ends). */
export function pointAt(g: Geo, t: number): V2 {
  if (g.kind === "line") return [g.a[0] + t * (g.b[0] - g.a[0]), g.a[1] + t * (g.b[1] - g.a[1])];
  const th = g.kind === "circle" ? t * TAU : g.t0 + t * g.sweep;
  return [g.c[0] + g.r * Math.cos(th), g.c[1] + g.r * Math.sin(th)];
}

/** The parameter nearest p (lines: along the infinite line; arcs: 0..2π/sweep once round from the start). */
export function paramOf(g: Geo, p: V2): number {
  if (g.kind === "line") {
    const d: V2 = [g.b[0] - g.a[0], g.b[1] - g.a[1]];
    return ((p[0] - g.a[0]) * d[0] + (p[1] - g.a[1]) * d[1]) / Math.max(d[0] * d[0] + d[1] * d[1], 1e-24);
  }
  const th = Math.atan2(p[1] - g.c[1], p[0] - g.c[0]);
  return g.kind === "circle" ? wrap(th) / TAU : wrap(th - g.t0) / g.sweep;
}

/** Points along a curve between two parameters, for drawing a preview. */
export function samplePiece(g: Geo, t0: number, t1: number, n = 24): V2[] {
  if (g.kind === "line") return [pointAt(g, t0), pointAt(g, t1)];
  return Array.from({ length: n + 1 }, (_, k) => pointAt(g, t0 + ((t1 - t0) * k) / n));
}

/** Where the infinite carrier of curve g (a line, or the whole circle) crosses curve h, within h's own extent. */
function crossings(g: Geo, h: Geo, tol: number): V2[] {
  const out: V2[] = [];
  const within = (p: V2) => {
    if (h.kind === "line") {
      const u = paramOf(h, p);
      const L = Math.hypot(h.b[0] - h.a[0], h.b[1] - h.a[1]);
      return u >= -tol / L && u <= 1 + tol / L;
    }
    if (h.kind === "circle") return true;
    const u = wrap(Math.atan2(p[1] - h.c[1], p[0] - h.c[0]) - h.t0);
    const slack = tol / Math.max(h.r, 1e-9);
    return u <= h.sweep + slack || u >= TAU - slack;
  };
  const carrierLine = (x: Geo): [V2, V2] | null => (x.kind === "line" ? [x.a, x.b] : null);
  const circleOf = (x: Geo): [V2, number] | null => (x.kind === "line" ? null : [x.c, x.r]);
  const lg = carrierLine(g);
  const lh = carrierLine(h);
  const cg = circleOf(g);
  const ch = circleOf(h);
  const lineCircle = ([p, q]: [V2, V2], [c, r]: [V2, number]) => {
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const A = dx * dx + dy * dy;
    const B = 2 * (dx * (p[0] - c[0]) + dy * (p[1] - c[1]));
    const C = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 - r * r;
    let disc = B * B - 4 * A * C;
    // a line just touching: one crossing
    if (disc < 0 && disc > -1e-9 * A * Math.max(r * r, 1)) disc = 0;
    if (A <= 0 || disc < 0) return [] as V2[];
    const ts = disc === 0 ? [-B / (2 * A)] : [(-B - Math.sqrt(disc)) / (2 * A), (-B + Math.sqrt(disc)) / (2 * A)];
    return ts.map((t): V2 => [p[0] + t * dx, p[1] + t * dy]);
  };
  let pts: V2[] = [];
  if (lg && lh) {
    const d1: V2 = [lg[1][0] - lg[0][0], lg[1][1] - lg[0][1]];
    const d2: V2 = [lh[1][0] - lh[0][0], lh[1][1] - lh[0][1]];
    const den = d1[0] * d2[1] - d1[1] * d2[0];
    if (Math.abs(den) > 1e-12 * Math.hypot(...d1) * Math.hypot(...d2)) {
      const t = ((lh[0][0] - lg[0][0]) * d2[1] - (lh[0][1] - lg[0][1]) * d2[0]) / den;
      pts = [[lg[0][0] + t * d1[0], lg[0][1] + t * d1[1]]];
    }
  } else if (lg && ch) pts = lineCircle(lg, ch);
  else if (cg && lh) pts = lineCircle(lh, cg);
  else if (cg && ch) {
    const [c1, r1] = cg;
    const [c2, r2] = ch;
    const D = Math.hypot(c2[0] - c1[0], c2[1] - c1[1]);
    if (D > 1e-12 && D <= r1 + r2 + tol && D >= Math.abs(r1 - r2) - tol) {
      const a = (r1 * r1 - r2 * r2 + D * D) / (2 * D);
      const hh = Math.sqrt(Math.max(0, r1 * r1 - a * a));
      const m: V2 = [c1[0] + (a * (c2[0] - c1[0])) / D, c1[1] + (a * (c2[1] - c1[1])) / D];
      pts = hh < 1e-12 ? [m] : [-1, 1].map((sg): V2 => [m[0] + (sg * hh * -(c2[1] - c1[1])) / D, m[1] + (sg * hh * (c2[0] - c1[0])) / D]);
    }
  }
  for (const p of pts) if (within(p)) out.push(p);
  return out;
}

/** Where another curve crosses this one: the parameter here, the point, the curve, and that curve's end point when it lands on one. */
export interface Cut {
  t: number;
  p: V2;
  with: string;
  at?: string;
}

/** Every crossing of curve `id`'s carrier with the other curves (construction and projected ones too), by parameter. */
export function cutsOn(sk: EvalSketch, id: string): Cut[] {
  const c = sk.curves.find((q) => q.id === id);
  if (!c) return [];
  const g = geoOf(sk, c);
  const size = scaleOf(sk);
  const tol = 1e-7 * size;
  const out: Cut[] = [];
  for (const o of sk.curves) {
    if (o.id === id) continue;
    const h = geoOf(sk, o);
    for (const p of crossings(g, h, tol)) {
      let t = paramOf(g, p);
      // arcs: before the start reads as a large parameter; the editor wants the nearer way round
      if (g.kind === "arc" && t > 1 && t - 1 > TAU / g.sweep - t) t -= TAU / g.sweep;
      const ends = o.kind === "circle" ? [] : [0, 1].map((k) => ({ name: `${o.id}.${k ? "end" : "start"}`, at: pos(sk, o.pts[k]) }));
      const land = ends.find((e) => Math.hypot(e.at[0] - p[0], e.at[1] - p[1]) < 1e-6 * size);
      out.push({ t, p, with: o.id, at: land?.name });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

function scaleOf(sk: EvalSketch): number {
  let m = 1;
  for (const p of sk.points) m = Math.max(m, Math.abs(p.x), Math.abs(p.y));
  return m;
}

/** The piece of curve `id` a click at p would trim, between the crossings either side of it. */
export interface Piece {
  id: string;
  /** whole: no crossing, the curve goes; start / end: an end piece; middle: cut out of the middle; circle: part of a circle */
  kind: "whole" | "start" | "end" | "middle" | "circle";
  t0: number;
  t1: number;
  before?: Cut;
  after?: Cut;
  /** for drawing the piece that goes */
  pts: V2[];
}

export function pieceAt(sk: EvalSketch, id: string, p: V2): Piece | null {
  const c = sk.curves.find((q) => q.id === id);
  if (!c) return null;
  const g = geoOf(sk, c);
  const tc = paramOf(g, p);
  const cuts = cutsOn(sk, id);
  const eps = 1e-6;
  if (g.kind === "circle") {
    // crossings once round, without repeats
    const ts = [...new Set(cuts.map((k) => Math.round(wrap(k.t * TAU) * 1e9) / 1e9))].sort((a, b) => a - b).map((a) => a / TAU);
    if (ts.length < 2) return { id, kind: "whole", t0: 0, t1: 1, pts: samplePiece(g, 0, 1, 48) };
    let i = ts.findIndex((t) => t > tc);
    if (i < 0) i = 0;
    const t1 = ts[i];
    const t0 = ts[(i - 1 + ts.length) % ts.length];
    const near = (t: number) => cuts.find((k) => Math.abs(wrap(k.t * TAU) - t * TAU) < 1e-7)!;
    const a = t0 < t1 ? t0 : t0 - 1;
    return { id, kind: "circle", t0: a, t1, before: near(t0), after: near(t1), pts: samplePiece(g, a, t1, 32) };
  }
  const inside = cuts.filter((k) => k.t > eps && k.t < 1 - eps);
  const clamped = Math.min(1, Math.max(0, tc));
  const before = [...inside].reverse().find((k) => k.t < clamped);
  const after = inside.find((k) => k.t > clamped);
  const t0 = before?.t ?? 0;
  const t1 = after?.t ?? 1;
  const kind = before && after ? "middle" : before ? "end" : after ? "start" : "whole";
  return { id, kind, t0, t1, before, after, pts: samplePiece(g, t0, t1) };
}

type Result = { src: string; message: string } | { error: string };

/** Text pieces shared by trim and extend. */
function editor(src: string, sk: EvalSketch) {
  const changes: Change[] = [];
  const added: string[] = [];
  const dropped = new Set<number>();
  const argText = (c: SkCurve, k: number) => src.slice(c.argSpans[k].start, c.argSpans[k].end);
  const isLiteral = (c: SkCurve, k: number) => /^\(\s*-?[\d.]+(e-?\d+)?\s*,\s*-?[\d.]+(e-?\d+)?\s*\)$/.test(argText(c, k).trim());
  const canon = (name: string) => sk.aliases[name] ?? name;
  const drop = (k: SkConstraint) => {
    if (dropped.has(k.index)) return;
    dropped.add(k.index);
    const s = lineSpan(src, k.span);
    changes.push({ from: s.start, to: s.end, insert: "" });
  };
  /** Replace constraint arguments written as `from` with `to`, or drop those constraints when `to` is null. */
  const rename = (from: string, to: string | null) => {
    for (const k of sk.constraints) {
      if (k.made || dropped.has(k.index)) continue;
      k.args.forEach((a, i) => {
        if (a !== from) return;
        if (to === null) drop(k);
        else changes.push({ from: k.argSpans[i].start, to: k.argSpans[i].end, insert: to });
      });
    }
  };
  /** Constraints that size curve `id` as a whole stop making sense when an end moves. */
  const dropSizes = (id: string) => {
    for (const k of sk.constraints) {
      if (k.made || dropped.has(k.index)) continue;
      const whole = k.ids.length === 1 && k.ids[0] === id;
      if ((k.kind === "length" && whole) || ((k.kind === "hdistance" || k.kind === "vdistance") && whole)) drop(k);
      else if (k.kind === "equal" && k.ids.includes(id) && sk.curves.find((c) => c.id === id)?.kind === "line") {
        const keep = k.args.filter((_, i) => k.ids[i] !== id);
        if (keep.length >= 2) changes.push({ from: k.span.start, to: k.span.end, insert: `equal ${keep.join(", ")}` });
        else drop(k);
      }
    }
  };
  const finish = (message: string): Result => {
    if (added.length) {
      // on lines of their own before the closing brace, clear of anything removed above
      const close = sk.bodyEnd;
      const ls = src.lastIndexOf("\n", close - 1) + 1;
      if (ls > 0 && /^[ \t]*$/.test(src.slice(ls, close))) changes.push({ from: ls, to: ls, insert: added.map((l) => `${sk.indent}${l}\n`).join("") });
      else {
        const at = bodyInsertAt(src, sk);
        changes.push({ from: at, to: at, insert: added.map((l) => `\n${sk.indent}${l}`).join("") });
      }
    }
    return { src: applyChanges(src, changes), message };
  };
  /**
   * Move one end of curve c to p, leaving whatever else met there where it was:
   * when c owned the point, the next curve that used it takes it over.
   */
  const moveEnd = (c: SkCurve, k: 0 | 1, p: V2, survivorFor?: string) => {
    const role = k ? "end" : "start";
    const pid = c.pts[k];
    const others = sk.curves.filter((o) => o.id !== c.id && !o.derived && !o.external && o.pts.includes(pid) && o.argSpans.length);
    const own = isLiteral(c, k);
    changes.push({ from: c.argSpans[k].start, to: c.argSpans[k].end, insert: fmtPt(p) });
    const written = `${c.id}.${role}`;
    if (survivorFor) {
      // a split: the far piece keeps the old end, under its own name
      for (const o of others) o.pts.forEach((q, j) => q === pid && argText(o, j) === written && changes.push({ from: o.argSpans[j].start, to: o.argSpans[j].end, insert: survivorFor }));
      rename(written, survivorFor);
      return;
    }
    if (!others.length) {
      rename(written, null);
      return;
    }
    if (!own) {
      // c started on someone else's point: they keep it, and names written through c now mean the shared point
      rename(written, canon(written));
      return;
    }
    // c owned it: the first other curve takes it over as plain coordinates, the rest share that
    const sorted = [...others].sort((a, b) => a.span.start - b.span.start);
    const first = sorted[0];
    const j = first.pts.indexOf(pid);
    const name = `${first.id}.${first.kind === "circle" ? "center" : j === 0 ? "start" : j === 1 ? "end" : "center"}`;
    changes.push({ from: first.argSpans[j].start, to: first.argSpans[j].end, insert: fmtPt(pos(sk, pid)) });
    for (const o of sorted.slice(1)) o.pts.forEach((q, i) => q === pid && changes.push({ from: o.argSpans[i].start, to: o.argSpans[i].end, insert: name }));
    rename(written, name);
  };
  const tieTo = (name: string, cut: Cut) => added.push(`coincident ${name}, ${cut.at ?? cut.with}`);
  return { changes, added, argText, isLiteral, moveEnd, dropSizes, tieTo, finish, drop };
}

const editable = (c: SkCurve | undefined): string | null =>
  !c ? "Nothing to trim there" : c.external ? `${c.id} is projected from another sketch; change it there` : c.derived !== undefined ? `${c.id} is a copy made by a mirror, pattern or offset; trim the original, or delete the copy` : null;

/** Trim the piece of curve `id` a click at p is on, back to the crossings either side of it (the whole curve when nothing crosses it). */
export function trimAt(src: string, sk: EvalSketch, id: string, p: V2): Result {
  const c = sk.curves.find((q) => q.id === id);
  const why = editable(c);
  if (why) return { error: why };
  const piece = pieceAt(sk, id, p)!;
  if (piece.kind === "whole") return { src: deleteSelection(src, sk, [id]), message: `deleted ${id}, which nothing crosses` };
  const E = editor(src, sk);
  if (piece.kind === "circle") {
    // the rest of the circle stays, as an arc from the crossing after the click round to the one before
    const g = geoOf(sk, c!);
    const a = pointAt(g, piece.t1);
    const b = pointAt(g, piece.t0);
    const center = E.argText(c!, 0);
    E.changes.push({ from: c!.span.start, to: c!.span.end, insert: `${c!.construction ? "construction " : ""}arc ${id} = ${fmtPt(a)} -> ${fmtPt(b)}, center: ${center}` });
    E.tieTo(`${id}.start`, piece.after!);
    E.tieTo(`${id}.end`, piece.before!);
    return E.finish(`trimmed ${id} into an arc`);
  }
  if (piece.kind === "start") {
    E.moveEnd(c!, 0, piece.after!.p);
    if (c!.kind === "line") E.dropSizes(id);
    E.tieTo(`${id}.start`, piece.after!);
    return E.finish(`trimmed the start of ${id} back to ${piece.after!.with}`);
  }
  if (piece.kind === "end") {
    E.moveEnd(c!, 1, piece.before!.p);
    if (c!.kind === "line") E.dropSizes(id);
    E.tieTo(`${id}.end`, piece.before!);
    return E.finish(`trimmed the end of ${id} back to ${piece.before!.with}`);
  }
  // the middle: c keeps its start, a new curve takes the far end
  const name = nextName(takenNames(sk), PREFIX[c!.kind]);
  const endText = E.argText(c!, 1);
  const g = geoOf(sk, c!);
  const from = pointAt(g, piece.t1);
  const centerName = c!.kind === "arc" ? (E.isLiteral(c!, 2) ? `${id}.center` : E.argText(c!, 2)) : "";
  const stmt = c!.kind === "line" ? `${c!.construction ? "construction " : ""}line ${name} = ${fmtPt(from)} -> ${endText}` : `${c!.construction ? "construction " : ""}arc ${name} = ${fmtPt(from)} -> ${endText}, center: ${centerName}`;
  const at = lineEnd(src, c!.span.end);
  E.changes.push({ from: at, to: at, insert: `\n${sk.indent}${stmt}` });
  E.moveEnd(c!, 1, pointAt(g, piece.t0), `${name}.end`);
  if (c!.kind === "line") E.dropSizes(id);
  E.tieTo(`${id}.end`, piece.before!);
  E.tieTo(`${name}.start`, piece.after!);
  E.added.push(c!.kind === "line" ? `collinear ${id}, ${name}` : `equal ${id}, ${name}`);
  return E.finish(`cut the middle out of ${id}, leaving ${id} and ${name}`);
}

/** Where extending curve `id` from the end nearer p would reach: the end, and the first crossing past it. */
export function extensionAt(sk: EvalSketch, id: string, p: V2): { end: 0 | 1; cut: Cut; pts: V2[] } | null {
  const c = sk.curves.find((q) => q.id === id);
  if (!c || c.kind === "circle") return null;
  const g = geoOf(sk, c);
  const a = pos(sk, c.pts[0]);
  const b = pos(sk, c.pts[1]);
  const end: 0 | 1 = Math.hypot(p[0] - a[0], p[1] - a[1]) < Math.hypot(p[0] - b[0], p[1] - b[1]) ? 0 : 1;
  const eps = 1e-6;
  const cuts = cutsOn(sk, id).filter((k) => (end ? k.t > 1 + eps : k.t < -eps));
  const cut = end ? cuts[0] : cuts[cuts.length - 1];
  if (!cut) return null;
  return { end, cut, pts: samplePiece(g, end ? 1 : cut.t, end ? cut.t : 0) };
}

/** Run a loose end of a line or arc on to the next curve it meets. */
export function extendAt(src: string, sk: EvalSketch, id: string, p: V2): Result {
  const c = sk.curves.find((q) => q.id === id);
  const why = editable(c);
  if (why) return { error: why.replace("Nothing to trim", "Nothing to extend").replace("trim the original", "extend the original") };
  if (c!.kind === "circle") return { error: `${id} is a circle; it has no end to extend` };
  const ext = extensionAt(sk, id, p);
  const role = ext?.end ? "end" : "start";
  if (!ext) return { error: `Nothing is in the way past that end of ${id} for it to reach` };
  const pid = c!.pts[ext.end];
  const joined = sk.curves.find((o) => o.id !== id && (o.kind === "line" ? o.pts.includes(pid) : o.kind === "arc" && o.pts.indexOf(pid) >= 0 && o.pts.indexOf(pid) < 2));
  if (joined) return { error: `The ${role} of ${id} joins ${joined.id}; only a loose end can be extended` };
  const E = editor(src, sk);
  E.moveEnd(c!, ext.end, ext.cut.p);
  if (c!.kind === "line") E.dropSizes(id);
  E.tieTo(`${id}.${role}`, ext.cut);
  return E.finish(`extended ${id} to ${ext.cut.with}`);
}

/** The curves joined end to end with `id` (stopping where three meet), in order, for offset. A circle is a chain of one. */
export function chainFrom(sk: EvalSketch, id: string): string[] {
  const c = sk.curves.find((q) => q.id === id);
  if (!c) return [];
  if (c.kind === "circle") return [id];
  const ends = (x: SkCurve) => [x.pts[0], x.pts[1]];
  const same = sk.curves.filter((x) => x.kind !== "circle" && x.construction === c.construction);
  const at = (pid: string) => same.filter((x) => ends(x).includes(pid));
  const chain = [c];
  const walk = (pid: string, push: (x: SkCurve) => void) => {
    for (let guard = 0; guard < 1000; guard++) {
      const here = at(pid);
      if (here.length !== 2) return;
      const nx = here.find((x) => !chain.includes(x));
      if (!nx) return;
      push(nx);
      pid = ends(nx)[0] === pid ? ends(nx)[1] : ends(nx)[0];
    }
  };
  walk(c.pts[1], (x) => chain.push(x));
  walk(c.pts[0], (x) => chain.unshift(x));
  // the clicked curve first, the rest in the order they join
  const i = chain.indexOf(c);
  return [...chain.slice(i), ...chain.slice(0, i)].map((x) => x.id);
}

/**
 * Which way offset by: d goes for a cursor at p: the signed by: that puts
 * the copy on the cursor's side at its distance, as the offset statement
 * reads it (outward from a closed loop for d > 0; left of the walk from the
 * first curve's start for an open chain), and the copy's outline for a
 * preview.
 */
export function offsetFor(sk: EvalSketch, ids: string[], p: V2, opts: { distance?: number; step?: number } = {}): { by: number; pts: V2[][] } | null {
  const curves = ids.map((id) => sk.curves.find((q) => q.id === id)).filter((c): c is SkCurve => !!c);
  if (!curves.length) return null;
  // how far: as typed, or the cursor's distance on round numbers for the zoom
  const far = (d: number) => (opts.distance && opts.distance > 0 ? opts.distance : opts.step ? Math.max(opts.step, Math.round(d / opts.step) * opts.step) : d);
  if (curves[0].kind === "circle") {
    const g = geoOf(sk, curves[0]) as Extract<Geo, { kind: "circle" }>;
    const out = Math.hypot(p[0] - g.c[0], p[1] - g.c[1]) - g.r;
    const by = Math.sign(out || 1) * far(Math.abs(out));
    if (g.r + by <= 1e-6) return null;
    return { by, pts: [samplePiece({ ...g, r: g.r + by }, 0, 1, 64)] };
  }
  // walk the chain as the statement does: the first curve forward, the rest following
  type El = { c: SkCurve; g: Geo; rev: boolean };
  const order: El[] = [{ c: curves[0], g: geoOf(sk, curves[0]), rev: false }];
  const left = new Set(curves.slice(1));
  let head = curves[0].pts[1];
  let tail = curves[0].pts[0];
  for (let guard = 0; left.size && guard < 1000; guard++) {
    const fwd = [...left].find((x) => x.pts[0] === head || x.pts[1] === head);
    if (fwd) {
      order.push({ c: fwd, g: geoOf(sk, fwd), rev: fwd.pts[1] === head });
      head = fwd.pts[1] === head ? fwd.pts[0] : fwd.pts[1];
      left.delete(fwd);
      continue;
    }
    const back = [...left].find((x) => x.pts[0] === tail || x.pts[1] === tail);
    if (!back) break;
    order.unshift({ c: back, g: geoOf(sk, back), rev: back.pts[0] === tail });
    tail = back.pts[0] === tail ? back.pts[1] : back.pts[0];
    left.delete(back);
  }
  const closed = head === tail && order.length > 1;
  const sample = (o: El, n = 16): V2[] => {
    const pts = samplePiece(o.g, 0, 1, n);
    return o.rev ? pts.reverse() : pts;
  };
  // nearest point of the chain, and which side of the walk the cursor is on there
  let best = { d: Infinity, side: 1 };
  for (const o of order) {
    const pts = sample(o);
    for (let i = 0; i + 1 < pts.length; i++) {
      const [a, b] = [pts[i], pts[i + 1]];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const L2 = dx * dx + dy * dy || 1;
      const t = Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
      const q: V2 = [a[0] + t * dx, a[1] + t * dy];
      const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
      if (d < best.d) best = { d, side: dx * (p[1] - a[1]) - dy * (p[0] - a[0]) >= 0 ? 1 : -1 };
    }
  }
  let area = 0;
  if (closed) {
    const ring = order.flatMap((o) => sample(o).slice(0, -1));
    for (let i = 0; i < ring.length; i++) area += ring[i][0] * ring[(i + 1) % ring.length][1] - ring[(i + 1) % ring.length][0] * ring[i][1];
  }
  if (!(best.d > 1e-6)) return null;
  best.d = far(best.d);
  const by = best.side * (closed ? (area > 0 ? -1 : 1) : 1) * best.d;
  // the preview: each curve moved out along its normal
  const pts = order.map((o) => {
    const s = sample(o);
    return s.map((q, i): V2 => {
      const a = s[Math.max(0, i - 1)];
      const b = s[Math.min(s.length - 1, i + 1)];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const n: V2 = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L];
      return [q[0] + best.side * best.d * n[0], q[1] + best.side * best.d * n[1]];
    });
  });
  return { by, pts };
}

/** What a mirror or pattern can copy from a selection: curves and named points (a curve's own end points come with it). */
export function copyable(sk: EvalSketch, selection: string[]): string[] {
  return selection.filter((id) => sk.curves.some((c) => c.id === id) || sk.points.some((p) => p.id === id && !p.implicit && p.id !== "origin"));
}

/** Where each copy of a pattern goes, as a move of the original's points, for a preview (the original itself is left out). */
export function patternMoves(sk: EvalSketch, o: PatternSpec): ((p: V2) => V2)[] {
  const out: ((p: V2) => V2)[] = [];
  if (o.around) {
    const c = sk.curves.find((q) => q.id === o.around);
    const cp = c ? (c.kind === "circle" ? c.pts[0] : c.kind === "arc" ? c.pts[2] : null) : o.around;
    if (!cp || !(sk.points.some((q) => q.id === cp) || sk.aliases[cp])) return out;
    const c0 = pos(sk, cp);
    const total = o.angle ?? 360;
    const dt = Math.abs(Math.abs(total) - 360) < 1e-9 ? total / o.count : total / Math.max(1, o.count - 1);
    for (let k = 1; k < o.count; k++) {
      const th = (dt * k * Math.PI) / 180;
      const [co, si] = [Math.cos(th), Math.sin(th)];
      out.push((p) => [c0[0] + co * (p[0] - c0[0]) - si * (p[1] - c0[1]), c0[1] + si * (p[0] - c0[0]) + co * (p[1] - c0[1])]);
    }
    return out;
  }
  const s1 = o.step ?? [10, 0];
  const n2 = o.count2 && o.count2 > 1 ? o.count2 : 1;
  const s2 = o.step2 ?? [0, 10];
  for (let j = 0; j < n2; j++)
    for (let i = 0; i < o.count; i++) {
      if (!i && !j) continue;
      const d: V2 = [i * s1[0] + j * s2[0], i * s1[1] + j * s2[1]];
      out.push((p) => [p[0] + d[0], p[1] + d[1]]);
    }
  return out;
}

/** A point reflected across the line through a and b. */
export function reflectAcross(a: V2, b: V2): (p: V2) => V2 {
  const d: V2 = [b[0] - a[0], b[1] - a[1]];
  const L2 = d[0] * d[0] + d[1] * d[1] || 1;
  return (p) => {
    const t = ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / L2;
    return [2 * (a[0] + t * d[0]) - p[0], 2 * (a[1] + t * d[1]) - p[1]];
  };
}

export const offsetStatement = (ids: string[], by: number) => `offset ${ids.join(", ")}, by: ${fmt(by)}`;
export const mirrorStatement = (ids: string[], axis: string) => `mirror ${ids.join(", ")}, about: ${axis}`;

export interface PatternSpec {
  count: number;
  /** a row (with an optional second direction for a grid) or a ring */
  step?: V2;
  count2?: number;
  step2?: V2;
  around?: string;
  angle?: number;
}

export function patternStatement(ids: string[], o: PatternSpec): string {
  const parts = [`count: ${o.count}`];
  if (o.around) {
    parts.push(`around: ${o.around}`);
    if (o.angle !== undefined && Math.abs(o.angle - 360) > 1e-9) parts.push(`angle: ${fmt(o.angle)}`);
  } else {
    parts.push(`step: ${fmtPt(o.step ?? [10, 0])}`);
    if (o.count2 && o.count2 > 1) parts.push(`count2: ${o.count2}`, `step2: ${fmtPt(o.step2 ?? [0, 10])}`);
  }
  return `pattern ${ids.join(", ")}, ${parts.join(", ")}`;
}
