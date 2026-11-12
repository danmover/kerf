// What an app's panels could show, for the builder's signal pickers: the
// firmware's telemetry columns, the app's derived values, everything the
// running link has sent, and the channels the twin's scenario records.

import type { AppSpec } from "../../apps/spec";
import type { SignalStore } from "../../apps/store";
import { telemetryColumns, TEXT_SIGNALS } from "../../apps/lines";
import { channelInfo } from "../../sim/channels";
import { useSim } from "../../sim/runtime";

export interface SignalChoice {
  name: string;
  label: string;
  unit?: string;
  /** where it comes from: the firmware's lines, the app itself or the twin's simulation */
  from: "telemetry" | "derived" | "live" | "twin";
}

export function signalChoices(app: AppSpec, store: SignalStore | null): SignalChoice[] {
  const out = new Map<string, SignalChoice>();
  const add = (c: SignalChoice) => {
    if (!out.has(c.name)) out.set(c.name, c);
  };
  for (const c of telemetryColumns(app.telemetry)) add({ name: c.name, label: c.name, unit: c.unit, from: "telemetry" });
  for (const d of app.derive) add({ name: d.name, label: d.label ?? d.name, unit: d.unit, from: "derived" });
  for (const n of store?.names() ?? []) {
    const i = store!.info(n);
    add({ name: n, label: i.label ?? n, unit: i.unit, from: "live" });
  }
  const run = app.twin ? useSim.getState().runs.get(app.twin)?.result?.variants[0] : undefined;
  for (const n of Object.keys(run?.frames.series ?? {})) {
    const c = channelInfo(n);
    add({ name: n, label: c.label, unit: c.unit, from: "twin" });
  }
  for (const n of TEXT_SIGNALS) add({ name: n, label: n, from: "telemetry" });
  return [...out.values()];
}
