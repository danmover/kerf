// The Build tab's Sound section: the design's circuit simulated, with its
// knobs to turn, the frequency response they give, and a guitar to listen to.

import type { MachineData } from "../machine/types";

export function SoundPanel({ m }: { m: MachineData }) {
  return <div className="mp-pad">{m.components.length} parts.</div>;
}
