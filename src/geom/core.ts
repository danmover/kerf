// The Rust geometry core (crates/kerf-geom), loaded as WebAssembly: the part of the checks that works on meshes and
// the kernel's exact faces without the CAD kernel. A part's mesh and faces are copied in once and kept under a
// handle; questions are then asked about pairs of handles and where each is placed.
//
// The same Rust runs natively in the Rust app. Here it lives beside the kernel, in the kernel's worker.

/** Why a pair was not proved clear (crates/kerf-geom/src/clash.rs, `Why`). */
export const WHY = ["clear", "open mesh", "too many close triangles", "close", "inside", "film"] as const;

export interface PairVerdict {
  /** proved: the two parts do not overlap */
  clear: boolean;
  /**
   * The most the two parts can overlap by, mm³, where that is proved: 0 when clear, a small number when they overlap
   * by no more than a film (a screw a few ten-thousandths of a millimetre off the axis of a hole its own size).
   * Null: not proved either way, the kernel has to say.
   */
  atMost: number | null;
  why: (typeof WHY)[number];
  /** pairs of triangles looked at */
  candidates: number;
  /** when close: the kinds of the two faces that could not be cleared (0 flat, 1 cylinder, 2 other, 3 cone, 4 sphere) and their gap */
  kinds: [number, number];
  gap: number;
}

export interface GeomInfo {
  closed: boolean;
  pieces: number;
  /** faces the kernel described that the mesh did not agree with */
  mismatched: number;
  triangles: number;
  flat: number;
  round: number;
  other: number;
}

/** How two placed parts touch: as kernel/apart.ts `Touch`. */
export interface GeomTouch {
  aOnB: boolean;
  bOnA: boolean;
}

interface Exports {
  memory: WebAssembly.Memory;
  kerf_alloc(bytes: number): number;
  kerf_free(ptr: number, bytes: number): void;
  geom_new(pos: number, nPos: number, idx: number, nIdx: number, triFace: number, nTriFace: number, faces: number, nFaces: number, deflection: number): number;
  geom_drop(handle: number): void;
  geom_info(handle: number, out: number): number;
  pair_classify(a: number, b: number, xa: number, xb: number, out: number): number;
  pair_touch(a: number, b: number, xa: number, xb: number, gap: number): number;
}

type Numbers = Float32Array | Uint32Array | Int32Array | Float64Array;

export class GeomCore {
  /** room for two placements and an answer */
  private scratch: number;

  private constructor(private x: Exports) {
    this.scratch = x.kerf_alloc(48 * 8);
  }

  /** Compiles the module. Synchronous: call it in a worker (or Node), not on the page. */
  static load(bytes: BufferSource): GeomCore {
    const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
    return new GeomCore(inst.exports as unknown as Exports);
  }

  private put(a: Numbers): number {
    const ptr = this.x.kerf_alloc(a.byteLength);
    new Uint8Array(this.x.memory.buffer, ptr, a.byteLength).set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
    return ptr;
  }

  /**
   * A part's mesh with each triangle's face and the faces as the kernel knows them (kernel/exactFaces.ts).
   * `deflection` is how far the mesh may stray from a face the kernel gives no exact shape for. Returns a handle.
   */
  add(positions: Float32Array, indices: Uint32Array, triFace: Int32Array, faces: Float64Array, deflection: number): number {
    const p = this.put(positions);
    const i = this.put(indices);
    const t = this.put(triFace);
    const f = this.put(faces);
    try {
      return this.x.geom_new(p, positions.length, i, indices.length, t, triFace.length, f, faces.length, deflection);
    } finally {
      this.x.kerf_free(p, positions.byteLength);
      this.x.kerf_free(i, indices.byteLength);
      this.x.kerf_free(t, triFace.byteLength);
      this.x.kerf_free(f, faces.byteLength);
    }
  }

  drop(handle: number): void {
    this.x.geom_drop(handle);
  }

  info(handle: number): GeomInfo | null {
    if (!this.x.geom_info(handle, this.scratch)) return null;
    const o = new Float64Array(this.x.memory.buffer, this.scratch, 8);
    return { closed: o[0] === 1, pieces: o[1], mismatched: o[2], triangles: o[3], flat: o[4], round: o[5], other: o[6] };
  }

  private place(xa: ArrayLike<number>, xb: ArrayLike<number>) {
    const m = new Float64Array(this.x.memory.buffer, this.scratch, 32);
    m.set(xa, 0);
    m.set(xb, 16);
  }

  /** Whether two placed parts are proved not to overlap. `xa`, `xb`: their placements as 4x4 matrices, by column. */
  classify(a: number, b: number, xa: ArrayLike<number>, xb: ArrayLike<number>): PairVerdict {
    this.place(xa, xb);
    const out = this.scratch + 32 * 8;
    const why = this.x.pair_classify(a, b, this.scratch, this.scratch + 16 * 8, out);
    const o = new Float64Array(this.x.memory.buffer, out, 8);
    return { clear: why === 0, atMost: o[6] >= 0 ? o[6] : null, why: WHY[why] ?? "close", candidates: o[0], kinds: [o[1], o[2]], gap: o[5] };
  }

  /**
   * Whether the surfaces of two placed parts come within `gap`, and which (if either) holds the other up against
   * gravity (-Z): a's surface facing down over b's facing up where they meet.
   */
  touch(a: number, b: number, xa: ArrayLike<number>, xb: ArrayLike<number>, gap: number): GeomTouch | null {
    this.place(xa, xb);
    const r = this.x.pair_touch(a, b, this.scratch, this.scratch + 16 * 8, gap);
    return r & 1 ? { aOnB: (r & 2) !== 0, bOnA: (r & 4) !== 0 } : null;
  }

  /** A cylinder of radius `r` from the origin up Z by `length`, with its faces exact: what a tool or a turning part sweeps. */
  cylinder(r: number, length: number, segments = 48): number {
    const n = segments;
    const positions = new Float32Array((2 * n + 2) * 3);
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      positions.set([r * Math.cos(a), r * Math.sin(a), 0], i * 3);
      positions.set([r * Math.cos(a), r * Math.sin(a), length], (n + i) * 3);
    }
    positions.set([0, 0, 0], 2 * n * 3);
    positions.set([0, 0, length], (2 * n + 1) * 3);
    const indices = new Uint32Array(n * 12);
    const triFace = new Int32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      // bottom (seen from below), top, and the two halves of a strip of the side
      indices.set([2 * n, j, i, 2 * n + 1, n + i, n + j, i, j, n + j, i, n + j, n + i], i * 12);
      triFace.set([0, 1, 2, 2], i * 4);
    }
    const faces = new Float64Array([0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, length, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, r, 0, 0]);
    return this.add(positions, indices, triFace, faces, 0);
  }
}

/**
 * How b sits as a sees it, rounded (a billionth for its turn, a millionth of a millimetre for its place), as a key:
 * two pairs of the same two parts with the same key are one pair moved as a whole, so they overlap by the same amount.
 * `xa`, `xb`: placements as 4x4 matrices, by column.
 */
export function poseKey(xa: ArrayLike<number>, xb: ArrayLike<number>): string {
  // a's turn undone in full, not by its transpose: a placement may mirror
  const a00 = xa[0], a10 = xa[1], a20 = xa[2], a01 = xa[4], a11 = xa[5], a21 = xa[6], a02 = xa[8], a12 = xa[9], a22 = xa[10];
  const c00 = a11 * a22 - a12 * a21, c01 = a02 * a21 - a01 * a22, c02 = a01 * a12 - a02 * a11;
  const c10 = a12 * a20 - a10 * a22, c11 = a00 * a22 - a02 * a20, c12 = a02 * a10 - a00 * a12;
  const c20 = a10 * a21 - a11 * a20, c21 = a01 * a20 - a00 * a21, c22 = a00 * a11 - a01 * a10;
  const det = a00 * c00 + a01 * c10 + a02 * c20;
  const out: number[] = [];
  for (let j = 0; j < 4; j++) {
    const x = xb[j * 4] - (j === 3 ? xa[12] : 0);
    const y = xb[j * 4 + 1] - (j === 3 ? xa[13] : 0);
    const z = xb[j * 4 + 2] - (j === 3 ? xa[14] : 0);
    const k = j === 3 ? 1e6 : 1e9;
    // + 0 turns -0 into 0, so the two print alike
    out.push(Math.round(((c00 * x + c01 * y + c02 * z) / det) * k) + 0, Math.round(((c10 * x + c11 * y + c12 * z) / det) * k) + 0, Math.round(((c20 * x + c21 * y + c22 * z) / det) * k) + 0);
  }
  return out.join(",");
}

let shared: GeomCore | null = null;

/** Start the geometry core from the module's bytes (src/geom/kerf_geom.wasm). Once: handles belong to the core that gave them. */
export function startGeomCore(bytes: BufferSource): GeomCore {
  shared ??= GeomCore.load(bytes);
  return shared;
}

/** The geometry core, or null where it has not been started: callers then do without it (the kernel's own tests). */
export function geomCore(): GeomCore | null {
  return shared;
}
