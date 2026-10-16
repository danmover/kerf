// Memory as the firmware sees it. Variables hold JS values (numbers, and
// arrays for structs and C arrays), so anything that looks at memory as bytes
// (memcpy, EEPROM.put, Wire.write of a struct, a pointer cast) goes through
// the chip's layout: little-endian, no padding on AVR.

import { sameType, sizeOf, type Abi, type CType } from "./ctypes";
import type { Ptr } from "./vm";

const dv = new DataView(new ArrayBuffer(8));

/** Append the bytes of a value of type t. */
export function toBytes(t: CType, v: unknown, abi: Abi, out: number[] = []): number[] {
  switch (t.k) {
    case "bool":
      out.push(v ? 1 : 0);
      return out;
    case "enum":
      return toBytes(t.base, v, abi, out);
    case "int": {
      if (t.bits === 64) {
        let x = BigInt.asUintN(64, BigInt(Math.trunc((v as number) || 0)));
        for (let i = 0; i < 8; i++) {
          out.push(Number(x & BigInt(255)));
          x >>= BigInt(8);
        }
        return out;
      }
      let x = (v as number) | 0;
      for (let i = 0; i < t.bits / 8; i++) {
        out.push(x & 255);
        x >>= 8;
      }
      return out;
    }
    case "float":
      if (t.bits === 32) dv.setFloat32(0, (v as number) || 0, true);
      else dv.setFloat64(0, (v as number) || 0, true);
      for (let i = 0; i < t.bits / 8; i++) out.push(dv.getUint8(i));
      return out;
    case "arr": {
      const a = (v as unknown[]) ?? [];
      for (let i = 0; i < t.n; i++) toBytes(t.of, a[i], abi, out);
      return out;
    }
    case "struct": {
      const s = (v as unknown[]) ?? [];
      const start = out.length;
      t.fields.forEach((f, i) => {
        while (out.length < start + f.offset) out.push(0);
        toBytes(f.type, s[i], abi, out);
      });
      while (out.length < start + t.size) out.push(0);
      return out;
    }
    default: {
      // pointers, function pointers and library objects: their address means nothing outside the run
      const n = sizeOf(t, abi);
      for (let i = 0; i < n; i++) out.push(0);
      return out;
    }
  }
}

/** Read a value of type t from bytes. */
export function fromBytes(t: CType, b: ArrayLike<number>, off: number, abi: Abi): unknown {
  switch (t.k) {
    case "bool":
      return b[off] ? 1 : 0;
    case "enum":
      return fromBytes(t.base, b, off, abi);
    case "int": {
      const n = t.bits / 8;
      if (t.bits === 64) {
        let x = BigInt(0);
        for (let i = n - 1; i >= 0; i--) x = (x << BigInt(8)) | BigInt(b[off + i] & 255);
        return Number(t.signed ? BigInt.asIntN(64, x) : x);
      }
      let x = 0;
      for (let i = n - 1; i >= 0; i--) x = (x << 8) | (b[off + i] & 255);
      if (t.bits === 8) return t.signed ? (x << 24) >> 24 : x & 255;
      if (t.bits === 16) return t.signed ? (x << 16) >> 16 : x & 0xffff;
      return t.signed ? x | 0 : x >>> 0;
    }
    case "float":
      for (let i = 0; i < t.bits / 8; i++) dv.setUint8(i, b[off + i] & 255);
      return t.bits === 32 ? dv.getFloat32(0, true) : dv.getFloat64(0, true);
    case "arr": {
      const es = sizeOf(t.of, abi);
      const a = new Array(t.n);
      for (let i = 0; i < t.n; i++) a[i] = fromBytes(t.of, b, off + i * es, abi);
      return a;
    }
    case "struct":
      return t.fields.map((f) => fromBytes(f.type, b, off + f.offset, abi));
    case "ptr":
    case "fn":
      return null;
    default:
      return 0;
  }
}

/** Copy a value so the copy shares no arrays with the original (struct and array assignment). */
export function deepCopy<T>(v: T): T {
  return (Array.isArray(v) ? v.map(deepCopy) : v) as T;
}

/** A sized type a byte view can stand in for (not void or an incomplete struct). */
const sized = (t: CType) => t.k !== "void" && t.k !== "fn" && t.k !== "class" && !(t.k === "struct" && !t.complete);

/**
 * Whether reading memory of type `from` through a pointer to `to` changes the
 * values read: a cast between different element types (char* to uint8_t*, a
 * struct to bytes). Casts to and from void* keep the pointer as it is.
 */
export function needsView(from: CType, to: CType): boolean {
  if (!sized(from) || !sized(to)) return false;
  if (sameType(from, to)) return false;
  if (from.k === "struct" && to.k === "struct") return from.name !== to.name;
  if (from.k === "ptr" && to.k === "ptr") return false;
  if (from.k === "enum" && to.k === "int") return !sameType(from.base, to);
  if (to.k === "enum" && from.k === "int") return !sameType(to.base, from);
  return true;
}

function proxyArray(length: number, get: (k: number) => unknown, set: (k: number, v: unknown) => void): unknown[] {
  return new Proxy([] as unknown[], {
    get(_t, prop) {
      if (typeof prop !== "string") return undefined;
      if (prop === "length") return length;
      const k = Number(prop);
      return Number.isInteger(k) ? (k >= 0 && k < length ? get(k) : undefined) : undefined;
    },
    set(_t, prop, v) {
      const k = Number(prop);
      if (Number.isInteger(k) && k >= 0 && k < length) set(k, v);
      return true;
    },
  });
}

/**
 * Memory of type `from` (from p onwards) seen as elements of type `to`, as a
 * pointer cast does on the chip: reads and writes go through the bytes.
 */
export function castView(p: Ptr, from: CType, to: CType, abi: Abi): Ptr {
  const m = p.m;
  const base = p.i;
  const sf = sizeOf(from, abi);
  const st = sizeOf(to, abi);
  const avail = Math.max(0, m.length - base);
  // same-size whole numbers only change how the bits read (char <-> uint8_t)
  if (from.k === "int" && to.k === "int" && sf === st && st <= 4) {
    const rd = (x: number) => fromBytes(to, toBytes(from, x, abi), 0, abi);
    const wr = (x: number) => fromBytes(from, toBytes(to, x, abi), 0, abi);
    return { m: proxyArray(avail, (k) => rd(m[base + k] as number), (k, v) => (m[base + k] = wr(v as number))), i: 0, ro: p.ro };
  }
  const byteAt = (j: number): number => {
    const e = base + Math.floor(j / sf);
    if (e >= m.length) return 0;
    return toBytes(from, m[e], abi)[j % sf];
  };
  const setByte = (j: number, v: number) => {
    const e = base + Math.floor(j / sf);
    if (e >= m.length) return;
    const bytes = toBytes(from, m[e], abi);
    bytes[j % sf] = v & 255;
    m[e] = fromBytes(from, bytes, 0, abi);
  };
  const n = Math.floor((avail * sf) / st);
  return {
    m: proxyArray(
      n,
      (k) => {
        const bytes: number[] = [];
        for (let j = 0; j < st; j++) bytes.push(byteAt(k * st + j));
        return fromBytes(to, bytes, 0, abi);
      },
      (k, v) => {
        const bytes = toBytes(to, v, abi);
        for (let j = 0; j < st; j++) setByte(k * st + j, bytes[j]);
      },
    ),
    i: 0,
    ro: p.ro,
  };
}

/** Read n bytes of memory starting at p, whose elements have type t. */
export function readBytes(p: Ptr, t: CType, n: number, abi: Abi): number[] {
  const es = sized(t) ? sizeOf(t, abi) : 1;
  const out: number[] = [];
  for (let e = p.i; out.length < n && e < p.m.length; e++) {
    if (es === 1 && (t.k === "int" || t.k === "bool" || t.k === "void")) out.push((p.m[e] as number) & 255);
    else toBytes(sized(t) ? t : { k: "int", bits: 8, signed: false, name: "uint8_t" }, p.m[e], abi, out);
  }
  out.length = Math.min(out.length, n);
  return out;
}

/**
 * Write bytes into memory starting at p, whose elements have type t. A
 * partial last element keeps its other bytes. Returns how many bytes fit.
 */
export function writeBytes(p: Ptr, t: CType, bytes: number[], abi: Abi): number {
  const tt: CType = sized(t) ? t : { k: "int", bits: 8, signed: false, name: "uint8_t" };
  const es = sizeOf(tt, abi);
  let j = 0;
  for (let e = p.i; j < bytes.length && e < p.m.length; e++) {
    if (es === 1) {
      p.m[e] = fromBytes(tt, [bytes[j]], 0, abi);
      j++;
      continue;
    }
    const cur = toBytes(tt, p.m[e], abi);
    for (let k = 0; k < es && j < bytes.length; k++, j++) cur[k] = bytes[j];
    p.m[e] = fromBytes(tt, cur, 0, abi);
  }
  return j;
}
