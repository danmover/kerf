// Runtime values for the Kerf evaluator.

import type { Path3, Profile, Sel, ShapeRecipe, V3 } from "../kernel/recipe";

export class Vec {
  constructor(public v: number[]) {}
  get x() {
    return this.v[0] ?? 0;
  }
  get y() {
    return this.v[1] ?? 0;
  }
  get z() {
    return this.v[2] ?? 0;
  }
  v3(): V3 {
    return [this.v[0] ?? 0, this.v[1] ?? 0, this.v[2] ?? 0];
  }
}

export class Obj {
  constructor(
    public fields: Record<string, Value>,
    public kind = "object",
    public label?: string,
  ) {}
}

export class ShapeV {
  constructor(public recipe: ShapeRecipe) {}
}

/** A closed 2D outline: circle(), rect(), polygon(), text(), offset() ... */
export class ProfileV {
  constructor(public recipe: Profile) {}
}

/** A 3D curve for sweep() and pipe(). */
export class PathV {
  constructor(public recipe: Path3) {}
}

/** A set of edges or faces, picked when the modifier using it runs. */
export class SelV {
  constructor(public sel: Sel) {}
}

/** A named feature inside a part (`add ... as boss`): boss.root, boss.edges, boss.faces ... */
export class FeatRef {
  constructor(
    public name: string,
    public op: string,
  ) {}
}

export class Fn {
  constructor(
    public name: string,
    public call: (args: Value[], named: Record<string, Value>, ctx: CallCtx) => Value,
    public doc?: string,
  ) {}
}

/** Reference to a part or a component by name (used by geometric requirement functions). */
export class Ref {
  constructor(
    public name: string,
    public what: "part" | "component",
  ) {}
}

/** A value that depends on geometry not computed yet (min_distance, volume...). */
export class Pending {
  constructor(public keys: string[]) {}
}

export type Value = number | string | boolean | Vec | Obj | ShapeV | ProfileV | PathV | SelV | FeatRef | Fn | Ref | Pending | Value[] | null;

export interface CallCtx {
  /** Raise an evaluation error attached to the current call site. */
  error(msg: string): never;
  /** Ask for a geometric quantity; returns the resolved number or a Pending marker. */
  geo(query: GeoQuery): number | Pending;
}

export type GeoQuery =
  | { q: "min_distance"; a: string; b: string }
  | { q: "volume"; a: string }
  | { q: "mass"; a: string }
  | { q: "bbox"; a: string; axis: "x" | "y" | "z"; side: "min" | "max" | "size" };

export function geoKey(q: GeoQuery): string {
  switch (q.q) {
    case "min_distance":
      return `min_distance(${[q.a, q.b].sort().join(",")})`;
    case "volume":
    case "mass":
      return `${q.q}(${q.a})`;
    case "bbox":
      return `bbox(${q.a}).${q.axis}${q.side}`;
  }
}

export function typeName(v: Value): string {
  if (v === null) return "nothing";
  if (Array.isArray(v)) return "list";
  if (v instanceof Vec) return v.v.length === 2 ? "2D vector" : "vector";
  if (v instanceof Obj) return v.kind;
  if (v instanceof ShapeV) return "shape";
  if (v instanceof ProfileV) return "profile";
  if (v instanceof PathV) return "path";
  if (v instanceof SelV) return "selection";
  if (v instanceof FeatRef) return "feature";
  if (v instanceof Fn) return "function";
  if (v instanceof Ref) return v.what;
  if (v instanceof Pending) return "pending geometry value";
  return typeof v;
}

export function fmtNum(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return String(n);
  const r = Math.round(n * 10 ** digits) / 10 ** digits;
  return Object.is(r, -0) ? "0" : String(r);
}

export function show(v: Value): string {
  if (typeof v === "number") return fmtNum(v, 3);
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean") return String(v);
  if (v === null) return "nothing";
  if (Array.isArray(v)) return "[" + v.slice(0, 6).map(show).join(", ") + (v.length > 6 ? `, … (${v.length})` : "") + "]";
  if (v instanceof Vec) return "(" + v.v.map((n) => fmtNum(n, 3)).join(", ") + ")";
  if (v instanceof Obj) return v.label ?? v.kind;
  if (v instanceof ShapeV) return `shape:${v.recipe.t}`;
  if (v instanceof ProfileV) return `profile:${v.recipe.t}`;
  if (v instanceof PathV) return `path:${v.recipe.t}`;
  if (v instanceof SelV) return "selection";
  if (v instanceof FeatRef) return `feature ${v.name}`;
  if (v instanceof Fn) return `${v.name}()`;
  if (v instanceof Ref) return v.name;
  return "…";
}
