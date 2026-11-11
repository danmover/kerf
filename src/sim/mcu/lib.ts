// The Arduino core and libraries the virtual microcontroller provides: pins,
// time, interrupts, maths, C strings and printf, Serial, Wire (I2C), EEPROM,
// Servo and Adafruit_NeoPixel. Printing, rounding and overflow follow the AVR core and
// avr-libc, so the simulated board prints and computes what the real one does
// (sprintf has no %f, Serial.print(x) shows 2 decimals, map() is long maths).

import type { Pos } from "./ast";
import { BOOL, VOID, converter, isArith, isIntegral, sizeOf, strip, typeName, type CType, type Types } from "./ctypes";
import { bytesOf, cstr, text, type C, type Ctx, type Ev, type Frame } from "./ir";
import { fromBytes, readBytes, toBytes, writeBytes } from "./mem";
import type { FnRef, Hal, Ptr } from "./vm";

export type LibFn = (args: C[], ctx: Ctx, pos: Pos) => C;
export type LibMethod = (obj: C, args: C[], ctx: Ctx, pos: Pos) => C;
export interface LibClass {
  methods: Record<string, LibMethod>;
  /** `Type name(args);`: builds an instance from constructor arguments */
  construct?: (args: C[], ctx: Ctx, pos: Pos) => C;
}

/** Library state that belongs to one running chip (reset at power-up). */
export interface LibState {
  wireAddr: number;
  wireTx: number[] | null;
  wireRx: number[];
  wireRxPos: number;
  serialTimeout: number;
  seed: number;
}

export function newLibState(): LibState {
  return { wireAddr: 0, wireTx: null, wireRx: [], wireRxPos: 0, serialTimeout: 1000, seed: 1 };
}

export function resetLibState(s: LibState) {
  Object.assign(s, newLibState());
}

const dict = <T>(o: Record<string, T>): Record<string, T> => Object.assign(Object.create(null) as Record<string, T>, o);

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

function numEv(c: C, to: CType, ctx: Ctx, what: string): Ev {
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

function ptrEv(c: C, ctx: Ctx, what: string): Ev {
  const r = decay(c);
  const t = strip(r.t);
  if (t.k === "ptr") return r.ev;
  if (isIntegral(t) && r.cv === 0) return () => null;
  return ctx.error(`${what} needs a pointer or array here, not ${typeName(t)}`, c.pos);
}

function fnEv(c: C, ctx: Ctx, what: string): Ev {
  const t = strip(c.t);
  if (t.k === "fn") return c.ev;
  if (t.k === "ptr" && t.to.k === "fn") return c.ev;
  if (isIntegral(t) && c.cv === 0) return () => null;
  return ctx.error(`${what} needs the name of a function here`, c.pos);
}

/** The element type a pointer or array argument points at. */
function pointee(c: C): CType {
  const t = strip(c.t);
  return t.k === "arr" ? t.of : t.k === "ptr" ? t.to : VOID;
}

function argCount(name: string, min: number, max: number, n: number, ctx: Ctx, pos: Pos): never {
  const want = min === max ? `${min}` : max === Infinity ? `at least ${min}` : `${min} to ${max}`;
  return ctx.error(`${name}() takes ${want} argument${want === "1" ? "" : "s"}, given ${n}`, pos);
}

const sumCost = (args: C[]) => args.reduce((s, a) => s + a.cost, 0);

/** CPU work a library call does that depends on its data (formatting digits, copying bytes). */
function burn(hal: Hal, cycles: number) {
  hal.cyc += Math.round(cycles);
  if (hal.cyc >= hal.nextEvt) hal.service();
}

type PK = "int" | "uint" | "long" | "ulong" | "u8" | "double" | "size" | "bool" | "ptr" | "fn";
type RK = PK | "void" | "charp";

function typeOf(k: RK, T: Types): CType {
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
      return VOID;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Run = (v: any[], ctx: Ctx, pos: Pos) => unknown;

/** A library function with fixed parameter types (converted as C++ would) and an estimated cost. */
function def(name: string, params: PK[], ret: RK, cyc: number, run: Run, defaults: unknown[] = []): LibFn {
  return (args, ctx, pos) => {
    const min = params.length - defaults.length;
    if (args.length < min || args.length > params.length) argCount(name, min, params.length, args.length, ctx, pos);
    const what = `${name}()`;
    const evs: Ev[] = args.map((a, i) => (params[i] === "ptr" ? ptrEv(a, ctx, what) : params[i] === "fn" ? fnEv(a, ctx, what) : numEv(a, typeOf(params[i], ctx.T), ctx, what)));
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

// ---------- number formatting (Print.cpp) ----------

function printNumber(n: number, base: number): number[] {
  if (base < 2) base = 10;
  if (n === 0) return [48];
  const out: number[] = [];
  while (n > 0) {
    const d = n % base;
    out.push(d < 10 ? 48 + d : 55 + d);
    n = Math.floor(n / base);
  }
  return out.reverse();
}

/** Print::printFloat with AVR's 32-bit double: rounds by adding 0.5e-digits, then prints digit by digit. */
export function printFloat(x: number, digits: number): number[] {
  const fr = Math.fround;
  if (Number.isNaN(x)) return bytesOf("nan");
  if (!Number.isFinite(x)) return bytesOf("inf");
  if (x > 4294967040.0 || x < -4294967040.0) return bytesOf("ovf");
  digits &= 255;
  const out: number[] = [];
  let number = fr(x);
  if (number < 0) {
    out.push(45);
    number = fr(-number);
  }
  let rounding = fr(0.5);
  for (let i = 0; i < digits; i++) rounding = fr(rounding / 10);
  number = fr(number + rounding);
  const intPart = Math.trunc(number) >>> 0;
  let remainder = fr(number - fr(intPart));
  out.push(...printNumber(intPart, 10));
  if (digits > 0) out.push(46);
  while (digits-- > 0) {
    remainder = fr(remainder * 10);
    const d = Math.trunc(remainder) & 0xffff;
    out.push(...printNumber(d, 10));
    remainder = fr(remainder - d);
  }
  return out;
}

/** What Serial.print(value[, base or digits]) writes, chosen by the value's C type like the C++ overloads. */
function printBytes(t: CType, v: unknown, second: number | undefined, ctx: Ctx, pos: Pos): number[] {
  if (t.k === "ptr") return cstr(v as Ptr | null);
  if (t.k === "float") return printFloat(v as number, second ?? 2);
  if (t.k === "int" && t.char) return second === undefined ? [(v as number) & 255] : printInt(v as number, true, 32, second);
  if (t.k === "int") return printInt(v as number, t.signed, t.bits, second ?? 10);
  if (t.k === "bool" || t.k === "enum") return printInt(v as number, true, 32, second ?? 10);
  return ctx.error(`Serial.print cannot print ${typeName(t)}`, pos);
}

function printInt(n: number, signed: boolean, bits: number, base: number): number[] {
  if (base === 0) return [n & 255];
  if (bits === 64) {
    const neg = signed && n < 0;
    const s = Math.abs(n).toString(base < 2 ? 10 : base).toUpperCase();
    return bytesOf(base === 10 && neg ? "-" + s : s);
  }
  if (signed && base === 10 && n < 0) return [45, ...printNumber(-n, 10)];
  return printNumber(n >>> 0, base);
}

// ---------- printf (avr-libc vfprintf, the default build without floats) ----------

interface Spec {
  lit?: number[];
  flags: string;
  width: number | "*" | null;
  prec: number | "*" | null;
  len: string;
  conv: string;
}

function parseFormat(fmt: number[]): Spec[] {
  const out: Spec[] = [];
  let lit: number[] = [];
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c !== 37) {
      lit.push(c);
      continue;
    }
    let j = i + 1;
    let flags = "";
    while (j < fmt.length && "-+ #0".includes(String.fromCharCode(fmt[j]))) flags += String.fromCharCode(fmt[j++]);
    let width: Spec["width"] = null;
    if (fmt[j] === 42) {
      width = "*";
      j++;
    } else {
      let w = "";
      while (fmt[j] >= 48 && fmt[j] <= 57) w += String.fromCharCode(fmt[j++]);
      if (w) width = +w;
    }
    let prec: Spec["prec"] = null;
    if (fmt[j] === 46) {
      j++;
      if (fmt[j] === 42) {
        prec = "*";
        j++;
      } else {
        let p = "";
        while (fmt[j] >= 48 && fmt[j] <= 57) p += String.fromCharCode(fmt[j++]);
        prec = p ? +p : 0;
      }
    }
    let len = "";
    while (j < fmt.length && "hlLqjzt".includes(String.fromCharCode(fmt[j]))) len += String.fromCharCode(fmt[j++]);
    const conv = j < fmt.length ? String.fromCharCode(fmt[j]) : "";
    if (lit.length) out.push({ lit, flags: "", width: null, prec: null, len: "", conv: "" });
    lit = [];
    if (conv === "%") lit.push(37);
    else out.push({ flags, width, prec, len, conv });
    i = j;
  }
  if (lit.length) out.push({ lit, flags: "", width: null, prec: null, len: "", conv: "" });
  return out;
}

/** The argument size (bytes on the stack) a conversion reads on AVR. */
function specBytes(s: Spec, T: Types): number {
  if ("diouxXc".includes(s.conv)) return s.len.startsWith("l") ? 4 : T.abi.intBits / 8;
  if (s.conv === "s" || s.conv === "p") return T.abi.ptrBytes;
  if ("fFeEgGaA".includes(s.conv)) return T.abi.doubleBits / 8;
  return 0;
}

/** The size an argument takes after C's default promotions (char and short to int, float to double). */
function promotedBytes(t: CType, T: Types): number {
  if (t.k === "float") return T.abi.doubleBits / 8;
  if (t.k === "bool" || t.k === "enum") return T.abi.intBits / 8;
  if (t.k === "int") return Math.max(t.bits / 8, T.abi.intBits / 8);
  if (t.k === "ptr" || t.k === "arr" || t.k === "fn") return T.abi.ptrBytes;
  return sizeOf(t, T.abi);
}

function pad(body: string, s: Spec, numeric: boolean, sign: string): string {
  const w = typeof s.width === "number" ? s.width : 0;
  const left = s.flags.includes("-");
  const zero = numeric && s.flags.includes("0") && !left && s.prec === null;
  const total = sign.length + body.length;
  if (total >= w) return sign + body;
  if (left) return sign + body + " ".repeat(w - total);
  if (zero) return sign + "0".repeat(w - total) + body;
  return " ".repeat(w - total) + sign + body;
}

interface Arg {
  t: CType;
  v: unknown;
}

function formatPrintf(fmt: number[], args: Arg[], ctx: Ctx, pos: Pos): number[] {
  const out: number[] = [];
  let ai = 0;
  const next = (): Arg | undefined => args[ai++];
  for (const s0 of parseFormat(fmt)) {
    if (s0.lit) {
      out.push(...s0.lit);
      continue;
    }
    const s = { ...s0 };
    if (s.width === "*") {
      const w = (next()?.v as number) | 0;
      s.width = Math.abs(w);
      if (w < 0) s.flags += "-";
    }
    if (s.prec === "*") {
      const p = (next()?.v as number) | 0;
      s.prec = p < 0 ? null : p;
    }
    const prec = s.prec as number | null;
    const a = s.conv && s.conv !== "%" ? next() : undefined;
    if (s.conv && !a && s.conv !== "n") {
      ctx.fault(`printf format has more % conversions than values: the chip prints stack garbage`, pos);
      continue;
    }
    const long = s.len.startsWith("l");
    const bits = long ? 32 : ctx.T.abi.intBits;
    const raw = a && typeof a.v === "number" ? a.v : 0;
    switch (s.conv) {
      case "d":
      case "i": {
        const v = bits === 32 ? raw | 0 : (raw << 16) >> 16;
        let digits = Math.abs(v).toString();
        if (prec !== null) digits = prec === 0 && v === 0 ? "" : digits.padStart(prec, "0");
        const sign = v < 0 ? "-" : s.flags.includes("+") ? "+" : s.flags.includes(" ") ? " " : "";
        out.push(...bytesOf(pad(digits, s, true, sign)));
        break;
      }
      case "u":
      case "x":
      case "X":
      case "o": {
        const v = bits === 32 ? raw >>> 0 : raw & 0xffff;
        const radix = s.conv === "u" ? 10 : s.conv === "o" ? 8 : 16;
        let digits = v.toString(radix);
        if (s.conv === "X") digits = digits.toUpperCase();
        if (prec !== null) digits = prec === 0 && v === 0 ? "" : digits.padStart(prec, "0");
        let prefix = "";
        if (s.flags.includes("#") && v !== 0) prefix = s.conv === "o" ? "0" : s.conv === "x" ? "0x" : s.conv === "X" ? "0X" : "";
        out.push(...bytesOf(pad(digits, s, true, prefix)));
        break;
      }
      case "c":
        out.push(...bytesOf(pad(String.fromCharCode(raw & 255), s, false, "")));
        break;
      case "s": {
        let b = a && a.t.k === "ptr" ? cstr(a.v as Ptr | null) : [];
        if (a && a.t.k === "ptr" && a.v === null) b = bytesOf("(null)");
        if (prec !== null) b = b.slice(0, prec);
        out.push(...bytesOf(pad(text(b), s, false, "")));
        break;
      }
      case "p": {
        const p = a?.v as Ptr | null;
        out.push(...bytesOf(pad(p ? "0x" + (0x100 + p.i * 2).toString(16) : "0x0", s, false, "")));
        break;
      }
      case "f":
      case "F":
      case "e":
      case "E":
      case "g":
      case "G":
        // avr-libc's default printf has no floating point: it prints a question mark
        out.push(...bytesOf(pad("?", s, false, "")));
        break;
      case "n":
        break;
      default:
        out.push(37, ...bytesOf(s.conv));
    }
  }
  return out;
}

/** Check a literal printf format against its values, as gcc's -Wformat does, but as a firmware fault. */
function checkFormat(fmt: number[], args: C[], ctx: Ctx, pos: Pos, name: string) {
  const specs = parseFormat(fmt).filter((s) => !s.lit && s.conv);
  const want: { bytes: number; conv: string; star?: boolean }[] = [];
  for (const s of specs) {
    if (s.width === "*") want.push({ bytes: ctx.T.abi.intBits / 8, conv: "*", star: true });
    if (s.prec === "*") want.push({ bytes: ctx.T.abi.intBits / 8, conv: "*", star: true });
    if (s.conv !== "n") want.push({ bytes: specBytes(s, ctx.T), conv: s.conv });
  }
  if (want.length > args.length) ctx.error(`${name}: the format has ${want.length} values to print but ${args.length} given; the chip would print stack garbage`, pos);
  want.forEach((w, i) => {
    const t = strip(decay(args[i]).t);
    const got = promotedBytes(t, ctx.T);
    if ("fFeEgG".includes(w.conv)) return; // prints ? either way; the size matches on AVR
    if (w.conv === "s" && !(t.k === "ptr")) ctx.error(`${name}: %s needs a string, given ${typeName(t)}`, args[i].pos);
    if (got !== w.bytes) {
      const hint = w.bytes === 2 && got === 4 ? (t.k === "float" ? " (AVR printf has no %f: use dtostrf)" : ": use %ld or %lu for a long") : w.bytes === 4 && got === 2 ? ": use %d or %u for an int, or cast it to (long)" : "";
      ctx.error(`${name}: %${w.conv} reads ${w.bytes} bytes but gets a ${typeName(t)} (${got} bytes); on the chip the rest of the line prints garbage${hint}`, args[i].pos);
    }
  });
}

// ---------- C strings ----------

const isSpace = (c: number) => c === 32 || (c >= 9 && c <= 13);
const isDigit = (c: number) => c >= 48 && c <= 57;
const isAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isXDigit = (c: number) => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const digitVal = (c: number) => (isDigit(c) ? c - 48 : c >= 97 && c <= 122 ? c - 87 : c >= 65 && c <= 90 ? c - 55 : 99);

function parseInteger(b: number[], base: number): { v: number; used: number } {
  let i = 0;
  while (i < b.length && isSpace(b[i])) i++;
  let neg = false;
  if (b[i] === 43 || b[i] === 45) {
    neg = b[i] === 45;
    i++;
  }
  if ((base === 0 || base === 16) && b[i] === 48 && (b[i + 1] | 32) === 120 && isXDigit(b[i + 2] ?? 0)) {
    i += 2;
    base = 16;
  } else if (base === 0) base = b[i] === 48 ? 8 : 10;
  let v = 0;
  let any = false;
  for (; i < b.length; i++) {
    const d = digitVal(b[i]);
    if (d >= base) break;
    v = v * base + d;
    any = true;
  }
  if (!any) return { v: 0, used: 0 };
  return { v: neg ? -v : v, used: i };
}

function parseFloatPrefix(b: number[]): { v: number; used: number } {
  const s = text(b);
  const m = /^\s*[+-]?(?:inf(?:inity)?|nan|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/i.exec(s);
  if (!m) return { v: 0, used: 0 };
  const body = m[0].trim().toLowerCase().replace("infinity", "inf");
  const v = body.endsWith("nan") ? NaN : body.endsWith("inf") ? (body.startsWith("-") ? -Infinity : Infinity) : parseFloat(body);
  return { v: Math.fround(v), used: m[0].length };
}

/** Write a C string (with its terminating zero) into memory, faulting where the chip would overrun. */
function putStr(p: Ptr | null, bytes: number[], el: CType, ctx: Ctx, pos: Pos, what: string): boolean {
  if (!p) {
    ctx.fault(`${what} writes through a NULL pointer`, pos);
    return false;
  }
  if (p.ro) {
    ctx.fault(`${what} writes into a string literal (read-only memory)`, pos);
    return false;
  }
  const room = p.m.length - p.i;
  const need = bytes.length + 1;
  if (need > room) ctx.fault(`${what} writes ${need} bytes where only ${room} fit: on the chip this overwrites other memory`, pos);
  const signed = el.k === "int" ? el.signed : true;
  const n = Math.min(need, room);
  for (let k = 0; k < n; k++) {
    const b = k < bytes.length ? bytes[k] & 255 : 0;
    p.m[p.i + k] = signed ? (b << 24) >> 24 : b;
  }
  return need <= room;
}

function ctypeFn(name: string, fn: (c: number) => number | boolean): LibFn {
  return def(name, ["int"], "int", 8, ([c]) => {
    const r = fn(c);
    return typeof r === "boolean" ? (r ? 1 : 0) : r;
  });
}

const BLOCK_STEP_MS = 1;

// ---------- the core functions ----------

function mathFn(name: string, cyc: number, fn: (...x: number[]) => number, n = 1): LibFn {
  return def(name, (n === 1 ? ["double"] : ["double", "double"]) as PK[], "double", cyc, (v) => fn(...(v as number[])));
}

function randomNext(s: LibState): number {
  // avr-libc random(): Park-Miller minimal standard
  let x = s.seed;
  if (x === 0) x = 123459876;
  const hi = Math.trunc(x / 127773);
  const lo = x % 127773;
  x = 16807 * lo - 2836 * hi;
  if (x < 0) x += 0x7fffffff;
  s.seed = x;
  return x % 0x80000000;
}

const libFuncs: Record<string, LibFn> = {
  pinMode: def("pinMode", ["u8", "u8"], "void", 40, ([p, m], c) => c.hal.pinMode(p, m)),
  digitalWrite: def("digitalWrite", ["u8", "u8"], "void", 60, ([p, v], c) => c.hal.digitalWrite(p, v)),
  digitalRead: def("digitalRead", ["u8"], "int", 50, ([p], c) => c.hal.digitalRead(p)),
  analogRead: def("analogRead", ["u8"], "int", 30, ([p], c) => {
    const v = c.hal.analogRead(p);
    // a conversion takes 13 ADC clocks at 125 kHz
    c.hal.spend(Math.round(c.hal.fcpu * 104e-6));
    return v;
  }),
  analogReadMilliVolts: def("analogReadMilliVolts", ["u8"], "ulong", 30, ([p], c) => {
    const v = c.hal.analogMilliVolts(p);
    c.hal.spend(Math.round(c.hal.fcpu * 104e-6));
    return v;
  }),
  analogWrite: def("analogWrite", ["u8", "int"], "void", 70, ([p, v], c) => c.hal.analogWrite(p, v)),
  analogReference: def("analogReference", ["u8"], "void", 10, ([m], c) => c.hal.analogReference(m)),
  // the ESP32 core's PWM (LEDC, core 3.x: by pin). A board without it reports that the sketch would not compile
  ledcAttach: def("ledcAttach", ["u8", "ulong", "u8"], "bool", 400, ([p, hz, bits], c) => (c.hal.pwmAttach ? c.hal.pwmAttach(p, hz, bits) : 0)),
  ledcWrite: def("ledcWrite", ["u8", "ulong"], "bool", 90, ([p, d], c) => (c.hal.pwmWrite ? c.hal.pwmWrite(p, d) : 0)),
  ledcRead: def("ledcRead", ["u8"], "ulong", 30, ([p], c) => c.hal.pwmRead?.(p) ?? 0),
  ledcReadFreq: def("ledcReadFreq", ["u8"], "ulong", 30, ([p], c) => c.hal.pwmHz?.(p) ?? 0),
  ledcChangeFrequency: def("ledcChangeFrequency", ["u8", "ulong", "u8"], "ulong", 400, ([p, hz, bits], c) => (c.hal.pwmAttach?.(p, hz, bits, "ledcChangeFrequency") ? hz : 0)),
  ledcDetach: def("ledcDetach", ["u8"], "bool", 60, ([p], c) => {
    c.hal.pinMode(p, 0);
    return 1;
  }),
  analogWriteFrequency: def("analogWriteFrequency", ["u8", "ulong"], "void", 400, ([p, hz], c) => {
    c.hal.pwmAttach?.(p, hz, -1, "analogWriteFrequency");
  }),
  analogWriteResolution: def("analogWriteResolution", ["u8", "u8"], "void", 400, ([p, bits], c) => {
    c.hal.pwmAttach?.(p, -1, bits, "analogWriteResolution");
  }),
  millis: def("millis", [], "ulong", 30, (_v, c) => c.hal.millis()),
  micros: def("micros", [], "ulong", 40, (_v, c) => c.hal.micros()),
  delay: def("delay", ["ulong"], "void", 20, ([ms], c) => c.hal.spend((ms * c.hal.fcpu) / 1000)),
  delayMicroseconds: def("delayMicroseconds", ["uint"], "void", 10, ([us], c) => c.hal.spend((us * c.hal.fcpu) / 1e6)),
  // GCC's AVR builtin; nops in inline assembly come here too
  __builtin_avr_delay_cycles: def("__builtin_avr_delay_cycles", ["ulong"], "void", 0, ([n], c) => c.hal.spend(n)),
  attachInterrupt: def("attachInterrupt", ["u8", "fn", "int"], "void", 60, ([n, fn, mode], c, pos) => {
    if (!fn) return c.fault("attachInterrupt() given no function", pos);
    c.hal.attachInterrupt(n, fn as FnRef, mode);
  }),
  detachInterrupt: def("detachInterrupt", ["u8"], "void", 20, ([n], c) => c.hal.detachInterrupt(n)),
  digitalPinToInterrupt: def("digitalPinToInterrupt", ["u8"], "int", 4, ([p], c) => c.hal.digitalPinToInterrupt(p)),
  cli: def("cli", [], "void", 1, (_v, c) => c.hal.setInterrupts(false)),
  sei: def("sei", [], "void", 1, (_v, c) => c.hal.setInterrupts(true)),
  tone: def("tone", ["u8", "uint", "ulong"], "void", 80, ([p, f, d], c) => c.hal.tone(p, f, d), [0]),
  noTone: def("noTone", ["u8"], "void", 30, ([p], c) => c.hal.noTone(p)),
  yield: def("yield", [], "void", 2, () => undefined),
  pulseIn: def("pulseIn", ["u8", "u8", "ulong"], "ulong", 40, ([pin, state, timeout], c) => pulseIn(c.hal, pin, state, timeout), [1_000_000]),
  pulseInLong: def("pulseInLong", ["u8", "u8", "ulong"], "ulong", 40, ([pin, state, timeout], c) => pulseIn(c.hal, pin, state, timeout), [1_000_000]),
  shiftOut: def("shiftOut", ["u8", "u8", "u8", "u8"], "void", 30, ([dp, cp, order, val], c) => {
    for (let i = 0; i < 8; i++) {
      const bit = order === 0 ? (val >> i) & 1 : (val >> (7 - i)) & 1;
      c.hal.digitalWrite(dp, bit);
      c.hal.digitalWrite(cp, 1);
      c.hal.digitalWrite(cp, 0);
      burn(c.hal, 190);
    }
  }),
  shiftIn: def("shiftIn", ["u8", "u8", "u8"], "u8", 30, ([dp, cp, order], c) => {
    let v = 0;
    for (let i = 0; i < 8; i++) {
      c.hal.digitalWrite(cp, 1);
      const b = c.hal.digitalRead(dp);
      v |= order === 0 ? b << i : b << (7 - i);
      c.hal.digitalWrite(cp, 0);
      burn(c.hal, 190);
    }
    return v;
  }),
  random: (args, ctx, pos) => {
    if (args.length < 1 || args.length > 2) argCount("random", 1, 2, args.length, ctx, pos);
    const a = numEv(args[0], ctx.T.long, ctx, "random()");
    const b = args[1] ? numEv(args[1], ctx.T.long, ctx, "random()") : null;
    const s = ctx.lib;
    const one = (big: number) => (big === 0 ? 0 : randomNext(s) % big);
    const ev: Ev = b
      ? (f) => {
          const lo = a(f);
          const hi = b(f);
          return lo >= hi ? lo : (one((hi - lo) | 0) + lo) | 0;
        }
      : (f) => one(a(f));
    return { t: ctx.T.long, ev, cost: sumCost(args) + 600, pos };
  },
  randomSeed: def("randomSeed", ["ulong"], "void", 20, ([seed], c) => {
    if (seed !== 0) c.lib.seed = seed % 0x7fffffff || 1;
  }),
  rand: def("rand", [], "int", 600, (_v, c) => randomNext(c.lib) % 0x8000),
  srand: def("srand", ["uint"], "void", 20, ([seed], c) => {
    c.lib.seed = seed || 1;
  }),
  map: def("map", ["long", "long", "long", "long", "long"], "long", 700, ([x, inMin, inMax, outMin, outMax], c, pos) => {
    const den = (inMax - inMin) | 0;
    if (den === 0) {
      c.fault("map() with the same low and high input divides by zero", pos);
      return -1;
    }
    const num = Math.imul((x - inMin) | 0, (outMax - outMin) | 0);
    return (Math.trunc(num / den) + outMin) | 0;
  }),

  // maths (avr-libc, 32-bit double)
  sin: mathFn("sin", 1650, Math.sin),
  cos: mathFn("cos", 1600, Math.cos),
  tan: mathFn("tan", 2000, Math.tan),
  asin: mathFn("asin", 2200, Math.asin),
  acos: mathFn("acos", 2200, Math.acos),
  atan: mathFn("atan", 2000, Math.atan),
  atan2: mathFn("atan2", 2500, Math.atan2, 2),
  sinh: mathFn("sinh", 2200, Math.sinh),
  cosh: mathFn("cosh", 2200, Math.cosh),
  tanh: mathFn("tanh", 2200, Math.tanh),
  exp: mathFn("exp", 1800, Math.exp),
  log: mathFn("log", 2100, Math.log),
  log10: mathFn("log10", 2300, Math.log10),
  pow: mathFn("pow", 4000, Math.pow, 2),
  sqrt: mathFn("sqrt", 490, Math.sqrt),
  cbrt: mathFn("cbrt", 2500, Math.cbrt),
  square: mathFn("square", 140, (x) => x * x),
  fabs: mathFn("fabs", 10, Math.abs),
  floor: mathFn("floor", 100, Math.floor),
  ceil: mathFn("ceil", 100, Math.ceil),
  trunc: mathFn("trunc", 100, Math.trunc),
  fmod: mathFn("fmod", 1000, (a, b) => a % b, 2),
  hypot: mathFn("hypot", 1200, Math.hypot, 2),
  fmin: mathFn("fmin", 70, Math.min, 2),
  fmax: mathFn("fmax", 70, Math.max, 2),
  ldexp: def("ldexp", ["double", "int"], "double", 60, ([x, e]) => x * 2 ** e),
  lround: def("lround", ["double"], "long", 150, ([x]) => (x < 0 ? -Math.round(-x) : Math.round(x))),
  lrint: def("lrint", ["double"], "long", 150, ([x]) => Math.round(x)),
  isnan: def("isnan", ["double"], "int", 20, ([x]) => (Number.isNaN(x) ? 1 : 0)),
  isinf: def("isinf", ["double"], "int", 20, ([x]) => (x === Infinity ? 1 : x === -Infinity ? -1 : 0)),
  labs: def("labs", ["long"], "long", 10, ([x]) => Math.abs(x)),

  // C strings
  strlen: def("strlen", ["ptr"], "size", 10, ([p], c) => {
    const n = cstr(p).length;
    burn(c.hal, 4 * n);
    return n;
  }),
  strcmp: def("strcmp", ["ptr", "ptr"], "int", 10, ([a, b], c) => compareStr(cstr(a), cstr(b), Infinity, c.hal)),
  strncmp: def("strncmp", ["ptr", "ptr", "size"], "int", 10, ([a, b, n], c) => compareStr(cstr(a), cstr(b), n, c.hal)),
  strcasecmp: def("strcasecmp", ["ptr", "ptr"], "int", 10, ([a, b], c) => compareStr(cstr(a).map(lower), cstr(b).map(lower), Infinity, c.hal)),
  strncasecmp: def("strncasecmp", ["ptr", "ptr", "size"], "int", 10, ([a, b, n], c) => compareStr(cstr(a).map(lower), cstr(b).map(lower), n, c.hal)),
  strchr: def("strchr", ["ptr", "int"], "charp", 10, ([p, ch]) => findChr(p, ch & 255, false)),
  strrchr: def("strrchr", ["ptr", "int"], "charp", 10, ([p, ch]) => findChr(p, ch & 255, true)),
  strstr: def("strstr", ["ptr", "ptr"], "charp", 30, ([p, q]) => {
    if (!p) return null;
    const h = text(cstr(p));
    const k = h.indexOf(text(cstr(q)));
    return k < 0 ? null : { m: (p as Ptr).m, i: (p as Ptr).i + k, ro: (p as Ptr).ro };
  }),
  strcpy: strFn("strcpy", (dst, src) => cstr(src)),
  strncpy: (args, ctx, pos) => {
    if (args.length !== 3) argCount("strncpy", 3, 3, args.length, ctx, pos);
    const D = ptrEv(args[0], ctx, "strncpy()");
    const S = ptrEv(args[1], ctx, "strncpy()");
    const N = numEv(args[2], ctx.T.sizeT, ctx, "strncpy()");
    const el = pointee(args[0]);
    return {
      t: { k: "ptr", to: ctx.T.char },
      ev: (f) => {
        const d = D(f) as Ptr | null;
        const n = N(f);
        const s = cstr(S(f) as Ptr | null, n);
        // strncpy pads with zeros to n and does not terminate a string of n or more bytes
        const bytes = s.concat(new Array(Math.max(0, n - s.length)).fill(0)).slice(0, n);
        if (d && !d.ro) {
          if (d.i + n > d.m.length) ctx.fault(`strncpy() writes ${n} bytes where only ${d.m.length - d.i} fit`, pos);
          writeBytes(d, el, bytes.slice(0, Math.max(0, d.m.length - d.i)), ctx.abi);
        } else ctx.fault("strncpy() writes through a NULL or read-only pointer", pos);
        burn(ctx.hal, 6 * n);
        return d;
      },
      cost: sumCost(args) + 20,
      pos,
    };
  },
  strcat: strFn("strcat", (dst, src) => cstr(dst).concat(cstr(src))),
  strncat: (args, ctx, pos) => {
    if (args.length !== 3) argCount("strncat", 3, 3, args.length, ctx, pos);
    const D = ptrEv(args[0], ctx, "strncat()");
    const S = ptrEv(args[1], ctx, "strncat()");
    const N = numEv(args[2], ctx.T.sizeT, ctx, "strncat()");
    const el = pointee(args[0]);
    return {
      t: { k: "ptr", to: ctx.T.char },
      ev: (f) => {
        const d = D(f) as Ptr | null;
        putStr(d, cstr(d).concat(cstr(S(f) as Ptr | null, N(f))), el, ctx, pos, "strncat()");
        return d;
      },
      cost: sumCost(args) + 30,
      pos,
    };
  },
  memset: (args, ctx, pos) => {
    if (args.length !== 3) argCount("memset", 3, 3, args.length, ctx, pos);
    const D = ptrEv(args[0], ctx, "memset()");
    const V = numEv(args[1], ctx.T.int, ctx, "memset()");
    const N = numEv(args[2], ctx.T.sizeT, ctx, "memset()");
    const el = pointee(args[0]);
    return {
      t: { k: "ptr", to: VOID },
      ev: (f) => {
        const d = D(f) as Ptr | null;
        const n = N(f);
        if (!d || d.ro) {
          ctx.fault("memset() writes through a NULL or read-only pointer", pos);
          return d;
        }
        const wrote = writeBytes(d, el, new Array(n).fill(V(f) & 255), ctx.abi);
        if (wrote < n) ctx.fault(`memset() writes ${n} bytes where only ${wrote} fit: on the chip this overwrites other memory`, pos);
        burn(ctx.hal, 2 * n);
        return d;
      },
      cost: sumCost(args) + 20,
      pos,
    };
  },
  memcpy: memCopy("memcpy"),
  memmove: memCopy("memmove"),
  memcmp: (args, ctx, pos) => {
    if (args.length !== 3) argCount("memcmp", 3, 3, args.length, ctx, pos);
    const A = ptrEv(args[0], ctx, "memcmp()");
    const B = ptrEv(args[1], ctx, "memcmp()");
    const N = numEv(args[2], ctx.T.sizeT, ctx, "memcmp()");
    const ea = pointee(args[0]);
    const eb = pointee(args[1]);
    return {
      t: ctx.T.int,
      ev: (f) => {
        const n = N(f);
        const a = A(f) as Ptr | null;
        const b = B(f) as Ptr | null;
        if (!a || !b) {
          ctx.fault("memcmp() reads through a NULL pointer", pos);
          return 0;
        }
        const x = readBytes(a, ea, n, ctx.abi);
        const y = readBytes(b, eb, n, ctx.abi);
        burn(ctx.hal, 3 * n);
        for (let i = 0; i < n; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
        return 0;
      },
      cost: sumCost(args) + 20,
      pos,
    };
  },
  atoi: def("atoi", ["ptr"], "int", 80, ([p]) => parseInteger(cstr(p), 10).v),
  atol: def("atol", ["ptr"], "long", 120, ([p]) => parseInteger(cstr(p), 10).v),
  atof: def("atof", ["ptr"], "double", 900, ([p]) => parseFloatPrefix(cstr(p)).v),
  strtol: strto("strtol", "long", (b, base) => {
    const r = parseInteger(b, base);
    return { v: Math.max(-2147483648, Math.min(2147483647, r.v)), used: r.used };
  }),
  strtoul: strto("strtoul", "ulong", (b, base) => {
    const r = parseInteger(b, base);
    const v = Math.abs(r.v) > 4294967295 ? 4294967295 : r.v < 0 ? 4294967296 + r.v : r.v;
    return { v, used: r.used };
  }),
  strtod: strto("strtod", "double", (b) => parseFloatPrefix(b)),
  itoa: toA("itoa", "int", 16),
  ltoa: toA("ltoa", "long", 32),
  utoa: toA("utoa", "uint", 16),
  ultoa: toA("ultoa", "ulong", 32),
  dtostrf: (args, ctx, pos) => {
    if (args.length !== 4) argCount("dtostrf", 4, 4, args.length, ctx, pos);
    const V = numEv(args[0], ctx.T.double, ctx, "dtostrf()");
    const W = numEv(args[1], ctx.T.schar, ctx, "dtostrf()");
    const P = numEv(args[2], ctx.T.uchar, ctx, "dtostrf()");
    const S = ptrEv(args[3], ctx, "dtostrf()");
    const el = pointee(args[3]);
    return {
      t: { k: "ptr", to: ctx.T.char },
      ev: (f) => {
        const v = Math.fround(V(f));
        const w = W(f);
        const p = P(f);
        // avr-libc keeps about 7 significant digits, then pads with zeros
        let s = Number.isNaN(v) ? "nan" : !Number.isFinite(v) ? (v < 0 ? "-inf" : "inf") : Number(v.toPrecision(7)).toFixed(p);
        if (s.length < Math.abs(w)) s = w < 0 ? s.padEnd(-w) : s.padStart(w);
        const d = S(f) as Ptr | null;
        putStr(d, bytesOf(s), el, ctx, pos, "dtostrf()");
        burn(ctx.hal, 900 + 400 * s.length);
        return d;
      },
      cost: sumCost(args) + 40,
      pos,
    };
  },
  sprintf: (args, ctx, pos) => printfFn("sprintf", args, ctx, pos, false),
  snprintf: (args, ctx, pos) => printfFn("snprintf", args, ctx, pos, true),

  toupper: ctypeFn("toupper", (c) => (c >= 97 && c <= 122 ? c - 32 : c)),
  tolower: ctypeFn("tolower", lower),
  isdigit: ctypeFn("isdigit", isDigit),
  isalpha: ctypeFn("isalpha", isAlpha),
  isalnum: ctypeFn("isalnum", (c) => isAlpha(c) || isDigit(c)),
  isspace: ctypeFn("isspace", isSpace),
  isupper: ctypeFn("isupper", (c) => c >= 65 && c <= 90),
  islower: ctypeFn("islower", (c) => c >= 97 && c <= 122),
  isxdigit: ctypeFn("isxdigit", isXDigit),
  isprint: ctypeFn("isprint", (c) => c >= 32 && c < 127),
  ispunct: ctypeFn("ispunct", (c) => c > 32 && c < 127 && !isAlpha(c) && !isDigit(c)),
  iscntrl: ctypeFn("iscntrl", (c) => c < 32 || c === 127),
  isDigit: ctypeFn("isDigit", isDigit),
  isAlpha: ctypeFn("isAlpha", isAlpha),
  isAlphaNumeric: ctypeFn("isAlphaNumeric", (c) => isAlpha(c) || isDigit(c)),
  isSpace: ctypeFn("isSpace", isSpace),
  isWhitespace: ctypeFn("isWhitespace", (c) => c === 32 || c === 9),
  isUpperCase: ctypeFn("isUpperCase", (c) => c >= 65 && c <= 90),
  isLowerCase: ctypeFn("isLowerCase", (c) => c >= 97 && c <= 122),
  isHexadecimalDigit: ctypeFn("isHexadecimalDigit", isXDigit),
  isPrintable: ctypeFn("isPrintable", (c) => c >= 32 && c < 127),
  isPunct: ctypeFn("isPunct", (c) => c > 32 && c < 127 && !isAlpha(c) && !isDigit(c)),
  isControl: ctypeFn("isControl", (c) => c < 32 || c === 127),
  isAscii: ctypeFn("isAscii", (c) => c >= 0 && c < 128),
  toUpperCase: ctypeFn("toUpperCase", (c) => (c >= 97 && c <= 122 ? c - 32 : c)),
  toLowerCase: ctypeFn("toLowerCase", lower),
  toAscii: ctypeFn("toAscii", (c) => c & 0x7f),
};

function lower(c: number): number {
  return c >= 65 && c <= 90 ? c + 32 : c;
}

function compareStr(a: number[], b: number[], n: number, hal: Hal): number {
  const len = Math.min(n, Math.max(a.length, b.length) + 1);
  burn(hal, 5 * len);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x - y;
    if (!x) return 0;
  }
  return 0;
}

function findChr(p: Ptr | null, ch: number, last: boolean): Ptr | null {
  if (!p) return null;
  const b = cstr(p);
  const k = ch === 0 ? b.length : last ? b.lastIndexOf(ch) : b.indexOf(ch);
  return k < 0 ? null : { m: p.m, i: p.i + k, ro: p.ro };
}

function strFn(name: string, make: (dst: Ptr | null, src: Ptr | null) => number[]): LibFn {
  return (args, ctx, pos) => {
    if (args.length !== 2) argCount(name, 2, 2, args.length, ctx, pos);
    const D = ptrEv(args[0], ctx, `${name}()`);
    const S = ptrEv(args[1], ctx, `${name}()`);
    const el = pointee(args[0]);
    return {
      t: { k: "ptr", to: ctx.T.char },
      ev: (f) => {
        const d = D(f) as Ptr | null;
        const bytes = make(d, S(f) as Ptr | null);
        putStr(d, bytes, el, ctx, pos, `${name}()`);
        burn(ctx.hal, 6 * bytes.length);
        return d;
      },
      cost: sumCost(args) + 20,
      pos,
    };
  };
}

function memCopy(name: string): LibFn {
  return (args, ctx, pos) => {
    if (args.length !== 3) argCount(name, 3, 3, args.length, ctx, pos);
    const D = ptrEv(args[0], ctx, `${name}()`);
    const S = ptrEv(args[1], ctx, `${name}()`);
    const N = numEv(args[2], ctx.T.sizeT, ctx, `${name}()`);
    const ed = pointee(args[0]);
    const es = pointee(args[1]);
    return {
      t: { k: "ptr", to: VOID },
      ev: (f) => {
        const d = D(f) as Ptr | null;
        const s = S(f) as Ptr | null;
        const n = N(f);
        if (!d || !s || d.ro) {
          ctx.fault(`${name}() with a NULL or read-only pointer`, pos);
          return d;
        }
        const bytes = readBytes(s, es, n, ctx.abi);
        if (bytes.length < n) ctx.fault(`${name}() reads ${n} bytes where only ${bytes.length} exist: on the chip it copies whatever follows`, pos);
        const wrote = writeBytes(d, ed, bytes, ctx.abi);
        if (wrote < bytes.length) ctx.fault(`${name}() writes ${n} bytes where only ${wrote} fit: on the chip this overwrites other memory`, pos);
        burn(ctx.hal, 4 * n);
        return d;
      },
      cost: sumCost(args) + 20,
      pos,
    };
  };
}

function strto(name: string, ret: "long" | "ulong" | "double", parse: (b: number[], base: number) => { v: number; used: number }): LibFn {
  return (args, ctx, pos) => {
    const isFloat = ret === "double";
    const max = isFloat ? 2 : 3;
    if (args.length < (isFloat ? 1 : 2) || args.length > max) argCount(name, isFloat ? 1 : 2, max, args.length, ctx, pos);
    const S = ptrEv(args[0], ctx, `${name}()`);
    const E = args[1] ? ptrEv(args[1], ctx, `${name}()`) : () => null;
    const B = args[2] ? numEv(args[2], ctx.T.int, ctx, `${name}()`) : () => 10;
    const rt = typeOf(ret, ctx.T);
    const rc = converter(rt, null)!;
    return {
      t: rt,
      ev: (f) => {
        const s = S(f) as Ptr | null;
        const end = E(f) as Ptr | null;
        const r = parse(cstr(s), B(f));
        burn(ctx.hal, (isFloat ? 300 : 120) * Math.max(1, r.used));
        if (end && s) end.m[end.i] = { m: s.m, i: s.i + r.used, ro: s.ro };
        return rc(r.v);
      },
      cost: sumCost(args) + 40,
      pos,
    };
  };
}

function toA(name: string, kind: "int" | "long" | "uint" | "ulong", bits: 16 | 32): LibFn {
  return (args, ctx, pos) => {
    if (args.length !== 3) argCount(name, 3, 3, args.length, ctx, pos);
    const V = numEv(args[0], typeOf(kind, ctx.T), ctx, `${name}()`);
    const S = ptrEv(args[1], ctx, `${name}()`);
    const R = numEv(args[2], ctx.T.int, ctx, `${name}()`);
    const el = pointee(args[1]);
    const signed = kind === "int" || kind === "long";
    return {
      t: { k: "ptr", to: ctx.T.char },
      ev: (f) => {
        const v = V(f);
        const radix = R(f);
        const d = S(f) as Ptr | null;
        let s: string;
        if (radix < 2 || radix > 36) s = "";
        else if (signed && radix === 10 && v < 0) s = "-" + (-v).toString(10);
        else s = (bits === 16 ? v & 0xffff : v >>> 0).toString(radix);
        putStr(d, bytesOf(s), el, ctx, pos, `${name}()`);
        burn(ctx.hal, 300 * s.length);
        return d;
      },
      cost: sumCost(args) + 30,
      pos,
    };
  };
}

function printfFn(name: string, args: C[], ctx: Ctx, pos: Pos, sized: boolean): C {
  const fixed = sized ? 3 : 2;
  if (args.length < fixed) argCount(name, fixed, Infinity, args.length, ctx, pos);
  const D = ptrEv(args[0], ctx, `${name}()`);
  const N = sized ? numEv(args[1], ctx.T.sizeT, ctx, `${name}()`) : null;
  const fmtC = decay(args[fixed - 1]);
  const F = ptrEv(fmtC, ctx, `${name}()`);
  const rest = args.slice(fixed).map(decay);
  if (fmtC.lit) checkFormat(fmtC.lit, rest, ctx, pos, name);
  const evs = rest.map((a) => {
    const t = strip(a.t);
    const ev = a.ev;
    // default promotions: float to double, small ints to int
    if (t.k === "float") return (f: Frame): Arg => ({ t: ctx.T.double, v: ev(f) });
    return (f: Frame): Arg => ({ t, v: ev(f) });
  });
  const el = pointee(args[0]);
  return {
    t: ctx.T.int,
    ev: (f) => {
      const fmt = cstr(F(f) as Ptr | null);
      const out = formatPrintf(
        fmt,
        evs.map((e) => e(f)),
        ctx,
        pos,
      );
      const d = D(f) as Ptr | null;
      burn(ctx.hal, 400 + 250 * out.length);
      if (N) {
        const n = N(f);
        if (n > 0) putStr(d, out.slice(0, n - 1), el, ctx, pos, name + "()");
      } else putStr(d, out, el, ctx, pos, name + "()");
      return out.length;
    },
    cost: sumCost(args) + 60,
    pos,
  };
}

function pulseIn(hal: Hal, pin: number, state: number, timeoutUs: number): number {
  if (hal.pulseIn) return hal.pulseIn(pin, state, timeoutUs);
  const start = hal.micros();
  const step = Math.round(hal.fcpu * 4e-6);
  const elapsed = () => (hal.micros() - start) >>> 0;
  while (hal.digitalRead(pin) === state) {
    if (elapsed() > timeoutUs) return 0;
    hal.spend(step);
  }
  while (hal.digitalRead(pin) !== state) {
    if (elapsed() > timeoutUs) return 0;
    hal.spend(step);
  }
  const t0 = hal.micros();
  while (hal.digitalRead(pin) === state) {
    if (elapsed() > timeoutUs) return 0;
    hal.spend(step);
  }
  return (hal.micros() - t0) >>> 0;
}

// ---------- Serial ----------

function serialPrint(port: number, ln: boolean): LibFn {
  return (args, ctx, pos) => {
    const name = ln ? "println" : "print";
    if (args.length > 2 || (!ln && args.length === 0)) argCount(`Serial.${name}`, ln ? 0 : 1, 2, args.length, ctx, pos);
    const hal = ctx.hal;
    const nl = ln ? [13, 10] : [];
    if (args.length === 0) return { t: ctx.T.sizeT, ev: () => hal.serialWrite(port, nl), cost: 40, pos };
    const a = decay(args[0]);
    const t = strip(a.t);
    if (t.k === "ptr" && !(t.to.k === "int" && t.to.bits === 8)) ctx.error(`Serial.${name}() cannot print a pointer to ${typeName(t.to)}`, a.pos);
    if (t.k === "struct" || t.k === "arr" || t.k === "class" || t.k === "fn" || t.k === "void") ctx.error(`Serial.${name}() cannot print ${typeName(t)}`, a.pos);
    const A = a.ev;
    const S = args[1] ? numEv(args[1], ctx.T.int, ctx, `Serial.${name}()`) : null;
    const isNum = t.k !== "ptr" && !(t.k === "int" && t.char && !S);
    const perChar = t.k === "float" ? 1100 : isNum ? (t.k === "int" && t.bits <= 16 ? 250 : 700) : 20;
    return {
      t: ctx.T.sizeT,
      ev: (f) => {
        const bytes = printBytes(t, A(f), S ? S(f) : undefined, ctx, pos);
        burn(hal, 60 + perChar * bytes.length);
        return hal.serialWrite(port, nl.length ? bytes.concat(nl) : bytes);
      },
      cost: sumCost(args) + 40,
      pos,
    };
  };
}

function serialObject(port: number): Record<string, LibFn> {
  const waitByte = (ctx: Ctx): number => {
    const hal = ctx.hal;
    const start = hal.millis();
    while (hal.serialAvailable(port) === 0) {
      if (((hal.millis() - start) >>> 0) >= ctx.lib.serialTimeout) return -1;
      hal.spend((hal.fcpu * BLOCK_STEP_MS) / 1000);
    }
    return hal.serialPeek(port);
  };
  return dict({
    begin: def("Serial.begin", ["ulong", "u8"], "void", 200, ([baud], c) => c.hal.serialBegin(port, baud), [6]),
    end: def("Serial.end", [], "void", 20, () => undefined),
    print: serialPrint(port, false),
    println: serialPrint(port, true),
    write: (args, ctx, pos) => {
      if (args.length < 1 || args.length > 2) argCount("Serial.write", 1, 2, args.length, ctx, pos);
      const hal = ctx.hal;
      const a = decay(args[0]);
      const t = strip(a.t);
      if (args.length === 2) {
        const P = ptrEv(a, ctx, "Serial.write()");
        const N = numEv(args[1], ctx.T.sizeT, ctx, "Serial.write()");
        const el = pointee(args[0]);
        return { t: ctx.T.sizeT, ev: (f) => hal.serialWrite(port, readBytes(P(f) as Ptr, el, N(f), ctx.abi)), cost: sumCost(args) + 40, pos };
      }
      if (t.k === "ptr") {
        const P = a.ev;
        return { t: ctx.T.sizeT, ev: (f) => hal.serialWrite(port, cstr(P(f) as Ptr | null)), cost: sumCost(args) + 40, pos };
      }
      const V = numEv(a, ctx.T.uchar, ctx, "Serial.write()");
      return { t: ctx.T.sizeT, ev: (f) => hal.serialWrite(port, [V(f)]), cost: sumCost(args) + 30, pos };
    },
    available: def("Serial.available", [], "int", 20, (_v, c) => c.hal.serialAvailable(port)),
    availableForWrite: def("Serial.availableForWrite", [], "int", 20, () => 63),
    read: def("Serial.read", [], "int", 30, (_v, c) => c.hal.serialRead(port)),
    peek: def("Serial.peek", [], "int", 20, (_v, c) => c.hal.serialPeek(port)),
    flush: def("Serial.flush", [], "void", 20, (_v, c) => c.hal.serialFlush(port)),
    setTimeout: def("Serial.setTimeout", ["ulong"], "void", 10, ([ms], c) => {
      c.lib.serialTimeout = ms;
    }),
    parseInt: def("Serial.parseInt", [], "long", 200, (_v, c) => {
      const hal = c.hal;
      let ch = waitByte(c);
      while (ch >= 0 && !(isDigit(ch) || ch === 45)) {
        hal.serialRead(port);
        ch = waitByte(c);
      }
      if (ch < 0) return 0;
      let neg = false;
      let v = 0;
      if (ch === 45) {
        neg = true;
        hal.serialRead(port);
      }
      for (;;) {
        ch = waitByte(c);
        if (ch < 0 || !isDigit(ch)) break;
        v = v * 10 + ch - 48;
        hal.serialRead(port);
      }
      return neg ? -v : v;
    }),
    parseFloat: def("Serial.parseFloat", [], "double", 400, (_v, c) => {
      const hal = c.hal;
      let ch = waitByte(c);
      while (ch >= 0 && !(isDigit(ch) || ch === 45 || ch === 46)) {
        hal.serialRead(port);
        ch = waitByte(c);
      }
      const b: number[] = [];
      for (;;) {
        ch = waitByte(c);
        if (ch < 0 || !(isDigit(ch) || ch === 45 || ch === 46)) break;
        b.push(ch);
        hal.serialRead(port);
      }
      return parseFloatPrefix(b).v;
    }),
    readBytes: (args, ctx, pos) => {
      if (args.length !== 2) argCount("Serial.readBytes", 2, 2, args.length, ctx, pos);
      const P = ptrEv(args[0], ctx, "Serial.readBytes()");
      const N = numEv(args[1], ctx.T.sizeT, ctx, "Serial.readBytes()");
      const el = pointee(args[0]);
      return {
        t: ctx.T.sizeT,
        ev: (f) => {
          const n = N(f);
          const got: number[] = [];
          while (got.length < n && waitByte(ctx) >= 0) got.push(ctx.hal.serialRead(port));
          const p = P(f) as Ptr | null;
          if (p) writeBytes(p, el, got, ctx.abi);
          return got.length;
        },
        cost: sumCost(args) + 40,
        pos,
      };
    },
    readBytesUntil: (args, ctx, pos) => {
      if (args.length !== 3) argCount("Serial.readBytesUntil", 3, 3, args.length, ctx, pos);
      const T0 = numEv(args[0], ctx.T.int, ctx, "Serial.readBytesUntil()");
      const P = ptrEv(args[1], ctx, "Serial.readBytesUntil()");
      const N = numEv(args[2], ctx.T.sizeT, ctx, "Serial.readBytesUntil()");
      const el = pointee(args[1]);
      return {
        t: ctx.T.sizeT,
        ev: (f) => {
          const term = T0(f) & 255;
          const n = N(f);
          const got: number[] = [];
          while (got.length < n && waitByte(ctx) >= 0) {
            const ch = ctx.hal.serialRead(port);
            if (ch === term) break;
            got.push(ch);
          }
          const p = P(f) as Ptr | null;
          if (p) writeBytes(p, el, got, ctx.abi);
          return got.length;
        },
        cost: sumCost(args) + 40,
        pos,
      };
    },
    // if (Serial): always ready on the boards simulated here
    "@value": (_a, ctx, pos) => ({ t: BOOL, ev: () => 1, cost: 2, pos: pos ?? { file: "", line: 0 }, cv: undefined }),
  });
}

// ---------- Wire (I2C master) ----------

const WIRE_BUFFER = 32;

const wire: Record<string, LibFn> = dict({
  begin: (args, ctx, pos) => {
    if (args.length) ctx.error("Wire.begin(address) makes this board an I2C peripheral, which the simulator does not run; use Wire.begin()", pos);
    return { t: VOID, ev: () => ctx.hal.wireBegin(), cost: 200, pos };
  },
  end: def("Wire.end", [], "void", 20, () => undefined),
  setClock: def("Wire.setClock", ["ulong"], "void", 40, ([hz], c) => c.hal.wireSetClock(hz)),
  setWireTimeout: def("Wire.setWireTimeout", ["ulong", "bool"], "void", 10, () => undefined, [25000, 0]),
  beginTransmission: def("Wire.beginTransmission", ["int"], "void", 30, ([addr], c) => {
    c.lib.wireAddr = addr & 0x7f;
    c.lib.wireTx = [];
  }),
  write: (args, ctx, pos) => {
    if (args.length < 1 || args.length > 2) argCount("Wire.write", 1, 2, args.length, ctx, pos);
    const s = ctx.lib;
    const push = (bytes: number[]) => {
      if (!s.wireTx) return 0;
      const room = WIRE_BUFFER - s.wireTx.length;
      const n = Math.min(room, bytes.length);
      for (let i = 0; i < n; i++) s.wireTx.push(bytes[i] & 255);
      return n;
    };
    const a = decay(args[0]);
    const t = strip(a.t);
    if (args.length === 2) {
      const P = ptrEv(a, ctx, "Wire.write()");
      const N = numEv(args[1], ctx.T.sizeT, ctx, "Wire.write()");
      const el = pointee(args[0]);
      return { t: ctx.T.sizeT, ev: (f) => push(readBytes(P(f) as Ptr, el, N(f), ctx.abi)), cost: sumCost(args) + 30, pos };
    }
    if (t.k === "ptr") {
      const P = a.ev;
      return { t: ctx.T.sizeT, ev: (f) => push(cstr(P(f) as Ptr | null)), cost: sumCost(args) + 30, pos };
    }
    const V = numEv(a, ctx.T.uchar, ctx, "Wire.write()");
    return { t: ctx.T.sizeT, ev: (f) => push([V(f)]), cost: sumCost(args) + 25, pos };
  },
  endTransmission: def("Wire.endTransmission", ["bool"], "u8", 40, ([stop], c) => {
    const s = c.lib;
    if (!s.wireTx) return 4;
    const bytes = s.wireTx;
    s.wireTx = null;
    return c.hal.wireWrite(s.wireAddr, bytes, !!stop);
  }, [1]),
  requestFrom: def("Wire.requestFrom", ["int", "int", "bool"], "u8", 40, ([addr, qty, stop], c) => {
    const s = c.lib;
    const n = Math.max(0, Math.min(WIRE_BUFFER, qty));
    s.wireRx = n ? c.hal.wireRead(addr & 0x7f, n, !!stop).slice(0, n) : [];
    s.wireRxPos = 0;
    return s.wireRx.length;
  }, [1]),
  available: def("Wire.available", [], "int", 10, (_v, c) => c.lib.wireRx.length - c.lib.wireRxPos),
  read: def("Wire.read", [], "int", 15, (_v, c) => {
    const s = c.lib;
    return s.wireRxPos < s.wireRx.length ? s.wireRx[s.wireRxPos++] : -1;
  }),
  peek: def("Wire.peek", [], "int", 10, (_v, c) => {
    const s = c.lib;
    return s.wireRxPos < s.wireRx.length ? s.wireRx[s.wireRxPos] : -1;
  }),
  onReceive: (_a, ctx, pos) => ctx.error("Wire.onReceive() is for an I2C peripheral, which the simulator does not run", pos),
  onRequest: (_a, ctx, pos) => ctx.error("Wire.onRequest() is for an I2C peripheral, which the simulator does not run", pos),
});

// ---------- EEPROM ----------

function eepromAddr(ctx: Ctx, addr: number, n: number, pos: Pos, what: string): number {
  const len = ctx.hal.eeprom.length;
  if (addr < 0 || addr + n > len) ctx.fault(`EEPROM.${what} at address ${addr} is past the end (${len} bytes): the chip wraps around and overwrites the start`, pos);
  return ((addr % len) + len) % len;
}

function eepromProgram(hal: Hal, addr: number, v: number, update: boolean) {
  const len = hal.eeprom.length;
  const a = ((addr % len) + len) % len;
  if (update && hal.eeprom[a] === (v & 255)) {
    burn(hal, 40);
    return;
  }
  hal.eepromWrite(a, v & 255);
}

const eeprom: Record<string, LibFn> = dict({
  read: def("EEPROM.read", ["int"], "u8", 20, ([a], c, pos) => c.hal.eeprom[eepromAddr(c, a, 1, pos, "read")]),
  write: def("EEPROM.write", ["int", "u8"], "void", 20, ([a, v], c, pos) => eepromProgram(c.hal, eepromAddr(c, a, 1, pos, "write"), v, false)),
  update: def("EEPROM.update", ["int", "u8"], "void", 20, ([a, v], c, pos) => eepromProgram(c.hal, eepromAddr(c, a, 1, pos, "update"), v, true)),
  length: def("EEPROM.length", [], "uint", 4, (_v, c) => c.hal.eeprom.length),
  // the ESP32 core emulates EEPROM in flash: begin(size) maps it, commit() writes it back
  begin: def("EEPROM.begin", ["int"], "bool", 4, () => 1, [0]),
  commit: def("EEPROM.commit", [], "bool", 40, () => 1),
  end: def("EEPROM.end", [], "void", 4, () => undefined),
  get: (args, ctx, pos) => {
    if (args.length !== 2) argCount("EEPROM.get", 2, 2, args.length, ctx, pos);
    const A = numEv(args[0], ctx.T.int, ctx, "EEPROM.get()");
    const target = args[1];
    const lv = target.lv;
    if (!lv) return ctx.error("EEPROM.get() needs a variable to read into", target.pos);
    const t = strip(target.t);
    const n = sizeOf(t, ctx.abi);
    const set = lv.set;
    return {
      t,
      ev: (f) => {
        const addr = eepromAddr(ctx, A(f), n, pos, "get");
        const e = ctx.hal.eeprom;
        const bytes: number[] = [];
        for (let i = 0; i < n; i++) bytes.push(e[(addr + i) % e.length]);
        const v = fromBytes(t, bytes, 0, ctx.abi);
        set(f, v);
        burn(ctx.hal, 20 * n);
        return v;
      },
      cost: sumCost(args) + 30,
      pos,
    };
  },
  put: (args, ctx, pos) => {
    if (args.length !== 2) argCount("EEPROM.put", 2, 2, args.length, ctx, pos);
    const A = numEv(args[0], ctx.T.int, ctx, "EEPROM.put()");
    const src = args[1];
    const t = strip(src.t);
    const n = sizeOf(t, ctx.abi);
    const V = src.ev;
    return {
      t,
      ev: (f) => {
        const addr = eepromAddr(ctx, A(f), n, pos, "put");
        const v = V(f);
        const bytes = toBytes(t, v, ctx.abi);
        // put() only programs the bytes that changed, like update()
        for (let i = 0; i < n; i++) eepromProgram(ctx.hal, addr + i, bytes[i], true);
        return v;
      },
      cost: sumCost(args) + 30,
      pos,
    };
  },
  "[]": (args, ctx, pos) => {
    const A = numEv(args[0], ctx.T.int, ctx, "EEPROM[]");
    const hal = ctx.hal;
    const at = (f: Frame) => eepromAddr(ctx, A(f), 1, pos, "[]");
    return {
      t: ctx.T.uchar,
      ev: (f) => hal.eeprom[at(f)],
      lv: {
        get: (f) => hal.eeprom[at(f)],
        set: (f, v) => eepromProgram(hal, at(f), v as number, false),
        ptr: (f) => ({ m: hal.eeprom as unknown as unknown[], i: at(f) }),
      },
      cost: sumCost(args) + 20,
      pos,
    };
  },
});

// ---------- Servo ----------

interface ServoObj {
  kind: "Servo";
  pin: number;
  min: number;
  max: number;
  us: number;
}

const servoArg = (obj: C, ctx: Ctx): Ev => {
  const ev = obj.lv ? obj.lv.get : obj.ev;
  void ctx;
  return ev;
};

const servo: LibClass = {
  methods: dict<LibMethod>({
    attach: (obj, args, ctx, pos) => {
      if (args.length !== 1 && args.length !== 3) argCount("Servo.attach", 1, 3, args.length, ctx, pos);
      const O = servoArg(obj, ctx);
      const P = numEv(args[0], ctx.T.int, ctx, "attach()");
      const MN = args[1] ? numEv(args[1], ctx.T.int, ctx, "attach()") : () => 544;
      const MX = args[2] ? numEv(args[2], ctx.T.int, ctx, "attach()") : () => 2400;
      return {
        t: ctx.T.uchar,
        ev: (f) => {
          const s = O(f) as ServoObj;
          s.pin = P(f);
          s.min = MN(f);
          s.max = MX(f);
          ctx.hal.servoPulse(s.pin, s.us);
          return 1;
        },
        cost: sumCost(args) + 100,
        pos,
      };
    },
    write: (obj, args, ctx, pos) => {
      if (args.length !== 1) argCount("Servo.write", 1, 1, args.length, ctx, pos);
      const O = servoArg(obj, ctx);
      const V = numEv(args[0], ctx.T.int, ctx, "write()");
      return {
        t: VOID,
        ev: (f) => {
          const s = O(f) as ServoObj;
          let v = V(f);
          if (v < 544) {
            v = Math.max(0, Math.min(180, v));
            v = Math.trunc(((v - 0) * (s.max - s.min)) / 180) + s.min;
          }
          s.us = Math.max(s.min, Math.min(s.max, v));
          if (s.pin >= 0) ctx.hal.servoPulse(s.pin, s.us);
        },
        cost: sumCost(args) + 120,
        pos,
      };
    },
    writeMicroseconds: (obj, args, ctx, pos) => {
      if (args.length !== 1) argCount("Servo.writeMicroseconds", 1, 1, args.length, ctx, pos);
      const O = servoArg(obj, ctx);
      const V = numEv(args[0], ctx.T.int, ctx, "writeMicroseconds()");
      return {
        t: VOID,
        ev: (f) => {
          const s = O(f) as ServoObj;
          s.us = Math.max(s.min, Math.min(s.max, V(f)));
          if (s.pin >= 0) ctx.hal.servoPulse(s.pin, s.us);
        },
        cost: sumCost(args) + 60,
        pos,
      };
    },
    read: (obj, _args, ctx, pos) => {
      const O = servoArg(obj, ctx);
      return {
        t: ctx.T.int,
        ev: (f) => {
          const s = O(f) as ServoObj;
          return Math.trunc(((s.us + 1 - s.min) * 180) / (s.max - s.min));
        },
        cost: 80,
        pos,
      };
    },
    readMicroseconds: (obj, _args, ctx, pos) => {
      const O = servoArg(obj, ctx);
      return { t: ctx.T.int, ev: (f) => (O(f) as ServoObj).us, cost: 20, pos };
    },
    // ESP32Servo: the frame rate (50 Hz analog, up to 333 Hz digital servos); the pulse width is what moves it
    setPeriodHertz: (obj, args, ctx, pos) => {
      if (args.length !== 1) argCount("Servo.setPeriodHertz", 1, 1, args.length, ctx, pos);
      const O = servoArg(obj, ctx);
      const V = numEv(args[0], ctx.T.int, ctx, "setPeriodHertz()");
      return { t: VOID, ev: (f) => void ((O(f) as ServoObj & { hz?: number }).hz = V(f)), cost: sumCost(args) + 20, pos };
    },
    attached: (obj, _args, ctx, pos) => {
      const O = servoArg(obj, ctx);
      return { t: BOOL, ev: (f) => ((O(f) as ServoObj).pin >= 0 ? 1 : 0), cost: 10, pos };
    },
    detach: (obj, _args, ctx, pos) => {
      const O = servoArg(obj, ctx);
      return {
        t: VOID,
        ev: (f) => {
          const s = O(f) as ServoObj;
          if (s.pin >= 0) ctx.hal.servoPulse(s.pin, null);
          s.pin = -1;
        },
        cost: 40,
        pos,
      };
    },
  }),
};

// ---------- Adafruit_NeoPixel ----------
// The Adafruit library's calls, colour packing and maths (ColorHSV, gamma32,
// sine8) as it does them. show() hands the frame to the board, which sends it
// down the data pin to the LED boards wired there; on an AVR it holds the CPU
// for about 30 µs per LED with interrupts off, as the real one does.

interface PixelObj {
  kind: "NeoPixel";
  n: number;
  pin: number;
  /** the NEO_* type: colour order and speed */
  type: number;
  /** 0 = full (the library keeps brightness + 1, wrapping 255 to 0) */
  bright: number;
  px: number[];
}

const newPixels = (n = 0, pin = -1, type = 0x52): PixelObj => ({ kind: "NeoPixel", n, pin, type, bright: 0, px: new Array<number>(Math.max(0, n)).fill(0) });

/** Adafruit's gamma table: round(255 · (i/255)^2.6) */
const GAMMA8 = Array.from({ length: 256 }, (_, i) => Math.round(Math.pow(i / 255, 2.6) * 255));
/** Adafruit's sine table: one cycle over 0..255, 0..255 */
const SINE8 = Array.from({ length: 256 }, (_, i) => Math.min(255, Math.max(0, Math.round(127.5 + 127.5 * Math.sin((2 * Math.PI * i) / 256)))));
const pack = (r: number, g: number, b: number, w = 0) => ((((w & 255) << 24) | ((r & 255) << 16) | ((g & 255) << 8) | (b & 255)) >>> 0);

/** Adafruit_NeoPixel::ColorHSV: hue 0..65535 round the colour wheel, saturation and value 0..255. */
function colorHSV(hue: number, sat: number, val: number): number {
  let r: number;
  let g: number;
  let b: number;
  hue = (((hue & 0xffff) * 1530 + 32768) / 65536) | 0;
  if (hue < 510) {
    b = 0;
    if (hue < 255) (r = 255), (g = hue);
    else (r = 510 - hue), (g = 255);
  } else if (hue < 1020) {
    r = 0;
    if (hue < 765) (g = 255), (b = hue - 510);
    else (g = 1020 - hue), (b = 255);
  } else if (hue < 1530) {
    g = 0;
    if (hue < 1275) (r = hue - 1020), (b = 255);
    else (r = 255), (b = 1530 - hue);
  } else (r = 255), (g = 0), (b = 0);
  const v1 = 1 + (val & 255);
  const s1 = 1 + (sat & 255);
  const s2 = 255 - (sat & 255);
  const ch = (c: number) => ((((((c * s1) >> 8) + s2) * v1) & 0xff00) >> 8);
  return pack(ch(r), ch(g), ch(b));
}

/** a method taking numbers: args converted to the given C types, at most max of them */
function pxMethod(name: string, types: ("u8" | "u16" | "u32" | "int")[], min: number, ret: "void" | "u8" | "u16" | "u32" | "bool", cyc: number, run: (o: PixelObj, v: number[], ctx: Ctx) => number | void): LibMethod {
  return (obj, args, ctx, pos) => {
    if (args.length < min || args.length > types.length) argCount(`Adafruit_NeoPixel.${name}`, min, types.length, args.length, ctx, pos);
    const O = obj.lv ? obj.lv.get : obj.ev;
    const conv = (k: string) => (k === "u8" ? ctx.T.uchar : k === "u16" ? ctx.T.uint : k === "u32" ? ctx.T.ulong : ctx.T.int);
    const evs = args.map((a, i) => numEv(a, conv(types[i]), ctx, `${name}()`));
    const t = ret === "void" ? VOID : ret === "bool" ? BOOL : conv(ret === "u8" ? "u8" : ret === "u16" ? "u16" : "u32");
    return {
      t,
      ev: (f) => {
        const v = run(O(f) as PixelObj, evs.map((e) => e(f) as number), ctx);
        return ret === "void" ? undefined : (v ?? 0);
      },
      cost: sumCost(args) + cyc,
      pos,
    };
  };
}

const neoPixel: LibClass = {
  construct: (args, ctx, pos) => {
    if (args.length > 3) argCount("Adafruit_NeoPixel", 0, 3, args.length, ctx, pos);
    const N = args[0] ? numEv(args[0], ctx.T.uint, ctx, "Adafruit_NeoPixel()") : () => 0;
    const P = args[1] ? numEv(args[1], ctx.T.int, ctx, "Adafruit_NeoPixel()") : () => 6;
    const T = args[2] ? numEv(args[2], ctx.T.uint, ctx, "Adafruit_NeoPixel()") : () => 0x52;
    return { t: { k: "class", name: "Adafruit_NeoPixel" }, ev: (f) => newPixels(N(f) as number, P(f) as number, T(f) as number), cost: sumCost(args) + 60, pos };
  },
  methods: dict<LibMethod>({
    begin: pxMethod("begin", [], 0, "void", 40, (o, _v, ctx) => {
      if (o.pin >= 0) ctx.hal.pinMode(o.pin, 1);
    }),
    show: pxMethod("show", [], 0, "void", 60, (o, _v, ctx) => {
      if (o.pin < 0 || !o.n) return;
      const b = o.bright;
      const out = o.px.map((c) => {
        if (!b) return c;
        const sc = (x: number) => ((x * b) >> 8) & 255;
        return pack(sc((c >>> 16) & 255), sc((c >>> 8) & 255), sc(c & 255), sc((c >>> 24) & 255));
      });
      ctx.hal.pixels?.(o.pin, out, o.type);
      // 24 bits at 800 kHz per LED, with interrupts off on an AVR
      burn(ctx.hal, o.n * 30e-6 * ctx.hal.fcpu + 50e-6 * ctx.hal.fcpu);
    }),
    setPixelColor: pxMethod("setPixelColor", ["u16", "u32", "u8", "u8", "u8"], 2, "void", 40, (o, v) => {
      const i = v[0];
      if (i >= o.n) return;
      o.px[i] = v.length === 2 ? v[1] >>> 0 : pack(v[1], v[2], v[3], v[4] ?? 0);
    }),
    getPixelColor: pxMethod("getPixelColor", ["u16"], 1, "u32", 30, (o, v) => (v[0] < o.n ? o.px[v[0]] : 0)),
    fill: pxMethod("fill", ["u32", "u16", "u16"], 0, "void", 20, (o, v, ctx) => {
      const c = (v[0] ?? 0) >>> 0;
      const first = v[1] ?? 0;
      const count = v[2] ?? 0;
      if (first >= o.n) return;
      const end = count === 0 ? o.n : Math.min(o.n, first + count);
      for (let i = first; i < end; i++) o.px[i] = c;
      burn(ctx.hal, (end - first) * 12);
    }),
    clear: pxMethod("clear", [], 0, "void", 20, (o, _v, ctx) => {
      o.px.fill(0);
      burn(ctx.hal, o.n * 6);
    }),
    setBrightness: pxMethod("setBrightness", ["u8"], 1, "void", 30, (o, v) => {
      o.bright = (v[0] + 1) & 255;
    }),
    getBrightness: pxMethod("getBrightness", [], 0, "u8", 10, (o) => (o.bright - 1) & 255),
    numPixels: pxMethod("numPixels", [], 0, "u16", 10, (o) => o.n),
    getPin: pxMethod("getPin", [], 0, "u16", 10, (o) => o.pin),
    canShow: pxMethod("canShow", [], 0, "bool", 20, () => 1),
    setPin: pxMethod("setPin", ["int"], 1, "void", 30, (o, v, ctx) => {
      o.pin = v[0];
      if (o.pin >= 0) ctx.hal.pinMode(o.pin, 1);
    }),
    updateLength: pxMethod("updateLength", ["u16"], 1, "void", 60, (o, v) => {
      o.n = v[0];
      o.px = new Array<number>(o.n).fill(0);
    }),
    updateType: pxMethod("updateType", ["u16"], 1, "void", 20, (o, v) => {
      o.type = v[0];
    }),
    // the library's static helpers, called through an instance
    Color: pxMethod("Color", ["u8", "u8", "u8", "u8"], 3, "u32", 12, (_o, v) => pack(v[0], v[1], v[2], v[3] ?? 0)),
    ColorHSV: pxMethod("ColorHSV", ["u16", "u8", "u8"], 1, "u32", 120, (_o, v) => colorHSV(v[0], v[1] ?? 255, v[2] ?? 255)),
    gamma32: pxMethod("gamma32", ["u32"], 1, "u32", 40, (_o, v) => pack(GAMMA8[(v[0] >>> 16) & 255], GAMMA8[(v[0] >>> 8) & 255], GAMMA8[v[0] & 255], GAMMA8[(v[0] >>> 24) & 255])),
    gamma8: pxMethod("gamma8", ["u8"], 1, "u8", 8, (_o, v) => GAMMA8[v[0] & 255]),
    sine8: pxMethod("sine8", ["u8"], 1, "u8", 8, (_o, v) => SINE8[v[0] & 255]),
  }),
};

export const LIB_FUNCS: Record<string, LibFn> = dict(libFuncs);
export const LIB_OBJECTS: Record<string, Record<string, LibFn>> = dict({ Serial: serialObject(0), Wire: wire, EEPROM: eeprom });
export const LIB_CLASSES: Record<string, LibClass> = dict({ Servo: servo, Adafruit_NeoPixel: neoPixel });
/** Library class names the parser accepts as types. */
export const CLASS_NAMES = new Set(Object.keys(LIB_CLASSES));

export function newClassInstance(name: string): unknown {
  if (name === "Servo") return { kind: "Servo", pin: -1, min: 544, max: 2400, us: 1500 } satisfies ServoObj;
  if (name === "Adafruit_NeoPixel") return newPixels();
  return {};
}
