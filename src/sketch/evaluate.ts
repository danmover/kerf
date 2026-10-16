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
import { firstConflict, solveSketch, type ConsKind, type DefConstraint, type SketchDef, type SolveResult } from "./solver";
import { PLANES, frameOf, isPlane, planeValue, toWorld } from "./planes";
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
};
const ALIASES: Record<string, string> = { on: "coincident", dist: "distance", dx: "hdistance", dy: "vdistance", colinear: "collinear", perpendicular_to: "perpendicular" };

type Ent =
  | { kind: "point"; id: string }
  | { kind: "line"; id: string; a: string; b: string }
  | { kind: "circle"; id: string; c: string }
  | { kind: "arc"; id: string; c: string; a: string; b: string };

const solveCache = new Map<string, SolveResult>();
function cachedSolve(def: SketchDef): SolveResult {
  const key = stableStringify(def);
  const hit = solveCache.get(key);
  if (hit) {
    solveCache.delete(key);
    solveCache.set(key, hit);
    return hit;
  }
  const r = solveSketch(def);
  solveCache.set(key, r);
  if (solveCache.size > 300) solveCache.delete(solveCache.keys().next().value!);
  return r;
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
      return [v.v[0] ?? 0, v.v[1] ?? 0];
    }
    return host.fail(`${what} should be a point like (10, 5) or the name of a sketch point, got ${typeName(v)}`, e.span);
  };

  /** A point argument: the name of a sketch point, or coordinates that make a new point owned by the curve. */
  const pointArg = (e: Expr, owner: string, role: string): string => {
    const path = refPath(e);
    if (path) {
      const ent = ents.get(path);
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

  const declare = (name: string, span: Span) => {
    if (FIELD_RESERVED.has(name)) host.fail(`"${name}" is a built-in sketch name; choose another`, span);
    if (ents.has(name) || pointIdx.has(name)) host.fail(`"${name}" is already defined in this sketch`, span);
  };

  const constraintItems: Extract<SketchItem, { k: "constraint" }>[] = [];
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
          if (typeof v !== "number") host.fail(`offset: should be a distance along the plane's normal, got ${typeName(v)}`, it.value.span);
          offset = v as number;
        } else {
          if (!(v instanceof Vec)) host.fail(`origin: should be a 3D point, got ${typeName(v)}`, it.value.span);
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
        const a = pointArg(it.args[0], it.name, "start");
        const b = pointArg(it.args[1], it.name, "end");
        const c = pointArg(it.args[2], it.name, "center");
        if (a === b) host.fail(`arc ${it.name} starts and ends at the same point; use a circle for a full round`, it.span);
        ents.set(it.name, { kind: "arc", id: it.name, c, a, b });
        curves.push({ id: it.name, kind: "arc", construction: it.construction, pts: [a, b, c], status: "free", span: it.span, argSpans });
        break;
      }
      case "constraint":
        constraintItems.push(it);
        break;
    }
  }

  // ---- constraints ----
  const entOf = (e: Expr): Ent => {
    const path = refPath(e);
    if (!path) host.fail(`Expected the name of sketch geometry (a point, line, circle or arc) but found an expression`, e.span);
    const ent = ents.get(path!);
    if (ent) return ent;
    if (pointIdx.has(path!)) return { kind: "point", id: path! };
    if (alias.has(path!)) return { kind: "point", id: alias.get(path!)! };
    // members of curves: l1.start, c1.center
    const all = [...ents.keys(), ...pointIdx.keys(), ...alias.keys()];
    const sg = suggest(path!, all);
    return host.fail(`"${path}" is not geometry in sketch ${s.name}${sg ? `. Did you mean "${sg}"?` : ". Geometry must be declared before constraints use it."}`, e.span);
  };
  const isCirc = (e: Ent): e is Extract<Ent, { kind: "circle" | "arc" }> => e.kind === "circle" || e.kind === "arc";
  const centerOf = (e: Extract<Ent, { kind: "circle" | "arc" }>) => e.c;

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
        const a = circ(E[0]);
        const b = circ(E[1]);
        add("coincident", [centerOf(a), centerOf(b)]);
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
          const ids = E.map((e) => (e.kind === "point" ? e.id : isCirc(e) ? e.c : bad("measures between points (or circle centres)")));
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

  // ---- solve ----
  const def: SketchDef = {
    points: points.map((p) => ({ id: p.id, x: p.x, y: p.y, fixed: p.fixed })),
    lines: [...ents.values()].filter((e): e is Extract<Ent, { kind: "line" }> => e.kind === "line").map((l) => ({ id: l.id, a: l.a, b: l.b })),
    circles: [...radii].map(([id, r]) => ({ id, c: (ents.get(id) as Extract<Ent, { kind: "circle" }>).c, r })),
    arcs: [...ents.values()].filter((e): e is Extract<Ent, { kind: "arc" }> => e.kind === "arc").map((a) => ({ id: a.id, c: a.c, a: a.a, b: a.b })),
    constraints: defCons,
  };
  let res: SolveResult;
  try {
    res = cachedSolve(def);
  } catch (e) {
    return host.fail(`Sketch ${s.name} could not be set up: ${(e as Error).message}`, s.nameSpan);
  }
  let message: string | undefined;
  if (!res.ok) {
    const culprit = firstConflict(def);
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
    if (c.kind === "line") {
      const a = P(c.pts[0]);
      const b = P(c.pts[1]);
      lines[c.id] = [a, b];
      fields[c.id] = lineObj(c.id, a, b);
    } else if (c.kind === "circle") {
      fields[c.id] = new Obj({ center: W(P(c.pts[0])), r: c.r!, d: 2 * c.r! }, "sketch circle", `${s.name}.${c.id}`);
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
  if (!sk.solved) parts.push("constraints conflict");
  else if (sk.dof === 0) parts.push("fully defined");
  else parts.push(`${sk.dof} degree${sk.dof === 1 ? "" : "s"} of freedom left`);
  if (sk.redundant) parts.push(`${sk.redundant} redundant constraint${sk.redundant > 1 ? "s" : ""}`);
  if (sk.profile.error) parts.push(`profile problem: ${sk.profile.error.message}`);
  else if (sk.profile.regions.length) parts.push(`${sk.profile.regions.length} closed region${sk.profile.regions.length > 1 ? "s" : ""}, area ${fmtNum(sk.profile.area, 1)} mm²`);
  else parts.push("no closed profile yet");
  return parts.join(", ");
}
