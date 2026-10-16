// Messages between the UI thread and the geometry kernel worker.

import type { PartRecipe, Sel, V3, Xform } from "./recipe";
import type { MeshData } from "./build";
import type { GeoQuery } from "../lang/values";

export interface ExportItem {
  hash: string;
  xf: Xform[];
  name: string;
  color: string;
  /** lets the worker build the part if it has not yet */
  recipe?: PartRecipe;
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
  | { type: "inspect"; jobId: number; req: InspectRequest }
  | { type: "evict"; keep: string[] };

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
  | { type: "inspected"; jobId: number; result: InspectResult }
  | { type: "inspect-error"; jobId: number; message: string };
