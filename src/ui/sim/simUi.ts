// Shared bits of the simulation UI: the scenario and run on show, time
// formatting, and opening the Simulate tab.

import { useDesign } from "../../core/engine";
import { useView } from "../../app/view";
import { pick, useSim } from "../../sim/runtime";
import { duration } from "../../sim/frames";

export function useSelectedScenario() {
  const model = useDesign((s) => s.model);
  const selected = useSim((s) => s.selected);
  const runs = useSim((s) => s.runs);
  const variant = useSim((s) => s.variant);
  const defs = model?.scenarios ?? [];
  const def = defs.find((d) => d.label === selected) ?? defs[0];
  const run = def ? runs.get(def.label) : undefined;
  const vrun = run?.result ? pick(run.result.variants, variant) : undefined;
  return { model, defs, def, run, vrun, variant };
}

/** m:ss, or h:mm:ss past an hour */
export function mmss(t: number): string {
  if (!Number.isFinite(t)) return "–";
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Open the Simulate tab on a scenario, and show it in 3D when it has a result. */
export function openSimulation(label?: string, show3d = true) {
  useView.setState({ dockTab: "sim", dockOpen: true });
  const st = useSim.getState();
  const sel = label ?? st.selected;
  useSim.setState({ selected: sel, view: show3d && !!(sel && st.runs.get(sel)?.result) ? true : st.view });
}

/** Jump the playback to a time (clamped to the run on show). */
export function seek(t: number) {
  const st = useSim.getState();
  const m = useDesign.getState().model;
  const def = m?.scenarios?.find((d) => d.label === st.selected);
  const run = def ? st.runs.get(def.label) : undefined;
  const v = run?.result ? pick(run.result.variants, st.variant) : undefined;
  const end = v ? duration(v.frames) : 0;
  useSim.setState({ t: Math.max(0, Math.min(end, t)) });
}

export const EVENT_KIND_LABEL: Record<string, string> = { goal: "goal", contact: "contact", stall: "stuck", info: "", warn: "warning" };
