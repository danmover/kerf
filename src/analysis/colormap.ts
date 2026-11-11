// Colour scales for analysis results, shared by the viewport shader (which
// has GLSL copies of these functions) and the legend.

export type ScaleMode = "sequential" | "safety" | "diverging";

export type RGB = [number, number, number];

/** Google's Turbo colormap (polynomial fit), sRGB 0..1. */
export function turbo(x: number): RGB {
  const t = Math.min(1, Math.max(0, x));
  const t2 = t * t,
    t3 = t2 * t,
    t4 = t3 * t,
    t5 = t4 * t;
  return [
    Math.min(1, Math.max(0, 0.13572138 + 4.6153926 * t - 42.66032258 * t2 + 132.13108234 * t3 - 152.94239396 * t4 + 59.28637943 * t5)),
    Math.min(1, Math.max(0, 0.09140261 + 2.19418839 * t + 4.84296658 * t2 - 14.18503333 * t3 + 4.27729857 * t4 + 2.82956604 * t5)),
    Math.min(1, Math.max(0, 0.1066733 + 12.64194608 * t - 60.58204836 * t2 + 110.36276771 * t3 - 89.90310912 * t4 + 27.34824973 * t5)),
  ];
}

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const mix = (a: RGB, b: RGB, k: number): RGB => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

export const SAFETY_STOPS = { fail0: hex("#8e0b26"), fail1: hex("#ff4d5e"), low0: hex("#ff8a3d"), low1: hex("#ffd25e"), ok0: hex("#3ddc97"), ok1: hex("#28a8c8") };
export const DIVERGING_STOPS = { neg: hex("#3b6cff"), mid: hex("#e8ecf5"), pos: hex("#ff4d5e") };

/** Safety colours: red below 1, amber between 1 and the target, green above it. */
export function safetyColor(t: number): RGB {
  const s = SAFETY_STOPS;
  if (t < 0.25) return mix(s.fail0, s.fail1, t / 0.25);
  if (t < 0.5) return mix(s.low0, s.low1, (t - 0.25) / 0.25);
  return mix(s.ok0, s.ok1, Math.min(1, (t - 0.5) / 0.5));
}

export function divergingColor(t: number): RGB {
  const d = DIVERGING_STOPS;
  return t < 0.5 ? mix(d.neg, d.mid, t / 0.5) : mix(d.mid, d.pos, Math.min(1, (t - 0.5) / 0.5));
}

/** Position of a safety factor on the safety scale (0..1). */
export function safetyT(sf: number, target: number): number {
  if (!(sf > 0)) return 0;
  if (sf < 1) return 0.25 * sf;
  if (target > 1 && sf < target) return 0.25 + (0.25 * (sf - 1)) / (target - 1);
  return 0.5 + 0.5 * Math.min(1, Math.log(Math.max(sf, target) / Math.max(target, 1)) / Math.log(4));
}

/** The safety factor at a position on the safety scale (inverse of safetyT), for legend ticks. */
export function safetyAt(t: number, target: number): number {
  if (t < 0.25) return t / 0.25;
  if (t < 0.5) return target > 1 ? 1 + ((t - 0.25) / 0.25) * (target - 1) : 1;
  return Math.max(target, 1) * Math.pow(4, (t - 0.5) / 0.5);
}

/**
 * Position of a fatigue life on the safety scale, from its log10 over the life asked for: red short of it, amber within
 * ten times it, green beyond (deepest from 10⁵ times, or no limit at all below the endurance limit).
 */
export function lifeT(log: number): number {
  if (!(log > -3)) return 0;
  if (log < 0) return (0.25 * (log + 3)) / 3;
  if (log < 1) return 0.25 + 0.25 * log;
  return 0.5 + 0.5 * Math.min(1, (log - 1) / 4);
}

/** The log10 life over the target at a position on the safety scale (inverse of lifeT), for legend ticks. */
export function lifeAt(t: number): number {
  if (t < 0.25) return (t / 0.25) * 3 - 3;
  if (t < 0.5) return (t - 0.25) / 0.25;
  return 1 + ((t - 0.5) / 0.5) * 4;
}

export function colorAt(mode: ScaleMode, t: number): RGB {
  return mode === "safety" ? safetyColor(t) : mode === "diverging" ? divergingColor(t) : turbo(t);
}

/** CSS gradient for a legend bar, banded like the shader. */
export function gradientCss(mode: ScaleMode, bands: number, dir = "to right"): string {
  const stops: string[] = [];
  const n = mode === "safety" ? 48 : bands;
  for (let i = 0; i < n; i++) {
    const t0 = i / n,
      t1 = (i + 1) / n;
    const c = colorAt(mode, mode === "safety" ? (t0 + t1) / 2 : (i + 0.5) / n);
    const css = `rgb(${c.map((v) => Math.round(v * 255)).join(",")})`;
    stops.push(`${css} ${(t0 * 100).toFixed(2)}%`, `${css} ${(t1 * 100).toFixed(2)}%`);
  }
  return `linear-gradient(${dir}, ${stops.join(", ")})`;
}
