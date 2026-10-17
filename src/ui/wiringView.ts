// Display state for the 3D wiring: whether it is shown, the cable picked
// (its wire id from the wire list, W1, W2...) and the one under the pointer.

import { create } from "zustand";

export const useWiringView = create<{ on: boolean; picked: string | null; hovered: string | null; end: 0 | 1 | null }>(() => ({ on: false, picked: null, hovered: null, end: null }));

export function toggleWiring(on = !useWiringView.getState().on) {
  useWiringView.setState(on ? { on } : { on, picked: null, hovered: null, end: null });
}

/** Show the wiring with one cable picked, from the wire list or a part's card. */
export function showWire(id: string) {
  useWiringView.setState({ on: true, picked: id, end: null });
}
