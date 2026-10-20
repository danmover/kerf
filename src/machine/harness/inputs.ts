// What the wiring and mounting checks need from a model, gathered on the
// main thread (or in a test) and sent to the cable worker: every visible
// solid with its role, the electronics modules whose holding is checked,
// and the screws that might hold them.

import type { EvalPart, Model } from "../../core/model";
import { applyXforms, applyXformsToDir, xformMatrix, type V3 } from "../../kernel/recipe";
import { catalogPart } from "../catalog";
import type { CatalogKind } from "../types";
import type { MountSpec, ScrewSpec } from "./mounts";
import type { SolidGeometry, SolidPlaced, SolidRole } from "./solids";

/** Catalog kinds that are modules to hold down: boards, supplies, batteries, sensors. */
export const MOUNT_KINDS = new Set<CatalogKind>(["controller", "host", "motor_driver", "stepper_driver", "regulator", "sensor", "battery", "psu", "display", "amplifier", "circuit_board"]);
/** Library hardware that holds things together. */
const FASTENER_KINDS = new Set(["screw", "nut", "insert", "washer", "standoff", "dowel", "rivet"]);

export interface MeshLookup {
  (hash: string): { positions: Float32Array; indices: Uint32Array; bbox: [V3, V3] } | undefined;
}

/** The component instance a solid belongs to: its main solid's id (a.b → a), or the part itself. */
export const instanceOf = (p: EvalPart) => (p.kind === "component" ? p.id.split(".")[0] : p.id);

/** The modules whose holding is checked, by their main solid's id, with their name in the design. */
export function mountParts(model: Model): Map<string, { part: EvalPart; comp: string; held?: string }> {
  const out = new Map<string, { part: EvalPart; comp: string; held?: string }>();
  const comps = new Map((model.machine?.components ?? []).map((c) => [c.name, c]));
  for (const p of model.parts) {
    if (p.kind !== "component" || p.hidden || p.id.includes(".")) continue;
    const mc = comps.get(p.name);
    const cat = p.bom?.catalogId ? catalogPart(p.bom.catalogId) : undefined;
    // a plug-in adapter sits outside the design on the end of its cord
    const isMount = (cat && MOUNT_KINDS.has(cat.kind) && !cat.external && !mc?.pcb) || p.libKind === "pcb";
    if (!isMount) continue;
    const inst = p.id.match(/#(\d+)$/);
    const comp = mc && mc.count > 1 && inst ? `${p.name}[${Number(inst[1]) - 1}]` : p.name;
    out.set(p.id, { part: p, comp, held: mc?.held });
  }
  return out;
}

const isFastener = (p: EvalPart) => !!p.fastener || FASTENER_KINDS.has(p.libKind ?? "");
/**
 * Bought parts with a bore that something runs through (a bearing round a
 * shaft or a core, a seal, a pulley): marked as their exact shape, since their
 * box would close the bore. Every other bought part is a solid box, so
 * cables go round it and never thread its openings (a fan's blades, a vent).
 */
const BORED_KINDS = new Set(["bearing", "nut", "insert", "spur_gear", "spring", "band", "seal", "linear_bearing", "coupler", "pulley"]);

/** The box a bought part is filled as, or undefined for a made part or one marked as its exact shape. */
export const solidBox = (p: EvalPart, bbox: [V3, V3]) => (p.kind === "component" && !BORED_KINDS.has(p.libKind ?? "") ? bbox : undefined);

/** Every visible solid with a mesh, in the form the router and checks take. */
export function solidsInput(model: Model, mesh: MeshLookup, mounts = mountParts(model)): { geos: SolidGeometry[]; placed: (SolidPlaced & { box?: [V3, V3] })[] } {
  const geoIndex = new Map<string, number>();
  const geos: SolidGeometry[] = [];
  const placed: (SolidPlaced & { box?: [V3, V3] })[] = [];
  for (const p of model.parts) {
    if (p.hidden) continue;
    const m = mesh(p.hash);
    if (!m) continue;
    let g = geoIndex.get(p.hash);
    if (g === undefined) {
      g = geos.length;
      geos.push({ positions: m.positions, indices: m.indices });
      geoIndex.set(p.hash, g);
    }
    const comp = instanceOf(p);
    const role: SolidRole = p.kind === "part" ? "made" : isFastener(p) ? "fastener" : mounts.has(comp) ? "mount" : "part";
    placed.push({ geo: g, m: xformMatrix(p.xf), box: solidBox(p, m.bbox), id: p.id, comp, role, removable: p.removable });
  }
  return { geos, placed };
}

/** Each module's body and mounting holes in its own frame, from its main solid's recipe (a box with holes cut through it). */
export function mountSpecs(model: Model, bbox: (hash: string) => [V3, V3] | undefined, mounts = mountParts(model)): MountSpec[] {
  const out: MountSpec[] = [];
  for (const [id, { part: p, comp, held }] of mounts) {
    const base = p.recipe.base;
    let body: [V3, V3] | undefined;
    const holes: MountSpec["holes"] = [];
    if (base?.t === "box") {
      const at = base.at ?? [0, 0, 0];
      body = [
        [at[0] - base.w / 2, at[1] - base.d / 2, at[2]],
        [at[0] + base.w / 2, at[1] + base.d / 2, at[2] + base.h],
      ];
      for (const op of p.recipe.ops) {
        if (op.op !== "cut") continue;
        const sh = op.shape;
        if ((sh.t === "cyl" || sh.t === "hole") && sh.dir && Math.abs(sh.dir[2]) > 0.99 && Math.abs(sh.dir[0]) < 1e-6 && Math.abs(sh.dir[1]) < 1e-6) holes.push({ x: sh.at[0], y: sh.at[1], d: sh.d });
      }
    } else body = bbox(p.hash);
    if (!body) continue;
    const thin = body[1][2] - body[0][2] <= 3.2;
    out.push({ comp, partId: id, label: p.label, m: xformMatrix(p.xf), body, board: thin, holes, held });
  }
  return out;
}

/** Every screw: where its head seats, which way its shank runs, its length and size. */
export function screwSpecs(model: Model): ScrewSpec[] {
  const out: ScrewSpec[] = [];
  for (const p of model.parts) {
    if (p.hidden || p.libKind !== "screw" || !p.fastener) continue;
    const length = Number(/×\s*([\d.]+)/.exec(p.bom?.description ?? "")?.[1] ?? /×\s*([\d.]+)/.exec(p.label)?.[1] ?? 10);
    const d = Number(/M(\d+(?:[._]\d+)?)/.exec(p.fastener.size)?.[1]?.replace("_", ".") ?? 3);
    out.push({ id: p.id, seat: applyXforms([0, 0, 0], p.xf), axis: applyXformsToDir([0, 0, 1], p.xf), length, d });
  }
  return out;
}
