// Arduino's Print class: how print() and println() turn a value into characters, chosen by the value's C type
// like the C++ overloads (Print.cpp). Serial uses it, and so does every library object that prints: an SD card
// File, an LCD. printMethods() gives such an object its print, println and write.

import type { Pos } from "./ast";
import { strip, typeName, type CType } from "./ctypes";
import { bytesOf, cstr, type C, type Ctx } from "./ir";
import { readBytes } from "./mem";
import { argCount, burn, decay, numEv, pointee, ptrEv, sumCost, type LibMethod } from "./libBase";
import type { Ptr } from "./vm";

// ---------- number formatting (Print.cpp) ----------

export function printNumber(n: number, base: number): number[] {
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
export function printBytes(t: CType, v: unknown, second: number | undefined, ctx: Ctx, pos: Pos): number[] {
  if (t.k === "ptr") return cstr(v as Ptr | null);
  if (t.k === "float") return printFloat(v as number, second ?? 2);
  if (t.k === "int" && t.char) return second === undefined ? [(v as number) & 255] : printInt(v as number, true, 32, second);
  if (t.k === "int") return printInt(v as number, t.signed, t.bits, second ?? 10);
  if (t.k === "bool" || t.k === "enum") return printInt(v as number, true, 32, second ?? 10);
  return ctx.error(`Serial.print cannot print ${typeName(t)}`, pos);
}

export function printInt(n: number, signed: boolean, bits: number, base: number): number[] {
  if (base === 0) return [n & 255];
  if (bits === 64) {
    const neg = signed && n < 0;
    const s = Math.abs(n).toString(base < 2 ? 10 : base).toUpperCase();
    return bytesOf(base === 10 && neg ? "-" + s : s);
  }
  if (signed && base === 10 && n < 0) return [45, ...printNumber(-n, 10)];
  return printNumber(n >>> 0, base);
}


/**
 * print(), println() and write() for a library object that prints (an SD File, an LCD): `put` takes the bytes and
 * says how many it took, as Print::write does.
 */
export function printMethods(cls: string, put: (obj: unknown, bytes: number[], ctx: Ctx) => number, objOf: (obj: C, ctx: Ctx) => (f: unknown[]) => unknown): Record<string, LibMethod> {
  const printer =
    (ln: boolean): LibMethod =>
    (obj, args, ctx, pos) => {
      const name = `${cls}.${ln ? "println" : "print"}`;
      if (args.length > 2 || (!ln && args.length === 0)) argCount(name, ln ? 0 : 1, 2, args.length, ctx, pos);
      const O = objOf(obj, ctx);
      const nl = ln ? [13, 10] : [];
      if (args.length === 0) return { t: ctx.T.sizeT, ev: (f) => put(O(f), nl, ctx), cost: 40, pos };
      const a = decay(args[0]);
      const t = strip(a.t);
      if (t.k === "ptr" && !(t.to.k === "int" && t.to.bits === 8)) ctx.error(`${name}() cannot print a pointer to ${typeName(t.to)}`, a.pos);
      if (t.k === "struct" || t.k === "arr" || t.k === "class" || t.k === "fn" || t.k === "void") ctx.error(`${name}() cannot print ${typeName(t)}`, a.pos);
      const A = a.ev;
      const S = args[1] ? numEv(args[1], ctx.T.int, ctx, `${name}()`) : null;
      const isNum = t.k !== "ptr" && !(t.k === "int" && t.char && !S);
      const perChar = t.k === "float" ? 1100 : isNum ? (t.k === "int" && t.bits <= 16 ? 250 : 700) : 20;
      return {
        t: ctx.T.sizeT,
        ev: (f) => {
          const bytes = printBytes(t, A(f), S ? S(f) : undefined, ctx, pos);
          burn(ctx.hal, 40 + perChar * bytes.length);
          return put(O(f), nl.length ? bytes.concat(nl) : bytes, ctx);
        },
        cost: sumCost(args) + 40,
        pos,
      };
    };
  const write: LibMethod = (obj, args, ctx, pos) => {
    if (args.length < 1 || args.length > 2) argCount(`${cls}.write`, 1, 2, args.length, ctx, pos);
    const O = objOf(obj, ctx);
    const a = decay(args[0]);
    const t = strip(a.t);
    if (args.length === 2) {
      const P = ptrEv(a, ctx, `${cls}.write()`);
      const N = numEv(args[1], ctx.T.sizeT, ctx, `${cls}.write()`);
      const el = pointee(args[0]);
      return { t: ctx.T.sizeT, ev: (f) => put(O(f), readBytes(P(f) as Ptr, el, N(f) as number, ctx.abi), ctx), cost: sumCost(args) + 40, pos };
    }
    if (t.k === "ptr") {
      const P = a.ev;
      return { t: ctx.T.sizeT, ev: (f) => put(O(f), cstr(P(f) as Ptr | null), ctx), cost: sumCost(args) + 40, pos };
    }
    const V = numEv(a, ctx.T.uchar, ctx, `${cls}.write()`);
    return { t: ctx.T.sizeT, ev: (f) => put(O(f), [(V(f) as number) & 255], ctx), cost: sumCost(args) + 30, pos };
  };
  return { print: printer(false), println: printer(true), write };
}
