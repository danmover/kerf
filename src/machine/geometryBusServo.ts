// The shape of a serial bus servo in the Feetech STS3215 / Waveshare ST3215
// case: a flat box with the output horn on one broad face and a free-turning
// idler horn on the same axis on the other, so a yoke bolted to both horns
// carries the joint on two bearings. Dimensions are measured from the maker's
// STEP file of the case (the same case SO-ARM100 builds on).
//
// Local frame: the origin is on the output axis at the case's top face, +Z
// runs out through the output horn, and the body lies along -X (the motor
// end). dims: l (X), w (Y), h (Z) of the main case; axis_x from the +X end to
// the axis; cover_x from the +X end to where the raised covers start, top_cover
// and bottom_cover their heights; horn_d, horn_t, horn_top (the output horn's
// outer face above the case top); idler_t, idler_top (the idler horn's outer
// face below the case bottom); horn_pcd and horn_hole (four tapped holes in
// each horn, at 45° to the body); hole_depth of the M2 self-tapping holes in
// the covers (their places are in `holes`, as [x, y] on the top face, and
// bottom_x1 / bottom_x2 on the bottom); conn_x from the axis to the two 3-pin
// sockets in the bottom recess.

import type { PartRecipe, ShapeRecipe, V3 } from "../kernel/recipe";
import type { CompSolid } from "../library/components";
import type { CatalogPart } from "./types";
import type { GeomResult } from "./geometry";

const ZP: V3 = [0, 0, 1];
const ZN: V3 = [0, 0, -1];
const num = (d: Record<string, number>, k: string, def: number) => (typeof d[k] === "number" ? d[k] : def);
const box = (w: number, d: number, h: number, at: V3, r = 0): ShapeRecipe => ({ t: "box", w, d, h, at, r });
const solid = (suffix: string, label: string, recipe: PartRecipe, color: string, material: string, moving?: boolean): CompSolid => ({ suffix, label, recipe, color, material, moving });

/** Where the parts of a bus servo are, in its own frame (mm). */
export interface BusServoLayout {
  l: number;
  w: number;
  h: number;
  /** the case's ends along X */
  x0: number;
  x1: number;
  /** outer faces of the output and idler horns, along Z */
  hornZ: number;
  idlerZ: number;
  hornD: number;
  hornHoles: [number, number][];
  /** M2 holes in the top and bottom covers: [x, y] and the face they open on (z) */
  topHoles: [number, number][];
  topZ: number;
  bottomHoles: [number, number][];
  bottomZ: number;
  /** the two 3-pin sockets in the bottom recess: their centres, and the recess floor */
  sockets: [number, number][];
  socketZ: number;
}

export function busServoLayout(p: CatalogPart): BusServoLayout {
  const d = p.geom.dims;
  const l = num(d, "l", 45.4);
  const w = num(d, "w", 24.8);
  const h = num(d, "h", 28.8);
  const ax = num(d, "axis_x", 10.2);
  const x1 = ax;
  const x0 = ax - l;
  const pcd = num(d, "horn_pcd", 14);
  const k = pcd / 2 / Math.SQRT2;
  const top = p.geom.holes?.length ? p.geom.holes : ([[-29, 10.25], [-29, -10.25], [-8.3, 10.25], [-8.3, -10.25]] as [number, number][]);
  const by = Math.abs(top[0][1]);
  const b1 = num(d, "bottom_x1", -8.3);
  const b2 = num(d, "bottom_x2", -32.8);
  const cx = -num(d, "conn_x", 14.05);
  return {
    l,
    w,
    h,
    x0,
    x1,
    hornZ: num(d, "horn_top", 4.3),
    idlerZ: -h - num(d, "idler_top", 3.3),
    hornD: num(d, "horn_d", 20),
    hornHoles: [[k, k], [-k, k], [-k, -k], [k, -k]],
    topHoles: top,
    topZ: num(d, "top_cover", 1.4),
    bottomHoles: [[b1, by], [b1, -by], [b2, by], [b2, -by]],
    bottomZ: -h - num(d, "bottom_cover", 1.3),
    sockets: [[cx, 5.2], [cx, -5.2]],
    socketZ: -h + 3.2,
  };
}

export function busServoGeometry(p: CatalogPart): GeomResult {
  const g = p.geom;
  const d = g.dims;
  const L = busServoLayout(p);
  const { l, w, h, x0, x1 } = L;
  const coverX = x1 - num(d, "cover_x", 15.5);
  const tc = L.topZ;
  const bc = -h - L.bottomZ;
  const hornT = num(d, "horn_t", 2.5);
  const idlerT = num(d, "idler_t", 2.1);
  const hornHole = num(d, "horn_hole", 2.5);
  // the pilot of an M2 thread-forming screw (the maker's CAD draws these holes 1.5 mm)
  const m2 = g.hole_d ?? 1.6;
  const depth = num(d, "hole_depth", 5);
  const cxm = (x0 + x1) / 2;
  const look = g.servo ?? {};
  const dark = g.color ?? "#17191d";

  // the case as one solid: the middle with the two corners at the output end cut at 45°, the covers standing proud
  // behind the output end, the socket recess in the bottom, and the M2 self-tapping holes in both covers
  const ch = 3;
  const corner = (sy: number): ShapeRecipe => ({ t: "xform", shape: box(ch * 1.42, ch * 1.42, h + 2, [x1, (sy * w) / 2, -h - 1]), xf: [{ op: "rotate", angle: 45, origin: [x1, (sy * w) / 2, 0], axis: ZP }] });
  const coverL = coverX - x0;
  const recessW = 20.6;
  const caseScrewAt: [number, number][] = [[x0 + 2, w / 2 - 2], [x0 + 2, -w / 2 + 2]];
  const seam = (z: number) => [1, -1].map((sy) => ({ op: "cut" as const, shape: box(l + 1, 0.3, 0.3, [cxm, (sy * w) / 2, z]), cosmetic: true }));
  const body: PartRecipe = {
    base: box(l, w, h, [cxm, 0, -h], 1),
    ops: [
      { op: "cut", shape: corner(1) },
      { op: "cut", shape: corner(-1) },
      { op: "add", shape: box(coverL, w, tc + 0.02, [x0 + coverL / 2, 0, -0.02], 1) },
      { op: "add", shape: box(coverL, w, bc + 0.02, [x0 + coverL / 2, 0, -h - bc], 1) },
      // the motor's end cap shows as a low plateau at the motor end
      { op: "add", shape: box(11, 16, 1.2, [x0 + 6.1, 0, tc - 0.01], 1.5) },
      { op: "cut", shape: box(5.4, recessW, 3.2 + bc, [L.sockets[0][0], 0, -h - bc - 0.01]) },
      // the raised boss the output shaft comes through
      { op: "add", shape: { t: "cyl", d: 9, h: L.hornZ - hornT - 0.3, at: [0, 0, -0.01], dir: ZP } },
      ...L.topHoles.map(([x, y]) => ({ op: "cut" as const, shape: { t: "cyl" as const, d: m2, h: depth, at: [x, y, tc - depth] as V3, dir: ZP } })),
      ...L.bottomHoles.map(([x, y]) => ({ op: "cut" as const, shape: { t: "cyl" as const, d: m2, h: depth, at: [x, y, L.bottomZ] as V3, dir: ZP } })),
      ...seam(-6.2),
      ...seam(-h + 6),
    ],
  };
  // the long case screws at the motor end, their heads just under the top cover's face in square recesses (square, so
  // they are not taken for mounting holes)
  for (const [x, y] of caseScrewAt) body.ops.push({ op: "cut", shape: box(3.3, 3.3, 0.5, [x, y, tc - 0.49]) });
  const caseScrews: PartRecipe = {
    base: { t: "union", shapes: caseScrewAt.map(([x, y]) => ({ t: "cyl" as const, d: 3, h: 0.4, at: [x, y, tc - 0.49] as V3, dir: ZP })) },
    ops: caseScrewAt.flatMap(([x, y]) => [box(1.8, 0.35, 0.25, [x, y, tc - 0.3]), box(0.35, 1.8, 0.25, [x, y, tc - 0.3])].map((shape) => ({ op: "cut" as const, shape, cosmetic: true }))),
  };
  // the horns: a 2.5 mm disc with four tapped holes, on the output spline and on the idler's stub
  const horn = (z0: number, t: number, dir: V3, screwHead: boolean): PartRecipe => {
    const up = dir[2] > 0;
    const zf = up ? z0 + t : z0 - t; // outer face
    const ops: PartRecipe["ops"] = L.hornHoles.map(([x, y]) => ({ op: "cut" as const, shape: { t: "cyl" as const, d: hornHole, h: t + 0.02, at: [x, y, up ? z0 - 0.01 : zf - 0.01] as V3, dir: ZP } }));
    ops.push({ op: "chamfer", r: 0.3, edges: up ? "top" : "bottom" });
    // the centre screw that holds the horn on its spline
    if (screwHead) ops.push({ op: "add", shape: { t: "cyl", d: 5.5, h: 1.5, at: [0, 0, zf - 0.01], dir: ZP } });
    else ops.push({ op: "add", shape: { t: "cyl", d: 6, h: 0.6, at: [0, 0, zf + 0.01], dir: ZN } });
    return { base: { t: "cyl", d: L.hornD, h: t, at: [0, 0, up ? z0 : zf], dir: ZP }, ops };
  };
  const out = horn(L.hornZ - hornT, hornT, ZP, true);
  const idle = horn(L.idlerZ + idlerT, idlerT, ZN, false);
  // the idler's stub on the bottom face
  body.ops.push({ op: "add", shape: { t: "cyl", d: 8, h: -h - (L.idlerZ + idlerT) + 0.02, at: [0, 0, L.idlerZ + idlerT], dir: ZP } });
  // a sticker on each side, with the maker's and model's names as bars
  const lw = l * 0.62;
  const lh = h - 14.5;
  const lx = x0 + 4 + lw / 2;
  const lz = -h + 7.2;
  const plate = (len: number, ph: number, x: number, z: number, proud: number) => [1, -1].map((sy) => box(len, proud + 0.1, ph, [x, sy * (w / 2 + (proud - 0.1) / 2), z], 0));
  const bar = (len: number, bh: number, z: number) => plate(len, bh, lx - lw / 2 + 1.5 + len / 2, z, 0.24);
  const label: PartRecipe = { base: { t: "union", shapes: plate(lw, lh, lx, lz, 0.12) }, ops: [] };
  const print: PartRecipe = { base: { t: "union", shapes: [...bar(lw * 0.5, 1.6, lz + lh * 0.62), ...bar(lw * 0.72, 0.9, lz + lh * 0.3)] }, ops: [] };
  // the two 3-pin sockets in the bottom recess (5264 style, 2.5 mm pitch), one each way along the chain
  const sock = (cx: number, cy: number): ShapeRecipe => box(4.6, 9.8, 2.6, [cx, cy, L.socketZ - 2.6]);
  const pins = (cx: number, cy: number): ShapeRecipe[] => [-2.4, 0, 2.4].map((dy) => box(0.64, 0.64, 2.2, [cx, cy + dy, L.socketZ - 2.3]));
  const sockets: PartRecipe = {
    base: { t: "union", shapes: L.sockets.map(([x, y]) => sock(x, y)) },
    ops: L.sockets.map(([x, y]) => ({ op: "cut" as const, shape: box(3.4, 8.6, 2.2, [x, y, L.socketZ - 2.61]) })),
  };
  const contacts: PartRecipe = { base: { t: "union", shapes: L.sockets.flatMap(([x, y]) => pins(x, y)) }, ops: [] };

  // the room the case needs in a printed cradle: the case and both covers with `fit` all round, open at the horns
  const fit = 0.25;
  const pocket: ShapeRecipe = {
    t: "union",
    shapes: [box(l + 2 * fit, w + 2 * fit, h + 2 * fit, [cxm, 0, -h - fit]), box(coverL + 2 * fit, w + 2 * fit, tc + bc + h + 2 * fit, [x0 + coverL / 2, 0, -h - bc - fit])],
  };
  const z3 = (pts: [number, number][], z: number) => pts.map(([x, y]) => [x, y, z] as V3);
  return {
    placement: "axis",
    solids: [
      solid("", p.name, body, look.mid ?? dark, look.mid_material ?? "PA66"),
      solid("screws", `${p.name} case screws`, caseScrews, "#7d838c", "Steel"),
      solid("label", `${p.name} label`, label, look.label ?? "#1c4fa3", "PVC"),
      solid("label_text", `${p.name} label print`, print, look.text ?? "#eef1f5", "PVC"),
      solid("sockets", `${p.name} bus sockets`, sockets, "#ece9df", "PA66"),
      solid("pins", `${p.name} socket pins`, contacts, "#c9a23a", "Brass"),
      solid("horn", `${p.name} output horn`, out, look.spline ?? "#c4c9d0", look.spline_material ?? "Aluminum 6061", true),
      solid("idler", `${p.name} idler horn`, idle, look.spline ?? "#c4c9d0", look.spline_material ?? "Aluminum 6061", true),
    ],
    fields: {
      scalars: {
        l,
        w,
        h,
        horn_d: L.hornD,
        horn_t: hornT,
        // outer face of the output horn above the case top, of the idler horn below it, and between the two
        horn_z: L.hornZ,
        idler_z: -L.idlerZ,
        span: L.hornZ - L.idlerZ,
        back: -x0,
        front: x1,
        cover: tc,
        horn_screw: "M3",
        screw: "M2",
        screw_depth: depth,
        screw_clearance: 2.4,
      },
      points: { at: [0, 0, 0], horn: [0, 0, L.hornZ], idler: [0, 0, L.idlerZ], case_center: [cxm, 0, -h / 2], plug: [L.sockets[0][0], 0, -h] },
      pointLists: { horn_holes: z3(L.hornHoles, L.hornZ), idler_holes: z3(L.hornHoles, L.idlerZ), top_holes: z3(L.topHoles, tc), bottom_holes: z3(L.bottomHoles, L.bottomZ), holes: z3(L.topHoles, tc) },
      dirs: { axis: ZP, back: [-1, 0, 0], side: [0, 1, 0] },
      shapes: { pocket },
    },
  };
}
