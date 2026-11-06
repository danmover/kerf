// Ready-made building blocks for the joints and details most made parts need:
// hinges, lid lips, vents, cable clips, tube clamps, dovetails, bayonets and
// the hole pattern of a motor or a board. Each one is a feature (use with add):
// it adds and cuts what it needs, sized from a few numbers, so a design says
// what it wants ("a hinge here, five knuckles on a 3 mm pin") instead of
// drawing every cylinder and slot by hand.

import { def } from "./builtins";
import { FeatureV, Obj, Vec, type FeatStep, type Fn, type Value } from "./values";
import type { Args } from "./args";
import { frameAt, vadd, vcross, vdot, vlen, vnorm, vscale, vsub, type Profile, type ShapeRecipe, type V2, type V3 } from "../kernel/recipe";

const Z: V3 = [0, 0, 1];
const X: V3 = [1, 0, 0];
const r2 = (n: number) => Math.round(n * 100) / 100;
const deg = (r: number) => (r * 180) / Math.PI;
const rad = (d: number) => (d * Math.PI) / 180;

/** `along` made square to n; errors when it runs along n. */
function across(a: Args, name: string, along: V3, n: V3): V3 {
  const raw = vsub(along, vscale(n, vdot(along, n)));
  if (vlen(raw) < 1e-6) a.ctx.error(`${a.fname}(): ${name} must not run along the same line as the ${a.fname === "dovetail" ? "face's normal" : "axis"}`);
  return vnorm(raw);
}

/** A profile in the plane square to n, its x along u and its y along n × u, pushed h along n from o. */
const extrude = (p: Profile, o: V3, u: V3, n: V3, h: number): ShapeRecipe => ({ t: "extrude", p, h, f: { o, u, n }, twist: 0, scale: 1 });

const rect = (x0: number, x1: number, y0: number, y1: number, r = 0): Profile => ({ t: "rect", w: x1 - x0, h: y1 - y0, r, c: [(x0 + x1) / 2, (y0 + y1) / 2] });

function intIn(a: Args, name: string, def: number, lo: number, hi: number): number {
  const n = Math.round(a.num(name, def));
  if (n < lo || n > hi) a.ctx.error(`${a.fname}(): ${name} must be ${lo}..${hi}`);
  return n;
}

/** A placed component's point field, such as a motor's face. */
function pointField(o: Obj, name: string): V3 | undefined {
  const v = o.fields[name];
  return v instanceof Vec && v.v.length >= 3 ? [v.x, v.y, v.v[2]] : undefined;
}

export const BLOCK_FNS: Record<string, Fn> = Object.fromEntries([
  def(
    "hinge",
    ["at", "axis", "length", "od", "pin", "knuckles", "gap", "side", "toward", "reach"],
    (a) => {
      const at = a.vec3("at");
      const axis = a.dir("axis", X);
      const L = a.positive("length");
      const pin = a.positive("pin", 3);
      const od = a.positive("od", r2(pin + 4));
      const gap = a.positive("gap", 0.4);
      const k = intIn(a, "knuckles", 5, 2, 15);
      const side = a.oneOf("side", ["outer", "inner"] as const, "outer");
      const toward = across(a, "toward", a.dir("toward", [0, 0, -1]), axis);
      const reach = a.positive("reach", r2(od / 2 + 1));
      const hole = r2(pin + gap);
      if (od - hole < 1.6) a.ctx.error(`hinge(): od ${od} leaves a wall under 0.8 mm round the ${hole} mm pin hole; make od at least ${r2(hole + 1.6)}`);
      const s = (L - (k - 1) * gap) / k;
      if (s < 2) a.ctx.error(`hinge(): ${k} knuckles on ${L} mm leave each one ${r2(s)} mm long; use fewer knuckles or a longer hinge`);
      const start = vsub(at, vscale(axis, L / 2));
      const steps: FeatStep[] = [];
      for (let i = 0; i < k; i++) {
        const o = vadd(start, vscale(axis, i * (s + gap)));
        const mine = (i % 2 === 0) === (side === "outer");
        if (mine) {
          steps.push({ op: "add", shape: { t: "cyl", d: od, h: s, at: o, dir: axis } });
          // the web that joins the knuckle to the leaf, no wider than the knuckle so the other leaf turns past it
          steps.push({ op: "add", shape: extrude(rect(0, reach, -od / 2, od / 2), o, toward, axis, s) });
        } else {
          // room for the other leaf's knuckle to turn in
          steps.push({ op: "cut", shape: { t: "cyl", d: od + 2 * gap, h: s + gap, at: vsub(o, vscale(axis, gap / 2)), dir: axis } });
        }
      }
      steps.push({ op: "cut", shape: { t: "cyl", d: hole, h: L + 1, at: vsub(start, vscale(axis, 0.5)), dir: axis } });
      return new FeatureV("hinge", steps, { pin_d: pin, hole_d: hole, knuckle: r2(s), od, start: new Vec(start), end: new Vec(vadd(start, vscale(axis, L))) });
    },
    'hinge(at, axis: X, length, od: pin + 4, pin: 3, knuckles: 5, gap: 0.4, side: "outer"|"inner", toward: -Z, reach: od/2 + 1) — one leaf of a pin hinge on the axis through `at` (the middle of the hinge): knuckles od across with a pin + gap hole, gap between them, each joined to the part by a web reaching `reach` toward the part (toward: from the axis into the leaf). Give one part side: "outer" (the end knuckles) and the other side: "inner" on the same at and axis: each leaf also cuts room for the other\'s knuckles. The pin is a screw, a dowel (lib.dowel) or 3 mm filament through .start to .end. Fields: pin_d, hole_d, knuckle (length), od, start, end.',
  ),
  def(
    "lid_lip",
    ["w", "d", "r", "t", "h", "gap", "at", "dir", "along"],
    (a) => {
      const w = a.positive("w");
      const d = a.positive("d");
      const r = a.num("r", 0);
      const t = a.positive("t", 1.6);
      const h = a.positive("h", 4);
      const gap = a.num("gap", 0.2);
      if (gap < 0 || gap > 1) a.ctx.error("lid_lip(): gap (a side) must be 0..1 mm; 0.2 suits a printed lid");
      const at = a.vec3("at", [0, 0, 0]);
      const dir = a.dir("dir", [0, 0, -1]);
      const u = across(a, "along", a.dir("along", Math.abs(dir[2]) > 0.9 ? X : Z), dir);
      const ow = w - 2 * gap;
      const odp = d - 2 * gap;
      const ro = Math.max(0, r - gap);
      if (ow - 2 * t < 1 || odp - 2 * t < 1) a.ctx.error("lid_lip(): the opening is too small for this lip wall");
      const p: Profile = { t: "diff2", a: { t: "rect", w: ow, h: odp, r: Math.min(ro, ow / 2 - 0.01, odp / 2 - 0.01), c: [0, 0] }, b: [{ t: "rect", w: ow - 2 * t, h: odp - 2 * t, r: Math.max(0, Math.min(ro - t, (ow - 2 * t) / 2 - 0.01, (odp - 2 * t) / 2 - 0.01)), c: [0, 0] }] };
      // starts a little inside the lid so the two fuse
      const shape = extrude(p, vsub(at, vscale(dir, 0.05)), u, dir, h + 0.05);
      return new FeatureV("lid_lip", [{ op: "add", shape }], { outer_w: r2(ow), outer_d: r2(odp), gap, tip: new Vec(vadd(at, vscale(dir, h))) });
    },
    'lid_lip(w, d, r: 0, t: 1.6, h: 4, gap: 0.2, at:, dir: -Z, along: X) — the lip under a lid that locates it in a box: a ring t thick and h tall standing from `at` (the middle of the lid\'s underside) along dir, sized to slide into an opening w × d with corner radius r (the box\'s inside size) with gap a side. Give the box\'s inside numbers, not the lip\'s. Fields: outer_w, outer_d, gap, tip.',
  ),
  def(
    "vents",
    ["at", "facing", "size", "slot", "pitch", "depth", "along", "style"],
    (a) => {
      const at = a.vec3("at");
      const n = a.dir("facing", Z);
      const sz = a.value("size");
      const [w, h] = typeof sz === "number" ? [sz, sz] : sz instanceof Vec ? [sz.x, sz.y] : a.ctx.error("vents(): size should be (across, along), the area to fill");
      if (!(w > 0 && h > 0)) a.ctx.error("vents(): size must be greater than 0");
      const slot = a.positive("slot", 2);
      const pitch = a.positive("pitch", r2(slot * 2));
      if (pitch <= slot + 0.4) a.ctx.error(`vents(): pitch ${pitch} leaves bars under 0.4 mm between ${slot} mm openings`);
      const depth = a.positive("depth", 3);
      const style = a.oneOf("style", ["slots", "holes"] as const, "slots");
      const along = across(a, "along", a.dir("along", Math.abs(n[2]) > 0.9 ? [0, 1, 0] : Z), n);
      const u = vcross(along, n);
      const nx = Math.floor((w - slot) / pitch + 1e-9) + 1;
      const ny = style === "holes" ? Math.floor((h - slot) / pitch + 1e-9) + 1 : 1;
      if (w < slot || (style === "holes" ? h < slot : h < slot * 1.5)) a.ctx.error("vents(): the area is smaller than one opening");
      if (nx * ny > 400) a.ctx.error(`vents(): ${nx * ny} openings is too many; use a bigger pitch or a smaller area (at most 400)`);
      const ps: Profile[] = [];
      for (let i = 0; i < nx; i++)
        for (let j = 0; j < ny; j++) {
          const c: V2 = [(i - (nx - 1) / 2) * pitch, style === "holes" ? (j - (ny - 1) / 2) * pitch : 0];
          ps.push(style === "holes" ? { t: "circle", d: slot, c } : { t: "rect", w: slot, h, r: slot / 2 - 0.01, c });
        }
      const area = style === "holes" ? nx * ny * Math.PI * (slot / 2) ** 2 : nx * (slot * (h - slot) + Math.PI * (slot / 2) ** 2);
      const shape = extrude({ t: "union2", ps }, vsub(at, vscale(n, depth)), u, n, depth + 0.1);
      return new FeatureV("vents", [{ op: "cut", shape }], { count: nx * ny, open_area: r2(area) });
    },
    'vents(at, facing: Z, size: (across, along), slot: 2, pitch: 2 × slot, depth: 3, along:, style: "slots"|"holes") — cuts a row of rounded slots running along `along` (default Y on a top or bottom face, Z on a side wall), or a grid of round holes, filling size on the face at `at` whose outside faces `facing`, depth deep (the wall thickness, or more to cut through). Keep slot under 2 mm where fingers or parts must not get in. Fields: count, open_area (mm²).',
  ),
  def(
    "cable_clip",
    ["at", "d", "t", "w", "along", "dir", "mouth"],
    (a) => {
      const at = a.vec3("at");
      const d = a.positive("d");
      const t = a.positive("t", 1.6);
      const w = a.positive("w", 8);
      const dir = a.dir("dir", Z);
      const along = across(a, "along", a.dir("along", Math.abs(dir[0]) > 0.9 ? [0, 1, 0] : X), dir);
      const mouth = a.positive("mouth", r2(0.75 * d));
      if (mouth >= d) a.ctx.error(`cable_clip(): mouth ${mouth} must be narrower than the cable (${d}) or it will not hold`);
      if (mouth < 0.3 * d) a.ctx.error("cable_clip(): mouth under a third of the cable is too tight to push it in");
      const u = vcross(dir, along);
      const od = d + 2 * t;
      const c = vadd(at, vscale(dir, t + d / 2));
      const o = vsub(at, vscale(along, w / 2));
      const steps: FeatStep[] = [
        { op: "add", shape: { t: "cyl", d: od, h: w, at: vsub(c, vscale(along, w / 2)), dir: along } },
        { op: "add", shape: extrude(rect(-od / 2, od / 2, -0.05, t + d / 2), o, u, along, w) },
        { op: "cut", shape: { t: "cyl", d, h: w + 1, at: vsub(c, vscale(along, w / 2 + 0.5)), dir: along } },
        { op: "cut", shape: extrude(rect(-mouth / 2, mouth / 2, t + d / 2, 2 * t + d + 1), vsub(o, vscale(along, 0.5)), u, along, w + 1) },
      ];
      // each arm opens by half the difference as the cable goes in: a curved cantilever about a quarter turn long
      const arm = (Math.PI * (d / 2 + t / 2)) / 2;
      const strain = (1.5 * t * ((d - mouth) / 2)) / (arm * arm);
      return new FeatureV("cable_clip", steps, { mouth, strain, centre: new Vec(c) }, strain);
    },
    "cable_clip(at, d, t: 1.6, w: 8, along: X, dir: Z, mouth: 0.75 d) — a C-shaped clip standing on the face at `at` (dir points off the face) that a cable or tube of diameter d along `along` is pushed into through a mouth narrower than it. Its arms' bending strain is checked against the part's material. Fields: mouth, strain, centre (the cable's axis point).",
  ),
  def(
    "tube_clamp",
    ["at", "d", "t", "w", "axis", "ears", "screw", "gap", "ear_t"],
    (a) => {
      const at = a.vec3("at");
      const d = a.positive("d");
      const t = a.positive("t", 3);
      const w = a.positive("w", 10);
      const axis = a.dir("axis", Z);
      const u = across(a, "ears", a.dir("ears", Math.abs(axis[0]) > 0.9 ? [0, 1, 0] : X), axis);
      const screw = a.thread("screw", "M4");
      const gap = a.positive("gap", 1.5);
      const et = a.positive("ear_t", r2(Math.max(3, t)));
      if (w < screw.head_d) a.ctx.error(`tube_clamp(): w ${w} is narrower than the ${screw.name} screw's head (${screw.head_d} mm)`);
      const v = vcross(axis, u);
      const R = d / 2 + t;
      const earL = r2(screw.head_d + 2);
      const sx = R + earL / 2;
      const o = vsub(at, vscale(axis, w / 2));
      const o1 = vsub(at, vscale(axis, w / 2 + 0.5));
      const span = 2 * et + gap;
      const steps: FeatStep[] = [
        { op: "add", shape: { t: "cyl", d: 2 * R, h: w, at: o, dir: axis } },
        { op: "add", shape: extrude(rect(d / 2 + t / 2, R + earL, -span / 2, span / 2), o, u, axis, w) },
        { op: "cut", shape: { t: "cyl", d, h: w + 1, at: o1, dir: axis } },
        { op: "cut", shape: extrude(rect(d / 2 - 0.5, R + earL + 1, -gap / 2, gap / 2), o1, u, axis, w + 1) },
        { op: "cut", shape: { t: "cyl", d: screw.clearance, h: span + 1, at: vadd(at, vadd(vscale(u, sx), vscale(v, -span / 2 - 0.5))), dir: v } },
      ];
      return new FeatureV("tube_clamp", steps, {
        screw_at: new Vec(vadd(at, vadd(vscale(u, sx), vscale(v, -span / 2)))),
        screw_dir: new Vec(v),
        screw_len: r2(span + screw.nut_h + 1),
        span: r2(span),
      });
    },
    'tube_clamp(at, d, t: 3, w: 10, axis: Z, ears: X, screw: M4, gap: 1.5, ear_t:) — a split ring that clamps a tube or rod of diameter d running along axis through `at` (the middle of the clamp), with two ears sticking out along `ears` and a clearance hole for a screw and nut across them that squeezes the split shut. Fields: screw_at (the screw head\'s side), screw_dir, screw_len (a screw that reaches through with its nut), span (across both ears).',
  ),
  def(
    "dovetail",
    ["at", "along", "length", "w", "h", "angle", "gap", "side", "up"],
    (a) => {
      const at = a.vec3("at");
      const up = a.dir("up", Z);
      const along = across(a, "along", a.dir("along", Math.abs(up[0]) > 0.9 ? [0, 1, 0] : X), up);
      const L = a.positive("length");
      const w = a.positive("w", 8);
      const h = a.positive("h", 4);
      const angle = a.num("angle", 60);
      if (angle < 45 || angle > 80) a.ctx.error("dovetail(): angle (each flank from the face) must be 45..80 degrees; 60 is usual");
      const gap = a.num("gap", 0.15);
      if (gap < 0 || gap > 1) a.ctx.error("dovetail(): gap (a side) must be 0..1 mm");
      const side = a.oneOf("side", ["tail", "socket"] as const, "tail");
      const k = h / Math.tan(rad(angle));
      const u = vcross(up, along);
      const tail: Profile = {
        t: "poly",
        pts: [
          [-w / 2, -0.05],
          [w / 2, -0.05],
          [w / 2 + k, h],
          [-w / 2 - k, h],
        ],
        r: 0,
      };
      const ext = side === "socket" ? 0.5 : 0;
      const p: Profile = side === "socket" && gap > 0 ? { t: "offset", p: tail, d: gap } : tail;
      const shape = extrude(p, vsub(at, vscale(along, L / 2 + ext)), u, along, L + 2 * ext);
      return new FeatureV("dovetail", [{ op: side === "tail" ? "add" : "cut", shape }], { top_w: r2(w + 2 * k), w, h });
    },
    'dovetail(at, along: X, length, w: 8, h: 4, angle: 60, gap: 0.15, side: "tail"|"socket", up: Z) — a sliding dovetail joint `length` long along `along`, centred on `at` on the face whose normal is up: side: "tail" adds the tail (w wide at the face, widening to .top_w at h); side: "socket" with the same numbers cuts the matching groove in the mating part, gap larger all round and a little longer so it runs through. Put both on the same at, up and along, with the mating part lying over the face. Fields: top_w, w, h.',
  ),
  def(
    "bayonet",
    ["at", "d", "dir", "lugs", "lug_w", "lug_h", "lug_t", "turn", "depth", "gap", "side", "start"],
    (a) => {
      const at = a.vec3("at");
      const d = a.positive("d");
      const dir = a.dir("dir", [0, 0, -1]);
      const lugs = intIn(a, "lugs", 3, 2, 8);
      const lw = a.positive("lug_w", r2(Math.max(3, (Math.PI * d) / (lugs * 4))));
      const lh = a.positive("lug_h", 3);
      const lt = a.positive("lug_t", 1.5);
      const turn = a.positive("turn", 30);
      const gap = a.num("gap", 0.3);
      if (gap < 0 || gap > 1) a.ctx.error("bayonet(): gap must be 0..1 mm");
      const depth = a.positive("depth", r2(lh / 2 + 1.5));
      if (depth < lh / 2 + gap) a.ctx.error(`bayonet(): depth (the rim to the lugs' middle) must be at least ${r2(lh / 2 + gap)}`);
      const side = a.oneOf("side", ["lugs", "slots"] as const, "lugs");
      const start = a.num("start", 0);
      const rIn = d / 2 - 0.5;
      const rOut = Math.hypot(d / 2 + lt, lw / 2) + gap;
      // the slot's half width as an angle on the bore
      const half = deg(Math.atan((lw / 2 + gap) / (d / 2)));
      if (turn + 2 * half > 360 / lugs - 5) a.ctx.error(`bayonet(): ${lugs} lugs ${lw} mm wide leave room to turn at most ${Math.floor(360 / lugs - 5 - 2 * half)} degrees`);
      const steps: FeatStep[] = [];
      for (let i = 0; i < lugs; i++) {
        const ang = start + (i * 360) / lugs;
        if (side === "lugs") {
          // drawn turned home, where they sit once the two are locked together
          const f = frameAt(vadd(at, vscale(dir, depth - lh / 2)), dir, ang + turn);
          steps.push({ op: "add", shape: extrude(rect(rIn, d / 2 + lt, -lw / 2, lw / 2), f.o, f.u, dir, lh) });
        } else {
          const f = frameAt(vsub(at, vscale(dir, 0.5)), dir, ang);
          steps.push({ op: "cut", shape: extrude(rect(rIn, rOut, -lw / 2 - gap, lw / 2 + gap), f.o, f.u, dir, depth + lh / 2 + gap + 0.5) });
          const g = frameAt(at, dir, ang - half);
          steps.push({ op: "cut", shape: { t: "revolve2", p: rect(rIn, rOut, depth - lh / 2 - gap, depth + lh / 2 + gap), f: { o: at, u: g.u, n: dir }, angle: turn + 2 * half } });
        }
      }
      return new FeatureV("bayonet", steps, { turn, depth, lug_w: lw, lug_h: lh, lug_t: lt });
    },
    'bayonet(at, d, dir: -Z, lugs: 3, lug_w:, lug_h: 3, lug_t: 1.5, turn: 30, depth:, gap: 0.3, side: "lugs"|"slots", start: 0) — a push-and-turn lock between a part whose outside is d across (side: "lugs": lugs standing lug_t out of it) and one with a bore of d (side: "slots": an entry slot from the rim and a turn of `turn` degrees at the bottom). `at` is the axis point at the bore\'s rim and dir the way the inner part goes in; the lugs\' middle sits depth past the rim. Give both parts the same at, d, dir and numbers: the lugs are drawn turned home, so a closed assembly shows them locked. Make the bore d + 2 × gap across. Fields: turn, depth, lug_w, lug_h, lug_t.',
  ),
  def(
    "mount_holes",
    ["for", "depth", "fit", "screw", "dir", "pilot"],
    (a) => {
      const c = a.raw("for");
      if (!(c instanceof Obj) || !Array.isArray(c.fields.holes)) a.ctx.error("mount_holes(): for: should be a placed component with mounting holes, such as a NEMA 17 motor or a circuit board (lib.nema17, lib.pcb)");
      const comp = c as Obj;
      const holes = (comp.fields.holes as Value[]).filter((p): p is Vec => p instanceof Vec).map((p): V3 => [p.x, p.y, p.v[2] ?? 0]);
      if (!holes.length) a.ctx.error("mount_holes(): this component lists no mounting holes");
      const ax = comp.fields.axis instanceof Vec ? vnorm([comp.fields.axis.x, comp.fields.axis.y, comp.fields.axis.v[2] ?? 0]) : undefined;
      const top = pointField(comp, "top");
      const bottom = pointField(comp, "bottom");
      // into the part it mounts on: in front of a motor's face, under a board
      const dir = a.has("dir") ? a.dir("dir") : ax ?? (top && bottom ? vnorm(vsub(bottom, top)) : a.ctx.error("mount_holes(): give dir:, the way the holes go into the part"));
      const depth = a.positive("depth", 6);
      const screw = a.thread("screw", "M3");
      const fit = a.oneOf("fit", ["clearance", "close", "tap", "insert"] as const, "clearance");
      if (fit === "insert" && !screw.insert_d) a.ctx.error(`mount_holes(): there is no common heat-set insert for ${screw.name}`);
      const hd = fit === "clearance" ? screw.clearance : fit === "close" ? screw.close : fit === "tap" ? screw.tap : screw.insert_d;
      const steps: FeatStep[] = holes.map((p) => ({ op: "cut", shape: { t: "cyl", d: hd, h: depth + 0.1, at: vsub(p, vscale(dir, 0.05)), dir } }));
      const pilotD = typeof comp.fields.pilot_d === "number" ? comp.fields.pilot_d : 0;
      const face = pointField(comp, "face");
      if (a.bool("pilot", pilotD > 0)) {
        if (!pilotD || !face) a.ctx.error("mount_holes(): this component has no pilot boss to clear");
        steps.push({ op: "cut", shape: { t: "cyl", d: pilotD + 0.6, h: depth + 0.1, at: vsub(face!, vscale(dir, 0.05)), dir } });
      }
      return new FeatureV("mount_holes", steps, { hole_d: hd, count: holes.length });
    },
    'mount_holes(for, depth: 6, fit: "clearance"|"close"|"tap"|"insert", screw: M3, dir:, pilot:) — cuts the mounting-hole pattern of a placed component (for: a lib.nema17 motor or a lib.pcb board) into the part it mounts on, depth deep: screw holes at each of its holes and, for a motor, a hole clearing its pilot boss and shaft. dir defaults to the way into the part: along a motor\'s shaft, down under a board. Fields: hole_d, count.',
  ),
]);
