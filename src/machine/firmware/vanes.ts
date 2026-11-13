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
//
// From the wiring it also takes: a PCA9685 servo board making the pulses over
// I2C in place of controller pins (then the e-stop is the board's logic supply,
// and a board that goes quiet or loses its settings is the e-stop pressed); an
// NAU7802 load cell board in place of an HX711; and, when the firmware block
// gives i_yaw, a third axis: the unit turning about its own jet, its heading
// held from the gyro with all four vanes turned the same way.

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
  const escs = componentsOfKind(c, "esc");
  const esc = escs[0];
  const escPart = esc ? catalogPart(esc.catalogId) : undefined;
  // a PCA9685 servo board on the I2C bus: the pulses come from its outputs, not from controller pins
  const hub = c.m.components.find((x) => catalogPart(x.catalogId)?.specs.driver === "PCA9685");
  const hubPart = hub ? catalogPart(hub.catalogId) : undefined;
  const hubChOf = (comp: string) => {
    const out = hub ? c.nl.netOf.get(`${comp}[0].SIG`)?.pins.find((p) => p.comp === hub.name && /^P\d+$/.test(p.pin.id)) : undefined;
    return out ? Number(out.pin.id.slice(1)) : -1;
  };
  const viaHub = !!hub && (servos.some((s) => hubChOf(s.name) >= 0) || (!!esc && hubChOf(esc.name) >= 0));
  const onHub = (signal: string, comp: string) => {
    const ch = hubChOf(comp);
    if (ch >= 0) pinTable.push({ signal, pin: `${hub!.name} channel ${ch}`, wire: `${comp}.SIG` });
    return ch;
  };
  const vanePins = viaHub ? servos.map(() => -1) : servos.map((s, i) => note(`vane ${i + 1} servo`, s.name, "SIG"));
  const vaneCh = viaHub ? servos.map((s, i) => onHub(`vane ${i + 1} servo`, s.name)) : servos.map(() => -1);
  const escPin = esc && !viaHub ? note("ESC signal", esc.name, "SIG") : -1;
  const escCh = esc && viaHub ? onHub("ESC signal", esc.name) : -1;
  const from = viaHub ? `channel of ${hub!.name}` : `${board} pin`;
  if (!esc) warnings.push("No ESC in the design: the fan never runs.");
  else if (escPin < 0 && escCh < 0) warnings.push(`${esc.name}'s signal wire reaches no ${from}: the fan never runs.`);
  if (servos.length !== 4) warnings.push(`The X mix drives four vanes and the design has ${servos.length} servo${servos.length === 1 ? "" : "s"}: ${servos.length < 4 ? "the missing ones are left out" : "the extra ones stay centred"}.`);
  const missing = servos.flatMap((sv, i) => (vanePins[i] < 0 && vaneCh[i] < 0 ? [sv.name] : []));
  if (missing.length) warnings.push(`${missing.join(", ")}: signal not wired to a ${from}.`);
  // a spare output of the servo board wired back to a controller pin: the firmware times the board's frame on it
  let senseCh = -1;
  let sensePin = -1;
  if (viaHub) {
    note("servo board SDA", hub!.name, "SDA");
    note("servo board SCL", hub!.name, "SCL");
    if (!pinOf(hub!.name, "SDA") || !pinOf(hub!.name, "SCL")) warnings.push(`${hub!.name}: SDA and SCL must reach the ${board}'s I2C pins, or it makes no pulses.`);
    for (let n = 0; n < 16 && senseCh < 0; n++) {
      if (!pinOf(hub!.name, `P${n}`)) continue;
      senseCh = n;
      sensePin = note(`servo board clock check (its channel ${n})`, hub!.name, `P${n}`);
    }
    if (sensePin < 0)
      warnings.push(
        `${hub!.name}'s own clock can be 8 % out, and every pulse with it (the fan's thrust too). Wire the signal pin of a spare channel back to a free ${board} pin and the firmware times the board at start-up and corrects for it; without that, measure a channel's frame rate and set hub_osc_hz.`,
      );
  }

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
  // with a servo board, a switch whose normally-closed contact is in the board's logic supply stops every pulse
  // when pressed, and the firmware sees the board go quiet
  const hubVcc = viaHub ? c.nl.netOf.get(`${hub!.name}[0].VCC`) : undefined;
  const estopCut = hubVcc?.pins.find((p) => p.part.kind === "switch" && p.pin.type === "passive" && !!p.pin.through)?.mc;
  if (estopCut) {
    estop ??= estopCut;
    pinTable.push({ signal: "e-stop (cuts the servo board's logic supply)", pin: `${hub!.name} VCC`, wire: `${estopCut.name} NC contact` });
  }
  if (estopPin < 0 && !estopCut)
    warnings.push(
      viaHub
        ? `No e-stop: put a switch's normally-closed contact in ${hub!.name}'s VCC wire (pressing it stops every pulse and the firmware sees the board go quiet), or wire its normally-open contact to a controller pin.`
        : "No switch's normally-open contact reaches a controller pin: the firmware cannot see the e-stop (its normally-closed contact may still cut the ESC).",
    );

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
  // an NAU7802 load cell board on the I2C bus, when there is no HX711
  const nau = hx ? undefined : c.m.components.find((x) => catalogPart(x.catalogId)?.specs.chip === "NAU7802");
  const nauAddr = Number(nau ? (catalogPart(nau.catalogId)?.specs.i2c_addr ?? 0x2a) : 0x2a);
  if (nau) {
    note("load cell board SDA", nau.name, "SDA");
    note("load cell board SCL", nau.name, "SCL");
    if (!pinOf(nau.name, "SDA") || !pinOf(nau.name, "SCL")) warnings.push(`${nau.name}: SDA and SCL must reach the ${board}'s I2C pins for the force test.`);
  }
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
  // the ESC's own pulse range (as it leaves the factory, or after its throttle calibration), and a stop pulse safely
  // under its bottom end so it arms whatever the range
  const escMin = Math.round(Number(escPart?.specs.pwm_min_us ?? 1000));
  const escMax = Math.round(Number(escPart?.specs.pwm_max_us ?? 2000));
  const escStop = Math.min(1000, escMin - 100);
  const hubAddr = Number(hubPart?.specs.i2c_addr ?? 0x40);
  const hubOsc = Math.round(setting(c.fw, "hub_osc_hz", Number(hubPart?.specs.osc_mhz ?? 25) * 1e6));
  // the third axis: the unit turning about its own jet. Off until the design gives its inertia
  const iYaw = setting(c.fw, "i_yaw", 0);
  const yawOn = iYaw > 0;
  // a heading that starts on an end stop (yaw_home: the stop's angle): the fan's start-up twist parks the unit there
  const homeStop = yawOn && Math.abs(Number(c.fw.settings.yaw_home ?? 0) || 0) > 0;
  const S = {
    // a servo board gives every output one frame rate, the ESC's too: 200 Hz suits digital servos and most ESCs
    servoHz: setting(c.fw, "servo_hz", viaHub ? 200 : 333),
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
    // the share of the fan's own full static thrust the rig calls full (1: all of it). A fan bigger than the ESC,
    // fuse or plug can carry runs capped: the throttle never passes sqrt(thrust_cap)
    thrustCap: Math.min(1, Math.max(0.05, setting(c.fw, "thrust_cap", 1))),
    cellLever: setting(c.fw, "cell_lever_mm", 69.2) / 1000,
    // set-point steps follow a critically damped model at this rate; the loop tracks it with feed-forward
    refWn: Math.min(40, Math.max(2, setting(c.fw, "ref_wn", 14))),
    // how hard the unit's own weight pulls it back level, N m per radian of tilt (0: balanced on the pivot)
    pendRoll: setting(c.fw, "pend_roll", 0),
    pendPitch: setting(c.fw, "pend_pitch", 0),
    // the share of the vanes' full moment about one axis the integral term may hold
    iShare: Math.min(0.9, Math.max(0.05, setting(c.fw, "i_share", 0.6))),
    // yaw: moment per degree of all four vanes turned the same way at full thrust, N m; the loop's speed and
    // damping; how much vane angle it may use; how far the heading may be asked to go; the heading at arming
    mYaw: setting(c.fw, "m_deg_yaw_full", 0.003),
    wnYaw: setting(c.fw, "wn_yaw", 6),
    zetaYaw: setting(c.fw, "zeta_yaw", 0.9),
    yawVane: setting(c.fw, "yaw_vane_max", 8),
    yawRange: setting(c.fw, "yaw_range", 40),
    yawHome: Number(c.fw.settings.yaw_home ?? 0) || 0,
    refWnYaw: Math.min(20, Math.max(1, setting(c.fw, "ref_wn_yaw", 4))),
    yawDir: setting(c.fw, "yaw_dir", 1) < 0 ? -1 : 1,
    // the common vane angle that holds off the jet's left-over swirl, to start from; and how fast the thrust may
    // change while the heading is held (the rotor changing speed twists the unit)
    yawTrim: Number(c.fw.settings.yaw_trim ?? 0) || 0,
    rampHold: Math.min(1, Math.max(0.01, setting(c.fw, "ramp_hold_per_s", 0.1))),
  };
  // Bluetooth serial console (classic ESP32 only: the S2, S3 and C3 have no Bluetooth Classic)
  const btConsole = setting(c.fw, "bt_console", 1) > 0 && bp.specs.bluetooth === true && /^esp32$/i.test(String(bp.specs.mcu ?? ""));
  const name = ident(c.fw.name).toLowerCase() || "jet_vane";
  const dir0 = `firmware/${name}`;
  const nV = Math.min(4, servos.length);
  const vPin = (i: number) => (i < nV && vanePins[i] >= 0 ? vanePins[i] : -1);
  const vCh = (i: number) => (i < nV && vaneCh[i] >= 0 ? vaneCh[i] : 255);

  const config = `// ${cComment(c.designName)}: pins, rig numbers and controller settings for ${cComment(c.fw.name)}.
// Generated by Kerf from the design's wiring and its firmware block. Scenarios change the #defines.
#pragma once
#include <Arduino.h>

// ---- pins (${cComment(bp.name)}), from the wiring
${viaHub ? "" : `#define PIN_VANE_1 ${vPin(0)}
#define PIN_VANE_2 ${vPin(1)}
#define PIN_VANE_3 ${vPin(2)}
#define PIN_VANE_4 ${vPin(3)}
#define PIN_ESC ${escPin}
`}#define PIN_ESTOP ${estopPin}
${nau ? `#define CELL_ADDR 0x${nauAddr.toString(16).toUpperCase()}
` : `#define PIN_HX_DOUT ${hxDout}
#define PIN_HX_SCK ${hxSck}
`}#define PIN_I2C_POWER ${qtPower}
#define PIN_LED ${pinNum(String(Number(bp.specs.led_builtin ?? 13)))}
#define IMU_ADDR 0x${imuAddr.toString(16).toUpperCase()}
// the chip's axes to the rig's (X, Y, Z) as the design mounts the board${turned ? "" : " (flat, its X along the rig's X)"}: rig = IMU_R x chip
#define IMU_R { ${imuR.map((r) => `{ ${r.map((v) => cFloat(v)).join(", ")} }`).join(", ")} }

${viaHub ? `// ---- servo board (${cComment(hubPart?.name ?? hub!.name)}) on I2C: it makes the pulses, on these channels (255: none)
#define HUB_ADDR 0x${hubAddr.toString(16).toUpperCase()}
#define HUB_CH_VANE_1 ${vCh(0)}
#define HUB_CH_VANE_2 ${vCh(1)}
#define HUB_CH_VANE_3 ${vCh(2)}
#define HUB_CH_VANE_4 ${vCh(3)}
#define HUB_CH_ESC ${escCh >= 0 ? escCh : 255}
// The chip's own oscillator, Hz: 25 MHz on paper, a few percent out on a real one, and every pulse is out by the
// same share.${sensePin >= 0 ? ` The firmware times it at start-up: channel HUB_CH_SENSE gives a half-frame pulse, a jumper carries it to
// PIN_HUB_SENSE, and the controller's crystal is the clock it is timed against. This value is only where it starts.` : ` A multimeter on Hz between a channel's signal pin and GND should read the frame rate the README
// gives; if it reads f, set this to ${hubOsc} x f / that rate.`}
#define HUB_OSC_HZ ${hubOsc}
#define HUB_CH_SENSE ${senseCh >= 0 ? senseCh : 255}
#define PIN_HUB_SENSE ${sensePin}

` : ""}// ---- vane servos${servoPart ? ` (${cComment(servoPart.name)})` : ""}${viaHub ? "\n// the servo board gives every output this one frame rate, the ESC's too" : ""}
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
#define ESC_HZ ${viaHub ? "SERVO_HZ" : "50"}
// its throttle range, and the pulse that means stop: under the bottom of the range, so it arms whatever it is
#define ESC_MIN_US ${escMin}
#define ESC_MAX_US ${escMax}
#define ESC_STOP_US ${escStop}
// the ESC arms after its signal sits at minimum this long from power-up; "arm" waits for it
#define ESC_ARM_MS 2500
// "full thrust" below is this share of the fan's own: the throttle stops at sqrt(THRUST_CAP)
#define THRUST_CAP ${cFloat(S.thrustCap)}
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
// the unit hangs bottom-heavy: its weight pulls it back level with this moment per radian of tilt, N m/rad.
// From the swing test's period T: K = I (2 pi / T)^2. A set-point step feeds it forward.
#define K_ROLL ${cFloat(S.pendRoll)}
#define K_PITCH ${cFloat(S.pendPitch)}

${yawOn ? `// ---- the third axis: the unit turns about its own jet (yaw), steered by all four vanes turned the same way
#define I_YAW ${cFloat(iYaw)}
// moment per degree of that common vane angle at full thrust, N m, and which way a positive one turns the unit
#define M_DEG_YAW_FULL ${cFloat(S.mYaw)}
#define YAW_DIR ${S.yawDir}
#define WN_YAW ${cFloat(S.wnYaw)}
#define ZETA_YAW ${cFloat(S.zetaYaw)}
#define REF_WN_YAW ${cFloat(S.refWnYaw)}
// the most common vane angle the yaw loop may use (roll and pitch keep the rest), and how far either side of
// the middle a heading may be asked for, degrees
#define YAW_VANE_MAX_DEG ${cFloat(Math.min(S.yawVane, S.vaneMax * 0.6))}
#define YAW_RANGE_DEG ${cFloat(S.yawRange)}
${homeStop ? "// the end stop the fan's start-up twists the unit onto, degrees from the middle of its travel: the heading counts\n// from it (park the unit there before arming; the loop takes the stop's angle again when it first closes)" : "// where the unit points when it is armed, degrees from the middle of its travel"}
#define YAW_HOME_DEG ${cFloat(S.yawHome)}
// the vane angle that holds off the jet's left-over swirl, to start from: the loop finds its own and "save" keeps it
#define YAW_TRIM_DEG ${cFloat(S.yawTrim)}
// while the heading is held the thrust moves at this rate, share of full thrust a second: the rotor changing
// speed twists the unit, and this keeps the twist inside what the vanes can hold
#define THRUST_RAMP_HOLD_PER_S ${cFloat(S.rampHold)}

` : ""}// ---- controller
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
// set-point steps follow a critically damped model at this rate, rad/s; the loop tracks it with feed-forward
#define REF_WN ${cFloat(S.refWn)}
// the integral term may hold up to this share of the vanes' full moment about one axis at the running thrust:
// enough to trim out an off-centre mass or a steady push, with the rest left for catching knocks
#define I_SHARE ${cFloat(S.iShare)}

// ---- console: USB serial, and the same console over Bluetooth serial so no cable hangs off the gimbal
// (pair with BT_NAME, then open its serial port in any terminal)
#define BT_CONSOLE ${btConsole ? 1 : 0}
#define BT_NAME "JetVane"

// ---- safety
#define TILT_CUT_DEG ${cFloat(S.tiltCut)}
#define ARM_LEVEL_DEG ${cFloat(S.armLevel)}
#define ARM_STILL_DPS 5.0f
// the gyro's bias is only taken while no axis swings more than this either side of its mean
#define CAL_STILL_DPS 1.0f
// and only when its mean is under this: the chip's own zero-rate offset is about 1 deg/s, so a larger mean is the
// unit turning steadily (creeping off its stop against the bearings' friction reads as steady as standing still)
#define CAL_MAX_BIAS_DPS 3.0f
#define IMU_TIMEOUT_MS 20
#define LOOP_US 2000

// ---- load cell (force test)
// from the pitch axis to where the link pushes the cell; negative when the cell is mounted the other way round, so a
// push that reads as a positive force is a negative moment
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
${yawOn ? "#define STEP_YAW_S 4.0f\n" : ""}`;

  // the servo board's logic supply is the controller's switched STEMMA QT 3.3 V, so the firmware can reset the chip
  // through it when the chip does not answer
  const hubOnQt = viaHub && qtPower >= 0 && !!hubVcc?.pins.some((p) => p.comp === board && /^QT/.test(p.pin.id));
  const estopSays = viaHub ? "e-stop pressed or servo board unplugged" : "e-stop pressed";
  const zeros = yawOn ? "0, 0, 0" : "0, 0";
  const nAx = yawOn ? 3 : 2;

  // ---- the load cell's chip
  const cellCode = nau
    ? `// ---------------------------------------------------------------- load cell board (NAU7802 registers)
bool cellFound = false;

bool cellWrite(uint8_t reg, uint8_t v) {
  Wire.beginTransmission(CELL_ADDR);
  Wire.write(reg);
  Wire.write(v);
  return Wire.endTransmission() == 0;
}

int cellReg(uint8_t reg) {
  Wire.beginTransmission(CELL_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return -1;
  if (Wire.requestFrom(CELL_ADDR, 1) != 1) return -1;
  return Wire.read();
}

bool cellBegin() {
  bool ok = cellWrite(0x00, 0x01);    // PU_CTRL: registers back to their defaults
  ok = ok && cellWrite(0x00, 0x02);   // digital side on
  delay(1);
  int pu = ok ? cellReg(0x00) : -1;
  ok = pu >= 0 && (pu & 0x08) != 0;   // powered up
  ok = ok && cellWrite(0x00, 0x86);   // analogue side on, the cell fed from the chip's own regulator
  ok = ok && cellWrite(0x01, 0x2F);   // regulator at 3.0 V, gain 128
  ok = ok && cellWrite(0x02, 0x30);   // 80 samples a second
  ok = ok && cellWrite(0x15, 0x30);   // the chopper clock off
  ok = ok && cellWrite(0x1C, 0x80);   // the amplifier's stabilising capacitor on
  ok = ok && cellWrite(0x00, 0x96);   // start converting
  cellFound = ok;
  return ok;
}

// a new sample is waiting (asked once a pass at most: each ask is a message on the bus)
bool cellReady() {
  if (!cellFound) return false;
  int pu = cellReg(0x00);
  return pu >= 0 && (pu & 0x20) != 0;
}

long cellRead() {
  Wire.beginTransmission(CELL_ADDR);
  Wire.write((uint8_t)0x12);
  if (Wire.endTransmission(false) != 0) return cellRaw;
  if (Wire.requestFrom(CELL_ADDR, 3) != 3) return cellRaw;
  long v = 0;
  for (int i = 0; i < 3; i++) v = (v << 8) | Wire.read();
  if (v & 0x800000L) v -= 0x1000000L;
  return v;
}
`
    : `// ---------------------------------------------------------------- HX711
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
`;

  // ---- the servo board's driver
  const hubCode = viaHub
    ? `// ---------------------------------------------------------------- servo board (PCA9685 registers)
// The board makes every pulse, the four vanes' and the ESC's, at one frame rate (SERVO_HZ). A pulse is set in
// steps of 1/4096 of the frame.
const uint8_t hubCh[5] = {HUB_CH_VANE_1, HUB_CH_VANE_2, HUB_CH_VANE_3, HUB_CH_VANE_4, HUB_CH_ESC};
uint16_t hubUs[5] = {0, 0, 0, 0, 0};
uint8_t hubPrescale = 30;
float hubOsc = HUB_OSC_HZ;
bool hubTimed = false;
float hubStepsPerUs = 0.8f;
bool hubUp = false;
uint32_t hubUpAt = 0;
uint8_t hubMiss = 0;

bool hubWrite(uint8_t reg, uint8_t v) {
  Wire.beginTransmission(HUB_ADDR);
  Wire.write(reg);
  Wire.write(v);
  return Wire.endTransmission() == 0;
}

int hubRead(uint8_t reg) {
  Wire.beginTransmission(HUB_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return -1;
  if (Wire.requestFrom(HUB_ADDR, 1) != 1) return -1;
  return Wire.read();
}

// one channel's four registers: on at count 0, off at this count (4096 and over: off all the time)
bool hubSet(uint8_t ch, uint16_t off) {
  Wire.beginTransmission(HUB_ADDR);
  Wire.write((uint8_t)(0x06 + 4 * ch));
  Wire.write((uint8_t)0);
  Wire.write((uint8_t)0);
  Wire.write((uint8_t)(off & 0xFF));
  Wire.write((uint8_t)(off > 4095 ? 0x10 : (off >> 8)));
  return Wire.endTransmission() == 0;
}

// The chip's oscillator is a few percent out, and every pulse with it. With a jumper from channel HUB_CH_SENSE
// back to PIN_HUB_SENSE, that channel gives a pulse of half a frame (2048 counts) and the controller times it
// against its own crystal: the oscillator's real rate, Hz, or 0 when no pulse came. The middle of five
// readings, so one stretched by an interrupt does not count.
float hubClock() {
  if (PIN_HUB_SENSE < 0 || HUB_CH_SENSE > 15) return 0;
  pinMode(PIN_HUB_SENSE, INPUT);
  if (!hubSet(HUB_CH_SENSE, 2048)) return 0;
  delay(15);
  unsigned long t[5];
  for (int i = 0; i < 5; i++) t[i] = pulseIn(PIN_HUB_SENSE, HIGH, 30000);
  hubSet(HUB_CH_SENSE, 4096);
  for (int i = 1; i < 5; i++)
    for (int k = i; k > 0 && t[k] < t[k - 1]; k--) {
      unsigned long swap = t[k];
      t[k] = t[k - 1];
      t[k - 1] = swap;
    }
  if (t[2] == 0) return 0;
  return 2048.0f * (hubPrescale + 1) * 1000000.0f / t[2];
}

// Sets the frame rate (the chip only takes it while asleep), wakes the chip with every output off and times
// its oscillator.
bool hubBegin() {
  hubPrescale = (uint8_t)(HUB_OSC_HZ / (4096.0f * SERVO_HZ) + 0.5f) - 1;
  bool ok = hubWrite(0x00, 0x30);          // MODE1: asleep, register addresses step on by themselves
  ok = ok && hubWrite(0xFD, 0x10);         // ALL_LED_OFF_H: every output off
  ok = ok && hubWrite(0xFE, hubPrescale);  // PRE_SCALE
  ok = ok && hubWrite(0x01, 0x04);         // MODE2: outputs drive high and low
  ok = ok && hubWrite(0x00, 0x20);         // awake
  delay(1);                                // its oscillator takes 0.5 ms to start
  ok = ok && hubWrite(0x00, 0xA0);         // clear the restart flag
  ok = ok && hubRead(0xFE) == hubPrescale && (hubRead(0x00) & 0x7F) == 0x20;
  hubOsc = HUB_OSC_HZ;
  hubTimed = false;
  if (ok) {
    float f = hubClock();
    // a real chip is within 10 % of its 25 MHz; anything else is a bad reading
    if (f > 0.88f * HUB_OSC_HZ && f < 1.12f * HUB_OSC_HZ) {
      hubOsc = f;
      hubTimed = true;
    }
  }
  hubStepsPerUs = hubOsc / ((hubPrescale + 1) * 1000000.0f);
  hubUp = ok;
  hubMiss = 0;
  if (ok) hubUpAt = millis();
  return ok;
}

// Sends every pulse. Channels next to each other go in one message (the chip steps through its registers by
// itself): four bytes a channel, on at the start of the frame and off after the pulse.
bool hubSend() {
  bool ok = true;
  uint8_t i = 0;
  while (i < 5) {
    if (hubCh[i] > 15) {
      i++;
      continue;
    }
    Wire.beginTransmission(HUB_ADDR);
    Wire.write((uint8_t)(0x06 + 4 * hubCh[i]));
    uint8_t k = i;
    do {
      uint16_t off = (uint16_t)(hubUs[k] * hubStepsPerUs + 0.5f);
      Wire.write((uint8_t)0);
      Wire.write((uint8_t)0);
      Wire.write((uint8_t)(off & 0xFF));
      Wire.write((uint8_t)(hubUs[k] ? ((off >> 8) & 0x0F) : 0x10));
      k++;
    } while (k < 5 && hubCh[k] == hubCh[k - 1] + 1);
    if (Wire.endTransmission() != 0) ok = false;
    i = k;
  }
  return ok;
}

${hubOnQt ? `// The board's logic supply is the STEMMA QT socket's switched 3.3 V. Off for 150 ms, the chip comes back with
// every output off, whatever it was doing. The IMU${nau ? " and the load cell board share" : " shares"} that supply and ${nau ? "are" : "is"} set up again when it returns.
uint32_t hubCutAt = 0;

void hubCut() {
  digitalWrite(PIN_I2C_POWER, LOW);
  hubCutAt = millis() | 1;
}

void hubRestore() {
  digitalWrite(PIN_I2C_POWER, HIGH);
  hubCutAt = 0;
  delay(20);
  imuFound = imuBegin();
${nau ? "  cellBegin();\n" : ""}  lastTick = micros();
}

` : ""}// A board that is not up must not be left sending pulses.
void hubSafe() {
  int m = hubRead(0x00);
  if (m >= 0 && (m & 0x10)) return;  // it answers, asleep: no pulses
  if (m >= 0) {
    // it answers, awake: every output off, then asleep
    hubWrite(0xFD, 0x10);
    hubWrite(0x00, 0x30);
    return;
  }
${hubOnQt ? "  // quiet: its data wires may be off while it still sends its last pulses, so its supply goes off (the loop\n  // brings it back)\n  hubCut();\n" : "  // quiet: nothing more can be done from here. If its data wires are off it keeps its last pulses: press the e-stop\n"}}

// One pass sends the pulses, the next asks the chip whether it is still set up. Three misses in a row (under
// 15 ms) and the board is taken as gone: the e-stop pressed, or its lead off.
void hubService() {
  if (!hubUp) return;
  bool ok = turn ? hubSend() : (hubRead(0x00) & 0x7F) == 0x20;
  if (!ok) hubMiss++;
  else if (!turn) hubMiss = 0;
  if (hubMiss >= 3) {
    hubUp = false;
    hubSafe();
  }
}

`
    : "";

  // ---- pulses out: through the servo board, or straight from the controller's pins
  const outCode = viaHub
    ? `void servoUs(int i, int us) { hubUs[i] = us; }
`
    : `void servoUs(int i, int us) {
  if (i == 0) vane1.writeMicroseconds(us);
  if (i == 1) vane2.writeMicroseconds(us);
  if (i == 2) vane3.writeMicroseconds(us);
  if (i == 3) vane4.writeMicroseconds(us);
}
`;
  const escOut = viaHub ? "hubUs[4] = us;" : "esc.writeMicroseconds(us);";

  // ---- the controller: two axes, or three with the heading
  const controlCode = yawOn
    ? `// X mix: vane i (hinge at phi_i) makes roll moment ~cos(phi) and pitch moment ~sin(phi) per degree, so
// delta_i = (tx cos + ty sin) / m_deg gives (tx, ty). The heading loop's angle (yawVane) goes on all four
// alike: that turns the unit about its jet and tilts nothing. It is kept whole, and past what is left of
// VANE_MAX_DEG the roll and pitch parts scale down together so their moment keeps its direction.
bool mixVanes(float tx, float ty, float mDeg, float *v) {
  float room = VANE_MAX_DEG - fabs(yawVane);
  float worst = 0;
  for (int i = 0; i < 4; i++) {
    float ph = VANE_PHI_DEG[i] * DEG;
    v[i] = (tx * cos(ph) + ty * sin(ph)) / mDeg;
    if (fabs(v[i]) > worst) worst = fabs(v[i]);
  }
  bool over = worst > room;
  for (int i = 0; i < 4; i++) v[i] = (over ? v[i] * room / worst : v[i]) + yawVane;
  return over;
}

void control(float gx, float gy, float dt, float *v) {
  float I[2] = {I_ROLL, I_PITCH};
  float est[2] = {roll, pitch};
  float rate[2] = {gxf, gyf};
  float a[2];
  float err[2];
  for (int i = 0; i < 2; i++) {
    // the set point moves along a critically damped path (REF_WN), so a step asks for a moment the vanes have;
    // the path's own acceleration and the weight's pull at that tilt are fed forward, and the loop only
    // corrects what is left
    float acc = REF_WN * REF_WN * (cmd[i] - ref[i]) - 2 * REF_WN * refRate[i];
    refRate[i] += acc * dt;
    ref[i] += refRate[i] * dt;
    err[i] = ref[i] - est[i];
    // the angular acceleration wanted about the unit's own X and Y
    a[i] = acc + gainScale * (WN * WN * err[i] + 2 * ZETA * WN * (refRate[i] - rate[i]));
  }
  // The IMU and the vanes turn with the unit; the roll ring and the pitch arch do not, and the inertias and the
  // weight's pull belong to them. So the wanted accelerations go into the gimbal's axes by the heading, become
  // moments there, and come back into the unit's.
  float c = cos(yaw), s = sin(yaw);
  float tgx = I_ROLL * (c * a[0] - s * a[1]) + K_ROLL * (c * ref[0] - s * ref[1]);
  float tgy = I_PITCH * (s * a[0] + c * a[1]) + K_PITCH * (s * ref[0] + c * ref[1]);
  float t[2];
  t[0] = c * tgx + s * tgy + I[0] * WN * WN * gainScale * WN * KI_RATIO * integ[0];
  t[1] = c * tgy - s * tgx + I[1] * WN * WN * gainScale * WN * KI_RATIO * integ[1];
  // the rotor's momentum along +Z pushes back with (-H wy, +H wx): add the opposite
  float H = rotorDir * H_FULL * sqrt(thrust > 0 ? thrust : 0) * gyroK;
  t[0] += H * gy;
  t[1] -= H * gx;
  float th = thrust < 0.3f ? 0.3f : thrust;
  float mDeg = M_DEG_MIX_FULL * liftK * th;

  // The heading: the same kind of path and PD about the jet, in the same torque units. The path's acceleration
  // is held to what half the heading's vane travel can give, so a big turn never asks for more than there is.
  float mYaw = M_DEG_YAW_FULL * liftK * th;
  float aMax = 0.5f * YAW_VANE_MAX_DEG * mYaw / I_YAW;
  float accZ = constrain(REF_WN_YAW * REF_WN_YAW * (cmd[2] - ref[2]) - 2 * REF_WN_YAW * refRate[2], -aMax, aMax);
  refRate[2] += accZ * dt;
  ref[2] += refRate[2] * dt;
  float errZ = ref[2] - yaw;
  float kpZ = I_YAW * WN_YAW * WN_YAW * gainScale;
  float kdZ = 2 * ZETA_YAW * WN_YAW * I_YAW * gainScale;
  // speeding the rotor up twists the unit the other way, by the rate its momentum grows: the vanes push back
  float tz = I_YAW * accZ + kpZ * errZ + kdZ * (refRate[2] - gzf) + rotorDir * H_FULL * spool;
  // The jet's left-over swirl twists the unit as well. It and the vanes' moment both go with thrust, so one
  // vane angle holds it off at every thrust: yawTrim, the loop's integral, kept in degrees of vane. It winds
  // only while there is travel left, or to come back.
  float want = YAW_DIR * tz / mYaw + yawTrim;
  if (fabs(want) <= YAW_VANE_MAX_DEG || YAW_DIR * errZ * want < 0)
    yawTrim = constrain(yawTrim + YAW_DIR * kpZ * WN_YAW * KI_RATIO * errZ * dt / mYaw, -YAW_VANE_MAX_DEG, YAW_VANE_MAX_DEG);
  yawVane = constrain(want, -YAW_VANE_MAX_DEG, YAW_VANE_MAX_DEG);

  saturated = mixVanes(t[0], t[1], mDeg, v);
  // the integral holds at most I_SHARE of one axis's full moment with the heading's share of the travel left
  // out, and while the vanes are at their limit it may only unwind
  float tmax = I_SHARE * 1.414f * (VANE_MAX_DEG - YAW_VANE_MAX_DEG) * mDeg;
  for (int i = 0; i < 2; i++) {
    float ki = I[i] * WN * WN * gainScale * WN * KI_RATIO;
    if (saturated && err[i] * integ[i] >= 0) continue;
    integ[i] += err[i] * dt;
    float lim = ki > 1e-9f ? tmax / ki : 0;
    integ[i] = constrain(integ[i], -lim, lim);
  }
}
`
    : `// X mix: vane i (hinge at phi_i) makes roll moment ~cos(phi) and pitch moment ~sin(phi) per degree, so
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
  float K[2] = {K_ROLL, K_PITCH};
  float est[2] = {roll, pitch};
  float rate[2] = {gxf, gyf};
  float t[2];
  float err[2];
  for (int i = 0; i < 2; i++) {
    // the set point moves along a critically damped path (REF_WN), so a step asks for a moment the vanes have;
    // the path's own acceleration and the weight's pull at that tilt are fed forward, and the loop only
    // corrects what is left
    float acc = REF_WN * REF_WN * (cmd[i] - ref[i]) - 2 * REF_WN * refRate[i];
    refRate[i] += acc * dt;
    ref[i] += refRate[i] * dt;
    float kp = I[i] * WN * WN * gainScale;
    float kd = 2 * ZETA * WN * I[i] * gainScale;
    float ki = kp * WN * KI_RATIO;
    err[i] = ref[i] - est[i];
    t[i] = I[i] * acc + K[i] * ref[i] + kp * err[i] + kd * (refRate[i] - rate[i]) + ki * integ[i];
  }
  // the rotor's momentum along +Z pushes back with (-H wy, +H wx): add the opposite
  float H = rotorDir * H_FULL * sqrt(thrust > 0 ? thrust : 0) * gyroK;
  t[0] += H * gy;
  t[1] -= H * gx;
  float th = thrust < 0.3f ? 0.3f : thrust;
  float mDeg = M_DEG_MIX_FULL * liftK * th;
  saturated = mixVanes(t[0], t[1], mDeg, v);
  // the integral holds at most I_SHARE of one axis's full moment (all four vanes at VANE_MAX_DEG give
  // 1.414 x VANE_MAX_DEG x mDeg), and while the vanes are at their limit it may only unwind
  float tmax = I_SHARE * 1.414f * VANE_MAX_DEG * mDeg;
  for (int i = 0; i < 2; i++) {
    float kp = I[i] * WN * WN * gainScale;
    float ki = kp * WN * KI_RATIO;
    if (saturated && err[i] * integ[i] >= 0) continue;
    integ[i] += err[i] * dt;
    float lim = ki > 1e-9f ? tmax / ki : 0;
    integ[i] = constrain(integ[i], -lim, lim);
  }
}
`;

  // ---- set-point steps
  const stepCode = yawOn
    ? `// "step roll 5" while holding: the setpoint jumps, the log runs, and after STEP_S (STEP_YAW_S for the heading) it
// prints the 10-90 % rise, the overshoot, when it last left the 10 % band and the error left, then the setpoint
// goes back.
void stepWatch(uint32_t now) {
  float est[3] = {roll, pitch, yaw};
  float y = (est[stepAxis] / DEG - stepY0) / stepDeg;
  float t = (now - stepAt) * 0.001f;
  float watch = stepAxis == 2 ? STEP_YAW_S : STEP_S;
  if (stepT10 < 0 && y >= 0.1f) stepT10 = t;
  if (stepT90 < 0 && y >= 0.9f) stepT90 = t;
  if (y > stepPeak) stepPeak = y;
  if (fabs(y - 1) > 0.1f) stepSettle = t;
  if (t < watch) return;
  OUT("step ");
  OUT(stepAxis == 2 ? "yaw " : stepAxis ? "pitch " : "roll ");
  OUT(stepDeg, 1);
  OUT(" deg: ");
  if (stepT90 < 0) OUT("never reached 90 %");
  else {
    OUT("rise ");
    OUT(stepT90 - stepT10, 2);
    OUT(" s");
  }
  OUT(", overshoot ");
  OUT(stepPeak > 1 ? (stepPeak - 1) * 100 : 0, 0);
  OUT(" %, ");
  if (stepSettle >= watch) OUT("not settled");
  else {
    OUT("within 10 % after ");
    OUT(stepSettle, 2);
    OUT(" s");
  }
  OUT(", error ");
  OUT((1 - y) * stepDeg, 2);
  OUTLN(" deg");
  cmd[stepAxis] -= stepDeg * DEG;
  logOn = stepLogWas;
  stepAxis = -1;
}

void logHeader() { OUTLN("log: roll, pitch, yaw (deg), gx, gy, gz (deg/s), vane 1-4 (deg), thrust (%), cell (N)"); }
`
    : `// "step roll 5" while holding: the setpoint jumps, the log runs, and after STEP_S it prints the 10-90 % rise,
// the overshoot, when it last left the 10 % band and the error left, then the setpoint goes back.
void stepWatch(uint32_t now) {
  float y = ((stepAxis ? pitch : roll) / DEG - stepY0) / stepDeg;
  float t = (now - stepAt) * 0.001f;
  if (stepT10 < 0 && y >= 0.1f) stepT10 = t;
  if (stepT90 < 0 && y >= 0.9f) stepT90 = t;
  if (y > stepPeak) stepPeak = y;
  if (fabs(y - 1) > 0.1f) stepSettle = t;
  if (t < STEP_S) return;
  OUT("step ");
  OUT(stepAxis ? "pitch " : "roll ");
  OUT(stepDeg, 1);
  OUT(" deg: ");
  if (stepT90 < 0) OUT("never reached 90 %");
  else {
    OUT("rise ");
    OUT(stepT90 - stepT10, 2);
    OUT(" s");
  }
  OUT(", overshoot ");
  OUT(stepPeak > 1 ? (stepPeak - 1) * 100 : 0, 0);
  OUT(" %, ");
  if (stepSettle >= STEP_S) OUT("not settled");
  else {
    OUT("within 10 % after ");
    OUT(stepSettle, 2);
    OUT(" s");
  }
  OUT(", error ");
  OUT((1 - y) * stepDeg, 2);
  OUTLN(" deg");
  cmd[stepAxis] -= stepDeg * DEG;
  logOn = stepLogWas;
  stepAxis = -1;
}

void logHeader() { OUTLN("log: roll, pitch (deg), gx, gy (deg/s), vane 1-4 (deg), thrust (%), cell (N)"); }
`;

  const ino = `// ${cComment(c.designName)}: jet-vane balance firmware for the ${cComment(bp.name)}, generated by Kerf.
//
// 500 Hz loop: ${imu ? "LSM6DSOX" : "IMU"} gyro and accelerometer -> complementary filter -> PD + I per axis in torque
// units with the fan rotor's gyroscopic coupling cancelled -> X mix -> four vane servos at SERVO_HZ${viaHub ? `, their
// pulses and the ESC's made by the servo board (PCA9685) over I2C` : ""}.
${yawOn ? `// Third axis: the unit also turns about its own jet. The gyro's Z rate gives the heading, and all four vanes
// turned the same way hold it against the jet's swirl and the rotor's spin-up.
` : ""}${estopCut ? `// Safety: the e-stop's contact is in the servo board's logic supply, so pressing it stops every pulse in
// hardware (the ESC cuts on losing its signal) and the firmware latches a fault when the board goes quiet or
// answers with its settings gone; the fan also cuts past TILT_CUT_DEG or when the IMU stops answering, the
// throttle ramps, and it arms only level and still.` : `// Safety: the e-stop latches a fault (its normally-closed contact also breaks the ESC signal in hardware),
// the fan cuts past TILT_CUT_DEG or when the IMU stops answering, the throttle ramps, and it arms only
// level and still.`} Console: USB serial 115200${btConsole ? ' and Bluetooth serial ("JetVane")' : ""}, type "help".
//
// Board: ${cComment(String(bp.specs.fqbn ?? bp.name))}. ${viaHub ? "No libraries beyond the board's core." : "Library: ESP32Servo (Kevin Harrington)."}
#include <Arduino.h>
#include <Wire.h>
${viaHub ? "" : "#include <ESP32Servo.h>\n"}#include <EEPROM.h>
#include "config.h"
#if BT_CONSOLE
// the same console over Bluetooth serial: USB is for uploading and bench tests with the locks in, and a free run
// has no cable on the gimbal
#include <BluetoothSerial.h>
BluetoothSerial SerialBT;
#define OUT(...) do { Serial.print(__VA_ARGS__); SerialBT.print(__VA_ARGS__); } while (0)
#define OUTLN(...) do { Serial.println(__VA_ARGS__); SerialBT.println(__VA_ARGS__); } while (0)
#else
#define OUT(...) Serial.print(__VA_ARGS__)
#define OUTLN(...) Serial.println(__VA_ARGS__)
#endif

#define DEG 0.01745329252f

${viaHub ? "" : `Servo vane1;
Servo vane2;
Servo vane3;
Servo vane4;
Servo esc;

`}enum Mode : uint8_t { M_DISARMED, M_ARMED, M_HOLD, M_SERVO, M_SWEEP, M_COUPLE, M_FAULT };
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
${yawOn ? `// the heading: the gyro's Z rate summed from YAW_HOME_DEG at arming (it drifts by a degree or so a minute)
float yaw = 0;
float gzf = 0;
` : ""}float bias[3] = {0, 0, 0};
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
// the set point asked for, and where its model is on the way there
float cmd[${nAx}] = {${zeros}};
float ref[${nAx}] = {${zeros}};
float refRate[${nAx}] = {${zeros}};
${yawOn ? `// the vane angle the heading loop puts on all four, degrees; the part of it that holds off the jet's swirl
// ("save" keeps it); and how fast the rotor is being asked to speed up
float yawVane = 0;
float yawTrim = YAW_TRIM_DEG;
float spool = 0;
float rootWas = 0;
${homeStop ? `// the heading has been taken from the home stop since arming
bool yawHomed = false;
` : ""}` : ""}bool saturated = false;
uint32_t lastTick = 0;
uint32_t lastLog = 0;
bool logOn = false;
uint32_t overruns = 0;
${viaHub || nau ? "// the passes take turns on the I2C bus\nuint8_t turn = 0;\n" : ""}
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
  ok = ok && imuWrite(0x10, 0x8E);  // accel 1.66 kHz, +-8 g (room for the fan's vibration), LPF2 on
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
    ac[i] = raw[i + 3] * 0.000244f;
  }
  for (uint8_t j = 0; j < 3; j++) {
    g[j] = imuR[j][0] * gc[0] + imuR[j][1] * gc[1] + imuR[j][2] * gc[2];
    a[j] = imuR[j][0] * ac[0] + imuR[j][1] * ac[1] + imuR[j][2] * ac[2];
  }
  return sameCount < 50;
}

// the gyro's bias: its mean over 0.5 s, kept only when the unit held still all through it. A bias taken while the
// unit swings (it can still be settling on its pivots after power-up) is off by the swing's rate, and the attitude
// filter turns that into a steady tilt the loop then holds; one taken while it creeps steadily would also make a
// still unit read as turning, and the arm check would refuse it for good. Returns whether it was still.
bool calibrateGyro() {
  float s[3] = {0, 0, 0};
  float lo[3] = {1e9f, 1e9f, 1e9f};
  float hi[3] = {-1e9f, -1e9f, -1e9f};
  int n = 0;
  for (int k = 0; k < 250; k++) {
    float g[3], a[3];
    if (imuSample(g, a)) {
      for (int i = 0; i < 3; i++) {
        s[i] += g[i];
        lo[i] = min(lo[i], g[i]);
        hi[i] = max(hi[i], g[i]);
      }
      n++;
    }
    delay(2);
  }
  if (n < 100) return false;
  for (int i = 0; i < 3; i++)
    if (hi[i] - lo[i] > 2 * CAL_STILL_DPS * DEG || fabs(s[i] / n) > CAL_MAX_BIAS_DPS * DEG) return false;
  for (int i = 0; i < 3; i++) bias[i] = s[i] / n;
  return true;
}

${cellCode}
${hubCode}// ---------------------------------------------------------------- outputs
${outCode}
void writeVanes(float *v) {
  for (int i = 0; i < 4; i++) {
    float a = constrain(v[i], -VANE_MAX_DEG, VANE_MAX_DEG);
    vaneCmd[i] = a;
    float us = centerUs[i] + VANE_DIR[i] * a * SERVO_US_PER_DEG;
    servoUs(i, (int)constrain(us, (float)SERVO_MIN_US, (float)SERVO_MAX_US));
  }
}

// static thrust goes with fan speed squared and speed with throttle, so the throttle is sqrt(thrust); frac is the
// share of the rig's full thrust, THRUST_CAP of the fan's own. No thrust is the stop pulse, under the ESC's range
void writeEsc(float frac) {
  float u = frac <= 0 ? 0 : sqrt(frac * THRUST_CAP);
  int us = u <= 0 ? ESC_STOP_US : ESC_MIN_US + (int)(u * (ESC_MAX_US - ESC_MIN_US));
  ${escOut}
}

void centre() {
  float z[4] = {0, 0, 0, 0};
  writeVanes(z);
}

// ---------------------------------------------------------------- states
void say(const char *what) {
  OUT("state: ");
  OUTLN(what);
}

void fault(const char *why) {
  if (mode != M_FAULT) {
    strncpy(faultText, why, sizeof(faultText) - 1);
    faultText[sizeof(faultText) - 1] = 0;
    OUT("FAULT: ");
    OUT(why);
    OUTLN(". Fan off, vanes centred. Fix it, release the e-stop, then reset.");
  }
  mode = M_FAULT;
  thrustTarget = 0;
  thrust = 0;
  writeEsc(0);
  centre();
${viaHub ? "  if (hubUp) hubSend();\n" : ""}}

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
    OUT("state: fault (");
    OUT(faultText);
    OUTLN(")");
  }
}

${viaHub ? `// the e-stop's contact is in the servo board's logic supply: a board that is not up is the e-stop pressed (or
// its lead off). A switch contact on a pin counts too
bool estopPressed() { return !hubUp || (PIN_ESTOP >= 0 && digitalRead(PIN_ESTOP) == LOW); }` : "bool estopPressed() { return PIN_ESTOP >= 0 && digitalRead(PIN_ESTOP) == LOW; }"}

// ---------------------------------------------------------------- the controller
${controlCode}
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
  OUT("sweep ");
  OUT(sweepDeg, 0);
  OUT(" deg: ");
  OUT(f, 3);
  OUT(" N, ");
  OUT(m * 1000, 2);
  OUTLN(" mN m");
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
  OUT("vane moment: ");
  OUT(slope * 1000, 3);
  OUT(" mN m per deg, predicted ");
  OUT(predicted * 1000, 3);
  OUT(": set LIFT_K to ");
  OUTLN(predicted > 0 ? liftK * fabs(slope) / predicted : 0, 2);
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
  cmd[0] = 0;
  refRate[0] = 0;
  integ[0] = 0;
  thrustTarget = 0;
  mode = M_ARMED;
  centre();
  float fp = cpN ? cp / cpN : 0;
  float fm = cmN ? cm / cmN : 0;
  OUT("coupling: pitch nudge +");
  OUT(COUPLE_NUDGE_DEG, 0);
  OUT(" deg reads ");
  OUT(fp, 3);
  OUT(" N, -");
  OUT(COUPLE_NUDGE_DEG, 0);
  OUT(" deg reads ");
  OUT(fm, 3);
  OUTLN(" N; fan back to 0");
  float den = sn * sxx - sx * sx;
  if (sn < 10 || den <= 1e-9f || fabs(fp - fm) < 0.02f) {
    OUTLN("coupling: the load cell did not follow: fit the cell link, tare, and run it at 50 % thrust or more");
    return;
  }
  int sgn = fp > fm ? 1 : -1;
  float num = sn * sxy - sx * sy;
  float H = sgn * num / den;
  float vy = sn * syy - sy * sy;
  float r2 = vy > 1e-12f ? num * num / (den * vy) : 0;
  float predicted = rotorDir * H_FULL * sqrt(thrust);
  OUT("rotor momentum: ");
  OUT(H * 1000, 1);
  OUT(" mN m s at ");
  OUT(thrust * 100, 0);
  OUT(" % thrust, predicted ");
  OUT(predicted * 1000, 1);
  OUT(" (fit r2 ");
  OUT(r2, 2);
  OUTLN(")");
  if (H * rotorDir >= 0) OUTLN("rotor direction matches ROTOR_DIR");
  else {
    OUT("the rotor turns the other way: rotor ");
    OUT(-rotorDir);
    OUTLN(", then save");
  }
  OUT("H_FULL from this run: ");
  OUTLN(thrust > 0 ? fabs(H) / sqrt(thrust) : 0, 4);
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
  float mDeg = M_DEG_MIX_FULL * liftK * (thrust < 0.3f ? 0.3f : thrust);
  integ[0] += err * dt;
  float lim = ki > 1e-9f ? I_SHARE * 1.414f * VANE_MAX_DEG * mDeg / ki : 0;
  integ[0] = constrain(integ[0], -lim, lim);
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
      // the nudges give the cell's sign, so only the lever's length counts here
      float m = cellN * fabs(CELL_LEVER_M);
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
${stepCode}
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
${yawOn ? "  EEPROM.write(1, 0x59);\n  putLong(44, (long)(yawTrim * 1000));\n" : ""}  EEPROM.commit();
  OUTLN("saved");
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
${yawOn ? "  if (EEPROM.read(1) == 0x59) yawTrim = constrain(getLong(44) / 1000.0f, -YAW_VANE_MAX_DEG, YAW_VANE_MAX_DEG);\n" : ""}}

// ---------------------------------------------------------------- console
void help() {
  OUTLN("arm            arm (level, still, e-stop out, IMU answering)");
  OUTLN("t <percent>    thrust target, share of full thrust (THRUST_CAP of the fan's own)");
  OUTLN("hold           close the balance loop (vanes work from 25 % thrust)");
  OUTLN("stop           fan off, vanes centred, disarmed");
  OUTLN("reset          clear a fault once the e-stop is released");
  OUTLN("servo <1-4> <deg> / servo off   move one vane, fan off");
  OUTLN("sign           each vane to +10 deg in turn: check the push matches the README");
  OUTLN("trim <1-4> <us>  a servo's centre pulse");
  OUTLN("sweep          static force test (roll locked, load cell fitted, armed at thrust)");
  OUTLN("couple         gyroscopic coupling test (roll free, Y on the load cell link, armed at thrust)");
${yawOn ? `  OUTLN("step roll|pitch|yaw <deg>  a setpoint step while holding: prints rise, overshoot, settling");
  OUTLN("yaw <deg>      turn to a heading while holding (0 is the middle of the travel)");
` : `  OUTLN("step roll|pitch <deg>  a setpoint step while holding: prints rise, overshoot, settling");
`}  OUTLN("tare / cal <grams>  zero the load cell / scale it with a known weight");
  OUTLN("gain <x>  liftk <x>  gyrok <x>  rotor <1|-1>  save  show");
${yawOn ? `  OUTLN("log            50 Hz log on/off: roll, pitch, heading, gyro rates, vanes, thrust, load cell");
` : `  OUTLN("log            50 Hz log on/off: roll, pitch, gyro rates, vanes, thrust, load cell");
`}}

void show() {
  OUT("gain ");
  OUT(gainScale, 2);
  OUT(" liftk ");
  OUT(liftK, 2);
  OUT(" gyrok ");
  OUT(gyroK, 2);
  OUT(" rotor ");
  OUTLN(rotorDir);
  OUT("roll ");
  OUT(roll / DEG, 2);
  OUT(" pitch ");
  OUT(pitch / DEG, 2);
${yawOn ? `  OUT(" yaw ");
  OUT(yaw / DEG, 1);
` : ""}  OUT(" thrust ");
  OUT(thrust * 100, 0);
  OUT(" % cell ");
  OUT(cellN, 3);
  OUTLN(" N");
${yawOn ? `  OUT("heading trim ");
  OUT(yawTrim, 2);
  OUTLN(" deg of vane");
` : ""}${viaHub ? `  OUT("servo board clock ");
  OUT(hubOsc / 1000000.0f, 3);
  OUTLN(hubTimed ? " MHz (timed)" : " MHz (not timed: the value in config.h)");
` : ""}}

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
${viaHub ? `    // the servo board comes back with its settings gone once the e-stop is released: set it up again
    if ((!hubUp${sensePin >= 0 ? " || !hubTimed" : ""}) && hubBegin()) hubSend();
    if (estopPressed()) OUTLN("release the e-stop first (the servo board has to answer)");` : `    if (estopPressed()) OUTLN("release the e-stop first");`}
    else if (mode == M_FAULT) mode = M_DISARMED;
  } else if (!strcmp(s, "arm")) {
    if (mode == M_FAULT) OUTLN("clear the fault first: reset");
    else if (estopPressed()) OUTLN("e-stop is pressed");
    else if (!imuFound || now - lastImuOk > IMU_TIMEOUT_MS) OUTLN("IMU not answering");
    else if (fabs(roll) > ARM_LEVEL_DEG * DEG || fabs(pitch) > ARM_LEVEL_DEG * DEG) OUTLN("not level: within 5 deg to arm");
    else if (fabs(gxf) > ARM_STILL_DPS * DEG || fabs(gyf) > ARM_STILL_DPS * DEG${yawOn ? " || fabs(gzf) > ARM_STILL_DPS * DEG" : ""}) OUTLN("not still");
${viaHub && sensePin >= 0 ? `    else if (!hubTimed) OUTLN("servo board clock not timed: check the jumper from its channel ${senseCh} to pin ${sensePin}, then reset");
` : ""}    else if (${viaHub ? "now - hubUpAt < ESC_ARM_MS" : "now < ESC_ARM_MS"}) OUTLN("ESC still arming: try again in a second");
    // the gyro's bias again, now the unit sits still, and the attitude restarted from the accelerometer
    else if (!calibrateGyro()) OUTLN("moved while the gyro was measured: hold it still and arm again");
    else {
      estStarted = false;
${yawOn ? `      // the heading counts from here: the unit sits where YAW_HOME_DEG says
      yaw = YAW_HOME_DEG * DEG;
      gzf = 0;
${homeStop ? "      yawHomed = false;\n" : ""}` : ""}      lastImuOk = millis();
      lastTick = micros();
      thrustTarget = 0;
      mode = M_ARMED;
    }
  } else if (!strncmp(s, "t ", 2)) {
    if (mode == M_ARMED || mode == M_HOLD) thrustTarget = constrain(arg(s) / 100.0f, 0.0f, 1.0f);
    else OUTLN("arm first");
  } else if (!strcmp(s, "hold")) {
    if (mode == M_ARMED) {
      integ[0] = integ[1] = 0;
      ref[0] = ref[1] = 0;
      cmd[0] = cmd[1] = 0;
      refRate[0] = refRate[1] = 0;
${yawOn ? "      // the heading goes from wherever the unit sits to the middle of its travel\n      cmd[2] = 0;\n" : ""}      mode = M_HOLD;
    } else OUTLN("arm first");
  } else if (!strcmp(s, "sweep")) {
    if (mode != M_ARMED || thrust < THRUST_LOOP_MIN) OUTLN("arm and set a thrust first (t 70)");
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
    if (mode != M_ARMED || thrust < THRUST_LOOP_MIN) OUTLN("arm and set a thrust first (t 70)");
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
      cmd[0] = cmd[1] = 0;
      refRate[0] = refRate[1] = 0;
      mode = M_COUPLE;
      OUTLN("coupling test: pitch nudges for 3 s, then the roll wave");
    }
  } else if (!strncmp(s, "step ", 5)) {
${yawOn ? `    int ax = !strncmp(s + 5, "roll", 4) ? 0 : !strncmp(s + 5, "pitch", 5) ? 1 : !strncmp(s + 5, "yaw", 3) ? 2 : -1;
    float d = arg(s + 5);
    if (mode != M_HOLD || thrust < THRUST_LOOP_MIN) OUTLN("hold at thrust first");
    else if (stepAxis >= 0) OUTLN("a step is running");
    else if (ax < 0 || d == 0 || fabs(d) > (ax == 2 ? 30 : 10)) OUTLN("step roll <deg> or step pitch <deg>, up to 10 deg; step yaw <deg>, up to 30");
    else if (ax == 2 && fabs(cmd[2] / DEG + d) > YAW_RANGE_DEG) OUTLN("that heading is past YAW_RANGE_DEG");` : `    int ax = !strncmp(s + 5, "roll", 4) ? 0 : !strncmp(s + 5, "pitch", 5) ? 1 : -1;
    float d = arg(s + 5);
    if (mode != M_HOLD || thrust < THRUST_LOOP_MIN) OUTLN("hold at thrust first");
    else if (stepAxis >= 0) OUTLN("a step is running");
    else if (ax < 0 || d == 0 || fabs(d) > 10) OUTLN("step roll <deg> or step pitch <deg>, up to 10 deg");`}
    else {
      stepAxis = ax;
      stepDeg = d;
      stepAt = now;
      // measured from the setpoint it leaves, so a unit still settling from a knock does not skew it
      stepY0 = cmd[ax] / DEG;
      stepPeak = 0;
      stepT10 = stepT90 = -1;
      stepSettle = 0;
      stepLogWas = logOn;
      if (!logOn) logHeader();
      logOn = true;
      cmd[ax] += d * DEG;
    }
${yawOn ? `  } else if (!strncmp(s, "yaw ", 4)) {
    if (mode != M_HOLD) OUTLN("hold first");
    else if (stepAxis == 2) OUTLN("a step is running");
    else cmd[2] = constrain(arg(s), -YAW_RANGE_DEG, YAW_RANGE_DEG) * DEG;
` : ""}  } else if (!strcmp(s, "servo off")) {
    if (mode == M_SERVO) mode = M_DISARMED;
    centre();
  } else if (!strncmp(s, "servo ", 6)) {
    int i = atoi(s + 6) - 1;
    if (mode != M_DISARMED && mode != M_SERVO) OUTLN("fan off first: stop");
    else if (i < 0 || i > 3) OUTLN("servo 1 to 4");
    else {
      for (int k = 0; k < 4; k++) manualVane[k] = 0;
      manualVane[i] = arg(s + 6);
      mode = M_SERVO;
    }
  } else if (!strcmp(s, "sign")) {
    if (mode != M_DISARMED && mode != M_SERVO) OUTLN("fan off first: stop");
    else {
      for (int k = 0; k < 4; k++) manualVane[k] = 0;
      manualVane[0] = 10;
      mode = M_SERVO;
      OUTLN("vane 1 at +10 deg; servo 2 10, servo 3 10, servo 4 10 for the others, servo off to finish");
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
  else if (s[0]) OUTLN("? type help");
}

void feed(char ch, uint32_t now) {
  if (ch == '\\r') return;
  if (ch == '\\n') {
    line[lineLen] = 0;
    command(line, now);
    lineLen = 0;
  } else if (lineLen < sizeof(line) - 1) line[lineLen++] = ch;
}

void console(uint32_t now) {
  while (Serial.available()) feed(Serial.read(), now);
#if BT_CONSOLE
  while (SerialBT.available()) feed(SerialBT.read(), now);
#endif
}

// ---------------------------------------------------------------- setup and loop
void setup() {
${viaHub ? `  if (PIN_I2C_POWER >= 0) {
    // the STEMMA QT socket's power switch
    pinMode(PIN_I2C_POWER, OUTPUT);
    digitalWrite(PIN_I2C_POWER, HIGH);
  }
  loadSettings();
  // The servo board before anything slow: every output off, then the ESC's stop pulse so it arms. After a reset
  // of the controller alone, this is also what ends the pulses the board was still sending.
  Wire.begin();
  Wire.setClock(400000);
  delay(20);
  writeEsc(0);
  centre();
  if (hubBegin()) hubSend();
  Serial.begin(115200);
#if BT_CONSOLE
  SerialBT.begin(BT_NAME);
#endif
  if (PIN_ESTOP >= 0) pinMode(PIN_ESTOP, INPUT_PULLUP);
${hx ? `  if (PIN_HX_SCK >= 0) {
    pinMode(PIN_HX_SCK, OUTPUT);
    digitalWrite(PIN_HX_SCK, LOW);
  }
  if (PIN_HX_DOUT >= 0) pinMode(PIN_HX_DOUT, INPUT);
` : ""}  pinMode(PIN_LED, OUTPUT);
  // not answering: the loop's first pass latches the e-stop fault; until then make sure it sends nothing
  if (!hubUp) hubSafe();
${hubOnQt ? `  if (hubCutAt) {
    delay(150);
    hubRestore();
  }
` : ""}` : `  Serial.begin(115200);
#if BT_CONSOLE
  SerialBT.begin(BT_NAME);
#endif
  if (PIN_I2C_POWER >= 0) {
    // the STEMMA QT socket's power switch
    pinMode(PIN_I2C_POWER, OUTPUT);
    digitalWrite(PIN_I2C_POWER, HIGH);
  }
  if (PIN_ESTOP >= 0) pinMode(PIN_ESTOP, INPUT_PULLUP);
${nau ? "" : `  if (PIN_HX_SCK >= 0) {
    pinMode(PIN_HX_SCK, OUTPUT);
    digitalWrite(PIN_HX_SCK, LOW);
  }
  if (PIN_HX_DOUT >= 0) pinMode(PIN_HX_DOUT, INPUT);
`}  pinMode(PIN_LED, OUTPUT);
  loadSettings();
  // the ESC first, at its stop pulse, so it arms
  esc.setPeriodHertz(ESC_HZ);
  esc.attach(PIN_ESC, ESC_STOP_US, ESC_MAX_US);
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
`}${nau ? `  if (!cellBegin()) OUTLN("load cell board (NAU7802) not found at 0x${nauAddr.toString(16).toUpperCase()}: the force tests need it");
` : ""}  imuFound = imuBegin();
  if (!imuFound) {
    OUTLN("LSM6DSOX not found at 0x6A: check the STEMMA QT cable");
    fault("IMU not found");
  } else {
    delay(50);
    // up to 5 s for the unit to settle on its pivots; arming measures the bias again
    for (int k = 0; k < 10 && !calibrateGyro(); k++) {}
    lastImuOk = millis();
  }
  OUTLN("jet vane balance ready: type help");
  lastTick = micros();
}

void loop() {
  uint32_t now = millis();
  console(now);
${hubOnQt ? "  if (hubCutAt && now - hubCutAt >= 150) hubRestore();\n" : ""}${nau ? "" : `  if (cellReady()) {
    cellRaw = cellRead();
    cellN = (cellRaw - cellOffset) / cellCountsPerN;
    cellSamples++;
  }
`}  uint32_t us = micros();
  if ((uint32_t)(us - lastTick) < LOOP_US) return;
  float dt = (us - lastTick) * 1e-6f;
  if (dt > 0.01f) {
    dt = 0.01f;
    overruns++;
  }
  lastTick = us;
${viaHub || nau ? "  turn ^= 1;\n" : ""}${nau ? `  // the load cell board is asked on every other pass${viaHub ? ", the one the servo board is not sent its pulses on" : ""}
  if (!turn && cellReady()) {
    cellRaw = cellRead();
    cellN = (cellRaw - cellOffset) / cellCountsPerN;
    cellSamples++;
  }
` : ""}
  float g[3] = {0, 0, 0};
  float a[3] = {0, 0, 1};
  if (imuFound && imuSample(g, a)) {
    float an = sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
    if (an > 0.3f && an < 3.0f) lastImuOk = now;
    for (int i = 0; i < 3; i++) g[i] -= bias[i];
    float b = exp(-2.0f * PI * D_FILTER_HZ * dt);
    gxf = b * gxf + (1 - b) * g[0];
    gyf = b * gyf + (1 - b) * g[1];
${yawOn ? "    gzf = b * gzf + (1 - b) * g[2];\n" : ""}    float ra = atan2(a[1], a[2]);
    float pa = atan2(-a[0], sqrt(a[1] * a[1] + a[2] * a[2]));
    if (!estStarted) {
      roll = ra;
      pitch = pa;
      estStarted = true;
    } else {
      float k = COMP_TAU_S / (COMP_TAU_S + dt);
${yawOn ? `      // turning about the jet swings a tilt from one of the unit's axes to the other
      float r0 = roll;
      roll = k * (roll + (g[0] + pitch * g[2]) * dt) + (1 - k) * ra;
      pitch = k * (pitch + (g[1] - r0 * g[2]) * dt) + (1 - k) * pa;
    }
    yaw += g[2] * dt;
` : `      roll = k * (roll + g[0] * dt) + (1 - k) * ra;
      pitch = k * (pitch + g[1] * dt) + (1 - k) * pa;
    }
`}  }

  // safety, every pass
  bool running = mode == M_ARMED || mode == M_HOLD || mode == M_SWEEP || mode == M_COUPLE;
  if (estopPressed() && mode != M_FAULT) fault("${estopSays}");
  // a reading that has not changed for 50 samples (0.1 s) is a frozen sensor, not a still rig: the noise alone moves it
  else if (running && now - lastImuOk > IMU_TIMEOUT_MS) fault(sameCount >= 50 ? "IMU frozen (the same reading 50 times)" : "IMU stopped answering");
  else if (running && (fabs(roll) > TILT_CUT_DEG * DEG || fabs(pitch) > TILT_CUT_DEG * DEG)) fault("tilted past the cut-off");
  running = mode == M_ARMED || mode == M_HOLD || mode == M_SWEEP || mode == M_COUPLE;
  if (stepAxis >= 0 && mode != M_HOLD) {
    // a stop or a fault ends the step
    stepAxis = -1;
    logOn = stepLogWas;
  }

${yawOn ? `  // throttle: ramps up, drops at once. While the loop holds the heading it moves both ways at the slower
  // THRUST_RAMP_HOLD_PER_S, so the twist from the rotor changing speed stays inside what the vanes can hold
  if (!running) thrustTarget = 0;
  bool looping = mode == M_HOLD && thrust >= THRUST_LOOP_MIN;
  float ramp = looping ? THRUST_RAMP_HOLD_PER_S : THRUST_RAMP_PER_S;
  if (thrustTarget > thrust) thrust = min(thrustTarget, thrust + ramp * dt);
  else if (looping && thrustTarget >= THRUST_LOOP_MIN) thrust = max(thrustTarget, thrust - ramp * dt);
  else thrust = thrustTarget;
  writeEsc(running ? thrust : 0);
  // how fast the rotor is being asked to change speed (speed goes with sqrt(thrust)), smoothed over the 0.1 s
  // or so it takes to follow
  float root = sqrt(thrust > 0 ? thrust : 0);
  spool += ((root - rootWas) / dt - spool) * dt / (0.1f + dt);
  rootWas = root;
${homeStop ? `  if (mode == M_HOLD && thrust >= THRUST_LOOP_MIN && !yawHomed) {
    // the loop closes for the first time since arming. The rotor starting up twisted the unit onto its home stop,
    // wherever it sat before, so the heading is that stop's, not what the gyro summed on the way there
    yawHomed = true;
    yaw = YAW_HOME_DEG * DEG;
    ref[2] = yaw;
    refRate[2] = 0;
  }
` : ""}  if (!(mode == M_HOLD && thrust >= THRUST_LOOP_MIN)) {
    // the heading loop is open: no common angle, and its path starts from wherever the unit sits when it closes
    yawVane = 0;
    ref[2] = yaw;
    refRate[2] = 0;
  }
` : `  // throttle: ramps up, drops at once
  if (!running) thrustTarget = 0;
  if (thrustTarget > thrust) thrust = min(thrustTarget, thrust + THRUST_RAMP_PER_S * dt);
  else thrust = thrustTarget;
  writeEsc(running ? thrust : 0);
`}
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
${viaHub ? "  hubService();\n" : ""}  digitalWrite(PIN_LED, running ? HIGH : LOW);
  showMode();

  if (logOn && now - lastLog >= 20) {
    lastLog = now;
    OUT(roll / DEG, 2);
    OUT(",");
    OUT(pitch / DEG, 2);
    OUT(",");
${yawOn ? `    OUT(yaw / DEG, 1);
    OUT(",");
` : ""}    OUT(gxf / DEG, 1);
    OUT(",");
    OUT(gyf / DEG, 1);
${yawOn ? `    OUT(",");
    OUT(gzf / DEG, 1);
` : ""}    for (int i = 0; i < 4; i++) {
      OUT(",");
      OUT(vaneCmd[i], 1);
    }
    OUT(",");
    OUT(thrust * 100, 0);
    OUT(",");
    OUTLN(cellN, 3);
  }
}
`;

  const wiring = pinTable.map((p) => `| ${p.signal} | ${p.pin} | ${p.wire} |`).join("\n");
  const hubLabel = hub ? oneLine(hubPart?.name ?? hub.name) : "";
  const prescale = Math.max(3, Math.round(hubOsc / (4096 * S.servoHz)) - 1);
  const frameHz = Math.round((hubOsc / (4096 * (prescale + 1))) * 10) / 10;
  const readme = `# ${oneLine(c.designName)}: ${oneLine(c.fw.name)}

Jet-vane balance firmware for the ${oneLine(bp.name)}, generated by Kerf from the design's wiring. Everything you calibrate lives in \`config.h\` or in flash (\`save\`).

## Build

Arduino IDE 2: board **${oneLine(String(bp.specs.fqbn ?? bp.name))}** (arduino-esp32 core)${viaHub ? ", no extra libraries" : ", library **ESP32Servo**"}. USB serial at 115200; type \`help\`.${btConsole ? `

**No cable on the gimbal.** The same console runs over Bluetooth serial: pair with **JetVane** from a laptop or a phone, open its serial port in any terminal (115200 is ignored) and type the same commands. Use USB to upload and for bench tests with the lock screws in; unplug it before a free run, because a USB lead hanging off the fan unit pulls it off level.` : ""}

## Pins

| Signal | Pin | Wire |
|---|---|---|
${wiring}

## What it does

A 500 Hz loop reads the LSM6DSOX (gyro and accelerometer in one burst), runs a complementary filter (0.5 s) on a gyro bias measured with the unit still (at power-up once it settles, and again at \`arm\`), and holds the fan unit level with a PD + I controller per axis in torque units: gains from the rig's inertia (I_ROLL, I_PITCH) for a ${cNum(S.wn)} rad/s, ζ ${cNum(S.zeta)} response, scaled by GAIN_SCALE (${cNum(S.gainScale)} for first runs). The integral term may hold up to ${cNum(Math.round(S.iShare * 100))} % of the vanes' full moment about an axis, which trims out an off-centre mass or a steady push, and it only unwinds while the vanes are at their limit. A set-point step (\`step\`) moves along a critically damped path at ${cNum(S.refWn)} rad/s whose acceleration is fed forward, so the unit follows it without overshooting. The fan rotor's gyroscopic push is cancelled (GYRO_K ${cNum(S.gyroK)}) and the two torques are mixed onto the four vanes in an X, all four scaled back together past ±${cNum(S.vaneMax)}°.
${yawOn ? `
**The third axis.** The unit also turns about its own jet. Its heading is the gyro's Z rate summed from YAW_HOME_DEG at \`arm\` (it drifts by a degree or so a minute, which a run does not notice)${homeStop ? ". YAW_HOME_DEG is the end stop the rotor's start-up twists the unit onto, so that stop is the heading's datum: the firmware takes the stop's angle once more when the loop first closes after \`arm\`, wherever the unit sat before" : ""}, and the loop holds it with all four vanes turned the same way: a common angle turns the unit about the jet and tilts nothing. It is a PD in torque units (${cNum(S.wnYaw)} rad/s, ζ ${cNum(S.zetaYaw)}) with two things fed forward: the heading path's own acceleration, and the twist the rotor gives the unit whenever it changes speed. What is left of the fan's swirl after its stators twists the unit steadily; that and the vanes' moment both go with thrust, so one vane angle holds it off at any thrust. The loop finds that angle (\`show\` prints it as the heading trim) and \`save\` keeps it. The heading may use up to ±${cNum(Math.min(S.yawVane, S.vaneMax * 0.6))}° of vane; roll and pitch always keep the rest. Roll and pitch are still measured and steered in the unit's own axes (the IMU and the vanes turn with it), and the controller turns the wanted accelerations into the gimbal's axes by the heading before it applies the inertias, because the roll ring and the pitch arch do not turn with the unit.
` : ""}${viaHub ? `
**Pulses.** The ${hubLabel} makes all five pulses (four vanes and the ESC) and the controller sets them over I2C, so the servos and the ESC plug straight onto the board. One frame rate serves every output: SERVO_HZ ${cNum(S.servoHz)} asks for it and the chip's divider gives about ${cNum(frameHz)} Hz. The chip's oscillator is 25 MHz on paper and up to 8 % out on a real one, and every pulse is out by the same share, the ESC's too: uncorrected, that is the fan running well over or under the thrust asked for. ${sensePin >= 0 ? `So the firmware measures it: channel ${senseCh} gives a pulse of half a frame, the jumper carries it to pin ${sensePin}, and the controller times it against its own crystal at every start-up and \`reset\`. \`show\` prints the clock it found, and \`arm\` refuses until it has one (check the jumper).` : `Measure it once: a multimeter on Hz between a channel's signal pin and GND reads the frame rate; set HUB_OSC_HZ as \`config.h\` says. Better, wire a spare channel's signal pin back to a free controller pin in the design and the firmware times the board itself.`} The ESC's stop pulse (${escStop} µs) sits under its range (${escMin} to ${escMax} µs), so it arms either way. If the ESC will not arm at this frame rate, set \`servo_hz: 50\` in the design's firmware block (slower vanes, but every ESC takes 50 Hz).
` : ""}
Safety: ${estopCut ? `the e-stop's normally-closed contact is in the ${hubLabel}'s logic supply. Pressing it stops every pulse in hardware: the ESC stops the fan ${cNum(Number(escPart?.specs.signal_loss_ms ?? 250) / 1000)} s after its pulses end, whatever the firmware is doing. The firmware asks the board every 4 ms whether it is still set up, and a board that has gone quiet or answers with its settings gone latches a fault; after the e-stop is released, \`reset\` sets the board up again and \`arm\` waits for the ESC to arm.${hubOnQt ? " If the board stops answering while its pulses may still be running (a data wire off), the firmware switches the STEMMA QT socket's 3.3 V off for 0.15 s, which resets the board with every output off." : ""} The` : estopPin >= 0 ? "the e-stop's normally-closed contact breaks the ESC signal in hardware, and its normally-open contact latches a fault in the firmware; the" : "the"} fan also cuts past ±${cNum(S.tiltCut)}°, when the IMU stops answering for ${20} ms, or on \`stop\`. It arms only within ±${cNum(S.armLevel)}° and still, after the ESC has had its ${viaHub ? "stop pulse" : "signal at minimum"} for ${2.5} s.

## Bench order

1. **Servos** (fan off): \`servo 1 10\` … sight along each vane's hinge line with a protractor (or a card cut to 10°) held on the nozzle's end: the vane should stand straight at 0 and turn to +10°; \`trim\` and \`save\`. SERVO_US_PER_DEG is ${cNum(Math.round(usPerDeg * 100) / 100)} µs/° from the servo's catalogue range: measure yours.
2. **Sign test** (fan off): \`sign\`, then \`servo 2 10\` and so on. Each vane at +10° should push the unit the way the design's drawing shows; flip VANE_DIR for any that do not.
3. **Static force test**: roll ${yawOn ? "and yaw " : ""}locked, the load cell link fitted, \`tare\`, \`arm\`, \`t 70\`, \`sweep\`. It prints the vane moment per degree and the LIFT_K to set.
4. **Coupling test**: roll free, ${yawOn ? "yaw locked, " : ""}pitch still on the load cell link, \`tare\`, \`arm\`, \`t 70\`, \`couple\`. Two pitch nudges give the cell's sign, then the vanes rock the unit ±5° in roll at 1 Hz for 8 s while the cell feels the rotor's gyroscopic push on pitch. It prints the rotor's momentum against the prediction, whether ROTOR_DIR is right (\`rotor\` and \`save\` if not) and the H_FULL it measured. The fan goes back to 0 at the end.
5. **First free run**: ${yawOn ? `every axis free. ${homeStop ? `Turn the unit onto its yaw stop on the side the fan's start-up twists it toward (${S.rotorDir > 0 ? "clockwise" : "anticlockwise"} seen from above; YAW_HOME_DEG ${cNum(S.yawHome)}° is that stop), then \`arm\`, \`t 50\`, \`hold\`: the loop levels the unit and walks the heading to the middle. Left anywhere else, the start-up twist swings it onto that stop first, and the heading still counts from the stop.` : `\`arm\` with the unit pointing where heading 0 should be, then \`t 50\`, \`hold\`: the fan's start-up twists the unit ${S.rotorDir > 0 ? "clockwise" : "anticlockwise"} seen from above, and the loop levels it and walks the heading back.`} Then \`t 70\`, which climbs slowly while the heading is held. If the heading runs to a stop instead of settling, flip YAW_DIR.` : "both axes free, `arm`, `t 50`, `hold`, then up to 70 %."} GAIN_SCALE ${cNum(S.gainScale)} first, 1.0 after the force test.
6. **Steps**: holding, \`step roll 5\` and \`step pitch 5\` (one axis locked for a locked step test)${yawOn ? ", and `step yaw 20`" : ""}. Each prints the 10–90 % rise time, the overshoot and when it settled within 10 %, with the log running.${yawOn ? " `yaw 30` turns the unit to a heading and holds it there." : ""}

## Log

\`log\` prints a line every 20 ms: roll and pitch${yawOn ? " and the heading" : ""} (°), the filtered gyro rates gx and gy${yawOn ? " and gz" : ""} (°/s), the four vane commands (°), thrust (% of full) and the load cell (N). Paste it into a spreadsheet to plot a run.

## Settings in flash

\`trim\`, \`gain\`, \`liftk\`, \`gyrok\`, \`rotor\`${yawOn ? ", the heading trim the loop has found" : ""} and the load cell's \`tare\`/\`cal\` are kept by \`save\` (ESP32 flash, through EEPROM).
`;
  return {
    files: [
      { path: `${dir0}/${name}.ino`, content: ino },
      { path: `${dir0}/config.h`, content: config },
      { path: `${dir0}/README.md`, content: readme },
    ],
    warnings,
    pinTable,
    summary: `ESP32 sketch for ${bp.name}: jet-vane balance at 500 Hz with gyroscopic decoupling${yawOn ? ", heading hold on the third axis" : ""}${viaHub ? `, pulses through ${hub!.name}` : ""}, e-stop latch, tilt cut and IMU watchdog, plus servo, sign, force, coupling and step tests${estop ? "" : " (no e-stop wired)"}`,
  };
}
