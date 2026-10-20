// One pass of the wiring and mounting checks, as the cable worker runs it
// (and the tests, in Node): place the splices where there is room, route
// every cable, check the routed harness against the parts, and check how
// each electronics module is held.

import { checkWiring, placeSplices, type SplicePlace, type WiringFindings } from "./clash";
import { keepOutBits, routeRequests, type Harness } from "./harness";
import { checkMounts, type MountResult, type MountSpec, type ScrewSpec } from "./mounts";
import type { SignedField } from "./relax";
import { routeWithField, type RouteInput, type RouteResult } from "./route";
import { Solids } from "./solids";
import type { TravelPlan } from "./travel";

/** The harness to route and check, and the modules whose holding is checked. */
export interface WiringInput {
  harness: Harness;
  mounts: MountSpec[];
  screws: ScrewSpec[];
}

export interface WiringRun {
  result: RouteResult;
  findings?: WiringFindings;
  mounts: MountResult[];
  splices: SplicePlace[];
}

/** Route and check. `input` carries the solids (its wires are replaced by the harness's). Moves the harness's splices. */
export function runWiring(input: RouteInput, wiring: WiringInput, plan: TravelPlan | null = null): WiringRun {
  const { harness, mounts, screws } = wiring;
  const solids = new Solids(input.geos, input.placed);
  // splices go where there is room, before the cables through them are routed
  const splices = placeSplices(harness, solids);
  const route: RouteInput = { ...input, wires: routeRequests(harness, plan), keepOut: plan ? keepOutBits(plan).boxes : undefined };
  let result: RouteResult = { wires: [], cell: 0, ms: 0, stages: {} };
  let field: SignedField | null = null;
  if (route.wires.length) ({ result, field } = routeWithField(route, solids));
  const findings = harness.wires.length ? checkWiring(harness, result.wires, solids, field, plan) : undefined;
  return { result, findings, mounts: checkMounts(mounts, screws, solids), splices };
}
