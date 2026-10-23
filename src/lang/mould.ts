// mould(): one half of a two-part mould round another part of the design,
// for casting (resin, silicone, plaster, wax, concrete, metal) or as the
// core and cavity of a simple injection tool. The kernel builds it from the
// part as it is now, so the mould follows every change to the part.

import { def } from "./builtins";
import { Obj, Ref, ShapeV, typeName } from "./values";

/** How much a material shrinks as it sets or cools (linear fraction), for the cavity's oversize. */
const SHRINK: [RegExp, number][] = [
  [/^PP\b|polyprop/i, 0.015],
  [/^POM\b|acetal/i, 0.02],
  [/nylon|^PA\b/i, 0.012],
  [/^ABS\b|^ASA\b/i, 0.006],
  [/^PC\b|polycarb/i, 0.006],
  [/PETG/i, 0.004],
  [/PLA/i, 0.003],
  [/acrylic|PMMA/i, 0.004],
  [/TPU/i, 0.01],
  [/polyurethane|resin/i, 0.002],
  [/silicone|rubber|EPDM|nitrile|neoprene/i, 0.002],
  [/A380|zamak|zinc/i, 0.006],
  [/A356|AlSi/i, 0.012],
  [/alumin/i, 0.01],
  [/cast iron/i, 0.01],
  [/bronze|brass|copper/i, 0.015],
  [/steel|stainless/i, 0.02],
];

export function shrinkFor(material: string): number {
  return SHRINK.find(([re]) => re.test(material))?.[1] ?? 0;
}

export const MOULD_FNS = Object.fromEntries([
  def(
    "mould",
    ["part", "half", "pull", "split", "wall", "shrink", "keys", "sprue", "vents", "bolts"],
    (a) => {
      const v = a.value("part");
      const name = v instanceof Ref && v.what === "part" ? v.name : v instanceof Obj && v.kind === "part" ? String(v.fields.name) : null;
      if (!name) return a.ctx.error(`mould(): part should be the name of a part defined above, got ${v === undefined ? "nothing" : typeName(v)}`);
      const src = a.ctx.partShape?.(name);
      if (!src) return a.ctx.error(`mould(): "${name}" must be a custom part defined above the mould`);
      const halfName = a.str("half", "top").toLowerCase();
      const half = halfName === "top" || halfName === "cavity" ? "top" : halfName === "bottom" || halfName === "core" ? "bottom" : a.ctx.error('mould(): half should be "top" or "bottom" (the halves above and below the split)');
      const wall = a.positive("wall", 10);
      const shrink = a.has("shrink") ? a.num("shrink") : shrinkFor(src.material);
      if (shrink < 0 || shrink > 0.05) a.ctx.error(`mould(): shrink ${shrink} is a fraction of the size: 0.5% (or 0.005) for ABS, 0 for none`);
      const keys = Math.round(a.num("keys", 4));
      if (![0, 2, 4].includes(keys)) a.ctx.error("mould(): keys should be 0, 2 or 4 (registration bumps at the corners)");
      const sprue = a.num("sprue", 6);
      if (sprue < 0) a.ctx.error("mould(): sprue is the pour hole's diameter in mm (0 for none)");
      const vents = Math.round(a.num("vents", 2));
      if (vents < 0 || vents > 4) a.ctx.error("mould(): vents should be 0 to 4");
      const bv = a.value("bolts");
      const bolt = bv === undefined || bv === false ? 0 : bv instanceof Obj && bv.kind === "thread" && typeof bv.fields.clearance === "number" ? bv.fields.clearance : typeof bv === "number" ? bv : a.ctx.error("mould(): bolts should be a screw size like M4, or a hole diameter in mm");
      if (bolt > 0 && wall < bolt + 4) a.ctx.error(`mould(): bolt holes of ${bolt} mm need a wall of at least ${bolt + 4} mm round the part`);
      return new ShapeV({
        t: "mould",
        part: src.recipe,
        xf: src.xf,
        half,
        pull: a.dir("pull", [0, 0, 1]),
        split: a.has("split") ? a.num("split") : null,
        wall,
        shrink,
        keys,
        sprue,
        vents,
        bolt,
      });
    },
    'mould(part, half: "top", pull: Z, split: (auto), wall: 10, shrink: (the part\'s material), keys: 4, sprue: 6, vents: 2, bolts: none) — one half of a two-part mould round a part defined above, where that part sits: a block wall mm bigger all round, split across the pull. split is the height along the pull where the halves part (left out: the lowest height where the part is widest, so a lid splits at its rim and a ball at its middle). The cavity is enlarged by shrink (a fraction; the material\'s usual value by default: 0.6% ABS, 1.5% PP, 0.2% casting resin). keys puts registration bumps on the bottom half and matching sockets in the top; bolts: M4 adds clamping bolt holes through both halves; sprue is the pour hole into the part\'s highest point and vents the air vents from its other high points (both in the top half). Make each half its own part: part mould_top { body mould(knob, half: "top") } and part mould_bottom { body mould(knob, half: "bottom") }, then move them with at: to see them beside the part. The part itself must release along the pull: no undercuts.',
  ),
]);
