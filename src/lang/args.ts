// Argument helper for builtin functions: positional + named args with
// type checks and clear errors listing what a function accepts.

import type { V2, V3 } from "../kernel/recipe";
import { Fn, Obj, Pending, ShapeV, typeName, Vec, type CallCtx, type Value } from "./values";
import { THREADS, type ThreadSpec } from "../library/standards";

export class Args {
  constructor(
    public fname: string,
    public pos: Value[],
    public named: Record<string, Value>,
    public ctx: CallCtx,
    /** accepted parameter names in positional order */
    public params: string[],
  ) {
    for (const k of Object.keys(named)) {
      if (!params.includes(k)) {
        ctx.error(`${fname}() has no argument "${k}". It accepts: ${params.join(", ")}`);
      }
    }
    if (pos.length > params.length) ctx.error(`${fname}() takes at most ${params.length} arguments, got ${pos.length}`);
  }

  raw(name: string): Value | undefined {
    const idx = this.params.indexOf(name);
    if (name in this.named) return this.named[name];
    if (idx >= 0 && idx < this.pos.length) return this.pos[idx];
    return undefined;
  }
  has(name: string) {
    return this.raw(name) !== undefined;
  }
  num(name: string, def?: number): number {
    const v = this.raw(name);
    if (v === undefined) {
      if (def === undefined) this.ctx.error(`${this.fname}() needs "${name}"`);
      return def;
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v)) this.ctx.error(`${this.fname}(): "${name}" is not a finite number`);
      return v;
    }
    if (typeof v === "boolean") return v ? 1 : 0;
    return this.ctx.error(`${this.fname}(): "${name}" should be a number, got ${typeName(v)}`);
  }
  positive(name: string, def?: number): number {
    const n = this.num(name, def);
    if (!(n > 0)) this.ctx.error(`${this.fname}(): "${name}" must be greater than 0 (got ${n})`);
    return n;
  }
  str(name: string, def?: string): string {
    const v = this.raw(name);
    if (v === undefined) {
      if (def === undefined) this.ctx.error(`${this.fname}() needs "${name}"`);
      return def;
    }
    if (typeof v === "string") return v;
    if (typeof v === "number") return String(v);
    if (v instanceof Obj && v.kind === "thread") return String(v.fields.name);
    return this.ctx.error(`${this.fname}(): "${name}" should be text, got ${typeName(v)}`);
  }
  bool(name: string, def = false): boolean {
    const v = this.raw(name);
    if (v === undefined) return def;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    return this.ctx.error(`${this.fname}(): "${name}" should be true or false`);
  }
  vec3(name: string, def?: V3): V3 {
    const v = this.raw(name);
    if (v === undefined) {
      if (def === undefined) this.ctx.error(`${this.fname}() needs "${name}"`);
      return def;
    }
    return toV3(v, this.ctx, `${this.fname}(): "${name}"`);
  }
  dir(name: string, def?: V3): V3 {
    const d = this.vec3(name, def);
    const l = Math.hypot(...d);
    if (l < 1e-9) this.ctx.error(`${this.fname}(): "${name}" must be a non-zero direction`);
    return [d[0] / l, d[1] / l, d[2] / l];
  }
  points2(name: string): V2[] {
    const v = this.raw(name);
    if (!Array.isArray(v)) this.ctx.error(`${this.fname}(): "${name}" should be a list of points like [(0, 0), (10, 0), (10, 5)]`);
    return v.map((p, i) => {
      if (p instanceof Vec) return [p.x, p.y] as V2;
      return this.ctx.error(`${this.fname}(): point ${i + 1} of "${name}" is ${typeName(p)}, expected (x, y)`);
    });
  }
  thread(name: string, def?: string): ThreadSpec {
    const v = this.raw(name);
    return toThread(v ?? def, this.ctx, `${this.fname}(): "${name}"`);
  }
  shape(name: string): ShapeV {
    const v = this.raw(name);
    if (v instanceof ShapeV) return v;
    return this.ctx.error(`${this.fname}(): "${name}" should be a shape, got ${v === undefined ? "nothing" : typeName(v)}`);
  }
  value(name: string): Value | undefined {
    return this.raw(name);
  }
  fn(name: string): Fn | undefined {
    const v = this.raw(name);
    return v instanceof Fn ? v : undefined;
  }
}

export function toV3(v: Value, ctx: CallCtx, what: string): V3 {
  if (v instanceof Vec) {
    if (v.v.length < 2 || v.v.length > 3) ctx.error(`${what} should be a 2D or 3D vector`);
    return [v.v[0], v.v[1], v.v[2] ?? 0];
  }
  if (v instanceof Pending) ctx.error(`${what} depends on geometry that is only known after the build`);
  return ctx.error(`${what} should be a vector like (x, y, z), got ${typeName(v)}`);
}

export function toThread(v: Value | undefined, ctx: CallCtx, what: string): ThreadSpec {
  if (v instanceof Obj && v.kind === "thread") return THREADS[String(v.fields.key)];
  if (typeof v === "string") {
    const key = v.replace(".", "_").toUpperCase();
    if (THREADS[key]) return THREADS[key];
  }
  return ctx.error(`${what} should be a metric thread size like M3 (available: ${Object.keys(THREADS).join(", ")})`);
}
