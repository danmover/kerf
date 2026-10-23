// The ride behaviour of the Arduino generator: what a fairground ride's
// controller does, with every pin from the design's wiring. Boarding lights
// until the start button (or the boarding time runs out), a countdown, each
// motor ramped up to its ride speed and held there by its encoder, an
// optional change of direction part way, then a slow creep round until the
// hall sensor sees the station magnet, so the ride always stops where people
// get off. The emergency stop cuts the motors' power in hardware; the
// controller sees that supply go on its voltage sensor, flashes every light
// red and waits for the start button before creeping back to the station.
// Each addressable LED board plays its own light show, faster as the ride
// speeds up.

import { catalogPart } from "../catalog";
import type { CatalogPart, MachineComponent } from "../types";
import { type DriveOut, type Io, SCHEME_C, cFloat, channelPins } from "./arduino";
import { type FwContext, cComment, cNum, cString, setting } from "./common";

export const RIDE_WORDS = /\b(ride|carousel|roundabout|merry|ferris|teacup|tea cup|pirate|swing ship|fairground|theme park)/i;

const SHOWS = ["rainbow", "chase", "comet", "sparkle", "breathe", "twinkle"] as const;
type Show = (typeof SHOWS)[number];

interface LedSeg {
  label: string;
  comp: MachineComponent;
  part: CatalogPart;
  n: number;
  first: number;
  show: Show;
}

interface LedStrip {
  key: string;
  pin: Io;
  n: number;
  order: string;
  segs: LedSeg[];
  bright: number;
}

export interface RideInput {
  c: FwContext;
  motors: DriveOut[];
  encs: DriveOut[];
  io: (comp: string, pin: string, index?: number) => Io | undefined;
  def: (name: string, r: Io | undefined, what: string) => void;
  P: string[];
  C: string[];
  warnings: string[];
  vsense?: { comp: MachineComponent; pin?: Io; ratio: number };
  adcMax: number;
  boardV: number;
}

export interface RideOutput {
  ino: string;
  readme: string[];
  summary: string;
}

const ORDER_C: Record<string, string> = { RGB: "NEO_RGB", RBG: "NEO_RBG", GRB: "NEO_GRB", GBR: "NEO_GBR", BRG: "NEO_BRG", BGR: "NEO_BGR" };

/** Each pin's chain of LED boards, in data order: from the controller pin to the first DIN, then DOUT to the next board's DIN. */
function ledStrips(a: RideInput): LedStrip[] {
  const { c, warnings } = a;
  const board = c.board.name;
  const net = (comp: string, pin: string, index: number) => c.nl.netOf.get(`${comp}[${index}].${pin}`)?.pins ?? [];
  const leds = c.m.components.flatMap((mc) => {
    const part = catalogPart(mc.catalogId);
    return part?.kind === "led" ? Array.from({ length: mc.count }, (_, i) => ({ mc, part, i, label: mc.count > 1 ? `${mc.name}[${i}]` : mc.name })) : [];
  });
  const strips: LedStrip[] = [];
  const seen = new Set<string>();
  const showFor = (mc: MachineComponent, k: number): Show => {
    const asked = setting(c.fw, `${mc.name}_show`, "").toLowerCase();
    if (asked) {
      const s = SHOWS.find((x) => x === asked);
      if (s) return s;
      warnings.push(`${mc.name}_show: "${asked}" is not a light show Kerf knows (${SHOWS.join(", ")}): it plays ${SHOWS[k % SHOWS.length]}.`);
    }
    return SHOWS[k % SHOWS.length];
  };
  let k = 0;
  for (const head of leds) {
    const din = net(head.mc.name, "DIN", head.i).find((p) => p.comp === board && p.pin.type === "io");
    if (!din) continue;
    const pin: Io = { pin: din.pin.mcu ?? din.pin.id, at: `${board}.${din.pin.id}` };
    const strip: LedStrip = { key: `LEDS${strips.length}`, pin, n: 0, order: String(head.part.specs.order ?? "GRB"), segs: [], bright: 1 };
    for (let cur: typeof head | undefined = head; cur && !seen.has(`${cur.mc.name}[${cur.i}]`); ) {
      seen.add(`${cur.mc.name}[${cur.i}]`);
      const n = Number(cur.part.specs.leds ?? 0);
      strip.segs.push({ label: cur.label, comp: cur.mc, part: cur.part, n, first: strip.n, show: showFor(cur.mc, k++) });
      strip.n += n;
      if (cur.mc.brightness !== undefined) strip.bright = Math.min(strip.bright, cur.mc.brightness);
      if (String(cur.part.specs.order ?? "GRB") !== strip.order) warnings.push(`${cur.label} sends its colours in ${cur.part.specs.order} order and the first board on its chain in ${strip.order}: one of them will show the wrong colours.`);
      const from: typeof head = cur;
      cur = leds.find((x) => net(from.mc.name, "DOUT", from.i).some((p) => p.comp === x.mc.name && p.index === x.i && p.pin.id === "DIN"));
    }
    strips.push(strip);
  }
  for (const l of leds) if (!seen.has(`${l.mc.name}[${l.i}]`)) warnings.push(`${l.label}.DIN gets no data from ${board} (directly or from another board's DOUT): it stays dark.`);
  return strips;
}

/** The start button: a momentary switch with one side on a controller pin (and the other on ground). */
function startButton(a: RideInput): { comp: MachineComponent; pin: Io } | undefined {
  const cands = a.c.m.components.filter((mc) => {
    const p = catalogPart(mc.catalogId);
    return p?.kind === "switch" && p.specs.momentary;
  });
  cands.sort((x, y) => Number(/start|go/i.test(`${y.name} ${y.role ?? ""}`)) - Number(/start|go/i.test(`${x.name} ${x.role ?? ""}`)));
  for (const mc of cands) {
    const part = catalogPart(mc.catalogId)!;
    for (const pd of part.pins) {
      const pin = a.io(mc.name, pd.id);
      if (pin) return { comp: mc, pin };
    }
  }
  return undefined;
}

/** The station sensor: a hall switch whose output reaches a controller pin. */
function stationSensor(a: RideInput): { comp: MachineComponent; pin: Io } | undefined {
  for (const mc of a.c.m.components) {
    const part = catalogPart(mc.catalogId);
    if (part?.kind !== "sensor" || part.specs.iface !== "hall") continue;
    const pin = a.io(mc.name, "S");
    if (pin) return { comp: mc, pin };
    a.warnings.push(`${mc.name}.S is not wired to ${a.c.board.name}: the ride cannot find its station and stops wherever it slows down.`);
  }
  return undefined;
}

export function rideFirmware(a: RideInput): RideOutput {
  const { c, motors, encs, def, P, C, warnings } = a;
  const strips = ledStrips(a);
  const button = startButton(a);
  const station = stationSensor(a);
  const vs = a.vsense?.pin ? a.vsense : undefined;
  if (!motors.length) warnings.push("The ride firmware has no motor on a driver to run: wire each ride motor to a motor driver channel.");
  if (!button) warnings.push(`No momentary button is wired to ${c.board.name}: the ride starts on its own after the boarding time, or from the console (g).`);
  const estops = c.m.components.filter((mc) => {
    const p = catalogPart(mc.catalogId);
    return p?.kind === "switch" && p.specs.latching;
  });
  if (estops.length && !vs) warnings.push(`${estops[0].name} cuts the motors' power, but no voltage sensor watches that supply: the controller cannot tell it was pressed, so its lights keep playing. Add a voltage sensor on the motor supply after the stop button.`);
  const pinsTaken = new Set<string>();
  for (const s of strips) {
    if (pinsTaken.has(s.pin.pin)) warnings.push(`${s.pin.at} drives two LED chains: give each chain its own pin.`);
    pinsTaken.add(s.pin.pin);
  }

  // ---- settings ----
  const S = {
    RIDE_S: setting(c.fw, "ride_time", 30),
    RAMP_S: Math.max(0.5, setting(c.fw, "ramp", 4)),
    BOARD_S: setting(c.fw, "boarding", 8),
    COUNT_S: setting(c.fw, "countdown", 3),
    REVERSE: setting(c.fw, "reverse", false),
    CREEP: setting(c.fw, "creep", 0.25),
    STATION: setting(c.fw, "station", !!station) && !!station,
    ESTOP_V: setting(c.fw, "estop_volts", 6),
    BRIGHT: setting(c.fw, "brightness", 1),
  };
  const rpmOf = (m: DriveOut) => {
    const free = Number(m.part.specs.rpm_free ?? 60);
    return setting(c.fw, `${m.comp.name}_rpm`, Math.round(free * 0.5));
  };

  // ---- pins.h ----
  for (const s of strips) {
    P.push(`// ${s.segs.map((g) => `${g.label} (${g.n} LEDs)`).join(" -> ")}: ${s.n} addressable LEDs in one chain`);
    def(`${s.key}_PIN`, s.pin, `${s.segs[0].label}.DIN`);
    P.push("");
  }
  if (button) {
    P.push(`// ${button.comp.name}: ${catalogPart(button.comp.catalogId)?.name}, to ground when pressed`);
    def("START_BUTTON", button.pin, `${button.comp.name}`);
    P.push("");
  }
  if (station) {
    P.push(`// ${station.comp.name}: low while the station magnet is in front of it`);
    def("STATION_SENSOR", station.pin, `${station.comp.name}.S`);
    P.push("");
  }
  if (vs) {
    P.push(`// ${vs.comp.name}: the motors' supply after the emergency stop, through a ${vs.ratio}:1 divider`);
    def("MOTOR_V_SENSE", vs.pin, `${vs.comp.name}.S`);
    P.push("");
  }

  // ---- config.h ----
  C.push("// Ride cycle");
  C.push(`#define BOARDING_S       ${cNum(S.BOARD_S)}      // boarding lights this long, then it starts by itself (0: only the start button starts it)`);
  C.push(`#define COUNTDOWN_S      ${cNum(S.COUNT_S)}      // lights flash this long before it moves`);
  C.push(`#define RIDE_S           ${cNum(S.RIDE_S)}     // at speed (both directions together)`);
  C.push(`#define RAMP_S           ${cNum(S.RAMP_S)}      // 0 to ride speed, and back down`);
  C.push(`#define REVERSE          ${S.REVERSE ? 1 : 0}      // 1: 60 % of the ride one way, then 40 % the other`);
  C.push(`#define CREEP            ${cNum(S.CREEP)}   // share of ride speed while it finds the station`);
  C.push(`#define USE_STATION      ${S.STATION ? 1 : 0}      // 1: stop when the station sensor sees its magnet`);
  C.push("#define STATION_TIMEOUT_S 60    // creeping longer than this: the magnet or sensor is missing, stop anyway");
  C.push("");
  C.push("// Speed control (output shaft rpm from the encoders)");
  for (const m of motors) C.push(`#define ${(m.key + "_RPM").padEnd(16)} ${cNum(rpmOf(m))}     // ${m.label} at ride speed (${cNum(Number(m.part.specs.rpm_free ?? 0))} rpm free at ${cNum(Number(m.part.specs.v_rated ?? 12))} V)`);
  C.push("#define SPEED_KP         2.0     // PWM per rpm of error");
  C.push("#define SPEED_KI         6.0     // PWM per rpm-second");
  C.push("");
  if (vs) {
    C.push("// Emergency stop: the stop button cuts the motors' supply, which the controller watches");
    C.push(`#define MOTOR_V_RATIO    ${cNum(vs.ratio)}`);
    C.push(`#define ESTOP_V          ${cNum(S.ESTOP_V)}      // motor supply below this: the stop button is pressed (or the supply is off)`);
    C.push("");
  }
  C.push("// Lights");
  C.push(`#define BRIGHTNESS       ${Math.max(1, Math.min(255, Math.round(255 * Math.min(1, S.BRIGHT))))}    // 0..255 for every LED chain (each chain also keeps its boards' brightness cap)`);
  C.push("#define FRAME_MS         40      // 25 light frames a second");

  // ---- the sketch ----
  const L: string[] = [];
  const pinOr = (o: DriveOut, r: string) => (channelPins(o.driverPart, o.channel)[r as keyof ReturnType<typeof channelPins>] ? `${o.key}_${r.toUpperCase()}` : "-1");
  L.push(`// ${c.fw.name}: generated by Kerf for "${cComment(c.designName)}".`);
  const behaviour = setting(c.fw, "behaviour", setting(c.fw, "behavior", ""));
  if (behaviour) L.push(`// Behaviour asked for: ${cComment(behaviour)}`);
  L.push("// Mode: ride (boarding lights, start button, countdown, speed ramps, ride timer, station stop, emergency stop).");
  L.push("// Needs the Adafruit NeoPixel library (Arduino IDE: Tools > Manage Libraries).");
  L.push("// Open the Serial Monitor at 115200 baud and type h for the commands.");
  L.push("");
  L.push("#include <Arduino.h>");
  L.push("#include <Adafruit_NeoPixel.h>");
  L.push('#include "config.h"', '#include "pins.h"', "");

  L.push("// ---------------- motors ----------------");
  L.push("enum Scheme : uint8_t { PWM_DIR, RPWM_LPWM, EN_IN1_IN2, PWM_IN1_IN2, IN1_IN2_PWM };", "");
  L.push("struct Motor {");
  L.push("  const char *name;");
  L.push("  uint8_t scheme;");
  L.push("  int16_t pwm, dir, in1, in2, en, en2;  // -1 = not wired");
  L.push("  int8_t fwd;                          // +1 or -1");
  L.push("  int8_t enc;                          // its encoder, -1 = none (open loop)");
  L.push("  float rideRpm, freeRpm;              // ride speed, and free speed at full PWM");
  L.push("  int16_t cmd;                         // last PWM command, -255..255");
  L.push("  float target, ramped, integ, rpm;    // asked, ramped toward it, integral, measured");
  L.push("};", "");
  if (motors.length) {
    L.push("Motor motors[] = {");
    for (const o of motors) {
      const pins = ["pwm", "dir", "in1", "in2", "en", "en2"].map((r) => pinOr(o, r)).join(", ");
      L.push(`  { "${cString(o.label)}", ${SCHEME_C[o.scheme]}, ${pins}, ${o.key}_FWD, ${encs.indexOf(o)}, ${o.key}_RPM, ${cFloat(Number(o.part.specs.rpm_free ?? 60))}, 0, 0, 0, 0, 0 },`);
    }
    L.push("};");
  } else L.push('Motor motors[1] = { { "none", PWM_DIR, -1, -1, -1, -1, -1, -1, 1, -1, 0, 1, 0, 0, 0, 0, 0 } };');
  L.push(`const uint8_t N_MOTORS = ${motors.length};`, "");
  L.push(`void pinOut(int16_t p) { if (p >= 0) pinMode(p, OUTPUT); }
void writeD(int16_t p, bool v) { if (p >= 0) digitalWrite(p, v ? HIGH : LOW); }
void writeA(int16_t p, int v) { if (p >= 0) analogWrite(p, v); }

void motorSetup(Motor &m) {
  pinOut(m.pwm); pinOut(m.dir); pinOut(m.in1); pinOut(m.in2); pinOut(m.en); pinOut(m.en2);
  writeD(m.en, true); writeD(m.en2, true);   // wake / enable the driver
}

void motorWrite(Motor &m, int s) {
  s = constrain(s, -255, 255);
  m.cmd = s;
  int v = s * m.fwd;
  int mag = abs(v);
  switch (m.scheme) {
    case PWM_DIR: writeD(m.dir, v >= 0); writeA(m.pwm, mag); break;
    case RPWM_LPWM: writeA(m.in1, v > 0 ? mag : 0); writeA(m.in2, v < 0 ? mag : 0); break;
    case EN_IN1_IN2:
    case PWM_IN1_IN2: writeD(m.in1, v > 0); writeD(m.in2, v < 0); writeA(m.pwm, mag); break;
    case IN1_IN2_PWM: writeA(m.in1, v > 0 ? mag : 0); writeA(m.in2, v < 0 ? mag : 0); break;
  }
}

// stop at once: no ramp, every motor
void halt() {
  for (uint8_t i = 0; i < N_MOTORS; i++) { motors[i].target = 0; motors[i].ramped = 0; motors[i].integ = 0; motorWrite(motors[i], 0); }
}
`);

  L.push("// ---------------- encoders ----------------");
  L.push(`const uint8_t N_ENC = ${encs.length};`);
  L.push(`float encRpm[${Math.max(1, encs.length)}];`);
  if (encs.length) {
    L.push("volatile long encCount[N_ENC];");
    L.push(`const float encCountsPerRev[N_ENC] = { ${encs.map((m) => cFloat((m.cpr ?? 0) / 2)).join(", ")} };  // counting both edges of A`);
    encs.forEach((m, i) => {
      if (m.encB) L.push(`void encIsr${i}() { encCount[${i}] += (digitalRead(${m.key}_ENC_A) == digitalRead(${m.key}_ENC_B)) ? -${m.key}_FWD : ${m.key}_FWD; }`);
      else L.push(`void encIsr${i}() { encCount[${i}] += motors[${motors.indexOf(m)}].cmd >= 0 ? 1 : -1; }  // no channel B: direction from the command`);
    });
    L.push("long encRead(uint8_t i) { noInterrupts(); long v = encCount[i]; interrupts(); return v; }");
    L.push("void encSetup() {");
    encs.forEach((m, i) => {
      L.push(`  pinMode(${m.key}_ENC_A, INPUT_PULLUP);${m.encB ? ` pinMode(${m.key}_ENC_B, INPUT_PULLUP);` : ""}`);
      L.push(`  attachInterrupt(digitalPinToInterrupt(${m.key}_ENC_A), encIsr${i}, CHANGE);`);
    });
    L.push("}");
    L.push(`void encUpdate(float dtS) {
  static long last[N_ENC];
  for (uint8_t i = 0; i < N_ENC; i++) {
    long v = encRead(i);
    float r = encCountsPerRev[i] > 0 ? (v - last[i]) / encCountsPerRev[i] / dtS * 60.0f : 0;
    encRpm[i] = encRpm[i] * 0.5f + r * 0.5f;
    last[i] = v;
  }
}`);
  } else L.push("void encSetup() {}", "void encUpdate(float) {}");
  L.push("");

  L.push(`// ---------------- speed ----------------
// Each motor's target is ramped at its ride speed per RAMP_S, then held by a PI loop on its encoder
// (feed-forward from its free speed, so it is close before the loop has to work).
void speedUpdate(float dt) {
  for (uint8_t i = 0; i < N_MOTORS; i++) {
    Motor &m = motors[i];
    float step = fabs(m.rideRpm) / RAMP_S * dt;
    if (m.ramped < m.target) m.ramped = (m.ramped + step > m.target) ? m.target : m.ramped + step;
    else if (m.ramped > m.target) m.ramped = (m.ramped - step < m.target) ? m.target : m.ramped - step;
    m.rpm = m.enc >= 0 ? encRpm[m.enc] : m.ramped;
    if (m.ramped == 0 && m.target == 0) { m.integ = 0; motorWrite(m, 0); continue; }
    float out = m.ramped / m.freeRpm * 255.0f;
    if (m.enc >= 0) {
      float e = m.ramped - m.rpm;
      m.integ = constrain(m.integ + SPEED_KI * e * dt, -150.0f, 150.0f);
      out += SPEED_KP * e + m.integ;
    }
    motorWrite(m, (int)out);
  }
}
void setSpeed(float share) { for (uint8_t i = 0; i < N_MOTORS; i++) motors[i].target = motors[i].rideRpm * share; }
bool allRamped() { for (uint8_t i = 0; i < N_MOTORS; i++) if (motors[i].ramped != motors[i].target) return false; return true; }
float speedShare() {
  float s = 0;
  for (uint8_t i = 0; i < N_MOTORS; i++) if (motors[i].rideRpm != 0) { float k = fabs(motors[i].rpm / motors[i].rideRpm); if (k > s) s = k; }
  return s > 1.5f ? 1.5f : s;
}
`);

  // inputs
  L.push("// ---------------- inputs ----------------");
  if (button)
    L.push(`// true once per press (debounced)
bool startPressed() {
  static bool was = false;
  static unsigned long changed = 0;
  bool down = digitalRead(START_BUTTON) == LOW;
  if (down != was && millis() - changed > 30) { was = down; changed = millis(); return down; }
  return false;
}`);
  else L.push("bool startPressed() { return false; }  // no start button in the wiring");
  L.push(station ? "bool atStation() { return digitalRead(STATION_SENSOR) == LOW; }" : "bool atStation() { return true; }  // no station sensor in the wiring");
  L.push("float motorV = -1;");
  L.push(vs ? "float readMotorV() { return analogRead(MOTOR_V_SENSE) * (ADC_REF_V / ADC_MAX) * MOTOR_V_RATIO; }" : "float readMotorV() { return -1; }  // no voltage sensor on the motor supply");
  L.push(vs ? "bool motorPowerOff() { return motorV >= 0 && motorV < ESTOP_V; }" : "bool motorPowerOff() { return false; }");
  L.push("");

  // lights
  L.push("// ---------------- lights ----------------");
  for (const s of strips) L.push(`Adafruit_NeoPixel ${s.key.toLowerCase()}(${s.n}, ${s.key}_PIN, ${ORDER_C[s.order] ?? "NEO_GRB"} + NEO_KHZ800);`);
  L.push(`enum Show : uint8_t { ${SHOWS.map((s) => `SHOW_${s.toUpperCase()}`).join(", ")} };`);
  L.push("struct Seg { uint8_t strip; uint16_t first, n; uint8_t show; };");
  const segs = strips.flatMap((s, si) => s.segs.map((g) => ({ si, g })));
  if (segs.length) {
    L.push("const Seg segs[] = {");
    for (const { si, g } of segs) L.push(`  { ${si}, ${g.first}, ${g.n}, SHOW_${g.show.toUpperCase()} },  // ${cComment(g.label)}: ${g.part.name}`);
    L.push("};");
  } else L.push("const Seg segs[1] = { { 0, 0, 0, SHOW_RAINBOW } };");
  L.push(`const uint8_t N_SEGS = ${segs.length};`);
  L.push("void px(uint8_t s, uint16_t i, uint32_t col) {");
  if (strips.length) {
    L.push("  switch (s) {");
    strips.forEach((s, si) => L.push(`    case ${si}: ${s.key.toLowerCase()}.setPixelColor(i, col); break;`));
    L.push("  }");
  }
  L.push("}");
  L.push(`void lightsShow() { ${strips.map((s) => `${s.key.toLowerCase()}.show();`).join(" ")} }`);
  L.push(`void lightsBegin() { ${strips.map((s) => `${s.key.toLowerCase()}.begin(); ${s.key.toLowerCase()}.setBrightness((uint8_t)(BRIGHTNESS * ${cFloat(s.bright)})); ${s.key.toLowerCase()}.clear();`).join(" ")} lightsShow(); }`);
  const ref = strips.length ? strips[0].key.toLowerCase() : "";
  L.push(
    ref
      ? `uint32_t rgb(uint8_t r, uint8_t g, uint8_t b) { return ${ref}.Color(r, g, b); }
uint32_t hsv(uint16_t h, uint8_t s, uint8_t v) { return ${ref}.gamma32(${ref}.ColorHSV(h, s, v)); }
uint8_t wave(uint8_t x) { return ${ref}.sine8(x); }`
      : `uint32_t rgb(uint8_t r, uint8_t g, uint8_t b) { return ((uint32_t)r << 16) | ((uint32_t)g << 8) | b; }
uint32_t hsv(uint16_t, uint8_t, uint8_t v) { return rgb(v, v, v); }
uint8_t wave(uint8_t x) { return x; }`,
  );
  L.push(`uint32_t dim(uint32_t col, uint8_t k) {
  uint8_t r = (uint8_t)(((col >> 16) & 0xFF) * k / 255), g = (uint8_t)(((col >> 8) & 0xFF) * k / 255), b = (uint8_t)((col & 0xFF) * k / 255);
  return rgb(r, g, b);
}
const uint32_t SEG_HUE[6] = { 0, 10900, 21800, 32700, 43600, 54500 };

// One LED of a segment at phase p (turns of the show: it moves faster as the ride speeds up).
uint32_t showPixel(uint8_t si, uint16_t i, uint16_t n, float p) {
  const Seg &sg = segs[si];
  uint16_t hue0 = SEG_HUE[si % 6];
  float f = n ? (float)i / n : 0;
  switch (sg.show) {
    case SHOW_RAINBOW: return hsv((uint16_t)((f + p) * 65536.0f), 255, 255);
    case SHOW_CHASE: { long k = (long)(p * n * 2.0f); return ((i + k) % 3 == 0) ? rgb(255, 170, 40) : rgb(40, 18, 0); }
    case SHOW_COMET: {
      float d = p - f; d -= (long)d; if (d < 0) d += 1;      // how far behind the head, 0..1
      return d < 0.35f ? hsv(hue0 + 32768, 255, (uint8_t)(255 * (1 - d / 0.35f))) : rgb(0, 0, 8);
    }
    case SHOW_SPARKLE: return random(100) < 6 ? rgb(255, 255, 255) : hsv(hue0 + 43000, 255, 60);
    case SHOW_BREATHE: return hsv(hue0 + (uint16_t)(p * 8000), 255, (uint8_t)(40 + wave((uint8_t)(p * 512)) * 215 / 255));
    case SHOW_TWINKLE: return hsv((uint16_t)(hue0 + i * 9000), 200, wave((uint8_t)(p * 700 + i * 37)));
  }
  return 0;
}
`);

  // state
  L.push(`// ---------------- the ride ----------------
enum State : uint8_t { BOARDING, COUNTDOWN, RIDING, SLOWING, HOMING, ESTOP };
const char *stateName[] = { "boarding", "countdown", "riding", "slowing", "finding the station", "emergency stop" };
State state = BOARDING;
unsigned long stateSince = 0, rideStart = 0, lastFrame = 0;
float phase = 0;
uint8_t leg = 0;          // which direction of the ride: 0 forwards, 1 backwards (REVERSE)
uint16_t cycles = 0;
uint16_t stops = 0;       // rides that ended at the station

void setState(State s, const char *why) {
  state = s; stateSince = millis();
  Serial.print(F("state: ")); Serial.print(stateName[s]);
  if (why[0]) { Serial.print(F(" (")); Serial.print(why); Serial.print(F(")")); }
  Serial.println();
}

void lightsFrame(float dt) {
  float share = speedShare();
  unsigned long t = millis() - stateSince;
  phase += dt * (state == BOARDING ? 0.15f : 0.2f + 1.2f * share);
  if (phase > 1000) phase -= 1000;
  for (uint8_t si = 0; si < N_SEGS; si++) {
    const Seg &sg = segs[si];
    for (uint16_t i = 0; i < sg.n; i++) {
      uint32_t col;
      switch (state) {
        case BOARDING: col = ((i + (long)(phase * 6)) % 4 == 0) ? rgb(255, 190, 90) : rgb(30, 18, 6); break;
        case COUNTDOWN: col = dim(rgb(255, 255, 255), (uint8_t)(255 - (t % 1000) * 255 / 1000)); break;
        case SLOWING:
        case HOMING: { float d = phase - (float)i / sg.n; d -= (long)d; if (d < 0) d += 1; col = d < 0.25f ? rgb(255, 120, 0) : rgb(20, 8, 0); break; }
        case ESTOP: col = (t / 250) % 2 ? rgb(255, 0, 0) : rgb(30, 0, 0); break;
        default: col = showPixel(si, i, sg.n, phase);
      }
      px(sg.strip, sg.first + i, col);
    }
  }
  lightsShow();
}

void startRide(const char *why) {
  cycles++; leg = 0;
  setState(COUNTDOWN, why);
}

void stopRide(const char *why) {
  if (state == RIDING || state == COUNTDOWN) { setSpeed(0); setState(SLOWING, why); }
}

void rideStep(unsigned long now) {
  if (state != ESTOP && motorPowerOff()) { halt(); setState(ESTOP, "motor power lost: the stop button is pressed or the supply is off"); return; }
  unsigned long t = now - stateSince;
  switch (state) {
    case BOARDING:
      if (startPressed()) startRide("start button");
      else if (BOARDING_S > 0 && t > BOARDING_S * 1000UL) startRide("boarding time over");
      break;
    case COUNTDOWN:
      if (t > COUNTDOWN_S * 1000UL) { rideStart = now; setSpeed(1); setState(RIDING, "ramping up"); }
      break;
    case RIDING: {
      // forwards for 60 % of the ride, then backwards for 40 %: it ends away from the station and creeps home
      float legS = REVERSE ? RIDE_S * (leg ? 0.4f : 0.6f) : RIDE_S;
      if (startPressed()) { stopRide("stopped early with the start button"); break; }
      if ((now - rideStart) > (unsigned long)((legS + RAMP_S) * 1000)) {
        if (REVERSE && leg == 0) {
          setSpeed(0);
          if (allRamped()) { leg = 1; rideStart = now; setSpeed(-1); Serial.println(F("state: riding (backwards)")); }
        } else stopRide("ride time over");
      }
      break;
    }
    case SLOWING:
      if (allRamped()) {
        if (USE_STATION && !atStation()) { setSpeed(leg ? -CREEP : CREEP); setState(HOMING, ""); }
        else { halt(); if (USE_STATION) stops++; setState(BOARDING, USE_STATION ? "at the station" : "stopped"); }
      }
      break;
    case HOMING:
      if (atStation()) { halt(); stops++; setState(BOARDING, "at the station"); }
      else if (t > STATION_TIMEOUT_S * 1000UL) { halt(); setState(BOARDING, "station not found: check the magnet and sensor"); }
      break;
    case ESTOP:
      if (!motorPowerOff() && startPressed()) {
        if (USE_STATION && !atStation()) { setSpeed(CREEP); setState(HOMING, "reset: back to the station"); }
        else setState(BOARDING, "reset");
      }
      break;
  }
}
`);

  // console
  L.push(`// ---------------- serial console ----------------
void status() {
  Serial.print(F("state ")); Serial.print(stateName[state]); Serial.print(F("  rides ")); Serial.print(cycles); Serial.print(F("  station stops ")); Serial.print(stops);
  for (uint8_t i = 0; i < N_MOTORS; i++) { Serial.print(F("  ")); Serial.print(motors[i].name); Serial.print(F(" ")); Serial.print(motors[i].rpm, 1); Serial.print(F("/")); Serial.print(motors[i].ramped, 1); Serial.print(F(" rpm pwm ")); Serial.print(motors[i].cmd); }
  if (motorV >= 0) { Serial.print(F("  motor supply ")); Serial.print(motorV, 1); Serial.print(F(" V")); }
  Serial.print(F("  station ")); if (atStation()) Serial.println(F("yes")); else Serial.println(F("no"));
}
void help() {
  Serial.println(F("Commands:"));
  Serial.println(F("  h            this help"));
  Serial.println(F("  s            status"));
  Serial.println(F("  g            start a ride (as the start button)"));
  Serial.println(F("  x            end the ride early: slow down and stop at the station"));
  Serial.println(F("  m <n> <pwm>  run motor n at -255..255 for 2 s (boarding only)"));
  for (uint8_t i = 0; i < N_MOTORS; i++) { Serial.print(F("  motor ")); Serial.print(i); Serial.print(F(" = ")); Serial.println(motors[i].name); }
}
char line[24];
uint8_t lineLen = 0;
unsigned long testUntil = 0;
void command(char *s) {
  char cmd = s[0];
  char *p = s + 1;
  long a1 = strtol(p, &p, 10);
  long a2 = strtol(p, &p, 10);
  switch (cmd) {
    case 'h': help(); break;
    case 's': status(); break;
    case 'g': if (state == BOARDING) startRide("console"); break;
    case 'x': stopRide("console"); break;
    case 'm':
      if (state == BOARDING && a1 >= 0 && a1 < N_MOTORS) { motorWrite(motors[a1], a2); testUntil = millis() + 2000; }
      else Serial.println(F("Only while boarding, and n must be a motor"));
      break;
    default: if (cmd) Serial.println(F("? (h for help)"));
  }
}
void console() {
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\\r' || ch == '\\n') { line[lineLen] = 0; if (lineLen) command(line); lineLen = 0; }
    else if (lineLen < sizeof(line) - 1) line[lineLen++] = ch;
  }
}

// ---------------- setup and loop ----------------
void setup() {
  Serial.begin(115200);
  for (uint8_t i = 0; i < N_MOTORS; i++) motorSetup(motors[i]);
  halt();
  encSetup();${button ? "\n  pinMode(START_BUTTON, INPUT_PULLUP);" : ""}${station ? "\n  pinMode(STATION_SENSOR, INPUT_PULLUP);" : ""}
  lightsBegin();
  motorV = readMotorV();
  Serial.println(F("${cString(c.designName)}: ${cString(c.fw.name)} ready"));
  help();
  setState(BOARDING, "power on");
}

void loop() {
  static unsigned long tSpeed = 0;
  unsigned long now = millis();
  console();
  if (now - tSpeed >= 50) {
    float dt = (now - tSpeed) / 1000.0f;
    tSpeed = now;
    encUpdate(dt);
    float v = readMotorV();
    motorV = v < 0 ? -1 : (motorV < 0 ? v : motorV * 0.7f + v * 0.3f);
    if (testUntil) { if (now > testUntil) { testUntil = 0; halt(); } }
    else { rideStep(now); if (state != ESTOP) speedUpdate(dt); }
  }
  if (now - lastFrame >= FRAME_MS) {
    float dt = (now - lastFrame) / 1000.0f;
    lastFrame = now;
    lightsFrame(dt);
  }
}`);

  // ---- README lines ----
  const R: string[] = [];
  R.push(
    `**Mode: ride.** It powers up boarding, with warm marquee lights chasing round. The start button${S.BOARD_S > 0 ? ` (or ${cNum(S.BOARD_S)} s of boarding)` : ""} starts a ride: ${cNum(S.COUNT_S)} s of flashing lights, then ${motors.length === 1 ? "the motor ramps" : "the motors ramp"} up to ride speed over ${cNum(S.RAMP_S)} s and ${encs.length ? "the encoders hold it" : "hold it"} for ${cNum(S.RIDE_S)} s${S.REVERSE ? ", 60 % one way and 40 % the other" : ""}. ${S.STATION ? "Then it slows to a creep until the station sensor sees its magnet and stops there, so people always get off at the platform." : "Then it ramps down and stops."} Each LED board plays its own show (${[...new Set(segs.map((s) => s.g.show))].join(", ") || "none wired"}), faster as the ride speeds up.${vs ? " The emergency stop cuts the motors' supply in hardware; the controller sees that on its voltage sensor, flashes every light red, and after the stop button is released and the start button pressed it creeps back to the station." : ""}`,
  );
  const summary = `ride controller with ${motors.length} motor${motors.length === 1 ? "" : "s"}, ${segs.length ? `${strips.reduce((x, s) => x + s.n, 0)} addressable LEDs` : "no lights"}${station ? ", station stop" : ""}${vs ? " and emergency stop" : ""}`;
  return { ino: L.join("\n") + "\n", readme: R, summary };
}
