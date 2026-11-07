// Thermal properties for heat analysis: conductivity, heat capacity,
// expansion and the temperature a material stops being useful at. Read from
// the shared material record (library/materialDb), plus specific heats,
// which the record does not hold. Typical room-temperature values; printed
// plastics conduct a little less than moulded ones, which the record's
// conductivity already allows for.

import { MATERIAL_DB, type MaterialRecord } from "../library/materialDb";
import { mechMaterial } from "./materials";

export interface ThermalMaterial {
  name: string;
  /** thermal conductivity, W/(m·K) */
  k: number;
  /** g/cm³ */
  density: number;
  /** specific heat, J/(g·K) */
  cp: number;
  /** thermal expansion, 1/K */
  alpha: number;
  /** highest temperature for long use under light load, °C */
  maxC: number;
  /** plastics and rubbers lose strength and stiffness well before maxC; metals hold theirs */
  softens: boolean;
  /** properties are a guess (an unknown name, or the inside of a bought component) */
  assumed?: boolean;
  note?: string;
}

/** Specific heat, J/(g·K), by material name; families fill the gaps. */
const CP: Record<string, number> = {
  PLA: 1.8,
  PETG: 1.2,
  ABS: 1.4,
  ASA: 1.3,
  Nylon: 1.7,
  "Nylon CF": 1.4,
  TPU: 1.8,
  POM: 1.46,
  PC: 1.2,
  PP: 1.9,
  Acrylic: 1.47,
  Resin: 1.4,
  Polyurethane: 1.8,
  "Aluminum 6061": 0.9,
  "Aluminum 7075": 0.96,
  "Aluminum 5052": 0.9,
  "Aluminum A380": 0.96,
  "Aluminum A356": 0.96,
  AlSi10Mg: 0.91,
  "Zamak 3": 0.42,
  Steel: 0.49,
  "Steel 4140": 0.47,
  "Cast iron": 0.46,
  "Stainless 304": 0.5,
  "Stainless 316": 0.5,
  Brass: 0.38,
  Bronze: 0.38,
  Copper: 0.385,
  Titanium: 0.52,
  "Carbon fiber": 0.85,
  FR4: 1.1,
  Silicone: 1.3,
  Neoprene: 2.1,
  EPDM: 2.0,
  Nitrile: 2.0,
  "Natural rubber": 1.9,
  Wood: 1.7,
};

/**
 * The inside of a bought module (a driver board, an ESC, a battery pack, a motor) when its material is not one
 * Kerf knows: copper, silicon, FR4 and potting averaged. Good enough to spread its heat to what it is bolted to.
 */
export const COMPONENT_THERMAL: ThermalMaterial = {
  name: "component (copper, board and plastic averaged)",
  k: 5,
  density: 2.2,
  cp: 0.9,
  alpha: 20e-6,
  maxC: 85,
  softens: false,
  assumed: true,
  note: "Bought components are modelled as a uniform block with averaged properties (k 5 W/m·K), so their surface temperatures are a guide; the hottest point inside a chip is hotter.",
};

const byGrade = new Map<string, MaterialRecord>(MATERIAL_DB.map((m) => [m.grade, m]));

function fromRecord(rec: MaterialRecord): ThermalMaterial {
  return {
    name: rec.grade,
    k: rec.conductivity,
    density: rec.density,
    cp: CP[rec.name] ?? (rec.category === "metal" ? 0.6 : 1.4),
    alpha: rec.cte * 1e-6,
    maxC: rec.maxC,
    softens: rec.category !== "metal",
  };
}

/** Thermal properties for a material name; component: the part is a bought module, so an unknown name means its own insides. */
export function thermalMaterial(name: string | undefined, component = false): ThermalMaterial {
  const mech = mechMaterial(name);
  if (mech.assumed) {
    if (component) return COMPONENT_THERMAL;
    const pla = fromRecord(MATERIAL_DB.find((m) => m.name === "PLA")!);
    return { ...pla, name: mech.name, assumed: true, note: `No thermal data for "${name ?? "this material"}"; PLA values assumed.` };
  }
  const rec = byGrade.get(mech.name);
  return rec ? fromRecord(rec) : COMPONENT_THERMAL;
}

/**
 * Strength left at a temperature, as a share of the room-temperature value. Plastics fall away steadily from room
 * temperature to about half at their long-use limit (maxC, near the heat deflection temperature) and are soft past
 * it; metals keep theirs until their limit.
 */
export function strengthAt(m: ThermalMaterial, tC: number): number {
  const room = 23;
  if (tC <= room) return 1;
  if (!m.softens) return tC <= m.maxC ? 1 : Math.max(0.3, 1 - (0.5 * (tC - m.maxC)) / Math.max(m.maxC, 50));
  if (tC >= m.maxC) return Math.max(0.1, 0.5 - (0.4 * (tC - m.maxC)) / 20);
  return 1 - (0.5 * (tC - room)) / Math.max(m.maxC - room, 5);
}

/**
 * Film coefficients for cooling, W/(m²·K). h includes radiation from a dull surface near room temperature
 * (about 5 W/m²·K); conv is the convection alone, used when emissivity: asks for radiation to be worked out.
 */
export const COOLING: Record<string, { h: number; conv: number; text: string }> = {
  sealed: { h: 0, conv: 0, text: "no cooling (insulated)" },
  "still air": { h: 10, conv: 5, text: "still air (natural convection plus radiation)" },
  indoors: { h: 10, conv: 5, text: "still air indoors (natural convection plus radiation)" },
  breeze: { h: 25, conv: 20, text: "a light breeze, about 2 m/s" },
  fan: { h: 50, conv: 45, text: "air blown over it by a fan, about 4 m/s" },
  wind: { h: 80, conv: 75, text: "riding or driving through the air, about 10 m/s" },
  oil: { h: 200, conv: 200, text: "still oil" },
  water: { h: 800, conv: 800, text: "still water" },
  "flowing water": { h: 3000, conv: 3000, text: "water pumped past it" },
};
