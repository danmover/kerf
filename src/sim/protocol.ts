// Messages between the app and the simulation workers. One job is one
// variant of one scenario, so the three runs of a scenario go in parallel.

import type { MachineData } from "../machine/types";
import type { RunResult } from "./engine/run";
import type { DebugSpec } from "./mcu";
import type { SignalSpec } from "./engine/probes";
import type { ScenarioSpec } from "./scenario";
import type { VariantName } from "./worlds/common";

export interface SimRequest {
  id: number;
  spec: ScenarioSpec;
  machine: MachineData;
  designName: string;
  variant: VariantName;
  /** run under the firmware debugger */
  debug?: DebugSpec;
  /** record the pins and buses for the logic analyser */
  signals?: SignalSpec;
}

export type SimResponse =
  | { id: number; type: "progress"; frac: number }
  | { id: number; type: "done"; result: RunResult }
  | { id: number; type: "error"; message: string };
