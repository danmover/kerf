// The mate tool: two picks on two parts (flat faces, round faces or edges, corners) become a mate line. Each pick
// is matched to what the kernel lists of its part (a flat face, a hole's or shaft's axis, a corner) and written
// the way a person would: face(lid, -Z) when it is the face farthest out that way, axis(pin, d: 5) when that size
// is the part's only one, otherwise with near: the picked point. The kinds offered are the ones that fit the two,
// the likeliest first, and a distance or angle starts at what it is now, so adding the mate moves nothing more
// than it must. The first pick's part is the one that moves.

import { applyXforms, applyXformsToDir, type V3, type Xform } from "../kernel/recipe";
import { fmtNum } from "../lang/values";
import { pickAxis, pickPlane, rotAxisAngle, type FaceCatalogue, type MateKind, type PlacedCatalogue } from "./mates";
import type { EvalPart, Model } from "./model";

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** What a pick is, where its part is drawn (world). */
export type Picked = { t: "plane"; p: V3; n: V3 } | { t: "round"; p: V3; d: V3; r: number } | { t: "point"; p: V3 };

/** A part's own placement without the move its mates gave it: where the design draws it. */
export function drawnXf(model: Model, part: EvalPart): Xform[] {
  const mv = model.mates?.moves.find(([b]) => b === part.name)?.[1];
  if (!mv) return part.xf;
  // undo q = R (p − c) + c + t: take t off, then turn back about c
  const { axis, angle } = rotAxisAngle(mv.R);
  const out: Xform[] = [...part.xf];
  if (len(mv.t) > 1e-12) out.push({ op: "translate", v: [-mv.t[0], -mv.t[1], -mv.t[2]] });
  if (angle > 1e-12) out.push({ op: "rotate", angle: (-angle * 180) / Math.PI, origin: mv.c, axis });
  return out;
}

/** Which of a solid's listed faces a pick (in the solid's own coordinates) is on: a flat face, a round face or round edge, or a corner. */
export function classify(cat: FaceCatalogue, at: V3, kind: "face" | "edge" | "vertex"): { t: "plane"; i: number } | { t: "round"; i: number } | { t: "point" } | null {
  if (kind === "vertex") return { t: "point" };
  const tol = 0.2;
  if (kind === "face") {
    let best = -1,
      bestD = Infinity;
    cat.planes.forEach((f, i) => {
      const off = Math.abs(dot(sub(at, f.p), f.n));
      if (off > tol) return;
      const out = Math.hypot(...([0, 1, 2].map((k) => Math.max(f.lo[k] - tol - at[k], 0, at[k] - f.hi[k] - tol)) as V3));
      if (out < bestD) {
        best = i;
        bestD = out;
      }
    });
    if (best >= 0 && bestD < 1e-6) return { t: "plane", i: best };
  }
  // on a round face (a face pick), or round one end of it (an edge pick); the mesh lies a little inside curves
  let best = -1,
    bestD = Infinity;
  cat.rounds.forEach((f, i) => {
    const w = sub(at, f.p);
    const along = dot(w, f.d);
    const off = len(sub(w, [f.d[0] * along, f.d[1] * along, f.d[2] * along]));
    const radial = Math.abs(off - f.r);
    const rt = Math.max(tol, 0.03 * f.r);
    if (radial > rt) return;
    const end = Math.abs(Math.abs(along) - f.len / 2);
    if (kind === "edge" ? end > tol : Math.abs(along) > f.len / 2 + tol) return;
    if (radial < bestD) {
      best = i;
      bestD = radial;
    }
  });
  return best >= 0 ? { t: "round", i: best } : null;
}

const AXES: [V3, string][] = [
  [[1, 0, 0], "X"],
  [[0, 1, 0], "Y"],
  [[0, 0, 1], "Z"],
];
/** +X, -Z and the like for a direction along an axis; null otherwise. */
export function dirLabel(n: V3): string | null {
  for (const [a, w] of AXES) {
    const d = dot(n, a);
    if (Math.abs(Math.abs(d) - 1) < 1e-6) return `${d < 0 ? "-" : "+"}${w}`;
  }
  return null;
}
const num = (x: number) => fmtNum(Math.abs(x) < 0.005 ? 0 : x, 2);
const pt = (p: V3) => `(${p.map(num).join(", ")})`;

/**
 * A pick written as a mate reference (face(), axis() or point()), with what it is where the part is drawn; or why
 * it cannot be one. `cats` holds the kernel's lists for the part's solids, by geometry hash.
 */
export function pickedRef(model: Model, part: EvalPart, cats: Map<string, FaceCatalogue>, kind: "face" | "edge" | "vertex", at: V3): { text: string; geom: Picked } | string {
  const name = part.name;
  if (part.id.includes("#")) return `${part.label} is one of a pattern: mate the pattern with rigid() in the code, or give it its own block`;
  const cat = cats.get(part.hash);
  if (!cat) return `${part.label}'s faces are not listed yet: try again once it has built`;
  const xf = drawnXf(model, part);
  const placed: PlacedCatalogue[] = model.parts.filter((p) => p.name === name).flatMap((p) => {
    const c = cats.get(p.hash);
    return c ? [{ cat: c, xf: drawnXf(model, p) }] : [];
  });
  const hit = classify(cat, at, kind);
  if (!hit) return kind === "edge" ? "Pick a round edge (a hole's or a shaft's), a flat or round face, or a corner" : "That face is neither flat nor round: pick a flat face, a hole, a shaft or a corner";
  const p = applyXforms(at, xf);
  if (hit.t === "point") return { text: `point(${name}, ${pt(p)})`, geom: { t: "point", p } };
  if (hit.t === "plane") {
    const f = cat.planes[hit.i];
    const n = applyXformsToDir(f.n, xf);
    const fp = applyXforms(f.p, xf);
    const lab = dirLabel(n);
    const geom: Picked = { t: "plane", p: fp, n };
    if (lab) {
      // the face farthest out that way, written plainly; another facing the same way needs the point too
      const far = pickPlane(name, placed, n);
      if (typeof far !== "string" && far.t === "plane" && Math.abs(dot(sub(far.p, fp), n)) < 1e-3) return { text: `face(${name}, ${lab})`, geom };
      return { text: `face(${name}, ${lab}, near: ${pt(p)})`, geom };
    }
    return { text: `face(${name}, near: ${pt(p)})`, geom };
  }
  const f = cat.rounds[hit.i];
  const geom: Picked = { t: "round", p: applyXforms(f.p, xf), d: applyXformsToDir(f.d, xf), r: f.r };
  const d = 2 * f.r;
  const only = pickAxis(name, placed, { d });
  const sameAxis = typeof only !== "string" && only.t === "axis" && Math.abs(Math.abs(dot(only.d, geom.d)) - 1) < 1e-6 && len(cross(sub(only.p, geom.p), geom.d)) < 1e-3;
  return { text: sameAxis ? `axis(${name}, d: ${num(d)})` : `axis(${name}, d: ${num(d)}, near: ${pt(p)})`, geom };
}

export interface MateChoice {
  kind: MateKind;
  /** the extra argument it is written with (a distance or an angle as it is now) */
  arg?: string;
  /** what it does, for the button's tip */
  tip: string;
}

/** The mates that fit two picks, the likeliest first; distances and angles as they are now. */
export function mateChoices(a: Picked, b: Picked): MateChoice[] {
  const angleDeg = (u: V3, v: V3) => (Math.acos(Math.max(-1, Math.min(1, dot(u, v)))) * 180) / Math.PI;
  if (a.t === "plane" && b.t === "plane") {
    const c = dot(a.n, b.n);
    const list: MateChoice[] = [
      { kind: "against", tip: "Face to face, touching" },
      { kind: "flush", tip: "Level, facing the same way" },
      { kind: "distance", arg: `${num(Math.abs(dot(sub(a.p, b.p), b.n)))}mm`, tip: "Parallel, this far apart" },
      { kind: "angle", arg: `${num(angleDeg(a.n, b.n))}deg`, tip: "At this angle" },
      { kind: "parallel", tip: "Facing the same way or opposite, anywhere" },
      { kind: "perpendicular", tip: "Square to each other" },
      { kind: "coincident", tip: "In one plane" },
    ];
    // facing each other: against; facing the same way: flush; across: perpendicular
    const first = c < -0.5 ? "against" : c > 0.5 ? "flush" : "perpendicular";
    return [...list.filter((x) => x.kind === first), ...list.filter((x) => x.kind !== first)];
  }
  if (a.t === "round" && b.t === "round") {
    const across = len(cross(sub(a.p, b.p), b.d));
    return [
      { kind: "concentric", tip: "In line: still turns and slides along it" },
      { kind: "pin", tip: "In line and centred along each other: still turns" },
      { kind: "tangent", tip: "Side by side, touching (rollers, wheels)" },
      { kind: "parallel", tip: "The axes the same way" },
      { kind: "perpendicular", tip: "The axes square to each other" },
      { kind: "distance", arg: `${num(Math.max(across, 0.01))}mm`, tip: "Axes parallel, this far apart" },
    ];
  }
  if ((a.t === "plane" && b.t === "round") || (a.t === "round" && b.t === "plane")) {
    const pl = (a.t === "plane" ? a : b) as Extract<Picked, { t: "plane" }>;
    const rd = (a.t === "round" ? a : b) as Extract<Picked, { t: "round" }>;
    const along = Math.abs(dot(rd.d, pl.n)) > 0.5;
    const list: MateChoice[] = [
      { kind: "tangent", tip: "The round face resting on the flat one" },
      { kind: "perpendicular", tip: "The axis along the face's normal (a pin standing in a plate)" },
      { kind: "parallel", tip: "The axis lying along the face" },
      { kind: "distance", arg: `${num(Math.abs(dot(sub(rd.p, pl.p), pl.n)))}mm`, tip: "The axis this far from the face" },
    ];
    return along ? [list[1], list[0], list[2], list[3]] : list;
  }
  const dist = (p: V3, g: Picked) => (g.t === "plane" ? Math.abs(dot(sub(p, g.p), g.n)) : g.t === "round" ? len(cross(sub(p, g.p), g.d)) : len(sub(p, g.p)));
  const p = a.t === "point" ? a.p : (b as Extract<Picked, { t: "point" }>).p;
  const other = a.t === "point" ? b : a;
  return [
    { kind: "coincident", tip: other.t === "point" ? "The two points together" : other.t === "plane" ? "The point on the face" : "The point on the axis" },
    { kind: "distance", arg: `${num(dist(p, other))}mm`, tip: "This far apart" },
  ];
}

/** A name for a new mate that the design does not use yet. */
export function mateName(model: Model, a: string, b: string): string {
  const used = new Set([...model.blocks.map((x) => x.name), ...(model.mates?.list.map((x) => x.name) ?? []), ...model.parts.map((p) => p.name)]);
  const base = `${a}_to_${b}`.replace(/[^A-Za-z0-9_]/g, "_");
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}_${i}`)) return `${base}_${i}`;
}

/** The source with a mate line added at its end (after every part, as mates must be). */
export function addMate(src: string, model: Model, choice: MateChoice, a: { part: string; text: string }, b: { part: string; text: string }): { src: string; name: string; line: string } {
  const name = mateName(model, a.part, b.part);
  const line = `mate ${name} = ${choice.kind}(${a.text}, ${b.text}${choice.arg ? `, ${choice.arg}` : ""})`;
  const body = src.replace(/\s*$/, "");
  return { src: `${body}\n${line}\n`, name, line };
}
