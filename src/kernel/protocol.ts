// Messages between the UI thread and the geometry kernel worker.

import type { PartRecipe, Sel, V3, Xform } from "./recipe";
import type { MeshData } from "./build";
import type { GeoQuery } from "../lang/values";
import type { ProcessProbe, ProcessResult } from "../mfg/types";
import type { PickMeasure, PickRef, ViewRequest, ViewResult } from "./drawing";
import type { PartInspection } from "./inspect";
import type { ImportMeta } from "./imports";
import type { MeasureResult } from "./core";

export interface ExportItem {
  hash: string;
  xf: Xform[];
  name: string;
  color: string;
  /** lets the worker build the part if it has not yet */
  recipe?: PartRecipe;
  /** use the simple shape (its detailed build could not finish) */
  fast?: boolean;
}

export interface BuildItem {
  hash: string;
  recipe: PartRecipe;
  label: string;
}

export interface PlacedItem {
  id: string;
  name: string; // source block name (component or part)
  label: string;
  hash: string;
  xf: Xform[];
  removable: boolean;
  moving: boolean;
  density: number;
  /** excluded from pairwise solid booleans (gears: checked by tooth and envelope checks instead) */
  noInterference?: boolean;
}

export interface AccessProbe {
  id: string;
  headTop: V3;
  outward: V3;
  diameter: number;
  length: number;
}

export interface EnvelopeProbe {
  id: string;
  /** cylinder swept by a rotating part: start point, axis, diameter, length */
  at: V3;
  axis: V3;
  d: number;
  length: number;
  /** the hole through it: what passes through its bore (a still axle it turns on) is not in its way */
  bore?: number;
  /** ids that move with or mesh with this part (excluded) */
  exclude: string[];
}

export interface ChecksRequest {
  placed: PlacedItem[];
  queries: GeoQuery[];
  access: AccessProbe[];
  envelopes: EnvelopeProbe[];
  /** pairs that are intentionally in contact, e.g. meshing gears */
  ignorePairs: [string, string][];
}

export interface Interference {
  a: string;
  b: string;
  volume: number;
  center: V3;
  mesh?: MeshData;
}

export interface ChecksResult {
  interferences: Interference[];
  geo: Record<string, number>;
  geoErrors: Record<string, string>;
  access: { id: string; blockedBy: string[] }[];
  envelopes: { id: string; hits: string[] }[];
  ms: number;
  pairsTested: number;
  /** parts (by geometry hash) made of more than one solid, with the smaller pieces in the part's own coordinates */
  pieces?: Record<string, { count: number; others: { volume: number; at: V3 }[] }>;
  /** pairs of parts whose surfaces touch (or cross), with which one holds the other up */
  contacts?: Contact[];
  /** each placed part's box in the assembly, by part id */
  boxes?: Record<string, [V3, V3]>;
}

export interface Contact {
  a: string;
  b: string;
  /** a rests on b (b's surface faces up under it where they meet) */
  aOnB: boolean;
  bOnA: boolean;
}

export interface InspectRequest {
  hash: string;
  recipe: PartRecipe;
  label: string;
  /** an edge or face selection to list */
  sel?: Sel;
  selKind?: "edges" | "faces";
  /** a point in the part's own coordinates: report the face and edge there */
  at?: V3;
  /** most items to list */
  limit?: number;
}

export interface InspectEdge {
  kind: string;
  length: number;
  mid: V3;
  radius?: number;
  convexity: string;
  features: string[];
}

export interface InspectFace {
  kind: string;
  center: V3;
  normal?: V3;
  features: string[];
}

export interface InspectResult {
  bbox: [V3, V3];
  volume: number;
  faces: number;
  edges: number;
  features: { name: string; kind: string; faces: number; root: number; tip: number }[];
  edgeStats: { convex: number; concave: number; smooth: number };
  selection?: { kind: "edges" | "faces"; count: number; edges?: InspectEdge[]; faces?: InspectFace[] };
  pick?: { edge?: InspectEdge & { distance: number }; face?: InspectFace & { distance: number }; selectors: string[] };
  ms: number;
}

export type ToWorker =
  | { type: "init" }
  | { type: "build"; jobId: number; items: BuildItem[]; quality: "preview" | "final" }
  | { type: "cancel"; jobId: number }
  | { type: "checks"; jobId: number; req: ChecksRequest }
  | { type: "export-step"; jobId: number; items: ExportItem[] }
  | { type: "process"; jobId: number; probes: ProcessProbe[] }
  | { type: "evict"; keep: string[] }
  | { type: "project"; jobId: number; req: ViewRequest }
  | { type: "pick-measure"; jobId: number; req: { a: PickRef; b?: PickRef } }
  | { type: "inspect"; jobId: number; hashes: string[] }
  /** named features, sharp edges and a selection of one part (for inspect_part) */
  | { type: "inspect-part"; jobId: number; req: InspectRequest }
  /** read a STEP file and keep its bodies for "import" recipes; `analyse` false skips the hole search for a file analysed before */
  | { type: "import-step"; jobId: number; hash: string; file: string; data: ArrayBuffer; analyse: boolean }
  | { type: "drop-import"; hash: string }
  | { type: "measure"; jobId: number; a: { hash: string; xf: Xform[] }[]; b: { hash: string; xf: Xform[] }[] };

export type FromWorker =
  | { type: "ready"; ms: number }
  | { type: "init-error"; message: string }
  | { type: "part"; jobId: number; hash: string; quality: "preview" | "final"; mesh: MeshData; volume: number; bbox: [V3, V3]; ms: number; warnings?: string[] }
  | { type: "part-error"; jobId: number; hash: string; message: string }
  | { type: "built"; jobId: number; ms: number; built: number; cached: number }
  | { type: "checks"; jobId: number; result: ChecksResult }
  | { type: "checks-error"; jobId: number; message: string }
  | { type: "exported"; jobId: number; data: ArrayBuffer }
  | { type: "export-error"; jobId: number; message: string }
  | { type: "process"; jobId: number; results: ProcessResult[] }
  | { type: "process-error"; jobId: number; message: string }
  | { type: "projected"; jobId: number; result: ViewResult }
  | { type: "pick-measured"; jobId: number; result: PickMeasure }
  | { type: "job-error"; jobId: number; message: string }
  | { type: "inspected"; jobId: number; result: Record<string, PartInspection | { error: string }> }
  | { type: "imported"; jobId: number; hash: string; meta: ImportMeta }
  | { type: "import-error"; jobId: number; hash: string; message: string }
  | { type: "measured"; jobId: number; result: MeasureResult }
  | { type: "measure-error"; jobId: number; message: string }
  | { type: "part-inspected"; jobId: number; result: InspectResult }
  | { type: "inspect-part-error"; jobId: number; message: string }
  /** the worker started this job (jobs can run out of order: drawing projections wait behind urgent work) */
  | { type: "started"; jobId: number }
  /** WebAssembly trapped (out of memory, an abort): the worker must be replaced; hash is the part being built */
  | { type: "fatal"; jobId: number; hash?: string; message: string };
