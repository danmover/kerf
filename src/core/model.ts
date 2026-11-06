// The evaluated design model: what the viewer, checks, AI and UI consume.

import type { BandLayout } from "../library/bands";
import type { Span } from "../lang/ast";
import type { Diagnostic } from "../lang/parser";
import type { PartRecipe, V3, Xform } from "../kernel/recipe";
import type { GeoQuery } from "../lang/values";
import type { MachineData } from "../machine/types";
import type { ScenarioDef } from "../sim/scenario";
import type { EvalSketch } from "../sketch/types";
import type { AnalysisSpec } from "../analysis/spec";
import type { ProcessSpec } from "../mfg/types";
import type { DrawingSpec } from "../drawing/spec";
import type { SheetInfo } from "../lang/sheet";
import type { ChainInfo } from "../machine/chains";
import type { AeroTube } from "../lang/aero";

export interface Motion {
  origin: V3;
  axis: V3;
  /** rotation = ratio × driver angle (relative to `parent` when it rides on one) */
  ratio: number;
  /** the moving part this one rides on (`rides:`): its own turn is about an axis carried round by the parent's motion */
  parent?: Motion;
  /**
   * moved by a connecting rod instead of turning at a fixed rate: a part that slides along `axis` (a piston), one
   * that swings about `axis` through `origin` (a rocker, a pirate ship), or the rod itself; `link` says how
   */
  kind?: "slide" | "swing" | "rod";
  link?: Link;
}

/** A connecting rod: a pin on a moving part (the driver) and a pin on a part that slides or swings (the follower). */
export interface Link {
  /** the rod's part id and name */
  id: string;
  name: string;
  /** the driver's motion and the pins where they are drawn (world): p0 on the driver, w0 on the follower */
  driver: Motion;
  p0: V3;
  w0: V3;
  length: number;
  /** the follower: slides along `axis`, or swings about `axis` through `at` */
  follower: { name: string; kind: "slide" | "swing"; axis: V3; at: V3 };
}

/** A part's mass in grams: as given, else its volume (mm³) times its material's density (g/cm³). */
export function partMass(p: EvalPart, volume: number | undefined, density: number): number | undefined {
  if (p.mass !== undefined) return p.mass;
  return volume === undefined ? undefined : (volume / 1000) * density;
}

/** The volume that gives a part its mass: its solid's, or the one that matches a given mass:. */
export function massVolume(p: EvalPart, volume: number | undefined, density: number): number | undefined {
  if (p.mass !== undefined && density > 0) return (p.mass / density) * 1000;
  return volume;
}

/** How fast a motion turns about `axis` (a unit vector) per unit of driver angle, counting what it rides on. */
export function absRate(m: Motion | undefined, axis: V3): number {
  let r = 0;
  for (let x = m; x; x = x.parent) {
    const a = x.axis;
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    r += (x.ratio * (a[0] * axis[0] + a[1] * axis[1] + a[2] * axis[2])) / l;
  }
  return r;
}

/** Whether a motion turns at all, itself or by what it rides on. */
export const turns = (m: Motion | undefined): boolean => !!m && (Math.abs(m.ratio) > 1e-12 || !!m.link || turns(m.parent));

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

/** A part of a part that is meant to bend: a snap hook's arm or a flexure blade (in the part's own frame). */
export interface FlexInfo {
  kind: "snap" | "flexure";
  /** feature name (`as` name, or snap_hook#1) */
  name: string;
  /** centre of the root, along which the arm rises */
  at: V3;
  dir: V3;
  /** the way the catch (or the blade's thickness) faces */
  facing: V3;
  length: number;
  t: number;
  w: number;
  /** snap: catch depth (how far the arm bends to pass); flexure: tip travel, mm */
  deflection: number;
  /** flexure: bend angle of a living hinge, degrees (instead of travel) */
  angle?: number;
  /** snap: lead-in slope from the arm's axis, degrees */
  leadIn?: number;
  /** snap: slope of the catch face, degrees (90: square, does not let go) */
  retain?: number;
  /** snap: how far the arm stays bent once latched, mm (0: it just touches); flexure: how far the blade stays bent pressing on `against` */
  preload?: number;
  /** flexure: the part the blade presses on with its preload (drawn overlapping it by that much along facing) */
  against?: string;
  /** times it bends in its life */
  cycles?: number;
  /** snap: a round peg catch of this diameter that drops into a hole; flexure: a locking pin of this diameter */
  peg?: number;
  /** flexure: how far the locking pin stands out of the blade's face, mm */
  reach?: number;
  /** flexure: the locking pin's distance from the blade's root, mm */
  pinAt?: number;
  /** flexure: how far the locking pin sits off the blade's middle, across it (along facing × dir), mm */
  pinOff?: number;
  span: Span;
}

/** An O-ring or rubber band (lib.band), laid out in world space. */
export interface BandInfo {
  /** key into RUBBERS */
  rubber: string;
  shore: number;
  cs: number;
  id: number;
  /** the parts it wraps, and the part its hooks are on */
  around: string[];
  holds?: string;
  layout: BandLayout;
  /** mass it holds on, g, and the bumps it rides, g */
  carries?: number;
  shock?: number;
  /** friction of the holding part's seat on the tube */
  saddleMu: number;
}

/** A coil spring's design (lib.spring), in world space. */
export interface SpringInfo {
  /** wire diameter, outside diameter, free length, installed length and shortest working length, mm */
  d: number;
  od: number;
  free: number;
  installed: number;
  working: number;
  /** active coils */
  coils: number;
  ends: "closed-ground" | "closed" | "plain";
  /** compressions in its life */
  cycles: number;
  center: V3;
  axis: V3;
}

export interface FastenerInfo {
  headTop: V3;
  outward: V3;
  key: number;
  headD: number;
  size: string;
  /** what turns it ("2.5 mm hex key", "Torx T10", "13 mm spanner") and how wide that tool is */
  tool?: string;
  toolD?: number;
  head?: string;
  length?: number;
  grade?: string;
  /** tension and shear it carries in use, N each */
  load?: number;
  shear?: number;
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
  /** set on a part a drawing shows squared up (src/drawing/square.ts): where it really sits */
  worldXf?: Xform[];
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
  /** the part's real mass in grams, given because its solid is not what is made (a hollow carbon frame modelled solid) */
  mass?: number;
  /** how the part is held where the model cannot show it (`held: "glued"`, a catalog part's `held: "strap"`) */
  held?: string;
  /** snap hooks and flexures in this part */
  flex?: FlexInfo[];
  /** a sheet() part: its bends and flanges, and the recipe of its flat pattern */
  sheet?: SheetPart;
  spring?: SpringInfo;
  band?: BandInfo;
  /** aero_tube()s the part is built from, in its own coordinates */
  tubes?: AeroTube[];
  /** a lib.chain: its sprockets, where its rollers sit and how fast it runs */
  chain?: ChainInfo;
  bom?: { description: string; standard?: string; catalogId?: string; length?: number; price?: number; priceNote?: string; search?: string; key?: string };
  /** named features (`add ... as name`), for selectors and inspection */
  features?: { name: string; kind: string; cosmetic: boolean }[];
  /** detailed builds differ from fast ones (threads, knurls, cosmetic steps) */
  detail?: boolean;
  /** set for bodies of an imported STEP file */
  imported?: ImportedBody;
}

/** A sheet-metal part's data: flanges, bends and regions (part coordinates), and its flat pattern as a part of its own. */
export interface SheetPart extends Omit<SheetInfo, "unfold"> {
  flat: PartRecipe;
  flatHash: string;
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
  /** processes the user has themselves, as written; replaces Settings for this project */
  workshop?: string[];
  /** processes the user can order, as written; replaces Settings for this project */
  canOrder?: string[];
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
  /** engineering drawings defined in the source */
  drawings: DrawingSpec[];
  evalMs: number;
  /** purchased parts, wiring, calculations, firmware and tests (designs that use catalog parts) */
  machine?: MachineData;
  /** simulated tests: a world, the machine in it, its firmware and what has to come true */
  scenarios?: ScenarioDef[];
}
