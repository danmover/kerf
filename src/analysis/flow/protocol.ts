// Messages between the app and the flow worker. A run is stopped by ending the worker (the solve does not yield).

import type { FlowInput, FlowProgress, FlowResult } from "./types";

export type FlowRequest = { id: number; type: "run"; input: FlowInput };

export type FlowResponse =
  | { id: number; type: "progress"; progress: FlowProgress }
  | { id: number; type: "done"; result: FlowResult }
  /** setup: the set-up cannot be solved as written (an inlet in no air...), as opposed to a crash */
  | { id: number; type: "error"; message: string; setup: boolean };
