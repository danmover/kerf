// What Kerf knows about an imported file (STEP, or an STL, OBJ or 3MF mesh) once the kernel has read it.
// The kernel produces this when a file is imported; it is stored with the
// project so a design can be evaluated (sizes, holes, body names) before the
// kernel has finished loading the geometry again.

import type { V3 } from "./recipe";

/** Bump when the analysis changes, so stored results are recomputed. */
export const IMPORT_META_VERSION = 1;

/** File names Kerf imports: STEP files, and meshes it turns into solids. */
export const STEP_FILE = /\.(step|stp|p21)$/i;
export const MESH_FILE = /\.(stl|obj|3mf)$/i;
export const IMPORT_FILE = /\.(step|stp|p21|stl|obj|3mf)$/i;

/** What a file is, by its name: "STEP", "STL", "OBJ" or "3MF", or null for a file Kerf does not import. */
export function importKind(file: string): "STEP" | "STL" | "OBJ" | "3MF" | null {
  if (STEP_FILE.test(file)) return "STEP";
  const m = MESH_FILE.exec(file);
  return m ? (m[1].toUpperCase() as "STL" | "OBJ" | "3MF") : null;
}

/** Largest file Kerf imports. Bigger ones exhaust the browser's memory for OpenCASCADE. */
export const MAX_STEP_BYTES = 60 * 1024 * 1024;

/** More bodies than this are merged into one so the viewer and checks stay responsive. */
export const MAX_BODIES = 1500;

export interface ImportBody {
  /** display name: instance path and body, e.g. "J1 › shell" */
  name: string;
  /** product the body belongs to, as named in the file */
  product: string;
  /** "solid" bodies have volume and take part in interference checks */
  kind: "solid" | "shell" | "faces";
  /** colour from the file, when it gives one */
  color?: string;
  /** true when faces carry their own colours (rendered per face) */
  faceColors?: boolean;
  volume: number;
  area: number;
  faces: number;
  /** axis-aligned box in file coordinates */
  bbox: [V3, V3];
  /** centre of mass in file coordinates */
  center: V3;
}

/** A cylindrical face (or several faces of one cylinder) found on a body. */
export interface ImportCylinder {
  body: number;
  d: number;
  /** concave cylinders are holes, convex ones are pins, bosses and shafts */
  hole: boolean;
  /** axis end points in file coordinates; `start` has the lower position along the axis */
  start: V3;
  end: V3;
  /** fraction of a full turn the faces cover (1 = a complete cylinder) */
  sweep: number;
}

export interface ImportMeta {
  version: number;
  file: string;
  bytes: number;
  /** product name of the top of the file, when it has a meaningful one */
  title: string;
  bodies: ImportBody[];
  cylinders: ImportCylinder[];
  /** box around every body, in file coordinates */
  bbox: [V3, V3];
  /** what the reader could not do (names, colours, unsupported entities) */
  warnings: string[];
  ms: number;
}

/** An import as the evaluator sees it: its name in the project and what the kernel measured. */
export interface ImportRef {
  name: string;
  hash: string;
  meta: ImportMeta;
}

export type ImportTable = Record<string, ImportRef>;

/** Holes worth listing as mounting holes: complete concave cylinders of a usable size. */
export function mountingHoles(meta: ImportMeta, minD = 1.5, maxD = 40) {
  return meta.cylinders.filter((c) => c.hole && c.sweep > 0.95 && c.d >= minD && c.d <= maxD);
}

export const vmin = (a: V3, b: V3): V3 => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
export const vmax = (a: V3, b: V3): V3 => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];

/** An imported file as a project stores it. The bytes live in the asset store under `hash`. */
export interface ProjectImport {
  /** name designs use in step("name"), unique in the project */
  name: string;
  /** SHA-256 of the file's bytes */
  hash: string;
  /** original file name */
  file: string;
  size: number;
  addedAt: number;
  /** analysis by the kernel; null until the file has been read on this device */
  meta: ImportMeta | null;
}

/** The evaluator's view of a project's imports: only files that have been analysed. */
export function importTable(list: ProjectImport[]): ImportTable {
  const t: ImportTable = {};
  for (const i of list) if (i.meta) t[i.name] = { name: i.name, hash: i.hash, meta: i.meta };
  return t;
}
