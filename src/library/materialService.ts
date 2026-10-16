// Where each material can live: typical service temperatures, sunlight and
// moisture behaviour, and the processes that make it. Used by the brief
// checks. Values are typical for unfilled grades; a specific product's
// datasheet wins over them.

import type { ProcessKind } from "../core/brief";

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

export const MATERIAL_SERVICE: Record<string, MaterialService> = {
  PLA: { maxC: 52, minC: -10, sunlight: "poor", impact: "PLA is brittle and can crack on impact", processes: ["fdm", "molding"] },
  PETG: { maxC: 70, minC: -20, sunlight: "fair", processes: ["fdm", "molding"] },
  ABS: { maxC: 88, minC: -20, sunlight: "poor", processes: ["fdm", "molding", "cnc"] },
  ASA: { maxC: 90, minC: -20, sunlight: "good", processes: ["fdm", "molding"] },
  Nylon: { maxC: 95, minC: -40, sunlight: "fair", wet: "Nylon absorbs water and swells by about 1 to 2%, which loosens fits", processes: ["sls", "fdm", "molding", "cnc"] },
  POM: { maxC: 100, minC: -40, sunlight: "poor", processes: ["cnc", "molding"] },
  "Aluminum 6061": { maxC: 150, minC: -80, sunlight: "good", processes: ["cnc", "sheet", "laser"] },
  Steel: { maxC: 350, minC: -40, sunlight: "good", wet: "Plain steel rusts unless it is plated, painted or oiled", processes: ["cnc", "sheet", "laser"] },
  "Stainless 304": { maxC: 400, minC: -100, sunlight: "good", processes: ["cnc", "sheet", "laser"] },
  Brass: { maxC: 200, minC: -100, sunlight: "good", processes: ["cnc"] },
  Wood: { maxC: 60, minC: -40, sunlight: "fair", wet: "Plywood swells and its glue lines weaken when wet: seal or paint it", processes: ["cnc", "laser"] },
  FR4: { maxC: 130, minC: -50, sunlight: "fair", processes: ["cnc", "laser"] },
};

/** Better choices to suggest when a material fails a condition, in order of preference. */
export const SUNLIGHT_PICKS = ["ASA", "PETG"];
export const HEAT_PICKS = ["PETG", "ABS", "ASA", "Nylon"];
