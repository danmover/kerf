// Shapes of the flight hardware a CubeSat is built from, drawn as the things they are: solar panels with every
// cell, its cover glass, grid lines, busbars and interconnects; a Cassegrain telescope with its spider and
// mirrors; a star tracker with its baffle; a deployable UHF antenna frame with its stowed tape elements and
// burn resistors; an S-band patch; an ADCS module with its reaction wheels, torquer rods and coil between two
// PC/104 boards; a battery pack of 18650 cells in clamps on its board; microswitches, a sun sensor and a burn-wire
// hold-down. Each works in its own frame, documented above its generator, and repeated detail (cells, grid
// lines, screws) is drawn as instances, built once and placed many times, so a satellite rebuilds quickly.
// Sizes are the makers' published envelopes; where a maker publishes only an envelope, the detail inside it is
// drawn the way such parts are made, and the part's notes say so.

import type { PartRecipe, ShapeRecipe, V2, V3, Xform } from "../kernel/recipe";
import type { CompSolid } from "../library/components";
import type { CatalogPart } from "./types";
import type { GeomResult } from "./geometry";

const Z0: V3 = [0, 0, 0];
const XP: V3 = [1, 0, 0];
const YP: V3 = [0, 1, 0];
const ZP: V3 = [0, 0, 1];
const ZN: V3 = [0, 0, -1];

const num = (d: Record<string, number>, k: string, def: number) => (typeof d[k] === "number" ? d[k] : def);
const box = (w: number, d: number, h: number, at: V3, r = 0): ShapeRecipe => ({ t: "box", w, d, h, at, r });
const cyl = (d: number, h: number, at: V3, dir: V3 = ZP): ShapeRecipe => ({ t: "cyl", d, h, at, dir });
const tube = (od: number, id: number, h: number, at: V3, dir: V3 = ZP): ShapeRecipe => ({ t: "tube", od, id, h, at, dir });
const cone = (d1: number, d2: number, h: number, at: V3, dir: V3 = ZP): ShapeRecipe => ({ t: "cone", d1, d2, h, at, dir });
const union = (shapes: ShapeRecipe[]): ShapeRecipe => (shapes.length === 1 ? shapes[0] : { t: "union", shapes });
const one = (shape: ShapeRecipe, ops: PartRecipe["ops"] = []): PartRecipe => ({ base: shape, ops });
const solid = (suffix: string, label: string, recipe: PartRecipe, color: string, material: string, finish?: string): CompSolid => ({ suffix, label, recipe, color, material, ...(finish ? { finish } : {}) });
const tr = (v: V3): Xform[] => [{ op: "translate", v }];
/** copies of one shape (drawn round the origin) at each offset, built once */
const copies = (shape: ShapeRecipe, at: V3[], extra: Xform[] = []): ShapeRecipe => ({ t: "instances", items: [{ shape, xfs: at.map((v) => [...extra, { op: "translate", v } as Xform]) }] });
/** a polygon (u = X, v = Y) pushed h up from z */
const plate = (pts: V2[], h: number, z: number, r = 0): ShapeRecipe => ({ t: "extrude", p: { t: "poly", pts, r }, h, f: { o: [0, 0, z], u: XP, n: ZP }, twist: 0, scale: 1 });
const rot = (shape: ShapeRecipe, angle: number, axis: V3, origin: V3 = Z0): ShapeRecipe => ({ t: "xform", shape, xf: [{ op: "rotate", angle, origin, axis }] });

const BLACK_AL = "#1b1d21";
const ALU = "#c7ccd3";
const GOLD = "#d4a64a";
const SILVER = "#dfe3e8";
const KAPTON = "#c9821f";
const CELL = "#1e2a5e";
const GLASS = "#dfeaf3";
const FR4_BLACK = "#121417";
const WHITE = "#ece9df";

// ---------------- solar panels ----------------

/** a triple-junction cell's outline, 40 (x) by 80 (y), the two corners at +y (or -y) cropped where it met the edge of its wafer */
function cellOutline(cw: number, cl: number, crop: number, flip: boolean): V2[] {
  const x = cw / 2;
  const y = cl / 2;
  const s = flip ? -1 : 1;
  const pts: V2[] = [
    [-x, -y * s],
    [x, -y * s],
    [x, (y - crop) * s],
    [x - crop, y * s],
    [-x + crop, y * s],
    [-x, (y - crop) * s],
  ];
  return flip ? pts.reverse() : pts;
}

/**
 * space_panel: a solar panel lying flat, cells up (+Z), `at` the centre of the underside. dims: l (X, the
 * panel's length), w (Y), t the substrate; n cells in a row along X, cell_w (X) by cell_l (Y), gap between
 * them, crop the cropped corners' legs, x0 where the row's middle is along X; cover the cover glass's
 * thickness. holes (g.holes) go through the substrate, hole_d across; win_x, win_y, win_w, win_d cut a window
 * through it (a star tracker's or sun sensor's view). conn_x puts the panel's harness connector on the
 * underside at that x. color is the substrate's back, color2 the cells.
 */
export function solarPanelGeometry(p: CatalogPart): GeomResult {
  const g = p.geom;
  const d = g.dims;
  const l = num(d, "l", 326);
  const w = num(d, "w", 82);
  const t = num(d, "t", 1.6);
  const n = Math.max(0, Math.round(num(d, "n", 6)));
  const cw = num(d, "cell_w", 40.15);
  const cl = num(d, "cell_l", 80.15);
  const gap = num(d, "gap", 1.2);
  const crop = num(d, "crop", 10);
  const x0 = num(d, "x0", 0);
  const cover = num(d, "cover", 0.1);
  const pitch = cw + gap;
  const hd = g.hole_d ?? 2.2;
  const holes = g.holes ?? [];
  const xs = Array.from({ length: n }, (_, i) => x0 + (i - (n - 1) / 2) * pitch);
  const ops: PartRecipe["ops"] = holes.map(([x, y]) => ({ op: "cut" as const, shape: cyl(hd, t + 2, [x, y, -1]) }));
  // 90° countersinks for flat-head screws, so the heads sit flush under a panel stowed over this one
  const cs = g.csink ?? 0;
  if (cs > hd) for (const [x, y] of holes) ops.push({ op: "cut", shape: cone(hd, cs + 0.2, (cs + 0.2 - hd) / 2, [x, y, t - (cs - hd) / 2]) });
  if (num(d, "win_w", 0) > 0) ops.push({ op: "cut", shape: box(num(d, "win_w", 0), num(d, "win_d", 0), t + 2, [num(d, "win_x", 0), num(d, "win_y", 0), -1], 2) });
  // the substrate's edges broken, as a machined aluminium panel or a routed board is
  ops.push({ op: "chamfer", r: Math.min(0.3, t / 4), edges: "top", cosmetic: true });
  // a hold-down tab on the +X end, tab_w across at tab_y, tab_l long, with the hold-down line's hole at tab_hole from the end
  const tabL = num(d, "tab_l", 0);
  const tabW = num(d, "tab_w", 16);
  const tabY = num(d, "tab_y", 0);
  const tabHole = num(d, "tab_hole", tabL / 2);
  const base = tabL > 0 ? union([box(l, w, t, Z0, 1.5), box(tabL + 2, tabW, t, [l / 2 + tabL / 2 - 1, tabY, 0], 3)]) : box(l, w, t, Z0, 1.5);
  if (tabL > 0) ops.unshift({ op: "cut", shape: cyl(4.5, t + 2, [l / 2 + tabHole, tabY, -1]) });
  const substrate = one(base, ops);
  const solids: CompSolid[] = [solid("", p.name, substrate, g.color ?? ALU, g.material ?? "Aluminum 6061", g.material === "FR4" ? "solder-mask" : "anodized")];
  if (n > 0) {
    const zk = t;
    const kh = 0.05;
    // the polyimide film the cells are laid on, a little bigger than the row
    solids.push(solid("kapton", `${p.name} polyimide film`, one(box(n * pitch + 2, cl + 3, kh, [x0, 0, zk], 1)), KAPTON, "PC", "gloss"));
    const zc = zk + kh;
    const ch = 0.15;
    // cells: pairs mirrored, so the cropped corners of a dual-cell module face out to the panel's edges
    const cellA = plate(cellOutline(cw, cl, crop, false), ch, 0);
    const cellB = plate(cellOutline(cw, cl, crop, true), ch, 0);
    const even = xs.filter((_, i) => i % 2 === 0).map((x) => [x, 0, zc] as V3);
    const odd = xs.filter((_, i) => i % 2 === 1).map((x) => [x, 0, zc] as V3);
    const cells: ShapeRecipe = { t: "instances", items: [{ shape: cellA, xfs: even.map((v) => tr(v)) }, ...(odd.length ? [{ shape: cellB, xfs: odd.map((v) => tr(v)) }] : [])] };
    solids.push(solid("cells", `${p.name} solar cells`, one(cells), g.color2 ?? CELL, "FR4", "solder-mask"));
    // cover glass bonded over each cell, the same outline 0.1 mm bigger
    const zg = zc + ch + 0.03;
    const glassA = plate(cellOutline(cw + 0.2, cl + 0.2, crop, false), cover, 0);
    const glassB = plate(cellOutline(cw + 0.2, cl + 0.2, crop, true), cover, 0);
    const glass: ShapeRecipe = { t: "instances", items: [{ shape: glassA, xfs: even.map((v) => tr([v[0], 0, zg])) }, ...(odd.length ? [{ shape: glassB, xfs: odd.map((v) => tr([v[0], 0, zg])) }] : [])] };
    solids.push(solid("glass", `${p.name} cover glass`, one(glass), GLASS, "Acrylic", "clear"));
    // the front contact: fine grid lines across each cell (along X) into a busbar along its uncropped long edge
    const fingers: V3[] = [];
    const fp = 1.6;
    const fl = cw - 1.2;
    const nf = Math.floor((cl - 2 * crop - 4) / fp);
    for (const [i, x] of xs.entries()) {
      const s = i % 2 === 0 ? 1 : -1;
      for (let k = 0; k < nf; k++) fingers.push([x, s * (-cl / 2 + 3 + k * fp + fp / 2), zc + ch]);
    }
    const finger = box(fl, 0.09, 0.012, Z0);
    const bars = xs.map((x, i) => [x, (i % 2 === 0 ? -1 : 1) * (-cl / 2 + 1.1), zc + ch] as V3);
    const busbar = box(cw - 0.8, 1.4, 0.02, Z0);
    solids.push(solid("grid", `${p.name} cell grid and busbars`, one({ t: "instances", items: [{ shape: finger, xfs: fingers.map((v) => tr(v)) }, { shape: busbar, xfs: bars.map((v) => tr(v)) }] }), SILVER, "Copper", "polished"));
    // silver-plated interconnects bridging each gap: three omega tabs from one cell's busbar to the next cell's back
    const tabs: V3[] = [];
    for (let i = 0; i + 1 < n; i++) {
      const xm = (xs[i] + xs[i + 1]) / 2;
      for (const y of [-cl / 2 + 12, 0, cl / 2 - 12]) tabs.push([xm, y, zk + kh]);
    }
    // the string ends: a wider tab at each end of the row out to the panel's wiring
    const ends: V3[] = n ? [[xs[0] - pitch / 2 - 0.6, 0, zk + kh], [xs[n - 1] + pitch / 2 + 0.6, 0, zk + kh]] : [];
    solids.push(solid("tabs", `${p.name} interconnects`, one({ t: "instances", items: [{ shape: box(gap + 3, 4.5, 0.28, Z0), xfs: tabs.map((v) => tr(v)) }, { shape: box(3, 30, 0.3, Z0), xfs: ends.map((v) => tr(v)) }] }), SILVER, "Copper", "polished"));
  }
  // the panel's harness connector and its strain relief on the back
  const connX = num(d, "conn_x", NaN);
  if (Number.isFinite(connX)) solids.push(solid("conn", `${p.name} connector`, one(union([box(9, 6, 3.2, [connX, w / 2 - 10, -3.2], 0.3), box(4, 4, 1.4, [connX - 7, w / 2 - 10, -1.4], 0.3)])), WHITE, "PA66"));
  return {
    placement: "free",
    solids,
    fields: {
      scalars: { l, w, t, cells: n, height: t + 0.5 },
      points: { top: [0, 0, t], bottom: Z0, center: [0, 0, t / 2], tab_hole: [l / 2 + tabHole, tabY, 0] },
      pointLists: { holes: holes.map(([x, y]) => [x, y, 0] as V3), cells: xs.map((x) => [x, 0, t] as V3) },
    },
  };
}

// ---------------- the telescope ----------------

/**
 * space_telescope: a Cassegrain imager looking along -Z, `at` the centre of its aperture's rim. dims: len overall,
 * od and bore the front baffle tube, front_l its length; flange_z and flange_t the mounting flange (flange_w square,
 * with M3 holes on hole_sq), body_w the housing across its flats, chamfer its corners, rear_l the focal-plane
 * electronics at the back with rear_w across, its top face tapped M3 on rear_sq for the structure; sec_d the secondary mirror's
 * obscuration, prim_d the primary mirror.
 */
export function telescopeGeometry(p: CatalogPart): GeomResult {
  const g = p.geom;
  const d = g.dims;
  const len = num(d, "len", 176);
  const od = num(d, "od", 96);
  const bore = num(d, "bore", 92);
  const frontL = num(d, "front_l", 22);
  const fz = num(d, "flange_z", 5.5);
  const ft = num(d, "flange_t", 4);
  const fw = num(d, "flange_w", 92);
  const hsq = num(d, "hole_sq", 78);
  const bw = num(d, "body_w", 90);
  const ch = num(d, "chamfer", 11);
  const rearL = num(d, "rear_l", 26);
  const rw = num(d, "rear_w", 84);
  const secD = num(d, "sec_d", 47.2);
  const primD = num(d, "prim_d", 94.8);
  const zBody0 = fz + ft;
  const zRear = len - rearL;
  const oct = (s: number, c: number): V2[] => [[-s / 2 + c, -s / 2], [s / 2 - c, -s / 2], [s / 2, -s / 2 + c], [s / 2, s / 2 - c], [s / 2 - c, s / 2], [-s / 2 + c, s / 2], [-s / 2, s / 2 - c], [-s / 2, -s / 2 + c]];
  const holes4: V2[] = [[hsq / 2, hsq / 2], [-hsq / 2, hsq / 2], [-hsq / 2, -hsq / 2], [hsq / 2, -hsq / 2]];
  const rsq = num(d, "rear_sq", rw - 14);
  const rear4: V2[] = [[rsq / 2, rsq / 2], [-rsq / 2, rsq / 2], [-rsq / 2, -rsq / 2], [rsq / 2, -rsq / 2]];
  // the housing: the mounting flange at the aperture, the front baffle tube and the octagonal barrel
  const housing: PartRecipe = {
    base: union([plate(oct(fw, ch + 1), ft, fz, 1), tube(od, bore, frontL, Z0), plate(oct(bw, ch), zRear - zBody0, zBody0, 2)]),
    ops: [
      // the light path: open down to the primary mirror's cell
      { op: "cut", shape: cyl(bore, zRear - 30, [0, 0, -1]) },
      ...holes4.map(([x, y]) => ({ op: "cut" as const, shape: { t: "hole" as const, d: 2.5, depth: 6, at: [x, y, fz] as V3, dir: ZP } })),
      // weight-saving pockets in the barrel's flats, as the housing is machined
      ...[0, 90, 180, 270].map((a) => ({ op: "cut" as const, shape: rot(box(bw * 0.55, 3, zRear - zBody0 - 30, [0, bw / 2 - 1.2, zBody0 + 12], 3), a, ZP) })),
      { op: "chamfer", r: 0.5, edges: "convex", cosmetic: true },
    ],
  };
  const solids: CompSolid[] = [solid("", p.name, housing, g.color ?? BLACK_AL, "Aluminum 6061", "anodized")];
  // the focal-plane electronics box and its connectors
  const rear = one(union([box(rw, rw, rearL, [0, 0, zRear - 0.01], 4), box(8, 25, 6, [rw / 2 - 2, -20, zRear + 6]), box(8, 15, 6, [rw / 2 - 2, 18, zRear + 6])]), [
    // tapped holes in its top face, where the bulkhead above holds the back of the instrument
    ...rear4.map(([x, y]) => ({ op: "cut" as const, shape: { t: "hole" as const, d: 2.5, depth: 6, at: [x, y, len] as V3, dir: ZN } })),
    { op: "chamfer", r: 0.6, edges: "top", cosmetic: true },
  ]);
  solids.push(solid("rear", `${p.name} focal-plane electronics`, rear, g.color2 ?? "#2a2d33", "Aluminum 6061", "anodized"));
  // the connectors' gold shells
  solids.push(solid("connectors", `${p.name} Micro-D connectors`, one(union([box(4.2, 21, 5.2, [rw / 2 + 2.5, -20, zRear + 6.4]), box(4.2, 11, 5.2, [rw / 2 + 2.5, 18, zRear + 6.4])])), GOLD, "Brass", "polished"));
  // primary mirror in its cell, deep in the bore, and the secondary held on a three-vane spider near the front
  const zp = zRear - 31;
  solids.push(solid("primary", `${p.name} primary mirror`, one(cyl(primD - 3, 3, [0, 0, zp]), [{ op: "cut", shape: cyl(secD * 0.55, 5, [0, 0, zp - 1]) }]), "#e8edf2", "Aluminum 6061", "polished"));
  const zs = frontL - 4;
  const vane = box(1.0, bore / 2 - secD / 2 + 0.5, 10, [0, secD / 2 + (bore / 2 - secD / 2) / 2 - 0.2, zs - 5]);
  solids.push(
    solid(
      "spider",
      `${p.name} secondary mirror and spider`,
      one(union([cyl(secD, 12, [0, 0, zs - 6]), cone(secD - 6, secD - 14, 6, [0, 0, zs + 6]), ...[0, 120, 240].map((a) => rot(vane, a, ZP))])),
      "#101114",
      "Aluminum 6061",
      "anodized",
    ),
  );
  solids.push(solid("secondary", `${p.name} secondary mirror face`, one(cyl(secD - 16, 0.6, [0, 0, zs + 12])), "#eef2f6", "Aluminum 6061", "polished"));
  const pz = (z: number): V3[] => holes4.map(([x, y]) => [x, y, z] as V3);
  return {
    placement: "free",
    solids,
    fields: {
      scalars: { len, od, flange_z: fz, flange_t: ft, rear_z: zRear },
      points: { aperture: Z0, flange: [0, 0, fz], flange_top: [0, 0, fz + ft], rear: [0, 0, zRear], back: [0, 0, len] },
      pointLists: { flange_holes: pz(fz), rear_holes: rear4.map(([x, y]) => [x, y, len] as V3) },
    },
  };
}

// ---------------- the star tracker ----------------

/**
 * space_tracker: a star tracker standing on its base, looking along +Z, `at` the centre of its underside. dims: w (X),
 * d (Y), h the electronics housing; baffle_d, baffle_h the sun baffle round the lens and fov its field of view;
 * holes (g.holes) M2 tapped in the base.
 */
export function trackerGeometry(p: CatalogPart): GeomResult {
  const g = p.geom;
  const d = g.dims;
  const w = num(d, "w", 50);
  const dd = num(d, "d", 35);
  const h = num(d, "h", 30);
  const bd = num(d, "baffle_d", 32);
  const bh = num(d, "baffle_h", 25);
  const fov = num(d, "fov", 42);
  const holes = g.holes ?? [];
  const lens = 14;
  const mouth = Math.min(bd - 2, lens + 2 * bh * Math.tan(((fov / 2 + 4) * Math.PI) / 180));
  const body: PartRecipe = {
    base: union([box(w, dd, h, Z0, 3), cyl(bd, bh, [0, 0, h - 0.01])]),
    ops: [
      // the baffle's cone, opening at the field of view plus a margin, with two vanes inside it
      { op: "cut", shape: cone(lens, mouth, bh + 0.02, [0, 0, h]) },
      ...holes.map(([x, y]) => ({ op: "cut" as const, shape: { t: "hole" as const, d: 1.6, depth: 4, at: [x, y, 0] as V3, dir: ZP } })),
      { op: "chamfer", r: 0.4, edges: "convex", cosmetic: true },
    ],
  };
  const solids = [solid("", p.name, body, g.color ?? BLACK_AL, "Aluminum 6061", "anodized")];
  solids.push(solid("lens", `${p.name} lens`, one(cyl(lens, 1, [0, 0, h - 0.5])), "#4b6aa8", "Acrylic", "clear"));
  solids.push(solid("ring", `${p.name} lens retaining ring`, one(tube(lens + 4, lens - 0.5, 1.2, [0, 0, h])), GOLD, "Aluminum 6061", "anodized"));
  // its connector on the +X end, clear of whatever it is mounted to
  solids.push(solid("conn", `${p.name} connector`, one(box(5, 12, 4.5, [w / 2 + 2.4, 0, 3], 0.4)), WHITE, "PA66"));
  return {
    placement: "free",
    solids,
    fields: {
      scalars: { w, d: dd, h, height: h + bh },
      points: { top: [0, 0, h + bh], bottom: Z0, lens: [0, 0, h], center: [0, 0, h / 2] },
      pointLists: { holes: holes.map(([x, y]) => [x, y, 0] as V3) },
    },
  };
}

// ---------------- the deployable UHF antenna ----------------

/**
 * space_ants: a deployable antenna frame lying flat, `at` the centre of its underside. dims: w square, h overall,
 * win the open middle (for a patch antenna or a camera), t the frame board; four tape elements stowed in the
 * housings along its edges, each held by a door and a burn-wire tie. holes (g.holes) through it for the screws
 * into the structure.
 */
export function antsGeometry(p: CatalogPart): GeomResult {
  const g = p.geom;
  const d = g.dims;
  const w = num(d, "w", 98);
  const h = num(d, "h", 6.5);
  const win = num(d, "win", 58);
  const t = num(d, "t", 1.6);
  const hd = g.hole_d ?? 3.2;
  const holes = g.holes ?? [];
  const bayW = (w - win) / 2 - 2;
  const notch = num(d, "notch", 8);
  const ops: PartRecipe["ops"] = [
    { op: "cut", shape: box(win, win, t + 2, [0, 0, -1], 3) },
    ...holes.map(([x, y]) => ({ op: "cut" as const, shape: cyl(hd, t + 2, [x, y, -1]) })),
    // its corners notched round the structure's rails
    ...(notch > 0 ? [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([sx, sy]) => ({ op: "cut" as const, shape: box(notch * 2, notch * 2, t + 2, [(sx * w) / 2, (sy * w) / 2, -1]) })) : []),
  ];
  const solids: CompSolid[] = [solid("", p.name, one(box(w, w, t, Z0, 2), ops), g.color ?? FR4_BLACK, "FR4", "solder-mask")];
  // four element housings, one along each edge, each with its door over the coiled tape
  const housingL = win + 8;
  const zt = t;
  const bay: ShapeRecipe = box(housingL, bayW, h - t - 0.6, [0, 0, 0], 1.5);
  const at4 = [0, 90, 180, 270];
  const offs = w / 2 - bayW / 2 - 1;
  const bays = at4.map((a) => rot({ t: "xform", shape: bay, xf: tr([0, offs, zt]) }, a, ZP));
  solids.push(solid("housings", `${p.name} element housings`, one(union(bays), [{ op: "chamfer", r: 0.3, edges: "top", cosmetic: true }]), g.color2 ?? "#2c2f35", "Aluminum 6061", "anodized"));
  const door: ShapeRecipe = box(housingL - 4, bayW - 1.5, 0.6, [0, 0, 0], 1);
  solids.push(solid("doors", `${p.name} doors`, one(union(at4.map((a) => rot({ t: "xform", shape: door, xf: tr([0, offs, h - 0.6]) }, a, ZP)))), ALU, "Aluminum 6061", "brushed"));
  // the stowed tape elements' tips showing at each door's hinge end, and the burn resistors with their ties
  const tip: ShapeRecipe = box(6, bayW - 4, 0.3, [0, 0, 0]);
  solids.push(solid("elements", `${p.name} antenna elements (stowed)`, one(union(at4.map((a) => rot({ t: "xform", shape: tip, xf: tr([housingL / 2 - 1, offs, h - 1.6]) }, a, ZP)))), "#cfd3d8", "Stainless 304", "polished"));
  const res: ShapeRecipe = union([box(2, 1.25, 0.6, [0, 0, 0]), box(0.3, 3.5, 0.3, [1.4, 0, 0.5])]);
  const resAt: V3[] = [];
  for (const a of at4) {
    const ar = (a * Math.PI) / 180;
    const [px, py] = [-(housingL / 2 + 1.8), offs - bayW / 2 + 0.5];
    resAt.push([px * Math.cos(ar) - py * Math.sin(ar), px * Math.sin(ar) + py * Math.cos(ar), t]);
  }
  solids.push(solid("burn", `${p.name} burn resistors`, one(copies(res, resAt)), "#20262c", "FR4"));
  solids.push(solid("conn", `${p.name} connector`, one(box(10, 4.5, 3.6, [w / 2 - 11.5, -20, -3.6], 0.3)), WHITE, "PA66"));
  return {
    placement: "free",
    solids,
    fields: {
      scalars: { w, h, win, t, height: h },
      points: { top: [0, 0, h], bottom: Z0, center: [0, 0, h / 2] },
      pointLists: { holes: holes.map(([x, y]) => [x, y, 0] as V3) },
    },
  };
}

// ---------------- the S-band patch ----------------

/**
 * space_patch: a patch antenna lying flat, `at` the centre of its underside. dims: w square board, t its laminate,
 * patch the radiating patch (corners truncated by trunc for circular polarisation), sub the ceramic under it
 * (sub_h thick); holes (g.holes) M2 through. The coax connector hangs under the board.
 */
export function patchGeometry(p: CatalogPart): GeomResult {
  const g = p.geom;
  const d = g.dims;
  const w = num(d, "w", 54);
  const t = num(d, "t", 1.6);
  const sub = num(d, "sub", 40);
  const subH = num(d, "sub_h", 3.2);
  const pt = num(d, "patch", 26);
  const trunc = num(d, "trunc", 4);
  const holes = g.holes ?? [];
  const hd = g.hole_d ?? 2.2;
  const solids: CompSolid[] = [solid("", p.name, one(box(w, w, t, Z0, 1.5), holes.map(([x, y]) => ({ op: "cut" as const, shape: cyl(hd, t + 2, [x, y, -1]) }))), g.color ?? "#e6dcc6", "FR4", "solder-mask")];
  solids.push(solid("ceramic", `${p.name} dielectric`, one(box(sub, sub, subH, [0, 0, t], 0.5)), "#f2efe6", "PC", "matte"));
  const s = pt / 2;
  const patchPts: V2[] = [[-s + trunc, -s], [s, -s], [s, s - trunc], [s - trunc, s], [-s, s], [-s, -s + trunc]];
  solids.push(solid("patch", `${p.name} radiating patch`, one(plate(patchPts, 0.05, t + subH)), GOLD, "Copper", "polished"));
  solids.push(solid("feed", `${p.name} feed`, one(cyl(1.2, 0.3, [s * 0.32, -s * 0.32, t + subH])), SILVER, "Copper", "polished"));
  solids.push(solid("conn", `${p.name} MMCX connector`, one(union([box(4.8, 4.8, 1.4, [s * 0.32, -s * 0.32, -1.4]), cyl(3.6, 3.2, [s * 0.32, -s * 0.32, -4.5])])), GOLD, "Brass", "polished"));
  return {
    placement: "free",
    solids,
    fields: { scalars: { w, t, height: t + subH }, points: { top: [0, 0, t + subH], bottom: Z0 }, pointLists: { holes: holes.map(([x, y]) => [x, y, 0] as V3) } },
  };
}

// ---------------- PC/104 board helpers ----------------

/** a PC/104 board's stack-through connectors (H1, H2) as board features: the black bodies on top and the long tails under */
export const PC104 = { w: 90.17, d: 95.89, holes: [[40.005, 42.865], [-40.005, 42.865], [-40.005, -42.865], [40.005, -42.865]] as [number, number][] };

function pc104Board(w: number, d: number, t: number, z: number, color: string, suffix: string, label: string, holes: [number, number][]): CompSolid {
  return solid(
    suffix,
    label,
    one(box(w, d, t, [0, 0, z], 1), [...holes.map(([x, y]) => ({ op: "cut" as const, shape: cyl(3.2, t + 2, [x, y, z - 1]) })), { op: "chamfer", r: 0.2, edges: "top", cosmetic: true }]),
    color,
    "FR4",
    "solder-mask",
  );
}

/** the two stack connectors' bodies on a board's top at z, and their tails under it */
function stackConnectors(z: number, t: number, ys: number[]): { bodies: ShapeRecipe; tails: ShapeRecipe } {
  const bodies = union(ys.map((y) => box(66.04, 5.08, 8.5, [0, y, z + t], 0.3)));
  const pins: V3[] = [];
  for (const y of ys) for (let i = 0; i < 26; i++) for (const r of [-1.27, 1.27]) pins.push([-31.75 + i * 2.54, y + r, z - 7]);
  return { bodies, tails: copies(box(0.64, 0.64, 7, Z0), pins) };
}

// ---------------- the ADCS module ----------------

/**
 * space_adcs: an attitude control module of two PC/104 boards with three reaction wheels, two torquer rods and a
 * flat torquer coil between them, `at` the centre of the lower board's underside. The wheels stand in a row along Y
 * in the +X half on a machined bracket whose wall (wall_x) is where a star tracker looking out of -X is screwed on;
 * the -X half is left for it. dims: h overall, top_z the upper board's underside; wheel the wheels' square housing
 * and wheel_h their height, wheel_x the row's line; rod_l and rod_w the torquer rods.
 */
export function adcsGeometry(p: CatalogPart): GeomResult {
  const g = p.geom;
  const d = g.dims;
  const w = num(d, "w", PC104.w);
  const dd = num(d, "d", PC104.d);
  const t = 1.6;
  const topZ = num(d, "top_z", 38);
  const wheel = num(d, "wheel", 28);
  const wheelH = num(d, "wheel_h", 26.2);
  const wx = num(d, "wheel_x", 23.5);
  const wallX = num(d, "wall_x", 5);
  const rodW = num(d, "rod_w", 10.5);
  const holes = g.holes ?? PC104.holes;
  const solids: CompSolid[] = [pc104Board(w, dd, t, 0, g.color ?? "#1d5e3b", "", p.name, holes), pc104Board(w, dd, t, topZ, g.color ?? "#1d5e3b", "upper", `${p.name} control board`, holes)];
  const ys = [dd / 2 - 6.2, dd / 2 - 12.3];
  const low = stackConnectors(0, t, ys);
  const up = stackConnectors(topZ, t, ys);
  solids.push(solid("stack", `${p.name} stack connectors`, one(union([low.bodies, up.bodies])), "#111214", "PA66"));
  const items = (s: ShapeRecipe) => (s as { items: { shape: ShapeRecipe; xfs: Xform[][] }[] }).items;
  solids.push(solid("pins", `${p.name} connector tails`, one({ t: "instances", items: [...items(low.tails), ...items(up.tails)] }), GOLD, "Brass", "polished"));
  // the internal spacers between the two boards
  // tapped M3 right through: the stack's screws come up into them from below, the next standoff's stud down from above
  solids.push(solid("spacers", `${p.name} internal spacers`, one(copies(tube(5, 2.5, topZ - t, Z0), holes.map(([x, y]) => [x, y, t] as V3))), "#b7b9bd", "Aluminum 6061", "machined"));
  // the wheel bracket: a floor under the wheels and the wall a star tracker is screwed to, with its four M2 holes
  const zb = t;
  const fl = w / 2 - wallX - 1;
  const bracket: PartRecipe = one(union([box(fl, 88, 3, [wallX + fl / 2, 0, zb], 1.5), box(3, 52, topZ - t - 1.5, [wallX + 1.5, 0, zb], 1)]), [
    ...[[21, 13.5], [-21, 13.5], [-21, -13.5], [21, -13.5]].flatMap(([y, z]) => [
      { op: "cut" as const, shape: cyl(2.2, 5, [wallX - 1, y, zb + 18 + z], XP) },
      // countersunk on the wheels' side, so the flat heads sit flush beside the wheels
      { op: "cut" as const, shape: cone(2.2, 4.2, 1.01, [wallX + 2, y, zb + 18 + z], XP) },
    ]),
    { op: "chamfer", r: 0.4, edges: "convex", cosmetic: true },
  ]);
  solids.push(solid("bracket", `${p.name} wheel bracket`, bracket, "#b9bec6", "Aluminum 6061", "bead-blasted"));
  // the wheels: square housings with a round lid and four screws, their axes along Y, Z and X
  const wheelShape = union([box(wheel, wheel, wheelH - 2, Z0, 4), cyl(wheel - 4, 2, [0, 0, wheelH - 2.01])]);
  const zf = zb + 3;
  const wheelAt: { at: V3; dir: "x" | "y" | "z" }[] = [
    { at: [wx, -28 - wheelH / 2, zf + wheel / 2], dir: "y" },
    { at: [wx, 0, zf], dir: "z" },
    { at: [wx - wheelH / 2, 28, zf + wheel / 2], dir: "x" },
  ];
  const placeWheel = (sh: ShapeRecipe, wa: { at: V3; dir: "x" | "y" | "z" }): ShapeRecipe => {
    if (wa.dir === "z") return { t: "xform", shape: sh, xf: tr(wa.at) };
    if (wa.dir === "x") return { t: "xform", shape: sh, xf: [{ op: "rotate", angle: 90, origin: Z0, axis: YP }, { op: "translate", v: wa.at }] };
    return { t: "xform", shape: sh, xf: [{ op: "rotate", angle: -90, origin: Z0, axis: XP }, { op: "translate", v: wa.at }] };
  };
  solids.push(solid("wheels", `${p.name} reaction wheels`, one(union(wheelAt.map((wa) => placeWheel(wheelShape, wa)))), "#16171a", "Aluminum 6061", "anodized"));
  const lidScrews = copies(cyl(1.8, 0.6, Z0), [[9, 9, 0], [-9, 9, 0], [-9, -9, 0], [9, -9, 0]] as V3[]);
  solids.push(solid("wheel_screws", `${p.name} wheel lid screws`, one(union(wheelAt.map((wa) => placeWheel({ t: "xform", shape: lidScrews, xf: tr([0, 0, wheelH]) }, wa)))), "#9ea4ab", "Stainless 304", "machined"));
  // the torquer rods: one along Y at the +X edge, one along X in the -X half beside the tracker's space
  const rodA = box(rodW, 60, rodW, [w / 2 - rodW / 2 - 0.3, 0, zb + 0.4], 1.5);
  const rodB = { t: "xform" as const, shape: box(rodW, 50, rodW, Z0, 1.5), xf: [{ op: "rotate" as const, angle: 90, origin: Z0, axis: ZP }, { op: "translate" as const, v: [-w / 2 + 25 + 1, 40, zb + 0.4] as V3 }] };
  solids.push(solid("rods", `${p.name} magnetorquer rods`, one(union([rodA, rodB])), "#7a2a1c", "Copper", "machined"));
  // the air-core coil under the upper board, over the wheels
  const cx0 = wallX + 4;
  const cw = w / 2 - cx0 - 1;
  solids.push(solid("coil", `${p.name} air-core torquer coil`, one({ t: "extrude", p: { t: "diff2", a: { t: "rect", w: cw, h: dd - 14, r: 5, c: [cx0 + cw / 2, 0] }, b: [{ t: "rect", w: cw - 8, h: dd - 22, r: 2, c: [cx0 + cw / 2, 0] }] }, h: 4, f: { o: [0, 0, topZ - 4.2], u: XP, n: ZP }, twist: 0, scale: 1 }), "#b8692f", "Copper", "polished"));
  return {
    placement: "free",
    solids,
    fields: {
      scalars: { w, d: dd, t, height: num(d, "h", 57), top_z: topZ, wall_x: wallX },
      points: { top: [0, 0, topZ + t], bottom: Z0, center: [0, 0, topZ / 2], tracker_seat: [wallX, 0, zb + 18] },
      pointLists: { holes: holes.map(([x, y]) => [x, y, 0] as V3), top_holes: holes.map(([x, y]) => [x, y, topZ + t] as V3) },
    },
  };
}

// ---------------- the battery pack ----------------

/**
 * space_bp4: a PC/104 battery board with n 18650 cells lying along Y side by side, in two machined clamps, `at`
 * the centre of the board's underside. dims: cell_d, cell_l, n, h overall; cell_y where the cells' middle is along Y
 * (clear of the stack connectors near +Y).
 */
export function bp4Geometry(p: CatalogPart): GeomResult {
  const g = p.geom;
  const d = g.dims;
  const w = num(d, "w", PC104.w);
  const dd = num(d, "d", PC104.d);
  const t = 1.6;
  const cd = num(d, "cell_d", 18.4);
  const cl = num(d, "cell_l", 65.2);
  const n = Math.round(num(d, "n", 4));
  const h = num(d, "h", 23);
  const y0 = num(d, "cell_y", -3);
  const holes = g.holes ?? PC104.holes;
  const solids: CompSolid[] = [pc104Board(w, dd, t, 0, g.color ?? FR4_BLACK, "", p.name, holes)];
  const pitch = cd + 0.6;
  const xs = Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * pitch);
  const zc = t + 1.2 + cd / 2;
  const cell = cyl(cd, cl, [0, y0 - cl / 2, 0], YP);
  solids.push(solid("cells", `${p.name} 18650 cells, Kapton wrapped`, one(copies(cell, xs.map((x) => [x, 0, zc] as V3))), KAPTON, "PC", "gloss"));
  // the heater films wrapped over the middle of each cell
  solids.push(solid("heaters", `${p.name} heater films`, one(copies(tube(cd + 0.5, cd - 0.2, 24, [0, y0 - 12, 0], YP), xs.map((x) => [x, 0, zc] as V3))), "#8a4a12", "PC", "gloss"));
  // two clamps across the cells' ends, each screwed down to the board at both ends
  const span = n * pitch + 8;
  const clampAt = [y0 - cl / 2 + 5, y0 + cl / 2 - 5];
  const clamp = (y: number): ShapeRecipe => box(span, 8, h - t, [0, y, t], 1.2);
  const clampOps: PartRecipe["ops"] = [];
  for (const y of clampAt) for (const x of xs) clampOps.push({ op: "cut", shape: cyl(cd + 0.3, 9, [x, y - 4.5, zc], YP) });
  const sx = (n - 1) / 2 * pitch + cd / 2 + 1.8;
  for (const y of clampAt) for (const x of [-sx, sx]) clampOps.push({ op: "cut", shape: { t: "hole", d: 2.4, depth: h, at: [x, y, h] as V3, dir: ZN } });
  clampOps.push({ op: "chamfer", r: 0.5, edges: "convex", cosmetic: true });
  solids.push(solid("clamps", `${p.name} cell clamps`, one(union(clampAt.map(clamp)), clampOps), "#c3c8cf", "Aluminum 6061", "anodized"));
  // nickel strips joining the cells in series at each end, and the stack connectors
  solids.push(solid("strips", `${p.name} nickel interconnects`, one(union([box(span - 8, 1, 10, [0, y0 - cl / 2 - 0.6, zc - 5]), box(span - 8, 1, 10, [0, y0 + cl / 2 + 0.6, zc - 5])])), "#b9bcbf", "Steel", "polished"));
  const sc = stackConnectors(0, t, [dd / 2 - 6.2, dd / 2 - 12.3]);
  solids.push(solid("stack", `${p.name} stack connectors`, one(sc.bodies), "#111214", "PA66"));
  // the battery connector at the -X edge, beside the cells
  solids.push(solid("conn", `${p.name} battery connector`, one(box(5, 10, 4.2, [-42, -20, t], 0.3)), WHITE, "PA66"));
  solids.push(solid("pins", `${p.name} connector tails`, one(sc.tails), GOLD, "Brass", "polished"));
  return {
    placement: "free",
    solids,
    fields: {
      scalars: { w, d: dd, t, height: h },
      points: { top: [0, 0, h], bottom: Z0, center: [0, 0, h / 2] },
      pointLists: { holes: holes.map(([x, y]) => [x, y, 0] as V3) },
    },
  };
}

// ---------------- small parts ----------------

/**
 * space_switch: a subminiature basic switch (Omron D2F) standing on its mounting face, its plunger up +Z, `at` the
 * centre of the face. dims: w (X, along its length), d (Y), h, pin_d and pin_h the plunger, hole the two mounting
 * holes' spacing (Ø hole_d through Y).
 */
export function switchGeometry(p: CatalogPart): GeomResult {
  const g = p.geom;
  const d = g.dims;
  const w = num(d, "w", 12.8);
  const dd = num(d, "d", 5.8);
  const h = num(d, "h", 6.5);
  const pd = num(d, "pin_d", 2);
  const ph = num(d, "pin_h", 1.2);
  const hs = num(d, "hole", 6.5);
  const hd = g.hole_d ?? 1.2;
  const body: PartRecipe = {
    base: box(w, dd, h, Z0, 0.4),
    ops: [...[-hs / 2, hs / 2].map((x) => ({ op: "cut" as const, shape: cyl(hd, dd + 2, [x, -dd / 2 - 1, h / 2 - 0.5], YP) })), { op: "chamfer", r: 0.2, edges: "top", cosmetic: true }],
  };
  const solids = [solid("", p.name, body, g.color ?? "#141518", "PA66")];
  solids.push(solid("plunger", `${p.name} plunger`, one(cyl(pd, ph + 0.5, [-w / 2 + 3.3, 0, h - 0.5])), g.color2 ?? "#e8e4da", "POM", "machined"));
  solids.push(solid("terminals", `${p.name} terminals`, one(copies(box(0.5, 2.8, 3.5, Z0), [[-5.1, 0, -3.5], [-0.5, 0, -3.5], [5.6, 0, -3.5]] as V3[])), SILVER, "Brass", "polished"));
  return {
    placement: "free",
    solids,
    fields: {
      scalars: { w, d: dd, h, height: h + ph },
      points: { top: [0, 0, h], plunger: [-w / 2 + 3.3, 0, h + ph], bottom: Z0 },
      pointLists: { holes: [-hs / 2, hs / 2].map((x) => [x, 0, h / 2 - 0.5] as V3) },
    },
  };
}

/**
 * space_sun: a fine sun sensor's housing lying flat, its window up +Z, `at` the centre of its underside. dims: w,
 * d, h; win the window's diameter. holes (g.holes) M2 tapped in the base.
 */
export function sunSensorGeometry(p: CatalogPart): GeomResult {
  const g = p.geom;
  const d = g.dims;
  const w = num(d, "w", 41.7);
  const dd = num(d, "d", 17.7);
  const h = num(d, "h", 22.9);
  const win = num(d, "win", 7);
  const holes = g.holes ?? [];
  const body = one(box(w, dd, h, Z0, 1.5), [
    { op: "cut", shape: cone(win, win + 6, 3, [w / 4, 0, h - 2.99]) },
    ...holes.map(([x, y]) => ({ op: "cut" as const, shape: { t: "hole" as const, d: 1.6, depth: 4, at: [x, y, 0] as V3, dir: ZP } })),
    { op: "chamfer", r: 0.4, edges: "top", cosmetic: true },
  ]);
  const solids = [solid("", p.name, body, g.color ?? BLACK_AL, "Aluminum 6061", "anodized")];
  solids.push(solid("lens", `${p.name} window`, one(cyl(win, 0.6, [w / 4, 0, h - 3.2])), "#3d5d96", "Acrylic", "clear"));
  solids.push(solid("conn", `${p.name} connector`, one(box(9, 4, 3.5, [-w / 2 + 8, -dd / 2 - 1.9, 1.5], 0.3)), WHITE, "PA66"));
  return { placement: "free", solids, fields: { scalars: { w, d: dd, h, height: h }, points: { top: [0, 0, h], bottom: Z0 }, pointLists: { holes: holes.map(([x, y]) => [x, y, 0] as V3) } } };
}

/**
 * space_holddown: a burn-wire hold-down board lying flat, `at` the centre of its underside: two redundant burn
 * resistors the line runs over, a tie-off post and the line's anchor. dims: w (X), d (Y), t.
 */
export function holddownGeometry(p: CatalogPart): GeomResult {
  const g = p.geom;
  const d = g.dims;
  const w = num(d, "w", 30);
  const dd = num(d, "d", 14);
  const t = num(d, "t", 1.6);
  const holes = g.holes ?? [[-w / 2 + 3, 0], [w / 2 - 3, 0]];
  // where the line's parts sit: the resistors under the panels' tab holes (res_x), the tie-off post beside them (post_x, post_y)
  const px = num(d, "post_x", 0);
  const py = num(d, "post_y", -3.5);
  const rx = num(d, "res_x", 0);
  const cx = num(d, "conn_x", w / 2 - 8.5);
  const cy = num(d, "conn_y", -dd / 2 + 2);
  const solids = [solid("", p.name, one(box(w, dd, t, Z0, 1), holes.map(([x, y]) => ({ op: "cut" as const, shape: cyl(2.2, t + 2, [x, y, -1]) }))), g.color ?? "#16301f", "FR4", "solder-mask")];
  solids.push(solid("resistors", `${p.name} burn resistors`, one(copies(box(3.2, 1.6, 0.6, Z0), [[rx - 3.5, 0, t], [rx + 3.5, 0, t]] as V3[])), "#202326", "FR4"));
  solids.push(solid("post", `${p.name} tie-off post`, one(union([cyl(3, 4, [px, py, t]), cyl(4.5, 0.6, [px, py, t + 4])])), ALU, "Aluminum 6061", "machined"));
  // its harness connector hangs under the board, through a hole in the panel it is bonded to
  solids.push(solid("conn", `${p.name} connector`, one(box(6, 3.5, 3, [cx, cy, -3], 0.3)), WHITE, "PA66"));
  return { placement: "free", solids, fields: { scalars: { w, d: dd, t, height: t + 4.6 }, points: { top: [0, 0, t], post: [px, py, t + 4], line: [rx, 0, t + 0.6], bottom: Z0 }, pointLists: { holes: holes.map(([x, y]) => [x, y, 0] as V3) } } };
}

/** The shape of a space-hardware catalog part, by its geometry class; undefined for any other class. */
export function spaceGeometry(p: CatalogPart): GeomResult | undefined {
  switch (p.geom.g) {
    case "space_panel":
      return solarPanelGeometry(p);
    case "space_telescope":
      return telescopeGeometry(p);
    case "space_tracker":
      return trackerGeometry(p);
    case "space_ants":
      return antsGeometry(p);
    case "space_patch":
      return patchGeometry(p);
    case "space_adcs":
      return adcsGeometry(p);
    case "space_bp4":
      return bp4Geometry(p);
    case "space_switch":
      return switchGeometry(p);
    case "space_sun":
      return sunSensorGeometry(p);
    case "space_holddown":
      return holddownGeometry(p);
    default:
      return undefined;
  }
}
