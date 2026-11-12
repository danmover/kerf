// Geometric constraint solver for 2D sketches.
//
// Unknowns are point coordinates and circle radii. Every constraint becomes
// one or two residual equations measured in millimetres. The solver takes
// weighted minimum-norm Gauss-Newton steps (Levenberg-Marquardt damped), so
// geometry moves as little as possible from where it was written: anything
// the constraints leave free stays exactly at its starting position. While
// dragging, the dragged unknowns are made expensive to move, so the rest of
// the sketch gives way instead.
//
// After solving it reports degrees of freedom, which unknowns are still
// free (and in which direction a point can move), redundant constraints and,
// when the system cannot be satisfied, the constraints left unsatisfied.
//
// Unknowns that no constraint ties together are solved separately, and each
// group's equations are put in a narrow-band order, so a step costs about
// m·b² rather than m³ for chains of geometry. A group bigger than
// MAX_UNKNOWNS is not solved at all, and every solve has a time budget.

export type V2 = [number, number];

export interface DefPoint {
  id: string;
  x: number;
  y: number;
  fixed: boolean;
}
export interface DefLine {
  id: string;
  a: string;
  b: string;
}
export interface DefCircle {
  id: string;
  c: string;
  r: number;
}
/** Counter-clockwise from a to b around c. The radius is |a - c|; |b - c| is kept equal to it. */
export interface DefArc {
  id: string;
  c: string;
  a: string;
  b: string;
  /** a mirrored, patterned or offset copy: its points are set by the copy's constraints, which keep |b - c| = |a - c| already */
  rigid?: boolean;
}

export type ConsKind =
  | "coincident"
  | "on_line"
  | "on_circle"
  | "horizontal"
  | "vertical"
  | "parallel"
  | "perpendicular"
  | "equal_length"
  | "equal_radius"
  | "tangent"
  | "midpoint"
  | "symmetric_line"
  | "symmetric_point"
  | "distance"
  | "distance_pl"
  | "distance_ll"
  | "hdistance"
  | "vdistance"
  | "length"
  | "radius"
  | "angle"
  /** copies made by mirror, pattern and offset statements */
  | "rotate"
  | "radius_offset"
  | "radius_diff"
  | "perp_foot"
  | "radial";

export interface DefConstraint {
  kind: ConsKind;
  refs: string[];
  /** millimetres, or degrees for angle */
  value?: number;
  /** index of the source statement this came from (several may share one) */
  src: number;
}

export interface SketchDef {
  points: DefPoint[];
  lines: DefLine[];
  circles: DefCircle[];
  arcs: DefArc[];
  constraints: DefConstraint[];
}

export interface SolveOptions {
  /** ids of points (or circles, for their radius) to keep as close as possible to their start */
  heavy?: string[];
  maxIter?: number;
  /** skip the rank analysis (faster, used while dragging) */
  analyse?: boolean;
  /** time allowance, shared by every solve given the same object (default: SOLVE_MS from the start of this solve) */
  budget?: Budget;
}

/** The solver stops once performance.now() passes `until`, so a huge sketch cannot freeze the page. */
export interface Budget {
  until: number;
}

/** Most unknowns one connected group of geometry may have (about 300 points); bigger sketches are not solved. */
export const MAX_UNKNOWNS = 600;
/** Default time allowance for solving one sketch, in milliseconds. */
export const SOLVE_MS = 250;
export const budgetMs = (ms: number): Budget => ({ until: performance.now() + ms });
const over = (b: Budget) => performance.now() > b.until;

export type PointFreedom = { kind: "fixed" } | { kind: "defined" } | { kind: "line"; dir: V2 } | { kind: "free" };

export interface SolveResult {
  ok: boolean;
  iterations: number;
  /** largest remaining residual, mm */
  residual: number;
  points: Record<string, V2>;
  radii: Record<string, number>;
  /** remaining degrees of freedom (unknowns minus independent equations) */
  dof: number;
  freedom: Record<string, PointFreedom>;
  /** circles whose radius is still free */
  freeRadius: string[];
  /** constraint def indices whose equations are implied by earlier ones */
  redundant: number[];
  /** constraint def indices left unsatisfied when ok is false */
  unsatisfied: number[];
  /** set (to the group's unknown count) when a connected group is over MAX_UNKNOWNS, so nothing was solved */
  tooBig?: number;
  /** the time budget ran out before the solver finished */
  outOfTime?: boolean;
}

const TOL = 1e-9;
/** iterate past TOL so solved coordinates come out clean (25, not 24.999999998) */
const TIGHT = 1e-12;

interface Eq {
  vars: number[];
  f: (x: Float64Array) => number;
  /** def constraint index, or -1 for structural equations (arc radius) */
  con: number;
}

class System {
  x: Float64Array;
  free: boolean[];
  weight: Float64Array;
  eqs: Eq[] = [];
  pIdx = new Map<string, number>();
  rIdx = new Map<string, number>();
  /** var index → owning entity, for reporting */
  constructor(public def: SketchDef, heavy: Set<string>) {
    const n = def.points.length * 2 + def.circles.length;
    this.x = new Float64Array(n);
    this.free = new Array(n).fill(true);
    this.weight = new Float64Array(n).fill(1);
    def.points.forEach((p, i) => {
      this.pIdx.set(p.id, 2 * i);
      this.x[2 * i] = p.x;
      this.x[2 * i + 1] = p.y;
      if (p.fixed) this.free[2 * i] = this.free[2 * i + 1] = false;
      if (heavy.has(p.id)) this.weight[2 * i] = this.weight[2 * i + 1] = 1e4;
    });
    const base = def.points.length * 2;
    def.circles.forEach((c, i) => {
      this.rIdx.set(c.id, base + i);
      this.x[base + i] = c.r;
      if (heavy.has(c.id)) this.weight[base + i] = 1e4;
    });
  }
}

/** Builds residual equations for a sketch definition. Throws on references the evaluator should have caught. */
function build(def: SketchDef, heavy: Set<string>): System {
  const S = new System(def, heavy);
  const lines = new Map(def.lines.map((l) => [l.id, l]));
  const circles = new Map(def.circles.map((c) => [c.id, c]));
  const arcs = new Map(def.arcs.map((a) => [a.id, a]));
  const pi = (id: string) => {
    const i = S.pIdx.get(id);
    if (i === undefined) throw new Error(`unknown point ${id}`);
    return i;
  };
  // shared points (same id or tied by a coincident constraint) decide how tangency is written
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let r = a;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  for (const c of def.constraints) if (c.kind === "coincident") parent.set(find(c.refs[0]), find(c.refs[1]));
  const same = (a: string, b: string) => find(a) === find(b);

  const eq = (vars: number[], f: (x: Float64Array) => number, con: number) => S.eqs.push({ vars: [...new Set(vars)], f, con });

  // structural: an arc's end stays on its radius
  for (const a of def.arcs) {
    if (a.rigid) continue;
    const c = pi(a.c);
    const p = pi(a.a);
    const q = pi(a.b);
    eq([c, c + 1, p, p + 1, q, q + 1], (x) => Math.hypot(x[q] - x[c], x[q + 1] - x[c + 1]) - Math.hypot(x[p] - x[c], x[p + 1] - x[c + 1]), -1);
  }

  type Circ = { c: number; rVars: number[]; r: (x: Float64Array) => number; pts: string[]; center: string };
  const circ = (id: string): Circ => {
    const ci = circles.get(id);
    if (ci) {
      const c = pi(ci.c);
      const r = S.rIdx.get(ci.id)!;
      return { c, rVars: [r], r: (x) => x[r], pts: [], center: ci.c };
    }
    const a = arcs.get(id);
    if (a) {
      const c = pi(a.c);
      const p = pi(a.a);
      return { c, rVars: [p, p + 1], r: (x) => Math.hypot(x[p] - x[c], x[p + 1] - x[c + 1]), pts: [a.a, a.b], center: a.c };
    }
    throw new Error(`${id} is not a circle or arc`);
  };
  const line = (id: string) => {
    const l = lines.get(id);
    if (!l) throw new Error(`${id} is not a line`);
    return { a: pi(l.a), b: pi(l.b), ia: l.a, ib: l.b };
  };
  const len = (x: Float64Array, a: number, b: number) => Math.max(Math.hypot(x[b] - x[a], x[b + 1] - x[a + 1]), 1e-12);
  // signed distance of point p from the infinite line through a, b
  const sdist = (x: Float64Array, p: number, a: number, b: number) => ((x[b] - x[a]) * (x[p + 1] - x[a + 1]) - (x[b + 1] - x[a + 1]) * (x[p] - x[a])) / len(x, a, b);
  const sign0 = (v: number) => (v < 0 ? -1 : 1);

  def.constraints.forEach((con, k) => {
    const [r0, r1, r2] = con.refs;
    const v = con.value ?? 0;
    switch (con.kind) {
      case "coincident": {
        const a = pi(r0);
        const b = pi(r1);
        eq([a, b], (x) => x[a] - x[b], k);
        eq([a + 1, b + 1], (x) => x[a + 1] - x[b + 1], k);
        return;
      }
      case "on_line": {
        const p = pi(r0);
        const l = line(r1);
        eq([p, p + 1, l.a, l.a + 1, l.b, l.b + 1], (x) => sdist(x, p, l.a, l.b), k);
        return;
      }
      case "on_circle": {
        const p = pi(r0);
        const c = circ(r1);
        eq([p, p + 1, c.c, c.c + 1, ...c.rVars], (x) => Math.hypot(x[p] - x[c.c], x[p + 1] - x[c.c + 1]) - c.r(x), k);
        return;
      }
      case "horizontal":
      case "vertical": {
        const a = pi(r0);
        const b = pi(r1);
        const o = con.kind === "horizontal" ? 1 : 0;
        eq([a + o, b + o], (x) => x[b + o] - x[a + o], k);
        return;
      }
      case "parallel":
      case "perpendicular": {
        const l1 = line(r0);
        const l2 = line(r1);
        const vars = [l1.a, l1.a + 1, l1.b, l1.b + 1, l2.a, l2.a + 1, l2.b, l2.b + 1];
        eq(
          vars,
          (x) => {
            const dx1 = x[l1.b] - x[l1.a];
            const dy1 = x[l1.b + 1] - x[l1.a + 1];
            const dx2 = x[l2.b] - x[l2.a];
            const dy2 = x[l2.b + 1] - x[l2.a + 1];
            const L1 = Math.max(Math.hypot(dx1, dy1), 1e-12);
            const L2 = Math.max(Math.hypot(dx2, dy2), 1e-12);
            const s = con.kind === "parallel" ? dx1 * dy2 - dy1 * dx2 : dx1 * dx2 + dy1 * dy2;
            return (s / (L1 * L2)) * ((L1 + L2) / 2);
          },
          k,
        );
        return;
      }
      case "equal_length": {
        const l1 = line(r0);
        const l2 = line(r1);
        eq([l1.a, l1.a + 1, l1.b, l1.b + 1, l2.a, l2.a + 1, l2.b, l2.b + 1], (x) => len(x, l1.a, l1.b) - len(x, l2.a, l2.b), k);
        return;
      }
      case "equal_radius": {
        const c1 = circ(r0);
        const c2 = circ(r1);
        eq([c1.c, c1.c + 1, ...c1.rVars, c2.c, c2.c + 1, ...c2.rVars], (x) => c1.r(x) - c2.r(x), k);
        return;
      }
      case "tangent": {
        const isLine0 = lines.has(r0);
        const isLine1 = lines.has(r1);
        if (isLine0 && isLine1) throw new Error("tangent needs a circle or arc");
        if (isLine0 || isLine1) {
          const l = line(isLine0 ? r0 : r1);
          const c = circ(isLine0 ? r1 : r0);
          // sharing an end point: the line runs at right angles to the radius there
          const shared = c.pts.find((p) => same(p, l.ia) || same(p, l.ib));
          if (shared) {
            const p = pi(shared);
            eq([l.a, l.a + 1, l.b, l.b + 1, p, p + 1, c.c, c.c + 1], (x) => ((x[l.b] - x[l.a]) * (x[p] - x[c.c]) + (x[l.b + 1] - x[l.a + 1]) * (x[p + 1] - x[c.c + 1])) / len(x, l.a, l.b), k);
          } else {
            const s = sign0(sdist(S.x, c.c, l.a, l.b));
            eq([l.a, l.a + 1, l.b, l.b + 1, c.c, c.c + 1, ...c.rVars], (x) => sdist(x, c.c, l.a, l.b) - s * c.r(x), k);
          }
          return;
        }
        const c1 = circ(r0);
        const c2 = circ(r1);
        const shared = c1.pts.find((p) => c2.pts.some((q) => same(p, q)));
        if (shared) {
          // the two centres and the shared point are in line
          const p = pi(shared);
          eq([c1.c, c1.c + 1, c2.c, c2.c + 1, p, p + 1], (x) => {
            const ax = x[p] - x[c1.c];
            const ay = x[p + 1] - x[c1.c + 1];
            const bx = x[p] - x[c2.c];
            const by = x[p + 1] - x[c2.c + 1];
            const la = Math.max(Math.hypot(ax, ay), 1e-12);
            const lb = Math.max(Math.hypot(bx, by), 1e-12);
            return ((ax * by - ay * bx) / (la * lb)) * ((la + lb) / 2);
          }, k);
        } else {
          const x0 = S.x;
          const d0 = Math.hypot(x0[c2.c] - x0[c1.c], x0[c2.c + 1] - x0[c1.c + 1]);
          const external = d0 >= Math.max(c1.r(x0), c2.r(x0));
          const bigFirst = c1.r(x0) >= c2.r(x0);
          eq([c1.c, c1.c + 1, c2.c, c2.c + 1, ...c1.rVars, ...c2.rVars], (x) => {
            const d = Math.hypot(x[c2.c] - x[c1.c], x[c2.c + 1] - x[c1.c + 1]);
            return external ? d - (c1.r(x) + c2.r(x)) : d - (bigFirst ? c1.r(x) - c2.r(x) : c2.r(x) - c1.r(x));
          }, k);
        }
        return;
      }
      case "midpoint": {
        const p = pi(r0);
        const l = line(r1);
        eq([p, l.a, l.b], (x) => x[p] - (x[l.a] + x[l.b]) / 2, k);
        eq([p + 1, l.a + 1, l.b + 1], (x) => x[p + 1] - (x[l.a + 1] + x[l.b + 1]) / 2, k);
        return;
      }
      case "symmetric_line": {
        const p = pi(r0);
        const q = pi(r1);
        const l = line(r2);
        const vars = [p, p + 1, q, q + 1, l.a, l.a + 1, l.b, l.b + 1];
        // the midpoint lies on the line, and p→q crosses it at right angles
        eq(vars, (x) => {
          const mx = (x[p] + x[q]) / 2;
          const my = (x[p + 1] + x[q + 1]) / 2;
          return ((x[l.b] - x[l.a]) * (my - x[l.a + 1]) - (x[l.b + 1] - x[l.a + 1]) * (mx - x[l.a])) / len(x, l.a, l.b);
        }, k);
        eq(vars, (x) => ((x[q] - x[p]) * (x[l.b] - x[l.a]) + (x[q + 1] - x[p + 1]) * (x[l.b + 1] - x[l.a + 1])) / len(x, l.a, l.b), k);
        return;
      }
      case "symmetric_point": {
        const p = pi(r0);
        const q = pi(r1);
        const c = pi(r2);
        eq([p, q, c], (x) => (x[p] + x[q]) / 2 - x[c], k);
        eq([p + 1, q + 1, c + 1], (x) => (x[p + 1] + x[q + 1]) / 2 - x[c + 1], k);
        return;
      }
      case "distance": {
        const a = pi(r0);
        const b = pi(r1);
        eq([a, a + 1, b, b + 1], (x) => Math.hypot(x[b] - x[a], x[b + 1] - x[a + 1]) - v, k);
        return;
      }
      case "distance_pl": {
        const p = pi(r0);
        const l = line(r1);
        const s = sign0(sdist(S.x, p, l.a, l.b));
        eq([p, p + 1, l.a, l.a + 1, l.b, l.b + 1], (x) => sdist(x, p, l.a, l.b) - s * v, k);
        return;
      }
      case "distance_ll": {
        // distance from the second line's start to the first line (the lines are meant to be parallel)
        const l1 = line(r0);
        const l2 = line(r1);
        const s = sign0(sdist(S.x, l2.a, l1.a, l1.b));
        eq([l2.a, l2.a + 1, l1.a, l1.a + 1, l1.b, l1.b + 1], (x) => sdist(x, l2.a, l1.a, l1.b) - s * v, k);
        return;
      }
      case "hdistance":
      case "vdistance": {
        const a = pi(r0);
        const b = pi(r1);
        const o = con.kind === "hdistance" ? 0 : 1;
        eq([a + o, b + o], (x) => x[b + o] - x[a + o] - v, k);
        return;
      }
      case "length": {
        const l = line(r0);
        eq([l.a, l.a + 1, l.b, l.b + 1], (x) => len(x, l.a, l.b) - v, k);
        return;
      }
      case "radius": {
        const c = circ(r0);
        eq([c.c, c.c + 1, ...c.rVars], (x) => c.r(x) - v, k);
        return;
      }
      case "rotate": {
        // r1 is r0 turned by v degrees about r2
        const p = pi(r0);
        const q = pi(r1);
        const c = pi(r2);
        const co = Math.cos((v * Math.PI) / 180);
        const si = Math.sin((v * Math.PI) / 180);
        eq([p, p + 1, q, c, c + 1], (x) => x[q] - x[c] - (co * (x[p] - x[c]) - si * (x[p + 1] - x[c + 1])), k);
        eq([p, p + 1, q + 1, c, c + 1], (x) => x[q + 1] - x[c + 1] - (si * (x[p] - x[c]) + co * (x[p + 1] - x[c + 1])), k);
        return;
      }
      case "radius_offset": {
        // point r0 is v further from centre r1 than the circle or arc r2's radius
        const p = pi(r0);
        const c = pi(r1);
        const src = circ(r2);
        eq([p, p + 1, c, c + 1, src.c, src.c + 1, ...src.rVars], (x) => Math.hypot(x[p] - x[c], x[p + 1] - x[c + 1]) - src.r(x) - v, k);
        return;
      }
      case "radius_diff": {
        const c1 = circ(r0);
        const c2 = circ(r1);
        eq([c1.c, c1.c + 1, ...c1.rVars, c2.c, c2.c + 1, ...c2.rVars], (x) => c2.r(x) - c1.r(x) - v, k);
        return;
      }
      case "perp_foot": {
        // r1 - r0 runs square to line r2 (an offset line's loose end stays opposite the original's)
        const p = pi(r0);
        const q = pi(r1);
        const l = line(r2);
        eq([p, p + 1, q, q + 1, l.a, l.a + 1, l.b, l.b + 1], (x) => ((x[q] - x[p]) * (x[l.b] - x[l.a]) + (x[q + 1] - x[p + 1]) * (x[l.b + 1] - x[l.a + 1])) / len(x, l.a, l.b), k);
        return;
      }
      case "radial": {
        // r1 lies on the ray from centre r2 through r0
        const p = pi(r0);
        const q = pi(r1);
        const c = pi(r2);
        eq([p, p + 1, q, q + 1, c, c + 1], (x) => ((x[p] - x[c]) * (x[q + 1] - x[c + 1]) - (x[p + 1] - x[c + 1]) * (x[q] - x[c])) / len(x, c, p), k);
        return;
      }
      case "angle": {
        const l1 = line(r0);
        const l2 = line(r1);
        const target = (v * Math.PI) / 180;
        eq([l1.a, l1.a + 1, l1.b, l1.b + 1, l2.a, l2.a + 1, l2.b, l2.b + 1], (x) => {
          const dx1 = x[l1.b] - x[l1.a];
          const dy1 = x[l1.b + 1] - x[l1.a + 1];
          const dx2 = x[l2.b] - x[l2.a];
          const dy2 = x[l2.b + 1] - x[l2.a + 1];
          const phi = Math.atan2(dx1 * dy2 - dy1 * dx2, dx1 * dx2 + dy1 * dy2);
          let d = phi - target;
          while (d > Math.PI) d -= 2 * Math.PI;
          while (d < -Math.PI) d += 2 * Math.PI;
          return d * ((Math.hypot(dx1, dy1) + Math.hypot(dx2, dy2)) / 2);
        }, k);
        return;
      }
    }
  });
  return S;
}

// ---------------- groups ----------------

/** Unknowns tied together by equations, with those equations. Each group is solved and analysed on its own. */
interface Group {
  eqs: number[];
  vars: number[];
}

function groups(S: System): { groups: Group[]; fixedEqs: number[] } {
  const N = S.x.length;
  const up = new Int32Array(N);
  for (let i = 0; i < N; i++) up[i] = i;
  const find = (a: number) => {
    while (up[a] !== a) a = up[a] = up[up[a]];
    return a;
  };
  const join = (u: number, v: number) => {
    const a = find(u);
    const b = find(v);
    if (a !== b) up[a] = b;
  };
  // a point's x and y stay in one group, so its freedom can be read in one place
  S.def.points.forEach((p, i) => S.free[2 * i] && join(2 * i, 2 * i + 1));
  const first = S.eqs.map((e) => {
    let f = -1;
    for (const v of e.vars) {
      if (!S.free[v]) continue;
      if (f < 0) f = v;
      else join(f, v);
    }
    return f;
  });
  const byRoot = new Map<number, Group>();
  const group = (v: number) => {
    const r = find(v);
    let g = byRoot.get(r);
    if (!g) byRoot.set(r, (g = { eqs: [], vars: [] }));
    return g;
  };
  for (let v = 0; v < N; v++) if (S.free[v]) group(v).vars.push(v);
  const fixedEqs: number[] = [];
  first.forEach((f, i) => (f < 0 ? fixedEqs.push(i) : group(f).eqs.push(i)));
  return { groups: [...byRoot.values()], fixedEqs };
}

/** Sparse Jacobian rows (local column numbers) of a group's equations, by central differences. */
interface Rows {
  cols: Int32Array[];
  vals: Float64Array[];
}

function rowsOf(S: System, eqs: number[], local: Int32Array): Rows {
  const cols = eqs.map((i) => Int32Array.from(S.eqs[i].vars.filter((v) => local[v] >= 0).map((v) => local[v])));
  return { cols, vals: cols.map((c) => new Float64Array(c.length)) };
}

function differentiate(S: System, x: Float64Array, eqs: number[], vars: number[], J: Rows) {
  const h = 1e-6;
  for (let p = 0; p < eqs.length; p++) {
    const e = S.eqs[eqs[p]];
    const cs = J.cols[p];
    const out = J.vals[p];
    for (let k = 0; k < cs.length; k++) {
      const vi = vars[cs[k]];
      const save = x[vi];
      x[vi] = save + h;
      const fp = e.f(x);
      x[vi] = save - h;
      const fm = e.f(x);
      x[vi] = save;
      out[k] = (fp - fm) / (2 * h);
    }
  }
}

const maxAbs = (r: Float64Array) => {
  let m = 0;
  for (let i = 0; i < r.length; i++) m = Math.max(m, Math.abs(r[i]));
  return m;
};
const sumSq = (r: Float64Array) => {
  let s = 0;
  for (let i = 0; i < r.length; i++) s += r[i] * r[i];
  return s;
};

// ---------------- banded linear algebra ----------------

/**
 * Reverse Cuthill-McKee order of equations (neighbours share an unknown).
 * It keeps J Jᵀ inside a narrow band, so the factorisation below costs
 * about m·b² instead of m³ for chains of geometry.
 */
function bandOrder(cols: Int32Array[], n: number): Int32Array {
  const m = cols.length;
  const byCol: number[][] = Array.from({ length: n }, () => []);
  cols.forEach((cs, i) => cs.forEach((c) => byCol[c].push(i)));
  const deg = cols.map((cs) => {
    let d = 0;
    for (const c of cs) d += byCol[c].length - 1;
    return d;
  });
  const seen = new Uint8Array(m);
  const out: number[] = [];
  while (out.length < m) {
    let start = -1;
    for (let i = 0; i < m; i++) if (!seen[i] && (start < 0 || deg[i] < deg[start])) start = i;
    seen[start] = 1;
    out.push(start);
    for (let h = out.length - 1; h < out.length; h++) {
      const nb: number[] = [];
      for (const c of cols[out[h]]) for (const j of byCol[c]) if (!seen[j]) (seen[j] = 1), nb.push(j);
      nb.sort((a, b) => deg[a] - deg[b]);
      for (const j of nb) out.push(j);
    }
  }
  return Int32Array.from(out.reverse());
}

/** Skyline storage of a symmetric m×m matrix: row p keeps columns env[p]..p. */
interface Sky {
  m: number;
  env: Int32Array;
  /** start of row p in the store, minus env[p] (so entry (p, q) is at at[p] + q) */
  at: Int32Array;
  size: number;
}

function skyline(cols: Int32Array[], n: number): Sky {
  const m = cols.length;
  const first = new Int32Array(n).fill(m);
  cols.forEach((cs, p) => cs.forEach((c) => (first[c] = Math.min(first[c], p))));
  const env = new Int32Array(m);
  const at = new Int32Array(m);
  let size = 0;
  for (let p = 0; p < m; p++) {
    let e = p;
    for (const c of cols[p]) e = Math.min(e, first[c]);
    env[p] = e;
    at[p] = size - e;
    size += p - e + 1;
  }
  return { m, env, at, size };
}

/** Cholesky factor in place; false when the matrix is not positive definite. */
function cholSky(M: Float64Array, s: Sky): boolean {
  const { m, env, at } = s;
  for (let p = 0; p < m; p++) {
    const ep = env[p];
    const ap = at[p];
    for (let q = ep; q <= p; q++) {
      const aq = at[q];
      let v = M[ap + q];
      for (let k = Math.max(ep, env[q]); k < q; k++) v -= M[ap + k] * M[aq + k];
      if (q < p) M[ap + q] = v / M[aq + q];
      else if (v > 0) M[ap + p] = Math.sqrt(v);
      else return false;
    }
  }
  return true;
}

/** Solves L Lᵀ y = b in place with the factor from cholSky. */
function solveSky(M: Float64Array, s: Sky, b: Float64Array) {
  const { m, env, at } = s;
  for (let p = 0; p < m; p++) {
    let v = b[p];
    for (let k = env[p]; k < p; k++) v -= M[at[p] + k] * b[k];
    b[p] = v / M[at[p] + p];
  }
  for (let p = m - 1; p >= 0; p--) {
    const v = (b[p] /= M[at[p] + p]);
    for (let k = env[p]; k < p; k++) b[k] -= M[at[p] + k] * v;
  }
}

// ---------------- solve ----------------

/** snap solver noise: 24.9999999999 -> 25, -1e-13 -> 0 */
function clean(v: number): number {
  const r = Math.round(v * 1e6) / 1e6;
  return Math.abs(v - r) < 1e-9 ? r + 0 : v;
}

export function solveSketch(def: SketchDef, opts: SolveOptions = {}): SolveResult {
  const budget = opts.budget ?? budgetMs(SOLVE_MS);
  const heavy = opts.heavy ?? [];
  const pinIds = new Set(heavy.filter((id) => def.points.some((p) => p.id === id)));
  if (pinIds.size) {
    // dragging: put the dragged points exactly where the pointer is when the constraints allow it
    const pinned: SketchDef = { ...def, points: def.points.map((p) => (pinIds.has(p.id) ? { ...p, fixed: true } : p)) };
    const r = solveCore(pinned, { ...opts, budget, heavy: heavy.filter((id) => !pinIds.has(id)), analyse: false, maxIter: Math.min(opts.maxIter ?? 80, 20) });
    if (r.ok) {
      if (opts.analyse === false) {
        for (const p of def.points) r.freedom[p.id] = p.fixed ? { kind: "fixed" } : { kind: "free" };
        return r;
      }
      return solveCore({ ...def, points: def.points.map((p) => ({ ...p, x: r.points[p.id][0], y: r.points[p.id][1] })), circles: def.circles.map((c) => ({ ...c, r: r.radii[c.id] })) }, { ...opts, budget, heavy: [] });
    }
  }
  return solveCore(def, { ...opts, budget });
}

function solveCore(def: SketchDef, opts: SolveOptions & { budget: Budget }): SolveResult {
  const S = build(def, new Set(opts.heavy ?? []));
  const { groups: G, fixedEqs } = groups(S);
  const x = S.x;
  const result = (): SolveResult => {
    const points: Record<string, V2> = {};
    def.points.forEach((p, i) => (points[p.id] = [clean(x[2 * i]), clean(x[2 * i + 1])]));
    const radii: Record<string, number> = {};
    const base = def.points.length * 2;
    def.circles.forEach((c, i) => (radii[c.id] = clean(x[base + i])));
    const freedom: Record<string, PointFreedom> = {};
    for (const p of def.points) freedom[p.id] = p.fixed ? { kind: "fixed" } : { kind: "free" };
    return { ok: false, iterations: 0, residual: 0, points, radii, dof: G.reduce((s, g) => s + g.vars.length, 0), freedom, freeRadius: [], redundant: [], unsatisfied: [] };
  };

  const largest = G.reduce((a, g) => (g.vars.length > a.vars.length || (g.vars.length === a.vars.length && g.eqs.length > a.eqs.length) ? g : a), { vars: [], eqs: [] } as Group);
  if (largest.vars.length > MAX_UNKNOWNS || largest.eqs.length > 2 * MAX_UNKNOWNS) return { ...result(), tooBig: Math.max(largest.vars.length, Math.ceil(largest.eqs.length / 2)) };

  const local = new Int32Array(x.length).fill(-1);
  const maxIter = opts.maxIter ?? 80;
  let iterations = 0;
  for (const g of G) {
    if (!g.eqs.length) continue;
    g.vars.forEach((v, c) => (local[v] = c));
    iterations = Math.max(iterations, descend(S, x, g, local, maxIter, opts.budget));
    for (const v of g.vars) local[v] = -1;
  }

  const r = new Float64Array(S.eqs.length);
  for (let i = 0; i < r.length; i++) r[i] = S.eqs[i].f(x);
  const residual = maxAbs(r);
  const ok = residual <= Math.max(TOL * 10, 1e-8);
  const out = result();
  out.ok = ok;
  out.iterations = iterations;
  out.residual = residual;
  out.unsatisfied = ok ? [] : [...new Set(S.eqs.map((e, i) => (Math.abs(r[i]) > 1e-7 ? e.con : -1)).filter((c) => c >= 0))];
  if (over(opts.budget)) out.outOfTime = true;
  if (opts.analyse === false || out.outOfTime) return out;

  out.dof = 0;
  const redundant = new Set<number>();
  for (const i of fixedEqs) if (S.eqs[i].con >= 0) redundant.add(S.eqs[i].con);
  for (const g of G) {
    g.vars.forEach((v, c) => (local[v] = c));
    analyse(S, x, g, local, out, redundant, opts.budget);
    for (const v of g.vars) local[v] = -1;
  }
  out.redundant = [...redundant];
  if (over(opts.budget)) out.outOfTime = true;
  return out;
}

/**
 * Weighted minimum-norm Gauss-Newton steps, Levenberg-Marquardt damped,
 * for one group: dx = -W⁻¹Jᵀ (J W⁻¹ Jᵀ + μ)⁻¹ r. Stops when the residual is
 * clean, when progress stalls (the constraints cannot all hold), or when
 * the time budget runs out. Returns the number of iterations.
 */
function descend(S: System, x: Float64Array, g: Group, local: Int32Array, maxIter: number, budget: Budget): number {
  const vars = g.vars;
  const n = vars.length;
  const m = g.eqs.length;
  const r = new Float64Array(m);
  let eqs = g.eqs;
  const res = (out: Float64Array) => {
    for (let p = 0; p < m; p++) out[p] = S.eqs[eqs[p]].f(x);
  };
  res(r);
  if (maxAbs(r) <= TIGHT) return 0;

  // narrow band: reorder the equations once
  const order = bandOrder(rowsOf(S, eqs, local).cols, n);
  eqs = Array.from(order, (k) => eqs[k]);
  res(r);
  const J = rowsOf(S, eqs, local);
  const sky = skyline(J.cols, n);
  // entries of A = J W⁻¹ Jᵀ come from pairs of rows sharing a column
  const colRows: number[][] = Array.from({ length: n }, () => []);
  const colSlot: number[][] = Array.from({ length: n }, () => []);
  J.cols.forEach((cs, p) => cs.forEach((c, k) => (colRows[c].push(p), colSlot[c].push(k))));
  const w = Float64Array.from(vars, (v) => S.weight[v]);

  const A = new Float64Array(sky.size);
  const M = new Float64Array(sky.size);
  const y = new Float64Array(m);
  const dx = new Float64Array(n);
  const x0 = new Float64Array(n);
  const rTry = new Float64Array(m);
  let err = sumSq(r);
  let mu = 1e-9;
  let iterations = 0;
  let stalls = 0;
  while (iterations < maxIter && maxAbs(r) > TIGHT && !over(budget)) {
    iterations++;
    differentiate(S, x, eqs, vars, J);
    A.fill(0);
    for (let c = 0; c < n; c++) {
      const rs = colRows[c];
      const ks = colSlot[c];
      for (let a = 0; a < rs.length; a++) {
        const pa = rs[a];
        const va = J.vals[pa][ks[a]] / w[c];
        const base = sky.at[pa];
        for (let b = 0; b <= a; b++) A[base + rs[b]] += va * J.vals[rs[b]][ks[b]];
      }
    }
    let trace = 0;
    for (let p = 0; p < m; p++) trace += A[sky.at[p] + p];
    const scale = trace / m || 1;
    for (let c = 0; c < n; c++) x0[c] = x[vars[c]];
    let accepted = false;
    let e2 = err;
    for (let attempt = 0; attempt < 12 && !accepted && (attempt === 0 || !over(budget)); attempt++) {
      M.set(A);
      for (let p = 0; p < m; p++) M[sky.at[p] + p] += mu * scale;
      if (!cholSky(M, sky)) {
        mu *= 10;
        continue;
      }
      y.set(r);
      solveSky(M, sky, y);
      dx.fill(0);
      for (let p = 0; p < m; p++) {
        const cs = J.cols[p];
        const vs = J.vals[p];
        for (let k = 0; k < cs.length; k++) dx[cs[k]] -= vs[k] * y[p];
      }
      for (let c = 0; c < n; c++) dx[c] /= w[c];
      for (let alpha = 1; alpha > 1e-3; alpha /= 2) {
        for (let c = 0; c < n; c++) x[vars[c]] = x0[c] + alpha * dx[c];
        res(rTry);
        e2 = sumSq(rTry);
        if (e2 < err * (1 - 1e-4 * alpha) || e2 < TIGHT * TIGHT) {
          r.set(rTry);
          accepted = true;
          break;
        }
      }
      if (!accepted) {
        for (let c = 0; c < n; c++) x[vars[c]] = x0[c];
        mu *= 10;
      }
    }
    if (!accepted) break;
    // a least-squares minimum that is not zero: the constraints cannot all hold
    stalls = e2 > err * 0.99 ? stalls + 1 : 0;
    err = e2;
    if (stalls >= 5) break;
    mu = Math.max(mu / 10, 1e-12);
  }
  return iterations;
}

/**
 * Rank analysis of one group at the solution: Givens QR over the Jacobian
 * rows in constraint order. A row that adds nothing new is redundant. The
 * null space (the ways the geometry can still move) comes from the
 * triangular factor, and a point is defined when it has no part in it.
 */
function analyse(S: System, x: Float64Array, g: Group, local: Int32Array, out: SolveResult, redundant: Set<number>, budget: Budget) {
  const { eqs, vars } = g;
  const n = vars.length;
  const J = rowsOf(S, eqs, local);
  differentiate(S, x, eqs, vars, J);
  const R: (Float64Array | null)[] = new Array(n).fill(null);
  const hiR = new Int32Array(n);
  const v = new Float64Array(n);
  let rank = 0;
  let cut = false;
  for (let p = 0; p < eqs.length; p++) {
    if ((p & 31) === 31 && over(budget)) {
      cut = true;
      break;
    }
    const cs = J.cols[p];
    let lo = n;
    let hi = -1;
    let norm0 = 0;
    for (let k = 0; k < cs.length; k++) {
      v[cs[k]] = J.vals[p][k];
      lo = Math.min(lo, cs[k]);
      hi = Math.max(hi, cs[k]);
      norm0 += J.vals[p][k] ** 2;
    }
    norm0 = Math.sqrt(norm0);
    let independent = false;
    if (norm0 >= 1e-12) {
      const tiny = 1e-12 * norm0;
      for (let c = lo; c <= hi; c++) {
        const a = v[c];
        if (Math.abs(a) <= tiny) {
          v[c] = 0;
          continue;
        }
        const Rc = R[c];
        if (!Rc) {
          let rest = 0;
          for (let k = c; k <= hi; k++) rest += v[k] * v[k];
          if (Math.sqrt(rest) >= 1e-7 * norm0) {
            R[c] = v.slice();
            hiR[c] = hi;
            rank++;
            independent = true;
          }
          break;
        }
        const d = Rc[c];
        const rho = Math.hypot(d, a);
        const cs_ = d / rho;
        const sn = a / rho;
        const end = Math.max(hiR[c], hi);
        for (let k = c; k <= end; k++) {
          const ra = Rc[k];
          const vb = v[k];
          Rc[k] = cs_ * ra + sn * vb;
          v[k] = cs_ * vb - sn * ra;
        }
        v[c] = 0;
        hiR[c] = hi = end;
      }
    }
    if (lo <= hi) v.fill(0, lo, hi + 1);
    if (!independent && S.eqs[eqs[p]].con >= 0) redundant.add(S.eqs[eqs[p]].con);
  }
  out.dof += n - rank;

  // basis of the null space: one vector per column without a pivot, by back substitution
  const Q: { z: Float64Array; lo: number; hi: number }[] = [];
  if (rank < n && !cut && !over(budget)) {
    for (let f = 0; f < n; f++) {
      if (R[f]) continue;
      const z = new Float64Array(n);
      z[f] = 1;
      let lo = f;
      for (let c = f - 1; c >= 0; c--) {
        const Rc = R[c];
        if (!Rc || hiR[c] < lo) continue;
        let s = 0;
        for (let k = Math.max(c + 1, lo); k <= Math.min(hiR[c], f); k++) s += Rc[k] * z[k];
        if (s !== 0) {
          z[c] = -s / Rc[c];
          lo = c;
        }
      }
      // orthonormalise against the earlier null vectors (modified Gram-Schmidt)
      let zlo = lo;
      let zhi = f;
      for (let pass = 0; pass < 2; pass++)
        for (const q of Q) {
          if (q.hi < zlo || q.lo > zhi) continue;
          let d = 0;
          for (let k = Math.max(q.lo, zlo); k <= Math.min(q.hi, zhi); k++) d += q.z[k] * z[k];
          if (d === 0) continue;
          for (let k = q.lo; k <= q.hi; k++) z[k] -= d * q.z[k];
          zlo = Math.min(zlo, q.lo);
          zhi = Math.max(zhi, q.hi);
        }
      let norm = 0;
      for (let k = zlo; k <= zhi; k++) norm += z[k] * z[k];
      norm = Math.sqrt(norm);
      for (let k = zlo; k <= zhi; k++) z[k] /= norm;
      Q.push({ z, lo: zlo, hi: zhi });
      if (over(budget)) break;
    }
  }
  // projector onto the null space, restricted to the 2×2 block of each point
  const nullBlock = (a: number, b: number) => {
    let s = 0;
    for (const q of Q) if (a >= q.lo && a <= q.hi && b >= q.lo && b <= q.hi) s += q.z[a] * q.z[b];
    return s;
  };
  const complete = !cut && Q.length === n - rank;
  S.def.points.forEach((p, i) => {
    const cx = local[2 * i];
    if (cx < 0) return;
    if (!complete) {
      out.freedom[p.id] = { kind: "free" };
      return;
    }
    const cy = local[2 * i + 1];
    const a = nullBlock(cx, cx);
    const b = nullBlock(cx, cy);
    const d = nullBlock(cy, cy);
    const tr = a + d;
    const disc = Math.sqrt(Math.max(0, ((a - d) / 2) ** 2 + b * b));
    const l1 = tr / 2 + disc;
    const l2 = tr / 2 - disc;
    if (l1 < 1e-6) out.freedom[p.id] = { kind: "defined" };
    else if (l2 < 1e-6) {
      // eigenvector of the larger eigenvalue
      let vx = b;
      let vy = l1 - a;
      if (Math.hypot(vx, vy) < 1e-12) {
        vx = l1 - d;
        vy = b;
      }
      const L = Math.hypot(vx, vy) || 1;
      out.freedom[p.id] = { kind: "line", dir: [vx / L, vy / L] };
    } else out.freedom[p.id] = { kind: "free" };
  });
  S.def.circles.forEach((c) => {
    const ci = local[S.rIdx.get(c.id)!];
    if (ci >= 0 && (!complete || nullBlock(ci, ci) > 1e-6)) out.freeRadius.push(c.id);
  });
}

/**
 * When a sketch cannot be solved, find the first constraint (in order)
 * that makes it unsolvable: every constraint before it can hold together.
 * Null when there is none, or the budget runs out first.
 */
export function firstConflict(def: SketchDef, budget: Budget = budgetMs(SOLVE_MS)): number | null {
  const solves = (constraints: DefConstraint[]) => solveSketch({ ...def, constraints }, { analyse: false, budget }).ok;
  if (solves(def.constraints)) return null;
  let lo = 0; // constraints [0, lo) solve
  let hi = def.constraints.length; // constraints [0, hi) fail
  if (!solves([])) return null;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (solves(def.constraints.slice(0, mid))) lo = mid;
    else hi = mid;
    if (over(budget)) return null;
  }
  return hi - 1;
}
