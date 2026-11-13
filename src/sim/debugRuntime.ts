// Debug runs: one variant of a scenario run again with the firmware under the debugger (the breakpoints, watches and
// stop-on-mistake setting of Build → Firmware and Simulate → Debug) and the logic analyser on its pins and buses.
// The run uses the same seed as the scenario's own run, so its stops and signals happen at the times the replay
// shows; the scenario's results are left as they are.

import { create } from "zustand";
import { useDesign } from "../core/engine";
import { useFirmwareDebug, type Breakpoint } from "../app/firmwareDebug";
import { withOwnCode } from "../app/firmwareCode";
import { generateFirmware } from "../machine/firmware";
import type { DebugResult, DebugSpec } from "./mcu";
import type { VariantRun } from "./engine/run";
import type { SignalTrace } from "./engine/probes";
import type { SimRequest, SimResponse } from "./protocol";
import { runSpecOf, scenarioKey } from "./runtime";
import type { VariantName } from "./worlds/common";

export interface DebugRun {
  label: string;
  variant: VariantName;
  /** the firmware block the scenario runs */
  block: string;
  /** what was asked: the scenario as it was, and the debugger's settings */
  key: string;
  spec: DebugSpec;
  status: "running" | "done" | "error";
  progress: number;
  result?: DebugResult;
  /** the pins and buses over the run */
  signals?: SignalTrace;
  /** the run itself (why it stopped, its serial, the timeline) */
  run?: VariantRun;
  error?: string;
  startedAt: number;
  ms?: number;
}

export const useDebugRun = create<{ run: DebugRun | null }>(() => ({ run: null }));

let worker: Worker | null = null;
let seq = 0;

function stopWorker() {
  worker?.terminate();
  worker = null;
}

/** The firmware block a scenario runs: the one it names, else the first with Arduino code, as the run picks it. */
export function scenarioBlock(label: string): string | null {
  const model = useDesign.getState().model;
  const def = model?.scenarios?.find((d) => d.label === label);
  if (!model?.machine || !def) return null;
  const fw = generateFirmware(withOwnCode(model.machine), model.name);
  const named = def.spec.firmware ? fw.find((f) => f.name === def.spec.firmware) : undefined;
  return (named ?? fw.find((f) => f.target === "arduino") ?? fw[0])?.name ?? null;
}

/** The debugger's settings for a block, as a run takes them. */
export function debugSpecFor(block: string, opts: { from?: number } = {}): DebugSpec {
  const s = useFirmwareDebug.getState();
  return {
    breakpoints: s.breakpoints.filter((b: Breakpoint) => b.block === block && b.enabled).map((b) => ({ id: b.id, file: b.file, line: b.line, ...(b.cond ? { cond: b.cond } : {}), ...(b.log ? { log: b.log } : {}) })),
    watches: s.watches,
    breakOnFault: s.breakOnFault,
    from: opts.from && opts.from > 0 ? opts.from : undefined,
    maxStops: 40,
    traceSteps: 300,
  };
}

/** What a debug run of a scenario would be now, to tell whether the one on show is out of date. */
export function debugKey(label: string, variant: VariantName, spec: DebugSpec): string | null {
  const model = useDesign.getState().model;
  const def = model?.scenarios?.find((d) => d.label === label);
  if (!model || !def) return null;
  const sp = runSpecOf(def, model);
  if (!sp || "error" in sp) return null;
  return `${scenarioKey(sp, withOwnCode(model.machine), model.name)}|${variant}|${JSON.stringify(spec)}`;
}

/**
 * Run a scenario's variant under the debugger: with the settings of Build → Firmware and Simulate → Debug, or the
 * ones given (Claude's). Returns why it can't, or null.
 */
export function debugScenario(label: string, variant: VariantName, opts: { from?: number; spec?: DebugSpec } = {}): string | null {
  const model = useDesign.getState().model;
  const def = model?.scenarios?.find((d) => d.label === label);
  if (!model?.machine || !def) return "There is no such scenario.";
  const sp = runSpecOf(def, model);
  if (sp === null) return "The parts are still building: try again in a moment.";
  if ("error" in sp) return sp.error;
  if (sp.world.kind === "printer") return "A printer scenario runs Klipper, Marlin or RepRapFirmware, which the debugger can't step through.";
  if (sp.physicsOnly) return "This scenario runs the physics only, with no firmware to debug.";
  const block = scenarioBlock(label);
  if (!block) return "The design has no firmware block to debug.";
  const spec = opts.spec ?? debugSpecFor(block, opts);
  const key = `${scenarioKey(sp, withOwnCode(model.machine), model.name)}|${variant}|${JSON.stringify(spec)}`;
  stopWorker();
  const id = ++seq;
  const machine = withOwnCode(model.machine);
  const req: SimRequest = { id, spec: { ...sp, variants: [variant] }, machine, designName: model.name, variant, debug: spec, signals: {} };
  useDebugRun.setState({ run: { label, variant, block, key, spec, status: "running", progress: 0, startedAt: performance.now() } });
  const w = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module", name: "kerf-debug" });
  worker = w;
  const patch = (p: Partial<DebugRun>) => {
    const cur = useDebugRun.getState().run;
    if (cur && cur.key === key && worker === w) useDebugRun.setState({ run: { ...cur, ...p } });
  };
  const deadline = setTimeout(() => {
    patch({ status: "error", error: "The debug run took longer than 10 minutes and was stopped. Try a shorter duration:." });
    if (worker === w) stopWorker();
  }, 600_000);
  w.onmessage = (ev: MessageEvent<SimResponse>) => {
    const msg = ev.data;
    if (msg.id !== id) return;
    if (msg.type === "progress") return patch({ progress: msg.frac });
    clearTimeout(deadline);
    const started = useDebugRun.getState().run?.startedAt ?? performance.now();
    if (msg.type === "error") patch({ status: "error", error: msg.message, ms: performance.now() - started });
    else {
      const v = msg.result.variants[0];
      if (msg.result.error || v?.error) patch({ status: "error", error: msg.result.error ?? v?.error, run: v, ms: performance.now() - started });
      else patch({ status: "done", result: v?.debug, signals: v?.signals, run: v, progress: 1, ms: performance.now() - started });
    }
    if (worker === w) stopWorker();
  };
  w.onerror = (ev) => {
    ev.preventDefault();
    clearTimeout(deadline);
    patch({ status: "error", error: "The debug run stopped unexpectedly, most likely out of memory. Try a shorter duration:." });
    if (worker === w) stopWorker();
  };
  w.postMessage(req);
  return null;
}

export function stopDebugRun() {
  stopWorker();
  const cur = useDebugRun.getState().run;
  if (cur?.status === "running") useDebugRun.setState({ run: { ...cur, status: "error", error: "Stopped." } });
}

export function clearDebugRun() {
  stopWorker();
  useDebugRun.setState({ run: null });
}
