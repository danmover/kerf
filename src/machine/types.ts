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
  | "port" // multi-conductor connector (stepper, fan, heater, thermistor, endstop, probe)
  | "term"; // analog circuit terminal (resistor, capacitor, pot, op-amp signal pin, jack, speaker): checked by the circuit solver, not the logic rules

export type BusKind = "i2c_sda" | "i2c_scl" | "uart_tx" | "uart_rx" | "spi_mosi" | "spi_miso" | "spi_sck";

export interface PinDef {
  /** identifier used in .kerf wiring, e.g. D5, V5, B_PLUS */
  id: string;
  /** label printed on the part, e.g. "5V", "B+" */
  label?: string;
  /**
   * The stack connector the pin is on ("pc104"): boards stacked on one another join it to the pin in the same place
   * (the same label) on the next board through the connector, so a net between them needs no wire.
   */
  stack?: string;
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

/**
 * Another place on a part where one of its pins can be reached: SDA again in a board's STEMMA QT socket, the supply
 * pin of a servo board's channel 3. Wiring names it like a pin (`imu.QT_SDA`); electrically it is the pin.
 */
export interface SpotDef {
  /** identifier used in .kerf wiring, e.g. QT_SDA, V3 */
  id: string;
  /** the pin it is */
  pin: string;
  /** label printed on the part there */
  label?: string;
}

/**
 * A connector on a part, or a lead it is sold with: the pins that go through it, in contact order. Wiring can
 * join two of them in one statement (`wire servo.LEAD -> hub.CH0`), which makes a wire for each pair of contacts.
 */
export interface ConnDef {
  /** identifier used in .kerf wiring, e.g. QT, CH0, LEAD */
  id: string;
  /** what the build guide calls it, after the part's name: "STEMMA QT socket", "channel 0", "own lead" */
  name: string;
  /** the pins or spots in it, in contact order */
  pins: string[];
  /** a lead fixed to the part: its wires need no cutting, and it must reach */
  lead?: LeadDef;
  /** the wires of the standard cable that plugs in here (a STEMMA QT cable's black, red, blue, yellow): colour of each, in pin order, and their AWG */
  cable?: { colors: string[]; gauge: number };
  /** how it goes together, for the build guide: "It only fits one way round." */
  how?: string;
  /** the plug that goes in here only fits one way round, so the build guide need not tell its wires apart */
  keyed?: boolean;
}

export interface LeadDef {
  /** length from the part to the end of the lead, mm */
  mm: number;
  /** AWG of its wires */
  gauge: number;
  /** colour of each wire, in pin order */
  colors: string[];
  insulation?: WireInsulation;
  /** what is on its end, for the build guide: "3-way servo plug", "4 mm bullet", "bare end"; and its kind when two leads plug into each other along the run */
  end: string;
  joint?: "bullet" | "xt60";
}

/** Catalog categories, used for lib.<kind>("id") lookups and grouping. */
export type CatalogKind =
  | "controller"
  | "host"
  | "motor_driver"
  /** brushless motor controller: battery in, three phases out, an RC throttle pulse and usually a BEC */
  | "esc"
  | "stepper_driver"
  | "gearmotor"
  | "stepper"
  | "servo"
  | "bldc"
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
  | "belt"
  | "coupler"
  | "seal"
  | "led"
  | "magnet"
  /** a wound coil with two leads: an electromagnet a driver feeds (its field is worked out from the winding) */
  | "coil"
  // circuit-board parts and audio
  | "resistor"
  | "capacitor"
  | "potentiometer"
  | "diode"
  | "opamp"
  | "terminal"
  | "header"
  | "jack"
  | "speaker"
  | "amplifier"
  | "display"
  | "knob"
  | "circuit_board";

/** Geometry classes. Each generator in geometry.ts reads the numbers it documents. */
export type GeomClass =
  | "board"
  | "gearmotor"
  | "micro_gearmotor"
  | "tt_motor"
  | "outrunner"
  // electric ducted fan: housing, rotor and stator round the jet axis
  | "edf"
  | "stepper"
  | "servo"
  // serial bus servo: a flat case with an output horn and an idler horn on one axis (geometryBusServo.ts)
  | "bus_servo"
  | "actuator"
  | "box"
  | "extrusion"
  | "rail"
  | "rod"
  | "lead_screw"
  | "pulley"
  | "belt"
  | "coupler"
  | "linear_bearing"
  | "hotend"
  | "extruder"
  | "fan"
  | "plate"
  | "ring"
  // parts soldered to a circuit board: the shape comes from the footprint
  | "pcb_part"
  | "panel_jack"
  | "speaker"
  | "knob"
  | "brick"
  // a desktop supply with a mains inlet and a fixed DC lead, and a USB endoscope's head (geometryBenchParts.ts)
  | "desk_supply"
  | "endoscope"
  // addressable LED boards (rings, sticks, jewels) and plain discs (magnets, slip rings)
  | "led"
  | "disc"
  // differential pressure sensor: a housing with two tube ports and a screw lug
  | "dp_sensor"
  // spacecraft hardware (geometrySpace.ts): solar panels cell by cell, a telescope, a star tracker, a deployable
  // antenna, a patch antenna, an ADCS module, a battery board, microswitches, a sun sensor and a burn-wire hold-down
  | "space_panel"
  | "space_telescope"
  | "space_tracker"
  | "space_ants"
  | "space_patch"
  | "space_adcs"
  | "space_bp4"
  | "space_switch"
  | "space_sun"
  | "space_holddown";

export interface BoardFeature {
  kind: "usb" | "jack" | "header" | "terminal" | "chip" | "heatsink" | "cap" | "socket" | "module";
  /** centre of the feature footprint, relative to the board centre */
  x: number;
  y: number;
  w: number;
  d: number;
  h: number;
  /** overhang past the board edge is fine (USB, jacks) */
  /** on the underside of the board, hanging down from it (a lead socket on the back of a camera board); drawn as its own solid */
  side?: "bottom";
  /** an underside feature's colour */
  color?: string;
}

export interface GeomSpec {
  g: GeomClass;
  /** numeric dimensions in mm, keys documented per class in geometry.ts */
  dims: Record<string, number>;
  /** mounting hole centres relative to the part's local origin (board centre, motor face centre) */
  holes?: [number, number][];
  hole_d?: number;
  /** space_panel: the holes are countersunk for flat-head screws, to this diameter at the top face */
  csink?: number;
  /**
   * how the wiring router sees the part: "exact" for one whose solids are mostly open (a telescope's hollow barrel,
   * a module's corner spacers), so the cables can use the room round it; filled boxes otherwise
   */
  route?: "exact";
  features?: BoardFeature[];
  color?: string;
  /** colour of the secondary solid (heatsink, gearbox, wrap) */
  color2?: string;
  material?: string;
  /**
   * box class only: draw the details of a known kind of part inside the same
   * envelope (lipo, esc, fuse_maxi, fuse_blade, terminal_way, xt, load_cell, wago), so mount and clash checks
   * see the box they always did
   */
  style?: "lipo" | "esc" | "fuse_maxi" | "fuse_blade" | "terminal_way" | "xt" | "load_cell" | "wago";
  /**
   * servo class only: how the real case looks. mid is the middle case's colour (with the tabs; an alloy
   * middle takes mid_material), label and text the sticker on its sides, spline the output shaft's colour
   * and material (white POM in a plastic-geared servo, metal in a metal-geared one)
   */
  servo?: { mid?: string; mid_material?: string; label?: string; text?: string; spline?: string; spline_material?: string };
  /**
   * edf class only: how the real fan looks. spinner makes the spinner its own solid in that colour and
   * material (a machined metal one); can is the colour of the inrunner motor's rear end showing behind the
   * hub (dims can_d, can_l); leads the colour of the motor wires
   */
  edf?: { spinner?: string; spinner_material?: string; can?: string; can_material?: string; leads?: string };
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
  /** further places its pins can be reached (a second socket, a channel's own supply pin) */
  spots?: SpotDef[];
  /** its connectors and the leads it is sold with, for wiring a whole plug at once and for the build guide */
  conns?: ConnDef[];
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
  /** solders to a circuit board with this footprint (see catalog/footprints.ts) */
  footprint?: FootprintSpec;
  /** how the part behaves in the circuit solver (see circuit/netlist.ts) */
  sim?: SimModel;
  /** the part takes a value: lib.resistor("10k"), lib.capacitor("100n"), lib.pot("A500k") */
  valued?: "ohm" | "farad" | "pot";
  /** a sealed plug-in supply: no mains wiring inside the design */
  external?: boolean;
  /** small parts bought with it when it goes on a board (an IC socket, female headers) */
  extras?: { label: string; qty: number; price_usd?: number; search: string }[];
}

/** Footprints for through-hole parts, by family. Pin ids are the catalog pin ids. */
export type FootprintSpec =
  /** axial lead part lying flat: resistors, diodes. `band` marks the cathode pin */
  | { k: "axial"; pins: [string, string]; pitch: number; body_d: number; body_l: number; drill: number; pad: number; band?: string; color: string; band_color?: string }
  /** round radial part standing up: electrolytic capacitors. `plus` is the positive pin */
  | { k: "radial"; pins: [string, string]; pitch: number; body_d: number; body_h: number; drill: number; pad: number; plus?: string; color: string }
  /** box or disc radial part: film and ceramic capacitors */
  | { k: "box"; pins: [string, string]; pitch: number; body_w: number; body_t: number; body_h: number; drill: number; pad: number; color: string }
  /** dual in-line package, pins listed in pin-number order (1 at the top left, counter-clockwise seen from above) */
  | { k: "dip"; pins: string[]; row: number; drill: number; pad: number; socket: boolean }
  /** parts with one row of pins: TO-220, TO-92, headers and screw terminals */
  | { k: "inline"; pins: string[]; pitch: number; drill: number; pad: number; pad_h?: number; style: "to220" | "to92" | "header_m" | "header_f" | "terminal" }
  /** Alpha 9 mm vertical potentiometer: pins CCW, W, CW and two mounting tabs (pin MT) */
  | { k: "pot9" }
  /** explicit pads (module on headers): positions relative to the part's own origin */
  | { k: "pads"; pads: { pin: string; num: string; x: number; y: number }[]; drill: number; pad: number; square?: string; lift: number };

/** Circuit solver models. Values come from the component (resistors, capacitors, pots) or the part. */
export type SimModel =
  | { k: "R" }
  | { k: "C" }
  | { k: "pot" }
  | { k: "D"; is: number; nf: number; rs: number; bv?: number }
  /** op-amp package: each channel is [in+, in−, out]; supply pins V+ and V−; iq is per channel */
  | { k: "opamp"; channels: [string, string, string][]; vpos: string; vneg: string; a0: number; gbw: number; rout: number; swing: [number, number]; iq: number }
  | { k: "reg"; in: string; gnd: string; out: string; vout: number; dropout: number; ilim: number; iq: number }
  /** a load between two pins: input of an amplifier module, a speaker */
  | { k: "load"; a: string; b: string; r: number; l?: number }
  /** a supply: v volts between pos and neg with an output resistance */
  | { k: "supply"; pos: string; neg: string; v: number; r: number }
  /** a guitar input: the source is connected between sig and gnd through the pickup's impedance */
  | { k: "input"; sig: string; gnd: string }
  /** draws a fixed current from pwr to gnd (modules: controller, display) */
  | { k: "draw"; pwr: string; gnd: string; a: number };

// ---------- evaluated machine data on the Model ----------

/** A catalog-backed component instance in the design. */
export interface MachineComponent {
  name: string;
  catalogId: string;
  kind: CatalogKind;
  label: string;
  count: number;
  role?: string;
  /** the component's own X, Y and Z axes in design coordinates, when its placement turns it (an IMU's chip axes) */
  axes?: [[number, number, number], [number, number, number], [number, number, number]];
  /** where the component's own origin (its `at` point) sits in design coordinates, mm: its first instance */
  at?: [number, number, number];
  /** mechanical load on a motor in N·mm (component prop `load:`) */
  load?: number;
  /** cut length for stock items */
  length?: number;
  buyUrl?: string;
  price?: number;
  /** a fuse's rating in A (component prop `rating:`), in place of the catalog's */
  rating?: number;
  /** an LED board's brightness cap, 0 to 1 (component prop `brightness:`): the firmware never sets it brighter, so its power is budgeted at that share of full white */
  brightness?: number;
  /** resistance (Ω), capacitance (F) or pot resistance (Ω) */
  value?: number;
  /** the value as written: "10k", "100n", "A500k" */
  valueText?: string;
  /** pots: "A" log (audio) or "B" linear */
  taper?: "A" | "B";
  /** capacitor type and voltage rating */
  capType?: "film" | "ceramic" | "electrolytic";
  vRating?: number;
  /** soldered to a circuit board: board component name, position on it (mm from its bottom-left corner), rotation and side */
  pcb?: { board: string; x: number; y: number; rot: number; side: "top" | "bottom" };
  /** reference designator on the board (R1, C4, U2) */
  ref?: string;
  /** catalog specs replaced by values measured on the real part (`measured: sim.measured(...)`), for the simulation */
  measured?: Record<string, number>;
  /** how the part is held where the geometry cannot show it (`held: "hook-and-loop strap"`) */
  held?: string;
  /** its wires are soldered straight to its pads (`leads: "soldered"`), with no plugs or headers */
  leads?: "soldered";
  span: Span;
}

/** A circuit board designed in Kerf (lib.circuit_board): routed and turned into board-house files. */
export interface BoardDef {
  name: string;
  title: string;
  w: number;
  d: number;
  t: number;
  corner: number;
  /** mounting holes, mm from the bottom-left corner */
  holes: { x: number; y: number; d: number }[];
  span: Span;
}

export interface PinRef {
  comp: string;
  /** instance index for pattern components (0 based) */
  index?: number;
  pin: string;
  /** where on the part the wire meets the pin, when it is not the pin's own place (a SpotDef id) */
  spot?: string;
  span: Span;
}

export interface WireDef {
  a: PinRef;
  b: PinRef;
  /** AWG */
  gauge?: number;
  /** what the wire is insulated with: "pvc" (the default, rated as building wire) or "silicone" (high-strand RC wire, rated in free air) */
  insulation?: WireInsulation;
  color?: string;
  label?: string;
  /** the bought cable this wire is one conductor of ("STEMMA QT cable 100 mm"), and that cable's length in mm */
  cable?: string;
  length?: number;
  /**
   * The wire is a part's own lead from end to end (a servo's lead onto a header): nothing to cut, and the lead has to
   * reach. A wire the design gives a gauge is one the builder makes, joined to the lead's end, as long as it needs to be.
   */
  own?: boolean;
  /** where the wire is tied down on its way from a to b, in order (assembly coordinates, mm): its route passes through them */
  via?: [number, number, number][];
  span: Span;
}

export type WireInsulation = "pvc" | "silicone";

export interface NetDef {
  name: string;
  pins: PinRef[];
  gauge?: number;
  insulation?: WireInsulation;
  color?: string;
  /** copper track width on a circuit board, mm */
  width?: number;
  /** fill the board's free copper with this net (true), or never pour it (false) */
  pour?: boolean;
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
  /** the block's own code (settings.code "own"), from the project: the app adds it, the design source never holds it */
  own?: OwnFirmware;
}

/** Firmware written by the user or Claude in place of the code Kerf generates: the sketch's files, flat as in an Arduino sketch folder. */
export interface OwnFirmware {
  files: { path: string; content: string }[];
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

/** A pulley or clamp end on a belt's path, laid out in the belt's plane. */
export interface BeltNode {
  /** component name (pulleys), or "start" / "end" for the clamped ends of an open belt */
  name: string;
  kind: "pulley" | "clamp";
  /** centre in the belt plane (u, v), mm */
  c: [number, number];
  /** pitch-line radius round it (0 for a clamp) */
  r: number;
  /** the way the belt turns round it: 1 counter-clockwise in (u, v), -1 clockwise */
  dir: 1 | -1;
  /** wrapped on the belt's back (an outside idler) */
  outside: boolean;
  smooth: boolean;
  teeth?: number;
  /** belt contact angle, degrees */
  wrap: number;
  /** teeth engaged with a toothed pulley */
  teethInMesh?: number;
  /** distance of its belt centre from the belt plane, mm */
  offset: number;
  /** angle between its axis and the plane normal, degrees */
  tilt: number;
  /** width of its belt groove (between flanges) and the belt width it is made for */
  grooveW?: number;
  beltW?: number;
  /** what it is, for messages: "20-tooth pulley", "smooth idler", "625 bearing", "clamp" */
  label: string;
}

/** A free span of belt between two nodes. */
export interface BeltSpan {
  from: string;
  to: string;
  a: [number, number];
  b: [number, number];
  /** world end points */
  a3: [number, number, number];
  b3: [number, number, number];
  length: number;
  /** pluck frequency at the installed tension, Hz */
  hz: number;
}

/** One piece of the belt's pitch line in the belt plane, for diagrams. */
export type BeltPiece = { k: "line"; a: [number, number]; b: [number, number] } | { k: "arc"; c: [number, number]; r: number; a0: number; sweep: number };

/** A timing belt (lib.belt): its layout, tension and what that does. */
export interface BeltDef {
  name: string;
  catalogId: string;
  label: string;
  role?: string;
  open: boolean;
  /** pitch length round the path, mm */
  length: number;
  /** open belts: length to cut, allowing for stretch and clamp tails */
  cutLength?: number;
  /** closed loops: the stock loop length and tooth count that fit */
  stockLength?: number;
  teeth?: number;
  /** installation tension, N */
  tension: number;
  tensionAssumed: boolean;
  /** where the tension is written, and the parameter it comes from, so the app can edit it */
  tensionSpan?: Span;
  tensionParam?: string;
  belt: { pitch: number; width: number; core: string; mass: number; ea: number; teMax: number; tMin: number; tMax: number; minTeeth: number; stock?: number[] };
  plane: { o: [number, number, number]; u: [number, number, number]; v: [number, number, number]; n: [number, number, number] };
  nodes: BeltNode[];
  spans: BeltSpan[];
  pieces: BeltPiece[];
  /** the pulley that drives it, and the motor it sits on when Kerf finds one */
  drive?: string;
  motor?: { name: string; label: string; holdNmm?: number; stepDeg?: number; radialN?: number; radialAt?: number; lever: number };
  load?: { mass?: number; accel?: number; friction: number; torque?: number; force: number };
  figures: BeltFigures;
  span: Span;
}

export interface BeltFigures {
  /** stretch over the whole belt at the installed tension, mm */
  stretch: number;
  /** open belts: belt length from each clamp to the drive pulley, mm */
  lenA?: number;
  lenB?: number;
  /** stiffness at the carriage (or drive), N/mm: belt only at the position shown, the softest anywhere on the travel, and the motor's */
  kShown?: number;
  kMin?: number;
  kMotor?: number;
  /** with the motor in series, N/mm */
  kTotalShown?: number;
  kTotalMin?: number;
  /** natural frequency of the moving mass on the belt, Hz */
  ringShown?: number;
  ringMin?: number;
  /** how far the carriage lags the motor at full acceleration, mm */
  lag?: number;
  /** peak tight-side and slack-side tension, N */
  tight?: number;
  slack?: number;
  /** pull on the drive pulley's shaft at rest and at peak, N */
  hubStatic?: number;
  hubPeak?: number;
  /** the motor's radial rating scaled to where the belt pulls, N */
  hubLimit?: number;
  /** pull the teeth carry at this many teeth in mesh, N */
  teAllowed?: number;
  teethInMesh?: number;
}

export interface MachineData {
  components: MachineComponent[];
  wires: WireDef[];
  nets: NetDef[];
  calcs: CalcTrace[];
  firmware: FirmwareDef[];
  tests: TestDef[];
  items: BuyItem[];
  /** circuit boards designed in Kerf */
  boards: BoardDef[];
  /** timing belts round pulleys */
  belts: BeltDef[];
}

export function emptyMachine(): MachineData {
  return { components: [], wires: [], nets: [], calcs: [], firmware: [], tests: [], items: [], boards: [], belts: [] };
}
