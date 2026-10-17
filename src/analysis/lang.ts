// The `analysis` block of the design language: the functions that are only
// callable inside it (face, zone, force, pressure, torque, roller, mass, spin,
// band) and the step that turns its properties into an AnalysisSpec.
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
//   analysis "Gearbox duty" {
//     drive: motor_gear
//     torque: 0.3Nm
//     speed: 3000rpm
//     life: 2000h
//   }

import { Args } from "../lang/args";
import { Fn, Obj, Ref, Vec, typeName, type Value } from "../lang/values";
import type { Span } from "../lang/ast";
import type { AnalysisSpec, DropSpec, Excitation, LoadSpec, MassSpec, ModalSpec, RegionSpec, Resolution, SupportSpec, V3 } from "./spec";
import { MECH, mechMaterial } from "./materials";
import { FLOORS, MIN_ELEMENT_SIZE } from "./spec";

/** supports plus loads in one analysis: each one is a pass over the model's surface */
export const MAX_BOUNDARY_ITEMS = 200;

export const STRUCTURAL_PROPS = ["parts", "part", "material", "fix", "load", "gravity", "accel", "printed", "build", "cycles", "safety", "max_deflection", "resolution", "carries", "modes", "excite", "damping", "ringing", "drop", "tip", "impact", "onto"];
export const DRIVETRAIN_PROPS = ["drive", "torque", "speed", "life", "safety"];
const FLAGS = ["gravity", "printed", "locked"];

const REGION = "region";
const LOAD = "load";
const SUPPORT = "support";
const MASS = "mass";
const EXCITE = "excitation";

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
    ["where", "f", "dir"],
    (a) => {
      const r = region(a.value("where"), a);
      const fv = a.value("f");
      let f: V3;
      if (typeof fv === "number") {
        const d = a.dir("dir", [0, 0, -1]);
        f = [d[0] * fv, d[1] * fv, d[2] * fv];
      } else f = a.vec3("f");
      f = clean(f);
      return wrap(LOAD, { t: "force", region: r, f } satisfies LoadSpec, "force");
    },
    "force(region, (0, 0, -50N)) → a total force in newtons spread over the region. force(region, 50N, dir: -Z) is the same. 1 kg of weight ≈ 9.81 N.",
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
    "torque(region, 2Nm, axis: Z, at: (0, 0, 0)) → a twisting load about an axis through a point (default: the zone's centre, or the face's centre), shared over the region in proportion to the distance from the axis. Positive is counter-clockwise looking down the axis.",
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

export interface AnalysisItem {
  name: string;
  value: Value;
  span: Span;
}

export interface AnalysisEnv {
  fail(msg: string, span: Span): never;
  /** the kind of a top-level name: "part", "component", or undefined */
  kindOf(name: string): string | undefined;
}

/** Turn the evaluated items of an analysis block into a spec. */
export function buildAnalysis(label: string, props: AnalysisItem[], flags: AnalysisItem[], span: Span, env: AnalysisEnv): AnalysisSpec {
  const fail: (msg: string, span: Span) => never = env.fail;
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
          : `Unknown analysis property "${p.name}". Use ${STRUCTURAL_PROPS.join(", ")} for stress, or drive:, torque:, speed:, life: for a gear train.`,
        p.span,
      );
    }
  }
  for (const f of flags) if (!FLAGS.includes(f.name)) fail(`Unknown flag "${f.name}" in an analysis. Flags: gravity, printed.`, f.span);
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
        else fail(`fix: should be a region like face(bracket, -Y), zone(at: p, r: 3) or roller(face(base, -Z), Z); got ${typeName(x)}`, p.span);
      } else {
        if (x instanceof Obj && x.kind === LOAD) loads.push(x.fields.spec as unknown as LoadSpec);
        else fail(`load: should be force(...), pressure(...) or torque(...); got ${typeName(x)}`, p.span);
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
  const named = new Set<string>();
  for (const r of [...supports.map((s) => s.region), ...loads.map((l) => l.region), ...masses.map((m) => m.region)]) if (r.t === "face") named.add(r.part);
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

  if (supports.length + loads.length > MAX_BOUNDARY_ITEMS) fail(`An analysis takes at most ${MAX_BOUNDARY_ITEMS} supports and loads together; this one has ${supports.length + loads.length}. Combine regions, for example one zone() covering a row of holes.`, span);
  if (!supports.length) fail('Add fix: to say how the part is held, for example fix: face(bracket, -Y). A part that only rests on a surface can use roller(face(part, -Z), Z) plus one fixed point. For a fall use drop: 1m or tip: +X instead.', span);
  if (!loads.length && !accel && !modal) fail("Add load: force(...), pressure(...) or torque(...), or gravity, so there is something to analyse; or excite: or modes: for natural frequencies.", span);

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
    span,
  };
}
