// A carbon layup's ply schedule, given on its process (mfg.carbon_layup(plies: [...])): the laminate it makes, ply
// by ply from the outer surface in, for the process checks and cost, the ply book, and the part's analyses.

import { describeRegion, type PliesSpec } from "../analysis/spec";
import { PLY_MATERIALS } from "../analysis/fe/laminate";
import { fmtNum } from "../lang/values";

export interface PlyBook {
  /** plies in the stack over the whole part (the zones' plies not counted) */
  count: number;
  /** that stack's thickness, mm */
  wall: number;
  /** its cured density, g/cm³, and weight per area, g/m² */
  density: number;
  arealMass: number;
  /** each stack in order from the outside in: "1: 0° 3K twill carbon cloth, 0.22 mm" */
  lines: string[];
  /** the zones' plies, laid inside the stack where they lie: "4 plies [0/90]2 of T700-class carbon UD (0.48 mm) round the bottom bracket" */
  zones: string[];
}

const plyT = (s: PliesSpec) => s.t ?? PLY_MATERIALS[s.material]?.t ?? 0.12;
const plyRho = (s: PliesSpec) => PLY_MATERIALS[s.material]?.density ?? 1.55;
const plyName = (s: PliesSpec) => PLY_MATERIALS[s.material]?.label ?? s.material;
const deg = (a: number) => `${fmtNum(a, 1)}°`;

/** The stacks of a process's plies: whatever the setting holds that looks like plies() (a stored file's too). */
export function plyStacks(v: unknown): PliesSpec[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is PliesSpec => !!s && typeof s === "object" && !Array.isArray(s) && Array.isArray((s as PliesSpec).angles) && (s as PliesSpec).angles.length > 0 && typeof (s as PliesSpec).material === "string" && (s as PliesSpec).material in PLY_MATERIALS);
}

/** The laminate a ply schedule makes, and its ply book lines. Null when it has no stack over the whole part. */
export function plyBook(stacks: PliesSpec[]): PlyBook | null {
  const base = stacks.filter((s) => !s.zone);
  if (!base.length) return null;
  let n = 0;
  let wall = 0;
  let mass = 0;
  const lines: string[] = [];
  for (const s of base) {
    const t = plyT(s);
    const k = s.angles.length;
    const nums = k === 1 ? `${n + 1}` : `${n + 1}–${n + k}`;
    lines.push(`${nums}: ${k === 1 ? deg(s.angles[0]) : s.code} ${plyName(s)}, ${k === 1 ? `${fmtNum(t, 3)} mm` : `${k} × ${fmtNum(t, 3)} mm`}`);
    n += k;
    wall += k * t;
    mass += k * t * plyRho(s);
  }
  const zones = stacks
    .filter((s) => s.zone)
    .map((s) => {
      const k = s.angles.length;
      const where = `the ${s.label && !s.label.startsWith(s.code) ? s.label : describeRegion(s.zone!)}`;
      return `${k === 1 ? `1 ply ${deg(s.angles[0])}` : `${k} plies ${s.code}`} of ${plyName(s)} (${fmtNum(k * plyT(s), 3)} mm) over ${where}`;
    });
  // mm × g/cm³ is a tenth of a g/cm², a thousand g/m²
  return { count: n, wall: Math.round(wall * 1e6) / 1e6, density: mass / wall, arealMass: mass * 1000, lines, zones };
}
