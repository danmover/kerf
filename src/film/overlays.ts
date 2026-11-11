// The app's overlays a film shot can need on: the wiring (covers
// see-through), an airflow result's streamlines, a structural result, or a
// simulation run. Shots turn them on through the same state the panels use;
// the viewport's layers then add them to the 3D view. What was on before the
// film is put back after it.

import { toggleWiring, useWiringView } from "../ui/wiringView";
import { updateSettings, useSettings } from "../app/settings";
import { showAirflow, useAirflow } from "../analysis/aeroRuntime";
import { showResults, useAnalysis } from "../analysis/runtime";
import { useSim } from "../sim/runtime";
import type { OverlayNeed } from "./timeline";

export interface SavedOverlays {
  wiring: boolean;
  wiringSolid: boolean;
  airflow: string | null;
  airflowLines: boolean;
  results: string | null;
  sim: { view: boolean; selected: string | null; playing: boolean; t: number };
}

export function saveOverlays(): SavedOverlays {
  const s = useSim.getState();
  return {
    wiring: useWiringView.getState().on,
    wiringSolid: !!useSettings.getState().wiringSolid,
    airflow: useAirflow.getState().shown,
    airflowLines: useAirflow.getState().lines,
    results: useAnalysis.getState().shown,
    sim: { view: s.view, selected: s.selected, playing: s.playing, t: s.t },
  };
}

/** Let React draw the change and the viewport's layers add or drop their overlays. */
export async function settle(frames = 3) {
  for (let i = 0; i < frames; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
  await new Promise((r) => setTimeout(r, 20));
}

export const sameNeed = (a: OverlayNeed | null, b: OverlayNeed | null) => (a?.kind ?? "") === (b?.kind ?? "") && (a && "label" in a ? a.label : "") === (b && "label" in b ? b.label : "");

/** Turn on what a shot needs and everything else off. */
export async function setOverlay(need: OverlayNeed | null) {
  if (need?.kind !== "wiring" && useWiringView.getState().on) toggleWiring(false);
  if (need?.kind !== "airflow" && useAirflow.getState().shown) showAirflow(null);
  if (need?.kind !== "results" && useAnalysis.getState().shown) showResults(null);
  if (need?.kind !== "sim" && useSim.getState().view) useSim.setState({ view: false, playing: false });
  switch (need?.kind) {
    case "wiring":
      updateSettings({ wiringSolid: false });
      toggleWiring(true);
      break;
    case "airflow":
      showAirflow(need.label);
      useAirflow.setState({ lines: true });
      break;
    case "results":
      showResults(need.label);
      break;
    case "sim":
      useSim.setState({ view: true, selected: need.label, playing: false, t: 0 });
      break;
  }
  await settle(need ? 4 : 2);
}

export async function restoreOverlays(s: SavedOverlays) {
  await setOverlay(null);
  updateSettings({ wiringSolid: s.wiringSolid });
  if (s.wiring) toggleWiring(true);
  if (s.airflow) {
    showAirflow(s.airflow);
    useAirflow.setState({ lines: s.airflowLines });
  }
  if (s.results) showResults(s.results);
  useSim.setState({ view: s.sim.view, selected: s.sim.selected, playing: s.sim.playing, t: s.sim.t });
  await settle(1);
}
