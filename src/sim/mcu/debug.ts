// The firmware debugger. Breakpoints (with a condition, a hit count, or as logpoints that print), watch expressions,
// stopping on firmware mistakes, the call stack with each frame's variables, and a recording of the statements after
// each stop, so the app can step through them (over, into, out) without pausing the simulation. The recorder only
// reads: a run with breakpoints is the same run as without, so its stops line up with the replay of that run.

import type { Expr, Pos } from "./ast";
import { typeName, type CType } from "./ctypes";
import { CError } from "./lex";
import type { Ev, Frame } from "./ir";
import type { FnRef, Hal, Ptr } from "./vm";

export interface DebugBreakpoint {
  id: string;
  /** the file as the sketch names it (brain.ino, pins.h) */
  file: string;
  /** from 1; a line with no code stops at the next line that has some */
  line: number;
  /** stop only when this C expression is true */
  cond?: string;
  /** a logpoint: record this text, with {expressions} filled in, and go on */
  log?: string;
  /** stop from this hit on (1 = the first) */
  hit?: number;
}

export interface DebugSpec {
  breakpoints: DebugBreakpoint[];
  /** C expressions shown at each stop and step, in the scope of the line */
  watches?: string[];
  /** stop where the firmware makes a mistake the chip wouldn't report (an index out of range, a divide by zero) */
  breakOnFault?: boolean;
  /** stops before this time (seconds) are counted but not recorded */
  from?: number;
  /** stops recorded at most (40) */
  maxStops?: number;
  /** statements recorded after each stop, for stepping (300) */
  traceSteps?: number;
}

export interface DebugVar {
  name: string;
  type: string;
  value: string;
}

export interface DebugFrame {
  fn: string;
  file: string;
  line: number;
  locals: DebugVar[];
}

/** A statement the firmware ran while a stop's recording was open. */
export interface TraceStep {
  /** the statement: an index into DebugResult.sites */
  s: number;
  /** call depth: 1 is the function the chip called (setup, loop, an interrupt handler) */
  d: number;
  /** seconds since power-up */
  t: number;
  /** its function's variables before it ran, in the order sites[s].locals lists them */
  v: string[];
  /** plain global variables that changed since the statement before: name and value */
  g?: [string, string][];
  /** the watches' values */
  w?: string[];
}

export interface DebugSite {
  file: string;
  line: number;
  fn: string;
  locals: { name: string; type: string }[];
}

export interface DebugStop {
  t: number;
  reason: "breakpoint" | "fault";
  /** the breakpoint that stopped it */
  bp?: string;
  /** the firmware mistake that stopped it */
  fault?: string;
  file: string;
  line: number;
  fn: string;
  /** the call stack, innermost first, with each frame's variables */
  stack: DebugFrame[];
  globals: DebugVar[];
  watches: { expr: string; value?: string; error?: string }[];
  /** the statements that ran just before, oldest first */
  before: { s: number; d: number }[];
  /** the call depth here, to step over and out against */
  depth: number;
  /** the statements that ran after this one */
  trace: TraceStep[];
}

export interface DebugResult {
  stops: DebugStop[];
  logs: { t: number; bp: string; file: string; line: number; text: string }[];
  /** times each breakpoint's line ran with its condition true */
  hits: Record<string, number>;
  /** the line each breakpoint stops at: the first with code at or after the one it was set on, null when none */
  bound: Record<string, number | null>;
  sites: DebugSite[];
  /** conditions, logpoints and watches that couldn't be read */
  errors: { bp?: string; watch?: string; message: string }[];
  /** more stops happened than were recorded */
  more?: boolean;
  /** more logpoint lines than were kept */
  moreLogs?: boolean;
}

/** What the compiler knows at a statement: the variables in scope, and how to compile an expression there. */
export interface SiteScope {
  vars: { name: string; slot: number; t: CType; global: boolean }[];
  compile(e: Expr): { ev: Ev; t: CType };
}

interface SiteRt {
  pos: Pos;
  fn: string;
  key: number;
  scope: SiteScope;
  bps: BpAt[] | null;
  /** the watches compiled here: a value reader, or why not */
  watches?: ({ ev: Ev; t: CType } | string)[];
}

interface BpRt {
  b: DebugBreakpoint;
  hits: number;
  /** the condition or log text couldn't be read: the breakpoint does nothing */
  broken?: boolean;
}

interface BpAt {
  rt: BpRt;
  cond?: Ev;
  log?: (string | { ev: Ev; t: CType })[];
}

const MAX_LOGS = 2000;
const MAX_STACK = 40;
const MAX_GLOBALS = 150;
const RING = 64;
const MAX_VALUE = 160;

/** library calls a condition or watch may make: they read, and take no time */
const PURE_CALLS = new Set(["millis", "micros", "digitalRead", "bitRead", "abs", "min", "max", "constrain", "map", "sq", "sqrt", "lowByte", "highByte", "bit"]);

/** Why an expression can't be watched (it would change the firmware's state), or null. */
function sideEffect(e: Expr): string | null {
  switch (e.k) {
    case "assign":
      return "assigns a value";
    case "post":
      return `uses ${e.op}`;
    case "un":
      return e.op === "++" || e.op === "--" ? `uses ${e.op}` : sideEffect(e.a);
    case "call": {
      if (e.fn.k !== "id" || !PURE_CALLS.has(e.fn.name)) return "calls a function (only millis(), micros(), digitalRead() and math helpers can be called here)";
      for (const a of e.args) {
        const w = sideEffect(a);
        if (w) return w;
      }
      return null;
    }
    case "bin":
    case "logic":
    case "comma":
      return sideEffect(e.a) ?? sideEffect(e.b);
    case "cond":
      return sideEffect(e.c) ?? sideEffect(e.a) ?? sideEffect(e.b);
    case "idx":
      return sideEffect(e.a) ?? sideEffect(e.i);
    case "mem":
    case "cast":
    case "sizeofE":
      return sideEffect(e.a);
    case "init":
      for (const x of e.items) {
        const w = sideEffect(x);
        if (w) return w;
      }
      return null;
    default:
      return null;
  }
}

const isScalar = (t: CType) => t.k === "int" || t.k === "float" || t.k === "bool" || t.k === "enum";

function text(bytes: unknown[], max = 48): string {
  let s = "";
  for (let i = 0; i < bytes.length && s.length < max; i++) {
    const c = Number(bytes[i]) & 255;
    if (!c) break;
    s += c === 10 ? "\\n" : c === 13 ? "\\r" : c === 9 ? "\\t" : c === 34 ? '\\"' : c < 32 || c > 126 ? `\\x${c.toString(16).padStart(2, "0")}` : String.fromCharCode(c);
  }
  return `"${s}${s.length >= max ? "…" : ""}"`;
}

/** A value as the debugger shows it. */
export function formatValue(v: unknown, t: CType, depth = 0): string {
  try {
    const s = fmt(v, t, depth);
    return s.length > MAX_VALUE ? s.slice(0, MAX_VALUE - 1) + "…" : s;
  } catch {
    return "?";
  }
}

function fmt(v: unknown, t: CType, depth: number): string {
  if (v === undefined) return "–";
  switch (t.k) {
    case "bool":
      return v ? "true" : "false";
    case "int": {
      const n = Number(v);
      if (t.char && n >= 32 && n < 127) return `${n} '${String.fromCharCode(n)}'`;
      return String(v);
    }
    case "float": {
      const n = Number(v);
      return Number.isFinite(n) ? String(+n.toPrecision(t.bits === 32 ? 7 : 12)) : String(n);
    }
    case "enum":
      return String(v);
    case "fn":
      return v && typeof v === "object" && "fnName" in v ? `${(v as FnRef).fnName}()` : "NULL";
    case "ref": {
      const p = v as Ptr;
      return p && p.m ? fmt(p.m[p.i], t.to, depth) : "?";
    }
    case "ptr": {
      if (v === null) return "NULL";
      if (typeof v === "object" && v && "fnName" in v) return `${(v as FnRef).fnName}()`;
      const p = v as Ptr;
      if (!p || !p.m) return "?";
      if (t.to.k === "int" && t.to.bits === 8 && t.to.char) return text(Array.prototype.slice.call(p.m, p.i, p.i + 64));
      const at = p.i ? ` at [${p.i}]` : "";
      if (depth > 1 || t.to.k === "void") return `pointer${at}`;
      return `→ ${fmt(p.m[p.i], t.to, depth + 1)}${at}`;
    }
    case "arr": {
      const a = v as unknown[];
      if (!a || typeof a.length !== "number") return "?";
      if (t.of.k === "int" && t.of.bits === 8 && t.of.char) return text(a);
      if (depth > 1) return `[${a.length} items]`;
      const n = Math.min(a.length, depth ? 4 : 10);
      const items: string[] = [];
      for (let i = 0; i < n; i++) items.push(fmt(a[i], t.of, depth + 1));
      return `[${items.join(", ")}${a.length > n ? `, … ${a.length} in all` : ""}]`;
    }
    case "struct": {
      const s = v as unknown[];
      if (!s || typeof s.length !== "number") return "?";
      if (depth > 1) return "{…}";
      const n = Math.min(t.fields.length, depth ? 4 : 8);
      return `{${t.fields
        .slice(0, n)
        .map((f, i) => `${f.name}: ${fmt(s[i], f.type, depth + 1)}`)
        .join(", ")}${t.fields.length > n ? ", …" : ""}}`;
    }
    case "class":
      return t.name;
    default:
      return String(v);
  }
}

export class FirmwareDebugger {
  private sites: SiteRt[] = [];
  private files: string[] = [];
  /** the running functions, innermost last: name, frame and the statement running in it */
  private stack: { fn: string; f: Frame; s: number }[] = [];
  private ringS = new Int32Array(RING);
  private ringD = new Int32Array(RING);
  private ringN = 0;
  private lastSite = -1;
  private lastDepth = -1;
  private bps: BpRt[];
  private stops: DebugStop[] = [];
  private logs: DebugResult["logs"] = [];
  private errors: DebugResult["errors"] = [];
  private bound: Record<string, number | null> = {};
  private more = false;
  private moreLogs = false;
  /** recordings still open, with the statements they may still take */
  private open: { stop: DebugStop; left: number }[] = [];
  private lastScalars: unknown[] = [];
  private G: unknown[] = [];
  private globals: { name: string; slot: number; t: CType }[] = [];
  private scalarGlobals: { name: string; slot: number; t: CType }[] = [];
  private faultsSeen = new Set<string>();
  /** reading a condition or watch: a mistake there is the watch's, not the firmware's */
  muted = false;
  private mutedFault: string | null = null;
  private watches: string[];
  private watchExprs: (Expr | string)[] = [];
  private maxStops: number;
  private traceSteps: number;
  private from: number;

  constructor(
    private spec: DebugSpec,
    private hal: Hal,
    private parse: (text: string) => Expr,
  ) {
    this.bps = spec.breakpoints.map((b) => ({ b, hits: 0 }));
    this.watches = (spec.watches ?? []).filter((w) => w.trim()).slice(0, 24);
    this.maxStops = Math.max(1, Math.min(200, spec.maxStops ?? 40));
    this.traceSteps = Math.max(0, Math.min(2000, spec.traceSteps ?? 300));
    this.from = spec.from ?? 0;
    for (const w of this.watches) this.watchExprs.push(this.parseChecked(w));
    this.watchExprs.forEach((e, i) => {
      if (typeof e === "string") this.errors.push({ watch: this.watches[i], message: e });
    });
  }

  private parseChecked(src: string): Expr | string {
    try {
      const e = this.parse(src);
      const w = sideEffect(e);
      return w ? `It ${w}, which would change what the firmware does` : e;
    } catch (err) {
      return err instanceof CError ? err.message.replace(/^[^:]*:\d+: /, "") : String(err);
    }
  }

  // ---------- compile time ----------

  /** A statement, as it is compiled: its index for at(). */
  site(pos: Pos, fn: string, scope: SiteScope): number {
    let fi = this.files.indexOf(pos.file);
    if (fi < 0) fi = this.files.push(pos.file) - 1;
    return this.sites.push({ pos, fn, key: fi * 1_000_000 + pos.line, scope, bps: null }) - 1;
  }

  /** After compiling: the globals to show, and each breakpoint on the statements of its line. */
  bind(G: unknown[], globals: Map<string, { slot: number; t: CType }>) {
    this.G = G;
    for (const [name, g] of globals) {
      if (name.startsWith("__")) continue;
      if (this.globals.length < MAX_GLOBALS) this.globals.push({ name, slot: g.slot, t: g.t });
      if (isScalar(g.t)) this.scalarGlobals.push({ name, slot: g.slot, t: g.t });
    }
    const lines = new Map<string, number[]>();
    for (const s of this.sites) {
      const l = lines.get(s.pos.file) ?? [];
      l.push(s.pos.line);
      lines.set(s.pos.file, l);
    }
    for (const l of lines.values()) l.sort((a, b) => a - b);
    for (const rt of this.bps) {
      const b = rt.b;
      const at = (lines.get(b.file) ?? []).find((l) => l >= b.line && l - b.line <= 40);
      this.bound[b.id] = at ?? null;
      if (at === undefined) continue;
      const cond = b.cond?.trim() ? this.parseChecked(b.cond) : undefined;
      if (typeof cond === "string") {
        rt.broken = true;
        this.errors.push({ bp: b.id, message: `Condition: ${cond}` });
        continue;
      }
      const log = b.log !== undefined ? this.logParts(b) : undefined;
      if (log === null) continue;
      for (const s of this.sites) {
        if (s.pos.file !== b.file || s.pos.line !== at) continue;
        const here: BpAt = { rt };
        try {
          if (cond) here.cond = s.scope.compile(cond).ev;
          if (log) here.log = log.map((p) => (typeof p === "string" ? p : s.scope.compile(p)));
        } catch (err) {
          if (!rt.broken) this.errors.push({ bp: b.id, message: `${cond ? "Condition" : "Log"}: ${err instanceof CError ? err.message.replace(/^[^:]*:\d+: /, "") : String(err)}` });
          rt.broken = true;
          continue;
        }
        (s.bps ??= []).push(here);
      }
    }
  }

  /** A logpoint's text split into literal text and {expressions}; null when one can't be read. */
  private logParts(rt: DebugBreakpoint): (string | Expr)[] | null {
    const out: (string | Expr)[] = [];
    const src = rt.log ?? "";
    const re = /\{([^{}]+)\}/g;
    let last = 0;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      if (m.index > last) out.push(src.slice(last, m.index));
      const e = this.parseChecked(m[1]);
      if (typeof e === "string") {
        this.errors.push({ bp: rt.id, message: `Log {${m[1]}}: ${e}` });
        return null;
      }
      out.push(e);
      last = m.index + m[0].length;
    }
    if (last < src.length) out.push(src.slice(last));
    return out;
  }

  // ---------- run time ----------

  enter(fn: string, f: Frame) {
    this.stack.push({ fn, f, s: -1 });
  }

  leave() {
    this.stack.pop();
  }

  /** Called before each statement runs. */
  at(si: number, f: Frame) {
    const depth = this.stack.length;
    if (depth) this.stack[depth - 1].s = si;
    const r = this.ringN++ % RING;
    this.ringS[r] = si;
    this.ringD[r] = depth;
    if (this.open.length) this.record(si, f, depth);
    const site = this.sites[si];
    // a second statement on the same line doesn't stop again; the same statement again (a loop) does
    if (site.bps && !(this.lastSite !== si && this.lastSite >= 0 && this.sites[this.lastSite].key === site.key && this.lastDepth === depth)) this.hit(si, site, f);
    this.lastSite = si;
    this.lastDepth = depth;
  }

  private now() {
    return this.hal.cyc / this.hal.fcpu;
  }

  private read<T>(fn: () => T, fallback: T): T {
    this.muted = true;
    this.mutedFault = null;
    try {
      return fn();
    } catch {
      return fallback;
    } finally {
      this.muted = false;
    }
  }

  private hit(si: number, site: SiteRt, f: Frame) {
    for (const at of site.bps!) {
      const rt = at.rt;
      if (rt.broken) continue;
      if (at.cond && !this.read(() => !!at.cond!(f), false)) continue;
      rt.hits++;
      if (rt.b.hit && rt.hits < rt.b.hit) continue;
      const t = this.now();
      if (at.log) {
        if (this.logs.length >= MAX_LOGS) {
          this.moreLogs = true;
          continue;
        }
        const txt = at.log.map((p) => (typeof p === "string" ? p : this.read(() => formatValue(p.ev(f), p.t), "?"))).join("");
        this.logs.push({ t, bp: rt.b.id, file: site.pos.file, line: site.pos.line, text: txt });
        continue;
      }
      if (t < this.from) continue;
      this.stop("breakpoint", si, f, site.pos, rt.b.id);
    }
  }

  /** The firmware made a mistake: stop there (once for each kind and place). */
  fault(msg: string, file: string, line: number): boolean {
    if (this.muted) {
      this.mutedFault = msg;
      return false;
    }
    if (!this.spec.breakOnFault) return true;
    // once for each place: an index running past the end faults again with each new index
    const key = `${file}:${line}`;
    if (this.faultsSeen.has(key) || this.now() < this.from) return true;
    this.faultsSeen.add(key);
    const top = this.stack[this.stack.length - 1];
    if (top && top.s >= 0) this.stop("fault", top.s, top.f, { file, line }, undefined, msg);
    return true;
  }

  private stop(reason: DebugStop["reason"], si: number, f: Frame, pos: Pos, bp?: string, fault?: string) {
    if (this.stops.length >= this.maxStops) {
      this.more = true;
      return;
    }
    const stack: DebugFrame[] = [];
    for (let i = this.stack.length - 1; i >= 0 && stack.length < MAX_STACK; i--) {
      const fr = this.stack[i];
      const s = fr.s >= 0 ? this.sites[fr.s] : null;
      stack.push({ fn: fr.fn, file: s?.pos.file ?? "", line: s?.pos.line ?? 0, locals: s ? this.locals(s, fr.f) : [] });
    }
    const before: { s: number; d: number }[] = [];
    // the ring holds this statement last: the ones before it, oldest first
    const n = Math.min(this.ringN - 1, RING - 1);
    for (let k = n; k >= 1; k--) {
      const r = (this.ringN - 1 - k) % RING;
      before.push({ s: this.ringS[r], d: this.ringD[r] });
    }
    const stop: DebugStop = {
      t: this.now(),
      reason,
      bp,
      fault,
      file: pos.file,
      line: pos.line,
      fn: this.sites[si].fn,
      stack,
      globals: this.globals.map((g) => ({ name: g.name, type: typeName(g.t), value: this.read(() => formatValue(this.G[g.slot], g.t), "?") })),
      watches: this.watches.map((w, i) => this.watchAt(si, f, i, w)),
      before,
      depth: this.stack.length,
      trace: [],
    };
    this.stops.push(stop);
    if (this.traceSteps > 0) {
      if (!this.open.length) this.lastScalars = this.scalarGlobals.map((g) => this.G[g.slot]);
      this.open.push({ stop, left: this.traceSteps });
    }
  }

  private locals(s: SiteRt, f: Frame): DebugVar[] {
    return s.scope.vars.map((v) => ({ name: v.name, type: typeName(v.t), value: this.read(() => formatValue(v.global ? this.G[v.slot] : f[v.slot], v.t), "?") }));
  }

  private compiledWatches(si: number) {
    const s = this.sites[si];
    if (!s.watches)
      s.watches = this.watchExprs.map((e) => {
        if (typeof e === "string") return e;
        try {
          return s.scope.compile(e);
        } catch (err) {
          return err instanceof CError ? err.message.replace(/^[^:]*:\d+: /, "") : String(err);
        }
      });
    return s.watches;
  }

  private watchAt(si: number, f: Frame, i: number, expr: string): { expr: string; value?: string; error?: string } {
    const c = this.compiledWatches(si)[i];
    if (typeof c === "string") return { expr, error: c };
    const value = this.read(() => formatValue(c.ev(f), c.t), "?");
    return this.mutedFault ? { expr, error: this.mutedFault } : { expr, value };
  }

  private record(si: number, f: Frame, depth: number) {
    const s = this.sites[si];
    const step: TraceStep = { s: si, d: depth, t: this.now(), v: s.scope.vars.map((v) => this.read(() => formatValue(v.global ? this.G[v.slot] : f[v.slot], v.t), "?")) };
    const changed: [string, string][] = [];
    for (let k = 0; k < this.scalarGlobals.length; k++) {
      const g = this.scalarGlobals[k];
      const v = this.G[g.slot];
      if (v !== this.lastScalars[k]) {
        this.lastScalars[k] = v;
        changed.push([g.name, formatValue(v, g.t)]);
      }
    }
    if (changed.length) step.g = changed;
    if (this.watches.length) step.w = this.watches.map((w, i) => {
      const r = this.watchAt(si, f, i, w);
      return r.error ? `(${r.error})` : r.value!;
    });
    for (let k = this.open.length - 1; k >= 0; k--) {
      const o = this.open[k];
      o.stop.trace.push(step);
      if (--o.left <= 0) this.open.splice(k, 1);
    }
  }

  result(): DebugResult {
    // only the statements the stops refer to, renumbered
    const used = new Map<number, number>();
    const sites: DebugSite[] = [];
    const idx = (si: number) => {
      let n = used.get(si);
      if (n === undefined) {
        const s = this.sites[si];
        n = sites.push({ file: s.pos.file, line: s.pos.line, fn: s.fn, locals: s.scope.vars.map((v) => ({ name: v.name, type: typeName(v.t) })) }) - 1;
        used.set(si, n);
      }
      return n;
    };
    // a step object is shared by the recordings it is in: renumber each once
    const done = new Set<TraceStep>();
    const stops = this.stops.map((s) => {
      for (const st of s.trace)
        if (!done.has(st)) {
          st.s = idx(st.s);
          done.add(st);
        }
      return { ...s, before: s.before.map((b) => ({ s: idx(b.s), d: b.d })) };
    });
    return {
      stops,
      logs: this.logs,
      hits: Object.fromEntries(this.bps.map((b) => [b.b.id, b.hits])),
      bound: this.bound,
      sites,
      errors: this.errors,
      ...(this.more ? { more: true } : {}),
      ...(this.moreLogs ? { moreLogs: true } : {}),
    };
  }
}
