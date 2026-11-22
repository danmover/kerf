// Display state for "Let go" in the 3D view: gravity on and hands off, with
// each part held only by what the checks found holding it.

import { create } from "zustand";
import { useView } from "../app/view";

export const useLetGo = create<{
  on: boolean;
  /** bumped to let go again from the start */
  n: number;
  /** "running" while things move, "settled" once they rest, "none" when nothing can move, "waiting" for the build, "error" */
  state: "idle" | "waiting" | "running" | "settled" | "none" | "error";
  /** what happened, in a line */
  line: string;
}>(() => ({ on: false, n: 0, state: "idle", line: "" }));

export function toggleLetGo(on = !useLetGo.getState().on) {
  // the mechanism's own run and this one both move the parts: one at a time
  if (on) useView.setState({ playing: false });
  useLetGo.setState(on ? { on, n: useLetGo.getState().n + 1, state: "waiting", line: "" } : { on, state: "idle", line: "" });
}

/** Let go again from where the design is drawn. */
export function letGoAgain() {
  if (useLetGo.getState().on) useLetGo.setState({ n: useLetGo.getState().n + 1 });
}
