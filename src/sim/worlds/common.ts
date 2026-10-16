// Small helpers the worlds share: seeded random numbers, the three variants
// every scenario runs in, and unit conversions.

export type VariantName = "pessimistic" | "expected" | "optimistic";

export const VARIANTS: VariantName[] = ["pessimistic", "expected", "optimistic"];

export const VARIANT_LABEL: Record<VariantName, string> = {
  pessimistic: "Pessimistic",
  expected: "Expected",
  optimistic: "Optimistic",
};

/** A seeded generator (mulberry32): the same seed gives the same run. */
export function rngFrom(seed: number): () => number {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A standard normal sample. */
export function gauss(rng: () => number): number {
  const u = Math.max(1e-12, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;
export const G = 9.80665;

export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
