// The quadruped behaviour: firmware for a four-legged robot on twelve CAN actuators in MIT mode (CubeMars AK series),
// on a Teensy 4.1 with FlexCAN_T4, with every pin, CAN port and actuator id from the design's wiring. A 500 Hz loop
// reads each actuator's answer from the last tick, the LSM6DSOX (one 12-byte burst), runs a complementary filter for
// roll and pitch and integrates the yaw rate, works out where each foot should be (stand-up from lying folded,
// standing, a trot with stride, turn and sideways steps from the command, its stance feet levelling the body from the
// IMU), turns that into joint angles with the leg's inverse kinematics and sends every actuator its position, speed,
// stiffness and damping. A computer (the Jetson) drives it with lines on USB: on, stand, trot <m/s> [<deg/s>]
// [<m/s sideways>], stop, sit, off, st, rd. Safety: the e-stop (its normally-closed contact drops the actuators'
// relay in hardware) is watched on a pin; an actuator that stops answering, runs hot or a body that tips past 45°
// puts every joint into damping only, so it folds down slowly rather than falls; it takes hold softly. Plain C, so
// the simulator runs exactly what goes on the board.

import { catalogPart } from "../catalog";
import { canBuses } from "../canBuses";
import type { MachineComponent } from "../types";
import { cFloat } from "./arduino";
import { type FwContext, type GenFile, cNum, componentsOfKind, ctrlPinFor, oneLine, setting } from "./common";

export const QUAD_WORDS = /\b(quadruped|robot dog|four[- ]legged|legged robot|trot)/i;

export interface QuadResult {
  files: GenFile[];
  warnings: string[];
  pinTable: { signal: string; pin: string; wire: string }[];
  summary: string;
}

const JOINTS = ["abad", "hip", "knee"] as const;

const pinNum = (id: string | undefined) => {
  if (!id) return -1;
  const n = Number(id);
  return Number.isInteger(n) ? n : -1;
};

export function quadrupedFirmware(c: FwContext): QuadResult {
  const warnings: string[] = [];
  const pinTable: QuadResult["pinTable"] = [];
  const bp = c.boardPart;
  const pinOf = (comp: string, pin: string) => ctrlPinFor(c, comp, pin);
  const note = (signal: string, comp: string, pin: string) => {
    const r = pinOf(comp, pin);
    if (r) pinTable.push({ signal, pin: r.pin.label ? `${r.pin.label}` : r.pin.id, wire: `${comp}.${pin}` });
    return pinNum(r?.pin.mcu ?? r?.pin.id);
  };

  // ---- the legs: actuators named <leg>_abad, <leg>_hip, <leg>_knee
  const legNames = setting(c.fw, "legs", "fl, fr, rl, rr")
    .split(/[,\s]+/)
    .filter(Boolean)
    .slice(0, 4);
  const comps = new Map(c.m.components.map((m) => [m.name, m]));
  const buses = canBuses(c.m);
  const busOf = new Map<string, { port: number; id: number }>();
  // each transceiver's CAN port, from the controller pins its CAN_TX and CAN_RX reach
  const PORT_PINS: Record<string, number> = { "22/23": 1, "1/0": 2, "31/30": 3 };
  const ports: number[] = [];
  for (const b of buses) {
    const tx = note(`CAN TX to ${b.transceiver}`, b.transceiver, "CAN_TX");
    const rx = note(`CAN RX from ${b.transceiver}`, b.transceiver, "CAN_RX");
    const port = PORT_PINS[`${tx}/${rx}`] ?? 0;
    if (!port) warnings.push(`${b.transceiver}: its CAN_TX and CAN_RX must go to one CAN port of the ${bp.name} (CAN1 pins 22 and 23, CAN2 pins 1 and 0, CAN3 pins 31 and 30); it is on ${tx < 0 ? "nothing" : `pin ${tx}`} and ${rx < 0 ? "nothing" : `pin ${rx}`}.`);
    else if (ports.includes(port)) warnings.push(`${b.transceiver} shares CAN${port} with another transceiver: give each bus its own port.`);
    ports.push(port);
    for (const m of b.motors) busOf.set(m.comp, { port, id: m.id });
  }
  if (!buses.length) warnings.push("No CAN transceiver with actuators on its bus: the firmware has no joints to drive.");
  if (buses.length > 3) warnings.push(`The ${bp.name} has three CAN ports and the design has ${buses.length} buses: the extra ones are left out.`);

  type Leg = { name: string; ok: boolean; x: number; y: number; z: number; ids: number[]; ports: number[]; sgn: number[]; comps: (MachineComponent | undefined)[] };
  const legs: Leg[] = legNames.map((ln) => {
    const cs = JOINTS.map((j) => comps.get(`${ln}_${j}`));
    const missing = JOINTS.filter((_, i) => !cs[i]);
    if (missing.length) warnings.push(`Leg ${ln}: no actuator called ${missing.map((j) => `${ln}_${j}`).join(", ")}.`);
    const bus = cs.map((m) => (m ? busOf.get(m.name) : undefined));
    cs.forEach((m, i) => {
      if (m && !bus[i]) warnings.push(`${m.name} is not on a CAN bus behind a transceiver: wire its CAN_H and CAN_L to one.`);
    });
    // each actuator turns its joint about its own output axis (its local +Z): the sign that axis has along the leg's
    const ax = (m: MachineComponent | undefined, k: number) => {
      const z = m?.axes?.[2];
      return z ? (z[k] >= 0 ? 1 : -1) : 1;
    };
    const hip = cs[1];
    const abad = cs[0];
    const at = hip?.at ?? [0, 0, 0];
    return {
      name: ln,
      ok: !missing.length && bus.every(Boolean),
      x: at[0],
      y: abad?.at?.[1] ?? at[1],
      z: abad?.at?.[2] ?? at[2],
      ids: bus.map((b) => b?.id ?? 0),
      ports: bus.map((b) => b?.port ?? 0),
      sgn: [ax(abad, 0), ax(hip, 1), ax(cs[2], 1)],
      comps: cs,
    };
  });
  for (const l of legs) for (let i = 0; i < 3; i++) if (l.comps[i]) pinTable.push({ signal: `${l.name} ${JOINTS[i]} actuator`, pin: `CAN${l.ports[i] || "?"} id ${l.ids[i]}`, wire: `${l.comps[i]!.name}.CAN_H/CAN_L` });
  const actPart = legs.flatMap((l) => l.comps).find(Boolean);
  const ap = actPart ? catalogPart(actPart.catalogId) : undefined;
  const P_MAX = Number(ap?.specs.p_max_rad ?? 12.5);
  const V_MAX = Number(ap?.specs.v_max_rad_s ?? 50);
  const T_MAX = Number(ap?.specs.t_max_nm ?? 25);
  const KP_MAX = Number(ap?.specs.kp_max ?? 500);
  const KD_MAX = Number(ap?.specs.kd_max ?? 5);

  // ---- the e-stop's normally-open contact, the IMU, the status LEDs
  let estopPin = -1;
  for (const sw of componentsOfKind(c, "switch")) {
    const part = catalogPart(sw.catalogId)!;
    if (!/stop/i.test(`${sw.name} ${part.name}`)) continue;
    for (const p of part.pins.filter((x) => x.type === "passive" && !x.through)) if (estopPin < 0) estopPin = note("e-stop (LOW = pressed)", sw.name, p.id);
  }
  if (estopPin < 0) warnings.push("No e-stop contact reaches a controller pin: the firmware cannot see the e-stop (its normally-closed contact may still drop the actuators' power).");
  const imu = c.m.components.find((x) => catalogPart(x.catalogId)?.id === "lsm6dsox_breakout");
  const imuAddr = Number(catalogPart(imu?.catalogId ?? "")?.specs.i2c_addr ?? 0x6a);
  const ax3 = imu?.axes ?? [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const imuR = [0, 1, 2].map((j) => [0, 1, 2].map((i) => Math.round(ax3[i][j] * 1e4) / 1e4));
  if (!imu) warnings.push("No LSM6DSOX in the design: it walks without levelling or holding its heading.");
  else {
    note("IMU SDA", imu.name, "SDA");
    note("IMU SCL", imu.name, "SCL");
  }
  // NeoPixels: straight from a pin, or through a level translator's A side
  const ledComp = c.m.components.find((x) => catalogPart(x.catalogId)?.kind === "led" || /neopixel|ws2812/i.test(catalogPart(x.catalogId)?.name ?? ""));
  const ledPart = ledComp ? catalogPart(ledComp.catalogId) : undefined;
  let ledPin = ledComp ? note("status LEDs data", ledComp.name, "DIN") : -1;
  if (ledComp && ledPin < 0) {
    const din = c.nl.netOf.get(`${ledComp.name}[0].DIN`);
    const b = din?.pins.find((p) => /^B\d$/.test(p.pin.id) && p.mc.name !== ledComp.name);
    if (b) ledPin = note("status LEDs data (through the level translator)", b.mc.name, `A${b.pin.id.slice(1)}`);
  }
  const nLeds = Number(ledPart?.specs.count ?? ledPart?.specs.leds ?? 8);

  // ---- geometry and gait, mm and seconds in the settings
  const L1 = setting(c.fw, "thigh", 210) / 1000;
  const L2 = setting(c.fw, "shank", 210) / 1000;
  const footR = setting(c.fw, "foot_r", 21) / 1000;
  const standH = setting(c.fw, "stand", 320) / 1000;
  const legY = setting(c.fw, "leg_y", 110) / 1000;
  // the crouch the stand-up rises from: the knee folded to 136° unless the block gives the hip's height there
  const crouch = setting(c.fw, "crouch", 0) / 1000;
  const period = setting(c.fw, "period", 0.36);
  const swingH = setting(c.fw, "swing", 60) / 1000;
  const vMax = setting(c.fw, "max_speed", 0.6);
  const kpStand = setting(c.fw, "kp", 180);
  const kdStand = setting(c.fw, "kd", 3);
  // the robot's mass, for the stance legs' share of its weight (kg)
  const mass = setting(c.fw, "mass", 12);
  const reach = standH - footR;
  if (reach >= L1 + L2 - 0.005) warnings.push(`stand: the legs (${cNum(L1 * 1000)} + ${cNum(L2 * 1000)} mm) cannot reach ${cNum(standH * 1000)} mm with a foot radius of ${cNum(footR * 1000)} mm.`);
  for (const l of legs) if (!l.ok) warnings.push(`Leg ${l.name} is left limp.`);
  const legY0 = legs.map((l) => (l.y >= 0 ? 1 : -1) * legY);
  const name = "quadruped";
  const dir0 = `firmware/${name}`;
  const arr = (xs: number[]) => `{ ${xs.join(", ")} }`;
  const farr = (xs: number[]) => `{ ${xs.map((v) => cFloat(v)).join(", ")} }`;
  const legLine = (f: (l: Leg) => string) => `{ ${legs.map(f).join(", ")} }`;

  const config = `// ${oneLine(c.designName)}: settings for the quadruped firmware (from the design's wiring and its firmware block)
#pragma once

#define N_LEGS ${legs.length}
#define USB_BAUD 115200
#define TICK_US 2000              // 500 Hz control loop
#define CAN_BAUD ${cNum(buses[0]?.baud ?? 1000000)}
#define ESTOP_PIN ${estopPin}
#define LED_PIN ${ledPin}
#define N_LED ${nLeds}
#define IMU_ADDR 0x${imuAddr.toString(16).toUpperCase()}
#define HAS_IMU ${imu ? 1 : 0}

// the leg: thigh and shank (hip axis to knee axis, knee axis to the foot's centre), foot radius, m
#define L1 ${cFloat(L1)}
#define L2 ${cFloat(L2)}
#define FOOT_R ${cFloat(footR)}
// the hip axes' height over the floor standing, and crouched (where the stand-up starts its straight rise; 0: with
// the knee folded to FOLD_CROUCH)
#define STAND_H ${cFloat(standH)}
#define CROUCH_H ${cFloat(crouch)}
// how far the knee folds (rad, 0 straight): most it can (the shank tube against the knee actuator's cup), crouched, least
#define FOLD_MAX ${cFloat((setting(c.fw, "fold_max", 144) * Math.PI) / 180)}
#define FOLD_CROUCH ${cFloat((136 * Math.PI) / 180)}
#define FOLD_MIN ${cFloat((20 * Math.PI) / 180)}
// the thigh's angle from straight down (rad, + swings the knee back): its range
#define THIGH_LO ${cFloat(-0.6)}
#define THIGH_HI ${cFloat(2.6)}
// trot: period (s), swing height (m), top speed (m/s)
#define PERIOD ${cFloat(period)}
#define SWING_H ${cFloat(swingH)}
#define V_MAX ${cFloat(vMax)}
#define KP_STAND ${cFloat(kpStand)}
#define KD_STAND ${cFloat(kdStand)}
// the whole robot's mass, kg: the feet in stance share its weight
#define MASS ${cFloat(mass)}

// MIT mode ranges of the ${oneLine(ap?.name ?? "actuator", 60)}
#define P_MAX ${cFloat(P_MAX)}
#define V_MAXR ${cFloat(V_MAX)}
#define T_MAXR ${cFloat(T_MAX)}
#define KP_MAX ${cFloat(KP_MAX)}
#define KD_MAX ${cFloat(KD_MAX)}

// legs ${legs.map((l) => l.name).join(", ")}: hip axis x, ab/ad axis y and height (m, from the body's centre), the leg plane's offset from the ab/ad axis
const float HIP_X[N_LEGS] = ${legLine((l) => cFloat(l.x / 1000))};
const float ABAD_Y[N_LEGS] = ${legLine((l) => cFloat(l.y / 1000))};
const float LEG_Y[N_LEGS] = ${farr(legY0)};
// each joint's CAN id, CAN port (1 to 3, 0: not on a bus) and the sense its actuator turns it (+1 or -1): ab/ad, hip, knee
const uint8_t CAN_ID[N_LEGS][3] = ${legLine((l) => arr(l.ids))};
const uint8_t CAN_PORT[N_LEGS][3] = ${legLine((l) => arr(l.ports))};
const int8_t SGN[N_LEGS][3] = ${legLine((l) => arr(l.sgn))};
// joint limits from the standing pose, rad: ab/ad, hip, knee (folding the knee is negative); setup() works out the
// hip's and knee's from the leg's angles and the fold limits above
float Q_LO[3] = { -0.45, 0, 0 };
float Q_HI[3] = { 0.45, 0, 0 };
// the IMU's axes in the body's
#define IMU_R ${`{ ${imuR.map((r) => `{ ${r.map((v) => cFloat(v)).join(", ")} }`).join(", ")} }`}
`;

  const ino = `// ${oneLine(c.designName)}: quadruped firmware for the ${bp.name}, generated by Kerf from the design's wiring.
// Twelve CubeMars actuators in MIT mode on ${buses.length} CAN bus${buses.length === 1 ? "" : "es"} (FlexCAN_T4), an LSM6DSOX for attitude, a trot gait.
// Commands on USB, one per line: on | stand | trot <m/s> [<deg/s turn>] [<m/s sideways>] | stop | sit | off | st | rd
#include <Arduino.h>
#include <Wire.h>
#include <FlexCAN_T4.h>
#include <Adafruit_NeoPixel.h>
#include "config.h"

FlexCAN_T4<CAN1, RX_SIZE_256, TX_SIZE_16> can1;
FlexCAN_T4<CAN2, RX_SIZE_256, TX_SIZE_16> can2;
FlexCAN_T4<CAN3, RX_SIZE_256, TX_SIZE_16> can3;
Adafruit_NeoPixel leds(N_LED, LED_PIN < 0 ? 2 : LED_PIN, NEO_GRB + NEO_KHZ800);

enum { ST_LIMP, ST_HOLD, ST_RISE, ST_STAND, ST_TROT, ST_SIT, ST_DAMP, ST_ESTOP };
const char *ST_NAME[] = { "limp", "holding", "standing up", "standing", "trotting", "sitting down", "damping", "e-stop" };
uint8_t state_now = ST_LIMP;

// ---- what the actuators say (rad, rad/s, N.m, C) and when each last answered (ms)
float q[N_LEGS][3];
float dq[N_LEGS][3];
float tq[N_LEGS][3];
uint8_t temp[N_LEGS][3];
unsigned long heard[N_LEGS][3];
uint8_t seen[N_LEGS][3];
// ---- what they are told: joint angles and speeds from the standing pose, and the gains
float qd[N_LEGS][3];
float vd[N_LEGS][3];
float tff[N_LEGS][3];
float kp[N_LEGS][3];
float kd[N_LEGS][3];
uint8_t enabled = 0;

// counters the simulator's scenarios read
long frames = 0;
long replies = 0;
long txFull = 0;
long lostReplies = 0;
long faults = 0;
long falls = 0;
long refused = 0;
long strides = 0;
float maxTilt = 0;
float peakTorque = 0;

// ---- attitude (rad) and the gait
float roll = 0, pitch = 0, yaw = 0;
// the attitude through a 0.5 s low-pass: a slope to level against, not the rocking of each stride
float rollSlow = 0, pitchSlow = 0;
float gyroBias[3] = { 0, 0, 0 };
uint8_t imuOk = 0;
float TH0, QS0;            // the standing pose's thigh angle and shank angle from straight down
float CROUCH_D;            // hip to the foot's centre, crouched
float vCmd = 0, wCmd = 0, yCmd = 0;   // asked for: forward m/s, turn rad/s, sideways m/s
float vNow = 0, wNow = 0, yNow = 0;
float yawHold = 0;
float phase = 0;
uint8_t stopping = 0;
unsigned long tickN = 0;
unsigned long lastTick = 0;
unsigned long stateAt = 0;
float q0[N_LEGS][3];       // the joints where a move began
float qCrouch[N_LEGS][3];
float qLie[N_LEGS][3];     // where it lay when it took hold
char line[48];
uint8_t lineLen = 0;

static void say(uint8_t s) {
  state_now = s;
  stateAt = millis();
  Serial.print("state: ");
  Serial.println(ST_NAME[s]);
}

// ---------------------------------------------------------------- CAN: MIT-mode frames
static uint16_t f2u(float x, float lo, float hi, uint8_t bits) {
  if (x < lo) x = lo;
  if (x > hi) x = hi;
  return (uint16_t)((x - lo) * (float)((1UL << bits) - 1) / (hi - lo) + 0.5f);
}
static float u2f(uint16_t u, float lo, float hi, uint8_t bits) {
  return (float)u * (hi - lo) / (float)((1UL << bits) - 1) + lo;
}

static void canSend(uint8_t port, CAN_message_t &m) {
  int ok = 0;
  if (port == 1) ok = can1.write(m);
  else if (port == 2) ok = can2.write(m);
  else if (port == 3) ok = can3.write(m);
  else return;
  if (ok) frames++;
  else txFull++;
}

// the special frames: FC into motor mode, FD out of it
static void special(uint8_t L, uint8_t j, uint8_t code) {
  CAN_message_t m;
  m.id = CAN_ID[L][j];
  m.len = 8;
  for (uint8_t i = 0; i < 7; i++) m.buf[i] = 0xFF;
  m.buf[7] = code;
  canSend(CAN_PORT[L][j], m);
}

static void command(uint8_t L, uint8_t j) {
  float s = SGN[L][j];
  float p = s * qd[L][j];
  float v = s * vd[L][j];
  uint16_t pi = f2u(p, -P_MAX, P_MAX, 16);
  uint16_t vi = f2u(v, -V_MAXR, V_MAXR, 12);
  uint16_t kpi = f2u(kp[L][j], 0, KP_MAX, 12);
  uint16_t kdi = f2u(kd[L][j], 0, KD_MAX, 12);
  uint16_t ti = f2u(s * tff[L][j], -T_MAXR, T_MAXR, 12);
  CAN_message_t m;
  m.id = CAN_ID[L][j];
  m.len = 8;
  m.buf[0] = pi >> 8;
  m.buf[1] = pi & 0xFF;
  m.buf[2] = vi >> 4;
  m.buf[3] = ((vi & 0xF) << 4) | (kpi >> 8);
  m.buf[4] = kpi & 0xFF;
  m.buf[5] = kdi >> 4;
  m.buf[6] = ((kdi & 0xF) << 4) | (ti >> 8);
  m.buf[7] = ti & 0xFF;
  canSend(CAN_PORT[L][j], m);
}

// an answer: id, position (16 bits), speed (12), torque (12), temperature + 40, error
static void reply(CAN_message_t &m) {
  uint8_t id = m.buf[0];
  for (uint8_t L = 0; L < N_LEGS; L++)
    for (uint8_t j = 0; j < 3; j++) {
      if (CAN_ID[L][j] != id) continue;
      float s = SGN[L][j];
      uint16_t pi = (m.buf[1] << 8) | m.buf[2];
      uint16_t vi = (m.buf[3] << 4) | (m.buf[4] >> 4);
      uint16_t ti = ((m.buf[4] & 0xF) << 8) | m.buf[5];
      q[L][j] = s * u2f(pi, -P_MAX, P_MAX, 16);
      dq[L][j] = s * u2f(vi, -V_MAXR, V_MAXR, 12);
      tq[L][j] = s * u2f(ti, -T_MAXR, T_MAXR, 12);
      if (fabs(tq[L][j]) > peakTorque) peakTorque = fabs(tq[L][j]);
      temp[L][j] = m.len > 6 && m.buf[6] > 40 ? m.buf[6] - 40 : 0;
      heard[L][j] = millis();
      seen[L][j] = 1;
      replies++;
      return;
    }
}

static void readReplies() {
  CAN_message_t m;
  while (can1.read(m)) reply(m);
  while (can2.read(m)) reply(m);
  while (can3.read(m)) reply(m);
}

static void sendAll() {
  for (uint8_t L = 0; L < N_LEGS; L++)
    for (uint8_t j = 0; j < 3; j++)
      if (CAN_PORT[L][j]) command(L, j);
}

static void motorMode(uint8_t on) {
  for (uint8_t L = 0; L < N_LEGS; L++)
    for (uint8_t j = 0; j < 3; j++) {
      if (!CAN_PORT[L][j]) continue;
      special(L, j, on ? 0xFC : 0xFD);
      kp[L][j] = 0;
      kd[L][j] = 0;
      vd[L][j] = 0;
      tff[L][j] = 0;
    }
  enabled = on;
}

// ---------------------------------------------------------------- IMU (LSM6DSOX registers)
static bool imuWrite(uint8_t reg, uint8_t v) {
  Wire.beginTransmission(IMU_ADDR);
  Wire.write(reg);
  Wire.write(v);
  return Wire.endTransmission() == 0;
}

static bool imuRead(uint8_t reg, uint8_t *buf, uint8_t n) {
  Wire.beginTransmission(IMU_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(IMU_ADDR, n) != n) return false;
  for (uint8_t i = 0; i < n; i++) buf[i] = Wire.read();
  return true;
}

static bool imuBegin() {
  uint8_t who = 0;
  if (!imuRead(0x0F, &who, 1) || who != 0x6C) return false;
  imuWrite(0x12, 0x01);              // software reset
  delay(20);
  bool ok = imuWrite(0x12, 0x44);    // block data update, address auto-increment
  ok = ok && imuWrite(0x10, 0x8C);   // accel 1.66 kHz, +-8 g (feet striking)
  ok = ok && imuWrite(0x11, 0x8C);   // gyro 1.66 kHz, +-2000 dps
  return ok;
}

const float imuR[3][3] = IMU_R;
static bool imuSample(float *g, float *a) {
  uint8_t b[12];
  if (!imuRead(0x22, b, 12)) return false;
  float gc[3], ac[3];
  for (uint8_t i = 0; i < 3; i++) {
    gc[i] = (int16_t)(b[2 * i] | (b[2 * i + 1] << 8)) * (0.070f * DEG_TO_RAD);
    ac[i] = (int16_t)(b[6 + 2 * i] | (b[7 + 2 * i] << 8)) * 0.000244f;
  }
  for (uint8_t j = 0; j < 3; j++) {
    g[j] = imuR[j][0] * gc[0] + imuR[j][1] * gc[1] + imuR[j][2] * gc[2];
    a[j] = imuR[j][0] * ac[0] + imuR[j][1] * ac[1] + imuR[j][2] * ac[2];
  }
  return true;
}

// roll and pitch: the gyro, pulled towards the accelerometer's tilt (a 1 s time constant); yaw from the gyro alone
static void attitude() {
  if (!imuOk) return;
  float g[3], a[3];
  if (!imuSample(g, a)) return;
  for (uint8_t i = 0; i < 3; i++) g[i] -= gyroBias[i];
  float dt = TICK_US * 1e-6f;
  float ar = atan2(a[1], a[2]);
  float ap = atan2(-a[0], sqrt(a[1] * a[1] + a[2] * a[2]));
  roll = 0.998f * (roll + g[0] * dt) + 0.002f * ar;
  pitch = 0.998f * (pitch + g[1] * dt) + 0.002f * ap;
  yaw += g[2] * dt;
  float tilt = sqrt(roll * roll + pitch * pitch);
  if (tilt > maxTilt && state_now >= ST_RISE && state_now <= ST_SIT) maxTilt = tilt;
}

static void calibrate() {
  float s[3] = { 0, 0, 0 };
  int n = 0;
  for (int k = 0; k < 100; k++) {
    float g[3], a[3];
    if (imuSample(g, a)) {
      for (uint8_t i = 0; i < 3; i++) s[i] += g[i];
      n++;
    }
    delay(2);
  }
  if (n) for (uint8_t i = 0; i < 3; i++) gyroBias[i] = s[i] / n;
}

// ---------------------------------------------------------------- the leg
// foot (x, y, z) from the hip, m, y and z from the ab/ad axis: the three joint angles from the standing pose
static void ik(uint8_t L, float x, float y, float z, float *out) {
  float d = LEG_Y[L];
  float r2 = y * y + z * z - d * d;
  if (r2 < 0.0004f) r2 = 0.0004f;
  float h = sqrt(r2);
  out[0] = atan2(y, -z) - atan2(d, h);
  float D = sqrt(x * x + h * h);
  if (D > L1 + L2 - 0.002f) D = L1 + L2 - 0.002f;
  if (D < 0.06f) D = 0.06f;
  float psi = atan2(-x, h);
  float c = (L1 * L1 + D * D - L2 * L2) / (2 * L1 * D);
  if (c > 1) c = 1;
  if (c < -1) c = -1;
  float a1 = psi + acos(c);
  float kx = -L1 * sin(a1);
  float kz = -L1 * cos(a1);
  float a2 = atan2(-(x - kx), -(-h - kz));
  out[1] = a1 - TH0;
  out[2] = (a2 - a1) - (QS0 - TH0);
  for (uint8_t j = 0; j < 3; j++) {
    if (out[j] < Q_LO[j]) out[j] = Q_LO[j];
    if (out[j] > Q_HI[j]) out[j] = Q_HI[j];
  }
}

static void gains(float p, float d) {
  for (uint8_t L = 0; L < N_LEGS; L++)
    for (uint8_t j = 0; j < 3; j++) {
      kp[L][j] = j == 0 ? p * 1.5f : p;
      kd[L][j] = d;
      vd[L][j] = 0;
      tff[L][j] = 0;
    }
}

// a foot in stance: the joint torques that make it push down with w newtons (its share of the weight, J^T of the
// leg), and the joint speeds that move it at xd m/s along the body in the leg's plane (J^-1), at the joint angles f
// for the foot at (y, z) from the ab/ad axis. The PD then only corrects, so the body neither sags nor drags its feet.
static void stanceFF(uint8_t L, float *f, float y, float z, float w, float xd) {
  float a1 = f[1] + TH0;
  float a2 = f[2] + (QS0 - TH0) + a1;
  float s1 = sin(a1), c1 = cos(a1), s2 = sin(a2), c2 = cos(a2);
  float jxh = -L1 * c1 - L2 * c2, jxk = -L2 * c2;
  float jzh = L1 * s1 + L2 * s2, jzk = L2 * s2;
  tff[L][0] = -w * y;
  tff[L][1] = -w * jzh;
  tff[L][2] = -w * jzk;
  float det = jxh * jzk - jxk * jzh;
  if (fabs(det) > 1e-4f) {
    vd[L][1] = jzk * xd / det;
    vd[L][2] = -jzh * xd / det;
  }
}

static float smooth(float u) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return u * u * (3 - 2 * u);
}

static void begin(uint8_t s) {
  for (uint8_t L = 0; L < N_LEGS; L++)
    for (uint8_t j = 0; j < 3; j++) q0[L][j] = q[L][j];
  say(s);
}

// stance feet level the body on a slope: a side that is high is shortened, a low one lengthened
static float level(uint8_t L) {
  return 0.6f * (rollSlow * ABAD_Y[L] - pitchSlow * HIP_X[L]);
}

static void control() {
  float t = (millis() - stateAt) / 1000.0f;
  float f[3];
  if (state_now == ST_HOLD) {
    // hold softly where it was found
    gains(25, 1.0f);
    for (uint8_t L = 0; L < N_LEGS; L++)
      for (uint8_t j = 0; j < 3; j++) qd[L][j] = q0[L][j];
  } else if (state_now == ST_RISE) {
    // 1.5 s: the joints from where they lie to the crouch (feet under the hips); then 1.5 s straight up
    if (t < 1.5f) {
      float e = smooth(t / 1.5f);
      gains(60 + 60 * e, 2.5f);
      for (uint8_t L = 0; L < N_LEGS; L++)
        for (uint8_t j = 0; j < 3; j++) qd[L][j] = q0[L][j] + e * (qCrouch[L][j] - q0[L][j]);
    } else {
      float e = smooth((t - 1.5f) / 1.5f);
      gains(120 + (KP_STAND - 120) * e, KD_STAND);
      float zh = CROUCH_D + e * (STAND_H - FOOT_R - CROUCH_D);
      for (uint8_t L = 0; L < N_LEGS; L++) {
        ik(L, 0, LEG_Y[L], -zh, f);
        for (uint8_t j = 0; j < 3; j++) qd[L][j] = f[j];
        // the weight comes onto the feet as it rises
        stanceFF(L, f, LEG_Y[L], -zh, e * MASS * 9.81f / 4, 0);
      }
      if (t >= 3.2f) say(ST_STAND);
    }
  } else if (state_now == ST_STAND || state_now == ST_TROT) {
    float dt = TICK_US * 1e-6f;
    rollSlow += (roll - rollSlow) * dt / 0.5f;
    pitchSlow += (pitch - pitchSlow) * dt / 0.5f;
    // ramp towards what is asked: 0.5 m/s per second, 1 rad/s per second
    float dv = vCmd - vNow, dw = wCmd - wNow, dy = yCmd - yNow;
    float mv = 0.5f * dt, mw = 1.0f * dt;
    vNow += dv > mv ? mv : (dv < -mv ? -mv : dv);
    wNow += dw > mw ? mw : (dw < -mw ? -mw : dw);
    yNow += dy > mv ? mv : (dy < -mv ? -mv : dy);
    // heading: what the turn asks for, and the gyro's yaw held to it
    yawHold += wNow * dt;
    float w = wNow + 1.5f * (yawHold - yaw);
    if (state_now == ST_TROT) {
      phase += dt / PERIOD;
      if (phase >= 1) {
        phase -= 1;
        strides++;
        if (stopping && fabs(vNow) < 0.02f && fabs(wNow) < 0.05f && fabs(yNow) < 0.02f) {
          stopping = 0;
          say(ST_STAND);
        }
      }
    }
    gains(state_now == ST_TROT ? KP_STAND * 0.85f : KP_STAND, KD_STAND);
    for (uint8_t L = 0; L < N_LEGS; L++) {
      float x = 0, y = LEG_Y[L], z = -(STAND_H - FOOT_R);
      uint8_t inStance = 1;
      float xdot = 0;
      if (state_now == ST_TROT) {
        // diagonal pairs: front left and rear right, then front right and rear left
        float ph = phase + ((L == 0 || L == 3) ? 0 : 0.5f);
        if (ph >= 1) ph -= 1;
        float half = PERIOD / 2;
        float sx = (vNow - w * ABAD_Y[L]) * half;
        float sy = (yNow + w * HIP_X[L]) * half;
        if (ph < 0.5f) {
          float u = ph / 0.5f;
          x = sx / 2 - sx * u;
          y += sy / 2 - sy * u;
          z += level(L);
          xdot = -sx / half;
        } else {
          inStance = 0;
          float u = (ph - 0.5f) / 0.5f;
          float e = smooth(u);
          x = -sx / 2 + sx * e;
          y += -sy / 2 + sy * e;
          // lifts and sets down with no vertical speed, so the foot does not strike
          z += SWING_H * 0.5f * (1 - cos(2 * PI * u));
          // a leg in the air only carries itself: soft, so it gives where it meets the floor
          for (uint8_t j = 0; j < 3; j++) {
            kp[L][j] *= 0.4f;
            kd[L][j] *= 0.5f;
          }
        }
      } else z += level(L);
      ik(L, x, y, z, f);
      for (uint8_t j = 0; j < 3; j++) qd[L][j] = f[j];
      if (inStance) stanceFF(L, f, y, z, MASS * 9.81f / (state_now == ST_TROT ? 2 : 4), xdot);
    }
  } else if (state_now == ST_SIT) {
    // 1.5 s down to the crouch, then 1.5 s folding back to where it lay
    if (t < 1.5f) {
      float e = smooth(t / 1.5f);
      gains(KP_STAND, KD_STAND);
      float zh = (STAND_H - FOOT_R) - e * (STAND_H - FOOT_R - CROUCH_D);
      for (uint8_t L = 0; L < N_LEGS; L++) {
        ik(L, 0, LEG_Y[L], -zh, f);
        for (uint8_t j = 0; j < 3; j++) qd[L][j] = f[j];
      }
    } else {
      float e = smooth((t - 1.5f) / 1.5f);
      gains(120 - 80 * e, 2.5f);
      for (uint8_t L = 0; L < N_LEGS; L++)
        for (uint8_t j = 0; j < 3; j++) qd[L][j] = qCrouch[L][j] + e * (qLie[L][j] - qCrouch[L][j]);
      if (t >= 3.2f) begin(ST_HOLD);
    }
  } else if (state_now == ST_DAMP) {
    // no stiffness, only damping: it folds down slowly under its own weight
    for (uint8_t L = 0; L < N_LEGS; L++)
      for (uint8_t j = 0; j < 3; j++) {
        kp[L][j] = 0;
        kd[L][j] = 2.5f;
        vd[L][j] = 0;
        qd[L][j] = q[L][j];
      }
  }
}

// ---------------------------------------------------------------- watching over it
static void fault(const char *why) {
  Serial.print("err fault: ");
  Serial.println(why);
  faults++;
  if (enabled) begin(ST_DAMP);
}

static void watch() {
  unsigned long now = millis();
  uint8_t pressed = ESTOP_PIN >= 0 && digitalRead(ESTOP_PIN) == LOW;
  if (pressed && state_now != ST_ESTOP) {
    Serial.println("err e-stop pressed: the actuators' power is cut");
    faults++;
    motorMode(0);
    say(ST_ESTOP);
    return;
  }
  if (state_now == ST_ESTOP) {
    if (!pressed && now - stateAt > 500) say(ST_LIMP);
    return;
  }
  if (!enabled || state_now == ST_DAMP) return;
  for (uint8_t L = 0; L < N_LEGS; L++)
    for (uint8_t j = 0; j < 3; j++) {
      if (!CAN_PORT[L][j]) continue;
      if (now - heard[L][j] > 50) {
        lostReplies++;
        Serial.print("err no answer from CAN id ");
        Serial.println(CAN_ID[L][j]);
        fault("an actuator stopped answering");
        return;
      }
      if (temp[L][j] > 85) {
        fault("an actuator is too hot");
        return;
      }
    }
  if (HAS_IMU && imuOk && state_now >= ST_STAND && state_now <= ST_TROT && (fabs(roll) > 0.785f || fabs(pitch) > 0.785f)) {
    falls++;
    fault("tipped past 45 degrees");
  }
}

static void showLeds() {
  if (LED_PIN < 0) return;
  uint32_t c = leds.Color(0, 0, 0);
  if (state_now == ST_LIMP) c = leds.Color(40, 30, 0);
  else if (state_now == ST_HOLD || state_now == ST_SIT || state_now == ST_RISE) c = leds.Color(0, 40, 40);
  else if (state_now == ST_STAND) c = leds.Color(0, 60, 0);
  else if (state_now == ST_TROT) c = leds.Color(0, 20, 80);
  else c = leds.Color(80, 0, 0);
  for (uint8_t i = 0; i < N_LED; i++) leds.setPixelColor(i, c);
  leds.show();
}

// ---------------------------------------------------------------- console
static void report() {
  Serial.print("st ");
  Serial.print(ST_NAME[state_now]);
  Serial.print(" roll ");
  Serial.print(roll * RAD_TO_DEG, 1);
  Serial.print(" pitch ");
  Serial.print(pitch * RAD_TO_DEG, 1);
  Serial.print(" yaw ");
  Serial.print(yaw * RAD_TO_DEG, 1);
  Serial.print(" v ");
  Serial.print(vNow, 2);
  Serial.print(" frames ");
  Serial.print(frames);
  Serial.print(" replies ");
  Serial.print(replies);
  Serial.print(" faults ");
  Serial.println(faults);
}

static uint8_t answered() {
  for (uint8_t L = 0; L < N_LEGS; L++)
    for (uint8_t j = 0; j < 3; j++)
      if (CAN_PORT[L][j] && !seen[L][j]) return 0;
  return 1;
}

static void run() {
  char *a = line;
  while (*a == ' ') a++;
  if (!strncmp(a, "on", 2) && (a[2] == 0 || a[2] == ' ')) {
    if (state_now == ST_ESTOP) { refused++; Serial.println("err e-stop is in"); return; }
    if (!enabled) motorMode(1);
    delay(10);
    readReplies();
    if (!answered()) { refused++; Serial.println("err not every actuator answers"); motorMode(0); return; }
    for (uint8_t L = 0; L < N_LEGS; L++)
      for (uint8_t j = 0; j < 3; j++) qLie[L][j] = q[L][j];
    begin(ST_HOLD);
    Serial.println("ok");
  } else if (!strncmp(a, "stand", 5)) {
    if (state_now != ST_HOLD) { refused++; Serial.println("err stand from holding (send on first)"); return; }
    for (uint8_t L = 0; L < N_LEGS; L++) ik(L, 0, LEG_Y[L], -CROUCH_D, qCrouch[L]);
    for (uint8_t L = 0; L < N_LEGS; L++)
      for (uint8_t j = 0; j < 3; j++) qLie[L][j] = q[L][j];
    begin(ST_RISE);
    Serial.println("ok");
  } else if (!strncmp(a, "trot", 4)) {
    if (state_now != ST_STAND && state_now != ST_TROT) { refused++; Serial.println("err trot from standing"); return; }
    float v = 0, w = 0, y = 0;
    char *p = a + 4;
    v = strtod(p, &p);
    w = strtod(p, &p) * DEG_TO_RAD;
    y = strtod(p, &p);
    if (fabs(v) > V_MAX || fabs(y) > V_MAX / 2 || fabs(w) > 1.6f) { refused++; Serial.println("err too fast"); return; }
    vCmd = v;
    wCmd = w;
    yCmd = y;
    stopping = 0;
    if (state_now != ST_TROT) {
      phase = 0;
      yawHold = yaw;
      say(ST_TROT);
    }
    Serial.println("ok");
  } else if (!strncmp(a, "stop", 4)) {
    vCmd = wCmd = yCmd = 0;
    if (state_now == ST_TROT) stopping = 1;
    Serial.println("ok");
  } else if (!strncmp(a, "sit", 3)) {
    if (state_now != ST_STAND) { refused++; Serial.println("err sit from standing"); return; }
    for (uint8_t L = 0; L < N_LEGS; L++) ik(L, 0, LEG_Y[L], -CROUCH_D, qCrouch[L]);
    begin(ST_SIT);
    Serial.println("ok");
  } else if (!strncmp(a, "off", 3)) {
    motorMode(0);
    say(ST_LIMP);
    Serial.println("ok");
  } else if (!strncmp(a, "st", 2)) report();
  else if (!strncmp(a, "rd", 2)) {
    for (uint8_t L = 0; L < N_LEGS; L++) {
      for (uint8_t j = 0; j < 3; j++) {
        Serial.print(q[L][j] * RAD_TO_DEG, 1);
        Serial.print(j < 2 ? " " : (L < N_LEGS - 1 ? " | " : "\\n"));
      }
    }
  } else if (*a) {
    refused++;
    Serial.println("err unknown command");
  }
}

static void console() {
  while (Serial.available()) {
    char ch = (char)Serial.read();
    if (ch == '\\r') continue;
    if (ch == '\\n' || ch == ';') {
      line[lineLen] = 0;
      lineLen = 0;
      run();
    } else if (lineLen < sizeof(line) - 1) line[lineLen++] = ch;
  }
}

void setup() {
  Serial.begin(USB_BAUD);
  if (ESTOP_PIN >= 0) pinMode(ESTOP_PIN, INPUT_PULLUP);
  if (LED_PIN >= 0) {
    leds.begin();
    leds.show();
  }
  // the standing pose's angles, the zero every actuator was set to on the jig
  float reach = STAND_H - FOOT_R;
  TH0 = acos((L1 * L1 + reach * reach - L2 * L2) / (2 * L1 * reach));
  QS0 = atan2(-L1 * sin(TH0), reach - L1 * cos(TH0));
  Q_LO[1] = THIGH_LO - TH0;
  Q_HI[1] = THIGH_HI - TH0;
  // the knee's fold standing is TH0 - QS0; folding further is negative
  Q_LO[2] = (TH0 - QS0) - FOLD_MAX;
  Q_HI[2] = (TH0 - QS0) - FOLD_MIN;
  CROUCH_D = CROUCH_H > 0 ? CROUCH_H - FOOT_R : sqrt(L1 * L1 + L2 * L2 + 2 * L1 * L2 * cos(FOLD_CROUCH));
  can1.begin();
  can1.setBaudRate(CAN_BAUD);
  can2.begin();
  can2.setBaudRate(CAN_BAUD);
  can3.begin();
  can3.setBaudRate(CAN_BAUD);
  Wire.begin();
  Wire.setClock(400000);
  // the LSM6DSOX answers about 10 ms after power-up: give it a few tries
  for (uint8_t i = 0; HAS_IMU && i < 5 && !imuOk; i++) {
    imuOk = imuBegin();
    if (!imuOk) delay(10);
  }
  if (imuOk) calibrate();
  else if (HAS_IMU) Serial.println("err IMU not answering: no levelling or heading hold");
  showLeds();
  Serial.println("kerf quadruped ready");
  say(ST_LIMP);
  lastTick = micros();
}

void loop() {
  console();
  unsigned long now = micros();
  if (now - lastTick < TICK_US) return;
  lastTick += TICK_US;
  if (now - lastTick > 10 * TICK_US) lastTick = now;
  tickN++;
  readReplies();
  attitude();
  watch();
  if (enabled) {
    control();
    sendAll();
  }
  if (tickN % 50 == 0) showLeds();
}
`;

  const wiring = pinTable.map((r) => `| ${r.signal} | ${r.pin} | ${r.wire} |`).join("\n");
  const readme = `# ${oneLine(c.designName)}: quadruped firmware

Teensyduino sketch for the ${bp.name}: the leg controller. A computer on USB (the Jetson) sends it what to do as lines
of text; it runs every joint at 500 Hz over CAN.

## Build

Arduino IDE 2 with Teensyduino (board: Teensy 4.1, USB type: Serial). FlexCAN_T4 and Adafruit NeoPixel come with
Teensyduino. Open \`${name}/${name}.ino\` and upload.

## Pins and actuators

| Signal | Pin | Wire |
|---|---|---|
${wiring}

## Before the first run

1. Give each actuator its CAN id with CubeMars' upper computer tool, one at a time, as the table above says.
2. Put the robot on its jig in the standing pose (every foot under its hip, the hip axes ${cNum(standH * 1000)} mm over the
   floor) and set each actuator's zero there with the tool: the firmware counts every angle from that pose.

## Commands (USB serial, ${115200} baud, new line)

- \`on\`: every actuator into motor mode, holding softly where it lies
- \`stand\`: up from lying folded to the crouch, then straight up to standing
- \`trot <m/s> [<deg/s>] [<m/s sideways>]\`: trot (period ${cNum(period)} s, feet lifted ${cNum(swingH * 1000)} mm), up to ${cNum(vMax)} m/s
- \`stop\`: back to standing at the end of a stride; \`sit\`: back down to lying; \`off\`: limp
- \`st\`: state, attitude, speed and the CAN counters; \`rd\`: every joint's angle

The e-stop's normally-closed contact drops the actuators' relay; the board sees its normally-open contact and goes
limp. An actuator that stops answering for 50 ms or runs past 85 °C, or a body tipped past 45°, puts every joint into
damping only, so it folds down slowly instead of falling.
`;
  return {
    files: [
      { path: `${dir0}/${name}.ino`, content: ino },
      { path: `${dir0}/config.h`, content: config },
      { path: `${dir0}/README.md`, content: readme },
    ],
    warnings,
    pinTable,
    summary: `Teensy 4.1 sketch for ${bp.name}: ${legs.length} legs on ${buses.length} CAN bus${buses.length === 1 ? "" : "es"} of MIT-mode actuators at 500 Hz, stand-up, trot with IMU levelling and heading hold, commanded over USB`,
  };
}
