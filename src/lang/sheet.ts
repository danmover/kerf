// Sheet-metal parts: a flat base with flanges bent up or down along its
// edges, each with a real inside radius, optional lips, hems, rolls and jogs,
// automatic corner gaps and bend reliefs, and louvres pressed into the base or
// a flange. Besides the solid, sheet() records where every bend is
// and how each flat region unfolds, so the kernel makes the flat pattern from
// the finished part (holes and cut-outs included) and the checks read flange
// lengths and bend data without measuring.
//
// Each flange is worked out in its edge's cross-section: s runs outward from
// the base edge, z up from the base's bottom face. The "R face" is the face
// on the right as you travel from the base out along the flange (the base's
// bottom face); bends that turn left (up) have it on the outside.

import { def } from "./builtins";
import type { Args } from "./args";
import { Obj, ShapeV, Vec, typeName, type Value } from "./values";
import type { Profile, ProfileSeg, ShapeRecipe, V2, V3, Xform } from "../kernel/recipe";

type P = [number, number];

const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1]];
const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
const mul = (a: P, k: number): P => [a[0] * k, a[1] * k];
const dot = (a: P, b: P) => a[0] * b[0] + a[1] * b[1];
const rot = (v: P, a: number): P => [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)];
const left = (d: P): P => [-d[1], d[0]];
const right = (d: P): P => [d[1], -d[0]];
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const DEG = Math.PI / 180;

/** Where lines p + a·d and q + b·e cross. */
function meet(p: P, d: P, q: P, e: P): P {
  const den = d[0] * e[1] - d[1] * e[0];
  if (Math.abs(den) < 1e-12) return p;
  const a = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den;
  return add(p, mul(d, a));
}

/** Thickness slack of the unfold regions, so they never share a face with the sheet's skins. */
const EPS = 0.02;

export interface SheetBend {
  /** which bend: "front", "edge 3", "front lip" */
  name: string;
  /** degrees: + bends up (toward the flat pattern's top face), − down */
  angle: number;
  /** inside radius, mm */
  r: number;
  /** flat length the bend takes (bend allowance), mm */
  allowance: number;
  /** length of the bend line, mm */
  length: number;
  /** the bend's centre line on the flat pattern, in the part's own (x, y) */
  line: [V2, V2];
}

export interface SheetFlange {
  /** "front", "edge 2" */
  name: string;
  h: number;
  angle: number;
  /** flat length between the flange's bends (or out to its edge), mm; with a jog, the shorter of its two parts */
  flat: number;
  lip?: { length: number; angle: number; flat: number };
  /** a hem: its outside length, the gap asked for between its layers (0: closed) and its folded-back flat */
  hem?: { length: number; gap: number; flat: number };
  /** a roll: its inside radius and how far round it curls */
  roll?: { r: number; angle: number };
  /** a jog: the outside height of its first bend, its offset and angle, and the flat between its bends */
  jog?: { at: number; offset: number; angle: number; flat: number };
  /** hem() on the base's own edge (h is its length) rather than a flange */
  kind?: "hem" | "roll";
}

/** A louvre pressed into the base or a flange, as the checks read it. */
export interface SheetForm {
  kind: "louvre";
  /** "base louvre 1", "front louvre 2" */
  name: string;
  /** "base", or the flange it is pressed into */
  on: string;
  /** the middle of its slit, on the face it stands out of */
  c: V3;
  length: number;
  width: number;
  height: number;
  /** flat left between it and the nearest edge, bend or hem, mm */
  margin: number;
  /** what that is: "the front bend", "the left edge" */
  near: string;
  /** flat left between it and the next louvre on the same face, mm */
  web?: number;
}

/** A flat region of the bent part as an oriented box (centre, unit axes, half sizes), for collision checks. */
export interface SheetBox {
  name: string;
  c: V3;
  axes: [V3, V3, V3];
  half: V3;
}

export interface SheetInfo {
  t: number;
  /** inside bend radius the flanges default to */
  r: number;
  k: number;
  gap: number;
  /** height of the base's bottom face */
  z: number;
  flanges: SheetFlange[];
  bends: SheetBend[];
  boxes: SheetBox[];
  /** each flange's regions on the flat pattern (x, y outlines), for the overlap check */
  flatRegions: { flange: string; pts: V2[] }[];
  /** outline of the flat pattern's extent, (x, y) min and max */
  flatBox: [V2, V2];
  /** pieces of the finished part to lift onto the flat and where they go, plus the bends laid flat (and plain sheet where a louvre is pressed in after cutting) */
  unfold: { pieces: { region: ShapeRecipe; xf: Xform[] }[]; bends: ShapeRecipe[] };
  /** louvres, when it has any */
  forms?: SheetForm[];
}

/** A sheet() body: its solid plus what the flat pattern and the checks need. */
export class SheetV extends ShapeV {
  constructor(
    recipe: ShapeRecipe,
    public info: SheetInfo,
  ) {
    super(recipe);
  }
}

// ---------- one flange in its cross-section ----------

interface Bend {
  tin: P;
  tout: P;
  centre: P;
  /** radius on the R face */
  rho: number;
  theta: number;
  din: P;
  dout: P;
  /** inside radius */
  r: number;
}

interface Chain {
  /** s where the base stops and the first bend starts (negative: inside the base edge) */
  sb: number;
  b1: Bend;
  /** wall: R-face start and end, direction */
  w0: P;
  w1: P;
  d1: P;
  b2?: Bend;
  l0?: P;
  l1?: P;
  d2?: P;
}

function bendAt(c: P, din: P, theta: number, r: number, t: number): Bend {
  const rho = theta > 0 ? r + t : r;
  const b = rho * Math.tan(Math.abs(theta) / 2);
  const dout = rot(din, theta);
  const tin = sub(c, mul(din, b));
  const tout = add(c, mul(dout, b));
  const centre = add(tin, mul(theta > 0 ? left(din) : right(din), rho));
  return { tin, tout, centre, rho, theta, din, dout, r };
}

/**
 * The R-face outline of a flange from its outside dimensions: h runs from the
 * outer face of the base at the edge to the far face of the flange (or of its
 * lip), along the flange; a lip's length runs from the flange's outer face.
 */
function chainOf(t: number, r1: number, theta1: number, h: number, lip: { length: number; theta: number; r: number } | null, err: (m: string) => never): Chain {
  const d0: P = [1, 0];
  const d1 = rot(d0, theta1);
  const v1: P = theta1 > 0 ? [0, 0] : [0, t];
  const fr = theta1 > 0 ? v1 : add(v1, mul(right(d1), t));
  const c1 = meet([0, 0], d0, fr, d1);
  const q = add(v1, mul(d1, h));
  const b1 = bendAt(c1, d0, theta1, r1, t);
  if (b1.tin[0] > -1e-9) err("the bend would start outside the base");
  if (!lip) {
    const end = theta1 > 0 ? q : add(q, mul(right(d1), t));
    const flat = dot(sub(end, b1.tout), d1);
    if (flat <= 1e-6) err(`h ${r3(h)} is too short for its bend: with r ${r3(r1)} and t ${r3(t)} it needs more than ${r3(h - flat)} mm`);
    return { sb: b1.tin[0], b1, w0: b1.tout, w1: end, d1 };
  }
  const d2 = rot(d1, lip.theta);
  const lr = lip.theta > 0 ? q : add(q, mul(right(d2), t));
  const c2 = meet(fr, d1, lr, d2);
  const b2 = bendAt(c2, d1, lip.theta, lip.r, t);
  const tip = add(q, mul(d2, lip.length));
  const end = lip.theta > 0 ? tip : add(tip, mul(right(d2), t));
  const flat = dot(sub(b2.tin, b1.tout), d1);
  if (flat <= 1e-6) err(`h ${r3(h)} is too short for two bends: with r ${r3(r1)} and t ${r3(t)} it needs more than ${r3(h - flat)} mm`);
  const lipFlat = dot(sub(end, b2.tout), d2);
  if (lipFlat <= 1e-6) err(`lip ${r3(lip.length)} is too short for its bend: it needs more than ${r3(lip.length - lipFlat)} mm`);
  return { sb: b1.tin[0], b1, w0: b1.tout, w1: b2.tin, d1, b2, l0: b2.tout, l1: end, d2 };
}

/** The bend zone as a closed profile: the R-face arc out, across the thickness, the L-face arc back. */
function bendProfile(b: Bend, t: number): Profile {
  const tinL = add(b.tin, mul(left(b.din), t));
  const toutL = add(b.tout, mul(left(b.dout), t));
  const midR = add(b.centre, rot(sub(b.tin, b.centre), b.theta / 2));
  const midL = add(b.centre, rot(sub(tinL, b.centre), b.theta / 2));
  const segs: ProfileSeg[] = [
    { s: "arc", via: midR, to: b.tout },
    { s: "line", to: toutL },
    { s: "arc", via: midL, to: tinL },
    { s: "line", to: b.tin },
  ];
  return { t: "path2", start: b.tin, segs };
}

/** A flat strip from a to b (R face) with direction d, thickness t, as a quad; grow pads the outer faces. */
function quad(a: P, b: P, d: P, t: number, grow = 0, past = 0): P[] {
  const a0 = add(a, mul(right(d), grow));
  const b0 = add(add(b, mul(d, past)), mul(right(d), grow));
  const up = mul(left(d), t + grow);
  return [a0, b0, add(add(b, mul(d, past)), up), add(a, up)];
}

/** quad() grown by its own amount on each face: less on a face with another layer of the same flange close by (a hem). */
function quadG(a: P, b: P, d: P, t: number, growR: number, growL: number, past = 0): P[] {
  const end = add(b, mul(d, past));
  const up = mul(left(d), t + growL);
  return [add(a, mul(right(d), growR)), add(end, mul(right(d), growR)), add(end, up), add(a, up)];
}

/**
 * A bend that starts at tin (on the R face) heading din and turns theta, of any size: a hem's 180° or a roll's 270°,
 * which bendAt (from where two straight lines cross) cannot make.
 */
function bendFrom(tin: P, din: P, theta: number, r: number, t: number): Bend {
  const rho = theta > 0 ? r + t : r;
  const centre = add(tin, mul(theta > 0 ? left(din) : right(din), rho));
  return { tin, tout: add(centre, rot(sub(tin, centre), theta)), centre, rho, theta, din, dout: rot(din, theta), r };
}

/** Which stretch of the edge a step runs along: the first bend's, the wall's (with any jog), or the far edge's (lip, hem or roll). */
type StepSpan = "bend" | "wall" | "lip";
/** A flat run's face that has another layer of the same flange beside it (a hem's), and how far away. */
interface Facing {
  side: "L" | "R";
  gap: number;
}

/** One piece of a flange's cross-section, from the base out: a bend, or a flat run on the R face from a to b along d. */
type Step = { k: "bend"; b: Bend; span: StepSpan; name: string; angle: number } | { k: "run"; a: P; b: P; d: P; span: StepSpan; name: string; facing?: Facing };

interface Steps {
  /** s where the base stops and the first bend starts (negative: inside the base edge) */
  sb: number;
  steps: Step[];
  /** flat of the wall between its bends (the shorter part, with a jog), of a lip, of a hem's return and of a jog's riser */
  flat: number;
  lipFlat?: number;
  hemFlat?: number;
  jogFlat?: number;
  /** where the flange's outside height is measured from, and the wall's direction (for louvres up the wall) */
  v1: P;
  d1: P;
}

/** The gap a closed hem is modelled with: a hair between its layers, a tenth of the sheet. */
const closedGap = (t: number) => Math.max(0.05, 0.1 * t);

/** A plain flange (with or without a lip) as steps: the same solid and flat pattern as before steps. */
function stepsOf(c: Chain, nm: string, angle: number, t: number): Steps {
  const steps: Step[] = [
    { k: "bend", b: c.b1, span: "bend", name: nm, angle },
    { k: "run", a: c.w0, b: c.w1, d: c.d1, span: "wall", name: nm },
  ];
  const out: Steps = { sb: c.sb, steps, flat: dot(sub(c.w1, c.w0), c.d1), v1: angle > 0 ? [0, 0] : [0, t], d1: c.d1 };
  if (c.b2 && c.l0 && c.l1 && c.d2) {
    steps.push({ k: "bend", b: c.b2, span: "lip", name: `${nm} lip`, angle: c.b2.theta / DEG }, { k: "run", a: c.l0, b: c.l1, d: c.d2, span: "lip", name: `${nm} lip` });
    out.lipFlat = dot(sub(c.l1, c.l0), c.d2);
  }
  return out;
}

/**
 * A flange with a jog part way up, or a hem or roll at its far edge (a lip goes with a jog too). As for chainOf, h is
 * the outside height, to the far face of the flange or of its fold; the jog's offset is between the two parts' faces.
 */
function richSteps(t: number, r: number, f: FlangeArgs, nm: string, err: (m: string) => never): Steps {
  const theta1 = f.angle * DEG;
  const d0: P = [1, 0];
  const d1 = rot(d0, theta1);
  const v1: P = theta1 > 0 ? [0, 0] : [0, t];
  const fr = theta1 > 0 ? v1 : add(v1, mul(right(d1), t));
  const b1 = bendAt(meet([0, 0], d0, fr, d1), d0, theta1, r, t);
  if (b1.tin[0] > -1e-9) err("the bend would start outside the base");
  const pos = (x: P) => dot(sub(x, v1), d1);
  const steps: Step[] = [{ k: "bend", b: b1, span: "bend", name: nm, angle: f.angle }];
  const out: Steps = { sb: b1.tin[0], steps, flat: 0, v1, d1 };
  // the wall's R-face line as it goes (a point on it), and where the next flat run starts
  let line = fr;
  let from = b1.tout;
  const run = (to: P, d: P, span: StepSpan, name: string, short: (len: number) => string, facing?: Facing): number => {
    const len = dot(sub(to, from), d);
    if (len <= 1e-6) err(short(len));
    steps.push({ k: "run", a: from, b: to, d, span, name, ...(facing ? { facing } : {}) });
    return len;
  };
  const bend = (b: Bend, span: StepSpan, name: string) => {
    steps.push({ k: "bend", b, span, name, angle: b.theta / DEG });
    from = b.tout;
  };
  let shift: P = [0, 0];
  let lower: number | undefined;
  if (f.jog) {
    const [at, off] = f.jog;
    const thj = f.jogAngle * DEG;
    // out is away from the inside of the part: the right of a wall bent up, the left of one bent down
    const outward = theta1 > 0 ? right(d1) : left(d1);
    const side = off > 0 ? outward : mul(outward, -1);
    const phi = dot(side, right(d1)) > 0 ? -thj : thj;
    const dj = rot(d1, phi);
    const c1 = add(line, mul(d1, at - pos(line)));
    const c2 = add(c1, mul(dj, Math.abs(off) / Math.sin(thj)));
    const bj1 = bendAt(c1, d1, phi, r, t);
    const bj2 = bendAt(c2, dj, -phi, r, t);
    lower = run(bj1.tin, d1, "wall", nm, (len) => `the jog at ${r3(at)} is too close to the bend below it: put it at ${r3(at - len + Math.max(1, t))} or higher`);
    bend(bj1, "wall", `${nm} jog`);
    out.jogFlat = run(bj2.tin, dj, "wall", `${nm} jog`, (len) => `the jog's offset ${r3(Math.abs(off))} is too small for two bends of r ${r3(r)} at ${r3(f.jogAngle)}°: make it more than ${r3(Math.abs(off) - len * Math.sin(thj))}, or give a smaller jog_angle`);
    bend(bj2, "wall", `${nm} jog`);
    line = c2;
    shift = mul(side, Math.abs(off));
  }
  // the far end of the flange on its outside, moved over by any jog
  const q = add(add(v1, mul(d1, f.h)), shift);
  const tooShort = (what: string) => (len: number) => `h ${r3(f.h)} is too short for ${what}: it needs more than ${r3(f.h - len)} mm`;
  let wall: number;
  if (f.lip) {
    const theta2 = Math.sign(f.lip) * Math.sign(f.angle) * f.lipAngle * DEG;
    const d2 = rot(d1, theta2);
    const lr = theta2 > 0 ? q : add(q, mul(right(d2), t));
    const b2 = bendAt(meet(line, d1, lr, d2), d1, theta2, r, t);
    const tip = add(q, mul(d2, Math.abs(f.lip)));
    wall = run(b2.tin, d1, "wall", nm, tooShort(f.jog ? "its jog and lip" : "two bends"));
    bend(b2, "lip", `${nm} lip`);
    out.lipFlat = run(theta2 > 0 ? tip : add(tip, mul(right(d2), t)), d2, "lip", `${nm} lip`, (len) => `lip ${r3(Math.abs(f.lip))} is too short for its bend: it needs more than ${r3(Math.abs(f.lip) - len)} mm`);
  } else if (f.hem || f.roll) {
    // folded back 180° (a hem) or curled round (a roll), the fold's outside at the flange's height
    const rolled = !f.hem;
    const ri = rolled ? Math.abs(f.roll) : (f.hemGap > 0 ? f.hemGap : closedGap(t)) / 2;
    const theta = Math.sign(rolled ? f.roll : f.hem) * Math.sign(f.angle) * (rolled ? f.rollAngle : 180) * DEG;
    const tin = add(line, mul(d1, f.h - ri - t - pos(line)));
    const fold = bendFrom(tin, d1, theta, ri, t);
    const facing: Facing | undefined = rolled ? undefined : { side: theta > 0 ? "L" : "R", gap: 2 * ri };
    const wallFrom = pos(from);
    wall = run(tin, d1, "wall", nm, tooShort(`its ${rolled ? "roll" : "hem"}`), facing);
    bend(fold, "lip", `${nm} ${rolled ? "roll" : "hem"}`);
    if (!rolled) {
      const L = Math.abs(f.hem);
      if (L <= ri + t + 1e-6) err(`hem ${r3(L)} is too short to fold back: make it more than ${r3(ri + t)} mm`);
      if (f.h - L < wallFrom - 1e-6) err(`hem ${r3(L)} is longer than the straight part of the flange it folds onto: make it ${r3(f.h - wallFrom)} mm or less`);
      out.hemFlat = run(add(fold.tout, mul(fold.dout, L - ri - t)), fold.dout, "lip", `${nm} hem`, () => `hem ${r3(L)} is too short to fold back`, facing);
    }
  } else wall = run(theta1 > 0 ? q : add(q, mul(right(d1), t)), d1, "wall", nm, tooShort(f.jog ? "its jog" : "its bend"));
  out.flat = lower === undefined ? wall : Math.min(lower, wall);
  return out;
}

/** hem(): the base's own edge folded back over its top face (or under it), or rolled into a curl, its fold's outside on the edge. */
function baseHemSteps(t: number, f: FlangeArgs, nm: string, err: (m: string) => never): Steps {
  const d0: P = [1, 0];
  const rolled = !!f.roll;
  const ri = rolled ? Math.abs(f.roll) : (f.hemGap > 0 ? f.hemGap : closedGap(t)) / 2;
  const theta = (f.baseHem! > 0 ? 1 : -1) * (rolled ? f.rollAngle : 180) * DEG;
  const sb = -(ri + t);
  const fold = bendFrom([sb, 0], d0, theta, ri, t);
  const what = rolled ? "roll" : "hem";
  const steps: Step[] = [{ k: "bend", b: fold, span: "bend", name: `${nm} ${what}`, angle: theta / DEG }];
  const out: Steps = { sb, steps, flat: 0, v1: [0, 0], d1: d0 };
  if (!rolled) {
    const L = f.h;
    if (L <= ri + t + 1e-6) err(`length ${r3(L)} is too short to fold back: make it more than ${r3(ri + t)} mm`);
    steps.push({ k: "run", a: fold.tout, b: add(fold.tout, mul(fold.dout, L - ri - t)), d: fold.dout, span: "wall", name: `${nm} hem`, facing: { side: theta > 0 ? "L" : "R", gap: 2 * ri } });
    out.flat = out.hemFlat = L - ri - t;
  }
  return out;
}

// ---------- louvres ----------

const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * Where a louvre sits: the middle of its slit on the face it stands out of (O), its length (X), its open side (Y) and
 * the way it stands out (Z). The sheet there lies from Z −t to 0.
 */
interface LvFrame {
  O: V3;
  X: V3;
  Y: V3;
  Z: V3;
}

/** A (Y, Z) cross-section in a louvre's frame, pushed along its length from x0 to x1. */
function lvPrism(f: LvFrame, pts: P[], x0: number, x1: number): ShapeRecipe {
  // the extrusion's own v axis is n × u, which is Z for n = Y × Z whichever way X points
  const n = cross3(f.Y, f.Z);
  const o = add3(f.O, mul3(f.X, dot3(n, f.X) > 0 ? x0 : x1));
  return { t: "extrude", p: { t: "poly", pts: pts.map((q) => [q[0], q[1]] as V2), r: 0 }, h: x1 - x0, f: { o, u: f.Y, n }, twist: 0, scale: 1 };
}

/**
 * A louvre of length L, width w and height H: the slit cut from the sheet, and the hood (hinged on its closed side, its
 * open edge H out) with a cheek closing each end, added once the slit is cut.
 */
function louvreSolids(f: LvFrame, L: number, w: number, H: number, t: number): { slit: ShapeRecipe; adds: ShapeRecipe[] } {
  const e = 0.05;
  const slit = lvPrism(
    f,
    [
      [-w / 2, -t - e],
      [w / 2, -t - e],
      [w / 2, e],
      [-w / 2, e],
    ],
    -L / 2,
    L / 2,
  );
  const hood = lvPrism(
    f,
    [
      [-w / 2 - t / 2, -t],
      [w / 2, H - t],
      [w / 2, H],
      [-w / 2 - t / 2, 0],
    ],
    -L / 2 - t,
    L / 2 + t,
  );
  // each cheek fills under the hood's end, from the middle of the sheet up to the middle of the hood
  const cheek: P[] = [
    [-w / 2 - t / 2, -t / 2],
    [w / 2, -t / 2],
    [w / 2, H - t / 2],
  ];
  return { slit, adds: [hood, lvPrism(f, cheek, L / 2, L / 2 + t), lvPrism(f, cheek, -L / 2 - t, -L / 2)] };
}

/** A louvre's footprint on its face, grown by pad: x0..x1 along it, y0..y1 across (its open side at y1). */
const lvFoot = (L: number, w: number, t: number, pad: number) => ({ x0: -L / 2 - t - pad, x1: L / 2 + t + pad, y0: -w / 2 - t / 2 - pad, y1: w / 2 + pad });

const segDist = (q: P, a: P, b: P) => {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const u = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, dot(sub(q, a), ab) / l2));
  const c = add(a, mul(ab, u));
  return Math.hypot(q[0] - c[0], q[1] - c[1]);
};

/** Clear distance between two convex outlines (a segment counts as one): 0 or less when they touch or cross. */
function convexGap(a: P[], b: P[]): number {
  let apart = -Infinity;
  for (const poly of [a, b])
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len < 1e-12) continue;
      const nn: P = [-(q[1] - p[1]) / len, (q[0] - p[0]) / len];
      const pa = a.map((x) => dot(x, nn));
      const pb = b.map((x) => dot(x, nn));
      apart = Math.max(apart, Math.min(...pb) - Math.max(...pa), Math.min(...pa) - Math.max(...pb));
    }
  if (apart <= 1e-9) return apart;
  let d = Infinity;
  for (const [u, v] of [
    [a, b],
    [b, a],
  ])
    for (const x of u) for (let i = 0; i < v.length; i++) d = Math.min(d, segDist(x, v[i], v[(i + 1) % v.length]));
  return d;
}

function insidePoly(q: P, poly: V2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > q[1] !== yj > q[1] && q[0] < ((xj - xi) * (q[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** One louvre() for sheet()'s louvres, as its object holds it. */
interface LouvreArgs {
  length: number;
  width: number;
  height: number;
  /** "base", or the edge of the flange it is pressed into */
  on: Value;
  /** its middle: (x, y) on the base, (along from the edge's middle, height up the flange) on a flange; null: the middle */
  at: [number, number] | null;
  angle: number;
  count: number;
  pitch: number | null;
  flip: boolean;
}

function louvreArgs(v: Value, i: number, err: (m: string) => never): LouvreArgs {
  if (!(v instanceof Obj) || v.kind !== "louvre") return err(`sheet(): louvres[${i}] should be a louvre(length, width, height, ...), got ${typeName(v)}`);
  const f = v.fields;
  const n = (x: Value | undefined, d: number) => (typeof x === "number" ? x : d);
  const at = Array.isArray(f.at) && typeof f.at[0] === "number" && typeof f.at[1] === "number" ? ([f.at[0], f.at[1]] as [number, number]) : null;
  return { length: n(f.length, 0), width: n(f.width, 0), height: n(f.height, 0), on: f.on ?? "base", at, angle: n(f.angle, 0), count: n(f.count, 1), pitch: typeof f.pitch === "number" ? f.pitch : null, flip: f.flip === true };
}

/** A flange's steps: plain flanges and lips as they always were, the rest from richSteps, a hem of the base from baseHemSteps. */
function flangeSteps(t: number, rSheet: number, f: FlangeArgs, nm: string, err: (m: string) => never): Steps {
  const r = f.r ?? rSheet;
  if (f.baseHem) return baseHemSteps(t, f, nm, err);
  if (f.jog || f.hem || f.roll) return richSteps(t, r, f, nm, err);
  const lip = f.lip ? { length: Math.abs(f.lip), theta: Math.sign(f.lip) * Math.sign(f.angle) * f.lipAngle * DEG, r } : null;
  return stepsOf(chainOf(t, r, f.angle * DEG, f.h, lip, err), nm, f.angle, t);
}

// ---------- the base outline and its edges ----------

interface Edge {
  p0: V2;
  e: V2;
  n: V2;
  len: number;
}

const RECT_EDGES = ["front", "right", "back", "left"];

/** The base outline as counter-clockwise points, and the user's edge index for each of its edges. */
function baseOutline(p: Profile, err: (m: string) => never): { pts: V2[]; names: string[]; userIndex: number[] } {
  if (p.t === "rect") {
    if (p.r > 1e-9) err("sheet(): give the base sharp corners (rect(w, h) without r); round them afterwards with fillet(r, edges: \"vertical\")");
    const [cx, cy] = p.c;
    const pts: V2[] = [
      [cx - p.w / 2, cy - p.h / 2],
      [cx + p.w / 2, cy - p.h / 2],
      [cx + p.w / 2, cy + p.h / 2],
      [cx - p.w / 2, cy + p.h / 2],
    ];
    return { pts, names: RECT_EDGES, userIndex: [0, 1, 2, 3] };
  }
  if (p.t === "poly") {
    if (p.r > 1e-9) err("sheet(): give the base sharp corners (polygon(points) without r); round them afterwards with fillet(r, edges: \"vertical\")");
    let pts = p.pts.slice();
    if (pts.length > 2 && dist(pts[0], pts[pts.length - 1]) < 1e-9) pts = pts.slice(0, -1);
    if (pts.length < 3) err("sheet(): the base polygon needs at least 3 corners");
    const n = pts.length;
    let area = 0;
    for (let i = 0; i < n; i++) area += pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1];
    if (Math.abs(area) < 1e-9) err("sheet(): the base polygon has no area");
    // the user's edge i runs from points[i] to points[i + 1]
    let userIndex = pts.map((_, i) => i);
    if (area < 0) {
      pts = pts.reverse();
      userIndex = pts.map((_, j) => (((n - 2 - j) % n) + n) % n);
    }
    const names = pts.map((_, j) => `edge ${userIndex[j]}`);
    return { pts, names, userIndex };
  }
  return err(`sheet(): the base must be a rect() or polygon() outline, got a ${p.t} profile`);
}

const dist = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function edgesOf(pts: V2[]): Edge[] {
  return pts.map((p0, i) => {
    const p1 = pts[(i + 1) % pts.length];
    const len = dist(p0, p1);
    const e: V2 = [(p1[0] - p0[0]) / len, (p1[1] - p0[1]) / len];
    return { p0, e, n: [e[1], -e[0]], len };
  });
}

/** Which of the outline's edges a flange's edge: names (fname: the function named in the messages). */
function resolveEdge(v: Value, edges: Edge[], names: string[], userIndex: number[], err: (m: string) => never, fname = "flange"): number[] {
  if (typeof v === "number") {
    const j = userIndex.indexOf(Math.round(v));
    if (!Number.isInteger(v) || j < 0) err(`${fname}(): edge ${v} does not exist; the base has edges 0 to ${edges.length - 1}`);
    return [j];
  }
  if (typeof v !== "string") return err(`${fname}(): edge should be a name like "front" or an edge number, got ${typeName(v)}`);
  const name = v.trim().toLowerCase();
  if (name === "all") return edges.map((_, i) => i);
  const byName = names.indexOf(name);
  if (byName >= 0) return [byName];
  const axis: Record<string, V2> = { front: [0, -1], back: [0, 1], left: [-1, 0], right: [1, 0] };
  const want = axis[name];
  if (!want) return err(`${fname}(): unknown edge "${v}". Use front, back, left, right, all, or an edge number (edge i runs from point i to point i + 1)`);
  const hits = edges.map((e, i) => (e.n[0] * want[0] + e.n[1] * want[1] > Math.cos(DEG) ? i : -1)).filter((i) => i >= 0);
  if (hits.length !== 1) err(`${fname}(): ${hits.length ? "more than one" : "no"} edge of this outline faces ${name}; give the edge number instead (edge i runs from point i to point i + 1)`);
  return hits;
}

// ---------- the language functions ----------

interface FlangeArgs {
  edge: Value;
  h: number;
  angle: number;
  r: number | null;
  inset: [number, number];
  lip: number;
  lipAngle: number;
  /** a hem folded back at the far edge: its outside length (+ inward, − outward); 0 for none */
  hem: number;
  /** the gap between a hem's two layers; 0 for a closed hem */
  hemGap: number;
  /** a roll (curl) at the far edge: its inside radius (+ inward, − outward); 0 for none */
  roll: number;
  rollAngle: number;
  /** a jog part way up: the outside height of its first bend, and how far the rest steps (+ out, − in) */
  jog: [number, number] | null;
  jogAngle: number;
  /** hem(): the base's own edge folded back, over its top (+1) or under it (−1) */
  baseHem?: 1 | -1;
}

function flangeArgs(v: Value, i: number, err: (m: string) => never): FlangeArgs {
  if (!(v instanceof Obj) || v.kind !== "flange") return err(`sheet(): flanges[${i}] should be a flange(edge, h, ...) or a hem(edge, length), got ${typeName(v)}`);
  const f = v.fields;
  const n = (x: Value | undefined, d: number) => (typeof x === "number" ? x : d);
  const inset = Array.isArray(f.inset) ? f.inset : [0, 0];
  const jog = Array.isArray(f.jog) && typeof f.jog[0] === "number" && typeof f.jog[1] === "number" ? ([f.jog[0], f.jog[1]] as [number, number]) : null;
  return {
    edge: f.edge,
    h: n(f.h, 0),
    angle: n(f.angle, 90),
    r: typeof f.r === "number" ? f.r : null,
    inset: [n(inset[0], 0), n(inset[1], 0)],
    lip: n(f.lip, 0),
    lipAngle: n(f.lip_angle, 90),
    hem: n(f.hem, 0),
    hemGap: n(f.hem_gap, 0),
    roll: n(f.roll, 0),
    rollAngle: n(f.roll_angle, 270),
    jog,
    jogAngle: n(f.jog_angle, 90),
    ...(f.base_hem === 1 || f.base_hem === -1 ? { baseHem: f.base_hem } : {}),
  };
}

/** inset: a number for both ends, or [from start, from end] */
function insetOf(a: Args): [number, number] {
  const v = a.value("inset");
  let inset: [number, number] = [0, 0];
  if (typeof v === "number") inset = [v, v];
  else if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number")) inset = [v[0] as number, v[1] as number];
  else if (v instanceof Vec) inset = [v.x, v.y];
  else if (v !== undefined) a.ctx.error(`${a.fname}(): inset should be a number, or [from start, from end] in mm`);
  if (inset[0] < 0 || inset[1] < 0) a.ctx.error(`${a.fname}(): inset cannot be negative`);
  return inset;
}

/** roll_angle: how far round a roll curls */
function rollAngleOf(a: Args): number {
  const v = a.num("roll_angle", 270);
  if (v < 90 || v > 330) a.ctx.error(`${a.fname}(): roll_angle ${v}° is out of range: a roll curls round 90° to 330°`);
  return v;
}

export const SHEET_FNS = Object.fromEntries([
  def(
    "flange",
    ["edge", "h", "angle", "r", "inset", "lip", "lip_angle", "hem", "hem_gap", "roll", "roll_angle", "jog", "jog_angle"],
    (a) => {
      const edge = a.value("edge");
      if (edge === undefined) a.ctx.error('flange() needs the edge it stands on: "front", "back", "left", "right", "all" or an edge number');
      const h = a.positive("h");
      const angle = a.num("angle", 90);
      if (Math.abs(angle) < 1 || Math.abs(angle) > 150) a.ctx.error(`flange(): angle ${angle}° is out of range; bend between 1° and 150° up (positive) or down (negative)`);
      const r = a.has("r") ? a.positive("r") : null;
      const inset = insetOf(a);
      const lip = a.num("lip", 0);
      const lipAngle = a.num("lip_angle", 90);
      if (lip && (lipAngle < 1 || lipAngle > 150)) a.ctx.error(`flange(): lip_angle ${lipAngle}° is out of range (1° to 150°)`);
      const hem = a.num("hem", 0);
      const hemGap = a.num("hem_gap", 0);
      const roll = a.num("roll", 0);
      if ([lip, hem, roll].filter((x) => x).length > 1) a.ctx.error("flange(): its far edge takes one of lip:, hem: or roll:, not two");
      if (hemGap < 0) a.ctx.error("flange(): hem_gap is the gap between a hem's two layers: 0 for a closed hem, or a few tenths of a mm for an open one");
      if (a.has("hem_gap") && !hem) a.ctx.error("flange(): hem_gap goes with hem:");
      const rollAngle = roll ? rollAngleOf(a) : 270;
      let jog: [number, number] | null = null;
      const jogV = a.value("jog");
      if (jogV !== undefined) {
        const pair = jogV instanceof Vec ? [jogV.x, jogV.y] : Array.isArray(jogV) && jogV.length === 2 && jogV.every((x) => typeof x === "number") ? (jogV as number[]) : null;
        if (!pair) return a.ctx.error("flange(): jog is (where, offset): the outside height of its first bend, and how far the rest of the flange steps out (negative: in), like jog: (12, 3)");
        if (!(pair[0] > 0)) a.ctx.error("flange(): a jog's height (the first number) must be above 0");
        if (Math.abs(pair[1]) < 1e-6) a.ctx.error("flange(): a jog's offset (the second number) can't be 0: positive steps out, negative in");
        jog = [pair[0], pair[1]];
      }
      const jogAngle = a.num("jog_angle", 90);
      if (jogV !== undefined && (jogAngle < 15 || jogAngle > 90)) a.ctx.error(`flange(): jog_angle ${jogAngle}° is out of range (15° to 90°)`);
      return new Obj(
        {
          edge: edge!,
          h,
          angle,
          ...(r !== null ? { r } : {}),
          inset: [inset[0], inset[1]],
          lip,
          lip_angle: lipAngle,
          ...(hem ? { hem, hem_gap: hemGap } : {}),
          ...(roll ? { roll, roll_angle: rollAngle } : {}),
          ...(jog ? { jog: [jog[0], jog[1]], jog_angle: jogAngle } : {}),
        },
        "flange",
        "flange",
      );
    },
    "flange(edge, h, angle: 90, r: (the sheet's), inset: 0, lip: 0, lip_angle: 90, hem: 0, hem_gap: 0, roll: 0, roll_angle: 270, jog: (at, offset), jog_angle: 90) — one flange for sheet(): edge is \"front\", \"back\", \"left\", \"right\" (the sides of a rect base), \"all\", or an edge number (edge i runs from point i to point i + 1 of a polygon base). h is its outside height: from the base's outer face to the far face of the flange (or of its lip or fold). angle bends it up (positive) or down (negative). inset shortens it from both ends (or [from start, from end]), with bend reliefs cut automatically. Its far edge takes one of: lip, a return flange that long from the flange's outer face (positive curls inward over the base, negative turns outward); hem, the edge folded back flat on itself, that long from the fold (a safe, stiff edge; positive folds inward, negative outward; hem_gap leaves a gap between the layers, an open hem); roll, the edge curled round roll_angle with that inside radius (positive inward). jog: (at, offset) steps the flange sideways part way up, with two bends: at is the outside height of the first, offset how far the rest moves (positive outward, away from the inside of the part); jog_angle makes it a gentler joggle for small offsets.",
  ),
  def(
    "hem",
    ["edge", "length", "gap", "roll", "roll_angle", "down", "inset"],
    (a) => {
      const edge = a.value("edge");
      if (edge === undefined) a.ctx.error('hem() needs the edge of the base to fold: "front", "back", "left", "right", "all" or an edge number');
      const roll = a.num("roll", 0);
      if (roll < 0) a.ctx.error("hem(): roll is the curl's inside radius in mm; roll it under with down: true");
      const length = roll ? a.num("length", 0) : a.positive("length");
      const gap = a.num("gap", 0);
      if (gap < 0) a.ctx.error("hem(): gap is between the hem's two layers: 0 for a closed hem, or a few tenths of a mm for an open one");
      const down = a.bool("down", false);
      const inset = insetOf(a);
      return new Obj(
        { edge: edge!, h: length, angle: down ? -180 : 180, base_hem: down ? -1 : 1, inset: [inset[0], inset[1]], lip: 0, lip_angle: 90, ...(roll ? { roll, roll_angle: rollAngleOf(a) } : { hem_gap: gap }) },
        "flange",
        "flange",
      );
    },
    'hem(edge, length, gap: 0, roll: 0, roll_angle: 270, down: false, inset: 0) — for sheet()\'s flanges: the base\'s own edge folded back over its top face (down: true, under it), length long from the fold, for a safe, stiff edge on a panel or cover. gap leaves a gap between the layers (an open hem); roll: r curls the edge round instead, with that inside radius. Where hems or flanges on the same side meet at a corner, each hem\'s folded-back part stops short of the other. For a hem on a flange\'s far edge, give the flange hem: instead. Example: body sheet(rect(200, 120), t: 1, flanges: [hem("all", 8)]) is a cover with every edge hemmed.',
  ),
  def(
    "louvre",
    ["length", "width", "height", "at", "on", "angle", "count", "pitch", "flip"],
    (a) => {
      const length = a.positive("length");
      const width = a.positive("width");
      const height = a.positive("height");
      const on = a.value("on") ?? "base";
      if (typeof on !== "string" && typeof on !== "number") a.ctx.error('louvre(): on is "base", or the edge of the flange to press it into: "front", "back", "left", "right", "all" or an edge number');
      const atV = a.value("at");
      if (atV !== undefined && !(atV instanceof Vec)) a.ctx.error("louvre(): at is where its middle goes: (x, y) on the base, or (along, height) on a flange");
      const angle = a.num("angle", 0);
      const count = a.num("count", 1);
      if (!Number.isInteger(count) || count < 1 || count > 100) a.ctx.error(`louvre(): count is how many side by side: a whole number from 1 to 100, got ${count}`);
      const pitch = a.has("pitch") ? a.positive("pitch") : null;
      if (pitch !== null && pitch <= width) a.ctx.error(`louvre(): pitch ${pitch} is the distance from one louvre to the next, so it must be more than the width ${width}`);
      const flip = a.bool("flip", false);
      return new Obj(
        { length, width, height, on, ...(atV instanceof Vec ? { at: [atV.x, atV.y] } : {}), angle, count, ...(pitch !== null ? { pitch } : {}), flip },
        "louvre",
        "louvre",
      );
    },
    'louvre(length, width, height, at: (the middle), on: "base", angle: 0, count: 1, pitch: width + 4 × t, flip: false) — for sheet()\'s louvres: a vent pressed into the sheet, a slit cut along one side and the metal beside it pushed out into a hood that stands height out at its open side, so air gets through an enclosure while fingers and drips stay out. on is "base", or the edge of a flange to press it into ("all" puts one in every flange). at is its middle: (x, y) on the base; on a flange (along, height), along from the middle of the edge (toward +x, or +y on a left or right flange) and height up the flange from the base\'s outer face, the way h is measured. It runs along x (along the flange) and opens toward the front (on a flange, downward); angle turns it. count puts that many side by side, pitch apart. It stands out of the part: from the base, on the side away from the flanges; from a flange, outward. flip: true presses it in instead. Kerf keeps it clear of edges, bends and hems and checks the room round it; the flat pattern is the blank before the louvres are pressed (a turret punch\'s louvre tool). Example: body sheet(rect(200, 120), t: 1, flanges: [flange("all", 40)], louvres: [louvre(60, 6, 3, count: 5), louvre(40, 5, 2.5, on: "back", count: 3)]) is a tray with five louvres in its floor and three in its back wall.',
  ),
  def(
    "sheet",
    ["base", "t", "r", "k", "flanges", "gap", "at", "louvres"],
    (a) => {
      const err = (m: string): never => a.ctx.error(m);
      const t = a.positive("t");
      const r = a.has("r") ? a.positive("r") : t;
      const k = a.num("k", 0.44);
      if (k < 0 || k > 0.5) err(`sheet(): k (the K-factor, where the neutral layer sits across the thickness) should be between 0 and 0.5, got ${k}`);
      const gap = a.num("gap", 0.5);
      if (gap < 0.1) err("sheet(): gap (between flanges at a corner) should be at least 0.1 mm");
      const at = a.vec3("at", [0, 0, 0]);
      const listV = a.value("flanges") ?? [];
      const list = Array.isArray(listV) ? listV : [listV];
      const lvV = a.value("louvres") ?? [];
      const lvs = Array.isArray(lvV) ? lvV : [lvV];
      return buildSheet(
        a.profile("base"),
        { t, r, k, gap, at },
        list.map((v, i) => flangeArgs(v, i, err)),
        err,
        lvs.map((v, i) => louvreArgs(v, i, err)),
      );
    },
    'sheet(base, t, r: t, k: 0.44, flanges: [flange(...), hem(...), ...], gap: 0.5, at: (0, 0, 0), louvres: [louvre(...), ...]) — a sheet-metal part: a flat base of thickness t (base is a rect() or polygon() in x, y; the bottom face sits at at.z) with flanges bent up or down along its edges (with lips, hems, rolls or jogs), hem() folding the base\'s own edges back, and louvre() vents pressed into the base or a flange. r is the inside bend radius, k the K-factor for the flat pattern. Corners between flanges get a gap and relief automatically; give the base sharp corners and round them later with fillet(r, edges: "vertical"). Use it as the body, then cut holes and cut-outs as usual: Kerf unfolds the finished part into a flat pattern (its own drawing, with bend lines and a bend table, and a DXF for the laser), checks it as sheet metal, and the part is made by sheet_metal unless it says otherwise. Example: body sheet(rect(120, 80), t: 1.5, flanges: [flange("all", 30)]) is an open tray 120 × 80 × 30 outside.',
  ),
]);

interface SheetOpts {
  t: number;
  r: number;
  k: number;
  gap: number;
  at: V3;
}

interface Placed {
  edge: number;
  name: string;
  f: FlangeArgs;
  steps: Steps;
  /** bend span, wall span and lip span along the edge (distance from the edge's start) */
  bend: [number, number];
  wall: [number, number];
  lip: [number, number];
  relief: [boolean, boolean];
}

function buildSheet(baseProfile: Profile, o: SheetOpts, flanges: FlangeArgs[], err: (m: string) => never, louvres: LouvreArgs[] = []): SheetV {
  const { t, k, gap } = o;
  const z0 = o.at[2];
  const base = baseOutline(baseProfile, err);
  const pts: V2[] = base.pts.map((p) => [p[0] + o.at[0], p[1] + o.at[1]]);
  const edges = edgesOf(pts);
  const n = edges.length;

  // which flange stands on each edge
  const onEdge: (FlangeArgs | null)[] = edges.map(() => null);
  for (const f of flanges) {
    for (const i of resolveEdge(f.edge, edges, base.names, base.userIndex, err, f.baseHem ? "hem" : "flange")) {
      if (onEdge[i]) err(`sheet(): two flanges on the ${base.names[i]} edge`);
      onEdge[i] = f;
    }
  }
  const chains = onEdge.map((f, i) => {
    if (!f) return null;
    const where = (m: string): never => err(`${f.baseHem ? "hem" : "flange"} on the ${base.names[i]} edge: ${m}`);
    return flangeSteps(t, o.r, f, base.names[i], where);
  });
  const setback = (i: number) => (chains[i] ? -chains[i]!.sb : 0);

  // where the moved edge lines meet: the base's corners once every bend start is cut back
  const along = (i: number, p: V2) => (p[0] - edges[i].p0[0]) * edges[i].e[0] + (p[1] - edges[i].p0[1]) * edges[i].e[1];
  const moved = (i: number): [P, P] => [add(edges[i].p0 as P, mul(edges[i].n as P, -setback(i))), edges[i].e as P];
  const corner = (i: number, j: number): V2 => {
    const [p, d] = moved(i);
    const [q, e] = moved(j);
    return meet(p, d, q, e);
  };
  const square = (i: number, j: number) => Math.abs(edges[i].e[0] * edges[j].e[0] + edges[i].e[1] * edges[j].e[1]) < 0.02;

  const placed: Placed[] = [];
  for (let i = 0; i < n; i++) {
    const f = onEdge[i];
    const chain = chains[i];
    if (!f || !chain) continue;
    const prev = (i + n - 1) % n;
    const next = (i + 1) % n;
    const L = edges[i].len;
    let a = Math.max(0, along(i, corner(prev, i)));
    let b = Math.min(L, along(i, corner(i, next)));
    const reliefA = f.inset[0] > a + 1e-6;
    const reliefB = L - f.inset[1] < b - 1e-6;
    a = Math.max(a, f.inset[0]);
    b = Math.min(b, L - f.inset[1]);
    if (b - a < Math.max(1, t)) err(`${f.baseHem ? "hem" : "flange"} on the ${base.names[i]} edge: only ${r3(Math.max(0, b - a))} mm of the edge is left for it; reduce inset or the neighbouring flanges' bends`);
    // walls reach into a corner shared with another square wall, stopping a gap short of its inside face (not a
    // jogged one: its upper part is not where its lower part is)
    const meets = (j: number) => {
      const g = onEdge[j];
      return !!g && !f.jog && !g.jog && Math.abs(Math.abs(f.angle) - 90) < 1e-6 && Math.abs(Math.abs(g.angle) - 90) < 1e-6 && Math.sign(g.angle) === Math.sign(f.angle) && square(i, j);
    };
    let wa = !reliefA && meets(prev) ? Math.min(a, t + gap) : a;
    let wb = !reliefB && meets(next) ? Math.max(b, L - t - gap) : b;
    if (f.baseHem) {
      // a hem of the base folds back over (or under) it: the folded-back part stops short of whatever stands on the
      // same side at either corner, another hem's folded-back part or a flange's bend
      const over = (j: number) => {
        const g = onEdge[j];
        if (!g || (g.baseHem ? g.baseHem !== f.baseHem : Math.sign(g.angle) !== f.baseHem)) return 0;
        return g.baseHem ? (g.roll ? 2 * (Math.abs(g.roll) + t) : g.h) : setback(j);
      };
      if (over(prev)) wa = Math.max(wa, over(prev) + gap);
      if (over(next)) wb = Math.min(wb, L - over(next) - gap);
      if (!f.roll && wb - wa < Math.max(1, t)) err(`hem on the ${base.names[i]} edge: no room is left for its folded-back part between the corners; shorten the hems that meet it`);
    }
    // what a flange's far edge reaches in over the inside: lips, hems and rolls over the same corner would cross, so
    // each stops short of the other's
    const reach = (g: FlangeArgs | null) => (!g || g.baseHem ? 0 : g.lip > 0 ? g.lip : g.hem > 0 ? 2 * t + (g.hemGap > 0 ? g.hemGap : closedGap(t)) : g.roll > 0 ? 2 * (g.roll + t) : 0);
    const la = reach(f) && meets(prev) && reach(onEdge[prev]) ? Math.max(wa, reach(onEdge[prev]) + gap) : wa;
    const lb = reach(f) && meets(next) && reach(onEdge[next]) ? Math.min(wb, L - reach(onEdge[next]) - gap) : wb;
    const far = f.lip ? "lip" : f.hem ? "hem" : f.roll ? "roll" : "";
    if (far && !f.baseHem && lb - la < Math.max(1, t)) err(`flange on the ${base.names[i]} edge: its ${far} has no room left between the corners`);
    placed.push({ edge: i, name: base.names[i], f, steps: chain, bend: [a, b], wall: [wa, wb], lip: [la, lb], relief: [reliefA, reliefB] });
  }

  // cross-section (s, z) at a distance along an edge, to the part's coordinates
  const to3 = (i: number, s: number, z: number, al: number): V3 => {
    const E = edges[i];
    return [E.p0[0] + E.e[0] * al + E.n[0] * s, E.p0[1] + E.e[1] * al + E.n[1] * s, z0 + z];
  };
  const toXY = (i: number, s: number, al: number): V2 => {
    const E = edges[i];
    return [E.p0[0] + E.e[0] * al + E.n[0] * s, E.p0[1] + E.e[1] * al + E.n[1] * s];
  };
  /** a cross-section profile pushed along edge i from al0 to al1 */
  const sweep = (i: number, p: Profile, al0: number, al1: number): ShapeRecipe => {
    const E = edges[i];
    const o3 = to3(i, 0, 0, al1);
    return { t: "extrude", p, h: al1 - al0, f: { o: o3, u: [E.n[0], E.n[1], 0], n: [-E.e[0], -E.e[1], 0] }, twist: 0, scale: 1 };
  };
  const poly = (ps: P[]): Profile => ({ t: "poly", pts: ps.map((q) => [q[0], q[1]] as V2), r: 0 });
  const rectXY = (i: number, a0: number, a1: number, s0: number, s1: number): V2[] => [toXY(i, s0, a0), toXY(i, s0, a1), toXY(i, s1, a1), toXY(i, s1, a0)];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]);
    maxY = Math.max(maxY, p[1]);
  }
  const rw = Math.max(t, 1);
  /** how far past an outline's edge or corner the cutting regions reach */
  const M = 1;

  // ---------- louvres: where each goes, clear of edges, bends, hems and each other ----------
  interface LvPlaced {
    fr: LvFrame;
    L: number;
    w: number;
    H: number;
    /** the face: "base", or `${placed index}:${step index}` of a flange's straight run */
    face: string;
    /** its footprint on that face, in the face's own 2D coordinates */
    foot: P[];
    form: SheetForm;
  }
  const lvAt: LvPlaced[] = [];
  // the base's louvres stand out of the part: away from the side its flanges stand on
  const ups = placed.filter((p) => !p.f.baseHem && p.f.angle > 0).length;
  const downs = placed.filter((p) => !p.f.baseHem && p.f.angle < 0).length;
  const baseOut = ups > downs ? -1 : 1;
  const numbered: Record<string, number> = {};
  louvres.forEach((lv, li) => {
    const where = (m: string): never => err(`louvre ${li + 1}: ${m}`);
    if (lv.height < t + 0.2 - 1e-9) where(`height ${r3(lv.height)} is too low to open in a ${r3(t)} mm sheet: make it at least ${r3(t + 0.2)} mm`);
    const pitch = lv.pitch ?? lv.width + 4 * t;
    const ca = Math.cos(lv.angle * DEG);
    const sa = Math.sin(lv.angle * DEG);
    const F0 = lvFoot(lv.length, lv.width, t, 0);
    const corners: P[] = [
      [F0.x0, F0.y0],
      [F0.x1, F0.y0],
      [F0.x1, F0.y1],
      [F0.x0, F0.y1],
    ];
    const rowY = (j: number) => (j - (lv.count - 1) / 2) * pitch;
    const place = (onName: string, fr: LvFrame, face: string, foot: P[], margin: number, near: string) => {
      numbered[onName] = (numbered[onName] ?? 0) + 1;
      const form: SheetForm = { kind: "louvre", name: `${onName} louvre ${numbered[onName]}`, on: onName, c: fr.O, length: lv.length, width: lv.width, height: lv.height, margin, near };
      lvAt.push({ fr, L: lv.length, w: lv.width, H: lv.height, face, foot, form });
    };
    const far = (here: string, margin: number, near: string) => {
      if (margin < 0) where(`${here} it runs into ${near}: move it ${r3(3 * t - margin)} mm away, or make it smaller`);
    };

    if (typeof lv.on === "string" && lv.on.trim().toLowerCase() === "base") {
      const side = (lv.flip ? -1 : 1) * baseOut;
      const c: V2 = lv.at ? [lv.at[0] + o.at[0], lv.at[1] + o.at[1]] : [(minX + maxX) / 2, (minY + maxY) / 2];
      const X: V3 = [ca, sa, 0];
      const Y: V3 = [sa, -ca, 0];
      // what each edge keeps clear: a flange's bend, a hem's fold, and a hem's folded-back part on the side it lies
      const keep = (i: number): [number, string] => {
        const g = onEdge[i];
        const nm = base.names[i];
        if (!g) return [0, `the ${nm} edge`];
        if (!g.baseHem) return [setback(i), `the ${nm} bend`];
        const what = `the ${nm} ${g.roll ? "roll" : "hem"}`;
        return [g.baseHem !== side ? setback(i) : g.roll ? 2 * (Math.abs(g.roll) + t) : g.h, what];
      };
      for (let j = 0; j < lv.count; j++) {
        const O: V3 = [c[0] + Y[0] * rowY(j), c[1] + Y[1] * rowY(j), side > 0 ? z0 + t : z0];
        const foot = corners.map(([x, y]): P => [O[0] + X[0] * x + Y[0] * y, O[1] + X[1] * x + Y[1] * y]);
        const here = `at (${r3(O[0] - o.at[0])}, ${r3(O[1] - o.at[1])})`;
        const gaps = edges.map((E) => convexGap(foot, [E.p0 as P, add(E.p0 as P, mul(E.e as P, E.len))]));
        if (gaps.some((g) => g <= 0) || !foot.every((q) => insidePoly(q, pts))) where(`${here} it runs off the base`);
        let margin = Infinity;
        let near = "";
        gaps.forEach((g, i) => {
          const [kk, what] = keep(i);
          if (g - kk < margin) [margin, near] = [g - kk, what];
        });
        far(here, margin, near);
        place("base", { O, X, Y, Z: [0, 0, side] }, "base", foot, margin, near);
      }
      return;
    }

    const idx = resolveEdge(lv.on, edges, base.names, base.userIndex, where, "louvre");
    for (const i of idx) {
      const pi = placed.findIndex((p) => p.edge === i);
      const p = placed[pi];
      if (!p || p.f.baseHem) {
        if (idx.length > 1) continue;
        where(p ? `the ${base.names[i]} edge has a hem(), not a flange: press it into the base or a flange` : `there is no flange on the ${base.names[i]} edge to press it into`);
      }
      const st = p.steps;
      const nm = p.name;
      const f = p.f;
      const E = edges[i];
      const pos = (x: P) => dot(sub(x, st.v1), st.d1);
      const label = (s: Step | undefined, none: string) => (!s ? none : s.name === nm ? `the ${nm} bend` : `the ${s.name}`);
      // the straight parts of the wall, how high up each takes a louvre, and what bounds it below and above
      const runs = st.steps.flatMap((s, kk) => {
        if (s.k !== "run" || s.span !== "wall" || s.name !== nm) return [];
        const next = st.steps[kk + 1];
        let hi = pos(s.b);
        // a hem's folded-back part lies on the wall's top, a roll curls back below its start
        if (next?.name === `${nm} hem`) hi = Math.min(hi, f.h - Math.abs(f.hem));
        if (next?.name === `${nm} roll`) hi -= Math.abs(f.roll) + t;
        return [{ s, k: kk, lo: pos(s.a), hi, bottom: label(st.steps[kk - 1], `the ${nm} bend`), top: label(next, `the top of the ${nm} flange`) }];
      });
      const best = runs.reduce((x, y) => (y.hi - y.lo > x.hi - x.lo ? y : x));
      // along runs toward +x (+y on an edge that runs mostly along y), whichever way round the outline the edge goes
      const sAl = Math.abs(E.e[0]) >= Math.abs(E.e[1]) ? Math.sign(E.e[0]) : Math.sign(E.e[1]);
      const along = lv.at ? E.len / 2 + sAl * lv.at[0] : (p.wall[0] + p.wall[1]) / 2;
      const ht = lv.at ? lv.at[1] : (best.lo + best.hi) / 2;
      const run = runs.find((x) => ht >= x.lo - 1e-9 && ht <= x.hi + 1e-9);
      if (!run) return where(`at height ${r3(ht)} it is not on a straight part of the ${nm} flange, which is straight from ${runs.map((x) => `${r3(x.lo)} to ${r3(x.hi)}`).join(" and ")}`);
      const d = run.s.d;
      const out2 = f.angle > 0 ? right(d) : left(d);
      const z2 = lv.flip ? mul(out2, -1) : out2;
      // the face it stands out of: the R face, or the face a thickness to its left
      const rp = add(run.s.a, mul(d, ht - pos(run.s.a)));
      const fp = dot(z2, right(d)) > 0 ? rp : add(rp, mul(left(d), t));
      const ax3 = (v: P): V3 => [E.n[0] * v[0], E.n[1] * v[0], v[1]];
      const D = ax3(d);
      // up the flange in the world, so a louvre opens downward whichever way the flange is bent
      const sU = D[2] >= 0 ? 1 : -1;
      const U = mul3(D, sU);
      const Ea: V3 = [sAl * E.e[0], sAl * E.e[1], 0];
      const X = add3(mul3(Ea, ca), mul3(U, sa));
      const Y = add3(mul3(Ea, sa), mul3(U, -ca));
      for (let j = 0; j < lv.count; j++) {
        const y0 = rowY(j);
        // in the face's own (distance along the edge from its start, height up the flange) coordinates
        const foot = corners.map(([x, y]): P => [along + sAl * (x * ca + (y + y0) * sa), ht + sU * (x * sa - (y + y0) * ca)]);
        const c2: P = [along + sAl * y0 * sa, ht - sU * y0 * ca];
        let margin = Infinity;
        let near = "";
        const bound = (g: number, what: string) => {
          if (g < margin) [margin, near] = [g, what];
        };
        for (const q of foot) {
          bound(q[0] - p.wall[0], `the end of the ${nm} flange`);
          bound(p.wall[1] - q[0], `the end of the ${nm} flange`);
          bound(q[1] - run.lo, run.bottom);
          bound(run.hi - q[1], run.top);
        }
        far(`at (${r3(sAl * (c2[0] - E.len / 2))}, ${r3(c2[1])}) on the ${nm} flange`, margin, near);
        const O = add3(to3(i, fp[0], fp[1], c2[0]), mul3(D, c2[1] - ht));
        place(nm, { O, X, Y, Z: ax3(z2) }, `${pi}:${run.k}`, foot, margin, near);
      }
    }
  });
  // louvres on the same face keep apart
  for (let a = 0; a < lvAt.length; a++)
    for (let b = a + 1; b < lvAt.length; b++) {
      const A = lvAt[a];
      const B = lvAt[b];
      if (A.face !== B.face) continue;
      const web = convexGap(A.foot, B.foot);
      if (web <= 0) err(`${A.form.name} and ${B.form.name} overlap: space them further apart (a bigger pitch:) or make them narrower`);
      A.form.web = Math.min(A.form.web ?? Infinity, web);
      B.form.web = Math.min(B.form.web ?? Infinity, web);
    }

  // the base: the outline less each bend's zone, the corners between bends, and reliefs
  const zones: Profile[] = [];
  const exact: Profile[] = [];
  // a corner the outline turns through 90° or more (a rect's): no base lies past it beside the edge, so a bend that
  // runs out to it cuts on past it, not along the next edge (OpenCASCADE loses the plate when the two lines coincide)
  const clearPast = (j: number, i: number) => {
    const [a, b] = [edges[j].e, edges[i].e];
    return a[0] * b[1] - a[1] * b[0] > 1e-9 && a[0] * b[0] + a[1] * b[1] <= 1e-9;
  };
  for (const p of placed) {
    const i = p.edge;
    const sb = p.steps.sb;
    const prev = (i + n - 1) % n;
    const next = (i + 1) % n;
    // through a corner shared with another bend, so the corner between them is open
    const a0 = !p.relief[0] && onEdge[prev] ? Math.min(p.bend[0], 0) - M : !p.relief[0] && p.bend[0] <= 1e-9 && clearPast(prev, i) ? -M : p.bend[0];
    const a1 = !p.relief[1] && onEdge[next] ? Math.max(p.bend[1], edges[i].len) + M : !p.relief[1] && p.bend[1] >= edges[i].len - 1e-9 && clearPast(i, next) ? edges[i].len + M : p.bend[1];
    zones.push({ t: "poly", pts: rectXY(i, a0, a1, sb, M), r: 0 });
    if (p.relief[0]) zones.push({ t: "poly", pts: rectXY(i, p.bend[0] - rw, p.bend[0], sb - t, M), r: 0 });
    if (p.relief[1]) zones.push({ t: "poly", pts: rectXY(i, p.bend[1], p.bend[1] + rw, sb - t, M), r: 0 });
    // the unfold's base region stops at the bend start, and keeps clear of a shallow flange still in the base's slab
    exact.push({ t: "poly", pts: rectXY(i, p.bend[0], p.bend[1], sb, p.f.h + Math.abs(p.f.lip) + (p.f.jog ? Math.abs(p.f.jog[1]) : 0) + M), r: 0 });
  }
  const outline: Profile = { t: "poly", pts, r: 0 };
  const baseP: Profile = zones.length ? { t: "diff2", a: outline, b: zones } : outline;
  const plate: ShapeRecipe = { t: "extrude", p: baseP, h: t, f: { o: [0, 0, z0], u: [1, 0, 0], n: [0, 0, 1] }, twist: 0, scale: 1 };

  const solids: ShapeRecipe[] = [plate];
  const pieces: SheetInfo["unfold"]["pieces"] = [];
  const flatBends: ShapeRecipe[] = [];
  const bends: SheetBend[] = [];
  const info: SheetFlange[] = [];
  const boxes: SheetBox[] = [];
  const flatRegions: SheetInfo["flatRegions"] = [];
  const bboxPad: V2[] = [
    [minX - M, minY - M],
    [maxX + M, minY - M],
    [maxX + M, maxY + M],
    [minX - M, maxY + M],
  ];
  // louvres: the slits cut from the bent part and the hoods added; a louvre is pressed after the blank is cut, so the
  // flat takes plain sheet where each goes (a little bigger than it, so none of its hood comes along)
  const PAD = 0.3;
  const lvSlits: ShapeRecipe[] = [];
  const lvAdds: ShapeRecipe[] = [];
  const baseCuts: Profile[] = [];
  const lvBlock = (l: LvPlaced, zBottom: number, zTop: number) => {
    const F = lvFoot(l.L, l.w, t, PAD);
    return lvPrism(
      l.fr,
      [
        [F.y0, zBottom],
        [F.y1, zBottom],
        [F.y1, zTop],
        [F.y0, zTop],
      ],
      F.x0,
      F.x1,
    );
  };
  for (const l of lvAt) {
    const made = louvreSolids(l.fr, l.L, l.w, l.H, t);
    lvSlits.push(made.slit);
    lvAdds.push(...made.adds);
    if (l.face !== "base") continue;
    const F = lvFoot(l.L, l.w, t, PAD);
    const { O, X, Y } = l.fr;
    const at2 = (x: number, y: number): P => [O[0] + X[0] * x + Y[0] * y, O[1] + X[1] * x + Y[1] * y];
    baseCuts.push(poly([at2(F.x0, F.y0), at2(F.x1, F.y0), at2(F.x1, F.y1), at2(F.x0, F.y1)]));
    flatBends.push(lvBlock(l, -t, 0));
  }
  // the base region of the unfold: everything in the base's slab short of the bend starts (and of louvres)
  const cuts = [...exact, ...baseCuts];
  const baseRegion: Profile = cuts.length ? { t: "diff2", a: { t: "poly", pts: bboxPad, r: 0 }, b: cuts } : { t: "poly", pts: bboxPad, r: 0 };
  // the slab keeps clear of a hem folded back close over (or under) the base
  const hemGrow = (side: 1 | -1) => Math.min(EPS, ...placed.filter((p) => p.f.baseHem === side && !p.f.roll).map((p) => (p.f.hemGap > 0 ? p.f.hemGap : closedGap(t)) / 3));
  const growUp = hemGrow(1);
  const growDown = hemGrow(-1);
  const slab = growUp === EPS && growDown === EPS ? t + 2 * EPS : t + growDown + growUp;
  pieces.push({ region: { t: "extrude", p: baseRegion, h: slab, f: { o: [0, 0, z0 - growDown], u: [1, 0, 0], n: [0, 0, 1] }, twist: 0, scale: 1 }, xf: [] });

  const allowance = (b: Bend) => Math.abs(b.theta) * (b.r + k * t);
  const halfGap = gap / 2;
  /** the 3D move that lays a flat region (R face starting at `from`, running along d) flat at s = target */
  const layFlat = (i: number, from: P, d: P, target: number): Xform[] => {
    const E = edges[i];
    const phi = -Math.atan2(d[1], d[0]);
    const origin = to3(i, from[0], from[1], 0);
    const shift: P = sub([target, 0], from);
    return [
      { op: "rotate", angle: phi / DEG, origin, axis: [E.n[1], -E.n[0], 0] },
      { op: "translate", v: [E.n[0] * shift[0], E.n[1] * shift[0], shift[1]] },
    ];
  };
  const boxOf = (i: number, name: string, a: P, b: P, d: P, span: [number, number]): SheetBox => {
    const E = edges[i];
    const mid = add(mul(add(a, b), 0.5), mul(left(d), t / 2));
    const al = (span[0] + span[1]) / 2;
    const ax3 = (v: P): V3 => [E.n[0] * v[0], E.n[1] * v[0], v[1]];
    return { name, c: to3(i, mid[0], mid[1], al), axes: [ax3(d), ax3(left(d)), [E.e[0], E.e[1], 0]], half: [Math.hypot(b[0] - a[0], b[1] - a[1]) / 2, t / 2, (span[1] - span[0]) / 2] };
  };

  for (const [pi, p] of placed.entries()) {
    const i = p.edge;
    const st = p.steps;
    const nm = p.name;
    const spanOf = (k: StepSpan): [number, number] => (k === "bend" ? p.bend : k === "wall" ? p.wall : p.lip);
    // the solid, and the flat pattern laid out from the bend start: base | bend | flat | bend | flat …
    let s = st.sb;
    st.steps.forEach((step, k) => {
      const [s0, s1] = spanOf(step.span);
      if (step.k === "bend") {
        const ba = allowance(step.b);
        solids.push(sweep(i, bendProfile(step.b, t), s0, s1));
        flatBends.push(sweep(i, poly([[s, 0], [s + ba, 0], [s + ba, t], [s, t]]), s0, s1));
        // on the flat, a bend that turns left as you travel outward bends up
        bends.push({ name: step.name, angle: step.angle, r: step.b.r, allowance: ba, length: s1 - s0, line: [toXY(i, s + ba / 2, s0), toXY(i, s + ba / 2, s1)] });
        flatRegions.push({ flange: nm, pts: rectXY(i, s0, s1, s, s + ba) });
        s += ba;
        return;
      }
      const len = dot(sub(step.b, step.a), step.d);
      // the region a hair bigger than the flat, without reaching a hem's other layer
      const grow = (side: "L" | "R") => (step.facing?.side === side ? Math.min(EPS, step.facing.gap / 3) : EPS);
      solids.push(sweep(i, poly(quad(step.a, step.b, step.d, t)), s0, s1));
      const xf = layFlat(i, step.a, step.d, s);
      let region = sweep(i, poly(quadG(step.a, step.b, step.d, t, grow("R"), grow("L"), k === st.steps.length - 1 ? M : 0)), s0 - halfGap, s1 + halfGap);
      const lvHere = lvAt.filter((l) => l.face === `${pi}:${k}`);
      if (lvHere.length) {
        region = { t: "diff", a: region, b: lvHere.map((l) => lvBlock(l, -t - 1, l.H + 1)) };
        for (const l of lvHere) flatBends.push({ t: "xform", shape: lvBlock(l, -t, 0), xf });
      }
      pieces.push({ region, xf });
      flatRegions.push({ flange: nm, pts: rectXY(i, s0, s1, s, s + len) });
      boxes.push(boxOf(i, step.name, step.a, step.b, step.d, [s0, s1]));
      s += len;
    });
    const f = p.f;
    const fl: SheetFlange = { name: nm, h: f.h, angle: f.angle, flat: st.flat };
    if (st.lipFlat !== undefined) fl.lip = { length: Math.abs(f.lip), angle: f.lipAngle * Math.sign(f.lip), flat: st.lipFlat };
    if (st.hemFlat !== undefined) fl.hem = { length: f.baseHem ? f.h : Math.abs(f.hem), gap: f.hemGap, flat: st.hemFlat };
    if (f.roll) fl.roll = { r: Math.abs(f.roll), angle: f.rollAngle };
    if (f.jog && st.jogFlat !== undefined) fl.jog = { at: f.jog[0], offset: f.jog[1], angle: f.jogAngle, flat: st.jogFlat };
    if (f.baseHem) fl.kind = f.roll ? "roll" : "hem";
    info.push(fl);
  }

  let fx0 = minX;
  let fy0 = minY;
  let fx1 = maxX;
  let fy1 = maxY;
  for (const r of flatRegions)
    for (const q of r.pts) {
      fx0 = Math.min(fx0, q[0]);
      fy0 = Math.min(fy0, q[1]);
      fx1 = Math.max(fx1, q[0]);
      fy1 = Math.max(fy1, q[1]);
    }

  const bent: ShapeRecipe = solids.length === 1 ? plate : { t: "union", shapes: solids };
  const recipe: ShapeRecipe = lvSlits.length ? { t: "union", shapes: [{ t: "diff", a: bent, b: lvSlits }, ...lvAdds] } : bent;
  return new SheetV(recipe, {
    t,
    r: o.r,
    k,
    gap,
    z: z0,
    flanges: info,
    bends,
    boxes,
    flatRegions,
    flatBox: [
      [fx0, fy0],
      [fx1, fy1],
    ],
    unfold: { pieces, bends: flatBends },
    ...(lvAt.length ? { forms: lvAt.map((l) => l.form) } : {}),
  });
}
