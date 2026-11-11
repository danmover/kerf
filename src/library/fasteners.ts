// The fastener catalogue: screw heads and drives in every common standard
// (ISO and DIN metric, ASME inch), strength grades and materials, stocked
// lengths, nuts, washers, heat-set inserts, standoffs and retaining rings,
// with typical prices. chooseFastener() works through every candidate for a
// joint against real rules (thread engagement, strength, head room, tool,
// corrosion, cost, what the user already has) and ranks the ones that pass.
// Sizes are mm; loads N; prices US dollars each, bought in packs.

import { ALL_THREADS, THREADS, isUnified, isWoodGauge, threadSpec, type ThreadSpec } from "./standards";
import { materialRecord } from "./materialDb";
import { isPrinted } from "./materials";

// ---------------------------------------------------------------- heads

export type HeadType = "socket" | "button" | "flat" | "low" | "pan" | "hex" | "set" | "forming" | "wood";
export const HEAD_TYPES: HeadType[] = ["socket", "button", "flat", "low", "pan", "hex", "set", "forming", "wood"];

export interface HeadDims {
  /** head diameter (across corners for hex heads: the circle it needs) */
  d: number;
  /** head height; for flat (countersunk) heads the depth of the cone */
  h: number;
  /** hex key, Torx, Phillips or spanner size */
  drive: string;
  /** diameter of the tool that turns it, for the tool-access check */
  toolD: number;
  /** hex socket across flats (socket, button, flat, low, set); 0 for other drives */
  key: number;
  /** across flats of a hex head */
  af?: number;
  /** stocked lengths, mm [shortest, longest] */
  lengths: [number, number];
}

interface HeadInfo {
  label: string;
  /** what the parts list calls it */
  noun: string;
  standard: string;
  /** inch equivalent standard */
  inchStandard?: string;
  /** length is measured from the top of the head (countersunk) instead of from under it */
  lengthFromTop?: boolean;
  /** the screw goes in from the surface and sits flush */
  flush?: boolean;
  grades: Grade[];
  /** price relative to a socket head of the same size */
  priceFactor: number;
  note: string;
}

export const HEADS: Record<HeadType, HeadInfo> = {
  socket: { label: "socket head cap screw", noun: "Socket head cap screw", standard: "ISO 4762", inchStandard: "ASME B18.3", grades: ["12.9", "A2-70", "A4-80", "8.8", "brass", "nylon"], priceFactor: 1, note: "The default machine screw: strong, small head, turned with a hex key from straight above. Sits on the surface or flush in a counterbore." },
  button: { label: "button head screw", noun: "Button head screw", standard: "ISO 7380-1", inchStandard: "ASME B18.3", grades: ["A2-70", "10.9", "A4-80"], priceFactor: 1.1, note: "Low domed head with a wider bearing face than a socket head: tidy on covers and printed parts, gentler on plastic. Weaker socket, so not for high torque." },
  flat: { label: "countersunk socket screw", noun: "Countersunk (flat) socket screw", standard: "ISO 10642", inchStandard: "ASME B18.3", lengthFromTop: true, flush: true, grades: ["A2-70", "10.9", "A4-80"], priceFactor: 1.1, note: "90° countersunk head that sits flush in a countersink (hole(..., csink: true)). Centres the part it clamps. Length includes the head." },
  low: { label: "low head socket cap screw", noun: "Low head socket cap screw", standard: "DIN 7984", grades: ["A2-70", "8.8"], priceFactor: 1.3, note: "Socket head about two thirds the height of ISO 4762, for shallow counterbores and tight head room." },
  pan: { label: "pan head screw", noun: "Pan head screw", standard: "ISO 14583", inchStandard: "ASME B18.6.3", grades: ["A2-70", "4.8", "A4-80", "brass", "nylon"], priceFactor: 0.8, note: "Torx pan head: cheap, wide bearing face, good for sheet metal and covers; turned with a screwdriver." },
  hex: { label: "hex head bolt", noun: "Hex head bolt", standard: "ISO 4017", inchStandard: "ASME B18.2.1", grades: ["8.8", "A2-70", "A4-80", "10.9"], priceFactor: 0.85, note: "Hex head, fully threaded: the cheapest strong fastener from M6 up, turned with a spanner or socket, so it needs room round the head." },
  set: { label: "set screw", noun: "Socket set screw, cup point", standard: "ISO 4029", inchStandard: "ASME B18.3", grades: ["12.9", "A2-70"], priceFactor: 0.9, note: "Headless grub screw that locks a hub, collar or pulley to a shaft: point it at the shaft's flat." },
  forming: { label: "thread-forming screw for plastics", noun: "Thread-forming screw for plastics, Torx pan head", standard: "DIN 7500 / WN 1411 (PT style)", grades: ["A2-70", "8.8"], priceFactor: 1.6, note: "30° thread that forms its own thread in a plain pilot hole in plastic (no insert, no tap): the pilot is about 0.8 × the screw size. Holds well for a few re-assemblies." },
  wood: { label: "countersunk wood screw", noun: "Countersunk wood screw", standard: "gauge sizes (AS 3566)", lengthFromTop: true, flush: true, grades: ["4.8", "A2-70"], priceFactor: 0.5, note: "Countersunk timber screw in gauge sizes (\"8G\"), Phillips drive: it cuts its own thread in a pilot hole in wood or plywood and holds a part down through a clearance hole. Length includes the head. Give it thread in the wood of at least twice its diameter." },
};

// wood screw gauges: stocked lengths [shortest, longest]
const WOOD_RANGE: Record<string, [number, number]> = { "4G": [9, 25], "6G": [12, 40], "8G": [12, 75], "10G": [16, 100], "12G": [20, 100] };

// head dimensions per metric size: [diameter, height, hex key or drive size]
const SOCKET: Record<string, [number, number, number]> = {
  M1_6: [3, 1.6, 1.5], M2: [3.8, 2, 1.5], M2_5: [4.5, 2.5, 2], M3: [5.5, 3, 2.5], M4: [7, 4, 3], M5: [8.5, 5, 4], M6: [10, 6, 5], M8: [13, 8, 6], M10: [16, 10, 8], M12: [18, 12, 10], M14: [21, 14, 12], M16: [24, 16, 14], M20: [30, 20, 17],
};
const BUTTON: Record<string, [number, number, number]> = {
  M2: [3.5, 1.3, 1.3], M2_5: [4.7, 1.5, 1.5], M3: [5.7, 1.65, 2], M4: [7.6, 2.2, 2.5], M5: [9.5, 2.75, 3], M6: [10.5, 3.3, 4], M8: [14, 4.4, 5], M10: [17.5, 5.5, 6], M12: [21, 6.6, 8],
};
// countersunk: diameter 2 × d (the 90° countersink hole(…, csink: true) cuts), depth (D − d) / 2
const FLAT_KEY: Record<string, number> = { M2: 1.3, M2_5: 1.5, M3: 2, M4: 2.5, M5: 3, M6: 4, M8: 5, M10: 6, M12: 8, M16: 10, M20: 12 };
const LOW: Record<string, [number, number, number]> = { M3: [5.5, 2, 2], M4: [7, 2.8, 2.5], M5: [8.5, 3.5, 3], M6: [10, 4, 4], M8: [13, 5, 5], M10: [16, 6, 7], M12: [18, 7, 8] };
// pan head Torx: [diameter, height, Torx number]
const PAN: Record<string, [number, number, number]> = { M2: [4, 1.6, 6], M2_5: [5, 1.75, 8], M3: [5.6, 2.1, 10], M4: [8, 2.8, 20], M5: [9.5, 3.5, 25], M6: [12, 4.2, 30], M8: [16, 5.6, 45] };
// hex head: [across flats, head height]
const HEX: Record<string, [number, number]> = { M3: [5.5, 2], M4: [7, 2.8], M5: [8, 3.5], M6: [10, 4], M8: [13, 5.3], M10: [16, 6.4], M12: [18, 7.5], M14: [21, 8.8], M16: [24, 10], M20: [30, 12.5] };
const SET_KEY: Record<string, number> = { M2: 0.9, M2_5: 1.3, M3: 1.5, M4: 2, M5: 2.5, M6: 3, M8: 4, M10: 5, M12: 6 };
// thread-forming screws for plastics, nominal sizes 2.2 to 6 (written as the metric size they replace)
const FORMING: Record<string, [number, number, number]> = { M2: [4, 1.6, 6], M2_5: [5, 1.9, 8], M3: [6, 2.2, 10], M4: [8, 2.9, 20], M5: [10, 3.6, 25], M6: [12, 4.3, 30] };

// stocked lengths [shortest, longest] per head and size
const RANGE: Partial<Record<HeadType, Record<string, [number, number]>>> = {
  socket: { M1_6: [3, 16], M2: [3, 20], M2_5: [4, 25], M3: [4, 50], M4: [5, 60], M5: [6, 80], M6: [8, 100], M8: [10, 120], M10: [12, 150], M12: [16, 160], M14: [25, 160], M16: [20, 200], M20: [25, 200] },
  button: { M2: [3, 12], M2_5: [4, 16], M3: [4, 30], M4: [5, 40], M5: [6, 50], M6: [8, 60], M8: [10, 60], M10: [16, 60], M12: [20, 60] },
  flat: { M2: [4, 16], M2_5: [5, 20], M3: [5, 35], M4: [6, 40], M5: [8, 50], M6: [10, 60], M8: [12, 80], M10: [16, 100], M12: [20, 100], M16: [30, 100], M20: [40, 100] },
  low: { M3: [5, 20], M4: [6, 30], M5: [8, 35], M6: [8, 40], M8: [10, 50], M10: [16, 60], M12: [20, 60] },
  pan: { M2: [3, 16], M2_5: [4, 20], M3: [4, 30], M4: [5, 40], M5: [6, 40], M6: [8, 50], M8: [12, 50] },
  hex: { M3: [6, 30], M4: [8, 40], M5: [10, 50], M6: [10, 80], M8: [12, 120], M10: [16, 150], M12: [20, 160], M14: [30, 160], M16: [30, 200], M20: [40, 200] },
  set: { M2: [2, 10], M2_5: [2, 12], M3: [3, 16], M4: [4, 20], M5: [5, 25], M6: [6, 30], M8: [8, 40], M10: [10, 50], M12: [12, 60] },
  forming: { M2: [4, 12], M2_5: [5, 16], M3: [6, 25], M4: [8, 30], M5: [10, 40], M6: [12, 40] },
};

const UNIFIED_HEADS: HeadType[] = ["socket", "button", "flat", "hex", "set"];

/** Head shape and drive for a thread, or null when that head is not made in that size. */
export function headDims(head: HeadType, t: ThreadSpec): HeadDims | null {
  const k = keyOf(t);
  if (isWoodGauge(t)) {
    // a gauge size only comes as a wood screw: Phillips No. 1 up to 4G, No. 2 from 6G to 10G, No. 3 above
    const ph = t.d < 3.2 ? 1 : t.d < 5.2 ? 2 : 3;
    return head === "wood" ? { d: t.head_d, h: t.head_h, drive: `Phillips No. ${ph} screwdriver`, toolD: ph === 1 ? 5 : ph === 2 ? 6.5 : 8, key: 0, lengths: WOOD_RANGE[t.name] ?? [12, 50] } : null;
  }
  if (isUnified(t)) {
    if (!UNIFIED_HEADS.includes(head)) return null;
    // inch lengths run from about 2 × d to 2"; heads scale from the socket head (ASME B18.3 proportions)
    const lengths: [number, number] = [Math.max(3.2, Math.round(t.d * 0.75 * 10) / 10), t.d < 4 ? 25.4 : t.d < 7 ? 76.2 : 101.6];
    const key = t.key;
    switch (head) {
      case "socket":
        return { d: t.head_d, h: t.head_h, drive: `${inchName(key)} hex key`, toolD: key + 1.5, key, lengths };
      case "button":
        return { d: t.head_d * 1.17, h: t.d * 0.55, drive: `${inchName(key * 0.75)} hex key`, toolD: key * 0.75 + 1.5, key: key * 0.75, lengths: [lengths[0], Math.min(lengths[1], 50.8)] };
      case "flat":
        return { d: t.d * 2, h: t.d / 2, drive: `${inchName(key * 0.75)} hex key`, toolD: key * 0.75 + 1.5, key: key * 0.75, lengths };
      case "hex":
        return t.d < 6 ? null : { d: t.nut_af * 1.155, h: t.d * 0.66, drive: `${inchName(t.nut_af / 25.4)} spanner`, toolD: t.nut_af * 1.6, key: 0, af: t.nut_af, lengths: [12.7, 101.6] };
      case "set":
        return { d: t.d, h: 0, drive: `${inchName(key * 0.5)} hex key`, toolD: t.d, key: key * 0.5, lengths: [3.2, Math.min(25.4, t.d * 4)] };
      default:
        return null;
    }
  }
  const range = RANGE[head]?.[k];
  if (!range) return null;
  switch (head) {
    case "socket": {
      const [d, h, key] = SOCKET[k];
      return { d, h, drive: `${fmt(key)} mm hex key`, toolD: key + 1.5, key, lengths: range };
    }
    case "button": {
      const [d, h, key] = BUTTON[k];
      return { d, h, drive: `${fmt(key)} mm hex key`, toolD: key + 1.5, key, lengths: range };
    }
    case "flat": {
      const key = FLAT_KEY[k];
      return { d: 2 * t.d, h: t.d / 2, drive: `${fmt(key)} mm hex key`, toolD: key + 1.5, key, lengths: range };
    }
    case "low": {
      const [d, h, key] = LOW[k];
      return { d, h, drive: `${fmt(key)} mm hex key`, toolD: key + 1.5, key, lengths: range };
    }
    case "pan": {
      const [d, h, tx] = PAN[k];
      return { d, h, drive: `Torx T${tx}`, toolD: Math.max(4, tx / 4 + 2), key: 0, lengths: range };
    }
    case "forming": {
      const [d, h, tx] = FORMING[k];
      return { d, h, drive: `Torx T${tx}`, toolD: Math.max(4, tx / 4 + 2), key: 0, lengths: range };
    }
    case "hex": {
      const [af, h] = HEX[k];
      // a socket wrench is about 1.6 × the across-flats wide
      return { d: af * 1.155, h, drive: `${fmt(af)} mm spanner`, toolD: af * 1.6, key: 0, af, lengths: range };
    }
    case "set": {
      const key = SET_KEY[k];
      return { d: t.d, h: 0, drive: `${fmt(key)} mm hex key`, toolD: t.d, key, lengths: range };
    }
    case "wood":
      return null;
  }
}

/** Every head made in this size. */
export function headsFor(t: ThreadSpec): HeadType[] {
  return HEAD_TYPES.filter((h) => headDims(h, t));
}

// ---------------------------------------------------------------- grades and materials

export type Grade = "4.8" | "8.8" | "10.9" | "12.9" | "A2-70" | "A4-80" | "brass" | "nylon";
export const GRADE_IDS: Grade[] = ["4.8", "8.8", "10.9", "12.9", "A2-70", "A4-80", "brass", "nylon"];

interface GradeInfo {
  label: string;
  /** proof (or 0.2 % proof) stress and tensile strength, MPa */
  proof: number;
  uts: number;
  /** model material and finish */
  material: string;
  finish: string;
  color: string;
  /** 0 rusts if wet, 1 fine outdoors, 2 salt water and chemicals */
  corrosion: 0 | 1 | 2;
  /** conducts electricity */
  conductive: boolean;
  priceFactor: number;
}

export const GRADES: Record<Grade, GradeInfo> = {
  "4.8": { label: "steel 4.8, zinc plated", proof: 310, uts: 420, material: "Steel", finish: "zinc-plated", color: "#c9d1dc", corrosion: 0, conductive: true, priceFactor: 0.7 },
  "8.8": { label: "steel 8.8, zinc plated", proof: 580, uts: 800, material: "Steel", finish: "zinc-plated", color: "#c9d1dc", corrosion: 0, conductive: true, priceFactor: 0.8 },
  "10.9": { label: "steel 10.9, black", proof: 830, uts: 1040, material: "Steel", finish: "black-oxide", color: "#3b4048", corrosion: 0, conductive: true, priceFactor: 0.95 },
  "12.9": { label: "steel 12.9, black oxide", proof: 970, uts: 1220, material: "Steel", finish: "black-oxide", color: "#3b4048", corrosion: 0, conductive: true, priceFactor: 1 },
  "A2-70": { label: "stainless A2-70 (304)", proof: 450, uts: 700, material: "Stainless 304", finish: "machined", color: "#b9bfc7", corrosion: 1, conductive: true, priceFactor: 1.15 },
  "A4-80": { label: "stainless A4-80 (316)", proof: 600, uts: 800, material: "Stainless 316", finish: "machined", color: "#b9bfc7", corrosion: 2, conductive: true, priceFactor: 1.8 },
  brass: { label: "brass", proof: 250, uts: 370, material: "Brass", finish: "machined", color: "#c9a24b", corrosion: 1, conductive: true, priceFactor: 2 },
  nylon: { label: "nylon 6/6", proof: 50, uts: 70, material: "Nylon", finish: "matte", color: "#ecebe6", corrosion: 2, conductive: false, priceFactor: 1 },
};

/** Grade from loose text: "A2", "a2-70", "12.9", "stainless", "316", "nylon". */
export function gradeFrom(text: string | undefined): Grade | undefined {
  if (!text) return undefined;
  const s = text.trim().toLowerCase().replace(/\s+/g, "");
  if ((GRADE_IDS as string[]).includes(text.trim())) return text.trim() as Grade;
  if (/^a2|304|^stainless$|^ss$|inox/.test(s)) return "A2-70";
  if (/^a4|316|marine/.test(s)) return "A4-80";
  if (/^12\.9|black/.test(s)) return "12.9";
  if (/^10\.9/.test(s)) return "10.9";
  if (/^8\.8|zinc|^steel$/.test(s)) return "8.8";
  if (/^4\.8/.test(s)) return "4.8";
  if (/brass/.test(s)) return "brass";
  if (/nylon|plastic|pa66|pa6/.test(s)) return "nylon";
  return undefined;
}

// ---------------------------------------------------------------- nuts, washers, inserts, standoffs, rings

export type NutType = "hex" | "nyloc" | "thin" | "flange" | "square" | "tslot20";
export const NUT_TYPES: NutType[] = ["hex", "nyloc", "thin", "flange", "square", "tslot20"];

export interface NutDims {
  af: number;
  h: number;
  /** flange diameter (flange nuts) */
  flange?: number;
  standard: string;
  label: string;
}

const NYLOC_H: Record<string, number> = { M3: 4, M4: 5, M5: 5, M6: 6, M8: 8, M10: 10, M12: 12, M16: 16, M20: 20 };
const THIN_H: Record<string, number> = { M3: 1.8, M4: 2.2, M5: 2.7, M6: 3.2, M8: 4, M10: 5, M12: 6, M16: 8, M20: 10 };
const FLANGE: Record<string, [number, number, number]> = { M5: [8, 5, 11.8], M6: [10, 6, 14.2], M8: [13, 8, 17.9], M10: [15, 10, 21.8], M12: [18, 12, 26] };
const SQUARE: Record<string, [number, number]> = { M3: [5.5, 1.8], M4: [7, 2.2], M5: [8, 2.7], M6: [10, 3.2], M8: [13, 4] };

/** Nut shape, or null when that kind is not made in that size. */
export function nutDims(type: NutType, t: ThreadSpec): NutDims | null {
  const k = keyOf(t);
  const unified = isUnified(t);
  switch (type) {
    case "hex":
      return { af: t.nut_af, h: t.nut_h, standard: unified ? "ASME B18.6.3" : "ISO 4032", label: "Hex nut" };
    case "nyloc":
      if (unified) return t.d < 2.5 ? null : { af: t.nut_af, h: Math.round(t.nut_h * 1.4 * 100) / 100, standard: "ASME B18.16.6", label: "Nylon-insert lock nut" };
      return NYLOC_H[k] ? { af: t.nut_af, h: NYLOC_H[k], standard: "ISO 10511 (DIN 985)", label: "Nylon-insert lock nut (nyloc)" } : null;
    case "thin":
      return !unified && THIN_H[k] ? { af: t.nut_af, h: THIN_H[k], standard: "ISO 4035", label: "Thin hex nut (jam nut)" } : null;
    case "flange":
      return !unified && FLANGE[k] ? { af: FLANGE[k][0], h: FLANGE[k][1], flange: FLANGE[k][2], standard: "DIN 6923", label: "Hex flange nut" } : null;
    case "square":
      return !unified && SQUARE[k] ? { af: SQUARE[k][0], h: SQUARE[k][1], standard: "DIN 562", label: "Square nut, thin" } : null;
    case "tslot20":
      // drop-in T-nut for 20 series profiles with 6 mm slots (2020 V-slot and T-slot)
      return k === "M3" || k === "M4" || k === "M5" ? { af: 10, h: 4, standard: "20 series slot", label: "Drop-in T-nut for 2020 profile (6 mm slot)" } : null;
  }
}

export type WasherType = "flat" | "large";
export interface WasherDims {
  id: number;
  od: number;
  h: number;
  standard: string;
  label: string;
}

const FLAT_WASHER: Record<string, [number, number, number]> = {
  M1_6: [1.7, 4, 0.3], M2: [2.2, 5, 0.3], M2_5: [2.7, 6, 0.5], M3: [3.2, 7, 0.5], M4: [4.3, 9, 0.8], M5: [5.3, 10, 1], M6: [6.4, 12, 1.6], M8: [8.4, 16, 1.6], M10: [10.5, 20, 2], M12: [13, 24, 2.5], M14: [15, 28, 2.5], M16: [17, 30, 3], M20: [21, 37, 3],
};
const LARGE_WASHER: Record<string, [number, number, number]> = { M3: [3.2, 9, 0.8], M4: [4.3, 12, 1], M5: [5.3, 15, 1.2], M6: [6.4, 18, 1.6], M8: [8.4, 24, 2], M10: [10.5, 30, 2.5], M12: [13, 37, 3] };
// SAE flat washers, inches [id, od, thickness]
const SAE_WASHER: Record<string, [number, number, number]> = {
  "#2-56": [0.094, 0.25, 0.022], "#4-40": [0.125, 0.312, 0.032], "#6-32": [0.156, 0.375, 0.049], "#8-32": [0.188, 0.438, 0.049], "#10-24": [0.219, 0.5, 0.049], "#10-32": [0.219, 0.5, 0.049],
  "1/4-20": [0.281, 0.625, 0.065], "5/16-18": [0.344, 0.688, 0.065], "3/8-16": [0.406, 0.812, 0.065], "1/2-13": [0.531, 1.062, 0.095],
};

export function washerDims(type: WasherType, t: ThreadSpec): WasherDims | null {
  if (isUnified(t)) {
    const w = type === "flat" ? SAE_WASHER[t.name] : undefined;
    return w ? { id: w[0] * 25.4, od: w[1] * 25.4, h: w[2] * 25.4, standard: "SAE flat", label: "Flat washer" } : null;
  }
  const k = keyOf(t);
  const w = (type === "flat" ? FLAT_WASHER : LARGE_WASHER)[k];
  return w ? { id: w[0], od: w[1], h: w[2], standard: type === "flat" ? "ISO 7089" : "ISO 7093", label: type === "flat" ? "Flat washer" : "Large flat washer" } : null;
}

export interface InsertDims {
  /** hole to melt it into */
  hole: number;
  length: number;
  /** pull-out force in PLA (N) for the standard length, a typical test figure */
  pullPla: number;
}

/** Heat-set insert sizes (the CNC Kitchen / Ruthex pattern). length: a short or long variant of the same hole. */
export function insertDims(t: ThreadSpec, length?: number): InsertDims | null {
  if (!t.insert_d) return null;
  const L = length && length > 0 ? length : t.insert_l;
  // pull-out grows with the area melted into the wall: about 600 N for an M3 × 5.7 in PLA
  const pullPla = 600 * ((t.insert_d * L) / (4.2 * 5.7));
  return { hole: t.insert_d, length: L, pullPla };
}

export type StandoffType = "FF" | "MF";
const STANDOFF_AF: Record<string, number> = { M2: 4, M2_5: 5, M3: 5.5, M4: 7 };
export const STANDOFF_LENGTHS = [3, 4, 5, 6, 8, 10, 11, 12, 15, 16, 18, 20, 25, 30, 35, 40];

export function standoffDims(t: ThreadSpec): { af: number; stud: number } | null {
  const af = STANDOFF_AF[keyOf(t)];
  return af ? { af, stud: t.d < 2.6 ? 5 : 6 } : null;
}

/** DIN 471 external retaining rings by shaft diameter: groove diameter, groove width, ring thickness, ring radial width. */
export const CIRCLIPS: Record<number, { groove: number; m: number; s: number; a: number }> = {
  3: { groove: 2.8, m: 0.5, s: 0.4, a: 1.9 },
  4: { groove: 3.8, m: 0.5, s: 0.4, a: 2.2 },
  5: { groove: 4.8, m: 0.7, s: 0.6, a: 2.5 },
  6: { groove: 5.7, m: 0.8, s: 0.7, a: 2.7 },
  8: { groove: 7.6, m: 0.9, s: 0.8, a: 3.2 },
  10: { groove: 9.6, m: 1.1, s: 1, a: 3.3 },
  12: { groove: 11.5, m: 1.1, s: 1, a: 3.3 },
  15: { groove: 14.3, m: 1.1, s: 1, a: 3.6 },
  17: { groove: 16.2, m: 1.1, s: 1, a: 3.8 },
  20: { groove: 19, m: 1.3, s: 1.2, a: 4 },
  25: { groove: 23.9, m: 1.3, s: 1.2, a: 4.4 },
};

// ---------------------------------------------------------------- lengths, strength, price

const METRIC_LENGTHS = [2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 28, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 90, 100, 110, 120, 130, 140, 150, 160, 180, 200];
/** lengths most shops keep for small sizes; the others are a special order */
const UNCOMMON = new Set([14, 18, 22, 28, 55, 65, 75]);
const INCH_LENGTHS = [1 / 8, 3 / 16, 1 / 4, 5 / 16, 3 / 8, 7 / 16, 1 / 2, 5 / 8, 3 / 4, 7 / 8, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3, 3.5, 4].map((x) => Math.round(x * 25.4 * 100) / 100);

/** Stocked lengths of a screw, shortest first. */
export function stockLengths(head: HeadType, t: ThreadSpec): number[] {
  const hd = headDims(head, t);
  if (!hd) return [];
  const [lo, hi] = hd.lengths;
  const list = isUnified(t) ? INCH_LENGTHS : METRIC_LENGTHS;
  return list.filter((L) => L >= lo - 1e-6 && L <= hi + 1e-6 && (isUnified(t) || t.d >= 6 || !UNCOMMON.has(L)));
}

/**
 * Lengths a hardware store keeps on the shelf in small packs (Bunnings, Mitre 10 and the like in Australia, and their
 * counterparts elsewhere), for metric socket, button, countersunk and hex screws. Other stocked lengths come from
 * fastener and maker shops (online, or a fastener supplier) and take longer to get.
 */
const RETAIL: Record<string, number[]> = {
  M3: [6, 8, 10, 12, 16, 20, 25, 30, 40],
  M4: [10, 12, 16, 20, 25, 30, 40, 50],
  M5: [10, 12, 16, 20, 25, 30, 35, 40, 50],
  M6: [12, 16, 20, 25, 30, 35, 40, 50, 60, 70],
  M8: [16, 20, 25, 30, 35, 40, 50, 60, 70, 80, 100],
  M10: [20, 25, 30, 40, 50, 60, 70, 80, 100],
  M12: [25, 30, 40, 50, 60, 70, 80, 100],
};
const RETAIL_HEADS: HeadType[] = ["socket", "button", "flat", "hex"];

/** Lengths of this screw sold in hardware-store packs (empty when the size or head is a fastener-shop item). */
export function retailLengths(head: HeadType, t: ThreadSpec): number[] {
  if (isUnified(t) || !RETAIL_HEADS.includes(head)) return [];
  const all = RETAIL[keyOf(t)] ?? [];
  const stocked = new Set(stockLengths(head, t));
  return all.filter((L) => stocked.has(L));
}

/** The shortest length from lo to hi, mm: one from a hardware store when there is one, else any stocked length. */
export function pickLength(head: HeadType, t: ThreadSpec, lo: number, hi: number): { length: number; retail: boolean } | undefined {
  const inRange = (L: number) => L >= lo - 1e-6 && L <= hi + 1e-6;
  const r = retailLengths(head, t).find(inRange);
  if (r !== undefined) return { length: r, retail: true };
  const s = stockLengths(head, t).find(inRange);
  return s !== undefined ? { length: s, retail: false } : undefined;
}

/** Tensile stress area, mm² (ISO 898-1). */
export function stressArea(t: ThreadSpec): number {
  const d2 = t.d - 0.6495 * t.pitch;
  const d3 = t.d - 1.2269 * t.pitch;
  return (Math.PI / 4) * ((d2 + d3) / 2) ** 2;
}

/** Load a screw carries before it yields (proof load), N. */
export function proofLoad(t: ThreadSpec, grade: Grade): number {
  return stressArea(t) * GRADES[grade].proof;
}

const STEEL_G_CM3 = 7.9;
/** Typical price each in packs of 25 to 100, US dollars. */
export function screwPrice(t: ThreadSpec, L: number, head: HeadType, grade: Grade): number {
  const hd = headDims(head, t);
  const headVol = hd ? (Math.PI / 4) * hd.d * hd.d * Math.max(hd.h, 0.3 * t.d) : 0;
  const grams = (((Math.PI / 4) * t.d * t.d * L + headVol) / 1000) * STEEL_G_CM3;
  return round2((0.03 + 0.012 * grams) * HEADS[head].priceFactor * GRADES[grade].priceFactor);
}

export function nutPrice(type: NutType, t: ThreadSpec, grade: Grade): number {
  const n = nutDims(type, t);
  const grams = n ? ((n.af * n.af * 0.9 * n.h) / 1000) * STEEL_G_CM3 : 1;
  const factor = type === "nyloc" ? 1.6 : type === "flange" ? 1.4 : type === "tslot20" ? 4 : 1;
  return round2((0.015 + 0.01 * grams) * factor * GRADES[grade].priceFactor);
}

export function washerPrice(type: WasherType, t: ThreadSpec, grade: Grade): number {
  const w = washerDims(type, t);
  const grams = w ? (((Math.PI / 4) * (w.od * w.od - w.id * w.id) * w.h) / 1000) * STEEL_G_CM3 : 0.5;
  return round2((0.01 + 0.012 * grams) * GRADES[grade].priceFactor);
}

export function insertPrice(t: ThreadSpec): number {
  return round2(0.06 + 0.012 * t.d * t.d * 0.5);
}

// ---------------------------------------------------------------- names and parts-list text

const round2 = (x: number) => Math.round(x * 100) / 100;
const fmt = (x: number) => String(Math.round(x * 100) / 100);
const keyOf = (t: ThreadSpec) => Object.keys(THREADS).find((k) => THREADS[k] === t) ?? t.name;

function inchName(x: number): string {
  // nearest 64th as a fraction ("3/32"); a size already in mm comes in over 1
  const inches = x > 1 ? x / 25.4 : x;
  let n = Math.round(inches * 64);
  let d = 64;
  while (n % 2 === 0 && d > 1) {
    n /= 2;
    d /= 2;
  }
  return d === 1 ? `${n}"` : `${n}/${d}"`;
}

/** Length as written on the box: 10 mm, or 3/4" for inch screws. */
export function lengthText(t: ThreadSpec, L: number): string {
  return isUnified(t) ? inchName(L / 25.4) : `${fmt(L)}`;
}

export interface ScrewSpec {
  thread: ThreadSpec;
  length: number;
  head: HeadType;
  grade: Grade;
}

/** "Socket head cap screw M3 × 10, stainless A2-70 (304)" */
export function screwDescription(s: ScrewSpec): string {
  return `${HEADS[s.head].noun} ${s.thread.name} × ${lengthText(s.thread, s.length)}${isUnified(s.thread) ? "" : " mm"}, ${GRADES[s.grade].label}`;
}

/** "M3×10 socket A2-70": the short name used for what the user has on hand and in the chooser's list. */
export function screwName(s: ScrewSpec): string {
  return `${s.thread.name}×${isUnified(s.thread) ? lengthText(s.thread, s.length) : fmt(s.length)} ${s.head} ${s.grade}`;
}

export function screwStandard(s: ScrewSpec): string {
  return isUnified(s.thread) ? (HEADS[s.head].inchStandard ?? HEADS[s.head].standard) : HEADS[s.head].standard;
}

/** Marketplace search text for a fastener. */
export function screwSearch(s: ScrewSpec): string {
  const g = s.grade === "A2-70" ? "stainless" : s.grade === "A4-80" ? "316 stainless" : s.grade === "12.9" || s.grade === "10.9" ? "black alloy steel" : s.grade;
  return `${s.thread.name} x ${lengthText(s.thread, s.length)}${isUnified(s.thread) ? "" : "mm"} ${HEADS[s.head].label} ${g}`;
}

/** A key that matches a parts-list line to what the user has: "screw|M3|10|socket|A2-70". */
export function screwKey(s: ScrewSpec): string {
  return `screw|${s.thread.name}|${fmt(s.length)}|${s.head}|${s.grade}`;
}

// ---------------------------------------------------------------- what the user has

/** A fastener the user has, read from loose text: "M3x10 socket A2", "M3 nut", "M4 insert", "M3x6-20 button" (an assortment). */
export interface HaveSpec {
  kind: "screw" | "nut" | "washer" | "insert" | "standoff";
  thread: string;
  /** a length range; [0, Infinity] when any length */
  lengths: [number, number];
  head?: HeadType;
  grade?: Grade;
  type?: string;
}

const HEAD_WORDS: [RegExp, HeadType][] = [
  [/countersunk|csk|flat|10642|7991/, "flat"],
  [/button|7380/, "button"],
  [/low.?head|7984/, "low"],
  [/pan|7045|14583|phillips|torx/, "pan"],
  [/hex.?head|bolt|4017|4014|933|931/, "hex"],
  [/set|grub|4029|4026/, "set"],
  [/form|plastite|pt\b|self.?tap/, "forming"],
  [/wood|timber|chipboard/, "wood"],
  [/socket|cap|shcs|4762|912/, "socket"],
];

export function parseHave(text: string): HaveSpec | null {
  const s = text.toLowerCase().replace(/×/g, "x").replace(/\s+/g, " ").trim();
  const m = /(m\d+(?:[.,_]\d+)?|#\d+-\d+|\d+\/\d+-\d+)(?:\s*x\s*(\d+(?:\.\d+)?)(?:\s*(?:-|to)\s*(\d+(?:\.\d+)?))?)?/.exec(s);
  if (!m) return null;
  const t = threadSpec(m[1].replace(",", ".").toUpperCase()) ?? threadSpec(m[1]);
  if (!t) return null;
  const rest = s.replace(m[0], " ");
  const kind: HaveSpec["kind"] = /insert/.test(rest) ? "insert" : /standoff|spacer/.test(rest) ? "standoff" : /washer/.test(rest) ? "washer" : /\bnut|nyloc|locknut/.test(rest) ? "nut" : "screw";
  const lo = m[2] ? Number(m[2]) : 0;
  const hi = m[3] ? Number(m[3]) : m[2] ? Number(m[2]) : Infinity;
  const head = kind === "screw" ? HEAD_WORDS.find(([re]) => re.test(rest))?.[1] : undefined;
  const gradeWord = /(a2(?:-70)?|a4(?:-80)?|stainless|304|316|12\.9|10\.9|8\.8|4\.8|black|zinc|brass|nylon)/.exec(rest)?.[1];
  const type = kind === "nut" ? (/nyloc|lock/.test(rest) ? "nyloc" : /thin|jam/.test(rest) ? "thin" : /flange/.test(rest) ? "flange" : /square/.test(rest) ? "square" : /t.?nut|t-slot|tslot|2020/.test(rest) ? "tslot20" : undefined) : kind === "washer" ? (/large|fender|penny|9021|7093/.test(rest) ? "large" : undefined) : undefined;
  return { kind, thread: t.name, lengths: [lo, hi], head, grade: gradeFrom(gradeWord), type };
}

/** Whether a screw is covered by something the user has. */
export function haveScrew(have: readonly string[], s: ScrewSpec): boolean {
  return have.some((h) => {
    const p = parseHave(h);
    return !!p && p.kind === "screw" && p.thread === s.thread.name && s.length >= p.lengths[0] - 1e-6 && s.length <= p.lengths[1] + 1e-6 && (!p.head || p.head === s.head) && (!p.grade || p.grade === s.grade);
  });
}

export function haveOther(have: readonly string[], kind: HaveSpec["kind"], thread: ThreadSpec, type?: string): boolean {
  return have.some((h) => {
    const p = parseHave(h);
    return !!p && p.kind === kind && p.thread === thread.name && (!p.type || !type || p.type === type);
  });
}

/** Whether a parts-list line (by its hardware key, see screwKey) is something the user has. */
export function haveKey(have: readonly string[], key: string): boolean {
  if (!have.length) return false;
  const [kind, size, a, b, c] = key.split("|");
  const t = threadSpec(size);
  if (kind === "screw" && t) {
    return haveScrew(have, { thread: t, length: Number(a), head: b as HeadType, grade: c as Grade });
  }
  if ((kind === "nut" || kind === "washer") && t) return haveOther(have, kind, t, a);
  if (kind === "insert" && t) return haveOther(have, "insert", t);
  if (kind === "standoff" && t) return have.some((h) => {
    const p = parseHave(h);
    return !!p && p.kind === "standoff" && p.thread === t.name && Number(a) >= p.lengths[0] - 1e-6 && Number(a) <= p.lengths[1] + 1e-6;
  });
  if (kind === "circlip") return have.some((h) => new RegExp(`(circlip|retaining ring|e.?clip).*\\b${size}\\s*mm|\\b${size}\\s*mm.*(circlip|retaining ring)`, "i").test(h));
  return false;
}

// ---------------------------------------------------------------- choosing a fastener

export type Into = "insert" | "nut" | "nyloc" | "tapped" | "plastic";
export const INTO: Into[] = ["insert", "nut", "nyloc", "tapped", "plastic"];

export interface FastenRequest {
  /** thickness clamped under the head, mm (from the surface for a countersunk head) */
  grip: number;
  into: Into;
  /** what the thread is in: the tapped part, the plastic it forms into, or the print holding the insert */
  material?: string;
  /** what the head (and a nut) bears on */
  clamped?: string;
  /** most thread depth there is below the grip (a blind hole, an insert, a motor's tapped hole) */
  depth?: number;
  /** tension, total for the joint, N */
  load?: number;
  /** shear across the joint, total, N */
  shear?: number;
  /** screws sharing the load */
  count?: number;
  /** safety factor on the loads */
  factor?: number;
  head?: HeadType;
  grade?: Grade;
  /** the head must not stand proud of the surface */
  flush?: boolean;
  /** height a head may stand above the surface, mm */
  headroom?: number;
  /** widest head that fits (edge distance, a neighbour), mm */
  space?: number;
  /** a fixed size, or the smallest and largest to consider */
  size?: string;
  min?: string;
  max?: string;
  env?: "indoor" | "outdoor" | "marine";
  /** it shakes: lock nuts, threadlocker */
  vibration?: boolean;
  /** inch sizes instead of metric */
  inch?: boolean;
  /** must not conduct (on a circuit board) */
  insulated?: boolean;
  /** what the user has: preferred when it passes */
  have?: readonly string[];
}

export interface FastenChoice extends ScrewSpec {
  name: string;
  description: string;
  standard: string;
  head_dims: HeadDims;
  /** what it threads into, and its parts */
  into: Into;
  nut?: { type: NutType; dims: NutDims; price: number; have: boolean };
  /** washers under the head and under the nut */
  washer?: { type: WasherType; dims: WasherDims; price: number; underHead: boolean; underNut: boolean; have: boolean };
  insert?: { dims: InsertDims; price: number; have: boolean };
  /** thread engaged, and the least and most allowed, mm */
  engage: number;
  engageMin: number;
  engageMax: number;
  /** per screw: what it must carry (with the factor) and what it can, N */
  need: number;
  capacity: number;
  shearNeed: number;
  shearCapacity: number;
  /** what limits it: "screw", "thread", "insert" or "none" */
  limit: string;
  margin: number;
  /** holes: clearance in the clamped parts, pilot or insert hole, counterbore or countersink */
  clearance: number;
  pilot: number;
  cbore?: [number, number];
  csink?: number;
  /** price for one joint (screw and its nut, washers and insert), and whether it is all on hand */
  price: number;
  onHand: boolean;
  notes: string[];
  score: number;
}

export interface Rejected {
  name: string;
  why: string;
}

const COMMON = new Set(["M3", "M4", "M5", "M6", "M8", "#6-32", "#8-32", "#10-24", "1/4-20"]);

/** Thread engagement a joint needs, by what the screw threads into. */
export function engagementFor(req: FastenRequest, t: ThreadSpec, head: HeadType): { min: number; ideal: number; max: number; note?: string } | null {
  switch (req.into) {
    case "insert": {
      const ins = insertDims(t);
      if (!ins) return null;
      // the screw should run nearly through the insert, and not bottom out in the hole below it (screw_boss leaves 1 mm)
      const max = req.depth ?? ins.length + 1;
      // brass holds the screw's full strength from about 1.2 × d
      return { min: Math.max(0.5 * ins.length, Math.min(1.2 * t.d, ins.length - 0.5)), ideal: ins.length, max };
    }
    case "nut":
    case "nyloc": {
      const n = nutDims(req.into === "nyloc" ? "nyloc" : "hex", t);
      if (!n) return null;
      // at least one full thread past a plain nut, two past a nyloc's ring
      const past = req.into === "nyloc" ? 2 * t.pitch : t.pitch;
      return { min: n.h + past, ideal: n.h + past + 1.5 * t.pitch, max: req.depth ?? n.h + Math.max(4 * t.pitch, 5) };
    }
    case "tapped": {
      const rec = materialRecord(req.material ?? "Aluminum 6061");
      const soft = !rec || rec.category !== "metal" ? 2 : rec.mech.uts < 350 ? 1.5 : 1;
      const need = soft * t.d;
      const min = Math.max(need * 0.8, 3 * t.pitch);
      // a shallow blind hole made by someone else (a motor's face) sets what there is: use most of it
      if (req.depth !== undefined && req.depth <= need + 1e-6) return { min: Math.min(min, Math.max(0.6 * req.depth, 3 * t.pitch)), ideal: Math.max(req.depth - 0.5, 0.6 * req.depth), max: req.depth, note: `The ${fmt(req.depth)} mm deep thread limits the engagement below full strength (${fmt(need)} mm in this material): fine for holding a part on, check it for real loads.` };
      return { min, ideal: need, max: req.depth ?? need + 1.5 * t.d };
    }
    case "plastic": {
      // a wood screw wants thread in the wood of at least twice its diameter, and all the depth there is
      if (head === "wood") return { min: 2 * t.d, ideal: 3 * t.d, max: req.depth ?? 8 * t.d };
      // thread-forming screws want about 2 × d in plastic; a machine screw cut into it, more
      const k = head === "forming" ? 2 : 2.5;
      return { min: 1.6 * t.d, ideal: k * t.d, max: req.depth ?? (k + 1) * t.d };
    }
  }
}

/** What the thread can carry before it strips or pulls out, N. */
export function threadCapacity(req: FastenRequest, t: ThreadSpec, engage: number, grade: Grade): { n: number; what: string } {
  const bolt = proofLoad(t, grade);
  switch (req.into) {
    case "nut":
    case "nyloc":
      // a full nut of matching grade is stronger than the screw
      return { n: bolt * 1.1, what: "nut" };
    case "insert": {
      const ins = insertDims(t)!;
      const host = materialRecord(req.material ?? "PLA");
      const yieldMpa = host?.mech.yield ?? 50;
      return { n: ins.pullPla * (yieldMpa / 50) * Math.min(1, engage / ins.length), what: "insert pull-out" };
    }
    case "tapped": {
      const rec = materialRecord(req.material ?? "Aluminum 6061");
      const tau = 0.6 * (rec?.mech.uts ?? 300);
      return { n: 0.6 * Math.PI * t.d * engage * tau, what: "tapped thread" };
    }
    case "plastic": {
      const rec = materialRecord(req.material ?? "PLA");
      if (isWoodGauge(t)) {
        // withdrawal from side grain, USDA Wood Handbook: 108.25 G² D L newtons at failure (G: specific gravity,
        // D and L in mm). A third of it is what a short load such as a knock may use. A design seldom says which
        // timber a board is, so it is worked out for softwood (G = 0.5) unless the wood is lighter still.
        const G = Math.min(rec?.family === "wood" ? rec.density : 0.5, 0.5);
        return { n: (108.25 * G * G * t.d * engage) / 3, what: "wood screw pull-out in softwood" };
      }
      // printed plastic strips at about half the moulded figure
      const tau = 0.6 * (rec?.mech.yield ?? 50) * (isPrinted(req.material ?? "PLA") ? 0.5 : 0.8);
      return { n: 0.6 * Math.PI * t.d * engage * tau, what: "formed plastic thread" };
    }
  }
}

function sizesFor(req: FastenRequest): ThreadSpec[] {
  if (req.size) {
    const t = threadSpec(req.size);
    return t ? [t] : [];
  }
  const pool = ALL_THREADS.filter((t) => (req.inch ? isUnified(t) : !isUnified(t)));
  const lo = threadSpec(req.min)?.d ?? (req.into === "insert" ? 2 : 2.5);
  const hi = threadSpec(req.max)?.d ?? Infinity;
  return pool.filter((t) => t.d >= lo - 1e-6 && t.d <= hi + 1e-6);
}

function gradesFor(req: FastenRequest, head: HeadType): Grade[] {
  if (req.grade) return HEADS[head].grades.includes(req.grade) || req.head ? [req.grade] : [];
  return HEADS[head].grades.filter((g) => {
    if (req.insulated) return g === "nylon";
    if (g === "nylon" || g === "brass") return false;
    if (req.env === "marine") return GRADES[g].corrosion >= 2;
    if (req.env === "outdoor") return GRADES[g].corrosion >= 1;
    return true;
  });
}

function headsAllowed(req: FastenRequest, t: ThreadSpec): HeadType[] {
  if (req.head) return headDims(req.head, t) ? [req.head] : [];
  return headsFor(t).filter((h) => {
    if (h === "set") return false;
    if (req.into === "plastic") return h === "forming";
    if (h === "forming") return false;
    // flush: a countersunk head, or a socket or low head sunk in a counterbore
    if (req.flush) return h === "flat" || h === "socket" || h === "low";
    return true;
  });
}

/** Run every candidate for a joint against the rules and rank the ones that pass. */
export function chooseFastener(req: FastenRequest): { ranked: FastenChoice[]; rejected: Rejected[] } {
  const ranked: FastenChoice[] = [];
  const rejected: Rejected[] = [];
  const reject = (name: string, why: string) => rejected.push({ name, why });
  const count = Math.max(1, Math.round(req.count ?? 1));
  const factor = req.factor ?? 2;
  const need = ((req.load ?? 0) * factor) / count;
  const shearNeed = ((req.shear ?? 0) * factor) / count;
  const have = req.have ?? [];
  const clampPlastic = !!req.clamped && (isPrinted(req.clamped) || materialRecord(req.clamped)?.category === "plastic");
  const sizes = sizesFor(req);
  if (!sizes.length) reject(req.size ?? "size", `no thread size ${req.size ?? ""} in the catalogue`);
  const smallest = new Map<string, number>();
  for (const t of sizes) {
    const heads = headsAllowed(req, t);
    if (!heads.length) {
      reject(t.name, req.into === "insert" && !t.insert_d ? "no common heat-set insert in this size" : `no ${req.head ?? "suitable"} head made in ${t.name}`);
      continue;
    }
    for (const head of heads) {
      const hd = headDims(head, t)!;
      const base = `${t.name} ${head}`;
      if (req.into === "insert" && !insertDims(t)) {
        reject(base, "no common heat-set insert in this size");
        continue;
      }
      if ((req.into === "nut" || req.into === "nyloc") && !nutDims(req.into === "nyloc" ? "nyloc" : "hex", t)) {
        reject(base, `no ${req.into} in this size`);
        continue;
      }
      if (req.space !== undefined && hd.d > req.space + 1e-6) {
        reject(base, `head Ø${fmt(hd.d)} mm is wider than the ${fmt(req.space)} mm there is room for`);
        continue;
      }
      // a head that stands proud needs head room; a flush socket or low head needs a counterbore as deep as the head
      const sunk = req.flush && head !== "flat";
      if (req.headroom !== undefined && !req.flush && head !== "flat" && hd.h > req.headroom + 1e-6) {
        reject(base, `head stands ${fmt(hd.h)} mm proud; only ${fmt(req.headroom)} mm of room`);
        continue;
      }
      const eng = engagementFor(req, t, head);
      if (!eng) {
        reject(base, `cannot thread into ${req.into} in this size`);
        continue;
      }
      if (eng.max < eng.min - 1e-6) {
        reject(base, `only ${fmt(eng.max)} mm of thread depth; it needs at least ${fmt(eng.min)} mm`);
        continue;
      }
      const grades = gradesFor(req, head);
      if (!grades.length) {
        reject(base, req.env === "outdoor" || req.env === "marine" ? `not made in a grade that survives ${req.env}` : `not made in ${req.grade}`);
        continue;
      }
      // washers: under the head on plastic when the load presses harder than the plastic takes, and under a nut on plastic
      const yieldClamp = materialRecord(req.clamped ?? "")?.mech.yield ?? 50;
      const headArea = (Math.PI / 4) * (hd.d * hd.d - t.clearance * t.clearance);
      const headWasher = head !== "flat" && clampPlastic && need > 0 && need / headArea > 0.5 * yieldClamp;
      const nutWasher = (req.into === "nut" || req.into === "nyloc") && (clampPlastic || (req.clamped !== undefined && need > 0));
      const washer = headWasher || nutWasher ? washerDims(clampPlastic && t.d <= 12 ? "large" : "flat", t) ?? washerDims("flat", t) : null;
      const washerStack = (headWasher && washer ? washer.h : 0) + (nutWasher && washer ? washer.h : 0);
      for (const grade of grades) {
        const lengths = stockLengths(head, t);
        // length is measured under the head, or from the top for a countersunk head (which sits within the grip)
        const lo = req.grip + washerStack + eng.min;
        const hi = req.grip + washerStack + eng.max;
        const fits = lengths.filter((L) => L >= lo - 1e-6 && L <= hi + 1e-6);
        const spec = { thread: t, head, grade };
        if (!fits.length) {
          const near = lengths.length ? lengths.reduce((a, b) => (Math.abs(b - lo) < Math.abs(a - lo) ? b : a)) : 0;
          reject(screwName({ ...spec, length: near || lo }), lengths.length ? `no stocked length between ${fmt(lo)} and ${fmt(hi)} mm (stocked ${fmt(lengths[0])}–${fmt(lengths[lengths.length - 1])})` : "not stocked");
          continue;
        }
        const ideal = req.grip + washerStack + eng.ideal;
        const L = fits.reduce((a, b) => (Math.abs(b - ideal) < Math.abs(a - ideal) ? b : a));
        const engage = L - req.grip - washerStack;
        const bolt = proofLoad(t, grade);
        const th = threadCapacity(req, t, Math.min(engage, req.into === "nut" || req.into === "nyloc" ? Infinity : engage), grade);
        const capacity = Math.min(bolt, th.n);
        const limit = need <= 0 ? "none" : bolt <= th.n ? "screw" : th.what;
        // a screw in shear through clearance holes: 60 % of its tensile strength on the thread's stress area
        const shearCapacity = 0.6 * stressArea(t) * GRADES[grade].uts;
        const s: ScrewSpec = { ...spec, length: L };
        const name = screwName(s);
        if (need > 0 && capacity < need) {
          reject(name, `carries ${fmt(capacity)} N (${limit === "screw" ? "screw yields" : `${th.what} fails`}) against the ${fmt(need)} N it needs`);
          continue;
        }
        if (shearNeed > 0 && shearCapacity < shearNeed) {
          reject(name, `shears at ${fmt(shearCapacity)} N against the ${fmt(shearNeed)} N it needs`);
          continue;
        }
        const nutType: NutType | undefined = req.into === "nyloc" || (req.into === "nut" && req.vibration) ? "nyloc" : req.into === "nut" ? "hex" : undefined;
        const nd = nutType ? nutDims(nutType, t) : null;
        const ins = req.into === "insert" ? insertDims(t) : null;
        const notes: string[] = eng.note ? [eng.note] : [];
        const screwHave = haveScrew(have, s);
        const nutHave = nutType ? haveOther(have, "nut", t, nutType) : true;
        const washerHave = washer ? haveOther(have, "washer", t) : true;
        const insertHave = ins ? haveOther(have, "insert", t) : true;
        const price = screwPrice(t, L, head, grade) + (nd ? nutPrice(nutType!, t, grade) : 0) + (washer ? washerPrice(clampPlastic ? "large" : "flat", t, grade) * ((headWasher ? 1 : 0) + (nutWasher ? 1 : 0)) : 0) + (ins ? insertPrice(t) : 0);
        if (req.vibration && req.into !== "nyloc" && req.into !== "nut") notes.push("It shakes: a drop of medium threadlocker (blue) on the thread" + (req.into === "insert" ? ", or a nyloc nut where it can reach through" : ""));
        if (req.into === "plastic" && head !== "forming") notes.push("A machine screw cut into plastic holds less than a thread-forming screw or an insert");
        if (GRADES[grade].corrosion === 0 && req.env === undefined) notes.push("Plain steel: fine indoors and dry");
        if (sunk) notes.push(`Sink the head in a counterbore Ø${fmt(hd.d + 1)} × ${fmt(hd.h + 0.4)} mm (hole(${t.name}, cbore: true))`);
        if (head === "flat") notes.push(`Countersink the top part to Ø${fmt(hd.d)} mm, 90° (hole(${t.name}, csink: true)); the head takes ${fmt(hd.h)} mm of its thickness`);
        if (headWasher) notes.push("A washer under the head spreads the clamping load on the plastic");
        // ranking: what the user has first, then the cheapest joint, common sizes and lengths, and the length nearest the ideal
        const all = screwHave && nutHave && washerHave && insertHave;
        let score = price + Math.abs(L - ideal) * 0.004;
        if (!COMMON.has(t.name)) score += 0.04;
        if (head === "low" || head === "pan") score += 0.02;
        if (head === "hex" && t.d < 6) score += 0.05;
        if (head === "button" && !clampPlastic && need > 0) score += 0.02;
        if (head === "button" && clampPlastic) score -= 0.015;
        if (sunk) score += 0.01;
        if (screwHave) score -= 5;
        if (all) score -= 5;
        const sizeKey = `${head}|${grade}`;
        smallest.set(sizeKey, Math.min(smallest.get(sizeKey) ?? Infinity, t.d));
        ranked.push({
          ...s,
          name,
          description: screwDescription(s),
          standard: screwStandard(s),
          head_dims: hd,
          into: req.into,
          nut: nutType && nd ? { type: nutType, dims: nd, price: nutPrice(nutType, t, grade), have: nutHave } : undefined,
          washer: washer ? { type: clampPlastic ? "large" : "flat", dims: washer, price: washerPrice(clampPlastic ? "large" : "flat", t, grade), underHead: headWasher, underNut: nutWasher, have: washerHave } : undefined,
          insert: ins ? { dims: ins, price: insertPrice(t), have: insertHave } : undefined,
          engage,
          engageMin: eng.min,
          engageMax: eng.max,
          need,
          capacity,
          shearNeed,
          shearCapacity,
          limit,
          margin: need > 0 ? capacity / need : Infinity,
          clearance: t.clearance,
          pilot: req.into === "insert" ? ins!.hole : req.into === "tapped" ? t.tap : req.into === "plastic" ? Math.round(t.d * (head === "forming" ? 0.8 : 0.85) * 10) / 10 : t.clearance,
          cbore: sunk ? [hd.d + 1, hd.h + 0.4] : undefined,
          csink: head === "flat" ? hd.d : undefined,
          price: round2(price),
          onHand: all,
          notes,
          score,
        });
      }
    }
  }
  // a bigger size than the smallest that passes costs more and needs bigger holes: say so in the ranking
  for (const c of ranked) {
    const lo = smallest.get(`${c.head}|${c.grade}`) ?? c.thread.d;
    if (!c.onHand) c.score += (c.thread.d - lo) * 0.015;
  }
  ranked.sort((a, b) => a.score - b.score);
  return { ranked, rejected };
}
