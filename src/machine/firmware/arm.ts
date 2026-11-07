// The robot arm behaviour: firmware for a hobby-servo arm (base yaw, shoulder,
// elbow, wrist pitch and a gripper) with every pin from the design's wiring.
// It works out the joint angles for a tool point (inverse kinematics, elbow up,
// the tool's pitch held), moves in smooth straight lines in the arm's own
// cylinder (swing, reach, height) and falls back to a joint move when a line
// would leave the reach. Commands come from the serial console ("fwd 30",
// "up 20", "left 15", "goto 200 0 40", "grab", "release", "home", "wait 1"),
// from a handheld pendant (two joysticks jog it; their buttons grab, home,
// record a point and play the points back), and from a program written in the
// design's firmware block. Recorded points live in EEPROM. A latching e-stop's
// normally-open contact stops everything and lets the servos go; its
// normally-closed contact cuts the servos' supply in hardware.
// Plain C, so the simulator runs exactly what goes on the board.

import { catalogPart } from "../catalog";
import type { MachineComponent } from "../types";
import { cFloat } from "./arduino";
import { type FwContext, type GenFile, cComment, cNum, componentsOfKind, ctrlPinFor, ident, oneLine, setting } from "./common";

export const ARM_WORDS = /\b(robot(ic)?[- ]arm|pick[- ]and[- ]place|arm (jog|motion|program))/i;

export interface ArmResult {
  files: GenFile[];
  warnings: string[];
  pinTable: { signal: string; pin: string; wire: string }[];
  summary: string;
}

const JOINTS = ["base", "shoulder", "elbow", "wrist", "grip"] as const;
const JOINT_WORDS: RegExp[] = [/\b(base|waist|turntable|yaw|swing)\b/i, /\bshoulder\b/i, /\belbow\b/i, /\b(wrist|pitch)\b/i, /\b(grip|gripper|claw|jaw|hand|pincer)\b/i];
/** each joint's angle in the design pose: base heading 0, upper arm up (90 from horizontal), forearm level (-90 from the upper arm), tool down (-90 from the forearm) */
const POSE = [0, 90, -90, -90];

/** commands the console and a program take (the program is checked against these) */
const COMMANDS = ["help", "stop", "reset", "home", "goto", "fwd", "forward", "back", "backward", "up", "down", "left", "right", "move", "pitch", "grab", "grip", "close", "release", "open", "drop", "wait", "speed", "where", "rec", "record", "list", "clear", "play", "run", "joint", "trim", "centre", "center", "log"];

export function armFirmware(c: FwContext): ArmResult {
  const warnings: string[] = [];
  const pinTable: ArmResult["pinTable"] = [];
  const board = c.board.name;
  const bp = c.boardPart;
  const esp = /esp32/i.test(String(bp.specs.mcu ?? "")) || bp.id.startsWith("esp32") || bp.id.startsWith("feather_esp32");
  const pinOf = (comp: string, pin: string) => ctrlPinFor(c, comp, pin);
  const note = (signal: string, comp: string, pin: string): string => {
    const r = pinOf(comp, pin);
    if (!r) return "-1";
    pinTable.push({ signal, pin: r.pin.label ? `${r.pin.label} (${r.pin.mcu ?? r.pin.id})` : r.pin.id, wire: `${comp}.${pin}` });
    return String(r.pin.mcu ?? r.pin.id);
  };

  // ---- the servos, by role (or name or label), the rest in name order
  const servos = componentsOfKind(c, "servo").sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const words = (s: MachineComponent) => `${s.role ?? ""} ${s.name} ${s.label}`;
  const byJoint: (MachineComponent | undefined)[] = JOINT_WORDS.map(() => undefined);
  const taken = new Set<MachineComponent>();
  JOINT_WORDS.forEach((re, j) => {
    const s = servos.find((x) => !taken.has(x) && re.test(words(x)));
    if (s) {
      byJoint[j] = s;
      taken.add(s);
    }
  });
  const rest = servos.filter((s) => !taken.has(s));
  for (let j = 0; j < 5 && rest.length; j++) if (!byJoint[j]) byJoint[j] = rest.shift();
  if (rest.length) warnings.push(`${rest.map((s) => s.name).join(", ")}: the arm drives five servos (base, shoulder, elbow, wrist, gripper); ${rest.length === 1 ? "this one is" : "these are"} left out.`);
  const svPins = byJoint.map((s, j) => (s ? note(`${JOINTS[j]} servo`, s.name, "SIG") : "-1"));
  byJoint.forEach((s, j) => {
    if (!s) warnings.push(`No ${JOINTS[j]} servo in the design (give one role: "${JOINTS[j]}"): that joint stays still.`);
    else if (svPins[j] === "-1") warnings.push(`${s.name} (${JOINTS[j]}): its signal wire reaches no ${board} pin, so the firmware cannot move it.`);
  });
  const range = byJoint.map((s) => Number((s && catalogPart(s.catalogId)?.specs.range_deg) ?? 180));

  // ---- the pendant: joysticks (in name order, or by role "left"/"right") and the e-stop
  const sticks = c.m.components.filter((x) => catalogPart(x.catalogId)?.specs.iface === "joystick").sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (sticks.length === 2 && /\bright\b/i.test(words(sticks[0])) && !/\bright\b/i.test(words(sticks[1]))) sticks.reverse();
  const j1 = sticks[0];
  const j2 = sticks[1];
  const stickPins = (s: MachineComponent | undefined, n: number) => (s ? [note(`joystick ${n} X`, s.name, "VRX"), note(`joystick ${n} Y`, s.name, "VRY"), note(`joystick ${n} button`, s.name, "SW")] : ["-1", "-1", "-1"]);
  const [j1x, j1y, j1sw] = stickPins(j1, 1);
  const [j2x, j2y, j2sw] = stickPins(j2, 2);
  if (!sticks.length) warnings.push("No joystick in the design: the arm moves only from the serial console and its program.");
  else if (sticks.length === 1) warnings.push(`One joystick (${j1!.name}): it swings and reaches; up and down and the tool's pitch come from the console only.`);
  if (sticks.length > 2) warnings.push(`${sticks.slice(2).map((s) => s.name).join(", ")}: the pendant uses two joysticks; the others are left out.`);
  for (const [s, ps] of [
    [j1, [j1x, j1y]],
    [j2, [j2x, j2y]],
  ] as const)
    if (s && ps.includes("-1")) warnings.push(`${s.name}: VRX and VRY must both reach analog pins on ${board} to jog with it.`);

  let estopPin = "-1";
  let estop: MachineComponent | undefined;
  for (const sw of componentsOfKind(c, "switch")) {
    const part = catalogPart(sw.catalogId)!;
    if (!part.specs.latching) continue;
    for (const p of part.pins.filter((x) => x.type === "passive" && !x.through)) {
      if (estopPin !== "-1") break;
      const r = pinOf(sw.name, p.id);
      if (r) {
        estopPin = note("e-stop (LOW = pressed)", sw.name, p.id);
        estop = sw;
      }
    }
  }
  if (estopPin === "-1") warnings.push("No latching e-stop's normally-open contact reaches a controller pin: the firmware cannot see the stop (wire its NC contact in the servo supply so it still cuts them).");
  const led = String(bp.specs.led_builtin ?? (esp ? 13 : 13));

  // ---- settings
  const S = {
    l1: setting(c.fw, "l1", 140),
    l2: setting(c.fw, "l2", 140),
    tool: setting(c.fw, "tool", 70),
    shoulderZ: setting(c.fw, "shoulder_z", 120),
    shoulderX: setting(c.fw, "shoulder_x", 0),
    speed: setting(c.fw, "speed", 100),
    accel: setting(c.fw, "accel", 400),
    jointSpeed: setting(c.fw, "joint_speed", 90),
    jog: setting(c.fw, "jog_speed", 80),
    jogTurn: setting(c.fw, "jog_turn", 45),
    pitch: setting(c.fw, "pitch", -90),
    zMin: setting(c.fw, "z_min", 5),
    rMin: setting(c.fw, "r_min", 60),
    gripOpen: setting(c.fw, "grip_open_deg", 40),
    gripClosed: setting(c.fw, "grip_closed_deg", 140),
    gripOpenMm: setting(c.fw, "grip_open_mm", 50),
    squeeze: setting(c.fw, "grip_squeeze_mm", 3),
    gripMs: setting(c.fw, "grip_ms", 600),
    minUs: setting(c.fw, "servo_min_us", 500),
    maxUs: setting(c.fw, "servo_max_us", 2500),
    autorun: setting(c.fw, "autorun", false),
  };
  const num4 = (key: string, def: number[]): number[] => {
    const raw = c.fw.settings[key];
    if (raw === undefined) return def;
    const xs = String(raw)
      .split(/[,\s]+/)
      .filter(Boolean)
      .map(Number);
    if (xs.length === def.length && xs.every(Number.isFinite)) return xs;
    warnings.push(`${key}: give ${def.length} numbers (like "${def.join(", ")}"); using ${def.join(", ")}.`);
    return def;
  };
  // the servo angle each joint sits at in the design pose (the horn goes on there), and which way a longer pulse turns it
  const zero = JOINTS.map((j, i) => setting(c.fw, `zero_${j}`, i === 4 ? S.gripOpen : range[i] / 2));
  const dir = JOINTS.slice(0, 4).map((j) => (setting(c.fw, `dir_${j}`, 1) < 0 ? -1 : 1));
  // joint limits: the servo's own travel (2° in from each end), cut down by any the design sets
  const lim = [0, 1, 2, 3].map((i) => {
    const a = POSE[i] + dir[i] * (2 - zero[i]);
    const b = POSE[i] + dir[i] * (range[i] - 2 - zero[i]);
    let lo = Math.min(a, b);
    let hi = Math.max(a, b);
    const j = JOINTS[i];
    if (c.fw.settings[`${j}_min`] !== undefined) lo = Math.max(lo, setting(c.fw, `${j}_min`, lo));
    if (c.fw.settings[`${j}_max`] !== undefined) hi = Math.min(hi, setting(c.fw, `${j}_max`, hi));
    if (lo >= hi) {
      warnings.push(`${j}_min and ${j}_max leave the ${j} no room inside its servo's travel: using the servo's travel.`);
      return [Math.min(a, b), Math.max(a, b)];
    }
    return [lo, hi];
  });
  // home: the design pose by default (where the arm is parked when it powers up)
  const designR = S.shoulderX + S.l2 + S.tool * Math.cos((S.pitch * Math.PI) / 180);
  const designZ = S.shoulderZ + S.l1 + S.tool * Math.sin((S.pitch * Math.PI) / 180);
  const home = num4("home", [Math.round(designR * 10) / 10, 0, Math.round(designZ * 10) / 10]);

  // the program: commands separated by ; or new lines, checked here so a typo shows in Kerf, not on the bench
  const rawProg = String(c.fw.settings.program ?? "");
  const prog = rawProg
    .toLowerCase()
    .split(/[;\n]+/)
    .map((s) => s.replace(/[^a-z0-9 .,-]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const bad = prog.filter((s) => !COMMANDS.includes(s.split(" ")[0]) || ["run", "play", "rec", "record", "clear", "trim", "centre", "center", "joint"].includes(s.split(" ")[0]));
  if (bad.length) warnings.push(`program: ${bad.map((b) => `"${oneLine(b, 30)}"`).join(", ")} ${bad.length === 1 ? "is not a command a program can run" : "are not commands a program can run"} (see the README): the arm skips ${bad.length === 1 ? "it" : "them"}.`);
  let progText = prog.filter((s) => !bad.includes(s)).join(";");
  if (progText.length > 480) {
    warnings.push(`program: ${progText.length} characters is more than the board keeps (480): the end is cut off. Record the points with the pendant instead (they go in EEPROM).`);
    progText = progText.slice(0, 480).replace(/;[^;]*$/, "");
  }
  if (!progText && S.autorun) warnings.push("autorun is on but the program is empty: nothing runs at power-up.");

  const name = ident(c.fw.name).toLowerCase() || "robot_arm";
  const dir0 = `firmware/${name}`;
  const f = (n: number) => cFloat(Math.round(n * 1000) / 1000);
  const servoLib = esp ? "ESP32Servo.h" : "Servo.h";

  const config = `// ${cComment(c.designName)}: pins, arm sizes and motion settings for ${cComment(c.fw.name)}.
// Generated by Kerf from the design's wiring and its firmware block. Scenarios change the #defines.
#pragma once
#include <Arduino.h>

// ---- pins (${cComment(bp.name)}), from the wiring (-1: not wired)
#define PIN_BASE ${svPins[0]}
#define PIN_SHOULDER ${svPins[1]}
#define PIN_ELBOW ${svPins[2]}
#define PIN_WRIST ${svPins[3]}
#define PIN_GRIP ${svPins[4]}
#define PIN_J1X ${j1x}
#define PIN_J1Y ${j1y}
#define PIN_J1SW ${j1sw}
#define PIN_J2X ${j2x}
#define PIN_J2Y ${j2y}
#define PIN_J2SW ${j2sw}
#define PIN_ESTOP ${estopPin}
#define PIN_LED ${led}
#define ADC_MAX ${esp ? 4095 : 1023}

// ---- the arm (mm): shoulder to elbow, elbow to wrist, wrist axis to the grip point between the jaws,
// and the shoulder axis's height above the base board and its offset out from the base axis
#define L1 ${f(S.l1)}
#define L2 ${f(S.l2)}
#define TOOL ${f(S.tool)}
#define SHOULDER_Z ${f(S.shoulderZ)}
#define SHOULDER_X ${f(S.shoulderX)}

// ---- servos: pulse for 0° and for the servo's full travel
#define SERVO_MIN_US ${Math.round(S.minUs)}
#define SERVO_MAX_US ${Math.round(S.maxUs)}
// base, shoulder, elbow, wrist, gripper: travel (deg), the angle each sits at in the design pose (fit the
// horns there: "centre"), and which way a longer pulse turns the joint (+1 the way the drawing's arrows show)
static const float RANGE_DEG[5] = {${range.map(f).join(", ")}};
static const float ZERO_DEG[5] = {${zero.map(f).join(", ")}};
static const float DIR[4] = {${dir.map(f).join(", ")}};
// joint limits (deg): base swing from the design heading, shoulder up from level, elbow and wrist bend
static const float J_MIN[4] = {${lim.map((l) => f(l[0])).join(", ")}};
static const float J_MAX[4] = {${lim.map((l) => f(l[1])).join(", ")}};

// ---- gripper: servo angles fully open and closed (jaws touching), the opening when open, how far past a
// given width "grab <mm>" squeezes, and how long a full close takes
#define GRIP_OPEN_DEG ${f(S.gripOpen)}
#define GRIP_CLOSED_DEG ${f(S.gripClosed)}
#define GRIP_OPEN_MM ${f(S.gripOpenMm)}
#define GRIP_SQUEEZE_MM ${f(S.squeeze)}
#define GRIP_MS ${Math.round(S.gripMs)}

// ---- motion
#define SPEED_MM_S ${f(S.speed)}
#define ACCEL_MM_S2 ${f(S.accel)}
#define JOINT_DEG_S ${f(S.jointSpeed)}
#define JOG_MM_S ${f(S.jog)}
#define JOG_DEG_S ${f(S.jogTurn)}
#define PITCH_DEG ${f(S.pitch)}
#define HOME_X ${f(home[0])}
#define HOME_Y ${f(home[1])}
#define HOME_Z ${f(home[2])}
// the lowest the grip point goes (above the board), and the closest it comes to the base axis
#define Z_MIN ${f(S.zMin)}
#define R_MIN ${f(S.rMin)}
// joystick dead band (share of full throw) and which way each axis jogs (+1 or -1)
#define DEADBAND 0.08f
#define J1X_DIR 1
#define J1Y_DIR 1
#define J2X_DIR 1
#define J2Y_DIR 1
#define TICK_MS 20
#define LONG_PRESS_MS 800
#define MAX_POINTS 60
#define AUTORUN ${S.autorun && progText ? 1 : 0}

// ---- the program "run" plays (from the design's firmware block)
static const char PROGRAM[] PROGMEM = "${progText}";
`;

  const ino = `// ${cComment(c.designName)}: robot arm firmware for the ${cComment(bp.name)}, generated by Kerf.
//
// Five hobby servos: base swing, shoulder, elbow, wrist pitch and the gripper. Every 20 ms it works out the
// joint angles for the grip point (inverse kinematics, elbow up, the tool's pitch held), moving in smooth
// straight lines in the arm's own cylinder (swing, reach, height) or, when a line would leave the reach,
// joint by joint. Commands: the USB serial console (115200, type "help"), the pendant's two joysticks
// (left: swing and reach, right: height and tool pitch; left button: grab or let go, hold it: home; right
// button: record a point, hold it: play the points back) and the program in config.h ("run").
// Safety: the e-stop latches a fault and lets every servo go (its NC contact also cuts their supply);
// moves outside the reach, below Z_MIN or past a joint limit are refused before they start.
//
// Board: ${cComment(String(bp.specs.fqbn ?? bp.name))}.${esp ? " Library: ESP32Servo (Kevin Harrington)." : ""}
#include <Arduino.h>
#include <${servoLib}>
#include <EEPROM.h>
#include "config.h"

#define DEG 0.01745329252f
#define NQ 6
#define EE_MAGIC 0xA7
#define EE_TRIM 2
#define EE_COUNT 12
#define EE_POINTS 16

Servo sBase;
Servo sShoulder;
Servo sElbow;
Servo sWrist;
Servo sGrip;
const int SV_PIN[5] = {PIN_BASE, PIN_SHOULDER, PIN_ELBOW, PIN_WRIST, PIN_GRIP};
const float POSE[4] = {${POSE.map(f).join(", ")}};
float trim[5] = {0, 0, 0, 0, 0};

// the grip point now (x, y, z mm, pitch deg, grip 0 open .. 1 closed) and the joints that put it there
float cur[5];
float jq[4];
// after everything queued: relative commands start from here
float endP[5];

// the queue of moves
enum { Q_LINE, Q_JOINT, Q_GRIP, Q_WAIT };
uint8_t qType[NQ];
float qVal[NQ][5];
uint8_t qHead = 0;
uint8_t qCount = 0;

// the move under way
int8_t mvType = -1;
float mvFrom[5];
float mvTo[5];
float mvT = 0;
unsigned long mvStart = 0;

// what it is doing
enum { S_READY, S_MOVING, S_PROGRAM, S_PLAY, S_JOG, S_FAULT, S_DONE };
uint8_t st = S_READY;
uint8_t shownSt = 255;
bool attached = false;
int progPos = -1;
int playIdx = -1;
int playLoops = 0;
int nPoints = 0;
float speedMm = SPEED_MM_S;
bool logOn = false;

// counts the simulator (and "where") reads
long moves = 0;
long refused = 0;
long faults = 0;

// the pendant
float centre[4] = {ADC_MAX / 2.0f, ADC_MAX / 2.0f, ADC_MAX / 2.0f, ADC_MAX / 2.0f};
float jogV[4] = {0, 0, 0, 0};
unsigned long jogIdleAt = 0;
bool btnDown[2] = {false, false};
bool btnLong[2] = {false, false};
unsigned long btnAt[2] = {0, 0};

// the console, and the program's command being run
char line[48];
char pline[48];
uint8_t lineLen = 0;
unsigned long lastTick = 0;

// ---------------------------------------------------------------- servos
void svWrite(uint8_t j, int us) {
  switch (j) {
    case 0: sBase.writeMicroseconds(us); break;
    case 1: sShoulder.writeMicroseconds(us); break;
    case 2: sElbow.writeMicroseconds(us); break;
    case 3: sWrist.writeMicroseconds(us); break;
    default: sGrip.writeMicroseconds(us); break;
  }
}

void svAttach(uint8_t j) {
  if (SV_PIN[j] < 0) return;
  switch (j) {
    case 0: sBase.attach(SV_PIN[j], SERVO_MIN_US, SERVO_MAX_US); break;
    case 1: sShoulder.attach(SV_PIN[j], SERVO_MIN_US, SERVO_MAX_US); break;
    case 2: sElbow.attach(SV_PIN[j], SERVO_MIN_US, SERVO_MAX_US); break;
    case 3: sWrist.attach(SV_PIN[j], SERVO_MIN_US, SERVO_MAX_US); break;
    default: sGrip.attach(SV_PIN[j], SERVO_MIN_US, SERVO_MAX_US); break;
  }
}

void svDetachAll() {
  sBase.detach();
  sShoulder.detach();
  sElbow.detach();
  sWrist.detach();
  sGrip.detach();
  attached = false;
}

// a servo angle (deg) as a pulse
void writeServoDeg(uint8_t j, float s) {
  if (s < 0) s = 0;
  if (s > RANGE_DEG[j]) s = RANGE_DEG[j];
  svWrite(j, SERVO_MIN_US + (int)(s / RANGE_DEG[j] * (SERVO_MAX_US - SERVO_MIN_US) + 0.5f));
}

float servoDeg(uint8_t j, float q) {
  return ZERO_DEG[j] + trim[j] + DIR[j] * (q - POSE[j]);
}

float gripDeg(float g) {
  return GRIP_OPEN_DEG + trim[4] + g * (GRIP_CLOSED_DEG - GRIP_OPEN_DEG);
}

void writeArm(const float *q, float g) {
  for (uint8_t j = 0; j < 4; j++) writeServoDeg(j, servoDeg(j, q[j]));
  writeServoDeg(4, gripDeg(g));
}

// ---------------------------------------------------------------- kinematics
// joints (deg) to the grip point: x, y, z (mm) and pitch (deg)
void fk(const float *q, float *p) {
  float t1 = q[1] * DEG;
  float b = (q[1] + q[2]) * DEG;
  float ph = (q[1] + q[2] + q[3]) * DEG;
  float r = SHOULDER_X + L1 * cos(t1) + L2 * cos(b) + TOOL * cos(ph);
  p[0] = r * cos(q[0] * DEG);
  p[1] = r * sin(q[0] * DEG);
  p[2] = SHOULDER_Z + L1 * sin(t1) + L2 * sin(b) + TOOL * sin(ph);
  p[3] = q[1] + q[2] + q[3];
}

float wrap180(float a) {
  while (a > 180) a -= 360;
  while (a <= -180) a += 360;
  return a;
}

// 0: fine; 1 too far; 2 too close to the base; 3 below Z_MIN; 4 + j: past joint j's limit
uint8_t ikCyl(float psi, float r, float z, float pitch, float *q) {
  if (z < Z_MIN) return 3;
  if (r < R_MIN) return 2;
  float pr = pitch * DEG;
  float wr = r - SHOULDER_X - TOOL * cos(pr);
  float wz = z - TOOL * sin(pr) - SHOULDER_Z;
  float d = sqrt(wr * wr + wz * wz);
  if (d > L1 + L2 - 0.5f) return 1;
  if (d < fabs(L1 - L2) + 5.0f) return 2;
  float c = (L1 * L1 + d * d - L2 * L2) / (2.0f * L1 * d);
  if (c > 1) c = 1;
  if (c < -1) c = -1;
  float t1 = atan2(wz, wr) + acos(c);
  float ex = L1 * cos(t1);
  float ez = L1 * sin(t1);
  float b = atan2(wz - ez, wr - ex);
  q[0] = wrap180(psi);
  q[1] = t1 / DEG;
  q[2] = wrap180((b - t1) / DEG);
  q[3] = wrap180((pr - b) / DEG);
  // the elbow and the wrist stay above the board too
  if (SHOULDER_Z + ez < Z_MIN || SHOULDER_Z + wz < Z_MIN) return 3;
  for (uint8_t j = 0; j < 4; j++)
    if (q[j] < J_MIN[j] - 0.01f || q[j] > J_MAX[j] + 0.01f) return 4 + j;
  return 0;
}

uint8_t ik(const float *p, float *q) {
  return ikCyl(atan2(p[1], p[0]) / DEG, sqrt(p[0] * p[0] + p[1] * p[1]), p[2], p[3], q);
}

void sayWhy(uint8_t e) {
  if (e == 1) Serial.print(F("out of reach"));
  else if (e == 2) Serial.print(F("too close to the base"));
  else if (e == 3) Serial.print(F("below the lowest it may go (Z_MIN)"));
  else {
    Serial.print(F("past the "));
    if (e == 4) Serial.print(F("base"));
    else if (e == 5) Serial.print(F("shoulder"));
    else if (e == 6) Serial.print(F("elbow"));
    else Serial.print(F("wrist"));
    Serial.print(F("'s limit"));
  }
}

// ---------------------------------------------------------------- the queue
bool push(uint8_t type, float a, float b, float c, float d, float e) {
  if (qCount >= NQ) {
    Serial.println(F("busy: the queue is full, wait for a move to finish"));
    return false;
  }
  uint8_t i = (qHead + qCount) % NQ;
  qType[i] = type;
  qVal[i][0] = a;
  qVal[i][1] = b;
  qVal[i][2] = c;
  qVal[i][3] = d;
  qVal[i][4] = e;
  qCount++;
  return true;
}

// a move to a grip point, checked now: refused (and nothing queued) when it cannot be reached
bool queueTo(float x, float y, float z, float pitch) {
  float p[4] = {x, y, z, pitch};
  float q[4];
  uint8_t e = ik(p, q);
  if (e) {
    Serial.print(F("can't go to "));
    Serial.print(x, 0);
    Serial.print(' ');
    Serial.print(y, 0);
    Serial.print(' ');
    Serial.print(z, 0);
    Serial.print(F(": "));
    sayWhy(e);
    Serial.println();
    return false;
  }
  if (!push(Q_LINE, x, y, z, pitch, 0)) return false;
  endP[0] = x;
  endP[1] = y;
  endP[2] = z;
  endP[3] = pitch;
  return true;
}

bool queueCyl(float psi, float r, float z, float pitch) {
  return queueTo(r * cos(psi * DEG), r * sin(psi * DEG), z, pitch);
}

bool queueGrip(float g) {
  if (g < 0) g = 0;
  if (g > 1.08f) g = 1.08f;
  if (!push(Q_GRIP, g, 0, 0, 0, 0)) return false;
  endP[4] = g;
  return true;
}

void clearQueue() {
  qCount = 0;
  mvType = -1;
  progPos = -1;
  playIdx = -1;
  for (uint8_t i = 0; i < 5; i++) endP[i] = cur[i];
}

// ---------------------------------------------------------------- moves
float smooth(float u) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return u * u * (3 - 2 * u);
}

// the time a smooth move of D mm takes at speed v and acceleration a
float moveTime(float D, float v) {
  float t1 = 1.5f * D / v;
  float t2 = sqrt(6.0f * D / ACCEL_MM_S2);
  float t = t1 > t2 ? t1 : t2;
  return t < 0.1f ? 0.1f : t;
}

void toCyl(const float *p, float *c) {
  c[0] = atan2(p[1], p[0]) / DEG;
  c[1] = sqrt(p[0] * p[0] + p[1] * p[1]);
  c[2] = p[2];
  c[3] = p[3];
}

bool startMove() {
  uint8_t i = qHead;
  uint8_t type = qType[i];
  float v[5];
  for (uint8_t k = 0; k < 5; k++) v[k] = qVal[i][k];
  qHead = (qHead + 1) % NQ;
  qCount--;
  mvStart = millis();
  if (type == Q_WAIT) {
    mvType = Q_WAIT;
    mvT = v[0] < 0.02f ? 0.02f : v[0];
    return true;
  }
  if (type == Q_GRIP) {
    mvType = Q_GRIP;
    mvFrom[4] = cur[4];
    mvTo[4] = v[0];
    mvT = fabs(v[0] - cur[4]) * GRIP_MS / 1000.0f + 0.15f;
    return true;
  }
  // a straight line in (swing, reach, height, pitch) if every point on it can be reached, else joint by joint
  float a[4], b[4], q[4], qb[4];
  toCyl(cur, a);
  toCyl(v, b);
  b[0] = a[0] + wrap180(b[0] - a[0]);
  bool line = true;
  for (uint8_t k = 1; k <= 8 && line; k++) {
    float s = k / 8.0f;
    if (ikCyl(a[0] + s * (b[0] - a[0]), a[1] + s * (b[1] - a[1]), a[2] + s * (b[2] - a[2]), a[3] + s * (b[3] - a[3]), q)) line = false;
  }
  if (ik(v, qb)) {
    Serial.println(F("can't reach the next point any more: stopped"));
    refused++;
    clearQueue();
    return false;
  }
  float dq = 0;
  for (uint8_t j = 0; j < 4; j++) {
    float d = fabs(qb[j] - jq[j]);
    if (d > dq) dq = d;
  }
  float tj = 1.5f * dq / JOINT_DEG_S;
  if (line) {
    float rr = a[1] > b[1] ? a[1] : b[1];
    float D = fabs(b[1] - a[1]);
    float d2 = fabs(b[2] - a[2]);
    float d3 = fabs(b[0] - a[0]) * DEG * rr;
    float d4 = fabs(b[3] - a[3]) * DEG * TOOL;
    if (d2 > D) D = d2;
    if (d3 > D) D = d3;
    if (d4 > D) D = d4;
    mvType = Q_LINE;
    for (uint8_t k = 0; k < 4; k++) {
      mvFrom[k] = a[k];
      mvTo[k] = b[k];
    }
    mvT = moveTime(D, speedMm);
    if (tj > mvT) mvT = tj;
  } else {
    // joint by joint: check the grip point stays above the board and clear of the base on the way
    float p[4];
    for (uint8_t k = 1; k < 8; k++) {
      float s = k / 8.0f;
      for (uint8_t j = 0; j < 4; j++) q[j] = jq[j] + s * (qb[j] - jq[j]);
      fk(q, p);
      if (p[2] < Z_MIN || sqrt(p[0] * p[0] + p[1] * p[1]) < R_MIN) {
        Serial.println(F("can't get there from here without hitting the board or the base: try home first"));
        refused++;
        clearQueue();
        return false;
      }
    }
    mvType = Q_JOINT;
    for (uint8_t j = 0; j < 4; j++) {
      mvFrom[j] = jq[j];
      mvTo[j] = qb[j];
    }
    mvT = tj < 0.2f ? 0.2f : tj;
  }
  return true;
}

// one tick of the move under way; true when it has finished
bool stepMove(unsigned long now) {
  float u = (now - mvStart) / 1000.0f / mvT;
  float s = smooth(u);
  if (mvType == Q_GRIP) {
    cur[4] = mvFrom[4] + s * (mvTo[4] - mvFrom[4]);
    writeServoDeg(4, gripDeg(cur[4]));
  } else if (mvType == Q_LINE) {
    float c[4], q[4];
    for (uint8_t k = 0; k < 4; k++) c[k] = mvFrom[k] + s * (mvTo[k] - mvFrom[k]);
    if (ikCyl(c[0], c[1], c[2], c[3], q) == 0) {
      for (uint8_t j = 0; j < 4; j++) jq[j] = q[j];
      fk(jq, cur);
      for (uint8_t j = 0; j < 4; j++) writeServoDeg(j, servoDeg(j, jq[j]));
    }
  } else if (mvType == Q_JOINT) {
    for (uint8_t j = 0; j < 4; j++) jq[j] = mvFrom[j] + s * (mvTo[j] - mvFrom[j]);
    fk(jq, cur);
    for (uint8_t j = 0; j < 4; j++) writeServoDeg(j, servoDeg(j, jq[j]));
  }
  if (u < 1) return false;
  if (mvType != Q_WAIT) moves++;
  mvType = -1;
  return true;
}

// ---------------------------------------------------------------- recorded points (EEPROM)
void eeCommit() {
#if defined(ESP32)
  EEPROM.commit();
#endif
}

void savePoint(int i, const float *p) {
  int a = EE_POINTS + i * 8;
  int16_t x = (int16_t)(p[0] * 10);
  int16_t y = (int16_t)(p[1] * 10);
  int16_t z = (int16_t)(p[2] * 10);
  EEPROM.put(a, x);
  EEPROM.put(a + 2, y);
  EEPROM.put(a + 4, z);
  EEPROM.write(a + 6, (uint8_t)(int8_t)p[3]);
  EEPROM.write(a + 7, (uint8_t)(p[4] * 200));
}

void loadPoint(int i, float *p) {
  int a = EE_POINTS + i * 8;
  int16_t x, y, z;
  EEPROM.get(a, x);
  EEPROM.get(a + 2, y);
  EEPROM.get(a + 4, z);
  p[0] = x / 10.0f;
  p[1] = y / 10.0f;
  p[2] = z / 10.0f;
  p[3] = (int8_t)EEPROM.read(a + 6);
  p[4] = EEPROM.read(a + 7) / 200.0f;
}

void saveCount() {
  EEPROM.write(0, EE_MAGIC);
  EEPROM.write(EE_COUNT, (uint8_t)nPoints);
  eeCommit();
}

void saveTrims() {
  EEPROM.write(0, EE_MAGIC);
  for (uint8_t j = 0; j < 5; j++) {
    int16_t t = (int16_t)(trim[j] * 10);
    EEPROM.put(EE_TRIM + j * 2, t);
  }
  eeCommit();
}

void loadSaved() {
  if (EEPROM.read(0) != EE_MAGIC) {
    nPoints = 0;
    return;
  }
  for (uint8_t j = 0; j < 5; j++) {
    int16_t t;
    EEPROM.get(EE_TRIM + j * 2, t);
    trim[j] = (t > -300 && t < 300) ? t / 10.0f : 0;
  }
  nPoints = EEPROM.read(EE_COUNT);
  if (nPoints > MAX_POINTS) nPoints = 0;
}

void printPoint(int i, const float *p) {
  Serial.print(F("point "));
  Serial.print(i + 1);
  Serial.print(F(": "));
  Serial.print(p[0], 0);
  Serial.print(' ');
  Serial.print(p[1], 0);
  Serial.print(' ');
  Serial.print(p[2], 0);
  Serial.print(F(" pitch "));
  Serial.print(p[3], 0);
  if (p[4] > 0.5f) Serial.println(F(" (holding)"));
  else Serial.println(F(" (open)"));
}

void record() {
  if (nPoints >= MAX_POINTS) {
    Serial.println(F("all points used: \\"clear\\" first"));
    refused++;
    return;
  }
  const float *p = qCount || mvType >= 0 ? endP : cur;
  savePoint(nPoints, p);
  nPoints++;
  saveCount();
  printPoint(nPoints - 1, p);
}

// ---------------------------------------------------------------- state and safety
void showState() {
  if (st == shownSt) return;
  shownSt = st;
  Serial.print(F("state: "));
  switch (st) {
    case S_READY: Serial.println(F("ready")); break;
    case S_MOVING: Serial.println(F("moving")); break;
    case S_PROGRAM: Serial.println(F("running the program")); break;
    case S_PLAY: Serial.println(F("playing the recorded points")); break;
    case S_JOG: Serial.println(F("jogging from the pendant")); break;
    case S_FAULT: Serial.println(F("fault (e-stop)")); break;
    default: Serial.println(F("done")); break;
  }
}

void fault() {
  clearQueue();
  svDetachAll();
  st = S_FAULT;
  faults++;
  Serial.println(F("FAULT: e-stop pressed. The servos are let go. Twist the e-stop to release it, put the arm back near where it stopped, then type reset (or hold the left stick's button)."));
}

void resetFault() {
  if (PIN_ESTOP >= 0 && digitalRead(PIN_ESTOP) == LOW) {
    Serial.println(F("the e-stop is still pressed: twist it to release it first"));
    return;
  }
  writeArm(jq, cur[4]);
  for (uint8_t j = 0; j < 5; j++) svAttach(j);
  writeArm(jq, cur[4]);
  attached = true;
  st = S_READY;
  Serial.println(F("reset: the servos hold where the arm was"));
}

// ---------------------------------------------------------------- commands
int8_t jointOf(const char *w) {
  if (!strcmp(w, "base") || !strcmp(w, "1")) return 0;
  if (!strcmp(w, "shoulder") || !strcmp(w, "2")) return 1;
  if (!strcmp(w, "elbow") || !strcmp(w, "3")) return 2;
  if (!strcmp(w, "wrist") || !strcmp(w, "4")) return 3;
  if (!strcmp(w, "grip") || !strcmp(w, "gripper") || !strcmp(w, "5")) return 4;
  return -1;
}

void help() {
  Serial.println(F("fwd/back <mm>, up/down <mm>, left/right <deg>: jog (20 mm or 15 deg without a number)"));
  Serial.println(F("goto <x> <y> <z> [pitch]: go to a point (mm from the base axis on the board)"));
  Serial.println(F("move <dx> <dy> <dz>, pitch <deg>, home, grab [width mm], release, wait <s>, speed <mm/s>"));
  Serial.println(F("rec, list, clear, play [times, 0 = forever], run (the program), stop, where, log"));
  Serial.println(F("centre (all servos to the design pose, to fit the horns), trim <joint> <deg>, joint <joint> <deg>, reset"));
}

void where() {
  Serial.print(F("at "));
  Serial.print(cur[0], 1);
  Serial.print(' ');
  Serial.print(cur[1], 1);
  Serial.print(' ');
  Serial.print(cur[2], 1);
  Serial.print(F(" pitch "));
  Serial.print(cur[3], 0);
  Serial.print(F(", grip "));
  Serial.print(cur[4] * 100, 0);
  Serial.print(F(" %; joints"));
  for (uint8_t j = 0; j < 4; j++) {
    Serial.print(' ');
    Serial.print(jq[j], 1);
  }
  Serial.print(F("; "));
  Serial.print(nPoints);
  Serial.println(F(" points saved"));
}

bool exec(char *s, bool fromProgram) {
  while (*s == ' ') s++;
  if (!*s) return true;
  char *w = s;
  char *a = s;
  while (*a && *a != ' ') a++;
  if (*a) *a++ = 0;
  char *arg = a;
  float n[4] = {0, 0, 0, 0};
  uint8_t nn = 0;
  while (nn < 4) {
    while (*a == ' ' || *a == ',') a++;
    if (!*a) break;
    n[nn++] = atof(a);
    while (*a && *a != ' ' && *a != ',') a++;
  }
  if (st == S_FAULT && strcmp(w, "reset") && strcmp(w, "where") && strcmp(w, "help")) {
    Serial.println(F("fault: release the e-stop and type reset first"));
    refused++;
    return false;
  }
  if (fromProgram) {
    Serial.print(F("> "));
    Serial.print(w);
    if (*arg) {
      Serial.print(' ');
      Serial.print(arg);
    }
    Serial.println();
  }
  bool ok = true;
  if (!strcmp(w, "help") || !strcmp(w, "?")) help();
  else if (!strcmp(w, "stop")) {
    clearQueue();
    st = S_READY;
    Serial.println(F("stopped"));
  } else if (!strcmp(w, "reset")) {
    if (st == S_FAULT) resetFault();
  } else if (!strcmp(w, "where")) where();
  else if (!strcmp(w, "log")) logOn = !logOn;
  else if (!strcmp(w, "home")) ok = queueTo(HOME_X, HOME_Y, HOME_Z, PITCH_DEG);
  else if (!strcmp(w, "goto")) {
    if (nn < 3) {
      Serial.println(F("goto needs x y z, like goto 200 0 40"));
      ok = false;
    } else ok = queueTo(n[0], n[1], n[2], nn > 3 ? n[3] : endP[3]);
  } else if (!strcmp(w, "move")) ok = queueTo(endP[0] + n[0], endP[1] + n[1], endP[2] + n[2], endP[3]);
  else if (!strcmp(w, "fwd") || !strcmp(w, "forward") || !strcmp(w, "back") || !strcmp(w, "backward")) {
    float c[4];
    toCyl(endP, c);
    float d = nn ? n[0] : 20;
    ok = queueCyl(c[0], c[1] + (w[0] == 'f' ? d : -d), c[2], c[3]);
  } else if (!strcmp(w, "up") || !strcmp(w, "down")) {
    float d = nn ? n[0] : 20;
    ok = queueTo(endP[0], endP[1], endP[2] + (w[0] == 'u' ? d : -d), endP[3]);
  } else if (!strcmp(w, "left") || !strcmp(w, "right")) {
    float c[4];
    toCyl(endP, c);
    float d = nn ? n[0] : 15;
    ok = queueCyl(c[0] + (w[0] == 'l' ? d : -d), c[1], c[2], c[3]);
  } else if (!strcmp(w, "pitch")) ok = queueTo(endP[0], endP[1], endP[2], nn ? n[0] : PITCH_DEG);
  else if (!strcmp(w, "grab") || !strcmp(w, "grip") || !strcmp(w, "close")) {
    float g = 1.08f;
    if (nn) g = 1 - (n[0] - GRIP_SQUEEZE_MM) / GRIP_OPEN_MM;
    ok = queueGrip(g);
  } else if (!strcmp(w, "release") || !strcmp(w, "open") || !strcmp(w, "drop")) ok = queueGrip(nn ? 1 - n[0] / GRIP_OPEN_MM : 0);
  else if (!strcmp(w, "wait")) ok = push(Q_WAIT, nn ? n[0] : 1, 0, 0, 0, 0);
  else if (!strcmp(w, "speed")) {
    if (nn && n[0] >= 5 && n[0] <= 300) speedMm = n[0];
    Serial.print(F("speed "));
    Serial.print(speedMm, 0);
    Serial.println(F(" mm/s"));
  } else if (fromProgram) {
    Serial.println(F("a program can't use that: skipped"));
    ok = false;
  } else if (!strcmp(w, "rec") || !strcmp(w, "record")) record();
  else if (!strcmp(w, "list")) {
    float p[5];
    for (int i = 0; i < nPoints; i++) {
      loadPoint(i, p);
      printPoint(i, p);
    }
    if (!nPoints) Serial.println(F("no points saved: jog the arm, then rec"));
  } else if (!strcmp(w, "clear")) {
    nPoints = 0;
    saveCount();
    Serial.println(F("points cleared"));
  } else if (!strcmp(w, "play")) {
    if (!nPoints) {
      Serial.println(F("no points saved: jog the arm, then rec"));
      ok = false;
    } else {
      clearQueue();
      playIdx = 0;
      playLoops = nn ? (int)n[0] : 1;
      st = S_PLAY;
    }
  } else if (!strcmp(w, "run")) {
    if (!pgm_read_byte(PROGRAM)) {
      Serial.println(F("the design's firmware block has no program"));
      ok = false;
    } else {
      clearQueue();
      progPos = 0;
      st = S_PROGRAM;
    }
  } else if (!strcmp(w, "centre") || !strcmp(w, "center")) {
    clearQueue();
    for (uint8_t j = 0; j < 4; j++) jq[j] = POSE[j];
    fk(jq, cur);
    cur[4] = 0;
    for (uint8_t i = 0; i < 5; i++) endP[i] = cur[i];
    writeArm(jq, 0);
    Serial.println(F("every servo at its design-pose angle (gripper open): fit the horns with the arm as the drawing shows"));
  } else if (!strcmp(w, "trim") || !strcmp(w, "joint")) {
    char *jw = arg;
    while (*jw == ' ') jw++;
    char *e = jw;
    while (*e && *e != ' ') e++;
    if (*e) *e++ = 0;
    int8_t j = jointOf(jw);
    float v = atof(e);
    if (j < 0) {
      Serial.println(F("which joint? base, shoulder, elbow, wrist or grip"));
      ok = false;
    } else if (w[0] == 't') {
      if (v < -20 || v > 20) {
        Serial.println(F("trim is for a few degrees: refit the horn one tooth over instead"));
        ok = false;
      } else {
        trim[j] = v;
        saveTrims();
        writeArm(jq, cur[4]);
        Serial.print(F("trim saved: "));
        Serial.println(v, 1);
      }
    } else if (j == 4) ok = queueGrip(v / 100.0f);
    else if (v < J_MIN[j] || v > J_MAX[j]) {
      Serial.println(F("past that joint's limit"));
      ok = false;
    } else {
      float q[4], p[4];
      for (uint8_t k = 0; k < 4; k++) q[k] = jq[k];
      q[j] = v;
      fk(q, p);
      ok = queueTo(p[0], p[1], p[2], p[3]);
    }
  } else {
    Serial.print(F("unknown command: "));
    Serial.print(w);
    Serial.println(F(" (type help)"));
    ok = false;
  }
  if (!ok) refused++;
  else if ((qCount || mvType >= 0) && (st == S_READY || st == S_DONE)) st = S_MOVING;
  return ok;
}

// the program's next command, into line: false at its end
bool nextProgramCommand() {
  if (progPos < 0) return false;
  uint8_t n = 0;
  char ch = pgm_read_byte(PROGRAM + progPos);
  if (!ch) return false;
  while (ch && ch != ';') {
    if (n < sizeof(pline) - 1) pline[n++] = ch;
    progPos++;
    ch = pgm_read_byte(PROGRAM + progPos);
  }
  if (ch == ';') progPos++;
  pline[n] = 0;
  return true;
}

void readConsole() {
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\\n' || ch == '\\r' || ch == ';') {
      line[lineLen] = 0;
      if (lineLen) exec(line, false);
      lineLen = 0;
    } else if (lineLen < sizeof(line) - 1) {
      if (ch >= 'A' && ch <= 'Z') ch = ch - 'A' + 'a';
      line[lineLen++] = ch;
    }
  }
}

// ---------------------------------------------------------------- the pendant
float stick(int pin, uint8_t k) {
  if (pin < 0) return 0;
  float v = (analogRead(pin) - centre[k]) / (ADC_MAX * 0.5f);
  if (v > -DEADBAND && v < DEADBAND) return 0;
  v = v > 0 ? (v - DEADBAND) / (1 - DEADBAND) : (v + DEADBAND) / (1 - DEADBAND);
  if (v > 1) v = 1;
  if (v < -1) v = -1;
  return v;
}

void calibrateSticks() {
  const int pins[4] = {PIN_J1X, PIN_J1Y, PIN_J2X, PIN_J2Y};
  for (uint8_t k = 0; k < 4; k++) {
    if (pins[k] < 0) continue;
    long sum = 0;
    for (uint8_t i = 0; i < 8; i++) sum += analogRead(pins[k]);
    float c = sum / 8.0f;
    if (fabs(c - ADC_MAX / 2.0f) < ADC_MAX * 0.2f) centre[k] = c;
    else {
      Serial.print(F("joystick "));
      Serial.print(k / 2 + 1);
      Serial.println(F(" was not centred at power-up: using mid-scale (let go of the sticks while it starts)"));
    }
  }
}

void onPress(uint8_t b, bool isLong) {
  if (b == 0) {
    if (isLong) {
      if (st == S_FAULT) resetFault();
      else {
        clearQueue();
        queueTo(HOME_X, HOME_Y, HOME_Z, PITCH_DEG);
        st = S_MOVING;
      }
    } else if (st != S_FAULT) {
      queueGrip(endP[4] > 0.5f ? 0 : 1.08f);
      if (st == S_READY) st = S_MOVING;
    }
  } else if (st != S_FAULT) {
    if (isLong) {
      if (st == S_PLAY) {
        clearQueue();
        st = S_READY;
        Serial.println(F("stopped"));
      } else {
        char cmd[5] = "play";
        exec(cmd, false);
      }
    } else record();
  }
}

void readButtons(unsigned long now) {
  const int pins[2] = {PIN_J1SW, PIN_J2SW};
  for (uint8_t b = 0; b < 2; b++) {
    if (pins[b] < 0) continue;
    bool down = digitalRead(pins[b]) == LOW;
    if (down && !btnDown[b]) {
      btnDown[b] = true;
      btnLong[b] = false;
      btnAt[b] = now;
    } else if (down && !btnLong[b] && now - btnAt[b] >= LONG_PRESS_MS) {
      btnLong[b] = true;
      onPress(b, true);
    } else if (!down && btnDown[b]) {
      btnDown[b] = false;
      if (!btnLong[b] && now - btnAt[b] >= 30) onPress(b, false);
    }
  }
}

// velocity jog in (swing, reach, height, pitch): each axis that would leave the reach is held
void jog(float dt) {
  float u[4] = {-J1X_DIR * stick(PIN_J1X, 0), J1Y_DIR * stick(PIN_J1Y, 1), J2Y_DIR * stick(PIN_J2Y, 3), J2X_DIR * stick(PIN_J2X, 2)};
  const float vmax[4] = {JOG_DEG_S, JOG_MM_S, JOG_MM_S, JOG_DEG_S};
  bool any = false;
  for (uint8_t k = 0; k < 4; k++) {
    float want = u[k] * fabs(u[k]) * vmax[k];
    jogV[k] += (want - jogV[k]) * (dt * 8 > 1 ? 1 : dt * 8);
    if (u[k] != 0) any = true;
  }
  unsigned long now = millis();
  if (any) {
    if (st == S_PROGRAM || st == S_PLAY || qCount || mvType >= 0) {
      clearQueue();
      Serial.println(F("pendant moved: the program is stopped"));
    }
    st = S_JOG;
    jogIdleAt = now;
  } else if (st == S_JOG && now - jogIdleAt > 300) {
    for (uint8_t k = 0; k < 4; k++) jogV[k] = 0;
    for (uint8_t i = 0; i < 5; i++) endP[i] = cur[i];
    st = S_READY;
    return;
  }
  if (st != S_JOG) return;
  float c[4], t[4], q[4];
  toCyl(cur, c);
  for (uint8_t k = 0; k < 4; k++) t[k] = c[k] + jogV[k] * dt;
  if (ikCyl(t[0], t[1], t[2], t[3], q)) {
    // slide along the edge of the reach: keep the axes that still work on their own
    for (uint8_t k = 0; k < 4; k++) t[k] = c[k];
    for (uint8_t k = 0; k < 4; k++) {
      float keep = t[k];
      t[k] = c[k] + jogV[k] * dt;
      if (ikCyl(t[0], t[1], t[2], t[3], q)) {
        t[k] = keep;
        jogV[k] = 0;
      }
    }
    if (ikCyl(t[0], t[1], t[2], t[3], q)) return;
  }
  for (uint8_t j = 0; j < 4; j++) jq[j] = q[j];
  fk(jq, cur);
  for (uint8_t j = 0; j < 4; j++) writeServoDeg(j, servoDeg(j, jq[j]));
  for (uint8_t i = 0; i < 4; i++) endP[i] = cur[i];
}

// ---------------------------------------------------------------- setup and loop
void setup() {
  Serial.begin(115200);
#if defined(ESP32)
  EEPROM.begin(512);
#endif
  if (PIN_LED >= 0) pinMode(PIN_LED, OUTPUT);
  if (PIN_ESTOP >= 0) pinMode(PIN_ESTOP, INPUT_PULLUP);
  if (PIN_J1SW >= 0) pinMode(PIN_J1SW, INPUT_PULLUP);
  if (PIN_J2SW >= 0) pinMode(PIN_J2SW, INPUT_PULLUP);
  loadSaved();
  // park at home: the arm should be sitting there (or in the design pose) when it is switched on, since a
  // hobby servo jumps straight to its first pulse; one at a time so the start-up currents don't add up
  float p[4] = {HOME_X, HOME_Y, HOME_Z, PITCH_DEG};
  if (ik(p, jq)) {
    for (uint8_t j = 0; j < 4; j++) jq[j] = POSE[j];
    Serial.println(F("HOME is out of reach: starting in the design pose"));
  }
  fk(jq, cur);
  cur[4] = 0;
  for (uint8_t i = 0; i < 5; i++) endP[i] = cur[i];
  writeArm(jq, 0);
  const uint8_t order[5] = {0, 4, 3, 2, 1};
  for (uint8_t i = 0; i < 5; i++) {
    svAttach(order[i]);
    writeArm(jq, 0);
    delay(150);
  }
  attached = true;
  calibrateSticks();
  Serial.print(F("Robot arm ready, "));
  Serial.print(nPoints);
  Serial.println(F(" points saved. Type help."));
  if (PIN_ESTOP >= 0 && digitalRead(PIN_ESTOP) == LOW) fault();
  else if (AUTORUN) {
    progPos = 0;
    st = S_PROGRAM;
  }
  lastTick = millis();
}

void loop() {
  readConsole();
  unsigned long now = millis();
  if (now - lastTick < TICK_MS) return;
  float dt = (now - lastTick) / 1000.0f;
  lastTick = now;

  if (st != S_FAULT && PIN_ESTOP >= 0 && digitalRead(PIN_ESTOP) == LOW) fault();
  readButtons(now);
  if (st == S_FAULT) {
    if (PIN_LED >= 0) digitalWrite(PIN_LED, (now / 250) % 2 ? HIGH : LOW);
    showState();
    return;
  }
  jog(dt);
  if (st != S_JOG) {
    // feed the queue from the program or the recorded points
    while (st == S_PROGRAM && qCount < NQ - 1 && nextProgramCommand())
      if (!exec(pline, true) && st == S_PROGRAM) {
        // a move it cannot make: the rest of a pick and place would go wrong, so it stops here
        clearQueue();
        st = S_READY;
        Serial.println(F("program stopped"));
      }
    if (st == S_PLAY && playIdx >= 0 && qCount < NQ - 1) {
      float p[5];
      loadPoint(playIdx, p);
      bool ok = queueTo(p[0], p[1], p[2], p[3]);
      if (ok && fabs(p[4] - endP[4]) > 0.1f) ok = queueGrip(p[4] > 0.5f ? 1.08f : 0);
      if (!ok) {
        clearQueue();
        st = S_READY;
        refused++;
        Serial.println(F("playback stopped"));
      } else if (++playIdx >= nPoints) {
        if (playLoops == 1) playIdx = -1;
        else {
          if (playLoops > 1) playLoops--;
          playIdx = 0;
        }
      }
    }
    if (mvType < 0 && qCount) startMove();
    if (mvType >= 0 && stepMove(now) && qCount) startMove();
    bool idle = mvType < 0 && !qCount;
    if (idle && st == S_MOVING) st = S_READY;
    if (idle && st == S_PROGRAM && (progPos < 0 || !pgm_read_byte(PROGRAM + progPos))) {
      progPos = -1;
      st = S_DONE;
    }
    if (idle && st == S_PLAY && playIdx < 0) st = S_DONE;
  }
  if (PIN_LED >= 0) digitalWrite(PIN_LED, st == S_MOVING || st == S_PROGRAM || st == S_PLAY || st == S_JOG ? HIGH : LOW);
  showState();
  if (logOn) {
    Serial.print(cur[0], 1);
    Serial.print(',');
    Serial.print(cur[1], 1);
    Serial.print(',');
    Serial.print(cur[2], 1);
    Serial.print(',');
    Serial.println(cur[4], 2);
  }
}
`;

  const wiring = pinTable.map((p) => `| ${p.signal} | ${p.pin} | ${p.wire} |`).join("\n");
  const progLines = progText ? progText.split(";").map((s) => `    ${s}`).join("\n") : "    (none: add program: \"goto 200 0 40; grab; up 60; ...\" to the firmware block)";
  const readme = `# ${oneLine(c.designName)}: ${oneLine(c.fw.name)}

Robot arm firmware for the ${oneLine(bp.name)}, generated by Kerf from the design's wiring. Sizes, servo angles and limits are in \`config.h\`; trims and recorded points live in EEPROM.

## Build

Arduino IDE 2: board **${oneLine(String(bp.specs.fqbn ?? bp.name))}**${esp ? ", library **ESP32Servo**" : " (the Servo and EEPROM libraries come with the IDE)"}. USB serial at 115200 with "Newline" line endings; type \`help\`.

## Pins

| Signal | Pin | Wire |
|---|---|---|
${wiring}

## Where things are

Positions are in millimetres from the base's axis, on the base board: **x** forward in the design pose, **y** to the arm's left, **z** up. **Pitch** is the tool's angle from level (−90 points the gripper straight down). The arm's reach: shoulder to elbow ${cNum(S.l1)} mm, elbow to wrist ${cNum(S.l2)} mm, wrist to the grip point ${cNum(S.tool)} mm, the shoulder ${cNum(S.shoulderZ)} mm up. Home is ${home.map(cNum).join(", ")}.

## Commands

| Command | What it does |
|---|---|
| \`fwd 30\`, \`back 30\` | reach out or in by 30 mm (20 without a number) |
| \`up 20\`, \`down 20\` | raise or lower the grip point |
| \`left 15\`, \`right 15\` | swing the arm to its own left or right, degrees |
| \`goto 200 0 40\` | go to a point (add a pitch: \`goto 200 0 40 -60\`) |
| \`move 0 50 0\` | move by x, y, z |
| \`pitch -60\` | tilt the tool |
| \`grab\`, \`grab 30\` | close the gripper fully, or on something 30 mm wide (it squeezes ${cNum(S.squeeze)} mm) |
| \`release\` | open it |
| \`wait 1.5\` | pause, seconds |
| \`home\` | back to home |
| \`speed 60\` | straight-line speed, mm/s (${cNum(S.speed)} to start) |
| \`rec\`, \`list\`, \`clear\` | save the arm's position and grip as the next point, list them, forget them |
| \`play\`, \`play 3\`, \`play 0\` | play the points back once, three times, or until \`stop\` |
| \`run\` | run the design's program (below) |
| \`stop\` | stop at once and empty the queue |
| \`where\` | print the position, the joint angles and how many points are saved |
| \`log\` | print x, y, z and grip every 20 ms (again to stop) |
| \`centre\` | every servo to its design-pose angle: fit the horns with the arm as the drawing shows |
| \`trim shoulder 3\` | nudge a joint's zero by a few degrees (saved) |
| \`joint elbow -80\` | move one joint to an angle |
| \`reset\` | after the e-stop is released |

Moves queue up (six at a time), so \`fwd 40; down 30; grab; up 50\` on one line runs in order. Every move is checked before it starts: a point out of reach, below the board (z under ${cNum(S.zMin)} mm), closer than ${cNum(S.rMin)} mm to the base axis or past a joint's limit is refused and nothing moves. Moves run in straight lines in the arm's cylinder (swing, reach, height), easing in and out; when a straight line would leave the reach the arm goes joint by joint instead.

## The pendant

- **Left stick**: sideways swings the arm, forward and back reaches out and in.
- **Right stick**: forward and back raises and lowers the gripper, sideways tilts it.
- **Left stick's button**: press to grab or let go; hold it (0.8 s) to go home.
- **Right stick's button**: press to record a point; hold it to play the points back (hold again to stop).

Moving a stick while a program or playback runs stops it. Let go of the sticks while the arm powers up: it reads their centres then. If a stick jogs the wrong way, flip its \`J1X_DIR\`-style setting in \`config.h\`.

## The program

The firmware block's \`program\` setting is a list of commands separated by \`;\`, built into the firmware; \`run\` plays it${S.autorun && progText ? " (and it starts by itself at power-up: autorun is on)" : ""}:

${progLines}

## First power-up

1. **Horns off.** Power up, type \`centre\`: every servo goes to its design-pose angle. Fit each horn with that joint as the drawing shows it (upper arm straight up, forearm level, gripper pointing down, open). The splines have 25 teeth (14.4° a tooth), so get as close as a tooth allows.
2. **Trim.** \`trim shoulder 4\` and so on until each joint sits square (a set square against the board and the upper arm), then \`where\`.
3. **Directions.** \`joint base 20\` must swing the arm to its left (anticlockwise seen from above), \`joint shoulder 100\` lean the upper arm back, \`joint elbow -80\` lift the forearm, \`joint wrist -80\` tip the gripper's jaws forward. If one goes the wrong way set its \`DIR\` to −1 in \`config.h\` and upload again.
4. **Gripper.** \`release\`, then \`grab\` with nothing in it: the jaws should just touch. Adjust \`GRIP_CLOSED_DEG\` if not.
5. Park it at home before switching off: hobby servos jump to their first pulse at power-up, so it should already be there.

## Safety

The e-stop's normally-closed contact breaks the servos' supply, so pressing it stops the arm whatever the firmware is doing. Its normally-open contact tells the firmware, which empties the queue, stops the program and lets go of every servo, so nothing jumps when the power comes back. Twist it to release, put the arm back near where it stopped, then type \`reset\` (or hold the left stick's button).
`;

  return {
    files: [
      { path: `${dir0}/${name}.ino`, content: ino },
      { path: `${dir0}/config.h`, content: config },
      { path: `${dir0}/README.md`, content: readme },
    ],
    warnings,
    pinTable,
    summary: `${esp ? "ESP32" : "Arduino"} sketch for ${bp.name}: robot arm with inverse kinematics, straight-line moves, jog and grab commands, a two-joystick pendant, recorded points in EEPROM and a built-in program${estop ? ", e-stop latch" : " (no e-stop wired)"}`,
  };
}
