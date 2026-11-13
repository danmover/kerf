// The flow form of the `analysis` block: an analysis with flow: blows air through and round the design and works out
// how warm every part gets.
//
//   analysis "Cooling" {
//     flow: "fans"              // the design's fans push the air; or "natural" (warm air rising), or a set flow like 20cfm
//     heat: "auto"              // every electronic part's own loss (the default), plus any source(part, 2W)
//     ambient: 35C
//     max_temp: 70C
//   }
//
//   analysis "Manifold" {
//     flow: 12lpm
//     fluid: "water"            // or "air" (the default)
//     inlet: face(manifold, -X)  // pushed in through this end, into the part
//     outlets: [face(manifold, +X), face(branch, +Y)]
//     max_pressure: 20kPa
//   }

import { Obj, Ref, Vec, typeName, type Value } from "../lang/values";
import type { Span } from "../lang/ast";
import type { AnalysisItem, AnalysisEnv } from "./lang";
import { describeRegion, MIN_ELEMENT_SIZE, type FlowOpening, type FlowSpec, type HeatLoadSpec, type RegionSpec, type Resolution, type V3 } from "./spec";

export const FLOW_PROPS = ["flow", "fluid", "parts", "part", "fans", "inlet", "toward", "outlets", "heat", "ambient", "up", "gravity", "resolution", "max_temp", "max_pressure", "time"];

// the kinds lang.ts gives face()/zone() regions and source() heat (its REGION and HEAT)
const REGION_KIND = "region";
const HEAT_KIND = "heat source";

/** the smallest cell a flow analysis takes, mm */
const MIN_CELL = 0.25;

export function buildFlow(label: string, props: AnalysisItem[], flags: AnalysisItem[], span: Span, env: AnalysisEnv): FlowSpec {
  const fail: (msg: string, span: Span) => never = env.fail;
  for (const p of props) if (!FLOW_PROPS.includes(p.name)) fail(`"${p.name}:" is not part of a flow analysis, which takes ${FLOW_PROPS.join(", ")}`, p.span);
  for (const f of flags) if (f.name !== "gravity") fail(`Unknown flag "${f.name}" in a flow analysis (gravity is the one flag)`, f.span);
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
  const dirOf = (p: AnalysisItem, v: Value, what: string): V3 => {
    if (!(v instanceof Vec) || v.v.length < 2) fail(`${what} should be a direction like +X or (0, 0, 1), got ${typeName(v)}`, p.span);
    const d: V3 = [(v as Vec).v[0] || 0, (v as Vec).v[1] || 0, (v as Vec).v[2] || 0];
    const n = Math.hypot(...d);
    if (n < 1e-9) fail(`${what} must not be zero`, p.span);
    return [d[0] / n || 0, d[1] / n || 0, d[2] / n || 0];
  };
  const nameOf = (v: Value, p: AnalysisItem, what: string): string => {
    const n = v instanceof Ref ? v.name : v instanceof Obj && v.kind === "component" && typeof v.fields.name === "string" ? v.fields.name : typeof v === "string" ? v : undefined;
    if (!n) return fail(`${what} should name a part or component, got ${typeName(v)}`, p.span);
    const k = env.kindOf(n);
    if (k !== "part" && k !== "component" && k !== "frame") fail(`${what} "${n}" is not a part or component`, p.span);
    return n;
  };
  const names = (name: string): string[] | undefined => {
    const p = one(name);
    if (!p) return undefined;
    const list = Array.isArray(p.value) ? p.value.flat() : [p.value];
    const out: string[] = [];
    for (const v of list) {
      const n = nameOf(v as Value, p, `${name}:`);
      const members = env.members?.(n);
      for (const m of members?.length ? members : [n]) if (!out.includes(m)) out.push(m);
    }
    if (!out.length) fail(`${name}: the list is empty`, p.span);
    return out;
  };
  /** an opening: a face of a part, a zone, or a point (with toward:) */
  const opening = (p: AnalysisItem, v: Value, what: string, n: number): FlowOpening => {
    if (v instanceof Obj && v.kind === REGION_KIND) {
      const region = v.fields.spec as unknown as RegionSpec;
      if (region.t === "extreme") fail(`${what} give a face of a part, like face(duct, +X), or a zone round the opening`, p.span);
      return { label: region.t === "face" ? `${region.part} ${axisWord(region.dir)}` : `${what.replace(/:$/, "")} ${n}`, region };
    }
    if (v instanceof Vec && v.v.length === 3) return { label: `${what.replace(/:$/, "")} ${n}`, region: { t: "sphere", at: [v.v[0], v.v[1], v.v[2]], r: 0 } };
    return fail(`${what} should be a face of a part like face(duct, -X), a zone(…) round the opening, or a point (x, y, z) in it; got ${typeName(v)}`, p.span);
  };

  // ---- what moves the air ----
  const fp = one("flow")!;
  let drive: FlowSpec["drive"];
  let flow: number | undefined;
  if (fp.value === "fans" || fp.value === "natural") drive = fp.value;
  else if (typeof fp.value === "number" && Number.isFinite(fp.value)) {
    if (!(fp.value > 0)) fail("flow: a set flow should be more than 0, like flow: 20cfm", fp.span);
    if (fp.value < 100) fail("flow: give the flow with its unit, like 20cfm, 12lpm or 5cmh (m³/h); a plain number reads as mm³/s", fp.span);
    drive = "set";
    flow = fp.value;
  } else
    return fail(
      `flow: "fans" for the design's own fans, "natural" for warm air rising on its own, or a set flow pushed in at inlet:, like flow: 20cfm; got ${typeName(fp.value)}`,
      fp.span,
    );

  const flp = one("fluid");
  let fluid: FlowSpec["fluid"] = "air";
  if (flp) {
    if (flp.value !== "air" && flp.value !== "water") fail(`fluid: "air" (the default) or "water"; got ${typeof flp.value === "string" ? `"${flp.value}"` : typeName(flp.value)}`, flp.span);
    fluid = flp.value as FlowSpec["fluid"];
  }

  let inlet: FlowOpening | undefined;
  const ip = one("inlet");
  const tp = one("toward");
  if (drive === "set") {
    if (!ip) fail("flow: a set flow goes in somewhere: add inlet: face(duct, -X) (the end it goes in at) or a zone round the opening", fp.span);
    inlet = opening(ip!, ip!.value, "inlet:", 1);
    if (tp) inlet.toward = dirOf(tp, tp.value, "toward:");
    else if (inlet.region.t !== "face") fail("inlet: which way does the air go in? Add toward: +X (or give a face of the part, which it goes into)", ip!.span);
  } else {
    if (ip) fail(`inlet: goes with a set flow like flow: 20cfm; with flow: "${drive}" the ${drive === "fans" ? "fans move" : "warm air moves"} the air`, ip.span);
    if (tp) fail("toward: is the way a set flow goes in at its inlet:", tp.span);
  }
  const outlets: FlowOpening[] = [];
  const op = one("outlets");
  if (op) {
    const list = Array.isArray(op.value) ? op.value : [op.value];
    list.forEach((v, i) => outlets.push(opening(op, v as Value, "outlet:", i + 1)));
    if (!outlets.length) fail("outlets: the list is empty", op.span);
  }

  // ---- heat ----
  const heat: HeatLoadSpec[] = [];
  let auto = true;
  const hp = one("heat");
  if (hp) {
    auto = false;
    for (const x of Array.isArray(hp.value) ? hp.value.flat() : [hp.value]) {
      if (x === "auto") auto = true;
      else if (x === "none") continue;
      else if (x instanceof Obj && x.kind === HEAT_KIND) {
        const h = x.fields.spec as unknown as HeatLoadSpec;
        if (h.region) fail(`heat: in a flow analysis heat is made inside parts: give the part, like source(${h.region.t === "face" ? h.region.part : "board"}, ${h.watts}W)`, hp.span);
        heat.push(h);
      } else fail(`heat: "auto" for every electronic part's own loss, source(part, 2W) for heat made in a part, or "none"; got ${typeName(x as Value)}`, hp.span);
    }
  }

  const ambient = num("ambient");
  if (ambient !== undefined && (ambient < -40 || ambient > 120)) fail("ambient: the air's temperature round the design, in °C, like 35C", one("ambient")!.span);
  if (fluid === "water" && ambient !== undefined && (ambient <= 0 || ambient >= 100)) fail("ambient: water between 0 and 100 °C, like 25C", one("ambient")!.span);
  const upP = one("up");
  const up = upP ? dirOf(upP, upP.value, "up:") : ([0, 0, 1] as V3);
  let gravity = true;
  const gp = one("gravity");
  if (gp) {
    if (typeof gp.value !== "boolean") fail("gravity: true lets warm air rise (the default), false leaves it out", gp.span);
    gravity = gp.value as boolean;
  }
  if (drive === "natural" && !gravity) fail('flow: "natural" is warm air rising, so it needs gravity', gp!.span);

  const resP = one("resolution");
  let resolution: Resolution = "standard";
  if (resP) {
    if (resP.value === "draft" || resP.value === "standard" || resP.value === "fine") resolution = resP.value;
    else if (typeof resP.value === "number" && resP.value >= Math.max(MIN_ELEMENT_SIZE, MIN_CELL)) resolution = { h: resP.value };
    else fail(`resolution: "draft", "standard", "fine" or a cell size like 1.5mm (at least ${MIN_CELL} mm)`, resP.span);
  }

  const maxTemp = num("max_temp");
  if (maxTemp !== undefined && (maxTemp < -20 || maxTemp > 400)) fail("max_temp: the hottest any part may get, in °C, like 70C", one("max_temp")!.span);
  const maxPressure = num("max_pressure", 0);
  if (maxPressure !== undefined && drive !== "set") fail("max_pressure: is the pressure a set flow may take to push through; it goes with flow: 20cfm", one("max_pressure")!.span);
  if (maxPressure !== undefined && maxPressure > 1) fail("max_pressure: give it with its unit, like 200Pa or 1.5kPa", one("max_pressure")!.span);
  const time = num("time", 0);
  if (time !== undefined && time < 10) fail("time: how long it may run, like 5min", one("time")!.span);
  const fans = names("fans");
  if (fans && drive !== "fans") fail(`fans: are the fans that run with flow: "fans"`, one("fans")!.span);

  return {
    kind: "flow",
    label,
    drive,
    fluid,
    ...(flow !== undefined ? { flow } : {}),
    ...(inlet ? { inlet } : {}),
    outlets,
    parts: names("parts") ?? names("part") ?? [],
    ...(fans ? { fans } : {}),
    heat,
    auto,
    ...(ambient !== undefined ? { ambient } : {}),
    up,
    gravity,
    resolution,
    ...(maxTemp !== undefined ? { maxTemp } : {}),
    ...(maxPressure !== undefined ? { maxPressure } : {}),
    ...(time !== undefined ? { time } : {}),
    span,
  };
}

/** +X, -Z… for a direction along an axis, else the region's own words */
function axisWord(d: V3): string {
  const k = d.findIndex((x) => Math.abs(Math.abs(x) - 1) < 1e-6);
  if (k >= 0 && d.filter((x) => Math.abs(x) > 1e-6).length === 1) return `${d[k] < 0 ? "-" : "+"}${"XYZ"[k]}`;
  return describeRegion({ t: "face", part: "", dir: d }).replace(/ face$/, "").trim();
}
