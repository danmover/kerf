// Component values as people write them: 10k, 4k7, 4.7k, 1M, 470R, 100n,
// 4u7, 470p, 22µF, A500k. Parsing, printing and the resistor colour code.

export type ValueUnit = "ohm" | "farad";

const MULT: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, μ: 1e-6, m: 1e-3, R: 1, r: 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };

/** Parse "10k", "4k7", "470R", "100n", "4u7", "22µF", "1M" or a plain number. Returns undefined when it is not a value. */
export function parseValue(text: string | number, unit: ValueUnit): number | undefined {
  if (typeof text === "number") return Number.isFinite(text) && text > 0 ? text : undefined;
  let s = text.trim().replace(/\s+/g, "");
  s = unit === "ohm" ? s.replace(/(Ω|ohms?)$/i, "") : s.replace(/F$/i, "");
  // 4k7 / 4u7 / 4R7: the multiplier letter stands for the decimal point
  let m = /^(\d+)([pnuµμmRrkKMG])(\d+)$/.exec(s);
  if (m) {
    const v = parseFloat(`${m[1]}.${m[3]}`) * MULT[m[2]];
    return ok(v, m[2], unit);
  }
  m = /^(\d+(?:\.\d+)?|\.\d+)([pnuµμmRrkKMG]?)$/.exec(s);
  if (!m) return undefined;
  const v = parseFloat(m[1]) * (m[2] ? MULT[m[2]] : 1);
  return ok(v, m[2], unit);
}

function ok(v: number, letter: string, unit: ValueUnit): number | undefined {
  if (!(v > 0) || !Number.isFinite(v)) return undefined;
  // capacitors never take R/k/M; resistors never take p/n/u
  if (unit === "farad" && /[RrkKMG]/.test(letter)) return undefined;
  if (unit === "ohm" && /[pnuµμ]/.test(letter)) return undefined;
  return v;
}

/** Parse a potentiometer like "A500k" (A = audio/log taper, B = linear). */
export function parsePot(text: string): { taper: "A" | "B"; ohms: number } | undefined {
  const m = /^\s*([ABab])\s*(.+)$/.exec(text);
  if (!m) return undefined;
  const ohms = parseValue(m[2], "ohm");
  return ohms ? { taper: m[1].toUpperCase() as "A" | "B", ohms } : undefined;
}

const trim = (x: number) => {
  const r = Math.round(x * 100) / 100;
  return String(r);
};

/** Short form for silkscreens and labels: 10k, 4.7k, 1M, 470, 100n, 10µ, 470p. */
export function shortValue(v: number, unit: ValueUnit): string {
  if (unit === "ohm") {
    if (v >= 1e6) return `${trim(v / 1e6)}M`;
    if (v >= 1e3) return `${trim(v / 1e3)}k`;
    return trim(v);
  }
  if (v >= 1e-6 - 1e-12) return `${trim(v / 1e-6)}µ`;
  if (v >= 1e-9 - 1e-15) return `${trim(v / 1e-9)}n`;
  return `${trim(v / 1e-12)}p`;
}

/** Long form for parts lists: 10 kΩ, 4.7 kΩ, 100 nF, 10 µF. */
export function longValue(v: number, unit: ValueUnit): string {
  const s = shortValue(v, unit);
  const m = /^([\d.]+)(.*)$/.exec(s)!;
  return unit === "ohm" ? `${m[1]} ${m[2]}Ω` : `${m[1]} ${m[2]}F`;
}

export const BAND_COLORS: { name: string; hex: string }[] = [
  { name: "black", hex: "#1b1b1b" },
  { name: "brown", hex: "#7b4a22" },
  { name: "red", hex: "#c62828" },
  { name: "orange", hex: "#ef7d1a" },
  { name: "yellow", hex: "#f2d22e" },
  { name: "green", hex: "#2e9a46" },
  { name: "blue", hex: "#2950c9" },
  { name: "violet", hex: "#7b3fbf" },
  { name: "grey", hex: "#8a8a8a" },
  { name: "white", hex: "#f2f2f2" },
];
const GOLD = { name: "gold", hex: "#c9a24b" };
const SILVER = { name: "silver", hex: "#c4c7cc" };

/**
 * Colour bands of a 1 % metal film resistor (five bands: three digits, the
 * multiplier and brown for 1 %), read from the end the bands are bunched at.
 */
export function resistorBands(ohms: number): { name: string; hex: string }[] {
  let exp = Math.floor(Math.log10(ohms) + 1e-9) - 2;
  let digits = Math.round(ohms / 10 ** exp);
  if (digits >= 1000) {
    digits = Math.round(digits / 10);
    exp += 1;
  }
  const d = String(digits).padStart(3, "0").split("").map(Number);
  const mult = exp === -1 ? GOLD : exp === -2 ? SILVER : BAND_COLORS[Math.max(0, Math.min(9, exp))];
  return [BAND_COLORS[d[0]], BAND_COLORS[d[1]], BAND_COLORS[d[2]], mult, BAND_COLORS[1]];
}

/** The nearest E24 value (resistors and film capacitors are sold in this series). */
export function nearestE24(v: number): number {
  const E24 = [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1, 10];
  const exp = Math.floor(Math.log10(v));
  const m = v / 10 ** exp;
  let best = E24[0];
  for (const e of E24) if (Math.abs(Math.log(e / m)) < Math.abs(Math.log(best / m))) best = e;
  return best * 10 ** exp;
}

/** Can sizes of radial electrolytics by capacitance × voltage (typical 105 °C general-purpose series). */
export function elecSize(farads: number, volts: number): { d: number; h: number; pitch: number } {
  const cv = farads * 1e6 * volts;
  if (cv <= 1500) return { d: 5, h: 11, pitch: 2.0 };
  if (cv <= 3000) return { d: 6.3, h: 11, pitch: 2.5 };
  if (cv <= 7000) return { d: 8, h: 11.5, pitch: 3.5 };
  if (cv <= 20000) return { d: 10, h: 16, pitch: 5.0 };
  if (cv <= 40000) return { d: 12.5, h: 20, pitch: 5.0 };
  return { d: 16, h: 25, pitch: 7.5 };
}

/** Box sizes of 5 mm pitch polyester film capacitors (63 to 100 V). */
export function filmSize(farads: number): { w: number; t: number; h: number } {
  if (farads <= 100e-9 + 1e-15) return { w: 7.2, t: 2.5, h: 6.5 };
  if (farads <= 220e-9 + 1e-15) return { w: 7.2, t: 3.5, h: 8.5 };
  if (farads <= 470e-9 + 1e-15) return { w: 7.2, t: 4.5, h: 9.5 };
  return { w: 7.2, t: 5.5, h: 11.5 };
}

/** The usual dielectric for a small ceramic: C0G below 1 nF (stable, for tone and filter work), X7R above (decoupling). */
export const ceramicDielectric = (farads: number) => (farads <= 1e-9 + 1e-15 ? "C0G" : "X7R");

/**
 * Fraction of the track resistance between the CCW end and the wiper at
 * rotation x (0..1). Audio (A) taper is the usual 10 % at mid-travel curve.
 */
export function taperCurve(taper: "A" | "B", x: number): number {
  const t = Math.min(1, Math.max(0, x));
  if (taper === "B") return t;
  return (81 ** t - 1) / 80;
}
