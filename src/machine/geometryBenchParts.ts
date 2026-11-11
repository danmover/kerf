// Shapes of two bought parts that sit beside or on a bench machine and are
// drawn as the things they are, not as plain boxes: a desktop power supply
// (the sealed brick with a mains inlet in one end and its DC lead leaving the
// other) and a USB endoscope camera (a slim metal head on a lead).

import type { PartRecipe, ShapeRecipe, V3 } from "../kernel/recipe";
import type { CompSolid } from "../library/components";
import type { CatalogPart } from "./types";
import type { GeomResult } from "./geometry";

const Z0: V3 = [0, 0, 0];
const ZP: V3 = [0, 0, 1];
const ZN: V3 = [0, 0, -1];
const XP: V3 = [1, 0, 0];
const XN: V3 = [-1, 0, 0];
const num = (d: Record<string, number>, k: string, def: number) => (typeof d[k] === "number" ? d[k] : def);
const box = (w: number, d: number, h: number, at: V3, r = 0): ShapeRecipe => ({ t: "box", w, d, h, at, r });
const cyl = (d: number, h: number, at: V3, dir: V3): ShapeRecipe => ({ t: "cyl", d, h, at, dir });
const one = (shape: ShapeRecipe): PartRecipe => ({ base: shape, ops: [] });
const solid = (suffix: string, label: string, recipe: PartRecipe, color: string, material: string): CompSolid => ({ suffix, label, recipe, color, material });

/**
 * desk_supply: a desktop switch-mode supply lying flat. `at` is the centre of
 * its bottom face, the DC lead leaves the +X end and the mains inlet is in the
 * -X end. dims: w (X), d (Y), h (Z) of the case; inlet 14 for an IEC C14
 * (three-pin "kettle" inlet, the default) or 8 for a C8 (figure-8); cord_d and
 * cord_l the DC lead and how much of it is drawn; foot_h the stick-on feet
 * (inside h); plug_d and plug_l the barrel plug drawn on the end of the lead
 * (plug_l 0: the lead is cut and wired in, no plug).
 */
export function deskSupplyGeometry(p: CatalogPart): GeomResult {
  const g = p.geom;
  const d = g.dims;
  const w = num(d, "w", 170);
  const dd = num(d, "d", 65);
  const h = num(d, "h", 40);
  const inlet = num(d, "inlet", 14);
  const cordD = num(d, "cord_d", 5.5);
  const cordL = num(d, "cord_l", 60);
  const footH = Math.min(num(d, "foot_h", 1), h / 10);
  const plugD = num(d, "plug_d", 5.5);
  const plugL = num(d, "plug_l", 0);
  const dark = g.color ?? "#16181c";
  const zc = footH + (h - footH) / 2;
  const r = Math.min(6, dd / 8, (h - footH) / 4);

  // the mains inlet's recess in the -X end: a C14 is 24 × 16.5 mm with its two corners on the earth pin's side
  // cut off, a C8 a 16 × 8.5 slot with round ends
  const c14 = inlet !== 8;
  const iw = c14 ? 24 : 16;
  const ih = c14 ? 16.5 : 8.5;
  const depth = c14 ? 16 : 13;
  const cut = 4;
  const recess: ShapeRecipe = c14
    ? {
        t: "extrude",
        p: { t: "poly", pts: [[-iw / 2, -ih / 2], [iw / 2, -ih / 2], [iw / 2, ih / 2 - cut], [iw / 2 - cut, ih / 2], [-iw / 2 + cut, ih / 2], [-iw / 2, ih / 2 - cut]], r: 0 },
        h: depth,
        f: { o: [-w / 2 - 0.01, 0, zc], u: [0, 1, 0], n: XP },
        twist: 0,
        scale: 1,
      }
    : {
        t: "union",
        shapes: [box(depth, iw - ih, ih, [-w / 2 + depth / 2 - 0.01, 0, zc - ih / 2]), cyl(ih, depth, [-w / 2 - 0.01, (iw - ih) / 2, zc], XP), cyl(ih, depth, [-w / 2 - 0.01, -(iw - ih) / 2, zc], XP)],
      };
  const lw = Math.min(w * 0.5, 80);
  const ld = Math.min(dd * 0.6, 44);
  const body: PartRecipe = {
    base: box(w, dd, h - footH, [0, 0, footH], r),
    ops: [
      { op: "cut", shape: recess },
      // the two halves of the case meet in a seam round its middle
      ...[1, -1].map((sy) => ({ op: "cut" as const, shape: box(w - 2 * r, 0.4, 0.5, [0, (sy * dd) / 2, zc - 0.25]), cosmetic: true })),
      // the rating label's shallow recess underneath
      { op: "cut", shape: box(lw + 1, ld + 1, 0.3, [0, 0, footH - 0.01], 1), cosmetic: true },
    ],
  };
  // the inlet's pins: earth above (a C14), live and neutral side by side
  const pinL = depth - 4;
  const pin = (y: number, z: number, tall: boolean): ShapeRecipe => box(pinL, tall ? 2 : 4, tall ? 4 : 2, [-w / 2 + depth - pinL / 2, y, z - (tall ? 2 : 1)]);
  const pins: ShapeRecipe[] = c14 ? [pin(-7, zc - 2, true), pin(7, zc - 2, true), pin(0, zc + 3.5, true)] : [cyl(2.4, pinL, [-w / 2 + depth, -4.3, zc], XN), cyl(2.4, pinL, [-w / 2 + depth, 4.3, zc], XN)];

  const boot = Math.min(22, cordL * 0.4);
  const cord: PartRecipe = {
    base: cyl(cordD, cordL, [w / 2 - 1, 0, zc], XP),
    ops: [
      { op: "add", shape: { t: "cone", d1: cordD + 6, d2: cordD + 1.2, h: boot, at: [w / 2 - 1, 0, zc], dir: XP } },
      ...Array.from({ length: 4 }, (_, i) => ({ op: "cut" as const, shape: { t: "tube" as const, od: cordD + 8, id: cordD + 4.4 - i * 0.9, h: 1.1, at: [w / 2 + 4 + i * 3.6, 0, zc] as V3, dir: XP }, cosmetic: true })),
    ],
  };
  const solids: CompSolid[] = [
    solid("", p.name, body, dark, "PC"),
    solid("inlet", `${p.name} mains inlet pins`, one(pins.length === 1 ? pins[0] : { t: "union", shapes: pins }), "#c9b458", "Brass"),
    solid("cord", `${p.name} DC lead`, cord, "#121316", "PVC"),
    solid("label", `${p.name} rating label`, one(box(lw, ld, 0.25, [0, 0, footH + 0.02], 1)), "#d9dbd6", "PET"),
    solid("led", `${p.name} power light`, one(cyl(3, 0.6, [w / 2 - 14, 0, h - 0.3], ZP)), "#3fd46b", "PC"),
  ];
  if (footH > 0) {
    const fx = w / 2 - 12;
    const fy = dd / 2 - 10;
    solids.push(solid("feet", `${p.name} feet`, one({ t: "union", shapes: [[fx, fy], [-fx, fy], [fx, -fy], [-fx, -fy]].map(([x, y]) => cyl(9, footH + 0.2, [x, y, 0], ZP)) }), "#2a2c30", "Rubber"));
  }
  const cordEnd: V3 = [w / 2 - 1 + cordL, 0, zc];
  if (plugL > 0) {
    const grip = plugL * 1.8;
    solids.push(
      solid("plug", `${p.name} DC plug`, { base: cyl(plugD + 4.5, grip, cordEnd, XP), ops: [{ op: "add", shape: { t: "cone", d1: plugD + 2.2, d2: plugD + 4.5, h: 6, at: [cordEnd[0] - 6, 0, zc], dir: XP } }] }, "#121316", "PVC"),
      solid("barrel", `${p.name} DC plug barrel`, one({ t: "tube", od: plugD, id: num(d, "plug_id", 2.1), h: plugL, at: [cordEnd[0] + grip - 0.01, 0, zc], dir: XP }), "#c4c9d0", "Brass"),
    );
  }
  return {
    placement: "free",
    solids,
    fields: {
      scalars: { w, d: dd, h },
      points: { top: [0, 0, h], bottom: Z0, cord_end: plugL > 0 ? [cordEnd[0] + plugL * 2.8, 0, zc] : cordEnd, inlet: [-w / 2, 0, zc] },
      dirs: { cord: XP, inlet: XN },
    },
  };
}

/**
 * endoscope: the head of a USB endoscope camera. `at` is the lead end of the
 * head and `axis` points out through the lens. dims: d and h of the head; lens_d
 * the glass in the middle of its front; cable_d and cable_l the lead and how
 * much of it is drawn behind the head; boot_l the strain relief between them.
 */
export function endoscopeGeometry(p: CatalogPart): GeomResult {
  const g = p.geom;
  const d = g.dims;
  const dd = num(d, "d", 8);
  const h = num(d, "h", 40);
  const lensD = Math.min(num(d, "lens_d", 3.2), dd - 3);
  const cableD = Math.min(num(d, "cable_d", 5), dd);
  const cableL = num(d, "cable_l", 30);
  const bootL = Math.min(num(d, "boot_l", 8), cableL);
  // the head: a plain tube with a groove behind the front cap, and the pocket the lens and its lights sit in
  const head: PartRecipe = {
    base: cyl(dd, h, Z0, ZP),
    ops: [
      { op: "cut", shape: cyl(dd - 1.4, 0.5, [0, 0, h - 0.49], ZP) },
      { op: "cut", shape: { t: "tube", od: dd + 1, id: dd - 0.5, h: 0.4, at: [0, 0, h - 5], dir: ZP }, cosmetic: true },
    ],
  };
  const solids: CompSolid[] = [
    solid("", p.name, head, g.color ?? "#1b1c1f", g.material ?? "Aluminum 6061"),
    // the lights shine through a clear ring round the lens
    solid("lights", `${p.name} light ring`, one({ t: "tube", od: dd - 1.5, id: lensD + 0.8, h: 0.45, at: [0, 0, h - 0.5], dir: ZP }), "#e9edf0", "PC"),
    solid("lens", `${p.name} lens`, one(cyl(lensD + 0.7, 0.48, [0, 0, h - 0.5], ZP)), "#0c1016", "Glass"),
  ];
  if (cableL > 0)
    solids.push(solid("lead", `${p.name} lead`, { base: cyl(cableD, cableL, Z0, ZN), ops: bootL > 0 ? [{ op: "add", shape: { t: "cone", d1: Math.min(dd - 0.6, cableD + 2), d2: cableD + 0.2, h: bootL, at: Z0, dir: ZN } }] : [] }, g.color2 ?? "#121316", "PVC"));
  return {
    placement: "axis",
    solids,
    fields: {
      scalars: { d: dd, h, length: h },
      points: { at: Z0, end: [0, 0, h], lens: [0, 0, h], body_end: [0, 0, h], center: [0, 0, h / 2], lead: [0, 0, -cableL] },
      dirs: { axis: ZP },
    },
  };
}
