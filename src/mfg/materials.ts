// Which materials suit which processes, plus the material-dependent numbers
// the process rules need. Read from the material database
// (library/materialDb) by the names written in designs; other names are
// matched by family keywords (resin, acrylic, plywood...).

import type { ProcessId } from "./types";
import { MATERIAL_DB, type MaterialFamily as KnownFamily } from "../library/materialDb";

export type MaterialFamily = KnownFamily | "unknown";

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
  /** sand casting minimum wall: thinner than the first fails, thinner than the second warns, mm */
  castWall?: [number, number];
  /** a specific caution for one process */
  notes?: Partial<Record<ProcessId, string>>;
}

const METAL_PROCESSES: ProcessId[] = ["cnc_mill", "cnc_lathe", "sheet_metal", "laser_cut"];

const TABLE: Record<string, MaterialProcessInfo> = Object.fromEntries(
  MATERIAL_DB.map((m) => [
    m.name,
    {
      family: m.family,
      processes: m.processes,
      ...(m.mouldWall ? { mouldWall: m.mouldWall } : {}),
      ...(m.bendFactor !== undefined ? { bendFactor: m.bendFactor } : {}),
      ...(m.laserMaxT !== undefined ? { laserMaxT: m.laserMaxT } : {}),
      ...(m.castWall ? { castWall: m.castWall } : {}),
      ...(m.processNotes ? { notes: m.processNotes } : {}),
    },
  ]),
);

/** Materials only suggested when a part needs what they do (flexible, soft, conductive...), not as everyday choices. */
const SPECIAL = new Set(MATERIAL_DB.filter((m) => m.special).map((m) => m.name));

/** Names that win over a polymer word in the same name: "ABS-like PU resin" is cast polyurethane, not ABS or SLA resin. */
const FIRST: [RegExp, string][] = [[/(?<!thermoplastic )poly ?urethane|\burethane\b|\bpu\b|\bpur\b/i, "Polyurethane"]];

/** A cast or printed part needs an alloy made for it; a loose "aluminium" says which to name. */
const ALUMINIUM_NOTES: Partial<Record<ProcessId, string>> = {
  die_cast: 'Name a die-casting alloy for die-cast parts, such as "Aluminum A380"',
  sand_cast: 'Name a casting alloy for cast parts, such as "Aluminum A356"',
  investment_cast: 'Name a casting alloy for cast parts, such as "Aluminum A356"',
  metal_print: 'Name a printing alloy for printed parts, such as "AlSi10Mg"',
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
  // before "alumin": aluminium bronze is a bronze, and printing and casting alloys have their own records
  [/bronze|gunmetal|c93200|sae ?660/i, TABLE["Bronze"]],
  [/alsi10mg|alsi12|scalmalloy|printed alumin/i, TABLE["AlSi10Mg"]],
  [/a356|a357|alsi7mg|\blm ?25\b/i, TABLE["Aluminum A356"]],
  [/cast alumin/i, { family: "metal", processes: ["sand_cast", "investment_cast", "die_cast", "cnc_mill"], castWall: [3, 4] }],
  [/alumin/i, { family: "metal", processes: METAL_PROCESSES, bendFactor: 1, laserMaxT: 12, notes: ALUMINIUM_NOTES }],
  [/\biron\b|\bgj[ls]\b/i, TABLE["Cast iron"]],
  [/inconel|hastelloy|nickel alloy|superalloy/i, { family: "metal", processes: ["metal_print", "investment_cast", "cnc_mill", "cnc_lathe"] }],
  [/stainless|titanium/i, { family: "metal", processes: [...METAL_PROCESSES, "investment_cast", "metal_print"], bendFactor: 1, laserMaxT: 15 }],
  [/steel/i, { family: "metal", processes: [...METAL_PROCESSES, "sand_cast", "investment_cast"], bendFactor: 1, laserMaxT: 15, castWall: [5, 6] }],
  [/copper|brass/i, { family: "metal", processes: [...METAL_PROCESSES, "sand_cast", "investment_cast"], bendFactor: 1, laserMaxT: 15 }],
];

/** A polymer named with a fill or grade ("Wood PLA", "glass-filled nylon resin") is made like that polymer, not like wood or resin. */
const POLYMERS: [RegExp, string][] = [
  [/\bpla\b/i, "PLA"],
  [/\bpetg\b/i, "PETG"],
  [/\babs\b/i, "ABS"],
  [/\basa\b/i, "ASA"],
  [/\bnylon\b/i, "Nylon"],
];

export function materialInfo(name: string): MaterialProcessInfo {
  if (Object.hasOwn(TABLE, name)) return TABLE[name];
  for (const [re, n] of [...FIRST, ...POLYMERS]) if (re.test(name) && Object.hasOwn(TABLE, n)) return TABLE[n];
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
  // vacuum casting pours a polyurethane made to behave like another plastic: the part is that polyurethane
  if (plastic && process === "vacuum_cast") {
    return {
      status: "warn",
      detail: `Vacuum casting pours a polyurethane resin, not ${material}. Set material: "Polyurethane" and ask the caster for a grade that ${info.family === "thermoplastic" ? `behaves like ${material}` : "suits the part"} (ABS-, PP-, PC- and rubber-like grades exist).`,
    };
  }
  const metalOnly: ProcessId[] = ["sheet_metal", "die_cast", "sand_cast", "investment_cast", "metal_print"];
  const plasticOnly: ProcessId[] = ["fdm", "sla", "sls", "injection", "vacuum_cast"];
  if ((plastic && metalOnly.includes(process)) || (info.family === "metal" && plasticOnly.includes(process))) {
    return { status: "fail", detail: `${material} cannot be made this way. Pick a ${plastic ? "metal" : "plastic"} or another process.` };
  }
  return { status: "warn", detail: `${material} is unusual for this process. Common choices: ${suggestMaterials(process).slice(0, 6).join(", ")}.` };
}

export function suggestMaterials(process: ProcessId): string[] {
  return Object.entries(TABLE)
    .filter(([n, i]) => i.processes.includes(process) && !i.notes?.[process] && !SPECIAL.has(n))
    .map(([n]) => n);
}

const DEFAULT_MATERIAL: Record<ProcessId, string> = {
  fdm: "PLA",
  sla: "Resin",
  sls: "Nylon",
  metal_print: "AlSi10Mg",
  cnc_mill: "Aluminum 6061",
  cnc_lathe: "Aluminum 6061",
  injection: "ABS",
  vacuum_cast: "Polyurethane",
  die_cast: "Aluminum A380",
  sand_cast: "Aluminum A356",
  investment_cast: "Stainless 304",
  sheet_metal: "Steel",
  laser_cut: "Aluminum 6061",
};

/** The material a part gets when it names a process but no material. */
export function defaultMaterial(process: ProcessId): string {
  return DEFAULT_MATERIAL[process];
}
