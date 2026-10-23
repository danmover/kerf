// The airflow form of the `analysis` block: an analysis with airflow: puts
// the design in a wind tunnel.
//
//   analysis "Aero at 45 km/h" {
//     airflow: 45kmh
//     forward: X
//     yaw: [0, 5, 10]
//     rider: "drops"
//     max_cda: 0.25
//   }

import { Obj, Ref, Vec, typeName, type Value } from "../lang/values";
import type { Span } from "../lang/ast";
import type { AnalysisItem, AnalysisEnv } from "./lang";
import { MIN_ELEMENT_SIZE, type AirflowSpec, type Resolution, type RiderPosition, type V3 } from "./spec";

export const AIRFLOW_PROPS = ["airflow", "parts", "part", "forward", "wind", "up", "yaw", "ground", "wheels", "rider", "rider_height", "saddle", "bars", "bottom_bracket", "resolution", "density", "temperature", "max_cda", "max_drag", "max_watts", "max_lift", "time"];
const RIDERS: RiderPosition[] = ["drops", "hoods", "tops", "tt", "upright"];

/** Sea-level air at a temperature (°C): density from the gas law at 101.325 kPa, viscosity from Sutherland's law. */
export function airAt(tempC: number): { density: number; nu: number } {
  const T = tempC + 273.15;
  const density = 101325 / (287.05 * T);
  const mu = (1.458e-6 * T ** 1.5) / (T + 110.4);
  return { density, nu: mu / density };
}

export function buildAirflow(label: string, props: AnalysisItem[], flags: AnalysisItem[], span: Span, env: AnalysisEnv): AirflowSpec {
  const fail: (msg: string, span: Span) => never = env.fail;
  for (const p of props) if (!AIRFLOW_PROPS.includes(p.name)) fail(`"${p.name}:" is not part of an airflow analysis, which takes ${AIRFLOW_PROPS.join(", ")}`, p.span);
  for (const f of flags) if (f.name !== "ground") fail(`Unknown flag "${f.name}" in an airflow analysis (ground is the one flag)`, f.span);
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
  const dir = (name: string, fallback: V3): V3 => {
    const p = one(name);
    if (!p) return fallback;
    if (!(p.value instanceof Vec) || p.value.v.length < 2) fail(`${name}: should be a direction like X or (1, 0, 0), got ${typeName(p.value)}`, p.span);
    const v = (p.value as Vec).v;
    const d: V3 = [v[0] || 0, v[1] || 0, v[2] || 0];
    const n = Math.hypot(...d);
    if (n < 1e-9) fail(`${name}: must not be zero`, p.span);
    return [d[0] / n || 0, d[1] / n || 0, d[2] / n || 0];
  };
  const nameOf = (v: Value, p: AnalysisItem, what: string): string => {
    const n = v instanceof Ref ? v.name : v instanceof Obj && v.kind === "component" && typeof v.fields.name === "string" ? v.fields.name : typeof v === "string" ? v : undefined;
    if (!n) return fail(`${what} should name a part or component, got ${typeName(v)}`, p.span);
    const k = env.kindOf(n);
    if (k !== "part" && k !== "component") fail(`${what} "${n}" is not a part or component`, p.span);
    return n;
  };
  const names = (name: string): string[] | undefined => {
    const p = one(name);
    if (!p) return undefined;
    const list = Array.isArray(p.value) ? p.value.flat() : [p.value];
    const out: string[] = [];
    for (const v of list) {
      const n = nameOf(v as Value, p, `${name}:`);
      if (!out.includes(n)) out.push(n);
    }
    if (!out.length) fail(`${name}: the list is empty`, p.span);
    return out;
  };

  const sp = one("airflow")!;
  if (typeof sp.value !== "number" || !(sp.value > 0)) fail("airflow: the air speed past the design, like airflow: 45kmh", sp.span);
  const speed = sp.value as number;
  if (speed < 1000) fail("airflow: give the speed with its unit, like 45kmh, 30mph or 12000 (mm/s); a plain small number reads as mm/s", sp.span);
  if (speed > 120e3) fail("airflow: the solver is for air well below the speed of sound; keep it under 430 km/h", sp.span);

  const up = dir("up", [0, 0, 1]);
  let forward: V3 = [1, 0, 0];
  if (one("forward") && one("wind")) fail("Give forward: (the way the design travels) or wind: (the way the air blows past it), not both", one("wind")!.span);
  if (one("forward")) forward = dir("forward", forward);
  else if (one("wind")) forward = dir("wind", [-1, 0, 0]).map((x) => -x || 0) as V3;
  if (Math.abs(forward[0] * up[0] + forward[1] * up[1] + forward[2] * up[2]) > 0.98) fail("forward: and up: point the same way; forward is the way it travels, up is up", (one("forward") ?? one("up") ?? sp).span);

  const yp = one("yaw");
  let yaw = [0];
  if (yp) {
    const list = Array.isArray(yp.value) ? yp.value : [yp.value];
    yaw = list.map((v) => {
      if (typeof v !== "number" || !Number.isFinite(v)) return fail(`yaw: angles in degrees, like yaw: [0, 5, 10], got ${typeName(v as Value)}`, yp.span);
      if (Math.abs(v) > 45) fail("yaw: angles from -45 to 45 degrees", yp.span);
      return v;
    });
    if (!yaw.length) fail("yaw: the list is empty", yp.span);
    if (yaw.length > 12) fail("yaw: at most 12 angles in one analysis", yp.span);
  }

  let ground = true;
  const gp = one("ground");
  if (gp) {
    if (typeof gp.value !== "boolean") fail("ground: true for a rolling road under it, false for free air", gp.span);
    ground = gp.value;
  }

  const rp = one("rider");
  let rider: AirflowSpec["rider"];
  if (rp && rp.value !== false) {
    if (typeof rp.value !== "string" || !RIDERS.includes(rp.value as RiderPosition)) fail(`rider: one of ${RIDERS.map((r) => `"${r}"`).join(", ")} for a standard rider (or model one as a part and list it in parts:)`, rp.span);
    const h = num("rider_height", 0) ?? 1780;
    if (h < 1200 || h > 2200) fail("rider_height: the rider's standing height, like 1780mm", one("rider_height")!.span);
    const pick = (n: string) => (one(n) ? nameOf(one(n)!.value, one(n)!, `${n}:`) : undefined);
    rider = { position: rp.value as RiderPosition, height: h, saddle: pick("saddle"), bars: pick("bars"), bb: pick("bottom_bracket") };
  } else for (const n of ["rider_height", "saddle", "bars", "bottom_bracket"]) if (one(n)) fail(`${n}: goes with rider:`, one(n)!.span);

  const resP = one("resolution");
  let resolution: Resolution = "standard";
  if (resP) {
    if (resP.value === "draft" || resP.value === "standard" || resP.value === "fine") resolution = resP.value;
    else if (typeof resP.value === "number" && resP.value >= MIN_ELEMENT_SIZE) resolution = { h: resP.value };
    else fail('resolution: "draft", "standard", "fine" or a cell size like 6mm', resP.span);
  }

  const temp = num("temperature");
  if (temp !== undefined && (temp < -40 || temp > 60)) fail("temperature: the air's temperature in °C, like 20C", one("temperature")!.span);
  const air = airAt(temp ?? 15);
  const density = num("density", 0) ?? air.density;
  if (density > 20) fail("density: in kg/m³, like 1.225", one("density")!.span);

  const parts = names("parts") ?? names("part") ?? [];
  const wheels = names("wheels");
  if (wheels && !ground) fail("wheels: spin with a rolling road; drop wheels: or set ground: true", one("wheels")!.span);
  const time = num("time", 0);
  if (time !== undefined && time < 30) fail("time: how long it may run, like 10min", one("time")!.span);

  return {
    kind: "airflow",
    label,
    speed,
    parts,
    forward,
    up,
    yaw,
    ground,
    ...(wheels ? { wheels } : {}),
    ...(rider ? { rider } : {}),
    resolution,
    density,
    nu: air.nu * (air.density / density),
    maxCda: num("max_cda", 0),
    maxDrag: num("max_drag", 0),
    maxWatts: num("max_watts", 0),
    maxLift: num("max_lift"),
    time,
    span,
  };
}
