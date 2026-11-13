// C types as the target chip sees them. On an 8-bit AVR an int is 16 bits and
// double is the same 32-bit float as float, so arithmetic wraps and rounds
// exactly where the real Arduino's does (120 * 1000 overflows, for example).

export interface Abi {
  /** bits in an int (16 on AVR, 32 on ARM and Xtensa) */
  intBits: 16 | 32;
  ptrBytes: 2 | 4;
  /** bits in a double (32 on AVR) */
  doubleBits: 32 | 64;
  /** plain char is signed */
  charSigned: boolean;
}

export const AVR: Abi = { intBits: 16, ptrBytes: 2, doubleBits: 32, charSigned: true };
/** ESP32 (Xtensa LX6): 32-bit int and pointers, a real 64-bit double */
export const XTENSA: Abi = { intBits: 32, ptrBytes: 4, doubleBits: 64, charSigned: true };

export interface StructField {
  name: string;
  type: CType;
  offset: number;
}

export type CType =
  | { k: "void" }
  | { k: "bool" }
  | { k: "int"; bits: 8 | 16 | 32 | 64; signed: boolean; name: string; char?: boolean }
  | { k: "float"; bits: 32 | 64 }
  | { k: "ptr"; to: CType }
  | { k: "arr"; of: CType; n: number }
  /** lib: declared by a library's header (FastLED's CRGB), so the library's C++ for it applies (LibStruct) */
  | { k: "struct"; name: string; fields: StructField[]; size: number; complete: boolean; lib?: boolean }
  | { k: "enum"; name: string; base: CType }
  | { k: "fn"; ret: CType; params: CType[]; variadic?: boolean }
  | { k: "ref"; to: CType }
  /** objects of library classes (Servo); behaviour lives in the runtime */
  | { k: "class"; name: string };

export const VOID: CType = { k: "void" };
export const BOOL: CType = { k: "bool" };

export function intType(bits: 8 | 16 | 32 | 64, signed: boolean, name?: string, char = false): CType {
  return { k: "int", bits, signed, name: name ?? `${signed ? "" : "u"}int${bits}_t`, char };
}

export interface Types {
  abi: Abi;
  int: CType;
  uint: CType;
  long: CType;
  ulong: CType;
  llong: CType;
  char: CType;
  schar: CType;
  uchar: CType;
  short: CType;
  ushort: CType;
  float: CType;
  double: CType;
  sizeT: CType;
}

export function typesFor(abi: Abi): Types {
  const ib = abi.intBits;
  return {
    abi,
    int: intType(ib, true, "int"),
    uint: intType(ib, false, "unsigned int"),
    long: intType(32, true, "long"),
    ulong: intType(32, false, "unsigned long"),
    llong: intType(64, true, "long long"),
    char: intType(8, abi.charSigned, "char", true),
    schar: intType(8, true, "signed char"),
    uchar: intType(8, false, "unsigned char"),
    short: intType(16, true, "short"),
    ushort: intType(16, false, "unsigned short"),
    float: { k: "float", bits: 32 },
    double: { k: "float", bits: abi.doubleBits },
    sizeT: intType(ib, false, "size_t"),
  };
}

export const isInt = (t: CType): t is Extract<CType, { k: "int" }> => t.k === "int";
export const isIntegral = (t: CType) => t.k === "int" || t.k === "bool" || t.k === "enum";
export const isArith = (t: CType) => isIntegral(t) || t.k === "float";
export const isPtrLike = (t: CType) => t.k === "ptr" || t.k === "arr";
export const isScalar = (t: CType) => isArith(t) || t.k === "ptr";
export const strip = (t: CType): CType => (t.k === "ref" ? t.to : t);

export function sizeOf(t: CType, abi: Abi): number {
  switch (t.k) {
    case "void":
      return 1;
    case "bool":
      return 1;
    case "int":
      return t.bits / 8;
    case "float":
      return t.bits / 8;
    case "ptr":
      return abi.ptrBytes;
    case "arr":
      return Math.max(0, t.n) * sizeOf(t.of, abi);
    case "struct":
      return t.size;
    case "enum":
      return sizeOf(t.base, abi);
    case "ref":
      return sizeOf(t.to, abi);
    case "fn":
      return abi.ptrBytes;
    case "class":
      return t.name in CLASS_BYTES ? Math.round(CLASS_BYTES[t.name] * (abi.ptrBytes > 2 ? 1.5 : 1)) : 4;
  }
}

/** bytes a library object takes on the AVR (its fields as the library's header declares them) */
const CLASS_BYTES: Record<string, number> = { File: 17, LiquidCrystal: 22, LiquidCrystal_I2C: 13, AccelStepper: 66, MultiStepper: 41 };

export function typeName(t: CType): string {
  switch (t.k) {
    case "void":
      return "void";
    case "bool":
      return "bool";
    case "int":
      return t.name;
    case "float":
      return t.bits === 32 ? "float" : "double";
    case "ptr":
      return `${typeName(t.to)} *`;
    case "arr":
      return `${typeName(t.of)}[${t.n < 0 ? "" : t.n}]`;
    case "struct":
      return t.name;
    case "enum":
      return t.name;
    case "ref":
      return `${typeName(t.to)} &`;
    case "fn":
      return `${typeName(t.ret)}(${t.params.map(typeName).join(", ")})`;
    case "class":
      return t.name;
  }
}

/** The integer type an enum, bool or small int is promoted to in arithmetic. */
export function promote(t: CType, T: Types): CType {
  if (t.k === "bool") return T.int;
  if (t.k === "enum") return promote(t.base, T);
  if (t.k === "int" && t.bits < T.abi.intBits) return T.int;
  if (t.k === "int" && t.bits === T.abi.intBits) return t.signed ? T.int : T.uint;
  return t;
}

/** C's usual arithmetic conversions: the type both operands of a binary operator meet in. */
export function common(a: CType, b: CType, T: Types): CType {
  if (a.k === "float" || b.k === "float") {
    const bits = Math.max(a.k === "float" ? a.bits : 0, b.k === "float" ? b.bits : 0) as 32 | 64;
    return { k: "float", bits };
  }
  const x = promote(a, T) as Extract<CType, { k: "int" }>;
  const y = promote(b, T) as Extract<CType, { k: "int" }>;
  if (x.bits === y.bits && x.signed === y.signed) return x;
  if (x.signed === y.signed) return x.bits > y.bits ? x : y;
  const u = x.signed ? y : x;
  const s = x.signed ? x : y;
  if (u.bits >= s.bits) return u;
  // the signed type can hold every value of the unsigned one
  return s;
}

/** A function converting a JS number holding a `from` value into a `to` value. */
export function converter(to: CType, from: CType | null): ((x: number) => number) | null {
  if (to.k === "enum") return converter(to.base, from);
  const fromFloat = !from || from.k === "float";
  switch (to.k) {
    case "bool":
      return (x) => (x ? 1 : 0);
    case "float":
      if (to.bits === 64) return from && from.k === "float" && from.bits === 64 ? null : (x) => x;
      return from && from.k === "float" && from.bits === 32 ? null : Math.fround;
    case "int": {
      const same = from && from.k === "int" && from.bits === to.bits && from.signed === to.signed;
      if (same) return null;
      const narrowerSame = from && (from.k === "bool" || (from.k === "int" && (from.bits < to.bits ? from.signed === to.signed || !from.signed : false)));
      if (narrowerSame) return null;
      const tr = fromFloat ? (x: number) => (Number.isFinite(x) ? Math.trunc(x) : 0) : null;
      let wrap: (x: number) => number;
      switch (to.bits) {
        case 8:
          wrap = to.signed ? (x) => (x << 24) >> 24 : (x) => x & 0xff;
          break;
        case 16:
          wrap = to.signed ? (x) => (x << 16) >> 16 : (x) => x & 0xffff;
          break;
        case 32:
          wrap = to.signed ? (x) => x | 0 : (x) => x >>> 0;
          break;
        default:
          wrap = to.signed ? (x) => x : (x) => (x < 0 ? x + 18446744073709551616 : x);
      }
      if (tr) {
        if (to.bits === 64) return (x) => wrap(tr(x));
        // a float out of the 32-bit range still wraps like the low bits of its integer value
        return (x) => {
          const t = tr(x);
          return wrap(t > 2147483647 || t < -2147483648 ? t % 4294967296 : t);
        };
      }
      return wrap;
    }
    default:
      return null;
  }
}

export function sameType(a: CType, b: CType): boolean {
  if (a.k !== b.k) return false;
  switch (a.k) {
    case "int":
      return b.k === "int" && a.bits === b.bits && a.signed === b.signed;
    case "float":
      return b.k === "float" && a.bits === b.bits;
    case "ptr":
      return b.k === "ptr" && sameType(a.to, b.to);
    case "arr":
      return b.k === "arr" && sameType(a.of, b.of);
    case "struct":
      return b.k === "struct" && a.name === b.name;
    case "enum":
      return b.k === "enum" && a.name === b.name;
    case "class":
      return b.k === "class" && a.name === b.name;
    default:
      return true;
  }
}
