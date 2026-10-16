// Standard hardware data: ISO metric threads / socket head cap screws,
// deep-groove ball bearings and common materials.

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
};

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
};

/** Density in g/cm^3 */
export const MATERIALS: Record<string, { density: number; label: string }> = {
  PLA: { density: 1.24, label: "PLA" },
  PETG: { density: 1.27, label: "PETG" },
  ABS: { density: 1.04, label: "ABS" },
  ASA: { density: 1.07, label: "ASA" },
  Nylon: { density: 1.14, label: "Nylon PA12" },
  "Aluminum 6061": { density: 2.7, label: "Aluminum 6061" },
  Steel: { density: 7.85, label: "Steel" },
  "Stainless 304": { density: 8.0, label: "Stainless 304" },
  Brass: { density: 8.5, label: "Brass" },
  FR4: { density: 1.85, label: "FR4" },
  POM: { density: 1.41, label: "POM (Delrin)" },
};

export function materialDensity(name: string): number {
  return MATERIALS[name]?.density ?? 1.2;
}
