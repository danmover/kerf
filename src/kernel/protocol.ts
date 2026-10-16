// Messages between the UI thread and the geometry kernel worker.

import type { PartRecipe, V3, Xform } from "./recipe";
import type { MeshData } from "./build";
import type { GeoQuery } from "../lang/values";
import type { ProcessProbe, ProcessResult } from "../mfg/types";
import type { PartInspection } from "./inspect";
import type { ImportMeta } from "./imports";
import type { MeasureResult } from "./core";

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

export type ToWorker =
  | { type: "init" }
  | { type: "build"; jobId: number; items: BuildItem[]; quality: "preview" | "final" }
  | { type: "cancel"; jobId: number }
  | { type: "checks"; jobId: number; req: ChecksRequest }
  | { type: "export-step"; jobId: number; items: { hash: string; xf: Xform[]; name: string; color: string }[] }
  | { type: "process"; jobId: number; probes: ProcessProbe[] }
  | { type: "evict"; keep: string[] }
  | { type: "inspect"; jobId: number; hashes: string[] }
  /** read a STEP file and keep its bodies for "import" recipes; `analyse` false skips the hole search for a file analysed before */
  | { type: "import-step"; jobId: number; hash: string; file: string; data: ArrayBuffer; analyse: boolean }
  | { type: "drop-import"; hash: string }
  | { type: "measure"; jobId: number; a: { hash: string; xf: Xform[] }[]; b: { hash: string; xf: Xform[] }[] };

export type FromWorker =
  | { type: "ready"; ms: number }
  | { type: "init-error"; message: string }
  | { type: "part"; jobId: number; hash: string; quality: "preview" | "final"; mesh: MeshData; volume: number; bbox: [V3, V3]; ms: number }
  | { type: "part-error"; jobId: number; hash: string; message: string }
  | { type: "built"; jobId: number; ms: number; built: number; cached: number }
  | { type: "checks"; jobId: number; result: ChecksResult }
  | { type: "checks-error"; jobId: number; message: string }
  | { type: "exported"; jobId: number; data: ArrayBuffer }
  | { type: "export-error"; jobId: number; message: string }
  | { type: "process"; jobId: number; results: ProcessResult[] }
  | { type: "process-error"; jobId: number; message: string }
  | { type: "inspected"; jobId: number; result: Record<string, PartInspection | { error: string }> }
  | { type: "imported"; jobId: number; hash: string; meta: ImportMeta }
  | { type: "import-error"; jobId: number; hash: string; message: string }
  | { type: "measured"; jobId: number; result: MeasureResult }
  | { type: "measure-error"; jobId: number; message: string };
