// Imported files in the design language: `step("name")` places an imported
// file (a STEP file, or a mesh Kerf turned into solids) as a component, with
// fields for its size, bodies and holes.
// Everything here works from the analysis stored with the project, so a
// design evaluates before the kernel has loaded the geometry again.

import type { CompDef } from "../library/components";
import { applyXforms, applyXformsToDir, vnorm, type ShapeRecipe, type V3, type Xform } from "../kernel/recipe";
import { mountingHoles, type ImportMeta, type ImportRef, type ImportTable } from "../kernel/imports";
import { Fn, Obj, ShapeV, Vec, type Value } from "./values";

/** Imports the evaluator uses when a call does not pass its own (set by the engine and the solver worker). */
let current: ImportTable = {};
/** names of imports whose analysis is still running */
let pending = new Set<string>();

export function setEvalImports(table: ImportTable, reading: string[] = []) {
  current = table;
  pending = new Set(reading);
}

export function evalImports(): ImportTable {
  return current;
}

/** `step` is looked up after the user's own names, so existing designs that use the word keep working. */
export class ImportFn extends Fn {
  constructor() {
    super(
      "step",
      // in an expression (a part's body) it is the file's solid, to change with direct edits
      (pos, named, ctx) => {
        const name = pos[0] ?? named.name;
        if (typeof name !== "string") return ctx.error('step("name") names an imported file: component board = step("name") { at: (x, y, z) } places it, and part bracket { body step("name") } makes it a part to change');
        const table = ctx.imports?.() ?? evalImports();
        const ref = findImport(table, name);
        if (!ref) return ctx.error(missingImportMessage(table, name));
        const origin = named.origin ?? "base";
        if (origin !== "base" && origin !== "center" && origin !== "file") return ctx.error('step(): origin is "base", "center" or "file"');
        const n = ref.meta.bodies.length;
        const b = named.body;
        if (b !== undefined && (typeof b !== "number" || !Number.isInteger(b) || b < 1 || b > n)) return ctx.error(`step(): body is the body's number from 1 to ${n}`);
        const shift = sub([0, 0, 0], originOffset(ref.meta, origin));
        return new ShapeV(bodyRecipe(ref, b !== undefined ? b - 1 : n === 1 ? 0 : -1, shift));
      },
      'step("name") { at:, rotate:, origin: } places an imported file (STEP, or an STL, OBJ or 3MF mesh) as a component; in a part, body step("name", origin: "base", body: 1) makes the file (or one of its bodies) the part\'s solid, to change with push_pull(), delete_faces(), move_faces() and the other modelling steps',
    );
  }
}

export const STEP_FN = new ImportFn();

export type ImportOrigin = "base" | "center" | "file";

/** Find an import by its name in the project, its file name, or a close match. */
export function findImport(table: ImportTable, name: string): ImportRef | undefined {
  if (table[name]) return table[name];
  const all = Object.values(table);
  const lower = name.toLowerCase();
  return (
    all.find((r) => r.name.toLowerCase() === lower) ??
    all.find((r) => r.meta.file.toLowerCase() === lower || r.meta.file.replace(/\.(step|stp|p21|stl|obj|3mf)$/i, "").toLowerCase() === lower)
  );
}

export function missingImportMessage(table: ImportTable, name: string): string {
  if (pending.has(name)) return `The imported file "${name}" is still being read. The design updates when it is ready.`;
  const names = Object.keys(table);
  if (!names.length) return `No file named "${name}" is imported. Import one from the Structure panel (Imported files), or drop a STEP file or a mesh (.stl, .obj, .3mf) on the 3D view.`;
  return `No file named "${name}" is imported. Imported files: ${names.map((n) => `"${n}"`).join(", ")}.`;
}

/** The point of the file that `at` places: centre of the bottom of its box, its centre, or the file's own origin. */
export function originOffset(meta: ImportMeta, origin: ImportOrigin): V3 {
  const [lo, hi] = meta.bbox;
  if (origin === "file") return [0, 0, 0];
  const c: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  return origin === "center" ? c : [c[0], c[1], lo[2]];
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

function bodyRecipe(ref: ImportRef, body: number, shift: V3): ShapeRecipe {
  const r: ShapeRecipe = { t: "import", asset: ref.hash, body };
  return shift[0] || shift[1] || shift[2] ? { t: "xform", shape: r, xf: [{ op: "translate", v: shift }] } : r;
}

const DEFAULT_BODY_COLOR = "#a3abb5";

/** A component definition for an imported file: one solid per body, in the file's local frame moved to the chosen origin. */
export function importDef(ref: ImportRef, origin: ImportOrigin): CompDef {
  const shift = sub([0, 0, 0], originOffset(ref.meta, origin));
  const many = ref.meta.bodies.length > 1;
  return {
    kind: "step",
    label: ref.name,
    placement: "free",
    solids: ref.meta.bodies.map((b, i) => ({
      suffix: many ? String(i + 1) : "",
      label: many ? `${ref.name}: ${b.name}` : ref.name,
      recipe: { base: bodyRecipe(ref, i, shift), ops: [] },
      color: b.color ?? DEFAULT_BODY_COLOR,
      material: "",
    })),
    fields: {},
    bom: { description: `${ref.meta.title || ref.name} (imported from ${ref.meta.file})` },
  };
}

/** Box helpers in world space for a local box under a placement. */
function worldBox(lo: V3, hi: V3, xf: Xform[]): [V3, V3] {
  const a: V3 = [Infinity, Infinity, Infinity];
  const b: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const p = applyXforms([i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]], xf);
    for (let k = 0; k < 3; k++) {
      a[k] = Math.min(a[k], p[k]);
      b[k] = Math.max(b[k], p[k]);
    }
  }
  return [a, b];
}

function boxFields(lo: V3, hi: V3, xf: Xform[]): Record<string, Value> {
  const [a, b] = worldBox(lo, hi, xf);
  const c: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  return {
    min: new Vec(a),
    max: new Vec(b),
    center: new Vec(c),
    top: new Vec([c[0], c[1], b[2]]),
    bottom: new Vec([c[0], c[1], a[2]]),
    size: new Vec([b[0] - a[0], b[1] - a[1], b[2] - a[2]]),
    w: b[0] - a[0],
    d: b[1] - a[1],
    h: b[2] - a[2],
  };
}

/** A box around a local box, `margin` bigger on every side, placed like the import. */
function envelopeFn(lo: V3, hi: V3, xf: Xform[], what: string): Fn {
  return new Fn(
    "envelope",
    (pos, named, ctx) => {
      const m = pos[0] ?? named.margin ?? 0;
      if (typeof m !== "number" || !Number.isFinite(m) || m < 0) return ctx.error("envelope(margin): margin must be a number of mm, 0 or more");
      const shape: ShapeRecipe = {
        t: "box",
        w: hi[0] - lo[0] + 2 * m,
        d: hi[1] - lo[1] + 2 * m,
        h: hi[2] - lo[2] + 2 * m,
        at: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2] - m],
        r: 0,
      };
      return new ShapeV({ t: "xform", shape, xf });
    },
    `envelope(margin) → a box around ${what}, margin mm bigger on every side (for clearance cuts and keep-out checks)`,
  );
}

const MAX_HOLES = 100;

/**
 * World-space fields of one placed instance. `ids` names the solid each body
 * became, so a body can be used in min_distance() and other measurements.
 */
export function importFields(ref: ImportRef, origin: ImportOrigin, xf: Xform[], ids: string[]): Record<string, Value> {
  const meta = ref.meta;
  const shift = sub([0, 0, 0], originOffset(meta, origin));
  const local = (p: V3): V3 => [p[0] + shift[0], p[1] + shift[1], p[2] + shift[2]];
  const place: Xform[] = shift[0] || shift[1] || shift[2] ? [{ op: "translate", v: shift }, ...xf] : xf;
  const world = (p: V3) => new Vec(applyXforms(local(p), xf));
  const holes = mountingHoles(meta)
    .slice()
    .sort((a, b) => a.body - b.body || a.start[1] - b.start[1] || a.start[0] - b.start[0])
    .slice(0, MAX_HOLES);

  const fields: Record<string, Value> = {
    file: meta.file,
    title: meta.title || ref.name,
    body_count: meta.bodies.length,
    ...boxFields(local(meta.bbox[0]), local(meta.bbox[1]), xf),
    holes: holes.map((h) => world(h.start)),
    hole_tops: holes.map((h) => world(h.end)),
    hole_d: holes.map((h) => Math.round(h.d * 1000) / 1000),
    hole_dirs: holes.map((h) => new Vec(vnorm(applyXformsToDir(sub(h.end, h.start), xf)))),
    shape: new ShapeV({ t: "xform", shape: { t: "import", asset: ref.hash, body: -1 }, xf: place }),
    envelope: envelopeFn(local(meta.bbox[0]), local(meta.bbox[1]), xf, "the whole file"),
  };

  // body objects are only built when a design reads them: files can have hundreds
  let bodies: Obj[] | null = null;
  const bodyList = () =>
    (bodies ??= meta.bodies.map((b, i) => {
      const lo = local(b.bbox[0]);
      const hi = local(b.bbox[1]);
      return new Obj(
        {
          name: b.name,
          id: ids[i],
          index: i,
          product: b.product,
          kind: b.kind,
          color: b.color ?? DEFAULT_BODY_COLOR,
          ...boxFields(lo, hi, xf),
          volume: b.volume,
          shape: new ShapeV({ t: "xform", shape: { t: "import", asset: ref.hash, body: i }, xf: place }),
          envelope: envelopeFn(lo, hi, xf, b.name),
        },
        "body",
        b.name,
      );
    }));
  Object.defineProperty(fields, "bodies", { get: bodyList, enumerable: true });
  fields.body = new Fn(
    "body",
    (pos, named, ctx) => {
      const q = pos[0] ?? named.name;
      const list = bodyList();
      if (typeof q === "number") {
        const b = list[Math.round(q) - 1];
        return b ?? ctx.error(`body(${q}): the file has ${list.length} bodies, numbered from 1`);
      }
      if (typeof q !== "string") return ctx.error('body("name") finds a body by name, e.g. body("J1"), or by number from 1');
      const lower = q.toLowerCase();
      const hit =
        list.find((b) => String(b.fields.name).toLowerCase() === lower) ??
        list.find((b) => String(b.fields.name).toLowerCase().includes(lower)) ??
        list.find((b) => String(b.fields.product).toLowerCase().includes(lower));
      if (hit) return hit;
      const names = meta.bodies.slice(0, 12).map((b) => `"${b.name}"`);
      return ctx.error(`No body matching "${q}". Bodies: ${names.join(", ")}${meta.bodies.length > 12 ? `, … (${meta.bodies.length})` : ""}`);
    },
    'body("name") → one body of the file by name (or part of a name), or by number from 1',
  );
  return fields;
}
