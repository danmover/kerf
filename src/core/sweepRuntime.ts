// Works through the motion sweep for the live design a slice at a time, so a
// design with many moving parts never holds the page up. The sweep pass
// reports what is swept so far (finished pairs come from the sweep's cache)
// and carries on between frames until every pair is done, then the report is
// composed again. The assistant's check results wait for it.

import { refreshReport } from "./engine";
import { registerReportPass } from "./reportPasses";
import { sweepChecks, sweepInputs } from "./sweepChecks";
import type { CheckItem } from "./checks";

/** How long one slice of the sweep may run, ms. */
const SLICE_MS = 40;

let timer: ReturnType<typeof setTimeout> | null = null;
let waiting: (() => void)[] = [];

function run(): { items: CheckItem[]; done: boolean } {
  const s = sweepInputs();
  if (!s) return { items: [], done: true };
  const items = sweepChecks(s.model, s.holds, s.kernel, s.mesh, s.ignore, SLICE_MS);
  return { items, done: !items.some((i) => i.id === "sweep:partial") };
}

function settle() {
  const w = waiting;
  waiting = [];
  for (const f of w) f();
}

function carryOn() {
  timer = null;
  if (!run().done) {
    timer = setTimeout(carryOn, 0);
    return;
  }
  refreshReport();
  settle();
}

registerReportPass(
  "sweep",
  (items, ctx) => {
    const s = sweepInputs();
    if (!ctx.live || !s || s.model !== ctx.model) return items;
    const r = run();
    if (!r.done && !timer) timer = setTimeout(carryOn, 0);
    return [...items, ...r.items];
  },
  11,
);

/** Resolves once the live design's moving parts are all swept (or after `ms`). */
export function whenSwept(ms = 20_000): Promise<void> {
  if (!timer) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    waiting.push(() => {
      clearTimeout(t);
      resolve();
    });
  });
}
