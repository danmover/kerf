// Shared types for manufacturing processes: what a part says about how it is
// made, the numeric rules that follow from that, and what the geometry
// analysis found. Plain data so it crosses the kernel worker boundary.

import type { V3 } from "../kernel/recipe";
import type { PliesSpec } from "../analysis/spec";
import type { PlyBook } from "./plies";

export type ProcessId =
  | "fdm"
  | "sla"
  | "sls"
  | "metal_print"
  | "cnc_mill"
  | "cnc_lathe"
  | "injection"
  | "vacuum_cast"
  | "die_cast"
  | "sand_cast"
  | "investment_cast"
  | "carbon_layup"
  | "sheet_metal"
  | "laser_cut";

/** A cutting tool in a mill's library: diameter and how deep it reaches (flute or neck length), mm. */
export type Tool = [d: number, reach: number];

export type SettingValue = number | boolean | string | V3 | V3[] | Tool[] | PliesSpec[];

/** How one part is made: a process and the settings the design gave it (defaults are not stored). */
export interface ProcessSpec {
  id: ProcessId;
  settings: Record<string, SettingValue>;
  /** material named in the process call, used when the part names none */
  material?: string;
  /** a machine or shop profile by name (Settings → Making), whose settings fill in the ones the part leaves out */
  machine?: string;
}

export type Severity = "fail" | "warn";

/**
 * The numbers a part is checked against, resolved from the process, its
 * settings and the part's material. Absent sections are not checked.
 */
export interface Rules {
  process: ProcessId;
  label: string;
  material: string;
  /** the machine or shop profile the numbers came from, when one applies */
  machine?: string;
  /** wall thickness: below fail is a failure, below warn a warning; above max (if set) a warning */
  wall?: { fail: number; warn: number; max?: number; thickRatio?: number; why: string };
  /** faces nearly parallel to the pull direction need this much draft (degrees) */
  draft?: { pull: V3; warn: number; fail: number };
  /**
   * every face must be reachable along one of these directions (mould halves, machining setups).
   * relief: what frees an undercut when they are allowed (severity "info"), e.g. "side actions" or "sand cores"
   */
  reach?: { dirs: V3[]; severity: Severity | "info"; what: "mould" | "setup"; relief?: string };
  /**
   * down-facing surfaces steeper than max (degrees from vertical) need support.
   * bridgeR: horizontal holes up to this radius arch over without support;
   * span: flat ceilings up to this wide bridge without support (default 10 mm)
   */
  overhang?: { build: V3; max: number; severity: Severity; bridgeR: number; span?: number };
  /** the part should sit on a flat face */
  bedContact?: { build: V3 };
  /**
   * concave corners: radius below min fails (dirs: only corners along these
   * directions, e.g. end-mill axes; null: every inside corner). min may scale
   * with the measured nominal wall (factor) with a floor.
   */
  innerRadius?: { min: number; factor?: number; dirs: V3[] | null; severity: Severity; why: string };
  /** slots and pockets narrower than min across (seen along dirs) cannot be cut */
  gap?: { min: number; dirs: V3[] };
  holes?: { minD: number; minDFail?: number; maxDepthRatio?: number; why: string };
  /** machine envelope: along the build direction when frame is set, otherwise any orientation */
  envelope?: { size: V3; frame: V3 | null; what: string };
  /** turned parts: every surface revolves about this axis */
  revolve?: { axis: V3; maxSlender: number; maxBoreRatio: number; maxD: number; maxLength: number; liveTools?: boolean };
  /** moulded composites: the laminate laid over the part's outer surface, mm, and its cured density, g/cm³ (and its plies, when the process gives them) */
  layup?: { wall: number; density: number; plies?: PlyBook };
  /** sheet metal: constant thickness t (null: measure), minimum inside bend radius */
  sheet?: { t: number | null; bendR: number | null; bendFactor: number; holeEdge: number; brake?: number; maxT?: number };
  /** profile cutting: a flat plate cut through along normal (null: find it) */
  profile?: { normal: V3 | null; t: number | null; maxT: number; minWeb: number };
  /** closed internal voids trap resin or powder */
  voids?: { severity: Severity; why: string };
  /**
   * supports: where they stand, and whether they can be taken out. opening: the
   * smallest gap the removal tool needs (pliers, cutters, a saw), mm; soluble
   * supports only need a way in for the solvent. how: what removes them.
   */
  supportAccess?: { build: V3; max: number; bridgeR: number; span: number; soluble: boolean; opening: number; how: string };
  /** facing surfaces closer than min fuse together as the part is made (print-in-place clearances) */
  fuse?: { min: number; why: string };
  /** the printer against the material: nozzle temperature and whether it warps without an enclosure */
  printer?: { maxTemp: number; enclosed: boolean; needTemp?: number; warps: boolean };
  /**
   * a milling machine: its tool library (smallest first), axes, spindle and frame,
   * and the vise it holds stock in (0: clamped to the table). cutSpeed is the
   * cutting speed for this material, m/min; frame says whether the frame cuts it.
   */
  machining?: {
    tools: Tool[];
    /** tools came from the machine's own list rather than the default sizes */
    library: boolean;
    axes: number;
    rpm: number;
    vise: number;
    cutSpeed: number;
    frame: { name: string; status: "pass" | Severity; why: string };
  };
  /** moulding and die casting: the press's clamp force (t) and shot (cm³) against the part's shadow and volume */
  press?: { pull: V3; clamp: number; shot: number; cavities: number; pressure: number; flowRatio?: number; what: string };
  /** casting: the most metal or resin poured at once, kg, with the casting's share of the pour (yield) */
  pour?: { maxKg: number; density: number; yield: number; what: string };
  /** laser, waterjet or plasma: the cutting area (x, y), thickest plate, and whether the source cuts this material */
  cutter?: { bed: [number, number]; maxT: number; source: string; status: "pass" | Severity; why: string };
}

export type FindingStatus = "pass" | "warn" | "fail" | "info";

/** A computed alternative that a single setting change gives, e.g. printing upside down. */
export interface Alternative {
  setting: string;
  value: SettingValue;
  label: string;
  detail: string;
}

export interface ProcessFinding {
  rule: string;
  status: FindingStatus;
  title: string;
  detail: string;
  /** what to change, in plain words with numbers */
  fix?: string;
  value?: number;
  limit?: number;
  /** flagged triangles, 9 floats each, in the part's own frame */
  marks?: Float32Array;
  /** flagged edges, 6 floats per segment, in the part's own frame */
  lines?: Float32Array;
  alt?: Alternative;
}

export interface ProcessStats {
  triangles: number;
  samples: number;
  minWall?: number;
  nominalWall?: number;
  maxWall?: number;
  sheetT?: number;
  /** round holes, for cost estimates */
  holes?: number;
  /** sheet metal bends, for cost estimates */
  bends?: number;
  /** machining setups the part needs (CNC), for cost estimates */
  setups?: number;
}

export interface ProcessResult {
  key: string;
  findings: ProcessFinding[];
  stats: ProcessStats;
  ms: number;
  error?: string;
}

/** One analysis request: a built solid and the rules to hold it to. */
export interface ProcessProbe {
  id: string;
  hash: string;
  rules: Rules;
}
