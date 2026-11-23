// Round belts (lib.round_belt): polyurethane round belting welded to length,
// and O-rings used as belts, run in grooved pulleys and driven by friction
// alone. This file has the cord's figures (how hard it pulls at a stretch,
// the smallest pulley, its grip), the closed path a taut belt takes round its
// pulleys, and the belt as a solid. What it can carry before it slips, and
// whether its pulleys turn at the speeds it gives them, are worked out in
// core/roundBeltChecks.ts from the RoundBeltDef.

import type { PartRecipe, V3 } from "../kernel/recipe";
import { vadd, vcross, vdot, vlen, vnorm, vscale, vsub } from "../kernel/recipe";
import { relaxedShare, strandTension, type Rubber } from "../library/bands";
import { ropePath, sweepAlong, type RopePoint, type WheelIn } from "./ropes";
import type { RoundBeltDef, RoundBeltNode, RopeSpan } from "./types";

export class RoundBeltError extends Error {}

const deg = (r: number) => (r * 180) / Math.PI;

// ---------------------------------------------------------------- the cord

/**
 * Polyurethane round belting. Stress at 5 % and 10 % stretch, the hardness and the smallest pulley for each size are
 * MISUMI's published figures for its MBT (orange) and MBTH (green, high tensile) belts; friction is Ammeraal
 * Beltech's table for its Solicord round belts (the row at or above the belt's hardness, which is the lower grip);
 * 1 to 8 % pretension is Ammeraal Beltech's range for round belts, and sellers quote working load at 8 %.
 */
interface PuGrade {
  label: string;
  shore: number;
  /** N/mm² at 5 % and at 10 % stretch */
  at5: number;
  at10: number;
  /** smallest pulley by cord diameter, mm */
  pulley: [number, number][];
  mu: { aluminium: number; steel: number };
  color: string;
}
const PU: Record<string, PuGrade> = {
  pu: { label: "polyurethane 88A", shore: 88, at5: 1.2, at10: 1.8, pulley: [[2, 15], [3, 20], [4, 30], [5, 40], [6, 50], [8, 70], [10, 90]], mu: { aluminium: 0.7, steel: 0.5 }, color: "#e8792b" },
  pu92: { label: "polyurethane 92A", shore: 92, at5: 2.0, at10: 3.1, pulley: [[2, 20], [3, 30], [4, 40], [5, 50], [6, 60], [8, 80], [10, 100]], mu: { aluminium: 0.65, steel: 0.45 }, color: "#2f8f4e" },
};
const PU_BASIS = { pulley: "MISUMI's smallest pulley for this belt", stretch: "Ammeraal Beltech gives 1 to 8 % pretension for round belts", mu: "Ammeraal Beltech's friction table for polyurethane round belts" };
/** O-rings as belts: Apple Rubber's Seal Design Guide (drive belts). */
const RING_BASIS = { pulley: "Apple Rubber's rule for O-ring drive belts: four times the cord at the bottom of the groove", stretch: "Apple Rubber gives 8 to 12 % stretch for O-ring drive belts", mu: "a typical figure for dry rubber on a smooth painted or anodised surface" };

export type BeltCord = RoundBeltDef["cord"];

export function puGrade(name: string): string | undefined {
  const k = name.trim().toLowerCase();
  if (/92|high/.test(k) && /pu|urethane/.test(k)) return "pu92";
  if (/^(pu|tpu|polyurethane|urethane)( ?8[58] ?a?)?$/.test(k)) return "pu";
  return undefined;
}

/** A value read off a table of [size, value] rows: between two rows in proportion, beyond the ends by the end row's ratio. */
function fromTable(rows: [number, number][], x: number): number {
  if (x <= rows[0][0]) return (rows[0][1] * x) / rows[0][0];
  for (let i = 1; i < rows.length; i++) if (x <= rows[i][0]) return rows[i - 1][1] + ((rows[i][1] - rows[i - 1][1]) * (x - rows[i - 1][0])) / (rows[i][0] - rows[i - 1][0]);
  const last = rows[rows.length - 1];
  return (last[1] * x) / last[0];
}

export function puCord(grade: string, d: number): BeltCord {
  const g = PU[grade];
  return { kind: "pu", label: g.label, material: "TPU", color: g.color, d, shore: g.shore, at5: g.at5, at10: g.at10, stretchMin: 0.01, stretchMax: 0.08, stretchBasis: PU_BASIS.stretch, minPulley: Math.round(fromTable(g.pulley, d) * 10) / 10, pulleyBasis: PU_BASIS.pulley, muAluminium: g.mu.aluminium, muSteel: g.mu.steel, muBasis: PU_BASIS.mu, maxTemp: 80 };
}

export function rubberCord(r: Rubber, shore: number, d: number): BeltCord {
  return { kind: "rubber", label: `${r.label} ${shore}A`, material: r.material, color: "#1b1d21", d, shore, Jm: r.Jm, relax: r.relax, stretchMin: 0.08, stretchMax: 0.12, stretchBasis: RING_BASIS.stretch, minPulley: 4 * d, pulleyBasis: RING_BASIS.pulley, muAluminium: r.mu[0], muSteel: r.mu[0], muBasis: RING_BASIS.mu, maxTemp: r.temp[1] };
}

/** Pull in one strand of the cord at a stretch (0.06 = 6 %), freshly fitted, N. */
export function cordTension(c: BeltCord, stretch: number): number {
  if (stretch <= 0) return 0;
  const area = (Math.PI * c.d * c.d) / 4;
  if (c.kind === "pu") {
    const at5 = c.at5 ?? 1.2;
    const at10 = c.at10 ?? 1.8;
    // the maker's two points, a straight line to each and on past the second
    const stress = stretch <= 0.05 ? (at5 * stretch) / 0.05 : at5 + ((at10 - at5) * (stretch - 0.05)) / 0.05;
    return stress * area;
  }
  return strandTension({ rubber: { Jm: c.Jm ?? 13 } as Rubber, shore: c.shore, cs: c.d, id: 0 }, 1 + stretch);
}

/** The share of that pull a rubber ring keeps after a year held stretched (polyurethane belting: its makers' figures are working figures already). */
export function cordKept(c: BeltCord): number {
  return c.kind === "rubber" && c.relax ? relaxedShare({ relax: c.relax } as Rubber, 60 * 24 * 365) : 1;
}

/** A cord keeps its volume: stretched, it is thinner. */
export const stretchedD = (d: number, stretch: number) => d / Math.sqrt(1 + Math.max(0, stretch));

// ---------------------------------------------------------------- the path

export interface RoundBeltLayout {
  nodes: RoundBeltNode[];
  spans: RopeSpan[];
  /** round the path along the cord's centre line, mm */
  length: number;
  /** the centre line for drawing, open by a hair in the middle of its longest straight run */
  line: V3[];
}

/**
 * Lay a belt round its pulleys, in the order it meets them. It runs round the outside of them all, turning the same
 * way round each; flip: sends it past a pulley on its back (an idler pressing in on the belt).
 */
export function layoutRoundBelt(wheels: WheelIn[], dLine: number, flip: Set<string>): RoundBeltLayout {
  const K = wheels.length;
  if (K < 2) throw new RoundBeltError("path: a belt needs two pulleys or more, like path: [motor_pulley, big_pulley]");
  if (K > 20) throw new RoundBeltError("path: a belt is limited to 20 pulleys");
  for (let i = 0; i < K; i++) {
    const a = wheels[i];
    const b = wheels[(i + 1) % K];
    if (a.name === b.name && K > 1) throw new RoundBeltError(`path: ${a.name} is listed twice in a row`);
    if (vlen(vsub(a.c, b.c)) < 1e-6) throw new RoundBeltError(`path: ${a.name} and ${b.name} are in the same place`);
  }
  const n0 = vnorm(wheels[0].axis);
  // the way round: counter-clockwise seen against the first pulley's axis when the pulleys are listed that way
  let area = 0;
  for (let i = 1; i < K - 1; i++) area += vdot(vcross(vsub(wheels[i].c, wheels[0].c), vsub(wheels[i + 1].c, wheels[0].c)), n0);
  const way = area < 0 ? -1 : 1;
  const pts: RopePoint[] = wheels.map((w) => {
    const a = vnorm(w.axis);
    const same = vdot(a, n0) >= 0 ? 1 : -1;
    return { c: w.c, axis: a, r: w.rootD / 2 + dLine / 2, dir: (way * same * (flip.has(w.name) ? -1 : 1)) as 1 | -1 };
  });
  // a closed loop, as an open path that starts a pulley early and ends a pulley late: every pulley is then between two others
  const ring = [pts[K - 1], ...pts, pts[0]];
  const path = ropePath(ring);
  const bad = path.inside.find((i) => i >= 1 && i <= K);
  if (bad !== undefined) throw new RoundBeltError(`path: ${wheels[bad - 1].name} is too close to the pulley next to it for the belt to run between them: move them apart`);
  const nodes: RoundBeltNode[] = wheels.map((w, i) => {
    const k = i + 1;
    if (path.wrap[k] < (0.5 * Math.PI) / 180) throw new RoundBeltError(`path: the belt does not bend round ${w.name}. List the pulleys in the order the belt meets them; flip: [${w.name}] runs its back on that pulley`);
    return { name: w.name, label: w.label, c: pts[i].c, axis: pts[i].axis!, r: pts[i].r, rootD: w.rootD, dir: pts[i].dir, wrap: deg(path.wrap[k]), fleet: deg(Math.max(path.fleetIn[k], path.fleetOut[k])), width: w.width, flange: w.flange };
  });
  const spans: RopeSpan[] = wheels.map((w, i) => ({ from: w.name, to: wheels[(i + 1) % K].name, a3: path.depart[i + 1], b3: path.arrive[i + 2], length: path.spans[i + 1] }));
  const length = spans.reduce((n, s) => n + s.length, 0) + nodes.reduce((n, nd) => n + (nd.r * nd.wrap * Math.PI) / 180, 0);

  // the centre line, from the middle of the longest straight run and back to it. Round a pulley its corners stand
  // just outside the cord's circle, so that with the corners rounded it touches the circle and never cuts inside
  let longest = 0;
  spans.forEach((s, i) => {
    if (s.length > spans[longest].length) longest = i;
  });
  const line: V3[] = [];
  const mid = vscale(vadd(spans[longest].a3, spans[longest].b3), 0.5);
  const along = vnorm(vsub(spans[longest].b3, spans[longest].a3));
  line.push(vadd(mid, vscale(along, 0.01)));
  for (let j = 1; j <= K; j++) {
    const i = (longest + j) % K;
    const nd = pts[i];
    const k = i + 1;
    const a = nd.axis!;
    const e1 = vnorm(vsub(path.arrive[k], nd.c));
    const e2 = vcross(a, e1);
    const T = Math.max(0, path.wrap[k]);
    const steps = Math.max(1, Math.ceil(T / ((12 * Math.PI) / 180)));
    const st = T / steps;
    const R = nd.r / Math.cos(st / 2);
    for (let q = 0; q < steps; q++) {
      const tau = nd.dir * (q + 0.5) * st;
      line.push(vadd(nd.c, vadd(vscale(e1, R * Math.cos(tau)), vscale(e2, R * Math.sin(tau)))));
    }
  }
  line.push(vsub(mid, vscale(along, 0.01)));
  return { nodes, spans, length, line };
}

/** The belt as a solid: the stretched cord's round section swept along its centre line. */
export function roundBeltRecipe(L: RoundBeltLayout, dDrawn: number): PartRecipe {
  const shape = sweepAlong(L.line, dDrawn);
  if (!shape) throw new RoundBeltError("path: the belt has no length");
  return { base: shape, ops: [] };
}

/** One revolution's worth of slip-free grip round a pulley: tight side over slack side, by the capstan relation. */
export const capstan = (mu: number, wrapDeg: number) => Math.exp((mu * wrapDeg * Math.PI) / 180);

/** The most pull (tight side less slack side) a belt can pass at a pulley before it slips, N, with `t0` in each strand at rest. */
export function gripForce(t0: number, mu: number, wrapDeg: number): number {
  const k = capstan(mu, wrapDeg);
  return (2 * t0 * (k - 1)) / (k + 1);
}


