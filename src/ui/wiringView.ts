// Display state for the 3D wiring: whether the wiring view is on, the cable
// picked (its wire id from the wire list, W1, W2...), the one under the
// pointer, the drag chain or loop picked, and whether the machine is moving
// through its travel so the moving cables can be watched. The wiring tab
// adds what it filters by, the circuit lit up, how cables are coloured, the
// build-order step and a request for the camera to fly to a cable.

import { create } from "zustand";
import type { WireKind } from "../machine/wiring";
import { updateSettings, useSettings } from "../app/settings";
import { useView } from "../app/view";

export type WiringLook = "ghost" | "solid" | "see";
/** how the cables are coloured in the wiring tab: their real wire colours, by what they carry, or by load against rating */
export type CableColours = "wire" | "kind" | "load";

export interface WiringFilter {
  /** kinds shown; empty shows every kind */
  kinds: WireKind[];
  /** voltages shown (power and signal levels, rounded to 0.1 V); empty shows all */
  volts: number[];
  /** only cables to this component (by name, with [i] for instances) */
  comp: string | null;
  /** words in the cable's id, ends, net or label */
  text: string;
}

export const NO_FILTER: WiringFilter = { kinds: [], volts: [], comp: null, text: "" };

interface WiringViewState {
  on: boolean;
  picked: string | null;
  hovered: string | null;
  end: 0 | 1 | null;
  link: string | null;
  travel: boolean;
  /** cables lit together: the circuit traced from a cable, with the cable it was traced from */
  trace: { from: string; wires: string[] } | null;
  filter: WiringFilter;
  colours: CableColours;
  /** the build order: the cable fitted at this step (index into the harness's cables, which are in build order), or null */
  step: number | null;
  /** stepping through the build order on its own */
  playing: boolean;
  /** the camera is asked to fly to a cable */
  fly: { wire: string; nonce: number } | null;
  /** the wiring tab turned the view on (leaving the tab turns it off again) */
  byTab: boolean;
}

export const useWiringView = create<WiringViewState>(() => ({
  on: false,
  picked: null,
  hovered: null,
  end: null,
  link: null,
  travel: false,
  trace: null,
  filter: NO_FILTER,
  colours: "wire",
  step: null,
  playing: false,
  fly: null,
  byTab: false,
}));

let nonce = 0;

export function toggleWiring(on = !useWiringView.getState().on) {
  useWiringView.setState(on ? { on } : { on, picked: null, hovered: null, end: null, link: null, travel: false, trace: null, step: null, playing: false, byTab: false });
}

/** Pick a cable (or none) and, with `fly`, move the camera to it. */
export function pickWire(id: string | null, opts: { fly?: boolean; end?: 0 | 1 | null } = {}) {
  const s = useWiringView.getState();
  useWiringView.setState({
    picked: id,
    end: opts.end ?? null,
    link: null,
    // a traced circuit stays lit while one of its cables is picked
    trace: id && s.trace?.wires.includes(id) ? s.trace : null,
    ...(id && opts.fly ? { fly: { wire: id, nonce: ++nonce } } : {}),
  });
}

/** Fly the camera to a cable. */
export const flyToWire = (id: string) => useWiringView.setState({ fly: { wire: id, nonce: ++nonce } });

/** Show the wiring with one cable picked, from the wire list, the schematic or a part's card: in the wiring tab, camera on it. */
export function showWire(id: string) {
  openWiringTab();
  useWiringView.setState({ on: true, picked: id, end: null, link: null, trace: null, fly: { wire: id, nonce: ++nonce } });
}

/** Open the wiring tab in the dock (it turns the wiring view on). */
export function openWiringTab() {
  useView.setState({ dockTab: "wiring", dockOpen: true });
}

/** The look of the wiring view, kept in the settings. Older settings only had solid or see-through. */
export function wiringLook(): WiringLook {
  return useSettings.getState().wiringLook ?? "ghost";
}

export function setWiringLook(look: WiringLook) {
  updateSettings({ wiringLook: look, wiringSolid: look === "solid" });
}

/** Light up the circuit a cable is on. */
export function traceCircuit(from: string, wires: string[]) {
  useWiringView.setState({ trace: { from, wires }, picked: from, link: null });
}
