// The shapes of the legged-robot parts in catalog/legged.ts: a CubeMars AK
// actuator (qdd), the RealSense depth camera, the Jetson developer kit, an
// ISO mini relay and a flanged HTD pulley with a bolt-circle hub. Each is
// drawn from the maker's outline drawing, with the details that make it read
// as the real thing: the back cover's connectors, the output flange's bolt
// circle, the camera's four windows, the Jetson's fan heat sink and its row
// of ports. Every frame is noted on its function.

import type { PartRecipe, ShapeRecipe, V2, V3 } from "../kernel/recipe";
import type { CompSolid } from "../library/components";
import type { CatalogPart } from "./types";
import type { GeomResult } from "./geometry";

const ZP: V3 = [0, 0, 1];
const ZN: V3 = [0, 0, -1];
const XP: V3 = [1, 0, 0];
const YP: V3 = [0, 1, 0];
const YN: V3 = [0, -1, 0];
const num = (d: Record<string, number>, k: string, def: number) => (typeof d[k] === "number" ? d[k] : def);
const box = (w: number, d: number, h: number, at: V3, r = 0): ShapeRecipe => ({ t: "box", w, d, h, at, r });
const cyl = (d: number, h: number, at: V3, dir: V3 = ZP): ShapeRecipe => ({ t: "cyl", d, h, at, dir });
const solid = (suffix: string, label: string, recipe: PartRecipe, color: string, material: string, moving?: boolean, finish?: string): CompSolid =>
  ({ suffix, label, recipe, color, material, moving, ...(finish ? { finish } : {}) }) as CompSolid;
const only = (base: ShapeRecipe, ops: PartRecipe["ops"] = []): PartRecipe => ({ base, ops });
const ring = (n: number, r: number, z: number, a0 = 0): V3[] => Array.from({ length: n }, (_, i) => {
  const a = a0 + (2 * Math.PI * i) / n;
  return [r * Math.cos(a), r * Math.sin(a), z] as V3;
});

/** Dispatch for the shapes this file draws; undefined for any other. */
export function leggedGeometry(p: CatalogPart): GeomResult | undefined {
  switch (p.geom.g) {
    case "qdd":
      return qddGeometry(p);
    case "depth_camera":
      return depthCameraGeometry(p);
    case "jetson_devkit":
      return jetsonGeometry(p);
    case "auto_relay":
      return relayGeometry(p);
    case "htd_pulley":
      return htdPulleyGeometry(p);
  }
  return undefined;
}

// ---------------------------------------------------------------- AK actuator

/**
 * Where the parts of an AK-series actuator are (its own frame, mm): the origin is the centre of the output flange's
 * face and +Z runs out of it, so the body lies along -Z. The stator's back face (where it is mounted) is at -l.
 */
export function qddLayout(p: CatalogPart) {
  const d = p.geom.dims;
  const D = num(d, "d", 89);
  const L = num(d, "l", 44);
  return {
    D,
    L,
    flangeD: num(d, "flange_d", 44),
    outPcd: num(d, "out_pcd", 36),
    outN: num(d, "out_n", 8),
    mountPcd: num(d, "mount_pcd", 76),
    mountN: num(d, "mount_n", 6),
    coverD: num(d, "cover_d", 64),
    coverT: num(d, "cover_t", 2.5),
    frontD: num(d, "front_d", 80),
    frontL: num(d, "front_l", 4.5),
  };
}

function qddGeometry(p: CatalogPart): GeomResult {
  const Q = qddLayout(p);
  const { D, L } = Q;
  const R = D / 2;
  const fr = Q.frontD / 2;
  const flR = Q.flangeD / 2;
  const dark = p.geom.color ?? "#202226";
  const metal = p.geom.color2 ?? "#b9bdc3";
  // the stator housing: the main can with chamfered ends, a stepped-down front ring round the output and a recess the
  // output turns in; three fine grooves round the can where the case halves meet and the label sits
  const z0 = -L;
  const zf = -Q.frontL; // where the can steps down to the front ring
  const pts: V2[] = [
    [0, z0 + 2],
    [R - 6, z0 + 2],
    [R - 6, z0],
    [R - 1.2, z0],
    [R, z0 + 1.2],
    [R, zf - 1.2],
    [R - 1.2, zf],
    [fr, zf],
    [fr, -1.9],
    [fr - 0.6, -1.3],
    [flR + 1.2, -1.3],
    [flR + 1.2, -7],
    [0, -7],
  ];
  const housing: PartRecipe = {
    base: { t: "revolve", pts, at: [0, 0, 0], dir: ZP },
    ops: [
      ...[-0.3, 0.3].map((k) => ({ op: "cut" as const, shape: { t: "tube" as const, od: D + 1, id: D - 0.8, h: 0.5, at: [0, 0, z0 + L * 0.5 + k * L * 0.6] as V3, dir: ZP }, cosmetic: true })),
      { op: "cut" as const, shape: { t: "tube", od: 2 * fr + 1, id: 2 * fr - 0.6, h: 0.4, at: [0, 0, zf + 1.4], dir: ZP }, cosmetic: true },
      // the M3 threads in the back face it is mounted by (drawn at the root diameter, 6 deep)
      ...ring(Q.mountN, Q.mountPcd / 2, z0 - 0.01, Math.PI / Q.mountN).map((c) => ({ op: "cut" as const, shape: cyl(2.5, 6, c) })),
      // three cooling slots in the front ring
      ...[0, 1, 2].map((i) => ({ op: "cut" as const, shape: { t: "xform" as const, shape: box(9, 2.2, 1.2, [fr - 7, 0, -1.31 - 1.19]), xf: [{ op: "rotate" as const, angle: 30 + i * 120, origin: [0, 0, 0] as V3, axis: ZP }] }, cosmetic: true })),
    ],
  };
  // the back cover over the driver board, with its four screws
  const coverZ = z0 - Q.coverT;
  const cover: PartRecipe = {
    base: cyl(Q.coverD, Q.coverT + 0.02, [0, 0, coverZ]),
    ops: [{ op: "chamfer", r: 0.6, edges: "bottom" }],
  };
  const coverScrews: PartRecipe = only({ t: "union", shapes: ring(4, Q.coverD / 2 - 4.5, coverZ - 1.4, Math.PI / 4).map((c) => cyl(4.6, 1.42, c)) }, ring(4, Q.coverD / 2 - 4.5, coverZ - 1.41, Math.PI / 4).map((c) => ({ op: "cut" as const, shape: cyl(2.4, 1, c), cosmetic: true })));
  // the XT30PW-M power socket and the CAN and UART sockets standing out of the cover
  const xt: V3 = [11, -14, coverZ];
  const xtBody: PartRecipe = {
    base: box(10.4, 5.6, 7.2, [xt[0], xt[1], coverZ - 7.2], 0.6),
    ops: [
      { op: "cut", shape: box(3.6, 3.2, 5.5, [xt[0] - 2.5, xt[1], coverZ - 7.21], 0.3) },
      { op: "cut", shape: box(3.6, 3.2, 5.5, [xt[0] + 2.5, xt[1], coverZ - 7.21], 0.3) },
    ],
  };
  const xtPins: PartRecipe = only({ t: "union", shapes: [-2.5, 2.5].map((dx) => cyl(2, 5, [xt[0] + dx, xt[1], coverZ - 6.8])) });
  const can: V3 = [-8, -19, coverZ];
  const uart: V3 = [-17, -12, coverZ];
  const sockets: PartRecipe = {
    base: { t: "union", shapes: [box(5.2, 3.6, 4.4, [can[0], can[1], coverZ - 4.4], 0.2), box(6.6, 3.6, 4.4, [uart[0], uart[1], coverZ - 4.4], 0.2)] },
    ops: [{ op: "cut", shape: box(4.2, 2.4, 3.6, [can[0], can[1], coverZ - 4.41]) }, { op: "cut", shape: box(5.6, 2.4, 3.6, [uart[0], uart[1], coverZ - 4.41]) }],
  };
  // the output: a flange on the planet carrier with its bolt circle (M3, root diameter) and a centring recess
  const flange: PartRecipe = {
    base: cyl(Q.flangeD, 7.0, [0, 0, -7]),
    ops: [
      { op: "chamfer", r: 0.5, edges: "top" },
      { op: "cut", shape: cyl(14, 1.2, [0, 0, -1.19]) },
      ...ring(Q.outN, Q.outPcd / 2, -5.5, Math.PI / Q.outN).map((c) => ({ op: "cut" as const, shape: cyl(2.5, 5.52, c) })),
    ],
  };
  // what to cut from a plate the back face is bolted to: a clearance hole for each M3 and room for the cover and its sockets
  const mountCut: ShapeRecipe = {
    t: "union",
    shapes: [cyl(Q.coverD + 3, 30, [0, 0, z0 - 20]), ...ring(Q.mountN, Q.mountPcd / 2, z0 - 20, Math.PI / Q.mountN).map((c) => cyl(3.4, 30, c))],
  };
  // what to cut from a plate bolted to the output: the M3 clearance holes and the centring spigot
  const flangeCut: ShapeRecipe = { t: "union", shapes: ring(Q.outN, Q.outPcd / 2, -5, Math.PI / Q.outN).map((c) => cyl(3.4, 30, c)) };
  return {
    placement: "axis",
    solids: [
      solid("", p.name, housing, dark, "Aluminum 6061", false, "anodized"),
      solid("cover", `${p.name} back cover`, cover, "#141518", "Aluminum 6061", false, "anodized"),
      solid("cover_screws", `${p.name} cover screws`, coverScrews, "#8d939b", "Steel"),
      solid("xt30", `${p.name} XT30 power socket`, xtBody, "#e8b423", "PA66"),
      solid("xt30_pins", `${p.name} XT30 contacts`, xtPins, "#c9a23a", "Brass"),
      solid("sockets", `${p.name} CAN and UART sockets`, sockets, "#ece9df", "PA66"),
      solid("flange", `${p.name} output flange`, flange, metal, "Aluminum 6061", true, "bead-blasted"),
    ],
    fields: {
      scalars: { d: D, l: L, flange_d: Q.flangeD, out_pcd: Q.outPcd, mount_pcd: Q.mountPcd, back: L + Q.coverT + 7.2, screw: "M3", screw_depth: 5.5, mount_depth: 6, screw_clearance: 3.4 },
      points: { at: [0, 0, 0], back: [0, 0, z0], center: [0, 0, -L / 2], plug: [xt[0], xt[1], coverZ - 7.2], can: [can[0], can[1], coverZ - 4.4] },
      // holes and mount: the names every motor gives for its back-face fixing
      pointLists: { out_holes: ring(Q.outN, Q.outPcd / 2, 0, Math.PI / Q.outN), mount_holes: ring(Q.mountN, Q.mountPcd / 2, z0, Math.PI / Q.mountN), holes: ring(Q.mountN, Q.mountPcd / 2, z0, Math.PI / Q.mountN) },
      dirs: { axis: ZP, back: ZN },
      shapes: { mount_cut: mountCut, flange_cut: flangeCut, mount: mountCut },
    },
  };
}

// ---------------------------------------------------------------- RealSense D435i

/**
 * Frame: the origin is the centre of the back face, +Z looks out through the front glass, X runs along the camera
 * (the USB-C port is at +X) and +Y is up (the 1/4-20 thread is in the -Y face).
 */
function depthCameraGeometry(p: CatalogPart): GeomResult {
  const d = p.geom.dims;
  const W = num(d, "w", 90);
  const H = num(d, "h", 25);
  const D = num(d, "d", 25);
  const pitch = num(d, "m3_pitch", 45);
  const base = num(d, "baseline", 50);
  // the case: an extrusion with rounded long edges and rounded ends
  const body: PartRecipe = {
    base: box(W, H, D, [0, 0, 0], 4.5),
    ops: [
      { op: "chamfer", r: 0.8, edges: "top" },
      // the two M3 threads in the back, the 1/4-20 under it, the USB-C opening in the +X end
      ...[-pitch / 2, pitch / 2].map((x) => ({ op: "cut" as const, shape: cyl(2.5, 4, [x, 0, -0.01]) })),
      { op: "cut", shape: cyl(5.4, 6, [0, -H / 2 - 0.01, D / 2], YP) },
      { op: "cut", shape: box(4, 9.4, 3.6, [W / 2 - 3.99, 0, D / 2 - 1.8], 1.2) },
      // a groove round the front where the glass is set in
      { op: "cut", shape: box(W - 4, 0.5, H - 2, [0, H / 2 - 1.1, D - 2.5]), cosmetic: true },
    ],
  };
  // the black front window and the four optics behind it: right imager, projector, left imager, colour camera
  const glass: PartRecipe = only(box(W - 6, H - 5, 0.8, [0, 0, D - 0.79], 2.5));
  const optics: [number, number][] = [[-base / 2 - 7.5, 6.6], [-7.5 + 0.0, 5.2], [base / 2 - 7.5, 6.6], [base / 2 + 7.5 + 7.5, 7.2]];
  const lenses: PartRecipe = only({ t: "union", shapes: optics.map(([x, dd]) => cyl(dd, 0.5, [x, 0, D + 0.01])) });
  const rims: PartRecipe = only({ t: "union", shapes: optics.map(([x, dd]) => ({ t: "tube" as const, od: dd + 1.6, id: dd, h: 0.35, at: [x, 0, D + 0.01] as V3, dir: ZP })) });
  return {
    placement: "axis",
    solids: [
      solid("", p.name, body, p.geom.color ?? "#9fa4ab", "Aluminum 6063", false, "anodized"),
      solid("glass", `${p.name} front window`, glass, p.geom.color2 ?? "#0d0e10", "Glass"),
      solid("lenses", `${p.name} lenses`, lenses, "#16233a", "Glass"),
      solid("rims", `${p.name} lens rims`, rims, "#2b2e33", "Aluminum 6061"),
    ],
    fields: {
      scalars: { w: W, h: H, d: D, m3_pitch: pitch, screw: "M3", screw_depth: 4 },
      points: { at: [0, 0, 0], front: [0, 0, D], usb: [W / 2, 0, D / 2], tripod: [0, -H / 2, D / 2] },
      pointLists: { holes: [[-pitch / 2, 0, 0], [pitch / 2, 0, 0]] },
      dirs: { axis: ZP, up: YP, usb: XP },
    },
  };
}

// ---------------------------------------------------------------- Jetson developer kit

/**
 * Frame: the origin is under the middle of the carrier board, which lies in XY with its top at z = t + feet; the
 * ports face -Y, the 40-pin header runs along the +Y edge.
 */
export function jetsonLayout(p: CatalogPart) {
  const d = p.geom.dims;
  const W = num(d, "w", 100);
  const Dp = num(d, "d", 79);
  const t = num(d, "t", 1.6);
  const feet = 3.2;
  return { W, D: Dp, t, feet, top: feet + t, hx: num(d, "hole_x", 86) / 2, hy: num(d, "hole_y", 58) / 2, holeD: num(d, "hole_d", 2.7) };
}

function jetsonGeometry(p: CatalogPart): GeomResult {
  const J = jetsonLayout(p);
  const { W, D, t, feet, top } = J;
  const holes: V3[] = [[-J.hx, -J.hy + 4, 0], [J.hx, -J.hy + 4, 0], [-J.hx, J.hy + 4, 0], [J.hx, J.hy + 4, 0]];
  const pcb: PartRecipe = {
    base: box(W, D, t, [0, 0, feet], 2.5),
    ops: holes.map((h) => ({ op: "cut" as const, shape: cyl(J.holeD, t + 0.2, [h[0], h[1], feet - 0.1]) })),
  };
  // four nylon standoffs under the holes (the feet the kit stands on)
  const standoffs: PartRecipe = { base: { t: "union", shapes: holes.map((h) => cyl(5, feet, [h[0], h[1], 0])) }, ops: holes.map((h) => ({ op: "cut" as const, shape: cyl(J.holeD, feet + 0.1, [h[0], h[1], -0.05]) })) };
  // the module on its SO-DIMM socket, and the fan heat sink that covers it
  const mx = 0;
  const my = 8;
  const socket: PartRecipe = only(box(72, 8, 4.5, [mx, my - 16, top], 0.5));
  const module: PartRecipe = only(box(69.6, 45, 1.0, [mx, my, top + 4.5]));
  const hsZ = top + 5.5;
  const hsH = 21 - 5.5 - top - 0.6;
  const fins: ShapeRecipe[] = Array.from({ length: 19 }, (_, i) => box(1.0, 45, hsH - 2.5, [mx - 31.5 + i * 3.5, my, hsZ + 2.5]));
  const heatsink: PartRecipe = {
    base: { t: "union", shapes: [box(69.6, 45, 2.5, [mx, my, hsZ], 1), ...fins] },
    ops: [{ op: "cut", shape: cyl(38, hsH, [mx, my, hsZ + 2.5]) }],
  };
  // a 40 mm blower-style fan sunk in the fins: its frame, hub and seven blades
  const fanZ = hsZ + 2.5;
  const fanFrame: PartRecipe = only({ t: "tube", od: 38, id: 35, h: hsH - 2.5, at: [mx, my, fanZ], dir: ZP });
  const blade = (i: number): ShapeRecipe => ({
    t: "xform",
    shape: { t: "prism", pts: [[6, -1.2], [16.8, -3.6], [16.8, 0.2], [6, 1.2]], h: hsH - 4, at: [0, 0, 0.5], dir: ZP, rot: 0 },
    xf: [{ op: "rotate", angle: (360 / 7) * i, origin: [0, 0, 0], axis: ZP }, { op: "translate", v: [mx, my, fanZ] }],
  });
  const fan: PartRecipe = only({ t: "union", shapes: [cyl(13, hsH - 3, [mx, my, fanZ + 0.5]), ...Array.from({ length: 7 }, (_, i) => blade(i))] });
  const hub: PartRecipe = only(cyl(11, 0.4, [mx, my, fanZ + hsH - 2.5]));
  // the ports along -Y: DC jack, DisplayPort, two double USB-A stacks, gigabit Ethernet, USB-C
  const y0 = -D / 2;
  const port = (x: number, w: number, dd: number, h: number) => box(w, dd, h, [x, y0 + dd / 2 - 1.5, top]);
  const dcX = -40;
  const dpX = -26;
  const usbX = [-8.5, 9.5];
  const ethX = 28;
  const ucX = 42;
  const shells: PartRecipe = {
    base: { t: "union", shapes: [port(dpX, 16, 9, 5.8), ...usbX.map((x) => port(x, 14.6, 17, 15.8)), port(ethX, 16.2, 21, 13.6), port(ucX, 9, 7.4, 3.3)] },
    ops: [
      { op: "cut", shape: box(14, 6, 4.2, [dpX, y0 - 1.51 + 2.99, top + 0.8]) },
      ...usbX.flatMap((x) => [2.2, 9.9].map((z) => ({ op: "cut" as const, shape: box(12.6, 10, 5.4, [x, y0 - 1.51 + 4.99, top + z]) }))),
      { op: "cut", shape: box(12, 12, 9, [ethX, y0 - 1.51 + 5.99, top + 1.2]) },
      { op: "cut", shape: box(7.6, 5, 2.2, [ucX, y0 - 1.51 + 2.49, top + 0.55], 1) },
    ],
  };
  const tongues: PartRecipe = only({ t: "union", shapes: usbX.flatMap((x) => [2.2, 9.9].map((z) => box(11.2, 8, 1.6, [x, y0 + 5, top + z + 1.2]))) });
  const dc: PartRecipe = { base: box(9, 12, 11, [dcX, y0 + 6 - 1.5, top], 0.6), ops: [{ op: "cut", shape: cyl(6.4, 10, [dcX, y0 - 1.6, top + 6.2], YP) }] };
  const ethLeds: PartRecipe = only({ t: "union", shapes: [-5, 5].map((dx) => box(2.4, 0.4, 1.6, [ethX + dx, y0 - 1.6, top + 10.8])) });
  // the 40-pin header along +Y, the 12-pin button header beside it and the fan lead's socket
  const hdr: PartRecipe = only({ t: "union", shapes: [box(50.8, 5.08, 2.5, [-8, D / 2 - 4.5, top]), box(15.24, 5.08, 2.5, [32, D / 2 - 4.5, top])] });
  const hdrPins: PartRecipe = only({
    t: "instances",
    items: [{ shape: box(0.64, 0.64, 8.4, [0, 0, top - 2.6]), xfs: [...Array.from({ length: 40 }, (_, i) => [{ op: "translate" as const, v: [-8 - 24.13 + 2.54 * Math.floor(i / 2), D / 2 - 4.5 + (i % 2 ? 1.27 : -1.27), 0] as V3 }]), ...Array.from({ length: 12 }, (_, i) => [{ op: "translate" as const, v: [32 - 6.35 + 2.54 * Math.floor(i / 2), D / 2 - 4.5 + (i % 2 ? 1.27 : -1.27), 0] as V3 }])] }],
  });
  // chips on the carrier: the USB hub, Ethernet PHY, power stage, and two M.2 slots underneath
  const chips: PartRecipe = only({ t: "union", shapes: [box(7, 7, 0.9, [-30, -18, top]), box(6, 6, 0.9, [30, -12, top]), box(5, 5, 1.2, [-38, 10, top]), box(5, 5, 1.2, [-38, 20, top])] });
  const m2: PartRecipe = only({ t: "union", shapes: [box(22, 80 * 0.5, 2.2, [16, 0, feet - 2.2 - 0.01]), box(22, 30, 2.2, [-20, 6, feet - 2.2 - 0.01])] });
  const sd: PartRecipe = only(box(12, 11, 1.4, [mx + 30, my + 18, top + 5.5 - 0.4]));
  return {
    placement: "free",
    solids: [
      solid("", p.name, pcb, p.geom.color ?? "#1a1c20", "FR4"),
      solid("standoffs", `${p.name} standoffs`, standoffs, "#e9e6dc", "PA66"),
      solid("socket", `${p.name} SO-DIMM socket`, socket, "#1b1c1f", "LCP"),
      solid("module", `${p.name} Orin Nano module`, module, "#1f4d2c", "FR4"),
      solid("heatsink", `${p.name} heat sink`, heatsink, "#16171a", "Aluminum 6063", false, "anodized"),
      solid("fan_frame", `${p.name} fan frame`, fanFrame, "#101113", "PBT"),
      solid("fan", `${p.name} fan`, fan, "#18191c", "PBT"),
      solid("fan_hub", `${p.name} fan sticker`, hub, "#76b900", "PVC"),
      solid("ports", `${p.name} port shells`, shells, "#c6cbd2", "Steel"),
      solid("usb_tongues", `${p.name} USB tongues`, tongues, "#1f5fbf", "PBT"),
      solid("dc_jack", `${p.name} DC jack`, dc, "#121315", "PBT"),
      solid("eth_leds", `${p.name} Ethernet LEDs`, ethLeds, "#ffb000", "PC"),
      solid("headers", `${p.name} headers`, hdr, "#131416", "PBT"),
      solid("header_pins", `${p.name} header pins`, hdrPins, "#d4af37", "Brass"),
      solid("chips", `${p.name} chips`, chips, "#1c1c1e", "Epoxy"),
      solid("m2", `${p.name} M.2 slots`, m2, "#202124", "LCP"),
      solid("sd", `${p.name} microSD slot`, sd, "#b9bec5", "Steel"),
    ],
    fields: {
      scalars: { w: W, d: D, t, top, h: 21, screw: "M2.5", hole_d: J.holeD },
      points: { at: [0, 0, 0], dc: [dcX, y0 - 1.5, top + 6.2], usb1: [usbX[0], y0 - 1.5, top + 12.6], usb2: [usbX[0], y0 - 1.5, top + 4.9], usb3: [usbX[1], y0 - 1.5, top + 12.6], usb4: [usbX[1], y0 - 1.5, top + 4.9], fan: [mx, my, 21] },
      pointLists: { holes: holes.map((h) => [h[0], h[1], 0] as V3) },
      dirs: { up: ZP, ports: YN },
    },
  };
}

// ---------------------------------------------------------------- ISO mini relay

/** Frame: the origin is the middle of the terminal face, the blades point -Z, the case stands up +Z; the tab is at +X. */
export const RELAY_BLADES: Record<string, [number, number, "x" | "y"]> = {
  COM_30: [0, -8.6, "y"],
  NO_87: [0, 8.6, "y"],
  COIL_85: [-8.6, 0, "x"],
  COIL_86: [8.6, 0, "x"],
};

function relayGeometry(p: CatalogPart): GeomResult {
  const d = p.geom.dims;
  const w = num(d, "w", 28);
  const dd = num(d, "d", 28);
  const h = num(d, "h", 25);
  const bl = num(d, "blade_l", 9);
  const body: PartRecipe = {
    base: box(w, dd, h, [0, 0, 0], 1.5),
    ops: [
      { op: "add", shape: box(w - 3, dd - 3, 1.2, [0, 0, -1.19], 1) },
      { op: "cut", shape: box(w - 6, 0.4, 0.3, [0, -dd / 2 + 0.1, h - 6]), cosmetic: true },
    ],
  };
  // five 6.3 mm blades: 30 and 87 across, 85 and 86 along, and the second 87 in the middle
  const blade = (x: number, y: number, along: "x" | "y") => (along === "x" ? box(0.8, 6.3, bl, [x, y, -1.2 - bl]) : box(6.3, 0.8, bl, [x, y, -1.2 - bl]));
  const blades: PartRecipe = only({ t: "union", shapes: [...Object.values(RELAY_BLADES).map(([x, y, a]) => blade(x, y, a)), blade(0, 0, "y")] });
  // the steel mounting tab clipped to the +X side, with its M5 hole
  const tab: PartRecipe = { base: { t: "union", shapes: [box(1, 12, h * 0.8, [w / 2 + 0.5, 0, h * 0.1]), box(16, 12, 1, [w / 2 + 8, 0, h * 0.9 - 1])] }, ops: [{ op: "cut", shape: cyl(5.5, 2, [w / 2 + 10, 0, h * 0.9 - 1.5]) }] };
  return {
    placement: "free",
    solids: [solid("", p.name, body, p.geom.color ?? "#16181b", "PA66"), solid("blades", `${p.name} blades`, blades, "#c8ccd1", "Tin-plated brass"), solid("tab", `${p.name} mounting tab`, tab, "#9aa0a8", "Steel")],
    fields: {
      scalars: { w, d: dd, h, blade_l: bl, tab_hole: 5.5 },
      points: { at: [0, 0, 0], tab_hole: [w / 2 + 10, 0, h * 0.9], top: [0, 0, h] },
      dirs: { up: ZP, blades: ZN },
    },
  };
}

// ---------------------------------------------------------------- flanged HTD pulley

/**
 * Frame: the origin is on the axis at the hub's face (the face bolted to the actuator), +Z runs through the hub
 * into the toothed part: hub, flange, teeth, flange.
 */
function htdPulleyGeometry(p: CatalogPart): GeomResult {
  const d = p.geom.dims;
  const pd = num(d, "pd", 47.75);
  const od = num(d, "od", 46.61);
  const w = num(d, "w", 17);
  const fd = num(d, "flange_d", 53);
  const ft = num(d, "flange_t", 1.2);
  const hd = num(d, "hub_d", 40);
  const hl = num(d, "hub_l", 4.5);
  const bore = num(d, "bore", 20);
  const pcd = num(d, "pcd", 36);
  const n = num(d, "holes", 8);
  const hole = num(d, "hole_d", 3.4);
  const teeth = Number(p.specs.teeth ?? 30);
  const z1 = hl;
  const z2 = z1 + ft;
  const z3 = z2 + w;
  const z4 = z3 + ft;
  const pts: V2[] = [
    [bore / 2, 0],
    [hd / 2, 0],
    [hd / 2, z1],
    [fd / 2, z1],
    [fd / 2, z2],
    [od / 2, z2],
    [od / 2, z3],
    [fd / 2, z3],
    [fd / 2, z4],
    [bore / 2, z4],
  ];
  // the tooth gaps: round-bottomed grooves across the face, as the HTD profile cuts them
  const gap = (i: number): ShapeRecipe => ({
    t: "xform",
    shape: cyl(num(d, "gap_d", 3.05), w + 0.02, [od / 2 - 0.2, 0, z2 - 0.01]),
    xf: [{ op: "rotate", angle: (360 / teeth) * i, origin: [0, 0, 0], axis: ZP }],
  });
  const body: PartRecipe = {
    base: { t: "revolve", pts, at: [0, 0, 0], dir: ZP },
    ops: [
      { op: "cut", shape: { t: "union", shapes: Array.from({ length: teeth }, (_, i) => gap(i)) }, cosmetic: true },
      // clearance holes right through, or threads into the hub face (hole_depth)
      ...ring(n, pcd / 2, -0.01, Math.PI / n).map((c) => ({ op: "cut" as const, shape: cyl(hole, num(d, "hole_depth", z4) + 0.02, c) })),
    ],
  };
  return {
    placement: "axis",
    solids: [solid("", p.name, body, p.geom.color ?? "#c8ccd2", "Aluminum 6061", true, "anodized")],
    fields: {
      scalars: { pd, od, width: z4, bore, belt_z: (z2 + z3) / 2, groove_w: w, hub_l: hl, pcd },
      points: { at: [0, 0, 0], belt_center: [0, 0, (z2 + z3) / 2], end: [0, 0, z4] },
      pointLists: { holes: ring(n, pcd / 2, z4, Math.PI / n) },
      dirs: { axis: ZP },
    },
  };
}
