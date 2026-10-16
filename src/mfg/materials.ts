// Which materials suit which processes, plus the material-dependent numbers
// the process rules need. Keyed by the names in library/standards MATERIALS;
// other names are matched by family keywords (resin, acrylic, plywood...).

import type { ProcessId } from "./types";

export type MaterialFamily = "thermoplastic" | "resin" | "metal" | "composite" | "wood" | "unknown";

export interface MaterialProcessInfo {
  family: MaterialFamily;
  /** processes this material is commonly made with */
  processes: ProcessId[];
  /** injection moulding nominal wall range, mm */
  mouldWall?: [number, number];
  /** minimum inside bend radius as a multiple of sheet thickness */
  bendFactor?: number;
  /** thickest plate a laser cuts cleanly, mm */
  laserMaxT?: number;
  /** a specific caution for one process */
  notes?: Partial<Record<ProcessId, string>>;
}

const METAL_PROCESSES: ProcessId[] = ["cnc_mill", "cnc_lathe", "sheet_metal", "laser_cut"];

const TABLE: Record<string, MaterialProcessInfo> = {
  PLA: { family: "thermoplastic", processes: ["fdm", "injection"], mouldWall: [0.8, 3.0], notes: { cnc_mill: "PLA melts and gums up cutters; machine POM, nylon or ABS instead" } },
  PETG: { family: "thermoplastic", processes: ["fdm", "injection"], mouldWall: [1.0, 3.0] },
  ABS: { family: "thermoplastic", processes: ["fdm", "injection", "cnc_mill", "cnc_lathe"], mouldWall: [1.2, 3.5] },
  ASA: { family: "thermoplastic", processes: ["fdm", "injection"], mouldWall: [1.2, 3.5] },
  Nylon: { family: "thermoplastic", processes: ["fdm", "sls", "injection", "cnc_mill", "cnc_lathe"], mouldWall: [0.8, 2.9] },
  POM: { family: "thermoplastic", processes: ["cnc_mill", "cnc_lathe", "injection", "laser_cut"], mouldWall: [0.8, 3.0], laserMaxT: 10 },
  "Aluminum 6061": {
    family: "metal",
    processes: METAL_PROCESSES,
    bendFactor: 2,
    laserMaxT: 12,
    notes: {
      die_cast: '6061 is a wrought alloy and is not die cast; use "Aluminum A380"',
      sheet_metal: '6061-T6 cracks in tight bends; use "Aluminum 5052" for bent parts, or keep the inside bend radius at 2× the thickness or more',
    },
  },
  Steel: { family: "metal", processes: METAL_PROCESSES, bendFactor: 1, laserMaxT: 20 },
  "Stainless 304": { family: "metal", processes: METAL_PROCESSES, bendFactor: 1, laserMaxT: 15 },
  Brass: { family: "metal", processes: METAL_PROCESSES, bendFactor: 1, laserMaxT: 6 },
  "Aluminum 5052": { family: "metal", processes: METAL_PROCESSES, bendFactor: 1, laserMaxT: 12 },
  "Aluminum A380": { family: "metal", processes: ["die_cast", "cnc_mill"] },
  "Zamak 3": { family: "metal", processes: ["die_cast"] },
  Resin: { family: "resin", processes: ["sla"] },
  Acrylic: { family: "thermoplastic", processes: ["laser_cut", "cnc_mill", "injection"], mouldWall: [0.6, 3.8], laserMaxT: 20 },
  Plywood: { family: "wood", processes: ["laser_cut", "cnc_mill"], laserMaxT: 9 },
  FR4: { family: "composite", processes: ["cnc_mill"], notes: { laser_cut: "Laser cutting FR4 gives off toxic fumes and chars the edge; route it on a CNC" } },
};

const KEYWORDS: [RegExp, MaterialProcessInfo][] = [
  [/resin/i, { family: "resin", processes: ["sla"] }],
  [/\b(pa ?12|pa ?11)\b/i, { family: "thermoplastic", processes: ["sls", "fdm", "injection"], mouldWall: [0.8, 2.9] }],
  [/tpu|tpe/i, { family: "thermoplastic", processes: ["fdm", "sls", "injection"], mouldWall: [1.0, 3.0] }],
  [/polypropylene|\bpp\b/i, { family: "thermoplastic", processes: ["injection", "cnc_mill"], mouldWall: [0.8, 3.8] }],
  [/polycarbonate|\bpc\b/i, { family: "thermoplastic", processes: ["injection", "cnc_mill", "fdm"], mouldWall: [1.0, 3.8] }],
  [/acrylic|pmma/i, { family: "thermoplastic", processes: ["laser_cut", "cnc_mill", "injection"], mouldWall: [0.6, 3.8], laserMaxT: 20 }],
  [/plywood|mdf|wood|birch/i, { family: "wood", processes: ["laser_cut", "cnc_mill"], laserMaxT: 9 }],
  [/a380|adc12|zamak|zinc|magnesium/i, { family: "metal", processes: ["die_cast", "cnc_mill"] }],
  [/alumin/i, { family: "metal", processes: METAL_PROCESSES, bendFactor: 1, laserMaxT: 12 }],
  [/steel|copper|titanium/i, { family: "metal", processes: METAL_PROCESSES, bendFactor: 1, laserMaxT: 15 }],
];

export function materialInfo(name: string): MaterialProcessInfo {
  if (TABLE[name]) return TABLE[name];
  for (const [re, info] of KEYWORDS) if (re.test(name)) return info;
  return { family: "unknown", processes: [] };
}

export const isMetal = (name: string) => materialInfo(name).family === "metal";

/** Whether a material suits a process, and why not. */
export function materialFit(material: string, process: ProcessId): { status: "pass" | "warn" | "fail" | "info"; detail: string } {
  const info = materialInfo(material);
  const note = info.notes?.[process];
  if (info.family === "unknown") return { status: "info", detail: `Kerf has no process data for "${material}". Check with the supplier that it can be made this way.` };
  if (info.processes.includes(process)) return note ? { status: "warn", detail: note } : { status: "pass", detail: `${material} is a common choice for this process` };
  if (note) return { status: "warn", detail: note };
  const plastic = info.family === "thermoplastic" || info.family === "resin";
  const metalOnly: ProcessId[] = ["sheet_metal", "die_cast"];
  const plasticOnly: ProcessId[] = ["fdm", "sla", "sls", "injection"];
  if ((plastic && metalOnly.includes(process)) || (info.family === "metal" && plasticOnly.includes(process))) {
    return { status: "fail", detail: `${material} cannot be made this way. Pick a ${plastic ? "metal" : "plastic"} or another process.` };
  }
  return { status: "warn", detail: `${material} is unusual for this process. Common choices: ${suggestMaterials(process).join(", ")}.` };
}

export function suggestMaterials(process: ProcessId): string[] {
  return Object.entries(TABLE)
    .filter(([, i]) => i.processes.includes(process) && !i.notes?.[process])
    .map(([n]) => n);
}

const DEFAULT_MATERIAL: Record<ProcessId, string> = {
  fdm: "PLA",
  sla: "Resin",
  sls: "Nylon",
  cnc_mill: "Aluminum 6061",
  cnc_lathe: "Aluminum 6061",
  injection: "ABS",
  die_cast: "Aluminum A380",
  sheet_metal: "Steel",
  laser_cut: "Aluminum 6061",
};

/** The material a part gets when it names a process but no material. */
export function defaultMaterial(process: ProcessId): string {
  return DEFAULT_MATERIAL[process];
}
