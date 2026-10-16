// Parametric standard components. Each generator works in a local frame
// (axis along +Z, or mouth facing +X for connectors). The evaluator places
// the result and converts local fields to world coordinates.

import type { PartRecipe, ShapeRecipe, V2, V3 } from "../kernel/recipe";
import { BEARINGS, THREADS, type ThreadSpec } from "./standards";
import { pitchDiameter, rootDiameter, tipDiameter } from "./gears";
import { MACHINE_LIBRARY } from "../machine/library";
import type { Footprint } from "../machine/pcb/types";

export type Placement = "axis" | "facing" | "free";

export interface CompSolid {
  suffix: string; // "" for the main solid
  label: string;
  recipe: PartRecipe;
  color: string;
  material: string;
  /** surface finish id from library/materials (the material default if omitted) */
  finish?: string;
  /** solid rotates with the component's motion (e.g. a motor shaft) */
  moving?: boolean;
}

export interface LocalFields {
  points?: Record<string, V3>;
  dirs?: Record<string, V3>;
  pointLists?: Record<string, V3[]>;
  scalars?: Record<string, number | string>;
  shapes?: Record<string, ShapeRecipe>;
}

export interface CompDef {
  kind: string;
  label: string;
  placement: Placement;
  solids: CompSolid[];
  fields: LocalFields;
  fastener?: { headTop: V3; outward: V3; key: number; headD: number; size: string };
  gear?: { m: number; z: number; width: number; pa: number; bore: number };
  bearing?: { code: string; bore: number; od: number; width: number; dynamicLoadN: number };
  bom: { description: string; standard?: string; catalogId?: string; length?: number };
  /** catalog-backed purchasable part */
  catalog?: { id: string; length?: number; travel?: number };
  /** soldered to a circuit board (place it with on: board): footprint, value and reference prefix */
  board?: {
    footprint: Footprint;
    value?: number;
    valueText?: string;
    taper?: "A" | "B";
    capType?: "film" | "ceramic" | "electrolytic";
    vRating?: number;
    refPrefix: string;
    /** a module's shape when plugged into a board (on its headers), when it differs from its free-standing shape */
    mounted?: () => { solids: CompSolid[]; fields: LocalFields };
  };
  /** a circuit board designed in Kerf (lib.circuit_board): the frame parts are placed in */
  circuitBoard?: { w: number; d: number; t: number; corner: number; holes: { x: number; y: number; d: number }[]; title: string };
}

export interface LibArgs {
  num(name: string, def?: number): number;
  str(name: string, def?: string): string;
  thread(name: string, def?: string): ThreadSpec;
  list2(name: string): V2[] | undefined;
  has(name: string): boolean;
}

const Z0: V3 = [0, 0, 0];
const ZP: V3 = [0, 0, 1];
const ZN: V3 = [0, 0, -1];

const STEEL = "#8b929c";
const DARK_STEEL = "#3b4048";
const BRASS = "#c9a24b";

export interface LibEntry {
  doc: string;
  signature: string;
  make(a: LibArgs, phase: number): CompDef;
  /** argument names in positional order (built-in entries list theirs in the evaluator) */
  positional?: string[];
  /** every accepted argument name */
  params?: string[];
  /** default group in the part tree */
  group?: string;
  /** a purchasable catalog part: accepts the machine properties (role:, load:, buy:, price:) */
  machine?: boolean;
}

function hexPoints(af: number): V2[] {
  const r = af / Math.sqrt(3);
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    return [r * Math.cos(a), r * Math.sin(a)] as V2;
  });
}

export const LIBRARY: Record<string, LibEntry> = {
  bearing: {
    signature: 'lib.bearing("608") { at: (x, y, z), axis: Y }',
    doc: "Deep-groove ball bearing. Codes: 623 625 626 608 688 MR105 6000 6001 6002 6005 6200 6201 6205 6800 6801 6806 6808 6810 6812 (68xx are thin-section). `at` is the centre of one face, the bearing extends along `axis` by its width. Fields: bore, od, width, at, end, center, axis.",
    make(a) {
      const code = a.str("code", "608");
      const b = BEARINGS[code];
      if (!b) throw new Error(`Unknown bearing "${code}". Available: ${Object.keys(BEARINGS).join(", ")}`);
      const span = b.od - b.bore;
      const outerId = b.od - span * 0.36;
      const innerOd = b.bore + span * 0.32;
      const recipe: PartRecipe = {
        base: { t: "tube", od: b.od, id: outerId, h: b.width, at: Z0, dir: ZP },
        ops: [
          { op: "add", shape: { t: "tube", od: innerOd, id: b.bore, h: b.width, at: Z0, dir: ZP } },
          { op: "add", shape: { t: "tube", od: outerId + 0.05, id: innerOd - 0.05, h: b.width - 0.8, at: [0, 0, 0.4], dir: ZP } },
        ],
      };
      return {
        kind: "bearing",
        label: `Bearing ${code}`,
        placement: "axis",
        solids: [{ suffix: "", label: `Bearing ${code}`, recipe, color: "#c4c9d0", material: "Steel", finish: "machined" }],
        fields: {
          scalars: { bore: b.bore, od: b.od, width: b.width, code, load_n: b.dynamicLoadN },
          points: { at: Z0, end: [0, 0, b.width], center: [0, 0, b.width / 2] },
          dirs: { axis: ZP },
        },
        bearing: { code, bore: b.bore, od: b.od, width: b.width, dynamicLoadN: b.dynamicLoadN },
        bom: { description: `Deep groove ball bearing ${code} (${b.bore}x${b.od}x${b.width})`, standard: "ISO 15" },
      };
    },
  },

  screw: {
    signature: "lib.screw(M3, 12) { at: seat_point, axis: -Z }",
    doc: "ISO 4762 socket head cap screw. Args: size (M2 M2_5 M3 M4 M5 M6), length. `at` is where the underside of the head seats, `axis` points along the shank into the material. Fields: seat, tip, head_top, axis, length. Fastener access is checked automatically.",
    make(a) {
      const t = a.thread("size", "M3");
      const L = a.num("length", 10);
      const socket = hexPoints(t.key);
      const recipe: PartRecipe = {
        base: { t: "cyl", d: t.head_d, h: t.head_h, at: [0, 0, -t.head_h], dir: ZP },
        ops: [
          { op: "fillet", r: Math.min(0.4, t.head_h * 0.15), edges: "bottom" },
          { op: "cut", shape: { t: "prism", pts: socket, h: t.head_h * 0.6, at: [0, 0, -t.head_h - 0.01], dir: ZP, rot: 0 } },
          { op: "add", shape: { t: "cyl", d: t.tap, h: L, at: [0, 0, -0.01], dir: ZP } },
        ],
      };
      return {
        kind: "screw",
        label: `${t.name}×${L} SHCS`,
        placement: "axis",
        solids: [{ suffix: "", label: `${t.name}×${L}`, recipe, color: DARK_STEEL, material: "Steel", finish: "black-oxide" }],
        fields: {
          scalars: { length: L, size: t.name, head_d: t.head_d, head_h: t.head_h },
          points: { seat: Z0, tip: [0, 0, L], head_top: [0, 0, -t.head_h] },
          dirs: { axis: ZP },
        },
        fastener: { headTop: [0, 0, -t.head_h], outward: ZN, key: t.key, headD: t.head_d, size: t.name },
        bom: { description: `Socket head cap screw ${t.name}×${L}`, standard: "ISO 4762" },
      };
    },
  },

  nut: {
    signature: "lib.nut(M3) { at: (x, y, z), axis: Z }",
    doc: "ISO 4032 hex nut. `at` is the centre of one face, it extends along `axis`. Fields: at, end, axis, af, height.",
    make(a) {
      const t = a.thread("size", "M3");
      const recipe: PartRecipe = {
        base: { t: "prism", pts: hexPoints(t.nut_af), h: t.nut_h, at: Z0, dir: ZP, rot: 0 },
        ops: [{ op: "cut", shape: { t: "cyl", d: t.tap, h: t.nut_h + 0.2, at: [0, 0, -0.1], dir: ZP } }],
      };
      return {
        kind: "nut",
        label: `${t.name} nut`,
        placement: "axis",
        solids: [{ suffix: "", label: `${t.name} nut`, recipe, color: "#c9d1dc", material: "Steel", finish: "zinc-plated" }],
        fields: { scalars: { af: t.nut_af, height: t.nut_h }, points: { at: Z0, end: [0, 0, t.nut_h] }, dirs: { axis: ZP } },
        bom: { description: `Hex nut ${t.name}`, standard: "ISO 4032" },
      };
    },
  },

  insert: {
    signature: "lib.insert(M3) { at: top_point, axis: -Z }",
    doc: "Brass heat-set threaded insert. `at` is the top face, it extends along `axis` into the material. Model the receiving hole with hole(M3, fit: \"insert\"). Fields: at, bottom, axis, length, od.",
    make(a) {
      const t = a.thread("size", "M3");
      // modelled in its installed state: the knurl is melted into the hole wall
      const od = t.insert_d;
      const recipe: PartRecipe = {
        base: { t: "tube", od, id: t.tap, h: t.insert_l, at: Z0, dir: ZP },
        ops: [],
      };
      return {
        kind: "insert",
        label: `${t.name} heat-set insert`,
        placement: "axis",
        solids: [{ suffix: "", label: `${t.name} insert`, recipe, color: BRASS, material: "Brass", finish: "machined" }],
        fields: { scalars: { length: t.insert_l, od }, points: { at: Z0, bottom: [0, 0, t.insert_l] }, dirs: { axis: ZP } },
        bom: { description: `Heat-set insert ${t.name}×${t.insert_l}` },
      };
    },
  },

  spur_gear: {
    signature: "lib.spur_gear(m: 1, z: 20, width: 8, bore: 5) { at: (x, y, z), axis: Y, mesh: other_gear }",
    doc: "Involute spur gear, 20° pressure angle. Args: m (module), z (teeth), width, bore, hub_d, hub_l, backlash. `at` is the centre of one face, the gear extends along `axis`. Props: `spin: 1` marks the driving gear, `mesh: g` meshes with gear g (phase and speed are computed), `turns_with: g` locks it to g (compound gears). Fields: m, z, pitch_d, tip_d, root_d, width, at, center, end, axis.",
    make(a, phase) {
      const m = a.num("m", 1);
      const z = Math.round(a.num("z", 20));
      if (z < 6) throw new Error("A spur gear needs at least 6 teeth");
      if (m <= 0) throw new Error("Gear module must be positive");
      const w = a.num("width", 6);
      const bore = a.num("bore", 0);
      const hubD = a.num("hub_d", 0);
      const hubL = a.num("hub_l", 0);
      const pa = a.num("pa", 20);
      const backlash = a.num("backlash", 0.05);
      if (bore >= rootDiameter(m, z)) throw new Error(`Bore ${bore} mm is larger than the root diameter ${rootDiameter(m, z).toFixed(2)} mm`);
      const ops: PartRecipe["ops"] = [];
      if (hubD > 0 && hubL > 0) ops.push({ op: "add", shape: { t: "cyl", d: hubD, h: hubL + 0.01, at: [0, 0, w - 0.01], dir: ZP } });
      if (bore > 0) ops.push({ op: "cut", shape: { t: "cyl", d: bore, h: w + hubL + 2, at: [0, 0, -1], dir: ZP } });
      const recipe: PartRecipe = {
        base: { t: "gear", m, z, w, bore: 0, at: Z0, dir: ZP, phase, pa, backlash },
        ops,
      };
      return {
        kind: "spur_gear",
        label: `Spur gear m${m} z${z}`,
        placement: "axis",
        solids: [{ suffix: "", label: `Gear z${z}`, recipe, color: "#ecebe6", material: "POM", finish: "machined" }],
        fields: {
          scalars: { m, z, pitch_d: pitchDiameter(m, z), tip_d: tipDiameter(m, z), root_d: rootDiameter(m, z), width: w, bore, hub_l: hubL },
          points: { at: Z0, center: [0, 0, w / 2], end: [0, 0, w + hubL] },
          dirs: { axis: ZP },
        },
        gear: { m, z, width: w, pa, bore },
        bom: { description: `Spur gear module ${m}, ${z} teeth, ${w} mm face` },
      };
    },
  },

  nema17: {
    signature: "lib.nema17(length: 40) { at: face_center, axis: Y }",
    doc: "NEMA 17 stepper motor. `at` is the centre of the mounting face, the shaft points along `axis` and the body extends behind it. Fields: face, holes (4 M3 holes on a 31 mm square, on the face), hole_spacing, pilot_d (22), pilot_h (2), shaft_d (5), shaft_len (24), shaft_tip, body (42.3), length, axis. Add `spin: 1` to drive the mechanism from the shaft.",
    make(a) {
      const L = a.num("length", 40);
      const s = 42.3;
      const holes: V3[] = [
        [15.5, 15.5, 0],
        [-15.5, 15.5, 0],
        [-15.5, -15.5, 0],
        [15.5, -15.5, 0],
      ];
      const body: PartRecipe = {
        base: { t: "box", w: s, d: s, h: L, at: [0, 0, -L], r: 4 },
        ops: [
          { op: "add", shape: { t: "cyl", d: 22, h: 2, at: [0, 0, -0.01], dir: ZP } },
          ...holes.map((p) => ({ op: "cut" as const, shape: { t: "hole" as const, d: 2.5, depth: 4.5, at: p, dir: ZN } })),
        ],
      };
      const shaft: PartRecipe = {
        base: { t: "cyl", d: 5, h: 24, at: [0, 0, 1], dir: ZP },
        ops: [{ op: "chamfer", r: 0.4, edges: "top" }],
      };
      return {
        kind: "nema17",
        label: "NEMA 17 stepper",
        placement: "axis",
        solids: [
          { suffix: "", label: "NEMA 17 body", recipe: body, color: "#2a2e35", material: "Steel", finish: "powder-coated" },
          { suffix: "shaft", label: "Motor shaft", recipe: shaft, color: "#c3c8cf", material: "Stainless 304", finish: "polished", moving: true },
        ],
        fields: {
          scalars: { length: L, body: s, hole_spacing: 31, pilot_d: 22, pilot_h: 2, shaft_d: 5, shaft_len: 24 },
          points: { face: Z0, shaft_tip: [0, 0, 25], at: Z0 },
          pointLists: { holes },
          dirs: { axis: ZP },
        },
        bom: { description: `NEMA 17 stepper motor, ${L} mm body` },
      };
    },
  },

  pcb: {
    signature: "lib.pcb(w: 70, d: 50, t: 1.6, hole_inset: 3.5, hole_d: 3.2) { at: (x, y, z) }",
    doc: "Printed circuit board with four corner mounting holes (or `holes: [(x, y), ...]` relative to the board centre). `at` is the centre of the board's underside. Fields: w, d, t, top (point at board top centre), bottom, holes (points on the underside, one per hole), hole_d, corners.",
    make(a) {
      const w = a.num("w", 70);
      const d = a.num("d", 50);
      const t = a.num("t", 1.6);
      const inset = a.num("hole_inset", 3.5);
      const hd = a.num("hole_d", 3.2);
      const custom = a.list2("holes");
      const holes2: V2[] = custom ?? [
        [w / 2 - inset, d / 2 - inset],
        [-(w / 2 - inset), d / 2 - inset],
        [-(w / 2 - inset), -(d / 2 - inset)],
        [w / 2 - inset, -(d / 2 - inset)],
      ];
      const board: PartRecipe = {
        base: { t: "box", w, d, h: t, at: Z0, r: Math.min(1.5, w / 10, d / 10) },
        ops: holes2.map((p) => ({ op: "cut" as const, shape: { t: "cyl" as const, d: hd, h: t + 2, at: [p[0], p[1], -1] as V3, dir: ZP } })),
      };
      // a plausible component population, kept clear of the mounting holes
      const mcu = Math.min(10, w * 0.18, d * 0.25);
      const parts: ShapeRecipe[] = [
        { t: "box", w: mcu, d: mcu, h: 1.2, at: [-w * 0.08, 0, t], r: 0.3 },
        { t: "box", w: mcu * 0.5, d: mcu * 0.35, h: 1.0, at: [-w * 0.08 + mcu, d * 0.18, t], r: 0.2 },
        { t: "box", w: w * 0.16, d: d * 0.12, h: 2.2, at: [w * 0.12, -d * 0.2, t], r: 0.4 },
        { t: "cyl", d: Math.min(6, d * 0.12), h: 4, at: [w * 0.15, d * 0.18, t], dir: ZP },
        { t: "box", w: w * 0.3, d: 2.5, h: 8.5, at: [-w * 0.1, -d / 2 + inset + 4, t], r: 0.2 },
      ];
      const comps: PartRecipe = { base: { t: "union", shapes: parts }, ops: [] };
      return {
        kind: "pcb",
        label: `PCB ${w}×${d}`,
        placement: "free",
        solids: [
          { suffix: "", label: `PCB ${w}×${d}`, recipe: board, color: "#1d6b4b", material: "FR4", finish: "solder-mask" },
          { suffix: "parts", label: "PCB components", recipe: comps, color: "#20242b", material: "FR4", finish: "matte" },
        ],
        fields: {
          scalars: { w, d, t, hole_d: hd, component_h: 8.5 },
          points: { top: [0, 0, t], bottom: Z0, center: [0, 0, t / 2] },
          pointLists: {
            holes: holes2.map((p) => [p[0], p[1], 0] as V3),
            corners: [
              [w / 2, d / 2, 0],
              [-w / 2, d / 2, 0],
              [-w / 2, -d / 2, 0],
              [w / 2, -d / 2, 0],
            ],
          },
        },
        bom: { description: `Printed circuit board ${w}×${d}×${t} mm` },
      };
    },
  },

  usb_c: {
    signature: "lib.usb_c() { at: mouth_point, facing: X }",
    doc: "USB-C receptacle (mid-mount style). `at` is the centre of the bottom edge of the mouth, sitting on the PCB top; `facing` is the horizontal direction the plug enters from. Fields: opening (a ready-made cutting tool: `cut usb.opening`), opening_center, opening_w (9.4), opening_h (3.8), facing.",
    make(a) {
      const bw = 8.94;
      const bh = 3.26;
      const bl = 7.35;
      const ow = a.num("opening_w", 9.6);
      const oh = a.num("opening_h", 4.0);
      const recipe: PartRecipe = {
        base: { t: "box", w: bl, d: bw, h: bh, at: [-bl / 2, 0, 0], r: 0.6 },
        ops: [{ op: "cut", shape: { t: "rrect", w: 8.2, h: 2.4, r: 1.0, depth: 6, at: [0.01, 0, bh / 2], dir: [-1, 0, 0], center: false } }],
      };
      return {
        kind: "usb_c",
        label: "USB-C receptacle",
        placement: "facing",
        solids: [{ suffix: "", label: "USB-C", recipe, color: "#c0c5cc", material: "Stainless 304", finish: "brushed" }],
        fields: {
          scalars: { opening_w: ow, opening_h: oh, body_h: bh },
          points: { opening_center: [0, 0, bh / 2], at: Z0 },
          dirs: { facing: [1, 0, 0] },
          shapes: { opening: { t: "rrect", w: ow, h: oh, r: 1.4, depth: 25, at: [-1, 0, bh / 2], dir: [1, 0, 0], center: false } },
        },
        bom: { description: "USB Type-C receptacle" },
      };
    },
  },

  connector: {
    signature: "lib.connector(w: 12, h: 10, d: 14) { at: mouth_point, facing: -Y }",
    doc: "Generic panel connector body (barrel jack, RJ45, terminal block). `at` is the centre of the bottom edge of the mouth, `facing` is the direction the plug enters from. Fields: opening (cutting tool), opening_center, opening_w, opening_h, facing.",
    make(a) {
      const w = a.num("w", 9);
      const h = a.num("h", 11);
      const d = a.num("d", 14);
      const ow = a.num("opening_w", w + 0.6);
      const oh = a.num("opening_h", h + 0.6);
      const recipe: PartRecipe = { base: { t: "box", w: d, d: w, h, at: [-d / 2, 0, 0], r: 0.5 }, ops: [] };
      return {
        kind: "connector",
        label: "Connector",
        placement: "facing",
        solids: [{ suffix: "", label: "Connector", recipe, color: "#2c3038", material: "ABS", finish: "gloss" }],
        fields: {
          scalars: { opening_w: ow, opening_h: oh, w, h, d },
          points: { opening_center: [0, 0, h / 2], at: Z0 },
          dirs: { facing: [1, 0, 0] },
          shapes: { opening: { t: "rrect", w: ow, h: oh, r: 0.8, depth: 25, at: [-1, 0, h / 2], dir: [1, 0, 0], center: false } },
        },
        bom: { description: `Panel connector ${w}×${h}×${d} mm` },
      };
    },
  },

  dowel: {
    signature: "lib.dowel(d: 3, length: 12) { at: (x, y, z), axis: Z }",
    doc: "Hardened steel dowel pin (ISO 8734). Fields: at, tip, axis.",
    make(a) {
      const d = a.num("d", 3);
      const L = a.num("length", 12);
      const recipe: PartRecipe = { base: { t: "cyl", d, h: L, at: Z0, dir: ZP }, ops: [{ op: "chamfer", r: Math.min(0.3, d * 0.1), edges: "all" }] };
      return {
        kind: "dowel",
        label: `Dowel ${d}×${L}`,
        placement: "axis",
        solids: [{ suffix: "", label: `Dowel ${d}×${L}`, recipe, color: STEEL, material: "Steel", finish: "polished" }],
        fields: { scalars: { d, length: L }, points: { at: Z0, tip: [0, 0, L] }, dirs: { axis: ZP } },
        bom: { description: `Dowel pin ${d}×${L}`, standard: "ISO 8734" },
      };
    },
  },
};

// Purchasable catalog parts (controllers, motors, rails...) as lib.<kind>("id").
for (const [k, v] of Object.entries(MACHINE_LIBRARY)) if (!(k in LIBRARY)) LIBRARY[k] = v;

export const THREAD_NAMES = Object.keys(THREADS);
