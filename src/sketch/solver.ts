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
  | "angle";

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
}

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

// ---------------- linear algebra ----------------

/** Solve the symmetric positive-definite system A y = b in place (Cholesky). Returns false if it breaks down. */
function cholSolve(A: Float64Array, b: Float64Array, m: number): boolean {
  for (let j = 0; j < m; j++) {
    let d = A[j * m + j];
    for (let k = 0; k < j; k++) d -= A[j * m + k] * A[j * m + k];
    if (!(d > 0)) return false;
    d = Math.sqrt(d);
    A[j * m + j] = d;
    for (let i = j + 1; i < m; i++) {
      let s = A[i * m + j];
      for (let k = 0; k < j; k++) s -= A[i * m + k] * A[j * m + k];
      A[i * m + j] = s / d;
    }
  }
  for (let i = 0; i < m; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= A[i * m + k] * b[k];
    b[i] = s / A[i * m + i];
  }
  for (let i = m - 1; i >= 0; i--) {
    let s = b[i];
    for (let k = i + 1; k < m; k++) s -= A[k * m + i] * b[k];
    b[i] = s / A[i * m + i];
  }
  return true;
}

function residuals(S: System, x: Float64Array, out: Float64Array) {
  for (let i = 0; i < S.eqs.length; i++) out[i] = S.eqs[i].f(x);
}

/** Jacobian over the free unknowns, by central differences per equation. Rows are equations. */
function jacobian(S: System, x: Float64Array, cols: number[], colOf: Int32Array): Float64Array {
  const m = S.eqs.length;
  const n = cols.length;
  const J = new Float64Array(m * n);
  const h = 1e-6;
  for (let i = 0; i < m; i++) {
    const e = S.eqs[i];
    for (const vi of e.vars) {
      const c = colOf[vi];
      if (c < 0) continue;
      const save = x[vi];
      x[vi] = save + h;
      const fp = e.f(x);
      x[vi] = save - h;
      const fm = e.f(x);
      x[vi] = save;
      J[i * n + c] = (fp - fm) / (2 * h);
    }
  }
  return J;
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

// ---------------- solve ----------------

/** snap solver noise: 24.9999999999 -> 25, -1e-13 -> 0 */
function clean(v: number): number {
  const r = Math.round(v * 1e6) / 1e6;
  return Math.abs(v - r) < 1e-9 ? r + 0 : v;
}

export function solveSketch(def: SketchDef, opts: SolveOptions = {}): SolveResult {
  const heavy = opts.heavy ?? [];
  const pinIds = new Set(heavy.filter((id) => def.points.some((p) => p.id === id)));
  if (pinIds.size) {
    // dragging: put the dragged points exactly where the pointer is when the constraints allow it
    const pinned: SketchDef = { ...def, points: def.points.map((p) => (pinIds.has(p.id) ? { ...p, fixed: true } : p)) };
    const r = solveCore(pinned, { ...opts, heavy: heavy.filter((id) => !pinIds.has(id)), analyse: false });
    if (r.ok) {
      if (opts.analyse === false) {
        for (const p of def.points) r.freedom[p.id] = p.fixed ? { kind: "fixed" } : { kind: "free" };
        return r;
      }
      return solveCore({ ...def, points: def.points.map((p) => ({ ...p, x: r.points[p.id][0], y: r.points[p.id][1] })), circles: def.circles.map((c) => ({ ...c, r: r.radii[c.id] })) }, { ...opts, heavy: [] });
    }
  }
  return solveCore(def, opts);
}

function solveCore(def: SketchDef, opts: SolveOptions): SolveResult {
  const S = build(def, new Set(opts.heavy ?? []));
  const m = S.eqs.length;
  const cols: number[] = [];
  const colOf = new Int32Array(S.x.length).fill(-1);
  S.free.forEach((f, i) => {
    if (f) {
      colOf[i] = cols.length;
      cols.push(i);
    }
  });
  const n = cols.length;
  const x = S.x;
  const r = new Float64Array(m);
  residuals(S, x, r);
  let err = sumSq(r);
  let iterations = 0;
  let mu = 1e-9;
  const maxIter = opts.maxIter ?? 80;
  const xTry = new Float64Array(x.length);
  const rTry = new Float64Array(m);
  while (iterations < maxIter && maxAbs(r) > TIGHT && n > 0 && m > 0) {
    iterations++;
    const J = jacobian(S, x, cols, colOf);
    // A = J W⁻¹ Jᵀ
    const A = new Float64Array(m * m);
    let trace = 0;
    for (let i = 0; i < m; i++) {
      for (let j = 0; j <= i; j++) {
        let s = 0;
        for (let c = 0; c < n; c++) s += (J[i * n + c] * J[j * n + c]) / S.weight[cols[c]];
        A[i * m + j] = s;
        A[j * m + i] = s;
      }
      trace += A[i * m + i];
    }
    const scale = trace / m || 1;
    let accepted = false;
    for (let attempt = 0; attempt < 12 && !accepted; attempt++) {
      const M = A.slice();
      for (let i = 0; i < m; i++) M[i * m + i] += mu * scale;
      const y = r.slice();
      if (!cholSolve(M, y, m)) {
        mu *= 10;
        continue;
      }
      // dx = -W⁻¹ Jᵀ y
      const dx = new Float64Array(n);
      for (let c = 0; c < n; c++) {
        let s = 0;
        for (let i = 0; i < m; i++) s += J[i * n + c] * y[i];
        dx[c] = -s / S.weight[cols[c]];
      }
      for (let alpha = 1; alpha > 1e-3; alpha /= 2) {
        xTry.set(x);
        for (let c = 0; c < n; c++) xTry[cols[c]] += alpha * dx[c];
        residuals(S, xTry, rTry);
        const e2 = sumSq(rTry);
        if (e2 < err * (1 - 1e-4 * alpha) || e2 < TIGHT * TIGHT) {
          x.set(xTry);
          r.set(rTry);
          err = e2;
          accepted = true;
          break;
        }
      }
      if (!accepted) mu *= 10;
    }
    if (!accepted) break;
    mu = Math.max(mu / 10, 1e-12);
  }
  const ok = maxAbs(r) <= Math.max(TOL * 10, 1e-8);

  const points: Record<string, V2> = {};
  def.points.forEach((p, i) => (points[p.id] = [clean(x[2 * i]), clean(x[2 * i + 1])]));
  const radii: Record<string, number> = {};
  const base = def.points.length * 2;
  def.circles.forEach((c, i) => (radii[c.id] = clean(x[base + i])));

  const unsatisfied = ok ? [] : [...new Set(S.eqs.map((e, i) => (Math.abs(r[i]) > 1e-7 ? e.con : -1)).filter((c) => c >= 0))];
  const result: SolveResult = { ok, iterations, residual: maxAbs(r), points, radii, dof: n, freedom: {}, freeRadius: [], redundant: [], unsatisfied };
  for (const p of def.points) result.freedom[p.id] = p.fixed ? { kind: "fixed" } : { kind: "free" };
  if (opts.analyse === false) return result;
  analyse(S, x, cols, colOf, result);
  return result;
}

/**
 * Rank analysis at the solution: modified Gram-Schmidt over the Jacobian
 * rows in constraint order. A row that adds nothing new is redundant; an
 * unknown is determined when its unit vector lies in the row space.
 */
function analyse(S: System, x: Float64Array, cols: number[], colOf: Int32Array, out: SolveResult) {
  const m = S.eqs.length;
  const n = cols.length;
  if (!n) {
    out.dof = 0;
    out.redundant = [...new Set(S.eqs.map((e) => e.con).filter((c) => c >= 0))];
    for (const p of S.def.points) out.freedom[p.id] = { kind: "fixed" };
    return;
  }
  const J = jacobian(S, x, cols, colOf);
  const Q: Float64Array[] = [];
  const redundantRows: number[] = [];
  for (let i = 0; i < m; i++) {
    const row = J.slice(i * n, i * n + n);
    const norm0 = Math.sqrt(sumSq(row));
    if (norm0 < 1e-12) {
      redundantRows.push(i);
      continue;
    }
    for (let pass = 0; pass < 2; pass++)
      for (const q of Q) {
        let d = 0;
        for (let c = 0; c < n; c++) d += row[c] * q[c];
        for (let c = 0; c < n; c++) row[c] -= d * q[c];
      }
    const norm = Math.sqrt(sumSq(row));
    if (norm < 1e-7 * norm0) {
      redundantRows.push(i);
      continue;
    }
    for (let c = 0; c < n; c++) row[c] /= norm;
    Q.push(row);
  }
  out.dof = n - Q.length;
  const redundant = new Set<number>();
  for (const i of redundantRows) if (S.eqs[i].con >= 0) redundant.add(S.eqs[i].con);
  out.redundant = [...redundant];
  // projector onto the null space, restricted to the 2×2 block of each point
  const nullBlock = (a: number, b: number) => {
    let s = a === b ? 1 : 0;
    for (const q of Q) s -= q[a] * q[b];
    return s;
  };
  S.def.points.forEach((p, i) => {
    if (p.fixed) {
      out.freedom[p.id] = { kind: "fixed" };
      return;
    }
    const cx = colOf[2 * i];
    const cy = colOf[2 * i + 1];
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
    const ci = colOf[S.rIdx.get(c.id)!];
    if (ci >= 0 && nullBlock(ci, ci) > 1e-6) out.freeRadius.push(c.id);
  });
}

/**
 * When a sketch cannot be solved, find the first constraint (in order)
 * that makes it unsolvable: every constraint before it can hold together.
 */
export function firstConflict(def: SketchDef): number | null {
  const full = solveSketch(def, { analyse: false });
  if (full.ok) return null;
  let lo = 0; // constraints [0, lo) solve
  let hi = def.constraints.length; // constraints [0, hi) fail
  if (!solveSketch({ ...def, constraints: [] }, { analyse: false }).ok) return null;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (solveSketch({ ...def, constraints: def.constraints.slice(0, mid) }, { analyse: false }).ok) lo = mid;
    else hi = mid;
  }
  return hi - 1;
}
