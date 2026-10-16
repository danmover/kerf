// Catalog parts as language components: lib.gearmotor("gobilda_5203_188"),
// lib.controller("arduino_nano"), lib.extrusion("vslot_2020", length: 300)
// and the generic lib.part("id"). Each component carries its specs as
// fields (drive.t_stall, drive.rpm_free...) so calculations can read them.

import type { CompDef, LibArgs, LibEntry } from "../library/components";
import { CATALOG, CATALOG_KINDS, catalogOfKind, catalogPart } from "./catalog";
import { buildGeometry } from "./geometry";
import type { CatalogKind, CatalogPart } from "./types";

const GROUPS: Record<CatalogKind, string> = {
  controller: "Electronics",
  host: "Electronics",
  motor_driver: "Electronics",
  stepper_driver: "Electronics",
  sensor: "Electronics",
  regulator: "Power",
  battery: "Power",
  psu: "Power",
  switch: "Power",
  fuse: "Power",
  connector: "Power",
  gearmotor: "Drive",
  stepper: "Drive",
  servo: "Drive",
  actuator: "Drive",
  hotend: "Toolhead",
  extruder: "Toolhead",
  fan: "Toolhead",
  heated_bed: "Bed",
  extrusion: "Frame",
  rail: "Motion",
  rod: "Motion",
  linear_bearing: "Motion",
  lead_screw: "Motion",
  pulley: "Motion",
  coupler: "Motion",
  seal: "Seals",
};

const KIND_DOC: Partial<Record<CatalogKind, string>> = {
  gearmotor: "`at` is the centre of the mounting face, the output shaft points along `axis`, the body extends behind. Fields: face, shaft_tip, holes, body_center, back, shaft_d, shaft_len, body_d, length, plus specs (v_rated, rpm_free, t_stall in N·mm, i_stall, i_free, encoder_cpr).",
  stepper: "`at` is the centre of the mounting face, the shaft points along `axis`. Fields: face, shaft_tip, holes, pilot_d, body, length, plus specs (i_rated, t_hold in N·mm, r_phase, l_phase).",
  servo: "`at` is the top face at the output spline, the spline points along `axis`. Fields: spline_top, holes (on the mounting tabs), case_center, plus specs (t_stall).",
  actuator: "Linear actuator along `axis`; `at` is the rear mounting hole. Args: travel (extension, mm). Fields: rear, rod_end, stroke, ret_l, plus specs (f_max N).",
  controller: "Board lying flat; `at` is the centre of the underside. Fields: top, holes, corners, w, d, height.",
  host: "Board lying flat; `at` is the centre of the underside. Fields: top, holes, corners.",
  motor_driver: "Board lying flat; `at` is the centre of the underside. Fields: top, holes, corners, height.",
  stepper_driver: "Driver module; `at` is the centre of the underside.",
  sensor: "Module lying flat; `at` is the centre of the underside. Fields: top, holes.",
  regulator: "Module lying flat; `at` is the centre of the underside. Fields: top, holes.",
  battery: "Pack lying flat; `at` is the centre of the bottom face. Fields: top, center, w, d, h.",
  psu: "Box; `at` is the centre of the bottom face. Fields: top, holes.",
  extrusion: "Profile along `axis`, `at` is the centre of one end. Args: length (required). Fields: start, end, center.",
  rail: "Linear rail along `axis`, rail underside at `at`, carriage up along local Y. Args: length (required), travel (carriage position). Fields: carriage_top, carriage_holes, end.",
  rod: "Round bar along `axis`, `at` is one end. Args: length (required).",
  lead_screw: "Screw along `axis`, `at` is one end. Args: length (required), travel (nut position). Fields: nut_face, nut_bottom, nut_holes, end.",
  pulley: "Pulley on `axis`, `at` is the hub-side face. Fields: belt_center, end, pd.",
  coupler: "Shaft coupler along `axis`, `at` is the bore1 end. Fields: end, center.",
  hotend: "`at` is the nozzle tip, `axis` points up toward the mount. Fields: nozzle, mount_top, groove, sink_center.",
  extruder: "Filament drive bolted to a NEMA 17 face: `at` is the motor-side face centre, `axis` is the motor axis. Fields: filament_in, filament_out, top.",
  heated_bed: "Plate lying flat; `at` is the centre of the underside. Fields: top, holes.",
  fan: "Fan on `axis`; `at` is the intake face centre. Fields: outlet, holes.",
  seal: "Lip seal ring on `axis`; `at` is one face.",
  linear_bearing: "Linear bearing on `axis`; `at` is one face.",
};

function specFields(p: CatalogPart): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(p.specs)) out[k] = typeof v === "boolean" ? (v ? 1 : 0) : v;
  return out;
}

export function makeCatalogComponent(p: CatalogPart, a: LibArgs): CompDef {
  const length = a.has("length") ? a.num("length") : undefined;
  const travel = a.has("travel") ? a.num("travel") : undefined;
  if (p.cut_to_length && length === undefined) throw new Error(`${p.name} is cut to length: give it a length, e.g. lib.${p.kind}("${p.id}", length: 300)`);
  if (length !== undefined && !(length > 0)) throw new Error("length must be greater than 0");
  const g = buildGeometry(p, { length, travel });
  const desc = p.cut_to_length && length ? `${p.name}, cut to ${Math.round(length)} mm` : p.name;
  return {
    kind: p.kind,
    label: p.name,
    placement: g.placement,
    solids: g.solids,
    fields: { ...g.fields, scalars: { ...specFields(p), ...g.fields.scalars, catalog_id: p.id, price: p.price_usd ?? 0 } },
    bom: { description: desc, standard: p.mpn ? `${p.maker ?? ""} ${p.mpn}`.trim() : undefined, catalogId: p.id, length },
    catalog: { id: p.id, length, travel },
  };
}

function findOrThrow(id: string, kind?: string): CatalogPart {
  const p = catalogPart(id);
  if (!p) {
    const options = (kind ? catalogOfKind(kind) : CATALOG).map((x) => x.id);
    throw new Error(`No catalog part "${id}". ${kind ? `${kind} parts` : "Parts"}: ${options.join(", ")}`);
  }
  if (kind && p.kind !== kind) throw new Error(`"${id}" is a ${p.kind}, not a ${kind}. Use lib.${p.kind}("${id}") or lib.part("${id}").`);
  return p;
}

const POS = ["id"];
const PARAMS = ["id", "length", "travel"];

function kindEntry(kind: CatalogKind): LibEntry {
  const ids = catalogOfKind(kind).map((p) => p.id);
  return {
    signature: `lib.${kind}("${ids[0]}") { at: (x, y, z) }`,
    doc: `Purchasable ${kind.replace(/_/g, " ")} from the parts catalog. ${KIND_DOC[kind] ?? ""} Ids: ${ids.join(", ")}.`,
    positional: POS,
    params: PARAMS,
    group: GROUPS[kind],
    machine: true,
    make(a) {
      return makeCatalogComponent(findOrThrow(a.str("id"), kind), a);
    },
  };
}

export const MACHINE_LIBRARY: Record<string, LibEntry> = {
  part: {
    signature: 'lib.part("id") { at: (x, y, z) }',
    doc: "Any purchasable part from the parts catalog by id (see the catalog table). Same fields and properties as its lib.<kind> form.",
    positional: POS,
    params: PARAMS,
    machine: true,
    make(a) {
      return makeCatalogComponent(findOrThrow(a.str("id")), a);
    },
  },
  ...Object.fromEntries(CATALOG_KINDS.map((k) => [k, kindEntry(k)])),
};

export function groupForCatalog(id: string): string | undefined {
  const p = catalogPart(id);
  return p ? GROUPS[p.kind] : undefined;
}
