// Projecting a part's face into a sketch: the edges round the face become
// sketch lines, arcs and circles, fixed where they are, so new geometry can
// be dimensioned from them or the outline extruded. Edges that do not stay
// round when seen square to the sketch (a circle at an angle, a spline)
// come in as short straight lines. The projection is a copy: it does not
// move if the part changes later.

import type { OutlineEdge } from "../kernel/protocol";
import type { V2, V3 } from "../kernel/recipe";
import { fmt, fmtPt, nextName, takenNames } from "./edits";
import { toLocal } from "./planes";
import type { EvalSketch } from "./types";

/** Centre of the circle through three points, or null when they are in a line. */
function circleThrough(a: V2, b: V2, c: V2): V2 | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] * a[0] + a[1] * a[1];
  const b2 = b[0] * b[0] + b[1] * b[1];
  const c2 = c[0] * c[0] + c[1] * c[1];
  return [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
}

const gap = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * The statements that bring a face's edges (given in the part's own
 * coordinates, with `toWorld` placing them) into sketch `sk`. Curves that
 * meet share their end points, so the outline closes into a profile.
 */
export function projectEdges(sk: EvalSketch, edges: OutlineEdge[], toWorld: (p: V3) => V3, label: string): { geometry: string[]; constraints: string[]; curves: number } {
  const taken = takenNames(sk);
  const geometry: string[] = [`// the edges of ${label}, projected here and fixed (they do not follow later changes to the part)`];
  const fixes: string[] = [];
  const sizes: string[] = [];
  let size = 1;
  const flat = edges.map((e) => e.pts.map((p) => toLocal(sk.frame, toWorld(p))));
  for (const pts of flat) for (const p of pts) size = Math.max(size, Math.abs(p[0]), Math.abs(p[1]));
  const tol = 1e-6 * size;
  // end points already written, so the next curve can start on one
  const ends: { p: V2; name: string }[] = [];
  const endArg = (p: V2) => ends.find((e) => gap(e.p, p) < tol)?.name ?? fmtPt(p);
  const remember = (p: V2, name: string) => {
    if (!ends.some((e) => gap(e.p, p) < tol)) ends.push({ p, name });
  };
  let curves = 0;
  // a face seen edge on, or a cylinder seen end on, lands edges on top of each other: each goes in once
  const done: { k: string; pts: V2[] }[] = [];
  const again = (k: string, pts: V2[], either = false) => {
    const same = (q: V2[]) => q.every((p, i) => gap(p, pts[i]) < tol);
    if (done.some((d) => d.k === k && (same(d.pts) || (either && same([...d.pts].reverse()))))) return true;
    done.push({ k, pts });
    return false;
  };
  const line = (a: V2, b: V2) => {
    if (gap(a, b) < tol || again("l", [a, b], true)) return;
    const id = nextName(taken, "l");
    geometry.push(`line ${id} = ${endArg(a)} -> ${endArg(b)}`);
    remember(a, `${id}.start`);
    remember(b, `${id}.end`);
    fixes.push(id);
    curves++;
  };
  edges.forEach((e, i) => {
    const pts = flat[i];
    if (e.kind === "line") return line(pts[0], pts[pts.length - 1]);
    if (e.kind === "circle" && pts.length >= 5) {
      const closed = gap(pts[0], pts[4]) < tol;
      const c = closed ? circleThrough(pts[0], pts[1], pts[2]) : circleThrough(pts[0], pts[2], pts[4]);
      const r = c ? gap(pts[0], c) : 0;
      // seen at an angle a circle is an ellipse: fall through to straight pieces
      if (c && r > tol && pts.every((p) => Math.abs(gap(p, c) - r) < 1e-4 * Math.max(r, 1))) {
        if (closed) {
          if (again("c", [c, [r, 0]])) return;
          const id = nextName(taken, "c");
          geometry.push(`circle ${id} = ${fmtPt(c)}, r: ${fmt(r)}`);
          fixes.push(id);
          sizes.push(`radius ${id} = ${fmt(r)}`);
        } else {
          const ccw = (pts[2][0] - pts[0][0]) * (pts[4][1] - pts[0][1]) - (pts[2][1] - pts[0][1]) * (pts[4][0] - pts[0][0]) > 0;
          const [a, b] = ccw ? [pts[0], pts[4]] : [pts[4], pts[0]];
          if (again("a", [a, b, c])) return;
          const id = nextName(taken, "a");
          geometry.push(`arc ${id} = ${endArg(a)} -> ${endArg(b)}, center: ${fmtPt(c)}`);
          remember(a, `${id}.start`);
          remember(b, `${id}.end`);
          fixes.push(`${id}.start`, `${id}.end`, `${id}.center`);
        }
        curves++;
        return;
      }
    }
    for (let k = 0; k + 1 < pts.length; k++) line(pts[k], pts[k + 1]);
  });
  const constraints = fixes.length ? [`fix ${[...new Set(fixes)].join(", ")}`, ...sizes] : [];
  return { geometry: curves ? geometry : [], constraints: curves ? constraints : [], curves };
}
