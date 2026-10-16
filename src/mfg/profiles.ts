// Manufacturing process profiles: what each process can make, its settings
// with defaults, the rules a part is checked against, and design guidance
// for the assistant. Numbers follow common design-for-manufacture guides
// (Protolabs, Xometry, Hubs, Formlabs) and are deliberately on the safe side.

import type { V3 } from "../kernel/recipe";
import { isMetal, materialInfo, suggestMaterials } from "./materials";
import type { ProcessId, ProcessSpec, Rules, SettingValue } from "./types";

export type SettingKind = "number" | "bool" | "dir" | "dirs" | "size";

export interface SettingDef {
  key: string;
  kind: SettingKind;
  /** null: worked out from the geometry */
  def: SettingValue | null;
  doc: string;
}

export interface ProcessDef {
  id: ProcessId;
  label: string;
  /** a few words for chips and menus */
  short: string;
  family: "additive" | "subtractive" | "formative" | "sheet";
  summary: string;
  /** typical general tolerance, ± mm */
  tolerance: number;
  /** what you send to the maker */
  output: string;
  /** when this process is the right choice */
  bestFor: string;
  settings: SettingDef[];
}

const Z: V3 = [0, 0, 1];
const NZ: V3 = [0, 0, -1];

export const PROCESSES: Record<ProcessId, ProcessDef> = {
  fdm: {
    id: "fdm",
    label: "3D printing (FDM)",
    short: "FDM print",
    family: "additive",
    summary: "Filament printed layer by layer. Cheap and fast for prototypes and one-offs.",
    tolerance: 0.3,
    output: "STL or 3MF, sliced for the printer",
    bestFor: "prototypes, jigs and low volumes in PLA, PETG, ABS, ASA or nylon",
    settings: [
      { key: "nozzle", kind: "number", def: 0.4, doc: "nozzle diameter, mm" },
      { key: "layer", kind: "number", def: 0.2, doc: "layer height, mm" },
      { key: "build", kind: "dir", def: Z, doc: "build direction in the part's frame (Z: printed as modelled; -Z: upside down)" },
      { key: "overhang", kind: "number", def: 45, doc: "steepest unsupported overhang, degrees from vertical" },
      { key: "supports", kind: "bool", def: true, doc: "support material allowed (false makes overhangs failures)" },
      { key: "bed", kind: "size", def: [250, 210, 210], doc: "build volume (x, y, z), mm" },
    ],
  },
  sla: {
    id: "sla",
    label: "3D printing (SLA resin)",
    short: "SLA resin",
    family: "additive",
    summary: "Resin cured by laser or screen. Fine detail and smooth surfaces, small build volume.",
    tolerance: 0.15,
    output: "STL, with supports added by the print service",
    bestFor: "small detailed parts, smooth cosmetic models and moulding masters",
    settings: [
      { key: "build", kind: "dir", def: Z, doc: "build direction" },
      { key: "bed", kind: "size", def: [145, 145, 185], doc: "build volume (x, y, z), mm" },
    ],
  },
  sls: {
    id: "sls",
    label: "3D printing (SLS / MJF nylon)",
    short: "SLS nylon",
    family: "additive",
    summary: "Nylon powder fused by laser or agent. No supports, strong functional parts.",
    tolerance: 0.3,
    output: "STL or 3MF",
    bestFor: "functional nylon parts, complex shapes and low-to-mid volumes without tooling",
    settings: [{ key: "bed", kind: "size", def: [300, 300, 300], doc: "build volume (x, y, z), mm" }],
  },
  cnc_mill: {
    id: "cnc_mill",
    label: "CNC milling (3-axis)",
    short: "CNC mill",
    family: "subtractive",
    summary: "Cut from solid stock with rotating end mills, one setup per side.",
    tolerance: 0.1,
    output: "STEP plus a drawing for toleranced features and threads",
    bestFor: "precise metal and engineering-plastic parts in low to mid volumes",
    settings: [
      { key: "tool_d", kind: "number", def: 3, doc: "smallest end mill diameter, mm (sets the tightest inside corner and narrowest slot)" },
      { key: "setups", kind: "dirs", def: [Z, NZ], doc: "directions the tool comes from, one per setup (add X, -Y... for side work)" },
      { key: "max_depth", kind: "number", def: 4, doc: "deepest pocket as a multiple of its width" },
      { key: "envelope", kind: "size", def: [600, 400, 300], doc: "machine travel (x, y, z), mm" },
    ],
  },
  cnc_lathe: {
    id: "cnc_lathe",
    label: "CNC turning (lathe)",
    short: "CNC lathe",
    family: "subtractive",
    summary: "Spun in a chuck and cut with a fixed tool. Round parts: shafts, spacers, pins, knobs.",
    tolerance: 0.05,
    output: "STEP plus a drawing for diameters, fits and threads",
    bestFor: "shafts, bushings, spacers and anything round",
    settings: [
      { key: "axis", kind: "dir", def: Z, doc: "spindle axis in the part's frame" },
      { key: "max_d", kind: "number", def: 200, doc: "largest diameter the machine turns, mm" },
      { key: "max_length", kind: "number", def: 300, doc: "longest part, mm" },
    ],
  },
  injection: {
    id: "injection",
    label: "Injection moulding",
    short: "Injection mould",
    family: "formative",
    summary: "Molten plastic shot into a steel or aluminium mould. Costly tooling, very cheap parts.",
    tolerance: 0.1,
    output: "STEP for the toolmaker, with the parting line and gate agreed",
    bestFor: "plastic parts in thousands or more",
    settings: [
      { key: "pull", kind: "dir", def: Z, doc: "direction the mould opens (the part releases along ±pull)" },
      { key: "draft", kind: "number", def: 1, doc: "minimum draft on faces along the pull, degrees" },
      { key: "texture", kind: "bool", def: false, doc: "textured surfaces (needs 3° draft or more)" },
      { key: "side_actions", kind: "bool", def: false, doc: "side actions or lifters allowed for undercuts (raises tool cost)" },
      { key: "min_wall", kind: "number", def: null, doc: "override the material's minimum wall, mm" },
      { key: "max_wall", kind: "number", def: null, doc: "override the material's maximum wall, mm" },
    ],
  },
  die_cast: {
    id: "die_cast",
    label: "Die casting",
    short: "Die cast",
    family: "formative",
    summary: "Molten aluminium or zinc forced into a steel die. Metal parts in volume.",
    tolerance: 0.15,
    output: "STEP for the toolmaker, plus machining drawing for critical faces",
    bestFor: "metal housings and brackets in thousands or more",
    settings: [
      { key: "pull", kind: "dir", def: Z, doc: "direction the die opens" },
      { key: "draft", kind: "number", def: 1.5, doc: "minimum draft, degrees" },
      { key: "side_actions", kind: "bool", def: false, doc: "slides allowed for undercuts" },
    ],
  },
  sheet_metal: {
    id: "sheet_metal",
    label: "Sheet metal (cut and bent)",
    short: "Sheet metal",
    family: "sheet",
    summary: "Flat sheet laser cut or punched, then bent on a press brake.",
    tolerance: 0.2,
    output: "STEP plus a flat pattern DXF and bend table",
    bestFor: "brackets, enclosures, chassis and covers in metal",
    settings: [
      { key: "t", kind: "number", def: null, doc: "sheet thickness, mm (measured from the part if not given)" },
      { key: "bend_r", kind: "number", def: null, doc: "minimum inside bend radius, mm (default from the material)" },
    ],
  },
  laser_cut: {
    id: "laser_cut",
    label: "Laser or waterjet cutting (flat)",
    short: "Laser cut",
    family: "sheet",
    summary: "A 2D profile cut through flat plate. No bends, pockets or bevels.",
    tolerance: 0.15,
    output: "DXF of the outline at 1:1, plus the plate thickness",
    bestFor: "flat plates, gussets, spacers and panels in metal, acrylic or wood",
    settings: [
      { key: "t", kind: "number", def: null, doc: "plate thickness, mm (measured if not given)" },
      { key: "normal", kind: "dir", def: null, doc: "plate normal (found from the geometry if not given)" },
      { key: "kerf", kind: "number", def: 0.2, doc: "cut width, mm" },
    ],
  },
};

export const PROCESS_IDS = Object.keys(PROCESSES) as ProcessId[];

export function isProcessId(s: string): s is ProcessId {
  return s in PROCESSES;
}

/** Settings with defaults filled in. */
export function resolvedSettings(spec: ProcessSpec): Record<string, SettingValue | null> {
  const out: Record<string, SettingValue | null> = {};
  for (const s of PROCESSES[spec.id].settings) out[s.key] = spec.settings[s.key] ?? s.def;
  return out;
}

const num = (v: SettingValue | null | undefined, d: number) => (typeof v === "number" ? v : d);
const dir = (v: SettingValue | null | undefined, d: V3): V3 => (Array.isArray(v) && typeof v[0] === "number" ? norm(v as V3) : d);
const dirs = (v: SettingValue | null | undefined, d: V3[]): V3[] => (Array.isArray(v) && Array.isArray(v[0]) ? (v as V3[]).map(norm) : d);
const size = (v: SettingValue | null | undefined, d: V3): V3 => (Array.isArray(v) && typeof v[0] === "number" ? (v as V3) : d);
const neg = (v: V3): V3 => [-v[0] + 0, -v[1] + 0, -v[2] + 0];
/** rounds away float noise such as 3 × 0.6 = 1.7999999999999998 */
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Turn a process choice into the numbers a part is checked against. */
export function resolveRules(spec: ProcessSpec, material: string): Rules {
  const s = resolvedSettings(spec);
  const def = PROCESSES[spec.id];
  const base = { process: spec.id, label: def.label, material };
  const metal = isMetal(material);
  const info = materialInfo(material);
  switch (spec.id) {
    case "fdm": {
      const nozzle = num(s.nozzle, 0.4);
      const build = dir(s.build, Z);
      return {
        ...base,
        wall: { fail: r6(2 * nozzle), warn: r6(3 * nozzle), why: `two lines of a ${nozzle} mm nozzle is the thinnest wall that prints; three is reliable` },
        overhang: { build, max: num(s.overhang, 45), severity: s.supports === false ? "fail" : "warn", bridgeR: 4 },
        bedContact: { build },
        holes: { minD: Math.max(1.5, r6(3 * nozzle)), why: "small printed holes close up and need drilling out" },
        envelope: { size: size(s.bed, [250, 210, 210]), frame: build, what: "printer's build volume" },
      };
    }
    case "sla": {
      const build = dir(s.build, Z);
      return {
        ...base,
        wall: { fail: 0.3, warn: 0.6, why: "unsupported resin walls under 0.6 mm warp or break in post-curing" },
        holes: { minD: 0.5, why: "resin does not drain from smaller holes" },
        envelope: { size: size(s.bed, [145, 145, 185]), frame: build, what: "printer's build volume" },
        voids: { severity: "warn", why: "uncured resin stays trapped inside; add two drain holes of at least 3.5 mm" },
      };
    }
    case "sls":
      return {
        ...base,
        wall: { fail: 0.7, warn: 1.0, why: "thinner nylon walls do not sinter through and break" },
        holes: { minD: 1.5, why: "powder sinters shut in smaller holes" },
        envelope: { size: size(s.bed, [300, 300, 300]), frame: null, what: "printer's build volume" },
        voids: { severity: "fail", why: "unfused powder is trapped inside; add two escape holes of at least 5 mm" },
      };
    case "cnc_mill": {
      const tool = num(s.tool_d, 3);
      const setups = dirs(s.setups, [Z, NZ]);
      return {
        ...base,
        wall: metal ? { fail: 0.5, warn: 0.8, why: "thin metal walls vibrate and bend while cutting" } : { fail: 1.0, warn: 1.5, why: "thin plastic walls flex and melt while cutting" },
        reach: { dirs: setups, severity: "fail", what: "setup" },
        innerRadius: { min: tool / 2, dirs: setups, severity: "fail", why: `a Ø${fmt(tool)} mm end mill leaves at least R${fmt(tool / 2)} in every inside corner along its axis` },
        gap: { min: tool, dirs: setups },
        depthRatio: { max: num(s.max_depth, 4), dirs: setups },
        holes: { minD: 1, minDFail: 0.5, maxDepthRatio: 10, why: "drills under 1 mm break easily; holes deeper than 10× their diameter need gun drilling" },
        envelope: { size: size(s.envelope, [600, 400, 300]), frame: null, what: "machine's travel" },
      };
    }
    case "cnc_lathe": {
      return {
        ...base,
        wall: metal ? { fail: 0.5, warn: 0.8, why: "thin-walled turned parts chatter and distort in the chuck" } : { fail: 1.0, warn: 1.5, why: "thin plastic walls distort in the chuck" },
        revolve: { axis: dir(s.axis, Z), maxSlender: 8, maxBoreRatio: 5, maxD: num(s.max_d, 200), maxLength: num(s.max_length, 300) },
        holes: { minD: 1, minDFail: 0.5, maxDepthRatio: 10, why: "small or very deep holes need special drills" },
      };
    }
    case "injection": {
      const pull = dir(s.pull, Z);
      const [lo, hi] = info.mouldWall ?? [1.0, 4.0];
      const minW = num(s.min_wall, lo);
      const maxW = num(s.max_wall, hi);
      const draft = s.texture === true ? Math.max(3, num(s.draft, 1)) : num(s.draft, 1);
      return {
        ...base,
        wall: { fail: minW, warn: minW, max: maxW, thickRatio: 1.6, why: `${material} fills a mould well between ${fmt(minW)} and ${fmt(maxW)} mm` },
        draft: { pull, warn: draft, fail: draft / 2 },
        reach: { dirs: [pull, neg(pull)], severity: s.side_actions === true ? "info" : "fail", what: "mould" },
        innerRadius: { min: 0.5, factor: 0.5, dirs: null, severity: "warn", why: "sharp inside corners concentrate stress and block the flow; use at least half the wall" },
        holes: { minD: 1, maxDepthRatio: 5, why: "thin core pins bend under injection pressure" },
        envelope: { size: [600, 500, 300], frame: null, what: "mould area of a mid-size press" },
      };
    }
    case "die_cast": {
      const pull = dir(s.pull, Z);
      const draft = num(s.draft, 1.5);
      return {
        ...base,
        wall: { fail: 1.0, warn: 1.5, max: 6, thickRatio: 1.6, why: "die-cast aluminium fills reliably between 1.5 and 6 mm" },
        draft: { pull, warn: draft, fail: draft / 2 },
        reach: { dirs: [pull, neg(pull)], severity: s.side_actions === true ? "info" : "fail", what: "mould" },
        innerRadius: { min: 1, factor: 0.5, dirs: null, severity: "warn", why: "sharp inside corners crack the die and the casting; use at least R1 or half the wall" },
        holes: { minD: 2.5, maxDepthRatio: 4, why: "cast holes under 2.5 mm, or deeper than 4× their diameter, are drilled afterwards" },
        envelope: { size: [600, 500, 300], frame: null, what: "die area of a mid-size casting machine" },
      };
    }
    case "sheet_metal": {
      const t = typeof s.t === "number" ? s.t : null;
      const factor = info.bendFactor ?? 1;
      return {
        ...base,
        sheet: { t, bendR: typeof s.bend_r === "number" ? s.bend_r : null, bendFactor: factor, holeEdge: 2 },
        holes: { minD: t ?? 1, minDFail: t ?? 1, why: "punched or cut holes must be at least as wide as the sheet is thick" },
      };
    }
    case "laser_cut": {
      const t = typeof s.t === "number" ? s.t : null;
      return {
        ...base,
        profile: { normal: Array.isArray(s.normal) ? dir(s.normal, Z) : null, t, maxT: info.laserMaxT ?? 10, minWeb: Math.max(0.5, metal ? (t ?? 1) : 1) },
        holes: { minD: metal ? (t ?? 1) : 0.5, why: metal ? "holes narrower than the plate thickness taper and burn" : "very small holes burn through" },
      };
    }
  }
}

export function fmt(n: number, d = 2): string {
  const r = Math.round(n * 10 ** d) / 10 ** d;
  return Object.is(r, -0) ? "0" : String(r);
}

const axisName = (v: V3): string => {
  const names: [V3, string][] = [
    [[1, 0, 0], "X"],
    [[-1, 0, 0], "-X"],
    [[0, 1, 0], "Y"],
    [[0, -1, 0], "-Y"],
    [[0, 0, 1], "Z"],
    [[0, 0, -1], "-Z"],
  ];
  for (const [d, n] of names) if (Math.abs(d[0] - v[0]) + Math.abs(d[1] - v[1]) + Math.abs(d[2] - v[2]) < 1e-6) return n;
  return `(${v.map((x) => fmt(x, 3)).join(", ")})`;
};
export { axisName };

function settingSource(kind: SettingKind, v: SettingValue): string {
  if (kind === "bool") return String(v);
  if (kind === "number") return fmt(v as number, 3);
  if (kind === "dir") return axisName(v as V3);
  if (kind === "dirs") return "[" + (v as V3[]).map(axisName).join(", ") + "]";
  return "(" + (v as V3).map((x) => fmt(x, 3)).join(", ") + ")";
}

/** Kerf source for a process: mfg.cnc_mill(tool_d: 2, setups: [Z, -Z, X]) */
export function specToSource(spec: ProcessSpec): string {
  const def = PROCESSES[spec.id];
  const args: string[] = [];
  for (const sd of def.settings) {
    const v = spec.settings[sd.key];
    if (v === undefined) continue;
    args.push(`${sd.key}: ${settingSource(sd.kind, v)}`);
  }
  if (spec.material) args.push(`material: ${JSON.stringify(spec.material)}`);
  return `mfg.${spec.id}(${args.join(", ")})`;
}

/** Numbers a design can use in requirements: printed.min_wall, moulded.draft... */
export function ruleFields(rules: Rules): Record<string, number> {
  const f: Record<string, number> = { tolerance: PROCESSES[rules.process].tolerance };
  if (rules.wall) {
    f.min_wall = rules.wall.warn;
    if (rules.wall.max !== undefined) f.max_wall = rules.wall.max;
  }
  if (rules.draft) f.draft = rules.draft.warn;
  if (rules.innerRadius) f.min_inner_r = rules.innerRadius.min;
  if (rules.gap) f.tool_d = rules.gap.min;
  if (rules.overhang) f.max_overhang = rules.overhang.max;
  if (rules.holes) f.min_hole = rules.holes.minD;
  if (rules.sheet?.t) {
    f.t = rules.sheet.t;
    f.bend_r = rules.sheet.bendR ?? rules.sheet.bendFactor * rules.sheet.t;
  }
  if (rules.profile?.t) f.t = rules.profile.t;
  if (rules.revolve) f.max_d = rules.revolve.maxD;
  return f;
}

/** Design rules in plain words, for the assistant and the process picker. */
export function guideLines(rules: Rules): string[] {
  const out: string[] = [];
  const r = rules;
  if (r.wall)
    out.push(
      `Walls ${fmt(r.wall.warn)} mm or thicker${r.wall.fail < r.wall.warn ? ` (under ${fmt(r.wall.fail)} mm fails)` : ""}${r.wall.max ? `, and no thicker than ${fmt(r.wall.max)} mm` : ""}: ${r.wall.why}.`,
    );
  if (r.wall?.thickRatio)
    out.push(`Keep walls uniform: sections more than ${r.wall.thickRatio}× the nominal wall sink and void. Core out thick areas and use ribs (about 0.6× the wall) for stiffness.`);
  if (r.draft)
    out.push(
      `Draft every face that runs along the pull direction ${axisName(r.draft.pull)} by at least ${fmt(r.draft.warn)}° (under ${fmt(r.draft.fail)}° fails). Bosses, ribs and hole walls need it too.`,
    );
  if (r.reach?.what === "mould")
    out.push(
      `No undercuts: every face must release straight along ${axisName(r.reach.dirs[0])} or ${axisName(r.reach.dirs[1])}${r.reach.severity === "info" ? " (side actions are allowed here, but each adds tool cost)" : ". Snap hooks, side holes and inward lips need side actions; redesign them as pass-through cores or open them to a pull direction"}.`,
    );
  if (r.reach?.what === "setup")
    out.push(`Every face must be reachable by a tool from one of the setups: ${r.reach.dirs.map(axisName).join(", ")}. Side holes and undercuts need another setup, which adds cost.`);
  if (r.innerRadius)
    out.push(
      r.innerRadius.dirs
        ? `Inside corners along the tool axis need a radius of at least ${fmt(r.innerRadius.min)} mm: ${r.innerRadius.why}. Use slightly more than the tool radius; floors can stay sharp.`
        : `Round every inside corner to at least ${r.innerRadius.factor ? `${r.innerRadius.factor}× the wall (min ${fmt(r.innerRadius.min)} mm)` : `${fmt(r.innerRadius.min)} mm`}: ${r.innerRadius.why}.`,
    );
  if (r.gap) out.push(`Slots and gaps must be at least ${fmt(r.gap.min)} mm wide so the smallest tool fits.`);
  if (r.depthRatio) out.push(`Pockets no deeper than ${r.depthRatio.max}× their width.`);
  if (r.overhang)
    out.push(
      `Overhangs steeper than ${r.overhang.max}° from vertical need support${r.overhang.severity === "fail" ? " (not allowed here)" : ""}. Orient the part with a large flat face on the bed (build direction ${axisName(r.overhang.build)}), chamfer the underside of ledges at 45°, and keep horizontal holes under Ø${fmt(2 * r.overhang.bridgeR)} or use teardrops.`,
    );
  if (r.holes) out.push(`Holes at least Ø${fmt(r.holes.minD)} mm${r.holes.maxDepthRatio ? ` and no deeper than ${r.holes.maxDepthRatio}× their diameter` : ""}: ${r.holes.why}.`);
  if (r.envelope) out.push(`Fits the ${r.envelope.what}: ${r.envelope.size.map((x) => fmt(x)).join(" × ")} mm.`);
  if (r.revolve)
    out.push(
      `Every surface must revolve about the spindle axis ${axisName(r.revolve.axis)}: diameters, faces, cones, grooves and on-axis holes. Flats and cross holes need a second operation. Keep length under ${r.revolve.maxSlender}× diameter without a tailstock and bores under ${r.revolve.maxBoreRatio}× their diameter deep. Max Ø${fmt(r.revolve.maxD)}, length ${fmt(r.revolve.maxLength)} mm.`,
    );
  if (r.sheet)
    out.push(
      `One constant thickness${r.sheet.t ? ` (${fmt(r.sheet.t)} mm)` : ""}; only flat faces and cylindrical bends; inside bend radius at least ${r.sheet.bendR ? `${fmt(r.sheet.bendR)} mm` : `${r.sheet.bendFactor}× the thickness`}; holes at least the thickness in diameter and at least ${r.sheet.holeEdge}× the thickness from edges and bends. Model bends as real radii, never as sharp corners.`,
    );
  if (r.profile)
    out.push(
      `A flat plate of one thickness${r.profile.t ? ` (${fmt(r.profile.t)} mm)` : ""}, cut straight through: no pockets, steps, bends or bevels. Webs at least ${fmt(r.profile.minWeb)} mm; plate no thicker than ${fmt(r.profile.maxT)} mm for ${r.material}.`,
    );
  if (r.voids) out.push(`No sealed internal voids: ${r.voids.why}.`);
  const mats = suggestMaterials(r.process);
  if (mats.length) out.push(`Usual materials: ${mats.join(", ")}.`);
  return out;
}
