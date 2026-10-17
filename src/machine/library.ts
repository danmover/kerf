// Catalog parts as language components: lib.gearmotor("gobilda_5203_188"),
// lib.controller("arduino_nano"), lib.extrusion("vslot_2020", length: 300)
// and the generic lib.part("id"). Each component carries its specs as
// fields (drive.t_stall, drive.rpm_free...) so calculations can read them.

import type { V3 } from "../kernel/recipe";
import type { CompDef, LibArgs, LibEntry } from "../library/components";
import { CATALOG, CATALOG_KINDS, catalogOfKind, catalogPart } from "./catalog";
import { footprintFor, footprintSolids, type PartValue } from "./catalog/footprints";
import { ceramicDielectric, elecSize, longValue, parsePot, parseValue, shortValue } from "./catalog/values";
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
  belt: "Motion",
  coupler: "Motion",
  seal: "Seals",
  resistor: "Circuit board",
  capacitor: "Circuit board",
  potentiometer: "Circuit board",
  diode: "Circuit board",
  opamp: "Circuit board",
  terminal: "Circuit board",
  header: "Circuit board",
  display: "Circuit board",
  circuit_board: "Circuit board",
  jack: "Panel",
  knob: "Panel",
  amplifier: "Electronics",
  speaker: "Speaker",
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
  pulley: "Pulley on `axis`, `at` is the hub-side face. Fields: belt_center, end, pd, groove_w (contact_d for smooth idlers).",
  belt: "Timing belt round pulleys: see Belts below. No at: or axis: (the path places it).",
  coupler: "Shaft coupler along `axis`, `at` is the bore1 end. Fields: end, center.",
  hotend: "`at` is the nozzle tip, `axis` points up toward the mount. Fields: nozzle, mount_top, groove, sink_center.",
  extruder: "Filament drive bolted to a NEMA 17 face: `at` is the motor-side face centre, `axis` is the motor axis. Fields: filament_in, filament_out, top.",
  heated_bed: "Plate lying flat; `at` is the centre of the underside. Fields: top, holes.",
  fan: "Fan on `axis`; `at` is the intake face centre. Fields: outlet, holes.",
  seal: "Lip seal ring on `axis`; `at` is one face.",
  linear_bearing: "Linear bearing on `axis`; `at` is one face.",
  opamp: "Through-hole IC; place it on a board with `on:` (see lib.circuit_board).",
  diode: "Axial diode; place it on a board with `on:`. Pins A (anode) and K (cathode, the band).",
  terminal: "Screw terminal for off-board wires; place it on a board with `on:`. The wire entries face −y before rotation. Pins P1, P2 (P3).",
  display: "Display module on its header pins; place it on a board with `on:` (side: \"bottom\" to face a front panel). Fields: screen (centre of the glass), module_top.",
  jack: "Panel-mount jack or socket: `at` is the centre of the panel hole on the panel's front face, `axis` points out of the front. Fields: hole_d (drill the panel this size), back, depth.",
  knob: "Push-on knob: `at` is the centre of its underside, `axis` along the shaft. Fields: top, d, skirt_d.",
  speaker: "Speaker facing `axis`; `at` is the centre of the front of its mounting flange (against the back of the baffle). Fields: cutout_d (baffle hole), bolt_circle, holes (8 bolt positions), depth, back.",
  amplifier: "Amplifier board lying flat; `at` is the centre of the underside. Fields: top, holes, corners.",
};

/** reference designator letters by kind: R1, C4, U2, J3 */
const REF_PREFIX: Partial<Record<CatalogKind, string>> = {
  resistor: "R",
  capacitor: "C",
  potentiometer: "RV",
  diode: "D",
  opamp: "U",
  regulator: "U",
  controller: "A",
  display: "DS",
  terminal: "J",
  header: "J",
  switch: "SW",
  jack: "J",
};

function specFields(p: CatalogPart): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(p.specs)) out[k] = typeof v === "boolean" ? (v ? 1 : 0) : v;
  return out;
}

/** What the parts list calls a valued part: "Resistor 10 kΩ, metal film 1 % 0.25 W". */
function valuedDescription(p: CatalogPart, v: PartValue & { valueText?: string }): string {
  if (!v.value) return p.name;
  switch (p.kind) {
    case "resistor":
      return `Resistor ${longValue(v.value, "ohm")}, ${p.name.replace(/^Metal film resistor /, "metal film ")}`;
    case "potentiometer":
      return `Potentiometer ${v.taper ?? "B"}${shortValue(v.value, "ohm")} (${v.taper === "A" ? "audio/log" : "linear"}), ${p.name.replace(/ potentiometer/, "")}`;
    case "capacitor":
      if (v.capType === "electrolytic") {
        const z = elecSize(v.value, v.vRating ?? 25);
        return `Capacitor ${longValue(v.value, "farad")} ${v.vRating ?? 25} V electrolytic, ${z.d} × ${z.h} mm, ${z.pitch} mm pitch`;
      }
      if (v.capType === "ceramic") return `Capacitor ${longValue(v.value, "farad")} ceramic ${ceramicDielectric(v.value)} ${v.vRating ?? 50} V, 5 mm pitch`;
      return `Capacitor ${longValue(v.value, "farad")} polyester film ${v.vRating ?? 63} V, 5 mm pitch`;
    default:
      return p.name;
  }
}

/**
 * A part that solders to a circuit board: its shape comes from the footprint
 * (with the value deciding sizes and colour bands) and it can be placed on a
 * lib.circuit_board with on:.
 */
function makeBoardComponent(p: CatalogPart, v: PartValue & { valueText?: string }): CompDef {
  const fp = footprintFor(p, v)!;
  const fg = footprintSolids(p, v, 1.6, p.geom.g === "board" ? () => buildGeometry(p, {}).solids : undefined);
  const label = v.valueText ? `${v.valueText} ${p.kind}` : p.name;
  const scalars: Record<string, number | string> = { ...specFields(p), ...fg.fields.scalars, catalog_id: p.id, price: p.price_usd ?? 0 };
  if (v.value) scalars.value = v.value;
  if (v.vRating) scalars.v_rated = v.vRating;
  return {
    kind: p.kind,
    label,
    placement: "free",
    solids: fg.solids,
    fields: { ...fg.fields, scalars },
    bom: { description: valuedDescription(p, v), standard: p.mpn ? `${p.maker ?? ""} ${p.mpn}`.trim() : undefined, catalogId: p.id },
    catalog: { id: p.id },
    board: { footprint: fp, value: v.value, valueText: v.valueText, taper: v.taper, capType: v.capType, vRating: v.vRating, refPrefix: REF_PREFIX[p.kind] ?? "X" },
  };
}

export function makeCatalogComponent(p: CatalogPart, a: LibArgs): CompDef {
  if (p.footprint && p.geom.g === "pcb_part" && !p.valued) return makeBoardComponent(p, {});
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
    // modules that can also plug into a Kerf circuit board (Arduino Nano, displays)
    board: p.footprint
      ? {
          footprint: footprintFor(p)!,
          refPrefix: REF_PREFIX[p.kind] ?? "X",
          mounted: () => {
            const fg = footprintSolids(p, {}, 1.6, () => g.solids);
            return { solids: fg.solids, fields: { ...fg.fields, scalars: { ...specFields(p), ...fg.fields.scalars, catalog_id: p.id, price: p.price_usd ?? 0 } } };
          },
        }
      : undefined,
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

const ELEC_V = [6.3, 10, 16, 25, 35, 50, 63, 100];

function valueArg(a: LibArgs, unit: "ohm" | "farad", what: string, example: string): { value: number; text: string } {
  const raw = a.has("value") ? a.str("value") : "";
  const v = parseValue(raw, unit);
  if (!v) throw new Error(`${what} needs a value like ${example}${raw ? ` (got "${raw}")` : ""}`);
  return { value: v, text: shortValue(v, unit) };
}

/** lib.resistor("10k"), lib.capacitor("100n"), lib.pot("A500k"): valued parts placed on boards. */
const VALUED: Record<string, LibEntry> = {
  resistor: {
    signature: 'lib.resistor("10k") { on: board, at: (x, y), rotate: 0 }',
    doc: 'Through-hole 1 % metal film resistor with its value: "470", "4.7k" (or "4k7"), "1M". Place it on a lib.circuit_board with on:, at: (x, y) in mm from the board\'s bottom-left corner and rotate: degrees. Pins A and B. Fields: value (ohms).',
    positional: ["value"],
    params: ["value", "part"],
    group: GROUPS.resistor,
    machine: true,
    make(a) {
      const p = findOrThrow(a.str("part", "resistor_mf"), "resistor");
      const { value, text } = valueArg(a, "ohm", "lib.resistor()", '"10k" or "4.7k"');
      if (value < 1 || value > 10e6) throw new Error("Resistor values run from 1 Ω to 10 MΩ");
      return makeBoardComponent(p, { value, valueText: text });
    },
  },
  capacitor: {
    signature: 'lib.capacitor("100n", type: "film", v: 63) { on: board, at: (x, y), rotate: 0 }',
    doc: 'Through-hole capacitor with its value: "470p", "22n", "1u", "100u". type: "film" (signal path, 1 nF to 1 µF), "ceramic" (C0G up to 1 nF for tone circuits, X7R 100 nF for decoupling) or "electrolytic" (1 µF and up, polarised: pins PLUS and MINUS); left out it is ceramic up to 1 nF, film to 1 µF and electrolytic above. v: voltage rating (electrolytics: pick 1.5 × the voltage across it). Film and ceramic pins are A and B. Fields: value (farads), v_rated, d and h for electrolytics.',
    positional: ["value"],
    params: ["value", "type", "v"],
    group: GROUPS.capacitor,
    machine: true,
    make(a) {
      const { value, text } = valueArg(a, "farad", "lib.capacitor()", '"100n" or "10u"');
      const type = a.str("type", value <= 1e-9 + 1e-15 ? "ceramic" : value < 1e-6 - 1e-12 ? "film" : "electrolytic");
      if (type !== "film" && type !== "ceramic" && type !== "electrolytic") throw new Error('type: should be "film", "ceramic" or "electrolytic"');
      if (value < 1e-12 || value > 0.1) throw new Error("Capacitor values run from 1 pF to 100 000 µF");
      if (type === "electrolytic" && value < 0.1e-6) throw new Error('Electrolytics start at about 0.1 µF: use type: "film" or "ceramic" for smaller values');
      if (type === "film" && (value < 470e-12 || value > 10e-6)) throw new Error("Film capacitors here run from 470 pF to 10 µF");
      if (type === "ceramic" && value > 1e-6) throw new Error('Ceramics here go up to 1 µF: use type: "electrolytic" above that');
      const def = type === "electrolytic" ? 25 : type === "film" ? 63 : 50;
      const v = a.has("v") ? a.num("v") : def;
      if (!(v > 0)) throw new Error("v: the voltage rating must be greater than 0");
      if (type === "electrolytic" && !ELEC_V.includes(v)) throw new Error(`Electrolytics come in ${ELEC_V.join(", ")} V`);
      const p = findOrThrow(type === "electrolytic" ? "cap_elec" : type === "film" ? "cap_film" : "cap_ceramic", "capacitor");
      return makeBoardComponent(p, { value, valueText: text, capType: type, vRating: v });
    },
  },
  pot: {
    signature: 'lib.pot("A500k") { on: board, at: (x, y), rotate: 0, side: "bottom" }',
    doc: 'Alpha 9 mm vertical potentiometer: taper letter (A = audio/log for volume, B = linear) and value, e.g. "A500k", "B25k". On a board behind a front panel use side: "bottom" so the shaft points at the panel. at: is the shaft centre. Pins CCW (1), W (2, wiper), CW (3) and MT (mounting tabs). Fields: face (the body top the panel rests on), bushing_top, shaft_tip, axis, panel_hole (7.5), value.',
    positional: ["value"],
    params: ["value", "part"],
    group: GROUPS.potentiometer,
    machine: true,
    make(a) {
      const p = findOrThrow(a.str("part", "pot_alpha9"), "potentiometer");
      const raw = a.has("value") ? a.str("value") : "";
      const pv = parsePot(raw);
      if (!pv) throw new Error(`lib.pot() needs a taper and value like "A500k" (log) or "B25k" (linear)${raw ? ` (got "${raw}")` : ""}`);
      if (pv.ohms < 100 || pv.ohms > 2e6) throw new Error("Pot values run from 100 Ω to 2 MΩ");
      return makeBoardComponent(p, { value: pv.ohms, valueText: `${pv.taper}${shortValue(pv.ohms, "ohm")}`, taper: pv.taper });
    },
  },
  circuit_board: {
    signature: 'lib.circuit_board(w: 160, d: 60, holes: [(4, 4), (156, 4)], hole_d: 3.2, title: "Preamp") { at: (x, y, z), rotate: (rx, ry, rz) }',
    doc: "A circuit board Kerf lays out, routes and turns into Gerber files (2 layers, 1.6 mm, through-hole parts). Its local frame has the origin at the bottom-left corner of the underside, x along w, y along d, z up through the top face; `at` places that corner. Put parts on it with `on: board` and at: (x, y) in mm from that corner (rotate: degrees counter-clockwise seen from the top; side: \"bottom\" flips a part to the underside). Nets of on-board pins become copper; wire statements are off-board cables (land them on screw terminals). Fields: w, d, t, top, holes, corners.",
    params: ["w", "d", "t", "holes", "hole_d", "corner", "title"],
    group: "Circuit board",
    machine: true,
    make(a) {
      const w = a.num("w", 100);
      const d = a.num("d", 60);
      const t = a.num("t", 1.6);
      const hd = a.num("hole_d", 3.2);
      const corner = a.num("corner", 2);
      if (!(w >= 10 && w <= 400 && d >= 10 && d <= 400)) throw new Error("lib.circuit_board(): w and d should be 10 to 400 mm");
      if (t !== 1.6 && t !== 1.0 && t !== 1.2 && t !== 0.8 && t !== 2.0) throw new Error("t: board houses make 0.8, 1.0, 1.2, 1.6 (standard) or 2.0 mm boards");
      const holes2 = a.list2("holes") ?? [
        [4, 4],
        [w - 4, 4],
        [w - 4, d - 4],
        [4, d - 4],
      ];
      for (const [x, y] of holes2) if (x < hd / 2 || y < hd / 2 || x > w - hd / 2 || y > d - hd / 2) throw new Error(`holes: (${x}, ${y}) is off the board (holes are measured from the bottom-left corner)`);
      const p = findOrThrow("pcb_2layer", "circuit_board");
      const title = a.str("title", "Circuit board");
      return {
        kind: "circuit_board",
        label: title,
        placement: "free",
        solids: [
          {
            suffix: "",
            label: title,
            color: "#1d6b4b",
            material: "FR4",
            finish: "solder-mask",
            recipe: {
              base: { t: "box", w, d, h: t, at: [w / 2, d / 2, 0], r: Math.min(corner, w / 4, d / 4) },
              ops: holes2.map(([x, y]) => ({ op: "cut" as const, shape: { t: "cyl" as const, d: hd, h: t + 2, at: [x, y, -1] as V3, dir: [0, 0, 1] as V3 } })),
            },
          },
        ],
        fields: {
          scalars: { w, d, t, hole_d: hd, catalog_id: p.id, price: p.price_usd ?? 0 },
          points: { top: [w / 2, d / 2, t], bottom: [w / 2, d / 2, 0], center: [w / 2, d / 2, t / 2], origin: [0, 0, 0] },
          pointLists: {
            holes: holes2.map(([x, y]) => [x, y, 0] as V3),
            corners: [
              [0, 0, 0],
              [w, 0, 0],
              [w, d, 0],
              [0, d, 0],
            ],
          },
          dirs: { x: [1, 0, 0], y: [0, 1, 0], up: [0, 0, 1] },
        },
        bom: { description: `${title}: circuit board ${w} × ${d} mm, 2 layers, ${t} mm (order with the Gerber files in the build pack)`, catalogId: p.id },
        catalog: { id: p.id },
        circuitBoard: { w, d, t, corner, holes: holes2.map(([x, y]) => ({ x, y, d: hd })), title },
      };
    },
  },
};

/** lib.belt: placed by its path, so the evaluator lays it out (machine/belts.ts) instead of make(). */
const BELT: LibEntry = {
  signature: 'lib.belt("gt2_6mm", path: [clamp_a, motor_pulley, idler, clamp_b], tension: 15N, mass: 600, accel: 3000) { role: "x" }',
  doc: `Timing belt round its pulleys. path: the pulleys in the order the belt meets them, starting and ending at the two clamp points for an open belt (a carriage axis), or pulleys only for a closed loop; pulleys are lib.pulley components or lib.bearing used as a smooth idler. outside: [idler]: idlers the belt's back runs on. tension: installation tension (N). Load: mass (g) and accel (mm/s²) of what it moves, plus friction (N); or torque (N·mm at the drive pulley). drive: the driving pulley (default: the first pulley with a travel per turn). Ids: ${catalogOfKind("belt")
    .map((p) => p.id)
    .join(", ")}.`,
  positional: ["id"],
  params: ["id", "path", "outside", "tension", "mass", "accel", "friction", "torque", "force", "drive"],
  group: "Motion",
  machine: true,
  make() {
    throw new Error("lib.belt is laid out from its path");
  },
};

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
  belt: BELT,
  ...VALUED,
  potentiometer: VALUED.pot,
};

export function groupForCatalog(id: string): string | undefined {
  const p = catalogPart(id);
  return p ? GROUPS[p.kind] : undefined;
}
