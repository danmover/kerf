// The jet-vane balance behaviour: firmware for a ducted fan on a two-axis
// gimbal held level by vanes in its jet, with every pin from the design's
// wiring. A 500 Hz loop reads an LSM6DSOX (one 12-byte burst of gyro and
// accelerometer), runs a complementary filter, a PD + I controller per axis in
// torque units with the fan rotor's gyroscopic coupling cancelled, and mixes
// the two torques onto the vanes in an X. Safety: the e-stop latches a fault
// (its normally-closed contact also breaks the ESC signal in hardware), the
// fan cuts past a tilt limit or when the IMU stops answering, the throttle
// ramps, and it arms only level and still. Bench tests run from the console:
// a vane sign test, a servo check, the static force test and the gyroscopic
// coupling test on the load cell, and setpoint steps while holding.
// Plain C, so the simulator runs exactly what goes on the board.

import { catalogPart } from "../catalog";
import type { MachineComponent } from "../types";
import { cFloat } from "./arduino";
import { type FwContext, type GenFile, cComment, cNum, componentsOfKind, ctrlPinFor, ident, oneLine, setting } from "./common";

export const VANE_WORDS = /\b(jet[- ]?vane|thrust[- ]?vector|vane balance|vane-balance|vectoring)/i;

export interface VaneResult {
  files: GenFile[];
  warnings: string[];
  pinTable: { signal: string; pin: string; wire: string }[];
  summary: string;
}

/** a list setting like "45, 135, 225, 315", or the default when it does not give n numbers */
function listSetting(c: FwContext, key: string, n: number, def: number[], warnings: string[]): number[] {
  const raw = c.fw.settings[key];
  if (raw === undefined) return def;
  const xs = String(raw)
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(Number);
  if (xs.length === n && xs.every(Number.isFinite)) return xs;
  warnings.push(`${key}: give ${n} numbers (like "${def.join(", ")}"); using ${def.join(", ")}.`);
  return def;
}

const pinNum = (id: string | undefined) => {
  if (!id) return -1;
  const n = Number(id);
  return Number.isInteger(n) ? n : -1;
};

export function vaneFirmware(c: FwContext): VaneResult {
  const warnings: string[] = [];
  const pinTable: VaneResult["pinTable"] = [];
  const board = c.board.name;
  const bp = c.boardPart;
  const pinOf = (comp: string, pin: string) => ctrlPinFor(c, comp, pin);
  const note = (signal: string, comp: string, pin: string) => {
    const r = pinOf(comp, pin);
    if (r) pinTable.push({ signal, pin: r.pin.label ? `${r.pin.label} (GPIO${r.pin.mcu ?? r.pin.id})` : r.pin.id, wire: `${comp}.${pin}` });
    return pinNum(r?.pin.mcu ?? r?.pin.id);
  };

  // ---- the parts, from the wiring
  const servos = componentsOfKind(c, "servo").sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const vanePins = servos.map((s, i) => note(`vane ${i + 1} servo`, s.name, "SIG"));
  const escs = componentsOfKind(c, "esc");
  const esc = escs[0];
  const escPin = esc ? note("ESC signal", esc.name, "SIG") : -1;
  if (!esc) warnings.push("No ESC in the design: the fan never runs.");
  else if (escPin < 0) warnings.push(`${esc.name}'s signal wire reaches no ${board} pin: the fan never runs.`);
  if (servos.length !== 4) warnings.push(`The X mix drives four vanes and the design has ${servos.length} servo${servos.length === 1 ? "" : "s"}: ${servos.length < 4 ? "the missing ones are left out" : "the extra ones stay centred"}.`);
  const missing = vanePins.flatMap((p, i) => (p < 0 ? [servos[i].name] : []));
  if (missing.length) warnings.push(`${missing.join(", ")}: signal not wired to a ${board} pin.`);

  // the e-stop's normally-open contact, read on a pin with its pull-up
  let estopPin = -1;
  let estop: MachineComponent | undefined;
  for (const sw of componentsOfKind(c, "switch")) {
    const part = catalogPart(sw.catalogId)!;
    for (const p of part.pins.filter((x) => x.type === "passive" && !x.through)) {
      const n = pinNum(pinOf(sw.name, p.id)?.pin.mcu ?? pinOf(sw.name, p.id)?.pin.id);
      if (n >= 0 && estopPin < 0) {
        estopPin = note("e-stop (LOW = pressed)", sw.name, p.id);
        estop = sw;
      }
    }
  }
  if (estopPin < 0) warnings.push("No switch's normally-open contact reaches a controller pin: the firmware cannot see the e-stop (its normally-closed contact may still cut the ESC).");

  const imu = c.m.components.find((x) => catalogPart(x.catalogId)?.id === "lsm6dsox_breakout");
  const imuPart = imu ? catalogPart(imu.catalogId) : undefined;
  const imuAddr = Number(imuPart?.specs.i2c_addr ?? 0x6a);
  // the chip's axes as the design mounts it: rig axis j = sum over the chip's axes i of reading i x (axis i's component along j)
  const ax3 = imu?.axes ?? [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const imuR = [0, 1, 2].map((j) => [0, 1, 2].map((i) => Math.round(ax3[i][j] * 1e4) / 1e4));
  const turned = imuR.some((row, j) => row.some((v, i) => Math.abs(v - (i === j ? 1 : 0)) > 1e-3));
  if (!imu) warnings.push("No LSM6DSOX in the design: the loop has nothing to balance on.");
  else {
    note("IMU SDA", imu.name, "SDA");
    note("IMU SCL", imu.name, "SCL");
  }
  const hx = c.m.components.find((x) => catalogPart(x.catalogId)?.specs.iface === "hx711");
  const hxDout = hx ? note("HX711 DOUT", hx.name, "DOUT") : -1;
  const hxSck = hx ? note("HX711 SCK", hx.name, "SCK") : -1;
  if (hx && (hxDout < 0 || hxSck < 0)) warnings.push(`${hx.name}: DOUT and SCK must both reach ${board} pins for the force test.`);
  const cellComp = c.m.components.find((x) => catalogPart(x.catalogId)?.specs.iface === "bridge");
  const cellPart = cellComp ? catalogPart(cellComp.catalogId) : undefined;
  const ratedN = (Number(cellPart?.specs.capacity_g ?? 500) / 1000) * 9.80665;
  const mvPerV = Number(cellPart?.specs.rated_mv_per_v ?? 1);
  const countsPerN = (mvPerV * 1e-3 * 128 * 2 ** 24) / ratedN;
  const qtPower = Number(bp.specs.qt_power_pin ?? -1);

  // ---- settings
  const servoPart = servos[0] ? catalogPart(servos[0].catalogId) : undefined;
  const range = Number(servoPart?.specs.range_deg ?? 180);
  const usPerDeg = setting(c.fw, "servo_us_per_deg", 2000 / range);
  const phi = listSetting(c, "vane_phi", 4, [45, 135, 225, 315], warnings);
  const dir = listSetting(c, "vane_dir", 4, [1, 1, 1, 1], warnings).map((x) => (x < 0 ? -1 : 1));
  const S = {
    servoHz: setting(c.fw, "servo_hz", 333),
    vaneMax: setting(c.fw, "vane_max", 18),
    iRoll: setting(c.fw, "i_roll", 0.003),
    iPitch: setting(c.fw, "i_pitch", 0.0025),
    mDeg: setting(c.fw, "m_deg_mix_full", 0.0048),
    hFull: setting(c.fw, "h_full", 0.063),
    rotorDir: setting(c.fw, "rotor_dir", 1) < 0 ? -1 : 1,
    wn: setting(c.fw, "wn", 16),
    zeta: setting(c.fw, "zeta", 0.75),
    kiRatio: setting(c.fw, "ki_ratio", 0.15),
    gyroK: setting(c.fw, "gyro_k", 0.6),
    liftK: setting(c.fw, "lift_k", 1),
    gainScale: setting(c.fw, "gain_scale", 0.6),
    tiltCut: setting(c.fw, "tilt_cut", 20),
    armLevel: setting(c.fw, "arm_level", 5),
    ramp: setting(c.fw, "ramp_per_s", 0.4),
    loopMin: setting(c.fw, "loop_min_thrust", 0.25),
    cellLever: setting(c.fw, "cell_lever_mm", 69.2) / 1000,
  };
  const name = ident(c.fw.name).toLowerCase() || "jet_vane";
  const dir0 = `firmware/${name}`;
  const nV = Math.min(4, servos.length);
  const vPin = (i: number) => (i < nV && vanePins[i] >= 0 ? vanePins[i] : -1);

  const config = `// ${cComment(c.designName)}: pins, rig numbers and controller settings for ${cComment(c.fw.name)}.
// Generated by Kerf from the design's wiring and its firmware block. Scenarios change the #defines.
#pragma once
#include <Arduino.h>

// ---- pins (${cComment(bp.name)}), from the wiring
#define PIN_VANE_1 ${vPin(0)}
#define PIN_VANE_2 ${vPin(1)}
#define PIN_VANE_3 ${vPin(2)}
#define PIN_VANE_4 ${vPin(3)}
#define PIN_ESC ${escPin}
#define PIN_ESTOP ${estopPin}
#define PIN_HX_DOUT ${hxDout}
#define PIN_HX_SCK ${hxSck}
#define PIN_I2C_POWER ${qtPower}
#define PIN_LED ${pinNum(String(Number(bp.specs.led_builtin ?? 13)))}
#define IMU_ADDR 0x${imuAddr.toString(16).toUpperCase()}
// the chip's axes to the rig's (X, Y, Z) as the design mounts the board${turned ? "" : " (flat, its X along the rig's X)"}: rig = IMU_R x chip
#define IMU_R { ${imuR.map((r) => `{ ${r.map((v) => cFloat(v)).join(", ")} }`).join(", ")} }

// ---- vane servos${servoPart ? ` (${cComment(servoPart.name)})` : ""}
#define SERVO_HZ ${S.servoHz}
#define SERVO_US_PER_DEG ${cFloat(usPerDeg)}
#define SERVO_CENTER_US 1500
#define SERVO_MIN_US 900
#define SERVO_MAX_US 2100
#define VANE_MAX_DEG ${cFloat(S.vaneMax)}
// each vane's hinge direction from +X (degrees), and which way its servo turns it (+1 or -1); check with "sign"
static const float VANE_PHI_DEG[4] = {${phi.map(cFloat).join(", ")}};
static const int VANE_DIR[4] = {${dir.join(", ")}};

// ---- ESC${esc ? ` (${cComment(catalogPart(esc.catalogId)?.name ?? esc.name)})` : ""}
#define ESC_HZ 50
#define ESC_MIN_US 1000
#define ESC_MAX_US 2000
// the ESC arms after its signal sits at minimum this long from power-up; "arm" waits for it
#define ESC_ARM_MS 2500
#define THRUST_RAMP_PER_S ${cFloat(S.ramp)}
#define THRUST_LOOP_MIN ${cFloat(S.loopMin)}

// ---- the rig (from the design)
#define I_ROLL ${cFloat(S.iRoll)}
#define I_PITCH ${cFloat(S.iPitch)}
// moment per degree of mixed vane command at full thrust, N m, and the rotor's angular momentum at full thrust, N m s
#define M_DEG_MIX_FULL ${cFloat(S.mDeg)}
#define H_FULL ${cFloat(S.hFull)}
// +1 when the rotor turns anticlockwise seen from the intake; the coupling test checks it
#define ROTOR_DIR ${S.rotorDir}

// ---- controller
#define WN ${cFloat(S.wn)}
#define ZETA ${cFloat(S.zeta)}
#define KI_RATIO ${cFloat(S.kiRatio)}
#define GYRO_K ${cFloat(S.gyroK)}
// measured vane moment / predicted, from the static force test
#define LIFT_K ${cFloat(S.liftK)}
// first runs at a share of the full gains; raise to 1.0 after the force test
#define GAIN_SCALE ${cFloat(S.gainScale)}
#define D_FILTER_HZ 80.0f
#define COMP_TAU_S 0.5f
#define I_TORQUE_MAX 0.02f

// ---- safety
#define TILT_CUT_DEG ${cFloat(S.tiltCut)}
#define ARM_LEVEL_DEG ${cFloat(S.armLevel)}
#define ARM_STILL_DPS 5.0f
#define IMU_TIMEOUT_MS 20
#define LOOP_US 2000

// ---- load cell (force test)
#define CELL_LEVER_M ${cFloat(Math.round(S.cellLever * 1e5) / 1e5)}
// counts per newton from the cell's rating (${cNum(mvPerV)} mV/V at ${cNum(Math.round(ratedN * 100) / 100)} N, gain 128); "cal" measures yours
#define CELL_COUNTS_PER_N ${cFloat(Math.round(countsPerN))}

// ---- coupling test ("couple"): roll free, Y on the load cell link. Pitch nudges of +-COUPLE_NUDGE_DEG give
// the cell's sign, then the roll loop rocks the unit +-COUPLE_DEG at COUPLE_HZ for COUPLE_S seconds
#define COUPLE_NUDGE_DEG 4.0f
#define COUPLE_DEG 5.0f
#define COUPLE_HZ 1.0f
#define COUPLE_S 8.0f

// ---- setpoint steps ("step roll 5"): how long each step is watched, seconds
#define STEP_S 2.5f
`;

  const ino = `// ${cComment(c.designName)}: jet-vane balance firmware for the ${cComment(bp.name)}, generated by Kerf.
//
// 500 Hz loop: ${imu ? "LSM6DSOX" : "IMU"} gyro and accelerometer -> complementary filter -> PD + I per axis in torque
// units with the fan rotor's gyroscopic coupling cancelled -> X mix -> four vane servos at SERVO_HZ.
// Safety: the e-stop latches a fault (its normally-closed contact also breaks the ESC signal in hardware),
// the fan cuts past TILT_CUT_DEG or when the IMU stops answering, the throttle ramps, and it arms only
// level and still. Console: USB serial 115200, type "help".
//
// Board: ${cComment(String(bp.specs.fqbn ?? bp.name))}. Library: ESP32Servo (Kevin Harrington).
#include <Arduino.h>
#include <Wire.h>
#include <ESP32Servo.h>
#include <EEPROM.h>
#include "config.h"

#define DEG 0.01745329252f

Servo vane1;
Servo vane2;
Servo vane3;
Servo vane4;
Servo esc;

enum Mode : uint8_t { M_DISARMED, M_ARMED, M_HOLD, M_SERVO, M_SWEEP, M_COUPLE, M_FAULT };
uint8_t mode = M_DISARMED;
uint8_t shownMode = 255;
char faultText[48];

// settings that "save" keeps in flash
int centerUs[4] = {SERVO_CENTER_US, SERVO_CENTER_US, SERVO_CENTER_US, SERVO_CENTER_US};
float gainScale = GAIN_SCALE;
float liftK = LIFT_K;
float gyroK = GYRO_K;
int rotorDir = ROTOR_DIR;
long cellOffset = 0;
float cellCountsPerN = CELL_COUNTS_PER_N;

// attitude
float roll = 0, pitch = 0;
float gxf = 0, gyf = 0;
float bias[3] = {0, 0, 0};
bool estStarted = false;
uint32_t lastImuOk = 0;
int16_t lastRaw[6];
int sameCount = 0;
bool imuFound = false;

// control
float thrustTarget = 0;
float thrust = 0;
float vaneCmd[4] = {0, 0, 0, 0};
float manualVane[4] = {0, 0, 0, 0};
float integ[2] = {0, 0};
float ref[2] = {0, 0};
bool saturated = false;
uint32_t lastTick = 0;
uint32_t lastLog = 0;
bool logOn = false;
uint32_t overruns = 0;

// load cell
long cellRaw = 0;
float cellN = 0;
uint32_t cellSamples = 0;

// force test
float sweepDeg = 0;
uint32_t sweepAt = 0;
float sweepSum = 0;
int sweepN = 0;
float sxx = 0, sxy = 0, sx = 0, sy = 0, syy = 0;
int sn = 0;

// coupling test
uint32_t coupleAt = 0;
uint32_t coupleSeen = 0;
float gSum = 0;
int gN = 0;
float cp = 0, cm = 0;
int cpN = 0, cmN = 0;

// setpoint step
int stepAxis = -1;
float stepDeg = 0, stepY0 = 0, stepPeak = 0;
float stepT10 = -1, stepT90 = -1, stepSettle = 0;
uint32_t stepAt = 0;
bool stepLogWas = false;

// console
char line[48];
uint8_t lineLen = 0;

// ---------------------------------------------------------------- IMU (LSM6DSOX registers)
bool imuWrite(uint8_t reg, uint8_t v) {
  Wire.beginTransmission(IMU_ADDR);
  Wire.write(reg);
  Wire.write(v);
  return Wire.endTransmission() == 0;
}

bool imuRead(uint8_t reg, uint8_t *buf, uint8_t n) {
  Wire.beginTransmission(IMU_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(IMU_ADDR, n) != n) return false;
  for (uint8_t i = 0; i < n; i++) buf[i] = Wire.read();
  return true;
}

bool imuBegin() {
  uint8_t who = 0;
  if (!imuRead(0x0F, &who, 1) || who != 0x6C) return false;
  imuWrite(0x12, 0x01);     // software reset
  delay(20);
  bool ok = imuWrite(0x12, 0x44);   // block data update, address auto-increment
  ok = ok && imuWrite(0x10, 0x8A);  // accel 1.66 kHz, +-4 g, LPF2 on
  ok = ok && imuWrite(0x17, 0x60);  // accel LPF2 at ODR/45: tilt only, fan vibration out
  ok = ok && imuWrite(0x11, 0x88);  // gyro 1.66 kHz, +-1000 dps
  ok = ok && imuWrite(0x13, 0x02);  // gyro LPF1 on
  return ok;
}

// rates in rad/s and specific force in g, in the rig's axes (IMU_R turns the chip's axes as it is mounted)
const float imuR[3][3] = IMU_R;
bool imuSample(float *g, float *a) {
  uint8_t b[12];
  if (!imuRead(0x22, b, 12)) return false;
  int16_t raw[6];
  bool same = true;
  for (uint8_t i = 0; i < 6; i++) {
    raw[i] = (int16_t)(b[2 * i] | (b[2 * i + 1] << 8));
    if (raw[i] != lastRaw[i]) same = false;
    lastRaw[i] = raw[i];
  }
  sameCount = same ? sameCount + 1 : 0;
  float gc[3], ac[3];
  for (uint8_t i = 0; i < 3; i++) {
    gc[i] = raw[i] * (0.035f * DEG);
    ac[i] = raw[i + 3] * 0.000122f;
  }
  for (uint8_t j = 0; j < 3; j++) {
    g[j] = imuR[j][0] * gc[0] + imuR[j][1] * gc[1] + imuR[j][2] * gc[2];
    a[j] = imuR[j][0] * ac[0] + imuR[j][1] * ac[1] + imuR[j][2] * ac[2];
  }
  return sameCount < 50;
}

void calibrateGyro() {
  float s[3] = {0, 0, 0};
  int n = 0;
  for (int k = 0; k < 250; k++) {
    float g[3], a[3];
    if (imuSample(g, a)) {
      for (int i = 0; i < 3; i++) s[i] += g[i];
      n++;
    }
    delay(2);
  }
  for (int i = 0; i < 3; i++) bias[i] = n ? s[i] / n : 0;
}

// ---------------------------------------------------------------- HX711
bool cellReady() { return PIN_HX_DOUT >= 0 && digitalRead(PIN_HX_DOUT) == LOW; }

long cellRead() {
  long v = 0;
  for (int i = 0; i < 24; i++) {
    digitalWrite(PIN_HX_SCK, HIGH);
    delayMicroseconds(1);
    v = (v << 1) | digitalRead(PIN_HX_DOUT);
    digitalWrite(PIN_HX_SCK, LOW);
    delayMicroseconds(1);
  }
  // a 25th pulse: channel A, gain 128 for the next sample
  digitalWrite(PIN_HX_SCK, HIGH);
  delayMicroseconds(1);
  digitalWrite(PIN_HX_SCK, LOW);
  if (v & 0x800000L) v -= 0x1000000L;
  return v;
}

// ---------------------------------------------------------------- outputs
void servoUs(int i, int us) {
  if (i == 0) vane1.writeMicroseconds(us);
  if (i == 1) vane2.writeMicroseconds(us);
  if (i == 2) vane3.writeMicroseconds(us);
  if (i == 3) vane4.writeMicroseconds(us);
}

void writeVanes(float *v) {
  for (int i = 0; i < 4; i++) {
    float a = constrain(v[i], -VANE_MAX_DEG, VANE_MAX_DEG);
    vaneCmd[i] = a;
    float us = centerUs[i] + VANE_DIR[i] * a * SERVO_US_PER_DEG;
    servoUs(i, (int)constrain(us, (float)SERVO_MIN_US, (float)SERVO_MAX_US));
  }
}

// static thrust goes with fan speed squared and speed with throttle, so the throttle is sqrt(thrust)
void writeEsc(float frac) {
  float u = frac <= 0 ? 0 : sqrt(frac);
  esc.writeMicroseconds(ESC_MIN_US + (int)(u * (ESC_MAX_US - ESC_MIN_US)));
}

void centre() {
  float z[4] = {0, 0, 0, 0};
  writeVanes(z);
}

// ---------------------------------------------------------------- states
void say(const char *what) {
  Serial.print("state: ");
  Serial.println(what);
}

void fault(const char *why) {
  if (mode != M_FAULT) {
    strncpy(faultText, why, sizeof(faultText) - 1);
    faultText[sizeof(faultText) - 1] = 0;
    Serial.print("FAULT: ");
    Serial.print(why);
    Serial.println(". Fan off, vanes centred. Fix it, release the e-stop, then reset.");
  }
  mode = M_FAULT;
  thrustTarget = 0;
  thrust = 0;
  writeEsc(0);
  centre();
}

void showMode() {
  if (mode == shownMode) return;
  shownMode = mode;
  if (mode == M_DISARMED) say("disarmed");
  else if (mode == M_ARMED) say("armed");
  else if (mode == M_HOLD) say("holding level");
  else if (mode == M_SERVO) say("servo test");
  else if (mode == M_SWEEP) say("force test");
  else if (mode == M_COUPLE) say("coupling test");
  else {
    Serial.print("state: fault (");
    Serial.print(faultText);
    Serial.println(")");
  }
}

bool estopPressed() { return PIN_ESTOP >= 0 && digitalRead(PIN_ESTOP) == LOW; }

// ---------------------------------------------------------------- the controller
// X mix: vane i (hinge at phi_i) makes roll moment ~cos(phi) and pitch moment ~sin(phi) per degree, so
// delta_i = (tx cos + ty sin) / m_deg gives (tx, ty) with no yaw. Past VANE_MAX_DEG all four scale down
// together so the moment keeps its direction.
bool mixVanes(float tx, float ty, float mDeg, float *v) {
  float worst = 0;
  for (int i = 0; i < 4; i++) {
    float ph = VANE_PHI_DEG[i] * DEG;
    v[i] = (tx * cos(ph) + ty * sin(ph)) / mDeg;
    if (fabs(v[i]) > worst) worst = fabs(v[i]);
  }
  if (worst <= VANE_MAX_DEG) return false;
  for (int i = 0; i < 4; i++) v[i] *= VANE_MAX_DEG / worst;
  return true;
}

void control(float gx, float gy, float dt, float *v) {
  float I[2] = {I_ROLL, I_PITCH};
  float est[2] = {roll, pitch};
  float rate[2] = {gxf, gyf};
  float t[2];
  float err[2];
  for (int i = 0; i < 2; i++) {
    float kp = I[i] * WN * WN * gainScale;
    float kd = 2 * ZETA * WN * I[i] * gainScale;
    float ki = kp * WN * KI_RATIO;
    err[i] = ref[i] - est[i];
    t[i] = kp * err[i] - kd * rate[i] + ki * integ[i];
  }
  // the rotor's momentum along +Z pushes back with (-H wy, +H wx): add the opposite
  float H = rotorDir * H_FULL * sqrt(thrust > 0 ? thrust : 0) * gyroK;
  t[0] += H * gy;
  t[1] -= H * gx;
  float th = thrust < 0.3f ? 0.3f : thrust;
  saturated = mixVanes(t[0], t[1], M_DEG_MIX_FULL * liftK * th, v);
  if (saturated) return;
  for (int i = 0; i < 2; i++) {
    float kp = I[i] * WN * WN * gainScale;
    float ki = kp * WN * KI_RATIO;
    integ[i] += err[i] * dt;
    float lim = ki > 1e-9f ? I_TORQUE_MAX / ki : 0;
    integ[i] = constrain(integ[i], -lim, lim);
  }
}

// ---------------------------------------------------------------- the force test
// Roll locked, the load cell link fitted: vane pitch commands from -12 to +12 deg in 3 deg steps, 1.5 s
// each, the cell averaged over the last 0.5 s. Moment = force x lever; slope against the prediction.
void sweepStep(uint32_t now) {
  float ty = 0;
  float v[4];
  float mDeg = M_DEG_MIX_FULL * liftK * (thrust < 0.3f ? 0.3f : thrust);
  ty = sweepDeg * mDeg;
  mixVanes(0, ty, mDeg, v);
  writeVanes(v);
  uint32_t into = now - sweepAt;
  if (into > 1000 && cellSamples) {
    sweepSum += cellN;
    sweepN++;
  }
  if (into < 1500) return;
  float f = sweepN ? sweepSum / sweepN : 0;
  float m = f * CELL_LEVER_M;
  Serial.print("sweep ");
  Serial.print(sweepDeg, 0);
  Serial.print(" deg: ");
  Serial.print(f, 3);
  Serial.print(" N, ");
  Serial.print(m * 1000, 2);
  Serial.println(" mN m");
  sx += sweepDeg;
  sy += m;
  sxx += sweepDeg * sweepDeg;
  sxy += sweepDeg * m;
  sn++;
  sweepSum = 0;
  sweepN = 0;
  sweepAt = now;
  sweepDeg += 3;
  if (sweepDeg <= 12.5f) return;
  float slope = (sn * sxy - sx * sy) / (sn * sxx - sx * sx);
  float predicted = M_DEG_MIX_FULL * liftK * thrust;
  Serial.print("vane moment: ");
  Serial.print(slope * 1000, 3);
  Serial.print(" mN m per deg, predicted ");
  Serial.print(predicted * 1000, 3);
  Serial.print(": set LIFT_K to ");
  Serial.println(predicted > 0 ? liftK * fabs(slope) / predicted : 0, 2);
  mode = M_ARMED;
  centre();
}

// ---------------------------------------------------------------- the coupling test
// Roll free, Y on the load cell link: the cell holds pitch and feels the rotor's gyroscopic push as the unit
// rolls. First the pitch vanes at +COUPLE_NUDGE_DEG, then minus it (roll held level), give the cell's sign;
// then the roll loop rocks the unit +-COUPLE_DEG at COUPLE_HZ while the cell's pitch moment is fitted against
// the roll rate, each sample against the rate averaged over its conversion. The slope is the rotor's momentum.
void coupleEnd() {
  ref[0] = 0;
  integ[0] = 0;
  thrustTarget = 0;
  mode = M_ARMED;
  centre();
  float fp = cpN ? cp / cpN : 0;
  float fm = cmN ? cm / cmN : 0;
  Serial.print("coupling: pitch nudge +");
  Serial.print(COUPLE_NUDGE_DEG, 0);
  Serial.print(" deg reads ");
  Serial.print(fp, 3);
  Serial.print(" N, -");
  Serial.print(COUPLE_NUDGE_DEG, 0);
  Serial.print(" deg reads ");
  Serial.print(fm, 3);
  Serial.println(" N; fan back to 0");
  float den = sn * sxx - sx * sx;
  if (sn < 10 || den <= 1e-9f || fabs(fp - fm) < 0.02f) {
    Serial.println("coupling: the load cell did not follow: fit the cell link, tare, and run it at 50 % thrust or more");
    return;
  }
  int sgn = fp > fm ? 1 : -1;
  float num = sn * sxy - sx * sy;
  float H = sgn * num / den;
  float vy = sn * syy - sy * sy;
  float r2 = vy > 1e-12f ? num * num / (den * vy) : 0;
  float predicted = rotorDir * H_FULL * sqrt(thrust);
  Serial.print("rotor momentum: ");
  Serial.print(H * 1000, 1);
  Serial.print(" mN m s at ");
  Serial.print(thrust * 100, 0);
  Serial.print(" % thrust, predicted ");
  Serial.print(predicted * 1000, 1);
  Serial.print(" (fit r2 ");
  Serial.print(r2, 2);
  Serial.println(")");
  if (H * rotorDir >= 0) Serial.println("rotor direction matches ROTOR_DIR");
  else {
    Serial.print("the rotor turns the other way: rotor ");
    Serial.print(-rotorDir);
    Serial.println(", then save");
  }
  Serial.print("H_FULL from this run: ");
  Serial.println(thrust > 0 ? fabs(H) / sqrt(thrust) : 0, 4);
}

void coupleStep(uint32_t now, float dt) {
  float t = (now - coupleAt) * 0.001f;
  float tw = t - 3.0f;
  float nudge = t < 1.5f ? COUPLE_NUDGE_DEG : t < 3.0f ? -COUPLE_NUDGE_DEG : 0;
  ref[0] = tw > 0 ? COUPLE_DEG * DEG * sin(2 * PI * COUPLE_HZ * tw) : 0;
  float kp = I_ROLL * WN * WN * gainScale;
  float kd = 2 * ZETA * WN * I_ROLL * gainScale;
  float ki = kp * WN * KI_RATIO;
  float err = ref[0] - roll;
  integ[0] += err * dt;
  float lim = ki > 1e-9f ? I_TORQUE_MAX / ki : 0;
  integ[0] = constrain(integ[0], -lim, lim);
  float mDeg = M_DEG_MIX_FULL * liftK * (thrust < 0.3f ? 0.3f : thrust);
  float v[4];
  mixVanes(kp * err - kd * gxf + ki * integ[0], nudge * mDeg, mDeg, v);
  writeVanes(v);
  gSum += gxf;
  gN++;
  if (cellSamples != coupleSeen) {
    coupleSeen = cellSamples;
    float rate = gSum / gN;
    gSum = 0;
    gN = 0;
    if (t > 0.7f && t < 1.5f) {
      cp += cellN;
      cpN++;
    } else if (t > 2.2f && t < 3.0f) {
      cm += cellN;
      cmN++;
    } else if (tw > 1.0f) {
      float m = cellN * CELL_LEVER_M;
      sx += rate;
      sy += m;
      sxx += rate * rate;
      sxy += rate * m;
      syy += m * m;
      sn++;
    }
  }
  if (tw >= COUPLE_S) coupleEnd();
}

// ---------------------------------------------------------------- setpoint steps
// "step roll 5" while holding: the setpoint jumps, the log runs, and after STEP_S it prints the 10-90 % rise,
// the overshoot, when it last left the 10 % band and the error left, then the setpoint goes back.
void stepWatch(uint32_t now) {
  float y = ((stepAxis ? pitch : roll) / DEG - stepY0) / stepDeg;
  float t = (now - stepAt) * 0.001f;
  if (stepT10 < 0 && y >= 0.1f) stepT10 = t;
  if (stepT90 < 0 && y >= 0.9f) stepT90 = t;
  if (y > stepPeak) stepPeak = y;
  if (fabs(y - 1) > 0.1f) stepSettle = t;
  if (t < STEP_S) return;
  Serial.print("step ");
  Serial.print(stepAxis ? "pitch " : "roll ");
  Serial.print(stepDeg, 1);
  Serial.print(" deg: ");
  if (stepT90 < 0) Serial.print("never reached 90 %");
  else {
    Serial.print("rise ");
    Serial.print(stepT90 - stepT10, 2);
    Serial.print(" s");
  }
  Serial.print(", overshoot ");
  Serial.print(stepPeak > 1 ? (stepPeak - 1) * 100 : 0, 0);
  Serial.print(" %, ");
  if (stepSettle >= STEP_S) Serial.print("not settled");
  else {
    Serial.print("within 10 % after ");
    Serial.print(stepSettle, 2);
    Serial.print(" s");
  }
  Serial.print(", error ");
  Serial.print((1 - y) * stepDeg, 2);
  Serial.println(" deg");
  ref[stepAxis] -= stepDeg * DEG;
  logOn = stepLogWas;
  stepAxis = -1;
}

void logHeader() { Serial.println("log: roll, pitch (deg), gx, gy (deg/s), vane 1-4 (deg), thrust (%), cell (N)"); }

// ---------------------------------------------------------------- flash
void putLong(int a, long v) {
  for (int i = 0; i < 4; i++) EEPROM.write(a + i, (v >> (8 * i)) & 0xFF);
}

long getLong(int a) {
  long v = 0;
  for (int i = 0; i < 4; i++) v |= (long)EEPROM.read(a + i) << (8 * i);
  return v;
}

void saveSettings() {
  EEPROM.write(0, 0x4A);
  for (int i = 0; i < 4; i++) putLong(4 + 4 * i, centerUs[i]);
  putLong(20, (long)(gainScale * 1000));
  putLong(24, (long)(liftK * 1000));
  putLong(28, (long)(gyroK * 1000));
  putLong(32, rotorDir);
  putLong(36, cellOffset);
  putLong(40, (long)cellCountsPerN);
  EEPROM.commit();
  Serial.println("saved");
}

void loadSettings() {
  EEPROM.begin(64);
  if (EEPROM.read(0) != 0x4A) return;
  for (int i = 0; i < 4; i++) centerUs[i] = (int)getLong(4 + 4 * i);
  gainScale = getLong(20) / 1000.0f;
  liftK = getLong(24) / 1000.0f;
  gyroK = getLong(28) / 1000.0f;
  rotorDir = getLong(32) < 0 ? -1 : 1;
  cellOffset = getLong(36);
  cellCountsPerN = (float)getLong(40);
}

// ---------------------------------------------------------------- console
void help() {
  Serial.println("arm            arm (level, still, e-stop out, IMU answering)");
  Serial.println("t <percent>    thrust target, share of full static thrust");
  Serial.println("hold           close the balance loop (vanes work from 25 % thrust)");
  Serial.println("stop           fan off, vanes centred, disarmed");
  Serial.println("reset          clear a fault once the e-stop is released");
  Serial.println("servo <1-4> <deg> / servo off   move one vane, fan off");
  Serial.println("sign           each vane to +10 deg in turn: check the push matches the README");
  Serial.println("trim <1-4> <us>  a servo's centre pulse");
  Serial.println("sweep          static force test (roll locked, load cell fitted, armed at thrust)");
  Serial.println("couple         gyroscopic coupling test (roll free, Y on the load cell link, armed at thrust)");
  Serial.println("step roll|pitch <deg>  a setpoint step while holding: prints rise, overshoot, settling");
  Serial.println("tare / cal <grams>  zero the load cell / scale it with a known weight");
  Serial.println("gain <x>  liftk <x>  gyrok <x>  rotor <1|-1>  save  show");
  Serial.println("log            50 Hz log on/off: roll, pitch, gyro rates, vanes, thrust, load cell");
}

void show() {
  Serial.print("gain ");
  Serial.print(gainScale, 2);
  Serial.print(" liftk ");
  Serial.print(liftK, 2);
  Serial.print(" gyrok ");
  Serial.print(gyroK, 2);
  Serial.print(" rotor ");
  Serial.println(rotorDir);
  Serial.print("roll ");
  Serial.print(roll / DEG, 2);
  Serial.print(" pitch ");
  Serial.print(pitch / DEG, 2);
  Serial.print(" thrust ");
  Serial.print(thrust * 100, 0);
  Serial.print(" % cell ");
  Serial.print(cellN, 3);
  Serial.println(" N");
}

float arg(const char *s) {
  while (*s && *s != ' ') s++;
  return atof(s);
}

void command(const char *s, uint32_t now) {
  if (!strcmp(s, "help")) help();
  else if (!strcmp(s, "show")) show();
  else if (!strcmp(s, "log")) {
    logOn = !logOn;
    if (logOn) logHeader();
  }
  else if (!strcmp(s, "stop")) {
    thrustTarget = 0;
    thrust = 0;
    writeEsc(0);
    centre();
    if (mode != M_FAULT) mode = M_DISARMED;
  } else if (!strcmp(s, "reset")) {
    if (estopPressed()) Serial.println("release the e-stop first");
    else if (mode == M_FAULT) mode = M_DISARMED;
  } else if (!strcmp(s, "arm")) {
    if (mode == M_FAULT) Serial.println("clear the fault first: reset");
    else if (estopPressed()) Serial.println("e-stop is pressed");
    else if (!imuFound || now - lastImuOk > IMU_TIMEOUT_MS) Serial.println("IMU not answering");
    else if (fabs(roll) > ARM_LEVEL_DEG * DEG || fabs(pitch) > ARM_LEVEL_DEG * DEG) Serial.println("not level: within 5 deg to arm");
    else if (fabs(gxf) > ARM_STILL_DPS * DEG || fabs(gyf) > ARM_STILL_DPS * DEG) Serial.println("not still");
    else if (now < ESC_ARM_MS) Serial.println("ESC still arming: try again in a second");
    else {
      thrustTarget = 0;
      mode = M_ARMED;
    }
  } else if (!strncmp(s, "t ", 2)) {
    if (mode == M_ARMED || mode == M_HOLD) thrustTarget = constrain(arg(s) / 100.0f, 0.0f, 1.0f);
    else Serial.println("arm first");
  } else if (!strcmp(s, "hold")) {
    if (mode == M_ARMED) {
      integ[0] = integ[1] = 0;
      ref[0] = ref[1] = 0;
      mode = M_HOLD;
    } else Serial.println("arm first");
  } else if (!strcmp(s, "sweep")) {
    if (mode != M_ARMED || thrust < THRUST_LOOP_MIN) Serial.println("arm and set a thrust first (t 70)");
    else {
      sweepDeg = -12;
      sweepAt = now;
      sweepSum = 0;
      sweepN = 0;
      sx = sy = sxx = sxy = 0;
      sn = 0;
      mode = M_SWEEP;
    }
  } else if (!strcmp(s, "couple")) {
    if (mode != M_ARMED || thrust < THRUST_LOOP_MIN) Serial.println("arm and set a thrust first (t 70)");
    else {
      coupleAt = now;
      coupleSeen = cellSamples;
      gSum = 0;
      gN = 0;
      cp = cm = 0;
      cpN = cmN = 0;
      sx = sy = sxx = sxy = syy = 0;
      sn = 0;
      integ[0] = integ[1] = 0;
      ref[0] = ref[1] = 0;
      mode = M_COUPLE;
      Serial.println("coupling test: pitch nudges for 3 s, then the roll wave");
    }
  } else if (!strncmp(s, "step ", 5)) {
    int ax = !strncmp(s + 5, "roll", 4) ? 0 : !strncmp(s + 5, "pitch", 5) ? 1 : -1;
    float d = arg(s + 5);
    if (mode != M_HOLD || thrust < THRUST_LOOP_MIN) Serial.println("hold at thrust first");
    else if (stepAxis >= 0) Serial.println("a step is running");
    else if (ax < 0 || d == 0 || fabs(d) > 10) Serial.println("step roll <deg> or step pitch <deg>, up to 10 deg");
    else {
      stepAxis = ax;
      stepDeg = d;
      stepAt = now;
      // measured from the setpoint it leaves, so a unit still settling from a knock does not skew it
      stepY0 = ref[ax] / DEG;
      stepPeak = 0;
      stepT10 = stepT90 = -1;
      stepSettle = 0;
      stepLogWas = logOn;
      if (!logOn) logHeader();
      logOn = true;
      ref[ax] += d * DEG;
    }
  } else if (!strcmp(s, "servo off")) {
    if (mode == M_SERVO) mode = M_DISARMED;
    centre();
  } else if (!strncmp(s, "servo ", 6)) {
    int i = atoi(s + 6) - 1;
    if (mode != M_DISARMED && mode != M_SERVO) Serial.println("fan off first: stop");
    else if (i < 0 || i > 3) Serial.println("servo 1 to 4");
    else {
      for (int k = 0; k < 4; k++) manualVane[k] = 0;
      manualVane[i] = arg(s + 6);
      mode = M_SERVO;
    }
  } else if (!strcmp(s, "sign")) {
    if (mode != M_DISARMED && mode != M_SERVO) Serial.println("fan off first: stop");
    else {
      for (int k = 0; k < 4; k++) manualVane[k] = 0;
      manualVane[0] = 10;
      mode = M_SERVO;
      Serial.println("vane 1 at +10 deg; servo 2 10, servo 3 10, servo 4 10 for the others, servo off to finish");
    }
  } else if (!strncmp(s, "trim ", 5)) {
    int i = atoi(s + 5) - 1;
    if (i >= 0 && i < 4) centerUs[i] = (int)constrain(arg(s + 5), 1300.0f, 1700.0f);
  } else if (!strcmp(s, "tare")) {
    cellOffset = cellRaw;
  } else if (!strncmp(s, "cal ", 4)) {
    float grams = atof(s + 4);
    if (grams > 0 && cellRaw != cellOffset) cellCountsPerN = fabs((cellRaw - cellOffset) / (grams * 0.00980665f));
  } else if (!strncmp(s, "gain ", 5)) gainScale = constrain(arg(s), 0.1f, 1.5f);
  else if (!strncmp(s, "liftk ", 6)) liftK = constrain(arg(s), 0.3f, 3.0f);
  else if (!strncmp(s, "gyrok ", 6)) gyroK = constrain(arg(s), 0.0f, 1.5f);
  else if (!strncmp(s, "rotor ", 6)) rotorDir = arg(s) < 0 ? -1 : 1;
  else if (!strcmp(s, "save")) saveSettings();
  else if (s[0]) Serial.println("? type help");
}

void console(uint32_t now) {
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\\r') continue;
    if (ch == '\\n') {
      line[lineLen] = 0;
      command(line, now);
      lineLen = 0;
    } else if (lineLen < sizeof(line) - 1) line[lineLen++] = ch;
  }
}

// ---------------------------------------------------------------- setup and loop
void setup() {
  Serial.begin(115200);
  if (PIN_I2C_POWER >= 0) {
    // the STEMMA QT socket's power switch
    pinMode(PIN_I2C_POWER, OUTPUT);
    digitalWrite(PIN_I2C_POWER, HIGH);
  }
  if (PIN_ESTOP >= 0) pinMode(PIN_ESTOP, INPUT_PULLUP);
  if (PIN_HX_SCK >= 0) {
    pinMode(PIN_HX_SCK, OUTPUT);
    digitalWrite(PIN_HX_SCK, LOW);
  }
  if (PIN_HX_DOUT >= 0) pinMode(PIN_HX_DOUT, INPUT);
  pinMode(PIN_LED, OUTPUT);
  loadSettings();
  // the ESC first, at minimum, so it arms
  esc.setPeriodHertz(ESC_HZ);
  esc.attach(PIN_ESC, ESC_MIN_US, ESC_MAX_US);
  writeEsc(0);
  vane1.setPeriodHertz(SERVO_HZ);
  vane2.setPeriodHertz(SERVO_HZ);
  vane3.setPeriodHertz(SERVO_HZ);
  vane4.setPeriodHertz(SERVO_HZ);
  vane1.attach(PIN_VANE_1, SERVO_MIN_US, SERVO_MAX_US);
  vane2.attach(PIN_VANE_2, SERVO_MIN_US, SERVO_MAX_US);
  vane3.attach(PIN_VANE_3, SERVO_MIN_US, SERVO_MAX_US);
  vane4.attach(PIN_VANE_4, SERVO_MIN_US, SERVO_MAX_US);
  centre();
  Wire.begin();
  Wire.setClock(400000);
  delay(20);
  imuFound = imuBegin();
  if (!imuFound) {
    Serial.println("LSM6DSOX not found at 0x6A: check the STEMMA QT cable");
    fault("IMU not found");
  } else {
    delay(50);
    calibrateGyro();
    lastImuOk = millis();
  }
  Serial.println("jet vane balance ready: type help");
  lastTick = micros();
}

void loop() {
  uint32_t now = millis();
  console(now);
  if (cellReady()) {
    cellRaw = cellRead();
    cellN = (cellRaw - cellOffset) / cellCountsPerN;
    cellSamples++;
  }
  uint32_t us = micros();
  if ((uint32_t)(us - lastTick) < LOOP_US) return;
  float dt = (us - lastTick) * 1e-6f;
  if (dt > 0.01f) {
    dt = 0.01f;
    overruns++;
  }
  lastTick = us;

  float g[3] = {0, 0, 0};
  float a[3] = {0, 0, 1};
  if (imuFound && imuSample(g, a)) {
    float an = sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
    if (an > 0.3f && an < 3.0f) lastImuOk = now;
    for (int i = 0; i < 3; i++) g[i] -= bias[i];
    float b = exp(-2.0f * PI * D_FILTER_HZ * dt);
    gxf = b * gxf + (1 - b) * g[0];
    gyf = b * gyf + (1 - b) * g[1];
    float ra = atan2(a[1], a[2]);
    float pa = atan2(-a[0], sqrt(a[1] * a[1] + a[2] * a[2]));
    if (!estStarted) {
      roll = ra;
      pitch = pa;
      estStarted = true;
    } else {
      float k = COMP_TAU_S / (COMP_TAU_S + dt);
      roll = k * (roll + g[0] * dt) + (1 - k) * ra;
      pitch = k * (pitch + g[1] * dt) + (1 - k) * pa;
    }
  }

  // safety, every pass
  bool running = mode == M_ARMED || mode == M_HOLD || mode == M_SWEEP || mode == M_COUPLE;
  if (estopPressed() && mode != M_FAULT) fault("e-stop pressed");
  else if (running && now - lastImuOk > IMU_TIMEOUT_MS) fault("IMU stopped answering");
  else if (running && (fabs(roll) > TILT_CUT_DEG * DEG || fabs(pitch) > TILT_CUT_DEG * DEG)) fault("tilted past the cut-off");
  running = mode == M_ARMED || mode == M_HOLD || mode == M_SWEEP || mode == M_COUPLE;
  if (stepAxis >= 0 && mode != M_HOLD) {
    // a stop or a fault ends the step
    stepAxis = -1;
    logOn = stepLogWas;
  }

  // throttle: ramps up, drops at once
  if (!running) thrustTarget = 0;
  if (thrustTarget > thrust) thrust = min(thrustTarget, thrust + THRUST_RAMP_PER_S * dt);
  else thrust = thrustTarget;
  writeEsc(running ? thrust : 0);

  float v[4] = {0, 0, 0, 0};
  if (mode == M_HOLD && thrust >= THRUST_LOOP_MIN) {
    control(g[0], g[1], dt, v);
    writeVanes(v);
    if (stepAxis >= 0) stepWatch(now);
  } else if (mode == M_SWEEP) sweepStep(now);
  else if (mode == M_COUPLE) coupleStep(now, dt);
  else if (mode == M_SERVO) writeVanes(manualVane);
  else {
    integ[0] = integ[1] = 0;
    writeVanes(v);
  }
  digitalWrite(PIN_LED, running ? HIGH : LOW);
  showMode();

  if (logOn && now - lastLog >= 20) {
    lastLog = now;
    Serial.print(roll / DEG, 2);
    Serial.print(",");
    Serial.print(pitch / DEG, 2);
    Serial.print(",");
    Serial.print(gxf / DEG, 1);
    Serial.print(",");
    Serial.print(gyf / DEG, 1);
    for (int i = 0; i < 4; i++) {
      Serial.print(",");
      Serial.print(vaneCmd[i], 1);
    }
    Serial.print(",");
    Serial.print(thrust * 100, 0);
    Serial.print(",");
    Serial.println(cellN, 3);
  }
}
`;

  const wiring = pinTable.map((p) => `| ${p.signal} | ${p.pin} | ${p.wire} |`).join("\n");
  const readme = `# ${oneLine(c.designName)}: ${oneLine(c.fw.name)}

Jet-vane balance firmware for the ${oneLine(bp.name)}, generated by Kerf from the design's wiring. Everything you calibrate lives in \`config.h\` or in flash (\`save\`).

## Build

Arduino IDE 2: board **${oneLine(String(bp.specs.fqbn ?? bp.name))}** (arduino-esp32 core), library **ESP32Servo**. USB serial at 115200; type \`help\`.

## Pins

| Signal | Pin | Wire |
|---|---|---|
${wiring}

## What it does

A 500 Hz loop reads the LSM6DSOX (gyro and accelerometer in one burst), runs a complementary filter (0.5 s), and holds the fan unit level with a PD + I controller per axis in torque units: gains from the rig's inertia (I_ROLL, I_PITCH) for a ${cNum(S.wn)} rad/s, ζ ${cNum(S.zeta)} response, scaled by GAIN_SCALE (${cNum(S.gainScale)} for first runs). The fan rotor's gyroscopic push is cancelled (GYRO_K ${cNum(S.gyroK)}) and the two torques are mixed onto the four vanes in an X, all four scaled back together past ±${cNum(S.vaneMax)}°.

Safety: the e-stop's normally-closed contact breaks the ESC signal in hardware, and its normally-open contact latches a fault in the firmware; the fan also cuts past ±${cNum(S.tiltCut)}°, when the IMU stops answering for ${20} ms, or on \`stop\`. It arms only within ±${cNum(S.armLevel)}° and still, after the ESC has had its signal at minimum for ${2.5} s.

## Bench order

1. **Servos** (fan off): \`servo 1 10\` … check each vane turns +10° with the vane gauge; \`trim\` and \`save\`. SERVO_US_PER_DEG is ${cNum(Math.round(usPerDeg * 100) / 100)} µs/° from the servo's catalogue range: measure yours.
2. **Sign test** (fan off): \`sign\`, then \`servo 2 10\` and so on. Each vane at +10° should push the unit the way the design's drawing shows; flip VANE_DIR for any that do not.
3. **Static force test**: roll locked, the load cell link fitted, \`tare\`, \`arm\`, \`t 70\`, \`sweep\`. It prints the vane moment per degree and the LIFT_K to set.
4. **Coupling test**: roll free, pitch still on the load cell link, \`tare\`, \`arm\`, \`t 70\`, \`couple\`. Two pitch nudges give the cell's sign, then the vanes rock the unit ±5° in roll at 1 Hz for 8 s while the cell feels the rotor's gyroscopic push on pitch. It prints the rotor's momentum against the prediction, whether ROTOR_DIR is right (\`rotor\` and \`save\` if not) and the H_FULL it measured. The fan goes back to 0 at the end.
5. **First free run**: both axes free, \`arm\`, \`t 50\`, \`hold\`, then up to 70 %. GAIN_SCALE ${cNum(S.gainScale)} first, 1.0 after the force test.
6. **Steps**: holding, \`step roll 5\` and \`step pitch 5\` (one axis locked for a locked step test). Each prints the 10–90 % rise time, the overshoot and when it settled within 10 %, with the log running.

## Log

\`log\` prints a line every 20 ms: roll and pitch (°), the filtered gyro rates gx and gy (°/s), the four vane commands (°), thrust (% of full) and the load cell (N). Paste it into a spreadsheet to plot a run.

## Settings in flash

\`trim\`, \`gain\`, \`liftk\`, \`gyrok\`, \`rotor\` and the load cell's \`tare\`/\`cal\` are kept by \`save\` (ESP32 flash, through EEPROM).
`;
  return {
    files: [
      { path: `${dir0}/${name}.ino`, content: ino },
      { path: `${dir0}/config.h`, content: config },
      { path: `${dir0}/README.md`, content: readme },
    ],
    warnings,
    pinTable,
    summary: `ESP32 sketch for ${bp.name}: jet-vane balance at 500 Hz with gyroscopic decoupling, e-stop latch, tilt cut and IMU watchdog, plus servo, sign, force, coupling and step tests${estop ? "" : " (no e-stop wired)"}`,
  };
}
