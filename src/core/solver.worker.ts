/// <reference lib="webworker" />
// Runs the feasibility search off the UI thread: it evaluates the design
// hundreds of times while looking for the gentlest parameter changes.

import { parse } from "../lang/parser";
import { evaluate } from "../lang/evaluator";
import { solveConflict, type Conflict } from "./feasibility";

export interface SolveRequest {
  id: number;
  src: string;
  hold: string[];
}
export interface SolveResponse {
  id: number;
  conflict: Conflict | null;
  error?: string;
  ms: number;
}

self.onmessage = async (ev: MessageEvent<SolveRequest>) => {
  const { id, src, hold } = ev.data;
  const t0 = performance.now();
  try {
    const parsed = parse(src);
    const model = evaluate(src, { parsed, skipGeometry: true });
    const conflict = await solveConflict(src, parsed, model, { hold, maxOptions: 4 });
    (self as unknown as Worker).postMessage({ id, conflict, ms: performance.now() - t0 } satisfies SolveResponse);
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, conflict: null, error: e instanceof Error ? e.message : String(e), ms: performance.now() - t0 } satisfies SolveResponse);
  }
};
