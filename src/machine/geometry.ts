// 3D shapes for catalog parts. Each class works in a local frame and reads
// the dimensions documented above its generator. Purchased parts are
// modelled to their envelope and mounting interface (holes, shafts, pilots,
// connectors): the things a design has to fit around and fasten to.

import type { PartRecipe, ShapeRecipe, V2, V3 } from "../kernel/recipe";
import type { CompSolid, LocalFields, Placement } from "../library/components";
import type { CatalogPart } from "./types";
import { footprintSolids } from "./catalog/footprints";

const Z0: V3 = [0, 0, 0];
const ZP: V3 = [0, 0, 1];
const ZN: V3 = [0, 0, -1];
const XP: V3 = [1, 0, 0];
const YP: V3 = [0, 1, 0];

const DARK = "#23272e";
const STEEL = "#b9bfc7";
const ALU = "#c4c9d0";
const PCB = "#1d6b4b";
const BLACK = "#16191e";

export interface GeomResult {
  placement: Placement;
  solids: CompSolid[];
  fields: LocalFields;
}

export interface GeomArgs {
  /** cut length for stock items */
  length?: number;
  /** carriage / nut position along a rail or lead screw, mm from `at` */
  travel?: number;
}

const num = (d: Record<string, number>, k: string, def: number) => (typeof d[k] === "number" ? d[k] : def);

function circlePts(n: number, r: number, start = 0): V3[] {
  return Array.from({ length: n }, (_, i) => {
    const a = ((start + (360 * i) / n) * Math.PI) / 180;
    return [r * Math.cos(a), r * Math.sin(a), 0] as V3;
  });
}

function solid(suffix: string, label: string, recipe: PartRecipe, color: string, material: string, moving?: boolean): CompSolid {
  return { suffix, label, recipe, color, material, moving };
}

export function buildGeometry(p: CatalogPart, a: GeomArgs): GeomResult {
  const g = p.geom;
  const d = g.dims;
  switch (g.g) {
    // board: w (X), d (Y), t (thickness). `at` is the centre of the underside.
    // features sit on the top face; holes are through the board.
    case "board": {
      const w = num(d, "w", 50);
      const dd = num(d, "d", 30);
      const t = num(d, "t", 1.6);
      const holes = g.holes ?? [];
      const hd = g.hole_d ?? 3.2;
      const board: PartRecipe = {
        base: { t: "box", w, d: dd, h: t, at: Z0, r: Math.min(1, w / 10, dd / 10) },
        ops: holes.map(([x, y]) => ({ op: "cut" as const, shape: { t: "cyl" as const, d: hd, h: t + 2, at: [x, y, -1] as V3, dir: ZP } })),
      };
      const feats: ShapeRecipe[] = (g.features ?? []).map((f) => ({ t: "box", w: f.w, d: f.d, h: f.h, at: [f.x, f.y, t] as V3, r: 0 }));
      const solids = [solid("", p.name, board, g.color ?? PCB, "FR4")];
      if (feats.length) solids.push(solid("parts", `${p.name} components`, { base: feats.length === 1 ? feats[0] : { t: "union", shapes: feats }, ops: [] }, g.color2 ?? DARK, "FR4"));
      const height = t + Math.max(0, ...(g.features ?? []).map((f) => f.h));
      return {
        placement: "free",
        solids,
        fields: {
          scalars: { w, d: dd, t, height, hole_d: hd },
          points: { top: [0, 0, t], bottom: Z0, center: [0, 0, t / 2] },
          pointLists: {
            holes: holes.map(([x, y]) => [x, y, 0] as V3),
            corners: [
              [w / 2, dd / 2, 0],
              [-w / 2, dd / 2, 0],
              [-w / 2, -dd / 2, 0],
              [w / 2, -dd / 2, 0],
            ],
          },
        },
      };
    }

    // gearmotor: the output shaft sits on the local Z axis and `at` is the
    // centre of the mounting face. gear_d/gear_l gearbox, motor_d/motor_l can,
    // enc_l encoder cap, shaft_d/shaft_l output shaft, shaft_offset moves the
    // body off the shaft axis along -X (offset-shaft spur gearboxes),
    // boss_d/boss_h pilot boss, hole_circle/hole_n/hole_d/hole_start face holes.
    case "gearmotor": {
      const gd = num(d, "gear_d", 37);
      const gl = num(d, "gear_l", 25);
      const md = num(d, "motor_d", 35);
      const ml = num(d, "motor_l", 40);
      const el = num(d, "enc_l", 0);
      const sd = num(d, "shaft_d", 6);
      const sl = num(d, "shaft_l", 20);
      const off = num(d, "shaft_offset", 0);
      const bd = num(d, "boss_d", 0);
      const bh = num(d, "boss_h", 0);
      const c: V3 = [-off, 0, 0];
      const ops: PartRecipe["ops"] = [
        { op: "add", shape: { t: "cyl", d: md, h: ml + 0.02, at: [c[0], 0, -gl - ml], dir: ZP } },
      ];
      if (el > 0) ops.push({ op: "add", shape: { t: "cyl", d: md * 0.92, h: el + 0.02, at: [c[0], 0, -gl - ml - el], dir: ZP } });
      if (bd > 0 && bh > 0) ops.push({ op: "add", shape: { t: "cyl", d: bd, h: bh, at: [0, 0, -0.01], dir: ZP } });
      const holes = faceHoles(g, d);
      for (const h of holes) ops.push({ op: "cut", shape: { t: "cyl", d: num(d, "hole_d", 2.5), h: 6, at: [h[0], h[1], -6 + 0.01], dir: ZP } });
      const body: PartRecipe = { base: { t: "cyl", d: gd, h: gl, at: [c[0], 0, -gl], dir: ZP }, ops };
      // a D flat `shaft_flat` deep along the outer 80% of the shaft
      const flat = num(d, "shaft_flat", 0);
      const shaft: PartRecipe = { base: { t: "cyl", d: sd, h: sl, at: [0, 0, bh], dir: ZP }, ops: flat > 0 ? [{ op: "cut", shape: { t: "box", w: sd + 1, d: sd, h: sl * 0.8 + 1, at: [0, sd - flat, bh + sl * 0.2], r: 0 } }] : [] };
      return {
        placement: "axis",
        solids: [solid("", p.name, body, g.color ?? "#3a3f47", "Steel"), solid("shaft", `${p.name} shaft`, shaft, STEEL, "Steel", true)],
        fields: {
          scalars: { shaft_d: sd, shaft_len: sl, body_d: Math.max(gd, md), length: gl + ml + el, gear_d: gd, shaft_offset: off },
          points: { face: Z0, at: Z0, shaft_tip: [0, 0, bh + sl], body_center: [c[0], 0, -(gl + ml + el) / 2], back: [c[0], 0, -(gl + ml + el)] },
          pointLists: { holes: holes.map(([x, y]) => [x, y, 0] as V3) },
          dirs: { axis: ZP },
        },
      };
    }

    // stepper: NEMA frame `size` square, body length `l` behind the face,
    // pilot_d/pilot_h, shaft_d/shaft_l, holes on a hole_spacing square.
    case "stepper": {
      const s = num(d, "size", 42.3);
      const L = num(d, "l", 40);
      const pd = num(d, "pilot_d", 22);
      const ph = num(d, "pilot_h", 2);
      const sd = num(d, "shaft_d", 5);
      const sl = num(d, "shaft_l", 24);
      const hs = num(d, "hole_spacing", 31) / 2;
      const holes: V3[] = [
        [hs, hs, 0],
        [-hs, hs, 0],
        [-hs, -hs, 0],
        [hs, -hs, 0],
      ];
      const body: PartRecipe = {
        base: { t: "box", w: s, d: s, h: L, at: [0, 0, -L], r: Math.min(4, s / 10) },
        ops: [{ op: "add", shape: { t: "cyl", d: pd, h: ph, at: [0, 0, -0.01], dir: ZP } }, ...holes.map((h) => ({ op: "cut" as const, shape: { t: "hole" as const, d: num(d, "hole_d", 2.5), depth: 4.5, at: h, dir: ZN } }))],
      };
      const shaft: PartRecipe = { base: { t: "cyl", d: sd, h: sl, at: [0, 0, ph - 1], dir: ZP }, ops: [{ op: "chamfer", r: 0.4, edges: "top" }] };
      return {
        placement: "axis",
        solids: [solid("", p.name, body, g.color ?? "#2a2e35", "Steel"), solid("shaft", `${p.name} shaft`, shaft, STEEL, "Stainless 304", true)],
        fields: {
          scalars: { body: s, length: L, pilot_d: pd, pilot_h: ph, shaft_d: sd, shaft_len: sl, hole_spacing: hs * 2 },
          points: { face: Z0, at: Z0, shaft_tip: [0, 0, ph - 1 + sl], back: [0, 0, -L] },
          pointLists: { holes },
          dirs: { axis: ZP },
        },
      };
    }

    // servo: output spline on the Z axis, `at` on the top face of the case.
    // w (long side, along X), d, h (case height below the top face),
    // flange_w (tab length end to end), flange_t, flange_z (distance from
    // the top face down to the tab top), shaft_x (spline offset from the case
    // centre along X), hole spacing from `holes`.
    case "servo": {
      const w = num(d, "w", 40.7);
      const dd = num(d, "d", 19.7);
      const h = num(d, "h", 37);
      const fw = num(d, "flange_w", 54);
      const ft = num(d, "flange_t", 2.5);
      const fz = num(d, "flange_z", 10);
      const sx = num(d, "shaft_x", 10);
      const holes = g.holes ?? [];
      const body: PartRecipe = {
        base: { t: "box", w, d: dd, h, at: [-sx, 0, -h], r: 0.8 },
        ops: [
          { op: "add", shape: { t: "box", w: fw, d: dd, h: ft, at: [-sx, 0, -fz - ft], r: 0.5 } },
          ...holes.map(([x, y]) => ({ op: "cut" as const, shape: { t: "cyl" as const, d: g.hole_d ?? 4.5, h: ft + 2, at: [x, y, -fz - ft - 1] as V3, dir: ZP } })),
          { op: "add", shape: { t: "cyl", d: 12, h: 2, at: [0, 0, -0.01], dir: ZP } },
        ],
      };
      const spline: PartRecipe = { base: { t: "cyl", d: num(d, "spline_d", 5.8), h: 4, at: [0, 0, 1.9], dir: ZP }, ops: [] };
      return {
        placement: "axis",
        solids: [solid("", p.name, body, g.color ?? "#1b1f25", "ABS"), solid("horn", `${p.name} spline`, spline, "#e8e9eb", "POM", true)],
        fields: {
          scalars: { w, d: dd, h, flange_z: fz },
          points: { at: Z0, spline_top: [0, 0, 5.9], case_center: [-sx, 0, -h / 2] },
          pointLists: { holes: holes.map(([x, y]) => [x, y, -fz] as V3) },
          dirs: { axis: ZP },
        },
      };
    }

    // box: batteries, power supplies, modules. w (X), d (Y), h (Z), r corner
    // radius; `at` is the centre of the bottom face. band: a wrap band height.
    case "box": {
      const w = num(d, "w", 50);
      const dd = num(d, "d", 30);
      const h = num(d, "h", 20);
      const r = Math.min(num(d, "r", 1), Math.min(w, dd) / 2 - 0.1);
      const holes = g.holes ?? [];
      const body: PartRecipe = {
        base: { t: "box", w, d: dd, h, at: Z0, r },
        ops: holes.map(([x, y]) => ({ op: "cut" as const, shape: { t: "hole" as const, d: g.hole_d ?? 3, depth: 6, at: [x, y, 0] as V3, dir: ZP } })),
      };
      const solids = [solid("", p.name, body, g.color ?? "#2b3038", g.material ?? "ABS")];
      const band = num(d, "band", 0);
      if (band > 0) solids.push(solid("wrap", `${p.name} label`, { base: { t: "box", w: w + 0.4, d: dd + 0.4, h: band, at: [0, 0, (h - band) / 2], r: r + 0.2 }, ops: [] }, g.color2 ?? "#3d6fd6", "PETG"));
      return {
        placement: "free",
        solids,
        fields: {
          scalars: { w, d: dd, h },
          points: { top: [0, 0, h], bottom: Z0, center: [0, 0, h / 2] },
          pointLists: { holes: holes.map(([x, y]) => [x, y, 0] as V3) },
        },
      };
    }

    // extrusion: aluminium T-slot profile along Z. w (X) × h (Y) section in
    // multiples of 20, slot_w, slot_d, bore. `at` is the centre of one end.
    case "extrusion": {
      const w = num(d, "w", 20);
      const h = num(d, "h", 20);
      const L = a.length ?? num(d, "length", 300);
      const sw = num(d, "slot_w", 6.2);
      const sdp = num(d, "slot_d", 6);
      const bore = num(d, "bore", 4.2);
      const ops: PartRecipe["ops"] = [];
      const nx = Math.max(1, Math.round(w / 20));
      const ny = Math.max(1, Math.round(h / 20));
      for (let i = 0; i < nx; i++) {
        const x = -w / 2 + 10 + 20 * i;
        ops.push({ op: "cut", shape: { t: "box", w: sw, d: sdp, h: L + 2, at: [x, h / 2 - sdp / 2 + 0.01, -1], r: 0 } });
        ops.push({ op: "cut", shape: { t: "box", w: sw, d: sdp, h: L + 2, at: [x, -h / 2 + sdp / 2 - 0.01, -1], r: 0 } });
      }
      for (let j = 0; j < ny; j++) {
        const y = -h / 2 + 10 + 20 * j;
        ops.push({ op: "cut", shape: { t: "box", w: sdp, d: sw, h: L + 2, at: [w / 2 - sdp / 2 + 0.01, y, -1], r: 0 } });
        ops.push({ op: "cut", shape: { t: "box", w: sdp, d: sw, h: L + 2, at: [-w / 2 + sdp / 2 - 0.01, y, -1], r: 0 } });
      }
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) ops.push({ op: "cut", shape: { t: "cyl", d: bore, h: L + 2, at: [-w / 2 + 10 + 20 * i, -h / 2 + 10 + 20 * j, -1], dir: ZP } });
      return {
        placement: "axis",
        solids: [solid("", `${p.name} × ${Math.round(L)} mm`, { base: { t: "box", w, d: h, h: L, at: Z0, r: 1.5 }, ops }, g.color ?? ALU, "Aluminum 6061")],
        fields: {
          scalars: { length: L, w, h, slot_w: sw },
          points: { at: Z0, start: Z0, end: [0, 0, L], center: [0, 0, L / 2] },
          dirs: { axis: ZP },
        },
      };
    }

    // rail: linear guide along Z. rail_w (X) × rail_h (Y, up); block_w,
    // block_l, block_h (rail bottom to block top), pitch (rail hole pitch),
    // block hole spacing block_hx × block_hz. `at` is the centre of the rail
    // underside at one end; the carriage sits at `travel` along the rail.
    case "rail": {
      const rw = num(d, "rail_w", 12);
      const rh = num(d, "rail_h", 8);
      const L = a.length ?? num(d, "length", 300);
      const bw = num(d, "block_w", 27);
      const bl = num(d, "block_l", 45.4);
      const bh = num(d, "block_h", 13);
      const pitch = num(d, "pitch", 25);
      const pos = Math.min(Math.max(a.travel ?? L / 2, bl / 2), L - bl / 2);
      const holeCount = Math.max(1, Math.floor((L - 10) / pitch) + 1);
      const first = (L - (holeCount - 1) * pitch) / 2;
      const ops: PartRecipe["ops"] = [];
      for (let i = 0; i < Math.min(holeCount, 60); i++) ops.push({ op: "cut", shape: { t: "cyl", d: num(d, "rail_hole_d", 3.5), h: rh + 2, at: [0, -1, first + i * pitch], dir: YP } });
      const rail: PartRecipe = { base: { t: "box", w: rw, d: rh, h: L, at: [0, rh / 2, 0], r: 0 }, ops };
      const hx = num(d, "block_hx", 20) / 2;
      const hz = num(d, "block_hz", 20) / 2;
      const bholes: V3[] = [
        [hx, bh, pos - hz],
        [-hx, bh, pos - hz],
        [-hx, bh, pos + hz],
        [hx, bh, pos + hz],
      ];
      const block: PartRecipe = {
        base: { t: "box", w: bw, d: bh - rh * 0.45, h: bl, at: [0, (bh + rh * 0.45) / 2, pos - bl / 2], r: 0 },
        ops: [
          { op: "cut", shape: { t: "box", w: rw + 0.6, d: rh * 0.6, h: bl + 2, at: [0, rh * 0.45 + rh * 0.3 - 0.01, pos - bl / 2 - 1], r: 0 } },
          ...bholes.map((h) => ({ op: "cut" as const, shape: { t: "cyl" as const, d: 2.5, h: 5, at: [h[0], bh - 4.99, h[2]] as V3, dir: YP } })),
        ],
      };
      return {
        placement: "axis",
        solids: [solid("", `${p.name} rail × ${Math.round(L)} mm`, rail, g.color ?? "#9aa1aa", "Steel"), solid("block", `${p.name} carriage`, block, g.color2 ?? "#7d848e", "Steel")],
        fields: {
          scalars: { length: L, rail_w: rw, rail_h: rh, block_h: bh, block_l: bl, block_w: bw, travel: pos },
          points: { at: Z0, end: [0, 0, L], carriage: [0, bh, pos], carriage_top: [0, bh, pos] },
          pointLists: { carriage_holes: bholes },
          dirs: { axis: ZP, up: YP },
        },
      };
    }

    // rod: plain round bar d along Z. `at` is the centre of one end.
    case "rod": {
      const rd = num(d, "d", 8);
      const L = a.length ?? num(d, "length", 300);
      return {
        placement: "axis",
        solids: [solid("", `${p.name} × ${Math.round(L)} mm`, { base: { t: "cyl", d: rd, h: L, at: Z0, dir: ZP }, ops: [{ op: "chamfer", r: 0.4, edges: "all" }] }, g.color ?? STEEL, "Steel")],
        fields: { scalars: { length: L, d: rd }, points: { at: Z0, end: [0, 0, L], center: [0, 0, L / 2] }, dirs: { axis: ZP } },
      };
    }

    // lead_screw: d along Z with a flanged nut at `travel`. nut_d, nut_l,
    // flange_d, flange_t; nut flange holes from `holes`.
    case "lead_screw": {
      const sd = num(d, "d", 8);
      const L = a.length ?? num(d, "length", 300);
      const nd = num(d, "nut_d", 10.2);
      const nl = num(d, "nut_l", 15);
      const fd = num(d, "flange_d", 22);
      const ft = num(d, "flange_t", 3.5);
      const pos = Math.min(Math.max(a.travel ?? L / 2, 0), L - nl);
      const holes = (g.holes ?? []).map(([x, y]) => [x, y, pos + nl] as V3);
      const nut: PartRecipe = {
        base: { t: "cyl", d: nd, h: nl, at: [0, 0, pos], dir: ZP },
        ops: [
          { op: "add", shape: { t: "cyl", d: fd, h: ft, at: [0, 0, pos + nl - ft], dir: ZP } },
          { op: "cut", shape: { t: "cyl", d: sd + 0.2, h: nl + 2, at: [0, 0, pos - 1], dir: ZP } },
          ...holes.map((h) => ({ op: "cut" as const, shape: { t: "cyl" as const, d: g.hole_d ?? 3.5, h: ft + 2, at: [h[0], h[1], pos + nl - ft - 1] as V3, dir: ZP } })),
        ],
      };
      return {
        placement: "axis",
        solids: [solid("", `${p.name} × ${Math.round(L)} mm`, { base: { t: "cyl", d: sd, h: L, at: Z0, dir: ZP }, ops: [] }, g.color ?? "#cdd2d8", "Stainless 304", true), solid("nut", `${p.name} nut`, nut, g.color2 ?? "#c9a24b", "Brass")],
        fields: {
          scalars: { length: L, d: sd, travel: pos, flange_d: fd },
          points: { at: Z0, end: [0, 0, L], nut_face: [0, 0, pos + nl], nut_bottom: [0, 0, pos] },
          pointLists: { nut_holes: holes },
          dirs: { axis: ZP },
        },
      };
    }

    // pulley: timing pulley. pd (pitch diameter), od (flange), w (belt
    // width), hub_d, hub_l, bore. `at` is the outer face of the flange on the
    // hub side; the hub points along -Z toward the motor.
    case "pulley": {
      const pd = num(d, "pd", 12.73);
      const od = num(d, "od", 16);
      const w = num(d, "w", 7);
      const hd = num(d, "hub_d", 13);
      const hl = num(d, "hub_l", 7);
      const bore = num(d, "bore", 5);
      const r = (x: number) => x / 2;
      const pts: V2[] = [
        [r(bore), 0],
        [r(hd), 0],
        [r(hd), hl],
        [r(od), hl],
        [r(od), hl + 1],
        [r(pd) - 0.4, hl + 1],
        [r(pd) - 0.4, hl + 1 + w],
        [r(od), hl + 1 + w],
        [r(od), hl + 2 + w],
        [r(bore), hl + 2 + w],
      ];
      return {
        placement: "axis",
        solids: [solid("", p.name, { base: { t: "revolve", pts, at: Z0, dir: ZP }, ops: [] }, g.color ?? ALU, "Aluminum 6061", true)],
        fields: {
          scalars: { pd, od, width: hl + 2 + w, bore, belt_z: hl + 1 + w / 2 },
          points: { at: Z0, belt_center: [0, 0, hl + 1 + w / 2], end: [0, 0, hl + 2 + w] },
          dirs: { axis: ZP },
        },
      };
    }

    // coupler: d × l cylinder with bore1 / bore2 at each end. `at` is one end.
    case "coupler": {
      const cd = num(d, "d", 19);
      const L = num(d, "l", 25);
      return {
        placement: "axis",
        solids: [
          solid(
            "",
            p.name,
            {
              base: { t: "cyl", d: cd, h: L, at: Z0, dir: ZP },
              ops: [
                { op: "cut", shape: { t: "cyl", d: num(d, "bore1", 5), h: L / 2 + 0.5, at: [0, 0, -0.5], dir: ZP } },
                { op: "cut", shape: { t: "cyl", d: num(d, "bore2", 8), h: L / 2 + 0.5, at: [0, 0, L / 2], dir: ZP } },
              ],
            },
            g.color ?? ALU,
            "Aluminum 6061",
            true,
          ),
        ],
        fields: { scalars: { d: cd, length: L }, points: { at: Z0, end: [0, 0, L], center: [0, 0, L / 2] }, dirs: { axis: ZP } },
      };
    }

    // linear_bearing / ring: od, id, l along Z. `at` is one face.
    case "linear_bearing":
    case "ring": {
      const od = num(d, "od", 15);
      const id = num(d, "id", 8);
      const L = num(d, "l", 24);
      return {
        placement: "axis",
        solids: [solid("", p.name, { base: { t: "tube", od, id, h: L, at: Z0, dir: ZP }, ops: [] }, g.color ?? (g.g === "ring" ? BLACK : STEEL), g.material ?? "Steel")],
        fields: { scalars: { od, id, length: L }, points: { at: Z0, end: [0, 0, L], center: [0, 0, L / 2] }, dirs: { axis: ZP } },
      };
    }

    // hotend: `at` is the nozzle tip, the axis points up toward the mount.
    // nozzle_l, block_w/block_d/block_h (heater block, offset block_x),
    // break_l, sink_d, sink_l, mount_d, mount_l, groove_d, groove_h, collar_top
    // (groove mount stack).
    case "hotend": {
      const nl = num(d, "nozzle_l", 5);
      const bw = num(d, "block_w", 20);
      const bd = num(d, "block_d", 16);
      const bh = num(d, "block_h", 11.5);
      const bx = num(d, "block_x", 4);
      const brk = num(d, "break_l", 4);
      const skd = num(d, "sink_d", 22.3);
      const skl = num(d, "sink_l", 26);
      const mtd = num(d, "mount_d", 16);
      const mtl = num(d, "mount_l", 12.7);
      const z1 = nl;
      const z2 = z1 + bh;
      const z3 = z2 + brk;
      const z4 = z3 + skl;
      // groove mount: groove_h tall groove under a top collar of collar_top
      const gh = num(d, "groove_h", 6);
      const gz = z4 + mtl - num(d, "collar_top", 3.7) - gh;
      const fins: ShapeRecipe[] = [];
      for (let z = z3 + 1; z < z4 - 1; z += 2.6) fins.push({ t: "cyl", d: skd, h: 1.2, at: [0, 0, z], dir: ZP });
      const body: PartRecipe = {
        base: { t: "cone", d1: 1, d2: 7, h: nl, at: Z0, dir: ZP },
        ops: [
          { op: "add", shape: { t: "box", w: bw, d: bd, h: bh, at: [bx, 0, z1 - 0.01], r: 0.5 } },
          { op: "add", shape: { t: "cyl", d: 7, h: brk + 0.02, at: [0, 0, z2 - 0.01], dir: ZP } },
          { op: "add", shape: { t: "cyl", d: skd * 0.55, h: skl + 0.02, at: [0, 0, z3 - 0.01], dir: ZP } },
          ...fins.map((f) => ({ op: "add" as const, shape: f })),
          { op: "add", shape: { t: "cyl", d: mtd, h: mtl, at: [0, 0, z4 - 0.01], dir: ZP } },
          { op: "cut", shape: { t: "tube", od: mtd + 1, id: num(d, "groove_d", 12), h: gh, at: [0, 0, gz], dir: ZP } },
        ],
      };
      return {
        placement: "axis",
        solids: [solid("", p.name, body, g.color ?? "#cfd4da", "Aluminum 6061")],
        fields: {
          scalars: { length: z4 + mtl, mount_d: mtd, sink_d: skd, block_bottom: z1 },
          points: { at: Z0, nozzle: Z0, mount_top: [0, 0, z4 + mtl], groove: [0, 0, gz + gh / 2], sink_center: [0, 0, (z3 + z4) / 2] },
          dirs: { axis: ZP },
        },
      };
    }

    // extruder: filament drive. w (X) × d (Y) × h (Z) box above the motor face,
    // with the filament path along Z at fil_x. `at` is the motor-side face
    // centre (it bolts onto a NEMA 17 face), the axis is the motor axis.
    case "extruder": {
      const w = num(d, "w", 42);
      const dd = num(d, "d", 34);
      const h = num(d, "h", 42);
      const fx = num(d, "fil_x", 0);
      const body: PartRecipe = {
        base: { t: "box", w, d: h, h: dd, at: Z0, r: 3 },
        ops: [
          { op: "cut", shape: { t: "cyl", d: 2.2, h: h + 2, at: [fx, -h / 2 - 1, dd / 2], dir: YP } },
          // the motor's 22 mm pilot and its shaft (carrying the drive pinion) go into the motor face
          { op: "cut", shape: { t: "cyl", d: 22.6, h: 2.5, at: [0, 0, -0.01], dir: ZP } },
          { op: "cut", shape: { t: "cyl", d: 5.6, h: Math.min(26, dd - 2), at: [0, 0, -0.01], dir: ZP } },
        ],
      };
      return {
        placement: "axis",
        solids: [solid("", p.name, body, g.color ?? "#20242b", "Nylon")],
        fields: {
          scalars: { w, d: dd, h },
          points: { at: Z0, filament_in: [fx, h / 2, dd / 2], filament_out: [fx, -h / 2, dd / 2], top: [0, 0, dd] },
          dirs: { axis: ZP },
        },
      };
    }

    // fan: square axial fan size × t along Z, holes on hole_spacing.
    case "fan": {
      const s = num(d, "size", 40);
      const t = num(d, "t", 10);
      const hs = num(d, "hole_spacing", 32) / 2;
      const holes: V3[] = [
        [hs, hs, 0],
        [-hs, hs, 0],
        [-hs, -hs, 0],
        [hs, -hs, 0],
      ];
      return {
        placement: "axis",
        solids: [
          solid(
            "",
            p.name,
            {
              base: { t: "box", w: s, d: s, h: t, at: Z0, r: Math.min(3, s / 10) },
              ops: [
                { op: "cut", shape: { t: "cyl", d: s * 0.92, h: t + 2, at: [0, 0, -1], dir: ZP } },
                { op: "add", shape: { t: "cyl", d: s * 0.38, h: t, at: Z0, dir: ZP } },
                ...holes.map((h) => ({ op: "cut" as const, shape: { t: "cyl" as const, d: num(d, "hole_d", 3.4), h: t + 2, at: [h[0], h[1], -1] as V3, dir: ZP } })),
              ],
            },
            g.color ?? BLACK,
            "ABS",
          ),
        ],
        fields: { scalars: { size: s, t }, points: { at: Z0, outlet: [0, 0, t] }, pointLists: { holes }, dirs: { axis: ZP } },
      };
    }

    // actuator: linear actuator along Z. `at` is the rear mounting hole
    // centre. body_w (X) × body_d (Y) × body_l, rod_d, stroke, ret_l (rear
    // hole to rod-end hole when retracted). The rod extends by `travel` mm.
    case "actuator": {
      const bw = num(d, "body_w", 18);
      const bd = num(d, "body_d", 15);
      const bl = num(d, "body_l", 100);
      const rd = num(d, "rod_d", 6);
      const stroke = num(d, "stroke", 50);
      const ret = num(d, "ret_l", bl + 20);
      const ext = Math.min(Math.max(a.travel ?? 0, 0), stroke);
      const end = ret + ext;
      const body: PartRecipe = { base: { t: "box", w: bw, d: bd, h: bl, at: [0, 0, -4], r: 2 }, ops: [{ op: "cut", shape: { t: "cyl", d: 4.2, h: bd + 2, at: [0, -bd / 2 - 1, 0], dir: YP } }] };
      const rod: PartRecipe = {
        base: { t: "cyl", d: rd, h: Math.max(1, end - bl), at: [0, 0, bl - 4], dir: ZP },
        ops: [
          { op: "add", shape: { t: "box", w: 8, d: 8, h: 8, at: [0, 0, end - 4], r: 1 } },
          { op: "cut", shape: { t: "cyl", d: 4.2, h: 10, at: [0, -5, end], dir: YP } },
        ],
      };
      return {
        placement: "axis",
        solids: [solid("", p.name, body, g.color ?? "#2a2e35", "Aluminum 6061"), solid("rod", `${p.name} rod`, rod, STEEL, "Stainless 304", true)],
        fields: {
          scalars: { stroke, ret_l: ret, length: end, travel: ext },
          points: { at: Z0, rear: Z0, rod_end: [0, 0, end] },
          dirs: { axis: ZP },
        },
      };
    }

    // pcb_part: a part soldered to a circuit board, drawn from its footprint
    // (catalog/footprints.ts). `at` is the footprint origin on the board's top face.
    case "pcb_part": {
      const fg = footprintSolids(p, {}, 1.6);
      return { placement: "free", solids: fg.solids, fields: fg.fields };
    }

    // panel_jack: jack, socket or toggle through a panel hole. `at` is the
    // centre of the hole on the panel's front face and `axis` points out of
    // the front. bush_d/bush_l threaded bushing, nut_af/nut_t front nut,
    // body_w × body_d × body_l behind a panel_t thick panel (default 3),
    // hole_d the panel hole, lever_l/lever_d a toggle lever.
    case "panel_jack": {
      const pt = num(d, "panel_t", 3);
      const bd = num(d, "bush_d", 9.5);
      const nt = num(d, "nut_t", 2.4);
      const af = num(d, "nut_af", 14);
      const bw = num(d, "body_w", 13);
      const bdd = num(d, "body_d", 15);
      const bl = num(d, "body_l", 20);
      const lever = num(d, "lever_l", 0);
      const hex: V2[] = Array.from({ length: 6 }, (_, i) => {
        const a = (Math.PI / 3) * i + Math.PI / 6;
        const r = af / Math.sqrt(3);
        return [r * Math.cos(a), r * Math.sin(a)] as V2;
      });
      const front: PartRecipe = {
        base: { t: "prism", pts: hex, h: nt, at: Z0, dir: ZP, rot: 0 },
        ops: [
          { op: "add", shape: { t: "cyl", d: bd, h: pt + nt + 1, at: [0, 0, -pt], dir: ZP } },
          { op: "cut", shape: { t: "cyl", d: Math.max(1, bd - (lever ? 3.4 : 2.8)), h: nt + 3, at: [0, 0, -1], dir: ZP } },
        ],
      };
      const lugs: ShapeRecipe[] = [
        { t: "box", w: 2.5, d: 0.4, h: 6, at: [-bw / 4, 0, -pt - bl - 5.5], r: 0 },
        { t: "box", w: 2.5, d: 0.4, h: 6, at: [bw / 4, 0, -pt - bl - 5.5], r: 0 },
      ];
      const solids = [
        solid("", p.name, { base: { t: "box", w: bw, d: bdd, h: bl, at: [0, 0, -pt - bl], r: 0.5 }, ops: [] }, g.color2 ?? DARK, "PBT"),
        solid("front", `${p.name} bushing and nut`, front, g.color ?? STEEL, "Nickel-plated brass"),
        solid("lugs", `${p.name} solder lugs`, { base: { t: "union", shapes: lugs }, ops: [] }, "#c9ced6", "Tin"),
      ];
      if (lever) solids.push(solid("lever", `${p.name} lever`, { base: { t: "cone", d1: num(d, "lever_d", 2.6), d2: num(d, "lever_d", 2.6) * 0.75, h: lever, at: [0, 0, nt], dir: ZP }, ops: [] }, STEEL, "Stainless 304"));
      return {
        placement: "axis",
        solids,
        fields: {
          scalars: { hole_d: num(d, "hole_d", bd + 0.2), panel_t: pt, body_l: bl, depth: pt + bl + 6 },
          points: { at: Z0, front: Z0, back: [0, 0, -pt - bl], lug_a: [-bw / 4, 0, -pt - bl - 5], lug_b: [bw / 4, 0, -pt - bl - 5] },
          dirs: { axis: ZP },
        },
      };
    }

    // speaker: a cone driver facing along `axis`; `at` is the centre of the
    // front of its mounting flange (it sits against the back of the baffle).
    // d frame diameter, cutout_d baffle hole, bolt_circle/holes/hole_d
    // mounting holes, depth flange to back of magnet, magnet_d/magnet_h.
    case "speaker": {
      const D = num(d, "d", 259);
      const cut = num(d, "cutout_d", 231);
      const bc = num(d, "bolt_circle", 245);
      const nh = num(d, "holes", 8);
      const depth = num(d, "depth", 87);
      const md = num(d, "magnet_d", 100);
      const mh = num(d, "magnet_h", 17);
      const holes = circlePts(nh, bc / 2, 22.5);
      const zMag = -depth;
      const zCone = zMag + mh + 14;
      const coneH = -5 - zCone;
      // flange and four basket arms from the flange to the magnet
      const arm = (ang: number): ShapeRecipe => ({
        t: "xform",
        shape: { t: "prism", pts: [[-(cut / 2 - 4), -3], [-(cut / 2 - 12), -3], [-(md / 2 - 2), zMag + mh + 2], [-(md / 2 + 6), zMag + mh + 2]], h: 2.5, at: [0, -1.25, 0], dir: YP, rot: 0 },
        xf: [{ op: "rotate", angle: ang, origin: Z0, axis: ZP }],
      });
      const frame: PartRecipe = {
        base: { t: "tube", od: D, id: cut - 8, h: 3, at: [0, 0, -3], dir: ZP },
        ops: [
          ...holes.map((h) => ({ op: "cut" as const, shape: { t: "cyl" as const, d: num(d, "hole_d", 6.5), h: 6, at: [h[0], h[1], -4] as V3, dir: ZP } })),
          ...[45, 135, 225, 315].map((a) => ({ op: "add" as const, shape: arm(a) })),
        ],
      };
      const cone: PartRecipe = {
        base: { t: "cone", d1: 52, d2: cut - 14, h: coneH, at: [0, 0, zCone], dir: ZP },
        ops: [
          { op: "cut", shape: { t: "cone", d1: 50, d2: cut - 16, h: coneH, at: [0, 0, zCone + 1.6], dir: ZP } },
          { op: "add", shape: { t: "tube", od: cut - 4, id: cut - 16, h: 2.5, at: [0, 0, -6], dir: ZP } },
        ],
      };
      const cap: PartRecipe = { base: { t: "sphere", d: 70, at: [0, 0, zCone - 22] }, ops: [{ op: "cut", shape: { t: "cyl", d: 80, h: 40, at: [0, 0, zCone - 40 + 6], dir: ZP } }] };
      const magnet: PartRecipe = {
        base: { t: "cyl", d: md, h: mh, at: [0, 0, zMag + 3], dir: ZP },
        ops: [
          { op: "add", shape: { t: "cyl", d: md - 8, h: 3.02, at: [0, 0, zMag], dir: ZP } },
          { op: "add", shape: { t: "cyl", d: md + 4, h: 3, at: [0, 0, zMag + 3 + mh - 0.01], dir: ZP } },
        ],
      };
      const tabs: ShapeRecipe[] = [
        { t: "box", w: 5, d: 1, h: 8, at: [cut / 2 - 26, 18, -22], r: 0 },
        { t: "box", w: 5, d: 1, h: 8, at: [cut / 2 - 26, -18, -22], r: 0 },
      ];
      return {
        placement: "axis",
        solids: [
          solid("", p.name, frame, g.color2 ?? "#3a3e45", "Steel"),
          solid("cone", `${p.name} cone`, cone, g.color ?? "#2a2623", "Paper"),
          solid("cap", `${p.name} dust cap`, cap, "#1d1b19", "Paper"),
          solid("magnet", `${p.name} magnet`, magnet, "#4a4e55", "Ferrite"),
          solid("tabs", `${p.name} terminals`, { base: { t: "union", shapes: tabs }, ops: [] }, "#c9a24b", "Brass"),
        ],
        fields: {
          scalars: { d: D, cutout_d: cut, bolt_circle: bc, depth, magnet_d: md },
          points: { at: Z0, front: Z0, back: [0, 0, zMag], center: [0, 0, zCone] },
          pointLists: { holes },
          dirs: { axis: ZP },
        },
      };
    }

    // knob: push-on knob on a shaft along `axis`; `at` is the centre of its
    // underside. d body, skirt_d/skirt_h, h overall height.
    case "knob": {
      const kd = num(d, "d", 19);
      const sd = num(d, "skirt_d", 23);
      const sh = num(d, "skirt_h", 3);
      const h = num(d, "h", 15);
      const body: PartRecipe = {
        base: { t: "cyl", d: sd, h: sh, at: Z0, dir: ZP },
        ops: [
          { op: "add", shape: { t: "cone", d1: kd, d2: kd * 0.9, h: h - sh, at: [0, 0, sh - 0.01], dir: ZP } },
          { op: "cut", shape: { t: "cyl", d: 6, h: 11, at: [0, 0, -1], dir: ZP } },
        ],
      };
      const pointer: ShapeRecipe[] = [
        { t: "box", w: 1, d: kd * 0.45 - 1, h: 0.3, at: [0, (kd * 0.45) / 2 + 0.5, h - 0.05], r: 0 },
        { t: "box", w: 1, d: (sd - kd) / 2 + 0.4, h: 0.3, at: [0, kd / 2 + (sd - kd) / 4, sh - 0.05], r: 0 },
      ];
      return {
        placement: "axis",
        solids: [solid("", p.name, body, g.color ?? BLACK, "ABS"), solid("pointer", `${p.name} pointer`, { base: { t: "union", shapes: pointer }, ops: [] }, g.color2 ?? "#f2f2f2", "Paint", true)],
        fields: { scalars: { d: kd, skirt_d: sd, h }, points: { at: Z0, top: [0, 0, h] }, dirs: { axis: ZP } },
      };
    }

    // brick: plug-in power supply lying flat, `at` the centre of its bottom
    // face, cord leaving the +X end. w × d × h.
    case "brick": {
      const w = num(d, "w", 100);
      const dd = num(d, "d", 48);
      const h = num(d, "h", 32);
      return {
        placement: "free",
        solids: [
          solid("", p.name, { base: { t: "box", w, d: dd, h, at: Z0, r: 5 }, ops: [{ op: "cut", shape: { t: "box", w: w * 0.6, d: dd * 0.6, h: 1, at: [0, 0, h - 0.5], r: 2 } }] }, g.color ?? BLACK, "PC"),
          solid("cord", `${p.name} cord`, { base: { t: "cyl", d: 4, h: 60, at: [w / 2 - 1, 0, h / 2], dir: XP }, ops: [{ op: "add", shape: { t: "cone", d1: 9, d2: 4.5, h: 12, at: [w / 2 - 1, 0, h / 2], dir: XP } }] }, BLACK, "PVC"),
        ],
        fields: { scalars: { w, d: dd, h }, points: { top: [0, 0, h], bottom: Z0, cord_end: [w / 2 + 59, 0, h / 2] } },
      };
    }

    // plate: heated bed or build plate. w × d × t, `at` is the bottom centre;
    // holes from `holes`.
    case "plate": {
      const w = num(d, "w", 235);
      const dd = num(d, "d", 235);
      const t = num(d, "t", 3);
      const holes = g.holes ?? [];
      return {
        placement: "free",
        solids: [
          solid(
            "",
            p.name,
            { base: { t: "box", w, d: dd, h: t, at: Z0, r: 2 }, ops: holes.map(([x, y]) => ({ op: "cut" as const, shape: { t: "cyl" as const, d: g.hole_d ?? 4.2, h: t + 2, at: [x, y, -1] as V3, dir: ZP } })) },
            g.color ?? "#2c2f35",
            g.material ?? "Aluminum 6061",
          ),
        ],
        fields: { scalars: { w, d: dd, t }, points: { top: [0, 0, t], bottom: Z0, center: [0, 0, t / 2] }, pointLists: { holes: holes.map(([x, y]) => [x, y, 0] as V3) } },
      };
    }
  }
}

function faceHoles(g: CatalogPart["geom"], d: Record<string, number>): [number, number][] {
  if (g.holes?.length) return g.holes;
  const n = num(d, "hole_n", 0);
  if (!n) return [];
  return circlePts(n, num(d, "hole_circle", 31) / 2, num(d, "hole_start", 0)).map((p) => [p[0], p[1]]);
}

export { XP };
