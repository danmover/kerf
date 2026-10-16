// The evaluated design model: what the viewer, checks, AI and UI consume.

import type { Span } from "../lang/ast";
import type { Diagnostic } from "../lang/parser";
import type { PartRecipe, V3, Xform } from "../kernel/recipe";
import type { GeoQuery } from "../lang/values";
import type { AnalysisSpec } from "../analysis/spec";

export interface Motion {
  origin: V3;
  axis: V3;
  /** rotation = ratio × driver angle */
  ratio: number;
}

export interface GearInfo {
  m: number;
  z: number;
  width: number;
  pa: number;
  backlash: number;
  center: V3; // global position of the face centre (`at`)
  axis: V3;
  phase: number; // degrees, in frameFor(axis)
  meshWith?: string; // component name of the gear it meshes with
  bore?: number; // shaft hole diameter (0 or missing: none)
}

export interface BearingInfo {
  code: string;
  bore: number;
  od: number;
  width: number;
  /** basic dynamic load rating C, N */
  dynamicLoadN: number;
  /** global centre and axis */
  center: V3;
  axis: V3;
}

export interface FastenerInfo {
  headTop: V3;
  outward: V3;
  key: number;
  headD: number;
  size: string;
}

export interface EvalPart {
  id: string;
  name: string; // block name in source (component or part)
  label: string;
  kind: "part" | "component";
  libKind?: string;
  group: string;
  color: string;
  material: string;
  recipe: PartRecipe;
  hash: string;
  xf: Xform[];
  locked: boolean;
  hidden: boolean;
  /** removable covers (lids) are ignored by the tool-access check */
  removable: boolean;
  span: Span;
  deps: string[];
  motion?: Motion;
  gear?: GearInfo;
  bearing?: BearingInfo;
  fastener?: FastenerInfo;
  bom?: { description: string; standard?: string };
}

export interface EvalParam {
  name: string;
  value: number | string | boolean;
  text: string;
  min?: number;
  max?: number;
  desc?: string;
  locked: boolean;
  span: Span;
  valueSpan: Span;
  usedBy: string[];
}

export type ReqStatus = "pass" | "fail" | "pending" | "error";

export interface EvalRequirement {
  label: string;
  level: "hard" | "soft";
  status: ReqStatus;
  margin?: number;
  detail: string;
  span: Span;
  deps: string[];
  geo: GeoQuery[];
}

export interface DepNode {
  id: string;
  kind: "param" | "let" | "interface" | "component" | "part" | "require" | "analysis";
  label: string;
}

export interface Model {
  name: string;
  notes: string[];
  params: EvalParam[];
  parts: EvalPart[];
  requirements: EvalRequirement[];
  /** stress and drivetrain analyses declared with analysis blocks */
  analyses: AnalysisSpec[];
  diagnostics: Diagnostic[];
  /** dependency graph: edges from a definition to what reads it */
  graph: { nodes: DepNode[]; edges: { from: string; to: string }[] };
  /** names of top-level blocks with their source spans (for editing and locks) */
  blocks: { name: string; kind: string; span: Span; locked: boolean }[];
  /** geometric queries requested by requirements */
  geoQueries: GeoQuery[];
  evalMs: number;
}
