// Parametric standard components. Each generator works in a local frame
// (axis along +Z, or mouth facing +X for connectors). The evaluator places
// the result and converts local fields to world coordinates.

import type { PartRecipe, ShapeRecipe, ThreadSpec3, V2, V3 } from "../kernel/recipe";
import { BEARINGS, THREADS, threadSpec, type ThreadSpec } from "./standards";
import {
  CIRCLIPS,
  GRADES,
  GRADE_IDS,
  HEADS,
  HEAD_TYPES,
  NUT_TYPES,
  STANDOFF_LENGTHS,
  gradeFrom,
  headDims,
  headsFor,
  insertDims,
  insertPrice,
  nutDims,
  nutPrice,
  screwDescription,
  screwKey,
  screwPrice,
  screwSearch,
  screwStandard,
  standoffDims,
  stockLengths,
  washerDims,
  washerPrice,
  type Grade,
  type HeadType,
  type NutType,
  type WasherType,
} from "./fasteners";
import { pitchDiameter, rootDiameter, tipDiameter } from "./gears";
import { CHAINS, CHAIN_IDS, sprocketPd, sprocketProfile, sprocketRoot, sprocketTip, toothWidth } from "../machine/chains";
import { MACHINE_LIBRARY } from "../machine/library";
import { SPRING_WIRE, springRate } from "./springs";
import type { SpringInfo } from "../core/model";
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
  fastener?: { headTop: V3; outward: V3; key: number; headD: number; size: string; tool?: string; toolD?: number; head?: string; length?: number; grade?: string; load?: number; shear?: number };
  gear?: { m: number; z: number; width: number; pa: number; bore: number };
  bearing?: { code: string; bore: number; od: number; width: number; dynamicLoadN: number };
  spring?: Omit<SpringInfo, "center" | "axis">;
  bom: { description: string; standard?: string; catalogId?: string; length?: number; price?: number; priceNote?: string; search?: string; key?: string };
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
  /** the fields of an object passed for this argument (a fastener chosen by calc.fastener) */
  obj?(name: string): Record<string, unknown> | undefined;
}

/** A fastener chosen by calc.fastener(), when one is passed as the size: lib.screw(joint). */
function chosen(a: LibArgs): Record<string, unknown> | undefined {
  const f = a.obj?.("size");
  return f && typeof f.size === "string" && typeof f.head === "string" ? f : undefined;
}

function gradeArg(a: LibArgs, def: Grade, allowed?: readonly Grade[]): Grade {
  const raw = a.has("grade") ? a.str("grade") : def;
  const g = gradeFrom(raw);
  if (!g) throw new Error(`grade: should be one of ${GRADE_IDS.map((x) => `"${x}"`).join(", ")} (got "${raw}")`);
  if (allowed && !allowed.includes(g)) throw new Error(`grade: "${g}" is not made in this form; use ${allowed.map((x) => `"${x}"`).join(", ")}`);
  return g;
}

/** hardware is sold in packs: the parts list shows the price of one */
const PACK_NOTE = "typical price each, bought in a pack";
/** Nuts and washers are not graded like screws: plain steel is just zinc plated. */
const partGrade = (g: Grade) => (g === "4.8" || g === "8.8" || g === "10.9" || g === "12.9" ? "steel, zinc plated" : GRADES[g].label);
const searchGrade = (g: Grade) => (g === "A2-70" ? "stainless" : g === "A4-80" ? "316 stainless" : g === "brass" || g === "nylon" ? g : "zinc plated");

const Z0: V3 = [0, 0, 0];
const ZP: V3 = [0, 0, 1];
const ZN: V3 = [0, 0, -1];

const STEEL = "#8b929c";
const fmt = (n: number) => String(Math.round(n * 100) / 100);
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

/** Nominal ISO metric thread for library hardware (no printing clearance). */
function isoThread(t: { d: number; pitch: number }): ThreadSpec3 {
  return { d: t.d, pitch: t.pitch, form: "iso", starts: 1, left: false, clearance: 0 };
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
    signature: 'lib.screw(M3, 12, head: "socket", grade: "A2-70", load: 0, shear: 0) { at: seat_point, axis: -Z }',
    doc: `Machine screw from the fastener catalogue. Args: size (M1.6 to M20 as M3, M2_5…, or inch sizes as text: "#4-40", "#6-32", "#8-32", "#10-24", "#10-32", "1/4-20", "5/16-18", "3/8-16", "1/2-13"), length (mm; for a countersunk head it includes the head), head, grade, load (tension it carries in use, N each), shear (N each). Or pass a fastener chosen by calc.fastener as the size: lib.screw(joint) takes its size, length, head, grade and load. head: ${HEAD_TYPES.map((h) => `"${h}" (${HEADS[h].standard})`).join(", ")}. grade: "12.9" (black steel, the socket default), "A2-70" (stainless, most other heads' default), "A4-80" (marine), "8.8", "10.9", "4.8", "brass", "nylon". \`at\` is where the underside of the head seats (the surface, for a countersunk head; the top of a set screw), \`axis\` points along the shank into the material. Fields: seat, tip, head_top, axis, length, size, head, head_d, head_h, key. Tool access, thread engagement and (with load:) strength are checked automatically; the parts list gets its price and where to buy.`,
    params: ["size", "length", "head", "grade", "load", "shear"],
    make(a) {
      const c = chosen(a);
      const t = c ? threadSpec(String(c.size))! : a.thread("size", "M3");
      const head = (a.has("head") ? a.str("head") : typeof c?.head === "string" ? c.head : "socket") as HeadType;
      const hd = HEAD_TYPES.includes(head) ? headDims(head, t) : null;
      if (!HEAD_TYPES.includes(head)) throw new Error(`head: should be one of ${HEAD_TYPES.map((h) => `"${h}"`).join(", ")}`);
      if (!hd) throw new Error(`${HEADS[head].noun} is not made in ${t.name}. ${t.name} comes as ${headsFor(t).map((h) => `"${h}"`).join(", ")}`);
      const L = a.has("length") ? a.num("length") : typeof c?.length === "number" ? c.length : 10;
      if (!(L > 0)) throw new Error("length must be greater than 0");
      const grade = gradeArg(a, typeof c?.grade === "string" ? (c.grade as Grade) : HEADS[head].grades[0], HEADS[head].grades);
      const load = a.has("load") ? a.num("load") : typeof c?.load_each === "number" ? c.load_each : 0;
      const shear = a.has("shear") ? a.num("shear") : typeof c?.shear_each === "number" ? c.shear_each : 0;
      const lengths = stockLengths(head, t);
      const stocked = lengths.some((x) => Math.abs(x - L) < 0.05);
      const g = GRADES[grade];
      const flat = head === "flat";
      const set = head === "set";
      // the shank starts under the head (in the material for a countersunk head)
      const z0 = flat ? hd.h : 0;
      const shank = L - z0;
      if (shank <= 0.5) throw new Error(`A ${t.name} countersunk screw is at least ${Math.ceil(hd.h + 1)} mm long: its length includes the ${hd.h} mm head`);
      // socket and low heads are threaded b = 2d + 12 from the tip when longer than that; the rest are fully threaded
      const b = head === "socket" || head === "low" ? 2 * t.d + 12 : shank;
      const threadLen = shank > b ? b : shank + 0.01;
      const ops: PartRecipe["ops"] = [];
      let base: ShapeRecipe;
      const socket = (key: number, depth: number, z: number) => ({ op: "cut" as const, shape: { t: "prism" as const, pts: hexPoints(key), h: depth, at: [0, 0, z - 0.01] as V3, dir: ZP, rot: 0 } });
      switch (head) {
        case "socket":
        case "low":
          base = { t: "cyl", d: hd.d, h: hd.h, at: [0, 0, -hd.h], dir: ZP };
          ops.push({ op: "fillet", r: Math.min(0.4, hd.h * 0.15), edges: "bottom" }, socket(hd.key, hd.h * 0.6, -hd.h));
          break;
        case "button":
          base = { t: "revolve", pts: [[0, 0], [hd.d / 2, 0], [hd.d / 2, -hd.h * 0.25], [hd.d * 0.38, -hd.h * 0.8], [hd.d * 0.2, -hd.h], [0, -hd.h]], at: Z0, dir: ZP };
          ops.push(socket(hd.key, hd.h * 0.65, -hd.h));
          break;
        case "pan":
        case "forming":
          base = { t: "revolve", pts: [[0, 0], [hd.d / 2, 0], [hd.d / 2, -hd.h * 0.55], [hd.d * 0.4, -hd.h * 0.92], [hd.d * 0.25, -hd.h], [0, -hd.h]], at: Z0, dir: ZP };
          // Torx recess, drawn as a six-lobed hexagon
          ops.push(socket(hd.d * 0.32, hd.h * 0.55, -hd.h));
          break;
        case "flat":
          base = { t: "cone", d1: hd.d, d2: t.d, h: hd.h, at: Z0, dir: ZP };
          ops.push(socket(hd.key, Math.min(hd.h * 0.9, hd.key), 0));
          break;
        case "hex":
          base = { t: "prism", pts: hexPoints(hd.af!), h: hd.h, at: [0, 0, -hd.h], dir: ZP, rot: 0 };
          ops.push({ op: "chamfer", r: Math.min(0.4, hd.af! * 0.04), edges: "bottom", cosmetic: true });
          break;
        case "set":
          // headless: the thread is the whole screw
          base = { t: "cyl", d: t.tap, h: 0.02, at: Z0, dir: ZP };
          break;
      }
      if (!set && shank > b) ops.push({ op: "add", shape: { t: "cyl", d: t.tap, h: shank - b + 0.01, at: [0, 0, z0 - 0.01], dir: ZP } });
      // the thread length: a plain tap-size cylinder in checks, the real thread in detail builds
      ops.push({ op: "add", shape: { t: "thread", spec: isoThread(t), length: threadLen, at: [0, 0, shank > b ? L - b : z0 - 0.01], dir: ZP, internal: false, lead: 0, fastD: t.tap } });
      if (set) ops.push(socket(hd.key, Math.min(L * 0.6, hd.key * 1.3), 0));
      const recipe: PartRecipe = { base: base!, ops };
      const spec = { thread: t, length: L, head, grade };
      const short = `${t.name}×${fmt(L)}${head === "socket" ? "" : ` ${head}`}`;
      const price = screwPrice(t, L, head, grade);
      return {
        kind: "screw",
        label: `${short} ${head === "socket" ? "SHCS" : HEADS[head].label}`,
        placement: "axis",
        solids: [{ suffix: "", label: short, recipe, color: g.color, material: g.material, finish: g.finish }],
        fields: {
          scalars: { length: L, size: t.name, head, grade, head_d: hd.d, head_h: hd.h, key: hd.key, load, shear },
          points: { seat: Z0, tip: [0, 0, L], head_top: [0, 0, flat || set ? 0 : -hd.h] },
          dirs: { axis: ZP },
        },
        fastener: { headTop: [0, 0, flat || set ? 0 : -hd.h], outward: ZN, key: hd.key || hd.toolD - 1.5, headD: hd.d, size: t.name, tool: hd.drive, toolD: hd.toolD, head, length: L, grade, load, shear },
        bom: { description: screwDescription(spec), standard: screwStandard(spec), price, priceNote: `${PACK_NOTE}${stocked ? "" : `; ${fmt(L)} mm is not a stocked length (${lengths.filter((x) => x < L).slice(-1)[0] ?? "-"} or ${lengths.find((x) => x > L) ?? "-"} are)`}`, search: screwSearch(spec), key: screwKey(spec) },
      };
    },
  },

  nut: {
    signature: 'lib.nut(M3, type: "hex", grade: "A2-70") { at: (x, y, z), axis: Z }',
    doc: `Nut. type: "hex" (ISO 4032), "nyloc" (nylon-insert lock nut, ISO 10511: for anything that shakes), "thin" (ISO 4035 jam nut), "flange" (DIN 6923, M5 to M12: spreads the load without a washer), "square" (DIN 562: a captive nut slid into a printed slot), "tslot20" (drop-in T-nut for 2020 profile slots, M3 to M5). Or pass a fastener from calc.fastener: lib.nut(joint). \`at\` is the centre of one face, it extends along \`axis\`. Fields: at, end, axis, af, height.`,
    params: ["size", "type", "grade"],
    make(a) {
      const c = chosen(a);
      const t = c ? threadSpec(String(c.size))! : a.thread("size", "M3");
      const type = (a.has("type") ? a.str("type") : typeof c?.nut === "string" && c.nut ? c.nut : "hex") as NutType;
      if (!NUT_TYPES.includes(type)) throw new Error(`type: should be one of ${NUT_TYPES.map((x) => `"${x}"`).join(", ")}`);
      const n = nutDims(type, t);
      if (!n) throw new Error(`A ${type} nut is not made in ${t.name}`);
      const grade = gradeArg(a, typeof c?.grade === "string" ? (c.grade as Grade) : "8.8");
      const g = GRADES[grade];
      const threadCut = { op: "cut" as const, shape: { t: "thread" as const, spec: isoThread(t), length: n.h + 0.2, at: [0, 0, -0.1] as V3, dir: ZP, internal: true, lead: 0, fastD: t.tap } };
      let recipe: PartRecipe;
      switch (type) {
        case "square":
          recipe = { base: { t: "box", w: n.af, d: n.af, h: n.h, at: Z0, r: 0 }, ops: [threadCut] };
          break;
        case "tslot20":
          // a neck that sits in the 6 mm slot opening (at: is its top, flush with the profile's face) above a body
          // under the slot's lips, its sides chamfered at 45° to fit the cavity; 11 mm long along local y (the slot)
          recipe = {
            base: { t: "box", w: 5.8, d: 11, h: 1.8, at: Z0, r: 0 },
            ops: [
              { op: "add", shape: { t: "prism", pts: [[-5, 1.79], [5, 1.79], [3.6, 4], [-3.6, 4]], h: 11, at: [0, -5.5, 0], dir: [0, 1, 0], rot: 0 } },
              { ...threadCut, shape: { ...threadCut.shape, length: n.h + 0.1 } },
            ],
          };
          break;
        case "flange":
          recipe = { base: { t: "cyl", d: n.flange!, h: n.h * 0.2, at: Z0, dir: ZP }, ops: [{ op: "add", shape: { t: "prism", pts: hexPoints(n.af), h: n.h * 0.8 + 0.01, at: [0, 0, n.h * 0.2 - 0.01], dir: ZP, rot: 0 } }, threadCut] };
          break;
        case "nyloc":
          recipe = { base: { t: "prism", pts: hexPoints(n.af), h: n.h * 0.72, at: Z0, dir: ZP, rot: 0 }, ops: [{ op: "add", shape: { t: "cyl", d: n.af * 0.95, h: n.h * 0.28 + 0.01, at: [0, 0, n.h * 0.72 - 0.01], dir: ZP } }, threadCut] };
          break;
        default:
          recipe = {
            base: { t: "prism", pts: hexPoints(n.af), h: n.h, at: Z0, dir: ZP, rot: 0 },
            // detailed builds break the corners on both faces; the hole is a plain tap-size bore in checks and the real thread in detail
            ops: [{ op: "chamfer", r: Math.min(0.4, n.af * 0.04), edges: { s: "or", a: ["top", "bottom"] }, cosmetic: true }, threadCut],
          };
      }
      const price = nutPrice(type, t, grade);
      const label = `${t.name} ${type === "hex" ? "nut" : type === "tslot20" ? "T-nut" : `${type} nut`}`;
      return {
        kind: "nut",
        label,
        placement: "axis",
        solids: [{ suffix: "", label, recipe, color: type === "tslot20" ? "#c9d1dc" : g.color, material: g.material, finish: grade === "A2-70" || grade === "A4-80" ? "machined" : "zinc-plated" }],
        fields: { scalars: { af: n.af, height: n.h, type }, points: { at: Z0, end: [0, 0, n.h] }, dirs: { axis: ZP } },
        bom: { description: `${n.label} ${t.name}, ${type === "tslot20" ? "steel, zinc plated" : partGrade(grade)}`, standard: n.standard, price, priceNote: PACK_NOTE, search: `${t.name} ${n.label.toLowerCase()} ${searchGrade(grade)}`, key: `nut|${t.name}|${type}|${grade}` },
      };
    },
  },

  washer: {
    signature: 'lib.washer(M3, type: "flat") { at: (x, y, z), axis: Z }',
    doc: 'Flat washer: type "flat" (ISO 7089, or SAE for inch sizes) or "large" (ISO 7093, about 3 × the screw size across: spreads a screw\'s or nut\'s load on plastic and wood, and covers slotted holes). Or pass a fastener from calc.fastener: lib.washer(joint). `at` is the centre of one face, it extends along `axis`. Fields: at, end, axis, id, od, thickness.',
    params: ["size", "type", "grade"],
    make(a) {
      const c = chosen(a);
      const t = c ? threadSpec(String(c.size))! : a.thread("size", "M3");
      const type = (a.has("type") ? a.str("type") : typeof c?.washer === "string" && c.washer ? c.washer : "flat") as WasherType;
      if (type !== "flat" && type !== "large") throw new Error('type: should be "flat" or "large"');
      const w = washerDims(type, t);
      if (!w) throw new Error(`A ${type} washer is not listed for ${t.name}`);
      const grade = gradeArg(a, typeof c?.grade === "string" ? (c.grade as Grade) : "8.8");
      const g = GRADES[grade];
      const price = washerPrice(type, t, grade);
      const label = `${t.name} ${type === "large" ? "large " : ""}washer`;
      return {
        kind: "washer",
        label,
        placement: "axis",
        solids: [{ suffix: "", label, recipe: { base: { t: "tube", od: w.od, id: w.id, h: w.h, at: Z0, dir: ZP }, ops: [] }, color: g.color, material: g.material, finish: grade === "A2-70" || grade === "A4-80" ? "machined" : "zinc-plated" }],
        fields: { scalars: { id: w.id, od: w.od, thickness: w.h }, points: { at: Z0, end: [0, 0, w.h] }, dirs: { axis: ZP } },
        bom: { description: `${w.label} ${t.name} (${fmt(w.id)} × ${fmt(w.od)} × ${fmt(w.h)} mm), ${partGrade(grade)}`, standard: w.standard, price, priceNote: PACK_NOTE, search: `${t.name} ${type === "large" ? "large flat washer" : "flat washer"} ${searchGrade(grade)}`, key: `washer|${t.name}|${type}|${grade}` },
      };
    },
  },

  insert: {
    signature: "lib.insert(M3, length: 5.7) { at: top_point, axis: -Z }",
    doc: "Brass heat-set threaded insert (M2 to M6). `at` is the top face, it extends along `axis` into the material. Model the receiving hole with hole(M3, fit: \"insert\") at least 1 mm deeper than the insert. length: a short or long variant (same hole). Or pass a fastener from calc.fastener: lib.insert(joint). Fields: at, bottom, axis, length, od.",
    params: ["size", "length"],
    make(a) {
      const c = chosen(a);
      const t = c ? threadSpec(String(c.size))! : a.thread("size", "M3");
      const ins = insertDims(t, a.has("length") ? a.num("length") : undefined);
      if (!ins) throw new Error(`There is no common heat-set insert for ${t.name} (M2 to M6): use a nut, a tapped hole or a thread-forming screw`);
      // modelled in its installed state: the knurl is melted into the hole wall
      const od = ins.hole;
      const recipe: PartRecipe = {
        base: { t: "tube", od, id: t.tap, h: ins.length, at: Z0, dir: ZP },
        ops: [],
      };
      const price = insertPrice(t);
      return {
        kind: "insert",
        label: `${t.name} heat-set insert`,
        placement: "axis",
        solids: [{ suffix: "", label: `${t.name} insert`, recipe, color: BRASS, material: "Brass", finish: "machined" }],
        fields: { scalars: { length: ins.length, od, hole_d: ins.hole }, points: { at: Z0, bottom: [0, 0, ins.length] }, dirs: { axis: ZP } },
        bom: { description: `Heat-set insert ${t.name}×${fmt(ins.length)}, brass (hole Ø${fmt(ins.hole)} mm)`, price, priceNote: PACK_NOTE, search: `${t.name} heat set insert brass ${fmt(ins.length)}mm`, key: `insert|${t.name}|${fmt(ins.length)}` },
      };
    },
  },

  spur_gear: {
    signature: "lib.spur_gear(m: 1, z: 20, width: 8, bore: 5) { at: (x, y, z), axis: Y, mesh: other_gear }",
    doc: "Involute spur gear, 20° pressure angle. Args: m (module), z (teeth), width, bore, hub_d, hub_l, backlash. `at` is the centre of one face, the gear extends along `axis`. Props: `spin: 1` marks the driving gear, `mesh: g` meshes with gear g (phase and speed are computed), `turns_with: g` locks it to g (compound gears), `rides: carrier` with `mesh: sun` makes a planet that turns round a still or turning sun as its carrier turns. Fields: m, z, pitch_d, tip_d, root_d, width, at, center, end, axis.",
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

  sprocket: {
    signature: 'lib.sprocket(z: 52, chain: "bike_11s", bore: 10) { at: (x, y, z), axis: Y, spin: 1 }',
    doc: `Roller-chain sprocket (chainring, cassette cog, jockey wheel or drive sprocket) with ISO 606 teeth for the chain it runs: z teeth, chain: the chain id (${CHAIN_IDS.join(", ")}), width (tooth width, default 0.93 × the chain's inner width), bore, hub_d, hub_l. \`at\` is the centre of one face and the teeth extend along \`axis\` (use the same axis for every sprocket on a chain). Props: \`spin: 1\` drives it, \`chain: other_sprocket\` turns it from that sprocket through the chain at z_other / z, the same way round (so other parts can turns_with: it); a sprocket on the chain's path with no motion of its own is turned by the chain (jockey wheels, idlers). rotate: turns its teeth about the axis; the chain seats its rollers in whatever gaps they meet. Fields: z, pitch, pd (pitch diameter), tip_d, root_d, width, at, center (middle of the teeth, where the chain runs), end, axis, seats (the tooth-gap centres on the pitch circle).`,
    positional: ["z"],
    params: ["z", "chain", "width", "bore", "hub_d", "hub_l"],
    group: "Motion",
    make(a) {
      const z = Math.round(a.num("z", 18));
      if (z < 6 || z > 150) throw new Error(`A sprocket needs 6 to 150 teeth (got ${z})`);
      const id = a.str("chain", "bike_11s");
      const c = CHAINS[id];
      if (!c) throw new Error(`chain: "${id}" is not a chain. Chains: ${CHAIN_IDS.join(", ")}`);
      const w = a.num("width", toothWidth(c));
      if (!(w > 0)) throw new Error("width must be greater than 0");
      if (w > c.inner - 0.05) throw new Error(`width: ${fmt(w)} mm teeth do not fit between the ${fmt(c.inner)} mm inner plates of the ${c.name}`);
      const bore = a.num("bore", 0);
      const hubD = a.num("hub_d", 0);
      const hubL = a.num("hub_l", 0);
      const root = sprocketRoot(c.pitch, z, c.roller);
      if (bore >= root - 2) throw new Error(`bore ${fmt(bore)} mm leaves no metal under the teeth (root diameter ${fmt(root)} mm)`);
      const pd = sprocketPd(c.pitch, z);
      const ops: PartRecipe["ops"] = [];
      if (hubD > 0 && hubL > 0) ops.push({ op: "add", shape: { t: "cyl", d: hubD, h: hubL + 0.01, at: [0, 0, w - 0.01], dir: ZP } });
      if (bore > 0) ops.push({ op: "cut", shape: { t: "cyl", d: bore, h: w + hubL + 2, at: [0, 0, -1], dir: ZP } });
      const recipe: PartRecipe = { base: { t: "extrude", p: sprocketProfile(c.pitch, z, c.roller), h: w, f: { o: Z0, u: [1, 0, 0], n: ZP }, twist: 0, scale: 1 }, ops };
      const seats: V3[] = Array.from({ length: z }, (_, i) => {
        const t = (2 * Math.PI * i) / z;
        return [(pd / 2) * Math.cos(t), (pd / 2) * Math.sin(t), w / 2];
      });
      return {
        kind: "sprocket",
        label: `Sprocket ${z}T`,
        placement: "axis",
        solids: [{ suffix: "", label: `Sprocket ${z}T`, recipe, color: "#c4c8ce", material: "Steel", finish: "machined" }],
        fields: {
          scalars: { z, pitch: c.pitch, pd, tip_d: sprocketTip(c.pitch, z, c.roller), root_d: root, width: w, bore, hub_l: hubL, chain: c.id },
          points: { at: Z0, center: [0, 0, w / 2], end: [0, 0, w + hubL] },
          dirs: { axis: ZP },
          pointLists: { seats },
        },
        bom: { description: `Sprocket, ${z} teeth, for ${c.name}`, search: `${z}T sprocket ${c.bike ? "bicycle " : ""}${c.pitch === 12.7 ? "1/2 inch pitch" : c.id.replace("_", " ")}` },
      };
    },
  },

  chain: {
    signature: 'lib.chain("bike_11s", path: [chainring, cog, upper_jockey, lower_jockey], outside: [upper_jockey], torque: 120Nm)',
    doc: `Roller chain round its sprockets, made of real links: rollers seat in the tooth gaps and the links move round with the sprockets in the motion preview. id: ${CHAIN_IDS.join(", ")}. path: the lib.sprocket components in the order the chain meets them (a closed loop). outside: sprockets the chain wraps the other way round (the upper jockey wheel of a derailleur, a back-side tensioner). drive: the driving sprocket (default: the first on the path that moves). torque: torque at the drive sprocket (N·mm, e.g. 120Nm for a rider's hard effort), for the pull check. links: the link count (default: the shortest even count that reaches round). The chain makes every other sprocket on its path turn at the right speed (or checks the speed they were given). Checks: speed match, chain line, wrap and teeth engaged, smallest sprocket, link count and slack, and pull against the chain's strength. Fields: links, length (pitch length), pitch, pull (N), ratio (drive to last sprocket).`,
    positional: ["id"],
    params: ["id", "path", "outside", "drive", "torque", "links"],
    group: "Motion",
    make() {
      throw new Error("lib.chain is laid out from its path");
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

  spring: {
    signature: "lib.spring(d: 1, od: 10, free: 30, coils: 8, installed: 24, working: 16) { at: (x, y, z), axis: Z }",
    doc: 'Helical compression spring in drawn spring wire. d: wire diameter; od: outside diameter; free: free length; coils: active coils; installed: its length once assembled (shorter than free gives preload); working: the shortest it gets in use; ends: "closed-ground" (default), "closed" or "plain"; wire: "music" (default), "stainless" or "bronze"; cycles: compressions in its life (default 1e6). `at` is the centre of its seat end, it extends along `axis` to its installed length. The springs check gives its rate, the forces at installed and working length, stress, coil bind, buckling and fatigue life. Fields: rate (N/mm), preload and force (N at installed and working length), solid (solid length), at, end, axis.',
    params: ["d", "od", "free", "coils", "installed", "working", "ends", "wire", "cycles"],
    make(a) {
      const d = a.num("d", 1);
      const od = a.num("od", 10);
      const free = a.num("free", 30);
      const coils = a.num("coils", 8);
      const installed = a.num("installed", free);
      const working = a.num("working", installed);
      const ends = a.str("ends", "closed-ground");
      const wire = a.str("wire", "music");
      const cycles = a.num("cycles", 1e6);
      if (!(d > 0) || !(od > 2 * d)) throw new Error("lib.spring: od must be more than twice the wire diameter d");
      if (!(coils >= 1) || coils > 150) throw new Error("lib.spring: coils (active coils) must be 1..150");
      if (!(installed > 0) || installed > free) throw new Error("lib.spring: installed length must be more than 0 and no more than the free length");
      if (!(working > 0) || working > installed) throw new Error("lib.spring: working length must be more than 0 and no more than the installed length");
      if (!["closed-ground", "closed", "plain"].includes(ends)) throw new Error('lib.spring: ends must be "closed-ground", "closed" or "plain"');
      const grade = SPRING_WIRE[wire];
      if (!grade) throw new Error(`lib.spring: wire must be ${Object.keys(SPRING_WIRE).map((k) => `"${k}"`).join(", ")}`);
      const calc = springRate({ d, od, coils, material: grade.material });
      const total = coils + (ends === "plain" ? 0 : 2);
      const solid = d * (ends === "closed-ground" ? total : total + 1);
      // the wire swept along a helix at its installed length (one even pitch: the closed ends are not drawn tighter)
      const h = Math.max(installed - d, d);
      const recipe: PartRecipe = { base: { t: "sweep", p: { t: "circle", d, c: [0, 0] }, path: { t: "helix", pitch: h / total, h, d: od - d, at: [0, 0, d / 2], dir: ZP, left: false }, rot: 0, frenet: false }, ops: [] };
      const label = `Spring ${fmt(d)}×${fmt(od)}×${fmt(free)} mm`;
      return {
        kind: "spring",
        label,
        placement: "axis",
        solids: [{ suffix: "", label, recipe, color: wire === "bronze" ? BRASS : STEEL, material: grade.material, finish: "polished" }],
        fields: {
          scalars: { rate: calc.k, preload: calc.k * (free - installed), force: calc.k * (free - working), solid, free, installed, working, d, od },
          points: { at: Z0, end: [0, 0, installed], center: [0, 0, installed / 2] },
          dirs: { axis: ZP },
        },
        spring: { d, od, free, installed, working, coils, ends: ends as "closed-ground", cycles },
        bom: { description: `Compression spring, ${grade.label}, wire Ø${fmt(d)} mm, OD ${fmt(od)} mm, free length ${fmt(free)} mm, ${fmt(coils)} active coils, ends ${ends}, rate ${fmt(calc.k)} N/mm` },
      };
    },
  },

  band: {
    signature: 'lib.band("EPDM", id: 30, cs: 2.5, around: post, holds: bracket, from: (-14, 5, 12), to: (14, 5, 12), pin: 4, lip: 1.5, open: Z)',
    doc: 'An O-ring or rubber band stretched round a tube, post or bar (around:) and hooked at both ends onto the part it holds there (holds:), the way bike-light and number mounts are held on. It is laid out round the wrapped part\'s real cross-section (an extrude, cylinder or tube), and behaves like rubber: Gent\'s hyperelastic law, the cord thinning as it stretches, relaxing over months, and friction round the tube. rubber: "EPDM" (outdoors), "NBR", "silicone" or "natural rubber"; id and cs: the O-ring\'s inside diameter and cord, mm; shore: hardness (A). from: and to: the two hook pins\' centres in the holds part\'s own coordinates (world coordinates without holds:): the loop end goes over the from: pin, round the far side of the tube, and is stretched over the to: pin\'s head; pin: their diameter, lip: how far the loop must stretch past its seat to get over each pin\'s head, open: the way each pin\'s free end points (a direction or a list of two; default along the tube). spread: makes both hooks double hooks, the way a rear light\'s band holds: from: and to: are then the middles of two prongs this far apart along the tube (pin: their diameter, open: the way they stick out), the two strands run round at the prongs\' heights instead of side by side, and each end turns over the top prong, down its far side and under the bottom one, so the band also stops what it holds rocking on the tube. Hooks at different heights along the tube are fine: the band climbs evenly round it from one to the other (a slant is warned about, and one steep enough to drag a loop off its pin fails), but level hooks hold best. hooked_on: the parts its hooks are on when they are not the holds part itself, like arms that swing on it to follow the tube (a part or a list): from: and to: stay in the holds part\'s coordinates, the band may lie against those parts, and they go on and come off with the holds part. Leave out from: and to: for a closed loop round everything (it cannot go round a post or bar that carries on both sides). carries: the mass it holds on (g), shock: the bumps it must ride, in g, saddle_mu: friction of the holds part on the tube (0.3). The springs, clips and bands checks give its stretch, pull, hand force to fit, hold on the tube, relaxation, weathering and whether it can be put on at all. Fields: tension (N in each strand), pull (N on each hook), fit_force (hand force to stretch it on), stretch, fit_stretch, length, free_length, wrap (degrees), squeeze (N onto the tube), cord, spread, from, to, from_pull, to_pull (force vectors on the hooks).',
    positional: ["rubber"],
    params: ["rubber", "id", "cs", "shore", "around", "holds", "hooked_on", "from", "to", "pin", "lip", "open", "spread", "axis", "carries", "shock", "saddle_mu"],
    group: "Bands",
    make() {
      throw new Error("lib.band is laid out round the parts it wraps");
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

  standoff: {
    signature: 'lib.standoff(M3, 10, type: "FF", grade: "brass") { at: bottom_point, axis: Z }',
    doc: `Hex standoff (spacer) that holds a circuit board or panel off a base: M2, M2_5, M3 or M4, length ${STANDOFF_LENGTHS.join(", ")} mm. type: "FF" (threaded inside at both ends: a screw from each side) or "MF" (a male stud under \`at\` screws into the base, a screw from above). grade: "brass" (default), "nylon" (insulating) or "A2-70". \`at\` is the centre of the bottom face, it extends along \`axis\`. Fields: top, bottom, stud_tip, length, af.`,
    params: ["size", "length", "type", "grade"],
    make(a) {
      const t = a.thread("size", "M3");
      const L = a.num("length", 10);
      const type = a.str("type", "FF");
      if (type !== "FF" && type !== "MF") throw new Error('type: should be "FF" (female both ends) or "MF" (male stud and female)');
      const sd = standoffDims(t);
      if (!sd) throw new Error(`Standoffs here come in M2, M2_5, M3 and M4, not ${t.name}`);
      if (!STANDOFF_LENGTHS.some((x) => Math.abs(x - L) < 0.05)) throw new Error(`Standoffs come in ${STANDOFF_LENGTHS.join(", ")} mm`);
      const grade = gradeArg(a, "brass", ["brass", "nylon", "A2-70"]);
      const g = GRADES[grade];
      const depth = Math.min(L / 2 - 0.3, 1.5 * t.d + 1);
      const ops: PartRecipe["ops"] = [{ op: "cut", shape: { t: "thread", spec: isoThread(t), length: depth + 0.1, at: [0, 0, L - depth], dir: ZP, internal: true, lead: 0, fastD: t.tap } }];
      if (type === "FF") ops.push({ op: "cut", shape: { t: "thread", spec: isoThread(t), length: depth + 0.1, at: [0, 0, -0.1], dir: ZP, internal: true, lead: 0, fastD: t.tap } });
      else ops.push({ op: "add", shape: { t: "thread", spec: isoThread(t), length: sd.stud + 0.01, at: [0, 0, -sd.stud], dir: ZP, internal: false, lead: 0, fastD: t.tap } });
      const price = Math.round((0.12 + 0.008 * L) * GRADES[grade].priceFactor * 100) / 100;
      const label = `${t.name}×${fmt(L)} standoff`;
      return {
        kind: "standoff",
        label,
        placement: "axis",
        solids: [{ suffix: "", label, recipe: { base: { t: "prism", pts: hexPoints(sd.af), h: L, at: Z0, dir: ZP, rot: 0 }, ops }, color: g.color, material: g.material, finish: grade === "nylon" ? "matte" : "machined" }],
        fields: { scalars: { length: L, af: sd.af, type }, points: { at: Z0, bottom: Z0, top: [0, 0, L], stud_tip: [0, 0, type === "MF" ? -sd.stud : 0] }, dirs: { axis: ZP } },
        bom: { description: `Hex standoff ${t.name} × ${fmt(L)} mm, ${type === "FF" ? "female–female" : `male–female (${sd.stud} mm stud)`}, ${g.label}`, price, priceNote: PACK_NOTE, search: `${t.name} ${fmt(L)}mm ${type === "FF" ? "female female" : "male female"} hex standoff ${grade}`, key: `standoff|${t.name}|${fmt(L)}|${type}|${grade}` },
      };
    },
  },

  corner_bracket: {
    signature: 'lib.corner_bracket("2020") { at: inside_corner, axis: Z, rotate: 0 }',
    doc: `Cast aluminium 90° corner bracket that joins two aluminium profiles (or a profile and a plate) at a right angle, held by an M5 screw into a T-nut in each profile's slot: "2020" (20 mm wide, one hole per leg) or "2040" (40 mm wide, two holes per leg, 20 mm apart). Its holes are slots from 8.5 to 12.5 mm out from the inside corner, so a screw can meet a 20 series profile's slot line. \`at\` is the inside corner (on the line where the two faces meet, at the middle of the bracket's width); leg A lies on the face whose outward normal is \`axis\` and runs along local +x (turn it about the axis with rotate:); leg B stands up along \`axis\` against the face that faces local +x. Fields: holes_a and holes_b (where each screw head sits; the screws go along into_a and into_b), into_a, into_b, leg_a (leg A's direction), thickness. place_fasteners puts the brackets, screws and T-nuts on every profile joint for you.`,
    params: ["size"],
    group: "Frame",
    make(a) {
      const size = a.str("size", "2020");
      if (size !== "2020" && size !== "2040") throw new Error('size: should be "2020" (one hole per leg) or "2040" (two holes per leg)');
      const W = size === "2040" ? 40 : 20;
      const L = 20;
      const t = 3;
      const ys = size === "2040" ? [-10, 10] : [0];
      const rib = 2;
      const ops: PartRecipe["ops"] = [
        { op: "add", shape: { t: "box", w: t, d: W, h: L, at: [t / 2, 0, 0], r: 0 } },
        // two side webs (local y): the triangle between the legs, clear of the screw heads
        ...[W / 2 - rib, -W / 2].map((y) => ({ op: "add" as const, shape: { t: "prism" as const, pts: [[-t + 0.01, t - 0.01], [-(L - 1), t - 0.01], [-t + 0.01, L - 1]] as V2[], h: rib, at: [0, y, 0] as V3, dir: [0, 1, 0] as V3, rot: 0 } })),
      ];
      // slotted holes: a screw anywhere from 8.5 to 12.5 mm out from the inside corner, to meet a slot
      for (const y of ys) {
        ops.push({ op: "cut", shape: { t: "rrect", w: 9.5, h: 5.5, r: 2.7, depth: t + 2, at: [10.5, y, -1], dir: ZP, center: false } });
        ops.push({ op: "cut", shape: { t: "rrect", w: 5.5, h: 9.5, r: 2.7, depth: t + 2, at: [-1, y, 10.5], dir: [1, 0, 0], center: false } });
      }
      const label = `${size} corner bracket`;
      return {
        kind: "corner_bracket",
        label,
        placement: "axis",
        solids: [{ suffix: "", label, recipe: { base: { t: "box", w: L, d: W, h: t, at: [L / 2, 0, 0], r: 0 }, ops }, color: "#b7bcc4", material: "Aluminum 6061", finish: "matte" }],
        fields: {
          scalars: { thickness: t, width: W, length: L, slot_from: 8.5, slot_to: 12.5 },
          points: { at: Z0, corner: Z0 },
          pointLists: { holes_a: ys.map((y) => [10.5, y, t] as V3), holes_b: ys.map((y) => [t, y, 10.5] as V3) },
          dirs: { axis: ZP, into_a: ZN, into_b: [-1, 0, 0], leg_a: [1, 0, 0] },
        },
        bom: {
          description: `${size} cast aluminium 90° corner bracket (${W} × ${L} × ${L} mm, ${ys.length * 2} × M5 holes)`,
          price: size === "2040" ? 3.5 : 2.05,
          priceNote: "typical price each (Maker Store, Core Electronics)",
          search: `${size} corner bracket aluminium extrusion`,
          key: `corner_bracket|${size}`,
        },
      };
    },
  },

  joining_plate: {
    signature: 'lib.joining_plate("L") { at: outer_corner, axis: face_normal, rotate: 0 }',
    doc: `Flat 3 mm aluminium joining plate for 20 series profiles whose faces sit flush (an upright standing on a base rail, both faces in one plane): "L" is the 90° five-hole plate, 60 × 60 mm with 20 mm arms and M5 holes 20 mm apart. It lies on the faces with \`at\` at the L's outer corner and \`axis\` the faces' outward normal; arm A runs along local +x (turn it with rotate:), arm B along local +y, the holes 10 mm in from the edges so each row meets a slot line. An M5 × 8 button screw into a T-nut goes in each hole. Fields: holes (where each screw head sits, on the plate's outer face), into (the screws' direction), arm_a, arm_b, thickness. place_fasteners puts these on flush joints where a corner bracket has no room.`,
    params: ["type"],
    group: "Frame",
    make(a) {
      const type = a.str("type", "L").toUpperCase();
      if (type !== "L") throw new Error('type: "L" (the 90° five-hole plate)');
      const t = 3;
      const holes: [number, number][] = [[10, 10], [30, 10], [50, 10], [10, 30], [10, 50]];
      const cut = (hs: [number, number][]) => hs.map(([x, y]) => ({ op: "cut" as const, shape: { t: "cyl" as const, d: 5.5, h: t + 2, at: [x, y, -1] as V3, dir: ZP } }));
      // two solids, one per arm, so the L's open corner is not counted as solid where things pass it (cable chains)
      const armA: PartRecipe = { base: { t: "box", w: 60, d: 20, h: t, at: [30, 10, 0], r: 0 }, ops: cut(holes.filter(([, y]) => y < 20)) };
      const armB: PartRecipe = { base: { t: "box", w: 20, d: 40, h: t, at: [10, 40, 0], r: 0 }, ops: cut(holes.filter(([, y]) => y > 20)) };
      const label = "90° joining plate (5 hole)";
      return {
        kind: "joining_plate",
        label,
        placement: "axis",
        solids: [
          { suffix: "", label, recipe: armA, color: "#2b2f36", material: "Aluminum 6061", finish: "anodized" },
          { suffix: "arm", label: `${label}, upright arm`, recipe: armB, color: "#2b2f36", material: "Aluminum 6061", finish: "anodized" },
        ],
        fields: {
          scalars: { thickness: t },
          points: { at: Z0 },
          pointLists: { holes: holes.map(([x, y]) => [x, y, t] as V3) },
          dirs: { axis: ZP, into: ZN, arm_a: [1, 0, 0], arm_b: [0, 1, 0] },
        },
        bom: {
          description: "90° joining plate for 20 series profile, 3 mm aluminium, 5 × M5 holes",
          price: 3.5,
          priceNote: "typical price each (Maker Store, Core Electronics)",
          search: "90 degree joining plate 2020 v-slot 5 hole",
          key: "joining_plate|L",
        },
      };
    },
  },

  circlip: {
    signature: "lib.circlip(8) { at: groove_center, axis: X }",
    doc: `External retaining ring (DIN 471) that stops a bearing, gear or wheel sliding off a shaft. Arg: shaft (diameter, mm: ${Object.keys(CIRCLIPS).join(", ")}). \`at\` is the centre of the groove on the shaft's axis, \`axis\` along the shaft. Cut its groove into the shaft part with \`cut clip.groove\`. Fields: groove (cutting tool), groove_d, groove_w, at, axis.`,
    positional: ["shaft"],
    params: ["shaft"],
    make(a) {
      const d = a.num("shaft", 8);
      const r = CIRCLIPS[d];
      if (!r) throw new Error(`DIN 471 retaining rings here fit shafts of ${Object.keys(CIRCLIPS).join(", ")} mm`);
      const label = `Retaining ring ${d} mm`;
      const price = Math.round((0.04 + 0.006 * d) * 100) / 100;
      return {
        kind: "circlip",
        label,
        placement: "axis",
        solids: [{ suffix: "", label, recipe: { base: { t: "tube", od: d + 2 * r.a * 0.75, id: r.groove, h: r.s, at: [0, 0, -r.s / 2], dir: ZP }, ops: [] }, color: "#3b4048", material: "Steel", finish: "black-oxide" }],
        fields: {
          scalars: { groove_d: r.groove, groove_w: r.m, shaft: d },
          points: { at: Z0 },
          dirs: { axis: ZP },
          shapes: { groove: { t: "tube", od: d + 2, id: r.groove, h: r.m, at: [0, 0, -r.m / 2], dir: ZP } },
        },
        bom: { description: `Retaining ring for ${d} mm shaft (groove Ø${fmt(r.groove)} × ${fmt(r.m)} mm), spring steel`, standard: "DIN 471", price, priceNote: PACK_NOTE, search: `DIN 471 ${d}mm external circlip`, key: `circlip|${d}` },
      };
    },
  },
};

// Purchasable catalog parts (controllers, motors, rails...) as lib.<kind>("id").
for (const [k, v] of Object.entries(MACHINE_LIBRARY)) if (!(k in LIBRARY)) LIBRARY[k] = v;

export const THREAD_NAMES = Object.keys(THREADS);
