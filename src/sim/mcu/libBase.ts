// The pieces every library function is built from: argument conversion as C++ does it, argument-count errors,
// the cost of a call, and def(), which makes a library function from its parameter types and what it does.
// The libraries (lib.ts and the lib*.ts beside it) share them.

import type { Pos } from "./ast";
import { BOOL, VOID, converter, isArith, isIntegral, strip, typeName, type CType, type Types } from "./ctypes";
import type { C, Ctx, Ev } from "./ir";
import type { Hal } from "./vm";

export type LibFn = (args: C[], ctx: Ctx, pos: Pos) => C;
export type LibMethod = (obj: C, args: C[], ctx: Ctx, pos: Pos) => C;
export interface LibClass {
  methods: Record<string, LibMethod>;
  /** `Type name(args);`: builds an instance from constructor arguments */
  construct?: (args: C[], ctx: Ctx, pos: Pos) => C;
  /** `Type name;`: an instance with no constructor arguments (its default constructor runs at power-up), with a class template's arguments */
  make?: (ctx: Ctx, targs?: number[]) => unknown;
  /** `if (obj)`, `!obj`: the class's operator bool (an SD File is true while it is open) */
  truthy?: (obj: unknown) => boolean;
}

/**
 * The C++ a library adds to a struct its header declares (FastLED's CRGB): the struct stays a real C struct in
 * memory (its size, arrays of it, pointers into it), and these give it the library's constructors, operators and
 * member functions, as C++ picks them.
 */
export interface LibStruct {
  /** a value of another type made into this one (CRGB c = CRGB::Red;), or null when the library has no such conversion */
  from?: (c: C, to: CType, ctx: Ctx, pos: Pos) => C | null;
  /** this one made into another type: its conversion operators, some only in a cast ((uint32_t)leds[i]), or null */
  to?: (c: C, to: CType, explicit: boolean, ctx: Ctx, pos: Pos) => C | null;
  /** an operator with this struct on either side, or null when there is none; compound assignment passes its own operator ("|="), which C++ can resolve to another overload */
  binary?: (op: string, a: C, b: C, ctx: Ctx, pos: Pos) => C | null;
  unary?: (op: string, a: C, ctx: Ctx, pos: Pos) => C | null;
  /** ++ and --: the new value */
  step?: (v: unknown, d: 1 | -1) => unknown;
  /** operator bool (if (leds[i])) */
  truthy?: (v: unknown) => boolean;
  methods?: Record<string, LibMethod>;
  /** other names for fields, from a union in the library's struct (CRGB's red is r) */
  alias?: Record<string, string>;
  /** operator[]: "self" indexes the struct's own fields (CRGB's raw[]), a number that field, an array (a palette's entries) */
  index?: "self" | number;
}

export const dict = <T>(o: Record<string, T>): Record<string, T> => Object.assign(Object.create(null) as Record<string, T>, o);

// ---------- argument helpers ----------

/** Arrays decay to pointers and references read through, as when passing an argument. */
export function decay(c: C): C {
  const t = c.t;
  if (t.k === "ref") return decay({ ...c, t: t.to });
  if (t.k === "arr") {
    const ev = c.ev;
    return { ...c, t: { k: "ptr", to: t.of }, ev: (f) => ({ m: ev(f), i: 0 }), lv: undefined, cv: undefined };
  }
  return c;
}

export function numEv(c: C, to: CType, ctx: Ctx, what: string): Ev {
  const r = decay(c);
  const from = strip(r.t);
  if (!isArith(from)) return ctx.error(`${what} needs a number here, not ${typeName(from)}`, c.pos);
  const conv = converter(to, from);
  if (!conv) return r.ev;
  if (r.cv !== undefined) {
    const v = conv(r.cv);
    return () => v;
  }
  const ev = r.ev;
  return (f) => conv(ev(f));
}

export function ptrEv(c: C, ctx: Ctx, what: string): Ev {
  const r = decay(c);
  const t = strip(r.t);
  if (t.k === "ptr") return r.ev;
  if (isIntegral(t) && r.cv === 0) return () => null;
  return ctx.error(`${what} needs a pointer or array here, not ${typeName(t)}`, c.pos);
}

export function fnEv(c: C, ctx: Ctx, what: string): Ev {
  const t = strip(c.t);
  if (t.k === "fn") return c.ev;
  if (t.k === "ptr" && t.to.k === "fn") return c.ev;
  if (isIntegral(t) && c.cv === 0) return () => null;
  return ctx.error(`${what} needs the name of a function here`, c.pos);
}

/** The element type a pointer or array argument points at. */
export function pointee(c: C): CType {
  const t = strip(c.t);
  return t.k === "arr" ? t.of : t.k === "ptr" ? t.to : VOID;
}

export function argCount(name: string, min: number, max: number, n: number, ctx: Ctx, pos: Pos): never {
  const want = min === max ? `${min}` : max === Infinity ? `at least ${min}` : `${min} to ${max}`;
  return ctx.error(`${name}() takes ${want} argument${want === "1" ? "" : "s"}, given ${n}`, pos);
}

export const sumCost = (args: C[]) => args.reduce((s, a) => s + a.cost, 0);

/** CPU work a library call does that depends on its data (formatting digits, copying bytes). */
export function burn(hal: Hal, cycles: number) {
  hal.cyc += Math.round(cycles);
  if (hal.cyc >= hal.nextEvt) hal.service();
}

/** a parameter's type; "obj" is a library object itself (the instance a method runs on), passed as it is */
export type PK = "int" | "uint" | "long" | "ulong" | "u8" | "double" | "float" | "size" | "bool" | "ptr" | "fn" | "obj";
export type RK = PK | "void" | "charp";

export function typeOf(k: RK, T: Types): CType {
  switch (k) {
    case "int":
      return T.int;
    case "uint":
      return T.uint;
    case "long":
      return T.long;
    case "ulong":
      return T.ulong;
    case "u8":
      return T.uchar;
    case "double":
      return T.double;
    case "float":
      return T.float;
    case "size":
      return T.sizeT;
    case "bool":
      return BOOL;
    case "ptr":
      return { k: "ptr", to: VOID };
    case "charp":
      return { k: "ptr", to: T.char };
    case "fn":
      return { k: "fn", ret: VOID, params: [] };
    case "void":
    case "obj":
      return VOID;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Run = (v: any[], ctx: Ctx, pos: Pos) => unknown;

/** A library function with fixed parameter types (converted as C++ would) and an estimated cost. */
export function def(name: string, params: PK[], ret: RK, cyc: number, run: Run, defaults: unknown[] = []): LibFn {
  return (args, ctx, pos) => {
    const min = params.length - defaults.length;
    if (args.length < min || args.length > params.length) argCount(name, min, params.length, args.length, ctx, pos);
    const what = `${name}()`;
    const evs: Ev[] = args.map((a, i) => (params[i] === "obj" ? (a.lv ? a.lv.get : a.ev) : params[i] === "ptr" ? ptrEv(a, ctx, what) : params[i] === "fn" ? fnEv(a, ctx, what) : numEv(a, typeOf(params[i], ctx.T), ctx, what)));
    for (let i = args.length; i < params.length; i++) {
      const d = defaults[i - min];
      evs.push(() => d);
    }
    const rt = typeOf(ret, ctx.T);
    const rc = isArith(rt) ? converter(rt, null) : null;
    const n = evs.length;
    const cost = sumCost(args) + cyc;
    let ev: Ev;
    if (n === 0) ev = rc ? () => rc(run([], ctx, pos) as number) : () => run([], ctx, pos);
    else if (n === 1) {
      const a = evs[0];
      ev = rc ? (f) => rc(run([a(f)], ctx, pos) as number) : (f) => run([a(f)], ctx, pos);
    } else
      ev = (f) => {
        const v = new Array(n);
        for (let i = 0; i < n; i++) v[i] = evs[i](f);
        const r = run(v, ctx, pos);
        return rc ? rc(r as number) : r;
      };
    return { t: rt, ev, cost, pos };
  };
}

/**
 * A method of a library class with fixed parameter types: `run` gets the instance it is called on (an object of
 * the library's own) and the converted arguments.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function method<O>(cls: string, name: string, params: PK[], ret: RK, cyc: number, run: (o: O, v: any[], ctx: Ctx, pos: Pos) => unknown, defaults: unknown[] = []): LibMethod {
  const d = def(`${cls}.${name}`, ["obj", ...params], ret, cyc, (v, ctx, pos) => run(v[0] as O, v.slice(1), ctx, pos), defaults);
  return (obj, args, ctx, pos) => {
    const min = params.length - defaults.length;
    if (args.length < min || args.length > params.length) argCount(`${cls}.${name}`, min, params.length, args.length, ctx, pos);
    return d([obj, ...args], ctx, pos);
  };
}
