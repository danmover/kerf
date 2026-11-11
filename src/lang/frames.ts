// Frames and weldments: straight structural members laid along skeleton
// lines, trimmed and lengthened where they meet, with a cut list. A member is
// either a bought aluminium profile from the parts catalog (2020 or 2040
// V-slot, always cut square) or stock section: steel or aluminium box, round
// tube, angle, flat bar, square bar or round bar, which can also be mitred,
// cut on a slant to sit flat on a member it meets at an angle, or coped to fit
// round a tube.
//
// The lines run through the middle of each member. Where lines end together
// an upright runs through, then the longer member, and the others stop
// against it; a line that ends on another member (on its centre line or its
// face) stops at that member's face; two sections meeting at a corner can be
// mitred instead. Pure geometry: the evaluator turns each planned member into
// a component (a catalog profile) or a part (a section).

import { frameAt, vadd, vcross, vdot, vlen, vnorm, vscale, vsub, type PartRecipe, type Profile, type ShapeRecipe, type V3, type Xform } from "../kernel/recipe";

export type SectionKind = "extrusion" | "box" | "tube" | "angle" | "flat" | "bar" | "rod";

export interface Section {
  kind: SectionKind;
  /** size across the member's own x (w) and y (h), mm; a round section's diameter in both */
  w: number;
  h: number;
  /** wall or leg thickness: box, tube and angle */
  t?: number;
  round: boolean;
  /** a bought profile from the parts catalog (cut square, sold by the metre) */
  catalogId?: string;
  /** the sizes in words: "40 × 40 × 3 mm" */
  dims: string;
  /** what it is: "box section", "round tube", "angle", "flat bar", "bar", "round bar", or the catalog name */
  noun: string;
  /** cross-section area, mm² */
  area: number;
  /** grams per metre for a catalog profile */
  massPerM?: number;
  /** a catalog profile's second moment of area about its stronger axis, mm⁴ */
  iyy?: number;
}

/** A catalog profile as the section parser needs it. */
export interface CatalogProfile {
  id: string;
  name: string;
  w: number;
  h: number;
  massPerM?: number;
  /** second moment of area about its stronger axis, mm⁴ */
  iyy?: number;
}

const SECTION_HELP =
  'profile: should be "2020" or "2040" (V-slot aluminium extrusion), or a section: "box 40x40x3" (width x height x wall), "tube 26.9x2.6" (outside diameter x wall), "angle 30x30x3", "flat 40x5", "bar 20x20" or "rod 12"';

const WORDS: [RegExp, Exclude<SectionKind, "extrusion">][] = [
  [/^(box|box section|shs|rhs|square tube|rectangular tube|square hollow section|rectangular hollow section|hollow section)$/, "box"],
  [/^(tube|round tube|chs|pipe|circular hollow section)$/, "tube"],
  [/^(angle|angle iron|equal angle|unequal angle|ea|ua)$/, "angle"],
  [/^(flat|flat bar|strip)$/, "flat"],
  [/^(bar|square bar|rectangular bar|solid bar)$/, "bar"],
  [/^(rod|round|round bar|solid rod)$/, "rod"],
];

const n = (x: number) => String(Math.round(x * 100) / 100);

/** A profile: "2020", "2040", a catalog extrusion id, or a section such as "box 40x40x3". A string is the reason it can't be read. */
export function parseSection(text: string, catalog: (id: string) => CatalogProfile | undefined): Section | string {
  const raw = text.trim();
  const s = raw.toLowerCase().replace(/\s+/g, " ");
  const series = /^(?:v-?slot )?(\d{4})(?: (?:v-?slot|extrusion|profile))?$/.exec(s);
  const cp = catalog(series ? `vslot_${series[1]}` : raw) ?? catalog(s);
  if (cp) return { kind: "extrusion", w: cp.w, h: cp.h, round: false, catalogId: cp.id, dims: `${n(cp.w)} × ${n(cp.h)} mm`, noun: cp.name, area: (cp.massPerM ?? 0) / 2.7, massPerM: cp.massPerM, ...(cp.iyy ? { iyy: cp.iyy } : {}) };
  if (series) return `There is no ${series[1]} profile in the parts catalog: use "2020" or "2040", or a section such as "box 40x40x3"`;
  const m = /^([a-z][a-z ]*?) ?(\d[\d.]*(?: ?mm)?(?: ?[x×*] ?\d[\d.]*(?: ?mm)?)*)$/.exec(s);
  const kind = m ? WORDS.find(([re]) => re.test(m[1].trim()))?.[1] : undefined;
  if (!m || !kind) return SECTION_HELP;
  const v = m[2].split(/ ?[x×*] ?/).map((x) => parseFloat(x));
  if (v.some((x) => !(x > 0))) return SECTION_HELP;
  const bad = (why: string) => `profile: "${raw}": ${why}`;
  switch (kind) {
    case "box": {
      if (v.length !== 2 && v.length !== 3) return bad("a box section is width x height x wall, like box 40x20x2 (or box 25x1.6 for a square one)");
      const [w, h, t] = v.length === 3 ? v : [v[0], v[0], v[1]];
      if (t * 2 >= Math.min(w, h)) return bad(`the wall (${n(t)} mm) must be less than half the smaller side`);
      return { kind, w, h, t, round: false, dims: `${n(w)} × ${n(h)} × ${n(t)} mm`, noun: "box section", area: w * h - (w - 2 * t) * (h - 2 * t) };
    }
    case "tube": {
      if (v.length !== 2) return bad("a round tube is outside diameter x wall, like tube 26.9x2.6");
      const [d, t] = v;
      if (t * 2 >= d) return bad(`the wall (${n(t)} mm) must be less than half the diameter`);
      return { kind, w: d, h: d, t, round: true, dims: `${n(d)} × ${n(t)} mm`, noun: "round tube", area: (Math.PI / 4) * (d * d - (d - 2 * t) ** 2) };
    }
    case "angle": {
      if (v.length !== 2 && v.length !== 3) return bad("an angle is leg x leg x thickness, like angle 30x30x3 (or angle 25x3 for equal legs)");
      const [w, h, t] = v.length === 3 ? v : [v[0], v[0], v[1]];
      if (t >= Math.min(w, h)) return bad(`the thickness (${n(t)} mm) must be less than the shorter leg`);
      return { kind, w, h, t, round: false, dims: `${n(w)} × ${n(h)} × ${n(t)} mm`, noun: "angle", area: t * (w + h - t) };
    }
    case "flat": {
      if (v.length !== 2) return bad("a flat bar is width x thickness, like flat 40x5");
      const [w, t] = v;
      return { kind, w, h: t, round: false, dims: `${n(w)} × ${n(t)} mm`, noun: "flat bar", area: w * t };
    }
    case "bar": {
      if (v.length > 2) return bad("a bar is width x height, like bar 20x20 (or bar 20 for a square one)");
      const [w, h] = v.length === 2 ? v : [v[0], v[0]];
      return { kind, w, h, round: false, dims: `${n(w)} × ${n(h)} mm`, noun: w === h ? "square bar" : "bar", area: w * h };
    }
    case "rod": {
      if (v.length !== 1) return bad("a round bar is its diameter, like rod 12");
      return { kind, w: v[0], h: v[0], round: true, dims: `${n(v[0])} mm`, noun: "round bar", area: (Math.PI / 4) * v[0] * v[0] };
    }
  }
}

/** "steel", "aluminium", "stainless steel": the material as a word in a section's name. */
export function materialWord(material: string): string {
  if (/^stainless/i.test(material)) return "stainless steel";
  if (/^alumin/i.test(material)) return "aluminium";
  if (/^steel/i.test(material)) return "steel";
  return material;
}

/** "40 × 40 × 3 mm steel box section"; a catalog profile is its catalog name. */
export function sectionName(sec: Section, material: string): string {
  return sec.catalogId ? sec.noun : `${sec.dims} ${materialWord(material)} ${sec.noun}`;
}

/** The words a shop search wants: "40x40x3 steel square hollow section". */
export function sectionSearch(sec: Section, material: string): string {
  const dims = sec.dims.replace(/ × /g, "x").replace(/ mm$/, "");
  const noun: Record<SectionKind, string> = { extrusion: sec.noun, box: sec.w === sec.h ? "square hollow section" : "rectangular hollow section", tube: "round tube", angle: "angle", flat: "flat bar", bar: sec.w === sec.h ? "square bar" : "flat bar", rod: "round bar" };
  return sec.catalogId ? sec.noun : `${dims} ${materialWord(material)} ${noun[sec.kind]}`;
}

/** The section's outline across the member: x along the member's own x (u), y along its y (v), centred on the line. */
export function sectionProfile(sec: Section): Profile {
  const { w, h } = sec;
  const t = sec.t ?? 0;
  switch (sec.kind) {
    case "box": {
      const ro = Math.max(0, Math.min(1.5 * t, Math.min(w, h) / 2 - 0.05));
      const wi = w - 2 * t;
      const hi = h - 2 * t;
      const ri = Math.max(0, Math.min(ro - t, Math.min(wi, hi) / 2 - 0.05));
      return { t: "diff2", a: { t: "rect", w, h, r: ro, c: [0, 0] }, b: [{ t: "rect", w: wi, h: hi, r: ri > 0.05 ? ri : 0, c: [0, 0] }] };
    }
    case "tube":
      return { t: "diff2", a: { t: "circle", d: w, c: [0, 0] }, b: [{ t: "circle", d: w - 2 * t, c: [0, 0] }] };
    case "angle": {
      // the heel (where the legs meet) at (-w/2, -h/2): one leg along +x, the other along +y
      const x0 = -w / 2;
      const y0 = -h / 2;
      return { t: "poly", pts: [[x0, y0], [w / 2, y0], [w / 2, y0 + t], [x0 + t, y0 + t], [x0 + t, h / 2], [x0, h / 2]], r: 0 };
    }
    case "rod":
      return { t: "circle", d: w, c: [0, 0] };
    default:
      return { t: "rect", w, h, r: 0, c: [0, 0] };
  }
}

// ---------------------------------------------------------------- beam sections

/**
 * A section as a beam sees it, in the section's own (u, v) across the member (u along its width w, v along its
 * height h, centred on the line).
 */
export interface BeamSection {
  /** area, mm² */
  A: number;
  /** second moments about the centroid: Iu = ∫v² dA (bending that moves it along v), Iv = ∫u² dA (along u), Iuv = ∫uv dA */
  Iu: number;
  Iv: number;
  Iuv: number;
  /** torsion constant, mm⁴ */
  J: number;
  /** the centroid in (u, v): off the line for an angle */
  c: [number, number];
  /** share of the area that carries shear (Timoshenko) */
  kappa: number;
  /** the largest shear stress from twisting, per N·mm of torque, 1/mm³ */
  tau: number;
  kind: SectionKind;
  w: number;
  h: number;
  t?: number;
  round: boolean;
  /** properties taken from the catalog or estimated (a slotted extrusion's twist) */
  estimated?: string;
}

/** Torsion of a solid rectangle a × b (a ≥ b): its constant and the largest shear stress per unit torque (Roark). */
function rectTorsion(w: number, h: number): { J: number; tau: number } {
  const a = Math.max(w, h),
    b = Math.min(w, h);
  return { J: a * b ** 3 * (1 / 3 - 0.21 * (b / a) * (1 - b ** 4 / (12 * a ** 4))), tau: (3 * a + 1.8 * b) / (a * a * b * b) };
}

/** A section's beam properties: area, second moments, torsion, centroid. */
export function sectionProps(sec: Section): BeamSection {
  const { w, h } = sec;
  const t = sec.t ?? 0;
  const base = { kind: sec.kind, w, h, round: sec.round, ...(sec.t !== undefined ? { t: sec.t } : {}) };
  switch (sec.kind) {
    case "box": {
      const wi = w - 2 * t,
        hi = h - 2 * t;
      // a closed thin wall twists by Bredt's formula on its mid-line
      const am = (w - t) * (h - t);
      return { ...base, A: w * h - wi * hi, Iu: (w * h ** 3 - wi * hi ** 3) / 12, Iv: (h * w ** 3 - hi * wi ** 3) / 12, Iuv: 0, J: (4 * am * am * t) / (2 * (w - t + h - t)), c: [0, 0], kappa: 0.44, tau: 1 / (2 * am * t) };
    }
    case "tube": {
      const di = w - 2 * t;
      const I = (Math.PI / 64) * (w ** 4 - di ** 4);
      return { ...base, A: (Math.PI / 4) * (w * w - di * di), Iu: I, Iv: I, Iuv: 0, J: 2 * I, c: [0, 0], kappa: 0.53, tau: w / 2 / (2 * I) };
    }
    case "rod": {
      const I = (Math.PI / 64) * w ** 4;
      return { ...base, A: (Math.PI / 4) * w * w, Iu: I, Iv: I, Iuv: 0, J: 2 * I, c: [0, 0], kappa: 0.9, tau: w / 2 / (2 * I) };
    }
    case "angle": {
      // two rectangles: the leg along u (full width, at the bottom) and the leg along v above it, heel at (-w/2, -h/2)
      const r = [
        { a: w * t, cu: 0, cv: -h / 2 + t / 2, iu: (w * t ** 3) / 12, iv: (t * w ** 3) / 12 },
        { a: t * (h - t), cu: -w / 2 + t / 2, cv: -h / 2 + t + (h - t) / 2, iu: (t * (h - t) ** 3) / 12, iv: ((h - t) * t ** 3) / 12 },
      ];
      const A = r[0].a + r[1].a;
      const cu = (r[0].a * r[0].cu + r[1].a * r[1].cu) / A,
        cv = (r[0].a * r[0].cv + r[1].a * r[1].cv) / A;
      let Iu = 0,
        Iv = 0,
        Iuv = 0;
      for (const q of r) {
        Iu += q.iu + q.a * (q.cv - cv) ** 2;
        Iv += q.iv + q.a * (q.cu - cu) ** 2;
        Iuv += q.a * (q.cu - cu) * (q.cv - cv);
      }
      const J = ((w + h - t) * t ** 3) / 3;
      return { ...base, A, Iu, Iv, Iuv, J, c: [cu, cv], kappa: 0.4, tau: t / J };
    }
    case "extrusion": {
      // a V-slot profile: the catalog gives the stronger axis; across it, each square cell bends about like a 2020
      // (about half a solid square's stiffness: 7000 mm⁴ for 20 mm), and slotted profiles twist far more easily
      // than a closed tube
      const c = Math.min(w, h);
      const cells = Math.max(1, Math.round(Math.max(w, h) / c));
      const cell = 0.525 * (c ** 4 / 12);
      const strong = sec.iyy ?? (cells === 1 ? cell : 0.42 * ((c * Math.max(w, h) ** 3) / 12));
      const weak = cells === 1 ? strong : Math.min(strong, cells * cell);
      const A = sec.area > 0 ? sec.area : 0.46 * w * h;
      const Iu = h >= w ? strong : weak,
        Iv = h >= w ? weak : strong;
      const J = 0.1 * (Iu + Iv);
      return { ...base, A, Iu, Iv, Iuv: 0, J, c: [0, 0], kappa: 0.5, tau: Math.max(w, h) / 2 / J, estimated: "the profile's twist is estimated (slotted extrusions twist far more easily than tubes)" };
    }
    default: {
      // flat and solid bar
      const tr = rectTorsion(w, h);
      return { ...base, A: w * h, Iu: (w * h ** 3) / 12, Iv: (h * w ** 3) / 12, Iuv: 0, J: tr.J, c: [0, 0], kappa: 5 / 6, tau: tr.tau };
    }
  }
}

// ---------------------------------------------------------------- planning

export type MemberRole = "post" | "rail" | "brace";

/** One line of the skeleton: a member runs from a to b, its section turned `rot` degrees about the line. */
export interface FrameLine {
  a: V3;
  b: V3;
  rot: number;
  role?: MemberRole;
}

export interface MemberEnd {
  /** how far the piece runs past the line's end point (negative: it stops short of it), to its long point */
  ext: number;
  /** the same for where the cut crosses the centre line (the piece's length for its weight) */
  axis: number;
  /** a slanted cut (a mitre, or an end cut to sit flat on a member it meets at an angle): the plane through p, taking away the side n points to */
  cut?: { p: V3; n: V3 };
  /** a coped end, shaped to fit round a tube or rod: the round member's outside, which is cut away */
  cope?: { at: V3; dir: V3; d: number; h: number };
  /** the cut's angle from square, degrees (45 for a mitre on a right-angled corner) */
  angle: number;
  joint: "free" | "through" | "butt" | "tee" | "miter" | "splice";
  /** the members (indices) this end meets */
  meets: number[];
}

export interface PlannedMember {
  index: number;
  /** the line it was drawn on */
  from: V3;
  to: V3;
  dir: V3;
  /** the section's own x and y across the member */
  u: V3;
  v: V3;
  rot: number;
  role: MemberRole;
  /** where the piece's centre line starts and ends after trimming */
  start: V3;
  end: V3;
  /** the length to cut, long point to long point */
  length: number;
  /** the finished length along the centre line, between where its end cuts cross it */
  axial: number;
  ends: [MemberEnd, MemberEnd];
}

const TOL = 0.05;
const deg = (r: number) => (r * 180) / Math.PI;
/** rounded to a millionth of a millimetre, so sizes read as written (10, not 10.000000000000002) */
const r6 = (x: number) => Math.round(x * 1e6) / 1e6 || 0;
const p6 = (p: V3): V3 => [r6(p[0]), r6(p[1]), r6(p[2])];
const clamp1 = (x: number) => Math.max(-1, Math.min(1, x));

function roleOf(d: V3): MemberRole {
  if (Math.abs(d[2]) > 0.99) return "post";
  if (Math.abs(d[2]) < 0.01) return "rail";
  return "brace";
}

interface M {
  i: number;
  a: V3;
  b: V3;
  d: V3;
  L: number;
  u: V3;
  v: V3;
  rot: number;
  role: MemberRole;
  ends: [MemberEnd, MemberEnd];
}

interface Trim {
  /** where the centre line meets the face it stops against, from the joint point back along the member */
  axis: number;
  /** the shortest square-cut piece that is clear of the other member everywhere */
  clear: number;
  /** where the piece's long point must reach for a slanted or coped end */
  long: number;
  plane: { p: V3; n: V3 };
  cope?: { at: V3; dir: V3; d: number; h: number };
  angle: number;
  with: number;
}

/** How far a section reaches from its centre line in direction `dir` (across the member). */
export function reach(sec: Section, d: V3, u: V3, v: V3, dir: V3): number {
  if (sec.round) return (sec.w / 2) * vlen(vsub(dir, vscale(d, vdot(dir, d))));
  return (Math.abs(vdot(dir, u)) * sec.w) / 2 + (Math.abs(vdot(dir, v)) * sec.h) / 2;
}

/**
 * Plan a frame: trims, extensions and end cuts for every member, so members
 * butt against each other without overlapping (or meet in mitres), and
 * warnings for members that cross or lie along each other.
 */
export function planFrame(lines: FrameLine[], sec: Section, opts: { miter?: boolean } = {}): { members: PlannedMember[]; warnings: string[] } {
  const warnings: string[] = [];
  const free = (): MemberEnd => ({ ext: 0, axis: 0, angle: 0, joint: "free", meets: [] });
  const ms: M[] = lines.map((ln, i) => {
    const d = vnorm(vsub(ln.b, ln.a));
    const f = frameAt(ln.a, d, ln.rot);
    return { i, a: ln.a, b: ln.b, d, L: vlen(vsub(ln.b, ln.a)), u: f.u, v: vcross(d, f.u), rot: ln.rot, role: ln.role ?? roleOf(d), ends: [free(), free()] };
  });
  const support = (m: M, dir: V3) => reach(sec, m.d, m.u, m.v, dir);
  const endPt = (m: M, k: 0 | 1) => (k ? m.b : m.a);
  /** the way the member runs into its end k, carrying on past it */
  const into = (m: M, k: 0 | 1) => (k ? m.d : vscale(m.d, -1));
  const label = (m: M) => `member ${m.i + 1}`;

  /** Does point P lie on member n's body, strictly between its ends? */
  const onBody = (n: M, P: V3): V3 | null => {
    const t = vdot(vsub(P, n.a), n.d);
    if (t <= TOL || t >= n.L - TOL) return null;
    const X0 = vadd(n.a, vscale(n.d, t));
    const off = vsub(P, X0);
    if (sec.round) return vlen(off) <= sec.w / 2 + TOL ? X0 : null;
    return Math.abs(vdot(off, n.u)) <= sec.w / 2 + TOL && Math.abs(vdot(off, n.v)) <= sec.h / 2 + TOL ? X0 : null;
  };

  /** Member o's end k, at P, stopping against member n (whose centre line passes through X0, P's foot on it). */
  const trim = (o: M, k: 0 | 1, P: V3, n: M, X0: V3): Trim | null => {
    const back = vscale(into(o, k), -1);
    const perp = vsub(back, vscale(n.d, vdot(back, n.d)));
    const sin = vlen(perp);
    // within about 6° of lying along it: no face to stop against
    if (sin < 0.1) return null;
    const f = vscale(perp, 1 / sin);
    const cos = Math.abs(vdot(back, n.d));
    const off = vdot(vsub(P, X0), f);
    const hN = support(n, f);
    const q0 = vsub(f, vscale(o.d, vdot(f, o.d)));
    const hO = vlen(q0) > 1e-9 ? support(o, vnorm(q0)) : 0;
    const base = hN - off;
    const t: Trim = { axis: base / sin, clear: (base + hO * cos) / sin, long: (base - hO * cos) / sin, plane: { p: vadd(X0, vscale(f, hN)), n: vscale(f, -1) }, angle: deg(Math.acos(clamp1(sin))), with: n.i };
    if (sec.round) {
      // coped to fit round the other tube: where each line along the outside of this one meets the other's outside
      const R = sec.w / 2;
      const c = vsub(P, X0);
      const pb = vsub(back, vscale(n.d, vdot(back, n.d)));
      const side = vnorm(vcross(o.d, Math.abs(o.d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
      const side2 = vcross(o.d, side);
      let lo = Infinity;
      let hi = -Infinity;
      for (let j = 0; j < 48; j++) {
        const a = (j / 48) * Math.PI * 2;
        const w = vadd(vscale(side, R * Math.cos(a)), vscale(side2, R * Math.sin(a)));
        const g = vadd(c, w);
        const pg = vsub(g, vscale(n.d, vdot(g, n.d)));
        const A = vdot(pb, pb);
        const B = 2 * vdot(pg, pb);
        const C = vdot(pg, pg) - R * R;
        const disc = B * B - 4 * A * C;
        // a line that misses the other tube: it stops where the centre line does
        const s = disc < 0 ? t.axis : (-B + Math.sqrt(disc)) / (2 * A);
        lo = Math.min(lo, s);
        hi = Math.max(hi, s);
      }
      t.long = lo;
      t.clear = hi;
      t.cope = { at: vsub(X0, vscale(n.d, 4 * R + 4 * hO + 10)), dir: n.d, d: sec.w, h: 2 * (4 * R + 4 * hO + 10) };
    }
    return t;
  };

  const apply = (o: M, k: 0 | 1, t: Trim, joint: MemberEnd["joint"], meets: number[]) => {
    if (sec.catalogId) o.ends[k] = { ext: -t.clear, axis: -t.clear, angle: 0, joint, meets };
    else if (t.cope) o.ends[k] = { ext: -t.long, axis: -t.axis, cope: t.cope, angle: t.angle, joint, meets };
    else if (t.angle < 0.5) o.ends[k] = { ext: -t.axis, axis: -t.axis, angle: 0, joint, meets };
    else o.ends[k] = { ext: -t.long, axis: -t.axis, cut: t.plane, angle: t.angle, joint, meets };
  };

  // ends that meet at one point
  type End = { m: M; k: 0 | 1; P: V3 };
  const nodes: End[][] = [];
  for (const m of ms)
    for (const k of [0, 1] as const) {
      const P = endPt(m, k);
      const node = nodes.find((nd) => vlen(vsub(nd[0].P, P)) <= TOL);
      if (node) node.push({ m, k, P });
      else nodes.push([{ m, k, P }]);
    }

  /** which member of a corner runs through: an upright, then the longer, then one along X, then Y, then the first written */
  const rank = (x: M, y: M) => {
    const vx = Math.abs(x.d[2]) > 0.99 ? 0 : 1;
    const vy = Math.abs(y.d[2]) > 0.99 ? 0 : 1;
    if (vx !== vy) return vx - vy;
    if (Math.abs(x.L - y.L) > 0.5) return y.L - x.L;
    const ax = (d: V3) => (Math.abs(d[0]) > 0.99 ? 0 : Math.abs(d[1]) > 0.99 ? 1 : 2);
    return ax(x.d) - ax(y.d) || x.i - y.i;
  };

  for (const node of nodes) {
    const P = node[0].P;
    const inNode = new Set(node.map((e) => e.m.i));
    const through = ms.map((n) => ({ n, X0: inNode.has(n.i) ? null : onBody(n, P) })).filter((x): x is { n: M; X0: V3 } => !!x.X0);
    if (through.length) {
      // a line that ends on another member stops at its face
      for (const e of node) {
        let best: Trim | null = null;
        for (const { n, X0 } of through) {
          const t = trim(e.m, e.k, P, n, X0);
          if (t && (!best || t.clear > best.clear)) best = t;
        }
        if (best) apply(e.m, e.k, best, "tee", [best.with]);
        else warnings.push(`${label(e.m)} ends inside ${label(through[0].n)} but runs along it: end it where it meets that member, or move it off`);
      }
      continue;
    }
    if (node.length === 1) continue;
    if (node.length === 2) {
      const [e1, e2] = node;
      const c = vdot(into(e1.m, e1.k), into(e2.m, e2.k));
      if (c < -0.999) {
        // end to end in a straight line: a splice
        e1.m.ends[e1.k] = { ...free(), joint: "splice", meets: [e2.m.i] };
        e2.m.ends[e2.k] = { ...free(), joint: "splice", meets: [e1.m.i] };
        continue;
      }
      if (c > 0.999) {
        warnings.push(`${label(e1.m)} and ${label(e2.m)} lie along each other from the same point: remove one`);
        continue;
      }
      if (opts.miter && !sec.catalogId) {
        const a = vscale(into(e1.m, e1.k), -1);
        const b = vscale(into(e2.m, e2.k), -1);
        const th = Math.acos(clamp1(vdot(a, b)));
        if (th > (15 * Math.PI) / 180 && th < (165 * Math.PI) / 180) {
          for (const [e, x, y, other] of [
            [e1, a, b, e2],
            [e2, b, a, e1],
          ] as const) {
            const q = vnorm(vsub(y, vscale(x, vdot(y, x))));
            e.m.ends[e.k] = { ext: support(e.m, q) / Math.tan(th / 2), axis: 0, cut: { p: P, n: vnorm(vsub(y, x)) }, angle: 90 - deg(th) / 2, joint: "miter", meets: [other.m.i] };
          }
          continue;
        }
      }
    }
    // a butt corner: one runs through and the rest stop against what runs past them
    const order = [...node].sort((x, y) => rank(x.m, y.m));
    const R = order[0];
    const r = into(R.m, R.k);
    let ext = 0;
    for (let j = 1; j < order.length; j++) {
      const e = order[j];
      let best: Trim | null = null;
      for (let h = 0; h < j; h++) {
        const t = trim(e.m, e.k, P, order[h].m, P);
        if (t && (!best || t.clear > best.clear)) best = t;
      }
      if (!best) {
        warnings.push(`${label(e.m)} and ${label(R.m)} meet end to end almost in line: join them into one line, or bend the corner more`);
        continue;
      }
      apply(e.m, e.k, best, "butt", [best.with]);
      // the runner goes on past the corner far enough to cover this member's end
      const back = vscale(into(e.m, e.k), -1);
      ext = Math.max(ext, best.axis * vdot(back, r) + support(e.m, r));
    }
    R.m.ends[R.k] = { ext: Math.max(0, ext), axis: Math.max(0, ext), angle: 0, joint: "through", meets: order.slice(1).map((e) => e.m.i) };
  }

  const members: PlannedMember[] = ms.map((m) => {
    for (const e of m.ends) {
      e.ext = r6(e.ext);
      e.axis = r6(e.axis);
      e.angle = Math.round(e.angle * 1e4) / 1e4;
    }
    const [e0, e1] = m.ends;
    const start = p6(vsub(m.a, vscale(m.d, e0.ext)));
    const end = p6(vadd(m.b, vscale(m.d, e1.ext)));
    const length = r6(m.L + e0.ext + e1.ext);
    if (length < 1) warnings.push(`${label(m)} is ${length <= 0 ? "used up" : "under 1 mm long"} once its ends are cut to fit: make that line longer or leave it out`);
    return { index: m.i, from: m.a, to: m.b, dir: m.d, u: m.u, v: m.v, rot: m.rot, role: m.role, start, end, length, axial: r6(m.L + e0.axis + e1.axis), ends: m.ends };
  });

  // members that pass through each other
  for (let i = 0; i < ms.length; i++)
    for (let j = i + 1; j < ms.length; j++) {
      const x = ms[i];
      const y = ms[j];
      const c = vdot(x.d, y.d);
      if (Math.abs(c) > 0.999) {
        const off = vsub(y.a, x.a);
        const across = vsub(off, vscale(x.d, vdot(off, x.d)));
        const gap = vlen(across);
        const dir = gap > 1e-9 ? vscale(across, 1 / gap) : x.u;
        if (gap >= support(x, dir) + support(y, dir) - 0.1) continue;
        const t0 = vdot(vsub(y.a, x.a), x.d);
        const t1 = vdot(vsub(y.b, x.a), x.d);
        const overlap = Math.min(x.L, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1));
        if (overlap > TOL) warnings.push(`${label(x)} and ${label(y)} lie along each other for ${n(overlap)} mm: remove one or move it over`);
        continue;
      }
      // closest points of the two centre lines
      const w0 = vsub(x.a, y.a);
      const b = c;
      const dd = vdot(x.d, w0);
      const e = vdot(y.d, w0);
      const den = 1 - b * b;
      const s = (b * e - dd) / den;
      const t = (e - b * dd) / den;
      if (s <= TOL || s >= x.L - TOL || t <= TOL || t >= y.L - TOL) continue;
      const gapV = vsub(vadd(x.a, vscale(x.d, s)), vadd(y.a, vscale(y.d, t)));
      const gap = vlen(gapV);
      const dir = gap > 1e-9 ? vscale(gapV, 1 / gap) : vnorm(vcross(x.d, y.d));
      if (gap < support(x, dir) + support(y, dir) - 0.1) warnings.push(`${label(x)} and ${label(y)} cross: split one of them where they meet (end one line on the other)`);
    }
  return { members, warnings };
}

// ---------------------------------------------------------------- box frames

/** Where a section reaches along a world axis, for a member running along d turned rot degrees. */
function reachAlong(sec: Section, d: V3, rot: number, along: V3): number {
  const f = frameAt([0, 0, 0], d, rot);
  return reach(sec, d, f.u, vcross(d, f.u), along);
}

/** The turn (rot plus a multiple of 90°) that puts an angle's heel the way `out` points. */
function heelOut(d: V3, rot: number, out: V3): number {
  let best = rot;
  let score = -Infinity;
  for (const q of [0, 90, 180, 270]) {
    const f = frameAt([0, 0, 0], d, rot + q);
    const heel = vscale(vadd(f.u, vcross(d, f.u)), -1);
    const sc = vdot(heel, out);
    if (sc > score + 1e-9) {
      score = sc;
      best = rot + q;
    }
  }
  return best % 360;
}

const X: V3 = [1, 0, 0];
const Y: V3 = [0, 1, 0];
const Z: V3 = [0, 0, 1];

/**
 * The lines of a box frame w × d × h (outside sizes, sitting on z = 0, centred
 * on x and y): four full-height posts at the corners and a ring of rails along
 * X and Y at the bottom, the top and each of `levels` (heights to the rails'
 * centre lines). With h = 0 it is one flat rectangle. Angles are turned so
 * their heels face out.
 */
export function boxFrameLines(w: number, d: number, h: number, sec: Section, rot: number, opts: { levels?: number[]; top?: boolean; bottom?: boolean } = {}): FrameLine[] {
  const out: FrameLine[] = [];
  const lines = { push: (l: FrameLine) => out.push({ ...l, a: p6(l.a), b: p6(l.b) }) };
  const angle = sec.kind === "angle";
  const turn = (dir: V3, out: V3) => (angle ? heelOut(dir, rot, out) : rot);
  if (h <= 0) {
    // one flat rectangle: corners where the lines meet
    const ry = turn(Y, [1, 0, -1]);
    const rx = turn(X, [0, -1, -1]);
    const xc = w / 2 - reachAlong(sec, Y, ry, X);
    const yc = d / 2 - reachAlong(sec, X, rx, Y);
    const z = reachAlong(sec, X, rx, Z);
    const c: V3[] = [
      [-xc, -yc, z],
      [xc, -yc, z],
      [xc, yc, z],
      [-xc, yc, z],
    ];
    for (let i = 0; i < 4; i++) {
      const a = c[i];
      const b = c[(i + 1) % 4];
      const mid = vscale(vadd(a, b), 0.5);
      const outward: V3 = i % 2 === 0 ? [0, Math.sign(mid[1]), -1] : [Math.sign(mid[0]), 0, -1];
      lines.push({ a, b, rot: turn(vnorm(vsub(b, a)), outward), role: "rail" });
    }
    return out;
  }
  // corners in order round the base: (-x, -y), (+x, -y), (+x, +y), (-x, +y)
  const corners: [number, number][] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  const postRot = corners.map(([sx, sy]) => turn(Z, [sx, sy, 0]));
  const post = corners.map(([sx, sy], i): [number, number] => [sx * (w / 2 - reachAlong(sec, Z, postRot[i], X)), sy * (d / 2 - reachAlong(sec, Z, postRot[i], Y))]);
  post.forEach(([x, y], i) => lines.push({ a: [x, y, 0], b: [x, y, h], rot: postRot[i], role: "post" }));
  const zs: (number | "bottom" | "top")[] = [];
  if (opts.bottom !== false) zs.push("bottom");
  for (const z of opts.levels ?? []) zs.push(z);
  if (opts.top !== false) zs.push("top");
  for (const level of zs) {
    const up = level === "bottom" ? -1 : level === "top" ? 1 : level < h / 2 ? -1 : 1;
    const height = (r: number, dir: V3) => (level === "bottom" ? reachAlong(sec, dir, r, Z) : level === "top" ? h - reachAlong(sec, dir, r, Z) : level);
    for (const [sy, i, j] of [
      [-1, 0, 1],
      [1, 3, 2],
    ] as const) {
      const r = turn(X, [0, sy, up]);
      const y = sy * (d / 2 - reachAlong(sec, X, r, Y));
      const z = height(r, X);
      lines.push({ a: [post[i][0], y, z], b: [post[j][0], y, z], rot: r, role: "rail" });
    }
    for (const [sx, i, j] of [
      [1, 1, 2],
      [-1, 0, 3],
    ] as const) {
      const r = turn(Y, [sx, 0, up]);
      const x = sx * (w / 2 - reachAlong(sec, Y, r, X));
      const z = height(r, Y);
      lines.push({ a: [x, post[i][1], z], b: [x, post[j][1], z], rot: r, role: "rail" });
    }
  }
  return out;
}

// ---------------------------------------------------------------- solids

/** A block that takes away everything on the n side of the plane through p (within reach `size`). */
function slab(p: V3, nIn: V3, size: number): ShapeRecipe {
  const nv = vnorm(nIn);
  const xf: Xform[] = [];
  if (nv[2] < -1 + 1e-9) xf.push({ op: "rotate", angle: 180, origin: [0, 0, 0], axis: [1, 0, 0] });
  else if (nv[2] < 1 - 1e-9) xf.push({ op: "rotate", angle: deg(Math.acos(clamp1(nv[2]))), origin: [0, 0, 0], axis: vnorm(vcross(Z, nv)) });
  xf.push({ op: "translate", v: p });
  return { t: "xform", shape: { t: "box", w: size, d: size, h: size, at: [0, 0, 0], r: 0 }, xf };
}

/** The solid of a section member, in world coordinates: the section along its piece, with its end cuts. */
export function memberRecipe(sec: Section, m: PlannedMember): PartRecipe {
  const base: ShapeRecipe = { t: "extrude", p: sectionProfile(sec), h: m.length, f: { o: m.start, u: m.u, n: m.dir }, twist: 0, scale: 1 };
  const ops: PartRecipe["ops"] = [];
  const size = 8 * Math.max(sec.w, sec.h) + 4 * Math.max(0, ...m.ends.map((e) => Math.abs(e.ext))) + 20;
  for (const e of m.ends) {
    if (e.cut) ops.push({ op: "cut", shape: slab(e.cut.p, e.cut.n, size) });
    if (e.cope) ops.push({ op: "cut", shape: { t: "cyl", d: e.cope.d, h: e.cope.h, at: e.cope.at, dir: e.cope.dir } });
  }
  return { base, ops };
}

// ---------------------------------------------------------------- cut list

export interface CutRow {
  length: number;
  qty: number;
  /** each end's cut: 0 square, else degrees from square ("coped" ends say so) */
  ends: [string, string];
  members: string[];
}

/** How an end is cut, in words: "square", "45° mitre", "30° slant", "coped". */
export function endWords(e: MemberEnd): string {
  if (e.cope) return "coped";
  if (!e.cut || e.angle < 0.5) return "square";
  const a = Math.round(e.angle * 10) / 10;
  return e.joint === "miter" ? `${a}° mitre` : `${a}° slant`;
}

/** Identical pieces together, longest first. */
export function cutRows(members: { name: string; length: number; ends: [MemberEnd, MemberEnd] }[]): CutRow[] {
  const rows: CutRow[] = [];
  for (const m of members) {
    const len = Math.round(m.length * 10) / 10;
    const ends = [endWords(m.ends[0]), endWords(m.ends[1])].sort() as [string, string];
    const row = rows.find((r) => r.length === len && r.ends[0] === ends[0] && r.ends[1] === ends[1]);
    if (row) {
      row.qty++;
      row.members.push(m.name);
    } else rows.push({ length: len, qty: 1, ends, members: [m.name] });
  }
  return rows.sort((a, b) => b.length - a.length);
}

/** The saw cut allowed between pieces cut from one bar. */
export const SAW_KERF = 3;

/** Bars to buy for these pieces: the stock length (1 m, or the next 500 mm up from the longest piece) and how many, first fit longest first. */
export function stockPlan(rows: CutRow[]): { stock: number; bars: number } {
  const longest = rows.reduce((x, r) => Math.max(x, r.length), 0);
  const stock = longest <= 1000 ? 1000 : Math.ceil(longest / 500) * 500;
  const bars: number[] = [];
  for (const r of [...rows].sort((a, b) => b.length - a.length))
    for (let i = 0; i < r.qty; i++) {
      const k = bars.findIndex((left) => left >= r.length);
      if (k >= 0) bars[k] -= r.length + SAW_KERF;
      else bars.push(stock - r.length - SAW_KERF);
    }
  return { stock, bars: bars.length };
}
