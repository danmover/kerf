// Timing belts (lib.belt): the belt's path round its pulleys and clamps, the
// belt as a solid with its teeth, and what tension and acceleration do to it:
// stretch and cut length, pluck frequency, stiffness and ringing, slack and
// tooth load, and the pull on the motor shaft. The evaluator lays a belt out
// with layoutBelt, draws it with beltRecipe and works it out with analyseBelt;
// the checks, the calculation trace and the tension test read the BeltDef.

import type { CheckItem } from "../core/checks";
import type { PartRecipe, Profile, ProfileSeg, ShapeRecipe, V2, V3 } from "../kernel/recipe";
import { vadd, vcross, vdot, vlen, vnorm, vscale, vsub } from "../kernel/recipe";
import { fmtNum } from "../lang/values";
import type { BeltDef, BeltFigures, BeltNode, BeltSpan, CalcLine, CatalogPart } from "./types";

// ---------------------------------------------------------------- belt data

export interface BeltSpec {
  pitch: number;
  width: number;
  thickness: number;
  toothH: number;
  /** pitch line differential: the pitch line sits this far behind the tooth land, mm */
  pld: number;
  /** kg per metre */
  mass: number;
  /** tensile stiffness, N per unit strain */
  ea: number;
  /** pull the teeth carry for long life with 6 or more teeth in mesh, N */
  teMax: number;
  /** recommended installation tension range and the usual value, N */
  tMin: number;
  tMax: number;
  tNominal: number;
  /** smallest pulley the belt should run on, teeth */
  minTeeth: number;
  core: string;
  /** an endless loop, bought in stock lengths */
  closed: boolean;
  stock?: number[];
}

/** Stock lengths of closed GT2 loops, mm (the common sizes sellers keep). */
const GT2_LOOPS = [100, 110, 112, 122, 140, 158, 160, 180, 188, 200, 202, 210, 220, 232, 250, 260, 280, 300, 320, 350, 360, 400, 450, 500, 550, 600, 610, 700, 752, 800, 852, 1000, 1164, 1220, 1524];

export function beltSpec(p: CatalogPart): BeltSpec {
  const s = p.specs;
  const n = (k: string, d: number) => (typeof s[k] === "number" ? (s[k] as number) : d);
  const closed = s.closed === true;
  return {
    pitch: n("pitch", 2),
    width: n("width", 6),
    thickness: n("thickness", 1.38),
    toothH: n("tooth_h", 0.75),
    pld: n("pld", 0.254),
    mass: n("mass_g_m", 8.4) / 1000,
    ea: n("ea_n", 15000),
    teMax: n("te_max_n", 90),
    tMin: n("t_min_n", 8),
    tMax: n("t_max_n", 25),
    tNominal: n("t_nominal_n", 15),
    minTeeth: n("min_teeth", 12),
    core: String(s.core ?? "glass fibre"),
    closed,
    // a loop's own stock lengths when its catalog entry lists them ("350,375,…"), else the common GT2 loops
    stock: closed ? (typeof s.stock === "string" ? s.stock.split(",").map(Number).filter((x) => x > 0) : GT2_LOOPS) : undefined,
  };
}

/** How far the back of the belt stands above the pitch line, mm. */
const backAbove = (b: BeltSpec) => Math.max(0.2, b.thickness - b.toothH - b.pld);

// ---------------------------------------------------------------- inputs

export interface PulleyIn {
  k: "pulley";
  name: string;
  /** centre of the belt groove (the pulley's belt_center), world */
  c: V3;
  axis: V3;
  /** pitch diameter of a toothed pulley */
  pd: number;
  teeth?: number;
  /** a smooth roller (smooth idler or a bearing): the belt runs on contactD */
  smooth: boolean;
  contactD: number;
  grooveW?: number;
  beltW?: number;
  /** a toothed pulley made to be driven (it has a travel per turn) */
  driver: boolean;
  outside: boolean;
  label: string;
  /** pitch radius given outright (a sprocket: a roller chain's pitch line is the same on either face) */
  r?: number;
}
export interface PointIn {
  k: "point";
  p: V3;
}
export type BeltIn = PulleyIn | PointIn;

export interface MotorIn {
  name: string;
  label: string;
  /** a point on the shaft axis (the mounting face centre) and the axis, pointing out of the face */
  face: V3;
  axis: V3;
  holdNmm?: number;
  stepDeg?: number;
  radialN?: number;
  radialAt?: number;
}

export class BeltError extends Error {}

// ---------------------------------------------------------------- layout

type Piece = { k: "line"; a: V2; b: V2; len: number; s0: number } | { k: "arc"; c: V2; r: number; a0: number; sweep: number; s0: number };

export interface BeltLayout {
  open: boolean;
  /** 1 when the path runs counter-clockwise in (u, v); the teeth face that way's inside */
  orient: 1 | -1;
  o: V3;
  u: V3;
  v: V3;
  n: V3;
  nodes: BeltNode[];
  /** the input behind each node (undefined for clamps) */
  inputs: (PulleyIn | undefined)[];
  spans: Omit<BeltSpan, "hz">[];
  pieces: Piece[];
  length: number;
  /** pitch length from the start to each node's arrival and departure point */
  at: { arrive: number; depart: number }[];
}

const v2 = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]];
const s2 = (a: V2, k: number): V2 => [a[0] * k, a[1] * k];
const sub2 = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
const len2 = (a: V2) => Math.hypot(a[0], a[1]);
const left = (d: V2): V2 => [-d[1], d[0]];
const TAU = Math.PI * 2;
const mod2pi = (a: number) => ((a % TAU) + TAU) % TAU;
const deg = (r: number) => (r * 180) / Math.PI;

/**
 * Lay the belt out in its plane: the plane of the first pulley, with u along
 * world X (or Y) and v pointing up where it can. Each pulley's pitch circle
 * is joined to the next by the tangent the belt takes; open belts start and
 * end at their clamp points.
 */
export function layoutBelt(input: BeltIn[], b: BeltSpec): BeltLayout {
  const pts = input.filter((x) => x.k === "point").length;
  const open = input[0]?.k === "point" && input[input.length - 1]?.k === "point";
  if (pts && !open) throw new BeltError("path: an open belt starts and ends at a clamp point, with pulleys between, like path: [clamp_a, motor_pulley, idler, clamp_b]. A closed loop lists pulleys only.");
  if (pts > 2) throw new BeltError("path: only the two ends of an open belt can be points; everything between is a pulley");
  const pulleys = input.filter((x): x is PulleyIn => x.k === "pulley");
  if (open && pulleys.length < 1) throw new BeltError("path: an open belt needs at least one pulley between its two ends");
  if (!open && pulleys.length < 2) throw new BeltError("path: a closed loop needs at least two pulleys");
  if (input.length > 40) throw new BeltError("path: a belt is limited to 40 pulleys and clamps");

  // the belt plane and its frame
  let n = vnorm(pulleys[0].axis);
  const proj = (w: V3) => vsub(w, vscale(n, vdot(w, n)));
  let u = proj([1, 0, 0]);
  if (vlen(u) < 0.3) u = proj([0, 1, 0]);
  u = vnorm(u);
  let v = vcross(n, u);
  const up = Math.abs(v[2]) > 1e-6 ? v[2] : v[1];
  if (up < 0) {
    n = vscale(n, -1);
    v = vcross(n, u);
  }
  const o = pulleys[0].c;
  const to2 = (p: V3): V2 => [vdot(vsub(p, o), u), vdot(vsub(p, o), v)];

  const N = input.length;
  const c2 = input.map((x) => to2(x.k === "point" ? x.p : x.c));
  // which way the path runs round: the signed area of the polygon through the nodes
  let area = 0;
  for (let i = 0; i < N; i++) {
    const a = c2[i];
    const q = c2[(i + 1) % N];
    area += a[0] * q[1] - q[0] * a[1];
  }
  const orient: 1 | -1 = area < -1e-6 ? -1 : 1;
  const back = backAbove(b);

  const nodes: BeltNode[] = input.map((x, i) => {
    if (x.k === "point") {
      const name = i === 0 ? "start" : "end";
      return { name, kind: "clamp", c: c2[i], r: 0, dir: orient, outside: false, smooth: false, wrap: 0, offset: vdot(vsub(x.p, o), n), tilt: 0, label: `${name === "start" ? "first" : "second"} clamp` };
    }
    const dir: 1 | -1 = x.outside ? (-orient as 1 | -1) : orient;
    // the pitch line's radius depends on which face of the belt touches the pulley
    let r: number;
    if (x.r !== undefined) r = x.r;
    else if (!x.outside) r = x.smooth ? x.contactD / 2 + b.pld + b.toothH : x.pd / 2;
    else r = (x.smooth ? x.contactD / 2 : x.pd / 2 - b.pld) + back;
    const cosT = Math.min(1, Math.abs(vdot(vnorm(x.axis), n)));
    return { name: x.name, kind: "pulley", c: c2[i], r, dir, outside: x.outside, smooth: x.smooth, teeth: x.smooth ? undefined : x.teeth, wrap: 0, offset: vdot(vsub(x.c, o), n), tilt: deg(Math.acos(cosT)), grooveW: x.grooveW, beltW: x.beltW, label: x.label };
  });

  // pulleys whose pitch circles overlap would be drawn inside each other
  const wheels = nodes.filter((nd) => nd.kind === "pulley");
  for (let i = 0; i < wheels.length; i++)
    for (let j = i + 1; j < wheels.length; j++) {
      const A = wheels[i];
      const B = wheels[j];
      if (len2(sub2(B.c, A.c)) < A.r + B.r - 1e-6) throw new BeltError(`path: ${A.name} and ${B.name} are too close: their pitch circles overlap, so the belt cannot run between them`);
    }

  // tangents between consecutive nodes
  const segCount = open ? N - 1 : N;
  const tangents: { a: V2; b: V2; len: number }[] = [];
  for (let i = 0; i < segCount; i++) {
    const A = nodes[i];
    const B = nodes[(i + 1) % N];
    const D = sub2(B.c, A.c);
    const L = len2(D);
    const kA = A.dir * A.r;
    const kB = B.dir * B.r;
    const dk = kB - kA;
    if (L < 1e-6) throw new BeltError(`path: ${A.name} and ${B.name} are in the same place`);
    if (Math.abs(dk) >= L - 1e-6) throw new BeltError(`path: ${A.name} and ${B.name} are too close for the belt to run between them (their pitch circles overlap)`);
    const sinP = -dk / L;
    const cosP = Math.sqrt(1 - sinP * sinP);
    const dh = s2(D, 1 / L);
    const d = v2(s2(dh, cosP), s2(left(dh), sinP));
    const nl = left(d);
    tangents.push({ a: sub2(A.c, s2(nl, kA)), b: sub2(B.c, s2(nl, kB)), len: Math.sqrt(L * L - dk * dk) });
  }

  // wraps, and the pieces of the pitch line in order
  const pieces: Piece[] = [];
  const at: { arrive: number; depart: number }[] = nodes.map(() => ({ arrive: 0, depart: 0 }));
  let s = 0;
  const arc = (i: number) => {
    const nd = nodes[i];
    const into = tangents[(i - 1 + segCount) % segCount];
    const out = tangents[i];
    const ta = Math.atan2(into.b[1] - nd.c[1], into.b[0] - nd.c[0]);
    const td = Math.atan2(out.a[1] - nd.c[1], out.a[0] - nd.c[0]);
    let w = nd.dir > 0 ? mod2pi(td - ta) : mod2pi(ta - td);
    if (w > TAU - 1e-9) w = 0;
    nd.wrap = deg(w);
    if (nd.teeth && !nd.smooth) nd.teethInMesh = (w / TAU) * nd.teeth;
    at[i].arrive = s;
    if (w > 1e-9) pieces.push({ k: "arc", c: nd.c, r: nd.r, a0: ta, sweep: nd.dir * w, s0: s });
    s += nd.r * w;
    at[i].depart = s;
  };
  const line = (i: number) => {
    const t = tangents[i];
    pieces.push({ k: "line", a: t.a, b: t.b, len: t.len, s0: s });
    s += t.len;
  };
  if (open) {
    at[0] = { arrive: 0, depart: 0 };
    for (let i = 0; i < N - 1; i++) {
      if (i > 0) arc(i);
      line(i);
    }
    at[N - 1] = { arrive: s, depart: s };
  } else {
    for (let i = 0; i < N; i++) {
      arc(i);
      line(i);
    }
  }
  for (const nd of nodes) if (nd.kind === "pulley" && nd.wrap < 1e-6) throw new BeltError(`path: the belt does not touch ${nd.name}. List the pulleys in the order the belt meets them, and put back-side idlers in outside:`);

  const to3 = (p: V2): V3 => vadd(o, vadd(vscale(u, p[0]), vscale(v, p[1])));
  const spans = tangents.map((t, i) => ({
    from: nodes[i].name,
    to: nodes[(i + 1) % N].name,
    a: t.a,
    b: t.b,
    a3: to3(t.a),
    b3: to3(t.b),
    length: t.len,
  }));
  return { open, orient, o, u, v, n, nodes, inputs: input.map((x) => (x.k === "pulley" ? x : undefined)), spans, pieces, length: s, at };
}

// ---------------------------------------------------------------- the solid

type Seg = { from: V2; to: V2; via?: V2 };

/** The pitch line offset sideways by `off` (positive to the left of travel), as segments. */
function offsetSegs(pieces: Piece[], off: number): Seg[] {
  const out: Seg[] = [];
  for (const p of pieces) {
    if (p.k === "line") {
      const nl = left(s2(sub2(p.b, p.a), 1 / Math.max(1e-9, p.len)));
      out.push({ from: v2(p.a, s2(nl, off)), to: v2(p.b, s2(nl, off)) });
    } else {
      const r = p.r - Math.sign(p.sweep) * off;
      const pt = (a: number): V2 => [p.c[0] + r * Math.cos(a), p.c[1] + r * Math.sin(a)];
      out.push({ from: pt(p.a0), via: pt(p.a0 + p.sweep / 2), to: pt(p.a0 + p.sweep) });
    }
  }
  return out;
}

/**
 * The tooth side, with GT2-form teeth on the free spans. Teeth sit every
 * pitch along the pitch line, so they line up from span to span; on the
 * pulleys the belt is drawn by its land, which clears the pulley's drawn rim.
 */
function toothedSegs(pieces: Piece[], off: number, toothDir: number, b: BeltSpec): Seg[] {
  const out: Seg[] = [];
  // tooth outline per unit pitch (2 mm GT2): flank, round tip, flank
  const half = 0.31 * b.pitch;
  const flankX = 0.25 * b.pitch;
  const flankY = 0.56 * b.toothH;
  for (const p of pieces) {
    if (p.k === "arc") {
      out.push(...offsetSegs([p], off));
      continue;
    }
    const d = s2(sub2(p.b, p.a), 1 / Math.max(1e-9, p.len));
    const nl = left(d);
    const base = v2(p.a, s2(nl, off));
    const tip = s2(nl, toothDir);
    const at = (x: number, y = 0): V2 => v2(v2(base, s2(d, x)), s2(tip, y));
    let pen = 0;
    // first tooth centre at the next whole pitch along the belt
    let x = Math.ceil((p.s0 + half + 0.05) / b.pitch) * b.pitch - p.s0;
    while (x + half + 0.05 <= p.len) {
      if (x - half > pen) out.push({ from: at(pen), to: at(x - half) });
      out.push({ from: at(x - half), to: at(x - flankX, flankY) });
      out.push({ from: at(x - flankX, flankY), via: at(x, b.toothH), to: at(x + flankX, flankY) });
      out.push({ from: at(x + flankX, flankY), to: at(x + half) });
      pen = x + half;
      x += b.pitch;
    }
    if (p.len > pen) out.push({ from: at(pen), to: at(p.len) });
  }
  return out;
}

const reverse = (segs: Seg[]): Seg[] => segs.map((s) => ({ from: s.to, to: s.from, via: s.via })).reverse();

function pathProfile(segs: Seg[], closeTo?: V2): Profile {
  const out: ProfileSeg[] = [];
  for (const s of segs) {
    if (len2(sub2(s.to, s.from)) < 1e-7) continue;
    out.push(s.via ? { s: "arc", via: s.via, to: s.to } : { s: "line", to: s.to });
  }
  if (closeTo) out.push({ s: "line", to: closeTo });
  return { t: "path2", start: segs[0].from, segs: out };
}

/** Teeth on a belt are many small faces: past this many, even detailed builds show it smooth. */
const MAX_TEETH = 1500;

/**
 * The belt as a solid, centred on its plane: the land-to-back band in fast
 * builds, with the teeth on its free spans in detailed ones.
 */
export function beltRecipe(L: BeltLayout, b: BeltSpec): PartRecipe {
  const toothSide = L.orient; // teeth face the inside of the path: left of travel when it runs counter-clockwise
  const land = toothSide * b.pld;
  const backOff = -toothSide * backAbove(b);
  const f = { o: vsub(L.o, vscale(L.n, b.width / 2)), u: L.u, n: L.n };
  const band = (teeth: boolean): ShapeRecipe => {
    const backSegs = offsetSegs(L.pieces, backOff);
    const landSegs = teeth ? toothedSegs(L.pieces, land, toothSide, b) : offsetSegs(L.pieces, land);
    let p: Profile;
    if (L.open) {
      // back from start to end, across the end, then the tooth side back to the start
      p = pathProfile([...backSegs, { from: backSegs[backSegs.length - 1].to, to: landSegs[landSegs.length - 1].to }, ...reverse(landSegs)], backSegs[0].from);
    } else {
      p = { t: "diff2", a: pathProfile(backSegs), b: [pathProfile(landSegs)] };
    }
    return { t: "extrude", p, h: b.width, f, twist: 0, scale: 1 };
  };
  const spanLen = L.pieces.reduce((n, p) => n + (p.k === "line" ? p.len : 0), 0);
  const fast = band(false);
  if (spanLen / b.pitch > MAX_TEETH) return { base: fast, ops: [] };
  return { base: { t: "lod", fast, detail: band(true) }, ops: [] };
}

// ---------------------------------------------------------------- analysis

export interface BeltLoad {
  /** moving mass, g, and its acceleration, mm/s² */
  mass?: number;
  accel?: number;
  /** extra steady pull: rail and seal friction, N */
  friction?: number;
  /** torque the drive pulley delivers, N·mm (closed loops and drives) */
  torque?: number;
  /** a peak pull given directly, N */
  force?: number;
}

/** Pluck frequency of a free span: f = (1 / 2L) √(T / μ). */
export function spanHz(tension: number, lengthMm: number, massKgM: number): number {
  return (1 / (2 * (lengthMm / 1000))) * Math.sqrt(Math.max(0, tension) / massKgM);
}

/** Tension that makes a span sound at f Hz. */
export function tensionForHz(hz: number, lengthMm: number, massKgM: number): number {
  return massKgM * (2 * (lengthMm / 1000) * hz) ** 2;
}

/** A stepper's holding stiffness at the shaft, N·mm per radian, at the share of rated current it runs at. */
export function stepperStiffness(holdNmm: number, stepDeg = 1.8, currentShare = 0.7): number {
  // torque follows sin(electrical angle); an electrical cycle is four full steps
  return (holdNmm * currentShare * TAU) / ((4 * stepDeg * Math.PI) / 180);
}

export interface BeltAnalysis {
  spans: BeltSpan[];
  tension: number;
  tensionAssumed: boolean;
  figures: BeltFigures;
  drive?: number;
  load?: BeltDef["load"];
  cutLength?: number;
  stockLength?: number;
  teeth?: number;
}

/** The drive pulley when none is named: the first toothed pulley made to be driven, else the first toothed one. */
export function drivePulley(L: BeltLayout): number | undefined {
  const idx = L.inputs.findIndex((x) => x && !x.smooth && x.driver);
  const any = idx >= 0 ? idx : L.inputs.findIndex((x) => x && !x.smooth);
  return any >= 0 ? any : undefined;
}

export function analyseBelt(L: BeltLayout, b: BeltSpec, opts: { tension?: number; load: BeltLoad; drive?: number; motor?: MotorIn }): BeltAnalysis {
  const { load } = opts;
  const r = (x: number) => Math.round(x * 1000) / 1000;
  const drive = opts.drive ?? drivePulley(L);
  const dn = drive !== undefined ? L.nodes[drive] : undefined;

  // peak pull the belt has to pass: inertia plus friction (linear axes), or the drive torque
  const inertial = load.mass !== undefined && load.accel !== undefined ? (load.mass / 1000) * (load.accel / 1000) : 0;
  const friction = load.friction ?? 0;
  let force: number | undefined;
  if (load.force !== undefined) force = load.force;
  else if (load.torque !== undefined && dn) force = load.torque / dn.r;
  else if (load.mass !== undefined && load.accel !== undefined) force = inertial + friction;
  const loadOut = force !== undefined ? { mass: load.mass, accel: load.accel, friction, torque: load.torque, force } : undefined;

  // tension: as given, else the usual value, raised so the slack side never goes slack
  let tension = opts.tension;
  const tensionAssumed = tension === undefined;
  if (tension === undefined) tension = Math.min(b.tMax, Math.max(b.tNominal, force !== undefined ? 1.25 * (L.open ? force : force / 2) : 0));

  const spans: BeltSpan[] = L.spans.map((s) => ({ ...s, hz: r(spanHz(tension, s.length, b.mass)) }));
  const figures: BeltFigures = { stretch: r((L.length * tension) / b.ea) };

  if (dn && drive !== undefined) {
    const k = (len: number) => b.ea / Math.max(1, len);
    let frac: number;
    if (L.open) {
      const lenA = L.at[drive].arrive;
      const lenB = L.length - L.at[drive].depart;
      figures.lenA = r(lenA);
      figures.lenB = r(lenB);
      figures.kShown = r(k(lenA) + k(lenB));
      // the softest place on the travel is where both sides are the same length
      figures.kMin = r((4 * b.ea) / (lenA + lenB));
      // worst case for slack and peak tension: the carriage at the end of its travel, where the short side takes nearly all of the pull
      frac = 1;
    } else {
      // a closed drive: the pull splits evenly between the two sides
      const tot = L.length - (L.at[drive].depart - L.at[drive].arrive);
      figures.kShown = r(k(tot) * 2);
      figures.kMin = figures.kShown;
      frac = 0.5;
    }
    if (opts.motor?.holdNmm) {
      figures.kMotor = r(stepperStiffness(opts.motor.holdNmm, opts.motor.stepDeg ?? 1.8) / (dn.r * dn.r));
      const series = (a: number, c: number) => 1 / (1 / a + 1 / c);
      figures.kTotalShown = r(series(figures.kShown, figures.kMotor));
      figures.kTotalMin = r(series(figures.kMin, figures.kMotor));
    } else {
      figures.kTotalShown = figures.kShown;
      figures.kTotalMin = figures.kMin;
    }
    if (load.mass !== undefined && load.mass > 0) {
      const ring = (kNmm: number) => Math.sqrt((kNmm * 1000) / (load.mass! / 1000)) / TAU;
      figures.ringShown = r(ring(figures.kTotalShown!));
      figures.ringMin = r(ring(figures.kTotalMin!));
      if (inertial > 0) figures.lag = r(inertial / figures.kTotalMin!);
    }
    figures.teethInMesh = dn.teethInMesh !== undefined ? r(dn.teethInMesh) : undefined;
    const tim = dn.teethInMesh ?? 6;
    figures.teAllowed = r(b.teMax * Math.min(1, tim / 6));
    if (force !== undefined) {
      figures.tight = r(tension + frac * force);
      figures.slack = r(tension - frac * force);
    }
    // pull on the drive shaft: the two spans' tensions added as vectors
    const iIn = (drive - 1 + L.spans.length) % L.spans.length;
    const inSpan = L.open && drive === 0 ? undefined : L.spans[L.open ? drive - 1 : iIn];
    const outSpan = L.spans[drive];
    const away = (from: V2, to: V2): V2 => s2(sub2(to, from), 1 / Math.max(1e-9, len2(sub2(to, from))));
    if (inSpan && outSpan) {
      const dIn = away(inSpan.b, inSpan.a);
      const dOut = away(outSpan.a, outSpan.b);
      const hub = (tIn: number, tOut: number) => len2(v2(s2(dIn, tIn), s2(dOut, tOut)));
      figures.hubStatic = r(hub(tension, tension));
      if (force !== undefined) {
        const hi = tension + frac * force;
        const lo = Math.max(0, tension - frac * force);
        figures.hubPeak = r(Math.max(hub(hi, lo), hub(lo, hi)));
      }
    }
    if (opts.motor?.radialN && opts.motor.radialAt) {
      // the radial rating is quoted a distance from the face: a pull further out loads the bearings more
      figures.hubLimit = r(opts.motor.radialN * Math.min(1.5, opts.motor.radialAt / Math.max(1, motorLever(opts.motor, L.inputs[drive]!))));
    }
  }

  const out: BeltAnalysis = { spans, tension, tensionAssumed, figures, drive, load: loadOut };
  if (L.open) {
    // cut it short by the stretch, plus 20 mm at each end to hold in the clamps, to the next 10 mm
    out.cutLength = Math.ceil((L.length / (1 + tension / b.ea) + 40) / 10) * 10;
  } else {
    const want = L.length / (1 + tension / b.ea);
    const stock = b.stock?.length ? b.stock.reduce((best, x) => (Math.abs(x - want) < Math.abs(best - want) ? x : best), b.stock[0]) : Math.round(want / b.pitch) * b.pitch;
    out.stockLength = stock;
    out.teeth = Math.round(stock / b.pitch);
  }
  return out;
}

/** How far out from the motor's face the belt pulls, mm. */
export function motorLever(m: MotorIn, p: PulleyIn): number {
  return Math.abs(vdot(vsub(p.c, m.face), vnorm(m.axis)));
}

/** True when the pulley sits on the motor's shaft (axes in line within 1 mm, belt in front of the face). */
export function onShaft(m: MotorIn, p: PulleyIn): boolean {
  const ax = vnorm(m.axis);
  if (Math.abs(vdot(ax, vnorm(p.axis))) < 0.999) return false;
  const d = vsub(p.c, m.face);
  const along = vdot(d, ax);
  const off = vlen(vsub(d, vscale(ax, along)));
  return off < 1 && along > -2 && along < 80;
}

// ---------------------------------------------------------------- checks

const N = (x: number, d = 1) => fmtNum(x, d);

/** What the belt is called in messages: its role ("X belt") or its name. */
export function beltTitle(b: BeltDef): string {
  if (b.role) return /belt/i.test(b.role) ? cap(b.role) : `${b.role.length <= 2 ? b.role.toUpperCase() : cap(b.role)} belt`;
  return b.name;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The longest free span: the one to pluck when setting the tension. */
export function pluckSpan(b: BeltDef): BeltSpan | undefined {
  return [...b.spans].sort((x, y) => y.length - x.length)[0];
}

const spanName = (s: BeltSpan) => `${s.from === "start" ? "the first clamp" : s.from === "end" ? "the second clamp" : s.from} to ${s.to === "start" ? "the first clamp" : s.to === "end" ? "the second clamp" : s.to}`;

export function beltChecks(b: BeltDef): CheckItem[] {
  const out: CheckItem[] = [];
  const t = beltTitle(b);
  const f = b.figures;
  const base = { category: "engineering" as const, parts: [b.name], span: b.span, basis: "calculation" as const };
  const geo = { ...base, basis: "geometry" as const };

  // the belt has to sit on every pulley: in the plane, square to it and narrow enough for the groove
  const bad: string[] = [];
  let worst: "pass" | "warn" | "fail" = "pass";
  const worse = (s: "warn" | "fail") => (worst = worst === "fail" || s === "fail" ? "fail" : "warn");
  for (const nd of b.nodes) {
    if (nd.kind === "clamp") {
      if (Math.abs(nd.offset) > 1) {
        bad.push(`the ${nd.label} is ${N(Math.abs(nd.offset))} mm out of the belt's plane, so the belt twists into it`);
        worse(Math.abs(nd.offset) > 3 ? "fail" : "warn");
      }
      continue;
    }
    if (nd.beltW !== undefined && nd.beltW + 1e-6 < b.belt.width) {
      bad.push(`${nd.name} is made for a ${N(nd.beltW, 0)} mm belt, not ${N(b.belt.width, 0)} mm`);
      worse("fail");
    }
    const play = nd.grooveW !== undefined ? Math.max(0, (nd.grooveW - b.belt.width) / 2) : 0.5;
    const off = Math.abs(nd.offset);
    if (off > play + 1.5) {
      bad.push(`${nd.name} is ${N(off)} mm off the belt's line: the belt rides on its flange or falls off`);
      worse("fail");
    } else if (off > play + 0.05) {
      bad.push(`${nd.name} is ${N(off)} mm off the belt's line (${N(play)} mm of play): the belt rubs a flange`);
      worse("warn");
    }
    if (nd.tilt > 1) {
      bad.push(`${nd.name}'s axis is ${N(nd.tilt)}° off square to the belt: it walks off`);
      worse("fail");
    } else if (nd.tilt > 0.25) {
      bad.push(`${nd.name}'s axis is ${N(nd.tilt)}° off square to the belt (keep it under 0.25°)`);
      worse("warn");
    }
  }
  out.push({ ...geo, id: `belt:align:${b.name}`, status: worst, title: worst === "pass" ? `${t} runs true on its pulleys` : `${t} is out of line`, detail: worst === "pass" ? `Every pulley${b.open ? " and both clamps" : ""} sit in the belt's plane, square to it and wide enough for the ${N(b.belt.width, 0)} mm belt.` : cap(bad.join("; ")) + ".", fix: worst === "pass" ? undefined : "Move the pulleys along their axes (spacers or a shaft collar) until every belt groove is on one line, and square the axles." });

  // small pulleys fatigue the cords
  const small = b.nodes.filter((nd) => nd.kind === "pulley" && !nd.outside && nd.teeth !== undefined && nd.teeth < b.belt.minTeeth);
  if (small.length) out.push({ ...base, id: `belt:small:${b.name}`, status: "warn", title: `${t}: pulley too small for the belt`, detail: `${small.map((nd) => `${nd.name} has ${nd.teeth} teeth`).join("; ")}. A ${b.belt.core} belt should run on ${b.belt.minTeeth} teeth or more, or its cords crack early.` });

  // teeth in mesh on the drive pulley
  const dn = b.nodes.find((nd) => nd.name === b.drive);
  if (dn?.teethInMesh !== undefined) {
    const tim = dn.teethInMesh;
    out.push({ ...geo, id: `belt:mesh:${b.name}`, status: tim >= 6 ? "pass" : tim >= 4 ? "warn" : "fail", title: `${t}: teeth in mesh on ${dn.name}`, detail: `${N(tim)} teeth engaged over ${N(dn.wrap, 0)}° of wrap. ${tim >= 6 ? "Six or more carry the full rating." : `Below six the teeth share less load and can jump under a hard stop; ${tim < 4 ? "add an idler to wrap the belt further round." : "wrap the belt further round if you can."}`}`, margin: tim / 6 });
  }

  if (b.load && f.tight !== undefined && f.slack !== undefined) {
    const fz = b.load.force;
    // the slack side must stay tight at full acceleration
    out.push({
      ...base,
      id: `belt:slack:${b.name}`,
      status: f.slack > 0.15 * b.tension ? "pass" : f.slack > 0 ? "warn" : "fail",
      title: f.slack > 0 ? `${t} stays taut under load` : `${t} goes slack under load`,
      detail: `Peak pull ${N(fz)} N${b.load.mass !== undefined && b.load.accel !== undefined ? ` (${N(b.load.mass, 0)} g at ${N(b.load.accel, 0)} mm/s²${b.load.friction ? ` plus ${N(b.load.friction)} N of friction` : ""})` : b.load.torque !== undefined ? ` (${N(b.load.torque / 1000, 2)} N·m on ${b.drive})` : ""}. ${b.open ? "Near the end of the travel the short side takes almost all of it, so" : "Split between the two sides,"} the slack side drops to ${N(f.slack)} N from ${N(b.tension)} N.${f.slack <= 0 ? " A slack side lets the teeth jump and the axis lose position." : ""}`,
      margin: b.tension / Math.max(1e-6, b.tension - f.slack),
      fix: f.slack > 0.15 * b.tension ? undefined : `Tension it to at least ${N(Math.ceil(1.2 * (b.tension - f.slack)), 0)} N, or lower the acceleration.`,
    });
    // the teeth and cords carry the pull
    if (f.teAllowed !== undefined) {
      const ok = fz <= f.teAllowed;
      out.push({ ...base, id: `belt:load:${b.name}`, status: ok ? (fz <= 0.7 * f.teAllowed ? "pass" : "warn") : "fail", title: `${t} carries the pull`, detail: `Peak pull ${N(fz)} N against about ${N(f.teAllowed, 0)} N the teeth carry for long life${dn?.teethInMesh !== undefined && dn.teethInMesh < 6 ? ` with ${N(dn.teethInMesh)} teeth in mesh` : ""}; tight side ${N(f.tight)} N.`, margin: f.teAllowed / Math.max(1e-6, fz), fix: ok ? undefined : "Use a wider belt (9 mm), a bigger drive pulley or less acceleration." });
    }
  } else if (!b.load) {
    out.push({ ...base, id: `belt:noload:${b.name}`, status: "info", title: `${t}: load not given`, detail: `Give it mass: and accel: (a linear axis) or torque: (a drive) so Kerf can check slack, tooth load and ringing.`, basis: "needs analysis" });
  }

  // installation tension against the recommended range
  const tOk = b.tension >= b.belt.tMin && b.tension <= b.belt.tMax;
  out.push({
    ...base,
    id: `belt:tension:${b.name}`,
    status: tOk ? "pass" : "warn",
    title: tOk ? `${t} tension ${N(b.tension)} N` : b.tension < b.belt.tMin ? `${t} is loose` : `${t} is over-tight`,
    detail: `${b.tensionAssumed ? "Not given, so Kerf assumed " : ""}${N(b.tension)} N; ${N(b.belt.tMin, 0)} to ${N(b.belt.tMax, 0)} N suits a ${N(b.belt.width, 0)} mm ${b.belt.core} belt.${(() => {
      const s = pluckSpan(b);
      return s ? ` Pluck ${spanName(s)} (${N(s.length, 0)} mm free): ${N(s.hz, 0)} Hz.` : "";
    })()}${tOk ? "" : b.tension < b.belt.tMin ? " A loose belt rings, backlashes and can jump teeth." : " Over-tight belts stretch, wear pulleys and load the motor bearings."}`,
    fix: tOk ? undefined : `Set tension: to about ${N((b.belt.tMin + b.belt.tMax) / 2, 0)} N.`,
  });

  // pull on the motor shaft
  if (b.motor && f.hubStatic !== undefined && f.hubLimit !== undefined) {
    const peak = Math.max(f.hubStatic, f.hubPeak ?? 0);
    const st = peak <= f.hubLimit ? "pass" : peak <= 2 * f.hubLimit ? "warn" : "fail";
    out.push({ ...base, id: `belt:hub:${b.name}`, status: st, title: `${b.motor.name} shaft load from the ${t}`, detail: `${N(f.hubStatic)} N at rest${f.hubPeak !== undefined ? `, ${N(f.hubPeak)} N at peak` : ""}, ${N(b.motor.lever)} mm out from the face; the bearings are rated for about ${N(b.motor.radialN ?? 0, 0)} N at ${N(b.motor.radialAt ?? 0, 0)} mm (${N(f.hubLimit, 0)} N where this belt pulls).${st === "pass" ? "" : " More than that wears the motor's front bearing early."}`, margin: f.hubLimit / Math.max(1e-6, peak), fix: st === "pass" ? undefined : "Lower the tension, move the pulley closer to the motor face, or carry the pulley on its own bearing." });
  }

  // stiffness: how far the axis lags at full acceleration, and where it rings
  if (f.ringMin !== undefined) {
    const lag = f.lag ?? 0;
    const st = f.ringMin >= 25 && lag <= 0.1 ? "pass" : f.ringMin >= 15 && lag <= 0.25 ? "warn" : "fail";
    out.push({ ...base, id: `belt:stiff:${b.name}`, status: st, title: `${t} stiffness`, detail: `${N(f.kTotalMin ?? 0, 0)} N/mm at its softest${b.motor && f.kMotor ? ` (belt ${N(f.kMin ?? 0, 0)} N/mm with ${b.motor.name}'s holding stiffness in series)` : ""}, so the moving ${N(b.load?.mass ?? 0, 0)} g rings at about ${N(f.ringMin, 0)} Hz${f.ringShown !== undefined && Math.abs(f.ringShown - f.ringMin) > 1 ? ` (${N(f.ringShown, 0)} Hz where it is shown)` : ""} and lags ${N(lag * 1000, 0)} µm at full acceleration. Measure it and tune input shaping once it is built.${st === "pass" ? "" : " A soft axis leaves ripples after corners: use shorter belts, a wider or steel-core belt, or less moving mass."}`, margin: f.ringMin / 25 });
  }

  // closed loops come in stock lengths
  if (!b.open && b.stockLength !== undefined) {
    const want = b.length / (1 + b.tension / b.belt.ea);
    const diff = b.stockLength - want;
    const st = Math.abs(diff) <= 1 ? "pass" : Math.abs(diff) <= 4 ? "warn" : "fail";
    out.push({ ...geo, id: `belt:stock:${b.name}`, status: st, title: `${t} matches a stock loop`, detail: `The path needs ${N(b.length)} mm of pitch length (${N(want)} mm before stretch); the nearest stock loop is ${N(b.stockLength, 0)} mm (${Math.round(b.stockLength / b.belt.pitch)} teeth).${st === "pass" ? "" : ` Move a pulley ${N(Math.abs(diff) / 2)} mm ${diff > 0 ? "apart" : "together"}, or give the drive a tensioner.`}`, margin: 4 / Math.max(0.01, Math.abs(diff)) });
  }
  return out;
}

// ---------------------------------------------------------------- calculation trace and test

const L = (label: string, value: number, unit: string, note?: string): CalcLine => ({ label, value: Math.round(value * 1000) / 1000, unit, note });

export function beltTrace(b: BeltDef): { fn: string; title: string; inputs: CalcLine[]; outputs: CalcLine[]; method: string[]; assumptions: string[]; confidence: "estimate"; verify?: string } {
  const f = b.figures;
  const t = beltTitle(b);
  const s = pluckSpan(b);
  const inputs: CalcLine[] = [L("Installation tension", b.tension, "N", b.tensionAssumed ? "assumed" : undefined), L("Belt width", b.belt.width, "mm", b.belt.core), L("Belt mass", b.belt.mass * 1000, "g/m"), L("Belt stiffness (EA)", b.belt.ea, "N")];
  if (b.load?.mass !== undefined) inputs.push(L("Moving mass", b.load.mass, "g"));
  if (b.load?.accel !== undefined) inputs.push(L("Acceleration", b.load.accel, "mm/s²"));
  if (b.load?.friction) inputs.push(L("Friction", b.load.friction, "N"));
  if (b.load?.torque !== undefined) inputs.push(L("Drive torque", b.load.torque / 1000, "N·m"));
  const outputs: CalcLine[] = [L("Pitch length", b.length, "mm")];
  if (b.cutLength) outputs.push(L("Cut length", b.cutLength, "mm", "stretch taken off, 20 mm per clamp added"));
  if (b.stockLength) outputs.push(L("Stock loop", b.stockLength, "mm", `${Math.round(b.stockLength / b.belt.pitch)} teeth`));
  outputs.push(L("Stretch when tensioned", f.stretch, "mm"));
  if (s) outputs.push(L(`Pluck ${s.from}–${s.to}`, s.hz, "Hz", `${Math.round(s.length)} mm free span`));
  if (f.ringMin !== undefined) outputs.push(L("Lowest ringing frequency", f.ringMin, "Hz"));
  if (f.kTotalMin !== undefined) outputs.push(L("Softest stiffness", f.kTotalMin, "N/mm"));
  if (f.lag !== undefined) outputs.push(L("Lag at full acceleration", f.lag * 1000, "µm"));
  if (b.load) outputs.push(L("Peak pull", b.load.force, "N"));
  if (f.tight !== undefined) outputs.push(L("Peak tight side", f.tight, "N"));
  if (f.slack !== undefined) outputs.push(L("Lowest slack side", f.slack, "N"));
  if (f.teethInMesh !== undefined) outputs.push(L(`Teeth in mesh on ${b.drive}`, f.teethInMesh, ""));
  if (f.hubStatic !== undefined) outputs.push(L(`Pull on ${b.motor?.name ?? b.drive}'s shaft`, Math.max(f.hubStatic, f.hubPeak ?? 0), "N"));
  const method = [
    "Path: tangent lines between the pulleys' pitch circles, plus the wrap round each; the pitch line runs 0.25 mm behind the tooth land.",
    "Pluck frequency of a free span: f = (1 / 2L) √(T / μ), with μ the belt's mass per metre.",
    "Stretch: ΔL = T L / EA; open belts are cut short by it, plus 20 mm at each end for the clamps.",
  ];
  if (b.open) method.push("Carriage stiffness: the belt from each clamp to the drive pulley in parallel, k = EA / L₁ + EA / L₂; softest with both sides equal, k = 4 EA / (L₁ + L₂).");
  if (b.motor?.holdNmm) method.push(`Motor in series: holding stiffness ≈ 0.7 × holding torque × 2π / (4 steps), divided by r² at the pulley.`);
  if (f.ringMin !== undefined) method.push("Ringing: f = (1 / 2π) √(k / m).");
  if (b.load) method.push(b.open ? "Peak pull F = m a + friction; worst case at the end of the travel, where the short side takes nearly all of F: slack side T − F, tight side T + F." : "Peak pull F = torque / pitch radius, split evenly: slack side T − F/2, tight side T + F/2.");
  const assumptions = [
    `Typical ${b.belt.core} GT2 figures: ${N(b.belt.mass * 1000)} g/m, EA ≈ ${N(b.belt.ea / 1000, 0)} kN (measured on 6 mm belts, scaled by width). Branded belts can be stiffer.`,
    "Frame, idler axles and clamps are rigid: the real axis is softer, so it rings lower than this.",
    "Tooth rating from Gates' 2MGT tables, halved for generic belts.",
  ];
  if (b.motor?.holdNmm) assumptions.push(`${b.motor.name} runs at about 70 % of its rated current.`);
  const verify = f.ringMin !== undefined ? `Once tensioned, measure the ${t} resonance (Klipper: an ADXL345 and TEST_RESONANCES): expect roughly ${N(f.ringMin, 0)} Hz or a little lower, then set input shaping from the measurement.` : undefined;
  return { fn: "belt", title: `${t}: tension, stretch and stiffness`, inputs, outputs, method, assumptions, confidence: "estimate", verify };
}

/** The tension test for the build's test plan. */
export function beltTest(b: BeltDef): { title: string; steps: string; pass: string } | undefined {
  const s = pluckSpan(b);
  if (!s) return undefined;
  const lo = spanHz(b.tension * 0.9, s.length, b.belt.mass);
  const hi = spanHz(b.tension * 1.1, s.length, b.belt.mass);
  const where = b.open ? "With the carriage where the model shows it" : "With the drive at rest";
  return {
    title: `${beltTitle(b)} tension`,
    steps: `${where}, pluck the free span from ${spanName(s)} (${N(s.length, 0)} mm) and read the note with a phone tuner or spectrum app. Adjust the tensioner and pluck again.`,
    pass: `${N(s.hz, 0)} Hz for ${N(b.tension)} N (${N(lo, 0)} to ${N(hi, 0)} Hz is within 10 %)${b.open && b.spans.length > 2 ? "; the spans either side of the carriage should sound the same once it is moved to the middle" : ""}.`,
  };
}

/** The belt's figures as component fields, for require lines and calculations. */
export function beltFields(b: BeltDef): Record<string, number> {
  const f = b.figures;
  const s = pluckSpan(b);
  const out: Record<string, number> = { length: b.length, tension: b.tension, stretch: f.stretch, width: b.belt.width, pitch: b.belt.pitch };
  if (b.cutLength !== undefined) out.cut_length = b.cutLength;
  if (b.stockLength !== undefined) out.stock_length = b.stockLength;
  if (b.teeth !== undefined) out.teeth = b.teeth;
  if (s) {
    out.hz = s.hz;
    out.span = s.length;
  }
  const opt: [string, number | undefined][] = [
    ["stiffness", f.kTotalShown],
    ["stiffness_min", f.kTotalMin],
    ["ringing_hz", f.ringMin],
    ["lag", f.lag],
    ["tight", f.tight],
    ["slack", f.slack],
    ["teeth_in_mesh", f.teethInMesh],
    ["hub_load", f.hubStatic !== undefined ? Math.max(f.hubStatic, f.hubPeak ?? 0) : undefined],
  ];
  for (const [k, v] of opt) if (v !== undefined) out[k] = v;
  return out;
}

// ---------------------------------------------------------------- editing

/** Adds tension: to a lib.belt(...) call that has none, just before its closing bracket. */
export function insertTension(source: string, b: BeltDef, v: number): string | null {
  const from = b.span ? source.indexOf("lib.belt(", b.span.start) : -1;
  if (from < 0 || (b.span && from > b.span.end)) return null;
  let depth = 0;
  let quote = "";
  for (let i = from + "lib.belt".length; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"') quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") {
      depth--;
      if (depth === 0) return source.slice(0, i) + `, tension: ${fmtNum(v, 1)}N` + source.slice(i);
    }
  }
  return null;
}
