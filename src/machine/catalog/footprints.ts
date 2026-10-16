// Footprints (copper pads, drill holes, outline) and 3D shapes for parts
// soldered to a circuit board. Both work in the footprint frame: millimetres,
// y up, seen from the side the part sits on, with z = 0 on that face of the
// board and the leads going down through it. Dimensions are the families'
// datasheet numbers; the pads follow common hand-soldering practice (big
// pads, 1 mm drills) so a beginner with a small iron gets good joints.

import type { PartRecipe, ShapeRecipe, V3 } from "../../kernel/recipe";
import type { CompSolid, LocalFields } from "../../library/components";
import type { Footprint, Pad } from "../pcb/types";
import type { CatalogPart, FootprintSpec } from "../types";
import { elecSize, filmSize, resistorBands } from "./values";

export interface PartValue {
  /** ohms or farads */
  value?: number;
  taper?: "A" | "B";
  capType?: "film" | "ceramic" | "electrolytic";
  vRating?: number;
}

const XP: V3 = [1, 0, 0];
const YP: V3 = [0, 1, 0];
const ZP: V3 = [0, 0, 1];

const TIN = "#c9ced6";
const BLACK = "#16191e";
const GOLD = "#d7b45a";
const STEEL = "#b9bfc7";

/** how far leads stick out below the board after trimming */
const LEAD_OUT = 1.5;

// ---------------- footprints ----------------

const circle = (pin: string, x: number, y: number, pad: number, drill: number, square = false): Pad => ({ pin, x, y, shape: square ? "rect" : "circle", w: pad, h: pad, drill });

/** Electrolytic, film and ceramic body sizes depend on the value. */
function radialSize(spec: Extract<FootprintSpec, { k: "radial" }>, v: PartValue) {
  if (v.value && v.vRating) return elecSize(v.value, v.vRating);
  return { d: spec.body_d, h: spec.body_h, pitch: spec.pitch };
}

function boxSize(spec: Extract<FootprintSpec, { k: "box" }>, v: PartValue) {
  if (v.capType === "film" && v.value) {
    const s = filmSize(v.value);
    return { w: s.w, t: s.t, h: s.h };
  }
  return { w: spec.body_w, t: spec.body_t, h: spec.body_h };
}

function dipPos(n: number, row: number, k: number): [number, number] {
  const half = n / 2;
  const top = ((half - 1) / 2) * 2.54;
  // pin 1 top left, counter-clockwise seen from above
  return k < half ? [-row / 2, top - k * 2.54] : [row / 2, -top + (k - half) * 2.54];
}

/** Pin centres of the Alpha 9 mm vertical pot, relative to its shaft. CW (pin 3) is the end the wiper reaches turned fully clockwise. */
export const POT9 = { pins: { CCW: [-7.5, 2.5], W: [-7.5, 0], CW: [-7.5, -2.5] } as Record<string, [number, number]>, tabs: [[0, 4.8], [0, -4.8]] as [number, number][], body: { x0: -6.5, x1: 4.85, y0: -4.75, y1: 4.75 }, body_h: 6.5, bush_d: 7, bush_l: 5, shaft_d: 6, shaft_l: 15 };

const TO220_BODY = { y0: -1.5, y1: 3.2, tab: 1.9, lift: 3 };

export function footprintFor(part: CatalogPart, v: PartValue = {}): Footprint | undefined {
  const s = part.footprint;
  if (!s) return undefined;
  switch (s.k) {
    case "axial": {
      const [a, b] = s.pins;
      const half = s.pitch / 2;
      return {
        name: `${part.id}`,
        pads: [circle(a, -half, 0, s.pad, s.drill, s.band === a), circle(b, half, 0, s.pad, s.drill, s.band === b)],
        body: { shape: "rect", x0: -s.body_l / 2, y0: -s.body_d / 2, x1: s.body_l / 2, y1: s.body_d / 2 },
        mark: s.band ? { x: (s.band === a ? -1 : 1) * (s.body_l / 2 - 0.5), y: 0, kind: "band" } : undefined,
        height: s.body_d + 0.3,
      };
    }
    case "radial": {
      const z = radialSize(s, v);
      const [a, b] = s.pins;
      const half = z.pitch / 2;
      const plusX = s.plus === b ? half : -half;
      return {
        name: `${part.id}_${z.d}x${z.h}`,
        pads: [circle(a, -half, 0, s.pad, s.drill, s.plus === a), circle(b, half, 0, s.pad, s.drill, s.plus === b)],
        body: { shape: "circle", cx: 0, cy: 0, r: z.d / 2 },
        mark: s.plus ? { x: plusX, y: Math.min(z.d / 2 - 0.7, z.pitch / 2 + 1.4), kind: "plus" } : undefined,
        height: z.h + 0.5,
      };
    }
    case "box": {
      const z = boxSize(s, v);
      const [a, b] = s.pins;
      const half = s.pitch / 2;
      return {
        name: `${part.id}_${z.w}x${z.t}`,
        pads: [circle(a, -half, 0, s.pad, s.drill), circle(b, half, 0, s.pad, s.drill)],
        body: { shape: "rect", x0: -z.w / 2, y0: -z.t / 2, x1: z.w / 2, y1: z.t / 2 },
        height: z.h + 0.3,
      };
    }
    case "dip": {
      const n = s.pins.length;
      const pads = s.pins.map((pin, k): Pad => {
        const [x, y] = dipPos(n, s.row, k);
        return { pin, num: String(k + 1), x, y, shape: k === 0 ? "rect" : "oval", w: 2.0, h: s.pad, drill: s.drill };
      });
      const len = (n / 2) * 2.54;
      const sx = s.socket ? s.row / 2 + 1.3 : 3.2;
      const sy = len / 2 + (s.socket ? 0.9 : 0.4);
      return {
        name: `DIP-${n}${s.socket ? "_socket" : ""}`,
        pads,
        body: { shape: "rect", x0: -sx, y0: -sy, x1: sx, y1: sy },
        mark: { x: 0, y: sy, kind: "pin1" },
        height: s.socket ? 7.6 : 4,
      };
    }
    case "inline": {
      const n = s.pins.length;
      const x0 = (-(n - 1) / 2) * s.pitch;
      const pads = s.pins.map((pin, k): Pad => {
        const x = x0 + k * s.pitch;
        if (s.style === "to220" || s.style === "to92") return { pin, num: String(k + 1), x, y: 0, shape: k === 0 ? "rect" : "oval", w: s.pad, h: s.pad_h ?? s.pad, drill: s.drill };
        return { ...circle(pin, x, 0, s.pad, s.drill, k === 0), num: String(k + 1) };
      });
      const halfW = (n * s.pitch) / 2;
      const body: Footprint["body"] =
        s.style === "to220"
          ? { shape: "rect", x0: -5.1, y0: TO220_BODY.y0, x1: 5.1, y1: TO220_BODY.y1 }
          : s.style === "to92"
            ? { shape: "rect", x0: -2.4, y0: -1.6, x1: 2.4, y1: 2.4 }
            : s.style === "terminal"
              ? { shape: "rect", x0: -halfW, y0: -3.8, x1: halfW, y1: 3.8 }
              : { shape: "rect", x0: -halfW, y0: -1.27, x1: halfW, y1: 1.27 };
      const height = s.style === "to220" ? TO220_BODY.lift + 15.9 : s.style === "to92" ? 7.5 : s.style === "terminal" ? 10 : 8.5;
      return { name: `${part.id}`, pads, body, mark: s.style === "terminal" || s.style.startsWith("header") ? undefined : { x: x0, y: body.shape === "rect" ? body.y0 - 0.8 : 0, kind: "pin1" }, height };
    }
    case "pot9": {
      const pads: Pad[] = [
        { pin: "CCW", num: "1", x: POT9.pins.CCW[0], y: POT9.pins.CCW[1], shape: "rect", w: 1.8, h: 1.8, drill: 1.0 },
        { pin: "W", num: "2", x: POT9.pins.W[0], y: POT9.pins.W[1], shape: "circle", w: 1.8, h: 1.8, drill: 1.0 },
        { pin: "CW", num: "3", x: POT9.pins.CW[0], y: POT9.pins.CW[1], shape: "circle", w: 1.8, h: 1.8, drill: 1.0 },
        // the bracket tabs: plated slots, soldered for strength (and grounded to screen the case)
        ...POT9.tabs.map(([x, y]): Pad => ({ pin: "MT", num: "", x, y, shape: "oval", w: 3.24, h: 2.72, drill: 1.1, slot: 1.8 })),
      ];
      return { name: "Alpha_9mm_vertical", pads, body: { shape: "rect", ...POT9.body }, height: POT9.body_h };
    }
    case "pads": {
      const pads = s.pads.map((p): Pad => ({ pin: p.pin, num: p.num, x: p.x, y: p.y, shape: p.num === s.square ? "rect" : "circle", w: s.pad, h: s.pad, drill: s.drill }));
      const d = part.geom.dims;
      const w = d.w ?? 10;
      const dd = d.d ?? 10;
      const h = part.geom.g === "board" ? s.lift + (d.t ?? 1.6) + Math.max(0, ...(part.geom.features ?? []).map((f) => f.h)) : Math.max(d.h ?? 3, d.cyl_h ?? 0);
      return { name: `${part.id}`, pads, body: { shape: "rect", x0: -w / 2, y0: -dd / 2, x1: w / 2, y1: dd / 2 }, height: h };
    }
  }
}

// ---------------- 3D ----------------

function solid(suffix: string, label: string, shapes: ShapeRecipe[], color: string, material: string): CompSolid {
  const recipe: PartRecipe = { base: shapes.length === 1 ? shapes[0] : { t: "union", shapes }, ops: [] };
  return { suffix, label, recipe, color, material };
}

/** a round lead from below the board up to height z */
const leadUp = (x: number, y: number, t: number, z: number, d = 0.6): ShapeRecipe => ({ t: "cyl", d, h: z + t + LEAD_OUT, at: [x, y, -t - LEAD_OUT], dir: ZP });
/** a flat lead (DIP, TO-220, headers) */
const flatLead = (x: number, y: number, t: number, z: number, w: number, d: number): ShapeRecipe => ({ t: "box", w, d, h: z + t + LEAD_OUT, at: [x, y, -t - LEAD_OUT], r: 0 });

function translateRecipe(r: PartRecipe, v: V3): PartRecipe {
  const mv = (s: ShapeRecipe): ShapeRecipe => ({ t: "xform", shape: s, xf: [{ op: "translate", v }] });
  return { base: r.base ? mv(r.base) : null, ops: r.ops.map((o) => ("shape" in o ? { ...o, shape: mv(o.shape) } : o)) };
}

export interface FootprintGeom {
  solids: CompSolid[];
  fields: LocalFields;
}

/**
 * The part as it sits on the board, in the footprint frame. `t` is the board
 * thickness (the leads go through it). `module` builds a plug-in module's own
 * shape (Arduino, display) in its frame, centre of its underside at the origin.
 */
export function footprintSolids(part: CatalogPart, v: PartValue, t: number, module?: () => CompSolid[]): FootprintGeom {
  const s = part.footprint!;
  const fp = footprintFor(part, v)!;
  const name = part.name;
  const leads = (z: number, d?: number) => fp.pads.filter((p) => p.pin !== "MT").map((p) => leadUp(p.x, p.y, t, z, d));
  const out: CompSolid[] = [];
  const fields: LocalFields = { scalars: { height: fp.height }, points: { center: [0, 0, 0], top: [0, 0, fp.height] }, dirs: { up: ZP } };
  for (const p of fp.pads) fields.points![`pin_${p.pin}`] = [p.x, p.y, 0];
  switch (s.k) {
    case "axial": {
      const zc = s.body_d / 2 + 0.3;
      const L = s.body_l;
      const half = s.pitch / 2;
      const body: ShapeRecipe[] = [{ t: "cyl", d: s.body_d, h: L, at: [-L / 2, 0, zc], dir: XP }];
      const isRes = part.kind === "resistor";
      // metal film resistors have fatter end caps
      if (isRes) for (const x0 of [-L / 2, L / 2 - 1.5]) body.push({ t: "cyl", d: s.body_d * 1.12, h: 1.5, at: [x0, 0, zc], dir: XP });
      out.push(solid("", name, body, s.color, isRes ? "Epoxy" : "Glass"));
      const lead: ShapeRecipe[] = [];
      for (const x of [-half, half]) {
        lead.push(leadUp(x, 0, t, zc));
        const x1 = x < 0 ? -L / 2 : L / 2;
        lead.push({ t: "cyl", d: 0.6, h: Math.abs(x1 - x) + 0.3, at: [Math.min(x, x1) - 0.15, 0, zc], dir: XP });
      }
      out.push(solid("leads", `${name} leads`, lead, TIN, "Tin"));
      if (isRes && v.value) {
        // colour bands, bunched toward the first pin, tolerance band apart at the other end
        const bands = resistorBands(v.value);
        const xs = [-L / 2 + 1.0, -L / 2 + 1.85, -L / 2 + 2.7, -L / 2 + 3.55, L / 2 - 1.0];
        const byColor = new Map<string, { name: string; xs: number[] }>();
        bands.forEach((b, i) => {
          const e = byColor.get(b.hex) ?? { name: b.name, xs: [] };
          e.xs.push(xs[i]);
          byColor.set(b.hex, e);
        });
        let i = 0;
        for (const [hex, e] of byColor) {
          const d = (e.xs[0] === xs[0] || e.xs[0] === xs[4]) ? s.body_d * 1.14 : s.body_d + 0.08;
          out.push(solid(`band${i++}`, `${name} ${e.name} band`, e.xs.map((x) => ({ t: "cyl", d, h: 0.45, at: [x - 0.225, 0, zc], dir: XP }) as ShapeRecipe), hex, "Paint"));
        }
      } else if (s.band) {
        const sign = s.band === s.pins[0] ? -1 : 1;
        out.push(solid("band", `${name} cathode band`, [{ t: "cyl", d: s.body_d + 0.06, h: 0.6, at: [sign * (L / 2 - 0.4) - 0.3, 0, zc], dir: XP }], s.band_color ?? "#d9d9d9", "Paint"));
      }
      fields.scalars!.body_l = L;
      break;
    }
    case "radial": {
      const z = radialSize(s, v);
      const lift = 0.5;
      out.push(solid("", name, [{ t: "cyl", d: z.d, h: z.h, at: [0, 0, lift], dir: ZP }], s.color, "PVC sleeve"));
      out.push(solid("top", `${name} can top`, [{ t: "cyl", d: z.d - 0.5, h: 0.2, at: [0, 0, lift + z.h], dir: ZP }], STEEL, "Aluminum 1100"));
      // the minus stripe on the sleeve
      const minusX = s.plus === s.pins[0] ? 1 : -1;
      out.push(solid("stripe", `${name} minus stripe`, [{ t: "box", w: 0.3, d: z.d * 0.38, h: z.h * 0.92, at: [minusX * (z.d / 2 - 0.1), 0, lift + z.h * 0.04], r: 0 }], "#c8ced8", "Paint"));
      out.push(solid("leads", `${name} leads`, leads(lift), TIN, "Tin"));
      fields.scalars!.d = z.d;
      fields.scalars!.h = z.h;
      break;
    }
    case "box": {
      const z = boxSize(s, v);
      const lift = 0.3;
      const ceramic = v.capType === "ceramic" || part.kind !== "capacitor";
      out.push(solid("", name, [{ t: "box", w: z.w, d: z.t, h: z.h, at: [0, 0, lift], r: ceramic ? Math.min(z.t / 2 - 0.05, 1.2) : 0.4 }], s.color, ceramic ? "Ceramic" : "Epoxy"));
      out.push(solid("leads", `${name} leads`, leads(lift + 0.5, 0.5), TIN, "Tin"));
      break;
    }
    case "dip": {
      const n = s.pins.length;
      const len = (n / 2) * 2.54;
      const chipZ = s.socket ? 3.9 : 0.8;
      if (s.socket) {
        const sw = s.row + 2.6;
        const sl = len + 1.8;
        out.push({
          suffix: "socket",
          label: `${name} socket`,
          color: "#202329",
          material: "PBT",
          recipe: { base: { t: "box", w: sw, d: sl, h: 3.4, at: [0, 0, 0], r: 0.2 }, ops: [{ op: "cut", shape: { t: "box", w: s.row - 3.4, d: sl - 3, h: 5, at: [0, 0, -1], r: 0 } }] },
        });
      }
      out.push({
        suffix: "",
        label: name,
        color: BLACK,
        material: "Epoxy",
        recipe: { base: { t: "box", w: 6.35, d: len + 0.15, h: 3.3, at: [0, 0, chipZ], r: 0 }, ops: [{ op: "cut", shape: { t: "cyl", d: 1.6, h: 1.4, at: [0, len / 2 + 0.07, chipZ + 2.1], dir: ZP } }] },
      });
      const legs: ShapeRecipe[] = [];
      for (let k = 0; k < n; k++) {
        const [x, y] = dipPos(n, s.row, k);
        legs.push(flatLead(x, y, t, chipZ + 1.2, 0.3, 0.5));
        legs.push({ t: "box", w: Math.abs(x) - 3.175 + 0.1, d: 0.5, h: 0.3, at: [Math.sign(x) * (3.175 + (Math.abs(x) - 3.175) / 2), y, chipZ + 1.2], r: 0 });
      }
      out.push(solid("legs", `${name} pins`, legs, TIN, "Tin"));
      break;
    }
    case "inline": {
      const n = s.pins.length;
      const x0 = (-(n - 1) / 2) * s.pitch;
      const xs = s.pins.map((_, k) => x0 + k * s.pitch);
      if (s.style === "to220") {
        const L = TO220_BODY.lift;
        out.push(solid("", name, [{ t: "box", w: 10, d: TO220_BODY.tab - TO220_BODY.y0, h: 9.2, at: [0, (TO220_BODY.y0 + TO220_BODY.tab) / 2, L], r: 0 }], BLACK, "Epoxy"));
        out.push({
          suffix: "tab",
          label: `${name} tab`,
          color: STEEL,
          material: "Copper",
          recipe: { base: { t: "box", w: 10.2, d: TO220_BODY.y1 - TO220_BODY.tab, h: 15.9, at: [0, (TO220_BODY.tab + TO220_BODY.y1) / 2, L], r: 0 }, ops: [{ op: "cut", shape: { t: "cyl", d: 3.7, h: 4, at: [0, TO220_BODY.tab - 1, L + 15.9 - 2.8], dir: YP } }] },
        });
        out.push(solid("leads", `${name} leads`, xs.map((x) => flatLead(x, 0, t, L + 0.5, 0.8, 0.5)), TIN, "Tin"));
        fields.points!.tab_hole = [0, TO220_BODY.y1, L + 15.9 - 2.8];
      } else if (s.style === "to92") {
        out.push({ suffix: "", label: name, color: BLACK, material: "Epoxy", recipe: { base: { t: "cyl", d: 4.8, h: 4.6, at: [0, 0.6, 3], dir: ZP }, ops: [{ op: "cut", shape: { t: "box", w: 6, d: 3, h: 6, at: [0, -2.3, 2.5], r: 0 } }] } });
        out.push(solid("leads", `${name} leads`, xs.map((x) => flatLead(x, 0, t, 3.2, 0.45, 0.4)), TIN, "Tin"));
      } else if (s.style === "terminal") {
        const w = n * s.pitch;
        const ops: PartRecipe["ops"] = [];
        for (const x of xs) {
          ops.push({ op: "cut", shape: { t: "box", w: 3.4, d: 3.4, h: 3.6, at: [x, -3.8 + 1.6, 2.2], r: 0 } });
          ops.push({ op: "cut", shape: { t: "cyl", d: 3.6, h: 3.2, at: [x, 0.6, 10 - 3.1], dir: ZP } });
        }
        out.push({ suffix: "", label: name, color: part.geom.color ?? "#2c6fd1", material: "Nylon", recipe: { base: { t: "box", w: w - 0.1, d: 7.6, h: 10, at: [0, 0, 0], r: 0.3 }, ops } });
        out.push(solid("screws", `${name} screws`, xs.map((x) => ({ t: "cyl", d: 3.4, h: 2.6, at: [x, 0.6, 10 - 3.2], dir: ZP }) as ShapeRecipe), STEEL, "Steel"));
        out.push(solid("leads", `${name} leads`, xs.map((x) => flatLead(x, 0, t, 1, 1.0, 0.6)), TIN, "Tin"));
        fields.points!.entry = [0, -3.8, 3.8];
      } else {
        const female = s.style === "header_f";
        const h = female ? 8.5 : 2.5;
        out.push({ suffix: "", label: name, color: BLACK, material: "PBT", recipe: { base: { t: "box", w: n * 2.54, d: 2.54, h, at: [0, 0, 0], r: 0 }, ops: female ? xs.map((x) => ({ op: "cut" as const, shape: { t: "box" as const, w: 1, d: 1, h: 3, at: [x, 0, h - 2.5] as V3, r: 0 } })) : [] } });
        out.push(solid("pins", `${name} pins`, xs.map((x) => flatLead(x, 0, t, female ? 1 : 8.5, 0.64, 0.64)), GOLD, "Brass"));
      }
      break;
    }
    case "pot9": {
      const P = POT9;
      const bw = P.body.x1 - P.body.x0;
      const bc = (P.body.x0 + P.body.x1) / 2;
      out.push(solid("", name, [{ t: "box", w: bw, d: P.body.y1 - P.body.y0, h: 2.8, at: [bc, 0, 0], r: 0 }], "#23272e", "PBT"));
      out.push(solid("case", `${name} case`, [{ t: "box", w: bw, d: P.body.y1 - P.body.y0, h: P.body_h - 2.8, at: [bc, 0, 2.8], r: 0 }, { t: "cyl", d: P.bush_d, h: P.bush_l, at: [0, 0, P.body_h], dir: ZP }], STEEL, "Steel"));
      out.push({ suffix: "shaft", label: `${name} shaft`, color: "#d4d8de", material: "Aluminum 6061", moving: true, recipe: { base: { t: "cyl", d: P.shaft_d, h: P.shaft_l, at: [0, 0, P.body_h + P.bush_l], dir: ZP }, ops: [{ op: "cut", shape: { t: "box", w: 0.8, d: P.shaft_d + 1, h: 8, at: [0, 0, P.body_h + P.bush_l + P.shaft_l - 7.9], r: 0 } }] } });
      const pins: ShapeRecipe[] = Object.values(P.pins).map(([x, y]) => flatLead(x, y, t, 1.2, 0.8, 0.4));
      for (const [x, y] of P.pins ? Object.values(P.pins) : []) pins.push({ t: "box", w: Math.abs(x - P.body.x0) + 0.4, d: 0.8, h: 0.4, at: [(x + P.body.x0) / 2, y, 0.9], r: 0 });
      for (const [x, y] of P.tabs) pins.push(flatLead(x, y, t, 2.8, 1.6, 0.5));
      out.push(solid("pins", `${name} pins`, pins, TIN, "Tin"));
      fields.points = {
        ...fields.points,
        face: [0, 0, P.body_h],
        bushing_top: [0, 0, P.body_h + P.bush_l],
        shaft_tip: [0, 0, P.body_h + P.bush_l + P.shaft_l],
      };
      fields.dirs = { up: ZP, axis: ZP };
      Object.assign(fields.scalars!, { body_h: P.body_h, bush_d: P.bush_d, bush_l: P.bush_l, shaft_d: P.shaft_d, shaft_l: P.shaft_l, panel_hole: 7.5 });
      break;
    }
    case "pads": {
      const g = part.geom;
      if (g.g === "board" && module) {
        for (const m of module()) out.push({ ...m, recipe: translateRecipe(m.recipe, [0, 0, s.lift]) });
        // header strips under the module: female sockets when it plugs in, a plastic spacer when soldered
        const rows = new Map<number, number[]>();
        for (const p of s.pads) rows.set(Math.round(p.y * 100) / 100, [...(rows.get(Math.round(p.y * 100) / 100) ?? []), p.x]);
        const strips: ShapeRecipe[] = [];
        const pins: ShapeRecipe[] = [];
        for (const [y, xs] of rows) {
          const lo = Math.min(...xs) - 1.27;
          const hi = Math.max(...xs) + 1.27;
          strips.push({ t: "box", w: hi - lo, d: 2.54, h: s.lift > 4 ? s.lift : 2.5, at: [(lo + hi) / 2, y, 0], r: 0 });
          for (const x of xs) pins.push(flatLead(x, y, t, s.lift + (g.dims.t ?? 1.6) + (s.lift > 4 ? 0 : 0.8), 0.64, 0.64));
        }
        out.push(solid("header", `${name} header`, strips, BLACK, "PBT"));
        out.push(solid("headerpins", `${name} header pins`, pins, GOLD, "Brass"));
        const top = s.lift + (g.dims.t ?? 1.6);
        fields.points!.module_top = [0, 0, top];
        for (const f of g.features ?? []) if (f.kind === "module") fields.points!.screen = [f.x, f.y, top + f.h];
        fields.scalars!.lift = s.lift;
      } else {
        const d = g.dims;
        out.push(solid("", name, [{ t: "box", w: d.w ?? 6, d: d.d ?? 6, h: d.h ?? 3.5, at: [0, 0, 0], r: 0.2 }], g.color ?? BLACK, "PBT"));
        if (d.cyl_d && d.cyl_h) {
          out.push(solid("actuator", `${name} actuator`, [{ t: "cyl", d: d.cyl_d, h: d.cyl_h - (d.h ?? 3.5), at: [0, 0, d.h ?? 3.5], dir: ZP }], g.color2 ?? "#3a3f47", "POM"));
          fields.points!.actuator_top = [0, 0, d.cyl_h];
          fields.scalars!.actuator_d = d.cyl_d;
        }
        out.push(solid("leads", `${name} leads`, fp.pads.map((p) => flatLead(p.x, p.y, t, 0.6, 0.7, 0.4)), TIN, "Tin"));
      }
      break;
    }
  }
  return { solids: out, fields };
}
