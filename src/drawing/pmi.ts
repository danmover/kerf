// Product and manufacturing information (PMI) in 3D: the dimensions,
// tolerances, fits, datums and geometric tolerances of a part's drawing,
// placed on the model instead of a sheet. A part's PMI is its drawing's
// (its own drawing block, or the automatic one), so tol(), gdt() and the
// rest in the block change both. The viewport draws it (model-based
// definition), and the STEP AP242 export writes it as semantic PMI tied to
// the faces it is about (stepPmi.ts).

import type { EvalPart, Model } from "../core/model";
import { vadd, vcross, vdot, vnorm, vscale, vsub, type V3 } from "../kernel/recipe";
import { buildDims, type DimDef } from "./dims";
import { fcfText, type Fcf } from "./gdt";
import { worldFrame } from "./square";
import { autoDrawings, boxExtents, planDrawing, type BBoxOf, type DrawingPlan } from "./views";
import type { DrawingSpec } from "./spec";

/**
 * Where one end of a distance is: the face square to `w` at `c` along it,
 * or a hole or boss whose axis crosses there.
 */
export interface PmiPlace {
  w: V3;
  c: number;
}

/** A round feature (or a pattern of them): what a diameter, its fit and its frames are about. */
export interface PmiRound {
  r: number;
  dir: V3;
  /** a point on each one's axis */
  centres: V3[];
}

/** One diameter of a callout that stacks several (a bore under a bearing seat), with its own fit. */
export interface PmiSize {
  r: number;
  fit?: string;
  tol?: [number, number];
}

export interface PmiDim {
  /** the drawing's id for it (tol() and gdt() use it), when it has one */
  id?: string;
  kind: "size" | "distance" | "angle" | "other";
  /** as it reads on the drawing: "4× Ø5.5 THRU", "120 ±0.1", "Ø22 H7" */
  text: string;
  label: string;
  value: number;
  /** upper and lower deviation */
  tol?: [number, number];
  fit?: string;
  /** theoretically exact (boxed): a frame carries the tolerance */
  basic?: boolean;
  frames: Fcf[];
  /** the datum letter the feature is */
  datum?: string;
  round?: PmiRound;
  /** every diameter of a stacked callout; one for a plain one */
  sizes?: PmiSize[];
  ends?: [PmiPlace, PmiPlace];
  /** drawn in 3D: the dimension line (or leader) and where its text goes, with the plane it lies in */
  lines: [V3, V3][];
  arrows: { at: V3; dir: V3 }[];
  textAt: V3;
  /** which way the text runs from textAt (callouts on the left of a part read leftward) */
  side?: "left" | "right";
  u: V3;
  v: V3;
}

export interface PmiDatum {
  letter: string;
  /** the face: its outward normal and a point on it */
  n: V3;
  p: V3;
  /** a frame on the face itself (its flatness) */
  frame?: Fcf;
  textAt: V3;
}

export interface PartPmi {
  /** the part's instance id and name */
  part: string;
  name: string;
  /** how far annotations stand off the part, in mm (arrowheads and gaps scale with it) */
  step: number;
  /** the drawing it comes from */
  drawing: string;
  tolerance?: string;
  dims: PmiDim[];
  datums: PmiDatum[];
}

/**
 * The drawing a part's PMI comes from: its own block (of: [part]), else its
 * automatic one. `specs` is every drawing of the model, blocks first, when
 * the caller has them.
 */
export function pmiSpec(model: Model, name: string, bboxOf: BBoxOf, specs?: DrawingSpec[]): DrawingSpec | null {
  const own = (specs ?? model.drawings).find((d) => !d.flat && d.of.length === 1 && d.of[0] === name);
  if (own) return own.pmi === false ? null : own;
  // a copy shares its original's sheet, but its annotations belong on its own solid
  return autoDrawings(model, bboxOf, undefined, { copies: false }).find((s) => s.name === `auto:${name}`) ?? null;
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
/** the four ways a callout leader can run, as (u, v) signs */
const QUARTERS: [number, number][] = [[1, 1], [-1, 1], [-1, -1], [1, -1]];

/** A dimension's text as it reads on the sheet. */
function dimText(d: DimDef): string {
  const t = d.text;
  let s = t.main;
  if (t.boxed) s = `[${s}]`;
  if (t.suffix) s += ` ${t.suffix}`;
  if (t.up || t.lo) s += ` (${t.up ?? "0"}/${t.lo ?? "0"})`;
  return [s, ...(d.lines ?? [])].join(" ");
}

/** The part's PMI, from its drawing; null for parts without one (bought parts, assemblies). */
export function partPmi(model: Model, part: EvalPart, bboxOf: BBoxOf, specs?: DrawingSpec[]): PartPmi | null {
  const spec = pmiSpec(model, part.name, bboxOf, specs);
  if (!spec) return null;
  // positions as plain distances from the datums, holes each with their own callout
  const plan = planDrawing({ ...spec, holeTable: false, dimStyle: "baseline", aux: spec.aux ?? [], breaks: [], autoBreak: false }, model, bboxOf);
  const shown = plan.parts[0];
  if (!shown || plan.assembly || plan.views.length === 0) return null;
  const ext = plan.views.map((v) => boxExtents(plan.bbox, v.frame));
  let built;
  try {
    built = buildDims({ plan, model, spec: plan.spec, ext, results: [], bboxOf });
  } catch {
    return null;
  }
  return toPmi(plan, built.dims, built.marks, part, spec);
}

function toPmi(plan: DrawingPlan, dims: DimDef[], marks: ReturnType<typeof buildDims>["marks"], part: EvalPart, spec: DrawingSpec): PartPmi {
  const shown = plan.parts[0];
  const world = worldFrame(shown);
  const [lo, hi] = plan.bbox;
  const size = Math.max(1, hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  // annotations stand off the part by a step that grows with it
  const step = Math.min(25, Math.max(4, 0.07 * size));
  const mid: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i): V3 => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]);

  // each view's annotations lie in the plane of the part's face toward that view
  const planes = plan.views.map((v) => {
    const f = v.frame;
    const near = Math.max(...corners.map((c) => vdot(c, f.dir)));
    const at = (p: [number, number], depth = near): V3 => world.pt(vadd(vadd(vscale(f.x, p[0]), vscale(f.y, p[1])), vscale(f.dir, depth)));
    return { f, at, centre: vdot(mid, f.dir), u: world.dir(f.x), v: world.dir(f.y), n: world.dir(f.dir) };
  });

  // rows: shorter dimensions sit nearer the part
  const rows = new Map<DimDef, number>();
  const bySide = new Map<string, DimDef[]>();
  for (const d of dims) if (d.kind === "h" || d.kind === "v" || d.kind === "aligned") {
    const k = `${d.view}|${d.side ?? (d.kind === "v" ? "right" : "bottom")}`;
    bySide.set(k, [...(bySide.get(k) ?? []), d]);
  }
  for (const list of bySide.values()) {
    list.sort((a, b) => Math.hypot(a.b[0] - a.a[0], a.b[1] - a.a[1]) - Math.hypot(b.b[0] - b.a[0], b.b[1] - b.a[1]));
    list.forEach((d, i) => rows.set(d, i));
  }

  const out: PmiDim[] = [];
  const quarters = new Map<number, number[]>();
  for (const d of dims) {
    const pv = plan.views[d.view];
    if (!pv || pv.kind === "iso") continue;
    const P = planes[d.view];
    const e = boxExtents(plan.bbox, pv.frame);
    const base = {
      id: d.meta.id,
      text: dimText(d),
      label: d.meta.label,
      value: d.value,
      tol: d.meta.tol,
      fit: d.meta.fit,
      basic: d.meta.basic || d.text.boxed || undefined,
      frames: d.frames ?? [],
      datum: d.datum,
      u: P.u,
      v: P.v,
    };
    if (d.kind === "h" || d.kind === "v" || d.kind === "aligned") {
      const side = d.side ?? (d.kind === "v" ? "right" : "bottom");
      const off = step * ((rows.get(d) ?? 0) + 1);
      let a2: [number, number];
      let b2: [number, number];
      if (d.kind === "h") {
        const y = side === "top" ? e[3] + off : e[1] - off;
        a2 = [d.a[0], y];
        b2 = [d.b[0], y];
      } else if (d.kind === "v") {
        const x = side === "left" ? e[0] - off : e[2] + off;
        a2 = [x, d.a[1]];
        b2 = [x, d.b[1]];
      } else {
        // aligned: out square to the measured line
        const t = [d.b[0] - d.a[0], d.b[1] - d.a[1]];
        const len = Math.hypot(t[0], t[1]) || 1;
        const n: [number, number] = [-t[1] / len, t[0] / len];
        a2 = [d.a[0] + n[0] * off, d.a[1] + n[1] * off];
        b2 = [d.b[0] + n[0] * off, d.b[1] + n[1] * off];
      }
      const [A, B, A2, B2] = [P.at(d.a), P.at(d.b), P.at(a2), P.at(b2)];
      const along = vnorm(vsub(B2, A2));
      const axis = d.kind === "h" ? P.u : d.kind === "v" ? P.v : along;
      const ends: [PmiPlace, PmiPlace] | undefined = d.kind === "aligned" ? undefined : [{ w: axis, c: vdot(A, axis) }, { w: axis, c: vdot(B, axis) }];
      out.push({ ...base, kind: "distance", ends, lines: [[A, A2], [B, B2], [A2, B2]], arrows: [{ at: A2, dir: vscale(along, -1) }, { at: B2, dir: along }], textAt: vscale(vadd(A2, B2), 0.5) });
    } else if (d.kind === "inline") {
      // a diameter across a turned part: its axis runs square to the line, through the middle
      const [A, B] = [P.at(d.a, P.centre), P.at(d.b, P.centre)];
      const across = vnorm(vsub(B, A));
      const axis = vnorm(vcross(across, P.n));
      const [Ad, Bd] = [P.at(d.a), P.at(d.b)];
      out.push({ ...base, kind: "size", round: { r: d.value / 2, dir: axis, centres: [vscale(vadd(A, B), 0.5)] }, lines: [[Ad, Bd]], arrows: [{ at: Ad, dir: vscale(across, -1) }, { at: Bd, dir: across }], textAt: vscale(vadd(Ad, Bd), 0.5) });
    } else if (d.kind === "callout") {
      const c = d.circle?.c ?? d.a;
      const r = d.circle?.r ?? d.value / 2;
      const centres = (d.anchors?.length ? d.anchors : [c]).map((p) => P.at(p, P.centre));
      // the leader runs out at 45° from the circle, away from the part's middle, into the
      // quarter with fewest callouts so far (and further out when it has some)
      const cu = (e[0] + e[2]) / 2;
      const cv = (e[1] + e[3]) / 2;
      const pref = QUARTERS.findIndex(([qs, qt]) => qs === (c[0] >= cu ? 1 : -1) && qt === (c[1] >= cv ? 1 : -1));
      const counts = quarters.get(d.view) ?? [0, 0, 0, 0];
      quarters.set(d.view, counts);
      let q = pref;
      for (const k of [pref, (pref + 1) % 4, (pref + 3) % 4, (pref + 2) % 4]) if (counts[k] < counts[q]) q = k;
      const far = 1 + 1.2 * counts[q]++;
      const [s, t] = QUARTERS[q];
      const rim: [number, number] = [c[0] + (s * r) / Math.SQRT2, c[1] + (t * r) / Math.SQRT2];
      const knee: [number, number] = [rim[0] + s * step * 1.2 * far, rim[1] + t * step * 1.2 * far];
      const end: [number, number] = [knee[0] + s * step * 0.8, knee[1]];
      const [R0, K, E] = [P.at(rim), P.at(knee), P.at(end)];
      const round = /^(\d+× )?(Ø|M\d)/.test(d.text.main) && !/SLOT/.test(d.text.main) ? { r: d.value / 2, dir: P.n, centres } : undefined;
      const sizes = round && d.sizes ? d.sizes.map((x) => ({ r: x.d / 2, fit: x.fit, tol: x.tol })) : undefined;
      out.push({ ...base, kind: round ? "size" : "other", round, sizes, lines: [[R0, K], [K, E]], arrows: [{ at: R0, dir: vnorm(vsub(R0, K)) }], textAt: E, side: s < 0 ? "left" : "right" });
    } else if (d.kind === "angle") {
      const V = P.at(d.a);
      const legs = d.legs ?? [[1, 0], [0, 1]];
      const lens = d.lens ?? [step, step];
      const ends = legs.map((l, k) => P.at([d.a[0] + l[0] * lens[k], d.a[1] + l[1] * lens[k]]));
      const bis: [number, number] = [legs[0][0] + legs[1][0], legs[0][1] + legs[1][1]];
      const bl = Math.hypot(bis[0], bis[1]) || 1;
      const tAt = P.at([d.a[0] + (bis[0] / bl) * Math.min(...lens) * 0.7, d.a[1] + (bis[1] / bl) * Math.min(...lens) * 0.7]);
      out.push({ ...base, kind: "angle", lines: [[V, ends[0]], [V, ends[1]]], arrows: [], textAt: tAt });
    } else {
      // arcs and ordinates: the text by the point it is about
      const A = P.at(d.a);
      out.push({ ...base, kind: "other", lines: [], arrows: [], textAt: A });
    }
  }

  const datums: PmiDatum[] = marks.map((m) => {
    const P = planes[m.view];
    const f = plan.views[m.view].frame;
    const midp: [number, number] = [(m.a[0] + m.b[0]) / 2, (m.a[1] + m.b[1]) / 2];
    const n = world.dir(vnorm(vadd(vscale(f.x, m.out[0]), vscale(f.y, m.out[1]))));
    const p = P.at(midp, P.centre);
    return { letter: m.letter, n, p, frame: m.frame, textAt: vadd(P.at(midp), vscale(n, step * 1.4)) };
  });

  return { part: shown.id, name: part.name, step, drawing: spec.name, tolerance: spec.tolerance, dims: out, datums };
}

/** A part's PMI moved onto another instance of it: `pt` and `dir` map the drawn instance's world to the other's. */
export function movePmi(p: PartPmi, part: string, pt: (q: V3) => V3, dir: (d: V3) => V3): PartPmi {
  const place = (e: PmiPlace): PmiPlace => {
    const w = dir(e.w);
    return { w, c: vdot(pt(vscale(e.w, e.c)), w) };
  };
  return {
    ...p,
    part,
    dims: p.dims.map((d) => ({
      ...d,
      round: d.round && { ...d.round, dir: dir(d.round.dir), centres: d.round.centres.map(pt) },
      ends: d.ends && [place(d.ends[0]), place(d.ends[1])],
      lines: d.lines.map(([a, b]) => [pt(a), pt(b)]),
      arrows: d.arrows.map((a) => ({ at: pt(a.at), dir: dir(a.dir) })),
      textAt: pt(d.textAt),
      u: dir(d.u),
      v: dir(d.v),
    })),
    datums: p.datums.map((d) => ({ ...d, n: dir(d.n), p: pt(d.p), textAt: pt(d.textAt) })),
  };
}

/** One line for the assistant and toasts: what a part's PMI holds. */
export function pmiSummary(p: PartPmi): string {
  const tol = p.dims.filter((d) => d.tol || d.fit).length;
  const frames = p.dims.reduce((n, d) => n + d.frames.length, 0) + p.datums.filter((d) => d.frame).length;
  const bits = [`${p.dims.length} dimension${p.dims.length === 1 ? "" : "s"}${tol ? ` (${tol} with tolerances or fits)` : ""}`];
  if (frames) bits.push(`${frames} geometric tolerance${frames === 1 ? "" : "s"}`);
  const letters = [...new Set([...p.datums.map((d) => d.letter), ...p.dims.flatMap((d) => (d.datum ? [d.datum] : []))])].sort();
  if (letters.length) bits.push(`datum${letters.length === 1 ? "" : "s"} ${letters.join(" ")}`);
  return bits.join(", ");
}

/** Plain text of every annotation, for the assistant. */
export function pmiLines(p: PartPmi): string[] {
  return [
    ...p.datums.map((d) => `datum ${d.letter} on the face facing (${d.n.map(fmt).join(", ")})${d.frame ? ` [${fcfText(d.frame)}]` : ""}`),
    ...p.dims.map((d) => `${d.text}${d.frames.length ? ` [${d.frames.map(fcfText).join("; ")}]` : ""}${d.datum ? ` (datum ${d.datum})` : ""} — ${d.label}`),
  ];
}
