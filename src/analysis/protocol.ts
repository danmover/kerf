// Messages between the app and the analysis worker.

import type { StructuralInput, StructuralResult } from "./fe/structural";
import type { AirflowInput, AirflowProgress, AirflowResult } from "./aero/types";

export interface FeaRequest {
  id: number;
  input: StructuralInput;
}

export type FeaResponse =
  | { id: number; type: "progress"; stage: string; frac: number; iter?: number; residual?: number }
  | { id: number; type: "done"; result: StructuralResult }
  /** setup: the set-up cannot be solved (missing support, loose part...), as opposed to a crash */
  | { id: number; type: "error"; message: string; setup: boolean };

/** Messages between the app and the airflow worker. A cancel stops the run between batches of steps. */
export type AeroRequest = { id: number; type: "run"; input: AirflowInput } | { id: number; type: "cancel" };

export type AeroResponse =
  | { id: number; type: "progress"; progress: AirflowProgress }
  | { id: number; type: "done"; result: AirflowResult }
  | { id: number; type: "error"; message: string; cancelled: boolean };
