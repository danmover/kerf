// Where each material can live: typical service temperatures, sunlight and
// moisture behaviour, and the processes that make it. Used by the brief
// checks, which ask the material advisor (materials/advise) for better picks.
// Read from the material database (library/materialDb); values are typical
// for unfilled grades, and a specific product's datasheet wins.

import type { ProcessKind } from "../core/brief";
import type { ProcessId } from "../mfg/types";
import { MATERIAL_DB } from "./materialDb";

export interface MaterialService {
  /** highest temperature for long use under light load (about the heat deflection temperature), °C */
  maxC: number;
  /** below this it turns brittle, °C */
  minC: number;
  sunlight: "good" | "fair" | "poor";
  /** what goes wrong when wet, if anything */
  wet?: string;
  /** what goes wrong under impact, if anything */
  impact?: string;
  processes: ProcessKind[];
}

const KIND: Record<ProcessId, ProcessKind> = {
  fdm: "fdm",
  sla: "resin",
  sls: "sls",
  metal_print: "metal_print",
  cnc_mill: "cnc",
  cnc_lathe: "cnc",
  laser_cut: "laser",
  sheet_metal: "sheet",
  injection: "molding",
  vacuum_cast: "vacuum_cast",
  die_cast: "die_cast",
  sand_cast: "sand_cast",
  investment_cast: "investment_cast",
  carbon_layup: "other",
};

export const MATERIAL_SERVICE: Record<string, MaterialService> = Object.fromEntries(
  MATERIAL_DB.map((m) => [m.name, { maxC: m.maxC, minC: m.minC, sunlight: m.sunlight, wet: m.wet, impact: m.impact, processes: [...new Set(m.processes.map((p) => KIND[p]))] }]),
);
