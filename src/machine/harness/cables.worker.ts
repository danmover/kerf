// Routes the wiring harness off the main thread, then checks it against the
// parts (clash.ts) and checks how each electronics module is held
// (mounts.ts). For a machine whose parts move with its axes, the worker also
// works out how they move (re-evaluating the design, machine/pose) and plans
// the moving cables' links (travel.ts) before routing the runs between them.

import { evaluate } from "../../lang/evaluator";
import { machinePose, type MachinePose } from "../pose";
import type { SplicePlace, WiringFindings } from "./clash";
import type { Harness } from "./harness";
import type { MountResult } from "./mounts";
import type { RouteInput, RouteResult } from "./route";
import { planTravel, type PartBox, type TravelPlan } from "./travel";
import { runWiring, type WiringInput } from "./wiringRun";

export type { WiringInput };

/** What the planner needs: the design's source (to pose it), every part's box, and the harness. */
export interface TravelInput {
  source: string;
  boxes: PartBox[];
  harness: Harness;
}

export type HarnessRouteRequest = { id: number; input: RouteInput; travel?: TravelInput; wiring: WiringInput } | { id: number; plan: TravelInput };
export type HarnessRouteResponse =
  | { id: number; ok: true; result?: RouteResult; plan: TravelPlan | null; findings?: WiringFindings; mounts?: MountResult[]; splices?: SplicePlace[] }
  | { id: number; ok: false; error: string };

let posed: { source: string; pose: MachinePose | null } | null = null;

function poseOf(source: string): MachinePose | null {
  if (posed?.source === source) return posed.pose;
  let pose: MachinePose | null = null;
  try {
    pose = machinePose(source, evaluate(source));
  } catch {
    pose = null;
  }
  posed = { source, pose };
  return pose;
}

function plan(t: TravelInput): TravelPlan | null {
  const pose = poseOf(t.source);
  return pose && pose.moves.size ? planTravel(pose, t.boxes, t.harness) : null;
}

self.onmessage = (ev: MessageEvent<HarnessRouteRequest>) => {
  const req = ev.data;
  let msg: HarnessRouteResponse;
  try {
    if ("plan" in req) msg = { id: req.id, ok: true, plan: plan(req.plan) };
    else {
      const p = req.travel ? plan(req.travel) : null;
      msg = { id: req.id, ok: true, plan: p, ...runWiring(req.input, req.wiring, p) };
    }
  } catch (e) {
    msg = { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  (self as unknown as Worker).postMessage(msg);
};
