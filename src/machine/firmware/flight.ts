// CubeSat flight software for a flight computer on a PC/104 stack (the EnduroSat OBC): an STM32duino sketch written
// from the wiring. It finds the boards on the satellite's I2C bus (the EPS, the attitude system, the radios and the
// antenna system) by their catalog addresses, which EPS output feeds each switched load, the hinge switches on the
// computer's deployment inputs and the imager on its UART, and flies the CubeSat Design Specification's launch
// sequence: boot with every switched output off, detumble, hold every deployable for 30 minutes and every transmitter
// for 45, burn the solar wings' hold-downs and the antenna's releases, then beacon. After that (or at once, after a
// reboot with the wings already open) it runs normal operations: the wings at the sun, an imaging pass with the
// imager pointed at the ground, and an S-band downlink with the patch pointed at the ground station.

import { catalogPart } from "../catalog";
import type { CatalogPart, MachineComponent } from "../types";
import { cComment, cString, oneLine, type FwContext, type GenFile } from "./common";


/** Is this board a spacecraft's flight computer (its catalog entry says space_dev "obc")? */
export const isFlightComputer = (p: CatalogPart) => p.specs.space_dev === "obc";

export interface FlightResult {
  summary: string;
  files: GenFile[];
  warnings: string[];
  pinTable: { signal: string; pin: string; wire: string }[];
}

const hex = (n: number) => `0x${n.toString(16).toUpperCase().padStart(2, "0")}`;

export function flightFirmware(c: FwContext): FlightResult {
  const warnings: string[] = [];
  const pinTable: FlightResult["pinTable"] = [];
  const obc = c.board.name;
  const bp = c.boardPart;
  const s = c.fw.settings;
  const setting = (k: string, d: number, lo: number, hi: number) => {
    const v = Number(s[k] ?? d);
    if (!Number.isFinite(v) || v < lo || v > hi) {
      warnings.push(`${k}: ${oneLine(String(s[k]), 20)} is outside ${lo} to ${hi}; using ${d}.`);
      return d;
    }
    return Math.round(v);
  };

  // ---- the boards, by what their catalog entries say they are
  const comps = c.m.components.map((mc) => ({ mc, part: catalogPart(mc.catalogId) })).filter((x): x is { mc: MachineComponent; part: CatalogPart } => !!x.part);
  const dev = (kind: string) => comps.find((x) => x.part.specs.space_dev === kind);
  const addr = (x: { part: CatalogPart } | undefined, d: number) => (x ? parseInt(String(x.part.specs.i2c_addr ?? d), 16) || d : d);
  const eps = dev("eps");
  const adcs = dev("adcs");
  const uhf = dev("uhf");
  const sband = dev("sband");
  const ants = dev("ants");
  const camera = dev("camera");
  const burns = comps.filter((x) => x.part.specs.space_dev === "burn");
  if (!eps) warnings.push("No EPS in the design: the switched outputs, the hold-downs' burn and the battery readings need one (a GomSpace NanoPower P31u).");
  if (!adcs) warnings.push("No attitude system: the satellite never detumbles or points its wings at the sun.");
  if (!uhf) warnings.push("No UHF radio: the satellite never beacons.");

  // the board on each EPS output, from the wiring: OUT1 is channel 0
  const onOut = (comp: string, pins: string[]) => {
    if (!eps) return -1;
    for (let k = 0; k < 6; k++) {
      const net = c.nl.netOf.get(`${eps.mc.name}[0].OUT${k + 1}`);
      if (net?.pins.some((p) => p.comp === comp && pins.includes(p.pin.id))) return k;
    }
    return -1;
  };
  const camCh = camera ? onOut(camera.mc.name, ["V5", "VIN", "V3V3"]) : -1;
  const burnCh = burns.length ? onOut(burns[0].mc.name, ["BURN"]) : -1;
  const antsCh = ants ? onOut(ants.mc.name, ["V3V3", "V5", "VIN"]) : -1;
  if (camera && camCh < 0) warnings.push(`${camera.mc.name} is not on a switched EPS output: it stays on (or off) whatever the plan says.`);
  if (burns.length && burnCh < 0) warnings.push(`${burns.map((b) => b.mc.name).join(" and ")}: BURN is not on a switched EPS output, so the wings can never be released.`);
  for (const b of burns.slice(1)) if (onOut(b.mc.name, ["BURN"]) !== burnCh) warnings.push(`${b.mc.name}'s BURN is on a different EPS output from ${burns[0].mc.name}'s: only output ${burnCh + 1} is burned.`);
  if (ants && antsCh < 0) warnings.push(`${ants.mc.name} is not on a switched EPS output: the sketch burns its releases from the bus it is on.`);
  for (const [sig, comp, ch, pin] of [
    ["imager power", camera?.mc.name, camCh, "V5"],
    ["hold-down burn", burns[0]?.mc.name, burnCh, "BURN"],
    ["antenna system power", ants?.mc.name, antsCh, "V3V3"],
  ] as const)
    if (comp && ch >= 0) pinTable.push({ signal: sig, pin: `EPS OUT${ch + 1} (channel ${ch})`, wire: `${comp}.${pin}` });

  // the hinge switches on the computer's deployment inputs: closed to ground while their wing is stowed
  const deps: { id: string; mcu: string; sw: string }[] = [];
  for (const pin of bp.pins.filter((p) => /^DEP\d$/.test(p.id))) {
    const net = c.nl.netOf.get(`${obc}[0].${pin.id}`);
    const sw = net?.pins.find((p) => p.comp !== obc && p.part.kind === "switch");
    if (sw) {
      deps.push({ id: pin.id, mcu: String(pin.mcu ?? pin.id), sw: sw.comp });
      pinTable.push({ signal: `${sw.comp} (wing deployed)`, pin: `${pin.id} (${pin.mcu})`, wire: `${sw.comp}.${sw.pin.id}` });
    }
  }
  if (burns.length && !deps.length) warnings.push("No hinge switch reaches a DEP input: the sketch cannot tell whether the wings opened, so it burns once and carries on.");
  // the imager on the computer's UART
  const camRx = camera ? c.nl.netOf.get(`${camera.mc.name}[0].RX`)?.pins.some((p) => p.comp === obc && p.pin.bus === "uart_tx") : false;
  if (camera && !camRx) warnings.push(`${camera.mc.name}'s RX is not on the ${bp.name}'s TX: it never hears a command.`);
  if (camera && camRx) pinTable.push({ signal: "imager commands (Serial1)", pin: "TX (PA9)", wire: `${camera.mc.name}.RX` });
  const sdCs = String(bp.specs.sd_cs ?? "");
  if (sdCs) pinTable.push({ signal: "microSD chip select (on the board)", pin: sdCs, wire: `${obc} microSD slot` });

  // ---- the plan, from the block's settings
  const deployWait = setting("deploy_wait_s", 1800, 1800, 86400);
  const rfWait = setting("rf_wait_s", 2700, 2700, 86400);
  const burnS = setting("burn_s", 5, 1, 30);
  const beaconS = setting("beacon_s", 30, 5, 600);
  const imageAt = setting("image_at_s", 1360, 0, 86400);
  const imageS = setting("image_s", 480, 10, 3600);
  const downAt = setting("downlink_at_s", 2785, 0, 86400);
  const downS = setting("downlink_s", 600, 10, 3600);
  const callsign = cString(String(s.callsign ?? "KERFSAT1").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 10) || "KERFSAT1");
  const name = oneLine(c.fw.name).replace(/[^A-Za-z0-9_]/g, "_") || "flight";

  const L: string[] = [];
  const W = (x = "") => L.push(x);
  W(`// ${cComment(c.designName)}: flight software for the ${cComment(bp.name)} (STM32duino, generic STM32F4)`);
  W("// Written by Kerf from the design's wiring. It flies the CubeSat Design Specification (Rev 14.1) launch sequence:");
  W(`// detumble at once, no deployable before ${deployWait / 60} min (CDS 2.4.4), no transmission before ${rfWait / 60} min (CDS 2.4.5), then`);
  W("// the wings' and antenna's releases, then a beacon; then normal operations. Every step prints a \"state:\" line on the");
  W("// debug port and goes in /FLIGHT.LOG on the board's microSD card.");
  W("//");
  W("// The boards on I2C1 (PB7 SDA, PB6 SCL), at their datasheet addresses:");
  for (const [lab, x, d] of [
    ["EPS", eps, 0x02],
    ["ADCS", adcs, 0x57],
    ["UHF radio", uhf, 0x22],
    ["antenna system", ants, 0x31],
    ["S-band transmitter", sband, 0x26],
  ] as const)
    if (x) W(`//   ${lab}: ${cComment(x.mc.name)}, ${cComment(x.part.name)}, ${hex(addr(x, d))}`);
  W("");
  W("#include <Wire.h>");
  W("#include <SPI.h>");
  W("#include <SD.h>");
  W("");
  W(`const uint8_t EPS_ADDR = ${hex(addr(eps, 0x02))};`);
  W(`const uint8_t ADCS_ADDR = ${hex(addr(adcs, 0x57))};`);
  W(`const uint8_t UHF_ADDR = ${hex(addr(uhf, 0x22))};`);
  W(`const uint8_t ANTS_ADDR = ${hex(addr(ants, 0x31))};`);
  W(`const uint8_t SBAND_ADDR = ${hex(addr(sband, 0x26))};`);
  W("");
  W("// the EPS's switched outputs, from the wiring (OUT1 is channel 0; -1: not on one)");
  W(`const int CH_IMAGER = ${camCh};${camera ? ` // ${cComment(camera.mc.name)}` : ""}`);
  W(`const int CH_BURN = ${burnCh};${burns.length ? ` // ${cComment(burns.map((b) => b.mc.name).join(", "))}` : ""}`);
  W(`const int CH_ANTS = ${antsCh};${ants ? ` // ${cComment(ants.mc.name)}` : ""}`);
  W("");
  W("// hinge switches: pulled up on the board, closed to ground while their wing is stowed");
  W(`const int N_DEP = ${deps.length};`);
  W(`const int DEP_PIN[${Math.max(1, deps.length)}] = { ${deps.length ? deps.map((d) => d.mcu).join(", ") : "-1"} };${deps.length ? ` // ${cComment(deps.map((d) => `${d.id} ${d.sw}`).join(", "))}` : ""}`);
  W(`const int SD_CS = ${sdCs || "-1"};`);
  W(`const bool HAS_IMAGER = ${camera && camRx ? "true" : "false"};`);
  W(`const bool HAS_SBAND = ${sband ? "true" : "false"};`);
  W(`const bool HAS_ANTS = ${ants ? "true" : "false"};`);
  W(`const bool HAS_WINGS = ${burns.length && burnCh >= 0 ? "true" : "false"};`);
  W("");
  W("// the plan (seconds)");
  W(`const uint32_t DEPLOY_WAIT_S = ${deployWait}; // CDS: deployables wait 30 min after separation`);
  W(`const uint32_t RF_WAIT_S = ${rfWait}; // CDS: transmitters wait 45 min`);
  W(`const uint32_t BURN_S = ${burnS}; // the hold-downs' resistors on for this long a try`);
  W("const int BURN_TRIES = 3;");
  W("const uint32_t ANTS_BURN_S = 4; // each antenna element's release");
  W(`const uint32_t BEACON_S = ${beaconS};`);
  W(`const uint32_t IMAGE_AT_S = ${imageAt}; // into normal operations`);
  W(`const uint32_t IMAGE_S = ${imageS};`);
  W(`const uint32_t DOWNLINK_AT_S = ${downAt};`);
  W(`const uint32_t DOWNLINK_S = ${downS};`);
  W("const uint32_t IMAGER_BOOT_S = 20; // the imager's power-up before it takes commands");
  W(`const char CALLSIGN[] = "${callsign}";`);
  W("");
  W("// ADCS modes and targets (CubeSpace's control modes, reduced)");
  W("const uint8_t CTRL_NONE = 0, CTRL_DETUMBLE = 1, CTRL_3AXIS = 5;");
  W("const uint8_t AIM_SUN = 0, AIM_IMAGER = 1, AIM_PATCH = 2;");
  W("const int RATE_OK_CDPS = 50; // detumbled below 0.5 deg/s on every axis");
  W("");
  W("enum State { BOOT, DETUMBLE, WAIT_DEPLOY, DEPLOY_WINGS, DEPLOY_ANTENNA, WAIT_RF, FIRST_BEACON, OPS, IMAGING, DOWNLINK, SAFE };");
  W('const char *STATE_NAME[] = { "boot", "detumble", "waiting to deploy", "deploying wings", "deploying antenna", "waiting to transmit", "first beacon", "normal operations", "imaging", "downlink", "safe" };');
  W("State state = BOOT;");
  W("uint32_t stateAt = 0;    // seconds, when the state began");
  W("uint32_t opsAt = 0;      // when normal operations began");
  W("uint32_t lastBeacon = 0;");
  W("uint32_t lastHk = 0;");
  W("int burnTry = 0;");
  W("bool detumbled = false;");
  W("bool sdOk = false;");
  W("bool imaged = false, downlinked = false;");
  W("// housekeeping, as the EPS last reported it");
  W("uint16_t vbatMv = 0, solarMa = 0, sysMa = 0;");
  W("uint8_t outMask = 0, batMode = 0;");
  W("int16_t rate[3] = { 0, 0, 0 }; // body rates, 0.01 deg/s");
  W("bool rfOk = false;      // the 45 minutes are up (or this is a reboot later in the mission)");
  W("bool txOn = false;      // the UHF transmitter is enabled");
  W("bool rebooted = false;   // came up with the wings already open: a reboot later in the mission");
  W("bool antsFired = false, imagerAsked = false;");
  W("char line[96];");
  W("char why[40];");
  W("char reply[40];        // the imager's reply, as it comes in");
  W("int replyN = 0;");
  W("");
  W("uint32_t now() { return millis() / 1000; }");
  W("");
  W("void logLine(const char *text) {");
  W("  Serial.println(text);");
  W("  if (!sdOk) return;");
  W('  File f = SD.open("/FLIGHT.LOG", FILE_WRITE);');
  W("  if (f) {");
  W("    f.print(now()); f.print(' '); f.println(text);");
  W("    f.close();");
  W("  }");
  W("}");
  W("");
  W("void enter(State s, const char *why) {");
  W("  state = s;");
  W("  stateAt = now();");
  W('  snprintf(line, sizeof(line), "state: %s%s%s%s", STATE_NAME[s], why[0] ? " (" : "", why, why[0] ? ")" : "");');
  W("  logLine(line);");
  W("}");
  W("");
  W("// ---- the EPS: command 9 [channel, on, delay] switches an output; 8 [0] asks for housekeeping");
  W("void epsOut(int ch, bool on) {");
  W("  if (ch < 0) return;");
  W("  Wire.beginTransmission(EPS_ADDR);");
  W("  Wire.write(9); Wire.write((uint8_t)ch); Wire.write(on ? 1 : 0); Wire.write(0); Wire.write(0);");
  W("  Wire.endTransmission();");
  W("}");
  W("");
  W("bool epsHousekeeping() {");
  W("  Wire.beginTransmission(EPS_ADDR);");
  W("  Wire.write(8); Wire.write(0);");
  W("  if (Wire.endTransmission() != 0) return false;");
  W("  if (Wire.requestFrom(EPS_ADDR, (uint8_t)12) != 12) return false;");
  W("  uint8_t b[12];");
  W("  for (int i = 0; i < 12; i++) b[i] = Wire.read();");
  W("  if (b[0] != 8 || b[1] != 0) return false;");
  W("  vbatMv = (b[2] << 8) | b[3];");
  W("  solarMa = (b[4] << 8) | b[5];");
  W("  sysMa = (b[6] << 8) | b[7];");
  W("  outMask = b[8];");
  W("  batMode = b[9];");
  W("  return true;");
  W("}");
  W("");
  W("// ---- the ADCS: telecommands 10 (run mode), 13 (control mode), 17 (target); telemetry 146 (body rates)");
  W("void adcsCommand(uint8_t id, uint8_t a, uint8_t b, uint8_t c) {");
  W("  Wire.beginTransmission(ADCS_ADDR);");
  W("  Wire.write(id); Wire.write(a); Wire.write(b); Wire.write(c);");
  W("  Wire.endTransmission();");
  W("}");
  W("");
  W("void aim(uint8_t target) {");
  W("  adcsCommand(17, target, 0, 0);");
  W("}");
  W("");
  W("bool readRates() {");
  W("  Wire.beginTransmission(ADCS_ADDR);");
  W("  Wire.write(146);");
  W("  if (Wire.endTransmission() != 0) return false;");
  W("  if (Wire.requestFrom(ADCS_ADDR, (uint8_t)6) != 6) return false;");
  W("  for (int i = 0; i < 3; i++) {");
  W("    uint8_t lo = Wire.read();");
  W("    uint8_t hi = Wire.read();");
  W("    rate[i] = (int16_t)((hi << 8) | lo);");
  W("  }");
  W("  return true;");
  W("}");
  W("");
  W("int worstRate() {");
  W("  int w = 0;");
  W("  for (int i = 0; i < 3; i++) if (abs(rate[i]) > w) w = abs(rate[i]);");
  W("  return w;");
  W("}");
  W("");
  W("// ---- the UHF radio: 0x01 [on] enables its transmitter, 0x10 [length, bytes] sends a frame");
  W("void uhfTransmitter(bool on) {");
  W("  txOn = on;");
  W("  Wire.beginTransmission(UHF_ADDR);");
  W("  Wire.write(0x01); Wire.write(on ? 1 : 0);");
  W("  Wire.endTransmission();");
  W("}");
  W("");
  W("// the beacon: callsign, seconds since separation, state number, battery mV and the load's mA");
  W("void beacon() {");
  W("  // one frame through the Wire library's 32-byte buffer: the command, the length and 30 characters at most");
  W('  snprintf(line, 31, "%s T%lu S%d V%u I%u", CALLSIGN, (unsigned long)now(), (int)state, vbatMv, sysMa);');
  W("  int n = strlen(line);");
  W("  if (!txOn) uhfTransmitter(true);");
  W("  Wire.beginTransmission(UHF_ADDR);");
  W("  Wire.write(0x10); Wire.write((uint8_t)n);");
  W("  for (int i = 0; i < n; i++) Wire.write((uint8_t)line[i]);");
  W("  Wire.endTransmission();");
  W("  lastBeacon = now();");
  W("  logLine(line);");
  W("}");
  W("");
  W("// ---- the antenna system: 0xAD arms, 0xA5 [s] burns each element in turn, 0xC3 reads its status, 0xAC disarms");
  W("void antsCommand(uint8_t cmd, int arg) {");
  W("  Wire.beginTransmission(ANTS_ADDR);");
  W("  Wire.write(cmd);");
  W("  if (arg >= 0) Wire.write((uint8_t)arg);");
  W("  Wire.endTransmission();");
  W("}");
  W("");
  W("// a bit set for each element still stowed (bits 15, 11, 7, 3); -1 when it does not answer");
  W("int antsStowed() {");
  W("  antsCommand(0xC3, -1);");
  W("  if (Wire.requestFrom(ANTS_ADDR, (uint8_t)2) != 2) return -1;");
  W("  uint16_t st = Wire.read();");
  W("  st |= Wire.read() << 8;");
  W("  return st & 0x8888;");
  W("}");
  W("");
  W("// ---- the S-band transmitter: 0x01 [on]");
  W("void sbandDownlink(bool on) {");
  W("  Wire.beginTransmission(SBAND_ADDR);");
  W("  Wire.write(0x01); Wire.write(on ? 1 : 0);");
  W("  Wire.endTransmission();");
  W("}");
  W("");
  W("// both wings' hinge switches open: the wings swung clear of them");
  W("bool wingsOpen() {");
  W("  if (N_DEP == 0) return false;");
  W("  for (int i = 0; i < N_DEP; i++) if (digitalRead(DEP_PIN[i]) == LOW) return false;");
  W("  return true;");
  W("}");
  W("");
  W("void setup() {");
  W("  Serial.begin(115200);");
  W("  Serial1.begin(115200);");
  W("  Wire.begin();");
  W("  Wire.setClock(100000);");
  W("  for (int i = 0; i < N_DEP; i++) pinMode(DEP_PIN[i], INPUT_PULLUP);");
  W("  pinMode(LED_BUILTIN, OUTPUT);");
  W("  if (SD_CS >= 0) sdOk = SD.begin(SD_CS);");
  W(`  logLine("${cString(oneLine(c.designName, 60))}: flight software up");`);
  W('  if (!sdOk) Serial.println("microSD: no card, logging to the debug port only");');
  W("  // every switched output off: nothing deployable or transmitting is powered until the plan says");
  W("  for (int ch = 0; ch < 6; ch++) epsOut(ch, false);");
  W("  epsHousekeeping();");
  W("  uhfTransmitter(false);");
  W("  if (HAS_SBAND) sbandDownlink(false);");
  W("  // the attitude system on, detumbling on its magnetorquers (they radiate nothing, so the CDS lets them run at once)");
  W("  adcsCommand(10, 1, 0, 0);");
  W("  adcsCommand(13, CTRL_DETUMBLE, 0, 0);");
  W("  if (HAS_WINGS && wingsOpen()) {");
  W("    // a reboot later in the mission: the wings are already open and the waits are long past");
  W("    rebooted = true;");
  W("    rfOk = true;");
  W('    enter(DETUMBLE, "rebooted in orbit, wings open");');
  W("  } else {");
  W('    enter(DETUMBLE, "separated from the dispenser");');
  W("  }");
  W("}");
  W("");
  W("void startOps() {");
  W("  aim(AIM_SUN);");
  W("  adcsCommand(13, CTRL_3AXIS, 0, 0);");
  W("  opsAt = now();");
  W("  imaged = downlinked = false;");
  W('  enter(OPS, "wings at the sun");');
  W("}");
  W("");
  W("void loop() {");
  W("  uint32_t t = now();");
  W("  uint32_t in = t - stateAt;");
  W("  // housekeeping every 10 s: the battery, and the body rates");
  W("  if (t - lastHk >= 10) {");
  W("    lastHk = t;");
  W("    epsHousekeeping();");
  W("    readRates();");
  W("    digitalWrite(LED_BUILTIN, (t / 10) & 1);");
  W("    if (batMode == 1 && state != SAFE && state >= OPS) {");
  W("      // the battery under 20 %: everything that can wait is shed");
  W("      epsOut(CH_IMAGER, false);");
  W("      if (HAS_SBAND) sbandDownlink(false);");
  W("      aim(AIM_SUN);");
  W('      enter(SAFE, "battery low");');
  W("    }");
  W("  }");
  W("  switch (state) {");
  W("    case DETUMBLE:");
  W("      if (worstRate() < RATE_OK_CDPS && in >= 30) {");
  W("        detumbled = true;");
  W("        if (rebooted) { startOps(); break; }");
  W("        // the wheels hold the wings' side at the sun while the clock runs down");
  W("        aim(AIM_SUN);");
  W("        adcsCommand(13, CTRL_3AXIS, 0, 0);");
  W('        snprintf(line, sizeof(line), "detumbled at T+%lu s", (unsigned long)t);');
  W("        logLine(line);");
  W('        enter(WAIT_DEPLOY, "detumbled");');
  W("      } else if (!rebooted && t >= DEPLOY_WAIT_S) {");
  W('        enter(WAIT_DEPLOY, "still tumbling");');
  W("      }");
  W("      break;");
  W("    case WAIT_DEPLOY:");
  W("      if (t >= DEPLOY_WAIT_S) {");
  W("        if (HAS_WINGS) {");
  W("          burnTry = 1;");
  W("          epsOut(CH_BURN, true);");
  W('          enter(DEPLOY_WINGS, "burning the hold-downs, try 1");');
  W("        } else enter(DEPLOY_ANTENNA, \"no wings\");");
  W("      }");
  W("      break;");
  W("    case DEPLOY_WINGS:");
  W("      if (in >= BURN_S) epsOut(CH_BURN, false);");
  W("      if (wingsOpen() || (N_DEP == 0 && in >= BURN_S)) {");
  W("        epsOut(CH_BURN, false);");
  W('        snprintf(line, sizeof(line), "wings open at T+%lu s", (unsigned long)t);');
  W("        logLine(line);");
  W("        if (HAS_ANTS) {");
  W("          epsOut(CH_ANTS, true);");
  W("          antsFired = false;");
  W('          enter(DEPLOY_ANTENNA, "wings open");');
  W('        } else enter(WAIT_RF, "wings open");');
  W("      } else if (in >= BURN_S + 30) {");
  W("        if (burnTry >= BURN_TRIES) {");
  W('          logLine("wings did not open after every try: carrying on with them stowed");');
  W("          if (HAS_ANTS) epsOut(CH_ANTS, true);");
  W("          antsFired = false;");
  W('          enter(HAS_ANTS ? DEPLOY_ANTENNA : WAIT_RF, "wings stowed");');
  W("        } else {");
  W("          burnTry++;");
  W("          epsOut(CH_BURN, true);");
  W('          snprintf(why, sizeof(why), "burning the hold-downs, try %d", burnTry);');
  W("          enter(DEPLOY_WINGS, why);");
  W("        }");
  W("      }");
  W("      break;");
  W("    case DEPLOY_ANTENNA:");
  W("      // a second for its supply to come up, then arm it and burn each element's release in turn");
  W("      if (!antsFired && in >= 1) {");
  W("        antsFired = true;");
  W("        antsCommand(0xAD, -1);");
  W("        antsCommand(0xA5, ANTS_BURN_S);");
  W("      }");
  W("      if (antsFired && in >= 2 && t - lastHk == 0) {");
  W("        int st = antsStowed();");
  W("        if (st == 0 || in >= 4 * ANTS_BURN_S + 30) {");
  W("          antsCommand(0xAC, -1);");
  W("          epsOut(CH_ANTS, false);");
  W('          if (st == 0) snprintf(line, sizeof(line), "antenna deployed at T+%lu s", (unsigned long)t);');
  W('          else snprintf(line, sizeof(line), "antenna: elements still stowed at T+%lu s", (unsigned long)t);');
  W("          logLine(line);");
  W('          enter(WAIT_RF, st == 0 ? "antenna out" : "antenna stowed");');
  W("        }");
  W("      }");
  W("      break;");
  W("    case WAIT_RF:");
  W("      if (t >= RF_WAIT_S) {");
  W("        rfOk = true;");
  W("        uhfTransmitter(true);");
  W('        enter(FIRST_BEACON, "45 min since separation");');
  W("        beacon();");
  W("      }");
  W("      break;");
  W("    case FIRST_BEACON:");
  W("      if (in >= 2) startOps();");
  W("      break;");
  W("    case OPS:");
  W("      if (HAS_IMAGER && !imaged && t - opsAt >= IMAGE_AT_S) {");
  W("        imaged = true;");
  W("        aim(AIM_IMAGER);");
  W("        epsOut(CH_IMAGER, true);");
  W("        imagerAsked = false;");
  W('        enter(IMAGING, "the imager at the ground");');
  W("      } else if (HAS_SBAND && !downlinked && t - opsAt >= DOWNLINK_AT_S) {");
  W("        downlinked = true;");
  W("        aim(AIM_PATCH);");
  W("        sbandDownlink(true);");
  W('        enter(DOWNLINK, "the patch at the ground station");');
  W("      }");
  W("      break;");
  W("    case IMAGING:");
  W("      if (!imagerAsked && in >= IMAGER_BOOT_S) {");
  W("        imagerAsked = true;");
  W('        snprintf(line, sizeof(line), "IMG %lu", (unsigned long)IMAGE_S);');
  W("        Serial1.println(line);");
  W("        logLine(line);");
  W("      }");
  W("      if (in >= IMAGER_BOOT_S + IMAGE_S + 5) {");
  W("        epsOut(CH_IMAGER, false);");
  W("        aim(AIM_SUN);");
  W('        enter(OPS, "imaging pass done");');
  W("      }");
  W("      break;");
  W("    case DOWNLINK:");
  W("      if (in >= DOWNLINK_S) {");
  W("        sbandDownlink(false);");
  W("        aim(AIM_SUN);");
  W('        enter(OPS, "downlink done");');
  W("      }");
  W("      break;");
  W("    case SAFE:");
  W("      if (batMode >= 3) startOps();");
  W("      break;");
  W("    default:");
  W("      break;");
  W("  }");
  W("  // the beacon, every BEACON_S once the 45 minutes are up");
  W("  if (state >= OPS && rfOk && t - lastBeacon >= BEACON_S) beacon();");
  W("  // the imager's replies go in the log");
  W("  while (HAS_IMAGER && Serial1.available()) {");
  W("    char ch = Serial1.read();");
  W("    if (ch == '\\n' || replyN >= 39) {");
  W("      reply[replyN] = 0;");
  W("      if (replyN) logLine(reply);");
  W("      replyN = 0;");
  W("    } else if (ch != '\\r') reply[replyN++] = ch;");
  W("  }");
  W("  delay(250);");
  W("}");

  const summary = `CubeSat flight software for the ${bp.name}: detumble, the CDS's ${deployWait / 60}-minute and ${rfWait / 60}-minute waits, the wings' and antenna's releases, a beacon every ${beaconS} s, then an imaging pass and an S-band downlink`;
  return { summary, files: [{ path: `firmware/${name}/${name}.ino`, content: L.join("\n") + "\n" }], warnings, pinTable };
}
