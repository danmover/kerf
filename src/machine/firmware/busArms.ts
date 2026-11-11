// Firmware for arms built from smart bus servos (Feetech STS: Waveshare
// ST3215): the controller is a bridge between a computer on USB and one servo
// bus per arm. The computer plans (kinematics, vision, whatever drives it) and
// sends joint moves as lines of text; the board checks them against the joint
// limits, times every joint of a move to arrive together, starts the servos
// softly one arm at a time, reads every servo back 50 times a second
// (position, speed, load, voltage, temperature, current), and stops on the
// e-stop, an overloaded or overheated servo, or an arm drawing more than its
// fuse. Every pin and every servo's bus number comes from the design's wiring.
// Plain C, so the simulator runs exactly what goes on the board.

import { catalogPart } from "../catalog";
import { servoBuses } from "../busServos";
import type { MachineComponent } from "../types";
import { type FwContext, type GenFile, cComment, cNum, componentsOfKind, ctrlPinFor, ident, oneLine, setting } from "./common";

export const BUS_ARM_WORDS = /\b(two[- ]arm|dual[- ]arm|bus[- ]servos?|smart[- ]servos?|serial[- ]bus servos?)/i;

export interface BusArmResult {
  files: GenFile[];
  warnings: string[];
  pinTable: { signal: string; pin: string; wire: string }[];
  summary: string;
}

const pinNum = (id: string | undefined) => {
  if (!id) return -1;
  const n = Number(id);
  return Number.isInteger(n) ? n : -1;
};

/** Does this design have smart servos on a bus adapter? */
export function hasServoBus(c: FwContext): boolean {
  return servoBuses(c.m).some((b) => b.servos.length > 0);
}

export function busArmFirmware(c: FwContext): BusArmResult {
  const warnings: string[] = [];
  const pinTable: BusArmResult["pinTable"] = [];
  const board = c.board.name;
  const bp = c.boardPart;
  const note = (signal: string, comp: string, pin: string) => {
    const r = ctrlPinFor(c, comp, pin);
    if (r) pinTable.push({ signal, pin: r.pin.label ? `${r.pin.label} (GPIO${r.pin.mcu ?? r.pin.id})` : r.pin.id, wire: `${comp}.${pin}` });
    return pinNum(r?.pin.mcu ?? r?.pin.id);
  };

  // ---- the buses, from the wiring: at most two (the board's third UART is its USB port)
  let buses = servoBuses(c.m)
    .filter((b) => b.servos.length > 0)
    .sort((a, b) => a.adapter.localeCompare(b.adapter, undefined, { numeric: true }));
  if (buses.length > 2) {
    warnings.push(`${buses.length} servo buses and two spare UARTs: ${buses.slice(2).map((b) => b.adapter).join(", ")} left out.`);
    buses = buses.slice(0, 2);
  }
  if (!/esp32/i.test(String(bp.specs.mcu ?? bp.id))) warnings.push(`${bp.name} has one UART, which its USB port uses: a servo bus needs a board with a spare one (an ESP32).`);
  const nArms = Math.max(1, buses.length);
  const maxJ = Math.max(1, ...buses.map((b) => b.servos.length));
  // an arm is named by what tells its adapter's name from the others' (drv_l, drv_r: L, R)
  const tails = buses.map((b) => b.adapter.replace(/^.*[^A-Za-z0-9]/, "").toUpperCase());
  const names = tails.every((t, i) => t.length === 1 && /[A-Z]/.test(t) && tails.indexOf(t) === i) ? tails : buses.map((_, i) => "AB"[i]);
  const rx = buses.map((b, i) => note(`arm ${names[i]} bus, receive (Serial${i + 1} RX)`, b.adapter, "RX"));
  const tx = buses.map((b, i) => note(`arm ${names[i]} bus, transmit (Serial${i + 1} TX)`, b.adapter, "TX"));
  buses.forEach((b, i) => {
    if (tx[i] < 0) warnings.push(`${b.adapter}.TX reaches no ${board} pin: arm ${names[i]} hears nothing.`);
    if (rx[i] < 0) warnings.push(`${b.adapter}.RX reaches no ${board} pin: arm ${names[i]} cannot answer.`);
  });
  if (!buses.length) warnings.push("No smart servos are wired to a bus adapter: nothing to drive.");

  // the e-stop's spare contact, read on a pin with its pull-up
  let estopPin = -1;
  let estop: MachineComponent | undefined;
  for (const sw of componentsOfKind(c, "switch")) {
    const part = catalogPart(sw.catalogId)!;
    for (const p of part.pins.filter((x) => x.type === "passive")) {
      if (estopPin >= 0) break;
      const n = pinNum(ctrlPinFor(c, sw.name, p.id)?.pin.mcu ?? ctrlPinFor(c, sw.name, p.id)?.pin.id);
      if (n >= 0) {
        estopPin = note("e-stop (LOW = pressed)", sw.name, p.id);
        estop = sw;
      }
    }
  }
  if (!estop) warnings.push("No e-stop contact reaches the controller: it cannot tell a pressed e-stop from a dead supply.");

  // ---- settings
  const list = (key: string, def: number[]): number[] => {
    const raw = c.fw.settings[key];
    if (raw === undefined) return Array.from({ length: maxJ }, (_, j) => def[Math.min(j, def.length - 1)]);
    const xs = String(raw)
      .split(/[,\s]+/)
      .filter(Boolean)
      .map(Number);
    if (xs.length >= maxJ && xs.every(Number.isFinite)) return xs.slice(0, maxJ);
    warnings.push(`${key}: give ${maxJ} numbers, one for each joint from the base out; using the defaults.`);
    return Array.from({ length: maxJ }, (_, j) => def[Math.min(j, def.length - 1)]);
  };
  const lo = list("limits_lo", [-150]).map((v) => Math.round(v * 10));
  const hi = list("limits_hi", [150]).map((v) => Math.round(v * 10));
  const sign = list("signs", [1]).map((v) => (v < 0 ? -1 : 1));
  const torque = list("torque", [60]).map((v) => Math.max(5, Math.min(100, Math.round(v))) * 10);
  const accel = Math.max(1, Math.min(254, Math.round(setting(c.fw, "accel", 400) / (36000 / 4096))));
  const maxSpeed = Math.max(50, Math.min(3000, Math.round((setting(c.fw, "max_speed", 180) * 4096) / 360)));
  const usbBaud = setting(c.fw, "usb_baud", 115200);
  const armMa = Math.round(setting(c.fw, "arm_amps", 2.7) * 1000);
  const busBaud = buses[0]?.baud ?? 1_000_000;
  const jointNames = String(c.fw.settings.joints ?? "")
    .split(/[,\s]+/)
    .filter(Boolean);
  const jn = (j: number) => jointNames[j] ?? `joint ${j + 1}`;

  const name = ident(c.fw.name).toLowerCase() || "arms";
  const dir0 = `firmware/${name}`;
  const row = (xs: number[]) => xs.join(", ");
  const per = (xs: number[]) => Array.from({ length: nArms }, () => row(xs)).join(",\n  ");

  const config = `// ${cComment(c.designName)}: settings for ${name}.ino, from the design's wiring and its firmware block.
#pragma once

#define FW_ID "${ident(c.designName).toLowerCase() || "arms"} 1"
#define N_ARMS ${nArms}
#define MAX_J ${maxJ}
#define USB_BAUD ${usbBaud}
#define BUS_BAUD ${busBaud}
#define ESTOP_PIN ${estopPin}        // the e-stop's spare contact to ground: LOW = pressed (-1: none)

// One servo bus for each arm: ${buses.map((b, i) => `arm ${names[i]} on ${b.adapter}`).join(", ") || "none"}. Servos are numbered along the chain, 1 next to the adapter.
static const char ARM_NAME[N_ARMS] = { ${names.slice(0, nArms).map((n) => `'${n}'`).join(", ") || "'A'"} };
static const uint8_t N_J[N_ARMS] = { ${buses.map((b) => b.servos.length).join(", ") || "0"} };
static const int8_t BUS_RX[N_ARMS] = { ${rx.join(", ") || "-1"} };
static const int8_t BUS_TX[N_ARMS] = { ${tx.join(", ") || "-1"} };

// Each joint from the base out${jointNames.length ? ` (${jointNames.slice(0, maxJ).join(", ")})` : ""}: which way its servo counts, how far it may go either
// side of the pose it was zeroed in (0.1 degree), and the most torque it may give (0.1 % of stall).
static const int8_t SIGN[N_ARMS * MAX_J] = {
  ${per(sign)}
};
static const int16_t LIM_LO[N_ARMS * MAX_J] = {
  ${per(lo)}
};
static const int16_t LIM_HI[N_ARMS * MAX_J] = {
  ${per(hi)}
};
static const uint16_t TORQUE[N_ARMS * MAX_J] = {
  ${per(torque)}
};

#define ACCEL ${accel}             // the servos' own acceleration, x 100 steps/s² (${cNum(Math.round(accel * 8.79))} deg/s²)
#define MAX_SPEED ${maxSpeed}        // steps/s (${cNum(Math.round((maxSpeed * 360) / 4096))} deg/s); 4096 steps to a turn
#define SOFT_TORQUE 250       // what every servo starts on (0.1 %), until it has taken hold
#define ARM_MA_MAX ${armMa}       // what an arm may draw all day: its fuse's rating
#define ARM_HEAT_S 4          // how far past that it may go, as a fuse does: 110 % for 19 s, 135 % for 5 s, twice for 1.3 s
#define LOOP_MS 20            // every servo is read this often
`;

  const ino = `// ${cComment(c.designName)}: ${nArms === 1 ? "an arm" : `${nArms} arms`} of smart bus servos, driven from a computer over USB.
// Generated by Kerf from the design's wiring. Plain C: the simulator runs this same file.
//
// Lines in (ASCII, end with a new line; several on one line with ';'):
//   ping                         ok and the firmware's name
//   on [arm] / off [arm]         servos take hold (softly, one arm after the other) / go limp (to guide by hand)
//   mv <arm> <ms> <a1> <a2> ...  every joint of an arm to an angle (0.1 degree from its zero pose), arriving together
//   j <arm> <joint> <a> <ms>     one joint
//   home <ms>                    every joint of every arm to 0
//   stop                         hold where it is now
//   spin <arm> <steps/s>         the last servo of an arm turns on and on (a screwdriver); 0 ends it
//   tq <arm> <joint> <percent>   a joint's torque limit (joint 0: all of them)
//   rd / ld / st                 positions (0.1 degree) / loads (0.1 % of stall) / volts, milliamps, hottest servo, faults
//   stream <hz>                  positions as "p ..." lines, 0 to 50 times a second
//   setid <arm> <from> <to>      give a servo its bus number (one servo plugged in at a time)
//   zero <arm> <joint>           this joint is at its zero pose now (limp, held in the pose)
// Lines out: "ok", "err <why>", "p ...", "l ...", "s ...", and "state: limp | waiting | moving | estop | fault".

#include <Arduino.h>
#include "config.h"

#define NS (N_ARMS * MAX_J)
#define ST_LIMP 0
#define ST_WAITING 1
#define ST_MOVING 2
#define ST_ESTOP 3
#define ST_FAULT 4

// counters the computer (and the simulator) can read
unsigned long moves = 0;
unsigned long refused = 0;
unsigned long faults = 0;
unsigned long bus_errors = 0;
unsigned long polls = 0;
long arm_ma[N_ARMS];
int hottest = 0;
int volts_x10 = 0;
int state_now = -1;

static int16_t goal[NS];      // steps, 2048 at the zero pose
static int16_t pos[NS];
static int16_t spd[NS];       // steps/s
static int16_t load_[NS];     // 0.1 % of stall
static uint16_t ma[NS];
static uint8_t volt[NS];
static uint8_t temp[NS];
static uint8_t err[NS];
static uint8_t seen[NS];
static uint8_t alive[N_ARMS];
static uint8_t holding[N_ARMS];
static uint8_t wheel[N_ARMS];
static uint16_t wheelSpeed[N_ARMS];
static uint8_t estop = 0;
static uint8_t faulted = 0;
static uint8_t streamHz = 0;
static unsigned long lastPoll = 0;
static unsigned long lastStream = 0;
static unsigned long moveStart = 0;
static unsigned long moveMs = 0;
static long heat[N_ARMS];

static uint8_t tx[96];
static uint8_t rx[160];
static char line[120];
static uint8_t lineLen = 0;
static uint8_t at = 0;
static long numv = 0;
static long want[MAX_J];
static uint16_t speeds[MAX_J];

// ---------- the bus ----------

static void busSend(uint8_t arm, uint8_t n) {
  if (arm == 0) {
    while (Serial1.available()) Serial1.read();
    Serial1.write(tx, n);
    Serial1.flush();
  }
#if N_ARMS > 1
  else {
    while (Serial2.available()) Serial2.read();
    Serial2.write(tx, n);
    Serial2.flush();
  }
#endif
}

static uint8_t busRecv(uint8_t arm, uint8_t n) {
  if (arm == 0) return (uint8_t)Serial1.readBytes(rx, n);
#if N_ARMS > 1
  return (uint8_t)Serial2.readBytes(rx, n);
#else
  return 0;
#endif
}

// a packet round the np parameters already in tx[5..]: its length
static uint8_t frame(uint8_t id, uint8_t inst, uint8_t np) {
  uint8_t sum = (uint8_t)(id + np + 2 + inst);
  uint8_t i;
  tx[0] = 0xFF;
  tx[1] = 0xFF;
  tx[2] = id;
  tx[3] = (uint8_t)(np + 2);
  tx[4] = inst;
  for (i = 0; i < np; i++) sum = (uint8_t)(sum + tx[5 + i]);
  tx[5 + np] = (uint8_t)(~sum);
  return (uint8_t)(np + 6);
}

// one byte to one servo, and its acknowledgement
static uint8_t write8(uint8_t arm, uint8_t id, uint8_t addr, uint8_t v) {
  tx[5] = addr;
  tx[6] = v;
  busSend(arm, frame(id, 0x03, 2));
  return busRecv(arm, 6) == 6;
}

static uint8_t write16(uint8_t arm, uint8_t id, uint8_t addr, uint16_t v) {
  tx[5] = addr;
  tx[6] = (uint8_t)(v & 255);
  tx[7] = (uint8_t)(v >> 8);
  busSend(arm, frame(id, 0x03, 3));
  return busRecv(arm, 6) == 6;
}

// the same byte to every servo of an arm in one packet (no answers)
static void all8(uint8_t arm, uint8_t addr, uint8_t v) {
  uint8_t k = 5;
  uint8_t j;
  tx[k++] = addr;
  tx[k++] = 1;
  for (j = 0; j < N_J[arm]; j++) {
    tx[k++] = (uint8_t)(j + 1);
    tx[k++] = v;
  }
  busSend(arm, frame(0xFE, 0x83, (uint8_t)(k - 5)));
}

// every servo's torque limit: its own, or the soft one
static void allTorque(uint8_t arm, uint8_t soft) {
  uint8_t k = 5;
  uint8_t j;
  tx[k++] = 48;
  tx[k++] = 2;
  for (j = 0; j < N_J[arm]; j++) {
    uint16_t t = TORQUE[arm * MAX_J + j];
    if (soft && t > SOFT_TORQUE) t = SOFT_TORQUE;
    tx[k++] = (uint8_t)(j + 1);
    tx[k++] = (uint8_t)(t & 255);
    tx[k++] = (uint8_t)(t >> 8);
  }
  busSend(arm, frame(0xFE, 0x83, (uint8_t)(k - 5)));
}

// every servo's acceleration, goal and speed in one packet, so they all start together
static void sendGoals(uint8_t arm) {
  uint8_t k = 5;
  uint8_t j;
  tx[k++] = 41;
  tx[k++] = 7;
  for (j = 0; j < N_J[arm]; j++) {
    uint16_t g = (uint16_t)goal[arm * MAX_J + j];
    uint16_t s = speeds[j];
    if (wheel[arm] && j == N_J[arm] - 1) s = wheelSpeed[arm];
    tx[k++] = (uint8_t)(j + 1);
    tx[k++] = ACCEL;
    tx[k++] = (uint8_t)(g & 255);
    tx[k++] = (uint8_t)(g >> 8);
    tx[k++] = 0;
    tx[k++] = 0;
    tx[k++] = (uint8_t)(s & 255);
    tx[k++] = (uint8_t)(s >> 8);
  }
  busSend(arm, frame(0xFE, 0x83, (uint8_t)(k - 5)));
}

// read every servo of an arm: position, speed, load, volts, temperature, status and current (15 bytes from 56)
static void poll(uint8_t arm) {
  uint8_t n = N_J[arm];
  uint8_t b = (uint8_t)(arm * MAX_J);
  uint8_t k = 5;
  uint8_t j;
  uint8_t got;
  uint8_t p = 0;
  uint8_t found = 0;
  long total = 0;
  tx[k++] = 56;
  tx[k++] = 15;
  for (j = 0; j < n; j++) {
    tx[k++] = (uint8_t)(j + 1);
    seen[b + j] = 0;
  }
  busSend(arm, frame(0xFE, 0x82, (uint8_t)(k - 5)));
  got = busRecv(arm, (uint8_t)(n * 21));
  polls++;
  while (p + 21 <= got) {
    uint8_t id;
    uint8_t sum = 0;
    uint8_t i;
    if (rx[p] != 0xFF || rx[p + 1] != 0xFF || rx[p + 3] != 17) {
      p++;
      continue;
    }
    id = rx[p + 2];
    for (i = 2; i < 20; i++) sum = (uint8_t)(sum + rx[p + i]);
    if ((uint8_t)(~sum) != rx[p + 20] || id < 1 || id > n) {
      bus_errors++;
      p += 21;
      continue;
    }
    {
      uint8_t x = (uint8_t)(b + id - 1);
      uint16_t v;
      err[x] = rx[p + 4];
      pos[x] = (int16_t)(rx[p + 5] | (rx[p + 6] << 8));
      v = (uint16_t)(rx[p + 7] | (rx[p + 8] << 8));
      spd[x] = (v & 0x8000) ? -(int16_t)(v & 0x7FFF) : (int16_t)v;
      v = (uint16_t)(rx[p + 9] | (rx[p + 10] << 8));
      load_[x] = (v & 0x400) ? -(int16_t)(v & 0x3FF) : (int16_t)(v & 0x3FF);
      volt[x] = rx[p + 11];
      temp[x] = rx[p + 12];
      ma[x] = (uint16_t)(((long)(rx[p + 18] | (rx[p + 19] << 8)) * 13) / 2);
      total += ma[x];
      seen[x] = 1;
      found++;
    }
    p += 21;
  }
  if (found == 0) {
    // no answer at all: the arm has no power (the e-stop, its fuse, its plug)
    if (alive[arm]) {
      alive[arm] = 0;
      holding[arm] = 0;
      wheel[arm] = 0;
    }
    arm_ma[arm] = 0;
    return;
  }
  if (found < n) bus_errors++;
  alive[arm] = 1;
  arm_ma[arm] = total;
}

// ---------- angles ----------

static long toSteps(uint8_t x, long tenths) {
  return 2048 + (SIGN[x] * tenths * 4096) / 3600;
}

static long toTenths(uint8_t x, long steps) {
  return (SIGN[x] * (steps - 2048) * 3600) / 4096;
}

static void say(int s) {
  if (s == state_now) return;
  state_now = s;
  Serial.print("state: ");
  if (s == ST_LIMP) Serial.println("limp");
  else if (s == ST_WAITING) Serial.println("waiting");
  else if (s == ST_MOVING) Serial.println("moving");
  else if (s == ST_ESTOP) Serial.println("estop");
  else Serial.println("fault");
}

static uint8_t anyHolding() {
  uint8_t a;
  for (a = 0; a < N_ARMS; a++)
    if (holding[a]) return 1;
  return 0;
}

// ---------- what the lines do ----------

static void limp(uint8_t arm) {
  if (alive[arm]) all8(arm, 40, 0);
  holding[arm] = 0;
  wheel[arm] = 0;
}

// take hold where the arm stands: soft at first, then each joint's own limit
static uint8_t hold(uint8_t arm) {
  uint8_t j;
  poll(arm);
  if (!alive[arm]) return 0;
  for (j = 0; j < N_J[arm]; j++) {
    goal[arm * MAX_J + j] = pos[arm * MAX_J + j];
    speeds[j] = MAX_SPEED;
  }
  allTorque(arm, 1);
  all8(arm, 40, 1);
  sendGoals(arm);
  delay(150);
  allTorque(arm, 0);
  holding[arm] = 1;
  heat[arm] = 0;
  return 1;
}

// the joints of an arm to want[], in ms: every joint's speed set so they arrive together
static uint8_t moveArm(uint8_t arm, long ms) {
  uint8_t j;
  uint8_t n = N_J[arm];
  long longest = 0;
  if (estop) {
    Serial.println("err estop");
    refused++;
    return 0;
  }
  if (!holding[arm]) {
    Serial.println("err limp: send on first");
    refused++;
    return 0;
  }
  for (j = 0; j < n; j++) {
    uint8_t x = (uint8_t)(arm * MAX_J + j);
    if (wheel[arm] && j == n - 1) continue;
    if (want[j] < LIM_LO[x] || want[j] > LIM_HI[x]) {
      Serial.print("err limit ");
      Serial.print(ARM_NAME[arm]);
      Serial.print(" ");
      Serial.println(j + 1);
      refused++;
      return 0;
    }
  }
  if (ms < 0) ms = 0;
  for (j = 0; j < n; j++) {
    uint8_t x = (uint8_t)(arm * MAX_J + j);
    long g;
    long d;
    long s;
    if (wheel[arm] && j == n - 1) continue;
    g = toSteps(x, want[j]);
    d = g - goal[x];
    if (d < 0) d = -d;
    s = ms > 0 ? (d * 1000) / ms : MAX_SPEED;
    if (s > MAX_SPEED) s = MAX_SPEED;
    if (s < 20) s = 20;
    if (d * 1000 / s > longest) longest = d * 1000 / s;
    speeds[j] = (uint16_t)s;
    goal[x] = (int16_t)g;
  }
  sendGoals(arm);
  moves++;
  moveStart = millis();
  if ((unsigned long)longest > moveMs || state_now != ST_MOVING) moveMs = (unsigned long)longest;
  say(ST_MOVING);
  return 1;
}

static void report(char what) {
  uint8_t a;
  uint8_t j;
  Serial.print(what);
  for (a = 0; a < N_ARMS; a++) {
    Serial.print(" ");
    Serial.print(ARM_NAME[a]);
    for (j = 0; j < N_J[a]; j++) {
      uint8_t x = (uint8_t)(a * MAX_J + j);
      Serial.print(" ");
      if (what == 'p') Serial.print(toTenths(x, pos[x]));
      else Serial.print((long)SIGN[x] * load_[x]);
    }
  }
  Serial.println();
}

static void status() {
  uint8_t a;
  Serial.print("s state=");
  Serial.print(state_now);
  Serial.print(" estop=");
  Serial.print(estop);
  Serial.print(" volts_x10=");
  Serial.print(volts_x10);
  Serial.print(" hottest=");
  Serial.print(hottest);
  for (a = 0; a < N_ARMS; a++) {
    Serial.print(" ");
    Serial.print(ARM_NAME[a]);
    Serial.print("_ma=");
    Serial.print(arm_ma[a]);
    Serial.print(" ");
    Serial.print(ARM_NAME[a]);
    Serial.print("_on=");
    Serial.print(holding[a]);
  }
  Serial.print(" moves=");
  Serial.print(moves);
  Serial.print(" refused=");
  Serial.print(refused);
  Serial.print(" faults=");
  Serial.print(faults);
  Serial.print(" bus_errors=");
  Serial.println(bus_errors);
}

// ---------- reading a line ----------

static void skipSpaces() {
  while (line[at] == ' ') at++;
}

static uint8_t kw(const char *w) {
  uint8_t i = 0;
  skipSpaces();
  while (w[i] && tolower(line[at + i]) == w[i]) i++;
  if (w[i] == 0 && (line[at + i] == ' ' || line[at + i] == 0)) {
    at = (uint8_t)(at + i);
    return 1;
  }
  return 0;
}

static uint8_t num() {
  uint8_t neg = 0;
  uint8_t any = 0;
  long v = 0;
  skipSpaces();
  if (line[at] == '-') {
    neg = 1;
    at++;
  }
  while (isdigit(line[at])) {
    v = v * 10 + (line[at] - '0');
    at++;
    any = 1;
  }
  numv = neg ? -v : v;
  return any;
}

// which arm a line names: -1 none
static int armTok() {
  uint8_t a;
  char ch;
  skipSpaces();
  ch = (char)toupper(line[at]);
  for (a = 0; a < N_ARMS; a++) {
    if (ch == ARM_NAME[a] && (line[at + 1] == ' ' || line[at + 1] == 0)) {
      at++;
      return a;
    }
  }
  return -1;
}

static void bad() {
  Serial.println("err what? (ping, on, off, mv, j, home, stop, spin, tq, rd, ld, st, stream, setid, zero)");
}

static void run() {
  int a;
  uint8_t j;
  uint8_t ok = 1;
  at = 0;
  skipSpaces();
  if (line[at] == 0) return;
  if (kw("ping")) {
    Serial.print("ok ");
    Serial.println(FW_ID);
    return;
  }
  if (kw("on")) {
    a = armTok();
    if (estop) {
      Serial.println("err estop");
      return;
    }
    faulted = 0;
    for (j = 0; j < N_ARMS; j++) {
      if (a >= 0 && a != j) continue;
      if (!hold(j)) {
        Serial.print("err no answer from arm ");
        Serial.println(ARM_NAME[j]);
        ok = 0;
      }
    }
    if (ok) Serial.println("ok");
    say(anyHolding() ? ST_WAITING : ST_LIMP);
    return;
  }
  if (kw("off")) {
    a = armTok();
    for (j = 0; j < N_ARMS; j++)
      if (a < 0 || a == j) limp(j);
    Serial.println("ok");
    if (!estop && !faulted) say(anyHolding() ? ST_WAITING : ST_LIMP);
    return;
  }
  if (kw("mv")) {
    long ms;
    a = armTok();
    if (a < 0 || !num()) {
      bad();
      return;
    }
    ms = numv;
    for (j = 0; j < N_J[a]; j++) {
      if (!num()) {
        bad();
        return;
      }
      want[j] = numv;
    }
    if (moveArm((uint8_t)a, ms)) Serial.println("ok");
    return;
  }
  if (kw("j")) {
    uint8_t jj;
    long ang;
    a = armTok();
    if (a < 0 || !num() || numv < 1 || numv > N_J[a]) {
      bad();
      return;
    }
    jj = (uint8_t)(numv - 1);
    if (!num()) {
      bad();
      return;
    }
    ang = numv;
    for (j = 0; j < N_J[a]; j++) want[j] = toTenths((uint8_t)(a * MAX_J + j), goal[a * MAX_J + j]);
    want[jj] = ang;
    if (moveArm((uint8_t)a, num() ? numv : 0)) Serial.println("ok");
    return;
  }
  if (kw("home")) {
    long ms = num() ? numv : 2000;
    for (a = 0; a < N_ARMS; a++) {
      for (j = 0; j < N_J[a]; j++) want[j] = 0;
      if (!moveArm((uint8_t)a, ms)) ok = 0;
    }
    if (ok) Serial.println("ok");
    return;
  }
  if (kw("stop")) {
    for (a = 0; a < N_ARMS; a++) {
      if (!holding[a]) continue;
      poll((uint8_t)a);
      wheelSpeed[a] = 0;
      for (j = 0; j < N_J[a]; j++) {
        goal[a * MAX_J + j] = pos[a * MAX_J + j];
        speeds[j] = MAX_SPEED;
      }
      sendGoals((uint8_t)a);
    }
    Serial.println("ok");
    return;
  }
  if (kw("spin")) {
    uint8_t id;
    long s;
    a = armTok();
    if (a < 0 || !num()) {
      bad();
      return;
    }
    s = numv;
    id = N_J[a];
    if (!holding[a] || estop) {
      Serial.println("err limp: send on first");
      refused++;
      return;
    }
    if (s > MAX_SPEED) s = MAX_SPEED;
    if (s < -MAX_SPEED) s = -MAX_SPEED;
    s = s * SIGN[a * MAX_J + id - 1];
    wheelSpeed[a] = s < 0 ? (uint16_t)(0x8000 | (-s)) : (uint16_t)s;
    if (s != 0 && !wheel[a]) {
      // wheel mode is kept in the servo's flash: unlock, set, lock
      write8((uint8_t)a, id, 55, 0);
      write8((uint8_t)a, id, 33, 1);
      write8((uint8_t)a, id, 55, 1);
      wheel[a] = 1;
    }
    write16((uint8_t)a, id, 46, wheelSpeed[a]);
    if (s == 0 && wheel[a]) {
      delay(120);
      write8((uint8_t)a, id, 55, 0);
      write8((uint8_t)a, id, 33, 0);
      write8((uint8_t)a, id, 55, 1);
      poll((uint8_t)a);
      goal[a * MAX_J + id - 1] = pos[a * MAX_J + id - 1];
      write16((uint8_t)a, id, 42, (uint16_t)goal[a * MAX_J + id - 1]);
      wheel[a] = 0;
    }
    Serial.println("ok");
    return;
  }
  if (kw("tq")) {
    long jn;
    long pct;
    a = armTok();
    if (a < 0 || !num()) {
      bad();
      return;
    }
    jn = numv;
    if (!num() || jn < 0 || jn > N_J[a]) {
      bad();
      return;
    }
    pct = numv;
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    for (j = 0; j < N_J[a]; j++)
      if (jn == 0 || jn == j + 1) write16((uint8_t)a, (uint8_t)(j + 1), 48, (uint16_t)(pct * 10));
    Serial.println("ok");
    return;
  }
  if (kw("rd")) {
    report('p');
    return;
  }
  if (kw("ld")) {
    report('l');
    return;
  }
  if (kw("st")) {
    status();
    return;
  }
  if (kw("stream")) {
    streamHz = num() ? (uint8_t)(numv > 50 ? 50 : (numv < 0 ? 0 : numv)) : 0;
    Serial.println("ok");
    return;
  }
  if (kw("setid")) {
    long from;
    a = armTok();
    if (a < 0 || !num()) {
      bad();
      return;
    }
    from = numv;
    if (!num() || numv < 1 || numv > 253) {
      bad();
      return;
    }
    write8((uint8_t)a, (uint8_t)from, 55, 0);
    ok = write8((uint8_t)a, (uint8_t)from, 5, (uint8_t)numv);
    write8((uint8_t)a, (uint8_t)numv, 55, 1);
    Serial.println(ok ? "ok" : "err no answer");
    return;
  }
  if (kw("zero")) {
    a = armTok();
    if (a < 0 || !num() || numv < 1 || numv > N_J[a]) {
      bad();
      return;
    }
    if (holding[a]) {
      Serial.println("err holding: send off first");
      return;
    }
    // 128 to the torque switch: where it stands becomes the middle of its turn
    ok = write8((uint8_t)a, (uint8_t)numv, 40, 128);
    Serial.println(ok ? "ok" : "err no answer");
    return;
  }
  bad();
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

// ---------- watching over it ----------

static void fault(const char *why, uint8_t arm, uint8_t joint) {
  uint8_t a;
  Serial.print("err fault: ");
  Serial.print(why);
  Serial.print(" ");
  Serial.print(ARM_NAME[arm]);
  if (joint) {
    Serial.print(" ");
    Serial.print(joint);
  }
  Serial.println();
  for (a = 0; a < N_ARMS; a++) limp(a);
  faults++;
  faulted = 1;
  say(ST_FAULT);
}

static void watch() {
  uint8_t a;
  uint8_t j;
  uint8_t pressed = ESTOP_PIN >= 0 && digitalRead(ESTOP_PIN) == LOW;
  unsigned long now = millis();
  int hot = 0;
  int v = 0;
  for (a = 0; a < N_ARMS; a++) poll(a);
  if (pressed && !estop) {
    // its other contact has already cut the servos' supply
    estop = 1;
    faults++;
    for (a = 0; a < N_ARMS; a++) {
      holding[a] = 0;
      wheel[a] = 0;
    }
    Serial.println("err estop pressed");
    say(ST_ESTOP);
  } else if (!pressed && estop) {
    estop = 0;
    Serial.println("estop released: send on");
    say(ST_LIMP);
  }
  for (a = 0; a < N_ARMS; a++) {
    if (!alive[a]) continue;
    for (j = 0; j < N_J[a]; j++) {
      uint8_t x = (uint8_t)(a * MAX_J + j);
      if (!seen[x]) continue;
      if (temp[x] > hot) hot = temp[x];
      if (volt[x] > v) v = volt[x];
      if (holding[a] && !faulted && (err[x] & 0x20)) fault("overloaded", a, (uint8_t)(j + 1));
      else if (holding[a] && !faulted && (err[x] & 0x04)) fault("too hot", a, (uint8_t)(j + 1));
    }
    // the arm's wiring and fuse warm with the square of the current: over the rating they gain, under it they cool
    heat[a] += ((arm_ma[a] * arm_ma[a] - (long)ARM_MA_MAX * ARM_MA_MAX) / 1000) * LOOP_MS / 1000;
    if (heat[a] < 0 || !holding[a]) heat[a] = 0;
    if (heat[a] > ((long)ARM_MA_MAX * ARM_MA_MAX / 1000) * ARM_HEAT_S && !faulted) fault("too much current", a, 0);
  }
  hottest = hot;
  volts_x10 = v;
  if (estop || faulted) return;
  if (state_now == ST_MOVING) {
    // done once the time is up and nothing still turns
    uint8_t still = 1;
    if (now - moveStart < moveMs + 100) still = 0;
    for (a = 0; a < N_ARMS && still; a++) {
      if (!holding[a]) continue;
      for (j = 0; j < N_J[a]; j++) {
        int16_t s = spd[a * MAX_J + j];
        if (wheel[a] && j == N_J[a] - 1) continue;
        if (s > 25 || s < -25) still = 0;
      }
    }
    if (still || now - moveStart > moveMs + 4000) say(anyHolding() ? ST_WAITING : ST_LIMP);
  } else if (state_now != ST_LIMP && !anyHolding()) say(ST_LIMP);
}

void setup() {
  uint8_t a;
  Serial.begin(USB_BAUD);
  if (ESTOP_PIN >= 0) pinMode(ESTOP_PIN, INPUT_PULLUP);
  Serial1.begin(BUS_BAUD, SERIAL_8N1, BUS_RX[0], BUS_TX[0]);
  Serial1.setTimeout(4);
#if N_ARMS > 1
  Serial2.begin(BUS_BAUD, SERIAL_8N1, BUS_RX[1], BUS_TX[1]);
  Serial2.setTimeout(4);
#endif
  for (a = 0; a < N_ARMS; a++) {
    alive[a] = 0;
    holding[a] = 0;
    wheel[a] = 0;
    wheelSpeed[a] = 0;
    heat[a] = 0;
    arm_ma[a] = 0;
  }
  delay(400);
  Serial.print("kerf arms ");
  Serial.println(FW_ID);
  say(ST_LIMP);
}

void loop() {
  unsigned long now = millis();
  console();
  if (now - lastPoll >= LOOP_MS) {
    lastPoll = now;
    watch();
    if (streamHz && now - lastStream >= 1000UL / streamHz) {
      lastStream = now;
      report('p');
    }
  }
}
`;

  const wiring = pinTable.map((r) => `| ${r.signal} | ${r.pin} | ${r.wire} |`).join("\n");
  const chain = buses.map((b, i) => `- Arm ${names[i]} (${b.adapter}): ${b.servos.map((s) => `${s.id} ${s.comp}`).join(", ")}`).join("\n");
  const readme = `# ${oneLine(c.designName)}: firmware

Arduino sketch for the ${bp.name}. It is a bridge: a computer on USB sends joint moves as lines of text, the board
checks and times them and talks to the servos, one bus for each arm, at ${cNum(busBaud)} baud.

## Build

Arduino IDE 2 with the esp32 core (board: ${bp.name}); no libraries. Open \`${name}/${name}.ino\`, upload, then open the
serial monitor at ${usbBaud} baud, new line. \`ping\` answers \`ok\`.

## Pins

| Signal | Pin | Wire |
|---|---|---|
${wiring}

## Servo numbers

Every servo leaves the factory as number 1. Before it goes into the arm, plug one servo alone into the adapter and give
it its number with \`setid <arm> 1 <number>\`:

${chain}

## First run

1. \`st\` shows the supply voltage each arm's servos see and that every servo answers (bus_errors stays 0).
2. With the arm limp, hold each joint in its zero pose and send \`zero <arm> <joint>\`: the servo keeps that as the middle of its turn.
3. \`on\` takes hold softly, one arm after the other. \`j ${names[0] ?? "A"} 1 100 1000\` turns the first joint 10° in a second.
4. \`mv <arm> <ms> <angles>\` moves every joint of an arm to arrive together; \`rd\` reads them back.

A move past a joint's limit, with the e-stop pressed or with the arm limp is refused with \`err\`. The board lets go of
both arms if a servo reports overload or overheating, or an arm draws more than ${cNum(armMa / 1000)} A for long (it allows what a
fuse of that rating does: 110 % for about 19 s, 135 % for 5 s, twice the rating for just over a second).

## Joints

| Joint | From (°) | To (°) | Torque limit (% of stall) |
|---|---|---|---|
${Array.from({ length: maxJ }, (_, j) => `| ${j + 1} ${jn(j)} | ${lo[j] / 10} | ${hi[j] / 10} | ${torque[j] / 10} |`).join("\n")}
`;
  return {
    files: [
      { path: `${dir0}/${name}.ino`, content: ino },
      { path: `${dir0}/config.h`, content: config },
      { path: `${dir0}/README.md`, content: readme },
    ],
    warnings,
    pinTable,
    summary: `ESP32 sketch for ${bp.name}: ${nArms === 1 ? "one arm" : `${nArms} arms`} of smart bus servos driven from a computer over USB, with joint limits, timed moves, soft start, load and temperature readback${estop ? " and an e-stop latch" : ""}`,
  };
}
