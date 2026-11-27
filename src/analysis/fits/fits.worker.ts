/// <reference lib="webworker" />
// Runs the fit check off the UI thread: every fit, gear mesh and screw pattern of the design built thousands of
// times in simulation. On a large assembly that is a second or two of arithmetic, which would otherwise stop the
// page. It reads the model the page hands it and nothing else: no kernel, no network.

import type { Model } from "../../core/model";
import { findFits } from "./detect";
import { simulateFits, type FitLearned, type FitReport } from "./simulate";

export interface FitsRequest {
  id: number;
  model: Model;
}
export interface FitsResponse {
  id: number;
  report?: FitReport;
  /** every answer in the report with the key it was worked out under, for the page to keep (simulate.ts) */
  learned?: FitLearned[];
  error?: string;
}

// The worker lives as long as the page, and keeps what it has worked out (simulate.ts): the next design it is handed
// is mostly the last one, so only the fits an edit changed are built again.
self.onmessage = (ev: MessageEvent<FitsRequest>) => {
  const { id, model } = ev.data;
  const post = (m: FitsResponse) => (self as unknown as Worker).postMessage(m);
  try {
    const learned: FitLearned[] = [];
    post({ id, report: simulateFits(findFits(model), model, { learned }), learned });
  } catch (e) {
    post({ id, error: e instanceof Error ? e.message : String(e) });
  }
};
