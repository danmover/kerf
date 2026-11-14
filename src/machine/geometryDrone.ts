// The shapes of the bought parts of an FPV quad (catalog/drone.ts): a 22xx
// outrunner drawn the way the real one is built (vented base, wound stator,
// magnet ring, vented bell, prop shaft and the lock screw under the base), a
// tri-blade prop with twisted, tapered blades, the digital video camera and
// air unit, whip and T antennas, a lost-model buzzer and the low-ESR
// capacitor that goes on a 4-in-1 ESC's battery pads.
//
// Each class keeps the real outside dimensions and mounting interface of the
// product it draws (holes, shaft, faces), so mounts, clash and motion checks
// see the part as bought.

import type { PartRecipe, ShapeRecipe, V2, V3 } from "../kernel/recipe";
import type { CompSolid } from "../library/components";
import type { CatalogPart } from "./types";
import type { GeomResult } from "./geometry";
import { THREADS } from "../library/standards";

const Z0: V3 = [0, 0, 0];
const ZP: V3 = [0, 0, 1];
const ZN: V3 = [0, 0, -1];
const XP: V3 = [1, 0, 0];
const YP: V3 = [0, 1, 0];
const STEEL = "#b9bfc7";
const num = (d: Record<string, number>, k: string, def: number) => (typeof d[k] === "number" ? d[k] : def);
const box = (w: number, d: number, h: number, at: V3, r = 0): ShapeRecipe => ({ t: "box", w, d, h, at, r });
const cyl = (d: number, h: number, at: V3, dir: V3 = ZP): ShapeRecipe => ({ t: "cyl", d, h, at, dir });
const rotZ = (shape: ShapeRecipe, angle: number): ShapeRecipe => ({ t: "xform", shape, xf: [{ op: "rotate", angle, origin: Z0, axis: ZP }] });
const solid = (suffix: string, label: string, recipe: PartRecipe, color: string, material: string, moving?: boolean, finish?: string): CompSolid => ({ suffix, label, recipe, color, material, moving, ...(finish ? { finish } : {}) });
const one = (base: ShapeRecipe, ops: PartRecipe["ops"] = []): PartRecipe => ({ base, ops });
const ring = (n: number, r: number, start = 0): V2[] =>
  Array.from({ length: n }, (_, i) => {
    const a = ((start + (360 * i) / n) * Math.PI) / 180;
    return [r * Math.cos(a), r * Math.sin(a)] as V2;
  });

/** A thin cambered airfoil, chord c along +x from the trailing edge at -c/2 to the leading edge at +c/2. */
function airfoil(c: number, t: number, camber: number, n = 8): V2[] {
  const yt = (s: number) => 5 * t * c * (0.2969 * Math.sqrt(s) - 0.126 * s - 0.3516 * s * s + 0.2843 * s ** 3 - 0.1036 * s ** 4);
  const yc = (s: number) => camber * c * 4 * s * (1 - s);
  const ss = Array.from({ length: n + 1 }, (_, i) => (1 - Math.cos((Math.PI * i) / n)) / 2);
  const up = ss.map((s) => [c / 2 - s * c, yc(s) + yt(s)] as V2);
  const lo = ss.slice(1, -1).reverse().map((s) => [c / 2 - s * c, yc(s) - yt(s)] as V2);
  return [...up, ...lo];
}

/**
 * One span of a blade at azimuth a (degrees) from r0 to r1, its mid-chord on height z: chord c0 pitched b0 degrees
 * at r0, c1 at b1 at r1, the leading edge leading in +azimuth and up (+Z), so turning that way it pushes air down.
 * `sweep` moves the r1 section back along the chord (mm) for the swept tip of a freestyle prop.
 */
function bladeSpan(a: number, r0: number, r1: number, z: number, c0: number, c1: number, b0: number, b1: number, t: number, camber: number): ShapeRecipe {
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

// ---------------------------------------------------------------- 22xx FPV motor

/**
 * fpv_motor: a 22xx outrunner as T-Motor, iFlight and the rest build them. `at` is the centre of the base's mounting
 * face and `axis` runs up the shaft. dims: base_d and base_h the base; bell_d, bell_h the bell from the base gap to
 * its top face; stator_d, stator_h the stator (2207.5: 22 x 7.5); shaft_d and shaft_l the prop shaft above the bell
 * (M5); hole_sq the square the four tapped holes are on (16 x 16), hole_d their tap drill and hole_depth their depth;
 * poles the magnets (14), slots the stator teeth (12), vents the windows in the bell's top. The base is the main
 * solid; the stator and windings stand still; the bell, magnets, shaft and lock screw turn (`moving`). The three
 * leads leave the base's side at -Y as short stubs: the harness carries them on (harness/dronePlugs.ts).
 */
export function fpvMotorGeometry(p: CatalogPart): GeomResult {
  const g = p.geom;
  const d = g.dims;
  const bd = num(d, "base_d", 27);
  const bh = num(d, "base_h", 3.6);
  const belld = num(d, "bell_d", 26.8);
  const bellh = num(d, "bell_h", 15.6);
  const sd = num(d, "stator_d", 22);
  const sh = num(d, "stator_h", 7.5);
  const pd = num(d, "shaft_d", 5);
  const pl = num(d, "shaft_l", 11.3);
  const hsq = num(d, "hole_sq", 16);
  const hd = num(d, "hole_d", 2.5);
  const depth = num(d, "hole_depth", 3.5);
  const poles = Math.round(num(d, "poles", 14));
  const slots = Math.round(num(d, "slots", 12));
  const vents = Math.round(num(d, "vents", 6));
  const gap = 0.35;
  const z1 = bh + gap; // bell's open rim
  const zt = z1 + bellh; // bell's top face
  const wall = 0.9;
  const capT = 1.4;
  const holes: [number, number][] = [[hsq / 2, hsq / 2], [-hsq / 2, hsq / 2], [-hsq / 2, -hsq / 2], [hsq / 2, -hsq / 2]];

  // base: a disc with a recess for the stator's foot, four bosses round the tapped holes, four cooling windows
  // between them, the hub the stator stands on, and a counterbore under the shaft's lock screw
  const floor = Math.min(1.8, bh / 2);
  const window = (k: number): ShapeRecipe => rotZ(box(5.4, 5.6, floor + 0.2, [bd * 0.31, 0, -0.1], 1.2), 90 * k);
  const base: PartRecipe = one(cyl(bd, bh, Z0), [
    { op: "chamfer", r: 0.5, edges: "bottom" },
    { op: "cut", shape: { t: "tube", od: bd - 3.4, id: 9.5, h: bh - floor + 0.01, at: [0, 0, floor], dir: ZP } },
    ...holes.map(([x, y]) => ({ op: "add" as const, shape: cyl(5.2, bh - floor + 0.02, [x, y, floor - 0.01]) })),
    ...[0, 1, 2, 3].map((k) => ({ op: "cut" as const, shape: window(k) })),
    { op: "cut", shape: cyl(5.6, 1.2, [0, 0, -0.01]) },
    ...holes.map(([x, y]) => ({ op: "cut" as const, shape: cyl(hd, depth, [x, y, -0.01]) })),
  ]);
  // stator: the lamination stack on its hub, with the teeth's tips showing between the coils
  const zs = z1 + (bellh - capT - sh) / 2;
  const stator: PartRecipe = one({ t: "tube", od: sd, id: 8, h: sh, at: [0, 0, zs], dir: ZP }, [
    ...Array.from({ length: slots }, (_, i) => ({ op: "cut" as const, shape: rotZ(box(sd / 2 - 3.6, 2.2, sh + 0.2, [sd / 4 + 2.6, 0, zs - 0.1]), (360 * (i + 0.5)) / slots) })),
    { op: "add", shape: { t: "tube", od: 9.6, id: 8, h: zs - bh + floor + 0.5, at: [0, 0, floor - 0.25], dir: ZP } },
  ]);
  // windings: a copper coil round each tooth, standing proud of the stack top and bottom
  const coil = (i: number): ShapeRecipe => rotZ(box(sd / 2 - 5.2, 3.3, sh + 2.4, [sd / 4 + 2.3, 0, zs - 1.2], 0.9), (360 * i) / slots);
  const windings: PartRecipe = one({ t: "union", shapes: Array.from({ length: slots }, (_, i) => coil(i)) });
  // bell: the can and its top, with the vent windows round the hub and the boss the prop seats on
  const zb = zt + 0.8;
  const bell: PartRecipe = one({ t: "tube", od: belld, id: belld - 2 * wall, h: bellh - capT, at: [0, 0, z1], dir: ZP }, [
    { op: "add", shape: cyl(belld, capT, [0, 0, zt - capT]) },
    ...ring(vents, belld * 0.29, 90 / vents).map(([x, y]) => ({ op: "cut" as const, shape: cyl(belld * 0.2, capT + 0.2, [x, y, zt - capT - 0.1]) })),
    { op: "add", shape: cyl(pd + 4.2, zb - zt + 0.01, [0, 0, zt - 0.01]) },
    { op: "chamfer", r: 0.6, edges: "top" },
  ]);
  // magnets: the ring of arc magnets inside the can
  const magnets: PartRecipe = one({ t: "tube", od: belld - 2 * wall + 0.01, id: belld - 2 * wall - 2.4, h: sh + 1.2, at: [0, 0, zs - 0.6], dir: ZP }, [
    ...Array.from({ length: poles }, (_, i) => ({ op: "cut" as const, shape: rotZ(box(4, 0.45, sh + 1.6, [belld / 2 - wall - 1.2, 0, zs - 0.8]), (360 * i) / poles) })),
  ]);
  // prop shaft (M5, its thread left off) and the screw under the base that holds the bell on in place of a C-clip
  const shaft: PartRecipe = one(cyl(pd, pl + 0.01, [0, 0, zb - 0.01]), [{ op: "chamfer", r: 0.4, edges: "top" }]);
  const lock: PartRecipe = one(cyl(4.4, 0.8, [0, 0, 0.25]), [{ op: "cut", shape: { t: "prism", pts: ring(6, 1.15, 30), h: 0.6, at: [0, 0, 0.2], dir: ZP, rot: 0 } }]);
  // the three phase leads leave the base's side at -Y, one beside the other
  const leads: PartRecipe = one({ t: "union", shapes: [-1, 0, 1].map((k) => cyl(1.9, 3.2, [k * 2.05, -bd / 2 + 1.2, bh * 0.45], [0, -1, 0])) });
  const screw = Object.values(THREADS).reduce((a, b) => (Math.abs(b.tap - hd) < Math.abs(a.tap - hd) ? b : a));
  const top = zb + pl;
  return {
    placement: "axis",
    solids: [
      solid("", p.name, base, g.color ?? "#1b1d21", "Aluminum 7075", false, "anodized"),
      solid("stator", `${p.name} stator`, stator, "#5b6068", "Steel"),
      solid("windings", `${p.name} windings`, windings, "#b8692f", "Copper", false, "polished"),
      solid("bell", `${p.name} bell`, bell, g.color2 ?? "#8d939b", "Aluminum 7075", true, "anodized"),
      solid("magnets", `${p.name} magnets`, magnets, "#3a3d42", "Steel", true, "machined"),
      solid("shaft", `${p.name} prop shaft`, shaft, STEEL, "Steel", true, "polished"),
      solid("lock", `${p.name} shaft screw`, lock, "#30343a", "Steel", true, "black-oxide"),
      solid("leads", `${p.name} lead exits`, leads, "#15171a", "Silicone"),
    ],
    fields: {
      scalars: { shaft_d: pd, shaft_len: pl, bell_d: belld, base_d: bd, length: zb, height: top, screw: screw.name, screw_depth: depth, screw_clearance: screw.clearance },
      points: { face: Z0, at: Z0, prop_seat: [0, 0, zb], shaft_tip: [0, 0, top], bell_top: [0, 0, zt], body_center: [0, 0, zb / 2], leads: [0, -bd / 2 - 2, bh * 0.45] },
      pointLists: { holes: holes.map(([x, y]) => [x, y, 0] as V3) },
      dirs: { axis: ZP },
      // the arm under the motor: clearance holes for the four screws and room for the lock screw, down along -Z
      shapes: { mount: { t: "union", shapes: [...holes.map(([x, y]) => cyl(screw.clearance, 40.5, [x, y, 0.5], ZN)), cyl(6, 40.5, [0, 0, 0.5], ZN)] } },
    },
  };
}

// ---------------------------------------------------------------- tri-blade prop

/**
 * prop: a moulded multirotor prop. `at` is the centre of the hub's bottom face (where it sits on the motor's
 * bell) and `axis` points along the shaft, the way it pulls. dims: d diameter, pitch (mm per turn), blades,
 * hub_d and hub_h the hub, bore the shaft hole, ccw 1 for a prop that turns counter-clockwise seen from above
 * (its blades lead the other way), chord the widest chord, t the blade's thickness to chord. Every solid turns.
 */
export function propGeometry(p: CatalogPart): GeomResult {
  const g = p.geom;
  const d = g.dims;
  const D = num(d, "d", 129.5);
  const P = num(d, "pitch", 118.4);
  const nb = Math.max(2, Math.round(num(d, "blades", 3)));
  const hubD = num(d, "hub_d", 12.6);
  const hubH = num(d, "hub_h", 6.4);
  const bore = num(d, "bore", 5.15);
  const ccw = num(d, "ccw", 0) > 0;
  const cmax = num(d, "chord", 15.5);
  const tc = num(d, "t", 0.09);
  const R = D / 2;
  const beta = (r: number) => (Math.atan(P / (2 * Math.PI * r)) * 180) / Math.PI;
  // blade plan: a narrow root out of the hub that stays above the motor's bell, widest at about 40 % span, tapering
  // to a rounded tip
  const st: [number, number][] = [
    [hubD / 2 - 0.8, cmax * 0.42],
    [Math.max(R * 0.22, 14.5), cmax * 0.68],
    [R * 0.42, cmax],
    [R * 0.7, cmax * 0.82],
    [R * 0.92, cmax * 0.55],
    [R, cmax * 0.18],
  ];
  const zMid = hubH * 0.52;
  const blade = (a: number): ShapeRecipe => ({
    t: "union",
    shapes: st.slice(0, -1).map(([r0, c0], i) => {
      const [r1, c1] = st[i + 1];
      // the root span is pitched no steeper than 45°, as moulded props are, which keeps it clear of the bell
      return bladeSpan(a, r0, r1, zMid, c0, c1, Math.min(45, beta(r0)), Math.min(45, beta(r1)), i === 0 ? tc * 1.6 : tc, 0.05);
    }),
  });
  const blades: ShapeRecipe = { t: "union", shapes: Array.from({ length: nb }, (_, i) => blade((360 * i) / nb + 90)) };
  const hand: ShapeRecipe = ccw ? blades : { t: "xform", shape: blades, xf: [{ op: "mirror", origin: Z0, normal: XP }] };
  const hub: PartRecipe = one(cyl(hubD, hubH, Z0), [
    { op: "add", shape: hand },
    { op: "cut", shape: cyl(bore, hubH + 2, [0, 0, -1]) },
    // the recess under the hub that clears the bell's boss, and the raised seat on top for the nut
    { op: "cut", shape: cyl(hubD - 3.4, 0.6, [0, 0, -0.01]) },
    { op: "add", shape: { t: "tube", od: hubD - 2.2, id: bore, h: 0.5, at: [0, 0, hubH - 0.01], dir: ZP } },
  ]);
  return {
    placement: "axis",
    solids: [solid("", p.name, hub, g.color ?? "#7b3fd0", g.material ?? "PC", true, "clear")],
    fields: {
      scalars: { d: D, pitch: P, blades: nb, hub_h: hubH + 0.5, bore },
      points: { at: Z0, hub_top: [0, 0, hubH + 0.5], tip: [R, 0, zMid] },
      dirs: { axis: ZP },
    },
  };
}

// ---------------------------------------------------------------- digital FPV camera

/**
 * fpv_cam: a digital FPV camera module (DJI O4 Pro). `at` is the centre of the housing's front face and `axis` the way
 * it looks; local +Y is the image's up. dims: w (X) and h (Y) of the housing, l its depth behind the front face,
 * lens_d and lens_l the lens barrel in front, glass_d the front element, hole_y and hole_z where the M2 tapped
 * hole in each side face is (from the front face's centre, along Y and back along -Z), hole_depth, cable_d the coax
 * leaving the back. The housing is the main solid; the lens barrel, its ring and the glass are their own.
 */
export function fpvCamGeometry(p: CatalogPart): GeomResult {
  const g = p.geom;
  const d = g.dims;
  const w = num(d, "w", 20);
  const h = num(d, "h", 20);
  const l = num(d, "l", 16);
  const ld = num(d, "lens_d", 15.5);
  const ll = num(d, "lens_l", 9.5);
  const gd = num(d, "glass_d", 11);
  const hy = num(d, "hole_y", 0);
  const hz = num(d, "hole_z", 7);
  const hdp = num(d, "hole_depth", 3);
  const cd = num(d, "cable_d", 1.6);
  const housing: PartRecipe = one(box(w, h, l, [0, 0, -l], 1.6), [
    // a shallow face plate step, the heat-spreading grooves on top, the side tapped holes and the cable boot
    { op: "cut", shape: box(w - 3, h - 3, 0.6, [0, 0, -0.59], 1) },
    ...[-1, 0, 1].map((k) => ({ op: "cut" as const, shape: box(w - 6, 0.7, 0.5, [0, h / 2 - 0.49, -l / 2 + k * 3.2]) })),
    ...[-1, 1].map((s) => ({ op: "cut" as const, shape: cyl(1.6, hdp, [s * (w / 2 + 0.01), hy, -hz], [-s, 0, 0]) })),
    { op: "add", shape: cyl(cd + 2.2, 2.4, [0, -h * 0.2, -l + 0.01], ZN) },
  ]);
  const barrel: PartRecipe = one(cyl(ld, ll - 1.2, [0, 0, -0.6]), [
    { op: "add", shape: cyl(ld + 1.4, 2.2, [0, 0, -0.6]) },
    ...Array.from({ length: 18 }, (_, i) => ({ op: "cut" as const, shape: rotZ(box(0.7, 1.2, 2.2, [ld / 2 + 0.75, 0, -0.6]), i * 20) })),
    { op: "cut", shape: cyl(gd + 0.8, 0.9, [0, 0, ll - 2.7]) },
  ]);
  const ringR: PartRecipe = one({ t: "tube", od: gd + 2.4, id: gd + 0.2, h: 0.7, at: [0, 0, ll - 1.9], dir: ZP });
  const glass: PartRecipe = one({ t: "revolve", pts: [[0, ll - 2.4], [gd / 2, ll - 2.4], [gd / 2, ll - 1.9], [gd * 0.36, ll - 1.35], [0, ll - 1.15]], at: Z0, dir: ZP });
  return {
    placement: "axis",
    solids: [
      solid("", p.name, housing, g.color ?? "#202226", g.material ?? "Aluminum 6061", false, "bead-blasted"),
      solid("lens", `${p.name} lens barrel`, barrel, "#131416", "Aluminum 6061", false, "anodized"),
      solid("ring", `${p.name} lens ring`, ringR, g.color2 ?? "#9a7a3a", "Aluminum 6061", false, "anodized"),
      solid("glass", `${p.name} front element`, glass, "#1d2f4f", "Acrylic", false, "gloss"),
    ],
    fields: {
      scalars: { w, h, l, lens_l: ll },
      points: { at: Z0, front: Z0, lens: [0, 0, ll], back: [0, 0, -l], center: [0, 0, -l / 2], cable: [0, -h * 0.2, -l - 2.4] },
      // the M2 holes, on the side faces' surfaces; a screw goes in along -X at +X and along +X at -X
      pointLists: { holes: [[w / 2, hy, -hz], [-w / 2, hy, -hz]] },
      dirs: { axis: ZP },
    },
  };
}

// ---------------------------------------------------------------- digital video transmitter

/**
 * fpv_vtx: a digital video air unit (DJI O4 Air Unit Pro). `at` is the centre of its underside, +Z up through the
 * finned top, the camera socket at +Y. dims: w (X), d (Y), h overall; base_h the shell under the heatsink; fins,
 * fin_t, fin_h the heatsink's fins along Y; holes in `holes` (M2 tapped, hole_depth deep, from the underside).
 * The shell is the main solid, the heatsink the second.
 */
export function fpvVtxGeometry(p: CatalogPart): GeomResult {
  const g = p.geom;
  const d = g.dims;
  const w = num(d, "w", 33.5);
  const dd = num(d, "d", 33.5);
  const h = num(d, "h", 13);
  const sh = num(d, "base_h", 5.2);
  const nf = Math.max(3, Math.round(num(d, "fins", 9)));
  const ft = num(d, "fin_t", 0.9);
  const fh = num(d, "fin_h", h - sh - 1.6);
  const hdp = num(d, "hole_depth", 3);
  const holes = g.holes ?? [];
  const shell: PartRecipe = one(box(w, dd, sh, Z0, 2.4), [
    { op: "chamfer", r: 0.6, edges: "bottom" },
    ...holes.map(([x, y]) => ({ op: "cut" as const, shape: cyl(1.6, hdp, [x, y, -0.01]) })),
    // the side ports: USB-C and the microSD slot on -X, the 6-pin socket on +X, the camera socket on +Y
    { op: "cut", shape: box(1.6, 9.2, 3.4, [-w / 2 + 0.79, -5, 0.9], 1.2) },
    { op: "cut", shape: box(1.2, 11.5, 1.3, [-w / 2 + 0.59, 8, 3.1]) },
    { op: "cut", shape: box(1.2, 6.4, 3.0, [w / 2 - 0.59, 2, 1.1], 0.4) },
    { op: "cut", shape: box(5.2, 1.2, 2.2, [0, dd / 2 - 0.59, 1.4], 0.4) },
  ]);
  const pitch = (w - 4) / (nf - 1);
  const sink: PartRecipe = one(box(w - 0.4, dd - 0.4, 1.6, [0, 0, sh - 0.01], 2.2), [
    ...Array.from({ length: nf }, (_, i) => ({ op: "add" as const, shape: box(ft, dd - 3, fh, [-w / 2 + 2 + i * pitch, 0, sh + 1.58], 0.3) })),
  ]);
  // two U.FL sockets on the rear corners, the link button and the status LED window
  const ufl: PartRecipe = one({ t: "union", shapes: [-1, 1].flatMap((s) => [box(2.6, 2.6, 0.9, [s * (w / 2 - 3.2), -dd / 2 + 3.2, sh - 0.01]), cyl(1.9, 1.25, [s * (w / 2 - 3.2), -dd / 2 + 3.2, sh + 0.88])]) });
  const button: PartRecipe = one({ t: "union", shapes: [cyl(2.4, 0.8, [-w / 2 + 0.2, -12.5, 3.2], [-1, 0, 0]), box(0.5, 1.6, 0.9, [-w / 2 - 0.05, 12.2, 3.3])] });
  return {
    placement: "free",
    solids: [
      solid("", p.name, shell, g.color ?? "#2a2c31", "PC", false, "matte"),
      solid("sink", `${p.name} heatsink`, sink, g.color2 ?? "#3d4047", "Aluminum 6061", false, "anodized"),
      solid("ufl", `${p.name} antenna sockets`, ufl, "#d0b46a", "Brass", false, "polished"),
      solid("button", `${p.name} button and LED`, button, "#e9eef4", "Silicone"),
    ],
    fields: {
      scalars: { w, d: dd, h, height: h },
      points: { top: [0, 0, h], bottom: Z0, center: [0, 0, h / 2], cam_socket: [0, dd / 2, 2.5], ant1: [w / 2 - 3.2, -dd / 2 + 3.2, sh + 2.1], ant2: [-(w / 2 - 3.2), -dd / 2 + 3.2, sh + 2.1] },
      pointLists: { holes: holes.map(([x, y]) => [x, y, 0] as V3) },
    },
  };
}

// ---------------------------------------------------------------- antennas

/**
 * fpv_antenna: the radiating end of an antenna on a coax lead. `at` is where the coax meets it and `axis` runs out
 * along it. dims: l its length, d its diameter; t_w > 0 makes it a T dipole t_w across instead of a whip (a
 * receiver's T antenna), with wire_d its wires. The lead itself is the part's own lead (wired in the design).
 */
export function fpvAntennaGeometry(p: CatalogPart): GeomResult {
  const g = p.geom;
  const d = g.dims;
  const l = num(d, "l", 30);
  const dia = num(d, "d", 3.2);
  const tw = num(d, "t_w", 0);
  const wd = num(d, "wire_d", 1.1);
  if (tw > 0) {
    // a T: the coax's sleeve up to a moulded tee, and the two dipole wires out each side in clear sleeving
    const stem: PartRecipe = one(cyl(dia, l, Z0), [{ op: "add", shape: box(4.2, dia + 0.6, 3.2, [0, 0, l - 0.01], 0.6) }]);
    const arms: PartRecipe = one({ t: "union", shapes: [cyl(wd, tw / 2, [0, 0, l + 1.6], XP), cyl(wd, tw / 2, [0, 0, l + 1.6], [-1, 0, 0])] });
    return {
      placement: "axis",
      solids: [solid("", p.name, stem, g.color ?? "#16181b", "Silicone"), solid("arms", `${p.name} dipole`, arms, g.color2 ?? "#d8dde3", "Silicone")],
      fields: { scalars: { l: l + 3.2, d: dia }, points: { at: Z0, tip: [0, 0, l + 3.2] }, dirs: { axis: ZP } },
    };
  }
  const whip: PartRecipe = one(cyl(dia, l, Z0), [{ op: "fillet", r: dia * 0.45, edges: "top" }]);
  const band: PartRecipe = one({ t: "tube", od: dia + 0.3, id: dia - 0.2, h: 2.4, at: [0, 0, 1.2], dir: ZP });
  return {
    placement: "axis",
    solids: [solid("", p.name, whip, g.color ?? "#16181b", "Silicone"), solid("band", `${p.name} band`, band, g.color2 ?? "#c9ced6", "PVC")],
    fields: { scalars: { l, d: dia }, points: { at: Z0, tip: [0, 0, l] }, dirs: { axis: ZP } },
  };
}

// ---------------------------------------------------------------- lost-model buzzer

/**
 * fpv_buzzer: a self-powered lost-model buzzer (ViFly Finder 2). `at` is the centre of its bottom face, +Z up, its
 * leads leaving the -X end. dims: w (X), d (Y), h (Z). The case is the main solid; the sounder port, LED window
 * and button are the second.
 */
export function fpvBuzzerGeometry(p: CatalogPart): GeomResult {
  const g = p.geom;
  const d = g.dims;
  const w = num(d, "w", 24);
  const dd = num(d, "d", 13);
  const h = num(d, "h", 10.5);
  const body: PartRecipe = one(box(w, dd, h, Z0, 2.2), [
    { op: "fillet", r: 1, edges: "top" },
    { op: "cut", shape: cyl(3.2, 1.2, [w / 2 - 6, 0, h - 1.19]) },
    { op: "cut", shape: box(w - 4, 0.5, 0.4, [0, -dd / 2 + 0.19, h * 0.45]) },
    { op: "add", shape: box(3, dd * 0.6, h * 0.5, [-w / 2 - 1.4, 0, h * 0.2], 0.8) },
  ]);
  const bits: PartRecipe = one({ t: "union", shapes: [cyl(2.6, 0.3, [w / 2 - 6, 0, h - 1.2]), box(2, 1.3, 0.4, [-w / 2 + 5, 2.6, h - 0.2], 0.3), cyl(2.2, 0.5, [-w / 2 + 5, -2.4, h - 0.1])] });
  return {
    placement: "free",
    solids: [solid("", p.name, body, g.color ?? "#17191c", "PC", false, "matte"), solid("port", `${p.name} sounder, LED and button`, bits, g.color2 ?? "#2b6fd6", "Silicone")],
    fields: { scalars: { w, d: dd, h, height: h }, points: { top: [0, 0, h], bottom: Z0, center: [0, 0, h / 2], leads: [-w / 2 - 2.9, 0, h * 0.45] }, pointLists: { holes: [] } },
  };
}

// ---------------------------------------------------------------- radial capacitor on leads

/**
 * radial_cap: an aluminium electrolytic capacitor on its own legs (soldered to pads, not into a board). `at` is the
 * centre of its base, where the legs leave, and `axis` runs up the can. dims: d, h the can, leg_l and leg_d the legs
 * (bent down along -Z), pitch between them. The sleeve is the main solid; the stripe over the − leg, the top and
 * the legs are their own.
 */
export function radialCapGeometry(p: CatalogPart): GeomResult {
  const g = p.geom;
  const d = g.dims;
  const D = num(d, "d", 10);
  const H = num(d, "h", 20);
  const ll = num(d, "leg_l", 12);
  const ld = num(d, "leg_d", 0.6);
  const pitch = num(d, "pitch", 5);
  const sleeve: PartRecipe = one(cyl(D, H, Z0), [
    { op: "cut", shape: { t: "tube", od: D + 1, id: D - 0.5, h: 0.6, at: [0, 0, H - 1.6], dir: ZP } },
    { op: "fillet", r: 0.5, edges: "top" },
  ]);
  const stripe: PartRecipe = one({ t: "xform", shape: box(D * 0.36, 0.5, H - 3, [0, D / 2 - 0.12, 1]), xf: [{ op: "rotate", angle: 90, origin: Z0, axis: ZP }] });
  const top: PartRecipe = one(cyl(D - 1.4, 0.2, [0, 0, H - 0.05]), [{ op: "cut", shape: box(D * 0.6, 0.35, 0.3, [0, 0, H - 0.1]) }, { op: "cut", shape: box(0.35, D * 0.6, 0.3, [0, 0, H - 0.1]) }]);
  const legs: PartRecipe = one({ t: "union", shapes: [-1, 1].map((s) => cyl(ld, ll, [s * (pitch / 2), 0, 0.01], ZN)) });
  return {
    placement: "axis",
    solids: [
      solid("", p.name, sleeve, g.color ?? "#1a1c20", "PVC", false, "satin"),
      solid("stripe", `${p.name} minus stripe`, stripe, g.color2 ?? "#d9dde2", "PVC"),
      solid("top", `${p.name} vent`, top, "#b9bfc7", "Aluminum 6061"),
      solid("legs", `${p.name} legs`, legs, "#c9ccd1", "Brass", false, "polished"),
    ],
    fields: { scalars: { d: D, h: H }, points: { at: Z0, top: [0, 0, H], plus: [pitch / 2, 0, -ll], minus: [-pitch / 2, 0, -ll] }, dirs: { axis: ZP } },
  };
}

// ---------------------------------------------------------------- nano receiver

/**
 * fpv_rx: a nano RC receiver board (RadioMaster RP1). `at` is the centre of its underside, +Z up, its U.FL antenna
 * socket at the +X end and its four solder pads along the -X end. dims: w (X), d (Y), t the board, h overall.
 */
export function fpvRxGeometry(p: CatalogPart): GeomResult {
  const g = p.geom;
  const d = g.dims;
  const w = num(d, "w", 13);
  const dd = num(d, "d", 11);
  const t = num(d, "t", 1);
  const h = num(d, "h", 3);
  const board: PartRecipe = one(box(w, dd, t, Z0, 0.6), [{ op: "cut", shape: box(0.4, dd, t + 0.2, [-w / 2 + 2.7, 0, -0.1]) }]);
  const ch = Math.min(0.9, h - t - 0.2);
  // the radio (SX1281), its MCU (ESP8285), the TCXO and the LED on top
  const chips: PartRecipe = one({ t: "union", shapes: [box(4, 4, ch, [1.2, 1.6, t - 0.01], 0.2), box(5, 5, ch, [-1.2, -2.4, t - 0.01], 0.2), box(2, 1.6, 0.8, [4.6, -3.6, t - 0.01], 0.2)] });
  const led: PartRecipe = one(box(1.6, 0.8, 0.6, [4.6, 3.6, t - 0.01]));
  const ufl: PartRecipe = one(box(2.6, 2.6, 0.9, [w / 2 - 1.6, 0, t - 0.01]), [{ op: "add", shape: cyl(1.9, h - t - 0.9, [w / 2 - 1.6, 0, t + 0.88]) }]);
  // the four pads, tinned, along the -X end
  const pads: PartRecipe = one({ t: "union", shapes: [-1.5, -0.5, 0.5, 1.5].map((k) => box(1.8, 1.6, 0.06, [-w / 2 + 1.3, k * 2.5, t - 0.01], 0.3)) });
  return {
    placement: "free",
    solids: [
      solid("", p.name, board, g.color ?? "#121417", "FR4", false, "solder-mask"),
      solid("chips", `${p.name} chips`, chips, "#1b1c1f", "PC", false, "matte"),
      solid("led", `${p.name} LED`, led, "#e8f2ff", "PC", false, "clear"),
      solid("ufl", `${p.name} antenna socket`, ufl, "#d0b46a", "Brass", false, "polished"),
      solid("pads", `${p.name} pads`, pads, "#cfd3d8", "Brass", false, "polished"),
    ],
    fields: { scalars: { w, d: dd, t, h, height: h }, points: { top: [0, 0, t], bottom: Z0, center: [0, 0, t / 2], antenna: [w / 2 - 1.6, 0, h] }, pointLists: { holes: [] } },
  };
}

// ---------------------------------------------------------------- GNSS module with compass

/**
 * fpv_gps: a GNSS and compass board with a chip-antenna module on top (Matek M10Q-5883: u-blox SAM-M10Q, its 15 mm
 * patch on top, the QMC5883L compass and the JST GH socket underneath). `at` is the centre of the board's underside,
 * +Z up to the sky, the socket at -Y. dims: w, d, t the board, mod the module's footprint and mod_h its shielded
 * base, patch and patch_h the ceramic patch, gh_h the socket under the board.
 */
export function fpvGpsGeometry(p: CatalogPart): GeomResult {
  const g = p.geom;
  const d = g.dims;
  const w = num(d, "w", 20);
  const dd = num(d, "d", 20);
  const t = num(d, "t", 1);
  const mod = num(d, "mod", 15.5);
  const mh = num(d, "mod_h", 2.3);
  const pa = num(d, "patch", 15);
  const ph = num(d, "patch_h", 4);
  const gh = num(d, "gh_h", 4.2);
  const board: PartRecipe = one(box(w, dd, t, Z0, 1), [{ op: "cut", shape: box(1.2, 0.6, t + 0.2, [w / 2 - 2, dd / 2 - 0.9, -0.1]) }]);
  const shield: PartRecipe = one(box(mod, mod, mh, [0, 0.8, t - 0.01], 0.4));
  const patch: PartRecipe = one(box(pa, pa, ph, [0, 0.8, t + mh - 0.02], 0.6), [{ op: "chamfer", r: 0.5, edges: "top" }]);
  const feed: PartRecipe = one(box(pa * 0.72, pa * 0.72, 0.08, [0, 0.8, t + mh + ph - 0.05], 0.8), [{ op: "add", shape: cyl(1.4, 0.2, [1.6, 0.8 + 1.6, t + mh + ph - 0.02]) }]);
  // the compass chip, regulator and the GH socket on the back; the green PPS LED by the socket's edge on top
  const back: PartRecipe = one({ t: "union", shapes: [box(3, 3, 0.9, [-4, 4, -0.89], 0.2), box(2.9, 1.6, 1.1, [5, 4, -1.09], 0.2)] });
  const socket: PartRecipe = one(box(8.6, 4.25, gh, [0, -dd / 2 + 2.6, -gh + 0.01], 0.3), [{ op: "cut", shape: box(7.4, 3, gh - 0.8, [0, -dd / 2 + 2.1, -gh - 0.02]) }]);
  const led: PartRecipe = one(box(1.6, 0.8, 0.6, [w / 2 - 2, -dd / 2 + 1.4, t - 0.01]));
  return {
    placement: "free",
    solids: [
      solid("", p.name, board, g.color ?? "#15171a", "FR4", false, "solder-mask"),
      solid("shield", `${p.name} module`, shield, "#c3c7cd", "Steel", false, "machined"),
      solid("patch", `${p.name} patch antenna`, patch, "#e6dccb", "PC", false, "matte"),
      solid("feed", `${p.name} patch electrode`, feed, "#d5d8dc", "Brass", false, "polished"),
      solid("back", `${p.name} compass and regulator`, back, "#1b1c1f", "PC", false, "matte"),
      solid("socket", `${p.name} GH socket`, socket, "#efe9da", "Nylon"),
      solid("led", `${p.name} PPS LED`, led, "#3fd06a", "PC", false, "clear"),
    ],
    fields: { scalars: { w, d: dd, t, height: t + mh + ph, below: gh }, points: { top: [0, 0, t + mh + ph], bottom: Z0, center: [0, 0, t / 2], socket: [0, -dd / 2, -gh / 2] }, pointLists: { holes: [] } },
  };
}

export { YP };
