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
//   analysis "Gearbox duty" {
//     drive: motor_gear
//     torque: 0.3Nm
//     speed: 3000rpm
//     life: 2000h
//   }

import { Args } from "../lang/args";
import { Fn, Obj, Ref, Vec, typeName, type Value } from "../lang/values";
import type { Span } from "../lang/ast";
import type { AnalysisSpec, BucklingSpec, DropSpec, Excitation, FilmSpec, FixedTempSpec, HeatLoadSpec, LoadSpec, MassSpec, ModalSpec, RegionSpec, Resolution, SupportSpec, ThermalSpec, V3 } from "./spec";
import { MECH, mechMaterial } from "./materials";
import { FLOORS, MIN_ELEMENT_SIZE } from "./spec";
import { COOLING } from "./thermalMaterials";
import { buildAirflow } from "./aeroLang";
import { buildStudy } from "./studyLang";

/** supports plus loads in one analysis: each one is a pass over the model's surface */
export const MAX_BOUNDARY_ITEMS = 200;

/** heat: where heat is made and how the parts are cooled; with fix: the temperatures then load the structure */
export const HEAT_PROPS = ["heat", "hold", "cooling", "ambient", "emissivity", "time", "start", "max_temp"];
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
  "safety",
  "max_deflection",
  "resolution",
  "carries",
  "modes",
  "excite",
  "damping",
  "ringing",
  "drop",
  "tip",
  "impact",
  "onto",
  ...HEAT_PROPS,
  "temperature",
  "assembled_at",
  "buckling",
  "buckling_safety",
];
export const DRIVETRAIN_PROPS = ["drive", "torque", "speed", "life", "safety"];
export const UCI_PROPS = ["uci", "bottom_bracket", "wheels", "saddle", "bars", "hoods", "forward", "parts", "rim_depth"];
const FLAGS = ["gravity", "printed", "locked", "buckling", "converge"];

const REGION = "region";
const LOAD = "load";
const SUPPORT = "support";
const MASS = "mass";
const EXCITE = "excitation";
const HEAT = "heat source";
const HELD = "held temperature";
const FILM = "film";

function def(name: string, params: string[], impl: (a: Args) => Value, doc: string): [string, Fn] {
  return [name, new Fn(name, (pos, named, ctx) => impl(new Args(name, pos, named, ctx, params)), doc)];
}

function refName(v: Value | undefined, a: Args, what: string): string {
  if (v instanceof Ref) return v.name;
  if (v instanceof Obj && v.kind === "component" && typeof v.fields.name === "string") return v.fields.name;
  if (typeof v === "string") return v;
  return a.ctx.error(`${a.fname}(): ${what} should be a part or component name, got ${v === undefined ? "nothing" : typeName(v)}`);
}

function region(v: Value | undefined, a: Args): RegionSpec {
  if (v instanceof Obj && v.kind === REGION) return v.fields.spec as unknown as RegionSpec;
  return a.ctx.error(`${a.fname}(): the first argument should say where it acts, like face(bracket, -Y) or zone(at: (0, 0, 5), r: 3); got ${v === undefined ? "nothing" : typeName(v)}`);
}

const wrap = (kind: string, spec: unknown, label: string) => new Obj({ spec: spec as Value }, kind, label);
/** -Y evaluates to (-0, -1, -0); store plain zeros */
const clean = (v: V3): V3 => [v[0] || 0, v[1] || 0, v[2] || 0];

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
    ["at", "r", "size", "d", "axis", "length"],
    (a) => {
      const at = a.vec3("at");
      if (a.has("size")) return wrap(REGION, { t: "box", at, size: a.vec3("size") } satisfies RegionSpec, "box zone");
      if (a.has("d")) {
        const axis = clean(a.dir("axis", [0, 0, 1]));
        return wrap(REGION, { t: "cyl", at, axis, d: a.positive("d"), length: a.num("length", 0) } satisfies RegionSpec, "cylinder zone");
      }
      return wrap(REGION, { t: "sphere", at, r: a.num("r", 1) } satisfies RegionSpec, "sphere zone");
    },
    "zone(at: p, r: 3) → the part surface within r of a point. zone(at: p, size: (x, y, z)) uses a box centred at p; zone(at: p, d: 8, axis: Z, length: 6) a cylinder starting at p (a bore or a boss).",
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
  for (const f of flags) if (!FLAGS.includes(f.name)) fail(`Unknown flag "${f.name}" in an analysis. Flags: gravity, printed, buckling, converge.`, f.span);
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
        else fail(`fix: should be a region like face(bracket, -Y), zone(at: p, r: 3), roller(face(base, -Z), Z) or contact(region, mu: 0.3); got ${typeName(x)}`, p.span);
      } else {
        if (x instanceof Obj && x.kind === LOAD) loads.push(x.fields.spec as unknown as LoadSpec);
        else fail(`load: should be force(...), pressure(...), torque(...), wind(...) or pull(band); got ${typeName(x)}`, p.span);
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
  let auto = false;
  if (heatP)
    for (const x of listOf(heatP.value)) {
      if (x === "auto") auto = true;
      else if (x instanceof Obj && x.kind === HEAT) heatLoads.push(x.fields.spec as unknown as HeatLoadSpec);
      else
        fail(
          typeof x === "number"
            ? `heat: say where the ${x} W is made, like heat: [source(motor, ${x}W)], or use heat: "auto" for every electronic part's own loss`
            : `heat: should list heat sources like source(motor, 12W) or source(face(plate, +Z), 3W), or "auto" for every electronic part's loss at its working current; got ${typeName(x)}`,
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
  const named = new Set<string>();
  for (const r of [...supports.map((s) => s.region), ...loads.map((l) => l.region), ...masses.map((m) => m.region), ...fixedTemps.map((f) => f.region), ...heatLoads.flatMap((h) => (h.region ? [h.region] : []))])
    if (r.t === "face") named.add(r.part);
  for (const h of heatLoads) if (h.part) named.add(h.part);
  for (const n of named) {
    const k = env.kindOf(n);
    if (k !== "part" && k !== "component") fail(`face(${n}, …): "${n}" is not a part or component`, span);
  }
  if (!parts.length) parts = [...named];
  else {
    const missing = [...named].filter((n) => !parts.includes(n));
    if (missing.length) fail(`face(${missing[0]}, …) refers to "${missing[0]}", which is not in parts:. Add it to parts: [${[...parts, missing[0]].join(", ")}].`, span);
  }
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
  const modal: ModalSpec | undefined =
    modesN !== undefined || exP || damping !== undefined || ringing !== undefined ? { modes: modesN ?? 6, excite, damping: damping ?? 0.02, ringing } : undefined;

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
    if (modal) fail("Check natural frequencies in a separate analysis from the drop.", at);
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
    if (modal) fail("Check natural frequencies in a separate analysis from heat.", (heatP ?? holdP)!.span);
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
    if (!heatLoads.length && !auto && !fixedTemps.length) fail('heat: lists no heat sources; add source(part, watts), or "auto"', heatP!.span);
  } else if (emissivity !== undefined) fail("emissivity: goes with heat: (radiation from a hot surface).", one("emissivity")!.span);

  // ---- one temperature for the whole model: expansion against the supports ----
  const uniformTemp = plain("temperature", "the temperature of the whole model, like temperature: 60C", (v) => v > -273.15);
  const refTemp = plain("assembled_at", "the temperature it is made and assembled at, like assembled_at: 20C", (v) => v > -273.15);
  if (uniformTemp !== undefined && thermalOn) fail("temperature: sets the whole model to one temperature, while heat: and hold: work the temperatures out. Use one or the other.", one("temperature")!.span);
  if (uniformTemp !== undefined && !supports.length) fail("temperature: stresses the parts against their supports as they expand; add fix: to say how they are held.", one("temperature")!.span);
  if (uniformTemp !== undefined && drop) fail("Check a set temperature in a separate analysis from the drop.", one("temperature")!.span);
  if (refTemp !== undefined && uniformTemp === undefined && !(thermalOn && supports.length)) fail("assembled_at: is the temperature with no thermal stress; it goes with temperature: or with heat: and fix:.", one("assembled_at")!.span);

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
    if (modal || drop) fail(`Check buckling in a separate analysis from the ${modal ? "natural frequencies" : "drop"}.`, at);
    if (!loads.length && !accel && !thermalOn && uniformTemp === undefined) fail("buckling needs loads to scale: add load: (or gravity) for what presses on the parts.", at);
    buckling = { modes, safety: plain("buckling_safety", "the lowest buckling factor wanted, like buckling_safety: 3", (v) => v >= 1) ?? 3 };
  } else if (one("buckling_safety")) fail("buckling_safety: goes with buckling.", one("buckling_safety")!.span);

  if (supports.length + loads.length > MAX_BOUNDARY_ITEMS) fail(`An analysis takes at most ${MAX_BOUNDARY_ITEMS} supports and loads together; this one has ${supports.length + loads.length}. Combine regions, for example one zone() covering a row of holes.`, span);
  if (!supports.length && !thermalOn)
    fail('Add fix: to say how the part is held, for example fix: face(bracket, -Y). A part that only rests on a surface can use roller(face(part, -Z), Z) plus one fixed point. For a fall use drop: 1m or tip: +X instead; for temperatures alone use heat:.', span);
  if (!loads.length && !accel && !modal && !thermalOn && uniformTemp === undefined)
    fail("Add load: force(...), pressure(...) or torque(...), or gravity, so there is something to analyse; or excite: or modes: for natural frequencies, or heat: for temperatures.", span);

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
  let resolution: Resolution = modal && !loads.length && !accel ? "draft" : "standard";
  if (resP) {
    if (resP.value === "draft" || resP.value === "standard" || resP.value === "fine") resolution = resP.value;
    else if (typeof resP.value === "number" && resP.value >= MIN_ELEMENT_SIZE) resolution = { h: resP.value };
    else if (typeof resP.value === "number") fail(`resolution: the element size must be at least ${MIN_ELEMENT_SIZE}mm`, resP.span);
    else fail('resolution: should be "draft", "standard", "fine" or an element size like 0.8mm', resP.span);
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
    safety: safetyGiven ?? (drop ? 1.5 : 2),
    maxDeflection: num("max_deflection", 0),
    cycles,
    printed: bool("printed"),
    buildDir,
    resolution,
    ...(masses.length ? { masses } : {}),
    ...(modal ? { modal } : {}),
    ...(drop ? { drop } : {}),
    ...(thermal ? { thermal } : {}),
    ...(uniformTemp !== undefined ? { uniformTemp } : {}),
    ...(refTemp !== undefined ? { refTemp } : {}),
    ...(buckling ? { buckling } : {}),
    ...(flags.some((f) => f.name === "converge") ? { converge: true } : {}),
    span,
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
