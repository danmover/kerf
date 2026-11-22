// Ropes through the motion. A rope is laid out as drawn by lib.rope; here it
// is followed at every position: each drum, sheave and tied end moves with
// the part it is on, the taut path is found again, and the rope the path
// takes is set against what the drum lets out. From that come the checks: a
// rope that would have to stretch or that hangs slack, turns left on the
// drum, sheaves too small for the rope, fleet angles, and its pull against
// its strength. The pull comes from the weights that hang on it (virtual
// work: the weight a drive carries, over the rope it takes up per unit of
// that drive), and goes on to the drum, where the gravity checks ask what
// holds it.

import { type EvalPart, type Model, type Motion } from "./model";
import type { CheckItem } from "./checks";
import type { ChecksResult, Interference } from "../kernel/protocol";
import { applyMat, driveAngle, motionPose, motionPoseSplit, type Mat4 } from "./kinematics";
import { isFastener, motionOfPart, type Holds, type MeshLookup } from "./holds";
import { sweepAngles } from "./sweepChecks";
import { unheldParts } from "./holdChecks";
import { massBodies } from "./stability";
import type { DriveLoad } from "./gravityChecks";
import { drumPayout, ropeState, ropeTaken, squareTo, type RopePoint, type RopeState } from "../machine/ropes";
import type { RopeDef, RopeNode } from "../machine/types";
import { fmtNum } from "../lang/values";
import { inverseXforms, type V3 } from "../kernel/recipe";
import type { MeshData } from "../kernel/build";

const G = 9.80665;
const TAU = Math.PI * 2;
/** A tied end within this of a part's surface (or inside it) is tied to that part, mm. */
const TIE_REACH = 1;
/** Slack or stretch under this through a motion is the rope's own give, mm, plus this share of the rope it takes up. */
const RUN_TOL = 0.5;
const RUN_SHARE = 0.003;
/** Fleet angle, degrees: past the first a smooth drum winds unevenly; past the second the rope rides up the flange. */
const FLEET_WARN = 1.5;
const FLEET_FAIL = 4;
/** Turns that must stay on a drum: under two the anchor takes the load; most winch makers ask for three. */
const WRAPS_MIN = 2;
const WRAPS_WANT = 3;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const N0 = (x: number, d = 0) => fmtNum(x, d);
const force = (n: number) => (n >= 1000 ? `${fmtNum(n / 1000, 2)} kN` : `${fmtNum(n, n < 10 ? 1 : 0)} N`);
const deg = (r: number) => (r * 180) / Math.PI;
const listOf = (names: string[]) => {
  const a = [...new Set(names)];
  return a.length <= 3 ? a.join(", ").replace(/, ([^,]*)$/, " and $1") : `${a.slice(0, 3).join(", ")} and ${a.length - 3} more`;
};
const chain = (m: Motion | undefined): Motion[] => {
  const out: Motion[] = [];
  for (let x = m; x; x = x.parent) out.push(x);
  return out;
};

// ---------------------------------------------------------------- what a tie is on

/** Distance from a point to a triangle. */
function triDistance(p: V3, a: V3, b: V3, c: V3): number {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return len(ap);
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return len(bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return len(sub(ap, [ab[0] * v, ab[1] * v, ab[2] * v]));
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return len(cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return len(sub(ap, [ac[0] * w, ac[1] * w, ac[2] * w]));
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return len(sub(bp, [(c[0] - b[0]) * w, (c[1] - b[1]) * w, (c[2] - b[2]) * w]));
  }
  const n = unit([ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]]);
  return Math.abs(dot(ap, n));
}

/** How far a point (in the mesh's own coordinates) is from the solid: 0 inside it. */
function solidDistance(m: MeshData, p: V3): number {
  const P = m.positions;
  const I = m.indices;
  const at = (i: number): V3 => [P[3 * i], P[3 * i + 1], P[3 * i + 2]];
  let best = Infinity;
  let crossings = 0;
  // a ray in no special direction, so it meets no edge or corner of a part drawn square to the axes
  const dir: V3 = unit([0.5774, 0.2113, 0.7887]);
  for (let t = 0; t < I.length; t += 3) {
    const a = at(I[t]);
    const b = at(I[t + 1]);
    const c = at(I[t + 2]);
    best = Math.min(best, triDistance(p, a, b, c));
    // does the ray from p cross this triangle
    const e1 = sub(b, a);
    const e2 = sub(c, a);
    const h: V3 = [dir[1] * e2[2] - dir[2] * e2[1], dir[2] * e2[0] - dir[0] * e2[2], dir[0] * e2[1] - dir[1] * e2[0]];
    const det = dot(e1, h);
    if (Math.abs(det) < 1e-12) continue;
    const s = sub(p, a);
    const u = dot(s, h) / det;
    if (u < 0 || u > 1) continue;
    const q: V3 = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
    const v = dot(dir, q) / det;
    if (v < 0 || u + v > 1) continue;
    if (dot(e2, q) / det > 1e-9) crossings++;
  }
  return crossings % 2 ? 0 : best;
}

const meshBox = new WeakMap<MeshData, [V3, V3]>();
function boxOf(m: MeshData): [V3, V3] {
  let b = meshBox.get(m);
  if (b) return b;
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  const P = m.positions;
  for (let i = 0; i < P.length; i += 3)
    for (let k = 0; k < 3; k++) {
      if (P[i + k] < lo[k]) lo[k] = P[i + k];
      if (P[i + k] > hi[k]) hi[k] = P[i + k];
    }
  b = [lo, hi];
  meshBox.set(m, b);
  return b;
}

/** The part drawn at a point: the nearest one within reach, a made or bought part before a fastener. */
function partAt(model: Model, mesh: MeshLookup, p: V3): EvalPart | undefined {
  let best: { part: EvalPart; d: number } | undefined;
  for (const q of model.parts) {
    if (q.hidden || q.libKind === "rope" || q.libKind === "belt" || (q.imported && q.imported.kind !== "solid")) continue;
    const m = mesh(q.hash);
    if (!m) continue;
    const local = inverseXforms(p, q.xf);
    const [lo, hi] = boxOf(m);
    if ([0, 1, 2].some((k) => local[k] < lo[k] - TIE_REACH || local[k] > hi[k] + TIE_REACH)) continue;
    const d = solidDistance(m, local) + (isFastener(q) ? 1e-3 : 0);
    if (d <= TIE_REACH + 1e-3 && (!best || d < best.d)) best = { part: q, d };
  }
  return best?.part;
}

// ---------------------------------------------------------------- the rope through the motion

export interface RopeRun {
  rope: RopeDef;
  /** the part each node is: the drum or sheave itself, or the part a tied end is on (none: tied to nothing) */
  parts: (EvalPart | undefined)[];
  /** how each node moves, when it does */
  motions: (Motion | undefined)[];
  /** drive angles looked at, degrees */
  angles: number[];
  /** rope the path takes beyond what it takes as drawn, mm, with the drums held still */
  need: number[];
  /** rope its drums have let out since the drawn position, mm */
  payout: number[];
  /** payout less need: over zero the rope hangs slack by that much, under zero it would have to stretch */
  slack: number[];
  /** turns of rope on each drum (by node) at each angle */
  wraps: Map<number, number[]>;
  /** per node: the largest fleet angle through the motion, degrees, and the least contact angle (sheaves), degrees */
  fleet: number[];
  wrapMin: number[];
  /** nodes the rope cannot reach at some position (one wheel inside another's circle) */
  inside: Set<number>;
  moving: boolean;
}

/** A plain spin about its own axis (a drum on its shaft): how far it has turned, radians, at a drive angle. */
const spinOf = (m: Motion | undefined, d: number): number => (m && !m.kind && !m.link && Math.abs(m.ratio) > 1e-12 ? (driveAngle(d, m.range) * m.ratio * Math.PI) / 180 : 0);
const plainSpin = (m: Motion | undefined): m is Motion => !!m && !m.kind && !m.link && Math.abs(m.ratio) > 1e-12;

interface Frame {
  pts: RopePoint[];
  marks: (V3 | undefined)[];
}

/**
 * The rope's nodes with every moving part where `pose` puts it. A drum's mark (the direction its leaving point is
 * measured from) goes with what carries the drum, not with the drum's own turn; `lead` is how far each drum's
 * leaving point has moved along its axis as turns came off or went on.
 */
function frameAt(run: Pick<RopeRun, "rope" | "motions">, pose: (m: Motion) => Mat4, lead: (i: number) => number): Frame {
  const N = run.rope.nodes.length;
  const pts: RopePoint[] = [];
  const marks: (V3 | undefined)[] = [];
  run.rope.nodes.forEach((nd, i) => {
    const m = run.motions[i];
    const M = m ? pose(m) : null;
    const put = (p: V3) => (M ? applyMat(M, p) : p);
    const turn = (v: V3): V3 => (M ? sub(applyMat(M, v), applyMat(M, [0, 0, 0])) : v);
    if (!nd.axis) {
      pts.push({ c: put(nd.c), r: 0, dir: 1 });
      marks.push(undefined);
      return;
    }
    const end = i === 0 || i === N - 1;
    const c0: V3 = end ? [nd.c[0] + nd.axis[0] * lead(i), nd.c[1] + nd.axis[1] * lead(i), nd.c[2] + nd.axis[2] * lead(i)] : nd.c;
    pts.push({ c: put(c0), axis: unit(turn(nd.axis)), r: nd.r, dir: nd.dir });
    if (!end) {
      marks.push(undefined);
      return;
    }
    // the mark rides with the drum's carrier: the drum's own spin is counted apart
    const C = m ? (plainSpin(m) ? (m.parent ? pose(m.parent) : null) : M) : null;
    const mark = squareTo(nd.axis);
    marks.push(C ? unit(sub(applyMat(C, mark), applyMat(C, [0, 0, 0]))) : mark);
  });
  return { pts, marks };
}

/** The part each node of a rope is: the drum or sheave itself, or the part a tied end is on (none: tied to nothing). */
export function ropeParts(rope: RopeDef, model: Model, mesh: MeshLookup): (EvalPart | undefined)[] {
  return rope.nodes.map((nd) => (nd.kind === "tie" ? partAt(model, mesh, nd.c) : (model.parts.find((p) => p.name === nd.name && !isFastener(p)) ?? model.parts.find((p) => p.name === nd.name))));
}

/** How each node of a rope moves, when it does. */
export function ropeMotions(parts: (EvalPart | undefined)[], holds: Holds): (Motion | undefined)[] {
  return parts.map((p) => {
    const m = p ? motionOfPart(p, holds) : undefined;
    return m && (Math.abs(m.ratio) > 1e-12 || !!m.link || !!m.travel || !!m.parent || !!m.roll) ? m : undefined;
  });
}

function runOf(rope: RopeDef, model: Model, holds: Holds, mesh: MeshLookup): RopeRun {
  const parts = ropeParts(rope, model, mesh);
  const motions = ropeMotions(parts, holds);
  const moving = motions.some(Boolean);
  const angles = moving ? sweepAngles(motions) : [0];
  const drums = rope.nodes.map((nd, i) => ({ nd, i })).filter((x) => x.nd.kind === "drum");
  const wraps = new Map(drums.map((x) => [x.i, [] as number[]]));
  const leadOff = new Map(drums.map((x) => [x.i, 0]));
  const run: RopeRun = { rope, parts, motions, angles, need: [], payout: [], slack: [], wraps, fleet: rope.nodes.map(() => 0), wrapMin: rope.nodes.map((nd) => (nd.kind === "sheave" ? Infinity : 0)), inside: new Set(), moving };
  let prev: { f: Frame; st: RopeState } | undefined;
  let need = 0;
  // each drum's leaving point, how far round it has moved since drawn (radians, the way the rope runs)
  const swung = new Map(drums.map((x) => [x.i, 0]));
  angles.forEach((a) => {
    const f = frameAt(run, (m) => motionPose(m, a), (i) => leadOff.get(i) ?? 0);
    const st = ropeState(f.pts, f.marks);
    if (prev) {
      need += ropeTaken(f.pts, prev.st, st);
      for (const { i } of drums) {
        let da = st.ang[i] - prev.st.ang[i];
        while (da > Math.PI) da -= TAU;
        while (da < -Math.PI) da += TAU;
        swung.set(i, swung.get(i)! + da);
      }
    }
    let out = 0;
    for (const { nd, i } of drums) {
      const turned = spinOf(motions[i], a) - spinOf(motions[i], angles[0]);
      const let_ = drumPayout(nd, i === 0) * turned;
      out += let_;
      // on the drum: what it had, less what it has let out, plus what the leaving point's shift keeps on it
      const w = (nd.wraps ?? 0) + (-let_ + (i === 0 ? 1 : -1) * nd.r * nd.dir * swung.get(i)!) / (TAU * nd.r);
      wraps.get(i)!.push(w);
      leadOff.set(i, -(nd.stack ?? 1) * (w - (nd.wraps ?? 0)) * rope.rope.d);
    }
    run.need.push(need);
    run.payout.push(out);
    run.slack.push(out - need);
    st.path.inside.forEach((i) => run.inside.add(i));
    rope.nodes.forEach((nd, i) => {
      if (!nd.axis) return;
      run.fleet[i] = Math.max(run.fleet[i], deg(Math.max(st.path.fleetIn[i], st.path.fleetOut[i])));
      if (nd.kind === "sheave") run.wrapMin[i] = Math.min(run.wrapMin[i], deg(st.path.wrap[i]));
    });
    prev = { f, st };
  });
  return run;
}

/**
 * A rope drawn a little way into the part it is tied to: its end goes through an eye or a hole there, or meets the
 * face at an angle. Not a clash, when it is no more than the rope's own end near that tie.
 */
export function ropeTie(i: Interference, model: Model, mesh: MeshLookup): { rope: RopeDef; on: EvalPart } | null {
  const ropes = model.machine?.ropes ?? [];
  if (!ropes.length) return null;
  const A = model.parts.find((p) => p.id === i.a);
  const B = model.parts.find((p) => p.id === i.b);
  if (!A || !B || (A.libKind === "rope") === (B.libKind === "rope")) return null;
  const [line, on] = A.libKind === "rope" ? [A, B] : [B, A];
  const rope = ropes.find((r) => r.name === line.name);
  if (!rope) return null;
  const d = rope.rope.d;
  // no more of it than ten diameters of rope, close to the tie
  if (i.volume > (Math.PI / 4) * d * d * 10 * d) return null;
  const parts = ropeParts(rope, model, mesh);
  const tied = rope.nodes.some((nd, k) => nd.kind === "tie" && parts[k]?.id === on.id && len(sub(i.center, nd.c)) <= 10 * d + 2);
  return tied ? { rope, on } : null;
}

const runCache = new WeakMap<Model, { holds: Holds; mesh: MeshLookup; runs: RopeRun[] }>();

/** Every rope of the design, followed through its motion. */
export function ropeRuns(model: Model, holds: Holds, mesh: MeshLookup): RopeRun[] {
  const ropes = model.machine?.ropes ?? [];
  if (!ropes.length) return [];
  const hit = runCache.get(model);
  if (hit && hit.holds === holds && hit.mesh === mesh) return hit.runs;
  const runs = ropes.map((r) => runOf(r, model, holds, mesh));
  runCache.set(model, { holds, mesh, runs });
  return runs;
}

// ---------------------------------------------------------------- what hangs on it

/** A drive whose weight a rope carries. */
export interface RopeCarry {
  load: DriveLoad;
  /** the rope's pull where it is greatest, N, and the drive angle there */
  pull: number;
  deg: number;
  /** mm of rope the path takes up for each unit the drive's root moves (mm for a lift, radians for a turn), where the pull is greatest */
  take: number;
  /**
   * A rope pulls and cannot push: true when the way the weight wants to go needs more rope than there is, at
   * every position where it weighs on the drive at all.
   */
  holds: boolean;
}

export interface RopeHold {
  run: RopeRun;
  carries: RopeCarry[];
  /** the greatest pull in the rope, N: from what hangs on it, or as given (pull:) */
  tension: number;
  /** its drums: the node, the part and how it turns, and the torque the rope's pull puts about each drum's axis, N·mm */
  drums: { node: number; part?: EvalPart; motion?: Motion; torque: number }[];
}

/**
 * The pull each drive's weight puts on each rope. With the drums held still and only that drive moving, the rope
 * is taken up at so many mm per unit of the drive; the weight on the drive (N, or N·mm about its shaft) over that
 * is the pull. A lift on one rope gives its weight; one hung from a travelling sheave, half of it.
 */
export function ropeHolds(runs: RopeRun[], loads: DriveLoad[]): RopeHold[] {
  return runs.map((run) => {
    const drumSpin = new Set(run.rope.nodes.map((nd, i) => (nd.kind === "drum" && plainSpin(run.motions[i]) ? run.motions[i] : undefined)).filter(Boolean) as Motion[]);
    const carries: RopeCarry[] = [];
    for (const d of loads) {
      // the drive that turns the drum is what holds the rope, not what hangs on it
      if ([...drumSpin].some((m) => d.motions.has(m))) continue;
      const on = run.motions.some((m, i) => !!m && !(run.rope.nodes[i].kind === "drum" && plainSpin(m) && !m.parent) && chain(m).some((x) => d.motions.has(x)));
      if (!on) continue;
      const lift = d.kind === "lift";
      const per = lift ? Math.abs(d.root.rate ?? 0) : plainSpin(d.root) ? (Math.abs(d.root.ratio) * Math.PI) / 180 : Math.PI / 180;
      if (per < 1e-12) continue;
      const range = d.root.range;
      const step = Math.max(1, Math.floor(d.angles.length / 60));
      let best: RopeCarry | undefined;
      let holds = true;
      for (let k = 0; k < d.angles.length; k += step) {
        const a = d.angles[k];
        const h = 0.25;
        const lo = range ? Math.max(0, a - h) : a - h;
        const hi = range ? Math.min(range, a + h) : a + h;
        const at = (x: number) => {
          const f = frameAt(run, (m) => motionPoseSplit(m, x, a, d.motions), () => 0);
          return { f, st: ropeState(f.pts, f.marks) };
        };
        const A = at(lo);
        const B = at(hi);
        // rope taken up per unit of the root (mm per mm, or mm per radian)
        const take = ropeTaken(B.f.pts, A.st, B.st) / ((hi - lo) * per);
        const w = d.load[k];
        if (Math.abs(take) < 1e-6) {
          // the rope does nothing for this drive here: whatever weighs on it is held by something else, or by nothing
          if (Math.abs(w) > (lift ? 0.02 : 1)) holds = false;
          continue;
        }
        // the load is the rise of the weight per unit of the root: it wants to go the way that lowers it, and the
        // rope stops that only if going that way takes more rope
        if (Math.abs(w) > (lift ? 0.02 : 1) && w * take > 0) holds = false;
        const pull = Math.abs(w / take);
        if (!best || pull > best.pull) best = { load: d, pull, deg: a, take: Math.abs(take), holds: true };
      }
      if (best) carries.push({ ...best, holds });
    }
    const tension = Math.max(run.rope.pull ?? 0, ...carries.filter((c) => c.holds).map((c) => c.pull));
    const drums = run.rope.nodes.map((nd, i) => ({ nd, i })).filter((x) => x.nd.kind === "drum").map(({ nd, i }) => ({ node: i, part: run.parts[i], motion: run.motions[i], torque: tension * nd.r }));
    return { run, carries, tension, drums };
  });
}

// ---------------------------------------------------------------- checks

/** What the rope is called in messages. */
const title = (r: RopeDef) => r.name;
const where = (nd: RopeNode, run: RopeRun, i: number) => (nd.kind === "tie" ? (run.parts[i]?.name ?? "nothing") : nd.name);

/** A weight that hangs on a rope and nothing else, as drawn (nothing moving): what it weighs and how it hangs. */
interface Hanging {
  names: string[];
  ids: string[];
  kg: number;
  /** its centre of mass */
  c: V3;
  /** the rope's legs that hold it up: where each leaves the hanging parts, and the way it leads */
  legs: { at: V3; dir: V3 }[];
}

function hangingOn(run: RopeRun, model: Model, holds: Holds, kernel: ChecksResult, mesh: MeshLookup, volume: (p: EvalPart) => number | undefined): Hanging[] {
  // what is held with the ropes taken away: anything left unheld that a rope is tied to or runs under hangs on it
  const bare: Model = { ...model, parts: model.parts.filter((p) => p.libKind !== "rope") };
  const found = unheldParts(bare, holds, kernel, volume);
  if (!found || !kernel.boxes) return [];
  const st = ropeState(
    run.rope.nodes.map((nd) => ({ c: nd.c, axis: nd.axis, r: nd.r, dir: nd.dir })),
    run.rope.nodes.map(() => undefined),
  );
  const out: Hanging[] = [];
  for (const u of found.unheld) {
    const ids = new Set(u.members.map((p) => p.id));
    const legs: Hanging["legs"] = [];
    run.rope.nodes.forEach((nd, i) => {
      const p = run.parts[i];
      if (!p || !ids.has(p.id)) return;
      if (i > 0) legs.push({ at: st.path.arrive[i], dir: unit(sub(st.path.depart[i - 1], st.path.arrive[i])) });
      if (i < run.rope.nodes.length - 1) legs.push({ at: st.path.depart[i], dir: unit(sub(st.path.arrive[i + 1], st.path.depart[i])) });
      void nd;
    });
    if (!legs.length) continue;
    const bodies = massBodies(u.members.filter((p) => kernel.boxes![p.id]), kernel.boxes, mesh, volume);
    const g = bodies.reduce((n, b) => n + b.g, 0);
    if (!(g > 0)) continue;
    const c: V3 = [0, 1, 2].map((k) => bodies.reduce((n, b) => n + b.g * b.c[k], 0) / g) as V3;
    out.push({ names: u.shown.map((p) => p.name), ids: u.members.map((p) => p.id), kg: g / 1000, c, legs });
  }
  return out;
}

/**
 * The rope checks: where each end is tied, whether it stays taut through the motion, the turns on its drum, its
 * sheaves and fleet angles, and its pull against its strength.
 */
export function ropeChecks(model: Model, holds: Holds, kernel: ChecksResult, mesh: MeshLookup, volume: (p: EvalPart) => number | undefined, loads: DriveLoad[]): CheckItem[] {
  const runs = ropeRuns(model, holds, mesh);
  if (!runs.length) return [];
  const held = ropeHolds(runs, loads);
  const out: CheckItem[] = [];
  for (const h of held) {
    const { run } = h;
    const r = run.rope;
    const t = title(r);
    const d = r.rope.d;
    const nodes = r.nodes;
    const N = nodes.length;
    const ropePart = model.parts.find((p) => p.name === r.name);
    const ids = [...(ropePart ? [ropePart.id] : []), ...run.parts.filter((p): p is EvalPart => !!p).map((p) => p.id)];
    const base = { category: "engineering" as const, parts: ids, span: r.span, basis: "calculation" as const };
    const geo = { ...base, basis: "geometry" as const };
    const motion = { ...geo, category: "motion" as const };

    // every tied end is tied to something
    const loose = nodes.map((nd, i) => ({ nd, i })).filter((x) => x.nd.kind === "tie" && !run.parts[x.i]);
    for (const { nd, i } of loose)
      out.push({
        ...geo,
        category: "assembly",
        id: `rope:tie:${r.name}:${nd.name}`,
        status: "fail",
        title: `${t} is tied to nothing at its ${i === 0 ? "first" : "last"} end`,
        detail: `Its ${i === 0 ? "first" : "last"} end is at (${nd.c.map((x) => N0(x, 1)).join(", ")}), and no part is drawn there (within ${TIE_REACH} mm): a rope's tied end has to be on the part it pulls, or on the part that holds it.`,
        fix: `Move that point in path: onto the part the rope ties to (the top of an eye bolt, a hole through a lug, the face it is clamped to), or draw the anchor there.`,
      });
    const route = nodes.map((nd, i) => (nd.kind === "tie" ? `a tie on ${where(nd, run, i)}` : nd.kind === "drum" && !/drum|winch|spool|reel|capstan/i.test(nd.name) ? `the drum ${nd.name}` : nd.name));
    const stored = nodes.filter((nd) => nd.kind === "drum").reduce((n, nd) => n + (nd.wraps ?? 0) * TAU * nd.r, 0);
    if (!loose.length)
      out.push({
        ...geo,
        category: "assembly",
        id: `rope:path:${r.name}`,
        status: "pass",
        title: `${t} runs from ${route[0]} to ${route[N - 1]}`,
        detail: `${r.label}: ${route.join(", then ")}. ${N0(r.length)} mm as drawn${stored > 1 ? `, ${N0(stored)} mm of it on the drum` : ""}; buy ${N0(r.cutLength)} mm${nodes.some((nd) => nd.kind === "tie") ? `, which leaves ${N0(30 * d)} mm at each tied end for an eye or a knot` : ""}.`,
      });

    if (run.inside.size) {
      const i = [...run.inside][0];
      out.push({ ...motion, id: `rope:reach:${r.name}`, status: "fail", title: `${t} cannot reach round ${nodes[i].name}`, detail: `At some position of the motion what the rope comes from or goes to is inside the circle the rope makes round ${nodes[i].name}, so there is no straight run between them.`, fix: `Keep ${nodes[i].name} and its neighbours on the path further apart than their radii through the whole motion.` });
    }

    // taut through the motion: the rope the path takes, against what the drum lets out
    if (run.moving && !loose.length) {
      let worst = 0;
      run.slack.forEach((s, k) => {
        if (Math.abs(s) > Math.abs(run.slack[worst])) worst = k;
      });
      const span = Math.max(...run.need) - Math.min(...run.need);
      const tol = RUN_TOL + RUN_SHARE * Math.max(span, Math.max(...run.payout) - Math.min(...run.payout));
      const s = run.slack[worst];
      const drum = nodes.findIndex((nd) => nd.kind === "drum");
      const dm = drum >= 0 ? run.motions[drum] : undefined;
      const lifts = h.carries.filter((c) => c.load.kind === "lift");
      let offLine = false;
      if (Math.abs(s) <= tol) {
        const off = Math.abs(s);
        out.push({ ...motion, id: `rope:run:${r.name}`, status: "pass", title: `${t} stays taut through the motion`, detail: `The path takes up ${N0(span)} mm of rope through the motion${drum >= 0 ? `, and the drum winds exactly that` : " and gives it back"}${off >= 0.05 ? `: the rope is never more than ${N0(off, 1)} mm slack or short` : ""}.` });
      } else {
        const at = `with the drive at ${N0(run.angles[worst] % 360)}°`;
        let fix: string;
        if (drum < 0) fix = `Both ends are tied, so the path must stay the same length as the parts move: move the sheaves or the ties until it does, or take one end to a drum.`;
        else if (!plainSpin(dm)) fix = `${nodes[drum].name} does not turn: give it spin: (or turns_with: its motor or gearbox) so it winds the rope as ${listOf(lifts.map((c) => c.load.lead.name)) || "the load"} moves.`;
        else {
          // the travel per turn that fits: what the drum winds in a turn of the drive, over the rope the lift's
          // whole travel takes for each millimetre of it
          const lift = lifts[0];
          let far = 0;
          run.need.forEach((n, k) => {
            if (Math.abs(n) > Math.abs(run.need[far])) far = k;
          });
          const want = run.need[far];
          const total = run.payout[far];
          const travel = lift ? Math.abs(lift.load.root.rate ?? 0) * driveAngle(run.angles[far], lift.load.root.range) : 0;
          const fits = lift && travel > 1e-6 && Math.abs(want) > 1e-6 ? (Math.abs(dm.ratio) * TAU * nodes[drum].r * travel) / Math.abs(want) : undefined;
          const now = lift?.load.root.perTurn;
          if (lift && Math.abs(want) > 1e-6 && Math.abs(total) > 1e-6 && Math.sign(want) !== Math.sign(total)) fix = `The drum turns the wrong way: it lets rope out as ${lift.load.lead.name} needs it taken in. Give ${nodes[drum].name} spin: ${N0(-dm.ratio, 3)}, or lead the rope off the other side of it with wind: "${r.wind === "under" ? "over" : "under"}".`;
          else if (lift && fits !== undefined && now !== undefined && Math.abs(fits / now - 1) < 2e-3) {
            // the two ends of the travel agree and the middle does not: the rope leads off the line of the travel
            offLine = true;
            fix = `Lead the rope to ${lift.load.lead.name} in line with its travel (tie it straight under the sheave it comes from), so every millimetre of rope moves it a millimetre.`;
          } else if (lift && fits !== undefined) fix = `Set per_turn: ${N0(fits, 2)} on ${lift.load.lead.name} (one turn of ${nodes[drum].name} winds ${N0(TAU * nodes[drum].r, 1)} mm of rope${Math.abs(travel / Math.abs(want) - 1) > 0.01 ? `, and ${lift.load.lead.name} moves 1 mm for every ${N0(Math.abs(want) / travel, 2)} mm of it` : ""}), or leave per_turn: out and give the rope lifts: ${lift.load.lead.name} so Kerf works it out.`;
          else fix = `Make what the drum winds match what the moving parts take up: change the drum's diameter or its spin:, or the travel of what the rope moves.`;
        }
        if (offLine) {
          out.push({
            ...motion,
            id: `rope:run:${r.name}`,
            status: "warn",
            title: `${t} does not pull ${lifts[0].load.lead.name} at a steady rate`,
            detail: `${t} leads to ${lifts[0].load.lead.name} at an angle to its travel, so a turn of the drum moves it a little more at one end of the travel than the other: against a steady ${N0(lifts[0].load.root.perTurn ?? 0, 1)} mm a turn it is up to ${N0(Math.abs(s), 1)} mm out part way (${at}). The rope stays taut under the weight; a position counted from the motor's turns is that far off.`,
            fix,
            margin: tol / Math.abs(s),
          });
        } else {
          out.push({
            ...motion,
            id: `rope:run:${r.name}`,
            status: "fail",
            title: s > 0 ? `${t} goes slack as it moves` : `${t} would have to stretch as it moves`,
            detail: `${at}, the path from ${route[0]} to ${route[N - 1]} takes ${N0(Math.abs(run.need[worst]), 1)} mm ${run.need[worst] >= 0 ? "more" : "less"} rope than as drawn, and ${drum >= 0 ? `the drum has ${run.payout[worst] >= 0 ? "let out" : "wound in"} ${N0(Math.abs(run.payout[worst]), 1)} mm` : "there is no drum to give or take any"}: the rope is ${N0(Math.abs(s), 1)} mm ${s > 0 ? "too long there and hangs loose" : "too short there, which a real rope settles by stopping the motion or breaking"}.`,
            fix,
            margin: tol / Math.abs(s),
          });
        }
      }
    }

    // turns on the drum, at both ends of the travel
    for (const [i, w] of run.wraps) {
      const nd = nodes[i];
      const lo = Math.min(...w);
      const hi = Math.max(...w);
      const perLayer = nd.width && nd.width > 0 ? Math.max(1, Math.floor(nd.width / d + 1e-6)) : undefined;
      const layers = perLayer ? Math.ceil(hi / perLayer - 1e-6) : 1;
      const range = hi - lo > 0.05 ? `between ${N0(lo, 1)} and ${N0(hi, 1)} turns` : `${N0(hi, 1)} turns`;
      const b = { ...geo, category: "motion" as const, id: `rope:drum:${r.name}:${nd.name}` };
      if (lo < WRAPS_MIN - 1e-6)
        out.push({
          ...b,
          status: "fail",
          title: lo <= 0 ? `${t} runs out on ${nd.name}` : `${t} leaves under two turns on ${nd.name}`,
          detail: `${nd.name} holds ${range} of rope through the motion${lo <= 0 ? `: it has let all of it out ${N0(-lo, 1)} turns before the travel ends` : ""}. At least two full turns must stay on a drum (most winch makers ask for three), so the rope's grip round the barrel takes the pull and not its anchor.`,
          fix: `Give the rope wraps: ${N0(Math.ceil((r.nodes[i].wraps ?? 0) + WRAPS_WANT - lo), 0)} (turns on the drum where it is drawn)${r.wrapsGiven ? "" : ", or leave wraps: out with lifts: set so Kerf works it out"}.`,
          margin: Math.max(0, lo) / WRAPS_MIN,
        });
      else if (perLayer && nd.flange !== undefined && layers * d > nd.flange + 1e-6 && nd.flange > 0)
        out.push({ ...b, status: "fail", title: `${t} overfills ${nd.name}`, detail: `${nd.name} holds ${range} of rope. ${perLayer} turns of ${N0(d, 1)} mm rope fit side by side in its ${N0(nd.width!, 1)} mm, so ${N0(hi, 1)} turns pile ${layers} deep: ${N0(layers * d, 1)} mm against flanges ${N0(nd.flange, 1)} mm high. The rope spills over them.`, fix: `Make ${nd.name} at least ${N0(Math.ceil(hi) * d + d, 0)} mm wide between its flanges, raise the flanges to ${N0((layers + 1.5) * d, 0)} mm, or use a bigger barrel so fewer turns are needed.`, margin: nd.flange / (layers * d) });
      else if (layers > 1)
        out.push({ ...b, status: "warn", title: `${t} winds onto a second layer on ${nd.name}`, detail: `${nd.name} holds ${range} of rope, and ${perLayer} turns fit side by side in its ${N0(nd.width!, 1)} mm: the rest ride on top. On the second layer each turn winds ${N0(TAU * (nd.r + d), 0)} mm instead of ${N0(TAU * nd.r, 0)} mm, so the travel per turn grows and the rope beds into the layer below.`, fix: `Make ${nd.name} at least ${N0(Math.ceil(hi) * d + d, 0)} mm wide between its flanges for one layer, or use a bigger barrel.` });
      else if (lo < WRAPS_WANT - 1e-6) out.push({ ...b, status: "warn", title: `${t} leaves ${N0(lo, 1)} turns on ${nd.name}`, detail: `${nd.name} holds ${range} of rope through the motion. Two full turns is the least that keeps the pull off the anchor; three is what most winch makers ask for.`, fix: `Give the rope wraps: ${N0(Math.ceil((r.nodes[i].wraps ?? 0) + WRAPS_WANT - lo), 0)}.` });
      else if (nd.flange === 0)
        out.push({ ...b, status: "warn", title: `${nd.name} has no flanges`, detail: `${nd.name} holds ${range} of rope on a plain barrel: nothing stops a turn sliding off its end when the rope goes slack or leads off at an angle.`, fix: `Give ${nd.name} a flange at each end, at least ${N0(2.5 * d, 0)} mm higher than the barrel (lib.drum draws one).` });
      else out.push({ ...b, status: "pass", title: `${nd.name} keeps ${N0(lo, 1)} turns or more`, detail: `${nd.name} holds ${range} of rope through the motion${perLayer ? `, in one layer (${perLayer} turns fit side by side)` : ""}.` });
    }

    // sheaves and drums big enough for the rope
    const wheels = nodes.map((nd, i) => ({ nd, i })).filter((x) => x.nd.kind !== "tie" && x.nd.rootD !== undefined);
    if (wheels.length) {
      const small = wheels.map((x) => ({ ...x, ratio: x.nd.rootD! / d })).filter((x) => x.ratio < r.rope.bend - 1e-6);
      const worst = small.length ? Math.min(...small.map((x) => x.ratio)) : Math.min(...wheels.map((x) => x.nd.rootD! / d));
      const status = !small.length ? "pass" : worst < r.rope.bendMin - 1e-6 ? "fail" : "warn";
      const rule = r.rope.kind === "wire" ? `Loos & Co's smallest recommended pulley for ${r.rope.construction.split(" ")[0]} is ${N0(r.rope.bend)} times the rope's diameter` : `Marlow's figure for most fibre ropes is a sheave 8 to 10 times the rope's diameter`;
      out.push({
        ...geo,
        id: `rope:bend:${r.name}`,
        status,
        title: status === "pass" ? `${t}: sheaves and drum are big enough` : `${t} is bent too tightly`,
        detail:
          status === "pass"
            ? `The smallest it runs on is ${N0(worst, 1)} times its ${N0(d, 1)} mm diameter; ${rule}.`
            : `${small.map((x) => `${x.nd.name} is ${N0(x.nd.rootD!, 1)} mm where the rope sits, ${N0(x.ratio, 1)} times the rope's ${N0(d, 1)} mm`).join("; ")}. ${rule.replace(/^./, (c) => c.toUpperCase())} (${N0(r.rope.bend * d)} mm here): on less, ${r.rope.kind === "wire" ? "its wires bend past what they stand and break one by one" : "its fibres wear and it loses strength"}${status === "fail" ? ", and under half of that it takes a set the first time it is loaded" : ""}.`,
        fix: status === "pass" ? undefined : `Make ${listOf(small.map((x) => x.nd.name))} at least ${N0(r.rope.bend * d)} mm where the rope sits${r.rope.kind === "wire" ? `, use a thinner or more flexible rope (7x19 bends tighter than 7x7), or a Dyneema rope, which runs on sheaves 8 times its diameter` : ""}.`,
        margin: worst / r.rope.bend,
      });
      // the rope fits its grooves
      const tight = wheels.filter((x) => x.nd.kind === "sheave" && x.nd.width !== undefined && x.nd.width > 0 && x.nd.width < d - 1e-6);
      if (tight.length) out.push({ ...geo, id: `rope:groove:${r.name}`, status: "fail", title: `${t} does not fit ${listOf(tight.map((x) => x.nd.name))}`, detail: `${tight.map((x) => `${x.nd.name}'s groove is ${N0(x.nd.width!, 1)} mm wide where the rope sits`).join("; ")}, and the rope is ${N0(d, 1)} mm: it rides on the rims and jumps off.`, fix: `Use a sheave with a round groove ${N0(d * 1.07, 1)} to ${N0(d * 1.1, 1)} mm across (lib.sheave sizes it from rope:).` });
      // fleet angle: how far off square the rope meets each wheel
      const off = wheels.map((x) => ({ ...x, a: run.fleet[x.i] })).filter((x) => x.a > FLEET_WARN + 1e-6);
      const worstA = Math.max(...wheels.map((x) => run.fleet[x.i]));
      out.push({
        ...motion,
        id: `rope:fleet:${r.name}`,
        status: !off.length ? "pass" : worstA > FLEET_FAIL ? "fail" : "warn",
        title: !off.length ? `${t} leads square onto its sheaves and drum` : `${t} leads off at an angle`,
        detail: !off.length
          ? `The most it leads off square anywhere in the motion is ${N0(worstA, 1)}° (1.5° is the limit for a smooth drum).`
          : `${off.map((x) => `it meets ${x.nd.name} ${N0(x.a, 1)}° off square`).join("; ").replace(/^./, (c) => c.toUpperCase())}. Past 1.5° a smooth drum winds unevenly and the rope scrubs a sheave's flange; past 4° it climbs out of the groove.`,
        fix: !off.length
          ? undefined
          : `Line ${listOf(off.map((x) => x.nd.name))} up with the rope's run (move it along its axis, or turn its axis square to the rope)${
              off.some((x) => x.nd.kind === "drum" && (x.nd.width ?? 0) > d) ? `, or move the first sheave further from the drum: at least ${N0(Math.max(...off.map((x) => (x.nd.kind === "drum" ? (x.nd.width ?? 0) / 2 / Math.tan((FLEET_WARN * Math.PI) / 180) : 0))), 0)} mm away keeps a drum this wide inside 1.5°` : ""
            }.`,
        margin: FLEET_WARN / Math.max(1e-6, worstA),
      });
    }

    // weights that hang on it as drawn, with nothing moving
    const hanging = hangingOn(run, model, holds, kernel, mesh, volume);
    let staticPull = 0;
    for (const hg of hanging) {
      const up = hg.legs.reduce((n, l) => n + l.dir[2], 0);
      const W = hg.kg * G;
      const names = listOf(hg.names);
      const b = { ...base, id: `rope:hang:${r.name}:${hg.ids[0]}`, parts: [...ids, ...hg.ids] };
      if (up < 0.05) {
        out.push({ ...b, category: "assembly", status: "fail", title: `${t} cannot hold ${names} up`, detail: `${names} (${mass(hg.kg)}) ${hg.names.length === 1 ? "is" : "are"} held by nothing but ${t}, and the rope leads ${up < -0.05 ? "downward" : "sideways"} from ${hg.names.length === 1 ? "it" : "them"}: a rope only pulls along itself, so it cannot carry a weight it does not lead up from.`, fix: `Take the rope up from ${names} to a sheave or an anchor above, or hold ${names} some other way.`, margin: 0 });
        continue;
      }
      const pull = W / up;
      staticPull = Math.max(staticPull, pull);
      // plumb: the weight settles with its centre of mass under where the rope holds it
      const side = hg.legs.length === 1 ? Math.hypot(hg.c[0] - hg.legs[0].at[0], hg.c[1] - hg.legs[0].at[1]) : 0;
      const lean = hg.legs.length === 1 ? deg(Math.acos(Math.min(1, hg.legs[0].dir[2]))) : 0;
      const swings = side > 2 || lean > 1;
      out.push({
        ...b,
        category: "assembly",
        status: swings ? "warn" : "pass",
        title: swings ? `${names} will swing on ${t}` : `${names} ${hg.names.length === 1 ? "hangs" : "hang"} on ${t}`,
        detail: `${names} (${mass(hg.kg)}) ${hg.names.length === 1 ? "hangs" : "hang"} on ${hg.legs.length === 1 ? "one part" : `${hg.legs.length} parts`} of the rope and nothing else, which puts ${force(pull)} in it.${swings ? ` ${lean > 1 ? `The rope leads up ${N0(lean, 1)}° off vertical` : `${hg.names.length === 1 ? "Its" : "Their"} centre of mass is ${N0(side, 1)} mm to the side of where the rope holds ${hg.names.length === 1 ? "it" : "them"}`}: let go, ${hg.names.length === 1 ? "it swings" : "they swing"} until the weight is straight under the rope.` : ""}`,
        fix: swings ? (lean > 1 ? `Move the rope's tie, or the sheave above it, so the rope leads straight up from ${names}.` : `Tie the rope over the centre of mass of ${names} (x ${N0(hg.c[0], 1)}, y ${N0(hg.c[1], 1)}), or use two legs to hold it level.`) : undefined,
      });
    }

    // the pull against the rope's strength
    const pushes = h.carries.filter((c) => !c.holds);
    for (const c of pushes)
      out.push({
        ...base,
        id: `rope:push:${r.name}:${c.load.lead.name}`,
        status: "fail",
        title: `${t} cannot hold ${c.load.lead.name}: a rope does not push`,
        detail: `${c.load.lead.name}'s weight (${mass(c.load.mass)}) pulls it the way that slackens ${t}, at least for part of its motion: the rope would have to push to hold it there, and it folds instead.`,
        fix: `Lead the rope to ${c.load.lead.name} from the side its weight pulls away from (up from a lift, over a sheave above it), or hold it some other way where the rope goes slack.`,
        margin: 0,
      });
    const pull = Math.max(h.tension, staticPull);
    const wll = r.rope.mbl / r.rope.factor;
    const carried = h.carries.filter((c) => c.holds);
    if (pull > 1e-6) {
      const top = carried.sort((a, b) => b.pull - a.pull)[0];
      const parts = top ? Math.abs(top.take) : 1;
      const from =
        top && top.pull >= staticPull && top.pull >= (r.pull ?? 0)
          ? `${top.load.lead.name}${top.load.parts.some((p) => p.name !== top.load.lead.name && !isFastener(p)) ? " and what moves with it weigh" : " weighs"} ${mass(top.load.mass)}${top.load.kind === "lift" && Math.abs(parts - 1) > 0.05 ? `, shared by ${N0(parts, Math.abs(parts - Math.round(parts)) > 0.05 ? 1 : 0)} parts of rope` : ""}, which puts ${force(pull)} in the rope`
          : (r.pull ?? 0) >= staticPull
            ? `Its pull is given as ${force(r.pull ?? 0)}`
            : `The weight hanging on it puts ${force(pull)} in the rope`;
      const share = pull / wll;
      const status = pull <= wll ? "pass" : pull <= 2 * wll ? "warn" : "fail";
      const stretch = (pull / r.rope.ea) * (r.length - stored);
      out.push({
        ...base,
        id: `rope:load:${r.name}`,
        status,
        title: status === "pass" ? `${t} carries ${force(pull)}, ${share < 0.01 ? "under 1" : N0(share * 100)} % of its working load` : `${t} is ${status === "fail" ? "far too" : "too"} weak for ${force(pull)}`,
        detail: `${from}. ${r.label} breaks at ${force(r.rope.mbl)}, and ropes are worked at a fifth of that: ${force(wll)} here (a tenth for anything overhead or safety-critical). At this pull it stretches ${stretch < 0.05 ? "under 0.1" : `about ${N0(stretch, stretch < 10 ? 1 : 0)}`} mm over its ${N0(r.length - stored)} mm run.${status === "pass" ? "" : " Starting, stopping and any snatch add to the pull."}`,
        fix: status === "pass" ? undefined : `Use a rope that breaks at ${force(pull * r.rope.factor)} or more, or share the weight over more parts of rope with a sheave on the load.`,
        margin: wll / pull,
      });
    } else if (!pushes.length)
      out.push({ ...base, id: `rope:noload:${r.name}`, status: "info", title: `${t}: pull not known`, detail: `No moving part's weight hangs on ${t} and it has no pull: of its own, so Kerf cannot check its strength. Its working load is ${force(wll)} (a fifth of the ${force(r.rope.mbl)} it breaks at).`, fix: `Give it pull: (the most it carries, in newtons), or lifts: the part it raises.`, basis: "needs analysis" });
  }
  return out;
}

const mass = (kg: number) => (kg >= 1 ? `${fmtNum(kg, 2)} kg` : `${fmtNum(kg * 1000, 0)} g`);
