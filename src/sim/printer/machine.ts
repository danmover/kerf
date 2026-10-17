// The physical printer the simulated firmware drives, read from the design:
// each axis's motors, moving mass, friction and drive (from the design's
// stepper_axis calculations where it has them), the hotend and bed as heated
// masses that lose heat to the room, the hotend's melt rate, the power supply
// and the probe. The firmware's config says what it believes; this is what is
// really there, so a config that asks too much of the hardware shows up.

import { catalogPart } from "../../machine/catalog";
import { fwContext } from "../../machine/firmware/common";
import { boardFlavors, devName, fullSteps, printerFacts, type PrinterAxis, type PrinterFacts, type PrinterFlavor } from "../../machine/firmware/printer";
import type { CalcTrace, CatalogPart, FirmwareDef, MachineData } from "../../machine/types";
import type { AxisE } from "./config";

export interface AxisPhys {
  axis: AxisE;
  /** "X", "Y", "Z", "extruder" */
  label: string;
  /** the motor component and how many motors drive the axis */
  comp: string;
  motors: number;
  /** each motor: holding torque at rated current (N·mm), rated current (A), phase inductance (H) and resistance, full steps per turn, rotor inertia (kg·m²) */
  tHold: number;
  iRated: number;
  lPhase: number;
  /** phase resistance, Ω */
  rPhase: number;
  fullSteps: number;
  inertia: number;
  /** axis (or filament) travel per motor turn, mm */
  mmPerRev: number;
  /** load on each motor: moving mass (kg) and friction (N), and the drive's efficiency */
  mass: number;
  friction: number;
  efficiency: number;
  /** the axis lifts its load */
  vertical: boolean;
  /** where the load came from */
  from: string;
}

export interface HeaterPhys {
  comp: string;
  label: string;
  /** heater power at the supply voltage, W */
  power: number;
  /** heat capacity, J/K, and loss to the room, W/K */
  capacity: number;
  loss: number;
  /** extra loss with the part fan at full speed blowing past it, W/K */
  lossFan: number;
  /** how far the thermistor lags the heated mass, s */
  lag: number;
  /** the part's own temperature limit, °C */
  limit: number;
  from: string;
}

export interface PrinterPhys {
  firmware: string;
  board: { comp: string; name: string; flavors: PrinterFlavor[] };
  supply: number;
  psu?: { comp: string; watts: number };
  axes: Partial<Record<AxisE, AxisPhys>>;
  hotend?: HeaterPhys;
  bed?: HeaterPhys;
  /** the hotend's melt rate at its usual printing temperature, mm³/s */
  maxFlow: number;
  nozzle: number;
  filament: number;
  bed_size: [number, number];
  probe?: { comp: string; accuracy: number };
  fans: { part?: string; hotend?: string; controller?: string };
  /** board, host, fans and drivers at rest, W */
  idleWatts: number;
  facts: PrinterFacts;
  assumptions: string[];
}

const AXIS_OF: Record<PrinterAxis, AxisE> = { x: "x", y: "y", z: "z", extruder: "e" };
const LABEL: Record<AxisE, string> = { x: "X", y: "Y", z: "Z", e: "extruder" };

const specNum = (p: CatalogPart | undefined, k: string, d: number) => (p && typeof p.specs[k] === "number" ? (p.specs[k] as number) : d);

/** The design's stepper_axis calculation for a motor component, if it has one. */
function axisCalc(calcs: CalcTrace[], comp: string): CalcTrace | undefined {
  return calcs.find((c) => c.fn === "stepper_axis" && c.title.startsWith(`${comp}:`));
}

const input = (c: CalcTrace | undefined, label: string) => c?.inputs.find((i) => i.label === label)?.value;

export function printerPhys(m: MachineData, fw: FirmwareDef, designName: string): PrinterPhys | string {
  const ctx = fwContext(m, fw, designName);
  if (typeof ctx === "string") return ctx;
  const f = printerFacts(ctx);
  const assumptions: string[] = [];
  const psuComp = m.components.find((x) => catalogPart(x.catalogId)?.kind === "psu");
  const psuPart = psuComp && catalogPart(psuComp.catalogId);
  const supply = specNum(psuPart, "v_out", 24);

  const axes: PrinterPhys["axes"] = {};
  for (const pa of ["x", "y", "z", "extruder"] as PrinterAxis[]) {
    const ls = f.steppers.get(pa);
    if (!ls?.length) continue;
    const ax = AXIS_OF[pa];
    const comp = ls[0].dev.comp;
    const motor = catalogPart(ls[0].dev.mc.catalogId);
    const calc = axisCalc(m.calcs, comp);
    const motors = ls.length;
    const vertical = ax === "z";
    let mass: number;
    let friction: number;
    let efficiency: number;
    let from: string;
    if (calc) {
      mass = input(calc, "Moving mass") ?? 0.5;
      friction = input(calc, "Friction") ?? 5;
      efficiency = (input(calc, "Drive efficiency") ?? 90) / 100;
      from = `the design's ${calc.name} calculation`;
    } else if (ax === "e") {
      // the filament's drag through the drive and the cold end; the melt's back-pressure is added as it flows
      mass = 0.01;
      friction = 5;
      efficiency = 0.8;
      from = "a typical geared extruder";
    } else {
      mass = ax === "z" ? 1 : ax === "y" ? 1.2 : 0.6;
      friction = 5;
      efficiency = ax === "z" ? 0.4 : 0.9;
      from = "a typical bed-slinger (the design has no stepper_axis calculation for it)";
      assumptions.push(`${LABEL[ax]} axis: no calc.stepper_axis(...) for ${comp}, so Kerf assumed ${mass} kg moving and 5 N of friction.`);
    }
    const mmPerRev = pa === "extruder" ? f.rot.extruder.v / f.gearRatio : f.rot[pa].v;
    axes[ax] = {
      axis: ax,
      label: LABEL[ax],
      comp: motors > 1 ? `${comp}` : devName(ls[0]),
      motors,
      tHold: specNum(motor, "t_hold", 400),
      iRated: specNum(motor, "i_rated", 1.5),
      lPhase: specNum(motor, "l_phase", 3) / 1000,
      rPhase: specNum(motor, "r_phase", 2),
      fullSteps: fullSteps(ls[0]),
      inertia: specNum(motor, "rotor_inertia_gcm2", 50) * 1e-7,
      mmPerRev,
      mass,
      friction,
      efficiency,
      vertical,
      from,
    };
  }

  // heaters: the design's warm-up calculations give the heated mass and its loss
  const warm = m.calcs.filter((c) => c.fn === "heater_warmup");
  const heater = (part: CatalogPart | undefined, comp: string | undefined, role: "hotend" | "bed"): HeaterPhys | undefined => {
    if (!part || !comp) return undefined;
    const power = role === "hotend" ? specNum(part, "heater_w", 40) : specNum(part, "power_w", 200);
    const calc = warm.find((c) => input(c, "Heater power") === power && (role === "bed" ? (input(c, "Heated mass") ?? 0) > 100 : (input(c, "Heated mass") ?? 1e9) <= 100));
    const mass = input(calc, "Heated mass") ?? (role === "hotend" ? 15 : specNum(part, "mass_g", 900) + 250);
    const c = input(calc, "Specific heat") ?? 0.9;
    const loss = input(calc, "Heat loss") ?? (role === "hotend" ? 0.1 : power / 100);
    if (!calc) assumptions.push(`${comp}: no calc.heater_warmup(...) for it, so Kerf assumed ${Math.round(mass)} g of aluminium losing ${loss.toFixed(2)} W/K.`);
    return {
      comp,
      label: role === "hotend" ? "Hotend" : "Bed",
      power,
      capacity: mass * c,
      loss,
      // the part-cooling blower washes past the heater block; a silicone sock halves this
      lossFan: role === "hotend" ? 0.03 : 0.3,
      // thermistor in the block (hotend) or taped under the plate (bed)
      lag: role === "hotend" ? 1.5 : 4,
      limit: specNum(part, "max_temp_c", role === "hotend" ? 285 : 110),
      from: calc ? `the design's ${calc.name} calculation` : "typical values",
    };
  };
  const hotend = heater(f.hotPart, f.hotHeater?.dev.comp, "hotend");
  const bed = heater(f.bedPart, f.bedHeater?.dev.comp, "bed");
  const bedPart = f.bedPart;

  const fanOf = (role: string) => f.fans.find((x) => x.role === role)?.link.dev.comp;
  const fans = { part: fanOf("part"), hotend: fanOf("hotend"), controller: fanOf("controller") };
  const fanW = f.fans.reduce((s, x) => s + specNum(catalogPart(x.link.dev.mc.catalogId), "i", 0.1) * specNum(catalogPart(x.link.dev.mc.catalogId), "v", 24), 0);
  const probePart = f.probe && catalogPart(f.probe.dev.mc.catalogId);

  if (!psuPart) assumptions.push(`No power supply in the design: Kerf assumed a ${supply} V supply that never runs out.`);
  return {
    firmware: fw.name,
    board: { comp: f.board, name: ctx.boardPart.name, flavors: boardFlavors(ctx.boardPart) },
    supply,
    psu: psuComp ? { comp: psuComp.name, watts: specNum(psuPart, "power_w", supply * specNum(psuPart, "i_out", 10)) } : undefined,
    axes,
    hotend,
    bed,
    maxFlow: specNum(f.hotPart, "max_flow_mm3_s", 12),
    nozzle: f.nozzle,
    filament: f.filament,
    bed_size: [specNum(bedPart, "w", f.size.x), specNum(bedPart, "d", f.size.y)],
    probe: f.probe ? { comp: f.probe.dev.comp, accuracy: specNum(probePart, "accuracy_mm", 0.01) } : undefined,
    fans,
    // board and drivers, the host computer and the fans
    idleWatts: 3 + (f.host ? 3 : 0) + fanW,
    facts: f,
    assumptions,
  };
}

/** A motor's torque at a speed: flat to the corner speed, then falling as 1/speed (the same model as calc.stepper_axis). */
export function motorTorque(a: AxisPhys, amps: number, revPerS: number, supply: number): number {
  const I = Math.max(1e-3, amps);
  const t0 = a.tHold * Math.min(1, I / a.iRated) * 0.85;
  const corner = supply / (2 * a.lPhase * I) / a.fullSteps;
  return revPerS <= corner ? t0 : (t0 * corner) / revPerS;
}
