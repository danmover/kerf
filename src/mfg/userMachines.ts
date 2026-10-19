// The user's machines from Settings → Making, for the process checks. Kept
// apart from machines.ts, which settings itself imports.

import { useSettings } from "../app/settings";
import type { MachineContext } from "./machines";

export function userMachines(): MachineContext {
  const s = useSettings.getState();
  return { machines: s.machines, machineFor: s.machineFor };
}
