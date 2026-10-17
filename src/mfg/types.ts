// Shared types for manufacturing processes: what a part says about how it is
// made, the numeric rules that follow from that, and what the geometry
// analysis found. Plain data so it crosses the kernel worker boundary.

import type { V3 } from "../kernel/recipe";

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
  | "sheet_metal"
  | "laser_cut";

export type SettingValue = number | boolean | V3 | V3[];

/** How one part is made: a process and the settings the design gave it (defaults are not stored). */
export interface ProcessSpec {
  id: ProcessId;
  settings: Record<string, SettingValue>;
  /** material named in the process call, used when the part names none */
  material?: string;
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
  /** pockets deeper than max × their width */
  depthRatio?: { max: number; dirs: V3[] };
  holes?: { minD: number; minDFail?: number; maxDepthRatio?: number; why: string };
  /** machine envelope: along the build direction when frame is set, otherwise any orientation */
  envelope?: { size: V3; frame: V3 | null; what: string };
  /** turned parts: every surface revolves about this axis */
  revolve?: { axis: V3; maxSlender: number; maxBoreRatio: number; maxD: number; maxLength: number };
  /** sheet metal: constant thickness t (null: measure), minimum inside bend radius */
  sheet?: { t: number | null; bendR: number | null; bendFactor: number; holeEdge: number };
  /** profile cutting: a flat plate cut through along normal (null: find it) */
  profile?: { normal: V3 | null; t: number | null; maxT: number; minWeb: number };
  /** closed internal voids trap resin or powder */
  voids?: { severity: Severity; why: string };
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
