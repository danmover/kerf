// 3D shapes for catalog parts. Each class works in a local frame and reads
// the dimensions documented above its generator. Purchased parts are
// modelled to their envelope and mounting interface (holes, shafts, pilots,
// connectors): the things a design has to fit around and fasten to.

import type { PartRecipe, ShapeRecipe, V2, V3 } from "../kernel/recipe";
import type { CompSolid, LocalFields, Placement } from "../library/components";
import type { CatalogPart } from "./types";
import { footprintSolids } from "./catalog/footprints";
import { THREADS, type ThreadSpec } from "../library/standards";
import { EDF_STUB, edfLeadExit } from "./harness/plugs";
import { busServoGeometry } from "./geometryBusServo";
import { leggedGeometry } from "./geometryLegged";
import { deskSupplyGeometry, endoscopeGeometry } from "./geometryBenchParts";

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

/**
 * Where a servo's side stickers are (in its frame, `at` on the top face): x the middle, w long, from z0 up h,
 * standing `proud` off each side face; the middle case's box (base) for telling a servo drawn this way.
 * Null when the case is too short for one. The 3D view prints the label on it (ui/viewport/parts/decorate.ts).
 */
export function servoStickerBox(d: Record<string, number>): { x: number; w: number; z0: number; h: number; proud: number; base: V3 } | null {
  const w = num(d, "w", 40.7);
  const h = num(d, "h", 37);
  const ft = num(d, "flange_t", 2.5);
  const fz = num(d, "flange_z", 10);
  const sx = num(d, "shaft_x", 10);
  const zb = -h + Math.min(8, Math.max(3, h * 0.2));
  const z0 = zb + 0.8;
  const lh = -fz - ft - 0.7 - z0;
  if (lh <= 3) return null;
  return { x: -sx, w: w * 0.8, z0, h: lh, proud: 0.12, base: [-sx, 0, zb] };
}

function circlePts(n: number, r: number, start = 0): V3[] {
  return Array.from({ length: n }, (_, i) => {
    const a = ((start + (360 * i) / n) * Math.PI) / 180;
    return [r * Math.cos(a), r * Math.sin(a), 0] as V3;
  });
}

function solid(suffix: string, label: string, recipe: PartRecipe, color: string, material: string, moving?: boolean): CompSolid {
  return { suffix, label, recipe, color, material, moving };
}

const XN: V3 = [-1, 0, 0];
const box = (w: number, d: number, h: number, at: V3, r = 0): ShapeRecipe => ({ t: "box", w, d, h, at, r });
/** a box turned 45° about Z round its own centre line: cut at a corner, it leaves a chamfer */
const diamond = (s: number, at: V3, h: number): ShapeRecipe => ({ t: "xform", shape: box(s, s, h, at), xf: [{ op: "rotate", angle: 45, origin: at, axis: ZP }] });

/**
 * A cambered thin airfoil (NACA 4-digit thickness t of the chord, parabolic camber), chord c along +x from the
 * trailing edge at -c/2 to the leading edge at +c/2, mid-chord at the origin, camber towards +y.
 */
function airfoil(c: number, t: number, camber: number, n = 8): V2[] {
  const yt = (s: number) => 5 * t * c * (0.2969 * Math.sqrt(s) - 0.126 * s - 0.3516 * s * s + 0.2843 * s ** 3 - 0.1036 * s ** 4);
  const yc = (s: number) => camber * c * 4 * s * (1 - s);
  const ss = Array.from({ length: n + 1 }, (_, i) => (1 - Math.cos((Math.PI * i) / n)) / 2);
  const up = ss.map((s) => [c / 2 - s * c, yc(s) + yt(s)] as V2);
  const lo = ss.slice(1, -1).reverse().map((s) => [c / 2 - s * c, yc(s) - yt(s)] as V2);
  return [...up, ...lo];
}

/**
 * A fan or stator blade on the Z axis at azimuth `a` (degrees), from radius r0 to r1, mid-chord at height z:
 * root chord c0 pitched b0 degrees from the plane of rotation, tapering to c1 at b1 at the tip. The leading edge
 * leads in +azimuth and sits towards +Z, so a rotor turning that way pushes air to -Z.
 */
function radialBlade(a: number, r0: number, r1: number, z: number, c0: number, c1: number, b0: number, b1: number, t: number, camber: number): ShapeRecipe {
  const ar = (a * Math.PI) / 180;
  const b = (b0 * Math.PI) / 180;
  const er: V3 = [Math.cos(ar), Math.sin(ar), 0];
  const et: V3 = [-Math.sin(ar), Math.cos(ar), 0];
  const u: V3 = [et[0] * Math.cos(b), et[1] * Math.cos(b), Math.sin(b)];
  return {
    t: "extrude",
    p: { t: "poly", pts: airfoil(c0, t, camber), r: 0 },
    h: r1 - r0,
    f: { o: [er[0] * r0, er[1] * r0, z], u, n: er },
    twist: b1 - b0,
    scale: c1 / c0,
  };
}

/**
 * The look of a known kind of box-class part: the body's own cuts (seams,
 * pockets) and the extra solids (labels, heatsinks, lids, boots), all inside
 * the catalog envelope so mounts, trays and clash checks see the same box.
 */
function boxLook(style: NonNullable<CatalogPart["geom"]["style"]>, p: CatalogPart, w: number, dd: number, h: number, r: number): { base?: ShapeRecipe; cuts: ShapeRecipe[]; solids: CompSolid[]; color?: string; finish?: string } {
  const g = p.geom;
  const one = (shape: ShapeRecipe): PartRecipe => ({ base: shape, ops: [] });
  switch (style) {
    // a soft LiPo pack: cells stacked in its height (seams round the sides and ends), the printed
    // sleeve over the middle with a foil stripe, and the tape over the cell tabs at the lead (+X) end
    case "lipo": {
      const cells = Math.max(1, Number(p.specs?.cells) || Math.round(h / 9));
      const per = h / cells;
      const lw = w * 0.6;
      const lx = -w * 0.1;
      const cuts: ShapeRecipe[] = [];
      for (let k = 1; k < cells; k++) {
        const z = k * per - 0.25;
        cuts.push(box(w + 2, 0.7, 0.5, [0, dd / 2, z]), box(w + 2, 0.7, 0.5, [0, -dd / 2, z]), box(0.7, dd + 2, 0.5, [w / 2, 0, z]), box(0.7, dd + 2, 0.5, [-w / 2, 0, z]));
      }
      // the sleeve sits in a 0.3 mm recess, flush with the pack (the strap and tray see the same box)
      cuts.push(box(lw, dd + 2, 0.3, [lx, 0, h - 0.3]), box(lw, 0.6, h + 2, [lx, dd / 2, -1]), box(lw, 0.6, h + 2, [lx, -dd / 2, -1]));
      cuts.push(box(1.2, dd + 2, h + 2, [w / 2 - 0.6, 0, -1]));
      const foil = 7;
      const a = lw - 0.3 - foil;
      const sleeve = (len: number, x: number) => box(len, dd, h, [x, 0, 0], 0.3);
      const xa = lx - (lw - 0.3) / 2;
      return {
        cuts,
        solids: [
          solid("wrap", `${p.name} label`, one({ t: "union", shapes: [sleeve(a * 0.72, xa + (a * 0.72) / 2), sleeve(a * 0.28, xa + a * 0.72 + foil + (a * 0.28) / 2)] }), g.color2 ?? "#d4382c", "PVC"),
          solid("foil", `${p.name} label stripe`, one(sleeve(foil, xa + a * 0.72 + foil / 2)), "#c9ced6", "PVC"),
          solid("tabs", `${p.name} tab tape`, one(box(1.2, dd - 2 * r, h - 2 * Math.min(r, per / 2), [w / 2 - 0.6, 0, Math.min(r, per / 2)])), "#b5832a", "Polyimide"),
        ],
      };
    }
    // an ESC in shrink wrap: the label round the middle, and the aluminium heatsink's fins on top
    case "esc": {
      const fin = Math.min(1.6, h * 0.15);
      const bodyH = h - fin - 0.6;
      const hw = w * 0.62;
      const hx = w * 0.06;
      const n = Math.max(3, Math.floor((dd - 4) / 2.8));
      const pitch = (dd - 4) / n;
      const fins: ShapeRecipe[] = [box(hw, dd - 4, 0.6, [hx, 0, bodyH])];
      for (let k = 0; k < n; k++) fins.push(box(hw, Math.min(1.2, pitch * 0.45), fin, [hx, -(dd - 4) / 2 + pitch * (k + 0.5), bodyH + 0.6]));
      const band = Math.min(num(g.dims, "band", bodyH * 0.8), bodyH - 1);
      return {
        base: box(w, dd, bodyH, Z0, r),
        cuts: [],
        solids: [
          solid("sink", `${p.name} heatsink`, one({ t: "union", shapes: fins }), "#aeb5be", "Aluminum 6063"),
          solid("wrap", `${p.name} label`, one(box(w * 0.7, dd + 0.3, band, [0, 0, (bodyH - band) / 2], Math.max(0.2, r - 0.3))), g.color2 ?? "#2f6ad8", "PVC"),
        ],
      };
    }
    // an inline MAXI fuse holder: base, snap-on lid with a lip, and a tapered boot round each lead end
    case "fuse_maxi": {
      const boot = Math.min(5, w * 0.12);
      const L = w - 2 * boot;
      const hb = h * 0.56;
      const zc = h / 2;
      const bd = Math.min(dd, h) * 0.6;
      return {
        base: box(L - 0.8, dd - 0.8, hb, Z0, Math.max(0.3, r - 0.4)),
        cuts: [],
        color: "#1b1f25",
        solids: [
          solid("lid", `${p.name} lid`, one(box(L, dd, h - hb, [0, 0, hb], r)), "#2b3038", "PA66"),
          solid("boots", `${p.name} lead boots`, one({ t: "union", shapes: [{ t: "cone", d1: bd, d2: bd * 0.62, h: boot, at: [L / 2 - 0.4, 0, zc], dir: XP }, { t: "cone", d1: bd, d2: bd * 0.62, h: boot, at: [-L / 2 + 0.4, 0, zc], dir: XN }] }), "#1b1f25", "PVC"),
        ],
      };
    }
    // an inline blade fuse holder with screw terminals: a low base with a wire port in each end and a terminal
    // screw sunk in its top beside it, and the blade fuse standing in the middle (in its rating's colour)
    case "fuse_blade": {
      const hb = h * 0.6;
      const port = Math.min(dd, hb) * 0.42;
      const sx = w / 2 - Math.min(9, w * 0.15);
      const fw = Math.min(19.1, w * 0.4);
      const ft = Math.min(5.2, dd * 0.3);
      const screws: ShapeRecipe[] = [-sx, sx].map((x): ShapeRecipe => ({ t: "cyl", d: 5.4, h: 1.2, at: [x, 0, hb - 1.6], dir: ZP }));
      return {
        base: box(w, dd, hb, Z0, r),
        cuts: [
          { t: "hole", d: port, depth: w * 0.16, at: [-w / 2, 0, hb * 0.4], dir: XP },
          { t: "hole", d: port, depth: w * 0.16, at: [w / 2, 0, hb * 0.4], dir: XN },
          ...[-sx, sx].map((x): ShapeRecipe => ({ t: "hole", d: 6.6, depth: 1.6, at: [x, 0, hb], dir: ZN })),
        ],
        color: g.color ?? "#1b1f25",
        solids: [
          solid("screws", `${p.name} terminal screws`, one({ t: "union", shapes: screws }), "#c9ced6", "Steel"),
          solid("blade", `${p.name} blade fuse`, one(box(fw, ft, h - hb, [0, 0, hb], 0.8)), g.color2 ?? "#3fae5a", "PA66"),
        ],
      };
    }
    // one way of a nylon terminal strip: the body with a wire port in each end (Y) and a screw tower over each,
    // the two brass screws sunk in the towers
    case "terminal_way": {
      const hb = h * 0.62;
      const tw = Math.min(w * 0.72, 9);
      const ty = dd / 2 - dd * 0.27;
      const port = Math.min(w * 0.45, hb * 0.6);
      const towers: ShapeRecipe[] = [-ty, ty].map((y): ShapeRecipe => ({ t: "cyl", d: tw, h: h - hb, at: [0, y, hb], dir: ZP }));
      return {
        base: { t: "union", shapes: [box(w, dd, hb, Z0, r), ...towers] },
        cuts: [
          { t: "hole", d: port, depth: dd * 0.3, at: [0, -dd / 2, hb * 0.42], dir: YP },
          { t: "hole", d: port, depth: dd * 0.3, at: [0, dd / 2, hb * 0.42], dir: [0, -1, 0] },
          ...[-ty, ty].map((y): ShapeRecipe => ({ t: "hole", d: tw * 0.62, depth: (h - hb) * 0.5, at: [0, y, h], dir: ZN })),
        ],
        solids: [solid("screws", `${p.name} screws`, one({ t: "union", shapes: [-ty, ty].map((y): ShapeRecipe => ({ t: "cyl", d: tw * 0.58, h: 1.2, at: [0, y, h - (h - hb) * 0.5], dir: ZP })) }), g.color2 ?? "#b9975b", "Brass")],
      };
    }
    // a mated XT-series pair: the female housing below, the male above it on a slightly smaller body, the
    // polarity chamfers on the +Y corners of both
    case "xt": {
      const s = Math.min(dd * 0.45, 4.5);
      const ch = (zh: number, z0: number) => [diamond(s, [w / 2, dd / 2, z0 - 0.5], zh + 1), diamond(s, [-w / 2, dd / 2, z0 - 0.5], zh + 1)];
      const hm = h * 0.48;
      return {
        base: box(w, dd, h - hm, Z0, r),
        cuts: ch(h - hm, 0),
        solids: [solid("male", `${p.name} male`, { base: box(w - 0.8, dd - 0.8, hm, [0, 0, h - hm], r), ops: ch(hm, h - hm).map((shape) => ({ op: "cut" as const, shape })) }, g.color2 ?? "#e3a81e", "PA66")],
      };
    }
    // a Wago 221 lever connector: the clear case with a wire port for each lever in its -Y end, and the orange
    // levers lying closed along the top
    case "wago": {
      const n = Math.max(2, Number(p.specs?.ways) || 2);
      const pitch = w / n;
      const lev = Math.min(2.4, h * 0.28);
      const bodyH = h - lev;
      const port = Math.min(pitch * 0.62, bodyH * 0.6);
      const xs = Array.from({ length: n }, (_, k) => (k - (n - 1) / 2) * pitch);
      return {
        base: box(w, dd, bodyH, Z0, r),
        cuts: xs.map((x): ShapeRecipe => ({ t: "hole", d: port, depth: dd * 0.45, at: [x, -dd / 2, bodyH * 0.45], dir: YP })),
        solids: [
          solid("levers", `${p.name} levers`, one({ t: "union", shapes: xs.map((x) => box(pitch * 0.72, dd * 0.7, lev, [x, dd * 0.13, bodyH], 0.5)) }), g.color2 ?? "#f08a1c", "PA66"),
        ],
      };
    }
    // a bar load cell: the strain gauges under a pad of white potting in a pocket in the middle of the top
    case "load_cell": {
      const pw = Math.min(14, w * 0.3);
      const pd = dd * 0.7;
      return {
        // a bar cell is bead-blasted or anodised aluminium, matte silver: not a mirror
        finish: "bead-blasted",
        cuts: [box(pw, pd, 0.6, [0, 0, h - 0.6], 0.5)],
        solids: [solid("gauge", `${p.name} gauge potting`, one(box(pw - 0.4, pd - 0.4, 0.6, [0, 0, h - 0.6], 0.4)), "#ece8dc", "Silicone")],
      };
    }
  }
}

export function buildGeometry(p: CatalogPart, a: GeomArgs): GeomResult {
  const g = p.geom;
  const d = g.dims;
  switch (g.g) {
    // legged-robot parts: actuators, depth camera, Jetson kit, relay, HTD pulley (geometryLegged.ts)
    case "qdd":
    case "depth_camera":
    case "jetson_devkit":
    case "auto_relay":
    case "htd_pulley":
      return leggedGeometry(p)!;
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
      const above = (g.features ?? []).filter((f) => f.side !== "bottom");
      const under = (g.features ?? []).filter((f) => f.side === "bottom");
      const feats: ShapeRecipe[] = above.map((f) => ({ t: "box", w: f.w, d: f.d, h: f.h, at: [f.x, f.y, t] as V3, r: 0 }));
      const solids = [solid("", p.name, board, g.color ?? PCB, "FR4")];
      if (feats.length) solids.push(solid("parts", `${p.name} components`, { base: feats.length === 1 ? feats[0] : { t: "union", shapes: feats }, ops: [] }, g.color2 ?? DARK, "FR4"));
      // what hangs under the board is drawn part by part, so a detailed drawing of the top leaves it showing
      under.forEach((f, i) => solids.push(solid(`under${i + 1}`, `${p.name} ${f.kind} on the back`, { base: { t: "box", w: f.w, d: f.d, h: f.h, at: [f.x, f.y, -f.h] as V3, r: 0.3 }, ops: [] }, f.color ?? DARK, "PA66")));
      const height = t + Math.max(0, ...above.map((f) => f.h));
      const below = Math.max(0, ...under.map((f) => f.h));
      return {
        placement: "free",
        solids,
        fields: {
          scalars: { w, d: dd, t, height, below, hole_d: hd },
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
    // enc_l encoder cap, shaft_d/shaft_l output shaft, shaft_flat D-flat
    // depth, shaft_offset moves the body off the shaft axis along -X
    // (offset-shaft spur gearboxes), boss_d/boss_h pilot boss,
    // hole_circle/hole_n/hole_d/hole_start face holes round the gearbox
    // centre (or `holes`, from the shaft), hole_d the tap drill, hole_depth
    // the thread depth. The gearbox is the main solid (color), the can and
    // encoder the second (color2).
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
      const hd = num(d, "hole_d", 2.5);
      const depth = num(d, "hole_depth", 6);
      const c: V3 = [-off, 0, 0];
      const holes = g.holes?.length ? g.holes : faceHoles(g, d).map(([x, y]) => [x - off, y] as [number, number]);
      const ops: PartRecipe["ops"] = [];
      if (bd > 0 && bh > 0) ops.push({ op: "add", shape: { t: "cyl", d: bd, h: bh, at: [0, 0, -0.01], dir: ZP } });
      for (const h of holes) ops.push({ op: "cut", shape: { t: "cyl", d: hd, h: depth, at: [h[0], h[1], -depth + 0.01], dir: ZP } });
      const body: PartRecipe = { base: { t: "cyl", d: gd, h: gl, at: [c[0], 0, -gl], dir: ZP }, ops };
      const can: PartRecipe = { base: { t: "cyl", d: md, h: ml + 0.02, at: [c[0], 0, -gl - ml], dir: ZP }, ops: el > 0 ? [{ op: "add", shape: { t: "cyl", d: md * 0.92, h: el + 0.02, at: [c[0], 0, -gl - ml - el], dir: ZP } }] : [] };
      const shaft = dShaft(sd, sl, bh, num(d, "shaft_flat", 0), sl * 0.8);
      const screw = screwFor(d, hd, true);
      return {
        placement: "axis",
        solids: [solid("", p.name, body, g.color ?? "#3a3f47", "Steel"), solid("can", `${p.name} motor`, can, g.color2 ?? ALU, "Steel"), solid("shaft", `${p.name} shaft`, shaft, STEEL, "Steel", true)],
        fields: {
          scalars: { shaft_d: sd, shaft_len: sl, body_d: Math.max(gd, md), length: gl + ml + el, gear_d: gd, shaft_offset: off, ...mountScalars(screw, depth) },
          points: { face: Z0, at: Z0, shaft_tip: [0, 0, bh + sl], body_center: [c[0], 0, -(gl + ml + el) / 2], back: [c[0], 0, -(gl + ml + el)] },
          pointLists: { holes: holes.map(([x, y]) => [x, y, 0] as V3) },
          dirs: { axis: ZP },
          shapes: { mount: mountCut(holes, screw, Math.max(bd, sd + 1) + 0.6, 1) },
        },
      };
    }

    // micro_gearmotor: N20-size gearmotor, `at` the centre of the gearbox
    // face, shaft along +Z. A w (X) × t (Y) gearbox gear_l long, a can of
    // diameter w flattened to t, motor_l long, an optional encoder enc_l,
    // the D shaft shaft_d × shaft_l (shaft_flat deep) on a boss_d × boss_h
    // bearing boss, two holes hole_spacing apart along X (hole_d tap drill,
    // hole_depth deep).
    case "micro_gearmotor": {
      const w = num(d, "w", 12);
      const t = num(d, "t", 10);
      const gl = num(d, "gear_l", 9);
      const ml = num(d, "motor_l", 15);
      const el = num(d, "enc_l", 0);
      const sd = num(d, "shaft_d", 3);
      const sl = num(d, "shaft_l", 10);
      const bd = num(d, "boss_d", 4);
      const bh = num(d, "boss_h", 0.8);
      const hs = num(d, "hole_spacing", 9) / 2;
      const hd = num(d, "hole_d", 1.25);
      const depth = num(d, "hole_depth", 2);
      const holes: [number, number][] = [[hs, 0], [-hs, 0]];
      const back = gl + ml + el;
      const body: PartRecipe = {
        base: { t: "box", w, d: t, h: gl, at: [0, 0, -gl], r: 0.3 },
        ops: [{ op: "add", shape: { t: "cyl", d: bd, h: bh, at: [0, 0, -0.01], dir: ZP } }, ...holes.map(([x, y]) => ({ op: "cut" as const, shape: { t: "cyl" as const, d: hd, h: depth, at: [x, y, -depth + 0.01] as V3, dir: ZP } }))],
      };
      const can: PartRecipe = {
        base: { t: "cyl", d: w, h: ml + el + 0.02, at: [0, 0, -back], dir: ZP },
        ops: [
          { op: "intersect", shape: { t: "box", w: w + 2, d: t, h: ml + el + 2, at: [0, 0, -back - 1], r: 0 } },
          // the two solder tabs on the end cap
          { op: "add", shape: { t: "box", w: 1.6, d: 0.4, h: 2.4, at: [w / 4, 0, -back - 2.3], r: 0 } },
          { op: "add", shape: { t: "box", w: 1.6, d: 0.4, h: 2.4, at: [-w / 4, 0, -back - 2.3], r: 0 } },
        ],
      };
      const shaft = dShaft(sd, sl, bh, num(d, "shaft_flat", 0.5), sl * 0.85);
      const screw = screwFor(d, hd, true);
      return {
        placement: "axis",
        solids: [solid("", p.name, body, g.color ?? "#c9a24b", "Brass"), solid("can", `${p.name} motor`, can, g.color2 ?? ALU, "Steel"), solid("shaft", `${p.name} shaft`, shaft, STEEL, "Steel", true)],
        fields: {
          scalars: { shaft_d: sd, shaft_len: sl, w, t, length: back, ...mountScalars(screw, depth) },
          points: { face: Z0, at: Z0, shaft_tip: [0, 0, bh + sl], body_center: [0, 0, -back / 2], back: [0, 0, -back] },
          pointLists: { holes: holes.map(([x, y]) => [x, y, 0] as V3) },
          dirs: { axis: ZP },
          shapes: { mount: mountCut(holes, screw, bd + 0.6, 1) },
        },
      };
    }

    // tt_motor: the yellow "TT" hobby gearmotor. The output shaft runs along
    // Z right through the gearbox and `at` is its centre on the gearbox's +Z
    // face. The gearbox is gear_l long along X (the shaft shaft_x from its +X
    // end), gear_w wide (Y), gear_t thick (down -Z); the can (motor_d,
    // flattened to motor_t) sticks out along -X, motor_l long. Double-D shaft
    // shaft_d with shaft_af across the flats, shaft_l out of each face.
    // Through holes for long screws from `holes` (hole_d).
    case "tt_motor": {
      const gl = num(d, "gear_l", 37);
      const gw = num(d, "gear_w", 22.5);
      const gt = num(d, "gear_t", 18.8);
      const sx = num(d, "shaft_x", 11);
      const md = num(d, "motor_d", 20);
      const mt = num(d, "motor_t", 15);
      const ml = num(d, "motor_l", 25);
      const sd = num(d, "shaft_d", 5.4);
      const af = num(d, "shaft_af", 3.7);
      const sl = num(d, "shaft_l", 9);
      const hd = num(d, "hole_d", 3.2);
      const holes = g.holes ?? [];
      const x0 = sx - gl;
      const body: PartRecipe = {
        base: { t: "box", w: gl, d: gw, h: gt, at: [sx - gl / 2, 0, -gt], r: 1.5 },
        ops: holes.map(([x, y]) => ({ op: "cut" as const, shape: { t: "cyl" as const, d: hd, h: gt + 2, at: [x, y, -gt - 1] as V3, dir: ZP } })),
      };
      const can: PartRecipe = {
        base: { t: "cyl", d: md, h: ml + 0.02, at: [x0 + 0.01, 0, -gt / 2], dir: [-1, 0, 0] },
        ops: [{ op: "intersect", shape: { t: "box", w: ml + 4, d: md + 2, h: mt, at: [x0 - ml / 2, 0, -gt / 2 - mt / 2], r: 0 } }],
      };
      const total = gt + 2 * sl;
      const shaft: PartRecipe = { base: { t: "cyl", d: sd, h: total, at: [0, 0, -gt - sl], dir: ZP }, ops: [{ op: "intersect", shape: { t: "box", w: sd + 1, d: af, h: total + 2, at: [0, 0, -gt - sl - 1], r: 0 } }] };
      const screw = screwFor(d, hd, false);
      return {
        placement: "axis",
        solids: [solid("", p.name, body, g.color ?? "#f0c419", "ABS"), solid("can", `${p.name} motor`, can, g.color2 ?? ALU, "Steel"), solid("shaft", `${p.name} shaft`, shaft, "#f4f4f4", "ABS", true)],
        fields: {
          scalars: { shaft_d: sd, shaft_af: af, shaft_len: sl, gear_t: gt, gear_w: gw, length: gl + ml, ...mountScalars(screw, 0) },
          points: { face: Z0, at: Z0, back_face: [0, 0, -gt], shaft_tip: [0, 0, sl], shaft_tip2: [0, 0, -gt - sl], body_center: [sx - gl / 2, 0, -gt / 2], can_end: [x0 - ml, 0, -gt / 2] },
          pointLists: { holes: holes.map(([x, y]) => [x, y, 0] as V3) },
          dirs: { axis: ZP },
          shapes: { mount: mountCut(holes, screw, sd + 2, 1) },
        },
      };
    }

    // outrunner: brushless outrunner. `at` is the centre of the mounting face
    // (the back of the base), the bell and shaft point along +Z. base_d ×
    // base_h base, the bell (bell_d × bell_h) spins in front of it, the shaft
    // (shaft_d) sticks shaft_l past the bell. Tapped holes from `holes` in
    // the back face (hole_d tap drill, hole_depth deep: longer screws reach
    // the windings).
    case "outrunner": {
      const bd = num(d, "base_d", 28);
      const bh = num(d, "base_h", 4);
      const belld = num(d, "bell_d", 28);
      const bellh = num(d, "bell_h", 20);
      const sd = num(d, "shaft_d", 5);
      const sl = num(d, "shaft_l", 12);
      const hd = num(d, "hole_d", 2.5);
      const depth = num(d, "hole_depth", 3);
      const holes = g.holes ?? [];
      const base: PartRecipe = {
        base: { t: "cyl", d: bd, h: bh, at: Z0, dir: ZP },
        ops: holes.map(([x, y]) => ({ op: "cut" as const, shape: { t: "cyl" as const, d: hd, h: depth, at: [x, y, -0.01] as V3, dir: ZP } })),
      };
      const bell: PartRecipe = {
        base: { t: "cyl", d: belld, h: bellh, at: [0, 0, bh + 0.3], dir: ZP },
        ops: [{ op: "add", shape: { t: "cyl", d: sd + 5, h: 1.5, at: [0, 0, bh + 0.3 + bellh - 0.01], dir: ZP } }, { op: "chamfer", r: 0.8, edges: "bottom" }],
      };
      const top = bh + 0.3 + bellh + 1.5;
      const shaft: PartRecipe = { base: { t: "cyl", d: sd, h: sl, at: [0, 0, top - 0.01], dir: ZP }, ops: [{ op: "chamfer", r: 0.3, edges: "top" }] };
      const screw = screwFor(d, hd, true);
      return {
        placement: "axis",
        solids: [solid("", p.name, base, g.color ?? "#2a2e35", "Aluminum 6061"), solid("bell", `${p.name} bell`, bell, g.color2 ?? "#c0392b", "Aluminum 6061", true), solid("shaft", `${p.name} shaft`, shaft, STEEL, "Steel", true)],
        fields: {
          scalars: { shaft_d: sd, shaft_len: sl, bell_d: belld, length: top, ...mountScalars(screw, depth) },
          points: { face: Z0, at: Z0, shaft_tip: [0, 0, top + sl], bell_top: [0, 0, top], body_center: [0, 0, top / 2] },
          pointLists: { holes: holes.map(([x, y]) => [x, y, 0] as V3) },
          dirs: { axis: ZP },
          // the arm or plate is behind the motor: the cut runs back along -Z, with room for the shaft's circlip
          shapes: { mount: mountCut(holes, screw, sd + 4, -1) },
        },
      };
    }

    // edf: an electric ducted fan. `at` is the centre of the intake face and `axis` points out of the intake,
    // the way the fan pushes; the housing runs back along -Z to the exhaust. od housing outside diameter,
    // fan_d the bore, length intake to exhaust, hub_d the motor hub, blades rotor blades, stators stator
    // vanes, lead_az where the three motor leads leave the housing's side over the stator (degrees from +X). The housing and stator
    // are the main solid, the rotor the second (it spins). tabs mounting tabs round the intake ring (tab_t
    // thick, through holes hole_d on tab_circle, first at tab_start degrees) take screws and nuts into the
    // seat behind them; `mount` is that seat's cut: the housing bore back along -Z and a hole per tab. tabs: 0 is a
    // plain round housing, clamped by its ends. spinner_h sets the spinner's height in front of the rotor hub;
    // can_d and can_l show an inrunner's rear end can_l behind the hub in place of the tail cone (look: geom.edf).
    case "edf": {
      const od = num(d, "od", 70);
      const fd = num(d, "fan_d", 64);
      const L = num(d, "length", 66);
      const hd = num(d, "hub_d", 31);
      const nb = Math.max(3, Math.round(num(d, "blades", 12)));
      const ns = Math.max(3, Math.round(num(d, "stators", 6)));
      const laz = (num(d, "lead_az", 0) * Math.PI) / 180;
      const ri = fd / 2;
      const rh = hd / 2;
      // housing with a small chamfer on the intake lip (inside and out, leaving a flat between them), a stator
      // ring of vanes from the hub to the wall, the motor can, and the mounting tabs round the intake ring
      const lip = Math.min(1.2, (od - fd) / 6);
      const nt = Math.max(0, Math.round(num(d, "tabs", 4)));
      const tt = nt ? num(d, "tab_t", 3) : 0;
      const look = g.edf ?? {};
      const canD = Math.min(hd - 1, num(d, "can_d", 0));
      const canL = num(d, "can_l", 3);
      const tc = num(d, "tab_circle", od + 10);
      const thd = num(d, "hole_d", 3.2);
      const tabs = nt ? circlePts(nt, tc / 2, num(d, "tab_start", 45)).map((q) => [q[0], q[1]] as [number, number]) : [];
      const tab = ([x, y]: [number, number]): ShapeRecipe => {
        const a = (Math.atan2(y, x) * 180) / Math.PI;
        const w = tc / 2 - od / 2 + 4;
        return {
          t: "union",
          shapes: [
            { t: "cyl", d: thd + 4.4, h: tt, at: [x, y, -tt], dir: ZP },
            { t: "xform", shape: { t: "box", w, d: thd + 4.4, h: tt, at: [od / 2 - 2 + w / 2, 0, -tt], r: 0 }, xf: [{ op: "rotate", angle: a, origin: Z0, axis: ZP }] },
          ],
        };
      };
      // stator vanes: thin cambered blades from the hub to the wall, nearly axial, that take the swirl out of the jet
      const stator = (a: number): ShapeRecipe => radialBlade(a, rh - 0.6, ri + 0.6, -L * 0.7, L * 0.3, L * 0.3, 78, 78, 0.07, 0.06);
      const housing: PartRecipe = {
        base: { t: "tube", od, id: fd, h: L, at: [0, 0, -L], dir: ZP },
        ops: [
          { op: "chamfer", r: lip, edges: "top" },
          { op: "add", shape: { t: "cyl", d: hd, h: L * 0.72, at: [0, 0, -L], dir: ZP } },
          ...(canD > 0 ? [] : [{ op: "add" as const, shape: { t: "cone" as const, d1: hd, d2: hd * 0.55, h: L * 0.06, at: [0, 0, -L + 0.01] as V3, dir: ZN } }]),
          ...Array.from({ length: ns }, (_, i) => ({ op: "add" as const, shape: stator((360 * i) / ns + 90 / ns) })),
          ...tabs.map((q) => ({ op: "add" as const, shape: tab(q) })),
          ...tabs.map(([x, y]) => ({ op: "cut" as const, shape: { t: "cyl" as const, d: thd, h: tt + 2, at: [x, y, -tt - 1] as V3, dir: ZP } })),
        ],
      };
      const screw = screwFor(d, thd, false);
      // rotor: the hub under a rounded spinner, and twisted, tapered blades just behind the intake (steep at the
      // root, flatter at the tip), as many as the fan has, close to the wall
      const zr = -L * 0.08;
      const sh = Math.min(num(d, "spinner_h", Math.min(L * 0.07, hd * 0.3)), -zr - 0.3);
      // a metal spinner is its own solid sitting on the hub; a moulded one is part of the rotor
      const zs = look.spinner ? zr : zr - 0.01;
      const spinner: V2[] = [[0, zs], ...Array.from({ length: 6 }, (_, i) => {
        const t = i / 6;
        return [(rh - 0.3) * Math.sqrt(Math.max(0, 1 - t * t)) * (1 - 0.12 * t), zs + sh * t] as V2;
      }), [0, zs + sh]];
      const rootC = Math.min(L * 0.2, (2 * Math.PI * rh * 1.6) / nb);
      const blade = (a: number): ShapeRecipe => radialBlade(a, rh - 0.8, ri - 0.6, -L * 0.18, rootC, rootC * 1.15, 52, 30, 0.08, 0.05);
      const rotor: PartRecipe = {
        base: { t: "cyl", d: hd - 0.6, h: L * 0.2, at: [0, 0, -L * 0.28], dir: ZP },
        ops: [
          ...(look.spinner ? [] : [{ op: "add" as const, shape: { t: "revolve" as const, pts: spinner, at: Z0, dir: ZP } }]),
          ...Array.from({ length: nb }, (_, i) => ({ op: "add" as const, shape: blade((360 * i) / nb) })),
        ],
      };
      // an inrunner's rear end behind the hub: the can, its end bell and the bearing boss
      const motor: PartRecipe = {
        base: { t: "cyl", d: canD, h: canL + 1, at: [0, 0, -L - canL], dir: ZP },
        ops: [
          { op: "chamfer", r: Math.min(0.6, canL / 4), edges: "bottom" },
          { op: "add", shape: { t: "cyl", d: canD * 0.36, h: 0.8, at: [0, 0, -L - canL - 0.8], dir: ZP } },
        ],
      };
      // the three motor leads come out through a stator vane and leave the housing's side at lead_az, one behind
      // the other along the axis, as short stubs: the harness carries them on from there (harness/plugs.ts)
      const u: V3 = [Math.cos(laz), Math.sin(laz), 0];
      const leads: PartRecipe = {
        base: { t: "union", shapes: [0, 1, 2].map((k) => ({ t: "cyl" as const, d: 2.8, h: EDF_STUB + 2, at: edfLeadExit(d, k).p.map((v, i) => v - u[i] * (EDF_STUB + 2)) as V3, dir: u })) },
        ops: [],
      };
      const lead1 = edfLeadExit(d, 1).p;
      return {
        placement: "axis",
        solids: [
          solid("", p.name, housing, g.color ?? "#2b2f36", "Nylon"),
          solid("rotor", `${p.name} rotor`, rotor, g.color2 ?? "#c9ced6", "Nylon", true),
          ...(look.spinner ? [{ ...solid("spinner", `${p.name} spinner`, { base: { t: "revolve", pts: spinner, at: Z0, dir: ZP }, ops: [] }, look.spinner, look.spinner_material ?? "Aluminum 6061", true), finish: "polished" }] : []),
          ...(canD > 0 ? [solid("motor", `${p.name} motor`, motor, look.can ?? "#9aa0a8", look.can_material ?? "Aluminum 6061")] : []),
          solid("leads", `${p.name} motor leads`, leads, look.leads ?? "#1e2a5c", "PVC"),
        ],
        fields: {
          scalars: { od, fan_d: fd, hub_d: hd, length: L, tab_t: tt, ...mountScalars(screw, 0) },
          points: { at: Z0, intake: Z0, exhaust: [0, 0, -L], center: [0, 0, -L / 2], leads: lead1 },
          // the tab holes on the back of the tabs, where the seat behind them starts
          pointLists: { holes: tabs.map(([x, y]) => [x, y, -tt] as V3) },
          dirs: { axis: ZP },
          // the seat is behind the tabs: the housing's bore (0.4 mm clearance) and a hole per tab run back along -Z
          shapes: { mount: { t: "xform", shape: mountCut(tabs, screw, od + 0.4, -1, L), xf: [{ op: "translate", v: [0, 0, -tt] }] } },
        },
      };
    }

    // stepper: NEMA frame `size` square, body length `l` behind the face,
    // pilot_d/pilot_h, shaft_d/shaft_l (shaft_flat D-flat depth, flat_l
    // long; or key_w/key_l keyway), holes on a hole_spacing square. Small
    // frames have tapped holes in the front cap (hole_d tap drill,
    // hole_depth deep); flange_t > 0 is a through-hole flange (NEMA 23 and
    // up, hole_d clearance) with the corners behind it relieved for nuts.
    // Front cap, lamination stack and rear cap are separate solids (color,
    // color2).
    case "stepper": {
      const s = num(d, "size", 42.3);
      const L = num(d, "l", 40);
      const pd = num(d, "pilot_d", 22);
      const ph = num(d, "pilot_h", 2);
      const sd = num(d, "shaft_d", 5);
      const sl = num(d, "shaft_l", 24);
      const hs = num(d, "hole_spacing", 31) / 2;
      const hd = num(d, "hole_d", 2.5);
      const ft = num(d, "flange_t", 0);
      const depth = num(d, "hole_depth", 4.5);
      const holes2: [number, number][] = [
        [hs, hs],
        [-hs, hs],
        [-hs, -hs],
        [hs, -hs],
      ];
      const holes = holes2.map(([x, y]) => [x, y, 0] as V3);
      const r = Math.min(4, s / 10);
      const cap = Math.min(Math.max(L * 0.2, 4), 12);
      const fc = Math.min(Math.max(cap, ft), L * 0.6);
      const rc = Math.min(cap, (L - fc) / 3);
      const stack = L - fc - rc;
      // room behind a through-hole flange for the nut or screw head
      const relief = (z0: number, h: number): PartRecipe["ops"] => (ft > 0 ? holes.map((p) => ({ op: "cut" as const, shape: { t: "cyl" as const, d: hd * 2.2, h: h + 0.2, at: [p[0], p[1], z0 - 0.1] as V3, dir: ZP } })) : []);
      const front: PartRecipe = {
        base: { t: "box", w: s, d: s, h: fc, at: [0, 0, -fc], r },
        ops: [
          { op: "add", shape: { t: "cyl", d: pd, h: ph, at: [0, 0, -0.01], dir: ZP } },
          ...holes.map((h) => (ft > 0 ? { op: "cut" as const, shape: { t: "cyl" as const, d: hd, h: ft + 0.2, at: [h[0], h[1], -ft - 0.1] as V3, dir: ZP } } : { op: "cut" as const, shape: { t: "hole" as const, d: hd, depth, at: h, dir: ZN } })),
          ...(fc > ft && ft > 0 ? relief(-fc, fc - ft) : []),
        ],
      };
      const lam: PartRecipe = { base: { t: "box", w: s, d: s, h: stack, at: [0, 0, -fc - stack], r: r * 0.5 }, ops: relief(-fc - stack, stack) };
      const rear: PartRecipe = { base: { t: "box", w: s, d: s, h: rc, at: [0, 0, -L], r }, ops: relief(-L, rc) };
      const flat = num(d, "shaft_flat", sd <= 6.4 ? 0.5 : 0);
      const shaft = dShaft(sd, sl, ph - 1, flat, num(d, "flat_l", Math.min(sl - 2, 15)), num(d, "key_w", 0), num(d, "key_l", sl * 0.75));
      const screw = screwFor(d, hd, ft <= 0);
      const capColor = g.color ?? "#24272d";
      return {
        placement: "axis",
        solids: [
          solid("", p.name, front, capColor, "Aluminum 6061"),
          ...(stack > 0.5 ? [solid("stack", `${p.name} stator`, lam, g.color2 ?? "#8e949c", "Steel")] : []),
          ...(rc > 0.5 ? [solid("cap", `${p.name} end cap`, rear, capColor, "Aluminum 6061")] : []),
          solid("shaft", `${p.name} shaft`, shaft, STEEL, "Stainless 304", true),
        ],
        fields: {
          scalars: { body: s, length: L, pilot_d: pd, pilot_h: ph, shaft_d: sd, shaft_len: sl, hole_spacing: hs * 2, flange_t: ft, ...mountScalars(screw, ft > 0 ? 0 : depth) },
          points: { face: Z0, at: Z0, shaft_tip: [0, 0, ph - 1 + sl], back: [0, 0, -L], body_center: [0, 0, -L / 2] },
          pointLists: { holes },
          dirs: { axis: ZP },
          shapes: { mount: mountCut(holes2, screw, pd + 0.4, 1) },
        },
      };
    }

    // servo: output spline on the Z axis, `at` on the top face of the case.
    // w (long side, along X), d, h (case height below the top face),
    // flange_w (tab length end to end), flange_t, flange_z (distance from
    // the top face down to the tab top), shaft_x (spline offset from the case
    // centre along X), hole spacing from `holes`. Drawn as the real case is
    // made: the top cover (output boss and the idler gear's bump), the middle
    // case with the tabs (holes slotted out to the tab ends), the bottom cover
    // with its long case screws, a sticker on each side, and the lead's boot
    // where the harness takes the lead from (harness/plugs.ts). g.servo sets
    // the colours (an alloy middle, a metal spline); all of it inside the
    // envelope the mounts and clash checks have always seen.
    case "servo": {
      const w = num(d, "w", 40.7);
      const dd = num(d, "d", 19.7);
      const h = num(d, "h", 37);
      const fw = num(d, "flange_w", 54);
      const ft = num(d, "flange_t", 2.5);
      const fz = num(d, "flange_z", 10);
      const sx = num(d, "shaft_x", 10);
      const holes = g.holes ?? [];
      const look = g.servo ?? {};
      const cx = -sx;
      const micro = dd < 15;
      const hb = Math.min(8, Math.max(3, h * 0.2));
      const zb = -h + hb;
      // the middle case, tabs on its top: holes slotted out to the tab ends, and the recess the lead's boot sits in
      const holeD = g.hole_d ?? 4.5;
      const endX = w / 2 - sx;
      const bootW = Math.min(micro ? 4.6 : 6.5, dd * 0.42);
      const bootH = Math.min(micro ? 2.4 : 3.4, h * 0.12);
      const boot = (grow: number, proud: number): ShapeRecipe => box(1.4 + proud + grow, bootW + grow, bootH + grow, [endX - 1.4 / 2 + proud / 2, 0, -h / 2 - (bootH + grow) / 2]);
      const body: PartRecipe = {
        base: box(w, dd, -fz - zb, [cx, 0, zb], 0.8),
        ops: [
          { op: "chamfer", r: 0.25, edges: "bottom" },
          { op: "add", shape: box(fw, dd, ft, [cx, 0, -fz - ft], 0.5) },
          ...holes.map(([x, y]) => ({ op: "cut" as const, shape: { t: "cyl" as const, d: holeD, h: ft + 2, at: [x, y, -fz - ft - 1] as V3, dir: ZP } })),
          ...holes.map(([x, y]) => {
            const end = x >= cx ? cx + fw / 2 + 1 : cx - fw / 2 - 1;
            return { op: "cut" as const, shape: box(Math.abs(end - x), holeD * 0.45, ft + 2, [(x + end) / 2, y, -fz - ft - 1]) };
          }),
          { op: "cut", shape: boot(0.02, 0) },
        ],
      };
      // the top cover: soft top edge, the output boss round the spline and the lower bump over the idler gear
      const bossD = Math.min(12, dd - 0.2, 2 * endX - 0.4);
      const bumpD = dd * 0.5;
      const top: PartRecipe = {
        base: box(w, dd, fz, [cx, 0, -fz], 0.8),
        ops: [
          { op: "chamfer", r: Math.min(0.5, fz / 6), edges: "top" },
          { op: "chamfer", r: 0.25, edges: "bottom" },
          { op: "add", shape: { t: "cyl", d: bossD, h: 2, at: [0, 0, -0.01], dir: ZP } },
          { op: "add", shape: { t: "cyl", d: bumpD, h: 0.8, at: [-(bossD / 2 + bumpD / 2 - 2), 0, -0.01], dir: ZP } },
        ],
      };
      // the bottom cover and its case screws (two in a micro, four in a standard case), heads sunk in it
      const sd = Math.min(4.2, Math.max(2, dd * 0.22));
      const sdepth = micro ? 0.7 : 1.2;
      const inset = micro ? 1.9 : 2.6;
      const screwsAt: V2[] = micro
        ? [[cx + w / 2 - inset, 0], [cx - w / 2 + inset, 0]]
        : [[cx + w / 2 - inset, dd / 2 - inset], [cx + w / 2 - inset, -dd / 2 + inset], [cx - w / 2 + inset, dd / 2 - inset], [cx - w / 2 + inset, -dd / 2 + inset]];
      const bottom: PartRecipe = {
        base: box(w, dd, hb, [cx, 0, -h], 0.8),
        ops: [{ op: "chamfer", r: 0.4, edges: "bottom" }, { op: "chamfer", r: 0.25, edges: "top" }, ...screwsAt.map(([x, y]) => ({ op: "cut" as const, shape: { t: "cyl" as const, d: sd, h: sdepth + 0.01, at: [x, y, -h - 0.01] as V3, dir: ZP } }))],
      };
      const hh = 0.45;
      const slotL = sd * 0.55;
      const caseScrews: PartRecipe = {
        base: { t: "union", shapes: screwsAt.map(([x, y]) => ({ t: "cyl" as const, d: sd - 0.5, h: hh, at: [x, y, -h + sdepth - hh] as V3, dir: ZP })) },
        ops: screwsAt.flatMap(([x, y]) => [box(slotL, 0.3, 0.3, [x, y, -h + sdepth - hh - 0.05]), box(0.3, slotL, 0.3, [x, y, -h + sdepth - hh - 0.05])].map((shape) => ({ op: "cut" as const, shape }))),
      };
      // a sticker on each side of the middle case, below the tabs, with the maker's and the model's names as bars
      // (the 3D view prints the real label over it and hides the bars)
      const sb = servoStickerBox(d);
      const lz0 = sb?.z0 ?? 0;
      const lh = sb?.h ?? 0;
      const lw = sb?.w ?? 0;
      const stickers: CompSolid[] = [];
      if (sb) {
        // a thin plate on each face (0.12 mm proud, the print 0.24), both sunk a little into the case so no gap shows
        const plate = (len: number, ph: number, x: number, z: number, proud: number, r: number) => [1, -1].map((sy) => box(len, proud + 0.1, ph, [x, sy * (dd / 2 + (proud - 0.1) / 2), z], r));
        stickers.push(solid("label", `${p.name} label`, { base: { t: "union", shapes: plate(lw, lh, cx, lz0, 0.12, 0.3) }, ops: [] }, look.label ?? "#15171b", "PVC"));
        const bar = (len: number, bh: number, z: number) => plate(len, bh, cx - lw / 2 + 1.2 + len / 2, z, 0.24, 0);
        stickers.push(solid("label_text", `${p.name} label print`, { base: { t: "union", shapes: [...bar(lw * 0.52, Math.max(0.6, lh * 0.11), lz0 + lh * 0.66), ...bar(lw * 0.36, Math.max(0.9, lh * 0.17), lz0 + lh * 0.3)] }, ops: [] }, look.text ?? "#e9ecef", "PVC"));
      }
      // the spline's tapped centre hole for the horn screw (M3 in a standard servo, M2 in a micro), on into the output shaft
      const splineD = num(d, "spline_d", 5.8);
      const hornScrew = num(d, "horn_screw", splineD >= 5.5 ? 3 : 2);
      const tap = hornScrew >= 3 ? 2.5 : hornScrew * 0.8;
      top.ops.push({ op: "cut", shape: { t: "cyl", d: tap, h: 4, at: [0, 0, -2], dir: ZP } });
      const spline: PartRecipe = { base: { t: "cyl", d: splineD, h: 4, at: [0, 0, 1.9], dir: ZP }, ops: [{ op: "chamfer", r: 0.3, edges: "top" }, { op: "cut", shape: { t: "cyl", d: tap, h: 5, at: [0, 0, 1.4], dir: ZP } }] };
      // the case drops through a pocket in the plate and the tabs sit on it: screws through the tabs, nuts under
      const screw = screwFor(d, (g.hole_d ?? 4.5) >= 3.5 ? 3.6 : 2.3, false);
      const under = -fz - ft;
      const pocket: ShapeRecipe = {
        t: "union",
        shapes: [{ t: "box", w: w + 0.8, d: dd + 0.8, h: 40, at: [-sx, 0, under - 40 + 0.01], r: 0.8 }, ...holes.map(([x, y]) => ({ t: "cyl" as const, d: screw.clearance, h: 40, at: [x, y, under + 0.01] as V3, dir: ZN }))],
      };
      return {
        placement: "axis",
        solids: [
          solid("", p.name, body, look.mid ?? g.color ?? "#1b1f25", look.mid_material ?? "ABS"),
          solid("top", `${p.name} top cover`, top, g.color ?? "#1b1f25", "ABS"),
          solid("bottom", `${p.name} bottom cover`, bottom, g.color ?? "#1b1f25", "ABS"),
          solid("screws", `${p.name} case screws`, caseScrews, "#7d838c", "Steel"),
          solid("boot", `${p.name} lead boot`, { base: boot(0, 0.2), ops: [] }, "#121417", "PVC"),
          ...stickers,
          solid("horn", `${p.name} spline`, spline, look.spline ?? "#e8e9eb", look.spline_material ?? "POM", true),
        ],
        fields: {
          scalars: { w, d: dd, h, flange_z: fz, flange_t: ft, horn_screw: hornScrew, ...mountScalars(screw, 0) },
          points: { at: Z0, spline_top: [0, 0, 5.9], case_center: [-sx, 0, -h / 2], tab_under: [0, 0, under] },
          pointLists: { holes: holes.map(([x, y]) => [x, y, -fz] as V3) },
          dirs: { axis: ZP },
          shapes: { mount: pocket },
        },
      };
    }

    // bus_servo: a serial bus servo with an output horn and an idler horn (geometryBusServo.ts)
    case "bus_servo":
      return busServoGeometry(p);

    // desk_supply and endoscope: a desktop power supply and a USB endoscope's head (geometryBenchParts.ts)
    case "desk_supply":
      return deskSupplyGeometry(p);
    case "endoscope":
      return endoscopeGeometry(p);

    // box: batteries, power supplies, modules. w (X), d (Y), h (Z), r corner
    // radius; `at` is the centre of the bottom face. band: a wrap band height.
    // style: draw a known kind of part in detail (boxLook), inside the same box.
    case "box": {
      const w = num(d, "w", 50);
      const dd = num(d, "d", 30);
      const h = num(d, "h", 20);
      const r = Math.min(num(d, "r", 1), Math.min(w, dd) / 2 - 0.1);
      const holes = g.holes ?? [];
      const look = g.style ? boxLook(g.style, p, w, dd, h, r) : undefined;
      const body: PartRecipe = {
        base: look?.base ?? { t: "box", w, d: dd, h, at: Z0, r },
        // mounting holes up from the bottom face: blind (6 mm) unless hole_depth says how deep (a blower's ears go right through)
        ops: [
          ...holes.map(([x, y]) => ({ op: "cut" as const, shape: { t: "hole" as const, d: g.hole_d ?? 3, depth: num(d, "hole_depth", 6), at: [x, y, 0] as V3, dir: ZP } })),
          ...(look?.cuts ?? []).map((shape) => ({ op: "cut" as const, shape })),
        ],
      };
      const solids = [{ ...solid("", p.name, body, look?.color ?? g.color ?? "#2b3038", g.material ?? "ABS"), ...(look?.finish ? { finish: look.finish } : {}) }, ...(look?.solids ?? [])];
      const band = look ? 0 : num(d, "band", 0);
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
      // each slot: the opening between the lips, then the T-nut cavity under them, narrowing toward the core's flat
      // (so a T-nut's body fits under the lips, a screw reaches down to the core, and the core stays joined to the
      // walls by its diagonal webs)
      const lip = num(d, "lip", 1.8);
      const cav = Math.min(11, sw + 4.8);
      const bot = sw - 0.2;
      const slot = (s: V2, n: V2): V2[] => {
        // s: centre of the opening on the face, n: inward normal; points across (t) and in (n)
        const t: V2 = [-n[1], n[0]];
        const at = (a: number, b: number): V2 => [s[0] + t[0] * a + n[0] * b, s[1] + t[1] * a + n[1] * b];
        return [at(-sw / 2, -0.05), at(sw / 2, -0.05), at(sw / 2, lip), at(cav / 2, lip), at(bot / 2, sdp), at(-bot / 2, sdp), at(-cav / 2, lip), at(-sw / 2, lip)];
      };
      const cutSlot = (pts: V2[]) => ops.push({ op: "cut", shape: { t: "prism", pts, h: L + 2, at: [0, 0, -1], dir: ZP, rot: 0 } });
      for (let i = 0; i < nx; i++) {
        const x = -w / 2 + 10 + 20 * i;
        cutSlot(slot([x, h / 2], [0, -1]));
        cutSlot(slot([x, -h / 2], [0, 1]));
      }
      for (let j = 0; j < ny; j++) {
        const y = -h / 2 + 10 + 20 * j;
        cutSlot(slot([w / 2, y], [-1, 0]));
        cutSlot(slot([-w / 2, y], [1, 0]));
      }
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) ops.push({ op: "cut", shape: { t: "cyl", d: bore, h: L + 2, at: [-w / 2 + 10 + 20 * i, -h / 2 + 10 + 20 * j, -1], dir: ZP } });
      return {
        placement: "axis",
        solids: [solid("", `${p.name} × ${Math.round(L)} mm`, { base: { t: "box", w, d: h, h: L, at: Z0, r: 1.5 }, ops }, g.color ?? ALU, "Aluminum 6061")],
        fields: {
          scalars: { length: L, w, h, slot_w: sw, lip },
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
      // each hole counterbored from the top so the screw head sits below the carriage's path
      const cbd = num(d, "rail_cbore_d", 6);
      const cbh = Math.min(num(d, "rail_cbore_h", 4.5), rh * 0.6);
      for (let i = 0; i < Math.min(holeCount, 60); i++) {
        ops.push({ op: "cut", shape: { t: "cyl", d: num(d, "rail_hole_d", 3.5), h: rh + 2, at: [0, -1, first + i * pitch], dir: YP } });
        ops.push({ op: "cut", shape: { t: "cyl", d: cbd, h: cbh + 1, at: [0, rh - cbh, first + i * pitch], dir: YP } });
      }
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
          // M3 tapped holes in the carriage's top
          ...bholes.map((h) => ({ op: "cut" as const, shape: { t: "hole" as const, d: 2.5, depth: 5, at: [h[0], bh, h[2]] as V3, dir: [0, -1, 0] as V3, fit: "tap", threadName: "M3" } })),
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
      // smooth idlers: the belt runs on contact_d; toothed pulleys are drawn to just inside their tooth tips
      const contact = num(d, "contact_d", 0);
      const groove = contact > 0 ? contact / 2 : pd / 2 - 0.4;
      const r = (x: number) => x / 2;
      const pts: V2[] = [
        [r(bore), 0],
        [r(hd), 0],
        [r(hd), hl],
        [r(od), hl],
        [r(od), hl + 1],
        [groove, hl + 1],
        [groove, hl + 1 + w],
        [r(od), hl + 1 + w],
        [r(od), hl + 2 + w],
        [r(bore), hl + 2 + w],
      ];
      return {
        placement: "axis",
        solids: [solid("", p.name, { base: { t: "revolve", pts, at: Z0, dir: ZP }, ops: [] }, g.color ?? ALU, "Aluminum 6061", true)],
        fields: {
          scalars: { pd, od, width: hl + 2 + w, bore, belt_z: hl + 1 + w / 2, groove_w: w, ...(contact > 0 ? { contact_d: contact } : {}) },
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
      const hs = num(d, "hole_spacing", 31) / 2;
      const screwHoles: [number, number][] = [
        [hs, hs],
        [-hs, -hs],
        [hs, -hs],
      ];
      const body: PartRecipe = {
        base: { t: "box", w, d: h, h: dd, at: Z0, r: 3 },
        ops: [
          { op: "cut", shape: { t: "cyl", d: 2.2, h: h + 2, at: [fx, -h / 2 - 1, dd / 2], dir: YP } },
          // the motor's 22 mm pilot and its shaft (carrying the drive pinion) go into the motor face
          { op: "cut", shape: { t: "cyl", d: 22.6, h: 2.5, at: [0, 0, -0.01], dir: ZP } },
          { op: "cut", shape: { t: "cyl", d: 5.6, h: Math.min(26, dd - 2), at: [0, 0, -0.01], dir: ZP } },
          // three of the motor's four screws run through it from the back face (the idler arm covers the fourth)
          ...screwHoles.map(([x, y]) => ({ op: "cut" as const, shape: { t: "cyl" as const, d: 3.4, h: dd + 0.02, at: [x, y, -0.01] as V3, dir: ZP } })),
        ],
      };
      return {
        placement: "axis",
        solids: [solid("", p.name, body, g.color ?? "#20242b", "Nylon")],
        fields: {
          scalars: { w, d: dd, h },
          points: { at: Z0, filament_in: [fx, h / 2, dd / 2], filament_out: [fx, -h / 2, dd / 2], top: [0, 0, dd] },
          pointLists: { holes: screwHoles.map(([x, y]) => [x, y, dd] as V3) },
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
      // with `blades` the fan is drawn as the real part: a barrel between two square flanges, the impeller
      // (blades, hub_d hub) on the intake side and the motor on `struts` struts at the outlet (bore_d bore,
      // flange_t flanges). Air goes in at z = 0 and out at z = t, as for the plain shape below.
      const nb = Math.round(num(d, "blades", 0));
      if (nb >= 3) {
        const hd = num(d, "hole_d", 3.4);
        const bore = num(d, "bore_d", s * 0.96);
        const hub = num(d, "hub_d", s * 0.5);
        const ft = num(d, "flange_t", Math.min(4.5, t / 5));
        const ns = Math.max(3, Math.round(num(d, "struts", 4)));
        const sz = Math.min(8, t * 0.22);
        const rb = bore / 2;
        const rh = hub / 2;
        const flange = (z: number): ShapeRecipe => ({ t: "box", w: s, d: s, h: ft, at: [0, 0, z], r: Math.min(6, s / 16) });
        const strut = (a: number, w: number): ShapeRecipe => ({ t: "xform", shape: { t: "box", w: rb - rh + 2, d: w, h: sz, at: [(rb + rh) / 2, 0, t - sz - 0.6], r: 0 }, xf: [{ op: "rotate", angle: a, origin: Z0, axis: ZP }] });
        const frame: PartRecipe = {
          base: { t: "tube", od: s, id: bore, h: t, at: Z0, dir: ZP },
          ops: [
            { op: "add", shape: flange(0) },
            { op: "add", shape: flange(t - ft) },
            // a tube round each screw hole joins the flanges, so a long screw clamps solid plastic
            ...holes.map((h) => ({ op: "add" as const, shape: { t: "cyl" as const, d: hd + 4.6, h: t, at: [h[0], h[1], 0] as V3, dir: ZP } })),
            { op: "cut", shape: { t: "cyl", d: bore, h: t + 2, at: [0, 0, -1], dir: ZP } },
            ...holes.map((h) => ({ op: "cut" as const, shape: { t: "cyl" as const, d: hd, h: t + 2, at: [h[0], h[1], -1] as V3, dir: ZP } })),
            // the motor's seat and the struts that carry it; the widest strut carries the cable
            { op: "add", shape: { t: "cyl", d: hub, h: sz + 2.4, at: [0, 0, t - sz - 2.6], dir: ZP } },
            ...Array.from({ length: ns }, (_, i) => ({ op: "add" as const, shape: strut((360 * i) / ns + 45, i === 0 ? 7 : 3.2) })),
          ],
        };
        const zb = (t - sz - 2.6) * 0.5 + 0.6;
        const c0 = Math.min((2 * Math.PI * rh * 1.25) / nb, (t - sz - 5) / Math.sin((40 * Math.PI) / 180));
        const blade = (a: number): ShapeRecipe => radialBlade(a, rh - 1, rb - 1, zb, c0, c0 * 1.5, -40, -24, 0.07, -0.06);
        const rotor: PartRecipe = {
          base: { t: "cyl", d: hub, h: t - sz - 4.2, at: [0, 0, 1], dir: ZP },
          ops: [
            { op: "chamfer", r: Math.min(2, hub / 12), edges: "bottom" },
            ...Array.from({ length: nb }, (_, i) => ({ op: "add" as const, shape: blade((360 * i) / nb) })),
            // the blades' flat sections reach past the barrel at their corners: turn the tips to a round, 1.2 mm clear of it
            { op: "cut", shape: { t: "tube", od: s * 2, id: bore - 2.4, h: t + 2, at: [0, 0, -1], dir: ZP } },
          ],
        };
        // the maker's label on the motor seat, on the outlet side
        const label: PartRecipe = { base: { t: "cyl", d: hub * 0.82, h: 0.15, at: [0, 0, t - 0.2], dir: ZP }, ops: [] };
        return {
          placement: "axis",
          solids: [
            solid("", p.name, frame, g.color ?? BLACK, "PBT"),
            solid("rotor", `${p.name} impeller`, rotor, g.color2 ?? "#1c1e22", "PBT", true),
            solid("label", `${p.name} label`, label, "#c9ccd1", "PET"),
          ],
          fields: { scalars: { size: s, t }, points: { at: Z0, outlet: [0, 0, t] }, pointLists: { holes }, dirs: { axis: ZP } },
        };
      }
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
      // clevis pin holes at both ends
      const pin = num(d, "pin_d", 4.2);
      const body: PartRecipe = { base: { t: "box", w: bw, d: bd, h: bl, at: [0, 0, -4], r: 2 }, ops: [{ op: "cut", shape: { t: "cyl", d: pin, h: bd + 2, at: [0, -bd / 2 - 1, 0], dir: YP } }] };
      const rod: PartRecipe = {
        base: { t: "cyl", d: rd, h: Math.max(1, end - bl), at: [0, 0, bl - 4], dir: ZP },
        ops: [
          { op: "add", shape: { t: "box", w: Math.max(8, rd + 2), d: Math.max(8, rd + 2), h: 8, at: [0, 0, end - 4], r: 1 } },
          { op: "cut", shape: { t: "cyl", d: pin, h: Math.max(10, rd + 2), at: [0, -Math.max(5, rd / 2 + 1), end], dir: YP } },
        ],
      };
      return {
        placement: "axis",
        solids: [solid("", p.name, body, g.color ?? "#2a2e35", "Aluminum 6061"), solid("rod", `${p.name} rod`, rod, STEEL, "Stainless 304", true)],
        fields: {
          scalars: { stroke, ret_l: ret, length: end, travel: ext, pin_d: pin },
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
      // with `lip_d` it is a moulded barrel jack (DC-022 and its kin): a round threaded body that goes in from the
      // front until its lip (lip_d across, nut_t thick) meets the panel, a hex nut (nut_af, rear_nut_t) behind the
      // panel, the plug's socket (socket_d, with a pin_d pin) in the front and solder eyes at the back
      const lipD = num(d, "lip_d", 0);
      if (lipD) {
        const sd = num(d, "socket_d", 6.3);
        const pd = num(d, "pin_d", 2.1);
        const rn = num(d, "rear_nut_t", 3);
        const sock = Math.min(11, bl + pt - 2);
        const body: PartRecipe = {
          base: { t: "cyl", d: lipD, h: nt, at: Z0, dir: ZP },
          ops: [
            { op: "chamfer", r: Math.min(0.6, nt / 3), edges: "top" },
            { op: "add", shape: { t: "cyl", d: bd, h: pt + bl, at: [0, 0, -pt - bl], dir: ZP } },
            // the flat plate at the back that carries the solder eyes
            { op: "add", shape: { t: "box", w: bw, d: bdd, h: 1.6, at: [0, 0, -pt - bl - 1.6], r: 1 } },
            { op: "cut", shape: { t: "cyl", d: sd, h: sock + 1, at: [0, 0, nt - sock], dir: ZP } },
          ],
        };
        const nut: PartRecipe = {
          base: { t: "prism", pts: hex, h: rn, at: [0, 0, -pt - rn], dir: ZP, rot: 0 },
          ops: [{ op: "cut", shape: { t: "cyl", d: bd, h: rn + 2, at: [0, 0, -pt - rn - 1], dir: ZP } }],
        };
        // the centre pin, and the sleeve spring that presses on the plug's barrel
        const contacts: ShapeRecipe[] = [
          { t: "cyl", d: pd, h: sock - 1.5, at: [0, 0, nt - sock], dir: ZP },
          { t: "box", w: 1.6, d: 0.4, h: sock - 4, at: [0, sd / 2 - 0.3, nt - sock], r: 0 },
        ];
        const eyes: ShapeRecipe[] = [
          { t: "box", w: 2.5, d: 0.4, h: 6, at: [-bw / 4, 0, -pt - bl - 7.1], r: 0 },
          { t: "box", w: 2.5, d: 0.4, h: 6, at: [bw / 4, 0, -pt - bl - 7.1], r: 0 },
          { t: "box", w: 0.4, d: 2.5, h: 5, at: [0, bdd / 2 - 1.2, -pt - bl - 6.1], r: 0 },
        ];
        return {
          placement: "axis",
          solids: [
            solid("", p.name, body, g.color ?? BLACK, "Nylon"),
            solid("nut", `${p.name} nut`, nut, g.color ?? BLACK, "Nylon"),
            solid("pin", `${p.name} contacts`, { base: { t: "union", shapes: contacts }, ops: [] }, "#c9ced6", "Brass"),
            solid("lugs", `${p.name} solder eyes`, { base: { t: "union", shapes: eyes }, ops: [] }, "#c9ced6", "Brass"),
          ],
          fields: {
            scalars: { hole_d: num(d, "hole_d", bd + 0.2), panel_t: pt, body_l: bl, depth: pt + bl + 7.5 },
            points: { at: Z0, front: Z0, back: [0, 0, -pt - bl], lug_a: [-bw / 4, 0, -pt - bl - 6.5], lug_b: [bw / 4, 0, -pt - bl - 6.5] },
            dirs: { axis: ZP },
          },
        };
      }
      // a push button's cap (a mushroom for an emergency stop) stands on the nut, in the part's colour
      const capD = num(d, "cap_d", 0);
      const solids = [
        solid("", p.name, { base: { t: "box", w: bw, d: bdd, h: bl, at: [0, 0, -pt - bl], r: 0.5 }, ops: [] }, g.color2 ?? DARK, "Nylon"),
        solid("front", `${p.name} bushing and nut`, front, capD ? STEEL : (g.color ?? STEEL), "Stainless 304"),
        solid("lugs", `${p.name} solder lugs`, { base: { t: "union", shapes: lugs }, ops: [] }, "#c9ced6", "Stainless 304"),
      ];
      if (capD) solids.push(solid("cap", `${p.name} cap`, { base: { t: "cyl", d: capD, h: num(d, "cap_h", 3), at: [0, 0, nt], dir: ZP }, ops: [{ op: "fillet", r: Math.min(1.5, num(d, "cap_h", 3) / 3), edges: "top" }] }, g.color ?? STEEL, capD > 30 ? "ABS" : "Stainless 304"));
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
          solid("cone", `${p.name} cone`, cone, g.color ?? "#2a2623", "Silicone"),
          solid("cap", `${p.name} dust cap`, cap, "#1d1b19", "Silicone"),
          solid("magnet", `${p.name} magnet`, magnet, "#4a4e55", "Steel"),
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
          { op: "cut", shape: { t: "cyl", d: 6.2, h: 11, at: [0, 0, -1], dir: ZP } },
        ],
      };
      const pointer: ShapeRecipe[] = [
        { t: "box", w: 1, d: kd * 0.45 - 1, h: 0.3, at: [0, (kd * 0.45) / 2 + 0.5, h - 0.05], r: 0 },
        { t: "box", w: 1, d: (sd - kd) / 2 + 0.4, h: 0.3, at: [0, kd / 2 + (sd - kd) / 4, sh - 0.05], r: 0 },
      ];
      return {
        placement: "axis",
        solids: [solid("", p.name, body, g.color ?? BLACK, "ABS"), solid("pointer", `${p.name} pointer`, { base: { t: "union", shapes: pointer }, ops: [] }, g.color2 ?? "#f2f2f2", "PC", true)],
        fields: { scalars: { d: kd, skirt_d: sd, h, bore: 10 }, points: { at: Z0, top: [0, 0, h] }, dirs: { axis: ZP } },
      };
    }

    // led: an addressable LED board. A ring (od, id > 0) or jewel (od, id 0:
    // six round one in the middle) lies on the local XY plane with its LEDs
    // facing +Z and `at` the centre of its back; a stick (w × d) lies flat
    // with `at` the centre of its underside and its n LEDs along X. t board
    // thickness, led the LED package's side (5050: 5), led_h its height.
    case "led": {
      const n = Math.max(1, Math.round(num(d, "n", 12)));
      const t = num(d, "t", 1.6);
      const ls = num(d, "led", 5);
      const lh = num(d, "led_h", 1.6);
      const od = num(d, "od", 0);
      const idd = num(d, "id", 0);
      const w = num(d, "w", 0);
      const leds = ledLayout(d);
      const board: PartRecipe =
        w > 0
          ? { base: { t: "box", w, d: num(d, "d", 10), h: t, at: Z0, r: 1 }, ops: [] }
          : idd > 0
            ? { base: { t: "tube", od, id: idd, h: t, at: Z0, dir: ZP }, ops: [] }
            : { base: { t: "cyl", d: od, h: t, at: Z0, dir: ZP }, ops: [] };
      const pkg: ShapeRecipe[] = leds.map(({ p: c, a }) => ({
        t: "prism",
        pts: [
          [-ls / 2, -ls / 2],
          [ls / 2, -ls / 2],
          [ls / 2, ls / 2],
          [-ls / 2, ls / 2],
        ].map(([x, y]) => [c[0] + x * Math.cos(a) - y * Math.sin(a), c[1] + x * Math.sin(a) + y * Math.cos(a)] as V2),
        h: lh,
        at: [0, 0, t] as V3,
        dir: ZP,
        rot: 0,
      }));
      return {
        placement: w > 0 ? "free" : "axis",
        solids: [solid("", p.name, board, g.color ?? BLACK, "FR4"), solid("leds", `${p.name} LEDs`, { base: { t: "union", shapes: pkg }, ops: [] }, "#f4f1e8", "PC")],
        fields: {
          scalars: { leds: n, od, id: idd, t, height: t + lh },
          points: { back: Z0, bottom: Z0, face: [0, 0, t + lh], top: [0, 0, t + lh], center: [0, 0, (t + lh) / 2] },
          pointLists: { leds: leds.map((l) => [l.p[0], l.p[1], t + lh] as V3) },
          dirs: { axis: ZP },
        },
      };
    }

    // disc: a plain cylinder d × h on Z from `at` (a magnet, a slip ring's
    // body), with a collar_d × collar_h collar on its far end that turns with
    // whatever the part turns with (a slip ring's rotor).
    case "disc": {
      const dd = num(d, "d", 6);
      const h = num(d, "h", 3);
      const cd = num(d, "collar_d", 0);
      const ch = num(d, "collar_h", 0);
      const solids = [solid("", p.name, { base: { t: "cyl", d: dd, h, at: Z0, dir: ZP }, ops: [] }, g.color ?? STEEL, g.material ?? "Steel")];
      if (cd > 0 && ch > 0) solids.push(solid("collar", `${p.name} turning collar`, { base: { t: "cyl", d: cd, h: ch + 0.01, at: [0, 0, h - 0.01], dir: ZP }, ops: [] }, "#9aa0a8", g.material ?? "Steel", true));
      return {
        placement: "axis",
        solids,
        fields: { scalars: { d: dd, h, length: h + ch }, points: { at: Z0, end: [0, 0, h + ch], body_end: [0, 0, h], center: [0, 0, h / 2] }, dirs: { axis: ZP } },
      };
    }

    // brick: plug-in power supply lying flat, `at` the centre of its bottom
    // face, cord leaving the +X end. w × d × h.
    case "brick": {
      const w = num(d, "w", 100);
      const dd = num(d, "d", 48);
      const h = num(d, "h", 32);
      // `inlet: 1` draws a desktop supply as sold: a three-pin mains inlet (IEC C14) in the end away from the
      // cord, a power light, the split line of the two shell halves and a ribbed strain relief, with the
      // maker's rating label in the recess on top. Without it, the plain brick below.
      if (num(d, "inlet", 0)) {
        const xi = -w / 2;
        const shell: PartRecipe = {
          base: { t: "box", w, d: dd, h, at: Z0, r: Math.min(6, h / 5) },
          ops: [
            { op: "cut", shape: { t: "box", w: w * 0.62, d: dd * 0.66, h: 1, at: [-w * 0.04, 0, h - 0.5], r: 2 } },
            // the seam where the two halves of the shell meet
            { op: "cut", shape: { t: "box", w: w + 2, d: dd + 2, h: 0.5, at: [0, 0, h / 2 - 0.25], r: 0 } },
            { op: "add", shape: { t: "box", w: w - 0.9, d: dd - 0.9, h: 0.7, at: [0, 0, h / 2 - 0.35], r: Math.min(5.5, h / 5) } },
            // the inlet's well: 24 x 16.5, 16 deep
            { op: "cut", shape: { t: "box", w: 16, d: 24, h: 16.5, at: [xi + 7.99, 0, h / 2 - 8.25], r: 0 } },
          ],
        };
        const pins: ShapeRecipe[] = [
          { t: "box", w: 11, d: 4, h: 2, at: [xi + 9.5, -7, h / 2 - 2.5], r: 0 },
          { t: "box", w: 11, d: 4, h: 2, at: [xi + 9.5, 7, h / 2 - 2.5], r: 0 },
          { t: "box", w: 13, d: 4, h: 2, at: [xi + 8.5, 0, h / 2 + 1.5], r: 0 },
        ];
        // the strain relief: a ribbed boot that tapers onto the output lead
        const boot: ShapeRecipe[] = [
          { t: "cone", d1: 10.5, d2: 6.4, h: 22, at: [w / 2 - 1, 0, h / 2], dir: XP },
          ...Array.from({ length: 5 }, (_, i): ShapeRecipe => ({ t: "cyl", d: 10.4 - i * 0.75, h: 1.4, at: [w / 2 + 2.5 + i * 3.6, 0, h / 2], dir: XP })),
        ];
        return {
          placement: "free",
          solids: [
            solid("", p.name, shell, g.color ?? BLACK, "PC"),
            solid("cord", `${p.name} cord`, { base: { t: "cyl", d: 4.6, h: 60, at: [w / 2 - 1, 0, h / 2], dir: XP }, ops: boot.map((shape) => ({ op: "add" as const, shape })) }, BLACK, "PVC"),
            solid("pins", `${p.name} mains inlet pins`, { base: { t: "union", shapes: pins }, ops: [] }, "#c9ced6", "Brass"),
            solid("label", `${p.name} rating label`, { base: { t: "box", w: w * 0.6, d: dd * 0.62, h: 0.15, at: [-w * 0.04, 0, h - 0.5], r: 1.5 }, ops: [] }, "#d9dce1", "PET"),
            solid("light", `${p.name} power light`, { base: { t: "cyl", d: 3, h: 0.6, at: [w / 2 - 12, 0, h - 0.3], dir: ZP }, ops: [] }, "#3ddc97", "PC"),
          ],
          fields: { scalars: { w, d: dd, h }, points: { top: [0, 0, h], bottom: Z0, cord_end: [w / 2 + 59, 0, h / 2], inlet: [xi, 0, h / 2] } },
        };
      }
      return {
        placement: "free",
        solids: [
          solid("", p.name, { base: { t: "box", w, d: dd, h, at: Z0, r: 5 }, ops: [{ op: "cut", shape: { t: "box", w: w * 0.6, d: dd * 0.6, h: 1, at: [0, 0, h - 0.5], r: 2 } }] }, g.color ?? BLACK, "PC"),
          solid("cord", `${p.name} cord`, { base: { t: "cyl", d: 4, h: 60, at: [w / 2 - 1, 0, h / 2], dir: XP }, ops: [{ op: "add", shape: { t: "cone", d1: 9, d2: 4.5, h: 12, at: [w / 2 - 1, 0, h / 2], dir: XP } }] }, BLACK, "Silicone"),
        ],
        fields: { scalars: { w, d: dd, h }, points: { top: [0, 0, h], bottom: Z0, cord_end: [w / 2 + 59, 0, h / 2] } },
      };
    }

    // dp_sensor: a differential pressure sensor lying flat, `at` the centre of its underside. w × d × h housing,
    // two tube ports port_d × port_l standing on top port_pitch apart along X (high side at +X, by the
    // connector), a screw lug lug_w wide on the +Y side with a hole_d hole, the pin connector on the −Y side.
    case "dp_sensor": {
      const w = num(d, "w", 29);
      const dd = num(d, "d", 18);
      const h = num(d, "h", 12.5);
      const pd = num(d, "port_d", 5.2);
      const pl = num(d, "port_l", 11);
      const pp = num(d, "port_pitch", 12.8) / 2;
      const lw = num(d, "lug_w", 9);
      const hd = num(d, "hole_d", 3.4);
      const lug: V3 = [0, dd / 2 + lw / 2 - 0.5, 0];
      const port = (x: number): ShapeRecipe => ({ t: "union", shapes: [{ t: "cyl", d: pd, h: pl, at: [x, 0, h - 0.01], dir: ZP }, { t: "cone", d1: pd + 0.9, d2: pd - 0.6, h: 2.2, at: [x, 0, h + pl - 4.4], dir: ZP }, { t: "cone", d1: pd + 0.9, d2: pd - 0.6, h: 2.2, at: [x, 0, h + pl - 2.2], dir: ZP }] });
      const body: PartRecipe = {
        base: { t: "box", w, d: dd, h, at: Z0, r: 1.5 },
        ops: [
          { op: "add", shape: { t: "box", w: lw, d: lw, h: 3, at: lug, r: 2 } },
          { op: "cut", shape: { t: "cyl", d: hd, h: 5, at: [lug[0], lug[1] + 1, -1], dir: ZP } },
          { op: "add", shape: port(pp) },
          { op: "add", shape: port(-pp) },
          { op: "cut", shape: { t: "cyl", d: pd - 2.2, h: pl + 2, at: [pp, 0, h], dir: ZP } },
          { op: "cut", shape: { t: "cyl", d: pd - 2.2, h: pl + 2, at: [-pp, 0, h], dir: ZP } },
        ],
      };
      return {
        placement: "free",
        solids: [
          solid("", p.name, body, g.color ?? "#1d2024", g.material ?? "PA66"),
          solid("plug", `${p.name} connector`, { base: { t: "box", w: 9, d: 4.5, h: 5.5, at: [pp - 2, -dd / 2 - 2, 3], r: 0.4 }, ops: [] }, "#e9e6dc", "PA66"),
        ],
        fields: {
          scalars: { w, d: dd, h, port_d: pd },
          points: { top: [0, 0, h], bottom: Z0, center: [0, 0, h / 2], port_hi: [pp, 0, h + pl], port_lo: [-pp, 0, h + pl], plug: [pp - 2, -dd / 2 - 4.2, 5.7] },
          pointLists: { holes: [[lug[0], lug[1] + 1, 0]] },
        },
      };
    }

    // belt: laid out from its path by lib.belt (machine/belts.ts), never from the catalog alone
    case "belt":
      throw new Error(`${p.name} follows the pulleys it runs round: use lib.belt("${p.id}", path: [...])`);

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

/** A shaft from z0 along +Z with an optional D-flat (`flat` deep, `flatL` from the tip) or keyway. */
/** Each LED's centre on an LED board's top face, in data order, and the way its package is turned (radians). */
function ledLayout(d: Record<string, number>): { p: V3; a: number }[] {
  const n = Math.max(1, Math.round(num(d, "n", 12)));
  const t = num(d, "t", 1.6);
  const od = num(d, "od", 0);
  const idd = num(d, "id", 0);
  const w = num(d, "w", 0);
  const out: { p: V3; a: number }[] = [];
  if (w > 0) for (let i = 0; i < n; i++) out.push({ p: [-w / 2 + (w / n) * (i + 0.5), 0, t], a: 0 });
  else if (idd > 0) {
    const r = (od + idd) / 4;
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      out.push({ p: [r * Math.cos(a), r * Math.sin(a), t], a });
    }
  } else {
    // a jewel: one in the middle, the rest round it
    const r = od / 2 - num(d, "led", 5) * 0.9;
    out.push({ p: [0, 0, t], a: 0 });
    for (let i = 0; i < n - 1; i++) {
      const a = (2 * Math.PI * i) / Math.max(1, n - 1);
      out.push({ p: [r * Math.cos(a), r * Math.sin(a), t], a });
    }
  }
  return out;
}

/** Where each LED of an LED board shines from, on top of its package, in the part's own frame (data order). */
export function ledPoints(p: CatalogPart): V3[] {
  if (p.geom.g !== "led") return [];
  const lh = num(p.geom.dims, "led_h", 1.6);
  return ledLayout(p.geom.dims).map(({ p: c }) => [c[0], c[1], c[2] + lh] as V3);
}

function dShaft(sd: number, sl: number, z0: number, flat: number, flatL: number, keyW = 0, keyL = 0): PartRecipe {
  const ops: PartRecipe["ops"] = [{ op: "chamfer", r: Math.min(0.4, sd * 0.08), edges: "top" }];
  if (flat > 0) ops.push({ op: "cut", shape: { t: "box", w: sd + 1, d: sd, h: flatL + 1, at: [0, sd - flat, z0 + sl - flatL], r: 0 } });
  if (keyW > 0) ops.push({ op: "cut", shape: { t: "box", w: keyW, d: sd * 0.4, h: keyL + 1, at: [0, sd / 2, z0 + sl - keyL], r: 0 } });
  return { base: { t: "cyl", d: sd, h: sl, at: [0, 0, z0], dir: ZP }, ops };
}

/**
 * The metric screw a motor's holes take: `screw` in the dims (its nominal
 * diameter) when given, otherwise the size whose tap drill matches a tapped
 * hole, or the largest that passes a through hole.
 */
function screwFor(d: Record<string, number>, holeD: number, tapped: boolean): ThreadSpec {
  const all = Object.values(THREADS);
  const named = typeof d.screw === "number" ? all.find((t) => t.d === d.screw) : undefined;
  if (named) return named;
  if (tapped) return all.reduce((a, b) => (Math.abs(b.tap - holeD) < Math.abs(a.tap - holeD) ? b : a));
  return all.filter((t) => t.d < holeD - 0.05).at(-1) ?? all[0];
}

/** Fields every motor carries for its mount: the screw size and the thread depth in its holes (0: through holes, nuts behind). */
function mountScalars(screw: ThreadSpec, depth: number): Record<string, number | string> {
  return { screw: screw.name, screw_depth: depth, screw_clearance: screw.clearance };
}

/**
 * The cut for the plate a motor bolts to (its `mount` field): a clearance
 * hole for each screw and one for the pilot, boss or shaft, `depth` mm out
 * from the mounting face, along +Z (the plate is in front of the face) or
 * -Z (behind it).
 */
function mountCut(holes: [number, number][], screw: ThreadSpec, centreD: number, dir: 1 | -1, depth = 40): ShapeRecipe {
  const z0 = dir > 0 ? -0.5 : 0.5;
  const along = dir > 0 ? ZP : ZN;
  const shapes: ShapeRecipe[] = holes.map(([x, y]) => ({ t: "cyl", d: screw.clearance, h: depth + 0.5, at: [x, y, z0], dir: along }));
  if (centreD > 0) shapes.push({ t: "cyl", d: centreD, h: depth + 0.5, at: [0, 0, z0], dir: along });
  return { t: "union", shapes };
}

function faceHoles(g: CatalogPart["geom"], d: Record<string, number>): [number, number][] {
  if (g.holes?.length) return g.holes;
  const n = num(d, "hole_n", 0);
  if (!n) return [];
  return circlePts(n, num(d, "hole_circle", 31) / 2, num(d, "hole_start", 0)).map((p) => [p[0], p[1]]);
}

export { XP };
