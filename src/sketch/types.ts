// Types shared by the sketch evaluator, the kernel recipe builder, the AI
// tools and the sketch editor.

import type { Span } from "../lang/ast";
import type { ProfileRegion, V2, V3 } from "../kernel/recipe";
import type { PointFreedom, SketchDef } from "./solver";
import type { Profile } from "./regions";

/** A sketch plane: origin and right-handed axes (u across, v up, n out of the plane). */
export interface Frame {
  o: V3;
  u: V3;
  v: V3;
  n: V3;
}

export type SkStatus = "fixed" | "defined" | "free" | "conflict";

export interface SkPoint {
  id: string;
  x: number;
  y: number;
  /** declared inline as part of a curve (l1.start, c1.center) */
  implicit: boolean;
  /** the curve that declared an implicit point */
  owner?: string;
  fixed: boolean;
  status: SkStatus;
  freedom: PointFreedom;
  /** where its coordinates are written, and whether they are plain numbers the editor may rewrite */
  coordSpan?: Span;
  literal: boolean;
  /** the coordinates as written, before solving */
  written?: V2;
  /** the declaring statement, for named points */
  span?: Span;
  /** projected from another sketch (side.l3.end): fixed reference, not editable here */
  external?: boolean;
  /** made by a mirror, pattern or offset statement: the index of that statement among the constraints */
  derived?: number;
}

export interface SkCurve {
  id: string;
  kind: "line" | "circle" | "arc" | "spline" | "ellipse";
  construction: boolean;
  /** line: [start, end]; circle: [center]; arc: [start, end, center]; spline: the points it passes through, in order; ellipse: [center] */
  pts: string[];
  /** a spline that runs back round to its first point */
  closed?: boolean;
  /** ellipse: its radii along its own axes and the turn of the rx axis (degrees counter-clockwise) */
  rx?: number;
  ry?: number;
  angle?: number;
  /** ellipse: where rx:, ry: and angle: are written, and whether each is a plain number the editor may rewrite */
  optSpans?: Partial<Record<"rx" | "ry" | "angle" | "closed", Span>>;
  optLiteral?: Partial<Record<"rx" | "ry" | "angle", boolean>>;
  /** circle radius (solved) */
  r?: number;
  status: SkStatus;
  span: Span;
  /** source text of each point argument (a name or inline coordinates) */
  argSpans: Span[];
  /** circle: where the size (r: or d:) is written */
  sizeSpan?: Span;
  sizeWhich?: "r" | "d";
  sizeLiteral?: boolean;
  /** radius as written, before solving */
  writtenR?: number;
  /** a line projected from another sketch (side.l3): reference only */
  external?: boolean;
  /** made by a mirror, pattern or offset statement: the index of that statement among the constraints */
  derived?: number;
}

export interface SkConstraint {
  /** position among the sketch's constraint statements */
  index: number;
  kind: string;
  /** names as written, e.g. ["l1"], ["p1", "l2.start"] */
  args: string[];
  /** resolved entity ids per argument */
  ids: string[];
  argSpans: Span[];
  value?: number;
  valueText?: string;
  span: Span;
  valueSpan?: Span;
  /** conflict: the constraint that broke the sketch; involved: others fighting it */
  status: "ok" | "redundant" | "conflict" | "involved";
  /** a dimension (has a value) rather than a geometric relation */
  dimension: boolean;
  /** named options as written (mirror, pattern, offset): about: l5, count: 4 */
  opts?: { name: string; text: string; span: Span; ids: string[] }[];
  /** the curves a mirror, pattern or offset statement made */
  made?: string[];
  /** the original each of those copies was made from */
  madeFrom?: string[];
}

export interface EvalSketch {
  name: string;
  span: Span;
  nameSpan: Span;
  /** offset of the closing brace */
  bodyEnd: number;
  /** offset after the last geometry statement (new geometry goes here) */
  entityEnd: number;
  indent: string;
  locked: boolean;
  frame: Frame;
  planeText: string;
  points: SkPoint[];
  curves: SkCurve[];
  constraints: SkConstraint[];
  dof: number;
  solved: boolean;
  /** the solver gave up because the sketch is too large or slow (message says which); the geometry is as written */
  tooBig?: boolean;
  /** what went wrong solving, in plain words */
  message?: string;
  redundant: number;
  profile: Profile;
  /** other names of shared points: "l2.start" → "l1.end" */
  aliases: Record<string, string>;
  /** the solver input, so the editor can re-solve while dragging */
  def: SketchDef;
  /** parts whose geometry uses this sketch */
  usedBy: string[];
}

/** What extrude() and revolve() need from a sketch value. */
export interface SketchGeom {
  name: string;
  frame: Frame;
  regions: ProfileRegion[];
  profileError?: string;
  solved: boolean;
  message?: string;
  lines: Record<string, [V2, V2]>;
  /** every point in sketch coordinates, for the revolve side check */
  extent: V2[];
}
