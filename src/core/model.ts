// The evaluated design model: what the viewer, checks, AI and UI consume.

import type { Span } from "../lang/ast";
import type { Diagnostic } from "../lang/parser";
import type { PartRecipe, V3, Xform } from "../kernel/recipe";
import type { GeoQuery } from "../lang/values";
import type { EvalSketch } from "../sketch/types";
import type { AnalysisSpec } from "../analysis/spec";
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
  /** how the part is made (custom parts only; library components are bought) */
  process?: ProcessSpec;
  /** span of the part's process: property, for edits */
  processSpan?: Span;
  /** the process came from a design-wide default (applyDefaultProcess), not from the part */
  processInherited?: boolean;
  /** process: false: bought or made by hand, so the brief's process does not apply */
  processNone?: boolean;
  /** process settings filled in from design-wide defaults; left out when the process is written back */
  processDefaults?: string[];
  /** span of the part's material: property, when it names one */
  materialSpan?: Span;
  /** surface finish; undefined means the material's default (see library/materials) */
  finish?: string;
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
  /** set for bodies of an imported STEP file */
  imported?: ImportedBody;
}

export interface ImportedBody {
  /** content hash of the file */
  asset: string;
  /** the import's name in the project */
  file: string;
  /** body index in the file */
  body: number;
  bodyName: string;
  /** surfaces ("shell", "faces") have no volume and are left out of interference checks */
  kind: "solid" | "shell" | "faces";
  /** the body's faces carry their own colours (and no color: override is set) */
  faceColors: boolean;
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
  /** brief uses this requirement checks */
  uses: string[];
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
  kind: "param" | "given" | "let" | "interface" | "sketch" | "component" | "part" | "require" | "analysis";
  label: string;
}

// ---------- the brief ----------

/** Something the design must do or survive. Each use should be covered by requirements (`require ... for <id>`). */
export interface BriefUse {
  id: string;
  text: string;
  /** recorded by Claude without the user saying so */
  assumed: boolean;
  /** force in newtons */
  load?: number;
  /** unit vector the load acts along */
  dir?: V3;
  /** part or component the load acts on */
  on?: string;
  /** how many times it happens over the design's life */
  cycles?: number;
  note?: string;
  span: Span;
}

/** A fact about the world the design has to fit, such as the tube diameter. Available to the design as a fixed name. */
export interface BriefGiven {
  name: string;
  value: number | string | boolean;
  /** value expression as written */
  text: string;
  desc?: string;
  assumed: boolean;
  span: Span;
  valueSpan: Span;
  usedBy: string[];
}

export interface BriefRef {
  id: string;
  title: string;
  /** stored file (image or PDF) in this project's assets */
  file?: string;
  url?: string;
  notes?: string;
  span: Span;
}

export interface BriefAssumption {
  text: string;
  confirmed: boolean;
  span: Span;
}

export interface Brief {
  span: Span;
  purpose?: string;
  setting?: string;
  look?: string;
  priorities: string[];
  /** service temperature range in °C */
  temp?: [number, number];
  outdoor?: boolean;
  exposure: string[];
  /** as written: text, or process source like mfg.fdm(layer: 0.2) */
  process?: string;
  /** the process parts default to, when Kerf has rules for it */
  processSpec?: ProcessSpec;
  material?: string;
  quantity?: number;
  buildVolume?: V3;
  maxSize?: V3;
  /** grams */
  maxMass?: number;
  /** source names of fields Claude assumed */
  assumed: string[];
  uses: BriefUse[];
  givens: BriefGiven[];
  refs: BriefRef[];
  assumptions: BriefAssumption[];
  /** fields this version of Kerf does not know, kept as written */
  extra: { name: string; text: string; span: Span }[];
}

export interface Model {
  name: string;
  notes: string[];
  /** what the design is for; null when the source has no brief block */
  brief: Brief | null;
  params: EvalParam[];
  parts: EvalPart[];
  requirements: EvalRequirement[];
  decisions: EvalDecision[];
  /** 2D constrained sketches, solved, with what the sketch editor needs */
  sketches: EvalSketch[];
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
