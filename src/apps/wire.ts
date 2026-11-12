// What a saved app carries, as JSON: its spec, the twin's ready-made options
// (scenario, machine, firmware files) and copies of the design's meshes for
// its 3D panels. JSON cannot hold typed arrays, maps, sets or NaN, which the
// twin's options use, so they are written as small tagged objects (typed
// arrays as base64) and read back the same.

import type { MeshEntry } from "../core/engine";
import type { EvalPart } from "../core/model";
import type { AppSpec } from "./spec";
import type { TwinOptions } from "./twin";

const TYPED = {
  Float32Array,
  Float64Array,
  Int8Array,
  Int16Array,
  Int32Array,
  Uint8Array,
  Uint16Array,
  Uint32Array,
  Uint8ClampedArray,
} as const;
type TypedName = keyof typeof TYPED;

function b64(bytes: Uint8Array): string {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// JSON may hold the two line separators raw, a <script> element may not
const LS = new RegExp(String.fromCharCode(0x2028), "g");
const PS = new RegExp(String.fromCharCode(0x2029), "g");

/** JSON text for a value with typed arrays, maps, sets and non-finite numbers in it. */
export function wireStringify(value: unknown): string {
  return JSON.stringify(value, function (this: unknown, _k, v) {
    if (typeof v === "number" && !Number.isFinite(v)) return { $n: String(v) };
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
      const name = v.constructor.name as TypedName;
      if (!(name in TYPED)) return v;
      return { $t: name, b: b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
    }
    if (v instanceof Map) return { $m: [...v.entries()] };
    if (v instanceof Set) return { $s: [...v.values()] };
    return v;
  })
    .replace(/</g, "\\u003c")
    .replace(LS, "\\u2028")
    .replace(PS, "\\u2029");
}

export function wireParse<T>(text: string): T {
  return JSON.parse(text, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (typeof v.$n === "string" && Object.keys(v).length === 1) return Number(v.$n);
      if (typeof v.$t === "string" && typeof v.b === "string" && v.$t in TYPED) {
        const bytes = unb64(v.b);
        const C = TYPED[v.$t as TypedName];
        // copy into an aligned buffer of the array's own type
        const n = bytes.byteLength / C.BYTES_PER_ELEMENT;
        const out = new C(n);
        new Uint8Array(out.buffer).set(bytes);
        return out;
      }
      if (Array.isArray(v.$m) && Object.keys(v).length === 1) return new Map(v.$m);
      if (Array.isArray(v.$s) && Object.keys(v).length === 1) return new Set(v.$s);
    }
    return v;
  }) as T;
}

// ---------- meshes for the 3D panels ----------

/** One part's mesh, made smaller: positions as 16-bit steps across its box, normals as bytes. */
export interface WireMesh {
  hash: string;
  bbox: [[number, number, number], [number, number, number]];
  pos: Uint16Array;
  nrm: Int8Array;
  idx: Uint16Array | Uint32Array;
}

/** What a 3D panel needs of a part. */
export type WirePart = Pick<EvalPart, "id" | "name" | "hash" | "xf" | "color" | "material" | "kind" | "motion" | "hidden"> & { bom?: { catalogId?: string } };

export interface WireModel {
  parts: WirePart[];
  meshes: WireMesh[];
}

export function packMesh(hash: string, e: MeshEntry, data: { positions: Float32Array; normals: Float32Array; indices: Uint32Array }): WireMesh {
  const [lo, hi] = e.bbox;
  const n = data.positions.length / 3;
  const pos = new Uint16Array(n * 3);
  for (let i = 0; i < n; i++)
    for (let a = 0; a < 3; a++) {
      const span = hi[a] - lo[a] || 1;
      pos[i * 3 + a] = Math.max(0, Math.min(65535, Math.round(((data.positions[i * 3 + a] - lo[a]) / span) * 65535)));
    }
  const nrm = new Int8Array(n * 3);
  for (let i = 0; i < n * 3; i++) nrm[i] = Math.max(-127, Math.min(127, Math.round(data.normals[i] * 127)));
  const idx = n <= 65535 ? Uint16Array.from(data.indices) : data.indices;
  return { hash, bbox: [[lo[0], lo[1], lo[2]], [hi[0], hi[1], hi[2]]], pos, nrm, idx };
}

export function unpackMesh(w: WireMesh): MeshEntry {
  const [lo, hi] = w.bbox;
  const n = w.pos.length / 3;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) positions[i * 3 + a] = lo[a] + (w.pos[i * 3 + a] / 65535) * (hi[a] - lo[a] || 1);
  const normals = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x = w.nrm[i * 3] / 127;
    const y = w.nrm[i * 3 + 1] / 127;
    const z = w.nrm[i * 3 + 2] / 127;
    const l = Math.hypot(x, y, z) || 1;
    normals[i * 3] = x / l;
    normals[i * 3 + 1] = y / l;
    normals[i * 3 + 2] = z / l;
  }
  const indices = w.idx instanceof Uint32Array ? w.idx : Uint32Array.from(w.idx);
  return { preview: { positions, normals, indices, edges: new Float32Array(0) }, volume: 0, bbox: w.bbox, rev: 0 };
}

// ---------- the whole bundle ----------

export interface AppBundle {
  v: 1;
  app: AppSpec;
  /** the simulated twin, ready to run (no generators needed) */
  twin?: TwinOptions;
  /** why there is no twin, to say in the app */
  twinWhy?: string;
  model?: WireModel;
  design: { name: string; kerf: string; saved: string };
}
