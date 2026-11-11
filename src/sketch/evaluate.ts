// Evaluates a `sketch` block: resolves its geometry and constraints, solves
// them, finds closed profiles, and produces both the language value (world
// points and curves, the profile for extrude/revolve) and the editor's view
// of the sketch (solved positions, statuses, spans to edit).

import type { Expr, SketchItem, Span, Stmt } from "../lang/ast";
import { Obj, SketchLineObj, SketchObj, Vec, fmtNum, typeName, type Value } from "../lang/values";
import { suggest } from "../lang/suggest";
import type { V2, V3 } from "../kernel/recipe";
import { stableStringify, vscale, vadd } from "../kernel/recipe";
import { buildProfile, sampleSeg, type CornerSpec } from "./regions";
import { MAX_UNKNOWNS, SOLVE_MS, budgetMs, firstConflict, solveSketch, type Budget, type ConsKind, type DefConstraint, type SketchDef, type SolveResult } from "./solver";
import { PLANES, frameOf, isPlane, planeValue, toLocal, toWorld } from "./planes";
import type { EvalSketch, Frame, SkConstraint, SkCurve, SkPoint, SkStatus } from "./types";

export interface SketchHost {
  src: string;
  expr(e: Expr, scope: unknown): Value;
  newScope(): unknown;
  setVar(scope: unknown, name: string, v: Value): void;
  /** throws: stops the sketch statement */
  fail(msg: string, span: Span): never;
  diag(msg: string, span: Span, severity: "error" | "warning"): void;
  /** report an error thrown by fail() as a diagnostic; false when it is something else */
  report(e: unknown): boolean;
  /** solver time allowance shared by every sketch in one evaluation */
  budget?: Budget;
}

/** Names every sketch has: the fixed origin and the two axes through it. */
export const SKETCH_RESERVED = ["origin", "x_axis", "y_axis"];
const FIELD_RESERVED = new Set([...SKETCH_RESERVED, "area", "plane", "normal", "name", "kind"]);
const PROPS = ["plane", "offset", "origin"];

/** Constraint statements: what they take and whether they carry a value. */
export const CONSTRAINTS: Record<string, { dim: boolean; doc: string }> = {
  fix: { dim: false, doc: "fix p, … — keep points exactly where they are written" },
  coincident: { dim: false, doc: "coincident a, b — two points together, or a point on a line, circle or arc" },
  horizontal: { dim: false, doc: "horizontal l, … — lines along the sketch x axis (or two points level)" },
  vertical: { dim: false, doc: "vertical l, … — lines along the sketch y axis (or two points above each other)" },
  parallel: { dim: false, doc: "parallel l1, l2, …" },
  perpendicular: { dim: false, doc: "perpendicular l1, l2" },
  collinear: { dim: false, doc: "collinear l1, l2 — on the same infinite line" },
  equal: { dim: false, doc: "equal a, b, … — equal length (lines) or equal radius (circles, arcs)" },
  tangent: { dim: false, doc: "tangent a, b — line and arc/circle, or two arcs/circles" },
  midpoint: { dim: false, doc: "midpoint p, l — p at the middle of l" },
  symmetric: { dim: false, doc: "symmetric p, q, about — mirror images across a line (or about a point)" },
  concentric: { dim: false, doc: "concentric c1, c2 — circles or arcs sharing a centre" },
  distance: { dim: true, doc: "distance a, b = d — point to point, point to line, or between parallel lines" },
  hdistance: { dim: true, doc: "hdistance a, b = d — b.x − a.x along the sketch x axis (or one line's width)" },
  vdistance: { dim: true, doc: "vdistance a, b = d — b.y − a.y along the sketch y axis (or one line's height)" },
  length: { dim: true, doc: "length l = d" },
  radius: { dim: true, doc: "radius c = r — circle or arc" },
  diameter: { dim: true, doc: "diameter c = d — circle or arc" },
  angle: { dim: true, doc: "angle l1, l2 = θ — counter-clockwise from l1 to l2, in degrees" },
  fillet: { dim: true, doc: "fillet l1, l2 = r — rounds the profile corner where two lines meet (or fillet p, l3.end, … = r at corner points). Dimensions still measure to the sharp corner." },
  chamfer: { dim: true, doc: "chamfer l1, l2 = d — cuts the corner where two lines meet, d back along each line (or chamfer p, … = d)" },
  mirror: { dim: false, doc: "mirror a, b, …, about: l — copies of the geometry mirrored across line l, named a_m, b_m, … (their points a_m.start, …), kept mirrored as the original changes" },
  pattern: {
    dim: false,
    doc: "pattern a, …, count: n, step: (dx, dy) — n in a row counting the original, the copies named a_2, a_3, … (add count2: m, step2: (dx, dy) for a grid, numbered along step first); or pattern a, …, count: n, around: p, angle: 360 — n round point p (or a circle's centre), spread evenly over angle. The copies follow the original",
  },
  offset: { dim: false, doc: "offset a, b, …, by: d — a copy of one chain of lines and arcs (or of one circle) d away from it, named a_o, b_o, …: outward from a closed loop when d > 0 (inward when negative); for an open chain, to the left walking from the first curve's start. It stays d away as the original changes" },
};

/** Statements that make copies of geometry, and the options each takes. */
export const COPY_STATEMENTS: Record<string, string[]> = { mirror: ["about"], pattern: ["count", "step", "count2", "step2", "around", "angle"], offset: ["by"] };
/** Most copies one pattern makes. */
export const MAX_PATTERN = 200;
const ALIASES: Record<string, string> = { on: "coincident", dist: "distance", dx: "hdistance", dy: "vdistance", colinear: "collinear", perpendicular_to: "perpendicular" };

type Ent =
  | { kind: "point"; id: string }
  | { kind: "line"; id: string; a: string; b: string }
  | { kind: "circle"; id: string; c: string }
  | { kind: "arc"; id: string; c: string; a: string; b: string }
  | { kind: "spline"; id: string; pts: string[]; closed: boolean }
  | { kind: "ellipse"; id: string; c: string };

const solveCache = new Map<string, { res: SolveResult; culprit: number | null }>();
/**
 * Solves (and, when it fails, finds the first conflicting constraint) once
 * per distinct sketch. Each sketch has SOLVE_MS, within what is left of the
 * evaluation's shared allowance; a sketch cut short only because earlier
 * sketches used that up is tried again next time.
 */
function cachedSolve(def: SketchDef, shared: Budget | undefined): { res: SolveResult; culprit: number | null } {
  const key = stableStringify(def);
  const cached = solveCache.get(key);
  if (cached) {
    solveCache.delete(key);
    solveCache.set(key, cached);
    return cached;
  }
  const own = budgetMs(SOLVE_MS);
  const starved = !!shared && shared.until < own.until;
  const budget = starved ? shared! : own;
  const res = solveSketch(def, { budget });
  const hit = { res, culprit: res.ok || res.tooBig || res.outOfTime ? null : firstConflict(def, budget) };
  if (!(starved && performance.now() > budget.until)) {
    solveCache.set(key, hit);
    if (solveCache.size > 300) solveCache.delete(solveCache.keys().next().value!);
  }
  return hit;
}

/** True when an expression is plain numbers, so the editor may rewrite it. */
function isLiteral(e: Expr): boolean {
  if (e.k === "num") return true;
  if (e.k === "unary" && e.op === "-") return isLiteral(e.arg);
  if (e.k === "vec") return e.items.every(isLiteral);
  return false;
}

/** Path of a reference like p1 or l1.end; null for anything else. */
function refPath(e: Expr): string | null {
  if (e.k === "ident") return e.name;
  if (e.k === "member") {
    const base = refPath(e.obj);
    return base ? `${base}.${e.name}` : null;
  }
  return null;
}

export function evaluateSketch(host: SketchHost, s: Extract<Stmt, { k: "sketch" }>): { value: SketchObj; sketch: EvalSketch } {
  const scope = host.newScope();
  const src = host.src;
  let frame: Frame = { ...PLANES.XY };
  let planeText = "XY";
  let offset = 0;
  let originOverride: V3 | null = null;
  let locked = false;

  const points: SkPoint[] = [];
  const pointIdx = new Map<string, number>();
  /** names of shared points: when l2 starts at l1.end, "l2.start" means "l1.end" */
  const alias = new Map<string, string>();
  const ents = new Map<string, Ent>();
  const curves: SkCurve[] = [];
  const defCons: DefConstraint[] = [];
  const cons: SkConstraint[] = [];
  const fixedIds = new Set<string>(["origin", "x_axis.end", "y_axis.end"]);
  const radii = new Map<string, number>();
  let entityEnd = src.indexOf("{", s.nameSpan.end) + 1;

  // built-in reference geometry
  const addPoint = (p: Omit<SkPoint, "status" | "freedom" | "fixed">) => {
    pointIdx.set(p.id, points.length);
    points.push({ ...p, fixed: false, status: "free", freedom: { kind: "free" } });
  };
  addPoint({ id: "origin", x: 0, y: 0, implicit: true, literal: false });
  addPoint({ id: "x_axis.end", x: 1, y: 0, implicit: true, owner: "x_axis", literal: false });
  addPoint({ id: "y_axis.end", x: 0, y: 1, implicit: true, owner: "y_axis", literal: false });
  ents.set("origin", { kind: "point", id: "origin" });
  ents.set("x_axis", { kind: "line", id: "x_axis", a: "origin", b: "x_axis.end" });
  ents.set("y_axis", { kind: "line", id: "y_axis", a: "origin", b: "y_axis.end" });

  const num = (e: Expr, what: string): number => {
    const v = host.expr(e, scope);
    if (typeof v === "number" && Number.isFinite(v)) return v;
    return host.fail(`${what} should be a number, got ${typeName(v)}`, e.span);
  };
  const vec2 = (e: Expr, what: string): V2 => {
    const v = host.expr(e, scope);
    if (v instanceof Vec) {
      if (v.v.length === 3 && Math.abs(v.v[2]) > 1e-9) host.fail(`${what}: sketch points are 2D (x, y) in the sketch plane`, e.span);
      if (!v.v.every(Number.isFinite)) host.fail(`${what}: coordinates must be finite numbers`, e.span);
      return [v.v[0] ?? 0, v.v[1] ?? 0];
    }
    return host.fail(`${what} should be a point like (10, 5) or the name of a sketch point, got ${typeName(v)}`, e.span);
  };

  /** This sketch's plane as placed so far (props come first in a sketch). */
  const placed = (): Frame => ({ ...frame, o: vadd(originOverride ?? frame.o, vscale(frame.n, offset)) });
  /**
   * Geometry of an earlier sketch, named like side.l3.end or side.l3: projected
   * onto this plane as fixed reference geometry, so this sketch follows it.
   */
  const external = (e: Expr, path: string): Ent | null => {
    const root = path.split(".")[0];
    if (!path.includes(".") || ents.has(root) || pointIdx.has(root) || root === s.name) return null;
    let v: Value;
    try {
      v = host.expr(e, scope);
    } catch {
      return null;
    }
    const f = placed();
    const proj = (w: Vec): V2 => toLocal(f, [w.v[0] ?? 0, w.v[1] ?? 0, w.v[2] ?? 0]);
    const extPoint = (id: string, w: Vec) => {
      if (!pointIdx.has(id)) {
        const [x, y] = proj(w);
        addPoint({ id, x, y, implicit: true, literal: false, external: true });
        fixedIds.add(id);
      }
      return id;
    };
    if (v instanceof Vec) return v.v.every(Number.isFinite) ? { kind: "point", id: extPoint(path, v) } : null;
    if (v instanceof Obj && v.fields.start instanceof Vec && v.fields.end instanceof Vec && v.kind === "sketch line") {
      if (!ents.has(path)) {
        const a = extPoint(`${path}.start`, v.fields.start);
        const b = extPoint(`${path}.end`, v.fields.end);
        ents.set(path, { kind: "line", id: path, a, b });
        curves.push({ id: path, kind: "line", construction: true, external: true, pts: [a, b], status: "fixed", span: e.span, argSpans: [] });
      }
      return ents.get(path)!;
    }
    if (v instanceof Obj && (v.kind === "sketch circle" || v.kind === "sketch arc")) host.fail(`To use ${path} here, refer to one of its points: ${path}.center${v.kind === "sketch arc" ? `, ${path}.start or ${path}.end` : ""}`, e.span);
    return null;
  };

  /** A point argument: the name of a sketch point, or coordinates that make a new point owned by the curve. */
  const pointArg = (e: Expr, owner: string, role: string): string => {
    const path = refPath(e);
    if (path) {
      const ent = ents.get(path) ?? external(e, path) ?? undefined;
      const id = ent?.kind === "point" ? ent.id : pointIdx.has(path) ? path : alias.get(path);
      if (id) {
        // l2.start names the shared point too
        alias.set(`${owner}.${role}`, id);
        return id;
      }
      if (ent) host.fail(`${path} is a ${ent.kind}; ${owner}'s ${role} needs a point`, e.span);
    }
    const [x, y] = vec2(e, `${owner}'s ${role}`);
    const id = `${owner}.${role}`;
    addPoint({ id, x, y, implicit: true, owner, coordSpan: e.span, literal: isLiteral(e), written: [x, y] });
    return id;
  };

  /** A spline's or ellipse's named options, each allowed once. */
  const entityOpts = (it: Extract<SketchItem, { k: "entity" }>, allowed: string[]) => {
    const out: Record<string, NonNullable<typeof it.opts>[number]> = {};
    for (const o of it.opts ?? []) {
      if (!allowed.includes(o.name)) {
        const sg = suggest(o.name, allowed);
        host.fail(`${it.kind} has no option "${o.name}:"${sg ? `; did you mean "${sg}:"` : `; it takes ${allowed.map((a) => a + ":").join(", ")}`}`, o.nameSpan);
      }
      if (out[o.name]) host.fail(`${o.name}: is given twice`, o.nameSpan);
      out[o.name] = o;
    }
    return out;
  };

  const declare = (name: string, span: Span) => {
    if (FIELD_RESERVED.has(name)) host.fail(`"${name}" is a built-in sketch name; choose another`, span);
    if (ents.has(name) || pointIdx.has(name)) host.fail(`"${name}" is already defined in this sketch`, span);
  };

  /** The geometry a name refers to: this sketch's, or another sketch's projected here. */
  const entOf = (e: Expr): Ent => {
    const path = refPath(e);
    if (!path) host.fail(`Expected the name of sketch geometry (a point, line, circle or arc) but found an expression`, e.span);
    const ent = ents.get(path!);
    if (ent) return ent;
    if (pointIdx.has(path!)) return { kind: "point", id: path! };
    if (alias.has(path!)) return { kind: "point", id: alias.get(path!)! };
    const ext = external(e, path!);
    if (ext) return ext;
    // members of curves: l1.start, c1.center
    const all = [...ents.keys(), ...pointIdx.keys(), ...alias.keys()];
    const sg = suggest(path!, all);
    return host.fail(`"${path}" is not geometry in sketch ${s.name}${sg ? `. Did you mean "${sg}"?` : ". Geometry must be declared before constraints use it."}`, e.span);
  };
  const isCirc = (e: Ent): e is Extract<Ent, { kind: "circle" | "arc" }> => e.kind === "circle" || e.kind === "arc";
  const centerOf = (e: Extract<Ent, { kind: "circle" | "arc" }>) => e.c;

  const constraintItems: Extract<SketchItem, { k: "constraint" }>[] = [];
  /** copies whose arcs keep their radius through the copy's own constraints */
  const rigidArcs = new Set<string>();
  /** fillets and chamfers: applied to the profile after solving, so dimensions keep measuring to sharp corners */
  const cornerReqs: { src: number; kind: "fillet" | "chamfer"; r: number; pts?: string[]; lines?: [Extract<Ent, { kind: "line" }>, Extract<Ent, { kind: "line" }>] }[] = [];

  for (const it of s.items) {
    // a mistake in one statement is reported and skipped; the rest of the sketch still solves
    try {
      sketchItem(it);
    } catch (e) {
      if (!host.report(e)) throw e;
    }
  }

  function sketchItem(it: SketchItem) {
    switch (it.k) {
      case "prop": {
        if (!PROPS.includes(it.name)) {
          const sg = suggest(it.name, PROPS);
          host.fail(`Unknown sketch property "${it.name}"${sg ? `. Did you mean "${sg}"?` : `. Use: ${PROPS.join(", ")}`}`, it.span);
        }
        const v = host.expr(it.value, scope);
        if (it.name === "plane") {
          if (!isPlane(v)) host.fail(`plane: should be XY, XZ, YZ, -XY… or plane(origin:, normal:), got ${typeName(v)}`, it.value.span);
          frame = frameOf(v as Obj);
          planeText = src.slice(it.value.span.start, it.value.span.end);
        } else if (it.name === "offset") {
          if (typeof v !== "number" || !Number.isFinite(v)) host.fail(`offset: should be a distance along the plane's normal, got ${typeof v === "number" ? v : typeName(v)}`, it.value.span);
          offset = v as number;
        } else {
          if (!(v instanceof Vec) || !v.v.every(Number.isFinite)) host.fail(`origin: should be a 3D point with finite coordinates, got ${typeName(v)}`, it.value.span);
          const o = (v as Vec).v;
          originOverride = [o[0] ?? 0, o[1] ?? 0, o[2] ?? 0];
        }
        entityEnd = Math.max(entityEnd, it.span.end);
        break;
      }
      case "flag":
        locked = true;
        entityEnd = Math.max(entityEnd, it.span.end);
        break;
      case "let":
        if (FIELD_RESERVED.has(it.name)) host.fail(`"${it.name}" is a built-in sketch name; choose another`, it.span);
        host.setVar(scope, it.name, host.expr(it.value, scope));
        entityEnd = Math.max(entityEnd, it.span.end);
        break;
      case "entity": {
        declare(it.name, it.nameSpan);
        entityEnd = Math.max(entityEnd, it.span.end);
        const argSpans = it.args.map((a) => a.span);
        if (it.kind === "point") {
          const [x, y] = vec2(it.args[0], `point ${it.name}`);
          addPoint({ id: it.name, x, y, implicit: false, coordSpan: it.args[0].span, literal: isLiteral(it.args[0]), span: it.span, written: [x, y] });
          ents.set(it.name, { kind: "point", id: it.name });
          if (it.construction) host.diag(`Points are always reference geometry; "construction" has no effect here`, it.span, "warning");
          break;
        }
        if (it.kind === "line") {
          const a = pointArg(it.args[0], it.name, "start");
          const b = pointArg(it.args[1], it.name, "end");
          if (a === b) host.fail(`line ${it.name} starts and ends at the same point`, it.span);
          ents.set(it.name, { kind: "line", id: it.name, a, b });
          curves.push({ id: it.name, kind: "line", construction: it.construction, pts: [a, b], status: "free", span: it.span, argSpans });
          break;
        }
        if (it.kind === "circle") {
          const c = pointArg(it.args[0], it.name, "center");
          const size = num(it.size!.value, `circle ${it.name}'s ${it.size!.which === "r" ? "radius" : "diameter"}`);
          const r = it.size!.which === "r" ? size : size / 2;
          if (!(r > 0)) host.fail(`circle ${it.name} needs a size greater than 0`, it.size!.value.span);
          radii.set(it.name, r);
          ents.set(it.name, { kind: "circle", id: it.name, c });
          curves.push({ id: it.name, kind: "circle", construction: it.construction, pts: [c], r, status: "free", span: it.span, argSpans, sizeSpan: it.size!.value.span, sizeWhich: it.size!.which, sizeLiteral: isLiteral(it.size!.value), writtenR: r });
          break;
        }
        if (it.kind === "spline") {
          const o = entityOpts(it, ["closed"]);
          const cv = o.closed ? host.expr(o.closed.value, scope) : false;
          if (typeof cv !== "boolean") host.fail(`closed: should be true or false, got ${typeName(cv)}`, o.closed!.value.span);
          const closed = cv as boolean;
          if (it.args.length < 3) host.fail(`spline ${it.name} needs at least 3 points to pass through${it.args.length === 2 ? "; for 2, use a line" : ""}`, it.span);
          const pts = it.args.map((e, i) => pointArg(e, it.name, `p${i + 1}`));
          pts.forEach((id, i) => i && id === pts[i - 1] && host.fail(`spline ${it.name} passes through ${id} twice in a row`, it.args[i].span));
          if (closed && pts[0] === pts[pts.length - 1]) host.fail(`closed spline ${it.name} runs back to its first point by itself; leave the last point off`, it.args[it.args.length - 1].span);
          if (!closed) {
            alias.set(`${it.name}.start`, pts[0]);
            alias.set(`${it.name}.end`, pts[pts.length - 1]);
          }
          ents.set(it.name, { kind: "spline", id: it.name, pts, closed });
          curves.push({ id: it.name, kind: "spline", construction: it.construction, pts, closed, status: "free", span: it.span, argSpans, optSpans: o.closed ? { closed: o.closed.value.span } : {} });
          break;
        }
        if (it.kind === "ellipse") {
          const o = entityOpts(it, ["rx", "ry", "angle"]);
          const size = (k: "rx" | "ry") => {
            const opt = o[k] ?? host.fail(`ellipse ${it.name} needs ${k}: its radius along its ${k === "rx" ? "first" : "second"} axis, like ellipse ${it.name} = (0, 0), rx: 20, ry: 10`, it.span);
            const v = num(opt.value, `ellipse ${it.name}'s ${k}`);
            if (!(v > 0)) host.fail(`ellipse ${it.name}'s ${k} must be greater than 0`, opt.value.span);
            return v;
          };
          const rx = size("rx");
          const ry = size("ry");
          const angle = o.angle ? num(o.angle.value, `ellipse ${it.name}'s angle`) : 0;
          const c = pointArg(it.args[0], it.name, "center");
          ents.set(it.name, { kind: "ellipse", id: it.name, c });
          curves.push({
            id: it.name,
            kind: "ellipse",
            construction: it.construction,
            pts: [c],
            rx,
            ry,
            angle,
            status: "free",
            span: it.span,
            argSpans,
            optSpans: { rx: o.rx!.value.span, ry: o.ry!.value.span, ...(o.angle ? { angle: o.angle.value.span } : {}) },
            optLiteral: { rx: isLiteral(o.rx!.value), ry: isLiteral(o.ry!.value), angle: o.angle ? isLiteral(o.angle.value) : true },
          });
          break;
        }
        const a = pointArg(it.args[0], it.name, "start");
        const b = pointArg(it.args[1], it.name, "end");
        const c = pointArg(it.args[2], it.name, "center");
        if (a === b) host.fail(`arc ${it.name} starts and ends at the same point; use a circle for a full round`, it.span);
        ents.set(it.name, { kind: "arc", id: it.name, c, a, b });
        curves.push({ id: it.name, kind: "arc", construction: it.construction, pts: [a, b, c], status: "free", span: it.span, argSpans });
        break;
      }
      case "constraint":
        // copies are made in order with the geometry, so later lines can start on a copy's points
        if (COPY_STATEMENTS[it.name]) {
          makeCopies(it);
          entityEnd = Math.max(entityEnd, it.span.end);
        } else constraintItems.push(it);
        break;
    }
  }

  /**
   * mirror, pattern and offset: plan every copy first (so a mistake leaves
   * nothing half made), then add the points, curves and the constraints that
   * keep each copy tied to its original.
   */
  function makeCopies(it: Extract<SketchItem, { k: "constraint" }>) {
    const kind = it.name;
    const index = cons.length;
    const spec = CONSTRAINTS[kind];
    const bad = (msg: string, span: Span = it.span): never => host.fail(`${kind}: ${msg}. ${spec.doc}`, span);
    if (it.value) bad('takes its settings as named options, not "= …"', it.value.span);
    if (!it.refs.length) bad("needs the geometry to copy");
    const allowed = COPY_STATEMENTS[kind];
    type Opt = NonNullable<typeof it.opts>[number];
    const opt = new Map<string, Opt>();
    for (const o of it.opts ?? []) {
      if (!allowed.includes(o.name)) {
        const sg = suggest(o.name, allowed);
        bad(`has no option "${o.name}:"${sg ? `; did you mean "${sg}:"` : `; it takes ${allowed.map((a) => a + ":").join(", ")}`}`, o.nameSpan);
      }
      if (opt.has(o.name)) bad(`${o.name}: is given twice`, o.nameSpan);
      opt.set(o.name, o);
    }
    const E = it.refs.map(entOf);
    E.forEach((e, i) => E.findIndex((q) => q.id === e.id) < i && bad(`${e.id} is listed twice`, it.refs[i].span));
    // the end or centre of a curve comes with that curve; copying it alone would need a name of its own
    E.forEach((e, i) => {
      if (e.kind !== "point") return;
      if (e.id === "origin") bad("the origin stays where it is; put a point there to copy it", it.refs[i].span);
      if (e.id.includes(".")) bad(`${src.slice(it.refs[i].span.start, it.refs[i].span.end)} belongs to a curve; list the whole curve, or a named point`, it.refs[i].span);
    });
    const xy = (id: string): V2 => {
      const p = points[pointIdx.get(id)!];
      return [p.x, p.y];
    };
    const construction = (id: string) => curves.find((c) => c.id === id)?.construction ?? false;

    const plan: Plan = { points: [], curves: [], aliases: [], cons: [] };
    const optIds: Record<string, string[]> = {};
    const planned = new Set<string>();
    const free = (n: string) => !FIELD_RESERVED.has(n) && !ents.has(n) && !pointIdx.has(n) && !alias.has(n) && !planned.has(n);
    /** a_m, then a_m2, a_m3 … when that name is taken */
    const unique = (base: string) => {
      let n = base;
      for (let i = 2; !free(n); i++) n = `${base}${i}`;
      planned.add(n);
      return n;
    };
    const exact = (n: string) => {
      if (!free(n)) bad(`the copy ${n} would take a name already used in sketch ${s.name}; rename that geometry`);
      planned.add(n);
      return n;
    };
    const tie = (k: ConsKind, refs: string[], v?: number) => plan.cons.push({ k, refs, v });
    const ROLES = { line: ["start", "end"], circle: ["center"], arc: ["start", "end", "center"], ellipse: ["center"] } as const;
    const role = (kind: Exclude<Ent["kind"], "point">, k: number) => (kind === "spline" ? `p${k + 1}` : ROLES[kind][k]);
    const curveOf = (id: string) => curves.find((c) => c.id === id);

    /**
     * One copy of everything listed: `name` names each copy, `at` places a copied point, `hold` ties it to the
     * original, `turn` turns an ellipse's axes (degrees). Mirroring flips arcs.
     */
    const copyOnce = (name: (id: string) => string, at: (p: V2) => V2, hold: (from: string, to: string) => void, flip: boolean, turn: (deg: number) => number = (d) => d) => {
      const map = new Map<string, string>();
      for (const e of E) {
        if (e.kind !== "point") continue;
        const id = name(e.id);
        plan.points.push({ id, xy: at(xy(e.id)), named: true });
        map.set(e.id, id);
        hold(e.id, id);
      }
      for (const e of E) {
        if (e.kind === "point") continue;
        const cid = name(e.id);
        const src = e.kind === "line" ? [e.a, e.b] : e.kind === "circle" || e.kind === "ellipse" ? [e.c] : e.kind === "spline" ? e.pts : flip ? [e.b, e.a, e.c] : [e.a, e.b, e.c];
        const pts = src.map((pid, k) => {
          const r = role(e.kind, k);
          const hit = map.get(pid);
          if (hit) {
            plan.aliases.push([`${cid}.${r}`, hit]);
            return hit;
          }
          const id = `${cid}.${r}`;
          plan.points.push({ id, xy: at(xy(pid)), owner: cid });
          map.set(pid, id);
          hold(pid, id);
          return id;
        });
        const orig = curveOf(e.id);
        if (e.kind === "spline" && !e.closed) plan.aliases.push([`${cid}.start`, pts[0]], [`${cid}.end`, pts[pts.length - 1]]);
        plan.curves.push({
          id: cid,
          kind: e.kind,
          pts,
          construction: construction(e.id),
          r: e.kind === "circle" ? radii.get(e.id) : undefined,
          rigid: e.kind === "arc",
          from: e.id,
          closed: e.kind === "spline" ? e.closed : undefined,
          ...(e.kind === "ellipse" && orig ? { rx: orig.rx, ry: orig.ry, angle: turn(orig.angle ?? 0) } : {}),
        });
        if (e.kind === "circle") tie("equal_radius", [e.id, cid]);
      }
    };
    const numOpt = (o: Opt, what: string) => num(o.value, `${kind} ${what}`);
    const countOpt = (o: Opt, min: number) => {
      const n = numOpt(o, `${o.name}:`);
      if (!Number.isInteger(n) || n < min || n > MAX_PATTERN) bad(`${o.name}: should be a whole number from ${min} to ${MAX_PATTERN}, got ${fmtNum(n, 3)}`, o.value.span);
      return n;
    };

    if (kind === "mirror") {
      const o = opt.get("about") ?? bad("needs about: the line to mirror across, like about: y_axis");
      const axis = entOf(o.value);
      if (axis.kind !== "line") bad(`about: should be a line, got ${axis.kind} ${axis.id}`, o.value.span);
      const ax = axis as Extract<Ent, { kind: "line" }>;
      if (E.some((e) => e.id === ax.id)) bad(`${ax.id} is the line it mirrors across, so it can't be one of the copies`);
      optIds.about = [ax.id];
      const a = xy(ax.a);
      const b = xy(ax.b);
      const d: V2 = [b[0] - a[0], b[1] - a[1]];
      const L2 = d[0] * d[0] + d[1] * d[1];
      const across = (p: V2): V2 => {
        const t = L2 > 0 ? ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / L2 : 0;
        return [2 * (a[0] + t * d[0]) - p[0], 2 * (a[1] + t * d[1]) - p[1]];
      };
      const axisDeg = (Math.atan2(d[1], d[0]) * 180) / Math.PI;
      copyOnce((id) => unique(`${id}_m`), across, (p, q) => tie("symmetric_line", [p, q, ax.id]), true, (deg) => 2 * axisDeg - deg);
    } else if (kind === "pattern") {
      const n = countOpt(opt.get("count") ?? bad("needs count: how many there are in all, counting the original"), 2);
      const around = opt.get("around");
      const step = opt.get("step");
      if (around && step) bad("give step: for a row, or around: for a ring, not both");
      if (!around && !step) bad("needs step: (dx, dy) for a row, or around: a point for a ring");
      const name = (k: number) => (id: string) => exact(`${id}_${k}`);
      if (around) {
        for (const o of ["count2", "step2"]) if (opt.has(o)) bad(`${o}: makes a grid, so it goes with step:, not around:`, opt.get(o)!.nameSpan);
        const c = entOf(around.value);
        const cp = c.kind === "point" ? c.id : c.kind === "circle" || c.kind === "arc" || c.kind === "ellipse" ? c.c : bad(`around: should be a point (or a circle, for its centre), got ${c.kind} ${c.id}`, around.value.span);
        optIds.around = [c.id];
        const total = opt.has("angle") ? numOpt(opt.get("angle")!, "angle:") : 360;
        if (!(Math.abs(total) > 1e-9 && Math.abs(total) <= 360 + 1e-9)) bad("angle: is how far round the copies spread, between -360 and 360 degrees, and not 0", opt.get("angle")!.value.span);
        // a full turn spaces n evenly with none on top of the first; a part turn puts the last copy at the angle
        const dt = Math.abs(Math.abs(total) - 360) < 1e-9 ? total / n : total / (n - 1);
        const c0 = xy(cp);
        for (let k = 1; k < n; k++) {
          const th = (dt * k * Math.PI) / 180;
          const co = Math.cos(th);
          const si = Math.sin(th);
          const turn = (p: V2): V2 => [c0[0] + co * (p[0] - c0[0]) - si * (p[1] - c0[1]), c0[1] + si * (p[0] - c0[0]) + co * (p[1] - c0[1])];
          copyOnce(name(k + 1), turn, (p, q) => tie("rotate", [p, q, cp], dt * k), false, (deg) => deg + dt * k);
        }
      } else {
        if (opt.has("angle")) bad("angle: goes with around:, for a ring", opt.get("angle")!.nameSpan);
        const vecOpt = (o: Opt): V2 => {
          const v = vec2(o.value, `${kind} ${o.name}:`);
          if (Math.hypot(v[0], v[1]) < 1e-9) bad(`${o.name}: can't be (0, 0); the copies would sit on top of each other`, o.value.span);
          return v;
        };
        const s1 = vecOpt(step!);
        const has2 = opt.has("count2") || opt.has("step2");
        if (has2 && !(opt.has("count2") && opt.has("step2"))) bad("count2: and step2: go together, for the second direction of a grid", (opt.get("count2") ?? opt.get("step2"))!.nameSpan);
        const n2 = has2 ? countOpt(opt.get("count2")!, 1) : 1;
        const s2: V2 = has2 ? vecOpt(opt.get("step2")!) : [0, 0];
        if (n * n2 > MAX_PATTERN) bad(`that is ${n * n2} in all; a pattern makes at most ${MAX_PATTERN}`);
        for (let j = 0; j < n2; j++)
          for (let i = 0; i < n; i++) {
            if (!i && !j) continue;
            const ox = i * s1[0] + j * s2[0];
            const oy = i * s1[1] + j * s2[1];
            copyOnce(
              name(j * n + i + 1),
              (p) => [p[0] + ox, p[1] + oy],
              (p, q) => {
                tie("hdistance", [p, q], ox);
                tie("vdistance", [p, q], oy);
              },
              false,
            );
          }
      }
    } else {
      const by = opt.get("by") ?? bad("needs by: how far to offset, like by: 2 (negative goes the other way)");
      offsetChain(E, by, numOpt(by, "by:"), { bad, xy, construction, unique, tie, plan });
    }

    // everything checked: make it
    for (const p of plan.points) {
      addPoint({ id: p.id, x: p.xy[0], y: p.xy[1], implicit: !p.named, owner: p.owner, literal: false, derived: index });
      if (p.named) ents.set(p.id, { kind: "point", id: p.id });
    }
    for (const [a, id] of plan.aliases) alias.set(a, id);
    const made: string[] = [];
    for (const c of plan.curves) {
      ents.set(
        c.id,
        c.kind === "line"
          ? { kind: "line", id: c.id, a: c.pts[0], b: c.pts[1] }
          : c.kind === "circle" || c.kind === "ellipse"
            ? { kind: c.kind, id: c.id, c: c.pts[0] }
            : c.kind === "spline"
              ? { kind: "spline", id: c.id, pts: c.pts, closed: !!c.closed }
              : { kind: "arc", id: c.id, a: c.pts[0], b: c.pts[1], c: c.pts[2] },
      );
      if (c.kind === "circle") radii.set(c.id, c.r!);
      if (c.rigid) rigidArcs.add(c.id);
      curves.push({ id: c.id, kind: c.kind, construction: c.construction, pts: c.pts, r: c.r, closed: c.closed, rx: c.rx, ry: c.ry, angle: c.angle, status: "free", span: it.span, argSpans: [], derived: index });
      made.push(c.id);
    }
    for (const c of plan.cons) defCons.push({ kind: c.k, refs: c.refs, value: c.v, src: index });
    cons.push({
      index,
      kind,
      args: it.refs.map((r) => src.slice(r.span.start, r.span.end)),
      ids: E.map((e) => e.id),
      argSpans: it.refs.map((r) => r.span),
      span: it.span,
      status: "ok",
      dimension: false,
      opts: (it.opts ?? []).map((o) => ({ name: o.name, text: src.slice(o.span.start, o.span.end), span: o.span, ids: optIds[o.name] ?? [] })),
      made,
      madeFrom: plan.curves.map((c) => c.from),
    });
  }

  type Plan = {
    points: { id: string; xy: V2; owner?: string; named?: boolean }[];
    curves: { id: string; kind: SkCurve["kind"]; pts: string[]; construction: boolean; r?: number; rigid?: boolean; from: string; closed?: boolean; rx?: number; ry?: number; angle?: number }[];
    aliases: [string, string][];
    cons: { k: ConsKind; refs: string[]; v?: number }[];
  };
  type OffsetKit = {
    bad: (msg: string, span?: Span) => never;
    xy: (id: string) => V2;
    construction: (id: string) => boolean;
    unique: (base: string) => string;
    tie: (k: ConsKind, refs: string[], v?: number) => void;
    plan: Plan;
  };

  /**
   * offset: one circle, or one chain of lines and arcs joined end to end.
   * Every copied end point gets one equation along the curve's normal (a set
   * distance from the original line, or a set radius from the arc's centre)
   * and corners get the other from the next curve. Where two curves meet
   * smoothly (a slot's line into its arc) those two would both be along the
   * same normal, so the corner is held on the radius through the original
   * corner instead; loose ends of an open chain are held opposite the
   * original's ends the same way.
   */
  function offsetChain(E: Ent[], by: { value: Expr }, d: number, K: OffsetKit) {
    const { bad, xy, construction, unique, tie, plan } = K;
    if (!(Math.abs(d) > 1e-9)) bad("by: can't be 0", by.value.span);
    if (E.some((e) => e.kind === "point")) bad("offsets lines, arcs and circles, not points");
    const curved = E.find((e) => e.kind === "spline" || e.kind === "ellipse");
    if (curved) bad(`offsets lines, arcs and circles; ${curved.id} is a${curved.kind === "ellipse" ? "n" : ""} ${curved.kind}, which can't be offset yet`);
    if (E.some((e) => e.kind === "circle")) {
      if (E.length > 1) bad("offsets one circle on its own, or one chain of lines and arcs");
      const c = E[0] as Extract<Ent, { kind: "circle" }>;
      const r0 = radii.get(c.id)!;
      if (!(r0 + d > 1e-9)) bad(`by: ${fmtNum(d, 3)} would shrink ${c.id} (radius ${fmtNum(r0, 3)}) to nothing`, by.value.span);
      const cid = unique(`${c.id}_o`);
      plan.curves.push({ id: cid, kind: "circle", pts: [c.c], construction: construction(c.id), r: r0 + d, from: c.id });
      plan.aliases.push([`${cid}.center`, c.c]);
      tie("radius_diff", [c.id, cid], d);
      return;
    }
    type Cur = Extract<Ent, { kind: "line" | "arc" }>;
    const list = E as Cur[];
    // ends meet when they are the same point, or written at the same place
    const node = new Map<string, string>();
    for (const e of list)
      for (const id of [e.a, e.b]) {
        if (node.has(id)) continue;
        const p = xy(id);
        const twin = [...node.keys()].find((q) => Math.abs(xy(q)[0] - p[0]) < 1e-7 && Math.abs(xy(q)[1] - p[1]) < 1e-7);
        node.set(id, twin ? node.get(twin)! : id);
      }
    const N = (id: string) => node.get(id)!;
    const deg = new Map<string, number>();
    for (const e of list) {
      if (N(e.a) === N(e.b)) bad(`${e.id} starts and ends at the same place`);
      for (const id of [e.a, e.b]) deg.set(N(id), (deg.get(N(id)) ?? 0) + 1);
    }
    if ([...deg.values()].some((v) => v > 2)) bad("the curves branch; give one chain, each curve meeting the next end to end");
    const ends = [...deg].filter(([, v]) => v === 1).map(([k]) => k);
    const closed = ends.length === 0;
    type El = { e: Cur; rev: boolean };
    const order: El[] = [];
    const left = new Set(list);
    let at = closed ? N(list[0].a) : ends[0];
    if (closed) {
      order.push({ e: list[0], rev: false });
      left.delete(list[0]);
      at = N(list[0].b);
    }
    while (left.size) {
      const nx = [...left].find((e) => N(e.a) === at || N(e.b) === at);
      if (!nx) bad("the curves don't join into one chain; offset each chain on its own");
      const rev = N(nx!.a) !== at;
      order.push({ e: nx!, rev });
      at = rev ? N(nx!.a) : N(nx!.b);
      left.delete(nx!);
    }
    if (closed && at !== N(list[0].a)) bad("the curves don't join into one chain; offset each chain on its own");
    // an open chain runs the way the first curve listed does
    const firstEl = order.find((o) => o.e === list[0])!;
    if (!closed && firstEl.rev) {
      order.reverse();
      for (const o of order) o.rev = !o.rev;
    }
    const from = (o: El) => (o.rev ? o.e.b : o.e.a);
    const to = (o: El) => (o.rev ? o.e.a : o.e.b);
    // walking direction at a point of an element, and its left-hand normal
    const dirAt = (o: El, id: string): V2 => {
      if (o.e.kind === "line") {
        const a = xy(from(o));
        const b = xy(to(o));
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        return [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
      }
      const c = xy(o.e.c);
      const p = xy(id);
      const L = Math.hypot(p[0] - c[0], p[1] - c[1]) || 1;
      const t: V2 = [-(p[1] - c[1]) / L, (p[0] - c[0]) / L];
      return o.rev ? [-t[0], -t[1]] : t;
    };
    const leftOf = (t: V2): V2 => [-t[1], t[0]];
    // the side: outward for a closed loop when by > 0, to the left of the walk for an open chain
    let area = 0;
    if (closed) {
      const ring: V2[] = [];
      for (const o of order) {
        if (o.e.kind === "line") ring.push(xy(from(o)));
        else {
          const c = xy(o.e.c);
          const a = xy(o.e.a);
          const b = xy(o.e.b);
          const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
          const t0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
          let sweep = Math.atan2(b[1] - c[1], b[0] - c[0]) - t0;
          while (sweep <= 0) sweep += 2 * Math.PI;
          for (let k = 0; k < 12; k++) {
            const f = o.rev ? 1 - k / 12 : k / 12;
            ring.push([c[0] + r * Math.cos(t0 + sweep * f), c[1] + r * Math.sin(t0 + sweep * f)]);
          }
        }
      }
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i];
        const q = ring[(i + 1) % ring.length];
        area += p[0] * q[1] - q[0] * p[1];
      }
    }
    const side = (closed ? (area > 0 ? -1 : 1) : 1) * Math.sign(d);
    const dist = Math.abs(d);
    // the new radius of each arc: walking an arc anticlockwise, its left is towards the centre
    const dr = new Map<string, number>();
    for (const o of order) {
      if (o.e.kind !== "arc") continue;
      const a = xy(o.e.a);
      const c = xy(o.e.c);
      const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
      const change = (o.rev ? 1 : -1) * side * dist;
      if (!(r + change > 1e-9)) bad(`by: ${fmtNum(d, 3)} would shrink arc ${o.e.id} (radius ${fmtNum(r, 3)}) to nothing`, by.value.span);
      dr.set(o.e.id, change);
    }
    const names = new Map(order.map((o) => [o.e.id, unique(`${o.e.id}_o`)]));
    const shift = (p: V2, o: El, id: string): V2 => {
      const n = leftOf(dirAt(o, id));
      return [p[0] + side * dist * n[0], p[1] + side * dist * n[1]];
    };
    // the offset curves, to start the corners where they cross
    type Geo = { line: [V2, V2] } | { circle: [V2, number] };
    const geo = (o: El): Geo => {
      if (o.e.kind === "line") return { line: [shift(xy(o.e.a), o, o.e.a), shift(xy(o.e.b), o, o.e.b)] };
      const c = xy(o.e.c);
      const a = xy(o.e.a);
      return { circle: [c, Math.hypot(a[0] - c[0], a[1] - c[1]) + dr.get(o.e.id)!] };
    };
    const meet = (g1: Geo, g2: Geo, guess: V2): V2 => {
      const pts: V2[] = [];
      const lineCircle = ([p, q]: [V2, V2], [c, r]: [V2, number]) => {
        const dx = q[0] - p[0];
        const dy = q[1] - p[1];
        const A = dx * dx + dy * dy;
        const B = 2 * (dx * (p[0] - c[0]) + dy * (p[1] - c[1]));
        const C = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 - r * r;
        const disc = B * B - 4 * A * C;
        if (A > 0 && disc >= 0) for (const sg of [-1, 1]) pts.push([p[0] + ((-B + sg * Math.sqrt(disc)) / (2 * A)) * dx, p[1] + ((-B + sg * Math.sqrt(disc)) / (2 * A)) * dy]);
      };
      if ("line" in g1 && "line" in g2) {
        const [p, q] = g1.line;
        const [u, v] = g2.line;
        const d1: V2 = [q[0] - p[0], q[1] - p[1]];
        const d2: V2 = [v[0] - u[0], v[1] - u[1]];
        const den = d1[0] * d2[1] - d1[1] * d2[0];
        if (Math.abs(den) > 1e-12 * Math.hypot(...d1) * Math.hypot(...d2)) {
          const t = ((u[0] - p[0]) * d2[1] - (u[1] - p[1]) * d2[0]) / den;
          pts.push([p[0] + t * d1[0], p[1] + t * d1[1]]);
        }
      } else if ("line" in g1 && "circle" in g2) lineCircle(g1.line, g2.circle);
      else if ("circle" in g1 && "line" in g2) lineCircle(g2.line, g1.circle);
      else if ("circle" in g1 && "circle" in g2) {
        const [c1, r1] = g1.circle;
        const [c2, r2] = g2.circle;
        const D = Math.hypot(c2[0] - c1[0], c2[1] - c1[1]);
        if (D > 1e-12 && D <= r1 + r2 && D >= Math.abs(r1 - r2)) {
          const a = (r1 * r1 - r2 * r2 + D * D) / (2 * D);
          const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
          const m: V2 = [c1[0] + (a * (c2[0] - c1[0])) / D, c1[1] + (a * (c2[1] - c1[1])) / D];
          for (const sg of [-1, 1]) pts.push([m[0] + (sg * h * -(c2[1] - c1[1])) / D, m[1] + (sg * h * (c2[0] - c1[0])) / D]);
        }
      }
      let best = guess;
      let bd = Infinity;
      for (const p of pts) {
        const dd = Math.hypot(p[0] - guess[0], p[1] - guess[1]);
        if (dd < bd) {
          bd = dd;
          best = p;
        }
      }
      // a crossing far from the corner (two nearly parallel lines) is no good start
      return bd < 50 * dist + 1e-6 ? best : guess;
    };
    // a smooth join: by the shapes as written, or a tangent / collinear / parallel constraint between them
    const written = s.items.filter((x): x is Extract<SketchItem, { k: "constraint" }> => x.k === "constraint" && ["tangent", "collinear", "colinear", "parallel"].includes(x.name));
    const tied = (a: string, b: string) => written.some((x) => {
      const names = x.refs.map(refPath);
      return names.includes(a) && names.includes(b);
    });
    const smooth = (o1: El, o2: El, id1: string, id2: string) => {
      const t1 = dirAt(o1, id1);
      const t2 = dirAt(o2, id2);
      return (Math.abs(t1[0] * t2[1] - t1[1] * t2[0]) < 1e-4 && t1[0] * t2[0] + t1[1] * t2[1] > 0) || tied(o1.e.id, o2.e.id);
    };
    // the equation that keeps a copied point on its offset curve
    const onCurve = (o: El, q: string) => {
      if (o.e.kind === "line") tie("distance_pl", [q, o.e.id], dist);
      else tie("radius_offset", [q, o.e.c, o.e.id], dr.get(o.e.id)!);
    };
    // the one that holds it opposite the original point
    const across = (o: El, srcId: string, q: string) => {
      if (o.e.kind === "line") tie("perp_foot", [srcId, q, o.e.id]);
      else tie("radial", [srcId, q, o.e.c]);
    };
    const role = (o: El, id: string) => (id === o.e.a ? "start" : "end");
    // corner k sits between element k-1 (coming in) and element k (going out)
    const corner = new Map<number, string>();
    const count = order.length;
    const cornersAt = closed ? count : count + 1;
    for (let k = 0; k < cornersAt; k++) {
      const prev = closed ? order[(k - 1 + count) % count] : k > 0 ? order[k - 1] : null;
      const next = k < count ? order[k] : null;
      const srcIn = prev ? to(prev) : null;
      const srcOut = next ? from(next) : null;
      const own = prev ?? next!;
      const ownSrc = (prev ? srcIn : srcOut)!;
      const id = `${names.get(own.e.id)!}.${role(own, ownSrc)}`;
      const base = xy(ownSrc);
      let start: V2;
      if (prev && next) {
        const g1 = geo(prev);
        const g2 = geo(next);
        const guess = shift(base, prev, srcIn!);
        start = smooth(prev, next, srcIn!, srcOut!) ? guess : meet(g1, g2, guess);
      } else start = shift(base, own, ownSrc);
      plan.points.push({ id, xy: start, owner: names.get(own.e.id)! });
      if (prev && next) plan.aliases.push([`${names.get(next.e.id)!}.${role(next, srcOut!)}`, id]);
      corner.set(k, id);
      // the equations: one from each curve, or across for a smooth join or a loose end
      if (prev) onCurve(prev, id);
      if (next) {
        if (!prev) {
          onCurve(next, id);
          across(next, srcOut!, id);
        } else if (smooth(prev, next, srcIn!, srcOut!)) {
          if (prev.e.kind === "arc") tie("radial", [srcIn!, id, prev.e.c]);
          else if (next.e.kind === "arc") tie("radial", [srcOut!, id, next.e.c]);
          else tie("perp_foot", [srcIn!, id, prev.e.id]);
        } else onCurve(next, id);
      } else across(prev!, srcIn!, id);
    }
    for (let k = 0; k < count; k++) {
      const o = order[k];
      const a = corner.get(k)!;
      const b = corner.get(closed ? (k + 1) % count : k + 1)!;
      // the copy runs the same way as its original
      const [s0, e0] = o.rev ? [b, a] : [a, b];
      const cid = names.get(o.e.id)!;
      if (o.e.kind === "line") plan.curves.push({ id: cid, kind: "line", pts: [s0, e0], construction: construction(o.e.id), from: o.e.id });
      else {
        plan.curves.push({ id: cid, kind: "arc", pts: [s0, e0, o.e.c], construction: construction(o.e.id), rigid: true, from: o.e.id });
        plan.aliases.push([`${cid}.center`, o.e.c]);
      }
    }
  }

  // ---- constraints ----

  for (const it of constraintItems) {
    const before = defCons.length;
    try {
      constraint(it);
    } catch (e) {
      defCons.length = before;
      if (!host.report(e)) throw e;
    }
  }

  function constraint(it: Extract<SketchItem, { k: "constraint" }>) {
    const index = cons.length;
    const raw = it.name;
    const name = CONSTRAINTS[raw] ? raw : ALIASES[raw];
    if (!name) {
      const sg = suggest(raw, [...Object.keys(CONSTRAINTS), ...Object.keys(ALIASES)]);
      host.fail(`Unknown sketch statement "${raw}"${sg ? `. Did you mean "${ALIASES[sg] ?? sg}"?` : `. Constraints: ${Object.keys(CONSTRAINTS).join(", ")}`}`, it.nameSpan);
    }
    const spec = CONSTRAINTS[name];
    if (spec.dim && !it.value) host.fail(`${name} needs a value, e.g. ${name} ${it.refs.map((r) => src.slice(r.span.start, r.span.end)).join(", ") || "l1"} = 20`, it.span);
    if (!spec.dim && it.value) host.fail(`${name} does not take a value; remove "= …"`, it.value.span);
    if (!it.refs.length) host.fail(`${name} needs geometry to act on: ${spec.doc}`, it.span);
    if (it.opts) host.fail(`${name} does not take named options like ${it.opts[0].name}:. ${spec.doc}`, it.opts[0].span);
    const E = it.refs.map(entOf);
    const value = it.value ? num(it.value, `${name}'s value`) : undefined;
    const add = (kind: ConsKind, refs: string[], v?: number) => defCons.push({ kind, refs, value: v, src: index });
    const bad = (msg: string): never => host.fail(`${name}: ${msg}. ${spec.doc}`, it.span);
    const need = (n: number) => {
      if (E.length !== n) bad(`takes ${n} item${n > 1 ? "s" : ""}, got ${E.length}`);
    };
    const line = (e: Ent) => (e.kind === "line" ? e : bad(`${e.id} is a ${e.kind}, expected a line`));
    const point = (e: Ent) => (e.kind === "point" ? e : bad(`${e.id} is a ${e.kind}, expected a point`));
    const circ = (e: Ent) => (isCirc(e) ? e : bad(`${e.id} is a ${e.kind}, expected a circle or arc`));

    switch (name) {
      case "fix":
        for (const e of E) {
          if (e.kind === "point") fixedIds.add(e.id);
          else if (e.kind === "line") fixedIds.add(e.a).add(e.b);
          else if (e.kind === "spline") for (const id of e.pts) fixedIds.add(id);
          else fixedIds.add(e.c);
        }
        break;
      case "coincident": {
        need(2);
        const [a, b] = E;
        if (a.kind === "point" && b.kind === "point") add("coincident", [a.id, b.id]);
        else {
          const p = a.kind === "point" ? a : b.kind === "point" ? b : bad("needs at least one point");
          const c = p === a ? b : a;
          if (c.kind === "line") add("on_line", [p.id, c.id]);
          else if (isCirc(c)) add("on_circle", [p.id, c.id]);
          else bad(`puts a point on a line, circle or arc; to join ${c.id}, name one of its points (${c.kind === "spline" ? `${c.id}.start, ${c.id}.end or ${c.id}.p2` : `${c.id}.center`})`);
        }
        break;
      }
      case "horizontal":
      case "vertical": {
        if (E.length === 2 && E[0].kind === "point" && E[1].kind === "point") add(name, [E[0].id, E[1].id]);
        else
          for (const e of E) {
            const l = line(e);
            add(name, [l.a, l.b]);
          }
        break;
      }
      case "parallel":
      case "perpendicular": {
        if (E.length < 2 || (name === "perpendicular" && E.length !== 2)) bad(`takes ${name === "parallel" ? "two or more lines" : "two lines"}`);
        const first = line(E[0]);
        for (const e of E.slice(1)) add(name, [first.id, line(e).id]);
        break;
      }
      case "collinear": {
        need(2);
        const l1 = line(E[0]);
        const l2 = line(E[1]);
        add("on_line", [l2.a, l1.id]);
        add("on_line", [l2.b, l1.id]);
        break;
      }
      case "equal": {
        if (E.length < 2) bad("takes two or more lines, or two or more circles and arcs");
        if (E.every((e) => e.kind === "line")) for (const e of E.slice(1)) add("equal_length", [E[0].id, e.id]);
        else if (E.every(isCirc)) for (const e of E.slice(1)) add("equal_radius", [E[0].id, e.id]);
        else bad("mixes lines with circles; give all lines or all circles and arcs");
        break;
      }
      case "tangent": {
        need(2);
        const [a, b] = E;
        if (a.kind === "point" || b.kind === "point") bad("takes curves, not points");
        if (a.kind === "line" && b.kind === "line") bad("needs a circle or arc; two lines cannot be tangent");
        if (a.kind === "spline" || b.kind === "spline" || a.kind === "ellipse" || b.kind === "ellipse") bad(`works between lines, circles and arcs; a spline already runs smoothly through its points`);
        add("tangent", [a.id, b.id]);
        break;
      }
      case "midpoint": {
        need(2);
        const p = E[0].kind === "point" ? E[0] : E[1].kind === "point" ? E[1] : bad("needs a point and a line");
        const l = line(p === E[0] ? E[1] : E[0]);
        add("midpoint", [p.id, l.id]);
        break;
      }
      case "symmetric": {
        need(3);
        const p = point(E[0]);
        const q = point(E[1]);
        const about = E[2];
        if (about.kind === "line") add("symmetric_line", [p.id, q.id, about.id]);
        else if (about.kind === "point") add("symmetric_point", [p.id, q.id, about.id]);
        else bad("mirrors about a line or a point");
        break;
      }
      case "concentric": {
        need(2);
        const centre = (e: Ent) => (e.kind === "ellipse" ? e.c : centerOf(circ(e)));
        add("coincident", [centre(E[0]), centre(E[1])]);
        break;
      }
      case "distance": {
        need(2);
        const [a, b] = E;
        if (!(value! >= 0)) bad("a distance cannot be negative");
        if (a.kind === "point" && b.kind === "point") add("distance", [a.id, b.id], value);
        else if (a.kind === "point" && b.kind === "line") add("distance_pl", [a.id, b.id], value);
        else if (a.kind === "line" && b.kind === "point") add("distance_pl", [b.id, a.id], value);
        else if (a.kind === "line" && b.kind === "line") add("distance_ll", [a.id, b.id], value);
        else if (isCirc(a) && b.kind === "point") add("distance", [centerOf(a), b.id], value);
        else if (a.kind === "point" && isCirc(b)) add("distance", [a.id, centerOf(b)], value);
        else if (isCirc(a) && isCirc(b)) add("distance", [centerOf(a), centerOf(b)], value);
        else if (isCirc(a) && b.kind === "line") add("distance_pl", [centerOf(a), b.id], value);
        else if (a.kind === "line" && isCirc(b)) add("distance_pl", [centerOf(b), a.id], value);
        else if (a.kind === "ellipse" || b.kind === "ellipse") {
          // from an ellipse's centre
          const pid = (e: Ent) => (e.kind === "ellipse" || isCirc(e) ? e.c : e.kind === "point" ? e.id : null);
          const [pa, pb] = [pid(a), pid(b)];
          if (pa && pb) add("distance", [pa, pb], value);
          else if (pa && b.kind === "line") add("distance_pl", [pa, b.id], value);
          else if (pb && a.kind === "line") add("distance_pl", [pb, a.id], value);
          else bad("measures between points, lines, circles and ellipses (from their centres)");
        } else bad(`measures between points, lines, circles and arcs; ${(a.kind === "spline" ? a : b).id} is a spline, so measure to one of its points`);
        break;
      }
      case "hdistance":
      case "vdistance": {
        let pa: string;
        let pb: string;
        if (E.length === 1) {
          const l = line(E[0]);
          pa = l.a;
          pb = l.b;
        } else {
          need(2);
          const ids = E.map((e) => (e.kind === "point" ? e.id : isCirc(e) || e.kind === "ellipse" ? e.c : bad("measures between points (or circle and ellipse centres)")));
          pa = ids[0];
          pb = ids[1];
        }
        add(name, [pa, pb], value);
        break;
      }
      case "length": {
        need(1);
        if (!(value! > 0)) bad("a length must be greater than 0");
        add("length", [line(E[0]).id], value);
        break;
      }
      case "radius":
      case "diameter": {
        if (!(value! > 0)) bad(`a ${name} must be greater than 0`);
        for (const e of E) add("radius", [circ(e).id], name === "radius" ? value : value! / 2);
        break;
      }
      case "angle": {
        need(2);
        add("angle", [line(E[0]).id, line(E[1]).id], value);
        break;
      }
      case "fillet":
      case "chamfer": {
        if (!(value! > 0)) bad(`the ${name === "fillet" ? "radius" : "distance"} must be greater than 0`);
        if (E.length === 2 && E[0].kind === "line" && E[1].kind === "line") cornerReqs.push({ src: index, kind: name, r: value!, lines: [E[0], E[1]] });
        else cornerReqs.push({ src: index, kind: name, r: value!, pts: E.map((e) => point(e).id) });
        break;
      }
    }
    cons.push({
      index,
      kind: name,
      args: it.refs.map((r) => src.slice(r.span.start, r.span.end)),
      ids: E.map((e) => e.id),
      argSpans: it.refs.map((r) => r.span),
      value,
      valueText: it.value ? src.slice(it.value.span.start, it.value.span.end) : undefined,
      span: it.span,
      valueSpan: it.value?.span,
      status: "ok",
      dimension: spec.dim,
    });
  }

  for (const id of fixedIds) {
    const i = pointIdx.get(id);
    if (i !== undefined) points[i].fixed = true;
  }

  // an arc held still by three fixed points (a projected outline) has nothing to solve: written to 3 decimals
  // its ends may sit a rounding error off the circle, which would otherwise read as a conflict
  const held = (a: Extract<Ent, { kind: "arc" }>) => {
    const [pa, pb, pc] = [a.a, a.b, a.c].map((id) => points[pointIdx.get(id) ?? -1]);
    if (!pa?.fixed || !pb?.fixed || !pc?.fixed) return false;
    const ra = Math.hypot(pa.x - pc.x, pa.y - pc.y);
    return Math.abs(Math.hypot(pb.x - pc.x, pb.y - pc.y) - ra) <= Math.max(3e-3, 1e-4 * ra);
  };
  // ---- solve ----
  const def: SketchDef = {
    points: points.map((p) => ({ id: p.id, x: p.x, y: p.y, fixed: p.fixed })),
    lines: [...ents.values()].filter((e): e is Extract<Ent, { kind: "line" }> => e.kind === "line").map((l) => ({ id: l.id, a: l.a, b: l.b })),
    circles: [...radii].map(([id, r]) => ({ id, c: (ents.get(id) as Extract<Ent, { kind: "circle" }>).c, r })),
    arcs: [...ents.values()].filter((e): e is Extract<Ent, { kind: "arc" }> => e.kind === "arc").map((a) => (rigidArcs.has(a.id) || held(a) ? { id: a.id, c: a.c, a: a.a, b: a.b, rigid: true } : { id: a.id, c: a.c, a: a.a, b: a.b })),
    constraints: defCons,
  };
  let res: SolveResult;
  let culprit: number | null;
  try {
    ({ res, culprit } = cachedSolve(def, host.budget));
  } catch (e) {
    return host.fail(`Sketch ${s.name} could not be set up: ${(e as Error).message}`, s.nameSpan);
  }
  let message: string | undefined;
  const tooBig = !!(res.tooBig || res.outOfTime);
  if (tooBig) {
    message = res.tooBig
      ? `Sketch ${s.name} is too big to solve: ${res.tooBig} unknowns are tied together by its constraints, and the limit is ${MAX_UNKNOWNS} (about ${MAX_UNKNOWNS / 2} points). It is drawn as written. Split it into smaller sketches.`
      : `Sketch ${s.name} took too long to solve and is drawn as written. Split it into smaller sketches, or remove constraints.`;
    host.diag(message, s.nameSpan, "error");
  } else if (!res.ok) {
    const srcIdx = culprit !== null ? defCons[culprit].src : res.unsatisfied.map((k) => defCons[k]?.src).find((x) => x !== undefined);
    const others = [...new Set(res.unsatisfied.map((k) => defCons[k]?.src).filter((x): x is number => x !== undefined && x !== srcIdx))];
    const text = (i: number) => src.slice(cons[i].span.start, cons[i].span.end).trim();
    if (srcIdx !== undefined) {
      cons[srcIdx].status = "conflict";
      for (const o of others) cons[o].status = "involved";
      message = `"${text(srcIdx)}" cannot hold together with the constraints before it${others.length ? ` (${others.slice(0, 3).map((o) => `"${text(o)}"`).join(", ")})` : ""}. Remove or change one of them.`;
      host.diag(message, cons[srcIdx].span, "error");
    } else {
      message = `Sketch ${s.name} could not be solved. Move the geometry closer to what the constraints describe.`;
      host.diag(message, s.nameSpan, "error");
    }
  } else {
    const red = new Set(res.redundant.map((k) => defCons[k].src));
    for (const i of red) {
      cons[i].status = "redundant";
      host.diag(`Already implied by the other constraints in ${s.name}; you can remove it`, cons[i].span, "warning");
    }
  }

  // statuses
  const conflictIds = new Set<string>();
  for (const c of cons) if (c.status === "conflict") for (const id of c.ids) conflictIds.add(id);
  for (const p of points) {
    const solved = res.points[p.id];
    p.x = solved[0];
    p.y = solved[1];
    p.freedom = res.freedom[p.id] ?? { kind: "free" };
    p.status = conflictIds.has(p.id) ? "conflict" : p.freedom.kind === "fixed" ? "fixed" : p.freedom.kind === "defined" ? "defined" : "free";
  }
  const pstat = (id: string) => points[pointIdx.get(id)!].status;
  const worst = (ss: SkStatus[]): SkStatus => (ss.includes("conflict") ? "conflict" : ss.includes("free") ? "free" : ss.every((x) => x === "fixed") ? "fixed" : "defined");
  for (const c of curves) {
    if (c.kind === "circle") c.r = res.radii[c.id];
    const st = worst(c.pts.map(pstat));
    c.status = conflictIds.has(c.id) ? "conflict" : c.kind === "circle" && res.freeRadius.includes(c.id) && st !== "conflict" ? "free" : st;
  }

  // ---- profile ----
  const P = (id: string): V2 => res.points[id];
  const solid = curves.filter((c) => !c.construction);
  const corners: CornerSpec[] = [];
  for (const q of cornerReqs) {
    if (q.pts) for (const at of q.pts) corners.push({ at, r: q.r, kind: q.kind, src: q.src });
    else {
      // the end the two lines share (by name, or by position after solving)
      const [l1, l2] = q.lines!;
      let best: { at: string; d: number } | null = null;
      for (const a of [l1.a, l1.b])
        for (const b of [l2.a, l2.b]) {
          const d = Math.hypot(P(a)[0] - P(b)[0], P(a)[1] - P(b)[1]);
          if (!best || d < best.d) best = { at: a, d };
        }
      if (best && best.d < 1e-5) corners.push({ at: best.at, r: q.r, kind: q.kind, src: q.src });
      else host.diag(`${q.kind}: ${l1.id} and ${l2.id} do not meet at a corner`, cons[q.src].span, "error");
    }
  }
  const profile = buildProfile(
    res.points,
    solid.filter((c) => c.kind === "line").map((c) => ({ id: c.id, a: c.pts[0], b: c.pts[1] })),
    solid.filter((c) => c.kind === "arc").map((c) => ({ id: c.id, a: c.pts[0], b: c.pts[1], c: c.pts[2] })),
    solid.filter((c) => c.kind === "circle").map((c) => ({ id: c.id, c: c.pts[0], r: c.r! })),
    corners,
    {
      splines: solid.filter((c) => c.kind === "spline").map((c) => ({ id: c.id, pts: c.pts, closed: !!c.closed })),
      ellipses: solid.filter((c) => c.kind === "ellipse").map((c) => ({ id: c.id, c: c.pts[0], rx: c.rx!, ry: c.ry!, rot: c.angle ?? 0 })),
    },
  );
  for (const issue of profile.cornerIssues) host.diag(issue.message, cons[issue.src].span, "error");

  // ---- frame and language value ----
  const o0: V3 = originOverride ?? frame.o;
  frame = { ...frame, o: vadd(o0, vscale(frame.n, offset)) };
  const W = (p: V2) => new Vec(toWorld(frame, p[0], p[1]));
  const dirW = (d: V2) => new Vec([frame.u[0] * d[0] + frame.v[0] * d[1], frame.u[1] * d[0] + frame.v[1] * d[1], frame.u[2] * d[0] + frame.v[2] * d[1]]);
  const lineObj = (id: string, a: V2, b: V2) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return new SketchLineObj(
      { start: W(a), end: W(b), mid: W([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]), length: L, dir: dirW(L ? [(b[0] - a[0]) / L, (b[1] - a[1]) / L] : [1, 0]) },
      `${s.name}.${id}`,
      s.name,
      a,
      b,
    );
  };
  const fields: Record<string, Value> = {
    name: s.name,
    origin: W([0, 0]),
    normal: new Vec([...frame.n]),
    plane: planeValue(frame, `${s.name}.plane`),
    x_axis: lineObj("x_axis", [0, 0], [1, 0]),
    y_axis: lineObj("y_axis", [0, 0], [0, 1]),
    area: profile.area,
  };
  const lines: Record<string, [V2, V2]> = { x_axis: [[0, 0], [1, 0]], y_axis: [[0, 0], [0, 1]] };
  for (const p of points) if (!p.implicit) fields[p.id] = W([p.x, p.y]);
  for (const c of curves) {
    if (c.external) continue;
    if (c.kind === "line") {
      const a = P(c.pts[0]);
      const b = P(c.pts[1]);
      lines[c.id] = [a, b];
      fields[c.id] = lineObj(c.id, a, b);
    } else if (c.kind === "circle") {
      fields[c.id] = new Obj({ center: W(P(c.pts[0])), r: c.r!, d: 2 * c.r! }, "sketch circle", `${s.name}.${c.id}`);
    } else if (c.kind === "ellipse") {
      fields[c.id] = new Obj({ center: W(P(c.pts[0])), rx: c.rx!, ry: c.ry!, angle: c.angle ?? 0 }, "sketch ellipse", `${s.name}.${c.id}`);
    } else if (c.kind === "spline") {
      const ps = c.pts.map(P);
      fields[c.id] = new Obj(
        { points: ps.map(W), closed: !!c.closed, ...(c.closed ? {} : { start: W(ps[0]), end: W(ps[ps.length - 1]) }), ...Object.fromEntries(ps.map((p, i) => [`p${i + 1}`, W(p)])) },
        "sketch spline",
        `${s.name}.${c.id}`,
      );
    } else {
      const [a, b, cc] = c.pts.map(P);
      fields[c.id] = new Obj({ start: W(a), end: W(b), center: W(cc), r: Math.hypot(a[0] - cc[0], a[1] - cc[1]) }, "sketch arc", `${s.name}.${c.id}`);
    }
  }
  const extent: V2[] = profile.regions.flatMap((r) => [...r.outer, ...r.holes.flat()]).flatMap((sg) => sampleSeg(sg, 10));
  const value = new SketchObj(fields, s.name, {
    name: s.name,
    frame,
    regions: profile.regions,
    profileError: profile.error?.message,
    solved: res.ok,
    message,
    lines,
    extent,
  });

  const firstItem = s.items[0];
  const indent = firstItem ? (/^[ \t]*/.exec(src.slice(src.lastIndexOf("\n", firstItem.span.start - 1) + 1, firstItem.span.start))?.[0] ?? "  ") : "  ";
  const sketch: EvalSketch = {
    name: s.name,
    span: s.span,
    nameSpan: s.nameSpan,
    bodyEnd: s.bodyEnd,
    entityEnd,
    indent: indent || "  ",
    locked,
    frame,
    planeText,
    points,
    curves,
    constraints: cons,
    dof: res.dof,
    solved: res.ok,
    tooBig: tooBig || undefined,
    message,
    redundant: cons.filter((c) => c.status === "redundant").length,
    profile,
    aliases: Object.fromEntries(alias),
    def,
    usedBy: [],
  };
  return { value, sketch };
}

/** One-line status for summaries: "fully defined, 1 profile" or "3 degrees of freedom left". */
export function sketchStatusText(sk: EvalSketch): string {
  const parts: string[] = [];
  if (sk.tooBig) parts.push("too big to solve, drawn as written");
  else if (!sk.solved) parts.push("constraints conflict");
  else if (sk.dof === 0) parts.push("fully defined");
  else parts.push(`${sk.dof} degree${sk.dof === 1 ? "" : "s"} of freedom left`);
  if (sk.redundant) parts.push(`${sk.redundant} redundant constraint${sk.redundant > 1 ? "s" : ""}`);
  if (sk.profile.error) parts.push(`profile problem: ${sk.profile.error.message}`);
  else if (sk.profile.open) parts.push(`${sk.profile.open.refs.length} open curve${sk.profile.open.refs.length > 1 ? "s" : ""} left out`);
  else if (sk.profile.regions.length) parts.push(`${sk.profile.regions.length} closed region${sk.profile.regions.length > 1 ? "s" : ""}, area ${fmtNum(sk.profile.area, 1)} mm²`);
  else parts.push("no closed profile yet");
  return parts.join(", ");
}
