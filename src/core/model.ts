// The evaluated design model: what the viewer, checks, AI and UI consume.

import type { Span } from "../lang/ast";
import type { Diagnostic } from "../lang/parser";
import type { PartRecipe, V3, Xform } from "../kernel/recipe";
import type { GeoQuery } from "../lang/values";
import type { ProcessSpec } from "../mfg/types";

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
  /** how the part is made (custom parts only; library components are bought) */
  process?: ProcessSpec;
  /** span of the part's process: property, for edits */
  processSpan?: Span;
  /** the process came from a design-wide default (applyDefaultProcess), not from the part */
  processInherited?: boolean;
  /** process settings filled in from design-wide defaults; left out when the process is written back */
  processDefaults?: string[];
  /** span of the part's material: property, when it names one */
  materialSpan?: Span;
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
  kind: "param" | "let" | "interface" | "component" | "part" | "require";
  label: string;
}

export interface Model {
  name: string;
  notes: string[];
  params: EvalParam[];
  parts: EvalPart[];
  requirements: EvalRequirement[];
  diagnostics: Diagnostic[];
  /** dependency graph: edges from a definition to what reads it */
  graph: { nodes: DepNode[]; edges: { from: string; to: string }[] };
  /** names of top-level blocks with their source spans (for editing and locks) */
  blocks: { name: string; kind: string; span: Span; locked: boolean }[];
  /** geometric queries requested by requirements */
  geoQueries: GeoQuery[];
  evalMs: number;
}
