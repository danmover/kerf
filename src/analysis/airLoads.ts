// Air loads from an airflow analysis's run: what a strength analysis's air("...") needs from the run, and the field it
// hands the solver. One-way: the flow is the one round the unbent parts.

import type { EvalPart, Model } from "../core/model";
import type { AirField, AirflowSpec, AirLoadSpec, AirPartField, LoadSpec, StructuralSpec, V3 } from "./spec";
import type { AirflowResult, PartForce } from "./aero/types";
import { bodyAxes } from "./aero/setup";

/** The run an air load takes its pressures from, or why it waits or cannot go on. */
export type AirState = { result: AirflowResult; aero: AirflowSpec; id: number } | { wait: string } | { error: string };
export type AirSource = (label: string) => AirState;

export const isAirLoad = (l: LoadSpec): l is AirLoadSpec => l.t === "air";
export const airLoadsOf = (spec: StructuralSpec): AirLoadSpec[] => spec.loads.filter(isAirLoad);

const ids = new WeakMap<AirflowResult, number>();
let nextId = 0;
/** A number for each run's result, so a strength run knows when the air it took has been replaced. */
export function resultId(r: AirflowResult): number {
  let id = ids.get(r);
  if (id === undefined) ids.set(r, (id = ++nextId));
  return id;
}

/** The airflow analysis an air load names, or what to say when there is none by that name. */
export function airflowNamed(model: Pick<Model, "analyses">, label: string): AirflowSpec | string {
  const flows = model.analyses.filter((a): a is AirflowSpec => a.kind === "airflow");
  const hit = flows.find((a) => a.label === label) ?? flows.find((a) => a.label.toLowerCase() === label.toLowerCase());
  if (hit) return hit;
  if (!flows.length) return `air("${label}") takes its pressures from an airflow analysis, and this design has none. Add one, like analysis "${label}" { airflow: 45kmh  forward: X }.`;
  return `air("${label}"): there is no airflow analysis called "${label}"; this design has ${flows.map((a) => `"${a.label}"`).join(", ")}.`;
}

/** The world force a part's body-axis drag, side force and lift add up to. */
export function partForceWorld(aero: Pick<AirflowSpec, "forward" | "up">, pf: PartForce): V3 {
  const { F, U, R } = bodyAxes({ facing: aero.forward, up: aero.up });
  return [0, 1, 2].map((k) => -pf.drag * F[k] - pf.side * R[k] + pf.lift * U[k]) as V3;
}

/** The run's pressures on the analysed parts, at the load's speed and scale, ready for the solver. */
export function airField(load: AirLoadSpec, aero: Pick<AirflowSpec, "forward" | "up">, result: AirflowResult, parts: EvalPart[]): { field?: AirField; error?: string } {
  if (!result.yaws.length) return { error: `air("${load.analysis}"): that airflow run has no results.` };
  const yr = load.yaw === undefined ? result.yaws[0] : result.yaws.find((y) => Math.abs(y.yaw - load.yaw!) < 0.01);
  if (!yr) return { error: `air("${load.analysis}", yaw: ${load.yaw}): that airflow analysis runs at ${result.yaws.map((y) => `${y.yaw}°`).join(", ")}; give one of those.` };
  const runSpeed = result.speed;
  const speed = load.speed !== undefined ? load.speed / 1000 : runSpeed;
  // the flow's pattern stays as the run found it, so its pressures and forces go as the speed squared
  const k = (runSpeed > 0 ? (speed / runSpeed) ** 2 : 1) * load.scale;
  const q = 0.5 * result.density * speed * speed * load.scale * 1e-6;
  const byId = new Map(parts.map((p) => [p.id, p]));
  const out: AirPartField[] = [];
  const left: AirField["left"] = [];
  for (const sf of yr.surface) {
    const pf = yr.parts.find((p) => p.id === sf.id);
    const w = pf ? partForceWorld(aero, pf).map((x) => x * k) as V3 : ([0, 0, 0] as V3);
    const p = byId.get(sf.id);
    if (!p) {
      if (pf) left.push({ name: sf.name, force: Math.hypot(...w) });
      continue;
    }
    out.push({ name: p.name, positions: sf.positions, indices: sf.indices, ...(sf.normals ? { normals: sf.normals } : {}), cp: sf.cp, cf: sf.cf, force: w });
  }
  if (!out.length) {
    const inAir = yr.surface.filter((s) => !s.extra).map((s) => s.name);
    return { error: `air("${load.analysis}"): none of ${parts.map((p) => p.name).join(", ")} is in that analysis's air (it has ${inAir.join(", ") || "no parts"}). Analyse the parts it puts in the air.` };
  }
  return { field: { yaw: yr.yaw, speed, runSpeed, q, parts: out, left } };
}

/** The spec's loads with each air load's field filled in from its run, or why they wait or cannot go on. */
export function withAirFields(spec: StructuralSpec, parts: EvalPart[], air: AirSource | undefined): { loads: LoadSpec[] } | { wait: string } | { error: string } {
  if (!spec.loads.some(isAirLoad)) return { loads: spec.loads };
  const loads: LoadSpec[] = [];
  for (const l of spec.loads) {
    if (!isAirLoad(l)) {
      loads.push(l);
      continue;
    }
    if (!air) return { error: `air("${l.analysis}") takes its pressures from the design's own airflow run, so it cannot load this run; it loads the design's analysis "${spec.label}".` };
    const st = air(l.analysis);
    if ("error" in st) return { error: st.error };
    if ("wait" in st) return { wait: st.wait };
    const made = airField(l, st.aero, st.result, parts);
    if (!made.field) return { error: made.error ?? `air("${l.analysis}") could not be read.` };
    loads.push({ ...l, field: made.field });
  }
  return { loads };
}

/** A key for the runs the spec's air loads take, so a new run (or one still to come) runs the analysis again. */
export function airKey(spec: StructuralSpec, air: AirSource | undefined): string {
  const labels = [...new Set(airLoadsOf(spec).map((l) => l.analysis))];
  if (!labels.length || !air) return "";
  return (
    "|air:" +
    labels
      .map((label) => {
        const st = air(label);
        return "result" in st ? `${label}#${resultId(st.result)}` : "wait" in st ? `${label}:wait` : `${label}:error:${st.error}`;
      })
      .join(",")
  );
}
