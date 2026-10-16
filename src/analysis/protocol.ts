// Messages between the app and the analysis worker.

import type { StructuralInput, StructuralResult } from "./fe/structural";

export interface FeaRequest {
  id: number;
  input: StructuralInput;
}

export type FeaResponse =
  | { id: number; type: "progress"; stage: string; frac: number; iter?: number; residual?: number }
  | { id: number; type: "done"; result: StructuralResult }
  /** setup: the set-up cannot be solved (missing support, loose part...), as opposed to a crash */
  | { id: number; type: "error"; message: string; setup: boolean };
