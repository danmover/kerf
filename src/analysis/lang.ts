// The `analysis` block of the design language: the functions that are only
// callable inside it (face, zone, force, pressure, torque, roller, mass, spin,
// band, wind, pull, contact) and the step that turns its properties into an AnalysisSpec.
//
//   analysis "Shelf load" {
//     parts: [bracket]
//     fix: face(bracket, -Y)
//     load: force(face(bracket, +X), (0, 0, -40N))
//     gravity
//     safety: 2
//   }
//
//   analysis "Frame shake" {
//     parts: [frame]
//     fix: face(frame, -Z)
//     carries: mass(face(frame, +Z), 350g)
//     excite: [spin(1500rpm, name: "fan"), band(20Hz, 60Hz)]
//   }
//
//   analysis "Table drop" {
//     parts: [case, lid]
//     drop: 0.8m
//     onto: "wood"
//   }
//
//   analysis "Motor mount heat" {
//     parts: [mount, motor]
//     heat: [source(motor, 12W)]
//     cooling: "still air"
//     fix: face(mount, -Z)
//   }
//
//   analysis "Crank arm fatigue" {
//     parts: [crank]
//     fix: zone(at: (0, 0, 0), d: 12, axis: Y, length: 10)
//     load: force(face(crank, +X), (0, 0, -900N))
//     cycles: 1e7
//     loading: "on-off"
//   }
//
//   analysis "Gearbox duty" {
//     drive: motor_gear
//     torque: 0.3Nm
//     speed: 3000rpm
//     life: 2000h
//   }

import { Args } from "../lang/args";
import { Fn, Obj, Ref, Vec, typeName, type Value } from "../lang/values";
import type { Span } from "../lang/ast";
import type { AnalysisSpec, BucklingSpec, CurrentSpec, DropSpec, Excitation, FatigueSpec, FilmSpec, FixedTempSpec, HeatLoadSpec, LoadSpec, MassSpec, ModalSpec, PliesSpec, PreloadSpec, RandomSpec, RegionSpec, Resolution, SineSpec, SupportSpec, ThermalSpec, TopologySpec, TouchingSpec, TouchSpec, V3, Within } from "./spec";
import { PLIES_KIND, describeRegion } from "./spec";
import { grms, PSD_PRESETS } from "./fe/vibration";
import { layupText, parseLayup, plyMaterial, PLY_MATERIALS } from "./fe/laminate";
import { FINISHES, MEAN_STRESS, mergeCycles, rainflow, type Finish, type LoadCycle, type MeanStress } from "./fe/fatigue";
import { MECH, mechMaterial } from "./materials";
import { FLOORS, MIN_ELEMENT_SIZE } from "./spec";
import { COOLING } from "./thermalMaterials";
import { buildAirflow } from "./aeroLang";
import { buildStudy } from "./studyLang";

/** supports plus loads in one analysis: each one is a pass over the model's surface */
export const MAX_BOUNDARY_ITEMS = 200;

/** heat: where heat is made and how the parts are cooled; with fix: the temperatures then load the structure */
export const HEAT_PROPS = ["heat", "hold", "cooling", "ambient", "emissivity", "time", "start", "max_temp"];
/** fatigue: how the loads repeat over the part's life, and what lowers the material's fatigue strength */
export const FATIGUE_PROPS = ["loading", "history", "repeats", "mean_stress", "finish", "reliability"];
/** topology optimisation: the stiffest shape for the loads from a share of the material, and what it must keep */
export const TOPOLOGY_PROPS = ["topology", "preserve", "min_member", "symmetry", "extrusion", "iterations"];
export const STRUCTURAL_PROPS = [
  "parts",
  "part",
  "material",
  "fix",
  "load",
  "gravity",
  "accel",
  "printed",
  "build",
  "cycles",
  ...FATIGUE_PROPS,
  "safety",
  "max_deflection",
  "resolution",
  "carries",
  "modes",
  "excite",
  "damping",
  "ringing",
  "shake",
  "random",
  "duration",
  "drop",
  "tip",
  "impact",
  "onto",
  ...HEAT_PROPS,
  "temperature",
  "assembled_at",
  "touching",
  "preload",
  "buckling",
  "buckling_safety",
  "large_deflection",
  "elements",
  "layup",
  "fibre",
  "fiber",
  ...TOPOLOGY_PROPS,
];
export const DRIVETRAIN_PROPS = ["drive", "torque", "speed", "life", "safety"];
export const UCI_PROPS = ["uci", "bottom_bracket", "wheels", "saddle", "bars", "hoods", "forward", "parts", "rim_depth"];
const FLAGS = ["gravity", "printed", "locked", "buckling", "converge", "large_deflection"];

const REGION = "region";
const LOAD = "load";
const SUPPORT = "support";
const MASS = "mass";
const EXCITE = "excitation";
const HEAT = "heat source";
const CURRENT = "electric current";
const HELD = "held temperature";
const FILM = "film";
const BLOCK = "load block";
const SINE = "sine sweep";
const PSD = "random spectrum";
const TOUCH = "touching pair";
const PLIES = PLIES_KIND;
const BOLT = "tightened bolt";

function def(name: string, params: string[], impl: (a: Args) => Value, doc: string): [string, Fn] {
  return [name, new Fn(name, (pos, named, ctx) => impl(new Args(name, pos, named, ctx, params)), doc)];
}

function refName(v: Value | undefined, a: Args, what: string): string {
  if (v instanceof Ref) return v.name;
  if (v instanceof Obj && v.kind === "component" && typeof v.fields.name === "string") return v.fields.name;
  // a frame: face(stand, -Z) is the side of all its members furthest that way
  if (v instanceof Obj && v.kind === "frame" && typeof v.fields.name === "string") return v.fields.name;
  if (typeof v === "string") return v;
  return a.ctx.error(`${a.fname}(): ${what} should be a part or component name, got ${v === undefined ? "nothing" : typeName(v)}`);
}

function region(v: Value | undefined, a: Args): RegionSpec {
  if (v instanceof Obj && v.kind === REGION) return v.fields.spec as unknown as RegionSpec;
  return a.ctx.error(`${a.fname}(): the first argument should say where it acts, like face(bracket, -Y) or zone(at: (0, 0, 5), r: 3); got ${v === undefined ? "nothing" : typeName(v)}`);
}

const wrap = (kind: string, spec: unknown, label: string) => new Obj({ spec: spec as Value }, kind, label);
/** a frequency for a label: 12.5, 500, 2000 */
const hzText = (f: number) => String(f < 10 ? Math.round(f * 100) / 100 : f < 100 ? Math.round(f * 10) / 10 : Math.round(f));
/** -Y evaluates to (-0, -1, -0); store plain zeros */
const clean = (v: V3): V3 => [v[0] || 0, v[1] || 0, v[2] || 0];
const norm3 = (v: V3): V3 => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** Functions that only exist inside analysis blocks; they take precedence there when called. */
export const ANALYSIS_FNS: Record<string, Fn> = Object.fromEntries([
  def(
    "face",
    ["part", "dir"],
    (a) => {
      const part = refName(a.value("part"), a, "the part");
      const dir = clean(a.dir("dir"));
      return wrap(REGION, { t: "face", part, dir } satisfies RegionSpec, `${part} face`);
    },
    "face(part, -Y) → the outer face of a part (or component) that points along a direction: the side furthest that way. Use it with fix:, force(), pressure() or torque().",
  ),
  def(
    "zone",
    ["at", "r", "size", "d", "axis", "length", "within"],
    (a) => {
      const at = a.vec3("at");
      // kept to where it overlaps another zone
      let within: Within["within"];
      if (a.has("within")) {
        const w = region(a.value("within"), a);
        if (w.t !== "sphere" && w.t !== "box" && w.t !== "cyl") return a.ctx.error("zone(): within: takes another zone(...), not a face");
        within = w;
      }
      const w = within ? { within } : {};
      if (a.has("size")) return wrap(REGION, { t: "box", at, size: a.vec3("size"), ...w } satisfies RegionSpec, "box zone");
      if (a.has("d")) {
        const axis = clean(a.dir("axis", [0, 0, 1]));
        return wrap(REGION, { t: "cyl", at, axis, d: a.positive("d"), length: a.num("length", 0), ...w } satisfies RegionSpec, "cylinder zone");
      }
      return wrap(REGION, { t: "sphere", at, r: a.num("r", 1), ...w } satisfies RegionSpec, "sphere zone");
    },
    "zone(at: p, r: 3) → the part surface within r of a point. zone(at: p, size: (x, y, z)) uses a box centred at p; zone(at: p, d: 8, axis: Z, length: 6) a cylinder starting at p (a bore or a boss). within: zone(...) keeps it to where it overlaps another zone, like a curved seat zone kept clear of the arms beside it: zone(at: c, d: 36, axis: Z, length: 16, within: zone(at: c, size: (21, 100, 100))).",
  ),
  def(
    "roller",
    ["where", "axis"],
    (a) => {
      const r = region(a.value("where"), a);
      return wrap(SUPPORT, { region: r, dir: clean(a.dir("axis")) } satisfies SupportSpec, "roller");
    },
    "roller(region, Z) → a support that only stops movement along one axis and lets the surface slide the other ways (resting on a flat surface, a pin in a slot).",
  ),
  def(
    "force",
    ["where", "f", "dir", "at"],
    (a) => {
      const r = region(a.value("where"), a);
      const fv = a.value("f");
      let f: V3;
      if (typeof fv === "number") {
        const d = a.dir("dir", [0, 0, -1]);
        f = [d[0] * fv, d[1] * fv, d[2] * fv];
      } else f = a.vec3("f");
      f = clean(f);
      if (a.has("at")) return leverLoads(a, r, f, a.vec3("at"), "force");
      return wrap(LOAD, { t: "force", region: r, f } satisfies LoadSpec, "force");
    },
    "force(region, (0, 0, -50N)) → a total force in newtons spread over the region. force(region, 50N, dir: -Z) is the same. 1 kg of weight ≈ 9.81 N. force(zone(...), 20N, dir: X, at: p) is a force on something not analysed (a thin sheet, a sign, a handle) at point p, carried into the zone as that force plus its moment.",
  ),
  def(
    "wind",
    ["where", "speed", "dir", "area", "at", "cd"],
    (a) => {
      const r = region(a.value("where"), a);
      const v = a.positive("speed");
      if (v < 1000) a.ctx.error("wind(): give the speed with its unit, like 70kmh or 45mph (a plain number is mm/s)");
      const cd = a.num("cd", 1.2);
      // dynamic pressure ½ρv², air at 1.225 kg/m³: in N/mm² with v in mm/s
      const q = 0.5 * 1.225e-12 * v * v;
      if (!a.has("area")) return wrap(LOAD, { t: "pressure", region: r, p: q * cd } satisfies LoadSpec, "wind");
      const d = a.dir("dir", [1, 0, 0]);
      const F = q * cd * a.positive("area");
      const f = clean([d[0] * F, d[1] * F, d[2] * F]);
      return a.has("at") ? leverLoads(a, r, f, a.vec3("at"), "wind") : wrap(LOAD, { t: "force", region: r, f } satisfies LoadSpec, "wind");
    },
    'wind(region, 70kmh, cd: 1.2) → wind pressure ½ρv²·cd pushing on a face (cd 1.2 for a flat plate square to the wind, 0.5 for a tube). wind(zone(...), 70kmh, dir: X, area: 8400, at: p) is the wind on a sheet or sign that is not analysed (area in mm², centre of pressure p), carried into the zone that holds it as a force plus its moment. Speeds take kmh or mph.',
  ),
  def(
    "pull",
    ["band"],
    (a) => {
      const b = a.value("band");
      if (!(b instanceof Obj) || b.kind !== "component" || b.fields.kind !== "band") a.ctx.error("pull(): name a lib.band, like pull(band_top)");
      const f = (b as Obj).fields;
      const pt = (k: string) => (f[k] instanceof Vec ? (f[k] as Vec).v : null);
      const from = pt("from");
      const to = pt("to");
      const fd = pt("from_pull");
      const td = pt("to_pull");
      if (!from || !to || !fd || !td) a.ctx.error("pull(): the band must be hooked at both ends (from: and to:) to pull on its hooks");
      const P = typeof f.pull === "number" ? f.pull : 0;
      const zoneAt = (p: number[], pin: number): RegionSpec => ({ t: "sphere", at: [p[0], p[1], p[2] ?? 0], r: pin / 2 + 1 });
      const load = (p: number[], d: number[], pin: number) => wrap(LOAD, { t: "force", region: zoneAt(p, pin), f: clean([d[0] * P, d[1] * P, (d[2] ?? 0) * P]) } satisfies LoadSpec, "band pull");
      const s = typeof f.spread === "number" ? f.spread : 0;
      const n = pt("axis");
      if (s > 0 && n) {
        // a double hook: each prong takes one strand's pull toward the tube and the end's pull toward the other prong
        const T = typeof f.tension === "number" ? f.tension : 0;
        const prong = (p: number[], d: number[], pin: number, up: number) =>
          wrap(LOAD, { t: "force", region: zoneAt([0, 1, 2].map((k) => (p[k] ?? 0) + (up * s * n[k]) / 2), pin), f: clean([0, 1, 2].map((k) => T * ((d[k] ?? 0) - up * n[k])) as V3) } satisfies LoadSpec, "band pull");
        const fp = Number(f.from_pin ?? 4);
        const tp = Number(f.to_pin ?? 4);
        return [prong(from!, fd!, fp, 1), prong(from!, fd!, fp, -1), prong(to!, td!, tp, 1), prong(to!, td!, tp, -1)];
      }
      return [load(from!, fd!, Number(f.from_pin ?? 4)), load(to!, td!, Number(f.to_pin ?? 4))];
    },
    "pull(band) → the pull of a lib.band on its two hook pins (both strands, toward the tube it wraps), as two forces; on double hooks (spread:) four, one on each prong. Use it with load: on the part the band holds.",
  ),
  def(
    "contact",
    ["where", "mu", "normal", "grip"],
    (a) => {
      const r = region(a.value("where"), a);
      if (r.t !== "face" && r.t !== "cyl" && !a.has("normal")) a.ctx.error("contact(): give normal: (the way the seat faces, out of the part) for a sphere or box zone; face() and cylinder zones know theirs");
      const mu = a.num("mu", 0.3);
      if (!(mu >= 0) || mu > 2) a.ctx.error("contact(): mu (the friction coefficient) should be 0..2");
      let grip: { force: number; moment: number; names: string[] } | undefined;
      const gv = a.value("grip");
      if (gv !== undefined) {
        grip = { force: 0, moment: 0, names: [] };
        for (const b of Array.isArray(gv) ? gv : [gv]) {
          if (!(b instanceof Obj) || b.kind !== "component" || b.fields.kind !== "band") a.ctx.error("contact(): grip: lists the lib.band components round the same tube, like grip: [band_top, band_bottom]");
          const f = (b as Obj).fields;
          const n = Number(f.grip_force ?? 0);
          grip.force += n;
          grip.moment += Number(f.grip_moment ?? 0);
          grip.names.push(String(f.name));
        }
      }
      const spec: SupportSpec = { region: r, contact: { mu, ...(a.has("normal") ? { normal: clean(a.dir("normal")) } : {}), ...(grip ? { grip } : {}) } };
      return wrap(SUPPORT, spec, "contact");
    },
    "contact(region, mu: 0.3, grip: [band]) → a seat that is only pressed on (by bands, springs or its own weight), not glued: it holds like fix:, then the result checks that the seat stays pressed (no edge lifts off) and that friction holds what would slide or turn it. A cylinder zone round a tube (zone(at:, d:, axis:, length:)) is a saddle on that tube; grip: adds the friction of bands round the same tube.",
  ),
  def(
    "touch",
    ["a", "b", "mu", "lift"],
    (a) => {
      const first = a.value("a");
      const muV = a.value("mu");
      let mu: TouchSpec["mu"] = 0.3;
      if (muV !== undefined) {
        if (muV === "rough" || muV === "glued") mu = muV;
        else if (muV === "bonded") mu = "glued";
        else if (typeof muV === "number" && muV >= 0 && muV <= 2) mu = muV;
        else a.ctx.error('touch(): mu: is the friction coefficient from 0 (slides freely) to 2, "rough" (never slides) or "glued" (bonded, to keep one pair glued under touching: "all")');
      }
      const lift = a.bool("lift", true);
      // touch("all", mu: 0.2): every touching pair, with this friction
      if ((first === "all" || (first instanceof Ref && first.name === "all")) && a.value("b") === undefined) {
        if (mu === "glued") a.ctx.error('touch("all", mu: "glued") is how parts are anyway: leave out touching:');
        return wrap(TOUCH, { a: "all", b: "", mu, lift } satisfies TouchSpec, "every touching pair");
      }
      const pa = refName(first, a, "the first part");
      const pb = refName(a.value("b"), a, "the second part");
      if (pa === pb) a.ctx.error(`touch(): name two different parts, like touch(lid, box); got ${pa} twice`);
      return wrap(TOUCH, { a: pa, b: pb, mu, lift } satisfies TouchSpec, "touching pair");
    },
    'touch(a, b, mu: 0.3, lift: true) → in touching:, two analysed parts that touch as a contact instead of glued: pressed together they bear on each other, pulled they come apart, and along the faces they slide once friction (mu) lets go. mu: 0 slides freely, "rough" never slides, "glued" keeps the pair bonded (an exception under touching: "all"). lift: false lets them slide but never part (held by something not analysed). touch("all", mu: 0.2) sets the friction for every touching pair.',
  ),
  def(
    "bolt",
    ["part", "force", "torque"],
    (a) => {
      const first = a.value("part");
      const hasF = a.value("force") !== undefined,
        hasT = a.has("torque");
      if (hasF && hasT) a.ctx.error("bolt(): give the tension (bolt(screw_1, 3kN)) or the torque it is done up to (bolt(screw_1, torque: 2Nm)), not both");
      const force = hasF ? a.num("force") : undefined;
      const torque = hasT ? a.num("torque") : undefined;
      if (force !== undefined && !(force > 0)) a.ctx.error("bolt(): the tension it is tightened to should be more than 0, like bolt(screw_1, 3kN)");
      if (torque !== undefined && !(torque > 0)) a.ctx.error("bolt(): torque: should be more than 0, like torque: 2Nm");
      const how = { ...(force !== undefined ? { force } : {}), ...(torque !== undefined ? { torque } : {}) };
      if (first === "all" || (first instanceof Ref && first.name === "all")) return wrap(BOLT, { part: "all", ...how }, "every bolt tightened");
      return wrap(BOLT, { part: refName(first, a, "the screw or bolt"), ...how }, BOLT);
    },
    'bolt(screw_1, 3kN) → in preload:, a screw or bolt tightened to this tension before the loads go on; bolt(screw_1, torque: 2Nm) by the torque it is done up to (tension = torque / (0.2 × its diameter)); bolt(screw_1) as it usually is (75 % of its proof load into a nut or metal, the usual hand torque into plastic or an insert); bolt("all", torque: 1Nm) for every screw and bolt analysed.',
  ),
  def(
    "spring",
    ["where", "rate", "axis", "per_area"],
    (a) => {
      const r = region(a.value("where"), a);
      const hasRate = a.has("rate"),
        hasPer = a.has("per_area");
      if (hasRate === hasPer) a.ctx.error("spring(): give rate: (the springs' total stiffness in N/mm, like spring(face(base, -Z), 500)) or per_area: (N/mm per mm² of surface, for a pad), one of them");
      const v = hasRate ? a.positive("rate") : a.positive("per_area");
      const spec: SupportSpec = { region: r, ...(a.has("axis") ? { dir: clean(a.dir("axis")) } : {}), spring: hasRate ? { rate: v } : { perArea: v } };
      return wrap(SUPPORT, spec, "spring");
    },
    "spring(region, 500, axis: Z) → an elastic support instead of a rigid one: rubber feet, a soft mount, the give of a shelf or wall it bolts to. rate: the springs' total stiffness in N/mm (it gives 1 mm per 500 N here), spread over the region by area, every way or only along axis:. per_area: 1.5 is a pad pressing along the surface's normal, in N/mm per mm² (a rubber pad: its compression modulus over its thickness, about 5 MPa / 3 mm ≈ 1.7). Use it in fix:; the result says how far it gives.",
  ),
  def(
    "pin",
    ["where", "slide", "tight"],
    (a) => {
      const r = region(a.value("where"), a);
      if (r.t !== "cyl") a.ctx.error("pin(): give the bore (or the shaft) as a cylinder zone, like pin(zone(at: (0, 0, 10), d: 6, axis: Y, length: 12))");
      return wrap(SUPPORT, { region: r, pin: { slide: a.bool("slide", false), tight: a.bool("tight", false) } } satisfies SupportSpec, "pin");
    },
    "pin(zone(at:, d:, axis:, length:)) → a pin through a bore, or a bushing or bearing round a shaft: holds it across the pin and along it while it turns freely about it (a hinge). It bears only on the side the loads press the bore onto it, like a pin with a little clearance; tight: true holds all round (a press fit), slide: true lets the part slide along the pin too. A part on one pin can swing about it, so add a second pin or another support. Use it in fix:; the result gives the bearing pressure.",
  ),
  def(
    "displace",
    ["where", "by", "dir"],
    (a) => {
      const r = region(a.value("where"), a);
      const v = a.value("by");
      if (typeof v === "number") {
        if (!a.has("dir")) a.ctx.error("displace(): with a distance, give the way it moves, like displace(face(hook, +Z), 1.5mm, dir: -Z); or give a vector, like (0, 0, -1.5mm)");
        const d = norm3(a.dir("dir"));
        return wrap(SUPPORT, { region: r, dir: clean(d), move: clean([d[0] * v, d[1] * v, d[2] * v]) } satisfies SupportSpec, "set displacement");
      }
      const m = clean(a.vec3("by"));
      if (Math.hypot(...m) < 1e-12) a.ctx.error("displace(): the displacement is zero; use fix: for a region held still");
      return wrap(SUPPORT, { region: r, move: m } satisfies SupportSpec, "set displacement");
    },
    "displace(region, (0, 0, -1.5mm)) → a set displacement instead of a force: the region is pushed this far and held there, every way. displace(face(hook, +X), 1.5mm, dir: -Z) pushes it along one axis only and lets it slide the other ways, like a finger. For snap fits, clips and clamps (how hard is it to push 1.5 mm, and what strain does that make?): use it in fix:; the result gives the force it takes. Stresses are linear, so they suit small movements.",
  ),
  def(
    "bearing",
    ["where", "f", "dir"],
    (a) => {
      const r = region(a.value("where"), a);
      if (r.t !== "cyl") a.ctx.error("bearing(): give the bore (or the shaft seat) as a cylinder zone, like bearing(zone(at: c, d: 22, axis: Y, length: 7), 300N, dir: -Z)");
      const fv = a.value("f");
      let f: V3;
      if (typeof fv === "number") {
        const d = a.dir("dir", [0, 0, -1]);
        f = [d[0] * fv, d[1] * fv, d[2] * fv];
      } else f = a.vec3("f");
      return wrap(LOAD, { t: "bearing", region: r, f: clean(f) } satisfies LoadSpec, "bearing load");
    },
    "bearing(zone(at:, d:, axis:, length:), 300N, dir: -Z) → the load a shaft, pin or bearing pushes onto a bore (or a bearing onto its shaft): spread over the half of the cylinder it presses on, most in the middle and none at the sides (a cosine), as a pin or bearing really loads a hole, rather than evenly over the whole bore like force(). A share along the axis (a thrust) is spread evenly. Use it in load:.",
  ),
  def(
    "pressure",
    ["where", "p"],
    (a) => {
      const r = region(a.value("where"), a);
      return wrap(LOAD, { t: "pressure", region: r, p: a.num("p") } satisfies LoadSpec, "pressure");
    },
    "pressure(region, 0.05MPa) → a pressure pushing into the surface (1 MPa = 1 N/mm², 1 bar = 0.1 MPa, 1 psi ≈ 0.0069 MPa). A negative value pulls.",
  ),
  def(
    "torque",
    ["where", "t", "axis", "at"],
    (a) => {
      const r = region(a.value("where"), a);
      const axis = clean(a.dir("axis", r.t === "cyl" ? r.axis : [0, 0, 1]));
      const at = a.has("at") ? a.vec3("at") : r.t === "face" || r.t === "extreme" ? undefined : r.at;
      return wrap(LOAD, { t: "torque", region: r, torque: a.num("t"), axis, at } satisfies LoadSpec, "torque");
    },
    "torque(region, 2Nm, axis: Z, at: (0, 0, 0)) → a twisting load about an axis (at: marks the point it is drawn through), shared over the region in proportion to the distance from that axis through the loaded surface's own centre, so it twists without pushing the region sideways. Positive is counter-clockwise looking down the axis.",
  ),
  def(
    "mass",
    ["where", "grams"],
    (a) => {
      const r = region(a.value("where"), a);
      return wrap(MASS, { region: r, grams: a.positive("grams") } satisfies MassSpec, "mass");
    },
    "mass(region, 350g) → a mass the parts carry that is not drawn as a solid (a motor, a battery, a payload), fixed to the region. Use it with carries:. It adds weight under gravity, inertia when shaken and force in a drop.",
  ),
  def(
    "spin",
    ["rpm", "to", "name"],
    (a) => {
      const lo = a.positive("rpm");
      const hi = a.has("to") ? a.positive("to") : lo;
      if (hi < lo) a.ctx.error("spin(): to: should be the higher speed");
      const label = a.has("name") ? a.str("name") : hi > lo ? `${lo}–${hi} rpm` : `${lo} rpm`;
      return wrap(EXCITE, { lo: lo / 60, hi: hi / 60, label } satisfies Excitation, label);
    },
    "spin(1500rpm, name: \"fan\") → something turning at this speed shakes the design once a turn (a motor, a drill, an unbalanced wheel). spin(600rpm, to: 3000rpm) for a range it runs through. Use it in excite:.",
  ),
  def(
    "source",
    ["where", "power", "name", "why"],
    (a) => {
      const w = a.value("where");
      const watts = a.num("power");
      if (!(watts >= 0)) a.ctx.error("source(): the power should be 0 W or more, like source(motor, 12W)");
      const why = a.has("why") ? { why: a.str("why") } : {};
      if (w instanceof Obj && w.kind === REGION) {
        const label = a.has("name") ? a.str("name") : "heat";
        return wrap(HEAT, { region: w.fields.spec as unknown as RegionSpec, watts, label, ...why } satisfies HeatLoadSpec, label);
      }
      const part = refName(w, a, "where the heat is made");
      const label = a.has("name") ? a.str("name") : part;
      return wrap(HEAT, { part, watts, label, ...why } satisfies HeatLoadSpec, label);
    },
    'source(motor, 12W) → heat made inside a part or component, spread through its volume (each copy of it makes this much). source(face(plate, +Z), 3W, name: "heater") makes it over a region of the surface instead. Use it in heat:, with heat: "auto" for every electronic part\'s own loss.',
  ),
  def(
    "current",
    ["from", "to", "amps", "volts", "name"],
    (a) => {
      const from = region(a.value("from"), a);
      const to = region(a.value("to"), a);
      const hasA = a.has("amps"),
        hasV = a.has("volts");
      if (hasA === hasV)
        a.ctx.error(
          hasA
            ? "current(): give the current through it or the voltage across it, not both"
            : "current(): say how much flows, like current(face(bar, -X), face(bar, +X), 40A), or the voltage across it with volts: 12V",
        );
      const label = a.has("name") ? a.str("name") : "current";
      if (hasA) {
        const amps = a.num("amps");
        if (!(amps > 0)) a.ctx.error("current(): the current should be more than 0 A, like 40A");
        return wrap(CURRENT, { from, to, amps, label } satisfies CurrentSpec, label);
      }
      const volts = a.num("volts");
      if (!(volts > 0)) a.ctx.error("current(): volts: should be more than 0 V, like volts: 12V");
      return wrap(CURRENT, { from, to, volts, label } satisfies CurrentSpec, label);
    },
    'current(face(busbar, -X), face(busbar, +X), 60A) → current that goes in over the first region and out over the second, heating whatever conducts it on the way (Joule heating, I²R): a busbar, a battery strap, a heater element. Kerf works out the resistance from the parts\' shape and metal, rising as they warm, and reports it with the voltage drop, the power and where the current crowds. volts: 12V instead of the current gives the voltage across it (a heater: the current follows). Use it in heat:.',
  ),
  def(
    "temp",
    ["where", "t"],
    (a) => {
      const r = region(a.value("where"), a);
      const t = a.num("t");
      if (t < -273.15) a.ctx.error("temp(): the temperature is in °C, like temp(face(plate, -Z), 60C)");
      return wrap(HELD, { region: r, temp: t } satisfies FixedTempSpec, "held temperature");
    },
    "temp(face(plate, -Z), 60C) → a surface held at a temperature: a heated bed, a chilled plate, the hot engine block it bolts to. Use it in hold:.",
  ),
  def(
    "film",
    ["where", "h", "air"],
    (a) => {
      const r = region(a.value("where"), a);
      const hv = a.value("h");
      let h: number;
      let conv: number | undefined;
      if (typeof hv === "string") {
        const c = COOLING[hv.toLowerCase()];
        if (!c) a.ctx.error(`film(): "${hv}" is not a cooling Kerf knows; use one of ${Object.keys(COOLING).map((k) => `"${k}"`).join(", ")} or a film coefficient in W/m²K, like 50`);
        h = c!.h;
        conv = c!.conv;
      } else {
        h = a.num("h");
        if (!(h >= 0)) a.ctx.error("film(): the film coefficient should be 0 or more, in W/m²K (still air about 10, a fan 50, water 800)");
      }
      return wrap(FILM, { region: r, h, ...(conv !== undefined ? { conv } : {}), ...(a.has("air") ? { ambient: a.num("air") } : {}) } satisfies FilmSpec, "film");
    },
    'film(face(heatsink, +Y), "fan", air: 35C) → different cooling on part of the surface: a named cooling ("fan", "water"...) or a film coefficient in W/m²K, and the temperature of what flows past it (default: ambient:). Use it in cooling:.',
  ),
  def(
    "band",
    ["lo", "hi", "name"],
    (a) => {
      const lo = a.positive("lo");
      const hi = a.positive("hi");
      if (hi < lo) a.ctx.error("band(): the second frequency should be the higher one");
      const label = a.has("name") ? a.str("name") : `${lo}–${hi} Hz`;
      return wrap(EXCITE, { lo, hi, label } satisfies Excitation, label);
    },
    "band(20Hz, 60Hz, name: \"road\") → shaking anywhere between two frequencies (a vehicle, footsteps, a vibrating table). A plain number like 50Hz in excite: is one frequency. Use it in excite:.",
  ),
  def(
    "sine",
    ["lo", "hi", "accel", "dir", "name"],
    (a) => {
      const lo = a.positive("lo");
      const hi = a.positive("hi");
      if (hi <= lo) a.ctx.error("sine(): the second frequency should be the higher one, like sine(10Hz, 500Hz, 2g, Z)");
      const accel = a.has("accel") ? a.positive("accel") : undefined;
      if (accel === undefined && a.has("dir")) a.ctx.error("sine(): dir: is the way the supports are shaken; give how hard too, like sine(10Hz, 500Hz, 2g, Z)");
      const dir = accel !== undefined ? clean(a.dir("dir", [0, 0, 1])) : undefined;
      const label = a.has("name") ? a.str("name") : `${hzText(lo)}–${hzText(hi)} Hz${accel !== undefined ? ` at ${Math.round(accel * 100) / 100} g` : ""}`;
      return wrap(SINE, { lo, hi, ...(accel !== undefined ? { accel, dir } : {}), label } satisfies SineSpec, label);
    },
    "sine(10Hz, 500Hz, 2g, Z) → a sine sweep: the supports shaken back and forth along Z at 2 g (peak), at every frequency from 10 to 500 Hz in turn, like a shaker table or a motor running up through its speeds. Without the acceleration, sine(20Hz, 200Hz), the loads go up and down at each frequency instead (an unbalanced rotor, a pump's pulses). Kerf finds the worst frequency and shows the stresses there, with the response across the band. Use it in shake:.",
  ),
  def(
    "psd",
    ["points", "dir", "name"],
    (a) => {
      const v = a.value("points");
      let points: [number, number][];
      let label: string;
      if (typeof v === "string") {
        const pr = PSD_PRESETS[v.toLowerCase()];
        if (!pr) a.ctx.error(`psd(): "${v}" is not a spectrum Kerf knows; use ${Object.keys(PSD_PRESETS).map((k) => `"${k}"`).join(", ")}, or your own points in g²/Hz like [(20Hz, 0.01), (80Hz, 0.04), (350Hz, 0.04), (2000Hz, 0.007)]`);
        points = pr!.points.map(([f, g]) => [f, g]);
        label = `${pr!.label} (${hzText(points[0][0])}–${hzText(points[points.length - 1][0])} Hz, ${Math.round(grms(points) * 100) / 100} g rms)`;
      } else {
        const pts = a.points2("points");
        if (pts.length < 2) a.ctx.error("psd(): give at least two points (frequency, g²/Hz), like [(20Hz, 0.01), (2000Hz, 0.01)]");
        pts.forEach(([f, g], i) => {
          if (!(f > 0)) a.ctx.error(`psd(): point ${i + 1}'s frequency should be more than 0 Hz`);
          if (!(g >= 0)) a.ctx.error(`psd(): point ${i + 1}'s level should be 0 g²/Hz or more`);
          if (i && f <= pts[i - 1][0]) a.ctx.error("psd(): the frequencies should go up from point to point");
        });
        points = pts.map(([f, g]) => [f, g]);
        if (!(grms(points) > 0)) a.ctx.error("psd(): every level is 0 g²/Hz, so nothing shakes it");
        label = `${hzText(points[0][0])}–${hzText(points[points.length - 1][0])} Hz, ${Math.round(grms(points) * 100) / 100} g rms`;
      }
      const dir = clean(a.dir("dir", [0, 0, 1]));
      if (a.has("name")) label = a.str("name");
      return wrap(PSD, { points, dir, label } satisfies RandomSpec, label);
    },
    'psd("navmat", Z) → random shaking of the supports along Z from an acceleration spectrum: "navmat" (NAVMAT P-9492 electronics screening, 20–2000 Hz, 6.06 g rms), "truck" (ASTM D4169 truck transport, 1–200 Hz, 0.52 g rms) or your own points in g²/Hz, like psd([(20Hz, 0.01), (80Hz, 0.04), (350Hz, 0.04), (2000Hz, 0.007)], Z), joined by straight lines on log-log axes. Kerf gives the RMS (1σ) movement and stress, shows 3σ stresses (it stays below them 99.7 % of the time) and the fatigue life by Steinberg\'s three bands. Use it in random:.',
  ),
  def(
    "plies",
    ["stack", "material", "t", "part", "zone", "name"],
    (a) => {
      const v = a.value("stack");
      let angles: number[] = [];
      let code = "";
      if (typeof v === "string") {
        const got = parseLayup(v);
        if ("error" in got) a.ctx.error(`plies(): ${got.error}. Write each ply's angle from 0° from the outside in, like "[0/±45/90]s" ("s" mirrors the stack, a number after brackets repeats it, 0₂ is two 0° plies)`);
        else angles = got;
        code = v.trim();
        if (/^[+-]?\d+(\.\d+)?$/.test(code)) code = `[${code}]`;
      } else if (typeof v === "number" || Array.isArray(v)) {
        const list = typeof v === "number" ? [v] : v;
        angles = list.map((x, i) => {
          if (typeof x !== "number" || !(Math.abs(x) <= 90)) a.ctx.error(`plies(): ply ${i + 1}'s angle should be a number of degrees from -90 to 90, like [0, 45, -45, 90]`);
          return x === -90 ? 90 : (x as number) || 0;
        });
        if (!angles.length) a.ctx.error("plies(): the list has no plies");
        code = layupText(angles);
      } else a.ctx.error(`plies(): give the stack as a code like "[0/±45/90]s" or a list of angles like [0, 45, -45, 90]; got ${v === undefined ? "nothing" : typeName(v)}`);
      const matName = a.has("material") ? a.str("material") : "carbon";
      const m = plyMaterial(matName);
      if (!m) a.ctx.error(`plies(): "${matName}" is not a ply material Kerf knows; use ${Object.keys(PLY_MATERIALS).map((k) => `"${k}"`).join(", ")}`);
      const t = a.has("t") ? a.positive("t") : undefined;
      if (t !== undefined && t > 2) a.ctx.error("plies(): t: is one ply's thickness, like 0.12mm (prepreg plies are about 0.05 to 0.3 mm)");
      const part = a.has("part") ? refName(a.value("part"), a, "part:") : undefined;
      let zone: RegionSpec | undefined;
      if (a.has("zone")) {
        const z = a.value("zone");
        if (z instanceof Obj && z.kind === REGION) zone = z.fields.spec as unknown as RegionSpec;
        else a.ctx.error(`plies(): zone: says where these plies go, like zone(at: (0, 0, 40), r: 30) or face(frame, -Z); got ${typeName(z!)}`);
        if (zone!.t === "extreme") a.ctx.error("plies(): zone: should be a zone(...) or a face(part, dir), not the side that lands first");
      }
      const label = a.has("name") ? a.str("name") : `${code} ${m!.label}${zone ? ` in the ${describeRegion(zone)}` : ""}`;
      return wrap(PLIES, { angles, material: m!.key, ...(t !== undefined ? { t } : {}), ...(part ? { part } : {}), ...(zone ? { zone } : {}), code, label } satisfies PliesSpec, label);
    },
    'plies("[0/±45/90]s", "carbon") → a stack of composite plies for a carbon layup, laid from the outer surface inward: each ply\'s angle from 0° (counterclockwise seen from outside); "s" mirrors the stack, a number after brackets repeats it ("[0/90]2s"), 0₂ (or 0_2) is two 0° plies, ±45 is +45 then -45. Materials: "carbon" (T700-class UD, 0.12 mm plies), "carbon im" (T800-class), "carbon hm" (M40J-class), "carbon woven" (3K twill, 0.22 mm), "glass", "glass woven", "aramid"; t: sets the ply thickness. zone: lays them inside the stack over a region only (round a bottom bracket, a head tube, a bolt), part: for one part only. Use it in layup:, or a list laid from the outside in, like layup: [plies("0", "carbon woven"), plies("[0/±45/90]s"), plies("[0/90]2", zone: zone(at: (0, 0, 0), r: 45))].',
  ),
  def(
    "block",
    ["cycles", "peak", "min"],
    (a) => {
      const n = a.positive("cycles");
      const peak = a.num("peak", 1);
      if (!Number.isFinite(peak) || peak === 0) a.ctx.error("block(): the peak is a scale of the analysis's loads, like 1 (the loads as written) or 1.5, not 0");
      const min = a.has("min") ? a.num("min") : undefined;
      if (min !== undefined && min >= peak) a.ctx.error("block(): min: should be lower than the peak");
      return wrap(BLOCK, { count: n, peak, ...(min !== undefined ? { min } : {}) }, "load block");
    },
    'block(1e5, 1.5, min: 0) → a block of load cycles in a fatigue history: this many cycles that peak at this scale of the loads as written, down to min: (default from loading:, e.g. -1.5 when fully reversed, 0 for "on-off"). Use them in history: [block(1e6, 1), block(1e3, 2)].',
  ),
]);

/** A force at a point off the analysed parts, carried into a zone as the same force plus its moment about the zone's centre. */
function leverLoads(a: Args, r: RegionSpec, f: V3, at: V3, what: string): Value {
  const c: V3 | null = r.t === "sphere" || r.t === "box" ? r.at : r.t === "cyl" ? [r.at[0] + (r.axis[0] * r.length) / 2, r.at[1] + (r.axis[1] * r.length) / 2, r.at[2] + (r.axis[2] * r.length) / 2] : null;
  if (!c) return a.ctx.error(`${a.fname}(): at: carries the load in from a point, so give a zone() that holds it (its centre is the pivot), not a face()`);
  const arm: V3 = [at[0] - c[0], at[1] - c[1], at[2] - c[2]];
  const M: V3 = [arm[1] * f[2] - arm[2] * f[1], arm[2] * f[0] - arm[0] * f[2], arm[0] * f[1] - arm[1] * f[0]];
  const m = Math.hypot(...M);
  const out: Value[] = [wrap(LOAD, { t: "force", region: r, f, from: at } satisfies LoadSpec, what)];
  if (m > 1e-9) out.push(wrap(LOAD, { t: "torque", region: r, torque: m, axis: clean([M[0] / m, M[1] / m, M[2] / m]), at: c } satisfies LoadSpec, `${what} moment`));
  return out;
}

export interface AnalysisItem {
  name: string;
  value: Value;
  span: Span;
}

export interface AnalysisEnv {
  fail(msg: string, span: Span): never;
  /** the kind of a top-level name: "part", "component", or undefined */
  kindOf(name: string): string | undefined;
  /** a frame's member parts, when the name is a frame, or the pieces of a part made in pieces (split:) */
  members?(name: string): string[] | undefined;
  /** a param declared so far, for a design study's vary: */
  param?(name: string): { value: number | string | boolean; text: string; min?: number; max?: number; locked: boolean } | undefined;
}

/** Turn the evaluated items of an analysis block into a spec. */
export function buildAnalysis(label: string, props: AnalysisItem[], flags: AnalysisItem[], span: Span, env: AnalysisEnv): AnalysisSpec {
  const fail: (msg: string, span: Span) => never = env.fail;
  if (props.some((p) => p.name === "uci")) return buildUci(label, props, flags, span, env);
  if (props.some((p) => p.name === "airflow")) return buildAirflow(label, props, flags, span, env);
  if (props.some((p) => p.name === "vary")) return buildStudy(label, props, flags, span, env);
  const isDrive = props.some((p) => p.name === "drive");
  const allowed = isDrive ? DRIVETRAIN_PROPS : STRUCTURAL_PROPS;
  for (const p of props) {
    if (!allowed.includes(p.name)) {
      const other = isDrive ? STRUCTURAL_PROPS.includes(p.name) : DRIVETRAIN_PROPS.includes(p.name);
      fail(
        other
          ? isDrive
            ? `"${p.name}:" belongs to a structural analysis. A drivetrain analysis (one with drive:) takes ${DRIVETRAIN_PROPS.join(", ")}.`
            : `"${p.name}:" belongs to a drivetrain analysis, which starts with drive: gear_name.`
          : `Unknown analysis property "${p.name}". Use ${STRUCTURAL_PROPS.join(", ")} for stress, drive:, torque:, speed:, life: for a gear train, airflow: 45kmh for drag and the flow round it, or vary: [param, …] for a design study.`,
        p.span,
      );
    }
  }
  for (const f of flags) if (!FLAGS.includes(f.name)) fail(`Unknown flag "${f.name}" in an analysis. Flags: gravity, printed, buckling, converge, large_deflection.`, f.span);
  const one = (name: string) => {
    const all = props.filter((p) => p.name === name);
    if (all.length > 1) fail(`"${name}:" is given twice`, all[1].span);
    return all[0];
  };
  const num = (name: string, min?: number): number | undefined => {
    const p = one(name);
    if (!p) return undefined;
    if (typeof p.value !== "number" || !Number.isFinite(p.value)) fail(`${name}: should be a number, got ${typeName(p.value)}`, p.span);
    if (min !== undefined && !(p.value > min)) fail(`${name}: must be greater than ${min}`, p.span);
    return p.value;
  };
  const bool = (name: string): boolean | undefined => {
    if (flags.some((f) => f.name === name)) return true;
    const p = one(name);
    if (!p) return undefined;
    if (typeof p.value !== "boolean") fail(`${name}: should be true or false`, p.span);
    return p.value;
  };
  const vec = (p: AnalysisItem, what: string): V3 => {
    if (p.value instanceof Vec && p.value.v.length >= 2 && p.value.v.length <= 3) return [p.value.v[0], p.value.v[1], p.value.v[2] ?? 0];
    return fail(`${what} should be a vector like (0, 0, -1), got ${typeName(p.value)}`, p.span);
  };
  const safetyGiven = num("safety", 0);
  const safety = safetyGiven ?? 2;

  if (isDrive) {
    const d = one("drive")!;
    const drive = d.value instanceof Obj && d.value.kind === "component" ? String(d.value.fields.name) : d.value instanceof Ref ? d.value.name : undefined;
    if (!drive) fail(`drive: should name the driving component (a gear or motor), got ${typeName(d.value)}`, d.span);
    const torque = num("torque", 0);
    if (torque === undefined) fail('A drivetrain analysis needs torque: (the input torque, e.g. torque: 0.4Nm)', span);
    const speed = num("speed", 0);
    if (speed === undefined) fail("A drivetrain analysis needs speed: (the input speed, e.g. speed: 3000rpm)", span);
    // times are in seconds in the language (2000h = 7.2e6); the drivetrain works in hours
    const life = num("life", 0);
    return { kind: "drivetrain", label, drive, torque, speed, life: life === undefined ? undefined : life / 3600, safety, span };
  }

  // ---- structural ----
  const supports: SupportSpec[] = [];
  const loads: LoadSpec[] = [];
  const regionsOf = (v: Value, p: AnalysisItem, as: "fix" | "load") => {
    const list = Array.isArray(v) ? v : [v];
    for (const x of list) {
      if (Array.isArray(x)) {
        regionsOf(x, p, as);
        continue;
      }
      if (as === "fix") {
        if (x instanceof Obj && x.kind === REGION) supports.push({ region: x.fields.spec as unknown as RegionSpec });
        else if (x instanceof Obj && x.kind === SUPPORT) supports.push(x.fields.spec as unknown as SupportSpec);
        else fail(`fix: should be a region like face(bracket, -Y), zone(at: p, r: 3), roller(face(base, -Z), Z), contact(region, mu: 0.3), spring(region, 500), pin(zone(...)) or displace(region, (0, 0, -1mm)); got ${typeName(x)}`, p.span);
      } else {
        if (x instanceof Obj && x.kind === LOAD) loads.push(x.fields.spec as unknown as LoadSpec);
        else if (x instanceof Obj && x.kind === SUPPORT) fail(`load: takes loads; ${x.label ?? "a support"} goes in fix:`, p.span);
        else fail(`load: should be force(...), pressure(...), torque(...), bearing(...), wind(...) or pull(band); got ${typeName(x)}`, p.span);
      }
    }
  };
  for (const p of props) {
    if (p.name === "fix") regionsOf(p.value, p, "fix");
    else if (p.name === "load") regionsOf(p.value, p, "load");
  }
  const listOf = (v: Value): Value[] => (Array.isArray(v) ? v.flatMap((x) => (Array.isArray(x) ? x : [x])) : [v]);
  const masses: MassSpec[] = [];
  const carryP = one("carries");
  if (carryP)
    for (const x of listOf(carryP.value)) {
      if (x instanceof Obj && x.kind === MASS) masses.push(x.fields.spec as unknown as MassSpec);
      else fail(`carries: should be mass(region, grams), like mass(face(frame, +Z), 350g); got ${typeName(x)}`, carryP.span);
    }

  // parts: explicit, or every part the supports and loads name
  let parts: string[] = [];
  const pp = props.filter((p) => p.name === "parts" || p.name === "part");
  if (pp.length > 1) fail("Give parts: once, as a list", pp[1].span);
  if (pp.length) {
    const list = Array.isArray(pp[0].value) ? pp[0].value : [pp[0].value];
    for (const v of list) {
      // a frame stands for all its members, and a part made in pieces (split:) for all its pieces
      const members = v instanceof Obj && v.kind === "frame" ? env.members?.(String(v.fields.name)) : v instanceof Ref ? env.members?.(v.name) : undefined;
      if (members) {
        for (const m of members) if (!parts.includes(m)) parts.push(m);
        continue;
      }
      const n = v instanceof Ref ? v.name : v instanceof Obj && v.kind === "component" ? String(v.fields.name) : null;
      if (!n) fail(`parts: should list part or component names, got ${typeName(v)}`, pp[0].span);
      if (!parts.includes(n)) parts.push(n);
    }
    if (!parts.length) fail("parts: the list is empty", pp[0].span);
  }
  // ---- heat: where it is made, surfaces held at a temperature, cooling ----
  const heatP = one("heat");
  const holdP = one("hold");
  const coolP = one("cooling");
  const heatLoads: HeatLoadSpec[] = [];
  const currents: CurrentSpec[] = [];
  let auto = false;
  if (heatP)
    for (const x of listOf(heatP.value)) {
      if (x === "auto") auto = true;
      else if (x instanceof Obj && x.kind === HEAT) heatLoads.push(x.fields.spec as unknown as HeatLoadSpec);
      else if (x instanceof Obj && x.kind === CURRENT) currents.push(x.fields.spec as unknown as CurrentSpec);
      else
        fail(
          typeof x === "number"
            ? `heat: say where the ${x} W is made, like heat: [source(motor, ${x}W)], or use heat: "auto" for every electronic part's own loss`
            : `heat: should list heat sources like source(motor, 12W) or source(face(plate, +Z), 3W), current through a conductor like current(face(bar, -X), face(bar, +X), 40A), or "auto" for every electronic part's loss at its working current; got ${typeName(x)}`,
          heatP.span,
        );
    }
  const fixedTemps: FixedTempSpec[] = [];
  if (holdP)
    for (const x of listOf(holdP.value)) {
      if (x instanceof Obj && x.kind === HELD) fixedTemps.push(x.fields.spec as unknown as FixedTempSpec);
      else fail(`hold: should list held surfaces like temp(face(plate, -Z), 60C); got ${typeName(x)}`, holdP.span);
    }
  const thermalOn = !!heatP || !!holdP;
  for (const n of HEAT_PROPS) {
    const p = one(n);
    if (p && !thermalOn && n !== "heat" && n !== "hold") fail(`${n}: goes with heat: (where heat is made) or hold: (a surface held at a temperature).`, p.span);
  }
  // ---- touching parts: contacts that press, part and slide, instead of glued ----
  const touchP = one("touching");
  let touching: TouchingSpec | undefined;
  if (touchP) {
    const isName = (x: Value) => x instanceof Ref || (x instanceof Obj && x.kind === "component");
    const nameOf = (x: Value) => (x instanceof Ref ? x.name : String((x as Obj).fields.name));
    const v = touchP.value;
    const pairsT: TouchSpec[] = [];
    let all: TouchingSpec["all"];
    // touching: [lid, box] is one pair; otherwise a list of touch(...) and "all"
    const items: Value[] = Array.isArray(v) && v.length === 2 && v.every(isName) ? [v] : Array.isArray(v) ? v : [v];
    for (const x of items) {
      if (Array.isArray(x) && x.length === 2 && x.every(isName)) pairsT.push({ a: nameOf(x[0]), b: nameOf(x[1]), mu: 0.3, lift: true });
      else if (x === "all") all = { mu: 0.3, lift: true };
      else if (x === "glued" || x === "bonded") continue;
      else if (x instanceof Obj && x.kind === TOUCH) {
        const t = x.fields.spec as unknown as TouchSpec;
        if (t.a === "all") all = { mu: t.mu === "glued" ? 0.3 : t.mu, lift: t.lift };
        else pairsT.push(t);
      } else fail(`touching: lists the parts that touch as contacts instead of glued: touch(lid, box, mu: 0.3), a pair like [lid, box], or "all" for every pair that touches; got ${typeName(x)}`, touchP.span);
    }
    for (const t of pairsT) {
      for (const n of [t.a, t.b]) {
        const k = env.kindOf(n);
        if (k !== "part" && k !== "component") fail(`touching: "${n}" is not a part or component`, touchP.span);
      }
      if (pairsT.filter((q) => (q.a === t.a && q.b === t.b) || (q.a === t.b && q.b === t.a)).length > 1) fail(`touching: ${t.a} and ${t.b} are given twice`, touchP.span);
    }
    if (pairsT.length || all) touching = { pairs: pairsT, ...(all ? { all } : {}) };
  }
  // ---- bolts tightened before the loads ----
  const preP = one("preload");
  let preload: PreloadSpec | undefined;
  if (preP) {
    const bolts: PreloadSpec["bolts"] = [];
    let all: PreloadSpec["all"];
    for (const x of listOf(preP.value)) {
      if (x === "all" || x === true) all = {};
      else if (typeof x === "number") {
        if (!(x > 0)) fail("preload: the tension the bolts are tightened to should be more than 0, like preload: 3kN", preP.span);
        all = { force: x };
      } else if (x instanceof Ref || (x instanceof Obj && x.kind === "component")) bolts.push({ part: x instanceof Ref ? x.name : String(x.fields.name) });
      else if (x instanceof Obj && x.kind === BOLT) {
        const b = x.fields.spec as unknown as PreloadSpec["bolts"][number];
        if (b.part === "all") all = { ...(b.force !== undefined ? { force: b.force } : {}), ...(b.torque !== undefined ? { torque: b.torque } : {}) };
        else bolts.push(b);
      } else fail(`preload: lists the bolts tightened before the loads: a screw's name (as it usually is), bolt(screw_1, 3kN), bolt(screw_1, torque: 2Nm), "all" for every screw and bolt analysed, or a tension like 3kN for all of them; got ${typeName(x)}`, preP.span);
    }
    for (const b of bolts) {
      const k = env.kindOf(b.part);
      if (k !== "part" && k !== "component") fail(`preload: "${b.part}" is not a part or component`, preP.span);
      if (bolts.filter((q) => q.part === b.part).length > 1) fail(`preload: ${b.part} is given twice`, preP.span);
    }
    if (bolts.length || all) preload = { bolts, ...(all ? { all } : {}) };
  }

  const named = new Set<string>();
  for (const t of touching?.pairs ?? []) {
    named.add(t.a);
    named.add(t.b);
  }
  for (const r of [...supports.map((s) => s.region), ...loads.map((l) => l.region), ...masses.map((m) => m.region), ...fixedTemps.map((f) => f.region), ...heatLoads.flatMap((h) => (h.region ? [h.region] : [])), ...currents.flatMap((c) => [c.from, c.to])])
    if (r.t === "face") named.add(r.part);
  for (const h of heatLoads) if (h.part) named.add(h.part);
  // a frame named in face() stands for its members, and a part made in pieces for its pieces
  const namedParts: string[] = [];
  for (const n of named) {
    const members = env.members?.(n);
    if (members) {
      if (!parts.length) namedParts.push(...members.filter((m) => !namedParts.includes(m)));
      else if (members.some((m) => !parts.includes(m))) {
        const frame = env.kindOf(n) === "frame";
        fail(`face(${n}, …) is every ${frame ? `member of the frame ${n}` : `piece of ${n} (it is made in pieces)`}, and parts: leaves some out. Give parts: [${n}], or name single ${frame ? "members" : "pieces"}, like face(${members[0]}, -Z).`, span);
      }
      continue;
    }
    const k = env.kindOf(n);
    if (k !== "part" && k !== "component") fail(`face(${n}, …): "${n}" is not a part or component`, span);
    if (!namedParts.includes(n)) namedParts.push(n);
  }
  if (!parts.length) parts = namedParts;
  else {
    const missing = namedParts.filter((n) => !parts.includes(n));
    if (missing.length) fail(`face(${missing[0]}, …) refers to "${missing[0]}", which is not in parts:. Add it to parts: [${[...parts, missing[0]].join(", ")}].`, span);
  }
  // the bolts preload: names are analysed with the rest
  for (const b of preload?.bolts ?? []) if (!parts.includes(b.part)) parts.push(b.part);
  if (!parts.length) fail("Say which parts to analyse with parts: [name], or use face(part, dir) in fix: or load:", span);

  const gravityOn = bool("gravity");
  const accelP = one("accel");
  let accel: V3 | undefined;
  if (accelP) accel = vec(accelP, "accel: (in g)");
  else if (gravityOn) accel = [0, 0, -1];

  // ---- natural frequencies: on when any of their properties is given ----
  const exP = one("excite");
  const excite: Excitation[] = [];
  if (exP)
    for (const x of listOf(exP.value)) {
      if (x instanceof Obj && x.kind === EXCITE) excite.push(x.fields.spec as unknown as Excitation);
      else if (typeof x === "number" && x > 0) excite.push({ lo: x, hi: x, label: `${Math.round(x * 100) / 100} Hz` });
      else fail(`excite: should list what shakes it: spin(1500rpm), band(20Hz, 60Hz) or a frequency like 50Hz; got ${typeName(x)}`, exP.span);
    }
  const modesP = one("modes");
  const modesN = num("modes", 0);
  if (modesN !== undefined && (!Number.isInteger(modesN) || modesN > 12)) fail("modes: should be a whole number from 1 to 12", modesP!.span);
  const damping = num("damping", 0);
  if (damping !== undefined && damping >= 1) fail("damping: is a fraction of critical damping, like 0.02 (or 2%)", one("damping")!.span);
  const ringing = num("ringing", 0);
  // ---- shaking: a sine sweep or random vibration, answered from the modes (so it turns them on) ----
  const shakeP = one("shake");
  const randomP = one("random");
  let shake: SineSpec | undefined;
  let random: RandomSpec | undefined;
  if (shakeP) {
    const v = shakeP.value;
    if (v instanceof Obj && v.kind === SINE) shake = v.fields.spec as unknown as SineSpec;
    else fail(`shake: should be a sine sweep: sine(10Hz, 500Hz, 2g, Z) shakes the supports at 2 g along Z, sine(20Hz, 200Hz) makes the loads go up and down; got ${typeName(v)}`, shakeP.span);
  }
  if (randomP) {
    const v = randomP.value;
    const preset = typeof v === "string" ? PSD_PRESETS[v.toLowerCase()] : undefined;
    if (v instanceof Obj && v.kind === PSD) random = v.fields.spec as unknown as RandomSpec;
    else if (preset) random = { points: preset.points.map(([f, g]) => [f, g]), dir: [0, 0, 1], label: `${preset.label} (${Math.round(grms(preset.points) * 100) / 100} g rms)` };
    else fail(`random: should be an acceleration spectrum: psd("navmat", Z), psd("truck", Z) or your own points in g²/Hz, like psd([(20Hz, 0.01), (80Hz, 0.04), (350Hz, 0.04), (2000Hz, 0.007)], Z); got ${typeName(v)}`, randomP.span);
  }
  const shakeAt = (shakeP ?? randomP)?.span;
  if (shakeP && randomP) fail("Give shake: (a sine sweep) or random: (random shaking), not both; check each in an analysis of its own.", randomP.span);
  const shaking = !!(shake || random);
  if (shaking) {
    const base = !!random || shake!.accel !== undefined;
    if (base && (loads.length || accelP || gravityOn)) fail("Shaking the supports moves the parts by their own inertia, so leave out load:, gravity and accel:; check the loads in an analysis of their own.", shakeAt!);
    if (!base && !loads.length) fail("A sweep without an acceleration makes the loads go up and down at every frequency, so it needs load:; or shake the supports, like shake: sine(10Hz, 500Hz, 2g, Z).", shakeAt!);
    if (!base && (accelP || gravityOn)) fail("A sweep of the loads makes them go up and down at every frequency, and gravity does not, so leave out gravity and accel: here.", shakeAt!);
    if (supports.some((sp) => sp.move)) fail("displace() pushes a region a set distance and holds it there, which shaking cannot follow; check it in an analysis of its own.", shakeAt!);
    if (modesN !== undefined && modesN < 1) fail("modes: should be a whole number from 1 to 12", modesP!.span);
  }
  const durationP = one("duration");
  let duration: number | undefined;
  if (durationP) {
    if (!shaking) fail("duration: is how long it is shaken; it goes with shake: or random:.", durationP.span);
    if (typeof durationP.value !== "number" || !Number.isFinite(durationP.value) || !(durationP.value > 0)) fail("duration: should be how long it is shaken, like duration: 2h or duration: 30min (a plain number is seconds)", durationP.span);
    duration = durationP.value as number;
    if (one("cycles")) fail("Give duration: (how long it is shaken) or cycles: (how many cycles), not both.", one("cycles")!.span);
  }
  const life = shaking ? shakeLife(one, fail) : {};
  const modal: ModalSpec | undefined =
    modesN !== undefined || exP || damping !== undefined || ringing !== undefined || shaking
      ? {
          modes: modesN ?? (shaking ? 12 : 6),
          excite,
          damping: damping ?? 0.02,
          ringing,
          ...(shake ? { shake } : {}),
          ...(random ? { random } : {}),
          ...(duration !== undefined ? { duration } : {}),
          ...life,
        }
      : undefined;
  /** what the modes are for, in the words a refusal uses */
  const modalName = shaking ? "shaking" : "natural frequencies";

  // ---- drops, knocks and tip-overs: held only by the floor it lands on ----
  const dropP = one("drop");
  const tipP = one("tip");
  const impactP = one("impact");
  const ontoP = one("onto");
  let drop: DropSpec | undefined;
  if (dropP && tipP) fail("Give drop: (a fall height) or tip: (the way it tips over), not both. Use two analyses to check both.", tipP.span);
  if (!dropP && !tipP && (impactP || ontoP)) fail(`${impactP ? "impact" : "onto"}: goes with drop: or tip:`, (impactP ?? ontoP)!.span);
  if (dropP || tipP) {
    const at = (dropP ?? tipP)!.span;
    if (impactP && tipP) fail("impact: is for drop:. A tip-over lands on the side tip: names.", impactP.span);
    if (supports.length) fail("A drop or tip-over is held only by the floor it lands on, so leave out fix:.", at);
    if (loads.length || accelP || gravityOn) fail("A drop works out its own forces from the fall, so leave out load:, gravity and accel:. Put those in a separate analysis.", at);
    if (modal) fail(`Check ${modalName} in a separate analysis from the drop.`, at);
    let floorKey = "concrete";
    if (ontoP) {
      if (typeof ontoP.value !== "string" || !FLOORS[ontoP.value]) fail(`onto: should be one of ${Object.keys(FLOORS).map((k) => `"${k}"`).join(", ")}`, ontoP.span);
      floorKey = ontoP.value;
    }
    let dir: V3;
    if (tipP) {
      dir = vec(tipP, "tip: (the way it falls over)");
      if (Math.abs(dir[2]) > 1e-6 || Math.hypot(dir[0], dir[1]) < 1e-9) fail("tip: should be a sideways direction like +X: the way it falls over", tipP.span);
    } else {
      dir = impactP ? vec(impactP, "impact: (the way it moves into the floor)") : [0, 0, -1];
      if (Math.hypot(...dir) < 1e-9) fail("impact: must be a direction like -Z", impactP!.span);
    }
    const n = Math.hypot(...dir);
    dir = clean([dir[0] / n, dir[1] / n, dir[2] / n]);
    drop = { height: dropP ? num("drop", 0) : undefined, tip: !!tipP, dir, floor: FLOORS[floorKey] };
    supports.push({ region: { t: "extreme", dir } });
    accel = dir;
  }

  // ---- cooling, and the rest of the heat set-up ----
  let thermal: ThermalSpec | undefined;
  const plain = (name: string, what: string, check?: (v: number) => boolean): number | undefined => {
    const p = one(name);
    if (!p) return undefined;
    if (typeof p.value !== "number" || !Number.isFinite(p.value) || (check && !check(p.value))) fail(`${name}: should be ${what}`, p.span);
    return p.value as number;
  };
  const emissivity = plain("emissivity", "a number from 0 to 1 (0.9 for paint, plastics and anodised metal, 0.1 for bare polished metal)", (v) => v >= 0 && v <= 1);
  if (thermalOn) {
    if (drop) fail("Check heat in a separate analysis from the drop.", (heatP ?? holdP)!.span);
    if (modal) fail(`Check ${modalName} in a separate analysis from heat.`, (heatP ?? holdP)!.span);
    let cooling: number = emissivity !== undefined ? COOLING["still air"].conv : COOLING["still air"].h;
    let coolingText = COOLING["still air"].text;
    const films: FilmSpec[] = [];
    if (coolP)
      for (const x of listOf(coolP.value)) {
        if (typeof x === "string") {
          const c = COOLING[x.toLowerCase()];
          if (!c) fail(`cooling: "${x}" is not one Kerf knows: use ${Object.keys(COOLING).map((k) => `"${k}"`).join(", ")}, or a film coefficient in W/m²K like cooling: 25`, coolP.span);
          cooling = emissivity !== undefined ? c.conv : c.h;
          coolingText = c.text;
        } else if (typeof x === "number") {
          if (!(x >= 0) || !Number.isFinite(x)) fail("cooling: a film coefficient should be 0 or more, in W/m²K", coolP.span);
          cooling = x;
          coolingText = `a film coefficient of ${Math.round(x * 10) / 10} W/m²K`;
        } else if (x instanceof Obj && x.kind === FILM) {
          const f = x.fields.spec as unknown as FilmSpec;
          films.push(emissivity !== undefined && f.conv !== undefined ? { ...f, h: f.conv } : f);
        } else fail(`cooling: should be how the surface is cooled ("still air", "fan", "water", a number in W/m²K) and any film(...) for parts of it; got ${typeName(x)}`, coolP.span);
      }
    const time = plain("time", "how long it warms up for, like time: 10min (a plain number is seconds)", (v) => v > 0);
    const startT = plain("start", "the temperature everything starts at, like start: 20C");
    const ambient = plain("ambient", "the surrounding air temperature, like ambient: 30C", (v) => v > -273.15);
    const maxTemp = plain("max_temp", "the highest temperature allowed, like max_temp: 80C", (v) => v > -273.15);
    if (startT !== undefined && time === undefined) fail("start: is the temperature a warm-up starts at; give time: too, like time: 10min", one("start")!.span);
    thermal = {
      heat: heatLoads,
      ...(currents.length ? { currents } : {}),
      auto,
      fixed: fixedTemps,
      cooling,
      coolingText,
      films,
      ...(ambient !== undefined ? { ambient } : {}),
      ...(emissivity !== undefined ? { emissivity } : {}),
      ...(time !== undefined ? { time } : {}),
      ...(startT !== undefined ? { start: startT } : {}),
      ...(maxTemp !== undefined ? { maxTemp } : {}),
    };
    if (!heatLoads.length && !currents.length && !auto && !fixedTemps.length) fail('heat: lists no heat sources; add source(part, watts), current(from, to, amps) or "auto"', heatP!.span);
  } else if (emissivity !== undefined) fail("emissivity: goes with heat: (radiation from a hot surface).", one("emissivity")!.span);

  // ---- one temperature for the whole model: expansion against the supports ----
  const uniformTemp = plain("temperature", "the temperature of the whole model, like temperature: 60C", (v) => v > -273.15);
  const refTemp = plain("assembled_at", "the temperature it is made and assembled at, like assembled_at: 20C", (v) => v > -273.15);
  if (uniformTemp !== undefined && thermalOn) fail("temperature: sets the whole model to one temperature, while heat: and hold: work the temperatures out. Use one or the other.", one("temperature")!.span);
  if (uniformTemp !== undefined && !supports.length) fail("temperature: stresses the parts against their supports as they expand; add fix: to say how they are held.", one("temperature")!.span);
  if (uniformTemp !== undefined && drop) fail("Check a set temperature in a separate analysis from the drop.", one("temperature")!.span);
  if (refTemp !== undefined && uniformTemp === undefined && !(thermalOn && supports.length)) fail("assembled_at: is the temperature with no thermal stress; it goes with temperature: or with heat: and fix:.", one("assembled_at")!.span);

  // ---- fatigue: how the loads repeat over the part's life ----
  const fatigue = buildFatigue(props, one, fail, span, { drop: !!drop, modal: !!modal, heat: thermalOn || uniformTemp !== undefined, shaking });

  // ---- buckling: how many times the loads it takes to buckle the parts ----
  const buckP = one("buckling");
  let buckling: BucklingSpec | undefined;
  if (buckP || flags.some((f) => f.name === "buckling")) {
    const at = buckP?.span ?? flags.find((f) => f.name === "buckling")!.span;
    let modes = 3;
    if (buckP) {
      if (typeof buckP.value !== "number" || !Number.isInteger(buckP.value) || buckP.value < 1 || buckP.value > 6) fail("buckling: should be how many buckled shapes to find, 1 to 6 (or write buckling on its own for 3)", buckP.span);
      modes = buckP.value as number;
    }
    if (modal || drop) fail(`Check buckling in a separate analysis from the ${modal ? modalName : "drop"}.`, at);
    if (!loads.length && !accel && !thermalOn && uniformTemp === undefined && !supports.some((s) => s.move)) fail("buckling needs loads to scale: add load: (or gravity) for what presses on the parts.", at);
    buckling = { modes, safety: plain("buckling_safety", "the lowest buckling factor wanted, like buckling_safety: 3", (v) => v >= 1) ?? 3 };
  } else if (one("buckling_safety")) fail("buckling_safety: goes with buckling.", one("buckling_safety")!.span);

  // ---- topology optimisation: on its own, with the loads it must carry ----
  const topology = buildTopology(props, one, fail, env, parts, {
    with: drop ? "the drop" : modal ? `the ${modalName}` : thermalOn ? "heat" : uniformTemp !== undefined ? "a set temperature" : buckling ? "buckling" : fatigue ? "fatigue" : flags.some((f) => f.name === "converge") ? "the accuracy check (converge)" : undefined,
    loads: loads.length,
    moved: supports.some((s) => s.move),
  });

  if (touching) {
    const other = modal ? modalName : drop ? "a drop" : buckling ? "buckling" : fatigue ? "fatigue" : topology ? "topology optimisation" : null;
    if (other) fail(`touching: lets touching parts press, part and slide under the loads, which ${other} cannot follow. Check ${other} with the parts glued, in an analysis of its own.`, touchP!.span);
    if (parts.length < 2) fail("touching: needs two or more analysed parts that touch; list them in parts:", touchP!.span);
  }
  if (preload) {
    const other = modal ? modalName : drop ? "a drop" : buckling ? "buckling" : fatigue ? "fatigue" : topology ? "topology optimisation" : null;
    if (other) fail(`preload: tightens the bolts so the parts they clamp press together, part and slide, which ${other} cannot follow. Check ${other} in an analysis of its own.`, preP!.span);
  }
  // ---- large deflection: parts that bend and turn far (snap fits, flexures, springs, straps that stretch as they sag) ----
  const large = bool("large_deflection");
  if (large) {
    const at = (one("large_deflection") ?? flags.find((f) => f.name === "large_deflection"))!.span;
    const other = modal ? modalName : drop ? "a drop" : buckling ? "buckling" : fatigue ? "fatigue" : topology ? "topology optimisation" : touching ? "touching parts" : preload ? "tightened bolts" : thermalOn || uniformTemp !== undefined ? "temperatures" : null;
    if (other) fail(`large_deflection solves the parts bending and turning far under the loads as given, which ${other} cannot follow yet. Check ${other} in an analysis of its own.`, at);
  }
  if (supports.length + loads.length > MAX_BOUNDARY_ITEMS) fail(`An analysis takes at most ${MAX_BOUNDARY_ITEMS} supports and loads together; this one has ${supports.length + loads.length}. Combine regions, for example one zone() covering a row of holes.`, span);
  if (!supports.length && !thermalOn)
    fail('Add fix: to say how the part is held, for example fix: face(bracket, -Y). A part that only rests on a surface can use roller(face(part, -Z), Z) plus one fixed point. For a fall use drop: 1m or tip: +X instead; for temperatures alone use heat:.', span);
  const moved = supports.some((s) => s.move);
  if (!loads.length && !accel && !modal && !thermalOn && uniformTemp === undefined && !moved)
    fail("Add load: force(...), pressure(...) or torque(...), or gravity, so there is something to analyse; or displace(...) in fix: to push a region a set distance, excite: or modes: for natural frequencies, or heat: for temperatures.", span);
  if (supports.length && supports.every((s) => s.move))
    fail("displace() pushes a region and holds it there, but nothing else holds the part, so it would just move along with it. Add where it is held to fix:, like fix: [face(hook, -Y), displace(face(hook, +Z), 1mm, dir: -Z)].", span);

  const matP = one("material");
  let material: string | undefined;
  if (matP) {
    if (typeof matP.value !== "string") fail("material: should be a material name in quotes", matP.span);
    material = matP.value;
    if (mechMaterial(material).assumed) fail(`material: no strength data for "${material}". Known: ${Object.keys(MECH).join(", ")}.`, matP.span);
  }

  const buildP = one("build");
  const buildDir = buildP ? vec(buildP, "build: (the direction layers stack in)") : ([0, 0, 1] as V3);
  if (Math.hypot(...buildDir) < 1e-9) fail("build: must be a direction like Z", buildP!.span);

  const resP = one("resolution");
  // frequencies only need the overall stiffness and mass, so a quick mesh does unless loads need stresses too
  let resolution: Resolution = modal && !shaking && !loads.length && !accel ? "draft" : "standard";
  if (resP) {
    if (resP.value === "draft" || resP.value === "standard" || resP.value === "fine") resolution = resP.value;
    else if (typeof resP.value === "number" && resP.value >= MIN_ELEMENT_SIZE) resolution = { h: resP.value };
    else if (typeof resP.value === "number") fail(`resolution: the element size must be at least ${MIN_ELEMENT_SIZE}mm`, resP.span);
    else fail('resolution: should be "draft", "standard", "fine" or an element size like 0.8mm', resP.span);
  }
  // ---- elements: frame members as beams (the default for a frame on its own), thin walls as shells (the default for
  // carbon layups and sheet metal on their own), or the real shape as solids ----
  const elemP = one("elements");
  let elements: "beams" | "solid" | "shells" | undefined;
  if (elemP) {
    const v = typeof elemP.value === "string" ? elemP.value.toLowerCase() : "";
    if (v === "beams" || v === "beam") elements = "beams";
    else if (v === "solid" || v === "solids") elements = "solid";
    else if (v === "shells" || v === "shell") elements = "shells";
    else
      fail(
        'elements: should be "beams" (frame members as beams through their joints: quick, and exact for slender members), "shells" (thin walls as their surface: carbon layups, sheet metal, thin moulded walls) or "solid" (the real shape in small cubes, for joints, holes and short stubby parts)',
        elemP.span,
      );
    if (elements === "beams" || elements === "shells") {
      const other = modal ? modalName : drop ? "a drop" : thermalOn || uniformTemp !== undefined ? "temperatures" : fatigue ? "fatigue" : topology ? "topology optimisation" : touching ? "touching parts" : preload ? "tightened bolts" : large ? "large deflection" : null;
      if (other) fail(`elements: "${elements}" cannot follow ${other} yet; use elements: "solid" for it.`, elemP.span);
    }
  }
  // ---- composite plies for the carbon layups (as shells), and where their 0° runs ----
  const layupP = one("layup");
  let layup: PliesSpec[] | undefined;
  if (layupP) {
    layup = [];
    for (const x of listOf(layupP.value)) {
      if (x instanceof Obj && x.kind === PLIES) layup.push(x.fields.spec as unknown as PliesSpec);
      else
        fail(
          `layup: should be plies("[0/±45/90]s"), or a list of them laid from the outside in, like [plies("0", "carbon woven"), plies("[0/±45/90]s"), plies("[0/90]2", zone: zone(at: (0, 0, 0), r: 45))]; got ${typeName(x)}`,
          layupP.span,
        );
    }
    if (elements === "solid" || elements === "beams") fail(`layup: gives the plies of carbon layups analysed as shells; elements: "${elements}" cannot follow them. Leave elements: out.`, layupP.span);
    const other = modal ? modalName : drop ? "a drop" : thermalOn || uniformTemp !== undefined ? "temperatures" : fatigue ? "fatigue" : topology ? "topology optimisation" : touching ? "touching parts" : preload ? "tightened bolts" : large ? "large deflection" : null;
    if (other) fail(`layup: needs the layups analysed as shells, which cannot follow ${other} yet; check the plies in an analysis without it.`, layupP.span);
    if (layup.every((l) => l.zone)) fail('layup: has only zones\' plies, which go inside a stack: give the stack too, like layup: [plies("[0/±45/90]s"), plies("[0/90]", zone: zone(at: (0, 0, 0), r: 45))].', layupP.span);
  }
  const fibreP = one("fibre") ?? one("fiber");
  if (one("fibre") && one("fiber")) fail('Give fibre: once (fiber: is the same).', one("fiber")!.span);
  let fibre: StructuralFibre | undefined;
  if (fibreP) {
    if (!layupP) fail('fibre: says where the plies\' 0° runs; give the plies too, like layup: plies("[0/±45/90]s").', fibreP.span);
    const v = fibreP.value;
    const word = typeof v === "string" ? v.toLowerCase() : "";
    if (word === "auto") fibre = "auto";
    else if (word === "tubes" || word === "tube" || word === "along") fibre = "tubes";
    else if (v instanceof Vec) {
      const d = vec(fibreP, "fibre:");
      if (!(Math.hypot(...d) > 1e-9)) fail("fibre: should be a direction that is not zero, like X or (1, 1, 0)", fibreP.span);
      fibre = clean(norm3(d));
    } else fail('fibre: should be "tubes" (0° along each tube), "auto" (along the tubes on a part made of tubes, else along its length) or a direction like X, laid onto the wall', fibreP.span);
  }
  const cycles = num("cycles", 0);
  return {
    kind: "structural",
    label,
    parts,
    supports,
    loads,
    accel,
    material,
    safety: safetyGiven ?? (drop || shaking ? 1.5 : 2),
    maxDeflection: num("max_deflection", 0),
    cycles,
    printed: bool("printed"),
    buildDir,
    ...(buildP ? { buildGiven: true } : {}),
    resolution,
    ...(masses.length ? { masses } : {}),
    ...(modal ? { modal } : {}),
    ...(drop ? { drop } : {}),
    ...(thermal ? { thermal } : {}),
    ...(uniformTemp !== undefined ? { uniformTemp } : {}),
    ...(refTemp !== undefined ? { refTemp } : {}),
    ...(buckling ? { buckling } : {}),
    ...(fatigue ? { fatigue } : {}),
    ...(flags.some((f) => f.name === "converge") ? { converge: true } : {}),
    ...(large !== undefined ? { large } : {}),
    ...(elements ? { elements } : {}),
    ...(layup ? { layup } : {}),
    ...(fibre ? { fibre } : {}),
    ...(topology ? { topology } : {}),
    ...(touching ? { touching } : {}),
    ...(preload ? { preload } : {}),
    span,
  };
}

type StructuralFibre = "auto" | "tubes" | V3;

const AXES = ["X", "Y", "Z"] as const;

/** An axis named by a direction (X, -Y) or its letter ("Z"); null when it is neither. */
function axisOf(v: Value): "X" | "Y" | "Z" | null {
  if (typeof v === "string") {
    const k = v.trim().toUpperCase().replace(/^[+-]/, "");
    return (AXES as readonly string[]).includes(k) ? (k as "X" | "Y" | "Z") : null;
  }
  if (v instanceof Vec) {
    const a = v.v.map((x) => Math.abs(x ?? 0));
    const big = a.indexOf(Math.max(...a));
    if (big < 0 || !(a[big] > 0)) return null;
    // along one axis only
    return a.every((x, i) => i === big || x < 1e-9 * a[big]) ? AXES[big] : null;
  }
  return null;
}

/**
 * Topology optimisation from topology: (the share of the material to keep), with what it must keep (preserve:), the
 * thinnest member (min_member:), mirror planes (symmetry:), a profile cut from plate (extrusion:) and how long it may run
 * (iterations:). undefined when the analysis has none of these.
 */
function buildTopology(
  props: AnalysisItem[],
  one: (name: string) => AnalysisItem | undefined,
  fail: (msg: string, span: Span) => never,
  env: AnalysisEnv,
  parts: string[],
  other: { with?: string; loads: number; moved: boolean },
): TopologySpec | undefined {
  const tp = one("topology");
  if (!tp) {
    for (const n of TOPOLOGY_PROPS) {
      const p = one(n);
      if (p) fail(`${n}: goes with topology: (the share of the material to keep, like topology: 35%).`, p.span);
    }
    return undefined;
  }
  if (typeof tp.value !== "number" || !(tp.value >= 0.05 && tp.value <= 0.95))
    fail("topology: is the share of the parts' material to keep, from 5% to 95%, like topology: 35%", tp.span);
  const keep = tp.value as number;
  if (other.with) fail(`Find the shape in an analysis of its own: topology: goes with fix: and load:, not with ${other.with}. Check that in a second analysis.`, tp.span);
  if (!other.loads) fail("topology: finds the shape that carries the loads best, so it needs load: (what the shape must carry). Gravity alone moves with the material, so give it as a load too.", tp.span);
  if (other.moved) fail("topology: finds the stiffest shape under loads; a displace() support sets a movement instead. Use load: force(...) for what pushes on it.", tp.span);
  const preserve: RegionSpec[] = [];
  const preserveParts: string[] = [];
  const pres = one("preserve");
  if (pres)
    for (const x of Array.isArray(pres.value) ? pres.value.flat() : [pres.value]) {
      if (x instanceof Obj && x.kind === REGION) preserve.push(x.fields.spec as unknown as RegionSpec);
      else if (x instanceof Ref || (x instanceof Obj && x.kind === "component")) {
        const n = x instanceof Ref ? x.name : String(x.fields.name);
        const k = env.kindOf(n);
        if (k !== "part" && k !== "component") fail(`preserve: "${n}" is not a part or component`, pres.span);
        if (!parts.includes(n)) fail(`preserve: ${n} is not one of the analysed parts (${parts.join(", ")}). Add it to parts: to keep it as it is in the shape.`, pres.span);
        if (!preserveParts.includes(n)) preserveParts.push(n);
      } else fail(`preserve: should list what the shape must keep: regions like zone(at: (10, 0, 5), r: 4) or face(bracket, +Z), or whole parts; got ${typeName(x)}`, pres.span);
    }
  if (preserveParts.length && preserveParts.length >= parts.length) fail("preserve: keeps every analysed part as it is, so there is nothing left to shape. Leave out the part to reshape.", pres!.span);
  let minMember: number | undefined;
  const mm = one("min_member");
  if (mm) {
    if (typeof mm.value !== "number" || !(mm.value > 0)) fail("min_member: the thinnest member the shape may have, like min_member: 4mm", mm.span);
    minMember = mm.value as number;
  }
  const symmetry: ("X" | "Y" | "Z")[] = [];
  const sym = one("symmetry");
  if (sym)
    for (const x of Array.isArray(sym.value) ? sym.value.flat() : [sym.value]) {
      const a = axisOf(x);
      if (!a) fail(`symmetry: should name the axes across the mirror planes, like symmetry: X or symmetry: [X, Z] (the planes go through the middle of the parts); got ${typeName(x)}`, sym.span);
      if (!symmetry.includes(a)) symmetry.push(a);
    }
  let cut: "X" | "Y" | "Z" | undefined;
  const cp = one("extrusion");
  if (cp) {
    const a = axisOf(cp.value);
    if (!a) fail("extrusion: the axis the shape runs straight through along, the same all the way, like extrusion: Y for a profile cut from plate lying in X and Z", cp.span);
    cut = a;
  }
  let iterations: number | undefined;
  const ip = one("iterations");
  if (ip) {
    if (typeof ip.value !== "number" || !Number.isInteger(ip.value) || ip.value < 5 || ip.value > 300) fail("iterations: the most design steps to take, a whole number from 5 to 300 (default 80; most shapes settle in 30 to 60)", ip.span);
    iterations = ip.value as number;
  }
  return { keep, preserve, preserveParts, ...(minMember !== undefined ? { minMember } : {}), symmetry, ...(cut ? { cut } : {}), ...(iterations !== undefined ? { iterations } : {}) };
}

const LOADING_WORDS: Record<string, number> = {
  reversed: -1,
  "fully reversed": -1,
  alternating: -1,
  "on-off": 0,
  "on off": 0,
  pulsating: 0,
  "zero-based": 0,
  "zero based": 0,
  repeated: 0,
};

const loadingText = (R: number) => (R === -1 ? "fully reversed (−1 to 1× the loads)" : R === 0 ? "on-off (0 to 1× the loads)" : `between ${fmtR(R)} and 1× the loads (R = ${fmtR(R)})`);
const fmtR = (v: number) => String(Math.round(v * 1000) / 1000).replace("-", "−");

/** finish: the surface a part is made with, for its S-N curve (unset: from how each part is made). */
function finishOf(finP: AnalysisItem | undefined, fail: (msg: string, span: Span) => never): Finish | undefined {
  if (!finP) return undefined;
  const v = typeof finP.value === "string" ? finP.value.toLowerCase().replace(/^as[- ]/, "") : "";
  const key = v === "rolled" ? "hot-rolled" : v;
  if (!Object.hasOwn(FINISHES, key)) fail(`finish: the surface it is made with, one of ${Object.keys(FINISHES).map((k) => `"${k}"`).join(", ")}; leave it out to take it from how each part is made`, finP.span);
  return key as Finish;
}

/** reliability: the chance it lasts the life (default 50 %, the average part). */
function reliabilityOf(relP: AnalysisItem | undefined, fail: (msg: string, span: Span) => never): number {
  if (!relP) return 0.5;
  if (typeof relP.value !== "number" || !(relP.value >= 0.5 && relP.value < 1)) fail("reliability: the chance it lasts the life, from 50% (the average part) to 99.99%, like reliability: 99%", relP.span);
  return relP.value as number;
}

/** Shaking's fatigue: the finish: and reliability: given with it. */
function shakeLife(one: (name: string) => AnalysisItem | undefined, fail: (msg: string, span: Span) => never): { finish?: Finish; reliability?: number } {
  const finish = finishOf(one("finish"), fail);
  const relP = one("reliability");
  return { ...(finish ? { finish } : {}), ...(relP ? { reliability: reliabilityOf(relP, fail) } : {}) };
}

/**
 * Fatigue from cycles: (constant amplitude), history: (load blocks or a trace of load scales, rainflow counted) and how
 * the loads repeat. undefined when the analysis has no fatigue: cycles: up to 1000 alone keeps the static check.
 */
function buildFatigue(
  props: AnalysisItem[],
  one: (name: string) => AnalysisItem | undefined,
  fail: (msg: string, span: Span) => never,
  span: Span,
  other: { drop: boolean; modal: boolean; heat: boolean; shaking?: boolean },
): FatigueSpec | undefined {
  const cyclesP = one("cycles");
  const histP = one("history");
  const repP = one("repeats");
  const loadP = one("loading");
  const meanP = one("mean_stress");
  const finP = one("finish");
  const relP = one("reliability");
  // shaking makes its own cycles from the frequencies; its finish: and reliability: are read with it
  if (other.shaking) {
    const bad = [histP, repP, loadP, meanP].find((p): p is AnalysisItem => !!p);
    if (bad) fail(`${bad.name}: describes a history of loads; shaking makes its own cycles from the frequencies (and duration:), so check a load history in an analysis of its own.`, bad.span);
    return undefined;
  }
  const extras = [loadP, meanP, finP, relP].filter((p): p is AnalysisItem => !!p);
  const cycles = cyclesP && typeof cyclesP.value === "number" ? cyclesP.value : undefined;
  if (!histP && !extras.length && !(cycles !== undefined && cycles > 1000)) {
    if (repP) fail("repeats: is how many times a history: happens in the part's life; give history: too.", repP.span);
    return undefined;
  }
  // a drop, the natural frequencies or heat with only a cycle count keep the fatigue strength as their allowable
  if (!histP && !extras.length && (other.drop || other.modal || other.heat)) return undefined;
  if (!histP && cycles === undefined) fail(`${extras[0]!.name}: goes with cycles: (how many load cycles the part sees in its life, like cycles: 1e6) or history: (a list of load blocks or load scales).`, extras[0]!.span);
  if (histP && cyclesP) fail("With history:, the counts are in the history. Leave out cycles: and use repeats: for how many times the history happens in the part's life.", cyclesP.span);
  if (repP && !histP) fail("repeats: goes with history:; for a constant load cycle give its count with cycles:.", repP.span);
  const at = (histP ?? cyclesP ?? extras[0])!.span;
  if (other.drop || other.modal || other.heat) fail(`Check fatigue in a separate analysis from the ${other.drop ? "drop" : other.modal ? "natural frequencies" : "heat and temperatures"}.`, at);

  // how the loads repeat: R = min/max of each cycle
  let R = -1;
  if (loadP) {
    if (typeof loadP.value === "number") {
      R = loadP.value;
      if (!(R < 1) || R < -5) fail("loading: as a number is the load ratio R = min/max of each cycle, below 1: -1 fully reversed, 0 on-off, 0.5 between half and full load", loadP.span);
    } else if (typeof loadP.value === "string" && Object.hasOwn(LOADING_WORDS, loadP.value.toLowerCase())) R = LOADING_WORDS[loadP.value.toLowerCase()];
    else fail('loading: should be "reversed" (the loads swing both ways, the default), "on-off" (from nothing to the loads) or a load ratio R = min/max like 0.2', loadP.span);
  }
  let meanStress: MeanStress = "goodman";
  if (meanP) {
    const v = typeof meanP.value === "string" ? meanP.value.toLowerCase() : "";
    if (!Object.hasOwn(MEAN_STRESS, v)) fail(`mean_stress: should be one of ${Object.keys(MEAN_STRESS).map((k) => `"${k}"`).join(", ")} (Goodman is the usual, safe choice)`, meanP.span);
    meanStress = v as MeanStress;
  }
  const finish = finishOf(finP, fail);
  const reliability = reliabilityOf(relP, fail);

  if (!histP) {
    const n = cycles!;
    if (!(n >= 1)) fail("cycles: should be 1 or more", cyclesP!.span);
    return { cycles: [{ max: 1, min: R, count: n }], repeats: 1, unit: "cycles", loading: loadingText(R), meanStress, ...(finish ? { finish } : {}), reliability, source: "constant" };
  }
  let repeats = 1;
  if (repP) {
    if (typeof repP.value !== "number" || !(repP.value >= 1)) fail("repeats: how many times the history happens in the part's life, 1 or more", repP.span);
    repeats = repP.value as number;
  }
  const list = Array.isArray(histP.value) ? histP.value : [histP.value];
  if (!list.length) fail("history: is empty", histP.span);
  if (list.every((x) => typeof x === "number")) {
    const trace = list as number[];
    if (trace.length < 2) fail("history: as numbers is a trace of the load over time (scales of the loads as written), like [0, 1, 0.2, 0.8, 0]; give at least two", histP.span);
    if (trace.some((v) => !Number.isFinite(v))) fail("history: the values should be numbers", histP.span);
    const counted = rainflow(trace, true);
    if (!counted.length) fail("history: the trace never changes, so there are no load cycles in it", histP.span);
    return { cycles: counted, repeats, unit: "repeats", loading: `a load trace of ${trace.length} points (${counted.reduce((a, c) => a + c.count, 0)} cycles counted by rainflow)`, meanStress, ...(finish ? { finish } : {}), reliability, source: "trace", trace };
  }
  const blocks: LoadCycle[] = [];
  for (const x of list) {
    if (!(x instanceof Obj) || x.kind !== BLOCK) fail(`history: should list load blocks like block(1e5, 1.5) or be a trace of load scales like [0, 1, 0.3, 1]; got ${typeName(x)}`, histP.span);
    const b = (x as Obj).fields.spec as unknown as { count: number; peak: number; min?: number };
    const lo = b.min ?? R * b.peak;
    blocks.push({ max: Math.max(b.peak, lo), min: Math.min(b.peak, lo), count: b.count });
  }
  return {
    cycles: mergeCycles(blocks),
    repeats,
    unit: "repeats",
    loading: `${blocks.length} load block${blocks.length > 1 ? "s" : ""}${loadP ? `, ${loadingText(R).replace(/ \(.*$/, "")} unless a block gives its min:` : ""}`,
    meanStress,
    ...(finish ? { finish } : {}),
    reliability,
    source: "blocks",
  };
}

/** A UCI rules check: names the bike's wheels, saddle and bars and where its bottom bracket is. */
function buildUci(label: string, props: AnalysisItem[], flags: AnalysisItem[], span: Span, env: AnalysisEnv): AnalysisSpec {
  const fail = env.fail;
  for (const p of props) if (!UCI_PROPS.includes(p.name)) fail(`"${p.name}:" is not part of a UCI rules check, which takes ${UCI_PROPS.join(", ")}`, p.span);
  for (const f of flags) fail(`A UCI rules check takes no flags ("${f.name}")`, f.span);
  const one = (name: string) => {
    const all = props.filter((p) => p.name === name);
    if (all.length > 1) fail(`"${name}:" is given twice`, all[1].span);
    return all[0];
  };
  const nameOf = (v: Value, p: AnalysisItem, what: string): string => {
    const n = v instanceof Ref ? v.name : v instanceof Obj && v.kind === "component" && typeof v.fields.name === "string" ? v.fields.name : undefined;
    if (!n || !env.kindOf(n)) return fail(`${what} should name a part or component, got ${typeName(v)}`, p.span);
    return n;
  };
  const need = (name: string, example: string) => one(name) ?? fail(`A UCI rules check needs ${name}: (${example})`, span);
  const list = (name: string, count?: number) => {
    const p = one(name);
    if (!p) return undefined;
    const v = Array.isArray(p.value) ? p.value : [p.value];
    if (count !== undefined && v.length !== count) fail(`${name}: should list ${count} parts`, p.span);
    return v.map((x) => nameOf(x, p, `${name}:`));
  };
  const rules = one("uci")!;
  if (rules.value !== "road") fail('uci: "road" is the rule set Kerf checks (UCI mass-start road racing, technical regulation part 1.3)', rules.span);
  const bbP = need("bottom_bracket", "the crank axle's centre as a point, or the crankset that turns about it");
  const bb = bbP.value instanceof Vec ? { at: [bbP.value.v[0], bbP.value.v[1], bbP.value.v[2] ?? 0] as V3 } : { part: nameOf(bbP.value, bbP, "bottom_bracket:") };
  need("wheels", "wheels: [front_wheel, rear_wheel]");
  const wheels = list("wheels", 2)!;
  const saddle = nameOf(need("saddle", "the saddle part").value, one("saddle")!, "saddle:");
  const bars = nameOf(need("bars", "the handlebar or one-piece bar and stem").value, one("bars")!, "bars:");
  const hoods = list("hoods", 2);
  const fw = one("forward");
  let forward: V3 = [1, 0, 0];
  if (fw) {
    if (!(fw.value instanceof Vec)) fail("forward: the way the bike rides, like forward: X", fw.span);
    const v = (fw.value as Vec).v;
    const h = Math.hypot(v[0], v[1]);
    if (h < 1e-6) fail("forward: should be level, like X or -Y", fw.span);
    forward = [v[0] / h, v[1] / h, 0];
  }
  const parts = list("parts");
  const rim = one("rim_depth");
  if (rim && !(typeof rim.value === "number" && rim.value > 0)) fail("rim_depth: the rims' depth, like rim_depth: 50mm", rim.span);
  return { kind: "uci", label, rules: "road", bb, wheels, saddle, bars, hoods, forward, parts, ...(rim ? { rimDepth: rim.value as number } : {}), span };
}
