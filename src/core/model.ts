// The evaluated design model: what the viewer, checks, AI and UI consume.

import type { Span } from "../lang/ast";
import type { Diagnostic } from "../lang/parser";
import type { PartRecipe, V3, Xform } from "../kernel/recipe";
import type { GeoQuery } from "../lang/values";

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

export interface DecisionSet {
  param: string;
  value: number | string | boolean;
  /** source span of `param: value` inside the option */
  span: Span;
  valueSpan: Span;
}

export interface DecisionOption {
  label: string;
  /** what happens if chosen */
  note?: string;
  /** parameter values this option means; empty for a structural choice */
  sets: DecisionSet[];
  span: Span;
}

/** A recorded design decision: the question, the alternatives and what was chosen, by whom and why. */
export interface EvalDecision {
  name: string;
  title: string;
  ask?: string;
  chose?: string;
  /** "you" for the user, "claude" for the assistant */
  by?: string;
  why?: string;
  options: DecisionOption[];
  span: Span;
  /** offset just after the opening brace, where new fields go */
  bodyStart: number;
  /** spans of the fields (ask, chose, by, why) and their values, for targeted edits */
  props: Record<string, { span: Span; valueSpan: Span }>;
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
  decisions: EvalDecision[];
  diagnostics: Diagnostic[];
  /** dependency graph: edges from a definition to what reads it */
  graph: { nodes: DepNode[]; edges: { from: string; to: string }[] };
  /** names of top-level blocks with their source spans (for editing and locks) */
  blocks: { name: string; kind: string; span: Span; locked: boolean }[];
  /** geometric queries requested by requirements */
  geoQueries: GeoQuery[];
  evalMs: number;
}
