// Routes the wiring harness off the main thread. For a machine whose parts
// move with its axes, the worker also works out how they move (re-evaluating
// the design, machine/pose) and plans the moving cables' links (travel.ts)
// before routing the runs between them.

import { evaluate } from "../../lang/evaluator";
import { machinePose, type MachinePose } from "../pose";
import { keepOutBits, routeRequests, type Harness } from "./harness";
import { routeCables, type RouteInput, type RouteResult } from "./route";
import { planTravel, type PartBox, type TravelPlan } from "./travel";

/** What the planner needs: the design's source (to pose it), every part's box, and the harness. */
export interface TravelInput {
  source: string;
  boxes: PartBox[];
  harness: Harness;
}

export type HarnessRouteRequest = { id: number; input: RouteInput; travel?: TravelInput } | { id: number; plan: TravelInput };
export type HarnessRouteResponse = { id: number; ok: true; result?: RouteResult; plan: TravelPlan | null } | { id: number; ok: false; error: string };

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
      const input: RouteInput = p ? { ...req.input, wires: routeRequests(req.travel!.harness, p), keepOut: keepOutBits(p).boxes } : req.input;
      msg = { id: req.id, ok: true, result: routeCables(input), plan: p };
    }
  } catch (e) {
    msg = { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  (self as unknown as Worker).postMessage(msg);
};
