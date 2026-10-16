// Dimension graphics for the sketch overlay, laid out in screen space so
// they stay readable at any zoom: extension lines, dimension lines with
// arrows, and a label that can be clicked to edit or dragged to scrub.

import type { V2 } from "../../kernel/recipe";
import { fmtNum } from "../../lang/values";
import type { EvalSketch, SkConstraint } from "../../sketch/types";
import type { Positions, Projector, Px } from "./geom";
import { add, closestOnSeg, dist, mul, sub } from "./geom";

export interface DimGfx {
  index: number;
  lines: Px[][];
  dashed: Px[][];
  arrows: { at: Px; dir: Px }[];
  label: Px;
  text: string;
  /** the value is a formula (driven by parameters) */
  driven: boolean;
  status: SkConstraint["status"];
  /** what to highlight when the label is hovered */
  ids: string[];
}

const OFF = 24;

/** Width of a dimension label box for its text. */
export const labelWidth = (text: string) => Math.max(28, text.length * 7 + 12);

/** Push overlapping labels apart, away from the sketch centre, with a dashed leader back to the dimension. */
function declutter(dims: DimGfx[], center: Px) {
  const placed: { x: number; y: number; w: number }[] = [];
  const hits = (x: number, y: number, w: number) => placed.some((r) => Math.abs(r.x - x) < (r.w + w) / 2 + 3 && Math.abs(r.y - y) < 21);
  for (const d of dims) {
    const w = labelWidth(d.text);
    const from = d.label;
    let at = from;
    if (hits(at.x, at.y, w)) {
      const away = pnorm(pv(from, center));
      const dir = Math.hypot(away.x, away.y) > 0.5 ? away : { x: 0, y: 1 };
      // try sliding out along the outward direction, then sideways
      const tries: Px[] = [];
      for (let k = 1; k <= 8; k++) tries.push(pa(from, { x: dir.x * 12 * k, y: dir.y * 12 * k }), pa(from, { x: 0, y: 21 * k }), pa(from, { x: 0, y: -21 * k }));
      at = tries.find((t) => !hits(t.x, t.y, w)) ?? at;
      if (at !== from) {
        d.dashed.push([from, at]);
        d.label = at;
      }
    }
    placed.push({ x: at.x, y: at.y, w });
  }
}
const pv = (a: Px, b: Px): Px => ({ x: a.x - b.x, y: a.y - b.y });
const pa = (a: Px, b: Px): Px => ({ x: a.x + b.x, y: a.y + b.y });
const pm = (a: Px, k: number): Px => ({ x: a.x * k, y: a.y * k });
const pdot = (a: Px, b: Px) => a.x * b.x + a.y * b.y;
const plen = (a: Px) => Math.hypot(a.x, a.y);
const pnorm = (a: Px): Px => {
  const l = plen(a) || 1;
  return { x: a.x / l, y: a.y / l };
};
const perp = (a: Px): Px => ({ x: -a.y, y: a.x });

export function valueText(c: SkConstraint): { text: string; driven: boolean } {
  const lit = /^-?\d+(\.\d+)?$/.test((c.valueText ?? "").trim());
  const v = c.value ?? 0;
  const deg = c.kind === "angle";
  const num = `${fmtNum(v, deg ? 1 : 2)}${deg ? "°" : ""}`;
  const prefix = c.kind === "diameter" ? "⌀" : c.kind === "radius" || c.kind === "fillet" ? "R" : c.kind === "chamfer" ? "C" : "";
  if (lit || !c.valueText) return { text: prefix + num, driven: false };
  return { text: `${c.valueText.trim()} = ${prefix}${num}`, driven: true };
}

export function layoutDims(sk: EvalSketch, P: Positions, radii: Record<string, number>, proj: Projector, center: V2): DimGfx[] {
  const S = proj.S;
  const sc = S(center);
  const ex = pnorm(pv(S([center[0] + 1, center[1]]), sc));
  const ey = pnorm(pv(S([center[0], center[1] + 1]), sc));
  const out: DimGfx[] = [];
  const stack = new Map<string, number>();
  const bump = (key: string) => {
    const n = stack.get(key) ?? 0;
    stack.set(key, n + 1);
    return n;
  };
  const lineEnds = (id: string): [V2, V2] => {
    if (id === "x_axis") return [P.origin, [P.origin[0] + 1, P.origin[1]]];
    if (id === "y_axis") return [P.origin, [P.origin[0], P.origin[1] + 1]];
    const c = sk.curves.find((q) => q.id === id)!;
    return [P[c.pts[0]], P[c.pts[1]]];
  };
  const centerOf = (id: string): V2 => {
    const c = sk.curves.find((q) => q.id === id)!;
    return P[c.kind === "circle" ? c.pts[0] : c.pts[2]];
  };

  for (const c of sk.constraints) {
    if (!c.dimension) continue;
    const { text, driven } = valueText(c);
    const base = { index: c.index, text, driven, status: c.status, ids: c.ids, lines: [] as Px[][], dashed: [] as Px[][], arrows: [] as DimGfx["arrows"] };
    const def = sk.def.constraints.find((d) => d.src === c.index);

    /** aligned dimension between two sketch points, pushed away from the sketch centre */
    const aligned = (a: V2, b: V2, key: string, forceDir?: Px) => {
      const A = S(a);
      const B = S(b);
      const d = pnorm(pv(B, A));
      let n = forceDir ?? perp(d);
      const mid = pm(pa(A, B), 0.5);
      if (!forceDir && pdot(pv(mid, sc), n) < 0) n = pm(n, -1);
      const off = OFF + bump(key) * 18;
      let A2: Px, B2: Px;
      if (forceDir) {
        // horizontal / vertical: both ends out to the same level
        const level = Math.max(pdot(A, n), pdot(B, n)) + off;
        A2 = pa(A, pm(n, level - pdot(A, n)));
        B2 = pa(B, pm(n, level - pdot(B, n)));
      } else {
        A2 = pa(A, pm(n, off));
        B2 = pa(B, pm(n, off));
      }
      const dd = pnorm(pv(B2, A2));
      base.lines.push([pa(A, pm(n, 4)), pa(A2, pm(n, 5))], [pa(B, pm(n, 4)), pa(B2, pm(n, 5))], [A2, B2]);
      base.arrows.push({ at: A2, dir: pm(dd, -1) }, { at: B2, dir: dd });
      return { ...base, label: pa(pm(pa(A2, B2), 0.5), pm(n, 10)) };
    };
    /** a measured gap drawn straight across (point to line) */
    const across = (p: V2, q: V2, lineA?: V2, lineB?: V2) => {
      const A = S(p);
      const B = S(q);
      const dd = pnorm(pv(B, A));
      base.lines.push([A, B]);
      base.arrows.push({ at: A, dir: pm(dd, -1) }, { at: B, dir: dd });
      if (lineA && lineB) {
        const { t } = closestOnSeg(q, lineA, lineB);
        if (t <= 0 || t >= 1) base.dashed.push([S(t <= 0 ? lineA : lineB), B]);
      }
      return { ...base, label: pa(pm(pa(A, B), 0.5), pm(perp(dd), 12)) };
    };

    try {
      if (c.kind === "fillet" || c.kind === "chamfer") {
        const corner = sk.profile.corners.find((k) => k.src === c.index);
        if (!corner) continue;
        const seg = corner.seg;
        const m = seg.k === "a" ? seg.m : seg.k === "l" ? mul(add(seg.a, seg.b), 0.5) : seg.c;
        const M = S(m);
        const out2 = pnorm(pv(M, sc));
        base.lines.push([M, pa(M, pm(out2, 16))]);
        out.push({ ...base, label: pa(M, pm(out2, 26)) });
        continue;
      }
      if (!def) continue;
      switch (def.kind) {
        case "length": {
          const [a, b] = lineEnds(def.refs[0]);
          out.push(aligned(a, b, def.refs[0]));
          break;
        }
        case "distance":
          out.push(aligned(P[def.refs[0]], P[def.refs[1]], def.refs.join("|")));
          break;
        case "hdistance":
        case "vdistance": {
          const a = P[def.refs[0]];
          const b = P[def.refs[1]];
          const along = def.kind === "hdistance" ? ey : ex;
          const mid = pm(pa(S(a), S(b)), 0.5);
          const dir = pdot(pv(mid, sc), along) >= 0 ? along : pm(along, -1);
          // a vertical screen direction reads as "up" for horizontal dims: flip so dims sit outside
          out.push(aligned(a, b, def.kind + def.refs.join("|"), dir));
          break;
        }
        case "distance_pl": {
          const p = P[def.refs[0]];
          const [la, lb] = lineEnds(def.refs[1]);
          const d = sub(lb, la);
          const l2 = d[0] * d[0] + d[1] * d[1] || 1;
          const t = ((p[0] - la[0]) * d[0] + (p[1] - la[1]) * d[1]) / l2;
          const foot: V2 = [la[0] + d[0] * t, la[1] + d[1] * t];
          if (dist(p, foot) < 1e-9) continue;
          out.push(across(p, foot, la, lb));
          break;
        }
        case "distance_ll": {
          const [l1a, l1b] = lineEnds(def.refs[0]);
          const [l2a] = lineEnds(def.refs[1]);
          const d = sub(l1b, l1a);
          const l2 = d[0] * d[0] + d[1] * d[1] || 1;
          const t = ((l2a[0] - l1a[0]) * d[0] + (l2a[1] - l1a[1]) * d[1]) / l2;
          out.push(across(l2a, [l1a[0] + d[0] * t, l1a[1] + d[1] * t], l1a, l1b));
          break;
        }
        case "radius": {
          const id = def.refs[0];
          const curve = sk.curves.find((q) => q.id === id);
          if (!curve) continue;
          const C = centerOf(id);
          const r = curve.kind === "circle" ? (radii[id] ?? curve.r ?? 0) : dist(P[curve.pts[0]], C);
          let ang = Math.PI / 4;
          if (curve.kind === "arc") {
            const a0 = Math.atan2(P[curve.pts[0]][1] - C[1], P[curve.pts[0]][0] - C[0]);
            let a1 = Math.atan2(P[curve.pts[1]][1] - C[1], P[curve.pts[1]][0] - C[0]);
            while (a1 <= a0) a1 += 2 * Math.PI;
            ang = (a0 + a1) / 2;
          }
          const q: V2 = [C[0] + r * Math.cos(ang), C[1] + r * Math.sin(ang)];
          const Cs = S(C);
          const Q = S(q);
          const dir = pnorm(pv(Q, Cs));
          const tail = pa(Q, pm(dir, 22));
          if (c.kind === "diameter") {
            const q2: V2 = [C[0] - r * Math.cos(ang), C[1] - r * Math.sin(ang)];
            const Q2 = S(q2);
            base.lines.push([Q2, tail]);
            base.arrows.push({ at: Q, dir }, { at: Q2, dir: pm(dir, -1) });
          } else {
            base.lines.push([Cs, tail]);
            base.arrows.push({ at: Q, dir });
          }
          out.push({ ...base, label: pa(tail, pm(dir, 14)) });
          break;
        }
        case "angle": {
          const [a1, b1] = lineEnds(def.refs[0]);
          const [a2, b2] = lineEnds(def.refs[1]);
          const d1 = sub(b1, a1);
          const d2 = sub(b2, a2);
          const den = d1[0] * d2[1] - d1[1] * d2[0];
          let X: V2;
          if (Math.abs(den) < 1e-9) X = mul(add(a1, b1), 0.5);
          else {
            const t = ((a2[0] - a1[0]) * d2[1] - (a2[1] - a1[1]) * d2[0]) / den;
            X = [a1[0] + d1[0] * t, a1[1] + d1[1] * t];
          }
          const rS = 38 / proj.scale(X);
          const t0 = Math.atan2(d1[1], d1[0]);
          const sweep = ((c.value ?? 0) * Math.PI) / 180;
          const pts: Px[] = [];
          for (let i = 0; i <= 24; i++) {
            const t = t0 + (sweep * i) / 24;
            pts.push(S([X[0] + rS * Math.cos(t), X[1] + rS * Math.sin(t)]));
          }
          base.lines.push(pts);
          const tm = t0 + sweep / 2;
          const Xs = S(X);
          const L = S([X[0] + rS * Math.cos(tm), X[1] + rS * Math.sin(tm)]);
          out.push({ ...base, label: pa(L, pm(pnorm(pv(L, Xs)), 14)) });
          break;
        }
        default:
          continue;
      }
    } catch {
      /* geometry mid-edit: skip this dimension */
    }
  }
  declutter(out, sc);
  return out;
}

/** Where to draw relation glyphs (H, V, ∥, …): next to the geometry they act on. */
export const GLYPH: Record<string, string> = {
  fix: "⌖",
  coincident: "•",
  horizontal: "H",
  vertical: "V",
  parallel: "∥",
  perpendicular: "⊥",
  collinear: "⋯",
  equal: "=",
  tangent: "T",
  midpoint: "M",
  symmetric: "⇋",
  concentric: "◎",
};

export interface GlyphGfx {
  index: number;
  at: Px;
  text: string;
  status: SkConstraint["status"];
  ids: string[];
}

export function layoutGlyphs(sk: EvalSketch, P: Positions, proj: Projector, center: V2): GlyphGfx[] {
  const S = proj.S;
  const sc = S(center);
  const used = new Map<string, number>();
  const out: GlyphGfx[] = [];
  const anchor = (id: string): { at: Px; n: Px } | null => {
    const curve = sk.curves.find((c) => c.id === id);
    if (curve?.kind === "line") {
      const A = S(P[curve.pts[0]]);
      const B = S(P[curve.pts[1]]);
      const m = pm(pa(A, B), 0.5);
      let n = perp(pnorm(pv(B, A)));
      if (pdot(pv(m, sc), n) > 0) n = pm(n, -1);
      return { at: m, n };
    }
    if (curve) {
      const C = S(P[curve.kind === "circle" ? curve.pts[0] : curve.pts[2]]);
      return { at: C, n: { x: 0.7, y: -0.7 } };
    }
    if (P[id]) return { at: S(P[id]), n: { x: 0.7, y: -0.7 } };
    return null;
  };
  for (const c of sk.constraints) {
    if (c.dimension) continue;
    const text = GLYPH[c.kind];
    if (!text) continue;
    // a coincidence between two points is visible on its own
    if (c.kind === "coincident" && c.ids.every((id) => P[id])) continue;
    const targets = c.kind === "horizontal" || c.kind === "vertical" || c.kind === "fix" || c.kind === "equal" || c.kind === "parallel" ? c.ids : [c.ids[0]];
    for (const id of targets) {
      const a = anchor(id);
      if (!a) continue;
      const k = used.get(id) ?? 0;
      used.set(id, k + 1);
      const along = perp(a.n);
      out.push({ index: c.index, at: pa(pa(a.at, pm(a.n, 14)), pm(along, k * 16)), text, status: c.status, ids: c.ids });
    }
  }
  return out;
}
