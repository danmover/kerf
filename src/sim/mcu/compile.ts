// Compiles the parsed firmware into JavaScript closures (no eval): each
// expression knows its C type, so integer arithmetic wraps at the chip's
// widths and floats round to 32 bits. Every statement charges an estimate
// of the CPU cycles it takes, which is how simulated time passes and when
// interrupts and the outside world get their turn.

import type { Expr, FuncDef, Pos, Program, Stmt, VarDecl } from "./ast";
import {
  BOOL,
  common,
  converter,
  intType,
  isArith,
  isIntegral,
  promote,
  sizeOf,
  strip,
  typeName,
  VOID,
  type CType,
  type Types,
} from "./ctypes";
import { CError } from "./lex";
import type { C, Ctx, Ev, Frame, LV } from "./ir";
import { LIB_FUNCS, LIB_OBJECTS, LIB_CLASSES, LIB_SCOPED, LIB_STRUCTS, newClassInstance, newLibState, resetLibState } from "./lib";
import type { LibStruct } from "./libBase";
import { castView, needsView } from "./mem";
import { AVR_REGISTERS, UNMODELLED_REGISTER } from "./registers";
import type { FnRef, Hal, Ptr } from "./vm";
import { Halt } from "./vm";
import type { DebugResult, FirmwareDebugger, SiteScope } from "./debug";

const NORMAL = 0;
const BREAK = 1;
const CONT = 2;
const RET = 3;
type St = (f: Frame) => number;

/** Cycle estimates for an 8-bit AVR at -Os (rough, ±30 %). */
const CYC = {
  load: 2,
  index: 6,
  field: 1,
  branch: 2,
  call: 14,
  ret: 8,
  intOp: (bits: number) => bits / 8,
  intMul: (bits: number) => (bits <= 8 ? 2 : bits <= 16 ? 10 : 40),
  intDiv: (bits: number) => (bits <= 16 ? 220 : 650),
  fAdd: 110,
  fMul: 140,
  fDiv: 480,
  fCmp: 60,
  fConv: 80,
};

/** Deepest call nesting before the chip would have run out of stack. */
const MAX_DEPTH = 120;

type Sym =
  | { k: "g"; slot: number; t: CType }
  | { k: "l"; slot: number; t: CType }
  | { k: "const"; v: number; t: CType }
  | { k: "fn"; fo: FnObj };

interface FnObj {
  name: string;
  def: FuncDef;
  ret: CType;
  nslots: number;
  frameBytes: number;
  body?: St;
  ref: FnRef;
}

export interface GlobalInfo {
  slot: number;
  t: CType;
}

export interface Firmware {
  /** call a firmware function by name (setup, loop, an interrupt handler) */
  call(name: string, args?: unknown[]): unknown;
  has(name: string): boolean;
  /** the functions the firmware defines (with a body) */
  fnNames: string[];
  /** value of a global variable for the timeline (numbers, or text for char pointers) */
  read(name: string): number | string | undefined;
  globals: Map<string, GlobalInfo>;
  /** RAM the globals and string literals take, bytes */
  staticRam: number;
  /** run the global initialisers (power-up) */
  reset(): void;
  /** what the debugger recorded, when the firmware was compiled with one */
  debug?: () => DebugResult;
}

const wrapInt = (t: CType): ((x: number) => number) => {
  if (t.k === "bool") return (x) => (x ? 1 : 0);
  if (t.k === "enum") return wrapInt(t.base);
  if (t.k !== "int") return (x) => x;
  switch (t.bits) {
    case 8:
      return t.signed ? (x) => (x << 24) >> 24 : (x) => x & 0xff;
    case 16:
      return t.signed ? (x) => (x << 16) >> 16 : (x) => x & 0xffff;
    case 32:
      return t.signed ? (x) => x | 0 : (x) => x >>> 0;
    default:
      return (x) => x;
  }
};

export function compileFirmware(prog: Program, T: Types, hal: Hal, dbg?: FirmwareDebugger): Firmware {
  return new Compiler(prog, T, hal, dbg).build();
}

class Compiler {
  G: unknown[] = [];
  gscope = new Map<string, Sym>();
  ginit: { slot: number; make: () => unknown }[] = [];
  globalsInfo = new Map<string, GlobalInfo>();
  fns = new Map<string, FnObj>();
  scopes: Map<string, Sym>[] = [];
  cur: FnObj | null = null;
  ret: unknown = undefined;
  depth = 0;
  stackBytes = 0;
  ctx: Ctx;
  staticRam = 0;

  constructor(
    private prog: Program,
    private T: Types,
    private hal: Hal,
    private dbg?: FirmwareDebugger,
  ) {
    const self = this;
    this.ctx = {
      T,
      abi: T.abi,
      hal,
      lib: newLibState(),
      structType: (name) => {
        const st = prog.structs?.get(name);
        return st?.lib ? st : undefined;
      },
      error(msg: string, pos: Pos): never {
        throw new CError(msg, pos.file, pos.line);
      },
      fault(msg: string, pos: Pos) {
        self.hal.fault(msg, pos.file, pos.line);
      },
    };
  }

  build(): Firmware {
    const { prog } = this;
    for (const [name, c] of prog.consts) this.gscope.set(name, { k: "const", v: c.v, t: c.type });
    for (const def of prog.funcs.values()) {
      const fo: FnObj = { name: def.name, def, ret: def.ret, nslots: 0, frameBytes: 0, ref: { fnName: def.name, call: () => undefined } };
      fo.ref.call = (args) => this.invoke(fo, args as Frame);
      this.fns.set(def.name, fo);
      this.gscope.set(def.name, { k: "fn", fo });
    }
    let ram = prog.ramStrings;
    for (const g of prog.globals) {
      ram += sizeOf(g.type, this.T.abi);
      const slot = this.G.length;
      this.G.push(undefined);
      this.gscope.set(g.name, { k: "g", slot, t: g.type });
      this.globalsInfo.set(g.name, { slot, t: g.type });
      this.ginit.push({ slot, make: this.initMaker(g) });
    }
    for (const fo of this.fns.values()) if (fo.def.body) this.compileFn(fo);
    this.dbg?.bind(this.G, this.globalsInfo);
    // statics found while compiling functions were added to the globals
    for (const info of this.globalsInfo.values()) void info;
    this.staticRam = ram + this.staticExtra;
    const self = this;
    return {
      call(name, args = []) {
        const fo = self.fns.get(name);
        if (!fo?.body) throw new CError(`The firmware has no ${name}() function`, "firmware", 0);
        return self.invoke(fo, args as Frame);
      },
      has: (name) => !!this.fns.get(name)?.body,
      fnNames: [...this.fns.values()].filter((f) => f.body).map((f) => f.name),
      read: (name) => this.readGlobal(name),
      globals: this.globalsInfo,
      staticRam: this.staticRam,
      ...(this.dbg ? { debug: () => this.dbg!.result() } : {}),
      reset: () => {
        for (let i = 0; i < this.G.length; i++) this.G[i] = undefined;
        resetLibState(this.ctx.lib);
        for (const g of this.ginit) this.G[g.slot] = g.make();
        this.depth = 0;
        this.stackBytes = 0;
      },
    };
  }

  staticExtra = 0;

  readGlobal(name: string): number | string | undefined {
    const g = this.globalsInfo.get(name);
    if (!g) return undefined;
    const v = this.G[g.slot];
    if (typeof v === "number") return v;
    if (g.t.k === "ptr" && v && typeof v === "object" && "m" in v) {
      const p = v as Ptr;
      const out: number[] = [];
      for (let i = p.i; i < p.m.length && out.length < 200; i++) {
        const c = p.m[i] as number;
        if (!c) break;
        out.push(c);
      }
      return String.fromCharCode(...out);
    }
    return undefined;
  }

  // ---------- calls ----------

  invoke(fo: FnObj, frame: Frame): unknown {
    const hal = this.hal;
    hal.cyc += CYC.call;
    if (++this.depth > MAX_DEPTH) {
      this.depth = 0;
      hal.fault(`${fo.name}() nested ${MAX_DEPTH} calls deep: the chip would run out of stack`, fo.def.file, fo.def.line);
      throw new Halt("stack overflow");
    }
    this.stackBytes += fo.frameBytes;
    hal.stack(this.stackBytes);
    if (frame.length < fo.nslots) frame.length = fo.nslots;
    const dbg = this.dbg;
    dbg?.enter(fo.name, frame);
    try {
      fo.body!(frame);
    } finally {
      this.depth--;
      this.stackBytes -= fo.frameBytes;
      dbg?.leave();
    }
    hal.cyc += CYC.ret;
    const r = this.ret;
    this.ret = undefined;
    return r;
  }

  // ---------- values ----------

  zero(t: CType): unknown {
    switch (t.k) {
      case "arr": {
        const n = Math.max(0, t.n);
        const a = new Array(n);
        if (t.of.k === "arr" || t.of.k === "struct" || t.of.k === "class") for (let i = 0; i < n; i++) a[i] = this.zero(t.of);
        else a.fill(t.of.k === "ptr" || t.of.k === "fn" ? null : 0);
        return a;
      }
      case "struct":
        if (!t.complete) throw new CError(`struct ${t.name} is used before it is defined`, "firmware", 0);
        return t.fields.map((f) => this.zero(f.type));
      case "ptr":
      case "fn":
        return null;
      case "class":
        return newClassInstance(t.name, this.ctx);
      default:
        return 0;
    }
  }

  copier(t: CType): ((v: unknown) => unknown) | null {
    if (t.k === "struct") {
      const fc = t.fields.map((f) => this.copier(f.type));
      return (v) => (v as unknown[]).map((x, i) => (fc[i] ? fc[i]!(x) : x));
    }
    if (t.k === "arr") {
      const ec = this.copier(t.of);
      return (v) => (ec ? (v as unknown[]).map(ec) : (v as unknown[]).slice());
    }
    return null;
  }

  /** Build the value of a declaration's initializer (globals and statics run this at power-up). */
  initMaker(v: VarDecl): () => unknown {
    if (!v.init) return () => this.zero(v.type);
    const ev = this.initEv(v.type, v.init);
    const frame: Frame = [];
    return () => ev(frame);
  }

  initEv(t: CType, init: Expr): Ev {
    if (t.k === "ref") throw new CError("Reference variables are not supported; use a pointer", init.file, init.line);
    if (t.k === "class") {
      const make = LIB_CLASSES[t.name]?.construct;
      // Type name = Type(arguments); builds it the same way
      if (init.k === "call" && init.fn.k === "id" && init.fn.name === t.name && make) return make(init.args.map((x) => this.expr(x)), this.ctx, init).ev;
      // a copy of another one (File f = SD.open(...)): a library object is a handle, so both name the same thing
      if (init.k !== "init") {
        const c = this.rvalue(this.expr(init));
        const ct = strip(c.t);
        if (ct.k === "class" && ct.name === t.name) return c.ev;
      }
      if (init.k !== "init" || !make) throw new CError(`${t.name} cannot be set up that way here: declare it as ${t.name} name; or ${t.name} name(arguments);`, init.file, init.line);
      return make(init.items.map((x) => this.expr(x)), this.ctx, init).ev;
    }
    if (init.k === "init") {
      if (t.k === "arr") {
        const items = init.items.map((it) => this.initEv(t.of, it));
        const n = t.n;
        return (f) => {
          const a = this.zero(t) as unknown[];
          for (let i = 0; i < items.length && i < n; i++) a[i] = items[i](f);
          return a;
        };
      }
      if (t.k === "struct") {
        if (init.items.length > t.fields.length) throw new CError(`Too many values for struct ${t.name}`, init.file, init.line);
        const items = init.items.map((it, i) => this.initEv(t.fields[i].type, it));
        return (f) => {
          const s = this.zero(t) as unknown[];
          for (let i = 0; i < items.length; i++) s[i] = items[i](f);
          return s;
        };
      }
      if (init.items.length === 1) return this.initEv(t, init.items[0]);
      if (init.items.length === 0) return () => this.zero(t);
      throw new CError(`A braced list cannot initialise a ${typeName(t)}`, init.file, init.line);
    }
    if (t.k === "arr" && init.k === "str" && t.of.k === "int" && t.of.bits === 8) {
      const bytes = init.bytes;
      return () => {
        const a = this.zero(t) as number[];
        for (let i = 0; i < bytes.length && i < a.length; i++) a[i] = bytes[i];
        return a;
      };
    }
    const c = this.rvalue(this.expr(init));
    return this.convertTo(c, t, init).ev;
  }

  // ---------- functions ----------

  compileFn(fo: FnObj) {
    const def = fo.def;
    this.cur = fo;
    this.scopes = [new Map()];
    let slots = 0;
    let bytes = 4;
    for (const p of def.params) {
      if (p.name) this.scopes[0].set(p.name, { k: "l", slot: slots, t: p.type });
      slots++;
      bytes += p.type.k === "ref" ? this.T.abi.ptrBytes : sizeOf(p.type, this.T.abi);
    }
    this.slotCount = slots;
    this.frameBytes = bytes;
    const body = this.block(def.body!, false);
    fo.nslots = this.slotCount;
    fo.frameBytes = this.frameBytes;
    const isVoid = def.ret.k === "void";
    fo.body = isVoid
      ? body
      : (f) => {
          const s = body(f);
          if (s !== RET) this.ret = 0;
          return s;
        };
    this.cur = null;
  }

  slotCount = 0;
  frameBytes = 0;

  lookup(name: string): Sym | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const s = this.scopes[i].get(name);
      if (s) return s;
    }
    return this.gscope.get(name);
  }

  // ---------- statements ----------

  charge(cost: number): (f: Frame) => void {
    const hal = this.hal;
    const c = Math.max(1, Math.round(cost));
    return () => {
      hal.cyc += c;
      if (hal.cyc >= hal.nextEvt) hal.service();
    };
  }

  block(b: Extract<Stmt, { k: "block" }>, scope = true): St {
    if (scope) this.scopes.push(new Map());
    const list = b.body.map((s) => this.stmt(s));
    if (scope) this.scopes.pop();
    const n = list.length;
    if (n === 0) return () => NORMAL;
    if (n === 1) return list[0];
    return (f) => {
      for (let i = 0; i < n; i++) {
        const s = list[i](f);
        if (s) return s;
      }
      return NORMAL;
    };
  }

  /** A statement; with a debugger, it hears of the statement before it runs. */
  stmt(s: Stmt): St {
    const dbg = this.dbg;
    if (!dbg || !this.cur || s.k === "block" || s.k === "empty" || s.k === "case" || s.k === "default") return this.stmtCore(s);
    // the scope before the statement: a declaration's own name isn't set yet when it stops there
    const si = dbg.site(s, this.cur.name, this.siteScope());
    const inner = this.stmtCore(s);
    return (f) => {
      dbg.at(si, f);
      return inner(f);
    };
  }

  /** The variables in scope here, and a way to compile an expression here later (the debugger's watches). */
  siteScope(): SiteScope {
    const snap = this.scopes.map((m) => new Map(m));
    const fo = this.cur;
    const seen = new Map<string, SiteScope["vars"][number]>();
    for (const m of snap)
      for (const [name, sym] of m) {
        if (sym.k === "l") seen.set(name, { name, slot: sym.slot, t: sym.t, global: false });
        else if (sym.k === "g") seen.set(name, { name, slot: sym.slot, t: sym.t, global: true });
      }
    return {
      vars: [...seen.values()],
      compile: (e) => {
        const saved = { scopes: this.scopes, cur: this.cur };
        this.scopes = snap;
        this.cur = fo;
        try {
          const c = this.rvalue(this.expr(e));
          return { ev: c.ev, t: c.t };
        } finally {
          this.scopes = saved.scopes;
          this.cur = saved.cur;
        }
      },
    };
  }

  stmtCore(s: Stmt): St {
    const hal = this.hal;
    switch (s.k) {
      case "block":
        return this.block(s);
      case "empty":
      case "case":
      case "default":
        return () => NORMAL;
      case "expr": {
        const e = this.expr(s.e);
        const ev = e.ev;
        const c = Math.max(1, Math.round(e.cost + 1));
        return (f) => {
          hal.cyc += c;
          if (hal.cyc >= hal.nextEvt) hal.service();
          ev(f);
          return NORMAL;
        };
      }
      case "decl":
        return this.decl(s.vars);
      case "if": {
        const c = this.cond(s.c);
        const cc = Math.max(1, Math.round(c.cost + CYC.branch));
        const th = this.scoped(s.t);
        const el = s.e ? this.scoped(s.e) : null;
        const ev = c.ev;
        if (el)
          return (f) => {
            hal.cyc += cc;
            if (hal.cyc >= hal.nextEvt) hal.service();
            return ev(f) ? th(f) : el(f);
          };
        return (f) => {
          hal.cyc += cc;
          if (hal.cyc >= hal.nextEvt) hal.service();
          return ev(f) ? th(f) : NORMAL;
        };
      }
      case "while": {
        const c = this.cond(s.c);
        const cc = Math.max(1, Math.round(c.cost + CYC.branch));
        const body = this.scoped(s.body);
        const ev = c.ev;
        return (f) => {
          for (;;) {
            hal.cyc += cc;
            if (hal.cyc >= hal.nextEvt) hal.service();
            if (!ev(f)) return NORMAL;
            const r = body(f);
            if (r === BREAK) return NORMAL;
            if (r === RET) return RET;
          }
        };
      }
      case "do": {
        const body = this.scoped(s.body);
        const c = this.cond(s.c);
        const cc = Math.max(1, Math.round(c.cost + CYC.branch));
        const ev = c.ev;
        return (f) => {
          for (;;) {
            const r = body(f);
            if (r === BREAK) return NORMAL;
            if (r === RET) return RET;
            hal.cyc += cc;
            if (hal.cyc >= hal.nextEvt) hal.service();
            if (!ev(f)) return NORMAL;
          }
        };
      }
      case "for": {
        this.scopes.push(new Map());
        const init = s.init ? this.stmt(s.init) : null;
        const c = s.c ? this.cond(s.c) : null;
        const cc = Math.max(1, Math.round((c?.cost ?? 0) + CYC.branch));
        const step = s.step ? this.expr(s.step) : null;
        const sc = Math.max(1, Math.round((step?.cost ?? 0) + 1));
        const body = this.scoped(s.body);
        this.scopes.pop();
        const cev = c?.ev;
        const sev = step?.ev;
        return (f) => {
          if (init) init(f);
          for (;;) {
            hal.cyc += cc;
            if (hal.cyc >= hal.nextEvt) hal.service();
            if (cev && !cev(f)) return NORMAL;
            const r = body(f);
            if (r === BREAK) return NORMAL;
            if (r === RET) return RET;
            if (sev) {
              hal.cyc += sc;
              sev(f);
            }
          }
        };
      }
      case "switch": {
        const e = this.rvalue(this.expr(s.e));
        if (!isIntegral(strip(e.t))) this.fail("switch needs an integer", s);
        const pt = promote(strip(e.t), this.T);
        const conv = converter(pt, strip(e.t)) ?? ((x: number) => x);
        this.scopes.push(new Map());
        const list = s.body.map((x) => this.stmt(x));
        this.scopes.pop();
        const cases = new Map<number, number>();
        let def = -1;
        s.body.forEach((x, i) => {
          if (x.k === "case") {
            const v = this.constValue(x.v);
            const cv = wrapInt(pt)(v);
            if (cases.has(cv)) this.fail(`case ${v} appears twice`, x);
            cases.set(cv, i);
          } else if (x.k === "default") def = i;
        });
        const n = list.length;
        const ev = e.ev;
        const cc = Math.max(1, Math.round(e.cost + 4 + cases.size));
        return (f) => {
          hal.cyc += cc;
          if (hal.cyc >= hal.nextEvt) hal.service();
          let i = cases.get(conv(ev(f))) ?? def;
          if (i < 0) return NORMAL;
          for (; i < n; i++) {
            const r = list[i](f);
            if (r === BREAK) return NORMAL;
            if (r) return r;
          }
          return NORMAL;
        };
      }
      case "break":
        return () => BREAK;
      case "continue":
        return () => CONT;
      case "return": {
        const fo = this.cur!;
        if (!s.e) {
          if (fo.ret.k !== "void") this.fail(`${fo.name}() must return a value`, s);
          return () => RET;
        }
        if (fo.ret.k === "void") this.fail(`${fo.name}() is void and cannot return a value`, s);
        const c = this.convertTo(this.rvalue(this.expr(s.e)), fo.ret, s.e);
        const ev = c.ev;
        const cp = this.copier(fo.ret);
        const cost = Math.max(1, Math.round(c.cost + 2));
        return (f) => {
          hal.cyc += cost;
          if (hal.cyc >= hal.nextEvt) hal.service();
          this.ret = cp ? cp(ev(f)) : ev(f);
          return RET;
        };
      }
    }
  }

  /** A statement in its own scope (the body of an if or loop). */
  scoped(s: Stmt): St {
    this.scopes.push(new Map());
    const r = this.stmt(s);
    this.scopes.pop();
    return r;
  }

  decl(vars: VarDecl[]): St {
    const hal = this.hal;
    const parts: St[] = [];
    for (const v of vars) {
      const scope = this.scopes[this.scopes.length - 1];
      if (v.type.k === "ref") {
        parts.push(this.refDecl(v, scope));
        continue;
      }
      if (v.storage === "static") {
        const slot = this.G.length;
        this.G.push(undefined);
        const make = this.initMaker(v);
        this.ginit.push({ slot, make });
        this.staticExtra += sizeOf(v.type, this.T.abi);
        scope.set(v.name, { k: "g", slot, t: v.type });
        this.globalsInfo.set(`${this.cur!.name}::${v.name}`, { slot, t: v.type });
        continue;
      }
      const slot = this.slotCount++;
      this.frameBytes += sizeOf(v.type, this.T.abi);
      // the name is visible in its own initializer only after it, as in C
      if (v.init) {
        const ev = this.initEv(v.type, v.init);
        const isAgg = v.type.k === "struct" || v.type.k === "arr";
        const cp = isAgg && v.init.k !== "init" && v.init.k !== "str" ? this.copier(v.type) : null;
        scope.set(v.name, { k: "l", slot, t: v.type });
        const cost = Math.max(1, Math.round(CYC.load * 2 + 2));
        parts.push((f) => {
          hal.cyc += cost;
          if (hal.cyc >= hal.nextEvt) hal.service();
          f[slot] = cp ? cp(ev(f)) : ev(f);
          return NORMAL;
        });
      } else {
        scope.set(v.name, { k: "l", slot, t: v.type });
        const t = v.type;
        const simple = isArith(t);
        parts.push(
          simple
            ? (f) => {
                f[slot] = 0;
                return NORMAL;
              }
            : (f) => {
                f[slot] = this.zero(t);
                return NORMAL;
              },
        );
      }
    }
    if (parts.length === 1) return parts[0];
    return (f) => {
      for (const p of parts) p(f);
      return NORMAL;
    };
  }

  /** A local reference (Motor &m = motors[i]): the slot holds where it points. */
  refDecl(v: VarDecl, scope: Map<string, Sym>): St {
    const hal = this.hal;
    const rt = v.type as Extract<CType, { k: "ref" }>;
    if (!v.init) this.fail(`The reference ${v.name} must be given a variable to refer to`, v);
    if (v.storage === "static") this.fail("static references are not supported; use a pointer", v);
    const c = this.expr(v.init);
    let P: (f: Frame) => Ptr;
    if (c.lv && !needsView(strip(c.t), rt.to) && strip(c.t).k === strip(rt.to).k) P = c.lv.ptr;
    else {
      // a const reference to a temporary keeps its own copy
      const ev = this.convertTo(this.rvalue(c), rt.to, v.init).ev;
      P = (f) => ({ m: [ev(f)], i: 0 });
    }
    const slot = this.slotCount++;
    this.frameBytes += this.T.abi.ptrBytes;
    scope.set(v.name, { k: "l", slot, t: v.type });
    return (f) => {
      hal.cyc += 4;
      if (hal.cyc >= hal.nextEvt) hal.service();
      f[slot] = P(f);
      return NORMAL;
    };
  }

  // ---------- expressions ----------

  fail(msg: string, pos: Pos): never {
    throw new CError(msg, pos.file, pos.line);
  }

  constValue(e: Expr): number {
    const c = this.expr(e);
    if (c.cv === undefined) this.fail("case needs a constant", e);
    return c.cv;
  }

  /** Condition: anything scalar, tested against zero. */
  cond(e: Expr): C {
    const c = this.truthOf(this.rvalue(this.expr(e)));
    const t = strip(c.t);
    if (!isArith(t) && t.k !== "ptr") this.fail(`A condition needs a number or pointer, not ${typeName(t)}`, e);
    return c;
  }

  /** A library object tested as a condition (if (file), !file) goes through its operator bool. */
  truthOf(c: C): C {
    const t = strip(c.t);
    const truthy = t.k === "class" ? LIB_CLASSES[t.name]?.truthy : this.libStruct(t)?.truthy;
    if (!truthy) return c;
    const ev = c.lv ? c.lv.get : c.ev;
    return { t: BOOL, ev: (f) => (truthy(ev(f)) ? 1 : 0), cost: c.cost + 4, pos: c.pos };
  }

  /** Arrays decay to pointers, references read through, functions become function references. */
  rvalue(c: C): C {
    const t = c.t;
    if (t.k === "ref") return this.rvalue({ ...c, t: t.to });
    if (t.k === "arr") {
      const ev = c.ev;
      return { t: { k: "ptr", to: t.of }, ev: (f) => ({ m: ev(f), i: 0 }), cost: c.cost, pos: c.pos };
    }
    return c;
  }

  /** the library's C++ for a struct its header declares (FastLED's CRGB): operators, conversions, member functions */
  libStruct(t: CType): LibStruct | undefined {
    const s = strip(t);
    return s.k === "struct" && s.lib ? LIB_STRUCTS[s.name] : undefined;
  }

  convertTo(c: C, to: CType, pos: Pos, explicit = false): C {
    const from = strip(c.t);
    to = strip(to);
    if (to.k === "void") return { ...c, t: VOID };
    // a library struct's conversion operators: (uint32_t)leds[i], a palette passed as CRGB*
    if (from.k === "struct" && !(to.k === "struct" && to.name === from.name)) {
      const out = this.libStruct(from)?.to?.(c, to, explicit, this.ctx, pos);
      if (out) return out;
    }
    if (isArith(to)) {
      if (from.k === "ptr" && to.k === "bool") {
        const ev = c.ev;
        return { t: BOOL, ev: (f) => (ev(f) ? 1 : 0), cost: c.cost, pos };
      }
      if (!isArith(from)) this.fail(`Cannot use ${typeName(from)} as ${typeName(to)}`, pos);
      const conv = converter(to, from);
      if (!conv) return { ...c, t: to };
      if (c.cv !== undefined) {
        const v = conv(c.cv);
        return { t: to, ev: () => v, cost: 0, cv: v, pos };
      }
      const ev = c.ev;
      const extra = (from.k === "float") !== (to.k === "float") ? CYC.fConv : 0;
      return { t: to, ev: (f) => conv(ev(f)), cost: c.cost + extra, pos };
    }
    if (to.k === "ptr") {
      if (from.k === "ptr") return this.retarget(c, from.to, to);
      if (from.k === "fn") return { ...c, t: to };
      if (isIntegral(from) && c.cv === 0) return { t: to, ev: () => null, cost: 0, pos };
      this.fail(`Cannot use ${typeName(from)} as a pointer`, pos);
    }
    if (to.k === "struct") {
      if (from.k === "struct" && from.name === to.name) return c;
      // a library's converting constructor: CRGB c = CRGB::Red; leds[i] = CHSV(h, 255, 255);
      const made = this.libStruct(to)?.from?.(c, to, this.ctx, pos);
      if (made) return made;
      this.fail(`Cannot use ${typeName(from)} as ${typeName(to)}`, pos);
    }
    if (to.k === "fn") return c;
    if (to.k === "class") {
      if (from.k !== "class" || from.name !== to.name) this.fail(`Cannot use ${typeName(from)} as ${typeName(to)}`, pos);
      return c;
    }
    return c;
  }

  /** A pointer seen as a pointer to another type: reads and writes go through the bytes, as on the chip. */
  retarget(c: C, from: CType, to: Extract<CType, { k: "ptr" }>): C {
    if (!needsView(from, to.to)) return { ...c, t: to };
    const P = c.ev;
    const abi = this.T.abi;
    return { t: to, ev: (f) => { const p = P(f) as Ptr | null; return p ? castView(p, from, to.to, abi) : null; }, cost: c.cost, pos: c.pos };
  }

  numConst(v: number, t: CType, pos: Pos): C {
    return { t, ev: () => v, cost: 0, cv: v, pos };
  }

  expr(e: Expr): C {
    switch (e.k) {
      case "num":
        return this.numConst(e.v, e.type, e);
      case "str": {
        const mem = [...e.bytes, 0];
        const p: Ptr = { m: mem, i: 0, ro: true };
        return { t: { k: "ptr", to: this.T.char }, ev: () => p, cost: 1, lit: e.bytes, pos: e };
      }
      case "id":
        return this.ident(e);
      case "bin":
        return this.binary(e.op, this.expr(e.a), this.expr(e.b), e);
      case "logic": {
        const ca = this.cond(e.a);
        const a = ca.ev;
        const b = this.cond(e.b);
        const bev = b.ev;
        return {
          t: BOOL,
          ev: e.op === "&&" ? (f) => (a(f) && bev(f) ? 1 : 0) : (f) => (a(f) || bev(f) ? 1 : 0),
          cost: ca.cost + b.cost + CYC.branch * 2,
          pos: e,
        };
      }
      case "un":
        return this.unary(e);
      case "post":
        return this.incdec(this.expr(e.a), e.op === "++" ? 1 : -1, true, e);
      case "assign":
        return this.assign(e);
      case "cond": {
        const c = this.cond(e.c);
        const a = this.rvalue(this.expr(e.a));
        const b = this.rvalue(this.expr(e.b));
        const ta = strip(a.t);
        const tb = strip(b.t);
        let t: CType;
        if (isArith(ta) && isArith(tb)) t = common(ta, tb, this.T);
        else if (ta.k === "ptr") t = ta;
        else if (tb.k === "ptr") t = tb;
        else t = ta;
        const A = this.convertTo(a, t, e.a).ev;
        const B = this.convertTo(b, t, e.b).ev;
        const cev = c.ev;
        return { t, ev: (f) => (cev(f) ? A(f) : B(f)), cost: c.cost + Math.max(a.cost, b.cost) + CYC.branch, pos: e };
      }
      case "call":
        return this.call(e);
      case "idx":
        return this.index(e);
      case "mem":
        return this.member(e);
      case "cast": {
        const a = this.rvalue(this.expr(e.a));
        const to = e.type;
        const from = strip(a.t);
        if (to.k === "ptr" && isIntegral(from) && a.cv !== 0) this.fail("Casting a number to a pointer is not supported", e);
        if (to.k === "ptr" && from.k === "ptr") return this.retarget(a, from.to, to);
        return this.convertTo(a, to, e, true);
      }
      case "sizeofT":
        return this.numConst(sizeOf(e.type, this.T.abi), this.T.sizeT, e);
      case "sizeofE": {
        const a = this.expr(e.a);
        return this.numConst(sizeOf(strip(a.t), this.T.abi), this.T.sizeT, e);
      }
      case "comma": {
        const a = this.expr(e.a).ev;
        const b = this.expr(e.b);
        const bev = b.ev;
        return { ...b, ev: (f) => (a(f), bev(f)), lv: undefined, cv: undefined };
      }
      case "init":
        return this.fail("A braced list can only initialise a variable", e);
    }
  }

  ident(e: Extract<Expr, { k: "id" }>): C {
    const name = e.name;
    if (name === "NULL") return { t: { k: "ptr", to: VOID }, ev: () => null, cost: 0, cv: 0, pos: e };
    const s = this.lookup(name);
    if (!s) {
      if (name.includes("::")) {
        const scoped = LIB_SCOPED[name];
        if (scoped) return scoped([], this.ctx, e);
        const [cls, member] = name.split("::");
        return this.fail(LIB_CLASSES[cls] || LIB_OBJECTS[cls] ? `${cls} has no ${member} in the simulator` : `"${name}" is not declared`, e);
      }
      if (AVR_REGISTERS.has(name)) return this.ioRegister(name, e);
      const asValue = LIB_OBJECTS[name]?.["@value"];
      if (asValue) return asValue([], this.ctx, e);
      if (LIB_OBJECTS[name]) return this.fail(`${name} is a library object; call one of its functions, like ${name}.begin()`, e);
      if (LIB_FUNCS[name]) return this.fail(`${name} is a function; call it with ()`, e);
      return this.fail(`"${name}" is not declared`, e);
    }
    if (s.k === "const") return this.numConst(s.v, s.t, e);
    if (s.k === "fn") {
      const ref = s.fo.ref;
      return { t: { k: "fn", ret: s.fo.ret, params: s.fo.def.params.map((p) => p.type) }, ev: () => ref, cost: 1, pos: e };
    }
    const slot = s.slot;
    const t = s.t;
    // an array, struct or object named here is used through its address (indexing, a member, decay to a
    // pointer): only a value is loaded in full
    const st = strip(t);
    const loadCost = st.k === "arr" || st.k === "struct" || st.k === "class" ? CYC.load : CYC.load * Math.max(1, sizeOf(st, this.T.abi) / 2);
    if (s.k === "g") {
      const G = this.G;
      const lv: LV = {
        get: () => G[slot],
        set: (_f, v) => {
          G[slot] = v;
        },
        ptr: () => ({ m: G, i: slot }),
      };
      return { t, ev: lv.get, lv, cost: loadCost, pos: e };
    }
    if (t.k === "ref") {
      const lv: LV = {
        get: (f) => {
          const p = f[slot] as Ptr;
          return p.m[p.i];
        },
        set: (f, v) => {
          const p = f[slot] as Ptr;
          p.m[p.i] = v;
        },
        ptr: (f) => f[slot] as Ptr,
      };
      return { t: t.to, ev: lv.get, lv, cost: loadCost + 2, pos: e };
    }
    const lv: LV = {
      get: (f) => f[slot],
      set: (f, v) => {
        f[slot] = v;
      },
      ptr: (f) => ({ m: f, i: slot }),
    };
    return { t, ev: lv.get, lv, cost: loadCost, pos: e };
  }

  /** A register of the chip's peripherals (ADCSRA, SREG): every read and write goes to the board. */
  ioRegister(name: string, e: Pos): C {
    const r = this.hal.register?.(name);
    if (!r) return this.fail(UNMODELLED_REGISTER(name, "ATmega328P"), e);
    const t = intType(r.bits, false, r.bits === 8 ? "uint8_t" : "uint16_t");
    const mask = r.bits === 8 ? 0xff : 0xffff;
    const cell = new Proxy([] as unknown[], {
      get: (_t, k) => (k === "length" ? 1 : k === "0" ? r.read() : undefined),
      set: (_t, k, v) => (k === "0" && r.write(Number(v) & mask), true),
    });
    const lv: LV = { get: () => r.read(), set: (_f, v) => r.write(Number(v) & mask), ptr: () => ({ m: cell, i: 0 }) };
    // lds / sts: two cycles each way
    return { t, ev: lv.get, lv, cost: 2 * (r.bits / 8), pos: e };
  }

  binary(op: string, a0: C, b0: C, pos: Pos): C {
    const a = this.rvalue(a0);
    const b = this.rvalue(b0);
    const ta = strip(a.t);
    const tb = strip(b.t);
    const T = this.T;
    // a library struct's operators: leds[i] + CRGB(10, 0, 0), leds[i] == CRGB::Black
    const sa = this.libStruct(ta);
    const sb = this.libStruct(tb);
    if (sa || sb) {
      const r = sa?.binary?.(op, a, b, this.ctx, pos) ?? (sb !== sa ? sb?.binary?.(op, a, b, this.ctx, pos) : null);
      if (r) return r;
      this.fail(`Cannot use ${op} on ${typeName(ta)} and ${typeName(tb)}`, pos);
    }
    // pointers
    if (ta.k === "ptr" || tb.k === "ptr") return this.pointerOp(op, a, b, pos);
    if (!isArith(ta) || !isArith(tb)) this.fail(`Cannot use ${op} on ${typeName(ta)} and ${typeName(tb)}`, pos);
    const isShift = op === "<<" || op === ">>";
    const ct = isShift ? promote(ta, T) : common(ta, tb, T);
    const ca = this.convertTo(a, ct, pos);
    const cb = isShift ? this.convertTo(b, promote(tb, T), pos) : this.convertTo(b, ct, pos);
    const A = ca.ev;
    const B = cb.ev;
    const cost0 = ca.cost + cb.cost;
    const cmp = op === "<" || op === ">" || op === "<=" || op === ">=" || op === "==" || op === "!=";
    let ev: Ev;
    let cost: number;
    let rt: CType = cmp ? BOOL : ct;
    if (ct.k === "float") {
      const fr = ct.bits === 32 ? Math.fround : (x: number) => x;
      switch (op) {
        case "+":
          ev = (f) => fr(A(f) + B(f));
          cost = CYC.fAdd;
          break;
        case "-":
          ev = (f) => fr(A(f) - B(f));
          cost = CYC.fAdd;
          break;
        case "*":
          ev = (f) => fr(A(f) * B(f));
          cost = CYC.fMul;
          break;
        case "/":
          ev = (f) => fr(A(f) / B(f));
          cost = CYC.fDiv;
          break;
        case "<":
          ev = (f) => (A(f) < B(f) ? 1 : 0);
          cost = CYC.fCmp;
          break;
        case ">":
          ev = (f) => (A(f) > B(f) ? 1 : 0);
          cost = CYC.fCmp;
          break;
        case "<=":
          ev = (f) => (A(f) <= B(f) ? 1 : 0);
          cost = CYC.fCmp;
          break;
        case ">=":
          ev = (f) => (A(f) >= B(f) ? 1 : 0);
          cost = CYC.fCmp;
          break;
        case "==":
          ev = (f) => (A(f) === B(f) ? 1 : 0);
          cost = CYC.fCmp;
          break;
        case "!=":
          ev = (f) => (A(f) !== B(f) ? 1 : 0);
          cost = CYC.fCmp;
          break;
        default:
          return this.fail(`${op} needs whole numbers, not ${typeName(ct)}`, pos);
      }
    } else {
      const it = ct as Extract<CType, { k: "int" }>;
      const bits = it.bits;
      const w = wrapInt(ct);
      const hal = this.hal;
      const divFault = () => hal.fault("Division by zero (the chip returns garbage)", pos.file, pos.line);
      const io = CYC.intOp(bits);
      switch (op) {
        case "+":
          ev = (f) => w(A(f) + B(f));
          cost = io;
          break;
        case "-":
          ev = (f) => w(A(f) - B(f));
          cost = io;
          break;
        case "*":
          ev = bits === 32 ? (it.signed ? (f) => Math.imul(A(f), B(f)) : (f) => Math.imul(A(f), B(f)) >>> 0) : bits === 64 ? (f) => A(f) * B(f) : (f) => w(A(f) * B(f));
          cost = CYC.intMul(bits);
          break;
        case "/":
          ev = (f) => {
            const x = A(f);
            const y = B(f);
            if (y === 0) {
              divFault();
              return w(-1);
            }
            return w(Math.trunc(x / y));
          };
          cost = CYC.intDiv(bits);
          break;
        case "%":
          ev = (f) => {
            const x = A(f);
            const y = B(f);
            if (y === 0) {
              divFault();
              return w(x);
            }
            return w(x % y);
          };
          cost = CYC.intDiv(bits);
          break;
        case "<<":
          ev = bits === 64 ? (f) => A(f) * 2 ** B(f) : (f) => w(A(f) << (B(f) & 31));
          cost = io * 2;
          break;
        case ">>":
          ev = it.signed ? (bits === 64 ? (f) => Math.floor(A(f) / 2 ** B(f)) : (f) => A(f) >> (B(f) & 31)) : bits === 32 ? (f) => A(f) >>> (B(f) & 31) : (f) => A(f) >> (B(f) & 31);
          cost = io * 2;
          break;
        case "&":
          ev = (f) => w(A(f) & B(f));
          cost = io;
          break;
        case "|":
          ev = (f) => w(A(f) | B(f));
          cost = io;
          break;
        case "^":
          ev = (f) => w(A(f) ^ B(f));
          cost = io;
          break;
        case "<":
          ev = (f) => (A(f) < B(f) ? 1 : 0);
          cost = io;
          break;
        case ">":
          ev = (f) => (A(f) > B(f) ? 1 : 0);
          cost = io;
          break;
        case "<=":
          ev = (f) => (A(f) <= B(f) ? 1 : 0);
          cost = io;
          break;
        case ">=":
          ev = (f) => (A(f) >= B(f) ? 1 : 0);
          cost = io;
          break;
        case "==":
          ev = (f) => (A(f) === B(f) ? 1 : 0);
          cost = io;
          break;
        case "!=":
          ev = (f) => (A(f) !== B(f) ? 1 : 0);
          cost = io;
          break;
        default:
          return this.fail(`Unknown operator ${op}`, pos);
      }
    }
    // fold constants
    if (ca.cv !== undefined && cb.cv !== undefined) {
      const v = ev([]);
      return { t: rt, ev: () => v, cost: 0, cv: v, pos };
    }
    void rt;
    return { t: rt, ev, cost: cost0 + cost, pos };
  }

  pointerOp(op: string, a: C, b: C, pos: Pos): C {
    const ta = strip(a.t);
    const tb = strip(b.t);
    const A = a.ev;
    const B = b.ev;
    const cost = a.cost + b.cost + 4;
    const hal = this.hal;
    if ((op === "+" || op === "-") && ta.k === "ptr" && isIntegral(tb)) {
      const s = op === "+" ? 1 : -1;
      return {
        t: ta,
        ev: (f) => {
          const p = A(f) as Ptr | null;
          if (!p) {
            hal.fault("Arithmetic on a NULL pointer", pos.file, pos.line);
            return null;
          }
          return { m: p.m, i: p.i + s * B(f), ro: p.ro };
        },
        cost,
        pos,
      };
    }
    if (op === "+" && tb.k === "ptr" && isIntegral(ta)) return this.pointerOp("+", b, a, pos);
    if (op === "-" && ta.k === "ptr" && tb.k === "ptr") {
      return {
        t: this.T.int,
        ev: (f) => {
          const p = A(f) as Ptr;
          const q = B(f) as Ptr;
          return p && q ? p.i - q.i : 0;
        },
        cost,
        pos,
      };
    }
    // a function pointer holds the function itself
    const same = (p: Ptr | null, q: Ptr | null) => (p === null || q === null || !p.m || !q.m ? p === q : p.m === q.m && p.i === q.i);
    const isNull = (c: C) => c.cv === 0;
    if (op === "==" || op === "!=") {
      const eq = op === "==";
      if (isNull(b)) return { t: BOOL, ev: (f) => ((A(f) === null) === eq ? 1 : 0), cost, pos };
      if (isNull(a)) return { t: BOOL, ev: (f) => ((B(f) === null) === eq ? 1 : 0), cost, pos };
      return { t: BOOL, ev: (f) => (same(A(f), B(f)) === eq ? 1 : 0), cost, pos };
    }
    if (op === "<" || op === ">" || op === "<=" || op === ">=") {
      const cmp = (x: number, y: number) => (op === "<" ? x < y : op === ">" ? x > y : op === "<=" ? x <= y : x >= y);
      return { t: BOOL, ev: (f) => (cmp((A(f) as Ptr)?.i ?? 0, (B(f) as Ptr)?.i ?? 0) ? 1 : 0), cost, pos };
    }
    return this.fail(`Cannot use ${op} on ${typeName(ta)} and ${typeName(tb)}`, pos);
  }

  unary(e: Extract<Expr, { k: "un" }>): C {
    const T = this.T;
    if (e.op === "&") {
      const a = this.expr(e.a);
      if (a.t.k === "fn") return a;
      // a library object handed back by a call (&FastLED.addLeds<...>(...)) is a handle: a pointer to it holds it
      if (!a.lv && strip(a.t).k === "class") {
        const ev = a.ev;
        return { t: { k: "ptr", to: strip(a.t) }, ev: (f) => ({ m: [ev(f)], i: 0 }), cost: a.cost, pos: e };
      }
      if (!a.lv) this.fail("& needs a variable", e);
      return { t: { k: "ptr", to: strip(a.t) }, ev: a.lv.ptr, cost: a.cost, pos: e };
    }
    if (e.op === "*") {
      const a = this.rvalue(this.expr(e.a));
      const t = strip(a.t);
      if (t.k !== "ptr") this.fail(`* needs a pointer, not ${typeName(t)}`, e);
      // (*fn)(): a function pointer's value is the function
      if (strip(t.to).k === "fn") return { t: strip(t.to), ev: a.ev, cost: a.cost, pos: e };
      const P = a.ev;
      const hal = this.hal;
      const nul = () => hal.fault("Read through a NULL pointer", e.file, e.line);
      const lv: LV = {
        get: (f) => {
          const p = P(f) as Ptr | null;
          if (!p) {
            nul();
            return 0;
          }
          return p.m[p.i];
        },
        set: (f, v) => {
          const p = P(f) as Ptr | null;
          if (!p) return nul();
          if (p.ro) return hal.fault("Write to a string literal (read-only memory)", e.file, e.line);
          p.m[p.i] = v;
        },
        ptr: (f) => P(f) as Ptr,
      };
      return { t: t.to, ev: lv.get, lv, cost: a.cost + 4, pos: e };
    }
    if (e.op === "++" || e.op === "--") return this.incdec(this.expr(e.a), e.op === "++" ? 1 : -1, false, e);
    const a = e.op === "!" ? this.truthOf(this.rvalue(this.expr(e.a))) : this.rvalue(this.expr(e.a));
    const t = strip(a.t);
    if (e.op === "!") {
      if (!isArith(t) && t.k !== "ptr") this.fail(`! needs a number or pointer, not ${typeName(t)}`, e);
      const A = a.ev;
      if (a.cv !== undefined) return this.numConst(a.cv ? 0 : 1, BOOL, e);
      return { t: BOOL, ev: (f) => (A(f) ? 0 : 1), cost: a.cost + 1, pos: e };
    }
    const ls = this.libStruct(t);
    if (ls) {
      const r = ls.unary?.(e.op, a, this.ctx, e);
      if (!r) this.fail(`Cannot use ${e.op} on ${typeName(t)}`, e);
      return r;
    }
    if (!isArith(t)) this.fail(`${e.op} needs a number, not ${typeName(t)}`, e);
    const pt = t.k === "float" ? t : promote(t, T);
    const c = this.convertTo(a, pt, e);
    const A = c.ev;
    if (e.op === "+") return c;
    if (e.op === "-") {
      if (pt.k === "float") {
        const fr = pt.bits === 32 ? Math.fround : (x: number) => x;
        if (c.cv !== undefined) return this.numConst(fr(-c.cv), pt, e);
        return { t: pt, ev: (f) => fr(-A(f)), cost: c.cost + 4, pos: e };
      }
      const w = wrapInt(pt);
      if (c.cv !== undefined) return this.numConst(w(-c.cv), pt, e);
      return { t: pt, ev: (f) => w(-A(f)), cost: c.cost + 2, pos: e };
    }
    // ~
    if (pt.k === "float") this.fail("~ needs a whole number", e);
    const w = wrapInt(pt);
    if (c.cv !== undefined) return this.numConst(w(~c.cv), pt, e);
    return { t: pt, ev: (f) => w(~A(f)), cost: c.cost + 2, pos: e };
  }

  /** A location read and written once, even when finding it has side effects (a[i++] += 1). */
  place(a: C, pos: Pos): { get: Ev; set: (f: Frame, v: unknown) => void; once: (f: Frame) => Ptr | null; simple: boolean } {
    if (!a.lv) this.fail("This needs a variable on the left", pos);
    return { get: a.lv.get, set: a.lv.set, once: (f) => a.lv!.ptr(f), simple: !!a.lv };
  }

  incdec(a: C, d: 1 | -1, post: boolean, pos: Pos): C {
    if (!a.lv) this.fail(`${d > 0 ? "++" : "--"} needs a variable`, pos);
    const t = strip(a.t);
    const ptr = a.lv.ptr;
    const hal = this.hal;
    let step: (v: unknown) => unknown;
    if (t.k === "ptr")
      step = (v) => {
        const p = v as Ptr | null;
        if (!p) {
          hal.fault("++ or -- on a NULL pointer", pos.file, pos.line);
          return null;
        }
        return { m: p.m, i: p.i + d, ro: p.ro };
      };
    else if (t.k === "float") {
      const fr = t.bits === 32 ? Math.fround : (x: number) => x;
      step = (v) => fr((v as number) + d);
    } else if (isIntegral(t)) {
      const w = wrapInt(t);
      step = (v) => w((v as number) + d);
    } else {
      const st = this.libStruct(t)?.step;
      if (!st) return this.fail(`Cannot use ++ or -- on ${typeName(t)}`, pos);
      step = (v) => st(v, d);
    }
    const cost = a.cost + (t.k === "float" ? CYC.fAdd : 3);
    return {
      t,
      ev: post
        ? (f) => {
            const p = ptr(f);
            const old = p.m[p.i];
            p.m[p.i] = step(old);
            return old;
          }
        : (f) => {
            const p = ptr(f);
            const v = step(p.m[p.i]);
            p.m[p.i] = v;
            return v;
          },
      cost,
      pos,
    };
  }

  assign(e: Extract<Expr, { k: "assign" }>): C {
    const a = this.expr(e.a);
    if (!a.lv) this.fail("The left of = must be a variable", e);
    const ta = strip(a.t);
    if (ta.k === "arr") this.fail("Arrays cannot be assigned; copy them element by element", e);
    const set = a.lv.set;
    if (e.op === "=") {
      const b = this.convertTo(this.rvalue(this.expr(e.b)), ta, e.b);
      const B = b.ev;
      const cp = this.copier(ta);
      const cost = a.cost + b.cost + CYC.load;
      if (cp)
        return {
          t: ta,
          ev: (f) => {
            const v = cp(B(f));
            set(f, v);
            return v;
          },
          cost,
          pos: e,
        };
      return {
        t: ta,
        ev: (f) => {
          const v = B(f);
          set(f, v);
          return v;
        },
        cost,
        pos: e,
      };
    }
    const op = e.op.slice(0, -1);
    // compute the location once, then read, combine and write through it
    const ptr = a.lv.ptr;
    let cell: Ptr = { m: [0], i: 0 };
    const current: C = { t: a.t, ev: () => cell.m[cell.i], cost: a.cost, pos: e };
    // a library struct's own compound operators, which C++ can pick differently from the plain ones (CRGB |= 5 is per byte)
    const ls = this.libStruct(ta);
    const own = ls?.binary?.(e.op, current, this.rvalue(this.expr(e.b)), this.ctx, e);
    if (ls && !own) this.fail(`Cannot use ${e.op} on ${typeName(ta)}`, e);
    const combined = this.convertTo(own ?? this.binary(op, current, this.expr(e.b), e), ta, e);
    const Cv = combined.ev;
    return {
      t: ta,
      ev: (f) => {
        const p = ptr(f);
        const saved = cell;
        cell = p;
        const v = Cv(f);
        cell = saved;
        p.m[p.i] = v;
        return v;
      },
      cost: combined.cost + CYC.load,
      pos: e,
    };
  }

  index(e: Extract<Expr, { k: "idx" }>): C {
    // a library object's operator[]: FastLED[0]
    if (e.a.k === "id" && LIB_OBJECTS[e.a.name] && !this.lookup(e.a.name) && LIB_OBJECTS[e.a.name]["[]"]) return LIB_OBJECTS[e.a.name]["[]"]([this.expr(e.i)], this.ctx, e);
    let a0 = this.expr(e.a);
    if (a0.t.k === "class") this.fail("This object cannot be indexed", e);
    // a library struct's operator[]: leds[i][0] is its red, palette[k] its k-th colour
    const ls = this.libStruct(a0.t);
    if (ls?.index !== undefined) a0 = this.structElems(a0, ls.index, e);
    const ta = strip(a0.t);
    const ic = this.rvalue(this.expr(e.i));
    if (!isIntegral(strip(ic.t))) this.fail("An index must be a whole number", e.i);
    const i = this.convertTo(ic, this.T.long, e.i);
    const I = i.ev;
    const hal = this.hal;
    const where = (n: number, len: number) => hal.fault(`Index ${n} is outside ${e.a.k === "id" ? e.a.name : "the array"} (size ${len}): on the chip this reads or overwrites other memory`, e.file, e.line);
    if (ta.k === "arr") {
      const B = a0.lv ? a0.lv.get : a0.ev;
      const zero = this.zeroScalar(ta.of);
      const lv: LV = {
        get: (f) => {
          const arr = B(f) as unknown[];
          const k = I(f);
          if (k < 0 || k >= arr.length) {
            where(k, arr.length);
            return zero;
          }
          return arr[k];
        },
        set: (f, v) => {
          const arr = B(f) as unknown[];
          const k = I(f);
          if (k < 0 || k >= arr.length) return where(k, arr.length);
          arr[k] = v;
        },
        ptr: (f) => {
          const arr = B(f) as unknown[];
          const k = I(f);
          if (k < 0 || k >= arr.length) {
            where(k, arr.length);
            return { m: [zero], i: 0 };
          }
          return { m: arr, i: k };
        },
      };
      return { t: ta.of, ev: lv.get, lv, cost: a0.cost + i.cost + CYC.index, pos: e };
    }
    const a = this.rvalue(a0);
    const tp = strip(a.t);
    if (tp.k !== "ptr") this.fail(`Cannot index ${typeName(tp)}`, e);
    const P = a.ev;
    const zero = this.zeroScalar(tp.to);
    const at = (f: Frame): Ptr | null => {
      const p = P(f) as Ptr | null;
      if (!p) {
        hal.fault("Indexing a NULL pointer", e.file, e.line);
        return null;
      }
      const k = p.i + I(f);
      if (k < 0 || k >= p.m.length) {
        where(k, p.m.length);
        return null;
      }
      return { m: p.m, i: k, ro: p.ro };
    };
    const lv: LV = {
      get: (f) => {
        const p = at(f);
        return p ? p.m[p.i] : zero;
      },
      set: (f, v) => {
        const p = at(f);
        if (!p) return;
        if (p.ro) return hal.fault("Write to a string literal (read-only memory)", e.file, e.line);
        p.m[p.i] = v;
      },
      ptr: (f) => at(f) ?? { m: [zero], i: 0 },
    };
    return { t: tp.to, ev: lv.get, lv, cost: a.cost + i.cost + CYC.index, pos: e };
  }

  /** a library struct seen as the array its operator[] indexes: its own fields ("self"), or one array field */
  structElems(a: C, which: "self" | number, pos: Pos): C {
    const st = strip(a.t) as Extract<CType, { k: "struct" }>;
    if (which === "self") return { ...a, t: { k: "arr", of: st.fields[0].type, n: st.fields.length }, cv: undefined };
    const fi = which;
    const B = a.lv ? a.lv.get : a.ev;
    const lv: LV | undefined = a.lv ? { get: (f) => (B(f) as unknown[])[fi], set: (f, v) => void ((B(f) as unknown[])[fi] = v), ptr: (f) => ({ m: B(f) as unknown[], i: fi }) } : undefined;
    return { t: st.fields[fi].type, ev: (f) => (B(f) as unknown[])[fi], lv, cost: a.cost + CYC.field, pos };
  }

  zeroScalar(t: CType): unknown {
    return t.k === "ptr" ? null : isArith(t) ? 0 : this.zero(t);
  }

  member(e: Extract<Expr, { k: "mem" }>): C {
    if (e.a.k === "id" && LIB_OBJECTS[e.a.name] && !this.lookup(e.a.name)) this.fail(`${e.a.name}.${e.name} is a function: call it with ()`, e);
    let a = this.expr(e.a);
    let base: Ev;
    let st: CType;
    let baseLv: LV | undefined;
    const hal = this.hal;
    if (e.arrow) {
      const p = this.rvalue(a);
      const tp = strip(p.t);
      if (tp.k !== "ptr") this.fail("-> needs a pointer to a struct", e);
      const P = p.ev;
      base = (f) => {
        const q = P(f) as Ptr | null;
        if (!q) {
          hal.fault("-> on a NULL pointer", e.file, e.line);
          return [];
        }
        return q.m[q.i];
      };
      st = tp.to;
      baseLv = { get: base, set: () => undefined, ptr: () => ({ m: [], i: 0 }) };
      a = p;
    } else {
      st = strip(a.t);
      base = a.lv ? a.lv.get : a.ev;
      baseLv = a.lv;
    }
    if (st.k === "class") this.fail(`${typeName(st)}.${e.name} must be called: ${e.name}()`, e);
    if (st.k !== "struct") this.fail(`${typeName(st)} has no field ${e.name}`, e);
    // a library struct's other names for its fields (the union FastLED's CRGB declares: red for r, raw[] for all three)
    const ls = this.libStruct(st);
    const fname = ls?.alias?.[e.name] ?? e.name;
    if (ls?.index === "self" && fname === "raw" && !st.fields.some((x) => x.name === "raw")) {
      const raw = this.structElems({ t: st, ev: base, lv: baseLv, cost: a.cost, pos: e }, "self", e);
      return raw;
    }
    if (ls?.methods?.[fname]) this.fail(`${e.name} is a function of ${st.name}: call it with ()`, e);
    const fi = st.fields.findIndex((x) => x.name === fname);
    if (fi < 0) this.fail(`struct ${st.name} has no field "${e.name}"`, e);
    const ft = st.fields[fi].type;
    const B = base;
    const lv: LV | undefined = baseLv
      ? {
          get: (f) => (B(f) as unknown[])[fi],
          set: (f, v) => {
            (B(f) as unknown[])[fi] = v;
          },
          ptr: (f) => ({ m: B(f) as unknown[], i: fi }),
        }
      : undefined;
    return { t: ft, ev: (f) => (B(f) as unknown[])[fi], lv, cost: a.cost + CYC.field, pos: e };
  }

  call(e: Extract<Expr, { k: "call" }>): C {
    const fn = e.fn;
    // library objects: Serial.print(...)
    if (fn.k === "mem" && fn.a.k === "id" && LIB_OBJECTS[fn.a.name] && !this.lookup(fn.a.name)) {
      const m = LIB_OBJECTS[fn.a.name][fn.name];
      if (!m) this.fail(`The simulator's ${fn.a.name} has no ${fn.name}()`, e);
      // template arguments ride on the position the library reads: FastLED.addLeds<WS2812B, 6, GRB>
      const at: Pos & { targs?: number[] } = fn.targs ? { file: e.file, line: e.line, targs: fn.targs } : e;
      return m(e.args.map((x) => this.expr(x)), this.ctx, at);
    }
    // library class instances: servo.write(90), and through a pointer: steppers[i]->run()
    if (fn.k === "mem") {
      let obj = this.expr(fn.a);
      if (fn.arrow) {
        const p = this.rvalue(obj);
        const pt = strip(p.t);
        if (pt.k === "ptr" && strip(pt.to).k === "class") {
          const P = p.ev;
          const hal = this.hal;
          obj = {
            t: strip(pt.to),
            ev: (f) => {
              const q = P(f) as Ptr | null;
              if (!q) {
                hal.fault("-> on a NULL pointer", e.file, e.line);
                return {};
              }
              return q.m[q.i];
            },
            cost: p.cost + 4,
            pos: fn,
          };
        }
      }
      const ot = strip(obj.t);
      if (ot.k === "class") {
        const cls = LIB_CLASSES[ot.name];
        const m = cls?.methods[fn.name];
        if (!m) this.fail(`${ot.name} has no ${fn.name}() in the simulator`, e);
        return m(obj, e.args.map((x) => this.expr(x)), this.ctx, e);
      }
      // a library struct's member functions, on the value itself: leds[i].fadeToBlackBy(64), p->setHue(h)
      const sm = this.libStruct(ot)?.methods?.[fn.name];
      if (sm) return sm(obj, e.args.map((x) => this.expr(x)), this.ctx, e);
      if (fn.arrow) {
        const pt = strip(this.rvalue(obj).t);
        const pm = pt.k === "ptr" ? this.libStruct(pt.to)?.methods?.[fn.name] : undefined;
        if (pm) return pm(this.unary({ k: "un", op: "*", a: fn.a, file: fn.file, line: fn.line }), e.args.map((x) => this.expr(x)), this.ctx, e);
      }
    }
    if (fn.k === "id" && fn.name === "__flash_str") {
      if (e.args.length !== 1 || e.args[0].k !== "str") this.fail("F() needs a string in quotes", e);
      return this.expr(e.args[0]);
    }
    if (fn.k === "id" && !this.lookup(fn.name)) {
      const b = LIB_FUNCS[fn.name];
      if (!b) this.fail(`The simulator does not know the function ${fn.name}()`, e);
      return b(e.args.map((x) => this.expr(x)), this.ctx, e);
    }
    const callee = this.expr(fn);
    // through a function pointer: patterns[current]();
    const ct0 = strip(callee.t);
    const ct = ct0.k === "ptr" && strip(ct0.to).k === "fn" ? strip(ct0.to) : ct0;
    if (ct.k !== "fn") this.fail(`${fn.k === "id" ? fn.name : "This"} is not a function`, e);
    const sym = fn.k === "id" ? this.lookup(fn.name) : undefined;
    const fo = sym?.k === "fn" ? sym.fo : undefined;
    const params = fo ? fo.def.params.map((p) => p.type) : ct.params;
    if (e.args.length !== params.length) this.fail(`${fo?.name ?? "The function"}() takes ${params.length} argument${params.length === 1 ? "" : "s"}, given ${e.args.length}`, e);
    let cost = CYC.call;
    const argEvs: Ev[] = e.args.map((x, i) => {
      const pt = params[i];
      const a = this.expr(x);
      if (pt.k === "ref") {
        cost += a.cost + 4;
        if (a.lv) return a.lv.ptr;
        // a temporary bound to a const reference
        const v = this.convertTo(this.rvalue(a), pt.to, x).ev;
        return (f) => ({ m: [v(f)], i: 0 });
      }
      const c = this.convertTo(this.rvalue(a), pt, x);
      cost += c.cost + sizeOf(pt, this.T.abi);
      const cp = this.copier(pt);
      const ev = c.ev;
      return cp ? (f: Frame) => cp(ev(f)) : ev;
    });
    const n = argEvs.length;
    const ret = ct.ret.k === "ref" ? ct.ret.to : ct.ret;
    if (fo) {
      const invoke = (fr: Frame) => this.invoke(fo, fr);
      let ev: Ev;
      if (n === 0) ev = () => invoke([]);
      else if (n === 1) {
        const a0 = argEvs[0];
        ev = (f) => invoke([a0(f)]);
      } else if (n === 2) {
        const [a0, a1] = argEvs;
        ev = (f) => invoke([a0(f), a1(f)]);
      } else
        ev = (f) => {
          const fr = new Array(n);
          for (let i = 0; i < n; i++) fr[i] = argEvs[i](f);
          return invoke(fr);
        };
      return { t: ret, ev, cost, pos: e };
    }
    const F = callee.ev;
    return {
      t: ret,
      ev: (f) => {
        const r = F(f) as FnRef | null;
        if (!r) {
          this.hal.fault("Call through a NULL function pointer", e.file, e.line);
          return 0;
        }
        return r.call(argEvs.map((a) => a(f)));
      },
      cost,
      pos: e,
    };
  }
}

export { CError };
