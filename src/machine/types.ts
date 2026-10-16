// Types for the machine layer: purchasable parts with electrical pins,
// wiring, engineering calculations, firmware and physical tests. Everything
// here is derived from the .kerf source, like the rest of the model.

import type { Span } from "../lang/ast";

/**
 * What a pin is, electrically. The rules check (erc.ts) reasons about nets
 * using these types and the ratings on each pin.
 */
export type PinType =
  | "gnd" // ground reference
  | "pwr_in" // consumes power: works from vmin..vmax, damaged above vabs
  | "pwr_out" // supplies power at v, up to imax amps
  | "pwr_rail" // a board rail that supplies power (v, imax) unless something else feeds it, then it is an input
  | "io" // microcontroller GPIO at logic level v
  | "in" // module logic input: tolerates up to vmax, reads high above vih
  | "out" // module logic output at level v
  | "analog_out" // module analog output (current sense, potentiometer): needs an ADC pin
  | "motor_out" // driver output terminal for a DC motor
  | "motor" // DC motor terminal
  | "passive" // switch, fuse or connector terminal: joins `through` when closed
  | "port"; // multi-conductor connector (stepper, fan, heater, thermistor, endstop, probe)

export type BusKind = "i2c_sda" | "i2c_scl" | "uart_tx" | "uart_rx" | "spi_mosi" | "spi_miso" | "spi_sck";

export interface PinDef {
  /** identifier used in .kerf wiring, e.g. D5, V5, B_PLUS */
  id: string;
  /** label printed on the part, e.g. "5V", "B+" */
  label?: string;
  type: PinType;
  /** volts: logic level (io/out), supply voltage (pwr_out/pwr_rail), rating (motor) */
  v?: number;
  /** pwr_in: lowest working supply */
  vmin?: number;
  /** pwr_in: highest recommended supply; in: highest tolerated input */
  vmax?: number;
  /** pwr_in: absolute maximum before damage */
  vabs?: number;
  /** in: lowest voltage read as logic high */
  vih?: number;
  /** pwr_out/pwr_rail/port source: continuous amps available; io: per-pin limit; motor_out: per channel */
  imax?: number;
  /** motor_out / port source: peak amps */
  ipeak?: number;
  /** pwr_in / pwr_rail used as an input: amps the part itself draws (not counting what it powers) */
  draw?: number;
  /** io: hardware PWM */
  pwm?: boolean;
  /** io: analog input */
  adc?: boolean;
  /** io: input only (cannot drive) */
  input_only?: boolean;
  /** in: the pin driving this must be PWM capable; out: the pin reading this should take interrupts */
  needs?: "pwm" | "irq";
  /** io: can trigger interrupts (encoders) */
  irq?: boolean;
  bus?: BusKind;
  /** motor_out/motor: bridge channel or terminal group */
  channel?: string;
  /** passive: terminal joined to this one when closed */
  through?: string;
  /** port: connector kind, both ends must match (stepper4, fan2, heater2, therm2, endstop3, probe5) */
  port?: string;
  /** port: board side (source) or device side (sink) */
  side?: "source" | "sink";
  /** port sink: what the device needs: amps (stepper phase current, fan), watts (heater) */
  need_a?: number;
  need_w?: number;
  /** must be connected for the part to work */
  required?: boolean;
  /** out: the logic level follows the voltage on this pin of the same part (encoder outputs follow their VCC) */
  vref?: string;
  /** name the firmware uses: Arduino pin number, STM32 pin (PB13), GPIO number */
  mcu?: string;
  note?: string;
}

/** Catalog categories, used for lib.<kind>("id") lookups and grouping. */
export type CatalogKind =
  | "controller"
  | "host"
  | "motor_driver"
  | "stepper_driver"
  | "gearmotor"
  | "stepper"
  | "servo"
  | "actuator"
  | "battery"
  | "psu"
  | "regulator"
  | "switch"
  | "fuse"
  | "connector"
  | "sensor"
  | "hotend"
  | "extruder"
  | "heated_bed"
  | "fan"
  | "extrusion"
  | "rail"
  | "rod"
  | "linear_bearing"
  | "lead_screw"
  | "pulley"
  | "coupler"
  | "seal";

/** Geometry classes. Each generator in geometry.ts reads the numbers it documents. */
export type GeomClass =
  | "board"
  | "gearmotor"
  | "stepper"
  | "servo"
  | "actuator"
  | "box"
  | "extrusion"
  | "rail"
  | "rod"
  | "lead_screw"
  | "pulley"
  | "coupler"
  | "linear_bearing"
  | "hotend"
  | "extruder"
  | "fan"
  | "plate"
  | "ring";

export interface BoardFeature {
  kind: "usb" | "jack" | "header" | "terminal" | "chip" | "heatsink" | "cap" | "socket" | "module";
  /** centre of the feature footprint, relative to the board centre */
  x: number;
  y: number;
  w: number;
  d: number;
  h: number;
  /** overhang past the board edge is fine (USB, jacks) */
}

export interface GeomSpec {
  g: GeomClass;
  /** numeric dimensions in mm, keys documented per class in geometry.ts */
  dims: Record<string, number>;
  /** mounting hole centres relative to the part's local origin (board centre, motor face centre) */
  holes?: [number, number][];
  hole_d?: number;
  features?: BoardFeature[];
  color?: string;
  /** colour of the secondary solid (heatsink, gearbox, wrap) */
  color2?: string;
  material?: string;
}

export interface BuyLink {
  /** shop or maker name shown to the user */
  vendor: string;
  /** direct product page (maker or official distributor) */
  url?: string;
  /** search text for marketplaces; Kerf builds the search links */
  search?: string;
}

export interface CatalogPart {
  id: string;
  kind: CatalogKind;
  name: string;
  maker?: string;
  /** maker's part number */
  mpn?: string;
  /** a commodity part sold by many sellers: specs are typical listing values and vary */
  generic?: boolean;
  /** one-line summary shown in pickers and given to Claude */
  summary: string;
  /** typed specs: units are mm, N·mm (torque), A, V, W, g, rpm, mAh unless the key says otherwise */
  specs: Record<string, number | string | boolean>;
  pins: PinDef[];
  geom: GeomSpec;
  /** typical price in USD, for budgeting only */
  price_usd?: number;
  buy: BuyLink[];
  /** where the specs came from */
  source?: string;
  /** things to know before buying or using it */
  notes?: string[];
  /** physical tests this part usually needs in a new design */
  tests?: string[];
  /** stock items cut to length (extrusions, rods, rails, lead screws) */
  cut_to_length?: boolean;
  /** "m": price_usd is per metre of cut length, otherwise per piece */
  price_per?: "m";
}

// ---------- evaluated machine data on the Model ----------

/** A catalog-backed component instance in the design. */
export interface MachineComponent {
  name: string;
  catalogId: string;
  kind: CatalogKind;
  label: string;
  count: number;
  role?: string;
  /** mechanical load on a motor in N·mm (component prop `load:`) */
  load?: number;
  /** cut length for stock items */
  length?: number;
  buyUrl?: string;
  price?: number;
  span: Span;
}

export interface PinRef {
  comp: string;
  /** instance index for pattern components (0 based) */
  index?: number;
  pin: string;
  span: Span;
}

export interface WireDef {
  a: PinRef;
  b: PinRef;
  /** AWG */
  gauge?: number;
  color?: string;
  label?: string;
  span: Span;
}

export interface NetDef {
  name: string;
  pins: PinRef[];
  gauge?: number;
  color?: string;
  span: Span;
}

export interface CalcLine {
  label: string;
  value: number;
  unit: string;
  note?: string;
}

export interface CalcTrace {
  /** the let name holding the result */
  name: string;
  fn: string;
  title: string;
  inputs: CalcLine[];
  outputs: CalcLine[];
  /** formulas in plain text */
  method: string[];
  assumptions: string[];
  /** how far to trust it */
  confidence: "standard" | "estimate" | "rough";
  /** what a physical test should confirm, if anything */
  verify?: string;
  span: Span;
}

export interface FirmwareDef {
  name: string;
  board?: string;
  settings: Record<string, number | string | boolean>;
  span: Span;
}

export interface TestDef {
  label: string;
  procedure: string;
  span: Span;
}

/** Simple BOM-only purchases (lib.item) with no geometry. */
export interface BuyItem {
  name: string;
  label: string;
  qty: number;
  price?: number;
  buyUrl?: string;
  search?: string;
  span: Span;
}

export interface MachineData {
  components: MachineComponent[];
  wires: WireDef[];
  nets: NetDef[];
  calcs: CalcTrace[];
  firmware: FirmwareDef[];
  tests: TestDef[];
  items: BuyItem[];
}

export function emptyMachine(): MachineData {
  return { components: [], wires: [], nets: [], calcs: [], firmware: [], tests: [], items: [] };
}
