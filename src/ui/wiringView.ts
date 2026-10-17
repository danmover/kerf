// Display state for the 3D wiring: whether it is shown, the cable picked
// (its wire id from the wire list, W1, W2...), the one under the pointer, the
// drag chain or loop picked, and whether the machine is moving through its
// travel so the moving cables can be watched.

import { create } from "zustand";

export const useWiringView = create<{ on: boolean; picked: string | null; hovered: string | null; end: 0 | 1 | null; link: string | null; travel: boolean }>(() => ({
  on: false,
  picked: null,
  hovered: null,
  end: null,
  link: null,
  travel: false,
}));

export function toggleWiring(on = !useWiringView.getState().on) {
  useWiringView.setState(on ? { on } : { on, picked: null, hovered: null, end: null, link: null, travel: false });
}

/** Show the wiring with one cable picked, from the wire list or a part's card. */
export function showWire(id: string) {
  useWiringView.setState({ on: true, picked: id, end: null, link: null });
}
