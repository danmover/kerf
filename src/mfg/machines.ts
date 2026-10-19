// Machine and shop profiles: the printer, mill, press or foundry a part is
// really made on. A profile is a named set of the process's machine settings
// (bed size, nozzle temperature, tool library, clamp force...). The user
// picks one per process in Settings → Making, or a part names one with
// mfg.fdm(machine: "Prusa MK4"); its settings fill in whatever the part's own
// process call leaves out, so the checks test the part against that machine.
// Without one, a process is checked against a typical shop.

import { PROCESSES, PROCESS_IDS, axisName, fmt, isProcessId, sanitizeSettings, toolName, type SettingDef } from "./profiles";
import type { ProcessId, ProcessSpec, SettingValue, Tool } from "./types";
import type { V3 } from "../kernel/recipe";

export interface MachineProfile {
  id: string;
  name: string;
  process: ProcessId;
  /** values for the process's machine settings; the rest keep their defaults */
  settings: Record<string, SettingValue>;
  /** one line on what it is, for the picker */
  note?: string;
}

/** Where the machines come from: the user's own profiles and which one each process uses. */
export interface MachineContext {
  machines: MachineProfile[];
  /** process id → machine id; a process with none is checked against a typical shop */
  machineFor: Partial<Record<string, string>>;
}

export const NO_MACHINES: MachineContext = { machines: [], machineFor: {} };

/** The settings a machine profile sets: the ones that describe the machine rather than the part. */
export const machineSettings = (id: ProcessId): SettingDef[] => PROCESSES[id].settings.filter((s) => s.machine);

const m = (id: string, name: string, process: ProcessId, settings: Record<string, SettingValue>, note: string): MachineProfile => ({ id, name, process, settings, note });

/**
 * Common machines with their published specs (build volume, nozzle
 * temperature, travel, spindle...), and typical shops for the processes most
 * people order. Values are the makers' figures where they publish them and
 * typical ones otherwise; a user can copy any of them and correct it.
 */
export const MACHINE_PRESETS: MachineProfile[] = [
  // FDM printers
  m("prusa-mk4", "Prusa MK4S", "fdm", { bed: [250, 210, 220], max_temp: 290, enclosed: false }, "Open frame, single nozzle"),
  m("prusa-core-one", "Prusa CORE One", "fdm", { bed: [250, 220, 270], max_temp: 290, enclosed: true }, "Enclosed, single nozzle"),
  m("prusa-xl-5", "Prusa XL (5 toolheads)", "fdm", { bed: [360, 360, 360], max_temp: 290, enclosed: false, soluble: true }, "Open frame, prints soluble supports from a second toolhead"),
  m("bambu-x1c", "Bambu Lab X1 Carbon", "fdm", { bed: [256, 256, 256], max_temp: 300, enclosed: true }, "Enclosed; supports break away (set soluble with PVA in the AMS)"),
  m("bambu-p1s", "Bambu Lab P1S", "fdm", { bed: [256, 256, 256], max_temp: 300, enclosed: true }, "Enclosed, single nozzle"),
  m("bambu-a1", "Bambu Lab A1", "fdm", { bed: [256, 256, 256], max_temp: 300, enclosed: false }, "Open bed-slinger"),
  m("bambu-h2d", "Bambu Lab H2D", "fdm", { bed: [300, 320, 325], max_temp: 350, enclosed: true, soluble: true }, "Enclosed, two nozzles: soluble supports"),
  m("ender-3-v3", "Creality Ender-3 V3", "fdm", { bed: [220, 220, 250], max_temp: 300, enclosed: false }, "Open frame, single nozzle"),
  m("voron-24", "Voron 2.4 (350)", "fdm", { bed: [350, 350, 340], max_temp: 300, enclosed: true }, "Enclosed CoreXY"),
  // resin and powder
  m("form-4", "Formlabs Form 4", "sla", { bed: [200, 125, 210] }, "Resin, masked SLA"),
  m("saturn-4-ultra", "Elegoo Saturn 4 Ultra", "sla", { bed: [218, 123, 220] }, "Resin, MSLA"),
  m("fuse-1", "Formlabs Fuse 1+ 30W", "sls", { bed: [165, 165, 300] }, "Nylon SLS"),
  m("hp-mjf", "HP Multi Jet Fusion (service)", "sls", { bed: [380, 284, 380] }, "What most online services run"),
  m("eos-m290", "EOS M 290 (service)", "metal_print", { bed: [250, 250, 325] }, "Laser powder-bed fusion"),
  // mills
  m("desktop-router", "Desktop CNC router", "cnc_mill", { frame: "router", envelope: [440, 440, 100], rpm: 24000, vise: 0, tools: [[1.6, 5], [3.175, 12], [6.35, 25]] }, "Shapeoko, X-Carve or Onefinity class: wood, plastic, light aluminium"),
  m("benchtop-mill", "Benchtop CNC mill", "cnc_mill", { frame: "benchtop", envelope: [254, 159, 254], rpm: 10000, vise: 100, tools: [[1, 3], [2, 6], [3, 10], [4, 14], [6, 20], [10, 30]] }, "Tormach PCNC 440 class: aluminium and steel"),
  m(
    "vmc-3",
    "3-axis machining centre (job shop)",
    "cnc_mill",
    { frame: "vmc", envelope: [762, 406, 508], rpm: 12000, vise: 228, tools: [[1, 4], [1, 8], [2, 8], [2, 16], [3, 12], [3, 25], [4, 16], [6, 24], [6, 50], [8, 32], [10, 40], [12, 50], [16, 64], [20, 80]] },
    "Haas VF-2 class with a 6-inch vise and long-reach tools",
  ),
  m(
    "vmc-4",
    "4-axis machining centre",
    "cnc_mill",
    { frame: "vmc", axes: 4, envelope: [762, 406, 508], rpm: 12000, vise: 150, tools: [[1, 4], [2, 8], [2, 16], [3, 12], [3, 25], [4, 16], [6, 24], [6, 50], [8, 32], [10, 40], [12, 50], [16, 64]] },
    "A rotary table about X turns the part between cuts",
  ),
  m(
    "vmc-5",
    "5-axis machining centre",
    "cnc_mill",
    { frame: "vmc", axes: 5, envelope: [762, 508, 508], rpm: 12000, vise: 160, tools: [[1, 4], [2, 8], [2, 16], [3, 12], [3, 25], [4, 16], [6, 24], [6, 50], [8, 32], [10, 40], [12, 50], [16, 64]] },
    "Haas UMC-750 class trunnion: every side but the bottom in one setup",
  ),
  // lathes
  m("benchtop-lathe", "Benchtop CNC lathe", "cnc_lathe", { max_d: 150, max_length: 250 }, "Tormach 8L class"),
  m("shop-lathe", "CNC lathe (job shop)", "cnc_lathe", { max_d: 356, max_length: 406 }, "Haas ST-10 class"),
  m("mill-turn", "Mill-turn lathe with live tools", "cnc_lathe", { max_d: 250, max_length: 500, live_tools: true }, "Mills flats and cross holes in the same setup"),
  // presses
  m("bench-injection", "Benchtop injection press", "injection", { clamp: 4, shot: 25 }, "Hand-lever press with aluminium moulds"),
  m("press-150", "Moulding press, 150 t", "injection", { clamp: 150, shot: 300 }, "A typical moulder's mid-size press"),
  m("press-500", "Moulding press, 500 t", "injection", { clamp: 500, shot: 1500 }, "For large housings and multi-cavity moulds"),
  m("die-250", "Die-casting machine, 250 t", "die_cast", { clamp: 250, shot: 600 }, "Small to medium castings"),
  m("die-800", "Die-casting machine, 800 t", "die_cast", { clamp: 800, shot: 3000 }, "Large housings"),
  // casting
  m("vacuum-small", "Small vacuum chamber", "vacuum_cast", { chamber: [300, 300, 300], max_pour: 1 }, "A home or studio set-up"),
  m("home-foundry", "Home foundry (#10 crucible)", "sand_cast", { flask: [300, 250, 200], max_pour: 3 }, "About 3 kg of aluminium per pour"),
  m("lost-wax-studio", "Lost-wax studio caster", "investment_cast", { max_size: [100, 100, 150], max_pour: 1 }, "Jewellery and small parts"),
  // sheet and cutting
  m("finger-brake", "Benchtop finger brake", "sheet_metal", { brake: 600, max_t: 1.5 }, "Hand brake for thin sheet"),
  m("brake-40t", "Press brake, 40 t", "sheet_metal", { brake: 1250, max_t: 4 }, "A small fabrication shop"),
  m("co2-40w", "Desktop CO2 laser (40 W)", "laser_cut", { source: "co2", bed: [500, 300, 6] }, "Wood and acrylic up to about 6 mm"),
  m("co2-100w", "CO2 laser (100 W)", "laser_cut", { source: "co2", bed: [1300, 900, 15] }, "Wood and acrylic up to about 15 mm"),
  m("diode-20w", "Diode laser (20 W)", "laser_cut", { source: "diode", bed: [400, 400, 8] }, "xTool or Ortur class: thin wood and dark acrylic"),
  m("fiber-3kw", "Fiber laser cutter (3 kW)", "laser_cut", { source: "fiber", bed: [3000, 1500, 20] }, "Sheet metal job shop"),
  m("plasma-table", "CNC plasma table", "laser_cut", { source: "plasma", bed: [1250, 1250, 16] }, "Steel and aluminium plate"),
  m("waterjet", "Waterjet (service)", "laser_cut", { source: "waterjet", bed: [3000, 1500, 100] }, "Cuts anything flat"),
];

/** Profiles of one process: the user's first, then the presets. */
export function machinesFor(process: ProcessId, ctx: MachineContext): MachineProfile[] {
  return [...ctx.machines.filter((x) => x.process === process), ...MACHINE_PRESETS.filter((x) => x.process === process)];
}

/** A profile by id or name (any case), the user's own first. */
export function findMachine(key: string, ctx: MachineContext, process?: ProcessId): MachineProfile | undefined {
  const k = key.trim().toLowerCase();
  const all = [...ctx.machines, ...MACHINE_PRESETS].filter((x) => !process || x.process === process);
  return all.find((x) => x.id.toLowerCase() === k) ?? all.find((x) => x.name.toLowerCase() === k);
}

/**
 * The machine a part's process is checked against: the one the part names,
 * else the user's machine for that process, else none (a typical shop).
 */
export function machineForSpec(spec: ProcessSpec, ctx: MachineContext): { machine?: MachineProfile; missing?: string } {
  if (spec.machine) {
    const named = findMachine(spec.machine, ctx, spec.id);
    return named ? { machine: named } : { missing: spec.machine };
  }
  const id = ctx.machineFor[spec.id];
  const machine = id ? findMachine(id, ctx, spec.id) : undefined;
  return machine ? { machine } : {};
}

/** The process with the machine's settings under the part's own: the part's settings win. */
export function withMachine(spec: ProcessSpec, machine: MachineProfile | undefined): ProcessSpec {
  if (!machine || machine.process !== spec.id) return spec;
  return { ...spec, settings: { ...sanitizeSettings(spec.id, machine.settings), ...spec.settings } };
}

/** A process as checked: with its machine's settings, and the machine's name for messages. */
export function specOnMachine(spec: ProcessSpec, ctx: MachineContext): { spec: ProcessSpec; machine?: string; missing?: string } {
  const { machine, missing } = machineForSpec(spec, ctx);
  return { spec: withMachine(spec, machine), machine: machine?.name, missing };
}

const fmtValue = (sd: SettingDef, v: SettingValue): string => {
  if (sd.kind === "bool") return v ? "yes" : "no";
  if (sd.kind === "size") return (v as V3).map((x) => fmt(x)).join(" × ");
  if (sd.kind === "tools") return (v as Tool[]).map(toolName).join(", ");
  if (sd.kind === "dir") return axisName(v as V3);
  return String(typeof v === "number" ? fmt(v) : v);
};

/** One line describing a machine's settings, for Claude and tooltips. */
export function machineSummary(machine: MachineProfile): string {
  const parts: string[] = [];
  for (const sd of machineSettings(machine.process)) {
    const v = machine.settings[sd.key];
    if (v === undefined) continue;
    parts.push(`${sd.key} ${fmtValue(sd, v)}`);
  }
  return `${machine.name} (${parts.join("; ") || "typical settings"})`;
}

/** The machines this user checks parts against, one line per process, for Claude. */
export function machinesText(ctx: MachineContext): string {
  const lines: string[] = [];
  for (const id of PROCESS_IDS) {
    const mid = ctx.machineFor[id];
    const machine = mid ? findMachine(mid, ctx, id) : undefined;
    if (machine) lines.push(`${id}: ${machineSummary(machine)}`);
  }
  return lines.length
    ? `Machines (Settings → Making; each process's parts are checked against these): ${lines.join(" | ")}. Other processes are checked against a typical shop.`
    : "Machines: none chosen, so every process is checked against a typical shop (Settings → Making sets the user's printer, mill and so on).";
}

/** A new id for a user's machine. */
export const newMachineId = () => `m-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Profiles from storage or another device: known processes, sane names, settings sanitised. Anything else is dropped. */
export function sanitizeMachines(raw: unknown): MachineProfile[] {
  if (!Array.isArray(raw)) return [];
  const out: MachineProfile[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    if (typeof o.id !== "string" || !/^[\w-]{1,40}$/.test(o.id) || typeof o.process !== "string" || !isProcessId(o.process)) continue;
    const name = typeof o.name === "string" ? o.name.trim().slice(0, 60) : "";
    if (!name || out.some((y) => y.id === o.id)) continue;
    const settings = sanitizeSettings(o.process, o.settings);
    // only machine settings belong in a profile
    for (const k of Object.keys(settings)) if (!machineSettings(o.process).some((sd) => sd.key === k)) delete settings[k];
    out.push({ id: o.id, name, process: o.process, settings, ...(typeof o.note === "string" && o.note ? { note: o.note.slice(0, 120) } : {}) });
    if (out.length >= 60) break;
  }
  return out;
}

/** Which machine each process uses, from storage: known processes and plausible ids only. */
export function sanitizeMachineFor(raw: unknown): Partial<Record<string, string>> {
  const out: Partial<Record<string, string>> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) if (isProcessId(k) && typeof v === "string" && /^[\w-]{1,40}$/.test(v)) out[k] = v;
  return out;
}
