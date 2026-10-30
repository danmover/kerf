// Organic models: creatures, people and other soft shapes, described as
// blended primitives (balls, eggs, limbs, slabs) with paint on top. This is
// the plain, serialisable recipe the evaluator writes and the kernel worker
// meshes; it never goes through OpenCASCADE except as a coarse stand-in for
// the checks (see mesh.ts).

import type { SheetData } from "./sheet";

export type V3 = [number, number, number];
export type V2 = [number, number];

/** A 3x3 rotation, row-major, taking world directions into the shape's own axes. */
export type M3 = [number, number, number, number, number, number, number, number, number];

export type Prim =
  | { k: "ball"; c: V3; r: number }
  /** an egg or bean: radii along its own axes */
  | { k: "ellipsoid"; c: V3; r: V3; m?: M3 }
  /** a capsule or tapered limb from a to b with end radii ra and rb (a horn when rb is tiny) */
  | { k: "limb"; a: V3; b: V3; ra: number; rb: number }
  /** a rounded box: half sizes h, corner radius r */
  | { k: "box"; c: V3; h: V3; r: number; m?: M3 }
  /** a flat outline (fin, feather, leaf, star, lightning bolt) given a thickness: points in the plane of u and n × u, half thickness t, edge radius r */
  | { k: "slab"; pts: V2[]; t: number; r: number; o: V3; u: V3; n: V3 }
  /** a ring of radius R and tube radius r round axis n */
  | { k: "torus"; c: V3; R: number; r: number; n: V3 }
  /** a faceted crystal from a to b: `sides` flat sides of radius r, a pointed tip of length tip */
  | { k: "gem"; a: V3; b: V3; r: number; sides: number; tip: number }
  /** tapered segments joined end to end or fanned out (curved tubes, curls, fur tufts): [ax, ay, az, bx, by, bz, ra, rb] per segment */
  | { k: "cones"; s: number[] };

export type ItemOp = "add" | "carve" | "paint";

export interface PaintNoise {
  /** feature size of the wobble, mm */
  scale: number;
  /** how far the edge wanders, as a fraction of scale */
  amount: number;
  seed: number;
}

export interface Item {
  op: ItemOp;
  prim: Prim;
  /** add: the colour of the surface where this shape is outermost; paint: the colour it paints */
  color?: string;
  /** smoothing radius where it joins what came before, mm */
  blend: number;
  /** surface detail strength on this shape, 0 to 1 (only the detailed style uses it) */
  detail?: number;
  /** paint only: a wobbly edge (galaxy swirls, patches) */
  noise?: PaintNoise;
  /** a name for the shape, kept for rigging and for messages */
  name?: string;
  /** which entry of the model's shape list it came from, so fitting moves an ear or a leg as one */
  g?: number;
  /** -1 on the copy that mirror: true made across x = 0 */
  side?: -1;
}

export type OrganicStyle = "lowpoly" | "smooth" | "detailed";

export type DetailKind = "fur" | "scales" | "skin" | "feathers";

export interface OrganicModel {
  v: 1;
  items: Item[];
  /** colour where no shape or paint gives one */
  color: string;
  /** smooth: soft stylised forms (the default); lowpoly: faceted, flat colours; detailed: fine surface detail */
  style: OrganicStyle;
  /** target triangle count of the final mesh (0: the style's default) */
  tris: number;
  /** detailed style: what the surface looks like up close */
  detail?: { kind: DetailKind; amp: number; scale: number };
  /** a reference sheet: the shapes are fitted to its outlines (unless fit is false) and coloured from its views */
  sheet?: SheetData;
  fit?: boolean;
}

/** Default triangle budgets: smooth fits one Roblox mesh (20k) and still shades smoothly from the field's normals. */
export const STYLE_TRIS: Record<OrganicStyle, number> = { lowpoly: 4000, smooth: 16000, detailed: 160000 };

/** Most triangles a model may ask for. */
export const MAX_TRIS = 400000;

/** Largest number of shapes in one model. */
export const MAX_ITEMS = 400;

export function isOrganicModel(x: unknown): x is OrganicModel {
  return !!x && typeof x === "object" && (x as OrganicModel).v === 1 && Array.isArray((x as OrganicModel).items);
}
