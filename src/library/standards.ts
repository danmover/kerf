// Standard hardware data: ISO metric threads / socket head cap screws,
// deep-groove ball bearings and common materials.

import { MATERIAL_LIST } from "./materials";

export interface ThreadSpec {
  name: string;
  d: number; // nominal
  clearance: number; // normal-fit clearance hole (ISO 273 medium)
  close: number; // close-fit clearance hole
  tap: number; // tap drill
  head_d: number; // ISO 4762 head diameter
  head_h: number; // head height
  key: number; // hex key across flats
  nut_af: number; // ISO 4032 nut width across flats
  nut_h: number;
  insert_d: number; // heat-set insert hole diameter
  insert_l: number; // heat-set insert length
  pitch: number;
}

export const THREADS: Record<string, ThreadSpec> = {
  M1_6: { name: "M1.6", d: 1.6, clearance: 1.8, close: 1.7, tap: 1.25, head_d: 3, head_h: 1.6, key: 1.5, nut_af: 3.2, nut_h: 1.3, insert_d: 0, insert_l: 0, pitch: 0.35 },
  M2: { name: "M2", d: 2, clearance: 2.4, close: 2.2, tap: 1.6, head_d: 3.8, head_h: 2, key: 1.5, nut_af: 4, nut_h: 1.6, insert_d: 3.2, insert_l: 3, pitch: 0.4 },
  M2_5: { name: "M2.5", d: 2.5, clearance: 2.9, close: 2.7, tap: 2.05, head_d: 4.5, head_h: 2.5, key: 2, nut_af: 5, nut_h: 2, insert_d: 3.6, insert_l: 4, pitch: 0.45 },
  M3: { name: "M3", d: 3, clearance: 3.4, close: 3.2, tap: 2.5, head_d: 5.5, head_h: 3, key: 2.5, nut_af: 5.5, nut_h: 2.4, insert_d: 4.2, insert_l: 5.7, pitch: 0.5 },
  M4: { name: "M4", d: 4, clearance: 4.5, close: 4.3, tap: 3.3, head_d: 7, head_h: 4, key: 3, nut_af: 7, nut_h: 3.2, insert_d: 5.6, insert_l: 8.1, pitch: 0.7 },
  M5: { name: "M5", d: 5, clearance: 5.5, close: 5.3, tap: 4.2, head_d: 8.5, head_h: 5, key: 4, nut_af: 8, nut_h: 4.7, insert_d: 6.4, insert_l: 9.5, pitch: 0.8 },
  M6: { name: "M6", d: 6, clearance: 6.6, close: 6.4, tap: 5, head_d: 10, head_h: 6, key: 5, nut_af: 10, nut_h: 5.2, insert_d: 8, insert_l: 12.7, pitch: 1 },
  // no common heat-set inserts above M6: insert_d 0 means "none"
  M8: { name: "M8", d: 8, clearance: 9, close: 8.4, tap: 6.8, head_d: 13, head_h: 8, key: 6, nut_af: 13, nut_h: 6.8, insert_d: 0, insert_l: 0, pitch: 1.25 },
  M10: { name: "M10", d: 10, clearance: 11, close: 10.5, tap: 8.5, head_d: 16, head_h: 10, key: 8, nut_af: 16, nut_h: 8.4, insert_d: 0, insert_l: 0, pitch: 1.5 },
  M12: { name: "M12", d: 12, clearance: 13.5, close: 13, tap: 10.2, head_d: 18, head_h: 12, key: 10, nut_af: 18, nut_h: 10.8, insert_d: 0, insert_l: 0, pitch: 1.75 },
  M14: { name: "M14", d: 14, clearance: 15.5, close: 15, tap: 12, head_d: 21, head_h: 14, key: 12, nut_af: 21, nut_h: 12.8, insert_d: 0, insert_l: 0, pitch: 2 },
  M16: { name: "M16", d: 16, clearance: 17.5, close: 17, tap: 14, head_d: 24, head_h: 16, key: 14, nut_af: 24, nut_h: 14.8, insert_d: 0, insert_l: 0, pitch: 2 },
  M20: { name: "M20", d: 20, clearance: 22, close: 21, tap: 17.5, head_d: 30, head_h: 20, key: 17, nut_af: 30, nut_h: 18, insert_d: 0, insert_l: 0, pitch: 2.5 },
};

const inch = (x: number) => Math.round(x * 25.4 * 100) / 100;

/**
 * Unified (inch) threads, by the name written in designs ("#4-40", "1/4-20").
 * Socket head sizes from ASME B18.3, hex nuts from B18.6.3 and B18.2.2,
 * normal and close clearance drills and tap drills from the usual tables.
 * They are not language constants (M3 is): write them as text, lib.screw("1/4-20", 19.05).
 */
function unified(name: string, d: number, tpi: number, close: number, clearance: number, tap: number, head: number, key: number, nutAf: number, nutH: number): ThreadSpec {
  return { name, d: inch(d), clearance: inch(clearance), close: inch(close), tap: inch(tap), head_d: inch(head), head_h: inch(d), key: inch(key), nut_af: inch(nutAf), nut_h: inch(nutH), insert_d: 0, insert_l: 0, pitch: Math.round((25.4 / tpi) * 10000) / 10000 };
}

export const UNIFIED_THREADS: Record<string, ThreadSpec> = Object.fromEntries(
  [
    unified("#2-56", 0.086, 56, 0.089, 0.096, 0.07, 0.14, 5 / 64, 3 / 16, 1 / 16),
    unified("#4-40", 0.112, 40, 0.116, 0.1285, 0.089, 0.183, 3 / 32, 1 / 4, 3 / 32),
    unified("#6-32", 0.138, 32, 0.144, 0.1495, 0.1065, 0.226, 7 / 64, 5 / 16, 7 / 64),
    unified("#8-32", 0.164, 32, 0.1695, 0.177, 0.136, 0.27, 9 / 64, 11 / 32, 1 / 8),
    unified("#10-24", 0.19, 24, 0.196, 0.213, 0.1495, 0.312, 5 / 32, 3 / 8, 1 / 8),
    unified("#10-32", 0.19, 32, 0.196, 0.213, 0.159, 0.312, 5 / 32, 3 / 8, 1 / 8),
    unified("1/4-20", 0.25, 20, 0.257, 0.266, 0.201, 0.375, 3 / 16, 7 / 16, 7 / 32),
    unified("5/16-18", 0.3125, 18, 0.323, 0.332, 0.257, 0.469, 1 / 4, 1 / 2, 17 / 64),
    unified("3/8-16", 0.375, 16, 0.386, 0.397, 0.3125, 0.5625, 5 / 16, 9 / 16, 21 / 64),
    unified("1/2-13", 0.5, 13, 0.516, 0.531, 0.4219, 0.75, 3 / 8, 3 / 4, 7 / 16),
  ].map((t) => [t.name, t]),
);

/**
 * Wood (timber) screw gauges, by the name on the box: "8G" is the 4.2 mm screw a hardware store sells as 8 gauge.
 * clearance: the hole through the part being held; tap: the pilot hole in softwood or plywood; head: the 90°
 * countersunk head. They are written as text, lib.screw("8G", 20), and only come as wood screws.
 */
function gauge(name: string, d: number, clearance: number, pilot: number, head: number, pitch: number): ThreadSpec {
  return { name, d, clearance, close: Math.round((d + 0.1) * 10) / 10, tap: pilot, head_d: head, head_h: Math.round(((head - d) / 2) * 100) / 100, key: 0, nut_af: 0, nut_h: 0, insert_d: 0, insert_l: 0, pitch };
}

export const WOOD_THREADS: Record<string, ThreadSpec> = Object.fromEntries(
  [gauge("4G", 2.9, 3.2, 2, 5.6, 1.1), gauge("6G", 3.5, 3.8, 2.5, 6.9, 1.4), gauge("8G", 4.2, 4.5, 3, 8.4, 1.6), gauge("10G", 4.8, 5.2, 3.5, 9.6, 1.8), gauge("12G", 5.5, 6, 4, 10.8, 2.1)].map((t) => [t.name, t]),
);

/** Wood screw gauges are written as a number and G. */
export const isWoodGauge = (t: ThreadSpec) => /^\d+G$/.test(t.name);

/** A thread by its key or name: "M3", "M2_5", "M2.5", "#10-24", "1/4-20", or a wood screw gauge "8G" (metric first). */
export function threadSpec(name: string | undefined): ThreadSpec | undefined {
  if (!name) return undefined;
  const s = name.trim().replace(/\s+/g, "");
  const key = s.replace(".", "_").toUpperCase();
  return THREADS[key] ?? UNIFIED_THREADS[s] ?? WOOD_THREADS[key] ?? Object.values(THREADS).find((t) => t.name === s);
}

/** Every thread size Kerf has hardware for, metric then unified. */
export const ALL_THREADS: ThreadSpec[] = [...Object.values(THREADS), ...Object.values(UNIFIED_THREADS)];

/** Unified sizes are written with a fraction or a number sign. */
export const isUnified = (t: ThreadSpec) => /^#|\//.test(t.name);

/** ISO 261 coarse pitches by nominal diameter, for thread("M16") and friends. */
export const COARSE_PITCH: Record<string, number> = {
  "1": 0.25, "1.2": 0.25, "1.4": 0.3, "1.6": 0.35, "2": 0.4, "2.5": 0.45, "3": 0.5, "3.5": 0.6, "4": 0.7, "5": 0.8, "6": 1, "7": 1,
  "8": 1.25, "10": 1.5, "12": 1.75, "14": 2, "16": 2, "18": 2.5, "20": 2.5, "22": 2.5, "24": 3, "27": 3, "30": 3.5, "33": 3.5, "36": 4, "42": 4.5, "48": 5,
};

/**
 * Nominal diameter and pitch from a thread name: "M8", "M8x1" (fine pitch),
 * "1/4-20" or "3/8-16" (Unified, inch), "#10-24" (numbered Unified).
 */
export function parseThreadName(name: string): { d: number; pitch: number; name: string } | null {
  const s = name.trim().replace(/\s+/g, "").replace(/×/g, "x");
  let m = /^M(\d+(?:[._]\d+)?)(?:x(\d+(?:\.\d+)?))?$/i.exec(s);
  if (m) {
    const dStr = m[1].replace("_", ".");
    const d = Number(dStr);
    const pitch = m[2] ? Number(m[2]) : COARSE_PITCH[String(d)];
    if (!pitch || !(d > 0)) return null;
    return { d, pitch, name: `M${dStr}${m[2] ? `x${m[2]}` : ""}` };
  }
  m = /^(\d+)\/(\d+)-(\d+)$/.exec(s);
  if (m) {
    const d = (Number(m[1]) / Number(m[2])) * 25.4;
    return { d, pitch: 25.4 / Number(m[3]), name: s };
  }
  m = /^(\d+(?:\.\d+)?)-(\d+)$/.exec(s);
  if (m && Number(m[1]) <= 2) return { d: Number(m[1]) * 25.4, pitch: 25.4 / Number(m[2]), name: s };
  m = /^#(\d+)-(\d+)$/.exec(s);
  if (m) return { d: (0.06 + 0.013 * Number(m[1])) * 25.4, pitch: 25.4 / Number(m[2]), name: s };
  return null;
}

export interface BearingSpec {
  code: string;
  bore: number;
  od: number;
  width: number;
  dynamicLoadN: number;
}

export const BEARINGS: Record<string, BearingSpec> = {
  "623": { code: "623", bore: 3, od: 10, width: 4, dynamicLoadN: 630 },
  "625": { code: "625", bore: 5, od: 16, width: 5, dynamicLoadN: 1140 },
  "626": { code: "626", bore: 6, od: 19, width: 6, dynamicLoadN: 2340 },
  "608": { code: "608", bore: 8, od: 22, width: 7, dynamicLoadN: 3450 },
  "688": { code: "688", bore: 8, od: 16, width: 5, dynamicLoadN: 1600 },
  MR105: { code: "MR105", bore: 5, od: 10, width: 4, dynamicLoadN: 430 },
  "6000": { code: "6000", bore: 10, od: 26, width: 8, dynamicLoadN: 4750 },
  "6001": { code: "6001", bore: 12, od: 28, width: 8, dynamicLoadN: 5400 },
  "6002": { code: "6002", bore: 15, od: 32, width: 9, dynamicLoadN: 5850 },
  "6200": { code: "6200", bore: 10, od: 30, width: 9, dynamicLoadN: 5070 },
  "6201": { code: "6201", bore: 12, od: 32, width: 10, dynamicLoadN: 6890 },
  "6800": { code: "6800", bore: 10, od: 19, width: 5, dynamicLoadN: 1720 },
  "6801": { code: "6801", bore: 12, od: 21, width: 5, dynamicLoadN: 1740 },
  "6005": { code: "6005", bore: 25, od: 47, width: 12, dynamicLoadN: 11900 },
  "6205": { code: "6205", bore: 25, od: 52, width: 15, dynamicLoadN: 14800 },
  "6806": { code: "6806", bore: 30, od: 42, width: 7, dynamicLoadN: 4490 },
  "6808": { code: "6808", bore: 40, od: 52, width: 7, dynamicLoadN: 4490 },
  "6810": { code: "6810", bore: 50, od: 65, width: 7, dynamicLoadN: 6760 },
  "6812": { code: "6812", bore: 60, od: 78, width: 10, dynamicLoadN: 11900 },
};

/** Density in g/cm^3, keyed by the material name used in design files. */
export const MATERIALS: Record<string, { density: number; label: string }> = Object.fromEntries(MATERIAL_LIST.map((m) => [m.name, { density: m.density, label: m.label }]));

export function materialDensity(name: string): number {
  return MATERIALS[name]?.density ?? 1.2;
}
