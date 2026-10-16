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
  M2: { name: "M2", d: 2, clearance: 2.4, close: 2.2, tap: 1.6, head_d: 3.8, head_h: 2, key: 1.5, nut_af: 4, nut_h: 1.6, insert_d: 3.2, insert_l: 3, pitch: 0.4 },
  M2_5: { name: "M2.5", d: 2.5, clearance: 2.9, close: 2.7, tap: 2.05, head_d: 4.5, head_h: 2.5, key: 2, nut_af: 5, nut_h: 2, insert_d: 3.6, insert_l: 4, pitch: 0.45 },
  M3: { name: "M3", d: 3, clearance: 3.4, close: 3.2, tap: 2.5, head_d: 5.5, head_h: 3, key: 2.5, nut_af: 5.5, nut_h: 2.4, insert_d: 4.2, insert_l: 5.7, pitch: 0.5 },
  M4: { name: "M4", d: 4, clearance: 4.5, close: 4.3, tap: 3.3, head_d: 7, head_h: 4, key: 3, nut_af: 7, nut_h: 3.2, insert_d: 5.6, insert_l: 8.1, pitch: 0.7 },
  M5: { name: "M5", d: 5, clearance: 5.5, close: 5.3, tap: 4.2, head_d: 8.5, head_h: 5, key: 4, nut_af: 8, nut_h: 4.7, insert_d: 6.4, insert_l: 9.5, pitch: 0.8 },
  M6: { name: "M6", d: 6, clearance: 6.6, close: 6.4, tap: 5, head_d: 10, head_h: 6, key: 5, nut_af: 10, nut_h: 5.2, insert_d: 8, insert_l: 12.7, pitch: 1 },
};

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
