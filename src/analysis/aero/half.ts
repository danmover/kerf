// IEEE half-precision conversion (round to nearest even), the same rounding the GPU kernels apply when they store
// populations and boundary data as 16-bit floats.

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** The 16 bits of the half nearest to x. */
export function toHalf(x: number): number {
  f32[0] = x;
  const b = u32[0];
  const s = (b >>> 16) & 0x8000;
  const e = ((b >>> 23) & 0xff) - 112;
  const m = b & 0x7fffff;
  if (e <= 0) {
    if (e < -10) return s;
    const mm = m | 0x800000;
    const sh = 14 - e;
    let r = mm >>> sh;
    const rem = mm & ((1 << sh) - 1);
    const half = 1 << (sh - 1);
    if (rem > half || (rem === half && r & 1)) r++;
    return s | r;
  }
  if (e >= 31) return s | 0x7c00;
  let r = (e << 10) | (m >>> 13);
  const rem = m & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && r & 1)) r++;
  return s | r;
}
