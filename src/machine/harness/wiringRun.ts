// One pass of the wiring and mounting checks, as the cable worker runs it
// (and the tests, in Node): place the splices where there is room, route
// every cable, check the routed harness against the parts, and check how
// each electronics module is held. Cables keep out of fans' intakes and
// jets, and cross the design's pivots (a gimbal's axes) beside their
// bearings, away from the space the moving parts sweep.

import { checkWiring, placeSplices, type Reach, type SplicePlace, type WiringFindings } from "./clash";
import { inCone, type FlowZone } from "./flow";
import { PLUG_BACK, keepOutBits, leadLength, routeRequests, type Harness } from "./harness";
import { checkMounts, type MountResult, type MountSpec, type ScrewSpec } from "./mounts";
import { planCrossings, type PivotJoint } from "./pivots";
import type { SignedField } from "./relax";
import { routeWithField, type RouteInput, type RouteResult } from "./route";
import { Solids } from "./solids";
import type { TravelPlan } from "./travel";
import type { V3 } from "../../kernel/recipe";

/** The harness to route and check, and the modules whose holding is checked. */
export interface WiringInput {
  harness: Harness;
  mounts: MountSpec[];
  screws: ScrewSpec[];
  /** the design's pivots (sim.pivot joints in its scenarios), for cables that run from one moving body to another */
  pivots?: PivotJoint[];
  /** fans' intakes and jets */
  flow?: FlowZone[];
}

export interface WiringRun {
  result: RouteResult;
  findings?: WiringFindings;
  mounts: MountResult[];
  splices: SplicePlace[];
}

const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Route and check. `input` carries the solids (its wires are replaced by the harness's). Moves the harness's splices. */
export function runWiring(input: RouteInput, wiring: WiringInput, plan: TravelPlan | null = null): WiringRun {
  const { harness, mounts, screws } = wiring;
  const solids = new Solids(input.geos, input.placed);
  // splices go where there is room, before the cables through them are routed
  const splices = placeSplices(harness, solids);
  const wires = routeRequests(harness, plan);
  const travel = plan ? keepOutBits(plan) : null;
  // cables between bodies that turn on pivots cross each joint beside its bearing
  const ends = new Map(wires.map((w) => [w.id, { a: w.a, b: w.b }]));
  const moving = new Set(plan ? Object.keys(plan.pieces) : []);
  const pivots = wiring.pivots?.length ? planCrossings(wiring.pivots, harness.wires.filter((w) => !moving.has(w.id)), ends, input.geos, input.placed, travel?.bits.size ?? 0) : null;
  if (pivots)
    for (const w of wires) {
      const c = pivots.wires.get(w.id);
      if (c) Object.assign(w, c);
    }
  const keepOut = [...(travel?.boxes ?? []), ...(pivots?.keepOut ?? [])];
  const route: RouteInput = { ...input, wires, keepOut: keepOut.length ? keepOut : undefined, flow: wiring.flow?.length ? wiring.flow : undefined };
  let result: RouteResult = { wires: [], cell: 0, ms: 0, stages: {} };
  let field: SignedField | null = null;
  if (route.wires.length) ({ result, field } = routeWithField(route, solids));
  const findings = harness.wires.length ? checkWiring(harness, result.wires, solids, field, plan) : undefined;
  if (findings) {
    findings.flow = flowHits(result, field, wiring.flow ?? []);
    findings.reach = shortLeads(harness, result);
    if (pivots) {
      const via = new Map(result.wires.map((r) => [r.id, r.via ?? []]));
      const seen = new Map<string, number>();
      findings.pivots = pivots.crossings.map((c) => {
        // the wire's crossings in order: the n-th crossing of a wire is its n-th via point
        const n = seen.get(c.wire) ?? 0;
        seen.set(c.wire, n + 1);
        const v = via.get(c.wire)?.[n];
        return { ...c, at: v?.p, r: v?.r };
      });
    }
  }
  return { result, findings, mounts: checkMounts(mounts, screws, solids), splices };
}

/** A lead may come up this much short on the model before it counts: plug positions are only that close, mm. */
const REACH_SLOP = 3;

/**
 * The run each fixed-length wire has to cover against the length it has: its routed run, the straight stub out of
 * each end, and the plug on the end of a part's own lead. A bought cable's length is the wire between its plugs.
 */
export function shortLeads(h: Harness, result: RouteResult): Reach[] {
  const out: Reach[] = [];
  for (const w of h.wires) {
    const have = w.row.fixedMm;
    if (have === undefined || !w.row.lead) continue;
    // a wire's run may be in pieces, one on each moving body
    const runs = result.wires.filter((r) => r.id === w.id || r.id.startsWith(`${w.id}.`));
    if (!runs.length || runs.some((r) => r.straight)) continue;
    let need = runs.reduce((a, r) => a + r.length, 0) + 2 * leadLength(w);
    // a lead ends in its plug: the plug's own length is part of the lead
    const own = w.row.own ?? [];
    if (own.includes("from") && !own.includes("to")) need += PLUG_BACK[w.ends[1].spec.kind];
    if (own.includes("to") && !own.includes("from")) need += PLUG_BACK[w.ends[0].spec.kind];
    if (need > have + REACH_SLOP) out.push({ wire: w.id, lead: w.row.lead, have, need: Math.ceil(need) });
  }
  return out;
}

/** Lengths of cable left in a fan's intake or jet, by wire and zone. */
function flowHits(result: RouteResult, field: SignedField | null, zones: FlowZone[]): NonNullable<WiringFindings["flow"]> {
  const out: NonNullable<WiringFindings["flow"]> = [];
  if (!zones.length || !field?.flow) return out;
  for (const r of result.wires) {
    if (r.straight) continue;
    const by = new Map<number, { length: number; at: V3 }>();
    for (let i = 1; i < r.points.length; i++) {
      const a = r.points[i - 1];
      const b = r.points[i];
      const m: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      if (!field.flow(m[0], m[1], m[2])) continue;
      const z = zones.findIndex((zz) => inCone(zz, m) >= 0);
      if (z < 0) continue;
      const cur = by.get(z) ?? { length: 0, at: m };
      cur.length += dist(a, b);
      by.set(z, cur);
    }
    for (const [z, v] of by) if (v.length >= 3) out.push({ wire: r.id, zone: z, part: zones[z].partId, comp: zones[z].comp, kind: zones[z].kind, length: v.length, at: v.at });
  }
  return out;
}
