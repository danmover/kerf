// Manufacturing process profiles: what each process can make, its settings
// with defaults, the rules a part is checked against, and design guidance
// for the assistant. Numbers follow common design-for-manufacture guides
// (Protolabs, Xometry, Hubs, Formlabs, foundry and investment-casting design
// guides) and are deliberately on the safe side.

import type { V3 } from "../kernel/recipe";
import { materialRecord } from "../library/materialDb";
import { FDM_DEFAULTS, INFILL_PATTERNS } from "./infill";
import { CUTTER_SOURCES, cutterFit, fdmNeeds, flowRatio, frameFit, isMetal, materialInfo, millClass, mouldPressure, suggestMaterials } from "./materials";
import type { ProcessId, ProcessSpec, Rules, SettingValue, Tool } from "./types";

export type SettingKind = "number" | "bool" | "dir" | "dirs" | "size" | "choice" | "tools";

export interface SettingDef {
  key: string;
  kind: SettingKind;
  /** null: worked out from the geometry */
  def: SettingValue | null;
  doc: string;
  /** describes the machine or shop rather than this part, so a machine profile (Settings → Making) sets it */
  machine?: boolean;
  /** choice: the values allowed */
  options?: readonly string[];
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
  /** ISO 2768 general tolerance class for drawings, where the standard fits the process */
  iso2768?: "f" | "m" | "c" | "v";
  /** ISO 8062-3 casting tolerance grade (DCTG) for drawings of castings */
  dctg?: number;
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
      { key: "nozzle", kind: "number", def: 0.4, doc: "nozzle diameter, mm", machine: true },
      { key: "layer", kind: "number", def: 0.2, doc: "layer height, mm" },
      { key: "build", kind: "dir", def: Z, doc: "build direction in the part's frame (Z: printed as modelled; -Z: upside down)" },
      { key: "walls", kind: "number", def: FDM_DEFAULTS.walls, doc: "walls (perimeters) round every outline; strength analyses count them as solid" },
      { key: "top", kind: "number", def: FDM_DEFAULTS.top, doc: "solid layers under every top face and over every bottom face" },
      { key: "infill", kind: "number", def: FDM_DEFAULTS.infill, doc: "sparse infill inside the walls, as a share like 40% (100% is solid)" },
      { key: "pattern", kind: "choice", def: FDM_DEFAULTS.pattern, options: INFILL_PATTERNS, doc: "infill pattern: gyroid (about as strong every way), grid, cubic, honeycomb, lines or lightning (only holds up top faces)" },
      { key: "overhang", kind: "number", def: 45, doc: "steepest unsupported overhang, degrees from vertical", machine: true },
      { key: "supports", kind: "bool", def: true, doc: "support material allowed (false makes overhangs failures)" },
      { key: "bed", kind: "size", def: [250, 210, 210], doc: "build volume (x, y, z), mm", machine: true },
      { key: "hole_comp", kind: "number", def: 0, doc: "slicer X-Y hole compensation, mm: holes print this much larger in radius", machine: true },
      { key: "shrink_comp", kind: "bool", def: false, doc: "slicer scales the part up to cancel the plastic's shrink as it cools (filament shrinkage setting)", machine: true },
      { key: "soluble", kind: "bool", def: false, doc: "supports print in a soluble material (PVA, BVOH) from a second nozzle and dissolve out of places no tool reaches", machine: true },
      { key: "max_temp", kind: "number", def: 300, doc: "hottest the nozzle runs, °C", machine: true },
      { key: "enclosed", kind: "bool", def: true, doc: "an enclosure keeps ABS, ASA, nylon and PC warm enough not to warp", machine: true },
      { key: "bridge", kind: "number", def: 10, doc: "widest flat ceiling it bridges without support, mm", machine: true },
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
      { key: "bed", kind: "size", def: [145, 145, 185], doc: "build volume (x, y, z), mm", machine: true },
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
    settings: [{ key: "bed", kind: "size", def: [300, 300, 300], doc: "build volume (x, y, z), mm", machine: true }],
  },
  metal_print: {
    id: "metal_print",
    label: "Metal 3D printing (DMLS/SLM)",
    short: "Metal print",
    family: "additive",
    summary: "Metal powder melted layer by layer by a laser (laser powder-bed fusion). Complex metal shapes without tooling; supports are cut off and accurate faces machined afterwards.",
    tolerance: 0.2,
    output: "STL or STEP, plus a drawing of the faces to machine after printing",
    bestFor: "complex or lightweighted metal parts, internal channels, and one-offs to tens in aluminium (AlSi10Mg), stainless 316L or titanium",
    settings: [
      { key: "build", kind: "dir", def: Z, doc: "build direction in the part's frame (Z: built as modelled)" },
      { key: "bed", kind: "size", def: [250, 250, 300], doc: "build volume (x, y, z), mm", machine: true },
    ],
  },
  cnc_mill: {
    id: "cnc_mill",
    label: "CNC milling (3-axis)",
    short: "CNC mill",
    family: "subtractive",
    summary: "Cut from solid stock with rotating end mills, one setup per side.",
    tolerance: 0.1,
    iso2768: "m",
    output: "STEP plus a drawing for toleranced features and threads",
    bestFor: "precise metal and engineering-plastic parts in low to mid volumes",
    settings: [
      { key: "tool_d", kind: "number", def: 3, doc: "smallest end mill diameter, mm (sets the tightest inside corner and narrowest slot)", machine: true },
      { key: "setups", kind: "dirs", def: [Z, NZ], doc: "directions the tool comes from, one per setup (add X, -Y... for side work)" },
      { key: "max_depth", kind: "number", def: 4, doc: "how deep the end mills reach, as a multiple of their diameter (used when no tools list is given)", machine: true },
      { key: "envelope", kind: "size", def: [600, 400, 300], doc: "machine travel (x, y, z), mm", machine: true },
      { key: "axes", kind: "number", def: 3, doc: "3 (tool from above, the part flipped by hand for each side), 4 (a rotary axis about X turns the part) or 5 (the tool tilts to any side from above)", machine: true },
      { key: "tools", kind: "tools", def: null, doc: "end mills as (diameter, reach) pairs, mm, e.g. [(6, 25), (3, 12), (1, 4)]; reach is the flute or neck length (default: sizes from tool_d up, each reaching max_depth × its diameter)", machine: true },
      { key: "rpm", kind: "number", def: 12000, doc: "fastest spindle speed, rpm", machine: true },
      { key: "frame", kind: "choice", def: "vmc", options: ["router", "benchtop", "vmc"], doc: "router (wood, plastic, light aluminium), benchtop mill (aluminium and steel) or vmc (an industrial machining centre: anything)", machine: true },
      { key: "vise", kind: "number", def: 200, doc: "widest the vise opens, mm (0: stock is clamped or screwed to the table)", machine: true },
    ],
  },
  cnc_lathe: {
    id: "cnc_lathe",
    label: "CNC turning (lathe)",
    short: "CNC lathe",
    family: "subtractive",
    summary: "Spun in a chuck and cut with a fixed tool. Round parts: shafts, spacers, pins, knobs.",
    tolerance: 0.05,
    iso2768: "m",
    output: "STEP plus a drawing for diameters, fits and threads",
    bestFor: "shafts, bushings, spacers and anything round",
    settings: [
      { key: "axis", kind: "dir", def: Z, doc: "spindle axis in the part's frame" },
      { key: "max_d", kind: "number", def: 200, doc: "largest diameter the machine turns, mm", machine: true },
      { key: "max_length", kind: "number", def: 300, doc: "longest part, mm", machine: true },
      { key: "live_tools", kind: "bool", def: false, doc: "live tooling (mill-turn): flats and cross holes are milled on the lathe in the same setup", machine: true },
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
      { key: "cavities", kind: "number", def: 1, doc: "parts moulded per shot" },
      { key: "clamp", kind: "number", def: 150, doc: "the press's clamp force, tonnes", machine: true },
      { key: "shot", kind: "number", def: 300, doc: "the press's largest shot, cm³", machine: true },
    ],
  },
  vacuum_cast: {
    id: "vacuum_cast",
    label: "Vacuum casting (urethane)",
    short: "Vacuum cast",
    family: "formative",
    summary: "Polyurethane poured under vacuum into a silicone mould taken from a 3D-printed master. Production-like plastic parts without steel tooling; each mould makes about 20 to 25 parts.",
    tolerance: 0.25,
    output: "STEP for the master pattern, plus the polyurethane grade (ABS-, PP- or rubber-like), colour and finish",
    bestFor: "10 to 100 production-like plastic parts: pre-production runs and samples, one silicone mould per 20 to 25 parts",
    settings: [
      { key: "chamber", kind: "size", def: [900, 600, 400], doc: "largest mould the vacuum chamber takes (x, y, z), mm", machine: true },
      { key: "max_pour", kind: "number", def: 3, doc: "most resin mixed and poured at once, kg", machine: true },
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
      { key: "cavities", kind: "number", def: 1, doc: "parts cast per shot" },
      { key: "clamp", kind: "number", def: 400, doc: "the machine's locking force, tonnes", machine: true },
      { key: "shot", kind: "number", def: 1000, doc: "the machine's largest shot of metal, cm³", machine: true },
    ],
  },
  sand_cast: {
    id: "sand_cast",
    label: "Sand casting",
    short: "Sand cast",
    family: "formative",
    summary: "Molten metal poured into a sand mould packed around a pattern. Cheap tooling for rough metal parts of almost any size; the faces that matter are machined afterwards.",
    tolerance: 1,
    dctg: 10,
    output: "STEP of the casting with machining allowance, plus a drawing of the machined faces",
    bestFor: "one-off to hundreds of rough metal parts (housings, brackets, bases, pump bodies) in aluminium, cast iron or bronze, machined on their critical faces",
    settings: [
      { key: "pull", kind: "dir", def: Z, doc: "direction the pattern is drawn out of the sand (the parting line runs square to it)" },
      { key: "draft", kind: "number", def: 2, doc: "minimum draft on faces along the pull, degrees" },
      { key: "cores", kind: "bool", def: true, doc: "sand cores allowed for undercuts and internal passages (each adds cost; false makes undercuts failures)" },
      { key: "flask", kind: "size", def: [1000, 800, 600], doc: "largest moulding box (x, y, z), mm", machine: true },
      { key: "max_pour", kind: "number", def: 500, doc: "most metal poured at once, kg", machine: true },
    ],
  },
  investment_cast: {
    id: "investment_cast",
    label: "Investment casting (lost wax)",
    short: "Investment cast",
    family: "formative",
    summary: "A wax copy of the part is coated in ceramic, melted out and replaced by molten metal. Fine detail and smooth surfaces with little or no draft.",
    tolerance: 0.25,
    dctg: 6,
    output: "STEP of the casting, plus a drawing of the faces and holes to machine after casting",
    bestFor: "detailed steel, stainless and aluminium parts in hundreds to thousands, where machining from solid would waste material or time",
    settings: [
      { key: "pull", kind: "dir", def: Z, doc: "direction the die for the wax patterns opens" },
      { key: "cores", kind: "bool", def: true, doc: "soluble wax or ceramic cores allowed for undercuts and internal passages (each adds cost; false makes undercuts failures)" },
      { key: "max_size", kind: "size", def: [500, 400, 300], doc: "largest pattern the foundry handles (x, y, z), mm", machine: true },
      { key: "max_pour", kind: "number", def: 50, doc: "most metal poured into one shell, kg", machine: true },
    ],
  },
  carbon_layup: {
    id: "carbon_layup",
    label: "Carbon fibre layup (moulded composite)",
    short: "Carbon layup",
    family: "formative",
    summary: "Prepreg carbon plies laid up over an inflatable bladder or a removable core, closed in a heated steel mould and cured under pressure. Hollow, one-piece, very light and stiff.",
    tolerance: 0.3,
    output: "STEP of the outer surface with the parting line, a ply book (plies, directions and zones), and the metal parts bonded in",
    bestFor: "hollow, light, stiff parts in tens to thousands: bike frames, forks, bars, rims, drone arms",
    settings: [
      { key: "pull", kind: "dir", def: Z, doc: "direction the mould halves open (the parting line runs square to it; a bike frame splits on its centre plane, pull: Y)" },
      { key: "slides", kind: "dirs", def: [], doc: "extra mould pieces and the way each pulls out, for faces neither half reaches (the core between a frame's rear stays, between fork legs)" },
      { key: "cores", kind: "bool", def: false, doc: "split cores that come apart inside the part, for small pockets no mould half or slide reaches (each adds tool cost; false makes them failures)" },
      { key: "wall", kind: "number", def: 1.2, doc: "nominal laminate thickness, mm (about ten 0.12 mm plies); the factory builds it up at joints, the bottom bracket and the head tube" },
      { key: "mould", kind: "size", def: [1500, 1000, 400], doc: "largest mould the shop's press or oven takes (x, y, z), mm", machine: true },
    ],
  },
  sheet_metal: {
    id: "sheet_metal",
    label: "Sheet metal (cut and bent)",
    short: "Sheet metal",
    family: "sheet",
    summary: "Flat sheet laser cut or punched, then bent on a press brake.",
    tolerance: 0.2,
    iso2768: "m",
    output: "STEP plus a flat pattern DXF and bend table",
    bestFor: "brackets, enclosures, chassis and covers in metal",
    settings: [
      { key: "t", kind: "number", def: null, doc: "sheet thickness, mm (measured from the part if not given)" },
      { key: "bend_r", kind: "number", def: null, doc: "minimum inside bend radius, mm (default from the material)" },
      { key: "brake", kind: "number", def: 2500, doc: "longest bend the press brake makes, mm", machine: true },
      { key: "max_t", kind: "number", def: 6, doc: "thickest mild steel the press brake bends, mm (aluminium about 1.5× this, stainless about 0.65×)", machine: true },
    ],
  },
  laser_cut: {
    id: "laser_cut",
    label: "Laser or waterjet cutting (flat)",
    short: "Laser cut",
    family: "sheet",
    summary: "A 2D profile cut through flat plate. No bends, pockets or bevels.",
    tolerance: 0.15,
    iso2768: "m",
    output: "DXF of the outline at 1:1, plus the plate thickness",
    bestFor: "flat plates, gussets, spacers and panels in metal, acrylic or wood",
    settings: [
      { key: "t", kind: "number", def: null, doc: "plate thickness, mm (measured if not given)" },
      { key: "normal", kind: "dir", def: null, doc: "plate normal (found from the geometry if not given)" },
      { key: "kerf", kind: "number", def: 0.2, doc: "cut width, mm", machine: true },
      { key: "source", kind: "choice", def: "any", options: CUTTER_SOURCES, doc: "what cuts: any (the shop picks), co2 or diode laser (wood, acrylic), fiber laser or plasma (metal), or waterjet (anything)", machine: true },
      { key: "bed", kind: "size", def: [3000, 1500, 25], doc: "cutting area (x, y) and the thickest plate it cuts (z), mm", machine: true },
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
const dirs = (v: SettingValue | null | undefined, d: V3[]): V3[] => (Array.isArray(v) && Array.isArray(v[0]) ? uniqueDirs(v as V3[]).slice(0, MAX_DIRECTIONS) : d);
const size = (v: SettingValue | null | undefined, d: V3): V3 => (Array.isArray(v) && typeof v[0] === "number" ? (v as V3) : d);
const choice = (v: SettingValue | null | undefined, d: string) => (typeof v === "string" ? v : d);
const toolList = (v: SettingValue | null | undefined): Tool[] | null => (Array.isArray(v) && Array.isArray(v[0]) && v[0].length === 2 ? sortTools(v as Tool[]) : null);
const neg = (v: V3): V3 => [-v[0] + 0, -v[1] + 0, -v[2] + 0];
/** rounds away float noise such as 3 × 0.6 = 1.7999999999999998 */
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Each direction is a full set of reach rays over the part, so a list of them is kept short: the six axes and a few diagonals. */
export const MAX_DIRECTIONS = 12;

/** A machine's tool library is kept to a sensible rack. */
export const MAX_TOOLS = 24;

/** End mills smallest first, repeats dropped. */
export function sortTools(list: Tool[]): Tool[] {
  const out: Tool[] = [];
  for (const [d, r] of [...list].sort((a, b) => a[0] - b[0] || a[1] - b[1])) if (!out.some((o) => o[0] === d && o[1] === r)) out.push([d, r]);
  return out.slice(0, MAX_TOOLS);
}

/** Common end mill sizes, for a machine that gives only its smallest tool. */
const STANDARD_TOOLS = [1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20];

/** The library a mill is assumed to have without a tools list: standard sizes from the smallest up, each reaching depthRatio × its diameter. */
export function defaultTools(smallest: number, depthRatio: number): Tool[] {
  const sizes = [smallest, ...STANDARD_TOOLS.filter((d) => d > smallest)];
  return sizes.map((d) => [d, r6(d * depthRatio)]);
}

/** Tool directions a 4-axis mill reaches with the part on a rotary axis about X, and a 5-axis trunnion with the tool tilted from above. */
const S2 = Math.SQRT1_2;
const FOUR_AXIS: V3[] = [Z, NZ, [0, 1, 0], [0, -1, 0], [0, S2, S2], [0, -S2, S2], [0, S2, -S2], [0, -S2, -S2]];
const FIVE_AXIS: V3[] = [Z, [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [S2, 0, S2], [-S2, 0, S2], [0, S2, S2], [0, -S2, S2], NZ];

/** A mill's axes count as 3, 4 or 5. */
export const millAxes = (v: SettingValue | null | undefined) => (typeof v === "number" && v >= 5 ? 5 : typeof v === "number" && v >= 4 ? 4 : 3);

/** Directions the tool comes from: the setups the part names, plus every direction the machine's extra axes reach. */
export function millDirections(setups: V3[], axes: number): V3[] {
  if (axes >= 5) return uniqueDirs([...setups, ...FIVE_AXIS], 16).slice(0, 16);
  if (axes === 4) return uniqueDirs([...setups, ...FOUR_AXIS], 16).slice(0, 16);
  return setups;
}

/** Unit directions with repeats (within half a degree) removed; stops once it has more than `limit`. */
export function uniqueDirs(list: V3[], limit = MAX_DIRECTIONS): V3[] {
  const out: V3[] = [];
  for (const d of list) {
    const n = norm(d);
    if (!out.some((o) => o[0] * n[0] + o[1] * n[1] + o[2] * n[2] > 0.99996)) out.push(n);
    if (out.length > limit) break;
  }
  return out;
}

const isVec3 = (v: unknown): v is V3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));

/**
 * Settings from outside the language (a stored brief, chat, an old file):
 * known keys with the right kind of value, directions made unit and capped.
 * Anything else is dropped.
 */
export function sanitizeSettings(id: ProcessId, raw: unknown): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const sd of PROCESSES[id].settings) {
    const v = (raw as Record<string, unknown>)[sd.key];
    if (v === undefined || v === null) continue;
    if (sd.kind === "number" && typeof v === "number" && Number.isFinite(v) && v >= 0) out[sd.key] = v;
    else if (sd.kind === "bool" && typeof v === "boolean") out[sd.key] = v;
    else if (sd.kind === "dir" && isVec3(v) && Math.hypot(...v) > 1e-9) out[sd.key] = norm(v);
    else if (sd.kind === "dirs" && Array.isArray(v)) {
      const list = uniqueDirs(v.filter((d): d is V3 => isVec3(d) && Math.hypot(...d) > 1e-9)).slice(0, MAX_DIRECTIONS);
      if (list.length) out[sd.key] = list;
    } else if (sd.kind === "size" && isVec3(v) && v.every((x) => x > 0)) out[sd.key] = v;
    else if (sd.kind === "choice" && typeof v === "string" && sd.options?.includes(v)) out[sd.key] = v;
    else if (sd.kind === "tools" && Array.isArray(v)) {
      const list = v.filter((t): t is Tool => Array.isArray(t) && t.length === 2 && t.every((x) => typeof x === "number" && Number.isFinite(x) && x > 0));
      if (list.length) out[sd.key] = sortTools(list);
    }
  }
  return out;
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
      const max = num(s.overhang, 45);
      const span = num(s.bridge, 10);
      const soluble = s.soluble === true;
      const need = fdmNeeds(material);
      return {
        ...base,
        wall: { fail: r6(2 * nozzle), warn: r6(3 * nozzle), why: `two lines of a ${nozzle} mm nozzle is the thinnest wall that prints; three is reliable` },
        overhang: { build, max, severity: s.supports === false ? "fail" : "warn", bridgeR: 4, span },
        bedContact: { build },
        holes: { minD: Math.max(1.5, r6(3 * nozzle)), why: "small printed holes close up and need drilling out" },
        envelope: { size: size(s.bed, [250, 210, 210]), frame: build, what: "printer's build volume" },
        ...(s.supports === false
          ? {}
          : { supportAccess: { build, max, bridgeR: 4, span, soluble, opening: 5, how: soluble ? "dissolved out in water or a solvent" : "broken out with pliers or a hook" } }),
        fuse: { min: Math.max(0.3, r6(0.75 * nozzle)), why: "the printer cannot keep a gap narrower than about one extrusion line open, so the plastic bridges it" },
        printer: { maxTemp: num(s.max_temp, 300), enclosed: s.enclosed !== false, needTemp: need?.temp, warps: need?.warps ?? false },
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
        // resin prints are supported wherever a surface faces the vat at more than about 60° from vertical
        supportAccess: { build, max: 60, bridgeR: 1.5, span: 2, soluble: false, opening: 3, how: "snipped off with flush cutters" },
        fuse: { min: 0.4, why: "light scattering in the resin cures across narrower gaps" },
      };
    }
    case "sls":
      return {
        ...base,
        wall: { fail: 0.7, warn: 1.0, why: "thinner nylon walls do not sinter through and break" },
        holes: { minD: 1.5, maxDepthRatio: 20, why: "powder sinters shut in smaller holes and packs into long narrow ones" },
        envelope: { size: size(s.bed, [300, 300, 300]), frame: null, what: "printer's build volume" },
        voids: { severity: "fail", why: "unfused powder is trapped inside; add two escape holes of at least 5 mm" },
        fuse: { min: 0.5, why: "the heat sinters the powder in narrower gaps, fusing the faces together" },
      };
    case "metal_print": {
      const build = dir(s.build, Z);
      return {
        ...base,
        wall: { fail: 0.4, warn: 0.8, why: "thinner metal walls warp from the laser's heat or break when the supports are cut away" },
        // flat metal ceilings sag after a couple of millimetres; small round holes arch over on their own
        overhang: { build, max: 45, severity: "warn", bridgeR: 4, span: 2 },
        holes: { minD: 1, why: "smaller holes fill with half-melted powder and have to be drilled out" },
        envelope: { size: size(s.bed, [250, 250, 300]), frame: build, what: "printer's build volume" },
        voids: { severity: "fail", why: "unfused metal powder is trapped inside; add at least two escape holes of 2 mm or more so it can be shaken out" },
        supportAccess: { build, max: 45, bridgeR: 4, span: 2, soluble: false, opening: 8, how: "cut off with a saw or wire EDM, or machined away" },
        fuse: { min: 0.4, why: "the melt pool and half-melted powder bridge narrower gaps" },
      };
    }
    case "cnc_mill": {
      const lib = toolList(s.tools);
      const tool = lib ? lib[0][0] : num(s.tool_d, 3);
      const axes = millAxes(s.axes);
      const setups = dirs(s.setups, [Z, NZ]);
      const reach = millDirections(setups, axes);
      const frame = choice(s.frame, "vmc");
      return {
        ...base,
        wall: metal ? { fail: 0.5, warn: 0.8, why: "thin metal walls vibrate and bend while cutting" } : { fail: 1.0, warn: 1.5, why: "thin plastic walls flex and melt while cutting" },
        reach: { dirs: reach, severity: "fail", what: "setup" },
        innerRadius: { min: tool / 2, dirs: reach, severity: "fail", why: `a Ø${fmt(tool)} mm end mill leaves at least R${fmt(tool / 2)} in every inside corner along its axis` },
        gap: { min: tool, dirs: reach },
        holes: { minD: 1, minDFail: 0.5, maxDepthRatio: 10, why: "drills under 1 mm break easily; holes deeper than 10× their diameter need gun drilling" },
        envelope: { size: size(s.envelope, [600, 400, 300]), frame: null, what: "machine's travel" },
        machining: {
          tools: lib ?? defaultTools(tool, num(s.max_depth, 4)),
          library: !!lib,
          axes,
          rpm: num(s.rpm, 12000),
          vise: num(s.vise, 200),
          cutSpeed: millClass(material).speed,
          frame: { name: frame, ...frameFit(frame, material) },
        },
      };
    }
    case "cnc_lathe": {
      return {
        ...base,
        wall: metal ? { fail: 0.5, warn: 0.8, why: "thin-walled turned parts chatter and distort in the chuck" } : { fail: 1.0, warn: 1.5, why: "thin plastic walls distort in the chuck" },
        revolve: { axis: dir(s.axis, Z), maxSlender: 8, maxBoreRatio: 5, maxD: num(s.max_d, 200), maxLength: num(s.max_length, 300), liveTools: s.live_tools === true },
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
        press: { pull, clamp: num(s.clamp, 150), shot: num(s.shot, 300), cavities: cavities(s.cavities), pressure: mouldPressure(material), flowRatio: flowRatio(material), what: "moulding press" },
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
        // zinc runs hot-chamber at lower pressure than aluminium's cold chamber
        press: { pull, clamp: num(s.clamp, 400), shot: num(s.shot, 1000), cavities: cavities(s.cavities), pressure: /zinc|zamak/i.test(material) ? 30 : 70, what: "die-casting machine" },
      };
    }
    case "vacuum_cast":
      // the silicone mould flexes and is cut open along a wavy parting line: no draft and no undercut rules
      return {
        ...base,
        wall: { fail: 0.8, warn: 1.5, max: 8, why: "cast polyurethane fills a silicone mould well between 1.5 and 8 mm; thinner walls fill short or tear coming out, thicker ones shrink and sink" },
        holes: { minD: 1, why: "the silicone pins that form smaller holes tear off when the part is pulled out; drill them afterwards" },
        envelope: { size: size(s.chamber, [900, 600, 400]), frame: null, what: "vacuum caster's chamber" },
        voids: { severity: "fail", why: "a sealed cavity cannot be moulded, since the silicone that forms it could not be pulled out; open it to the outside" },
        pour: { maxKg: num(s.max_pour, 3), density: density(material, 1.1), yield: 0.85, what: "vacuum caster's largest pour" },
      };
    case "sand_cast": {
      const pull = dir(s.pull, Z);
      const draft = num(s.draft, 2);
      const [fail, warn] = info.castWall ?? [3, 4];
      return {
        ...base,
        wall: { fail, warn, thickRatio: 2, why: `molten ${metal ? material : "metal"} freezes in the sand before it fills thinner sections` },
        // a patternmaker adds draft to straight faces (which moves them), so only back draft fails
        draft: { pull, warn: draft, fail: 0 },
        reach: { dirs: [pull, neg(pull)], severity: s.cores === false ? "fail" : "info", what: "mould", relief: "sand cores" },
        innerRadius: { min: 3, factor: 0.5, dirs: null, severity: "warn", why: "sharp inside corners crack as the casting shrinks, and the sand there crumbles" },
        holes: { minD: 10, why: "holes under Ø10 mm are not cored but drilled after casting" },
        envelope: { size: size(s.flask, [1000, 800, 600]), frame: null, what: "foundry's moulding box" },
        voids: { severity: "fail", why: "a sealed cavity needs a sand core that can be neither held in place nor shaken out; open it to the outside, ideally in two places" },
        pour: { maxKg: num(s.max_pour, 500), density: density(material, 2.7), yield: 0.6, what: "foundry's largest pour" },
      };
    }
    case "investment_cast": {
      const pull = dir(s.pull, Z);
      // the wax pattern slides out of its die with little or no draft, so draft is not checked
      return {
        ...base,
        wall: { fail: 1, warn: 1.5, thickRatio: 2, why: "thinner sections freeze before the metal fills them, even in a hot ceramic shell" },
        reach: { dirs: [pull, neg(pull)], severity: s.cores === false ? "fail" : "info", what: "mould", relief: "soluble wax or ceramic cores" },
        innerRadius: { min: 0.5, dirs: null, severity: "warn", why: "sharp inside corners crack the ceramic shell and the casting as it shrinks" },
        holes: { minD: 2.5, maxDepthRatio: 4, why: "the ceramic shell cannot form holes under Ø2.5 mm or deeper than 4× their diameter, so they are drilled afterwards" },
        envelope: { size: size(s.max_size, [500, 400, 300]), frame: null, what: "foundry's largest pattern" },
        voids: { severity: "fail", why: "a sealed cavity can be neither formed in the wax pattern nor cleaned of ceramic; open it to the outside" },
        pour: { maxKg: num(s.max_pour, 50), density: density(material, 7.9), yield: 0.6, what: "foundry's largest pour" },
      };
    }
    case "carbon_layup": {
      const pull = dir(s.pull, Z);
      return {
        ...base,
        // the part is the laminate's outer surface: walls are the plies, not the solid
        reach: { dirs: [pull, neg(pull), ...dirs(s.slides, [])], severity: s.cores === true ? "info" : "fail", what: "mould", relief: s.cores === true ? "split cores" : "mould slides or split cores" },
        layup: { wall: num(s.wall, 1.2), density: materialRecord(material)?.density ?? 1.55 },
        holes: { minD: 3, why: "holes in carbon are drilled after curing, and bolted ones need a bonded metal insert" },
        envelope: { size: size(s.mould, [1500, 1000, 400]), frame: null, what: "largest mould the shop presses" },
      };
    }
    case "sheet_metal": {
      const t = typeof s.t === "number" ? s.t : null;
      const factor = info.bendFactor ?? 1;
      return {
        ...base,
        sheet: { t, bendR: typeof s.bend_r === "number" ? s.bend_r : null, bendFactor: factor, holeEdge: 2, brake: num(s.brake, 2500), maxT: r6(num(s.max_t, 6) * brakeFactor(material)) },
        holes: { minD: t ?? 1, minDFail: t ?? 1, why: "punched or cut holes must be at least as wide as the sheet is thick" },
      };
    }
    case "laser_cut": {
      const t = typeof s.t === "number" ? s.t : null;
      const source = choice(s.source, "any");
      const bed = size(s.bed, [3000, 1500, 25]);
      // a laser's clean-cut limit depends on the material; waterjet and plasma are limited by the machine
      const laser = source === "any" || source === "co2" || source === "diode" || source === "fiber";
      const maxT = laser ? Math.min(info.laserMaxT ?? 10, bed[2]) : bed[2];
      return {
        ...base,
        profile: { normal: Array.isArray(s.normal) ? dir(s.normal, Z) : null, t, maxT, minWeb: Math.max(0.5, metal ? (t ?? 1) : 1) },
        holes: { minD: metal ? (t ?? 1) : 0.5, why: metal ? "holes narrower than the plate thickness taper and burn" : "very small holes burn through" },
        cutter: { bed: [bed[0], bed[1]], maxT: bed[2], source, ...cutterFit(source, material) },
      };
    }
  }
}

const cavities = (v: SettingValue | null | undefined) => Math.max(1, Math.round(num(v, 1)));

/** g/cm³ from the material database, or a stand-in for the family. */
const density = (material: string, d: number) => materialRecord(material)?.density ?? d;

/** A press brake rated for mild steel bends softer aluminium thicker and stainless thinner. */
function brakeFactor(material: string): number {
  if (/alumin|alsi|a356|a380/i.test(material)) return 1.5;
  if (/stainless|titanium/i.test(material)) return 0.65;
  return 1;
}

/**
 * The general tolerance a drawing's title block states for this process:
 * an ISO 2768 class for machined, cut and bent parts, an ISO 8062-3 casting
 * tolerance grade for sand and investment castings, otherwise the process's
 * typical tolerance. For the engineering drawings.
 */
export function generalToleranceFor(spec: ProcessSpec): string {
  const def = PROCESSES[spec.id];
  if (def.iso2768) return `ISO 2768-${def.iso2768}`;
  if (def.dctg) return `ISO 8062-3 DCTG ${def.dctg}`;
  return `±${fmt(def.tolerance)} UNLESS STATED`;
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
  if (kind === "choice") return JSON.stringify(v);
  if (kind === "tools") return "[" + (v as Tool[]).map(([d, r]) => `(${fmt(d, 3)}, ${fmt(r, 3)})`).join(", ") + "]";
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
  if (spec.machine) args.push(`machine: ${JSON.stringify(spec.machine)}`);
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

/** "Ø6 × 24 mm", the way a tool is named in advice. */
export const toolName = ([d, r]: Tool) => `Ø${fmt(d)} × ${fmt(r, 1)} mm`;

/** The mill, its tools, and what they mean for corners and pockets. */
function machiningLines(r: Rules): string[] {
  const m = r.machining!;
  const kind = m.axes === 5 ? "5-axis" : m.axes === 4 ? "4-axis (rotary about X)" : "3-axis";
  const list = m.tools.map(toolName).join(", ");
  return [
    `Mill: ${kind} ${m.frame.name === "vmc" ? "machining centre" : m.frame.name === "benchtop" ? "benchtop mill" : "router"}, spindle up to ${fmt(m.rpm, 0)} rpm${m.vise > 0 ? `, stock held in a vise opening ${fmt(m.vise, 0)} mm` : ", stock clamped to the table"}.${m.frame.status === "pass" ? "" : ` For ${r.material}: ${m.frame.why}.`}`,
    `End mills (diameter × reach): ${list}${m.library ? "" : " (standard sizes; give the machine's own list with tools: for exact checks)"}. Every inside corner, slot and pocket wall needs a tool that both fits and reaches: a corner of radius r at depth h needs a tool no wider than 2r that reaches h. Make deep corners larger than shallow ones, and pockets no deeper than the reach of a tool that fits them.`,
    `Small tools need high spindle speeds: in ${r.material} a Ø${fmt(slowestTool(m.cutSpeed, m.rpm), 1)} mm tool is about the smallest this spindle drives properly, so keep corners at R${fmt(slowestTool(m.cutSpeed, m.rpm) / 2, 1)} or more where you can.`,
  ];
}

/** A tool may run this many times slower than its ideal speed before it cuts too slowly and breaks. */
export const SPINDLE_SLACK = 5;

/** The smallest tool a spindle still drives properly in a material with this cutting speed (m/min), mm. */
export const slowestTool = (cutSpeed: number, rpm: number) => (cutSpeed * 1000) / (Math.PI * SPINDLE_SLACK * Math.max(1, rpm));

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
      `Draft every face that runs along the pull direction ${axisName(r.draft.pull)} by at least ${fmt(r.draft.warn)}° (${r.draft.fail > 0 ? `under ${fmt(r.draft.fail)}° fails` : "faces that lean back against the pull fail"}). Bosses, ribs and hole walls need it too.`,
    );
  if (r.reach?.what === "mould" && r.reach.relief) {
    const along = `${axisName(r.reach.dirs[0])} or ${axisName(r.reach.dirs[1])}`;
    out.push(
      r.reach.severity === "info"
        ? `Faces should release straight along ${along}. Undercuts, side holes and internal passages are made with ${r.reach.relief}, which are allowed here but each adds cost.`
        : `No undercuts: every face must release straight along ${along}. Undercuts, side holes and internal passages need ${r.reach.relief}, which are not allowed here; open them to a pull direction.`,
    );
  } else if (r.reach?.what === "mould")
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
  if (r.machining) out.push(...machiningLines(r));
  if (r.overhang)
    out.push(
      `Overhangs steeper than ${r.overhang.max}° from vertical need support${r.overhang.severity === "fail" ? " (not allowed here)" : ""}. Orient the part with a large flat face on the bed (build direction ${axisName(r.overhang.build)}), chamfer the underside of ledges at 45°, and keep horizontal holes under Ø${fmt(2 * r.overhang.bridgeR)} or use teardrops.${r.overhang.span !== undefined ? ` Flat ceilings wider than ${fmt(r.overhang.span)} mm need support too.` : ""}`,
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
  if (r.supportAccess) {
    const a = r.supportAccess;
    out.push(
      a.soluble
        ? `Supports dissolve, so they may sit inside, but every supported cavity needs an opening for the solvent; a sealed one keeps its support for good.`
        : `Every support must come out: supports are ${a.how}, so none may sit in a closed cavity, behind an opening narrower than ${fmt(a.opening)} mm, or deep in a narrow channel (more than about 4× its width in). Inside, use self-supporting shapes (45° roofs, teardrop or diamond holes, chamfered ledges) or open the cavity toward the bed.`,
    );
  }
  if (r.fuse) out.push(`Keep gaps between faces (print-in-place clearances, slots between features) at least ${fmt(r.fuse.min)} mm: ${r.fuse.why}.`);
  if (r.printer) {
    const p = r.printer;
    out.push(
      `Printer: nozzle up to ${fmt(p.maxTemp, 0)} °C, ${p.enclosed ? "enclosed" : "open frame (no enclosure)"}${p.needTemp ? `; ${r.material} prints at about ${fmt(p.needTemp, 0)} °C${p.warps ? " and warps without an enclosure" : ""}` : ""}.`,
    );
  }
  if (r.press) {
    const p = r.press;
    out.push(
      `The ${p.what} has ${fmt(p.clamp, 0)} t of clamp and a ${fmt(p.shot, 0)} cm³ shot: the part's shadow along the pull × ${fmt(p.pressure, 0)} MPa${p.cavities > 1 ? ` × ${p.cavities} cavities` : ""} must stay under the clamp, and its volume with runners under 80 % of the shot.${p.flowRatio ? ` Keep the flow from a centre gate to the farthest corner under ${p.flowRatio}× the wall.` : ""}`,
    );
  }
  if (r.pour) out.push(`Pours up to ${fmt(r.pour.maxKg)} kg (the ${r.pour.what}): the casting plus gates and risers, about ${fmt(1 / r.pour.yield, 1)}× its own weight.`);
  if (r.sheet?.brake) out.push(`The press brake bends up to ${fmt(r.sheet.brake, 0)} mm long and ${fmt(r.sheet.maxT ?? 6)} mm thick in ${r.material}.`);
  if (r.cutter)
    out.push(
      `Cutter: ${r.cutter.source === "any" ? "the shop's choice" : r.cutter.source}, ${fmt(r.cutter.bed[0], 0)} × ${fmt(r.cutter.bed[1], 0)} mm bed${r.cutter.status === "pass" ? "" : `; ${r.cutter.why}`}.`,
    );
  if (r.revolve?.liveTools) out.push("Live tooling: flats, cross holes and off-axis features are milled on the lathe in the same setup.");
  const mats = suggestMaterials(r.process);
  if (mats.length) out.push(`Usual materials: ${mats.join(", ")}.`);
  return out;
}
