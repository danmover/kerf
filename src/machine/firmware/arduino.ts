// Arduino sketch generator. Every pin number comes from the design's wiring, so
// the code always matches the harness. It uses only the Arduino core plus the
// bundled Wire, EEPROM and Servo libraries: nothing to install.
//
// Behaviours:
//   tunneller  screw-driven burrowing robot: start delay, heading hold with a
//              hinge actuator, roll trim, stall back-off, stop at distance or
//              breakthrough, battery cut-off, EEPROM run log
//   bench      no autonomous behaviour: the serial console drives each motor,
//              actuator and sensor for bring-up tests
// Both include the serial console.

import { catalogPart } from "../catalog";
import type { CatalogPart, MachineComponent } from "../types";
import { type FwContext, type GenFile, cNum, ident, setting } from "./common";

interface Io {
  /** the C expression for the pin: 9, A2 */
  pin: string;
  /** "ctrl.D9" for comments */
  at: string;
}

type Role = "pwm" | "dir" | "in1" | "in2" | "en" | "en2" | "cs" | "cs2" | "flt";

interface DriveOut {
  key: string;
  label: string;
  comp: MachineComponent;
  index: number;
  part: CatalogPart;
  kind: "dc" | "actuator";
  driver: MachineComponent;
  driverPart: CatalogPart;
  channel: string;
  scheme: string;
  pins: Partial<Record<Role, Io>>;
  tiedHigh: string[];
  missing: string[];
  sign: 1 | -1;
  encA?: Io;
  encB?: Io;
  cpr?: number;
  fb?: Io;
  csVPerA: number;
  csOffset: number;
  /** the driver's current sense reads only while driving, about 0 V in the PWM off-time */
  csDriveOnly: boolean;
  /** heat estimate: winding resistance (ohm), heat capacity (J/K) and thermal resistance to free air (K/W); 0 = none */
  heat: { r: number; c: number; rth: number };
}

interface ServoOut {
  key: string;
  comp: MachineComponent;
  part: CatalogPart;
  sig: Io;
}

export interface ArduinoResult {
  files: GenFile[];
  warnings: string[];
  pinTable: { signal: string; pin: string; wire: string }[];
  behaviour: "tunneller" | "bench";
}

/** a C float literal */
const cFloat = (n: number) => (Number.isInteger(n) ? `${n}.0f` : `${cNum(n)}f`);

const SCHEME_C: Record<string, string> = {
  pwm_dir: "PWM_DIR",
  rpwm_lpwm: "RPWM_LPWM",
  in1_in2_en: "EN_IN1_IN2",
  in1_in2_pwm: "PWM_IN1_IN2",
  in1_in2_pwm_both: "IN1_IN2_PWM",
};

/** Driver pin ids for each role of one channel. */
function channelPins(part: CatalogPart, channel: string): Partial<Record<Role, string>> {
  const has = (id: string) => part.pins.some((p) => p.id === id);
  const pick = (...ids: string[]) => ids.find(has);
  const B = channel === "B";
  switch (part.specs.control) {
    case "pwm_dir":
      return { pwm: pick(B ? "PWM2" : "PWM1", "PWM"), dir: pick(B ? "DIR2" : "DIR1", "DIR"), en: pick("SLP"), cs: pick("CS"), flt: pick("FLT") };
    case "rpwm_lpwm":
      return { in1: "RPWM", in2: "LPWM", en: "R_EN", en2: "L_EN", cs: pick("R_IS"), cs2: pick("L_IS") };
    case "in1_in2_en":
      return { pwm: B ? "ENB" : "ENA", in1: B ? "IN3" : "IN1", in2: B ? "IN4" : "IN2" };
    case "in1_in2_pwm":
      return { pwm: B ? "PWMB" : "PWMA", in1: B ? "BIN1" : "AIN1", in2: B ? "BIN2" : "AIN2", en: pick("STBY") };
    case "in1_in2_pwm_both":
      return { in1: B ? "BIN1" : "AIN1", in2: B ? "BIN2" : "AIN2", flt: pick("FAULT") };
    default:
      return {};
  }
}

/**
 * A one-lump heat estimate for a DC motor: winding resistance from the rated voltage and stall current,
 * and the catalog's thermal resistance and time constant when it gives them. Otherwise a guess scaled
 * from the motor's mass (the same one the simulation uses), so the firmware and the simulation agree.
 */
function motorHeat(part: CatalogPart): { r: number; c: number; rth: number } {
  const v = Number(part.specs.v_rated ?? 0);
  const iStall = Number(part.specs.i_stall ?? 0);
  if (part.kind !== "gearmotor" || !(v > 0) || !(iStall > 0)) return { r: 0, c: 0, rth: 0 };
  const r = v / iStall;
  const { rth_k_per_w: rth, tau_th_s: tau } = part.specs;
  if (typeof rth === "number" && typeof tau === "number" && rth > 0 && tau > 0) return { r, c: tau / rth, rth };
  const mass = Number(part.specs.mass_g ?? 300);
  return { r, c: mass * 0.45, rth: 12 * Math.sqrt(524 / mass) };
}

const NEEDED: Record<string, Role[]> = {
  pwm_dir: ["pwm", "dir"],
  rpwm_lpwm: ["in1", "in2"],
  in1_in2_en: ["pwm", "in1", "in2"],
  in1_in2_pwm: ["pwm", "in1", "in2"],
  in1_in2_pwm_both: ["in1", "in2"],
};

export function arduinoFirmware(c: FwContext): ArduinoResult {
  const warnings: string[] = [];
  const board = c.board.name;
  const boardV = c.boardPart.pins.find((p) => p.type === "io")?.v ?? 5;
  const isEsp32 = c.boardPart.id.startsWith("esp32");
  const adcMax = isEsp32 ? 4095 : 1023;

  const netPins = (comp: string, pin: string, index = 0) => c.nl.netOf.get(`${comp}[${index}].${pin}`)?.pins ?? [];
  const io = (comp: string, pin: string, index = 0): Io | undefined => {
    const p = netPins(comp, pin, index).find((x) => x.comp === board && x.pin.type === "io");
    return p ? { pin: p.pin.mcu ?? p.pin.id, at: `${board}.${p.pin.id}` } : undefined;
  };
  const high = (comp: string, pin: string, index = 0) => netPins(comp, pin, index).some((x) => x.pin.type === "pwr_out" || x.pin.type === "pwr_rail");
  const used = new Set<string>();
  const label = (mc: MachineComponent, i: number) => (mc.count > 1 ? `${mc.name}[${i}]` : mc.name);

  // ---- motors and actuators on driver channels ----
  const outs: DriveOut[] = [];
  const servos: ServoOut[] = [];
  for (const mc of c.m.components) {
    const part = catalogPart(mc.catalogId);
    if (!part) continue;
    for (let i = 0; i < mc.count; i++) {
      const key = ident(mc.count > 1 ? `${mc.name}_${i}` : mc.name);
      if ((part.kind === "servo" || part.kind === "actuator") && part.pins.some((p) => p.id === "SIG")) {
        const sig = io(mc.name, "SIG", i);
        if (sig) servos.push({ key, comp: mc, part, sig });
        else warnings.push(`${label(mc, i)}.SIG is not wired to ${board}: the firmware cannot move it.`);
        continue;
      }
      if (part.kind !== "gearmotor" && part.kind !== "actuator") continue;
      const plus = netPins(mc.name, "M_PLUS", i).find((p) => p.pin.type === "motor_out");
      if (!plus) {
        warnings.push(`${label(mc, i)} is not wired to a motor driver: the firmware leaves it out.`);
        continue;
      }
      const dpart = plus.part;
      const channel = plus.pin.channel ?? "A";
      const scheme = String(dpart.specs.control ?? "");
      if (!SCHEME_C[scheme]) {
        warnings.push(`${plus.comp} uses a control scheme Kerf cannot drive yet (${scheme || "unknown"}).`);
        continue;
      }
      const roles = channelPins(dpart, channel);
      const pins: Partial<Record<Role, Io>> = {};
      const tied: string[] = [];
      const missing: string[] = [];
      for (const [role, pid] of Object.entries(roles) as [Role, string | undefined][]) {
        if (!pid) continue;
        const r = io(plus.comp, pid, plus.index);
        if (r) pins[role] = r;
        else if (high(plus.comp, pid, plus.index)) tied.push(pid);
        else if (NEEDED[scheme]?.includes(role)) missing.push(pid);
      }
      if (missing.length) warnings.push(`${plus.comp} ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not wired to ${board}: ${label(mc, i)} cannot run until ${missing.length === 1 ? "it is" : "they are"}.`);
      const chOuts = dpart.pins.filter((p) => p.type === "motor_out" && (p.channel ?? "A") === channel);
      const sign: 1 | -1 = chOuts[0]?.id === plus.pin.id ? 1 : -1;
      const out: DriveOut = {
        key,
        label: label(mc, i),
        comp: mc,
        index: i,
        part,
        kind: part.kind === "actuator" ? "actuator" : "dc",
        driver: plus.mc,
        driverPart: dpart,
        channel,
        scheme,
        pins,
        tiedHigh: tied,
        missing,
        sign,
        csVPerA: typeof dpart.specs.current_sense_v_per_a === "number" ? dpart.specs.current_sense_v_per_a : 0,
        csOffset: typeof dpart.specs.current_sense_offset_v === "number" ? dpart.specs.current_sense_offset_v : 0,
        csDriveOnly: dpart.specs.current_sense_drive_only === true,
        heat: motorHeat(part),
      };
      if (part.pins.some((p) => p.id === "ENC_A")) {
        out.encA = io(mc.name, "ENC_A", i);
        out.encB = io(mc.name, "ENC_B", i);
        out.cpr = typeof part.specs.encoder_cpr === "number" ? part.specs.encoder_cpr : undefined;
      }
      if (part.pins.some((p) => p.id === "FB")) {
        out.fb = io(mc.name, "FB", i);
        if (!out.fb) warnings.push(`${label(mc, i)}.FB (position feedback) is not wired to an analog pin: the steering cannot hold a position.`);
      }
      outs.push(out);
    }
  }
  for (const o of outs) for (const r of Object.values(o.pins)) used.add(r!.pin);

  const motors = outs.filter((o) => o.kind === "dc");
  const actuators = outs.filter((o) => o.kind === "actuator");
  const find = (re: RegExp) => motors.find((m) => re.test(`${m.comp.name} ${m.comp.role ?? ""}`));
  const front = find(/front|nose|head/i) ?? motors[0];
  const rear = find(/rear|back|tail/i) ?? motors.find((m) => m !== front);
  const steer = actuators.find((a) => /steer|hinge/i.test(`${a.comp.name} ${a.comp.role ?? ""}`)) ?? actuators[0];
  const steerServo = !steer ? servos.find((s) => /steer|hinge/i.test(`${s.comp.name} ${s.comp.role ?? ""}`)) ?? servos[0] : undefined;

  // ---- encoders (interrupt pins) ----
  const encs = motors.filter((m) => m.encA);
  for (const m of encs) {
    const pin = c.boardPart.pins.find((p) => (p.mcu ?? p.id) === m.encA!.pin);
    if (pin && pin.irq === false) warnings.push(`${m.label} encoder A is on ${m.encA!.at}, which cannot take interrupts: the encoder counts will be wrong.`);
    used.add(m.encA!.pin);
    if (m.encB) used.add(m.encB.pin);
  }

  // ---- sensors ----
  const comps = (kinds: string[], ids?: string[]) => c.m.components.filter((x) => {
    const p = catalogPart(x.catalogId);
    return p && kinds.includes(p.kind) && (!ids || ids.includes(p.id));
  });
  const bno = comps(["sensor"], ["bno055"])[0];
  const mpu = !bno ? comps(["sensor"], ["mpu6050"])[0] : undefined;
  const imu = bno ?? mpu;
  if (imu) {
    const sda = netPins(imu.name, "SDA").some((p) => p.comp === board && p.pin.bus === "i2c_sda");
    const scl = netPins(imu.name, "SCL").some((p) => p.comp === board && p.pin.bus === "i2c_scl");
    if (!sda || !scl) warnings.push(`${imu.name} SDA/SCL must go to ${board}'s I2C pins for the firmware to read it.`);
  }
  const vsense = comps(["sensor"], ["voltage_sensor_25v"])[0];
  const vsPin = vsense ? io(vsense.name, "S") : undefined;
  if (vsPin) used.add(vsPin.pin);
  const vsRatio = vsense ? Number(catalogPart(vsense.catalogId)?.specs.ratio ?? 5) : 5;
  const battery = comps(["battery"])[0];
  const cells = battery ? Number(catalogPart(battery.catalogId)?.specs.cells ?? 0) : 0;
  const servoUse = servos.length > 0;
  for (const s of servos) used.add(s.sig.pin);
  if (servoUse && !isEsp32 && c.boardPart.id !== "arduino_mega") {
    const clash = outs.flatMap((o) => [o.pins.pwm, o.pins.in1, o.pins.in2]).filter((p) => p && (p.pin === "9" || p.pin === "10"));
    if (clash.length) warnings.push(`The Servo library uses Timer1, which turns off PWM on pins 9 and 10 (${clash.map((p) => p!.at).join(", ")}). Move those motor PWM wires to 3, 5, 6 or 11.`);
  }
  if (servoUse && isEsp32) warnings.push("ESP32 has no bundled Servo library: install ESP32Servo, or drive the servo with ledc PWM.");

  // ---- behaviour and settings ----
  const behaviourText = setting(c.fw, "behaviour", setting(c.fw, "behavior", ""));
  const tunneller = /tunnel|burrow|sand|drill|dig|bore/i.test(behaviourText) && motors.length > 0;
  const behaviour: ArduinoResult["behaviour"] = tunneller ? "tunneller" : "bench";
  const ledPin = used.has("13") || isEsp32 ? "-1" : "LED_BUILTIN";

  const stallA = (m: DriveOut) => {
    const iStall = Number(m.part.specs.i_stall ?? 0);
    return setting(c.fw, "stall_current", iStall ? Math.round(iStall * 0.8 * 10) / 10 : 8);
  };
  const actStroke = steer ? Number(steer.part.specs.stroke ?? 50) : 50;
  const S = {
    START_DELAY_S: setting(c.fw, "start_delay", 10),
    RUN_DISTANCE_MM: setting(c.fw, "run_distance", 1100),
    MAX_RUN_S: setting(c.fw, "max_run_time", 3600),
    POWER: setting(c.fw, "power", 0.8),
    PITCH_MM: setting(c.fw, "pitch", 40),
    SLIP: setting(c.fw, "slip", 0.5),
    STALL_A: front ? stallA(front) : 8,
    STALL_MS: setting(c.fw, "stall_time", 0.6) * 1000,
    BACKOFF_MS: setting(c.fw, "backoff_time", 1.5) * 1000,
    MAX_RETRIES: setting(c.fw, "max_retries", 8),
    HEADING_KP: setting(c.fw, "heading_kp", 1.5),
    HEADING_KI: setting(c.fw, "heading_ki", 0.05),
    STEER_MAX_DEG: setting(c.fw, "steer_max", 8),
    STEER_ARM_MM: setting(c.fw, "steer_arm", 40),
    STEER_SLOPE: setting(c.fw, "steer_slope", 1),
    ACT_DEADBAND_MM: setting(c.fw, "steer_deadband", 0.4),
    ACT_MID_MM: setting(c.fw, "steer_mid", actStroke / 2),
    ROLL_KP: setting(c.fw, "roll_kp", 0.01),
    ROLL_TRIM_MAX: setting(c.fw, "roll_trim_max", 0.25),
    LOW_CELL_V: setting(c.fw, "low_cell", 3.4),
    LOG_S: setting(c.fw, "log_interval", 5),
    BREAK_FRAC: setting(c.fw, "breakthrough_current", 0.5),
    STEER_SIGN: setting(c.fw, "steer_sign", 1) < 0 ? -1 : 1,
    ROLL_LIMIT_DEG: setting(c.fw, "roll_limit", 60),
    MOTOR_HOT_K: setting(c.fw, "motor_hot_rise", 60),
    MOTOR_COOLING: setting(c.fw, "motor_cooling", 0.5),
    GIVE_UP_S: setting(c.fw, "give_up_time", 0),
  };

  // ---- pins.h ----
  const pinTable: ArduinoResult["pinTable"] = [];
  const P: string[] = [];
  P.push(`// pins.h: generated by Kerf from the wiring in "${c.designName}" (firmware ${c.fw.name}, board ${board}: ${c.boardPart.name}).`);
  P.push("// Change the wiring in the design and export again rather than editing this file. -1 means not wired.");
  P.push("#pragma once", "");
  const def = (name: string, r: Io | undefined, what: string) => {
    P.push(`#define ${name.padEnd(22)} ${(r?.pin ?? "-1").padEnd(4)} // ${r ? `${r.at} -> ${what}` : `not wired (${what})`}`);
    if (r) pinTable.push({ signal: name, pin: r.at, wire: what });
  };
  for (const o of outs) {
    P.push(`// ${o.label}: ${o.part.name}`);
    P.push(`//   driven by ${o.driver.name} channel ${o.channel} (${o.driverPart.name}, ${o.scheme.replace(/_/g, " ")})${o.tiedHigh.length ? `; ${o.tiedHigh.join(", ")} tied high in the wiring` : ""}`);
    const rp = channelPins(o.driverPart, o.channel);
    for (const role of ["pwm", "dir", "in1", "in2", "en", "en2", "cs", "cs2", "flt"] as Role[]) {
      if (!rp[role]) continue;
      def(`${o.key}_${role.toUpperCase()}`, o.pins[role], `${o.driver.name}.${rp[role]}`);
    }
    if (o.encA || o.cpr) {
      def(`${o.key}_ENC_A`, o.encA, `${o.label}.ENC_A`);
      def(`${o.key}_ENC_B`, o.encB, `${o.label}.ENC_B`);
    }
    if (o.part.pins.some((p) => p.id === "FB")) def(`${o.key}_FB`, o.fb, `${o.label}.FB`);
    P.push("");
  }
  for (const s of servos) {
    P.push(`// ${s.comp.name}: ${s.part.name}`);
    def(`${s.key}_SIG`, s.sig, `${s.comp.name}.SIG`);
    P.push("");
  }
  if (vsense) {
    P.push(`// ${vsense.name}: battery voltage through a ${vsRatio}:1 divider`);
    def("VBAT_SENSE", vsPin, `${vsense.name}.S`);
    P.push("");
  }
  if (imu) P.push(`// ${imu.name} (${catalogPart(imu.catalogId)?.name}) on the I2C pins (Wire)`, "");
  P.push(`#define STATUS_LED             ${ledPin}${ledPin === "-1" ? " // pin 13 is used by the wiring" : ""}`);

  // ---- config.h ----
  const C: string[] = [];
  C.push(`// config.h: tuning for "${c.designName}". Values come from the firmware block in the design; edit here to tune on the bench.`);
  C.push("#pragma once", "");
  C.push(`#define ADC_REF_V        ${cNum(boardV)}   // ${board} logic and ADC reference`);
  C.push(`#define ADC_MAX          ${adcMax}.0`);
  C.push("");
  C.push("// Direction: flip to -1 if a motor turns the wrong way (bench test m <n> <pwm>), instead of swapping wires.");
  for (const o of outs) C.push(`#define ${(o.key + "_FWD").padEnd(16)} ${o.sign === 1 ? " 1" : "-1"}${o.sign === -1 ? "   // M+ goes to the driver's second output, so the code inverts it" : ""}`);
  C.push("");
  if (tunneller) {
    C.push("// Run");
    C.push(`#define START_DELAY_S    ${cNum(S.START_DELAY_S)}      // time to close the hatch and step back`);
    C.push(`#define RUN_DISTANCE_MM  ${cNum(S.RUN_DISTANCE_MM)}    // expected distance to the far side (estimated from screw turns)`);
    C.push(`#define GIVE_UP_MM       ${cNum(2 * S.RUN_DISTANCE_MM)}    // no breakthrough after twice that: probably turning in place, so back out`);
    C.push(`#define GIVE_UP_S        ${cNum(S.GIVE_UP_S)}    // or after this long digging (0: no time limit)`);
    C.push(`#define MAX_RUN_S        ${cNum(S.MAX_RUN_S)}    // hard stop`);
    C.push(`#define POWER            ${cNum(S.POWER)}     // 0..1 of full PWM while digging`);
    C.push(`#define PITCH_MM         ${cNum(S.PITCH_MM)}      // screw flight pitch`);
    C.push(`#define SLIP             ${cNum(S.SLIP)}     // fraction of each turn lost to sand slip (measure it: test plan)`);
    C.push("");
    C.push("// Stall handling");
    C.push(`#define STALL_A          ${cNum(S.STALL_A)}     // motor current that counts as stalled`);
    C.push(`#define STALL_MS         ${cNum(S.STALL_MS)}`);
    C.push(`#define BACKOFF_MS       ${cNum(S.BACKOFF_MS)}    // reverse this long, then dig again`);
    C.push(`#define MAX_RETRIES      ${cNum(S.MAX_RETRIES)}      // give up after this many stalls without progress`);
    C.push(`#define BREAK_FRAC       ${cNum(S.BREAK_FRAC)}     // front motor current falls below this share of its digging average at breakthrough`);
    C.push("#define DIG_REF_S        20      // time constant of that average, s");
    C.push("#define DIG_HOLD_S       60      // a drop held out of the average this long becomes the new normal");
    C.push(`#define ROLL_LIMIT_DEG   ${cNum(S.ROLL_LIMIT_DEG)}      // the body rolling past this means the screws no longer balance: stop`);
    C.push("");
    C.push("// Motor heating (estimated from the current: check the can temperature on the bench)");
    C.push(`#define MOTOR_HOT_K      ${cNum(S.MOTOR_HOT_K)}      // estimated rise above the surroundings that is too hot: rest. Digging turns back at 3/4 of it`);
    C.push(`#define MOTOR_COOLING    ${cNum(S.MOTOR_COOLING)}     // share of free-air cooling the motor gets where it runs (buried in sand: a guess)`);
    C.push("");
    C.push("// Steering and roll");
    C.push(`#define HEADING_KP       ${cNum(S.HEADING_KP)}     // degrees of hinge per degree of heading error`);
    C.push(`#define HEADING_KI       ${cNum(S.HEADING_KI)}`);
    C.push(`#define ROLL_KP          ${cNum(S.ROLL_KP)}    // speed split per degree of roll`);
    C.push(`#define ROLL_TRIM_MAX    ${cNum(S.ROLL_TRIM_MAX)}`);
    C.push("#define ROLL_SIGN        1       // flip if roll trim makes the roll worse");
    C.push("");
  }
  if (tunneller || steer || steerServo) {
    C.push(`#define STEER_MAX_DEG    ${cNum(S.STEER_MAX_DEG)}`);
    C.push(`#define STEER_SIGN       ${S.STEER_SIGN === 1 ? " 1" : "-1"}      // +1 when extending the steering turns the nose clockwise seen from above, the way the IMU heading grows; -1 when it turns it anticlockwise`);
    C.push("");
  }
  if (steer) {
    C.push("// Steering actuator (position from its potentiometer)");
    C.push(`#define ACT_STROKE_MM    ${cNum(actStroke)}`);
    C.push(`#define ACT_MID_MM       ${cNum(S.ACT_MID_MM)}      // stroke when the hinge is straight`);
    C.push(`#define STEER_ARM_MM     ${cNum(S.STEER_ARM_MM)}      // hinge pin to where the actuator or cam pushes`);
    C.push(`#define STEER_SLOPE      ${cFloat(S.STEER_SLOPE)}   // sideways movement per mm of stroke (1 for a direct push, the slot slope for a cam)`);
    C.push(`#define ACT_DEADBAND_MM  ${cFloat(S.ACT_DEADBAND_MM)}`);
    C.push("#define ACT_KP           120     // PWM per mm of error");
    C.push("#define ACT_PWM_MIN      90      // below this the actuator does not move");
    C.push("#define ACT_STALL_MS     1500    // no movement for this long while driving = jammed, rest 2 s");
    C.push("#define ACT_ADC_MIN      0       // reading fully retracted: run k on the console and copy the result here");
    C.push(`#define ACT_ADC_MAX      ${adcMax}`);
    C.push("");
  }
  if (steerServo) {
    C.push("// Steering servo");
    C.push("#define SERVO_MID_US     1500");
    C.push("#define SERVO_US_PER_DEG 10");
    C.push("");
  }
  if (vsense || cells) {
    C.push("// Battery");
    C.push(`#define VBAT_RATIO       ${cNum(vsRatio)}`);
    C.push(`#define LOW_BATTERY_V    ${cNum(cells ? cells * S.LOW_CELL_V : 0)}${cells ? `   // ${cells} cells × ${cNum(S.LOW_CELL_V)} V` : ""}`);
    C.push("");
  }
  C.push(`#define LOG_INTERVAL_MS  ${cNum(S.LOG_S * 1000)}`);
  if (bno) C.push("#define BNO_ADDR         0x28    // 0x29 if ADR is tied high", "#define BNO_AXIS_MAP     0x24    // default: chip flat, dot towards the front left. See the BNO055 datasheet 3.4", "#define BNO_AXIS_SIGN    0x00");
  if (mpu) C.push("#define MPU_ADDR         0x68");

  // ---- the sketch ----
  const ino = sketch({ c, outs, motors, front, rear, steer, steerServo, servos, encs, bno: !!bno, mpu: !!mpu, vsense: !!vsPin, tunneller, isEsp32 });

  const name = ident(c.fw.name).toLowerCase() || "firmware";
  const dir = `firmware/${name}`;
  const readme = arduinoReadme({ c, name, outs, servos, imu, vsense: !!vsPin, tunneller, warnings, pinTable, isEsp32, steer, front, rear });
  return {
    files: [
      { path: `${dir}/${name}.ino`, content: ino },
      { path: `${dir}/pins.h`, content: P.join("\n") + "\n" },
      { path: `${dir}/config.h`, content: C.join("\n") + "\n" },
      { path: `${dir}/README.md`, content: readme },
    ],
    warnings,
    pinTable,
    behaviour,
  };
}

interface SketchArgs {
  c: FwContext;
  outs: DriveOut[];
  motors: DriveOut[];
  front?: DriveOut;
  rear?: DriveOut;
  steer?: DriveOut;
  steerServo?: ServoOut;
  servos: ServoOut[];
  encs: DriveOut[];
  bno: boolean;
  mpu: boolean;
  vsense: boolean;
  tunneller: boolean;
  isEsp32: boolean;
}

function sketch(a: SketchArgs): string {
  const { c, outs, front, rear, steer, steerServo, servos, encs } = a;
  const imu = a.bno || a.mpu;
  const L: string[] = [];
  const pinOr = (o: DriveOut, r: Role) => (channelPins(o.driverPart, o.channel)[r] ? `${o.key}_${r.toUpperCase()}` : "-1");

  L.push(`// ${c.fw.name}: generated by Kerf for "${c.designName}".`);
  const behaviour = setting(c.fw, "behaviour", setting(c.fw, "behavior", ""));
  if (behaviour) L.push(`// Behaviour asked for: ${behaviour.replace(/\n/g, " ")}`);
  L.push(a.tunneller ? "// Mode: tunneller (autonomous run after the start delay; the serial console works throughout)." : "// Mode: bench (serial console only: drive each motor and read each sensor).");
  L.push("// Open the Serial Monitor at 115200 baud and type h for the commands.");
  L.push("");
  L.push("#include <Arduino.h>");
  if (imu) L.push("#include <Wire.h>");
  if (servos.length) L.push("#include <Servo.h>");
  L.push("#if defined(ARDUINO_ARCH_AVR)", "#include <EEPROM.h>", "#define HAVE_LOG 1", "#else", "#define HAVE_LOG 0", "#endif");
  L.push('#include "config.h"', '#include "pins.h"', "");

  // motor table
  L.push("// ---------------- motors ----------------");
  L.push("enum Scheme : uint8_t { PWM_DIR, RPWM_LPWM, EN_IN1_IN2, PWM_IN1_IN2, IN1_IN2_PWM };", "");
  L.push("struct Motor {");
  L.push("  const char *name;");
  L.push("  uint8_t scheme;");
  L.push("  int16_t pwm, dir, in1, in2, en, en2, cs, cs2, flt;  // -1 = not wired");
  L.push("  float csVPerA, csOffset;                         // current sense volts per amp and offset");
  L.push("  bool csDriveOnly;                                // current sense reads only while driving (0 V in the PWM off-time)");
  L.push("  int8_t fwd;                                      // +1 or -1");
  L.push("  int16_t cmd;                                     // last command, -255..255");
  L.push("  float amps;                                      // filtered current, -1 = no sensor");
  L.push("  float rOhm, heatJK, rthKW;                       // winding resistance, heat capacity, thermal resistance to free air (0: no estimate)");
  L.push("  float heat;                                      // estimated rise above the surroundings, K");
  L.push("};", "");
  if (outs.length) {
    L.push("Motor motors[] = {");
    for (const o of outs) {
      const pinsList = (["pwm", "dir", "in1", "in2", "en", "en2", "cs", "cs2", "flt"] as Role[]).map((r) => pinOr(o, r)).join(", ");
      const h = o.kind === "dc" ? o.heat : { r: 0, c: 0, rth: 0 };
      L.push(`  { "${o.label}", ${SCHEME_C[o.scheme]}, ${pinsList}, ${cFloat(o.csVPerA)}, ${cFloat(o.csOffset)}, ${o.csDriveOnly}, ${o.key}_FWD, 0, -1, ${cFloat(h.r)}, ${cFloat(h.c)}, ${cFloat(h.rth)}, 0 },`);
    }
    L.push("};");
  } else L.push("Motor motors[1] = { { \"none\", PWM_DIR, -1, -1, -1, -1, -1, -1, -1, -1, -1, 0, 0, false, 1, 0, -1, 0, 0, 0, 0 } };");
  L.push(`const uint8_t N_MOTORS = ${outs.length};`);
  for (const o of outs) L.push(`const uint8_t ${o.key}_IDX = ${outs.indexOf(o)};`);
  L.push("");
  L.push(
    `void pinOut(int16_t p) { if (p >= 0) pinMode(p, OUTPUT); }
void writeD(int16_t p, bool v) { if (p >= 0) digitalWrite(p, v ? HIGH : LOW); }
void writeA(int16_t p, int v) { if (p >= 0) analogWrite(p, v); }

void motorSetup(Motor &m) {
  pinOut(m.pwm); pinOut(m.dir); pinOut(m.in1); pinOut(m.in2); pinOut(m.en); pinOut(m.en2);
  writeD(m.en, true); writeD(m.en2, true);   // wake / enable the driver
  if (m.flt >= 0) pinMode(m.flt, INPUT_PULLUP);
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

void stopAll() { for (uint8_t i = 0; i < N_MOTORS; i++) motorWrite(motors[i], 0); }

// Driver current sense, if wired: -1 = no sensor, -2 = this sample says nothing. Some drivers (the G2)
// sense only while driving and read about 0 V, below their offset, in the PWM off-time. Those samples
// are skipped rather than averaged in, or the reading would come out low by the duty cycle.
float readAmps(const Motor &m) {
  int16_t p = (m.cs2 >= 0 && m.cmd * m.fwd < 0) ? m.cs2 : m.cs;
  if (p < 0 || m.csVPerA <= 0) return -1;
  float v = analogRead(p) * (ADC_REF_V / ADC_MAX);
  if (m.csDriveOnly && m.cmd != 0 && v < m.csOffset * 0.5f) return -2;
  float a = (v - m.csOffset) / m.csVPerA;
  return a < 0 ? 0 : a;
}

bool driverFault() {
  for (uint8_t i = 0; i < N_MOTORS; i++) if (motors[i].flt >= 0 && digitalRead(motors[i].flt) == LOW) return true;
  return false;
}
`,
  );

  // encoders
  L.push("// ---------------- encoders ----------------");
  L.push(`const uint8_t N_ENC = ${encs.length};`);
  L.push(`float encRpm[${Math.max(1, encs.length)}];`);
  L.push("#if defined(ESP32)", "#define ISR_ATTR IRAM_ATTR", "#else", "#define ISR_ATTR", "#endif");
  if (encs.length) {
    L.push(`volatile long encCount[N_ENC];`);
    L.push(`const float encCountsPerRev[N_ENC] = { ${encs.map((m) => cFloat((m.cpr ?? 0) / 2)).join(", ")} };  // counting both edges of A`);
    encs.forEach((m, i) => {
      if (m.encB) L.push(`void ISR_ATTR encIsr${i}() { encCount[${i}] += (digitalRead(${m.key}_ENC_A) == digitalRead(${m.key}_ENC_B)) ? -${m.key}_FWD : ${m.key}_FWD; }`);
      else L.push(`void ISR_ATTR encIsr${i}() { encCount[${i}] += motors[${m.key}_IDX].cmd >= 0 ? 1 : -1; }  // no channel B: direction from the command`);
    });
    L.push(`long encRead(uint8_t i) { noInterrupts(); long v = encCount[i]; interrupts(); return v; }`);
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
    encRpm[i] = encCountsPerRev[i] > 0 ? (v - last[i]) / encCountsPerRev[i] / dtS * 60.0f : 0;
    last[i] = v;
  }
}`);
  } else {
    L.push("void encSetup() {}", "void encUpdate(float) {}", "long encRead(uint8_t) { return 0; }");
  }
  L.push("");

  // IMU
  L.push("// ---------------- IMU ----------------");
  L.push("float yaw = 0, roll = 0, pitch = 0;  // degrees");
  L.push("bool imuOk = false;");
  if (a.bno) {
    L.push(`// Minimal BNO055 driver: IMU fusion mode (gyro + accelerometer, no compass, which is unreliable near motors and underground).
void bnoWrite(uint8_t reg, uint8_t v) { Wire.beginTransmission(BNO_ADDR); Wire.write(reg); Wire.write(v); Wire.endTransmission(); }
int bnoRead8(uint8_t reg) {
  Wire.beginTransmission(BNO_ADDR); Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return -1;
  if (Wire.requestFrom((uint8_t)BNO_ADDR, (uint8_t)1) != 1) return -1;
  return Wire.read();
}
bool imuBegin() {
  Wire.begin();
  delay(700);                           // boot time
  if (bnoRead8(0x00) != 0xA0) return false;   // chip id
  bnoWrite(0x3D, 0x00); delay(25);      // config mode
  bnoWrite(0x3E, 0x00); delay(10);      // normal power
  bnoWrite(0x41, BNO_AXIS_MAP); bnoWrite(0x42, BNO_AXIS_SIGN);
  bnoWrite(0x3B, 0x00);                 // degrees, Celsius
  bnoWrite(0x3D, 0x08); delay(25);      // IMU fusion mode
  return true;
}
bool imuRead() {
  Wire.beginTransmission(BNO_ADDR); Wire.write(0x1A);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((uint8_t)BNO_ADDR, (uint8_t)6) != 6) return false;
  int16_t v[3];
  for (uint8_t i = 0; i < 3; i++) { uint8_t lo = Wire.read(); uint8_t hi = Wire.read(); v[i] = (int16_t)((hi << 8) | lo); }
  yaw = v[0] / 16.0f; roll = v[1] / 16.0f; pitch = v[2] / 16.0f;
  return true;
}`);
  } else if (a.mpu) {
    L.push(`// Minimal MPU-6050 driver: yaw by integrating the gyro (drifts slowly), roll and pitch from gravity.
float gyroBias = 0;
void mpuWrite(uint8_t reg, uint8_t v) { Wire.beginTransmission(MPU_ADDR); Wire.write(reg); Wire.write(v); Wire.endTransmission(); }
bool mpuRead(uint8_t reg, int16_t *out, uint8_t n) {
  Wire.beginTransmission(MPU_ADDR); Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((uint8_t)MPU_ADDR, (uint8_t)(n * 2)) != n * 2) return false;
  for (uint8_t i = 0; i < n; i++) { uint8_t hi = Wire.read(); uint8_t lo = Wire.read(); out[i] = (int16_t)((hi << 8) | lo); }
  return true;
}
bool imuBegin() {
  Wire.begin();
  mpuWrite(0x6B, 0x00);                 // wake
  mpuWrite(0x1B, 0x00);                 // gyro ±250 °/s
  mpuWrite(0x1C, 0x00);                 // accel ±2 g
  delay(100);
  long sum = 0; int16_t g;
  for (int i = 0; i < 200; i++) { if (!mpuRead(0x47, &g, 1)) return false; sum += g; delay(3); }
  gyroBias = sum / 200.0f;              // keep still while this runs
  return true;
}
bool imuRead() {
  static unsigned long last = micros();
  int16_t acc[3], gz;
  if (!mpuRead(0x3B, acc, 3) || !mpuRead(0x47, &gz, 1)) return false;
  unsigned long now = micros();
  float dt = (now - last) * 1e-6f; last = now;
  yaw += (gz - gyroBias) / 131.0f * dt;
  roll = atan2(acc[1], acc[2]) * RAD_TO_DEG;
  pitch = atan2(-acc[0], sqrt((float)acc[1] * acc[1] + (float)acc[2] * acc[2])) * RAD_TO_DEG;
  return true;
}`);
  } else {
    L.push("bool imuBegin() { return false; }", "bool imuRead() { return false; }");
  }
  L.push("float wrap180(float a) { while (a > 180) a -= 360; while (a < -180) a += 360; return a; }");
  L.push("");

  // steering
  L.push("// ---------------- steering ----------------");
  if (steer) {
    L.push(`int actAdcMin = ACT_ADC_MIN, actAdcMax = ACT_ADC_MAX;
float actTarget = ACT_MID_MM;
float actPos() { return (analogRead(${steer.key}_FB) - actAdcMin) * (float)ACT_STROKE_MM / (float)(actAdcMax - actAdcMin); }
// Stall guard: if the actuator pushes without moving it rests, so a jam does
// not hold full force on the linkage.
unsigned long actCheckAt = 0, actRestUntil = 0;
float actCheckPos = 0;
void actService() {
  if (${steer.key}_FB < 0) return;
  unsigned long now = millis();
  float pos = actPos();
  float e = actTarget - pos;
  if (fabs(e) < ACT_DEADBAND_MM || now < actRestUntil) { motorWrite(motors[${steer.key}_IDX], 0); actCheckAt = now; actCheckPos = pos; return; }
  if (now - actCheckAt > ACT_STALL_MS) {
    if (fabs(pos - actCheckPos) < 0.3f) { actRestUntil = now + 2000; Serial.println(F("Steering actuator stalled: resting 2 s")); }
    actCheckAt = now; actCheckPos = pos;
  }
  int p = constrain((int)(fabs(e) * ACT_KP), ACT_PWM_MIN, 255);
  motorWrite(motors[${steer.key}_IDX], e > 0 ? p : -p);
}
bool steering() { return ${steer.key}_FB >= 0 && fabs(actTarget - actPos()) > 1.0f; }
// Hinge angle to actuator stroke: the actuator (or a cam slot it moves) pushes a point
// STEER_ARM_MM from the hinge pin sideways by STEER_SLOPE mm per mm of stroke.
void steerTo(float deg) {
  deg = constrain(deg, -STEER_MAX_DEG, STEER_MAX_DEG);
  actTarget = constrain(ACT_MID_MM + STEER_ARM_MM * tan(deg * STEER_SIGN * DEG_TO_RAD) / STEER_SLOPE, 1.0f, ACT_STROKE_MM - 1.0f);
}
// Drive to each end and record the potentiometer readings.
void actCalibrate() {
  Motor &m = motors[${steer.key}_IDX];
  unsigned long runMs = (unsigned long)(ACT_STROKE_MM / 2.0f * 1000) + 3000;
  Serial.println(F("Retracting fully..."));
  motorWrite(m, -255); delay(runMs); motorWrite(m, 0); delay(200);
  int lo = analogRead(${steer.key}_FB);
  Serial.println(F("Extending fully..."));
  motorWrite(m, 255); delay(runMs); motorWrite(m, 0); delay(200);
  int hi = analogRead(${steer.key}_FB);
  if (abs(hi - lo) < 50) { Serial.println(F("The reading barely changed: check the FB wiring.")); return; }
  actAdcMin = lo; actAdcMax = hi;
  Serial.print(F("Set ACT_ADC_MIN ")); Serial.print(lo); Serial.print(F(" and ACT_ADC_MAX ")); Serial.print(hi); Serial.println(F(" in config.h"));
  actTarget = ACT_MID_MM;
}`);
  } else if (steerServo) {
    L.push(`Servo steerServo;
void actService() {}
bool steering() { return false; }
void steerTo(float deg) {
  deg = constrain(deg, -STEER_MAX_DEG, STEER_MAX_DEG);
  steerServo.writeMicroseconds(SERVO_MID_US + (int)(deg * STEER_SIGN * SERVO_US_PER_DEG));
}
void actCalibrate() { Serial.println(F("Servo steering: nothing to calibrate. Set SERVO_MID_US so the hinge is straight.")); }`);
  } else {
    L.push("void actService() {}", "bool steering() { return false; }", "void steerTo(float) {}", "void actCalibrate() { Serial.println(F(\"No steering actuator in the wiring.\")); }");
  }
  const otherServos = servos.filter((s) => s !== steerServo);
  if (otherServos.length) {
    L.push(`Servo servos[${otherServos.length}];`);
    L.push(`const int16_t servoPins[${otherServos.length}] = { ${otherServos.map((s) => `${s.key}_SIG`).join(", ")} };`);
  }
  L.push("");

  // battery
  L.push("// ---------------- battery ----------------");
  L.push("float vbat = -1;");
  if (a.vsense) {
    L.push("float readBattery() { return analogRead(VBAT_SENSE) * (ADC_REF_V / ADC_MAX) * VBAT_RATIO; }");
  } else L.push("float readBattery() { return -1; }  // no voltage sensor in the wiring");
  L.push("bool batteryLow() {");
  L.push("#if defined(LOW_BATTERY_V)");
  L.push("  return vbat > 1 && vbat < LOW_BATTERY_V;");
  L.push("#else");
  L.push("  return false;");
  L.push("#endif");
  L.push("}", "");

  // state
  L.push("// ---------------- state ----------------");
  L.push("enum State : uint8_t { WAITING, DIGGING, BACKING, RETREAT, DONE, FAULT, BENCH };");
  L.push('const char *stateName[] = { "waiting", "digging", "backing off", "backing out", "done", "fault", "bench" };');
  L.push(`State state = ${a.tunneller ? "WAITING" : "BENCH"};`);
  L.push('const char *reason = "";');
  L.push("unsigned long t0, stateSince, stallSince, quietSince, rollSince, lastLog, testUntil, digMs, refAt, lowSince, coolSince, pausedMs;");
  L.push("float distance = 0, targetYaw = 0, headingI = 0, digAmps = 0, lastProgress = 0;");
  L.push("uint8_t retries = 0;");
  L.push("bool stopped = false;");
  L.push("long encAtStart = 0;");
  L.push("void stopAll();");
  L.push("void setState(State s, const char *why) {");
  L.push("  state = s; reason = why; stateSince = millis();");
  L.push("  if (s == DONE || s == FAULT) stopAll();");
  L.push('  Serial.print(F("state: ")); Serial.print(stateName[s]); if (why[0]) { Serial.print(F(" (")); Serial.print(why); Serial.print(F(")")); } Serial.println();');
  L.push("}", "");

  // log
  L.push(`// ---------------- run log (EEPROM, survives power off) ----------------
struct LogRec { uint16_t t; int16_t distMm; int8_t yaw, roll, pitch; uint8_t ampsX10, vbatX10, st; };
#if HAVE_LOG
const uint16_t LOG_BASE = 4;
uint16_t logCount() { uint16_t n; EEPROM.get(2, n); return EEPROM.read(0) == 0x4B && EEPROM.read(1) == 0x46 ? n : 0; }
void logClear() { EEPROM.update(0, 0x4B); EEPROM.update(1, 0x46); uint16_t z = 0; EEPROM.put(2, z); }
void logWrite(const LogRec &r) {
  uint16_t n = logCount();
  if (LOG_BASE + (n + 1) * sizeof(LogRec) > EEPROM.length()) return;   // full: keep the start of the run
  EEPROM.put(LOG_BASE + n * sizeof(LogRec), r);
  n++; EEPROM.put(2, n);
}
void logDump() {
  uint16_t n = logCount();
  Serial.println(F("t_s,distance_mm,yaw_deg,roll_deg,pitch_deg,amps,vbat,state"));
  for (uint16_t i = 0; i < n; i++) {
    LogRec r; EEPROM.get(LOG_BASE + i * sizeof(LogRec), r);
    Serial.print(r.t); Serial.print(','); Serial.print(r.distMm); Serial.print(','); Serial.print(r.yaw); Serial.print(',');
    Serial.print(r.roll); Serial.print(','); Serial.print(r.pitch); Serial.print(','); Serial.print(r.ampsX10 / 10.0f, 1); Serial.print(',');
    Serial.print(r.vbatX10 / 10.0f, 1); Serial.print(','); Serial.println(stateName[r.st < 7 ? r.st : 5]);
  }
}
#else
void logClear() {}
void logWrite(const LogRec &) {}
void logDump() { Serial.println(F("No EEPROM log on this board: watch the serial output instead.")); }
#endif
`);

  const fe = front ? encs.indexOf(front) : -1;
  L.push(`// The run starts only with the motor battery connected, so plugging in USB to read the log never starts the motors.
bool batteryPresent() {
#if defined(LOW_BATTERY_V)
  return vbat < 0 || vbat > LOW_BATTERY_V;
#else
  return true;
#endif
}
void startRun(const char *why) {
  t0 = millis(); targetYaw = yaw; headingI = 0; distance = 0; lastProgress = 0; retries = 0; digAmps = 0; rollSince = 0; quietSince = 0;
  refAt = 0; lowSince = 0; coolSince = 0; pausedMs = 0;
  encAtStart = ${fe >= 0 ? `encRead(${fe})` : "0"};
  logClear();
  setState(${a.tunneller ? "DIGGING" : "BENCH"}, why);
}`);
  // amps helper
  L.push("float maxAmps() { float a = -1; for (uint8_t i = 0; i < N_MOTORS; i++) if (motors[i].amps > a) a = motors[i].amps; return a; }");
  if (a.tunneller)
    L.push(`// Motor heating, one lump per motor: I²R in (the winding's resistance grows as it warms), the rise over
// the thermal resistance out. An estimate from the current, not a measurement.
void heatUpdate(Motor &m, float dt) {
  if (m.rOhm <= 0 || m.amps < 0) return;
  float p = m.amps * m.amps * m.rOhm * (1 + 0.0039f * m.heat);
  m.heat += dt * (p - m.heat * MOTOR_COOLING / m.rthKW) / m.heatJK;
  if (m.heat < 0) m.heat = 0;
}
float hottest() { float h = 0; for (uint8_t i = 0; i < N_MOTORS; i++) if (motors[i].heat > h) h = motors[i].heat; return h; }`);
  L.push(`void logNow() {
  LogRec r;
  r.t = (uint16_t)((millis() - t0) / 1000); r.distMm = (int16_t)distance;
  r.yaw = (int8_t)constrain(wrap180(yaw - targetYaw), -127, 127); r.roll = (int8_t)constrain(roll, -127, 127); r.pitch = (int8_t)constrain(pitch, -127, 127);
  r.ampsX10 = (uint8_t)constrain(maxAmps() * 10, 0, 255); r.vbatX10 = (uint8_t)constrain(vbat * 10, 0, 255); r.st = state;
  logWrite(r);
}`);
  L.push("");

  // status print
  L.push(`void printStatus() {
  Serial.print(F("state ")); Serial.print(stateName[state]);
  Serial.print(F("  dist ")); Serial.print(distance, 0); Serial.print(F(" mm"));
  Serial.print(F("  yaw ")); Serial.print(yaw, 1); Serial.print(F("  roll ")); Serial.print(roll, 1); Serial.print(F("  pitch ")); Serial.print(pitch, 1);
  for (uint8_t i = 0; i < N_MOTORS; i++) { Serial.print(F("  ")); Serial.print(motors[i].name); Serial.print(F(" ")); Serial.print(motors[i].cmd); if (motors[i].amps >= 0) { Serial.print(F("/")); Serial.print(motors[i].amps, 1); Serial.print(F("A")); } if (motors[i].heat >= 1) { Serial.print(F(" +")); Serial.print(motors[i].heat, 0); Serial.print(F("K")); } }
  for (uint8_t i = 0; i < N_ENC; i++) { Serial.print(F("  rpm")); Serial.print(i); Serial.print(F(" ")); Serial.print(encRpm[i], 1); }
  if (vbat > 0) { Serial.print(F("  battery ")); Serial.print(vbat, 2); Serial.print(F(" V")); }
  Serial.println();
}`);
  L.push("");

  // console
  L.push(`// ---------------- serial console ----------------
void help() {
  Serial.println(F("Commands:"));
  Serial.println(F("  h            this help"));
  Serial.println(F("  s            status"));
  Serial.println(F("  g            go now (skip the start delay)"));
  Serial.println(F("  x            stop everything"));
  Serial.println(F("  m <n> <pwm>  run motor n at -255..255 for 2 s"));
  Serial.println(F("  t <deg>      steer to an angle"));
  Serial.println(F("  k            calibrate the steering actuator ends"));
  Serial.println(F("  e            encoder counts"));
  Serial.println(F("  i            IMU readings for 5 s"));
  Serial.println(F("  z            zero the heading here"));
  Serial.println(F("  l            print the run log as CSV"));
  Serial.println(F("  c            clear the run log"));
  for (uint8_t i = 0; i < N_MOTORS; i++) { Serial.print(F("  motor ")); Serial.print(i); Serial.print(F(" = ")); Serial.println(motors[i].name); }
}

char line[32];
uint8_t lineLen = 0;
void command(char *s) {
  char cmd = s[0];
  char *p = s + 1;
  long a1 = strtol(p, &p, 10);
  long a2 = strtol(p, &p, 10);
  switch (cmd) {
    case 'h': help(); break;
    case 's': printStatus(); break;
    case 'g': stopped = false; if (state == WAITING || state == DONE || state == FAULT) startRun("go"); break;
    case 'x': stopped = true; stopAll(); setState(${a.tunneller ? "DONE" : "BENCH"}, "stopped from the console"); break;
    case 'm':
      if (a1 >= 0 && a1 < N_MOTORS) { motorWrite(motors[a1], a2); testUntil = millis() + 2000; }
      else Serial.println(F("No such motor"));
      break;
    case 't': steerTo(a1); break;
    case 'k': actCalibrate(); break;
    case 'e': for (uint8_t i = 0; i < N_ENC; i++) { Serial.print(F("enc")); Serial.print(i); Serial.print(F(" ")); Serial.println(encRead(i)); } break;
    case 'i': for (int n = 0; n < 25; n++) { imuRead(); Serial.print(F("yaw ")); Serial.print(yaw, 1); Serial.print(F("  roll ")); Serial.print(roll, 1); Serial.print(F("  pitch ")); Serial.println(pitch, 1); delay(200); } break;
    case 'z': targetYaw = yaw; headingI = 0; Serial.println(F("Heading zeroed")); break;
    case 'l': logDump(); break;
    case 'c': logClear(); Serial.println(F("Log cleared")); break;
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
`);

  // setup
  L.push(`// ---------------- setup and loop ----------------
void setup() {
  Serial.begin(115200);
  if (STATUS_LED >= 0) pinMode(STATUS_LED, OUTPUT);
  for (uint8_t i = 0; i < N_MOTORS; i++) motorSetup(motors[i]);
  stopAll();
  encSetup();${steerServo ? `\n  steerServo.attach(${steerServo.key}_SIG);\n  steerTo(0);` : ""}${otherServos.length ? `\n  for (uint8_t i = 0; i < ${otherServos.length}; i++) servos[i].attach(servoPins[i]);` : ""}
  imuOk = imuBegin();
  Serial.println(F("${c.designName.replace(/"/g, "'")}: ${c.fw.name} ready"));
  if (!imuOk) Serial.println(F("IMU not found${imu ? ": check SDA/SCL and power" : " (none in the wiring)"}"));
  t0 = stateSince = lastLog = millis();${steer ? "\n  actTarget = actPos();   // hold where it is until told to move" : ""}
  ${a.tunneller ? 'Serial.print(F("Starting in ")); Serial.print(START_DELAY_S); Serial.println(F(" s. Type x to cancel, g to start now."));' : "help();"}
}
`);

  const loopBody: string[] = [];
  loopBody.push(`void loop() {
  static unsigned long tFast = 0, tSlow = 0;
  unsigned long now = millis();
  console();
  if (now - tFast >= 20) {
    tFast = now;
    if (imuOk) imuRead();
    for (uint8_t i = 0; i < N_MOTORS; i++) {
      float a = readAmps(motors[i]);
      if (a < -1.5f) continue;   // PWM off-time sample: keep the last reading
      motors[i].amps = a < 0 ? -1 : (motors[i].amps < 0 ? a : motors[i].amps * 0.8f + a * 0.2f);
    }
    if (!testUntil && state != DONE && state != FAULT) actService();
  }
  if (now - tSlow >= 200) {
    encUpdate((now - tSlow) / 1000.0f);${a.tunneller ? "\n    for (uint8_t i = 0; i < N_MOTORS; i++) heatUpdate(motors[i], (now - tSlow) / 1000.0f);" : ""}
    tSlow = now;
    float v = readBattery();
    vbat = v < 0 ? -1 : (vbat < 0 ? v : vbat * 0.9f + v * 0.1f);
    if (STATUS_LED >= 0) digitalWrite(STATUS_LED, (state == DIGGING) || (state == WAITING && (now / 500) % 2) || (state == FAULT && (now / 100) % 2));
  }
  if (testUntil && now > testUntil) { testUntil = 0; stopAll(); ${steer ? `actTarget = actPos();` : ""} }`);
  if (a.tunneller) {
    const fr = front ? `${front.key}_IDX` : "0";
    const frontEnc = front ? encs.indexOf(front) : -1;
    const rr = rear ? `${rear.key}_IDX` : "-1";
    loopBody.push(`
  if (state != BENCH && state != DONE && state != FAULT) {
    if (batteryLow()) { stopAll(); setState(FAULT, "battery low"); }
    else if (driverFault()) { stopAll(); setState(FAULT, "motor driver fault"); }
    else if ((now - t0 - pausedMs - (coolSince ? now - coolSince : 0)) / 1000 > MAX_RUN_S && state != WAITING) { stopAll(); setState(DONE, "time limit"); }
  }

  switch (state) {
    case WAITING:
      if (!stopped && now - stateSince > START_DELAY_S * 1000UL) {
        if (!batteryPresent()) { if (now - stateSince > START_DELAY_S * 1000UL + 5000) { Serial.println(F("Waiting for the motor battery (USB power only?)")); stateSince = now - START_DELAY_S * 1000UL; } break; }
        startRun("start delay over");
      }
      break;

    case DIGGING: {
      // distance from screw turns, less slip
      ${frontEnc >= 0 ? `distance = (encRead(${frontEnc}) - encAtStart) / encCountsPerRev[${frontEnc}] * PITCH_MM * (1 - SLIP);` : "// no encoder on the front motor: the run ends on the time limit or at breakthrough"}
      // The turn count is only an estimate: screws turning in place in loose sand count too. With a current
      // reading on the front motor the run ends at breakthrough or the far wall; with neither by GIVE_UP_MM
      // (or GIVE_UP_S), it is probably turning in place, so it backs out on the reserve.
      float frontAmps = motors[${fr}].amps;
      if (frontAmps < 0 && distance >= RUN_DISTANCE_MM) { stopAll(); setState(DONE, "distance reached"); break; }
      if (distance >= GIVE_UP_MM || (GIVE_UP_S > 0 && (now - t0) / 1000 > GIVE_UP_S)) {
        stopAll(); delay(300); digMs = now - t0;
        setState(RETREAT, "no breakthrough: probably turning in place, backing out");
        break;
      }
      // working this hard for this long without breaking through: back out while the motors still have the margin
      if (hottest() > MOTOR_HOT_K * 0.75f) {
        stopAll(); delay(300); digMs = now - t0;
        setState(RETREAT, "motors getting hot without breaking through: backing out");
        break;
      }
      if (distance - lastProgress > 50) { lastProgress = distance; retries = 0; }

      // the screws balance each other's twist; a body that keeps rolling means one is no longer biting
      // (a quarter second over the limit; it only clears back under half of it, so a roll past 180 can't reset it)
      if (imuOk && fabs(roll) > ROLL_LIMIT_DEG) { if (!rollSince) rollSince = now; else if (now - rollSince > 250) { stopAll(); setState(FAULT, "body rolling: the screws no longer balance"); break; } }
      else if (!imuOk || fabs(roll) < ROLL_LIMIT_DEG * 0.5f) rollSince = 0;

      // heading hold: steer the hinge towards the start heading
      float err = imuOk ? wrap180(targetYaw - yaw) : 0;
      headingI = constrain(headingI + err * 0.02f, -50, 50);
      steerTo(err * HEADING_KP + headingI * HEADING_KI);

      // roll trim: counter-rotating screws cancel their torque on the body when balanced
      float trim = imuOk ? constrain(roll * ROLL_KP * ROLL_SIGN, -ROLL_TRIM_MAX, ROLL_TRIM_MAX) : 0;
      // ease the screws while the hinge is moving, so the actuator only fights the soil
      int base = (int)(POWER * 255 * (steering() ? 0.5f : 1.0f));
      motorWrite(motors[${fr}], (int)(base * (1 + trim)));
      ${rear ? `motorWrite(motors[${rr}], (int)(base * (1 - trim)));` : ""}

      // stall: current high, or the screw not turning, for STALL_MS
      float amps = maxAmps();
      bool stalled = amps > STALL_A${frontEnc >= 0 ? ` || (now - stateSince > 1500 && fabs(encRpm[${frontEnc}]) < 0.5f)` : ""};
      if (stalled) { if (!stallSince) stallSince = now; } else stallSince = 0;
      if (stallSince && now - stallSince > STALL_MS) {
        stallSince = 0;
        if (distance > RUN_DISTANCE_MM * 0.8f && retries >= 2) { stopAll(); setState(DONE, "reached the far side (stopped by the wall)"); break; }
        if (++retries > MAX_RETRIES) { stopAll(); setState(FAULT, "stuck: no progress after repeated back-offs"); break; }
        setState(BACKING, "stalled");
        break;
      }

      // breakthrough: the front screw comes out and its load drops away (the rear screw is still digging,
      // so only the front motor's current tells). Stop both: the rear screw alone would twist the body.
      // The turn count reads low when the sand slips less than SLIP, so this starts checking early.
      // The reference is a slow average (DIG_REF_S) of the front current while digging. Readings more than
      // 20 % below it are held out for up to DIG_HOLD_S, so the current falling away as the nose comes out
      // can't drag the reference down with it; a lighter load that lasts longer than that is the new normal.
      if (now - stateSince > 3000 && frontAmps > 0 && now - refAt >= 100) {
        refAt = now;
        bool low = digAmps > 0 && frontAmps < digAmps * 0.8f;
        if (!low) lowSince = 0; else if (!lowSince) lowSince = now;
        if (digAmps <= 0) digAmps = frontAmps;
        else if (!low || now - lowSince > DIG_HOLD_S * 1000UL) digAmps += (frontAmps - digAmps) * (0.1f / DIG_REF_S);
      }
      if (distance > RUN_DISTANCE_MM * 0.4f && digAmps > 0 && frontAmps >= 0 && frontAmps < digAmps * BREAK_FRAC) {
        if (!quietSince) quietSince = now;
        else if (now - quietSince > 1500) { stopAll(); setState(DONE, "broke through"); }
      } else quietSince = 0;
      break;
    }

    case RETREAT: {
      // back out the way it came, straight, for at most as long as it dug. If the motors get too hot it
      // rests until they cool, and the rest counts towards neither time limit.
      if (coolSince) {
        if (hottest() > MOTOR_HOT_K * 0.6f) break;
        stateSince += now - coolSince; pausedMs += now - coolSince; coolSince = 0;
        Serial.println(F("motors cooled: backing out again"));
      } else if (hottest() > MOTOR_HOT_K) { stopAll(); coolSince = now; Serial.println(F("motors hot: resting until they cool")); break; }
      steerTo(0);
      motorWrite(motors[${fr}], -(int)(POWER * 255));
      ${rear ? `motorWrite(motors[${rr}], -(int)(POWER * 255));` : ""}
      ${frontEnc >= 0 ? `if (encRead(${frontEnc}) <= encAtStart) { stopAll(); setState(DONE, "backed out to the start"); break; }` : ""}
      if (now - stateSince > digMs) { stopAll(); setState(FAULT, "backed out for as long as it dug: dig it out from the start wall"); break; }
      if (maxAmps() > STALL_A) { if (!stallSince) stallSince = now; } else stallSince = 0;
      if (stallSince && now - stallSince > STALL_MS * 3) { stallSince = 0; stopAll(); setState(FAULT, "stuck backing out"); }
      break;
    }

    case BACKING:
      motorWrite(motors[${fr}], -(int)(POWER * 255 * 0.7f));
      ${rear ? `motorWrite(motors[${rr}], -(int)(POWER * 255 * 0.7f));` : ""}
      if (now - stateSince > BACKOFF_MS) { stopAll(); delay(300); setState(DIGGING, "retry"); }
      break;

    case DONE:
    case FAULT:

    case BENCH:
      break;
  }
`);
  }
  loopBody.push(`  if (now - lastLog >= LOG_INTERVAL_MS) {
    lastLog = now;
    if (state == DIGGING || state == BACKING || state == RETREAT) logNow();
    if (state != BENCH && state != DONE && state != FAULT) printStatus();
  }
}`);
  L.push(loopBody.join(""));
  return L.join("\n") + "\n";
}

function arduinoReadme(a: {
  c: FwContext;
  name: string;
  outs: DriveOut[];
  servos: ServoOut[];
  imu?: MachineComponent;
  vsense: boolean;
  tunneller: boolean;
  warnings: string[];
  pinTable: ArduinoResult["pinTable"];
  isEsp32: boolean;
  steer?: DriveOut;
  front?: DriveOut;
  rear?: DriveOut;
}): string {
  const { c } = a;
  const boardMenu: Record<string, string> = {
    arduino_uno: "Arduino Uno",
    arduino_nano: "Arduino Nano (Processor: ATmega328P; clones often need \"ATmega328P (Old Bootloader)\")",
    arduino_mega: "Arduino Mega or Mega 2560",
    esp32_devkitc: "ESP32 Dev Module (install the esp32 boards package by Espressif first)",
    rpi_pico: "Raspberry Pi Pico (install the Raspberry Pi Pico/RP2040 boards package by Earle Philhower first)",
  };
  const L: string[] = [];
  L.push(`# ${c.fw.name}: firmware for ${c.designName}`, "");
  L.push(`Generated by Kerf from the design's wiring for **${c.board.name}** (${c.boardPart.name}). Every pin in \`pins.h\` comes from a wire in the design, so if you change the wiring, export again.`, "");
  L.push(a.tunneller ? "**Mode: tunneller.** After the start delay it digs forward, holds its heading with the hinge, trims roll by splitting speed between the screws, and backs off when it stalls. It stops when the front motor's load drops as the nose breaks through, or when the far wall stops it. Screw turns only estimate the distance (screws turning in place count too), so if neither happens by twice the expected distance or the give-up time, it backs out on the reserve. It also estimates each motor's heating from its current and backs out when they get warm without a breakthrough, resting on the way out if they get hot. It stops if the body rolls, and logs the run to EEPROM." : "**Mode: bench.** No autonomous behaviour: use the serial console to run each motor and read each sensor while you build and test.", "");
  if (a.warnings.length) {
    L.push("## Fix before uploading", "");
    for (const w of a.warnings) L.push(`- ${w}`);
    L.push("");
  }
  L.push("## Upload", "");
  L.push("1. Install the Arduino IDE 2 from arduino.cc. No extra libraries are needed: Wire, EEPROM and Servo come with it.");
  L.push(`2. Open \`${a.name}/${a.name}.ino\` (the folder name must match the sketch name).`);
  L.push(`3. Tools → Board: ${boardMenu[c.boardPart.id] ?? c.boardPart.name}. Pick the port.`);
  L.push("4. Upload with the motor battery **disconnected** or the drivers asleep, then open the Serial Monitor at 115200 baud.", "");
  L.push("## Pins", "", "| Signal | Controller pin | Goes to |", "|---|---|---|");
  for (const p of a.pinTable) L.push(`| ${p.signal} | ${p.pin} | ${p.wire} |`);
  L.push("");
  L.push("## Console", "", "Type a command and press Enter:", "");
  L.push("| Command | Does |", "|---|---|");
  L.push("| `h` | help |", "| `s` | status: state, distance, heading, roll, pitch, motor commands and currents, battery |", "| `g` | start now |", "| `x` | stop everything |");
  L.push("| `m <n> <pwm>` | run motor n at -255..255 for 2 seconds |", "| `t <deg>` | steer to an angle |", "| `k` | calibrate the steering actuator's ends |", "| `e` | encoder counts |", "| `i` | IMU readings for 5 seconds |", "| `z` | zero the heading |", "| `l` | print the run log as CSV |", "| `c` | clear the log |");
  L.push("");
  a.outs.forEach((o, i) => L.push(`Motor ${i} is **${o.label}** (${o.part.name}).`));
  L.push("");
  L.push("## Bring-up, in order", "");
  const steps = [
    "With the motor battery off, upload and check the console prints `ready`. If the IMU line says not found, fix SDA/SCL first.",
    "Battery on, everything clear of hands. `m 0 80`: the motor should turn slowly for 2 seconds. Repeat for each motor. If one turns the wrong way, flip its `_FWD` in config.h rather than swapping wires.",
    ...(a.outs.some((o) => o.encA) ? ["`e`, turn each output shaft one full turn by hand, `e` again: the count should change by about the counts per turn in config (half the maker's figure, since only channel A edges are counted). If it goes down when the motor runs forward, swap ENC_A and ENC_B in the design."] : []),
    ...(a.steer ? ["`k` runs the steering actuator to both ends and prints the potentiometer readings: copy them into config.h. Then `t 0`, `t 5`, `t -5` and check the hinge angle with a protractor."] : []),
    ...(a.imu ? ["`i` and turn the robot by hand: yaw should change by the angle you turn it, roll by the angle you twist it. `t 5` should turn the nose clockwise seen from above, the way yaw grows; if it turns it the other way, flip STEER_SIGN (or set steer_sign in the design's firmware block)."] : []),
    ...(a.vsense ? ["`s` and compare the battery voltage with a multimeter: it should agree within 0.2 V."] : []),
    ...(a.outs.some((o) => o.csDriveOnly && o.pins.cs)
      ? ["Check the current reading: run a motor against a load at part power (`m <n> 150`) and compare `s` with your bench supply's ammeter; they should agree within 10 %. Wire the driver's CS straight to its pin with no capacitor: the firmware skips the samples taken in the PWM off-time, when this driver's CS reads 0 V."]
      : []),
    ...(a.tunneller ? ["Run in a bucket of sand first with `g`: watch the currents in `s`. Set STALL_A just above the highest normal digging current.", "After a long bucket run, feel the motor cans: `s` shows each motor's estimated rise (+K). If the cans are hotter than that suggests, lower MOTOR_COOLING.", "After a run, `l` prints the log; paste it into a spreadsheet to see distance, heading and current over time."] : []),
  ];
  steps.forEach((s, i) => L.push(`${i + 1}. ${s}`));
  L.push("");
  L.push("## What is checked and what is not", "");
  L.push("- Pin numbers, PWM and interrupt pins, and logic levels are checked against the wiring by Kerf's wiring checks.");
  L.push("- The code compiles for this board in Kerf's tests with a mock Arduino core. It has not run on real hardware: the bring-up steps above are how you confirm it.");
  if (a.tunneller) L.push("- Tuning values (stall current, steering gain, slip) are starting points from the calculations, not measured: expect to adjust them after the bucket test.");
  return L.join("\n") + "\n";
}
