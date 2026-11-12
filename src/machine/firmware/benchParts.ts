// The bench console's steppers and its distance and temperature sensors, for the generated Arduino sketch:
// each stepper on a StepStick driver (STEP, DIR and EN from the wiring, its steps a turn from the driver's
// microstep setting) jogs with a ramped, blocking move from the console, and each sensor reads in its own units
// (the Sharp's datasheet curve, the TF-Luna's and MCP9808's registers, the NTC module's Steinhart-Hart fit).

import { catalogPart } from "../catalog";
import type { NetPin } from "../erc";
import { measuredPart } from "../measured";
import { drivenSteppers, driverMicrosteps, fullSteps } from "../stepstick";
import { type FwContext, cNum, cString, ident, setting } from "./common";

interface Io {
  pin: string;
  at: string;
}

export interface BenchParts {
  /** the sketch needs Wire for the sensors on the I2C bus */
  wire: boolean;
  /** pins.h lines, through the generator's own #define helper */
  pins: (def: (name: string, r: Io | undefined, what: string) => void, P: string[]) => void;
  /** config.h lines */
  config: string[];
  /** tables and functions, before the motor helpers (stopAll() stops the steppers too) */
  code: string;
  /** statements for setup() */
  setup: string;
  /** statements for loop(), and for stopAll() */
  loop: string;
  stopAll: string;
  /** help lines */
  help: string;
  /** cases for the console's command switch */
  cases: string;
  /** statements that add to the status line */
  status: string;
  /** README rows for the commands table, and a section on wiring them up */
  readme: { commands: string[]; notes: string[] };
}

interface StepperOut {
  key: string;
  label: string;
  driver: NetPin;
  step?: Io;
  dir?: Io;
  en?: Io;
  steps: number;
  full: number;
  micro: number;
}

interface SensorOut {
  key: string;
  label: string;
  chip: string;
  pin?: Io;
  addr?: number;
}

const NONE: BenchParts = { wire: false, pins: () => {}, config: [], code: "", setup: "", loop: "", stopAll: "", help: "", cases: "", status: "", readme: { commands: [], notes: [] } };

export function benchParts(c: FwContext, io: (comp: string, pin: string, index?: number) => Io | undefined, used: Set<string>, warnings: string[]): BenchParts {
  const board = c.board.name;
  const netPins = (comp: string, pin: string, index = 0) => c.nl.netOf.get(`${comp}[${index}].${pin}`)?.pins ?? [];
  const onRail = (comp: string, pin: string, index = 0) => netPins(comp, pin, index).some((x) => x.pin.type === "pwr_out" || x.pin.type === "pwr_rail");
  const onGround = (comp: string, pin: string, index = 0) => netPins(comp, pin, index).some((x) => x.pin.type === "gnd");
  const label = (comp: string, index: number, count: number) => (count > 1 ? `${comp}[${index}]` : comp);

  // ---- steppers ----
  const steppers: StepperOut[] = [];
  for (const { motor, driver } of drivenSteppers(c.nl)) {
    const name = label(motor.comp, motor.index, motor.mc.count);
    const step = io(driver.comp, "STEP", driver.index);
    const dir = io(driver.comp, "DIR", driver.index);
    const en = io(driver.comp, "EN", driver.index);
    if (!step) warnings.push(`${driver.comp}.STEP is not wired to ${board}: the firmware cannot turn ${name}.`);
    if (!dir) warnings.push(`${driver.comp}.DIR is not wired to ${board}: ${name} only turns one way.`);
    if (!en && onRail(driver.comp, "EN", driver.index)) warnings.push(`${driver.comp}.EN is tied high, which keeps the driver off: tie it to GND or wire it to a pin.`);
    const dpart = measuredPart(driver.mc) ?? driver.part;
    const { micro } = driverMicrosteps(dpart);
    steppers.push({ key: ident(motor.mc.count > 1 ? `${motor.comp}_${motor.index}` : motor.comp), label: name, driver, step, dir, en, steps: fullSteps(motor.part) * micro, full: fullSteps(motor.part), micro });
    for (const r of [step, dir, en]) if (r) used.add(r.pin);
  }

  // ---- distance and temperature sensors ----
  const sensors: SensorOut[] = [];
  const bus = (comp: string) => netPins(comp, "SDA").some((p) => p.comp === board && p.pin.bus === "i2c_sda") && netPins(comp, "SCL").some((p) => p.comp === board && p.pin.bus === "i2c_scl");
  for (const mc of c.m.components) {
    const part = catalogPart(mc.catalogId);
    const chip = String(part?.specs.chip ?? "");
    const key = ident(mc.name);
    const analog = ({ "GP2Y0A21YK0F": "VO", XC4494: "OUT", TMP36: "VOUT" } as Record<string, string>)[chip];
    if (analog) {
      const pin = io(mc.name, analog);
      if (!pin) warnings.push(`${mc.name}.${analog} is not wired to ${board}: the firmware cannot read it.`);
      else {
        const p = c.boardPart.pins.find((x) => (x.mcu ?? x.id) === pin.pin);
        if (p && !p.adc) warnings.push(`${mc.name}.${analog} is on ${pin.at}, which is not an analog input: move it to an A pin.`);
        used.add(pin.pin);
      }
      sensors.push({ key, label: mc.name, chip, pin });
    } else if (chip === "TF-Luna" || chip === "MCP9808") {
      if (!bus(mc.name)) {
        warnings.push(`${mc.name} SDA/SCL must go to ${board}'s I2C pins for the firmware to read it.`);
        continue;
      }
      if (chip === "TF-Luna" && !onGround(mc.name, "CFG")) warnings.push(`${mc.name}.CFG is not tied to GND: it starts in UART mode and does not answer on I2C.`);
      const addr = chip === "TF-Luna" ? 0x10 : 0x18 + (onRail(mc.name, "A0") ? 1 : 0) + (onRail(mc.name, "A1") ? 2 : 0) + (onRail(mc.name, "A2") ? 4 : 0);
      sensors.push({ key, label: mc.name, chip, addr });
    }
  }
  if (!steppers.length && !sensors.length) return NONE;

  const rpm = setting(c.fw, "stepper_rpm", 120);
  const accel = setting(c.fw, "stepper_accel", 4);
  const wire = sensors.some((s) => s.addr !== undefined);

  const config: string[] = [];
  if (steppers.length) {
    config.push("// Steppers: the jog command's top speed and how fast it gets there. A start too fast or a ramp too steep");
    config.push("// for the load makes a stepper slip and lose its place: lower these before raising the current.");
    config.push(`#define STEPPER_RPM      ${cNum(rpm)}`);
    config.push(`#define STEPPER_ACCEL    ${cNum(accel)}      // rev/s²`);
    config.push("");
  }

  const L: string[] = [];
  if (steppers.length) {
    L.push(`// ---------------- steppers ----------------
// Each on a StepStick driver: a rising edge on STEP moves it one microstep the way DIR says; EN low turns
// the driver on. The firmware's count is where the shaft is only while it never slips.
struct Stepper {
  const char *name;
  int16_t step, dir, en;   // -1 = not wired (EN tied low or left open: the driver is on)
  long stepsPerRev;
  long pos;                // steps from power-up, by the firmware's count
  long left, done;         // steps still to take in this move, and taken so far
  int8_t way;              // +1 forward (DIR high), -1 back
  unsigned long next;      // micros() of its next step
};
Stepper steppers[] = {
${steppers.map((s) => `  { "${cString(s.label)}", ${s.key}_STEP, ${s.key}_DIR, ${s.key}_EN, ${s.key}_STEPS_REV, 0, 0, 0, 1, 0 },`).join("\n")}
};
const uint8_t N_STEPPERS = ${steppers.length};

void stepperPin(int16_t p, bool v) { if (p >= 0) digitalWrite(p, v ? HIGH : LOW); }

void stepperSetup(Stepper &s) {
  if (s.step >= 0) pinMode(s.step, OUTPUT);
  if (s.dir >= 0) pinMode(s.dir, OUTPUT);
  if (s.en >= 0) pinMode(s.en, OUTPUT);
  stepperPin(s.step, false);
  stepperPin(s.en, false);   // on: it holds the shaft
}

// Starts a move (negative: back). loop() takes its steps a millisecond at a time (stepperService), up to
// STEPPER_RPM at STEPPER_ACCEL from a standing start and down to a stop by the last step, so the console
// and everything else keep running while it moves.
void stepperMove(Stepper &s, long steps) {
  if (s.step < 0) { Serial.print(s.name); Serial.println(F(": STEP is not wired")); return; }
  stepperPin(s.en, false);
  s.way = steps >= 0 ? 1 : -1;
  stepperPin(s.dir, steps >= 0);
  s.left = steps >= 0 ? steps : -steps;
  s.done = 0;
  s.next = micros() + 20;   // DIR settles before the first step
}

void stepperStopAll() { for (uint8_t i = 0; i < N_STEPPERS; i++) steppers[i].left = 0; }

// The steps due in the next millisecond, each timed from the one before so the maths in between does not
// slow them down. A step that comes late (loop() was busy elsewhere) restarts the timing rather than
// catching up in a burst the motor could not follow.
void stepperService() {
  unsigned long end = micros() + 1000;
  for (;;) {
    int8_t k = -1;
    for (uint8_t i = 0; i < N_STEPPERS; i++)
      if (steppers[i].left > 0 && (k < 0 || (long)(steppers[i].next - steppers[k].next) < 0)) k = i;
    if (k < 0) return;
    Stepper &s = steppers[k];
    if ((long)(s.next - end) > 0) return;
    long wait = (long)(s.next - micros());
    if (wait > 0) delayMicroseconds(wait);
    stepperPin(s.step, true);
    delayMicroseconds(2);
    stepperPin(s.step, false);
    s.pos += s.way;
    s.done++;
    s.left--;
    if (s.left == 0) { Serial.print(s.name); Serial.print(F(" at ")); Serial.print(s.pos); Serial.println(F(" steps")); continue; }
    long ramp = s.done + 1 < s.left ? s.done + 1 : s.left;
    float v = sqrt(2.0f * STEPPER_ACCEL * s.stepsPerRev * ramp);
    float top = STEPPER_RPM / 60.0f * s.stepsPerRev;
    if (v > top) v = top;
    unsigned long dt = (unsigned long)(1000000.0f / v);
    if ((long)(micros() - s.next) > (long)dt) s.next = micros();
    s.next += dt;
  }
}`);
  }
  if (sensors.length) {
    const has = (chip: string) => sensors.some((s) => s.chip === chip);
    L.push("// ---------------- distance and temperature sensors ----------------");
    if (has("GP2Y0A21YK0F"))
      L.push(`// Sharp GP2Y0A21YK0F: its datasheet curve, 10 to 80 cm on a white target; -1 with nothing in range. Nearer than
// 7 cm the output falls again, so a close object reads as a farther one.
float sharpCm(int16_t pin) {
  float v = analogRead(pin) * (ADC_REF_V / ADC_MAX);
  if (v < 0.42f) return -1;
  return 27.86f * pow(v, -1.15f);
}`);
    if (has("XC4494"))
      L.push(`// Duinotech XC4494 thermistor module: the 10 kOhm NTC from VCC to OUT over a 10 kOhm resistor, with Jaycar's
// Steinhart-Hart coefficients. Ratiometric: power it from the same supply as the ADC reference.
float ntcC(int16_t pin) {
  float adc = analogRead(pin);
  if (adc < 1 || adc > ADC_MAX - 1) return -273.15f;
  float r = 10000.0f * (ADC_MAX / adc - 1.0f);
  float lr = log(r);
  return 1.0f / (0.001129148f + 0.000234125f * lr + 0.0000000876741f * lr * lr * lr) - 273.15f;
}`);
    if (has("TMP36")) L.push("// TMP36: 0.5 V at 0 °C, 10 mV a degree\nfloat tmp36C(int16_t pin) { return (analogRead(pin) * (ADC_REF_V / ADC_MAX) - 0.5f) * 100.0f; }");
    if (has("TF-Luna"))
      L.push(`// Benewake TF-Luna on I2C (CFG tied to GND): distance in cm at register 0, signal strength at 2. It gives
// 0 when the signal is too weak to trust (past its range, or a dark target); -1 = no answer.
int lunaAmp = 0;
int lunaCm(uint8_t addr) {
  Wire.beginTransmission(addr);
  Wire.write((uint8_t)0x00);
  if (Wire.endTransmission() != 0) return -1;
  if (Wire.requestFrom((int)addr, 4) != 4) return -1;
  int d = Wire.read();
  d |= Wire.read() << 8;
  lunaAmp = Wire.read();
  lunaAmp |= Wire.read() << 8;
  return d;
}`);
    if (has("MCP9808"))
      L.push(`// Microchip MCP9808: T_A (register 5) in 1/16 °C with its sign in bit 12 and its alert flags in bits 13 to 15,
// masked off here. -999 = no answer.
float mcpC(uint8_t addr) {
  Wire.beginTransmission(addr);
  Wire.write((uint8_t)0x05);
  if (Wire.endTransmission() != 0) return -999;
  if (Wire.requestFrom((int)addr, 2) != 2) return -999;
  unsigned int raw = Wire.read();
  raw = ((raw << 8) | Wire.read()) & 0x1FFF;
  float t = (raw & 0x0FFF) / 16.0f;
  return (raw & 0x1000) ? t - 256.0f : t;
}`);
    const read = (s: SensorOut): string => {
      const head = `  Serial.print(F("${s.label === sensors[0].label ? "" : "  "}${cString(s.label)} "));`;
      switch (s.chip) {
        case "GP2Y0A21YK0F":
          return `${head} { float d = ${s.pin ? `sharpCm(${s.key}_PIN)` : "-1"}; if (d < 0) Serial.print(F("out of range")); else { Serial.print(d, 1); Serial.print(F(" cm")); } }`;
        case "XC4494":
          return `${head} Serial.print(${s.pin ? `ntcC(${s.key}_PIN)` : "-273.15f"}, 1); Serial.print(F(" C"));`;
        case "TMP36":
          return `${head} Serial.print(${s.pin ? `tmp36C(${s.key}_PIN)` : "-273.15f"}, 1); Serial.print(F(" C"));`;
        case "TF-Luna":
          return `${head} { int d = lunaCm(0x${s.addr!.toString(16)}); if (d < 0) Serial.print(F("no answer")); else if (d == 0) Serial.print(F("out of range")); else { Serial.print(d); Serial.print(F(" cm")); } }`;
        default:
          return `${head} { float t = mcpC(0x${s.addr!.toString(16)}); if (t < -900) Serial.print(F("no answer")); else { Serial.print(t, 2); Serial.print(F(" C")); } }`;
      }
    };
    L.push(`// each sensor's reading, on one line
void readSensors() {
${sensors.map(read).join("\n")}
  Serial.println();
}`);
  }

  const help: string[] = [];
  if (steppers.length) {
    help.push(`  Serial.println(F("  j <n> <steps> move stepper n, ramped to STEPPER_RPM (negative: back)"));`);
    help.push(`  for (uint8_t i = 0; i < N_STEPPERS; i++) { Serial.print(F("  stepper ")); Serial.print(i); Serial.print(F(" = ")); Serial.print(steppers[i].name); Serial.print(F(", ")); Serial.print(steppers[i].stepsPerRev); Serial.println(F(" steps a turn")); }`);
  }
  if (sensors.length) help.push(`  Serial.println(F("  r            read the distance and temperature sensors"));`);

  const cases: string[] = [];
  if (steppers.length)
    cases.push(`    case 'j':
      if (a1 >= 0 && a1 < N_STEPPERS) { stepperMove(steppers[a1], a2); Serial.print(steppers[a1].name); Serial.print(F(" moving ")); Serial.print(a2); Serial.println(F(" steps")); }
      else Serial.println(F("No such stepper"));
      break;`);
  if (sensors.length) cases.push("    case 'r': readSensors(); break;");

  const setup: string[] = [];
  if (steppers.length) setup.push("  for (uint8_t i = 0; i < N_STEPPERS; i++) stepperSetup(steppers[i]);");
  if (wire) setup.push("  Wire.begin();");

  return {
    wire,
    pins: (def, P) => {
      for (const s of steppers) {
        P.push(`// ${s.label}: ${s.driver.comp} (${s.driver.part.name}) at 1/${s.micro} step`);
        def(`${s.key}_STEP`, s.step, `${s.driver.comp}.STEP`);
        def(`${s.key}_DIR`, s.dir, `${s.driver.comp}.DIR`);
        def(`${s.key}_EN`, s.en, `${s.driver.comp}.EN`);
        P.push(`#define ${`${s.key}_STEPS_REV`.padEnd(22)} ${s.steps}L  // ${s.full} full steps a turn × ${s.micro}`, "");
      }
      for (const s of sensors) {
        if (s.addr !== undefined) P.push(`// ${s.label}: ${catalogPart(c.m.components.find((x) => x.name === s.label)?.catalogId ?? "")?.name ?? s.chip} at 0x${s.addr.toString(16)} on the I2C pins (Wire)`, "");
        else {
          P.push(`// ${s.label}: ${catalogPart(c.m.components.find((x) => x.name === s.label)?.catalogId ?? "")?.name ?? s.chip}`);
          def(`${s.key}_PIN`, s.pin, `${s.label}.${({ "GP2Y0A21YK0F": "VO", XC4494: "OUT", TMP36: "VOUT" } as Record<string, string>)[s.chip]}`);
          P.push("");
        }
      }
    },
    config,
    code: L.join("\n\n") + "\n",
    setup: setup.length ? "\n" + setup.join("\n") : "",
    loop: steppers.length ? "\n  stepperService();" : "",
    stopAll: steppers.length ? " stepperStopAll();" : "",
    help: help.length ? help.join("\n") + "\n" : "",
    cases: cases.length ? cases.join("\n") + "\n" : "",
    status: steppers.length ? `\n  for (uint8_t i = 0; i < N_STEPPERS; i++) { Serial.print(F("  ")); Serial.print(steppers[i].name); Serial.print(F(" ")); Serial.print(steppers[i].pos); Serial.print(F(" steps")); }` : "",
    readme: {
      commands: [...(steppers.length ? ["| `j <n> <steps>` | move stepper n that many steps (negative: back), ramped up to STEPPER_RPM at STEPPER_ACCEL; it says where it is when it gets there |"] : []), ...(sensors.length ? ["| `r` | read the distance and temperature sensors |"] : [])],
      notes: [
        ...steppers.map((s) => `- **${s.label}** on ${s.driver.comp}: ${s.steps} steps a turn (1/${s.micro} step). Set the driver's current limit with its trimpot before the first run.`),
        ...sensors.filter((s) => s.addr !== undefined).map((s) => `- **${s.label}** answers at I2C address 0x${s.addr!.toString(16)}.`),
      ],
    },
  };
}

/** The README with the steppers' and sensors' commands in its table and a line on each one under it. */
export function withBenchParts(readme: string, extra: BenchParts): string {
  const { commands, notes } = extra.readme;
  if (!commands.length && !notes.length) return readme;
  const lines = readme.split("\n");
  const row = lines.findIndex((l) => l.startsWith("| `b` |"));
  if (row < 0) return readme;
  lines.splice(row + 1, 0, ...commands);
  const bring = lines.findIndex((l) => l.startsWith("## Bring-up"));
  if (bring >= 0 && notes.length) lines.splice(bring, 0, ...notes, "");
  return lines.join("\n");
}
