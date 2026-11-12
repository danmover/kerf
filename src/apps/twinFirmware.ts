// The firmware a simulated twin runs, generated from the design the same way
// the scenario runner does: the block the app (or its twin scenario) names,
// or the first Arduino one.

import type { MachineData } from "../machine/types";
import { generateFirmware } from "../machine/firmware";
import type { ScenarioSpec } from "../sim/scenario";

export interface TwinFirmware {
  name: string;
  files: Record<string, string>;
  mcu: string;
  partId?: string;
}

/** The firmware a twin runs: its files and the board they are for. Generated from the machine unless given. */
export function twinFirmware(o: { machine: MachineData; designName: string; firmware?: string; spec: ScenarioSpec }): TwinFirmware | { error: string } {
  const all = generateFirmware(o.machine, o.designName);
  const want = o.firmware ?? o.spec.firmware;
  const fw = (want ? all.find((f) => f.name === want) : all.find((f) => f.target === "arduino")) ?? all[0];
  if (!fw) return { error: "The design has no firmware block for the twin to run" };
  if (fw.target !== "arduino") return { error: fw.target === "klipper" ? `${fw.name} is a Klipper configuration: the twin runs Arduino firmware` : fw.summary };
  const files: Record<string, string> = Object.fromEntries(fw.files.filter((f) => /\.(ino|h|hpp|c|cpp)$/.test(f.path)).map((f) => [f.path.split("/").pop()!, f.content]));
  const mcu = o.machine.components.find((c) => c.name === fw.board);
  return { name: fw.name, files, mcu: fw.board, partId: mcu?.catalogId };
}
