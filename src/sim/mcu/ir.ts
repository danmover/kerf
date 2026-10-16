// Shapes shared by the compiler and the Arduino library: compiled expressions
// are closures over a frame (the function's locals), with a static C type
// and an estimated cost in CPU cycles.

import type { Pos } from "./ast";
import type { Abi, CType, Types } from "./ctypes";
import type { LibState } from "./lib";
import type { Hal, Ptr } from "./vm";

export type Frame = unknown[];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Ev = (f: Frame) => any;

export interface LV {
  get: Ev;
  set: (f: Frame, v: unknown) => void;
  ptr: (f: Frame) => Ptr;
}

/** A compiled expression. */
export interface C {
  t: CType;
  ev: Ev;
  /** set when the expression names memory (assignable, addressable) */
  lv?: LV;
  /** estimated cycles to evaluate, charged with its statement */
  cost: number;
  /** compile-time constant value */
  cv?: number;
  /** string literal bytes (for overloads that want the text) */
  lit?: number[];
  pos: Pos;
}

export interface Ctx {
  T: Types;
  abi: Abi;
  hal: Hal;
  /** library state of this chip (Wire buffers, random seed) */
  lib: LibState;
  /** report a firmware mistake found at compile time */
  error(msg: string, pos: Pos): never;
  /** report a firmware mistake while it runs */
  fault(msg: string, pos: Pos): void;
}

/** Read a zero-terminated C string through a pointer. */
export function cstr(p: Ptr | null | undefined, max = 4096): number[] {
  const out: number[] = [];
  if (!p) return out;
  const m = p.m as number[];
  for (let i = p.i; i < m.length && out.length < max; i++) {
    const c = m[i] as number;
    if (!c) break;
    out.push(c & 255);
  }
  return out;
}

export const text = (bytes: number[]) => String.fromCharCode(...bytes.map((b) => b & 255));
export const bytesOf = (s: string) => [...s].map((c) => c.charCodeAt(0) & 255);
